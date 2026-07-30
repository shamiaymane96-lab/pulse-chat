import { supabase } from './supabase'

/**
 * Signed URLs were previously minted one-at-a-time, on every poll, for every
 * attachment on screen — a round trip per file every few seconds. They are
 * valid for an hour, so cache them and batch the misses.
 */

const TTL_SECONDS = 3600
/** Re-mint this far ahead of expiry so a URL never dies mid-render. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

const cache = new Map<string, { url: string; expiresAt: number }>()

export async function signedUrlsFor(paths: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  const now = Date.now()
  const missing: string[] = []

  for (const path of paths) {
    if (!path) continue
    const hit = cache.get(path)
    if (hit && hit.expiresAt - now > REFRESH_MARGIN_MS) {
      resolved.set(path, hit.url)
    } else if (!missing.includes(path)) {
      missing.push(path)
    }
  }

  if (missing.length > 0) {
    const { data, error } = await supabase.storage
      .from('chat-files')
      .createSignedUrls(missing, TTL_SECONDS)

    if (!error && data) {
      for (const row of data) {
        if (!row.signedUrl || !row.path) continue
        cache.set(row.path, { url: row.signedUrl, expiresAt: now + TTL_SECONDS * 1000 })
        resolved.set(row.path, row.signedUrl)
      }
    }
  }

  return resolved
}

export function forgetSignedUrls(paths?: string[]) {
  if (!paths) {
    cache.clear()
    return
  }
  for (const path of paths) cache.delete(path)
}
