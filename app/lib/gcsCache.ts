import { Storage } from "@google-cloud/storage";

let _storage: Storage | null = null;

function getClient(): { storage: Storage; bucket: string } | null {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return null;
  if (!_storage) _storage = new Storage();
  return { storage: _storage, bucket };
}

export async function gcsRead(key: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const [contents] = await client.storage.bucket(client.bucket).file(key).download();
    return contents.toString("utf-8");
  } catch {
    return null;
  }
}

export async function gcsWrite(key: string, data: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.storage.bucket(client.bucket).file(key).save(data, {
      contentType: "application/json",
      resumable: false,
    });
  } catch {
    // Ignore write failures — local cache is still valid
  }
}
