/**
 * identity.ts — rotating user agents + polite request pacing.
 *
 * Rotating realistic browser UAs avoids naive bot-detection, and the
 * per-host throttle keeps us comfortably under API rate limits so she
 * never gets throttled in the first place.
 */

// Realistic browser user agents, rotated per request.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/126.0.0.0 Safari/537.36",
]

let uaIndex = Math.floor(Math.random() * USER_AGENTS.length)

/** Get the next user agent in rotation. */
export function nextUserAgent(): string {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length]
  uaIndex++
  return ua
}

// Per-host request pacing: minimum gap between API calls.
const lastCall = new Map<string, number>()
const MIN_GAP_MS = 1200

/** Wait until we're allowed to hit this host again (polite pacing). */
export async function paceHost(host: string): Promise<void> {
  const now = Date.now()
  const last = lastCall.get(host) || 0
  const wait = MIN_GAP_MS - (now - last)
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait))
  }
  lastCall.set(host, Date.now())
}

/** Standard browser-ish headers for API/file requests. */
export function browserHeaders(referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": nextUserAgent(),
    "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.1",
    "Accept-Language": "en-US,en;q=0.9",
  }
  if (referer) h["Referer"] = referer
  return h
}
