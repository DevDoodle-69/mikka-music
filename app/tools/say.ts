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
 * Reply where the command came from:
 * - Server channel → reply in that channel
 * - Inbox/DM → reply in the DM
 */
async function tellUser(msg: Message, queue: Queue | undefined | null, content: string): Promise<void> {
  const clean = stripEmojis(content)
  await typeAndWait(msg.channel as any, clean)
  try {
    await msg.channel.send(clean)
  } catch (err) {
    try { console.log(`[tellUser] send failed: ${(err as any)?.message?.slice(0, 60)}`) } catch {}
  }
}

/**
 * Send to wherever the owner is controlling from:
 * - Command from server channel → reply in that server channel
 * - Command from inbox/DM → reply in the inbox
 * The queue's textChannel always tracks the latest control location.
 */
async function tellChannel(queue: Queue | undefined | null, content: string): Promise<any> {
  const ch = queue?.textChannel as any
  if (!ch || typeof ch.send !== "function") return
  const clean = stripEmojis(content)
  await typeAndWait(ch as any, clean)
  try {
    return await ch.send(clean)
  } catch (err) {
    // Channel may be deleted or inaccessible — log and move on.
    try { console.log(`[tellChannel] send failed: ${(err as any)?.message?.slice(0, 60)}`) } catch {}
  }
}

export { stripEmojis, pick, replySoft, saySoft, tellUser, tellChannel }
