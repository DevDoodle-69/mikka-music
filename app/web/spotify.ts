/**
 * spotify.ts — Spotify search + download via the snowping API (no key).
 *
 *   Search:   GET /api/search/spotify?query={q}&type=top_results
 *   Download: GET /api/downloader/spotify?url={spotify track url}
 *             -> result.download_url (direct audio file)
 */
import { logline, logerr } from "../tools/log"

const SEARCH_BASE = "https://api.snowping.cfd/api/search/spotify"
const DL_BASE = "https://api.snowping.cfd/api/downloader/spotify"

export interface SpotifyTrack {
  id: string
  name: string
  url: string
  /** Spotify CDN artwork (largest available). */
  image: string
  artist?: string
}

export interface SpotifyDownload {
  title: string
  artist: string
  cover: string
  downloadUrl: string
}

async function getJson(url: string, timeoutMs = 30000, retries = 3): Promise<any> {
  let lastErr: any = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "mikka-music/1.0" },
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      clearTimeout(timer)
      lastErr = err
      logerr("tube", `spotify API attempt ${attempt}:`, (err.message || err).slice(0, 100))
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr
}

/** Pick the largest image from a Spotify images array. */
function bestImage(images: any[]): string {
  if (!Array.isArray(images) || images.length === 0) return ""
  const sorted = [...images].sort((a, b) => (b.width || 0) - (a.width || 0))
  return sorted[0]?.url || ""
}

/**
 * Search Spotify for tracks. Returns track results only
 * (skips episodes/albums/playlists).
 */
export async function searchSpotify(query: string, limit = 5): Promise<SpotifyTrack[]> {
  const url = `${SEARCH_BASE}?query=${encodeURIComponent(query)}&type=top_results`
  logline("tube", `spotify search: "${query.slice(0, 50)}"`)
  const json = await getJson(url)
  const results: any[] = json?.result || []
  return results
    .filter((r) => r?.type === "Track" && r?.url)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      image: bestImage(r.images),
    }))
}

/**
 * Resolve a Spotify track URL to a direct audio download.
 * Throws on failure.
 */
export async function resolveSpotifyDownload(spotifyUrl: string): Promise<SpotifyDownload> {
  const url = `${DL_BASE}?url=${encodeURIComponent(spotifyUrl)}`
  logline("mp3", "resolving spotify download")
  const json = await getJson(url, 45000)
  const r = json?.result
  if (!r?.download_url) {
    throw new Error("spotify API: no download_url in response")
  }
  logline("mp3", `spotify resolved :: "${(r.title || "").slice(0, 50)}"`)
  return {
    title: r.title || "Unknown title",
    artist: r.artist || "",
    cover: r.cover || "",
    downloadUrl: r.download_url,
  }
}

/**
 * Best-effort: find the same song on Spotify given a YouTube title.
 * Used for auto-fallback and cross-platform playlists.
 */
export async function findOnSpotify(title: string): Promise<SpotifyTrack | null> {
  try {
    // Strip common YouTube cruft for a cleaner Spotify query.
    const clean = title
      .replace(/\(official[^)]*\)/gi, "")
      .replace(/\[official[^\]]*\]/gi, "")
      .replace(/official\s*(music\s*)?video/gi, "")
      .replace(/lyrics?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim()
    const tracks = await searchSpotify(clean || title, 3)
    return tracks[0] || null
  } catch (err) {
    logerr("tube", "spotify lookup failed:", (err as Error).message?.slice(0, 100))
    return null
  }
}

/**
 * Resolve a Spotify playlist/album URL via the public embed page
 * (no API credentials needed). Returns track entries.
 */
export async function resolveSpotifyPlaylist(spotifyUrl: string): Promise<SpotifyTrack[]> {
  const m = spotifyUrl.match(/open\.spotify\.com\/(playlist|album)\/([A-Za-z0-9]+)/)
  if (!m) throw new Error("not a spotify playlist/album link")
  const kind = m[1]
  const id = m[2]
  const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`
  logline("tube", `spotify ${kind} embed: ${id}`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  let html: string
  try {
    const res = await fetch(embedUrl, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`)
    html = await res.text()
  } catch (err: any) {
    clearTimeout(timer)
    throw err
  }

  // The embed page embeds a JSON trackList array.
  const idx = html.indexOf('"trackList":[')
  if (idx === -1) throw new Error("no trackList in spotify embed page")
  const start = idx + '"trackList":'.length
  let depth = 0, i = start
  while (i < html.length) {
    const c = html[i]
    if (c === "[") depth++
    else if (c === "]") { depth--; if (depth === 0) break }
    i++
  }
  const arrStr = html.slice(start, i + 1)
  let raw: any[]
  try {
    raw = JSON.parse(arrStr)
  } catch {
    throw new Error("could not parse spotify trackList")
  }

  const tracks: SpotifyTrack[] = []
  for (const t of raw) {
    const uri: string = t?.uri || ""
    const tid = uri.split(":").pop()
    if (!tid) continue
    const title: string = t?.title || "Unknown"
    const subtitle: string = t?.subtitle || ""
    tracks.push({
      id: tid,
      name: subtitle ? `${title} - ${subtitle}` : title,
      url: `https://open.spotify.com/track/${tid}`,
      image: "",
    })
  }
  logline("tube", `spotify ${kind}: ${tracks.length} tracks`)
  if (tracks.length === 0) throw new Error("spotify playlist was empty")
  return tracks
}
