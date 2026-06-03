import { NextResponse } from "next/server";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function simGet(path: string): Promise<unknown> {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${BASE_URL}${path}`, { headers: hdrs, cache: "no-store" });
    if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

function list(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    if (Array.isArray(o.Result)) return o.Result as Record<string, unknown>[];
  }
  return [];
}

// Search across all three companies for a staff member by name
export async function GET(req: Request) {
  const url  = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
  if (!name || name.length < 2) {
    return NextResponse.json({ error: "Name must be at least 2 characters" }, { status: 400 });
  }

  const companies = [1, 8, 10];
  const seen = new Set<number>();
  const results: { id: number; name: string; company: number }[] = [];

  for (const company of companies) {
    // Paginate through all staff — pageSize=250 may not cover everyone
    for (let page = 1; page <= 10; page++) {
      const data = list(await simGet(
        `/api/v1.0/companies/${company}/staff/?pageSize=250&columns=ID,Name&page=${page}`
      ));
      if (data.length === 0) break;
      for (const emp of data) {
        const id = emp.ID as number;
        if (!id || seen.has(id)) continue;
        const display = String(emp.Name ?? "").trim();
        if (display.toLowerCase().includes(name)) {
          seen.add(id);
          results.push({ id, name: display, company });
        }
      }
      if (data.length < 250) break; // last page
    }
  }

  return NextResponse.json(results);
}
