import { NextResponse } from "next/server";
import { readCacheRaw } from "../../lib/simpro";

const BASE_URL = process.env.SIMPRO_BASE_URL;
const TOKEN    = process.env.SIMPRO_TOKEN?.replace(/^﻿/, "").trim();
const hdrs     = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const LIST_COLS = "ID,Stage,Status,Technicians,Name";
const CFSP_ID  = 1126;

export async function GET(req: Request) {
  const url     = new URL(req.url);
  const mode    = url.searchParams.get("mode") ?? "tentative";
  const company = Number(url.searchParams.get("company") ?? "1");

  try {
    const [pending, progress] = await Promise.all([
      readCacheRaw(company, "Pending"),
      readCacheRaw(company, "Progress"),
    ]);

    const jobs = [
      ...(pending?.data  ?? []),
      ...(progress?.data ?? []),
    ];

    if (mode === "techs") {
      // Show all jobs with their technician names — for debugging filter issues
      const result = jobs.map(j => ({
        id:         j.ID,
        stage:      j.Stage,
        status:     (j.Status as Record<string,unknown>)?.Name ?? j.Stage,
        technicians: (j.Technicians as Record<string,unknown>[] | undefined)
          ?.map(t => ({ id: (t as Record<string,unknown>).ID, name: (t as Record<string,unknown>).Name })),
      }));
      return NextResponse.json({ company, total: result.length, jobs: result }, { headers: { "Cache-Control": "no-store" } });
    }

    if (mode === "tentative") {
      const tentative = jobs
        .filter(j => !j._scheduledDate)
        .map(j => ({
          id:             j.ID,
          name:           j.Name ?? j.Title,
          status:         (j.Status as Record<string,unknown>)?.Name ?? j.Stage,
          scheduledDate:  j._scheduledDate,
          scheduledHours: j._scheduledHours,
          estHours:       (() => {
            const t = j.Totals as Record<string,unknown> | undefined;
            const r = t?.ResourcesCost as Record<string,unknown> | undefined;
            const l = r?.LaborHours   as Record<string,unknown> | undefined;
            return l?.Estimate ?? 0;
          })(),
        }));
      return NextResponse.json({ company, total: tentative.length, jobs: tentative }, { headers: { "Cache-Control": "no-store" } });
    }

    if (mode === "scheduled") {
      const scheduled = jobs
        .filter(j => !!j._scheduledDate)
        .map(j => ({
          id:             j.ID,
          name:           j.Name ?? j.Title,
          status:         (j.Status as Record<string,unknown>)?.Name ?? j.Stage,
          scheduledDate:  j._scheduledDate,
          scheduledHours: j._scheduledHours,
        }));
      return NextResponse.json({ company, total: scheduled.length, jobs: scheduled }, { headers: { "Cache-Control": "no-store" } });
    }

    if (mode === "raw") {
      // Fetch directly from SimPRO — bypasses all caching and filtering
      const stage = url.searchParams.get("stage") ?? "Pending";
      const r = await fetch(
        `${BASE_URL}/api/v1.0/companies/${company}/jobs/?pageSize=10&columns=${LIST_COLS}&Stage=${stage}&page=1`,
        { headers: hdrs, cache: "no-store" }
      );
      const raw = await r.json();
      const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : (raw?.Result ?? []);
      const sample = items.slice(0, 10).map(j => ({
        id:   j.ID,
        name: j.Name,
        stage: j.Stage,
        technicians: j.Technicians,
        techIDs: (j.Technicians as Record<string,unknown>[] | undefined)
          ?.map(t => (t as Record<string,unknown>).ID),
        passesFilter: (j.Technicians as Record<string,unknown>[] | undefined)
          ?.some(t => Number((t as Record<string,unknown>).ID) === CFSP_ID) ?? false,
      }));
      return NextResponse.json({
        company, stage, totalReturned: items.length, cfspId: CFSP_ID, sample,
        passCount: sample.filter(j => j.passesFilter).length,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ error: "mode must be tentative, scheduled, techs, or raw" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
