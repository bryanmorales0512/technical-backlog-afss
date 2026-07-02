import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { gcsRead, gcsWrite } from "../../lib/gcsCache";
import { clearCache as clearAfacProspectCache } from "../afac-prospect/core";

const DATA_FILE = join(process.cwd(), "data", "afac-exclusions.json");
const GCS_KEY   = "data-afac-exclusions.json";

async function read(): Promise<string[]> {
  // Try local file first (fast path)
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf-8")) as string[];
  } catch {}
  // Fall back to GCS (new container after deployment)
  try {
    const remote = await gcsRead(GCS_KEY);
    if (remote) {
      const data = JSON.parse(remote) as string[];
      fs.writeFile(DATA_FILE, remote, "utf-8").catch(() => {});
      return data;
    }
  } catch {}
  return [];
}

export async function GET() {
  return NextResponse.json(await read(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as string[];
    const json = JSON.stringify(body, null, 2);
    await fs.writeFile(DATA_FILE, json, "utf-8");
    gcsWrite(GCS_KEY, json);
    await clearAfacProspectCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
