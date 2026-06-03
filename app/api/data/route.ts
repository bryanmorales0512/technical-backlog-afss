import { NextResponse } from "next/server";
import {
  fetchAndCacheDeduped,
  readCacheRaw,
  CACHE_TTL,
} from "../../lib/simpro";

export async function GET(req: Request) {
  try {
    const url     = new URL(req.url);
    const company = Number(url.searchParams.get("company") ?? "1");
    const stage   = url.searchParams.get("stage") ?? "Pending";
    const force   = url.searchParams.get("force") === "1";

    const entry = await readCacheRaw(company, stage);
    if (entry && entry.data.length > 0 && !entry.partial) {
      const fresh = Date.now() - entry.ts < CACHE_TTL;

      if (!force && fresh) {
        return NextResponse.json(entry.data);
      }

      if (force) {
        try {
          const data = await fetchAndCacheDeduped(company, stage);
          return NextResponse.json(data);
        } catch {
          return NextResponse.json(entry.data);
        }
      }

      fetchAndCacheDeduped(company, stage).catch(() => {});
      return NextResponse.json(entry.data);
    }

    // Cold cache — fetch directly, no gate blocking.
    const data = await fetchAndCacheDeduped(company, stage);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
