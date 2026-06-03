// GCS caching stub — disabled. Re-enable when debugging is complete.
export async function gcsRead(_key: string): Promise<string | null> { return null; }
export async function gcsWrite(_key: string, _data: string): Promise<void> { }
