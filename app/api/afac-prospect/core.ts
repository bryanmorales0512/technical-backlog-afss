import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const AFSS_STAFF_ID = 1581;

export const CACHE_TTL = 60 * 60_000;
export const EXCLUSIONS_FILE = join(process.cwd(), "data", "afac-exclusions.json");

export function cacheFile(filterYear?: number, filterMonth?: number) {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = filterYear  ?? aest.getUTCFullYear();
  const m = String(filterMonth ?? (aest.getUTCMonth() + 1)).padStart(2, "0");
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-afac-prospect-v10-${y}-${m}.json`);
}

async function loadExclusions(): Promise<Set<string>> {
  try {
    const dates = JSON.parse(await fs.readFile(EXCLUSIONS_FILE, "utf-8")) as string[];
    return new Set(dates);
  } catch { return new Set(); }
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

// Returns 5 evenly-spread weekdays across a month for quick sampling
function sampleWeekdays(year: number, month: number): string[] {
  const lastDay = new Date(year, month, 0).getDate();
  const targets = [2, Math.round(lastDay * 0.25), Math.round(lastDay * 0.5), Math.round(lastDay * 0.75), lastDay - 1];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of targets) {
    const d = new Date(year, month - 1, Math.max(1, Math.min(t, lastDay)));
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    if (d.getMonth() !== month - 1) continue;
    const s = fmt(d);
    if (!seen.has(s)) { seen.add(s); result.push(s); }
  }
  return result;
}

// Scans backwards from the month before baseYear/baseMonth to find the most recent
// month where Soban had AFAC (non-REDMEN-FIRE) jobs scheduled in Company 8.
// Uses 5 sample weekdays per month to keep API calls low.
async function findLatestAfacMonth(baseYear: number, baseMonth: number): Promise<{ year: number; month: number }> {
  for (let i = 1; i <= 24; i++) {
    let m = baseMonth - i;
    let y = baseYear;
    while (m <= 0) { m += 12; y--; }

    const samples = sampleWeekdays(y, m);
    for (const day of samples) {
      const raw = listOf(await simGet(`/api/v1.0/companies/8/schedules/?Date=${day}&pageSize=250`) ?? []);
      const sobanBlocks = raw.filter(b => (b.Staff as Record<string, unknown>)?.ID === AFSS_STAFF_ID);
      if (sobanBlocks.length === 0) { await sleep(80); continue; }

      const pids = [
        ...new Set(
          sobanBlocks
            .map(b => (b.Project as Record<string, unknown>)?.ProjectID)
            .filter((id): id is string | number => id != null)
        ),
      ];
      const jobs = await Promise.all(pids.map(id => simGet(`/api/v1.0/companies/8/jobs/${id}`).catch(() => null)));
      const hasAfac = jobs.some(job => {
        if (!job) return false;
        const customer = String(((job as Record<string, unknown>).Customer as Record<string, unknown>)?.CompanyName ?? "").toUpperCase();
        return !customer.includes("REDMEN FIRE");
      });
      if (hasAfac) {
        await sleep(80);
        return { year: y, month: m };
      }
      await sleep(80);
    }
  }
  // Fallback: previous year same month
  return { year: baseYear - 1, month: baseMonth };
}

export type AfacProspectResponse = {
  jobs: number;
  hours: number;
  dateFrom: string;
  dateTo: string;
  costCentreFiltered: boolean;
};

export async function buildData(filterYear?: number, filterMonth?: number): Promise<AfacProspectResponse> {
  const exclusions = await loadExclusions();

  const aest      = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const baseYear  = filterYear  ?? aest.getUTCFullYear();
  const baseMonth = filterMonth ?? (aest.getUTCMonth() + 1);

  // Auto-detect the most recent past month where Soban had AFAC jobs in SimPRO
  const { year: targetYear, month: targetMonth } = await findLatestAfacMonth(baseYear, baseMonth);

  const start    = new Date(targetYear, targetMonth - 1, 1);
  const end      = new Date(targetYear, targetMonth, 0);
  const dateFrom = fmt(start);
  const dateTo   = fmt(end);

  let allBlocks: Record<string, unknown>[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      const day = fmt(new Date(cursor));
      if (!exclusions.has(day)) {
        const raw = listOf(await simGet(
          `/api/v1.0/companies/8/schedules/?Date=${day}&pageSize=250`
        ) ?? []);
        allBlocks = allBlocks.concat(raw);
      }
      await sleep(80);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const sobanBlocks = allBlocks.filter(
    b => (b.Staff as Record<string, unknown>)?.ID === AFSS_STAFF_ID
  );

  const uniqueProjectIds = [
    ...new Set(
      sobanBlocks
        .map(b => (b.Project as Record<string, unknown>)?.ProjectID)
        .filter((id): id is string | number => id != null)
    ),
  ];

  const jobDetails = await Promise.all(
    uniqueProjectIds.map(id =>
      simGet(`/api/v1.0/companies/8/jobs/${id}`).catch(() => null)
    )
  );

  const afssProjectIds = new Set<string | number>();
  const jobTotalMap = new Map<string | number, number>();
  uniqueProjectIds.forEach((id, i) => {
    const job = jobDetails[i] as Record<string, unknown> | null;
    if (!job) return;
    const customer = String(
      (job.Customer as Record<string, unknown>)?.CompanyName ?? ""
    ).toUpperCase();
    if (!customer.includes("REDMEN FIRE")) {
      afssProjectIds.add(id);
      const exTax = Number((job.Total as Record<string, unknown>)?.ExTax ?? 0);
      jobTotalMap.set(id, exTax);
    }
  });

  const afssBlocks = sobanBlocks.filter(b => {
    const pid = (b.Project as Record<string, unknown>)?.ProjectID;
    return pid != null && afssProjectIds.has(pid as string | number);
  });

  let totalHours = 0;
  for (const b of afssBlocks) {
    totalHours += Number(b.TotalHours ?? 0);
  }

  return {
    jobs: afssProjectIds.size,
    hours: Math.round(totalHours * 100) / 100,
    dateFrom,
    dateTo,
    costCentreFiltered: true,
  };
}

export async function warmAfacProspect(): Promise<void> {
  const data = await buildData();
  const json = JSON.stringify({ data, ts: Date.now() });
  try {
    await fs.writeFile(cacheFile(), json, "utf-8");
  } catch { /* ignore */ }
  gcsWrite(`afss-afac-prospect-v10-${cacheFile().split("v10-")[1]}`, json);
}
