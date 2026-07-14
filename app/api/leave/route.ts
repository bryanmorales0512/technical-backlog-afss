import { NextResponse } from "next/server";
import { readLeaveCache, scanMonthLeave, writeLeaveCache, buildResponse, CACHE_TTL } from "./core";


export async function GET(req: Request) {
  const url   = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  // Accept an explicit year/month so leave already booked for a future month
  // is scanned for that month instead of always defaulting to today's real
  // month — previously any leave filed for a future month was silently never
  // scanned until that month became "current".
  const year  = url.searchParams.get("year")  ? Number(url.searchParams.get("year"))  : aest.getUTCFullYear();
  const month = url.searchParams.get("month") ? Number(url.searchParams.get("month")) : aest.getUTCMonth() + 1;

  const cached = await readLeaveCache(year, month);
  if (cached) {
    const fresh = Date.now() - cached.ts < CACHE_TTL;
    if (fresh && !force) {
      return NextResponse.json(await buildResponse(cached.data, year, month), { headers: { "Cache-Control": "no-store" } });
    }
    scanMonthLeave(year, month).then(d => writeLeaveCache(d, year, month)).catch(() => {});
    return NextResponse.json(await buildResponse(cached.data, year, month), { headers: { "Cache-Control": "no-store" } });
  }

  const leaveDays = await scanMonthLeave(year, month);
  await writeLeaveCache(leaveDays, year, month);
  return NextResponse.json(await buildResponse(leaveDays, year, month), { headers: { "Cache-Control": "no-store" } });
}
