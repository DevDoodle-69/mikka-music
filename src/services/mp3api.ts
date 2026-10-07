import fs from "fs"
import os from "os"
import path from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import config from "../config"
import { Queue } from "../types"

interface Mp3ResolveResult {
  title: string
  duration: number // seconds
  link: string
  proxyUrl?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ask the MP3 downloader API to convert a YouTube URL into a direct mp3
 * link. Polls until the conversion is done (or times out).
 */
async function resolveMp3(youtubeUrl: string): Promise<Mp3ResolveResult> {
  if (!config.mp3ApiKey) {
    throw new Error(
      "MP3_API_KEY is not set. Put your downloader API key in the MP3_API_KEY environment variable (or config.json \"mp3ApiKey\")."
    )
  }

  const apiUrl =
    `${config.mp3ApiBase}?apikey=${encodeURIComponent(config.mp3ApiKey)}` +
    `&url=${encodeURIComponent(youtubeUrl)}&type=mp3`

  const deadline = Date.now() + 120_000
  let lastNote = "waiting"
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++
    let json: any
    try {
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) {
        lastNote = `HTTP ${res.status}`
        console.log(`[mp3] poll #${attempt}: ${lastNote}`)
        await sleep(2500)
        continue
      }
      json = await res.json()
    } catch (err) {
      lastNote = (err as Error).message || "request failed"
      console.log(`[mp3] poll #${attempt}: ${lastNote}`)
      await sleep(2500)
      continue
    }

    const data = json?.data
    const result = data?.result
    if (json?.status === true && data?.status === "Success" && result?.status === "ok" && result?.link) {
      console.log(`[mp3] ready: "${result.title}" (${result.duration}s), downloading...`)
      return {
        title: result.title || "Unknown title",
        duration: typeof result.duration === "number" ? result.duration : 0,
        link: result.link as string,
        proxyUrl: result.proxyUrl as string | undefined
      }
    }

    if (json?.status === false || data?.status === "Failed" || result?.status === "error") {
      throw new Error(`Downloader API failed: ${result?.msg || json?.message || "unknown error"}`)
    }

    lastNote = result?.msg || data?.status || `progress ${result?.progress ?? 0}%`
    console.log(`[mp3] poll #${attempt}: ${lastNote}`)
    await sleep(2500)
  }

  throw new Error(`MP3 conversion timed out (${lastNote})`)
}

/**
 * Download the mp3 to a temp file. Tries the direct link first,
 * then the API's proxy URL as a fallback. Returns the temp file path.
 * The caller is responsible for deleting it via cleanupTempFile().
 */
async function downloadMp3(link: string, proxyUrl?: string): Promise<string> {
  const urls = [link, ...(proxyUrl ? [proxyUrl] : [])]
  let lastError = "no URL"

  for (const url of urls) {
    try {
      return await downloadOne(url)
    } catch (err) {
      lastError = (err as Error).message
      console.error(`[music] mp3 download failed (${lastError})`)
    }
  }

  throw new Error(`MP3 download failed (${lastError})`)
}

async function downloadOne(url: string): Promise<string> {
  const tmpPath = path.join(
    os.tmpdir(),
    `mikka-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  )

  console.log(`[mp3] downloading from ${url.slice(0, 70)}...`)
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`)
  }

  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpPath))

  const size = fs.statSync(tmpPath).size
  console.log(`[mp3] downloaded ${(size / 1024 / 1024).toFixed(2)} MB -> ${tmpPath}`)
  if (size < 1024) {
    fs.unlinkSync(tmpPath)
    throw new Error(`file too small (${size} bytes), probably an error page`)
  }

  return tmpPath
}

/** Delete the queue's current temp mp3 file, if any. Safe to call anytime. */
function cleanupTempFile(queue: Queue | undefined | null): void {
  if (!queue?.currentTempFile) return
  const p = queue.currentTempFile
  queue.currentTempFile = null
  fs.unlink(p, () => {})
}

export { resolveMp3, downloadMp3, cleanupTempFile, Mp3ResolveResult }
