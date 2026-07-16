import { NextResponse } from "next/server";
import { getObItRaw, getQaRaw, getQADateTo } from "../core";

// Cache-first (see getObItRaw/getQaRaw) — only a cold or forced request pays
// the full live-SimPRO cost.
export const maxDuration = 300;

export async function GET(req: Request) {
  const url  = new URL(req.url);
  const type = url.searchParams.get("type") ?? "ob";
  const nodc = url.searchParams.get("nodc") === "1";
  const force = url.searchParams.get("force") === "1";

  const aest        = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const yearParam   = url.searchParams.get("year");
  const monthParam  = url.searchParams.get("month");
  const year  = yearParam  ? parseInt(yearParam,  10) : aest.getUTCFullYear();
  const month = monthParam ? parseInt(monthParam, 10) : aest.getUTCMonth() + 1;

  try {
    if (type === "qa") {
      const rows = await getQaRaw(force);
      // No year/month given (the "All" filter) — same unfiltered list as before.
      if (!yearParam && !monthParam) {
        return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
      }
      // Otherwise match the QA card's cutoff: every job due on/before the end
      // of the selected month, same as aggregateQA() in ../route.ts.
      const dateTo = getQADateTo(year, month, false);
      const filtered = rows.filter(r => r.dueDate && r.dueDate <= dateTo);
      return NextResponse.json({ rows: filtered }, { headers: { "Cache-Control": "no-store" } });
    }

    const { otherBillable, investedTime } = await getObItRaw(year, month, nodc, force);
    const rows = type === "it" ? investedTime : otherBillable;
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
