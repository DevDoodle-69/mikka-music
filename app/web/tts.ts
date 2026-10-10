/**
 * tts.ts — text-to-speech via the user's Sarvam TTS worker.
 *
 *   POST https://odd-fog-3663.mikemathews7000.workers.dev/v1/audio/speech
 *   (OpenAI-compatible, bulbul:v3, no API key)
 *
 * Voice: TTS_VOICE env, default "shruti" (Sweet & Melodious female).
 * Returns the path to a temp mp3, or null on failure.
 */
import { logline, logerr } from "../tools/log"
import { proxiedFetch } from "./proxy"
import { writeFile, mkdir, unlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const TTS_API = process.env.TTS_API_BASE || "https://odd-fog-3663.mikemathews7000.workers.dev/v1/audio/speech"
export const TTS_VOICE = process.env.TTS_VOICE || "shruti"
// Escape hatch: if Sarvam's edge keeps challenging the worker's session
// bootstrap, paste the sarvam_pg_pass cookie value (from browser devtools)
// as TTS_COOKIE and it's sent as X-Sarvam-Cookie.
const TTS_COOKIE = process.env.TTS_COOKIE || ""

/** Strip markdown/emoji — TTS should speak plain words only. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_`~#>|]/g, "")
    .replace(/https?:\S+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900)
}

export async function synthesizeSpeech(text: string): Promise<string | null> {
  const clean = cleanForSpeech(text)
  if (!clean) return null
  try {
    const dir = join(tmpdir(), "mikka-tts")
    await mkdir(dir, { recursive: true })
    const outPath = join(dir, `tts-${Date.now()}.mp3`)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    let res: any
    try {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (TTS_COOKIE) headers["x-sarvam-cookie"] = `sarvam_pg_pass=${TTS_COOKIE}`
      res = await proxiedFetch(TTS_API, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: clean,
          voice: TTS_VOICE,
          response_format: "mp3",
          pace: 1.0,
          temperature: 0.7,
        }),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      logerr("tts", `HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) {
      logerr("tts", "suspiciously small audio response")
      return null
    }
    await writeFile(outPath, buf)
    logline("tts", `synthesized ${buf.length} bytes (voice=${TTS_VOICE})`)
    // Best-effort cleanup of older temp files.
    return outPath
  } catch (err: any) {
    logerr("tts", "synthesize failed:", (err.message || err).slice(0, 80))
    return null
  }
}

export async function dropTtsFile(path: string | null): Promise<void> {
  if (!path) return
  try {
    await unlink(path)
  } catch {}
}
