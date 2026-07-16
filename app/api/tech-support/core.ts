import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsWrite, gcsRead } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// Matches the SimPRO "Schedule Breakdown" technician selection the card is
// reconciled against: Muhammad Soban (1581), Ryan Gordon (15) and Josh Roger
// (1753); Muhammad's and Ryan's TENTATIVE placeholders are added dynamically.
const TEAM_IDS = new Set<number>([1581, 15, 1753]);
export const RATE = 100;

export const OB_IT_CACHE_TTL = 5  * 60_000;
export const QA_CACHE_TTL    = 60 * 60_000;

// Cost centres the SimPRO Schedule Breakdown report deliberately leaves out —
// everything else in SimPRO's setup cost-centre list counts.
const EXCLUDED_CC_NAMES = new Set(["system testing", "afss works"]);

// Fallback baseline only — the live list is fetched from SimPRO setup (see
// refreshCcNames) so cost centres created after this snapshot still count.
const FALLBACK_CC_NAMES = new Set([
  "afss works",
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

// Live setup cost-centre names (lowercased, trimmed, exclusions removed).
// Starts from the hard-coded fallback and is replaced by SimPRO's setup list
// on the first build, then refreshed every 30 minutes.
let _ccNames: Set<string> = new Set(FALLBACK_CC_NAMES);
let _ccNamesFetchTs = 0;
const CC_NAMES_TTL  = 30 * 60_000;
const CC_NAMES_FILE = "afss-setup-cc-names-v1.json";

async function fetchSetupCcNames(): Promise<Set<string>> {
  const names = new Set<string>();
  let page = 1;
  while (true) {
    const items = listOf(await simGet(
      `/api/v1.0/companies/1/setup/accounts/costCenters/?pageSize=250&columns=ID,Name&page=${page}`
    ));
    for (const cc of items) {
      const n = String(cc.Name ?? "").trim().toLowerCase();
      if (n.length > 0 && !EXCLUDED_CC_NAMES.has(n)) names.add(n);
    }
    if (items.length < 250) break;
    page++;
  }
  return names;
}

export async function refreshCcNames(): Promise<void> {
  if (Date.now() - _ccNamesFetchTs < CC_NAMES_TTL) return;
  try {
    const live = await fetchSetupCcNames();
    // A suspiciously tiny result means SimPRO errored mid-fetch — keep what we have.
    if (live.size >= 10) {
      _ccNames = live;
      _ccNamesFetchTs = Date.now();
      const json = JSON.stringify([...live]);
      fs.writeFile(join(CACHE_DIR, CC_NAMES_FILE), json, "utf-8").catch(() => {});
      gcsWrite(CC_NAMES_FILE, json);
      return;
    }
  } catch { /* fall through to persisted copy */ }
  if (_ccNamesFetchTs > 0) return; // already have a live list from earlier
  try {
    let raw: string | null = null;
    try { raw = await fs.readFile(join(CACHE_DIR, CC_NAMES_FILE), "utf-8"); } catch {}
    if (!raw) raw = await gcsRead(CC_NAMES_FILE);
    const arr = raw ? JSON.parse(raw) as string[] : null;
    if (Array.isArray(arr) && arr.length >= 10) {
      _ccNames = new Set(arr.filter(n => !EXCLUDED_CC_NAMES.has(n)));
    }
  } catch { /* keep fallback baseline */ }
}

export const KNOWN_AFSS_CC_IDS = new Set<number>([
  361944, 364605, 364606, 364607, 366362, 366676,
  366702, 362953, 363815, 364810, 366596, 366467,
  367774, 366871, 367112, 367904,
  366878, 367111, 367813, 367825, 367828,
  342907,
]);

const KNOWN_DATACOM_CC_IDS = new Set<number>([366467]);
const INTERNAL_CLIENTS = ["REDMEN FIRE", "AFAC", "ADAIR OPERATION", "Z SAFE"];

export type TechSupportStats = { jobs: number; hours: number; amount: number };
export type QARawJob = { id: unknown; dueDate: string; estHours: number; customer?: string };
export type TechSupportResponse = {
  otherBillable:    TechSupportStats;
  investedTime:     TechSupportStats;
  qualityAssurance: TechSupportStats;
  stale?:           boolean;
};

const CACHE_DIR = process.env.CACHE_DIR ?? os.tmpdir();

const CC_IDS_TTL = 30 * 60_000;
export let _dynamicAfssIds: Set<number> = new Set(KNOWN_AFSS_CC_IDS);
let _dynamicAfssIdsFetchTs = 0;
let _dynamicAfssIdsFetching = false;

export function scheduleCcIdRefresh(): void {
  if (_dynamicAfssIdsFetching) return;
  if (Date.now() - _dynamicAfssIdsFetchTs < CC_IDS_TTL) return;
  _dynamicAfssIdsFetching = true;
  _dynamicAfssIdsFetchTs = Date.now();
  (async () => {
    _dynamicAfssIds = new Set(KNOWN_AFSS_CC_IDS);
  })().catch(() => {}).finally(() => { _dynamicAfssIdsFetching = false; });
}

export function obItCacheFile(year: number, month: number, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  return join(CACHE_DIR, `afss-tech-support-v113${tag}-${year}-${String(month).padStart(2, "0")}.json`);
}
export async function readObItCache(year: number, month: number, nodc = false): Promise<{ data: { otherBillable: TechSupportStats; investedTime: TechSupportStats }; ts: number } | null> {
  try { return JSON.parse(await fs.readFile(obItCacheFile(year, month, nodc), "utf-8")); } catch { return null; }
}
export async function writeObItCache(year: number, month: number, data: { otherBillable: TechSupportStats; investedTime: TechSupportStats }, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(obItCacheFile(year, month, nodc), json, "utf-8").catch(() => {});
  gcsWrite(`afss-tech-support-v113${tag}-${year}-${String(month).padStart(2, "0")}.json`, json);
}

export function obItRawCacheFile(year: number, month: number, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  return join(CACHE_DIR, `afss-tech-support-raw-v1${tag}-${year}-${String(month).padStart(2, "0")}.json`);
}
export async function readObItRawCache(year: number, month: number, nodc = false): Promise<{ data: { otherBillable: TechSupportRawRow[]; investedTime: TechSupportRawRow[] }; ts: number } | null> {
  try { return JSON.parse(await fs.readFile(obItRawCacheFile(year, month, nodc), "utf-8")); } catch { return null; }
}
export async function writeObItRawCache(year: number, month: number, data: { otherBillable: TechSupportRawRow[]; investedTime: TechSupportRawRow[] }, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(obItRawCacheFile(year, month, nodc), json, "utf-8").catch(() => {});
  gcsWrite(`afss-tech-support-raw-v1${tag}-${year}-${String(month).padStart(2, "0")}.json`, json);
}

export function qaCacheFile() { return join(CACHE_DIR, "afss-qa-v1.json"); }
export async function readQaCache(): Promise<{ data: QARawJob[]; ts: number } | null> {
  try { return JSON.parse(await fs.readFile(qaCacheFile(), "utf-8")); } catch { return null; }
}
export async function writeQaCache(data: QARawJob[]) {
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(qaCacheFile(), json, "utf-8").catch(() => {});
  gcsWrite("afss-qa-v1.json", json);
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function listOf(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    if (Array.isArray(o.Result)) return o.Result as Record<string, unknown>[];
  }
  return [];
}

export async function simGet(path: string): Promise<unknown> {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
      if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
      if (r.status >= 500) { await sleep(500 * (a + 1)); continue; }
      if (!r.ok) return [];
      return r.json();
    } catch {
      if (a < 5) await sleep(500 * (a + 1));
    }
  }
  return [];
}

export async function fetchDayBlocks(date: string): Promise<Record<string, unknown>[]> {
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

export function getFullMonthWeekdays(year: number, month: number): string[] {
  const days: string[] = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() !== 0 && dt.getDay() !== 6)
      days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

// For the current month, returns all remaining days from today (including weekends).
// For past or future months, returns all days in that month.
// Includes weekends because SimPro schedules can fall on any day of the week.
export function getMonthWeekdays(year: number, month: number): string[] {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const todayYear  = aest.getUTCFullYear();
  const todayMonth = aest.getUTCMonth() + 1;
  const todayDay   = aest.getUTCDate();
  const isCurrentMonth = year === todayYear && month === todayMonth;
  const startDay = isCurrentMonth ? todayDay : 1;
  const lastDay = new Date(year, month, 0).getDate();
  const days: string[] = [];
  for (let d = startDay; d <= lastDay; d++) {
    days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

export function getRemainingWeekdays(year: number, month: number): string[] {
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
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = 1; d <= lastDay; d++) pushWeekday(year, month, d);
    return days;
  }
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

export async function getTentativeStaffIds(): Promise<Set<number>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ids = new Set<number>();
      let page = 1;
      while (true) {
        const staff = listOf(await simGet(`/api/v1.0/companies/1/staff/?pageSize=250&columns=ID,Name&page=${page}`));
        for (const s of staff) {
          const name = String(s.Name ?? "").toLowerCase();
          if (name.includes("tentative") && (name.includes("muhammad") || name.includes("ryan g")))
            ids.add(s.ID as number);
        }
        if (staff.length < 250) break;
        page++;
      }
      return ids;
    } catch {
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  return new Set();
}

export type BlockInfo = { staffId: number; date: string; hours: number; jobId: string; ccId: number; ccName: string; sectionId: number };

export function resolvedCcName(b: BlockInfo, ccCache?: Map<number, string>): string {
  if (b.ccName.length > 0) return b.ccName.trim().toLowerCase();
  // trim: SimPRO returns some CC names with trailing spaces (e.g. "WATER Flow
  // Testing ") which would silently fail the cost-centre name lookup
  if (ccCache && b.ccId > 0 && ccCache.has(b.ccId)) return ccCache.get(b.ccId)!.trim().toLowerCase();
  return "";
}

export function isDatacomBlock(b: BlockInfo, ccCache?: Map<number, string>): boolean {
  if (KNOWN_DATACOM_CC_IDS.has(b.ccId)) return true;
  return resolvedCcName(b, ccCache).startsWith("datacom");
}

export function isAfssBlock(b: BlockInfo, ccCache?: Map<number, string>, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): boolean {
  if (b.ccName.length > 0) {
    const n = b.ccName.trim().toLowerCase();
    return _ccNames.has(n) && !EXCLUDED_CC_NAMES.has(n);
  }
  if (ccCache && b.ccId > 0 && ccCache.has(b.ccId)) {
    const n = ccCache.get(b.ccId)!.trim().toLowerCase();
    if (EXCLUDED_CC_NAMES.has(n)) return false;
    if (_ccNames.has(n)) return true;
    return afssIds.has(b.ccId);
  }
  return afssIds.has(b.ccId);
}

export async function fetchAllScheduleBlocks(year: number, month: number, tentativeIds: Set<number>): Promise<BlockInfo[]> {
  const allIds = new Set([...TEAM_IDS, ...tentativeIds]);
  const days = getMonthWeekdays(year, month);
  const blockList: BlockInfo[] = [];
  const BATCH = 3;
  for (let i = 0; i < days.length; i += BATCH) {
    const batch = days.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(day => fetchDayBlocks(day)));
    for (let j = 0; j < batch.length; j++) {
      const day = batch[j];
      for (const block of results[j]) {
        const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
        if (!allIds.has(staffId)) continue;
        if (block.Type !== "job") continue;
        const hours = Number(block.TotalHours ?? 0);
        if (hours <= 0) continue;
        const proj  = block.Project as Record<string, unknown>;
        if (proj?.ProjectID == null) continue;
        const ccId      = Number(proj?.CostCenterID ?? 0);
        const sectionId = Number(proj?.SectionID    ?? 0);
        const ccTop     = block?.CostCenter as Record<string, unknown> | undefined;
        const ccProj    = proj?.CostCenter  as Record<string, unknown> | undefined;
        const ccName    = String(ccTop?.Name ?? ccProj?.Name ?? "").trim();
        blockList.push({ staffId, date: day, hours, jobId: String(proj.ProjectID), ccId, ccName, sectionId });
      }
    }
  }
  return blockList;
}

export async function fetchJobDetailsMap(jobIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (jobIds.length === 0) return map;
  const BATCH = 5;
  for (let i = 0; i < jobIds.length; i += BATCH) {
    const batch = jobIds.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(id => simGet(`/api/v1.0/companies/1/jobs/${id}?columns=ID,Stage,Customer,Totals`).catch(() => null))
    );
    for (let j = 0; j < batch.length; j++) {
      const raw = results[j];
      if (!raw) continue;
      const d = raw as Record<string, unknown>;
      const job = (d.Result && typeof d.Result === "object" && !Array.isArray(d.Result))
        ? d.Result as Record<string, unknown> : d;
      map.set(batch[j], job);
    }
    if (i + BATCH < jobIds.length) await sleep(250);
  }
  return map;
}

const CC_CACHE_FILE = join((process.env.CACHE_DIR ?? os.tmpdir()), "afss-cc-name-cache-v5.json");

export async function loadCcCache(): Promise<Map<number, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(CC_CACHE_FILE, "utf-8")) as Record<string, string>;
    return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
  } catch {
    // Local disk missing (e.g. Cloud Run restart) — fall back to GCS
    try {
      const gcs = await gcsRead("afss-cc-name-cache-v5.json");
      if (gcs) {
        const raw = JSON.parse(gcs) as Record<string, string>;
        return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
      }
    } catch {}
    return new Map();
  }
}
export async function saveCcCache(cache: Map<number, string>): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [k, v] of cache) obj[String(k)] = v;
  const json = JSON.stringify(obj);
  try { await fs.writeFile(CC_CACHE_FILE, json, "utf-8"); } catch {}
  gcsWrite("afss-cc-name-cache-v5.json", json);
}

export async function resolveUnknownCcNames(blocks: BlockInfo[], ccCache: Map<number, string>): Promise<void> {
  const toResolve = new Map<number, { jobId: string; sectionId: number }>();
  for (const b of blocks) {
    if (KNOWN_AFSS_CC_IDS.has(b.ccId)) continue;
    if (b.ccId > 0 && !ccCache.has(b.ccId))
      toResolve.set(b.ccId, { jobId: b.jobId, sectionId: b.sectionId });
  }
  if (toResolve.size === 0) return;
  for (const [ccId, { jobId, sectionId }] of toResolve) {
    await sleep(300);
    try {
      const path = sectionId > 0
        ? `/api/v1.0/companies/1/jobs/${jobId}/sections/${sectionId}/costCenters/`
        : `/api/v1.0/companies/1/jobs/${jobId}/sections/?pageSize=250&expand=CostCenter`;
      const raw = await simGet(path);
      if (!raw) continue;
      let name = "";
      if (sectionId > 0) {
        for (const cc of listOf(raw)) {
          const n = String((cc.CostCenter as Record<string,unknown>)?.Name ?? cc.Name ?? "").trim();
          if (n.length > 0) { name = n; break; }
        }
      } else {
        for (const sect of listOf(raw)) {
          const cc = sect.CostCenter as Record<string, unknown> | undefined;
          if (!cc) continue;
          const id = Number(cc.ID   ?? 0);
          const n  = String(cc.Name ?? "").trim();
          if (id === ccId && n.length > 0) { name = n; break; }
          if (id > 0 && n.length > 0 && !ccCache.has(id)) ccCache.set(id, n);
        }
      }
      if (name.length > 0) ccCache.set(ccId, name);
    } catch { /* skip */ }
  }
}

function isInternalClient(job: Record<string, unknown>): boolean {
  const name = String((job.Customer as Record<string, unknown>)?.CompanyName ?? "").toUpperCase();
  return INTERNAL_CLIENTS.some(ex => name.includes(ex));
}

export function jobEstHours(job: Record<string, unknown>): number {
  const totals = job.Totals as Record<string, unknown> | undefined;
  const res    = totals?.ResourcesCost as Record<string, unknown> | undefined;
  const lab    = res?.LaborHours as Record<string, unknown> | undefined;
  const est    = lab?.Estimate != null ? Number(lab.Estimate) : 0;
  return Number.isFinite(est) && est > 0 ? est : 0;
}

export type TechSupportRawRow = { jobId: string; customer: string; ccName: string; date: string; hours: number };

function statFromRows(rows: TechSupportRawRow[]): TechSupportStats {
  return rows.reduce<TechSupportStats>((acc, r) => ({
    jobs:   acc.jobs + 1,
    hours:  Math.round((acc.hours  + r.hours)        * 100) / 100,
    amount: Math.round((acc.amount + r.hours * RATE) * 100) / 100,
  }), { jobs: 0, hours: 0, amount: 0 });
}

function rawRow(b: BlockInfo, jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>): TechSupportRawRow {
  const job = jobMap.get(b.jobId);
  return {
    jobId:    b.jobId,
    customer: String((job?.Customer as Record<string, unknown> | undefined)?.CompanyName ?? ""),
    ccName:   resolvedCcName(b, ccCache) || b.ccName,
    date:     b.date,
    hours:    b.hours,
  };
}

// Rows are scheduled block hours (SimPRO's report basis); one row per
// schedule block (not deduped per unique job) so the row/"jobs" count
// matches SimPRO's Schedule Breakdown "Results" count exactly — a job
// scheduled across N days counts N times, same as SimPRO's row total.
export function rawOtherBillable(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportRawRow[] {
  const rows: TechSupportRawRow[] = [];
  for (const b of blockList) {
    if (!isAfssBlock(b, ccCache, afssIds)) continue;
    if (excludeDatacom && isDatacomBlock(b, ccCache)) continue;
    const job = jobMap.get(b.jobId);
    // If job details failed to load, include as OB (external, pending assumption)
    if (job) {
      const stage = String(job.Stage ?? "").toLowerCase();
      if (stage !== "pending" && stage !== "progress") continue;
      if (isInternalClient(job)) continue;
    }
    rows.push(rawRow(b, jobMap, ccCache));
  }
  return rows;
}

export function rawInvestedTime(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportRawRow[] {
  const rows: TechSupportRawRow[] = [];
  for (const b of blockList) {
    if (!isAfssBlock(b, ccCache, afssIds)) continue;
    if (excludeDatacom && isDatacomBlock(b, ccCache)) continue;
    const job = jobMap.get(b.jobId);
    if (!job) continue; // if unknown, OB already claimed it above
    const stage = String(job.Stage ?? "").toLowerCase();
    if (stage !== "pending" && stage !== "progress") continue;
    if (!isInternalClient(job)) continue;
    rows.push(rawRow(b, jobMap, ccCache));
  }
  return rows;
}

export function calcOtherBillable(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportStats {
  return statFromRows(rawOtherBillable(blockList, jobMap, ccCache, excludeDatacom, afssIds));
}

export function calcInvestedTime(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportStats {
  return statFromRows(rawInvestedTime(blockList, jobMap, ccCache, excludeDatacom, afssIds));
}

export function aggregateQA(rawJobs: QARawJob[], dateTo: string): TechSupportStats {
  return rawJobs
    .filter(j => j.dueDate && j.dueDate <= dateTo)
    .reduce<TechSupportStats>(
      (acc, j) => ({
        jobs:   acc.jobs + 1,
        hours:  Math.round((acc.hours  + j.estHours)        * 100) / 100,
        amount: Math.round((acc.amount + j.estHours * RATE) * 100) / 100,
      }),
      { jobs: 0, hours: 0, amount: 0 }
    );
}

export function getQADateTo(year: number, month: number, all: boolean): string {
  const aest        = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const targetYear  = all ? aest.getUTCFullYear()  : year;
  const targetMonth = all ? aest.getUTCMonth() + 1 : month;
  const lastDay     = new Date(targetYear, targetMonth, 0).getDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

let _cachedQaId: number | null | undefined = undefined;
export async function resolvedQaId(): Promise<number | null> {
  if (_cachedQaId !== undefined) return _cachedQaId;
  try {
    const staff = listOf(await simGet(`/api/v1.0/companies/1/staff/?pageSize=250&columns=ID,Name`));
    for (const s of staff) {
      if (String(s.Name ?? "").toLowerCase().includes("quality assurance")) {
        _cachedQaId = s.ID as number;
        return _cachedQaId;
      }
    }
  } catch {}
  _cachedQaId = null;
  return null;
}

export async function fetchQualityAssurance(): Promise<QARawJob[]> {
  const rawJobs: QARawJob[] = [];
  const qaId = await resolvedQaId();
  if (!qaId) return rawJobs;
  const cols = "ID,Totals,Technicians,DueDate,Customer";
  const seen = new Set<unknown>();
  let items: Record<string, unknown>[] = [];
  try {
    const first = listOf(await simGet(`/api/v1.0/companies/1/jobs/?pageSize=250&columns=${cols}&Stage=Pending&page=1`));
    items = first;
    if (first.length === 250) {
      const extras = await Promise.all(
        Array.from({ length: 9 }, (_, i) => i + 2).map(p =>
          simGet(`/api/v1.0/companies/1/jobs/?pageSize=250&columns=${cols}&Stage=Pending&page=${p}`)
            .then(listOf).catch((): Record<string, unknown>[] => [])
        )
      );
      for (const page of extras) { items = items.concat(page); if (page.length < 250) break; }
    }
  } catch { return rawJobs; }
  for (const job of items) {
    if (seen.has(job.ID)) continue;
    const techs = job.Technicians as Record<string, unknown>[] | undefined;
    if (!techs?.some(t => (t as Record<string, unknown>).ID === qaId)) continue;
    seen.add(job.ID);
    const totals = job.Totals as Record<string, unknown> | undefined;
    const res    = totals?.ResourcesCost as Record<string, unknown> | undefined;
    const labHrs = res?.LaborHours as Record<string, unknown> | undefined;
    const est    = labHrs?.Estimate != null ? Number(labHrs.Estimate) : 0;
    const customer = String((job.Customer as Record<string, unknown> | undefined)?.CompanyName ?? "");
    rawJobs.push({ id: job.ID, dueDate: String(job.DueDate ?? ""), estHours: est > 0 ? est : 2, customer });
  }
  return rawJobs;
}

export const _obItInFlight = new Map<string, Promise<{ regular: { otherBillable: TechSupportStats; investedTime: TechSupportStats }; nodc: { otherBillable: TechSupportStats; investedTime: TechSupportStats } }>>();
export function buildObItDeduped(year: number, month: number, forceNew = false) {
  const key = `${year}-${month}`;
  if (forceNew) _obItInFlight.delete(key);
  let p = _obItInFlight.get(key);
  if (!p) {
    p = buildObIt(year, month).finally(() => _obItInFlight.delete(key));
    _obItInFlight.set(key, p);
  }
  return p;
}

function addStats(a: TechSupportStats, b: TechSupportStats): TechSupportStats {
  return {
    jobs:   a.jobs + b.jobs,
    hours:  Math.round((a.hours + b.hours) * 100) / 100,
    amount: Math.round((a.amount + b.amount) * 100) / 100,
  };
}

async function buildBlocksAndJobMap(year: number, month: number): Promise<{ blockList: BlockInfo[]; jobMap: Map<string, Record<string, unknown>>; ccCache: Map<number, string>; afssIds: Set<number> }> {
  const tentativeIds = await getTentativeStaffIds();
  scheduleCcIdRefresh();
  await refreshCcNames();
  const afssIds = _dynamicAfssIds;
  const blockList = await fetchAllScheduleBlocks(year, month, tentativeIds);
  const jobIds    = [...new Set(blockList.map(b => b.jobId))];
  const ccCache = await loadCcCache();
  for (const b of blockList) {
    if (b.ccName.length > 0 && b.ccId > 0 && !ccCache.has(b.ccId)) ccCache.set(b.ccId, b.ccName);
  }
  await resolveUnknownCcNames(blockList, ccCache);
  await saveCcCache(ccCache);
  const jobMap = await fetchJobDetailsMap(jobIds);
  return { blockList, jobMap, ccCache, afssIds };
}

// buildObIt() (stats) and buildObItRaw() (raw rows) both need the same
// blocks+jobMap for a given month — share one live pull between them (and
// across repeated calls within OB_IT_CACHE_TTL) instead of each doing its
// own full SimPRO scan back-to-back, which is what made switching between
// the OB/IT raw views and the dashboard cards slow.
type BlocksAndJobMap = { blockList: BlockInfo[]; jobMap: Map<string, Record<string, unknown>>; ccCache: Map<number, string>; afssIds: Set<number> };
const _blocksJobMapInFlight = new Map<string, Promise<BlocksAndJobMap>>();
const _blocksJobMapCache    = new Map<string, { data: BlocksAndJobMap; ts: number }>();
async function buildBlocksAndJobMapCached(year: number, month: number, force = false): Promise<BlocksAndJobMap> {
  const key = `${year}-${month}`;
  if (!force) {
    const hit = _blocksJobMapCache.get(key);
    if (hit && Date.now() - hit.ts < OB_IT_CACHE_TTL) return hit.data;
  }
  let p = _blocksJobMapInFlight.get(key);
  if (!p || force) {
    p = buildBlocksAndJobMap(year, month).finally(() => _blocksJobMapInFlight.delete(key));
    _blocksJobMapInFlight.set(key, p);
  }
  const data = await p;
  _blocksJobMapCache.set(key, { data, ts: Date.now() });
  return data;
}

// Raw contributing rows behind the OB/IT cards — a diagnostic view, so it
// needs to sum to the same totals the cards show. That means the same
// "today → end of target month" cumulative range as buildObIt(): for a
// future month, merge in the rows from the month immediately before it too.
// getObItRaw() below is cache-first, so that predecessor call recurses through
// this same branch if it's future as well, chaining all the way back to today
// no matter how many months out the target is — not just the very next one.
async function buildObItRaw(year: number, month: number, excludeDatacom = false, force = false): Promise<{ otherBillable: TechSupportRawRow[]; investedTime: TechSupportRawRow[] }> {
  const { blockList, jobMap, ccCache, afssIds } = await buildBlocksAndJobMapCached(year, month, force);
  const otherBillable = rawOtherBillable(blockList, jobMap, ccCache, excludeDatacom, afssIds);
  const investedTime  = rawInvestedTime(blockList, jobMap, ccCache, excludeDatacom, afssIds);

  const aest       = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const todayYear  = aest.getUTCFullYear();
  const todayMonth = aest.getUTCMonth() + 1;
  const isFuture   = year > todayYear || (year === todayYear && month > todayMonth);
  if (isFuture) {
    let prevYear  = year;
    let prevMonth = month - 1;
    if (prevMonth < 1) { prevMonth = 12; prevYear--; }
    try {
      const prev = await getObItRaw(prevYear, prevMonth, excludeDatacom, force);
      return {
        otherBillable: [...prev.otherBillable, ...otherBillable],
        investedTime:  [...prev.investedTime,  ...investedTime],
      };
    } catch { /* proceed with target-month-only rows */ }
  }

  return { otherBillable, investedTime };
}

const _obItRawInFlight = new Map<string, Promise<{ otherBillable: TechSupportRawRow[]; investedTime: TechSupportRawRow[] }>>();
function buildObItRawDeduped(year: number, month: number, excludeDatacom: boolean, forceNew = false) {
  const key = `${year}-${month}-${excludeDatacom ? "nodc" : "dc"}`;
  if (forceNew) _obItRawInFlight.delete(key);
  let p = _obItRawInFlight.get(key);
  if (!p) {
    p = buildObItRaw(year, month, excludeDatacom, forceNew).finally(() => _obItRawInFlight.delete(key));
    _obItRawInFlight.set(key, p);
  }
  return p;
}

// Cache-first, same pattern as the OB/IT stats cache — serves instantly from
// the last live pull (same OB_IT_CACHE_TTL freshness window) instead of
// re-running the full SimPRO pull on every view switch; "Refresh now" sets
// force to bypass it.
export async function getObItRaw(year: number, month: number, excludeDatacom = false, force = false): Promise<{ otherBillable: TechSupportRawRow[]; investedTime: TechSupportRawRow[] }> {
  const cached = await readObItRawCache(year, month, excludeDatacom);
  const fresh  = cached && Date.now() - cached.ts < OB_IT_CACHE_TTL;
  if (fresh && !force) return cached.data;
  try {
    const data = await buildObItRawDeduped(year, month, excludeDatacom, force);
    await writeObItRawCache(year, month, data, excludeDatacom);
    return data;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

async function buildObIt(year: number, month: number): Promise<{ regular: { otherBillable: TechSupportStats; investedTime: TechSupportStats }; nodc: { otherBillable: TechSupportStats; investedTime: TechSupportStats } }> {
  const { blockList, jobMap, ccCache, afssIds } = await buildBlocksAndJobMapCached(year, month);
  const regular = {
    otherBillable: calcOtherBillable(blockList, jobMap, ccCache, false, afssIds),
    investedTime:  calcInvestedTime(blockList, jobMap, ccCache, false, afssIds),
  };
  const nodc = {
    otherBillable: calcOtherBillable(blockList, jobMap, ccCache, true, afssIds),
    investedTime:  calcInvestedTime(blockList, jobMap, ccCache, true, afssIds),
  };

  // For a future month, the totals are cumulative — "today → end of target
  // month" — so merge in the month immediately before the target rather than
  // always the real current month. That predecessor's own build recurses
  // through this same branch if it's future too, so picking a month several
  // months out (e.g. September while July is the real month) chains all the
  // way back to today instead of only pulling in July and silently dropping
  // August's data.
  const aest       = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const todayYear  = aest.getUTCFullYear();
  const todayMonth = aest.getUTCMonth() + 1;
  const isFuture   = year > todayYear || (year === todayYear && month > todayMonth);
  if (isFuture) {
    let prevYear  = year;
    let prevMonth = month - 1;
    if (prevMonth < 1) { prevMonth = 12; prevYear--; }
    let curReg  = await readObItCache(prevYear, prevMonth, false);
    let curNodc = await readObItCache(prevYear, prevMonth, true);
    // A stale predecessor-month cache would bake already-past days into the
    // future-month total — treat it the same as a missing one.
    if (curReg  && Date.now() - curReg.ts  > OB_IT_CACHE_TTL) curReg  = null;
    if (curNodc && Date.now() - curNodc.ts > OB_IT_CACHE_TTL) curNodc = null;
    if (!curReg || !curNodc) {
      try {
        const curBuilt = await buildObItDeduped(prevYear, prevMonth);
        await writeObItCache(prevYear, prevMonth, curBuilt.regular, false);
        await writeObItCache(prevYear, prevMonth, curBuilt.nodc,    true);
        curReg  = { data: curBuilt.regular, ts: Date.now() };
        curNodc = { data: curBuilt.nodc,    ts: Date.now() };
      } catch { /* proceed with target-month-only data */ }
    }
    if (curReg) {
      regular.otherBillable = addStats(curReg.data.otherBillable, regular.otherBillable);
      regular.investedTime  = addStats(curReg.data.investedTime,  regular.investedTime);
    }
    if (curNodc) {
      nodc.otherBillable = addStats(curNodc.data.otherBillable, nodc.otherBillable);
      nodc.investedTime  = addStats(curNodc.data.investedTime,  nodc.investedTime);
    }
  }

  return { regular, nodc };
}

export let _qaInFlight: Promise<QARawJob[]> | null = null;
export function buildQaDeduped(forceNew = false): Promise<QARawJob[]> {
  if (forceNew) _qaInFlight = null;
  if (!_qaInFlight) {
    _qaInFlight = fetchQualityAssurance().finally(() => { _qaInFlight = null; });
  }
  return _qaInFlight;
}

// Cache-first (same QA_CACHE_TTL as the stats route) so the raw QA view
// doesn't re-run the full staff+job scan on every open.
export async function getQaRaw(force = false): Promise<QARawJob[]> {
  const cached = await readQaCache();
  const fresh  = cached && Date.now() - cached.ts < QA_CACHE_TTL;
  if (fresh && !force) return cached.data;
  try {
    const data = await buildQaDeduped(force);
    await writeQaCache(data);
    return data;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

export async function warmTechSupport(): Promise<void> {
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year  = aest.getUTCFullYear();
  const month = aest.getUTCMonth() + 1;
  scheduleCcIdRefresh();
  await refreshCcNames();

  // Build QA once (not month-specific)
  const qa = await buildQaDeduped().catch(() => null);
  if (qa) await writeQaCache(qa);

  // Build current month + next 2 months sequentially to avoid re-exhausting
  // SimPRO's rate limit (warmAll() already hit it hard before this runs)
  for (let i = 0; i < 3; i++) {
    const d = new Date(year, month - 1 + i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const obIt = await buildObItDeduped(y, m).catch(() => null);
    if (obIt) {
      await writeObItCache(y, m, obIt.regular, false);
      await writeObItCache(y, m, obIt.nodc,    true);
    }
    // Reuses the blocks+jobMap the stats build above just warmed (see
    // buildBlocksAndJobMapCached) — no extra live SimPRO pull for this.
    // getObItRaw() writes its own cache entry internally.
    await getObItRaw(y, m, false).catch(() => null);
  }
}
