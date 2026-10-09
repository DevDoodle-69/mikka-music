/**
 * snowping.ts — direct MP3 streaming via the snowping downloader API.
 *
 *   GET https://api.snowping.cfd/api/downloader/youtube?url={encoded}&format=mp3
 *
 * No API key needed. Returns a direct MP3 stream URL that ffmpeg can play
 * straight into voice — no temp file download required.
 */
import { logline, logerr } from "../tools/log"

/** In-memory cache for API resolves: url -> { data, expires }. */
const resolveCache = new Map<string, { data: SnowpingTrack; expires: number }>()
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

function cacheGet(url: string): SnowpingTrack | null {
  const hit = resolveCache.get(url)
  if (hit && hit.expires > Date.now()) {
    logline("mp3", "resolve cache hit")
    return hit.data
  }
  if (hit) resolveCache.delete(url)
  return null
}
function cacheSet(url: string, data: SnowpingTrack): void {
  if (resolveCache.size > 200) {
    // Evict oldest
    const first = resolveCache.keys().next().value
    if (first) resolveCache.delete(first)
  }
  resolveCache.set(url, { data, expires: Date.now() + CACHE_TTL_MS })
}

const API_BASE = process.env.SNOWPING_API_BASE || "https://api.snowping.cfd/api/downloader/youtube"

export interface SnowpingTrack {
  title: string
  duration: string
  thumbnail: string
  videoUrl: string
  /** Direct MP3 stream URL — feed straight to ffmpeg, no download needed. */
  streamUrl: string
  size: string
}

/**
 * Resolve a YouTube URL to a direct MP3 stream URL.
 * Throws on API error or unexpected response shape.
 */
export async function resolveStream(youtubeUrl: string, timeoutMs = 45000): Promise<SnowpingTrack> {
  const cached = cacheGet(youtubeUrl)
  if (cached) return cached
  const apiUrl = `${API_BASE}?url=${encodeURIComponent(youtubeUrl)}&format=mp3`
  logline("mp3", "resolving direct stream")

  let res: any = null
  let lastErr: any = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      res = await fetch(apiUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": "mikka-music/1.0" },
      })
      clearTimeout(timer)
      if (res.ok) break
      lastErr = new Error(`snowping API HTTP ${res.status}`)
      logerr("mp3", `resolve attempt ${attempt}: HTTP ${res.status}`)
      res = null
      // Rate-limited: back off longer before retrying.
      if (res === null && attempt < 3) {
        // (res is null here; check status via lastErr message)
      }
    } catch (err: any) {
      clearTimeout(timer)
      lastErr = err
      logerr("mp3", `resolve attempt ${attempt}:`, (err.message || err).slice(0, 100))
      res = null
    }
    if (attempt < 3) {
      const isRateLimit = lastErr?.message?.includes("429")
      await new Promise((r) => setTimeout(r, isRateLimit ? 10000 * attempt : 2000 * attempt))
    }
  }
  if (!res) throw new Error(`snowping API failed after 3 tries: ${lastErr?.message?.slice(0, 120) || lastErr}`)

  let json: any
  try {
    json = await res.json()
  } catch {
    throw new Error("snowping API returned non-JSON")
  }

  const dl = json?.result?.download
  const video = json?.result?.video
  if (!dl?.url) {
    const msg = json?.message || json?.error || "no download URL in response"
    throw new Error(`snowping API: ${String(msg).slice(0, 120)}`)
  }

  logline("mp3", `got stream (${dl.size || "?"} ) :: "${(video?.title || "").slice(0, 50)}"`)
  const track: SnowpingTrack = {
    title: video?.title || "Unknown title",
    duration: video?.duration || "",
    thumbnail: video?.thumbnail || "",
    videoUrl: video?.url || youtubeUrl,
    streamUrl: dl.url,
    size: dl.size || "",
  }
  cacheSet(youtubeUrl, track)
  return track
}

/**
 * Download the MP3 stream URL to a temp file (the reliable classic way:
 * fully fetch first, then play the local file in voice).
 * Returns the temp file path. Caller owns cleanup via dropTemp().
 */
export async function downloadSnowpingMp3(streamUrl: string, timeoutMs = 120000): Promise<string> {
  const fs = await import("fs")
  const os = await import("os")
  const path = await import("path")
  const { pipeline } = await import("stream/promises")

  const tmp = path.join(os.tmpdir(), `mikka-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`)
  logline("mp3", "downloading mp3 file…")

  const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  // Retry loop: Render's network can hiccup; don't give up on one failure.
  let res: any = null
  let lastErr: any = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      logline("mp3", `download attempt ${attempt}/3`)
      res = await fetch(streamUrl, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.1",
          "Referer": "https://api.snowping.cfd/",
        },
      })
      clearTimeout(timer)
      if (res.ok) break
      lastErr = new Error(`mp3 download HTTP ${res.status}`)
      logerr("mp3", `attempt ${attempt}: HTTP ${res.status}`)
      res = null
    } catch (err: any) {
      clearTimeout(timer)
      lastErr = err
      logerr("mp3", `attempt ${attempt} failed:`, (err.message || err).slice(0, 120))
      res = null
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
  if (!res) {
    throw new Error(`mp3 download failed after 3 tries: ${lastErr?.message?.slice(0, 120) || lastErr}`)
  }
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("text/html")) {
    throw new Error("mp3 download returned an HTML page (blocked or expired link)")
  }
  try {
    const out = fs.createWriteStream(tmp)
    await pipeline(res.body as any, out)
  } catch (err: any) {
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error(`mp3 download failed mid-stream: ${err.message?.slice(0, 100) || err}`)
  }

  let size = 0
  try { size = fs.statSync(tmp).size } catch {}
  if (size < 1024) {
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error("mp3 download came back empty")
  }
  logline("mp3", `downloaded ${(size / 1024).toFixed(0)}KB`)
  return tmp
}
