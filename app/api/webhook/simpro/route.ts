import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { warmTechSupport, obItCacheFile, qaCacheFile } from "../../tech-support/core";
import { clearCache as clearAfssCache, WARM_COMBOS } from "../../../lib/simpro";

// SimPRO webhook endpoint — receives schedule change notifications, clears
// the tech-support AND AFSS Audits (RM AFSS/CHUBB/AE Evac) caches, then
// immediately kicks off a background rebuild so fresh data is ready before
// the next dashboard load.

// Current + next 2 months, matching the range warmTechSupport() builds.
function techSupportCacheFiles(): string[] {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = aest.getUTCFullYear();
  const m = aest.getUTCMonth() + 1;
  const files: string[] = [qaCacheFile()];
  for (let i = 0; i < 3; i++) {
    const d = new Date(y, m - 1 + i, 1);
    files.push(obItCacheFile(d.getFullYear(), d.getMonth() + 1, false));
    files.push(obItCacheFile(d.getFullYear(), d.getMonth() + 1, true));
  }
  return files;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const event = (body as Record<string, unknown>).event ?? "unknown";

    const isScheduleEvent =
      typeof event === "string" &&
      (event.includes("schedule") || event === "unknown");

    if (isScheduleEvent) {
      // Step 1: clear stale cache files — tech support (OB/IT/QA) and the
      // AFSS Audits per-company/stage job cache (RM AFSS/CHUBB/AE Evac),
      // including company 10 which isn't in WARM_COMBOS (warmup-gate only).
      await Promise.all([
        ...techSupportCacheFiles().map(f => fs.unlink(f).catch(() => {})),
        ...WARM_COMBOS.map(({ company, stage }) => clearAfssCache(company, stage)),
        clearAfssCache(10, "Pending"),
        clearAfssCache(10, "Progress"),
      ]);
      console.log(`[webhook] Schedule event "${event}" — caches cleared, rebuilding…`);

      // Step 2: rebuild tech support in the background so fresh data is ready
      // for the next dashboard load. AFSS Audits caches don't need an explicit
      // rebuild here — /api/data refetches automatically on the next request
      // since its cache file is now gone (cold-cache path in route.ts).
      warmTechSupport().catch(e => console.error("[webhook] rebuild failed:", e));
    }

    return NextResponse.json({ received: true, event }, { status: 200 });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

// SimPRO sends a GET request to verify the endpoint is reachable
export async function GET() {
  return NextResponse.json({ status: "ok", endpoint: "simpro-webhook" }, { status: 200 });
}
