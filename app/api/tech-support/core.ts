import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const TEAM_IDS = new Set<number>([1581, 15, 1753]);
export const RATE = 100;

export const OB_IT_CACHE_TTL = 5  * 60_000;
export const QA_CACHE_TTL    = 60 * 60_000;

const AFSS_CC_NAMES = new Set([
  "afe afex systems",
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

export const KNOWN_AFSS_CC_IDS = new Set<number>([
  361944, 364605, 364606, 364607, 366362, 366676,
  366702, 362953, 363815, 364810, 366596, 366467,
  367774, 366871, 367112, 367904,
  366878, 367111, 367813, 367825, 367828,
  342907,
  365492, 367662, // AFSS WORKS
]);

const KNOWN_DATACOM_CC_IDS = new Set<number>([366467]);
const INTERNAL_CLIENTS = ["REDMEN FIRE", "AFAC", "ADAIR OPERATION", "Z SAFE"];

export type TechSupportStats = { jobs: number; hours: number; amount: number };
export type QARawJob = { id: unknown; dueDate: string; estHours: number };
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
  return join(CACHE_DIR, `afss-tech-support-v110${tag}-${year}-${String(month).padStart(2, "0")}.json`);
}
export async function readObItCache(year: number, month: number, nodc = false): Promise<{ data: { otherBillable: TechSupportStats; investedTime: TechSupportStats }; ts: number } | null> {
  try { return JSON.parse(await fs.readFile(obItCacheFile(year, month, nodc), "utf-8")); } catch { return null; }
}
export async function writeObItCache(year: number, month: number, data: { otherBillable: TechSupportStats; investedTime: TechSupportStats }, nodc = false) {
  const tag = nodc ? "-nodc" : "";
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(obItCacheFile(year, month, nodc), json, "utf-8").catch(() => {});
  gcsWrite(`afss-tech-support-v110${tag}-${year}-${String(month).padStart(2, "0")}.json`, json);
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
  if (b.ccName.length > 0) return b.ccName.toLowerCase();
  if (ccCache && b.ccId > 0 && ccCache.has(b.ccId)) return ccCache.get(b.ccId)!.toLowerCase();
  return "";
}

export function isDatacomBlock(b: BlockInfo, ccCache?: Map<number, string>): boolean {
  if (KNOWN_DATACOM_CC_IDS.has(b.ccId)) return true;
  return resolvedCcName(b, ccCache).startsWith("datacom");
}

export function isAfssBlock(b: BlockInfo, ccCache?: Map<number, string>, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): boolean {
  if (b.ccName.length > 0) return AFSS_CC_NAMES.has(b.ccName.toLowerCase());
  if (ccCache && b.ccId > 0 && ccCache.has(b.ccId)) return AFSS_CC_NAMES.has(ccCache.get(b.ccId)!.toLowerCase());
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
      batch.map(id => simGet(`/api/v1.0/companies/1/jobs/${id}?columns=ID,Stage,Customer`).catch(() => null))
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
  } catch { return new Map(); }
}
export async function saveCcCache(cache: Map<number, string>): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [k, v] of cache) obj[String(k)] = v;
  try { await fs.writeFile(CC_CACHE_FILE, JSON.stringify(obj), "utf-8"); } catch {}
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
          const n = String((cc.CostCenter as Record<string,unknown>)?.Name ?? cc.Name ?? "");
          if (n.length > 0) { name = n; break; }
        }
      } else {
        for (const sect of listOf(raw)) {
          const cc = sect.CostCenter as Record<string, unknown> | undefined;
          if (!cc) continue;
          const id = Number(cc.ID   ?? 0);
          const n  = String(cc.Name ?? "");
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

export function calcOtherBillable(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportStats {
  const stat: TechSupportStats = { jobs: 0, hours: 0, amount: 0 };
  for (const b of blockList) {
    if (!isAfssBlock(b, ccCache, afssIds)) continue;
    if (excludeDatacom && isDatacomBlock(b, ccCache)) continue;
    const job = jobMap.get(b.jobId);
    // If job details failed to load, include as OB (external, pending assumption)
    if (!job) {
      stat.jobs++;
      stat.hours  = Math.round((stat.hours  + b.hours)        * 100) / 100;
      stat.amount = Math.round((stat.amount + b.hours * RATE)  * 100) / 100;
      continue;
    }
    const stage = String(job.Stage ?? "").toLowerCase();
    if (stage !== "pending" && stage !== "progress") continue;
    if (isInternalClient(job)) continue;
    stat.jobs++;
    stat.hours  = Math.round((stat.hours  + b.hours)        * 100) / 100;
    stat.amount = Math.round((stat.amount + b.hours * RATE)  * 100) / 100;
  }
  return stat;
}

export function calcInvestedTime(blockList: BlockInfo[], jobMap: Map<string, Record<string, unknown>>, ccCache: Map<number, string>, excludeDatacom = false, afssIds: Set<number> = KNOWN_AFSS_CC_IDS): TechSupportStats {
  const stat: TechSupportStats = { jobs: 0, hours: 0, amount: 0 };
  for (const b of blockList) {
    if (!isAfssBlock(b, ccCache, afssIds)) continue;
    if (excludeDatacom && isDatacomBlock(b, ccCache)) continue;
    const job = jobMap.get(b.jobId);
    if (!job) continue; // if unknown, OB already claimed it above
    const stage = String(job.Stage ?? "").toLowerCase();
    if (stage !== "pending" && stage !== "progress") continue;
    if (!isInternalClient(job)) continue;
    stat.jobs++;
    stat.hours  = Math.round((stat.hours  + b.hours)        * 100) / 100;
    stat.amount = Math.round((stat.amount + b.hours * RATE)  * 100) / 100;
  }
  return stat;
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
  const cols = "ID,Totals,Technicians,DueDate";
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
    rawJobs.push({ id: job.ID, dueDate: String(job.DueDate ?? ""), estHours: est > 0 ? est : 2 });
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

async function buildObIt(year: number, month: number): Promise<{ regular: { otherBillable: TechSupportStats; investedTime: TechSupportStats }; nodc: { otherBillable: TechSupportStats; investedTime: TechSupportStats } }> {
  const tentativeIds = await getTentativeStaffIds();
  scheduleCcIdRefresh();
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
  const regular = {
    otherBillable: calcOtherBillable(blockList, jobMap, ccCache, false, afssIds),
    investedTime:  calcInvestedTime(blockList, jobMap, ccCache, false, afssIds),
  };
  const nodc = {
    otherBillable: calcOtherBillable(blockList, jobMap, ccCache, true, afssIds),
    investedTime:  calcInvestedTime(blockList, jobMap, ccCache, true, afssIds),
  };

  // For a future month, merge the current month's data so the displayed range
  // covers "today → end of target month" (matching SimPRO's date range).
  // Build the current month on the fly if its cache doesn't exist yet.
  const aest       = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const todayYear  = aest.getUTCFullYear();
  const todayMonth = aest.getUTCMonth() + 1;
  const isFuture   = year > todayYear || (year === todayYear && month > todayMonth);
  if (isFuture) {
    let curReg  = await readObItCache(todayYear, todayMonth, false);
    let curNodc = await readObItCache(todayYear, todayMonth, true);
    if (!curReg || !curNodc) {
      try {
        const curBuilt = await buildObItDeduped(todayYear, todayMonth);
        await writeObItCache(todayYear, todayMonth, curBuilt.regular, false);
        await writeObItCache(todayYear, todayMonth, curBuilt.nodc,    true);
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

export async function warmTechSupport(): Promise<void> {
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year  = aest.getUTCFullYear();
  const month = aest.getUTCMonth() + 1;
  scheduleCcIdRefresh();

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
  }
}
