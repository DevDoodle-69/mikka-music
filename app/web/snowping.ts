/**
 * snowping.ts — direct MP3 streaming via the snowping downloader API.
 *
 *   GET https://api.snowping.cfd/api/downloader/youtube?url={encoded}&format=mp3
 *
 * No API key needed. Returns a direct MP3 stream URL that ffmpeg can play
 * straight into voice — no temp file download required.
 */
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
  console.log(`[snowping] resolving stream for ${youtubeUrl}`)

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

  console.log(`[snowping] got stream (${dl.size || "?"}) for "${(video?.title || "").slice(0, 60)}"`)
  return {
    title: video?.title || "Unknown title",
    duration: video?.duration || "",
    thumbnail: video?.thumbnail || "",
    videoUrl: video?.url || youtubeUrl,
    streamUrl: dl.url,
    size: dl.size || "",
  }
}
