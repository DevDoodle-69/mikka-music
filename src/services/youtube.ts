import { spawn } from "child_process"
import fs from "fs"
import config from "../config"
import { YouTubeSearchResult } from "../types"
import { extractYouTubeVideoId } from "../utils/format"

async function searchSong(query: string): Promise<YouTubeSearchResult> {
  const searchQuery = query.startsWith("https://") ? query : `ytsearch:${query}`

  console.log("Searching with yt-dlp:", searchQuery)

  return new Promise((resolve, reject) => {
    const ytdlpArgs: string[] = ["--dump-json", "--no-playlist", "--js-runtimes", "node"]

    if (fs.existsSync(config.cookiesFile)) {
      console.log("Cookie masuk")
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

export { searchSong, resolveUrlSong }

/**
 * Resolve a direct YouTube video URL to a playable song WITHOUT yt-dlp.
 * YouTube's bot wall ("Sign in to confirm you're not a bot") kills yt-dlp
 * on datacenter IPs, but oEmbed needs no auth. The MP3 downloader API
 * supplies the real title/duration later at play time anyway.
 */
async function resolveUrlSong(url: string): Promise<YouTubeSearchResult> {
  const videoId = extractYouTubeVideoId(url)
  if (!videoId) {
    // Not a YouTube URL — fall back to yt-dlp for other sites.
    return searchSong(url)
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  let title = "YouTube video"

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`
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
