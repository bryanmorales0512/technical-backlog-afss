import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsRead, gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// The master "AFSS - Audit" cost centre for company 8 (Adair Fire Audits in
// SimPRO's own UI) — confirmed via /setup/accounts/costCenters/. Schedule
// blocks only carry a per-job cost-centre *instance* ID (Project.CostCenterID),
// which must be resolved through the job's costCenters list to get here.
const AFSS_AUDIT_CC_ID = 382;

export const CACHE_TTL = 60 * 60_000;
export const EXCLUSIONS_FILE = join(process.cwd(), "data", "afac-exclusions.json");

export function cacheFile(filterYear?: number, filterMonth?: number) {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = filterYear  ?? aest.getUTCFullYear();
  const m = String(filterMonth ?? (aest.getUTCMonth() + 1)).padStart(2, "0");
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-afac-prospect-v17-${y}-${m}.json`);
}

function gcsKeyFor(filterYear?: number, filterMonth?: number): string {
  return `afss-afac-prospect-v17-${cacheFile(filterYear, filterMonth).split("v17-")[1]}`;
}

export type CachedEntry = { data: AfacProspectResponse; ts: number };

// Shared by the route (on-demand reads) and warmAfacProspect (background
// refresh) so both agree on exactly one cache format — local file first,
// falling back to GCS (and mirroring it locally) for a fresh container that
// hasn't seen this month yet.
export async function readCachedEntry(filterYear?: number, filterMonth?: number): Promise<CachedEntry | null> {
  try {
    const raw = await fs.readFile(cacheFile(filterYear, filterMonth), "utf-8");
    return JSON.parse(raw) as CachedEntry;
  } catch { /* fall through to GCS */ }
  try {
    const remote = await gcsRead(gcsKeyFor(filterYear, filterMonth));
    if (!remote) return null;
    fs.writeFile(cacheFile(filterYear, filterMonth), remote, "utf-8").catch(() => {});
    return JSON.parse(remote) as CachedEntry;
  } catch { return null; }
}

export async function writeCachedEntry(data: AfacProspectResponse, filterYear?: number, filterMonth?: number): Promise<void> {
  const json = JSON.stringify({ data, ts: Date.now() });
  try { await fs.writeFile(cacheFile(filterYear, filterMonth), json, "utf-8"); } catch { /* ignore */ }
  gcsWrite(gcsKeyFor(filterYear, filterMonth), json);
}

async function loadExclusions(): Promise<Set<string>> {
  // GCS is the source of truth — a stale copy of EXCLUSIONS_FILE is baked into
  // every container image, so it must never shadow saved edits.
  try {
    const remote = await gcsRead("data-afac-exclusions.json");
    if (remote) return new Set(JSON.parse(remote) as string[]);
  } catch {}
  try {
    const dates = JSON.parse(await fs.readFile(EXCLUSIONS_FILE, "utf-8")) as string[];
    return new Set(dates);
  } catch { return new Set(); }
}

// Persists which job-section pairs resolve to the "AFSS - Audit" cost centre.
// A job's cost-centre assignment never changes once scheduled, and every
// month's window is a superset of the previous month's — so without this,
// each later month re-resolves every earlier month's job-sections from
// scratch (a live SimPRO round trip apiece), which is what made
// September/October take 10-46s and left November/December still
// uncomputed. With this cache, only genuinely new job-sections need a live
// lookup, so later months get progressively faster instead of slower.
const CC_RESOLVE_CACHE_KEY = "afss-afac-cc-resolve-cache-v1.json";

async function loadCcResolveCache(): Promise<Record<string, string[]>> {
  try {
    const remote = await gcsRead(CC_RESOLVE_CACHE_KEY);
    if (remote) return JSON.parse(remote) as Record<string, string[]>;
  } catch {}
  return {};
}

function saveCcResolveCache(cache: Record<string, string[]>): void {
  gcsWrite(CC_RESOLVE_CACHE_KEY, JSON.stringify(cache)); // fire-and-forget, same as other caches here
}

function listOf(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    if (Array.isArray(o.Result)) return o.Result as Record<string, unknown>[];
  }
  return [];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function simGet(path: string): Promise<unknown> {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
      if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
      if (r.status >= 500) { await sleep(500 * (a + 1)); continue; }
      if (!r.ok) return null;
      return r.json();
    } catch {
      if (a < 5) await sleep(500 * (a + 1));
    }
  }
  return null;
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type AfacProspectResponse = {
  jobs: number;
  hours: number;
  dateFrom: string;
  dateTo: string;
  costCentreFiltered: boolean;
};

// Matches the "Schedule Breakdown" report in SimPRO (Company: Adair Fire
// Audits, Cost Centre: AFSS - Audit, Technician: No Filter) for the window
// "today's date one year ago" through "end of the selected month, one year
// ago" — a cumulative, growing window anchored on today, not an isolated
// single month. Confirmed against SimPRO directly: e.g. for the August
// dashboard view the window is 14 Jul 2025 -> 31 Aug 2025, not 1-31 Aug 2025.
function dateWindow(filterYear?: number, filterMonth?: number) {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const start = new Date(aest.getUTCFullYear() - 1, aest.getUTCMonth(), aest.getUTCDate());

  const baseYear   = filterYear  ?? aest.getUTCFullYear();
  const baseMonth  = filterMonth ?? (aest.getUTCMonth() + 1);
  const targetYear = baseYear - 1;
  const end = new Date(targetYear, baseMonth, 0);

  return { start, end };
}

// Fetches every schedule block (all technicians) in the window, then resolves
// each block's job cost-centre *instance* (Project.CostCenterID) to the
// master cost centre it belongs to, keeping only "AFSS - Audit" (382).
async function fetchAfssAuditBlocks(start: Date, end: Date, exclusions: Set<string>) {
  let allBlocks: Record<string, unknown>[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      const day = fmt(new Date(cursor));
      if (!exclusions.has(day)) {
        const raw = listOf(await simGet(`/api/v1.0/companies/8/schedules/?Date=${day}&pageSize=250`) ?? []);
        allBlocks = allBlocks.concat(raw);
      }
      await sleep(80);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const uniqueJobSections = new Map<string, { jobId: string | number; sectionId: string | number }>();
  for (const b of allBlocks) {
    const proj = (b.Project as Record<string, unknown>) ?? {};
    if (proj.ProjectID == null || proj.SectionID == null) continue;
    uniqueJobSections.set(`${proj.ProjectID}-${proj.SectionID}`, {
      jobId: proj.ProjectID as string | number,
      sectionId: proj.SectionID as string | number,
    });
  }

  const ccCache = await loadCcResolveCache();
  const keysToResolve = [...uniqueJobSections.keys()].filter(k => !(k in ccCache));

  if (keysToResolve.length > 0) {
    // Bounded concurrency — resolving hundreds of job-sections at once (a
    // cold December window) triggers SimPRO's 429 rate limit, and each 429
    // costs an exponential backoff in simGet, which is what made large
    // windows slow. Chunking keeps concurrent requests modest.
    const CHUNK = 15;
    for (let i = 0; i < keysToResolve.length; i += CHUNK) {
      const chunk = keysToResolve.slice(i, i + CHUNK);
      const lists = await Promise.all(
        chunk.map(key => {
          const { jobId, sectionId } = uniqueJobSections.get(key)!;
          return simGet(`/api/v1.0/companies/8/jobs/${jobId}/sections/${sectionId}/costCenters/?columns=ID,CostCenter&pageSize=250`).catch(() => []);
        })
      );
      chunk.forEach((key, idx) => {
        const matches: string[] = [];
        for (const cc of listOf(lists[idx] ?? [])) {
          if (((cc.CostCenter as Record<string, unknown>) ?? {}).ID === AFSS_AUDIT_CC_ID) {
            matches.push(String(cc.ID));
          }
        }
        ccCache[key] = matches;
      });
    }
    saveCcResolveCache(ccCache);
  }

  const matchingCcInstanceIds = new Set<string>();
  for (const key of uniqueJobSections.keys()) {
    for (const id of ccCache[key] ?? []) matchingCcInstanceIds.add(id);
  }

  return allBlocks.filter(b => {
    const proj = (b.Project as Record<string, unknown>) ?? {};
    return proj.CostCenterID != null && matchingCcInstanceIds.has(String(proj.CostCenterID));
  });
}

export async function buildDebugData(filterYear?: number, filterMonth?: number) {
  const exclusions = await loadExclusions();
  const { start, end } = dateWindow(filterYear, filterMonth);
  const auditBlocks = await fetchAfssAuditBlocks(start, end, exclusions);
  const uniqueProjectIds = [...new Set(auditBlocks.map(b => (b.Project as Record<string, unknown>)?.ProjectID).filter((id): id is string | number => id != null))];

  return {
    period: `${fmt(start)} to ${fmt(end)}`,
    auditBlockCount: auditBlocks.length,
    uniqueProjectIds,
  };
}

export async function buildData(filterYear?: number, filterMonth?: number): Promise<AfacProspectResponse> {
  const exclusions = await loadExclusions();
  const { start, end } = dateWindow(filterYear, filterMonth);
  const dateFrom = fmt(start);
  const dateTo   = fmt(end);

  const auditBlocks = await fetchAfssAuditBlocks(start, end, exclusions);

  // "Jobs" counts report ROWS, matching SimPRO's Schedule Breakdown "Results"
  // counter exactly — a schedule entry with multiple time blocks in one day
  // (e.g. two separate appointments against the same job) is one row per
  // block in that report, not one row per job. Same convention as the
  // Tech Support "# of Jobs" card (see core.ts there). Verified live:
  // 14 Jul - 30 Sep 2025 window -> SimPRO Results (62) == this count (62).
  let rowCount = 0;
  let totalHours = 0;
  for (const b of auditBlocks) {
    const blockCount = (b.Blocks as unknown[] | undefined)?.length ?? 0;
    rowCount += Math.max(1, blockCount);
    totalHours += Number(b.TotalHours ?? 0);
  }

  return {
    jobs: rowCount,
    hours: Math.round(totalHours * 100) / 100,
    dateFrom,
    dateTo,
    costCentreFiltered: true,
  };
}

// Deletes all cached month files so the next load (forced or not) recomputes
// with the current exclusions instead of serving stale pre-exclusion numbers.
export async function clearCache(): Promise<void> {
  const dir = process.env.CACHE_DIR ?? os.tmpdir();
  try {
    const files = await fs.readdir(dir);
    await Promise.all(
      files
        .filter(f => f.startsWith("afss-afac-prospect-v17-"))
        .map(f => fs.unlink(join(dir, f)).catch(() => {})),
    );
  } catch { /* no cache dir yet — nothing to clear */ }
}

// Keeps every selectable month (current through December) pre-computed and
// fresh in the background, on whatever schedule pings /api/warmup — so
// nobody has to click into a month first and wait out a live multi-month
// SimPRO scan; by the time anyone looks, it's already there. Skips a month
// entirely if its cache is still within CACHE_TTL, so steady-state warmup
// runs only recompute the one month (if any) that just went stale.
export async function warmAfacProspect(): Promise<void> {
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year  = aest.getUTCFullYear();
  const currentMonth = aest.getUTCMonth() + 1;

  for (let month = currentMonth; month <= 12; month++) {
    const entry = await readCachedEntry(year, month);
    if (entry && Date.now() - entry.ts < CACHE_TTL) continue;

    const data = await buildData(year, month).catch(() => null);
    if (!data) continue;
    await writeCachedEntry(data, year, month);
  }
}
