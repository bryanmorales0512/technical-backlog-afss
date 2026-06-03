import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";

const DATA_FILE = join(process.cwd(), "data", "afac-exclusions.json");

export async function GET() {
  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, "utf-8")) as string[];
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as string[];
    await fs.writeFile(DATA_FILE, JSON.stringify(body, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
