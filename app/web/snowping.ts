/**
 * snowping.ts — direct MP3 streaming via the snowping downloader API.
 *
 *   GET https://api.snowping.cfd/api/downloader/youtube?url={encoded}&format=mp3
 *
 * No API key needed. Returns a direct MP3 stream URL that ffmpeg can play
 * straight into voice — no temp file download required.
 */
import { logline, logerr } from "../tools/log"

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
  const apiUrl = `${API_BASE}?url=${encodeURIComponent(youtubeUrl)}&format=mp3`
  logline("mp3", "resolving direct stream")

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: any
  try {
    res = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "mikka-music/1.0" },
    })
  } catch (err: any) {
    clearTimeout(timer)
    throw new Error(`snowping API unreachable: ${err.message?.slice(0, 100) || err}`)
  }
  clearTimeout(timer)

  if (!res.ok) throw new Error(`snowping API HTTP ${res.status}`)

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

  logline("mp3", `got stream (${dl.size || "?"}) :: "${(video?.title || "").slice(0, 50)}"`)
  return {
    title: video?.title || "Unknown title",
    duration: video?.duration || "",
    thumbnail: video?.thumbnail || "",
    videoUrl: video?.url || youtubeUrl,
    streamUrl: dl.url,
    size: dl.size || "",
  }
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

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: any
  try {
    res = await fetch(streamUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "mikka-music/1.0" },
    })
  } catch (err: any) {
    clearTimeout(timer)
    throw new Error(`mp3 download unreachable: ${err.message?.slice(0, 100) || err}`)
  }
  if (!res.ok) {
    clearTimeout(timer)
    throw new Error(`mp3 download HTTP ${res.status}`)
  }
  try {
    const out = fs.createWriteStream(tmp)
    await pipeline(res.body as any, out)
  } catch (err: any) {
    clearTimeout(timer)
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error(`mp3 download failed mid-stream: ${err.message?.slice(0, 100) || err}`)
  }
  clearTimeout(timer)

  let size = 0
  try { size = fs.statSync(tmp).size } catch {}
  if (size < 1024) {
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error("mp3 download came back empty")
  }
  logline("mp3", `downloaded ${(size / 1024).toFixed(0)}KB`)
  return tmp
}
