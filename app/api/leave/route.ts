import { NextResponse } from "next/server";
import { readLeaveCache, scanMonthLeave, writeLeaveCache, buildResponse, CACHE_TTL } from "./core";


export async function GET(req: Request) {
  const url   = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const aest  = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year  = aest.getUTCFullYear();
  const month = aest.getUTCMonth() + 1;

  const cached = await readLeaveCache();
  if (cached) {
    const fresh = Date.now() - cached.ts < CACHE_TTL;
    if (fresh && !force) {
      return NextResponse.json(await buildResponse(cached.data, year, month), { headers: { "Cache-Control": "no-store" } });
    }
    scanMonthLeave(year, month).then(writeLeaveCache).catch(() => {});
    return NextResponse.json(await buildResponse(cached.data, year, month), { headers: { "Cache-Control": "no-store" } });
  }

  const leaveDays = await scanMonthLeave(year, month);
  await writeLeaveCache(leaveDays);
  return NextResponse.json(await buildResponse(leaveDays, year, month), { headers: { "Cache-Control": "no-store" } });
}
