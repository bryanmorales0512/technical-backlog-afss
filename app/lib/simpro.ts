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

export const CACHE_TTL = 5 * 60_000; // 5 minutes — near-live auto-sync with headroom for SimPRO rate limits

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

// Force the next /api/data request for this company/stage to refetch from
// SimPRO instead of serving the (possibly now-outdated) cached snapshot.
export async function clearCache(company: number, stage: string): Promise<void> {
  try { await fs.unlink(cacheFile(company, stage)); } catch { /* already gone */ }
}

// Read from GCS and mirror to the local file. Called during warmAll, and from
// fetchAndCache's safety guards (slow path only) when the local cache is empty.
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
  "Tags", "Name", "DateIssued", "DueDate", "Total", "Totals",
  "Salesperson", "Type",
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Paginate a filtered list endpoint. Errors return what was collected so far —
// a partial enrichment map only degrades individual fields, never drops jobs.
async function listAllPages(pathBase: string): Promise<Record<string, unknown>[]> {
  let all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    let items: Record<string, unknown>[];
    try {
      items = list(await simGet(`${pathBase}&page=${page}`));
    } catch { break; }
    all = all.concat(items);
    if (items.length < 250) break;
  }
  return all;
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

  // A fresh container has no local cache even when GCS holds good data — check
  // GCS before trusting an empty/shrunken result, so a transient SimPRO glitch
  // can't poison the persisted cache with [] and wipe the dashboard.
  let existing = await readCacheRaw(company, stage);
  if (!existing || existing.data.length === 0) {
    existing = await readCacheFromGcs(company, stage);
  }

  if (cfspJobs.length === 0) {
    // Don't overwrite a good cache with an empty result — may be a transient API glitch.
    if (existing && existing.data.length > 0) return existing.data;
    await writeCache(company, stage, []);
    return [];
  }

  // Don't overwrite a good cache with a suspiciously smaller result either — SimPRO
  // rate-limiting or a dropped page mid-fetch can silently truncate the job list
  // without throwing. Treat a >50% drop as an unreliable glitch and retry next cycle.
  if (existing && existing.data.length >= 3 && cfspJobs.length < existing.data.length * 0.5) {
    return existing.data;
  }

  const jobIds = cfspJobs.map((j) => j.ID as string | number);
  const siteIds = [...new Set(
    cfspJobs.map((j) => (j.Site as Record<string, unknown>)?.ID).filter(Boolean),
  )] as (string | number)[];

  const seenCustIds = new Set<string | number>();
  const companyCustIds: (string | number)[] = [];
  const individualCustIds: (string | number)[] = [];
  for (const j of cfspJobs) {
    const cust = j.Customer as Record<string, unknown> | null;
    const id   = cust?.ID as string | number | null | undefined;
    if (id == null || seenCustIds.has(id)) continue;
    seenCustIds.add(id);
    ((cust?.Type as string) === "Individual" ? individualCustIds : companyCustIds).push(id);
  }

  // Bulk enrichment via filtered list endpoints (ID=in / JobID=in) — a handful
  // of calls instead of one per job. The old per-job fetches (~3 calls × every
  // job, every sync) saturated SimPRO's rate limit on Cloud Run, so the big
  // company/stage combos never finished syncing and the dashboard showed 0.
  type SchedInfo = { date: string | null; hours: number };
  const schedMap: Record<string | number, SchedInfo> = {};
  for (const id of jobIds) schedMap[id] = { date: null, hours: 0 };
  const siteMap: Record<string | number, Record<string, unknown>> = {};
  const customerMap: Record<string | number, Record<string, unknown>> = {};

  await Promise.all([
    (async () => {
      for (const ids of chunk(jobIds, 100)) {
        const blocks = await listAllPages(
          `/api/v1.0/companies/${company}/schedules/?JobID=in(${ids.join(",")})&pageSize=250`,
        );
        for (const b of blocks) {
          // Schedule rows carry their job ID as the Reference prefix ("446829-368693").
          const s = schedMap[String(b.Reference ?? "").split("-")[0]];
          if (!s) continue;
          const date = b.Date;
          if (typeof date === "string" && date.length > 0 && (!s.date || date < s.date)) s.date = date;
          const dur = b.TotalHours ?? b.Duration ?? b.Hours ?? b.PlannedHours;
          s.hours += dur != null ? Number(dur) : 0;
        }
      }
    })(),
    (async () => {
      for (const ids of chunk(siteIds, 100)) {
        const sites = await listAllPages(
          `/api/v1.0/companies/${company}/sites/?ID=in(${ids.join(",")})&pageSize=250&columns=ID,Name,Address,PrimaryContact`,
        );
        for (const site of sites) {
          if (site.ID != null) siteMap[site.ID as string | number] = site;
        }
      }
    })(),
    (async () => {
      for (const [segment, allIds] of [["companies", companyCustIds], ["individuals", individualCustIds]] as const) {
        for (const ids of chunk(allIds, 100)) {
          const custs = await listAllPages(
            `/api/v1.0/companies/${company}/customers/${segment}/?ID=in(${ids.join(",")})&pageSize=250&columns=ID,Profile`,
          );
          for (const c of custs) {
            if (c.ID != null) customerMap[c.ID as string | number] = c;
          }
        }
      }
    })(),
  ]);

  const enriched = cfspJobs.map((job) => {
    const sched          = schedMap[job.ID as string | number] ?? { date: null, hours: 0 };
    const custId         = (job.Customer as Record<string, unknown>)?.ID as string | number;
    const customerDetail = customerMap[custId] ?? {};
    const profile        = (customerDetail.Profile ?? {}) as Record<string, unknown>;
    const custGroupObj   = (profile.CustomerGroup ?? {}) as Record<string, unknown>;

    return {
      ...job,
      _site:           siteMap[(job.Site as Record<string, unknown>)?.ID as string | number] ?? null,
      _scheduledDate:  sched.date,
      _scheduledHours: sched.hours,
      _customerGroup:  String(custGroupObj.Name ?? ""),
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
