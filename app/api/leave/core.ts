import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const LEAVE_REFS = new Set(["1", "2"]);

export const TEAM = [
  { id: 1581, name: "Muhammad Soban", role: "Primary APFS"                                        },
  { id: 15,   name: "Ryan Gordon",    role: "Mixed of Technical Support Works and Secondary APFS" },
  { id: 1753, name: "Josh Roger",     role: "Estimation / Office Management Time ETC"             },
] as const;

export type PublicHoliday = { date: string; name: string };

function phCacheFile(year: number) {
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-public-holidays-nsw-v3-${year}.json`);
}

// The NSW gov public holidays page (nsw.gov.au/about-nsw/public-holidays)
// lists a separate "Additional Day" row for New Year's/Christmas/Boxing Day
// whenever the actual date falls on a weekend and a substitute Monday (or
// Tuesday) is declared. Per business decision, that substitute day is not
// observed as a public holiday here — only the literal calendar date counts,
// even when it falls on a weekend (i.e. no weekday deduction that year).
const CANONICAL_MMDD: Record<string, string> = {
  "New Year's Day":   "01-01",
  "Christmas Day":    "12-25",
  "Boxing Day":       "12-26",
  "St. Stephen's Day": "12-26", // nager.at's alternate name for Boxing Day
};

function isSubstituteDay(h: { date: string; name: string }): boolean {
  const canonical = CANONICAL_MMDD[h.name];
  return canonical != null && h.date.slice(5) !== canonical;
}

// The NSW Bank Holiday (first Monday of August) is a bank/financial-sector
// holiday only — not observed as a public holiday for this business, so it's
// deliberately excluded from both the live-fetched and fallback holiday lists.
export async function fetchNSWPublicHolidays(year: number): Promise<PublicHoliday[]> {
  try {
    const raw = await fs.readFile(phCacheFile(year), "utf-8");
    return JSON.parse(raw) as PublicHoliday[];
  } catch { /* fetch fresh */ }

  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/AU`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as Array<{ date: string; name: string; global: boolean; counties: string[] | null }>;
    const holidays: PublicHoliday[] = data
      .filter(h => h.global || h.counties?.includes("AU-NSW"))
      .filter(h => h.name !== "Bank Holiday")
      .filter(h => !isSubstituteDay(h))
      .map(h => ({ date: h.date, name: h.name }));
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    await fs.writeFile(phCacheFile(year), JSON.stringify(holidays), "utf-8").catch(() => {});
    return holidays;
  } catch {
    return FALLBACK_HOLIDAYS[year] ?? [];
  }
}

const FALLBACK_HOLIDAYS: Record<number, PublicHoliday[]> = {
  2025: [
    { date: "2025-01-01", name: "New Year's Day" },
    { date: "2025-01-27", name: "Australia Day" },
    { date: "2025-04-18", name: "Good Friday" },
    { date: "2025-04-19", name: "Easter Saturday" },
    { date: "2025-04-21", name: "Easter Monday" },
    { date: "2025-04-25", name: "ANZAC Day" },
    { date: "2025-06-09", name: "King's Birthday" },
    { date: "2025-10-06", name: "Labour Day" },
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Boxing Day" },
  ],
  2026: [
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-04", name: "Easter Saturday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-04-27", name: "ANZAC Day" },
    { date: "2026-06-08", name: "King's Birthday" },
    { date: "2026-10-05", name: "Labour Day" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-26", name: "Boxing Day" },
  ],
  2027: [
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-26", name: "Australia Day" },
    { date: "2027-03-26", name: "Good Friday" },
    { date: "2027-03-27", name: "Easter Saturday" },
    { date: "2027-03-29", name: "Easter Monday" },
    { date: "2027-04-26", name: "ANZAC Day" },
    { date: "2027-06-14", name: "King's Birthday" },
    { date: "2027-10-04", name: "Labour Day" },
    { date: "2027-12-25", name: "Christmas Day" },
    { date: "2027-12-26", name: "Boxing Day" },
  ],
};

export async function getMonthPublicHolidays(year: number, month: number): Promise<PublicHoliday[]> {
  const all    = await fetchNSWPublicHolidays(year);
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return all.filter(ph => ph.date.startsWith(prefix));
}

export function remainingWorkingDays(year: number, month: number, phDates: Set<string>): number {
  const aest      = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const past3PM   = aest.getUTCHours() >= 15;
  const offset    = past3PM ? 1 : 0;
  const startDate = new Date(aest.getUTCFullYear(), aest.getUTCMonth(), aest.getUTCDate() + offset);
  const monthEnd  = new Date(year, month, 0);
  let count = 0;
  for (let d = new Date(startDate); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const day     = d.getDay();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (day !== 0 && day !== 6 && !phDates.has(dateStr)) count++;
  }
  return count;
}

const TEAM_IDS = new Set<number>(TEAM.map(m => m.id));
export const CACHE_TTL = 60 * 60_000;

type LeaveCache = { data: Record<number, string[]>; ts: number };

export function cacheFile() {
  return join((process.env.CACHE_DIR ?? os.tmpdir()), "afss-leave-cache.json");
}

const GCS_LEAVE_KEY = "afss-leave-cache.json";

export async function readLeaveCache(): Promise<LeaveCache | null> {
  try { return JSON.parse(await fs.readFile(cacheFile(), "utf-8")) as LeaveCache; } catch { return null; }
}

export async function writeLeaveCache(data: Record<number, string[]>): Promise<void> {
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(cacheFile(), json, "utf-8").catch(() => {});
  gcsWrite(GCS_LEAVE_KEY, json);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDayBlocks(date: string): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(
        `${BASE_URL}/api/v1.0/companies/1/schedules/?pageSize=250&Date=${date}`,
        { headers: hdrs, cache: "no-store" }
      );
      if (r.status === 429) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : (d.Result ?? []);
    } catch {
      if (attempt < 3) await sleep(500 * (attempt + 1));
    }
  }
  return [];
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

export async function scanMonthLeave(year: number, month: number): Promise<Record<number, string[]>> {
  const leaveDays: Record<number, string[]> = { 1581: [], 15: [], 1753: [] };
  const daysInMonth = new Date(year, month, 0).getDate();
  const today       = new Date();
  const scanTo = Math.min(daysInMonth, year === today.getFullYear() && month === today.getMonth() + 1
    ? today.getDate() + 7
    : daysInMonth
  );
  const days: string[] = [];
  for (let d = 1; d <= scanTo; d++) {
    const date = new Date(year, month - 1, d);
    if (isWeekday(date)) {
      days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  const results = await Promise.all(days.map(fetchDayBlocks));
  for (let j = 0; j < days.length; j++) {
    const dateStr = days[j];
    for (const block of results[j]) {
      const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
      const ref     = String(block.Reference ?? "");
      if (TEAM_IDS.has(staffId) && block.Type === "activity" && LEAVE_REFS.has(ref)) {
        leaveDays[staffId].push(dateStr);
      }
    }
  }
  return leaveDays;
}

export function groupConsecutive(dates: string[]): { from: string; to: string }[] {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const ranges: { from: string; to: string }[] = [];
  let start = sorted[0];
  let prev  = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur  = new Date(sorted[i]);
    const last = new Date(prev);
    const gap  = (cur.getTime() - last.getTime()) / 86_400_000;
    if (gap <= 3) {
      prev = sorted[i];
    } else {
      ranges.push({ from: start, to: prev });
      start = sorted[i];
      prev  = sorted[i];
    }
  }
  ranges.push({ from: start, to: prev });
  return ranges;
}

export async function buildResponse(leaveDays: Record<number, string[]>, year: number, month: number) {
  const monthPH     = await getMonthPublicHolidays(year, month);
  const phDates     = new Set(monthPH.map(ph => ph.date));
  const supplyHours = remainingWorkingDays(year, month, phDates) * 8;
  return {
    team: TEAM.map(m => ({
      ...m,
      monthlyHours: supplyHours,
      leave: groupConsecutive(leaveDays[m.id] ?? []),
    })),
    publicHolidays: monthPH,
  };
}

export async function warmLeave(): Promise<void> {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year = aest.getUTCFullYear();
  const month = aest.getUTCMonth() + 1;
  await fetchNSWPublicHolidays(year);
  const leaveDays = await scanMonthLeave(year, month);
  await writeLeaveCache(leaveDays);
}
