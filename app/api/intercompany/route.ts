import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";

const DATA_FILE = join(process.cwd(), "data", "intercompany.json");

type IcData = { hrs: string; rmHrs: string; aeHrs: string; fiaHrs: string };

async function read(): Promise<IcData> {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf-8")) as IcData;
  } catch {
    return { hrs: "", rmHrs: "", aeHrs: "", fiaHrs: "" };
  }
}

export async function GET() {
  return NextResponse.json(await read(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as IcData;
    await fs.writeFile(DATA_FILE, JSON.stringify(body, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
