import { Message } from "selfbotsdk-discordjs"
import { Queue } from "../types"

/**
 * Remove every emoji / pictograph from a string so all bot responses
 * are plain text. Keeps markdown (**bold**, newlines) intact.
 */
function stripEmojis(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pick one of several coy reply variants so she never sounds like
 * a robot reading the same line twice.
 */
function pick<T>(options: T[]): T {
  return options[Math.floor(Math.random() * options.length)]
}

/**
 * Human-like delay scaled to the message length, so replies feel typed
 * rather than instant. ~18ms per char, clamped between 0.7s and 2.8s.
 */
function humanDelayMs(content: string): number {
  const clean = stripEmojis(content)
  return Math.min(2800, Math.max(700, clean.length * 18))
}

async function typeAndWait(target: { sendTyping?: () => Promise<unknown> } | null | undefined, content: string): Promise<void> {
  try {
    await target?.sendTyping?.()
  } catch {
    // typing indicator is best-effort
  }
  await sleep(humanDelayMs(content))
}

/** Reply to a message: no emojis, typing indicator, human delay. */
async function replySoft(msg: Message, content: string): Promise<Message> {
  const clean = stripEmojis(content)
  await typeAndWait(msg.channel as any, clean)
  return msg.reply(clean)
}

/** Send plain text to a channel: no emojis, typing indicator, human delay. */
async function saySoft(channel: { send: (c: string) => Promise<any>; sendTyping?: () => Promise<unknown> }, content: string): Promise<any> {
  const clean = stripEmojis(content)
  await typeAndWait(channel as any, clean)
  return channel.send(clean)
}

/**
 * Reply to the owner via DM only. If the command came from a server channel,
 * the response still goes to the inbox — never back to the server.
 */
async function tellUser(msg: Message, queue: Queue | undefined | null, content: string): Promise<void> {
  const clean = stripEmojis(content)
  // Always prefer DM (inbox-only mode).
  try {
    const dm = await msg.author.createDM()
    await typeAndWait(dm as any, clean)
    await dm.send(clean)
    return
  } catch (err) {
    logDMFallback(clean, err)
  }
  // DM failed — stay silent rather than posting in a server.
}

/**
 * Send a message to the owner's inbox (DM) ONLY — never to a server channel.
 * Music still plays in voice; only the text goes private.
 */
async function tellChannel(queue: Queue | undefined | null, content: string): Promise<any> {
  const ch = queue?.textChannel as any
  const clean = stripEmojis(content)
  const userId = queue?.userId

  if (userId && ch?.client) {
    try {
      const user = await ch.client.users.fetch(userId)
      const dm = await user.createDM()
      await typeAndWait(dm as any, clean)
      return await dm.send(clean)
    } catch (err) {
      logDMFallback(clean, err)
    }
  }
  // No DM available — stay silent rather than leaking into a server.
}

function logDMFallback(content: string, err: any): void {
  try {
    console.log(`[dm-fallback] couldn't DM owner, message withheld: "${content.slice(0, 60)}" (${(err?.message || err)?.toString().slice(0, 60)})`)
  } catch {}
}

export { stripEmojis, pick, replySoft, saySoft, tellUser, tellChannel }
