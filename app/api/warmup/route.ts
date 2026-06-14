import { NextResponse } from "next/server";
import { warmAll } from "../../lib/simpro";
import { warmLeave } from "../leave/core";
import { warmTechSupport } from "../tech-support/core";
import { warmAfacProspect } from "../afac-prospect/core";

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
