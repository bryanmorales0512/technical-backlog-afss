import { NextResponse } from "next/server";
import {
  fetchAndCacheDeduped,
  readCacheRaw,
  CACHE_TTL,
} from "../../lib/simpro";

export const maxDuration = 300;

// Serves the same data as /api/data?company=1&stage=Progress, kept as a
// separate path for the backlog page. Previously this route ran its own
// full per-job enrichment pipeline with a 60 s TTL, which hammered SimPRO's
// rate limit and starved the dashboard syncs.
const COMPANY = 1;
const STAGE   = "Progress";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";

    const entry = await readCacheRaw(COMPANY, STAGE);
    if (entry && entry.data.length > 0 && !entry.partial) {
      const fresh = Date.now() - entry.ts < CACHE_TTL;

      if (!force && fresh) {
        return NextResponse.json(entry.data);
      }

      if (force) {
        try {
          const data = await fetchAndCacheDeduped(COMPANY, STAGE);
          return NextResponse.json(data);
        } catch {
          return NextResponse.json(entry.data);
        }
      }

      fetchAndCacheDeduped(COMPANY, STAGE).catch(() => {});
      return NextResponse.json(entry.data);
    }

    const data = await fetchAndCacheDeduped(COMPANY, STAGE);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
