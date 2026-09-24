import { supabase, BUCKET } from "./supabase";

// Private bucket → images are served through expiring signed URLs.
// Cache them so re-renders don't re-sign.
const TTL_SECONDS = 60 * 60 * 12;
const cache = new Map<string, { url: string; expires: number }>();

export async function signMany(paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const p of new Set(paths)) {
    const hit = cache.get(p);
    if (hit && hit.expires > now + 60_000) out[p] = hit.url;
    else missing.push(p);
  }

  if (missing.length) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(missing, TTL_SECONDS);
    if (error) throw error;
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        cache.set(item.path, { url: item.signedUrl, expires: now + TTL_SECONDS * 1000 });
        out[item.path] = item.signedUrl;
      }
    }
  }
  return out;
}

export async function signOne(path: string) {
  return (await signMany([path]))[path];
}
