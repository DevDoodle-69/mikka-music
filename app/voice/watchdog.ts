/**
 * watchdog.ts — voice connection health monitoring.
 *
 * The bot used to rely only on voiceStateUpdate to notice it lost voice.
 * Network blips can kill the voice connection WITHOUT any voiceStateUpdate,
 * leaving her silently dead in the channel. This watchdog subscribes to the
 * connection's own state machine and recovers automatically:
 *   - Disconnected -> wait for Discord's auto-reconnect, else manual rejoin
 *   - Destroyed (unexpected) -> rejoin the same channel with retries
 * Intentional leaves are never "recovered" — the marker system stays authoritative.
 */
import { VoiceConnectionStatus, entersState, joinVoiceChannel, createAudioPlayer } from "@discordjs/voice"
import { logline, logerr } from "../tools/log"
import { takeIntentionalLeave } from "./shelf"
import config from "../setup"

const REJOIN_ATTEMPTS = 3

/** HARD RULE: the bot never (re)joins a voice channel the owner isn't in. */
async function ownerInChannel(guild: any, channelId: string): Promise<boolean> {
  try {
    let m: any = guild.members?.cache.get(config.ownerId)
    if (!m) {
      try { m = await guild.members?.fetch(config.ownerId) } catch {}
    }
    return m?.voice?.channel?.id === channelId
  } catch {
    return false
  }
}

/**
 * Attach health monitoring to a queue's voice connection.
 * Safe to call multiple times — old listeners are cleared first.
 */
export function watchConnection(guild: any, queue: any): void {
  const conn = queue.connection
  if (!conn) return

  try { conn.removeAllListeners("stateChange") } catch {}

  conn.on("stateChange", async (oldState: any, newState: any) => {
    const guildId = guild.id

    // She left on purpose — never interfere.
    if (takeIntentionalLeave(guildId)) return

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      logline("voice", "connection wobbled — waiting for auto-recover")
      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 15_000)
        logline("voice", "connection recovered on its own")
      } catch {
        logerr("voice", "auto-recover failed — rejoining manually")
        await rejoinVoice(guild, queue)
      }
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      // Destroyed without an intentional marker = unexpected. Rejoin.
      logerr("voice", "connection destroyed unexpectedly — rejoining")
      await rejoinVoice(guild, queue)
    }
  })
}

async function rejoinVoice(guild: any, queue: any): Promise<boolean> {
  const channelId = queue.voiceChannelId
  if (!channelId) {
    logerr("voice", "no channel to rejoin — giving up")
    return false
  }
  // Don't fight an intentional leave that landed mid-retry.
  if (takeIntentionalLeave(guild.id)) return false
  // HARD RULE: never rejoin a channel the owner isn't sitting in.
  if (!(await ownerInChannel(guild, channelId))) {
    logline("voice", "owner not in that voice channel — staying out, no rejoin")
    return false
  }

  for (let attempt = 1; attempt <= REJOIN_ATTEMPTS; attempt++) {
    try {
      logline("voice", `rejoin attempt ${attempt}/${REJOIN_ATTEMPTS}`)
      try { queue.connection?.destroy() } catch {}
      const connection = joinVoiceChannel({
        channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      })
      const player = queue.player || createAudioPlayer()
      connection.subscribe(player)
      queue.connection = connection
      queue.player = player
      await entersState(connection, VoiceConnectionStatus.Ready, 12_000)
      logline("voice", "rejoined successfully")
      watchConnection(guild, queue) // re-arm the watchdog on the new connection
      return true
    } catch (err) {
      logerr("voice", `rejoin attempt ${attempt} failed:`, (err as Error).message?.slice(0, 100))
      if (attempt < REJOIN_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    }
  }
  logerr("voice", "all rejoin attempts failed — staying out")
  return false
}
