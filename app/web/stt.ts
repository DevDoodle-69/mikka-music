/**
 * stt.ts — speech-to-text via Groq's free Whisper API.
 *
 *   POST https://api.groq.com/openai/v1/audio/transcriptions
 *   (OpenAI-compatible, model whisper-large-v3-turbo)
 *
 * Needs GROQ_API_KEY on Render (free at console.groq.com).
 * Returns the transcribed text, or null on any failure.
 */
import { logline, logerr } from "../tools/log"
import { readFile } from "fs/promises"

const GROQ_API = "https://api.groq.com/openai/v1/audio/transcriptions"

export function isSttConfigured(): boolean {
  return !!process.env.GROQ_API_KEY
}

export async function transcribeAudio(wavPath: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    logerr("stt", "GROQ_API_KEY not set")
    return null
  }
  try {
    const buf = await readFile(wavPath)
    const form = new FormData()
    form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav")
    form.append("model", "whisper-large-v3-turbo")
    form.append("response_format", "json")
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    let res: Response
    try {
      res = await fetch(GROQ_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      logerr("stt", `Groq HTTP ${res.status}`)
      return null
    }
    const data: any = await res.json()
    const text = (data?.text || "").trim()
    if (text) logline("stt", `heard: "${text.slice(0, 80)}"`)
    return text || null
  } catch (err: any) {
    logerr("stt", "transcribe failed:", (err.message || err).slice(0, 80))
    return null
  }
}
