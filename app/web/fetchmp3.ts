import fs from "fs"
import os from "os"
import path from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import config from "../setup"
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
 * link. The API is task-based: the first call returns { taskId, pollUrl }
 * with status "Pending" (sometimes the result is inline instead), then we
 * poll the pollUrl until the result is ready.
 */
async function fetchMp3(youtubeUrl: string): Promise<Mp3ResolveResult> {
  if (!config.mp3ApiKey) {
    throw new Error(
      "MP3_API_KEY is not set. Put your downloader API key in the MP3_API_KEY environment variable (or config.json \"mp3ApiKey\")."
    )
  }

  const apiUrl =
    `${config.mp3ApiBase}?apikey=${encodeURIComponent(config.mp3ApiKey)}` +
    `&url=${encodeURIComponent(youtubeUrl)}&type=mp3`

  console.log("[mp3] requesting conversion...")
  const first = await fetchJson(apiUrl, "initial request")
  const inline = extractResult(first)
  if (inline) return inline

  // Task-based flow: poll the provided pollUrl (fall back to the
  // initial URL, which may flip to Success once the task completes).
  const pollUrl: string = first?.data?.pollUrl || apiUrl
  console.log(`[mp3] task ${first?.data?.taskId || ""} pending, polling ${pollUrl.slice(0, 60)}...`)

  const deadline = Date.now() + 180_000
  let lastNote = first?.data?.status || "pending"
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++
    let json: any
    try {
      json = await fetchJson(pollUrl, `poll #${attempt}`)
    } catch (err) {
      lastNote = (err as Error).message
      console.log(`[mp3] poll #${attempt}: ${lastNote}`)
      await sleep(2500)
      continue
    }

    const res = extractResult(json)
    if (res) return res

    const data = json?.data
    if (json?.status === false || data?.status === "Failed" || data?.result?.status === "error") {
      throw new Error(`Downloader API failed: ${data?.result?.msg || json?.message || "unknown error"}`)
    }

    lastNote = data?.result?.msg || data?.status || `progress ${data?.result?.progress ?? 0}%`
    console.log(`[mp3] poll #${attempt}: ${lastNote}`)
    await sleep(2500)
  }

  throw new Error(`MP3 conversion timed out (${lastNote})`)
}

/** Pull the finished result out of an API response, or null if not ready. */
function extractResult(json: any): Mp3ResolveResult | null {
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
  return null
}

async function fetchJson(url: string, label: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  return res.json()
}

/**
 * Download the mp3 to a temp file. Tries the direct link first,
 * then the API's proxy URL as a fallback. Returns the temp file path.
 * The caller is responsible for deleting it via dropTemp().
 */
async function grabMp3(link: string, proxyUrl?: string): Promise<string> {
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
function dropTemp(queue: Queue | undefined | null): void {
  if (!queue?.currentTempFile) return
  const p = queue.currentTempFile
  queue.currentTempFile = null
  fs.unlink(p, () => {})
}

export { fetchMp3, grabMp3, dropTemp, Mp3ResolveResult }
