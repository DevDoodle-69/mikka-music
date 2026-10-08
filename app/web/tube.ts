import { spawn } from "child_process"
import fs from "fs"
import config from "../setup"
import { YouTubeSearchResult } from "../types"
import { extractYouTubeVideoId, formatDuration } from "../tools/timefmt"

const V3 = "https://www.googleapis.com/youtube/v3"

function needKey(): string {
  if (!config.youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not set")
  return config.youtubeApiKey
}

async function v3get(path: string, params: Record<string, string>): Promise<any> {
  const key = needKey()
  const qs = new URLSearchParams({ ...params, key }).toString()
  const res = await fetch(`${V3}${path}?${qs}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`YouTube API HTTP ${res.status}: ${body.slice(0, 120)}`)
  }
  return res.json()
}

/** PT4M13S -> seconds */
function isoToSeconds(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return parseInt(m[1] || "0") * 3600 + parseInt(m[2] || "0") * 60 + parseInt(m[3] || "0")
}

function toTrack(id: string, title: string, durationSec: number): YouTubeSearchResult {
  return {
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    duration: durationSec,
    durationFormatted: formatDuration(durationSec)
  }
}

/**
 * YouTube Data API v3 search: text query -> top video.
 * Note: search costs 100 quota units (10k free/day = ~100 searches/day).
 */
async function v3Search(query: string): Promise<YouTubeSearchResult> {
  const data = await v3get("/search", { part: "snippet", type: "video", maxResults: "1", q: query })
  const item = data?.items?.[0]
  const id = item?.id?.videoId
  if (!id) throw new Error("No YouTube results found")

  let seconds = 0
  try {
    const det = await v3get("/videos", { part: "contentDetails", id })
    seconds = isoToSeconds(det?.items?.[0]?.contentDetails?.duration || "")
  } catch {
    // duration is nice-to-have; the mp3 API reports it at play time
  }

  return toTrack(id, item.snippet?.title || "YouTube video", seconds)
}

function extractPlaylistId(url: string): string | null {
  const m = url.match(/[?&]list=([^&#]+)/)
  return m ? m[1] : null
}

/**
 * YouTube Data API v3 playlist: playlist URL or ID -> all videos,
 * following pages (up to 500). Titles included; durations come from
 * the mp3 API at play time.
 */
async function v3Playlist(urlOrId: string): Promise<YouTubeSearchResult[]> {
  const playlistId = urlOrId.includes("list=") ? extractPlaylistId(urlOrId) : urlOrId
  if (!playlistId) throw new Error("Could not find a playlist ID in that URL")

  const tracks: YouTubeSearchResult[] = []
  let pageToken = ""
  for (let page = 0; page < 10; page++) {
    const data = await v3get("/playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {})
    })
    for (const item of data?.items || []) {
      const vid = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId
      if (vid && item?.snippet?.title !== "Deleted video" && item?.snippet?.title !== "Private video") {
        tracks.push(toTrack(vid, item?.snippet?.title || "YouTube video", 0))
      }
    }
    pageToken = data?.nextPageToken || ""
    if (!pageToken) break
  }

  if (!tracks.length) throw new Error("Playlist is empty or private")
  return tracks
}

/** yt-dlp fallback search (needs cookies on datacenter IPs). */
async function ytdlpSearchOnce(query: string, androidClient: boolean): Promise<YouTubeSearchResult> {
  const searchQuery = query.startsWith("https://") ? query : `ytsearch:${query}`

  console.log("[tube] searching with yt-dlp:", searchQuery, androidClient ? "(android client)" : "")

  return new Promise((resolve, reject) => {
    const ytdlpArgs: string[] = ["--dump-json", "--no-playlist", "--js-runtimes", "node"]

    // Android player client sails past YouTube's datacenter bot-checks
    // when the default web client gets challenged.
    if (androidClient) {
      ytdlpArgs.push("--extractor-args", "youtube:player_client=android")
    }

    if (fs.existsSync(config.cookiesFile)) {
      ytdlpArgs.push("--cookies", config.cookiesFile)
    }

    ytdlpArgs.push(searchQuery)

    const ytdlp = spawn(config.ytdlpExecutable, ytdlpArgs)

    let output = ""
    let errorOutput = ""

    ytdlp.stdout.on("data", (data: Buffer) => { output += data.toString() })
    ytdlp.stderr.on("data", (data: Buffer) => { errorOutput += data.toString() })

    ytdlp.on("close", (code: number | null) => {
      if (code !== 0 || !output) {
        console.error("yt-dlp error:", errorOutput)
        reject(new Error(`Video not found or invalid. yt-dlp exit code: ${code}`))
        return
      }

      try {
        const video: { title: string; webpage_url?: string; url?: string; duration: number; duration_string?: string } = JSON.parse(output)
        if (!video || !video.title) {
          reject(new Error("Video not found or invalid"))
          return
        }

        resolve({
          title: video.title,
          url: video.webpage_url || video.url || "",
          duration: video.duration,
          durationFormatted: video.duration_string || `${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')}`
        })
      } catch {
        reject(new Error("Failed to parse video information"))
      }
    })

    ytdlp.on("error", (err: Error) => {
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`))
    })
  })
}

/**
 * yt-dlp search with a retry: if the default web client hits YouTube's
 * bot-check (common on datacenter IPs), try again as the Android client.
 */
async function ytdlpSearch(query: string): Promise<YouTubeSearchResult> {
  try {
    return await ytdlpSearchOnce(query, false)
  } catch (err) {
    console.log("[tube] yt-dlp default search failed, retrying with android client:", (err as Error).message)
    return ytdlpSearchOnce(query, true)
  }
}

/**
 * Smart search: YouTube Data v3 first (clean, no bot walls),
 * yt-dlp as backup.
 */
async function findTrack(query: string): Promise<YouTubeSearchResult> {
  if (config.youtubeApiKey) {
    try {
      console.log("[tube] v3 search:", query)
      return await v3Search(query)
    } catch (err) {
      console.log("[tube] v3 search failed, trying yt-dlp:", (err as Error).message)
    }
  } else {
    console.log("[tube] no YOUTUBE_API_KEY, using yt-dlp search")
  }
  return ytdlpSearch(query)
}

/**
 * Resolve a direct YouTube video URL to a playable song WITHOUT yt-dlp.
 * oEmbed needs no auth, so datacenter bot walls don't apply. The MP3
 * downloader API supplies the real title/duration at play time anyway.
 */
async function linkTrack(url: string): Promise<YouTubeSearchResult> {
  const videoId = extractYouTubeVideoId(url)
  if (!videoId) {
    // Not a YouTube URL — fall back to yt-dlp for other sites.
    return ytdlpSearch(url)
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  let title = "YouTube video"

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (res.ok) {
      const data = (await res.json()) as { title?: string }
      if (data && data.title) title = data.title
    }
  } catch {
    // oEmbed failed — keep fallback title, MP3 API will correct it later
  }

  return { title, url: watchUrl, duration: 0, durationFormatted: undefined }
}

export { findTrack, linkTrack, v3Search, v3Playlist, extractPlaylistId }
