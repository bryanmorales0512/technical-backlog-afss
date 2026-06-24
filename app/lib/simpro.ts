import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsRead, gcsWrite } from "./gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const CFSP_ID  = 1126;

const hdrs = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

export const CACHE_TTL = 60 * 60_000; // 1 hour

// No warmup gate — requests proceed immediately, auto-retry handles cold caches.

export type CacheEntry = { data: Record<string, unknown>[]; ts: number; partial?: boolean };

// Company 10 (AE Evac) excluded from warmup gate — SimPRO rate limits are
// exhausted after companies 1 and 8, causing company 10 to hang indefinitely.
// Company 10 warms itself on first user access (one-time 60-90s cold fetch).
export const WARM_COMBOS = [
  { company: 1, stage: "Pending"  },
  { company: 1, stage: "Progress" },
  { company: 8, stage: "Pending"  },
  { company: 8, stage: "Progress" },
] as const;

// Use GCS-mounted volume in production (CACHE_DIR env var), tmpdir in dev.
export function cacheDir(): string {
  return process.env.CACHE_DIR ?? os.tmpdir();
}

function cacheFile(company: number, stage: string) {
  return join(cacheDir(), `afss-v4-${company}-${stage.toLowerCase()}-cache.json`);
}

const GCS_KEY = (company: number, stage: string) =>
  `afss-v4-${company}-${stage.toLowerCase()}-cache.json`;

// Request path: local cache only — never blocks on GCS network calls.
export async function readCacheRaw(company: number, stage: string): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(cacheFile(company, stage), "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch { return null; }
}

export async function writeCache(
  company: number,
  stage: string,
  data: Record<string, unknown>[],
  partial = false,
): Promise<void> {
  const json = JSON.stringify({ data, ts: Date.now(), partial });
  fs.writeFile(cacheFile(company, stage), json, "utf-8").catch(() => {});
  gcsWrite(GCS_KEY(company, stage), json); // persist to GCS for next deployment
}

// Warmup path: read from GCS to skip SimPRO fetch when cache is already fresh.
// Only called during warmAll, never during request handling.
async function readCacheFromGcs(company: number, stage: string): Promise<CacheEntry | null> {
  const remote = await gcsRead(GCS_KEY(company, stage));
  if (!remote) return null;
  try {
    const entry = JSON.parse(remote) as CacheEntry;
    // Write to local so request handlers can read without GCS
    fs.writeFile(cacheFile(company, stage), remote, "utf-8").catch(() => {});
    return entry;
  } catch { return null; }
}

const LIST_COLS = [
  "ID", "Stage", "Status", "Technicians", "Customer", "Site",
  "Tags", "Name", "DateIssued", "DueDate", "Total",
].join(",");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simGet(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
      if (r.status === 429) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (!r.ok) throw new Error(`simPRO ${r.status}: ${path}`);
      return r.json();
    } catch (err) {
      // Network error (not a HTTP error) — retry with backoff
      if (attempt < 7) { await sleep(500 * (attempt + 1)); continue; }
      throw err;
    }
  }
  throw new Error(`simPRO rate limit (429): ${path}`);
}

export function list(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.Result)) return d.Result as Record<string, unknown>[];
  }
  return [];
}

function unwrap(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  if (d.Result && typeof d.Result === "object" && !Array.isArray(d.Result)) {
    return d.Result as Record<string, unknown>;
  }
  return d;
}

async function pooledGet(
  paths: string[],
  concurrency = 4,
): Promise<(Record<string, unknown> | null)[]> {
  const results: (Record<string, unknown> | null)[] = new Array(paths.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const i = next++;
      results[i] = await simGet(paths[i]).catch(() => null) as Record<string, unknown> | null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

export async function fetchCFSPJobs(company: number, stage: string): Promise<Record<string, unknown>[]> {
  const first = list(await simGet(
    `/api/v1.0/companies/${company}/jobs/?pageSize=250&columns=${LIST_COLS}&Stage=${stage}&page=1`
  ));
  if (first.length === 0) return [];

  let allItems = first;
  if (first.length === 250) {
    // Sequential — parallel page fetches caused rate-limit drops on Cloud Run
    // when multiple warmAll combos ran concurrently.
    for (let page = 2; page <= 10; page++) {
      try {
        const nextPage = list(await simGet(
          `/api/v1.0/companies/${company}/jobs/?pageSize=250&columns=${LIST_COLS}&Stage=${stage}&page=${page}`
        ));
        allItems = allItems.concat(nextPage);
        if (nextPage.length < 250) break;
      } catch { break; }
    }
  }

  if (company === 8) return allItems;

  return allItems.filter((j) => {
    const techs = j.Technicians as Record<string, unknown>[] | undefined;
    return techs?.some((t) => Number((t as Record<string, unknown>).ID) === CFSP_ID);
  });
}

export async function fetchAndCache(company: number, stage: string): Promise<Record<string, unknown>[]> {
  const cfspJobs = await fetchCFSPJobs(company, stage);
  if (cfspJobs.length === 0) {
    // Don't overwrite a good cache with an empty result — may be a transient API glitch.
    const existing = await readCacheRaw(company, stage);
    if (existing && existing.data.length > 0) return existing.data;
    await writeCache(company, stage, []);
    return [];
  }

  const jobIds = cfspJobs.map((j) => j.ID);
  const siteIds = [...new Set(
    cfspJobs.map((j) => (j.Site as Record<string, unknown>)?.ID).filter(Boolean),
  )];

  type CustomerRef = { id: string | number; type: string };
  const seenCustIds = new Set<string | number>();
  const customerRefs: CustomerRef[] = [];
  for (const j of cfspJobs) {
    const cust = j.Customer as Record<string, unknown> | null;
    const id   = cust?.ID as string | number | null | undefined;
    const type = (cust?.Type as string) || "Company";
    if (id != null && !seenCustIds.has(id)) {
      seenCustIds.add(id);
      customerRefs.push({ id, type });
    }
  }
  const customerPaths = customerRefs.map(({ id, type }) => {
    const segment = type === "Individual" ? "individuals" : "companies";
    return `/api/v1.0/companies/${company}/customers/${segment}/${id}`;
  });

  // Concurrency 4 per pool × 4 pools = max 16 concurrent SimPRO calls.
  // Previously 10×4 = 40 concurrent — caused 429s on Cloud Run during warmup.
  const [detailResults, siteResults, schedResults, customerResults] = await Promise.all([
    pooledGet(jobIds.map((id) => `/api/v1.0/companies/${company}/jobs/${id}`), 4),
    pooledGet(siteIds.map((id) => `/api/v1.0/companies/${company}/sites/${id}`), 4),
    pooledGet(jobIds.map((id) => `/api/v1.0/companies/${company}/schedules/?JobID=${id}&pageSize=250`), 4),
    pooledGet(customerPaths, 4),
  ]);

  const detailMap: Record<string | number, Record<string, unknown>> = {};
  jobIds.forEach((id, i) => {
    const raw = detailResults[i];
    if (raw) detailMap[id as string | number] = unwrap(raw);
  });

  const siteMap: Record<string | number, Record<string, unknown>> = {};
  siteIds.forEach((id, i) => {
    const raw = siteResults[i];
    if (raw) siteMap[id as string | number] = unwrap(raw);
  });

  const customerMap: Record<string | number, Record<string, unknown>> = {};
  customerRefs.forEach(({ id }, i) => {
    const raw = customerResults[i];
    if (raw) customerMap[id] = unwrap(raw);
  });

  type SchedInfo = { date: string | null; hours: number };
  const schedMap: Record<string | number, SchedInfo> = {};
  jobIds.forEach((id, i) => {
    const raw = schedResults[i];
    if (!raw) { schedMap[id as string | number] = { date: null, hours: 0 }; return; }
    let blocks = list(raw);
    if (blocks.length === 0) {
      const u = unwrap(raw);
      if (u.Date) blocks = [u];
    }
    const dates = blocks
      .map((b) => b.Date as string | undefined)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    const hours = blocks.reduce((sum, b) => {
      const dur = b.TotalHours ?? b.Duration ?? b.Hours ?? b.PlannedHours;
      return sum + (dur != null ? Number(dur) : 0);
    }, 0);
    schedMap[id as string | number] = { date: dates.length ? dates.sort()[0] : null, hours };
  });

  const enriched = cfspJobs.map((job) => {
    const detail         = detailMap[job.ID as string | number] ?? {};
    const sched          = schedMap[job.ID as string | number] ?? { date: null, hours: 0 };
    const custId         = (job.Customer as Record<string, unknown>)?.ID as string | number;
    const customerDetail = customerMap[custId] ?? {};
    const profile        = (customerDetail.Profile ?? {}) as Record<string, unknown>;
    const custGroupObj   = (profile.CustomerGroup ?? {}) as Record<string, unknown>;
    const custGroupName  = String(custGroupObj.Name ?? "");

    const detailScheduled = detail.Scheduled ?? detail.DateScheduled ?? detail.ScheduledDate ?? detail.DateBooked;
    const detailSchedDate = typeof detailScheduled === "string"
      ? detailScheduled
      : typeof detailScheduled === "object" && detailScheduled !== null
        ? ((detailScheduled as Record<string, unknown>).Date as string | undefined) ?? null
        : null;

    return {
      ...job,
      ...detail,
      _site:           siteMap[(job.Site as Record<string, unknown>)?.ID as string | number] ?? null,
      _scheduledDate:  sched.date || detailSchedDate || null,
      _scheduledHours: sched.hours,
      _customerGroup:  custGroupName,
    };
  });

  await writeCache(company, stage, enriched);
  return enriched;
}

// In-process dedup: concurrent requests for the same company/stage share one fetchAndCache promise.
// Promises survive Cloud Run container freezes — they resume when CPU is re-allocated by the next request.
const _inFlight = new Map<string, Promise<Record<string, unknown>[]>>();

export function fetchAndCacheDeduped(company: number, stage: string): Promise<Record<string, unknown>[]> {
  const key = `${company}-${stage}`;
  let p = _inFlight.get(key);
  if (!p) {
    p = fetchAndCache(company, stage).finally(() => _inFlight.delete(key));
    _inFlight.set(key, p);
  }
  return p;
}

// Warm combos sequentially. Restore from GCS first — this makes warmAll instant
// on every deployment after the first (GCS has the data from the previous run).
// Only falls through to SimPRO if GCS is empty, stale (> 4h), or has no jobs.
export async function warmAll(): Promise<{ company: number; stage: string; ok: boolean; ms: number; source?: string }[]> {
  const GCS_WARM_TTL = 4 * 60 * 60 * 1000; // 4 hours
  const results = [];
  for (const { company, stage } of WARM_COMBOS) {
    const t = Date.now();
    try {
      const gcsEntry = await readCacheFromGcs(company, stage);
      if (gcsEntry && gcsEntry.data.length > 0 && !gcsEntry.partial &&
          Date.now() - gcsEntry.ts < GCS_WARM_TTL) {
        // GCS has fresh data — local file already written by readCacheFromGcs.
        // The data route's stale-while-revalidate will refresh it on first request.
        results.push({ company, stage, ok: true, ms: Date.now() - t, source: "gcs" });
        continue;
      }
      await fetchAndCacheDeduped(company, stage);
      results.push({ company, stage, ok: true, ms: Date.now() - t, source: "simpro" });
    } catch {
      results.push({ company, stage, ok: false, ms: Date.now() - t });
    }
  }
  return results;
}
