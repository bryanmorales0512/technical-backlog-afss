import { NextResponse } from "next/server";
import { getRawRows } from "../core";

// Cache-first (see getRawRows) — only a cold or forced request pays the
// full live-SimPRO cost.
export const maxDuration = 300;

export async function GET(req: Request) {
  const url        = new URL(req.url);
  const yearParam  = url.searchParams.get("year");
  const monthParam = url.searchParams.get("month");
  const filterYear  = yearParam  ? parseInt(yearParam,  10) : undefined;
  const filterMonth = monthParam ? parseInt(monthParam, 10) : undefined;
  const force = url.searchParams.get("force") === "1";

  try {
    const rows = await getRawRows(filterYear, filterMonth, force);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
