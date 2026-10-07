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

  while (Date.now() < deadline) {
    let json: any
    try {
      const res = await fetch(apiUrl)
      if (!res.ok) {
        lastNote = `HTTP ${res.status}`
        await sleep(2500)
        continue
      }
      json = await res.json()
    } catch (err) {
      lastNote = (err as Error).message || "request failed"
      await sleep(2500)
      continue
    }

    const data = json?.data
    const result = data?.result
    if (json?.status === true && data?.status === "Success" && result?.status === "ok" && result?.link) {
      return {
        title: result.title || "Unknown title",
        duration: typeof result.duration === "number" ? result.duration : 0,
        link: result.link as string
      }
    }

    if (json?.status === false || data?.status === "Failed" || result?.status === "error") {
      throw new Error(`Downloader API failed: ${result?.msg || json?.message || "unknown error"}`)
    }

    lastNote = result?.msg || `progress ${result?.progress ?? 0}%`
    await sleep(2500)
  }

  throw new Error(`MP3 conversion timed out (${lastNote})`)
}

/**
 * Download the mp3 link to a temp file. Returns the temp file path.
 * The caller is responsible for deleting it via cleanupTempFile().
 */
async function downloadMp3(link: string): Promise<string> {
  const tmpPath = path.join(
    os.tmpdir(),
    `mikka-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  )

  const res = await fetch(link)
  if (!res.ok || !res.body) {
    throw new Error(`MP3 download failed (HTTP ${res.status})`)
  }

  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpPath))
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
