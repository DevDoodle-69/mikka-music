/**
 * brain.ts — Mikka's AI brain via the mikka-proxy-ai chat API.
 *
 *   GET https://mikka-proxy-ai.onrender.com/chat?text=<encoded>&chatid=<id>
 *   -> { status, response, model, chatid }
 *
 * Used for:
 *  - aiplay: turn a natural-language music description into search queries
 *  - Fresh cute messages (with static fallback if the API is slow/down)
 *
 * Persona: Mikka — a cute, playful, slightly coy music-loving assistant.
 * She speaks naturally, keeps it short, never uses emojis in her own
 * messages (the send layer strips them anyway).
 */
import { logline, logerr } from "../tools/log"
import { proxiedFetch } from "./proxy"

const BRAIN_API = process.env.BRAIN_API_BASE || "https://mikka-proxy-ai.onrender.com/chat"
const BRAIN_TIMEOUT = 25000

/** Mikka's core persona, prepended to AI tasks. */
export const MIKKA_PERSONA = `You are Mikka, a cute and playful music assistant. You love music, you're a little coy and teasing, and you keep replies short and natural like a real person texting. Never use emojis.`

/** Stable chat id so the AI remembers context across calls. */
let chatId = `mikka-music-${Date.now().toString(36)}`

async function askBrain(prompt: string, timeoutMs = BRAIN_TIMEOUT): Promise<string | null> {
  try {
    const url = `${BRAIN_API}?text=${encodeURIComponent(prompt)}&chatid=${encodeURIComponent(chatId)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res: any = await proxiedFetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) {
      logerr("brain", `API HTTP ${res.status}`)
      return null
    }
    const data: any = await res.json()
    if (data?.chatid) chatId = data.chatid
    const text = (data?.response || "").trim()
    if (!text) return null
    return text
  } catch (err: any) {
    logerr("brain", "ask failed:", (err.message || err).slice(0, 80))
    return null
  }
}

/**
 * Turn a user's music description into a single YouTube search query.
 * e.g. "something sad for a rainy night" -> "sad lofi hip hop rainy night"
 */
export async function descriptionToQuery(description: string): Promise<string | null> {
  const prompt = `${MIKKA_PERSONA}

The user wants you to pick a song for them. They described the mood like this: "${description}"

Reply with ONLY a YouTube search query (artist and song title, or a descriptive query) that best matches what they want. No explanation, no quotes, just the search query on one line.`
  const out = await askBrain(prompt)
  if (!out) return null
  // Take the first line, strip quotes/numbering the AI might add.
  const line = out.split("\n")[0].replace(/^["'\d.\-\s]+/, "").replace(/["']$/, "").trim()
  logline("brain", `description -> query: "${line.slice(0, 60)}"`)
  return line || null
}

/**
 * Turn a user's description + limit into a list of search queries.
 * Returns up to `limit` "Artist - Title" strings.
 */
export async function descriptionToPlaylist(description: string, limit: number): Promise<string[]> {
  const n = Math.min(Math.max(limit, 1), 25)
  const prompt = `${MIKKA_PERSONA}

The user wants a playlist. They described it like this: "${description}"
They want ${n} songs.

Reply with ONLY a numbered list of ${n} songs, one per line, in the format "Artist - Song Title". No explanations, no extra text, just the ${n} lines. Make the picks match their description perfectly.`
  const out = await askBrain(prompt, 40000)
  if (!out) return []
  const queries = out
    .split("\n")
    .map((l) => l.replace(/^\s*["'\d.\-\)\s]+/, "").replace(/["']\s*$/, "").trim())
    .filter((l) => l.length > 3 && /-/.test(l))
    .slice(0, n)
  logline("brain", `playlist: got ${queries.length}/${n} picks`)
  return queries
}

/**
 * Voice-chat assistant: the user speaks in a voice call, this is the reply
 * she'll SAY aloud via TTS. Kept short and conversational — spoken, not read.
 * Uses the same chatid so she remembers the conversation.
 */
export async function voiceChatReply(text: string): Promise<string | null> {
  const prompt = `You are Mikka, a cute, playful, warm AI voice assistant — like a smart friend on a call. You can answer ANYTHING: questions, advice, chit-chat, jokes, explanations, help with anything. You're talking to Nehal LIVE in a voice call — he will HEAR your reply spoken aloud. Chat naturally like a real person would on a call. Keep it SHORT (1-2 sentences, under 40 words) because it's spoken. Plain conversational words only — no emojis, no markdown, no lists. Never break character, never mention you're an AI model.

He just said: "${text}"`
  const out = await askBrain(prompt, 25000)
  if (!out) return null
  const line = out
    .replace(/[*_`~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)
  return line || null
}

/**
 * Generate a fresh cute message for a moment (now playing, song added...).
 * Falls back to null quickly so the caller can use static lines.
 */
export async function freshLine(kind: "nowPlaying" | "songAdded" | "fetching" | "greeting", songTitle = ""): Promise<string | null> {
  const prompts: Record<string, string> = {
    nowPlaying: `Write ONE short cute playful line (max 15 words) announcing you're now playing "${songTitle}". Be coy and fun. No emojis, no quotes.`,
    songAdded: `Write ONE short cute playful line (max 12 words) saying you added "${songTitle}" to the queue. No emojis, no quotes.`,
    fetching: `Write ONE short cute line (max 10 words) saying you're going to fetch "${songTitle}". Playful. No emojis, no quotes.`,
    greeting: `Write ONE short cute playful greeting (max 12 words) as Mikka the music assistant. No emojis, no quotes.`,
  }
  const out = await askBrain(`${MIKKA_PERSONA}\n\n${prompts[kind]}`, 12000)
  if (!out) return null
  const line = out.split("\n")[0].replace(/^["']|["']$/g, "").trim()
  if (line.length > 120) return null
  return line || null
}
