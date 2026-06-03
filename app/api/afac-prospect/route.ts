import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsRead, gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// Muhammad Soban's SimPRO employee ID — schedules under company 8.
const AFSS_STAFF_ID = 1581;

// Cache key includes year-month so it automatically rebuilds when the month changes.
const CACHE_TTL = 60 * 60_000; // 1 hour — refresh AFAC prospect data every hour
const EXCLUSIONS_FILE = join(process.cwd(), "data", "afac-exclusions.json");

function cacheFile() {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = aest.getUTCFullYear();
  const m = String(aest.getUTCMonth() + 1).padStart(2, "0");
  return join((process.env.CACHE_DIR ?? os.tmpdir()), `afss-afac-prospect-v9-${y}-${m}.json`);
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
      if (r.status >= 500) { await sleep(500 * (a + 1)); continue; } // retry server errors
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

async function buildData(): Promise<AfacProspectResponse> {
  const exclusions = await loadExclusions();

  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  // Start from today's date last year (e.g. June 3 2026 → June 3 2025),
  // end at the last day of that same month (June 30 2025).
  // This advances each day, matching remaining prospect days for the period.
  const start = new Date(aest.getUTCFullYear() - 1, aest.getUTCMonth(), aest.getUTCDate());
  const end   = new Date(aest.getUTCFullYear() - 1, aest.getUTCMonth() + 1, 0);
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

  // Keep only Soban's blocks.
  const sobanBlocks = allBlocks.filter(
    b => (b.Staff as Record<string, unknown>)?.ID === AFSS_STAFF_ID
  );

  // Look up each unique ProjectID to distinguish AFSS-Audit jobs (external customers
  // like CHUBB) from internal jobs (REDMEN FIRE study time, admin, etc.).
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
    // Exclude internal REDMEN FIRE jobs (study time, admin, etc.).
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

  // Count individual time blocks — matches SimPRO "Results" row count.
  let totalRows = 0;
  let totalHours = 0;
  for (const b of afssBlocks) {
    const subBlocks = Array.isArray(b.Blocks) ? (b.Blocks as unknown[]) : [];
    totalRows += subBlocks.length > 0 ? subBlocks.length : 1;
    totalHours += Number(b.TotalHours ?? 0);
  }

  return {
    jobs: totalRows,
    hours: Math.round(totalHours * 100) / 100,
    dateFrom,
    dateTo,
    costCentreFiltered: true,
  };
}

export async function warmAfacProspect(): Promise<void> {
  const data = await buildData();
  try {
    await fs.writeFile(cacheFile(), JSON.stringify({ data, ts: Date.now() }), "utf-8");
  } catch { /* ignore */ }
}

export async function GET(req: Request) {
  const url   = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  try {
    const raw = await fs.readFile(cacheFile(), "utf-8");
    const c   = JSON.parse(raw) as { data: AfacProspectResponse; ts: number };
    if (!force && Date.now() - c.ts < CACHE_TTL) {
      return NextResponse.json(c.data, { headers: { "Cache-Control": "no-store" } });
    }
  } catch { /* cold cache */ }

  // Cloud Run throttles CPU after the response is sent, so background refreshes
  // never complete. Always rebuild synchronously when stale or on force.
  let data: AfacProspectResponse;
  try {
    data = await buildData();
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(cacheFile(), json, "utf-8").catch(() => {});
  gcsWrite(`afss-afac-prospect-v9-${cacheFile().split("v9-")[1]}`, json);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
