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
async function replyHuman(msg: Message, content: string): Promise<Message> {
  const clean = stripEmojis(content)
  await typeAndWait(msg.channel as any, clean)
  return msg.reply(clean)
}

/** Send plain text to a channel: no emojis, typing indicator, human delay. */
async function sendHuman(channel: { send: (c: string) => Promise<any>; sendTyping?: () => Promise<unknown> }, content: string): Promise<any> {
  const clean = stripEmojis(content)
  await typeAndWait(channel as any, clean)
  return channel.send(clean)
}

async function sendMsg(msg: Message, queue: Queue | undefined | null, content: string): Promise<void> {
  const clean = stripEmojis(content)
  if (queue?.silent) {
    try {
      await typeAndWait(msg.channel as any, clean)
      await msg.author.send(clean)
      return
    } catch {
      // If DM fails (e.g. selfbot can't DM itself), fallback to channel
      await typeAndWait(msg.channel as any, clean)
      await msg.channel.send(clean).catch(() => {})
      return
    }
  }
  await typeAndWait(msg.channel as any, clean)
  await msg.channel.send(clean)
}

async function sendToTextChannel(queue: Queue | undefined | null, content: string): Promise<any> {
  if (!queue?.textChannel) return
  const clean = stripEmojis(content)

  if (queue.silent && queue.userId) {
    try {
      const user = await queue.textChannel.client.users.fetch(queue.userId)
      const dm = await user.createDM()
      await typeAndWait(dm as any, clean)
      return await dm.send(clean)
    } catch {}
    return
  }

  await typeAndWait(queue.textChannel as any, clean)
  return await queue.textChannel.send(clean)
}

export { stripEmojis, replyHuman, sendHuman, sendMsg, sendToTextChannel }
