import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { gcsRead, gcsWrite } from "../../lib/gcsCache";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const LEAVE_REFS  = new Set(["1", "2"]); // Annual Leave, Sick/Personal Leave
const MEMBERS_FILE = join(process.cwd(), "data", "extra-team-members.json");
const MEMBERS_GCS_KEY = "data-extra-team-members.json";
const CACHE_FILE  = join(os.tmpdir(), "afss-extra-team-leave-cache.json");
const CACHE_TTL   = 60 * 60_000;

export type ExtraMember = { id: number; name: string; role: string; company: number };
type LeaveCache = { data: Record<number, string[]>; ts: number };

// ── persistence ──────────────────────────────────────────────────────────────

async function readMembers(): Promise<ExtraMember[]> {
  // Try local file first (fast path)
  try {
    return JSON.parse(await fs.readFile(MEMBERS_FILE, "utf-8")) as ExtraMember[];
  } catch {}
  // Fall back to GCS (new container after deployment)
  try {
    const remote = await gcsRead(MEMBERS_GCS_KEY);
    if (remote) {
      const data = JSON.parse(remote) as ExtraMember[];
      fs.writeFile(MEMBERS_FILE, remote, "utf-8").catch(() => {});
      return data;
    }
  } catch {}
  return [];
}

async function writeMembers(members: ExtraMember[]): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  const json = JSON.stringify(members, null, 2);
  await fs.writeFile(MEMBERS_FILE, json, "utf-8");
  gcsWrite(MEMBERS_GCS_KEY, json);
}

async function readLeaveCache(): Promise<LeaveCache | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf-8")) as LeaveCache;
  } catch { return null; }
}

async function writeLeaveCache(data: Record<number, string[]>): Promise<void> {
  await fs.writeFile(CACHE_FILE, JSON.stringify({ data, ts: Date.now() }), "utf-8");
}

// ── SimPRO helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDayBlocks(company: number, date: string): Promise<Record<string, unknown>[]> {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(
      `${BASE_URL}/api/v1.0/companies/${company}/schedules/?pageSize=250&Date=${date}`,
      { headers: hdrs, cache: "no-store" }
    );
    if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (d.Result ?? []);
  }
  return [];
}

// ── leave scanning ────────────────────────────────────────────────────────────

async function scanLeave(
  members: ExtraMember[],
  year: number,
  month: number,
): Promise<Record<number, string[]>> {
  const leaveDays: Record<number, string[]> = {};
  for (const m of members) leaveDays[m.id] = [];

  if (members.length === 0) return leaveDays;

  // Build list of weekdays to scan
  const daysInMonth = new Date(year, month, 0).getDate();
  const today       = new Date();
  const scanTo      = Math.min(
    daysInMonth,
    year === today.getFullYear() && month === today.getMonth() + 1
      ? today.getDate() + 7
      : daysInMonth,
  );
  const days: string[] = [];
  for (let d = 1; d <= scanTo; d++) {
    const date = new Date(year, month - 1, d);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }

  // Group members by company so we fetch the right schedule endpoint
  const byCompany = new Map<number, Set<number>>();
  for (const m of members) {
    if (!byCompany.has(m.company)) byCompany.set(m.company, new Set());
    byCompany.get(m.company)!.add(m.id);
  }

  for (const [company, ids] of byCompany) {
    const results = await Promise.all(days.map(d => fetchDayBlocks(company, d)));
    for (let j = 0; j < days.length; j++) {
      for (const block of results[j]) {
        const staffId = (block.Staff as Record<string, unknown>)?.ID as number;
        const ref     = String(block.Reference ?? "");
        if (ids.has(staffId) && block.Type === "activity" && LEAVE_REFS.has(ref)) {
          leaveDays[staffId].push(days[j]);
        }
      }
    }
  }

  return leaveDays;
}

// ── supply hours helpers ──────────────────────────────────────────────────────

function remainingWorkingDays(year: number, month: number): number {
  const now       = new Date();
  const past3PM   = now.getHours() >= 15;
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (past3PM ? 1 : 0));
  const monthEnd  = new Date(year, month, 0);
  let count = 0;
  for (let d = new Date(startDate); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) count++;
  }
  return count;
}

function groupConsecutive(dates: string[]): { from: string; to: string }[] {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const ranges: { from: string; to: string }[] = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (new Date(sorted[i]).getTime() - new Date(prev).getTime()) / 86_400_000;
    if (gap <= 3) { prev = sorted[i]; }
    else { ranges.push({ from: start, to: prev }); start = sorted[i]; prev = sorted[i]; }
  }
  ranges.push({ from: start, to: prev });
  return ranges;
}

function buildResponse(
  members: ExtraMember[],
  leaveDays: Record<number, string[]>,
  year: number,
  month: number,
) {
  const supplyHours = remainingWorkingDays(year, month) * 8;
  return members.map(m => ({
    ...m,
    monthlyHours: supplyHours,
    leave: groupConsecutive(leaveDays[m.id] ?? []),
  }));
}

// ── route handlers ────────────────────────────────────────────────────────────

export async function GET() {
  const members = await readMembers();
  const now     = new Date();
  const year    = now.getFullYear();
  const month   = now.getMonth() + 1;

  const cached = await readLeaveCache();
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(buildResponse(members, cached.data, year, month));
  }

  const leaveDays = await scanLeave(members, year, month);
  await writeLeaveCache(leaveDays);
  return NextResponse.json(buildResponse(members, leaveDays, year, month));
}

export async function POST(req: Request) {
  const body = await req.json() as { id: number; name: string; role: string; company: number };
  if (!body.id || !body.name) {
    return NextResponse.json({ error: "id and name are required" }, { status: 400 });
  }
  const members = await readMembers();
  if (members.some(m => m.id === body.id)) {
    return NextResponse.json({ error: "Member already added" }, { status: 409 });
  }
  members.push({ id: body.id, name: body.name, role: body.role || "", company: body.company });
  await writeMembers(members);

  // Invalidate leave cache so next GET rescans with the new member
  try { await fs.unlink(CACHE_FILE); } catch { /* ok if missing */ }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const body = await req.json() as { id: number };
  const members = await readMembers();
  const filtered = members.filter(m => m.id !== body.id);
  await writeMembers(filtered);
  try { await fs.unlink(CACHE_FILE); } catch { /* ok */ }
  return NextResponse.json({ ok: true });
}
