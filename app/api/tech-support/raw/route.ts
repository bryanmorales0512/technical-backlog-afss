import { NextResponse } from "next/server";
import { getObItRaw, getQaRaw } from "../core";

// Cache-first (see getObItRaw/getQaRaw) — only a cold or forced request pays
// the full live-SimPRO cost.
export const maxDuration = 300;

export async function GET(req: Request) {
  const url  = new URL(req.url);
  const type = url.searchParams.get("type") ?? "ob";
  const nodc = url.searchParams.get("nodc") === "1";
  const force = url.searchParams.get("force") === "1";

  try {
    if (type === "qa") {
      const rows = await getQaRaw(force);
      return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
    }

    const aest        = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const yearParam   = url.searchParams.get("year");
    const monthParam  = url.searchParams.get("month");
    const year  = yearParam  ? parseInt(yearParam,  10) : aest.getUTCFullYear();
    const month = monthParam ? parseInt(monthParam, 10) : aest.getUTCMonth() + 1;

    const { otherBillable, investedTime } = await getObItRaw(year, month, nodc, force);
    const rows = type === "it" ? investedTime : otherBillable;
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
