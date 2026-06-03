import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsRead, gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const TEAM_IDS   = new Set<number>([1581, 15, 1753]);
const LEAVE_REFS = new Set(["1", "2"]);
const CFSP_ID    = 1126;
const RATE       = 100;
const CACHE_TTL  = 60 * 60_000; // 1 hour

export type TechSupportStats = { jobs: number; hours: number; amount: number };
export type QARawJob = { id: unknown; dueDate: string; estHours: number };
export type TechSupportResponse = {
  otherBillable:    TechSupportStats;
  investedTime:     TechSupportStats;
  qualityAssurance: TechSupportStats;
};
type CacheData = {
  otherBillable: TechSupportStats;
  investedTime:  TechSupportStats;
  qaRawJobs:     QARawJob[];
};

function cacheFile(year: number, month: number, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-tech-support-v78${tag}-${year}-${String(month).padStart(2, "0")}.json`);
}

// Persistent map of CC ID → name, built incrementally via section API.
// Stores both AFSS and non-AFSS names so resolved IDs are never re-fetched.
const CC_NAME_CACHE_FILE = join((process.env.CACHE_DIR ?? os.tmpdir()), "afss-cc-name-cache-v2.json");

async function loadCcNameCache(): Promise<Map<number, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(CC_NAME_CACHE_FILE, "utf-8")) as Record<string, string>;
    return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
  } catch { return new Map(); }
}
async function saveCcNameCache(cache: Map<number, string>): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [k, v] of cache) obj[String(k)] = v;
  try { await fs.writeFile(CC_NAME_CACHE_FILE, JSON.stringify(obj), "utf-8"); } catch {}
}

// Lookup CC names for blocks whose CC ID is not yet cached.
// Uses the section detail endpoint with a short retry — max 3 attempts, 300ms on 429.
// Failed lookups are not cached so they'll be retried next time.
async function resolveCcNames(blocks: BlockInfo[], cache: Map<number, string>): Promise<void> {
  const toResolve = new Map<number, { jobId: string; sectionId: number }>();
  for (const b of blocks) {
    if (b.costCentreId > 0 && b.sectionId > 0 && !cache.has(b.costCentreId)) {
      toResolve.set(b.costCentreId, { jobId: b.jobId, sectionId: b.sectionId });
    }
  }
  if (toResolve.size === 0) return;

  const entries = [...toResolve.entries()];
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    await Promise.all(batch.map(async ([ccId, { jobId, sectionId }]) => {
      for (let a = 0; a < 3; a++) {
        try {
          const r = await fetch(
            `${BASE_URL}/api/v1.0/companies/1/jobs/${jobId}/sections/${sectionId}?expand=CostCenter`,
            { headers: hdrs, cache: "no-store" }
          );
          if (r.status === 429) { await sleep(300); continue; }
          if (!r.ok) { cache.set(ccId, ""); return; } // non-existent section → cache empty
          const body = await r.json();
          const sect = unwrapJob(body);
          const cc   = sect.CostCenter as Record<string, unknown> | undefined;
          cache.set(ccId, String(cc?.Name ?? ""));
          return;
        } catch { /* retry */ }
      }
      // All attempts failed — don't cache, will retry next time
    }));
    if (i + 5 < entries.length) await sleep(150);
  }
}

const gcsKey = (year: number, month: number, nodc: boolean) =>
  `afss-tech-support-v78${nodc ? "-nodc" : ""}-${year}-${String(month).padStart(2, "0")}.json`;
const gcsFbKey = (year: number, month: number, nodc: boolean) =>
  `afss-tech-support-fallback-v78${nodc ? "-nodc" : ""}-${year}-${String(month).padStart(2, "0")}.json`;

async function readCache(year: number, month: number, nodc = false): Promise<{ data: CacheData; ts: number } | null> {
  try { return JSON.parse(await fs.readFile(cacheFile(year, month, nodc), "utf-8")); } catch { return null; }
}
async function writeCache(year: number, month: number, data: CacheData, nodc = false) {
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(cacheFile(year, month, nodc), json, "utf-8").catch(() => {});
  gcsWrite(gcsKey(year, month, nodc), json);
}

function fallbackFile(year: number, month: number, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-tech-support-fallback-v78${tag}-${year}-${String(month).padStart(2, "0")}.json`);
}
async function readFallback(year: number, month: number, nodc = false): Promise<CacheData | null> {
  try { return JSON.parse(await fs.readFile(fallbackFile(year, month, nodc), "utf-8")); } catch { return null; }
}
async function writeFallback(year: number, month: number, data: CacheData, nodc = false) {
  const json = JSON.stringify(data);
  fs.writeFile(fallbackFile(year, month, nodc), json, "utf-8").catch(() => {});
  gcsWrite(gcsFbKey(year, month, nodc), json);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function listOf(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    if (Array.isArray(o.Result)) return o.Result as Record<string, unknown>[];
  }
  return [];
}

async function simGet(path: string): Promise<unknown> {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
      if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
      if (r.status >= 500) { await sleep(500 * (a + 1)); continue; } // retry server errors
      if (!r.ok) return []; // 4xx client errors — don't retry
      return r.json();
    } catch {
      if (a < 5) await sleep(500 * (a + 1));
    }
  }
  return [];
}

async function fetchDayBlocks(date: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    let fetched: Record<string, unknown>[] = [];
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch(
          `${BASE_URL}/api/v1.0/companies/1/schedules/?pageSize=250&page=${page}&Date=${date}&expand=CostCenter`,
          { headers: hdrs, cache: "no-store" }
        );
        if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
        if (!r.ok) return all;
        const d = await r.json();
        fetched = Array.isArray(d) ? d : (d.Result ?? []);
        break;
      } catch {
        if (a < 3) await sleep(500 * (a + 1));
      }
    }
    all.push(...fetched);
    if (fetched.length < 250) break;
    page++;
  }
  return all;
}

function getWeekdays(year: number, month: number): string[] {
  const days: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() !== 0 && dt.getDay() !== 6)
      days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

// Date range rules (all using AEST today as the starting point):
// - Current month (May/All) → today → end of current month
// - Future month (June+)    → today → end of that future month
// - Past month              → full month (day 1 → last day)
function getRemainingWeekdays(year: number, month: number): string[] {
  const aest       = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const todayYear  = aest.getUTCFullYear();
  const todayMonth = aest.getUTCMonth() + 1;
  const todayDay   = aest.getUTCDate();

  const days: string[] = [];

  const pushWeekday = (y: number, m: number, d: number) => {
    const dt = new Date(y, m - 1, d);
    if (dt.getDay() !== 0 && dt.getDay() !== 6)
      days.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  };

  const isPast = year < todayYear || (year === todayYear && month < todayMonth);

  if (isPast) {
    // Past month: full month
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = 1; d <= lastDay; d++) pushWeekday(year, month, d);
    return days;
  }

  // Current or future month: today → end of target month.
  // Start from today in current month, carry through to end of target month.
  const curLast = new Date(todayYear, todayMonth, 0).getDate();
  for (let d = todayDay; d <= curLast; d++) pushWeekday(todayYear, todayMonth, d);

  let y = todayYear, m = todayMonth + 1;
  if (m > 12) { y++; m = 1; }
  while (y < year || (y === year && m <= month)) {
    const mLast = new Date(y, m, 0).getDate();
    for (let d = 1; d <= mLast; d++) pushWeekday(y, m, d);
    m++; if (m > 12) { y++; m = 1; }
  }
  return days;
}

// Discover tentative/alternate staff IDs (e.g. "Tentative - Muhammad", "TENTATIVE - RYAN G")
// The Schedule Breakdown report includes these alongside real staff IDs.
async function getTentativeStaffIds(): Promise<Set<number>> {
  try {
    const staff = listOf(await simGet(`/api/v1.0/companies/1/staff/?pageSize=250&columns=ID,Name`));
    const ids = new Set<number>();
    for (const s of staff) {
      const name = String(s.Name ?? "").toLowerCase();
      if (name.includes("tentative") || name.includes("training") || name.includes("non-billable")) {
        ids.add(s.ID as number);
      }
    }
    return ids;
  } catch { return new Set(); }
}

// ── Shared schedule-block + job-detail fetchers ───────────────────────────────
// Fetching blocks ONCE and job details ONCE prevents doubling SimPRO API calls
// (previously both fetchOtherBillable and fetchInvestedTime did identical Pass 1
// fetches in parallel, causing 429 rate-limit errors on longer date ranges).

const CFSP_TECH_ID = 1126;

type BlockInfo = { staffId: number; date: string; hours: number; jobId: string; costCentreId: number; sectionId: number; costCentreName: string };

// The 38 AFSS cost centres used in SimPRO's Schedule Breakdown filter.
// Only blocks whose cost centre name (case-insensitive) is in this set are counted.
const AFSS_CC_NAMES = new Set([
  "afe afex systems",
  "afe aspirating smoke det parts",
  "afe income",
  "afe speech intelligibility testing",
  "afe video fire servicing",
  "alh parts - not included in pm contract",
  "christadelphian included in comprehensive package",
  "consultancy - block plans",
  "contract comprehensive package",
  "contracts 6 monthly",
  "contracts annual",
  "contracts monthly",
  "contracts quarterly",
  "datacom: contracts",
  "datacom - door works",
  "datacom: electrical detection income",
  "datacom: electrical lights income",
  "datacom - mech air",
  "datacom: passive income",
  "datacom: portables income",
  "datacom: water income",
  "electrical detection & maintenance",
  "electrical light installation & maintenance",
  "equipment hire",
  "evc service attendance",
  "exclusions",
  "fuel levy income 2026",
  "material collection",
  "passive income - doors, etc",
  "portables exting recharge & pressure test",
  "portables portables division income",
  "portables swap & go extinguishers",
  "quote required -> send to kam",
  "safety check",
  "test book income",
  "water - fire pump repairs",
  "water flow testing",
  "water - supression - sprinklers - hyd - fhr",
]);

// Master cost centre IDs for AFSS work — confirmed stable via allstatus debug (2026-05).
// These are company-wide master IDs, not per-job assignments (different service types for
// the same client always produce different stable IDs).
// Add new IDs here when new AFSS cost centre types first appear in the schedule.
const KNOWN_AFSS_CC_IDS = new Set<number>([
  361944, // Contracts Annual
  364605, // Portables (type A)
  364606, // Portables (type B)
  364607, // Portables (type C)
  366362, // Portables — Ourimbah RE
  366676, // Material Collection
  // June 2026 — confirmed via blockccids debug + SimPRO Schedule Breakdown
  366702, // Electrical Detection & Maintenance (Job 444498 — Buildcorp)
  362953, // Consultancy - Block Plans (Job 441792 — IBIS Care)
  363815, // Consultancy - Block Plans (Job 442358 — Sleeping Giant)
  364810, // Consultancy - Block Plans (Job 443070 — The Owners SP)
  366596, // Portables Division Income (Job 444413 — A&I DEDIS)
  366467, // DATACOM: Passive Income (Job 444295 — SP 79059/PICA)
  // May 2026 — confirmed via excluded debug + SimPRO Schedule Breakdown 29/05/2026
  367774, // Electrical Detection & Maintenance (Job 445336 — The Owners Strata Plan 91612)
  // June 2026 — confirmed via blockccids debug
  366871, // Safety Check (Job 444623 — Redmen Fire Protection / Afternoon Safety Check)
  367112, // Portables (Job 444827 — REDMEN SAFETY CHECK JOB / Weekly PPE Goform Tuggerah)
]);

// Fetch cost centre names for each unique CC ID seen in blockList, then return
// the set of CC IDs that belong to the 38 AFSS cost centres.
// Uses the section detail endpoint with expand=CostCenter.
// block.Project.SectionID is the real section ID (confirmed 357827 ≠ 0).
// simGet handles 429 retries automatically.
async function fetchValidCcIds(blockList: BlockInfo[]): Promise<Set<number>> {
  // Map each unique costCentreId to its job+section (both available from the block)
  const ccToSect = new Map<number, { jobId: string; sectionId: number }>();
  for (const { costCentreId, jobId, sectionId } of blockList) {
    if (costCentreId && !ccToSect.has(costCentreId)) {
      ccToSect.set(costCentreId, { jobId, sectionId });
    }
  }
  if (ccToSect.size === 0) return new Set();

  // Sequential — avoids rate-limit pile-up that happens when all calls retry at once
  const valid = new Set<number>();
  for (const [ccId, { jobId, sectionId }] of ccToSect) {
    await sleep(400);
    try {
      const path = sectionId
        ? `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectionId}?expand=CostCenter`
        : `/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250`;
      const raw = await simGet(path);
      let sect: Record<string, unknown> | null = null;
      if (Array.isArray(raw)) {
        sect = listOf(raw)[0] ?? null;
      } else if (raw && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        sect = (Array.isArray(o.Result) ? o.Result[0] : o) as Record<string, unknown>;
      }
      if (!sect) continue;
      const cc = sect.CostCenter as Record<string, unknown> | undefined;
      const name = String(cc?.Name ?? "").toLowerCase();
      if (AFSS_CC_NAMES.has(name)) valid.add(ccId);
    } catch { /* skip this CC ID */ }
  }
  return valid;
}

function isExcludedJob(job: Record<string, unknown>): boolean {
  const techs = job.Technicians as Record<string, unknown>[] | undefined;
  if (techs?.some(t => (t as Record<string, unknown>).ID === CFSP_TECH_ID)) return true;
  const tags = job.Tags as Record<string, unknown>[] | undefined;
  if (tags?.some(t => String((t as Record<string, unknown>).Name ?? "").toLowerCase().includes("system testing"))) return true;
  return false;
}

function unwrapJob(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const d = raw as Record<string, unknown>;
  if (d.Result && typeof d.Result === "object" && !Array.isArray(d.Result))
    return d.Result as Record<string, unknown>;
  return d;
}

async function fetchAllScheduleBlocks(year: number, month: number, tentativeIds: Set<number>): Promise<BlockInfo[]> {
  const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
  // Use remaining weekdays (today → end of month) so data advances daily automatically.
  // For past months, falls back to full month so historical views still work.
  const days = getRemainingWeekdays(year, month);
  const blockList: BlockInfo[] = [];

  // Sequential fetches with short sleep — parallel fetching triggers SimPRO 429s
  // which cause exponential backoff and make rebuilds slower overall.
  for (const day of days) {
    const dayBlocks = await fetchDayBlocks(day);
    for (const block of dayBlocks) {
      const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
      if (!allIds.has(staffId)) continue;
      if (block.Type !== "job") continue;
      const hours = Number(block.TotalHours ?? 0);
      if (hours <= 0) continue;
      const proj = block.Project as Record<string, unknown>;
      const projectId = proj?.ProjectID;
      if (projectId == null) continue;
      const costCentreId   = Number(proj?.CostCenterID ?? 0);
      const sectionId      = Number(proj?.SectionID    ?? 0);
      const ccTop          = block?.CostCenter as Record<string, unknown> | undefined;
      const ccInProj       = proj?.CostCenter  as Record<string, unknown> | undefined;
      const costCentreName = String(ccTop?.Name ?? ccInProj?.Name ?? "");
      blockList.push({ staffId, date: day, hours, jobId: String(projectId), costCentreId, sectionId, costCentreName });
    }
    await sleep(150);
  }

  return blockList;
}

async function fetchJobDetailsMap(jobIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (jobIds.length === 0) return map;
  // Batch 5 at a time with a 250ms gap — firing all in parallel causes SimPRO
  // 429s that make job fetches return null, silently dropping schedule blocks.
  const BATCH = 5;
  for (let i = 0; i < jobIds.length; i += BATCH) {
    const batch = jobIds.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(id =>
        simGet(`/api/v1.0/companies/1/jobs/${id}?expand=Sections.CostCenter`).catch(() => null)
      )
    );
    for (let j = 0; j < batch.length; j++) {
      const raw = results[j];
      if (!raw) continue;
      map.set(batch[j], unwrapJob(raw));
    }
    if (i + BATCH < jobIds.length) await sleep(250);
  }
  return map;
}

// Invested Time clients — only these go to Invested Time; everything else is Other Billable.
const INTERNAL_CLIENTS = ["REDMEN FIRE", "AFAC", "ADAIR OPERATION", "Z SAFE"];

function isInternalClient(job: Record<string, unknown>): boolean {
  const custName = String((job.Customer as Record<string, unknown>)?.CompanyName ?? "").toUpperCase();
  return INTERNAL_CLIENTS.some(ex => custName.includes(ex));
}

// Invested Time = schedule blocks for internal clients (Redmen Fire, Z SAFE OS, AFAC, Adair).
// Only "Pending" stage — matches SimPRO's Schedule Breakdown "Job Stage: Pending" filter.
// Each scheduled block counts as its own job entry — 3 Z SAFE OS jobs = 3.
function calcInvestedTime(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>): TechSupportStats {
  const stat: TechSupportStats = { jobs: 0, hours: 0, amount: 0 };
  const seen = new Set<string>();

  for (const { staffId, date, hours, jobId } of blockList) {
    const job = jobMap.get(jobId);
    if (!job) continue;
    const stage = String(job.Stage ?? "").toLowerCase();
    if (stage !== "pending") continue;
    if (!isInternalClient(job)) continue;
    const key = `${staffId}-${date}-${jobId}`;
    stat.hours  = Math.round((stat.hours + hours) * 100) / 100;
    stat.amount = Math.round((stat.amount + hours * RATE) * 100) / 100;
    if (!seen.has(key)) { seen.add(key); stat.jobs++; }
  }

  return stat;
}

// Other Billable = AFSS cost-centre schedule blocks for EXTERNAL clients, Pending stage.
// Internal clients (Redmen Fire Protection, Z SAFE OS, Adair, AFAC) go to Invested Time.
function calcOtherBillable(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>): TechSupportStats {
  const stat: TechSupportStats = { jobs: 0, hours: 0, amount: 0 };

  for (const { hours, jobId } of blockList) {
    const job = jobMap.get(jobId);
    if (!job) continue;
    const stage = String(job.Stage ?? "").toLowerCase();
    if (stage !== "pending") continue;
    if (isInternalClient(job)) continue;
    stat.jobs++;
    stat.hours  = Math.round((stat.hours + hours) * 100) / 100;
    stat.amount = Math.round((stat.amount + hours * RATE) * 100) / 100;
  }

  return stat;
}

function aggregateQA(rawJobs: QARawJob[], dateTo: string): TechSupportStats {
  // Only include pending QA jobs that have a due date set and it falls on or before dateTo.
  // Jobs with no DueDate are template/unscheduled jobs — exclude them to match SimPRO's count.
  const filtered = rawJobs.filter(j => j.dueDate && j.dueDate <= dateTo);
  return filtered.reduce<TechSupportStats>(
    (acc, j) => ({
      jobs:   acc.jobs + 1,
      hours:  Math.round((acc.hours + j.estHours) * 100) / 100,
      amount: Math.round((acc.amount + j.estHours * RATE) * 100) / 100,
    }),
    { jobs: 0, hours: 0, amount: 0 }
  );
}

// "All" uses the current month — so refresh / All shows the same data as selecting
// the current month (today → end of current month).
function getQADateTo(year: number, month: number, all: boolean): string {
  const aest        = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const targetYear  = all ? aest.getUTCFullYear()  : year;
  const targetMonth = all ? aest.getUTCMonth() + 1 : month;
  const lastDay     = new Date(targetYear, targetMonth, 0).getDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function toResponse(cache: CacheData, dateTo: string): TechSupportResponse {
  return {
    otherBillable:    cache.otherBillable,
    investedTime:     cache.investedTime,
    qualityAssurance: aggregateQA(cache.qaRawJobs ?? [], dateTo),
  };
}

// Look up the ID of "A Quality Assurance Officer" staff member
async function getQAOfficerId(): Promise<number | null> {
  try {
    const staff = listOf(await simGet(`/api/v1.0/companies/1/staff/?pageSize=250&columns=ID,Name`));
    for (const s of staff) {
      if (String(s.Name ?? "").toLowerCase().includes("quality assurance")) {
        return s.ID as number;
      }
    }
    return null;
  } catch { return null; }
}

// ── Quality Assurance ─────────────────────────────────────────────────────────
// Fetches all Pending jobs for company 1 assigned to "A Quality Assurance Officer".
// Returns raw list so the GET handler can apply date filtering per the month selector.
// Cached in memory for the lifetime of the server process — avoids re-fetching
// the staff list on every buildResponse call and prevents rate-limit failures.
let _cachedQaId: number | null | undefined = undefined;
async function resolvedQaId(): Promise<number | null> {
  if (_cachedQaId !== undefined) return _cachedQaId;
  _cachedQaId = await getQAOfficerId();
  return _cachedQaId;
}

async function fetchQualityAssurance(): Promise<QARawJob[]> {
  const rawJobs: QARawJob[] = [];

  const qaId = await resolvedQaId();
  if (!qaId) return rawJobs;

  const cols = "ID,Totals,Technicians,DueDate";
  const seen = new Set<unknown>();

  let items: Record<string, unknown>[] = [];
  try {
    const first = listOf(await simGet(
      `/api/v1.0/companies/1/jobs/?pageSize=250&columns=${cols}&Stage=Pending&page=1`
    ));
    items = first;
    if (first.length === 250) {
      const extraPages = await Promise.all(
        Array.from({ length: 9 }, (_, i) => i + 2).map(p =>
          simGet(`/api/v1.0/companies/1/jobs/?pageSize=250&columns=${cols}&Stage=Pending&page=${p}`)
            .then(listOf).catch((): Record<string, unknown>[] => [])
        )
      );
      for (const page of extraPages) {
        items = items.concat(page);
        if (page.length < 250) break;
      }
    }
  } catch { return rawJobs; }

  for (const job of items) {
    if (seen.has(job.ID)) continue;
    const techs = job.Technicians as Record<string, unknown>[] | undefined;
    const hasQA = techs?.some(t => (t as Record<string, unknown>).ID === qaId);
    if (!hasQA) continue;
    seen.add(job.ID);
    const totals = job.Totals as Record<string, unknown> | undefined;
    const res    = totals?.ResourcesCost as Record<string, unknown> | undefined;
    const labHrs = res?.LaborHours as Record<string, unknown> | undefined;
    const est    = labHrs?.Estimate != null ? Number(labHrs.Estimate) : 0;
    rawJobs.push({
      id:       job.ID,
      dueDate:  String(job.DueDate ?? ""),
      estHours: est > 0 ? est : 2,
    });
  }
  return rawJobs;
}

// For blocks whose CC is still unresolved (not in KNOWN list, not in cache, name empty),
// fetch the job's sections list with expand=CostCenter to get the CC name.
// Sequential with 400ms sleep to stay within SimPRO rate limits.
// Returns a jobId→ccName map for zero-costCentreId blocks that can't be looked up by CC ID.
async function resolveViaJobSections(
  blocks: BlockInfo[],
  idCache: Map<number, string>,
): Promise<Map<string, string>> {
  const jobCcByJobId = new Map<string, string>();

  // Collect unique jobIds that still have unresolved CCs
  const jobIds = new Set<string>();
  for (const b of blocks) {
    if (KNOWN_AFSS_CC_IDS.has(b.costCentreId)) continue;
    if (b.costCentreName.length > 0) continue;
    if (b.costCentreId > 0 && idCache.has(b.costCentreId) && idCache.get(b.costCentreId)!.length > 0) continue;
    jobIds.add(b.jobId);
  }

  for (const jobId of jobIds) {
    await sleep(100);
    try {
      const raw = await simGet(
        `/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250&expand=CostCenter`
      );
      for (const sect of listOf(raw)) {
        const cc = sect.CostCenter as Record<string, unknown> | undefined;
        if (!cc) continue;
        const id   = Number(cc.ID   ?? 0);
        const name = String(cc.Name ?? "");
        if (id > 0 && name.length > 0) {
          if (!idCache.has(id)) idCache.set(id, name);
          if (!jobCcByJobId.has(jobId)) jobCcByJobId.set(jobId, name);
        }
      }
    } catch { /* skip */ }
  }

  return jobCcByJobId;
}

// DATACOM cost centre IDs and name check — used by the no-DATACOM dashboard variant.
const DATACOM_CC_IDS = new Set<number>([366467]);
function isDatacomBlock(b: BlockInfo, ccNameCache: Map<number, string>, jobDerivedCcNames: Map<number, string>, jobCcByJobId: Map<string, string>): boolean {
  if (DATACOM_CC_IDS.has(b.costCentreId)) return true;
  const dc = (n: string) => n.toLowerCase().startsWith("datacom");
  if (b.costCentreName.length > 0 && dc(b.costCentreName)) return true;
  const fromJob = jobDerivedCcNames.get(b.costCentreId);
  if (fromJob && dc(fromJob)) return true;
  if (b.costCentreId > 0 && ccNameCache.has(b.costCentreId)) {
    const n = ccNameCache.get(b.costCentreId)!;
    if (n.length > 0 && dc(n)) return true;
  }
  if (b.costCentreId === 0) {
    const jobCc = jobCcByJobId.get(b.jobId);
    if (jobCc && dc(jobCc)) return true;
  }
  return false;
}

// Dedup concurrent builds — warmup + page-load both call buildResponse at startup.
// Without this, two simultaneous full-month fetches hammer SimPRO and cause 429s.
// forceNew=true cancels any stale in-flight and starts a guaranteed-fresh build.
const _buildInFlight = new Map<string, Promise<CacheData>>();
function buildResponseDeduped(year: number, month: number, excludeDatacom = false, forceNew = false): Promise<CacheData> {
  const key = `${year}-${month}${excludeDatacom ? "-nodc" : ""}`;
  if (forceNew) _buildInFlight.delete(key); // kill stale in-flight so we start fresh
  let p = _buildInFlight.get(key);
  if (!p) {
    p = buildResponse(year, month, excludeDatacom).finally(() => _buildInFlight.delete(key));
    _buildInFlight.set(key, p);
  }
  return p;
}

export async function warmTechSupport(): Promise<void> {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year = aest.getUTCFullYear();
  const month = aest.getUTCMonth() + 1;
  // Warm both regular and nodc variants so the first user request hits cache,
  // not a cold SimPRO fetch that races against rate-limit recovery.
  const data = await buildResponseDeduped(year, month);
  await writeCache(year, month, data);
  await writeFallback(year, month, data);
  await sleep(2000);
  const dataNodc = await buildResponseDeduped(year, month, true);
  await writeCache(year, month, dataNodc, true);
  await writeFallback(year, month, dataNodc, true);
}

// Extract CC id→name from job details already fetched with expand=Sections.CostCenter.
// Resolves CC names for blocks whose CC name is empty from the schedule API —
// no extra API calls, since job details are always fetched for Other Billable/Invested Time.
function extractCcNamesFromJobs(jobMap: Map<string, Record<string, unknown>>): Map<number, string> {
  const result = new Map<number, string>();
  for (const job of jobMap.values()) {
    const sections = (job.Sections ?? []) as Record<string, unknown>[];
    for (const sect of sections) {
      const cc = sect.CostCenter as Record<string, unknown> | undefined;
      if (!cc) continue;
      const id   = Number(cc.ID  ?? 0);
      const name = String(cc.Name ?? "");
      if (id > 0 && name.length > 0 && !result.has(id)) result.set(id, name);
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function buildResponse(year: number, month: number, excludeDatacom = false): Promise<CacheData> {
  const tentativeIds = await getTentativeStaffIds();

  // Fetch schedule blocks ONCE — shared between Other Billable and Invested Time.
  const rawBlockList = await fetchAllScheduleBlocks(year, month, tentativeIds);

  // Fetch job details for ALL raw block job IDs up front.
  // expand=Sections.CostCenter gives us CC names without extra per-section API calls.
  const allRawJobIds = [...new Set(rawBlockList.map(b => b.jobId))];
  const [jobMap, qaRawJobs] = await Promise.all([
    fetchJobDetailsMap(allRawJobIds),
    fetchQualityAssurance(),
  ]);

  // Build CC id→name from job sections (free — data already fetched).
  // Covers blocks whose CC name was empty from the schedule expand=CostCenter.
  const jobDerivedCcNames = extractCcNamesFromJobs(jobMap);

  // Merge job-section CC names into persistent cache.
  const ccNameCache = await loadCcNameCache();
  for (const [id, name] of jobDerivedCcNames) {
    if (!ccNameCache.has(id)) ccNameCache.set(id, name);
  }
  await resolveCcNames(rawBlockList, ccNameCache);

  // Resolve CC names for remaining unknown blocks via job sections endpoint.
  // Persists discovered names so future rebuilds are faster.
  const jobCcByJobId = await resolveViaJobSections(rawBlockList, ccNameCache);
  await saveCcNameCache(ccNameCache);

  // Filter to AFSS cost centres.
  const blockList = rawBlockList.filter(b => {
    if (KNOWN_AFSS_CC_IDS.has(b.costCentreId)) return true;
    if (b.costCentreName.length > 0) return AFSS_CC_NAMES.has(b.costCentreName.toLowerCase());
    const fromJob = jobDerivedCcNames.get(b.costCentreId);
    if (fromJob) return AFSS_CC_NAMES.has(fromJob.toLowerCase());
    if (b.costCentreId > 0 && ccNameCache.has(b.costCentreId)) {
      const n = ccNameCache.get(b.costCentreId)!;
      return n.length > 0 && AFSS_CC_NAMES.has(n.toLowerCase());
    }
    if (b.costCentreId === 0) {
      const jobCc = jobCcByJobId.get(b.jobId);
      if (jobCc) return AFSS_CC_NAMES.has(jobCc.toLowerCase());
    }
    return false;
  });

  // For the no-DATACOM variant: remove any blocks whose cost centre is DATACOM.
  const activeBlockList = excludeDatacom
    ? blockList.filter(b => !isDatacomBlock(b, ccNameCache, jobDerivedCcNames, jobCcByJobId))
    : blockList;

  // Other Billable: AFSS blocks for EXTERNAL clients, Pending stage.
  // Invested Time: ALL blocks for INTERNAL clients (Redmen Fire Protection, Z SAFE OS,
  // Adair, AFAC) — Pending stage. This includes AFSS jobs like Safety Check booked
  // for Redmen Fire Protection, as well as any non-AFSS internal work.
  const otherBillable = calcOtherBillable(activeBlockList, jobMap);
  const investedTime  = calcInvestedTime(activeBlockList, jobMap);

  return { otherBillable, investedTime, qaRawJobs };
}

export async function GET(req: Request) {
  const url   = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const all   = url.searchParams.get("all")   === "1";
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000); // UTC+10 (AEST)
  const year  = url.searchParams.get("year")  ? Number(url.searchParams.get("year"))  : aest.getUTCFullYear();
  const month = url.searchParams.get("month") ? Number(url.searchParams.get("month")) : aest.getUTCMonth() + 1;
  const range = getQADateTo(year, month, all);

  // Fast debug: shows all unique CC IDs in the month's blocks — no extra API calls.
  // Use this to discover new CC IDs, then hardcode AFSS ones in KNOWN_AFSS_CC_IDS.
  if (url.searchParams.get("debug") === "blockccids") {
    const tentativeIds = await getTentativeStaffIds();
    const rawBlocks = await fetchAllScheduleBlocks(year, month, tentativeIds);
    const seen = new Map<number, { jobId: string; date: string }>();
    for (const b of rawBlocks) {
      if (b.costCentreId && !seen.has(b.costCentreId)) {
        seen.set(b.costCentreId, { jobId: b.jobId, date: b.date });
      }
    }
    return NextResponse.json({
      totalBlocks: rawBlocks.length,
      uniqueCCIds: [...seen.entries()].map(([ccId, v]) => ({
        ccId, jobId: v.jobId, firstSeen: v.date,
        inKnownList: KNOWN_AFSS_CC_IDS.has(ccId),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: shows every block excluded by the CC ID filter — with job ID, date, staff, CC ID.
  // Use this to identify which excluded blocks are actually AFSS (cross-ref with SimPRO).
  if (url.searchParams.get("debug") === "excluded") {
    const tentativeIds = await getTentativeStaffIds();
    const rawBlocks = await fetchAllScheduleBlocks(year, month, tentativeIds);
    const excluded = rawBlocks
      .filter(b => !KNOWN_AFSS_CC_IDS.has(b.costCentreId))
      .map(b => ({ jobId: b.jobId, date: b.date, staffId: b.staffId, ccId: b.costCentreId, hours: b.hours }));
    const passed = rawBlocks.filter(b => KNOWN_AFSS_CC_IDS.has(b.costCentreId));
    return NextResponse.json({
      totalBlocks: rawBlocks.length,
      passedCount: passed.length,
      excludedCount: excluded.length,
      excluded,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: full pipeline — shows every block with resolved CC name, AFSS pass/fail,
  // and why each block is or isn't counted in Other Billable (excludeDatacom applied).
  // Use to identify missing blocks vs SimPRO's Schedule Breakdown count.
  if (url.searchParams.get("debug") === "obfull") {
    const nodc2 = url.searchParams.get("excludeDatacom") === "1";
    const tentativeIds2 = await getTentativeStaffIds();
    const rawBlocks2 = await fetchAllScheduleBlocks(year, month, tentativeIds2);
    const allJobIds2 = [...new Set(rawBlocks2.map(b => b.jobId))];
    const jobMap2 = await fetchJobDetailsMap(allJobIds2);
    const jobDerived2 = extractCcNamesFromJobs(jobMap2);
    const ccCache2 = await loadCcNameCache();
    for (const [id, name] of jobDerived2) if (!ccCache2.has(id)) ccCache2.set(id, name);
    await resolveCcNames(rawBlocks2, ccCache2);
    const jobCcByJob2 = await resolveViaJobSections(rawBlocks2, ccCache2);
    await saveCcNameCache(ccCache2);

    function resolvedCcName(b: BlockInfo): string {
      if (b.costCentreName.length > 0) return b.costCentreName;
      const fromJob = jobDerived2.get(b.costCentreId);
      if (fromJob) return fromJob;
      if (b.costCentreId > 0 && ccCache2.has(b.costCentreId)) return ccCache2.get(b.costCentreId)!;
      if (b.costCentreId === 0) return jobCcByJob2.get(b.jobId) ?? "";
      return "";
    }

    function passesAfss(b: BlockInfo): boolean {
      if (KNOWN_AFSS_CC_IDS.has(b.costCentreId)) return true;
      const n = resolvedCcName(b);
      return n.length > 0 && AFSS_CC_NAMES.has(n.toLowerCase());
    }

    const report = rawBlocks2.map(b => {
      const ccName = resolvedCcName(b);
      const afss = passesAfss(b);
      const isDatacom = nodc2 && isDatacomBlock(b, ccCache2, jobDerived2, jobCcByJob2);
      const job = jobMap2.get(b.jobId);
      const stage = job ? String(job.Stage ?? "").toLowerCase() : "not-fetched";
      const internal = job ? isInternalClient(job) : null;
      let obStatus: string;
      if (!afss)        obStatus = "excluded-cc";
      else if (isDatacom) obStatus = "excluded-datacom";
      else if (!job)    obStatus = "excluded-job-not-fetched";
      else if (stage !== "pending") obStatus = `excluded-stage-${stage}`;
      else if (internal) obStatus = "excluded-internal";
      else              obStatus = "COUNTED";
      return { jobId: b.jobId, date: b.date, staffId: b.staffId, ccId: b.costCentreId, ccName, hours: b.hours, afss, obStatus };
    });

    const counted = report.filter(r => r.obStatus === "COUNTED");
    return NextResponse.json({
      totalRawBlocks: rawBlocks2.length,
      otherBillableCount: counted.length,
      blocks: report,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug mode: show invested-time customers and their pending job counts
  if (url.searchParams.get("debug") === "invested") {
    const tentativeIds = await getTentativeStaffIds();
    const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
    const days = getRemainingWeekdays(year, month);
    const jobIdSet = new Set<number>();

    for (let i = 0; i < days.length; i += 4) {
      const batch = days.slice(i, i + 4);
      const res   = await Promise.all(batch.map(fetchDayBlocks));
      for (let j = 0; j < batch.length; j++) {
        for (const block of res[j]) {
          const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
          if (!allIds.has(staffId)) continue;
          if (block.Type !== "job") continue;
          const projectId = (block.Project as Record<string, unknown>)?.ProjectID;
          const jobId = projectId != null ? Number(projectId) : NaN;
          if (!isNaN(jobId) && jobId > 0) jobIdSet.add(jobId);
        }
      }
      if (i + 4 < days.length) await sleep(100);
    }

    const schedJobIds = [...jobIdSet];
    const schedJobResults = await Promise.all(
      schedJobIds.map(id =>
        simGet(`/api/v1.0/companies/1/jobs/${id}?columns=ID,Customer,Stage,Technicians,Tags`).catch(() => null)
      )
    );

    const schedJobDebug: Record<string, unknown>[] = [];
    const customerIdSet = new Set<number>();
    for (let i = 0; i < schedJobIds.length; i++) {
      const raw = schedJobResults[i];
      if (!raw) continue;
      const job = unwrapJob(raw);
      const stage = String(job.Stage ?? "");
      const excluded = isExcludedJob(job);
      const custId = (job.Customer as Record<string, unknown>)?.ID as number | undefined;
      const custName = (job.Customer as Record<string, unknown>)?.CompanyName as string | undefined;
      const passed = stage.toLowerCase() === "pending" && !excluded;
      if (passed && custId) customerIdSet.add(custId);
      schedJobDebug.push({ jobId: schedJobIds[i], stage, excluded, passed, custId, custName });
    }

    // Fetch page 1 three ways to compare what each returns
    const [pendingNoCol, pendingWithCust, pendingWithTotals] = await Promise.all([
      simGet(`/api/v1.0/companies/1/jobs/?pageSize=5&Stage=Pending&page=1`).then(listOf).catch(() => [] as Record<string, unknown>[]),
      simGet(`/api/v1.0/companies/1/jobs/?pageSize=5&Stage=Pending&columns=ID,Customer&page=1`).then(listOf).catch(() => [] as Record<string, unknown>[]),
      simGet(`/api/v1.0/companies/1/jobs/?pageSize=5&Stage=Pending&columns=ID,Totals,Customer&page=1`).then(listOf).catch(() => [] as Record<string, unknown>[]),
    ]);

    return NextResponse.json({
      days, schedJobDebug, customerIds: [...customerIdSet],
      sample_noColumns:        { count: (pendingNoCol as unknown[]).length,     first: pendingNoCol[0]     ?? null },
      sample_colsIDCustomer:   { count: (pendingWithCust as unknown[]).length,  first: pendingWithCust[0]  ?? null },
      sample_colsIDTotalsCust: { count: (pendingWithTotals as unknown[]).length,first: pendingWithTotals[0]?? null },
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: raw block structure for a single date
  if (url.searchParams.get("debug") === "rawblock") {
    const date = url.searchParams.get("date") ?? `${year}-${String(month).padStart(2,"0")}-02`;
    const blocks = await fetchDayBlocks(date);
    return NextResponse.json({ date, count: blocks.length, first3: blocks.slice(0, 3) }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: full job detail to see cost centre structure
  if (url.searchParams.get("debug") === "jobdetail") {
    const jobId = url.searchParams.get("jobid") ?? "441099";
    const raw = await simGet(`/api/v1.0/companies/1/jobs/${jobId}`);
    return NextResponse.json({ jobId, keys: Object.keys((raw as Record<string,unknown>)?.Result ?? raw as object ?? {}), raw }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: verify stages using full detail (no columns) — same as production fetchJobDetailsMap
  if (url.searchParams.get("debug") === "fullstages") {
    const ids = ["441099","444221","444413","444295","444482","442948","442949","442950", // "passed" production jobs
                 "444220","444412","442700","441072","443386","443837"]; // excluded + stage-suspect
    const results = await Promise.all(ids.map(id =>
      simGet(`/api/v1.0/companies/1/jobs/${id}`).then(r => {
        const j = ((r as Record<string,unknown>).Result ?? r) as Record<string,unknown>;
        const cfsp = (j.Technicians as Record<string,unknown>[] ?? []).some(t => t.ID === CFSP_ID);
        return { id, stage: j.Stage, cfsp, cust: (j.Customer as Record<string,unknown>)?.CompanyName };
      }).catch(() => ({ id, stage: "ERR", cfsp: false, cust: null }))
    ));
    return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: compare Type field across passed vs excluded jobs
  if (url.searchParams.get("debug") === "jobtypes") {
    const jobIds = ["441099","444221","444413","444295","443837","444482","442948", // passed
                    "442700","444220","444412","441072","443386","442713"]; // excluded
    const results = await Promise.all(jobIds.map(id =>
      simGet(`/api/v1.0/companies/1/jobs/${id}?columns=ID,Type,Stage,Customer`).then(r => {
        const j = ((r as Record<string,unknown>).Result ?? r) as Record<string,unknown>;
        return { id, type: j.Type, stage: j.Stage, cust: (j.Customer as Record<string,unknown>)?.CompanyName };
      }).catch(() => ({ id, type: "ERR", stage: null, cust: null }))
    ));
    return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: compare sections between two jobs
  if (url.searchParams.get("debug") === "compsects") {
    const [s220, s221, s412, s413] = await Promise.all([
      simGet(`/api/v1.0/companies/1/jobs/444220/sections/`),
      simGet(`/api/v1.0/companies/1/jobs/444221/sections/`),
      simGet(`/api/v1.0/companies/1/jobs/444412/sections/`),
      simGet(`/api/v1.0/companies/1/jobs/444413/sections/`),
    ]);
    return NextResponse.json({ j444220: s220, j444221: s221, j444412: s412, j444413: s413 }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: schedule blocks with CostCenter expand to get cost centre names
  if (url.searchParams.get("debug") === "ccexpand") {
    const date = url.searchParams.get("date") ?? "2026-05-29";
    const r = await fetch(`${BASE_URL}/api/v1.0/companies/1/schedules/?pageSize=10&Date=${date}&expand=CostCenter`, { headers: hdrs, cache: "no-store" });
    const body = await r.json();
    const blocks = Array.isArray(body) ? body : (body.Result ?? []);
    // Show first 3 blocks that have staff in our team
    const tentativeIds = await getTentativeStaffIds();
    const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
    const teamBlocks = (blocks as Record<string,unknown>[]).filter(b => allIds.has((b.Staff as Record<string,unknown>)?.ID as number));
    return NextResponse.json({ date, count: (blocks as unknown[]).length, teamCount: teamBlocks.length, first2Team: teamBlocks.slice(0,2), first2Any: (blocks as unknown[]).slice(0,2) }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: probe cost centre entity paths
  if (url.searchParams.get("debug") === "sections") {
    const paths = [
      `/api/v1.0/companies/1/resources/costcentres/?pageSize=5`,
      `/api/v1.0/companies/1/costCentres/?pageSize=5`,
      `/api/v1.0/companies/1/trade/resources/?pageSize=5`,
      `/api/v1.0/companies/1/schedules/?pageSize=2&Date=2026-05-29&expand=CostCenter`,
      `/api/v1.0/companies/1/schedules/?pageSize=2&Date=2026-05-29&columns=ID,Project,CostCenter`,
      `/api/v1.0/companies/0/costcentres/?pageSize=5`,
    ];
    const results: Record<string, unknown>[] = [];
    for (const p of paths) {
      try {
        const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        results.push({ path: p, status: r.status, bodyPreview: JSON.stringify(body).substring(0, 300) });
      } catch (e) { results.push({ path: p, error: String(e) }); }
    }
    return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: for team member blocks in a date range, show unique CostCenterIDs + names via job sections
  if (url.searchParams.get("debug") === "costcentres") {
    const tentativeIds = await getTentativeStaffIds();
    const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
    const days = getRemainingWeekdays(year, month);
    const ccMap = new Map<number, { jobId: string; sectionId: number }>();
    for (const day of days) {
      const blocks = await fetchDayBlocks(day);
      for (const block of blocks) {
        const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
        if (!allIds.has(staffId)) continue;
        if (block.Type !== "job") continue;
        const proj = block.Project as Record<string, unknown>;
        const ccId = proj?.CostCenterID as number;
        const sectionId = proj?.SectionID as number;
        const jobId = String(proj?.ProjectID ?? "");
        if (ccId && !ccMap.has(ccId)) ccMap.set(ccId, { jobId, sectionId });
      }
      await sleep(100);
    }
    // Fetch one section per unique costCentreId to get its name
    const ccIds = [...ccMap.keys()];
    const results: { ccId: number; jobId: string; name?: string }[] = [];
    for (const ccId of ccIds) {
      const { jobId, sectionId } = ccMap.get(ccId)!;
      const raw = await simGet(`/api/v1.0/companies/1/jobs/${jobId}/sections/${sectionId}?columns=ID,Name,CostCenter`) as Record<string, unknown>;
      const sect = (raw?.Result ?? raw) as Record<string, unknown>;
      const cc = sect?.CostCenter as Record<string, unknown> | undefined;
      results.push({ ccId, jobId, name: String(cc?.Name ?? sect?.Name ?? "") });
      await sleep(100);
    }
    return NextResponse.json({ totalUniqueCCs: ccIds.length, costCentres: results }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show raw block Project structure + multiple section URL variants for one job
  if (url.searchParams.get("debug") === "rawsect") {
    const jobId = url.searchParams.get("jobid") ?? "441099";
    const date  = url.searchParams.get("date")  ?? "2026-05-29";
    // Raw block (with expand=CostCenter) to see Project structure
    const rawBlocks = await fetchDayBlocks(date);
    const teamBlock = rawBlocks.find(b =>
      String((b.Project as Record<string,unknown>)?.ProjectID ?? "") === jobId
    );
    // Try multiple section URL variants to find which works
    const variants = [
      `/api/v1.0/companies/1/jobs/${jobId}/sections/`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/?columns=ID,Name,CostCenter`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250&columns=ID,CostCenter`,
    ];
    const sectResults = await Promise.all(variants.map(async p => {
      const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
      const body = r.ok ? await r.json() : null;
      return { path: p, status: r.status, body };
    }));
    return NextResponse.json({ jobId, date, blockProject: teamBlock ? (teamBlock.Project ?? null) : "not found", sectResults }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show what cost centre names the sections list returns + whether they pass the AFSS filter
  if (url.searchParams.get("debug") === "ccnames") {
    const tentativeIds = await getTentativeStaffIds();
    const rawBlocks = await fetchAllScheduleBlocks(year, month, tentativeIds);
    // Also show costCentreName from expand=CostCenter on first few blocks
    const expandSample = rawBlocks.slice(0, 5).map(b => ({ jobId: b.jobId, ccId: b.costCentreId, ccName: b.costCentreName }));
    const ccToJob = new Map<number, string>();
    for (const { costCentreId, jobId } of rawBlocks) {
      if (costCentreId && !ccToJob.has(costCentreId)) ccToJob.set(costCentreId, jobId);
    }
    const lookupResults = await Promise.all(
      [...ccToJob.entries()].map(([ccId, jobId]) =>
        simGet(`/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250&columns=ID,Name,CostCenter`)
          .then(r => {
            const sections = listOf(r);
            for (const sect of sections) {
              const cc = sect.CostCenter as Record<string, unknown> | undefined;
              if (Number(cc?.ID ?? 0) === ccId) {
                const name = String(cc?.Name ?? sect.Name ?? "");
                return { ccId, jobId, name, inAFSS: AFSS_CC_NAMES.has(name.toLowerCase()), sectRaw: sect };
              }
            }
            return { ccId, jobId, name: "", inAFSS: false, sectCount: sections.length, firstSect: sections[0] ?? null };
          })
          .catch(e => ({ ccId, jobId, name: "ERR: " + String(e), inAFSS: false }))
      )
    );
    return NextResponse.json({
      totalBlocks: rawBlocks.length, uniqueCCs: ccToJob.size, results: lookupResults,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show status + CC ID for every unique job in the month's block list
  if (url.searchParams.get("debug") === "allstatus") {
    const tentativeIds = await getTentativeStaffIds();
    const rawBlocks    = await fetchAllScheduleBlocks(year, month, tentativeIds);
    const uniqueJobIds = [...new Set(rawBlocks.map(b => b.jobId))];
    const rows: { jobId: string; statusId: unknown; statusName: unknown; customer: string; ccId: number }[] = [];
    for (const id of uniqueJobIds) {
      await sleep(350);
      const raw = await simGet(`/api/v1.0/companies/1/jobs/${id}?columns=ID,Status,Customer`);
      const job  = unwrapJob(raw);
      const st   = job.Status as Record<string, unknown> | undefined;
      const ccId = rawBlocks.find(b => b.jobId === id)?.costCentreId ?? 0;
      rows.push({
        jobId:      id,
        statusId:   st?.ID   ?? null,
        statusName: st?.Name ?? null,
        customer:   String((job.Customer as Record<string, unknown>)?.CompanyName ?? ""),
        ccId,
      });
    }
    return NextResponse.json({ totalBlocks: rawBlocks.length, uniqueJobs: rows.length, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: read section lines (cost centre line items) — uses simGet so it retries 429s
  if (url.searchParams.get("debug") === "sectlines") {
    const jobId  = url.searchParams.get("jobid")  ?? "441099";
    const sectId = url.searchParams.get("sectid") ?? "357827";
    const linesRaw   = await simGet(`/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}/lines/?pageSize=10`);
    await sleep(1500);
    const chargesRaw = await simGet(`/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}/charges/?pageSize=10`);
    return NextResponse.json({
      jobId, sectId,
      lines:   { count: listOf(linesRaw).length,   first: listOf(linesRaw)[0]   ?? null, raw: linesRaw   },
      charges: { count: listOf(chargesRaw).length, first: listOf(chargesRaw)[0] ?? null, raw: chargesRaw },
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: check CustomFields + final unexplored section sub-resources
  if (url.searchParams.get("debug") === "ccfinal") {
    const jobId  = url.searchParams.get("jobid") ?? "441099";
    const sectId = "357827";
    const jobRaw = await simGet(`/api/v1.0/companies/1/jobs/${jobId}?columns=ID,CustomFields,Status`);
    const customFields = unwrapJob(jobRaw).CustomFields;
    const status       = unwrapJob(jobRaw).Status;
    const probes = [
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}/costcentrelines/`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}/lines/`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}/charges/`,
      `/api/v1.0/companies/1/resources/?pageSize=3`,
      `/api/v1.0/companies/1/catalogue/?pageSize=3`,
    ];
    const probeResults: { path: string; status: number; preview: string }[] = [];
    for (const p of probes) {
      await sleep(600);
      try {
        const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        probeResults.push({ path: p, status: r.status, preview: JSON.stringify(body).substring(0, 400) });
      } catch (e) { probeResults.push({ path: p, status: -1, preview: String(e) }); }
    }
    return NextResponse.json({ jobId, sectId, customFields, status, probeResults }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show ALL top-level keys on the job detail + try master CC list endpoint
  if (url.searchParams.get("debug") === "jobkeys") {
    const jobId = url.searchParams.get("jobid") ?? "441099";
    const raw = await simGet(`/api/v1.0/companies/1/jobs/${jobId}`);
    const job  = unwrapJob(raw);
    const topKeys = Object.keys(job);
    // Summarise each field: show value if scalar, "(object)" or "(array:N)" if complex
    const summary: Record<string, unknown> = {};
    for (const k of topKeys) {
      const v = job[k];
      if (Array.isArray(v))             summary[k] = `(array:${v.length})`;
      else if (v && typeof v === "object") summary[k] = `(object:${Object.keys(v as object).join(",")})`;
      else                              summary[k] = v;
    }
    await sleep(1000);
    // Also try master CC list (list, no ID filter)
    const ccRaw  = await simGet(`/api/v1.0/companies/1/costcentres/?pageSize=5`);
    const ccList = listOf(ccRaw);
    return NextResponse.json({ jobId, topKeys, summary, ccListCount: ccList.length, ccListFirst: ccList[0] ?? null }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show EVERY field on the raw schedule block for a known job (uses simGet retry)
  if (url.searchParams.get("debug") === "blockkeys") {
    const date  = url.searchParams.get("date")  ?? "2026-05-29";
    const jobId = url.searchParams.get("jobid") ?? "441099";
    const raw = await simGet(`/api/v1.0/companies/1/schedules/?pageSize=250&Date=${date}&expand=CostCenter`);
    const blocks = listOf(raw);
    const b = blocks.find(b => String((b.Project as Record<string,unknown>)?.ProjectID ?? "") === jobId);
    return NextResponse.json({
      date, jobId,
      topLevelKeys: b ? Object.keys(b) : null,
      fullBlock: b ?? "not found",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: show full block.Project with/without expand to find all available fields
  if (url.searchParams.get("debug") === "blockproject") {
    const date  = url.searchParams.get("date")  ?? "2026-05-29";
    const jobId = url.searchParams.get("jobid") ?? "441099";

    const fetchAndFind = async (extraParam: string) => {
      const u = `${BASE_URL}/api/v1.0/companies/1/schedules/?pageSize=250&Date=${date}${extraParam}`;
      const r = await fetch(u, { headers: hdrs, cache: "no-store" });
      if (!r.ok) return { status: r.status, project: null };
      const d = await r.json();
      const blocks = (Array.isArray(d) ? d : (d?.Result ?? [])) as Record<string,unknown>[];
      const b = blocks.find(b => String((b.Project as Record<string,unknown>)?.ProjectID ?? "") === jobId);
      return { status: r.status, project: b?.Project ?? null };
    };

    const noExpand           = await fetchAndFind("");
    await sleep(700);
    const expandCC           = await fetchAndFind("&expand=CostCenter");
    await sleep(700);
    const expandProjCC       = await fetchAndFind("&expand=Project.CostCenter");
    await sleep(700);
    // Also try section cost-centre sub-resource
    const sectListRaw = await fetch(`${BASE_URL}/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=5`, { headers: hdrs, cache: "no-store" });
    const sectList    = sectListRaw.ok ? await sectListRaw.json() : null;
    const firstSectId = (Array.isArray(sectList) ? sectList[0] : sectList?.Result?.[0])?.ID;
    let sectCcList: unknown = null;
    if (firstSectId) {
      await sleep(700);
      const sc = await fetch(`${BASE_URL}/api/v1.0/companies/1/jobs/${jobId}/sections/${firstSectId}/costcentres/`, { headers: hdrs, cache: "no-store" });
      sectCcList = sc.ok ? await sc.json() : `HTTP ${sc.status}`;
    }

    return NextResponse.json({ date, jobId, noExpand, expandCC, expandProjCC, firstSectId, sectCcList }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: single-request section+expand test — waits 30s for rate limit to refill
  // IMPORTANT: wait 10+ min after any other debug call before hitting this
  if (url.searchParams.get("debug") === "sectone") {
    await sleep(30000);
    const r = await fetch(
      `${BASE_URL}/api/v1.0/companies/1/jobs/441099/sections/357827?expand=CostCenter`,
      { headers: hdrs, cache: "no-store" }
    );
    const body = r.ok ? await r.json() : `HTTP ${r.status}`;
    return NextResponse.json({ status: r.status, body }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: rate-limit-safe probes — waits 30s before first request
  if (url.searchParams.get("debug") === "sectexpand") {
    const jobId  = url.searchParams.get("jobid")  ?? "441099";
    const sectId = url.searchParams.get("sectid") ?? "357827";
    // Long initial pause — lets the SimPRO rate-limit window fully reset
    await sleep(30000);
    const results: { path: string; status: number; body: unknown }[] = [];
    for (const p of [
      `/api/v1.0/companies/1/resources/costcentres/?pageSize=10`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}?expand=CostCenter`,
    ]) {
      try {
        const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        results.push({ path: p, status: r.status, body });
      } catch (e) { results.push({ path: p, status: -1, body: String(e) }); }
      await sleep(3000);
    }
    return NextResponse.json({ jobId, sectId, results }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: fetch individual section to find CostCenter structure (sequential — avoids 429)
  if (url.searchParams.get("debug") === "secdetail") {
    const jobId  = url.searchParams.get("jobid")  ?? "441099";
    const sectId = url.searchParams.get("sectid") ?? "357827";
    const ccId   = url.searchParams.get("ccid")   ?? "361944";
    const paths = [
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectId}`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/?expand=CostCenter&pageSize=5`,
      `/api/v1.0/companies/1/jobs/${jobId}/sections/${ccId}`,
    ];
    const results: { path: string; status: number; preview: string }[] = [];
    for (const p of paths) {
      await sleep(600);
      try {
        const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        results.push({ path: p, status: r.status, preview: JSON.stringify(body).substring(0, 600) });
      } catch (e) { results.push({ path: p, status: -1, preview: String(e) }); }
    }
    return NextResponse.json({ jobId, sectId, ccId, results }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: brute-force find the correct API path for cost centre name lookup
  if (url.searchParams.get("debug") === "cclookup") {
    const testCcId  = 361944;  // Known AFSS CC for job 441099 (Contracts Annual)
    const testJobId = "441099";
    const paths = [
      `/api/v1.0/companies/1/costcentres/${testCcId}`,
      `/api/v1.0/companies/1/costcentres/?ID=${testCcId}&pageSize=5`,
      `/api/v1.0/companies/1/costCentres/${testCcId}`,
      `/api/v1.0/companies/1/costCentres/?ID=${testCcId}`,
      `/api/v1.0/companies/1/jobs/${testJobId}?columns=ID,CostCenter`,
      `/api/v1.0/companies/1/jobs/${testJobId}?expand=CostCenter`,
      `/api/v1.0/companies/1/jobs/${testJobId}/sections/?pageSize=5`,
      `/api/v1.0/companies/1/jobs/${testJobId}/sections`,
      `/api/v1.0/companies/1/jobs/${testJobId}/sections/?columns=ID,Name,CostCenter&pageSize=5`,
      `/api/v1.0/companies/1/jobs/${testJobId}?columns=ID,Sections`,
      `/api/v1.0/companies/1/jobs/${testJobId}?columns=ID,CostCentre`,
      `/api/v1.0/companies/1/jobs/${testJobId}/costcentres/`,
    ];
    const results = await Promise.all(paths.map(async p => {
      try {
        const r = await fetch(`${BASE_URL}${p}`, { headers: hdrs, cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        return { path: p, status: r.status, preview: JSON.stringify(body).substring(0, 400) };
      } catch (e) { return { path: p, status: -1, preview: String(e) }; }
    }));
    return NextResponse.json({ testCcId, testJobId, results }, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug mode: show ALL jobs being counted across all remaining days
  if (url.searchParams.get("debug") === "1") {
    const tentativeIds = await getTentativeStaffIds();
    const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
    const days   = getRemainingWeekdays(aest.getUTCFullYear(), aest.getUTCMonth() + 1);

    // Collect all team job blocks across ALL remaining days
    const allBlocks: { staffId: number; date: string; jobId: string; hours: number }[] = [];
    for (const day of days) {
      const res = await fetchDayBlocks(day);
      for (const block of res) {
        const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
        if (!allIds.has(staffId)) continue;
        if (block.Type !== "job") continue;
        const hours = Number(block.TotalHours ?? 0);
        const projectId = (block.Project as Record<string, unknown>)?.ProjectID;
        if (projectId == null) continue;
        allBlocks.push({ staffId, date: day, jobId: String(projectId), hours });
      }
    }

    // Fetch job details for all unique jobs
    const uniqueJobIds = [...new Set(allBlocks.map(b => b.jobId))];
    const jobDetails: Record<string, unknown>[] = [];
    for (const id of uniqueJobIds) {
      const raw = await simGet(`/api/v1.0/companies/1/jobs/${id}`).catch(() => null);
      const job = unwrapJob(raw);
      const excluded = isExcludedJob(job);
      const stage = String(job.Stage ?? "unknown");
      jobDetails.push({ jobId: id, stage, excluded, name: job.Name, status: job.Status });
    }

    return NextResponse.json({
      days, tentativeIds: [...tentativeIds], allIds: [...allIds],
      allBlocks, jobDetails,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const nodc = url.searchParams.get("excludeDatacom") === "1";

  const cached = await readCache(year, month, nodc);
  if (cached) {
    const fresh = Date.now() - cached.ts < CACHE_TTL;

    // force=1 (Refresh Now button): always rebuild synchronously so the user
    // gets confirmed-current data. forceNew kills any stale in-flight first.
    if (force) {
      try {
        const data = await buildResponseDeduped(year, month, nodc, true);
        await writeCache(year, month, data, nodc);
        await writeFallback(year, month, data, nodc);
        return NextResponse.json(toResponse(data, range), { headers: { "Cache-Control": "no-store" } });
      } catch {
        return NextResponse.json(toResponse(cached.data, range), { headers: { "Cache-Control": "no-store" } });
      }
    }

    // Normal load: always serve cached data instantly (fresh or stale) so the
    // UI never shows "—". If stale, kick off a background rebuild — join any
    // existing in-flight rather than killing it (forceNew=false).
    if (!fresh) {
      buildResponseDeduped(year, month, nodc, false)
        .then(async data => { await writeCache(year, month, data, nodc); await writeFallback(year, month, data, nodc); })
        .catch(() => {});
    }
    return NextResponse.json(toResponse(cached.data, range), { headers: { "Cache-Control": "no-store" } });
  }

  // No primary cache at all — block until fresh data is built.
  try {
    const data = await buildResponseDeduped(year, month, nodc, true);
    await writeCache(year, month, data, nodc);
    await writeFallback(year, month, data, nodc);
    return NextResponse.json(toResponse(data, range), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
