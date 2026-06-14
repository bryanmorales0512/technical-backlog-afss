import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { warmTechSupport } from "../../tech-support/core";

// SimPRO webhook endpoint — receives schedule change notifications,
// clears the tech-support cache, then immediately kicks off a background
// rebuild so fresh data is ready before the next dashboard load.

function techSupportCacheFiles(): string[] {
  const dir = process.env.CACHE_DIR ?? os.tmpdir();
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = aest.getUTCFullYear();
  const m = String(aest.getUTCMonth() + 1).padStart(2, "0");
  return [
    join(dir, `afss-tech-support-v78-${y}-${m}.json`),
    join(dir, `afss-tech-support-fallback-v78-${y}-${m}.json`),
    join(dir, `afss-tech-support-v78-nodc-${y}-${m}.json`),
    join(dir, `afss-tech-support-fallback-v78-nodc-${y}-${m}.json`),
  ];
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const event = (body as Record<string, unknown>).event ?? "unknown";

    const isScheduleEvent =
      typeof event === "string" &&
      (event.includes("schedule") || event === "unknown");

    if (isScheduleEvent) {
      // Step 1: clear stale cache files
      await Promise.all(
        techSupportCacheFiles().map(f => fs.unlink(f).catch(() => {}))
      );
      console.log(`[webhook] Schedule event "${event}" — cache cleared, rebuilding…`);

      // Step 2: rebuild in the background so fresh data is ready for next dashboard load.
      // warmTechSupport writes the new cache; ~55s on SimPRO API.
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
