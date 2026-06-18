import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { gcsWrite } from "../../lib/gcsCache";
import { buildData, cacheFile, CACHE_TTL } from "./core";

export type { AfacProspectResponse } from "./core";

export async function GET(req: Request) {
  const url   = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const yearParam   = url.searchParams.get("year");
  const monthParam  = url.searchParams.get("month");
  const filterYear  = yearParam  ? parseInt(yearParam,  10) : undefined;
  const filterMonth = monthParam ? parseInt(monthParam, 10) : undefined;

  try {
    const raw = await fs.readFile(cacheFile(filterYear, filterMonth), "utf-8");
    const c   = JSON.parse(raw) as { data: unknown; ts: number };
    if (!force && Date.now() - c.ts < CACHE_TTL) {
      return NextResponse.json(c.data, { headers: { "Cache-Control": "no-store" } });
    }
  } catch { /* cold cache */ }

  let data;
  try {
    data = await buildData(filterYear, filterMonth);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  const json = JSON.stringify({ data, ts: Date.now() });
  fs.writeFile(cacheFile(filterYear, filterMonth), json, "utf-8").catch(() => {});
  gcsWrite(`afss-afac-prospect-v9-${cacheFile(filterYear, filterMonth).split("v9-")[1]}`, json);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
