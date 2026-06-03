import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN;
const COMPANY  = 1;
const CFSP_ID  = 1126;

const hdrs = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

const CACHE_FILE = join(os.tmpdir(), "afss-jobs-cache.json");
const CACHE_TTL  = 60_000; // 60 seconds — stale-while-revalidate threshold

type CacheEntry = { data: Record<string, unknown>[]; ts: number };

async function readCacheRaw(): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch { return null; }
}

async function writeCache(data: Record<string, unknown>[]): Promise<void> {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify({ data, ts: Date.now() }), "utf-8");
  } catch { /* ignore write errors */ }
}

const LIST_COLS = [
  "ID", "Stage", "Status", "Technicians", "Customer", "Site",
  "Tags", "Name", "DateIssued", "DueDate", "Total",
].join(",");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function simGet(path: string): Promise<unknown> {
  const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
  if (!r.ok) throw new Error(`simPRO ${r.status}: ${path}`);
  return r.json();
}

function list(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.Result)) return d.Result as Record<string, unknown>[];
  }
  return [];
}

async function batchGet(
  paths: string[],
  batchSize = 8,
  delayMs   = 300,
): Promise<(Record<string, unknown> | null)[]> {
  const results: (Record<string, unknown> | null)[] = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    if (i > 0) await sleep(delayMs);
    const batch = await Promise.all(
      paths.slice(i, i + batchSize).map((p) =>
        simGet(p).catch(() => null)
      ),
    );
    results.push(...(batch as (Record<string, unknown> | null)[]));
  }
  return results;
}

async function fetchPendingCFSP(): Promise<Record<string, unknown>[]> {
  const jobs: Record<string, unknown>[] = [];
  let page = 1;

  while (page <= 100) {
    if (page > 1) await sleep(300);
    const url =
      `/api/v1.0/companies/${COMPANY}/jobs/` +
      `?pageSize=250&columns=${LIST_COLS}&Stage=Pending&page=${page}`;

    let items: Record<string, unknown>[] = [];
    try {
      items = list(await simGet(url));
    } catch {
      await sleep(1000);
      try { items = list(await simGet(url)); } catch { break; }
    }

    if (items.length === 0) break;

    for (const j of items) {
      const techs = j.Technicians as Record<string, unknown>[] | undefined;
      if (techs?.some((t) => (t as Record<string, unknown>).ID === CFSP_ID)) {
        jobs.push(j);
      }
    }

    if (items.length < 250) break;
    page++;
  }

  return jobs;
}

async function fetchAndCache(): Promise<Record<string, unknown>[]> {
  const cfspJobs = await fetchPendingCFSP();
  if (cfspJobs.length === 0) {
    await writeCache([]);
    return [];
  }

  const jobIds = cfspJobs.map((j) => j.ID);

  // Full job detail
  const detailResults = await batchGet(
    jobIds.map((id) => `/api/v1.0/companies/${COMPANY}/jobs/${id}`),
    8, 400,
  );
  const detailMap: Record<string | number, Record<string, unknown>> = {};
  jobIds.forEach((id, i) => {
    if (detailResults[i])
      detailMap[id as string | number] = detailResults[i] as Record<string, unknown>;
  });

  // Unique site details
  const siteIds = [
    ...new Set(
      cfspJobs
        .map((j) => (j.Site as Record<string, unknown>)?.ID)
        .filter(Boolean),
    ),
  ];
  const siteResults = await batchGet(
    siteIds.map((id) => `/api/v1.0/companies/${COMPANY}/sites/${id}`),
    8, 300,
  );
  const siteMap: Record<string | number, Record<string, unknown>> = {};
  siteIds.forEach((id, i) => {
    if (siteResults[i])
      siteMap[id as string | number] = siteResults[i] as Record<string, unknown>;
  });

  // Scheduled dates
  const schedDates = await batchGet(
    jobIds.map((id) => `/api/v1.0/companies/${COMPANY}/schedules/?JobID=${id}&pageSize=250`),
    6, 300,
  );
  const schedMap: Record<string | number, string | null> = {};
  jobIds.forEach((id, i) => {
    const raw = schedDates[i];
    if (!raw) { schedMap[id as string | number] = null; return; }
    const blocks = list(raw);
    const dates = blocks
      .map((b) => b.Date as string | undefined)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    schedMap[id as string | number] = dates.length ? dates.sort()[0] : null;
  });

  const enriched = cfspJobs.map((job) => {
    const detail = detailMap[job.ID as string | number] ?? {};
    return {
      ...job,
      ...detail,
      _site:          siteMap[(job.Site as Record<string, unknown>)?.ID as string | number] ?? null,
      _scheduledDate: schedMap[job.ID as string | number] ?? null,
    };
  });

  await writeCache(enriched);
  return enriched;
}

// Prevent concurrent background refreshes
let refreshing = false;

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";

    if (!force) {
      const entry = await readCacheRaw();
      if (entry) {
        const age = Date.now() - entry.ts;
        if (age < CACHE_TTL) {
          // Fresh — serve immediately
          return NextResponse.json(entry.data);
        }
        // Stale — serve immediately and refresh in background
        if (!refreshing) {
          refreshing = true;
          fetchAndCache().finally(() => { refreshing = false; });
        }
        return NextResponse.json(entry.data);
      }
    }

    // No cache or force — full blocking fetch
    const data = await fetchAndCache();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
