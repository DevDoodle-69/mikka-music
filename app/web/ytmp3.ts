/**
 * ytmp3.ts — YouTube → MP3 via the ytmp3.mobi converter backend (a.ymcdn.org).
 *
 * Flow: init → convert (yields progress + download URLs) → poll progress
 * until done → download the MP3. All requests go through proxiedFetch so
 * PROXY_LIST applies like everywhere else.
 *
 * NOTE: tested 2026-10-10 — the backend returned error 16 on convert for
 * every video from a datacenter IP. It's wired as a fallback (after
 * snowping, before invidious): if it ever works from the host's network
 * it helps; if not, the proven chain takes over and nothing breaks.
 */
import { logline, logerr } from "../tools/log"
import { proxiedFetch } from "./proxy"

export function extractVideoId(url: string): string | null {
  if (!url) return null
  let match: RegExpExecArray | null = null
  if (url.includes("youtube.com/shorts/") || url.includes("youtu.be/")) {
    match = /\/([a-zA-Z0-9\-_]{11})/.exec(url)
  } else if (url.includes("youtube.com")) {
    match = /v=([a-zA-Z0-9\-_]{11})/.exec(url)
  } else {
    // General fallback: any 11-char video-ID-like token.
    match = /[a-zA-Z0-9\-_]{11}/.exec(url)
  }
  return match ? match[1] : null
}

export interface Ytmp3Result {
  videoId: string
  title: string
  /** Direct MP3 download URL (use promptly — expires). */
  downloadUrl: string
}

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://id.ytmp3.mobi",
  Referer: "https://id.ytmp3.mobi/",
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res: any = await proxiedFetch(url, { signal: ctrl.signal, headers: YT_HEADERS })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Convert a YouTube video to MP3 via ytmp3. Resolves with a direct
 * download URL. Throws on any API error or timeout.
 */
export async function scrapeYtmp3(youtubeUrl: string): Promise<Ytmp3Result> {
  const videoId = extractVideoId(youtubeUrl)
  if (!videoId) throw new Error("ytmp3: could not extract video ID")

  logline("mp3", "trying ytmp3 converter")

  // 1. Init session on the backend.
  const initJson = await fetchJson(
    `https://a.ymcdn.org/api/v1/init?p=y&23=1llum1n471&_=${Math.random()}`,
    15000
  )
  if (initJson.error > 0) throw new Error(`ytmp3 init error ${initJson.error}`)
  if (!initJson.convertURL) throw new Error("ytmp3: no convert URL from init")

  // 2. Request conversion (follow backend redirects).
  let convertUrl = `${initJson.convertURL}&v=${videoId}&f=mp3&_=${Math.random()}`
  let convertJson: any = null
  for (let i = 0; i < 5; i++) {
    convertJson = await fetchJson(convertUrl, 15000)
    if (convertJson.error > 0) throw new Error(`ytmp3 convert error ${convertJson.error}`)
    if (convertJson.redirect > 0 && convertJson.redirectURL) {
      convertUrl = `${convertJson.redirectURL}&v=${videoId}&f=mp3&_=${Math.random()}`
      continue
    }
    break
  }
  if (!convertJson?.progressURL) throw new Error("ytmp3: no progress URL in convert response")

  // 3. Poll until conversion completes (progress >= 3).
  let progress = 0
  let title: string = convertJson.title || ""
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    let pj: any
    try {
      pj = await fetchJson(convertJson.progressURL, 10000)
    } catch (err: any) {
      logerr("mp3", "ytmp3 progress poll failed:", (err.message || err).slice(0, 60))
      continue
    }
    if (pj.error > 0) throw new Error(`ytmp3 progress error ${pj.error}`)
    progress = pj.progress
    if (pj.title) title = pj.title
    if (progress >= 3) break
  }
  if (progress < 3) throw new Error("ytmp3: conversion timed out")
  if (!convertJson.downloadURL) throw new Error("ytmp3: no download URL after conversion")

  logline("mp3", `ytmp3 converted :: "${title.slice(0, 50)}"`)
  return { videoId, title, downloadUrl: convertJson.downloadURL }
}
