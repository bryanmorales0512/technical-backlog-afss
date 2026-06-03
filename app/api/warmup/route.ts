import { NextResponse } from "next/server";
import { warmAll } from "../../lib/simpro";
import { warmLeave } from "../leave/route";
import { warmTechSupport } from "../tech-support/route";
import { warmAfacProspect } from "../afac-prospect/route";

export const maxDuration = 300;

export async function GET() {
  const [results] = await Promise.all([
    warmAll(),
    warmLeave(),
    warmTechSupport(),
    warmAfacProspect(),
  ]);
  return NextResponse.json(
    { ok: true, results },
    { headers: { "Cache-Control": "no-store" } }
  );
}
