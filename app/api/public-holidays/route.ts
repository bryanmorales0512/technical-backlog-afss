import { NextResponse } from "next/server";
import { getMonthPublicHolidays } from "../leave/core";

export async function GET(req: Request) {
  const url   = new URL(req.url);
  const year  = parseInt(url.searchParams.get("year") ?? "0");
  const month = parseInt(url.searchParams.get("month") ?? "0");
  if (!year || month < 1 || month > 12) return NextResponse.json([]);
  const holidays = await getMonthPublicHolidays(year, month);
  return NextResponse.json(holidays, { headers: { "Cache-Control": "no-store" } });
}
