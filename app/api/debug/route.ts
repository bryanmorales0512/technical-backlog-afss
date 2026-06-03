import { NextResponse } from "next/server";
import { readCacheRaw } from "../../lib/simpro";

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

    return NextResponse.json({ error: "mode must be tentative, scheduled, or techs" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
