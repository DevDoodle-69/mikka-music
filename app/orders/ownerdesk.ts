/**
 * ownerdesk.ts — self-commands for the OWNER's own account.
 *
 * When OWNER_TOKEN is set, the bot also logs in as the owner's account.
 * That client is fully separate from the robot: it only answers to its
 * own ^ messages, and only the sleep command lives there:
 *
 *   ^sleep 30sec / ^sleep 4m / ^sleep 1h   — timer, then *I* leave voice
 *   ^sleep off                              — cancel
 *
 * When the timer ends, ONLY the owner's account leaves the voice chat.
 * It never touches the robot — the robot is a separate bot with its own
 * commands, and it will notice its owner left and follow on its own.
 */
import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import { startSleepMs, cancelSleep, getSleepInfo } from "../voice/sleep"
import { disconnectOwnerFromVoice } from "../voice/session"
import { parseSleepDuration, formatSleepDuration } from "./handy"
import { logline, logerr } from "../tools/log"

/** Is the owner shadow client currently logged in? (for the dashboard) */
let ownerClientOnline = false
export function setOwnerClientOnline(v: boolean): void { ownerClientOnline = v }
export function isOwnerClientOnline(): boolean { return ownerClientOnline }

/** Which guild is the owner actually sitting in voice in (via this client)? */
async function findOwnerVoiceGuild(client: any, ownerId: string): Promise<{ guild: Guild; channel: VoiceChannel } | null> {
  try {
    for (const [, g] of client.guilds.cache) {
      try {
        const m: any = await g.members.fetch(ownerId).catch(() => null)
        const ch = m?.voice?.channel
        if (ch) return { guild: g, channel: ch }
      } catch {}
    }
  } catch (err) {
    logerr("sleep", "owner voice scan failed:", (err as Error).message?.slice(0, 60))
  }
  return null
}

/** Fallback: send the native OP 4 voice-state packet (what the official
 *  client sends when you click disconnect). Used if the REST call fails. */
function gatewayLeaveVoice(ownerClient: any, guildId: string): boolean {
  try {
    const shards = ownerClient?.ws?.shards
    const shard = shards?.get ? (shards.get(0) || [...shards.values()][0]) : null
    if (!shard || typeof shard.send !== "function") return false
    shard.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } })
    logline("sleep", "sent gateway OP 4 voice leave")
    return true
  } catch (err) {
    logerr("sleep", "gateway leave failed:", (err as Error).message?.slice(0, 60))
    return false
  }
}

async function handleOwnerSleep(msg: Message, args: string[]): Promise<void> {
  const client: any = msg.client
  const ownerId: string = client.user?.id
  const say = async (text: string) => {
    try { await (msg.channel as any).send(text) } catch {}
  }

  // Resolve the guild: message guild first, else wherever the owner is sitting in voice.
  let guild: Guild | undefined = (msg as any).guild || undefined
  if (!guild) {
    try {
      const found = await findOwnerVoiceGuild(client, ownerId)
      if (found) guild = found.guild
    } catch {}
  }

  const arg = (args[0] || "").toLowerCase()

  if (arg === "off" || arg === "cancel" || arg === "stop") {
    if (guild && cancelSleep(guild.id)) await say("sleep timer off — I'm staying")
    else await say("no sleep timer was running")
    return
  }

  if (!arg) {
    const info = guild ? getSleepInfo(guild.id) : null
    if (info) {
      await say(`sleep timer's on — leaving voice in ${formatSleepDuration(Math.max(1000, info.endsAt - Date.now()))}`)
    } else {
      await say("no sleep timer set — try `^sleep 30sec` or `^sleep 1h`")
    }
    return
  }

  const totalMs = parseSleepDuration(arg)
  if (totalMs === null) {
    await say("give me a time like `30sec`, `4m` or `1h` (10sec – 8h)")
    return
  }
  if (!guild) {
    await say("I can't tell which server — join a voice channel first, then `^sleep`")
    return
  }

  const label = formatSleepDuration(totalMs)

  startSleepMs(guild.id, totalMs, { volume: 1 }, async () => {
    logline("sleep", `owner sleep done (${label}) — my account leaves voice`)
    // ONLY my own account leaves. The robot is separate and untouched —
    // it will see its owner left and follow on its own (normal auto-leave).
    let targetGuildId: string = guild.id
    try {
      const found = await findOwnerVoiceGuild(client, ownerId)
      if (found) targetGuildId = found.guild.id
    } catch {}
    let ok = await disconnectOwnerFromVoice(targetGuildId)
    if (!ok) ok = gatewayLeaveVoice(client, targetGuildId)
    await say(ok ? "left the voice chat — goodnight" : "timer's up, but I couldn't leave voice — check the connection and try again")
  })

  await say(`okay — I'll leave the voice chat in ${label}`)
}

/**
 * Entry point for the owner client's messageCreate.
 * Only the owner's own ^ messages, only the sleep command.
 */
export async function handleOwnerMessageCreate(msg: Message): Promise<void> {
  const me = msg.client.user?.id
  if (!me || msg.author.id !== me) return // self-commands only
  if (!/^\^/.test(msg.content)) return
  const body = msg.content.replace(/^\^\s*/, "").trim()
  if (!body) return
  const args = body.split(/ +/)
  const cmd = (args.shift() || "").toLowerCase()
  if (cmd !== "sleep") return
  logline("command", `owner ^sleep · ${args.join(" ") || "—"}`)
  try {
    await handleOwnerSleep(msg, args)
  } catch (err) {
    logerr("sleep", "owner sleep failed:", (err as Error).message?.slice(0, 80))
  }
}
