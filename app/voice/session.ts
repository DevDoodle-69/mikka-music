import { joinVoiceChannel, createAudioPlayer } from "@discordjs/voice"
import { Client, Guild, VoiceChannel, TextChannel } from "selfbotsdk-discordjs"
import { queues, saveState, createDefaultQueue, markIntentionalLeave, takeIntentionalLeave } from "./shelf"
import { playTrack, playStation } from "./jukebox"
import { tellChannel } from "../tools/say"
import config from "../setup"
import { dropTemp } from "../web/fetchmp3"

let clientRef: Client | null = null

function setClient(client: Client): void {
  clientRef = client
}

async function resumeAllMusic(): Promise<void> {
  console.log("Resuming all music/radio after reconnection...")
  let resumedCount = 0
  let failedCount = 0

  for (const [guildId, queue] of queues) {
    if (!queue.voiceChannelId) {
      console.log(`No voice channel ID stored for guild ${guildId}`)
      continue
    }

    const guild: Guild | undefined = clientRef!.guilds.cache.get(guildId)
    if (!guild) {
      console.log(`Guild ${guildId} not found in cache`)
      failedCount++
      continue
    }

    try {
      const voiceChannel = guild.channels.cache.get(queue.voiceChannelId) as VoiceChannel | undefined
      if (!voiceChannel) {
        console.log(`Voice channel ${queue.voiceChannelId} not found in guild ${guildId}`)
        failedCount++
        continue
      }

      console.log(`Rejoining voice channel: ${voiceChannel.name} (${voiceChannel.id}) for guild ${guildId}`)

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      })

      connection.subscribe(queue.player)
      queue.connection = connection

      queue.isReconnecting = false
      queue.radioReconnectAttempts = 0
      queue.reconnectMessage = null
      queue.isMusicReconnecting = false
      queue.musicReconnectAttempts = 0
      queue.musicReconnectMessage = null

      if (queue.radioUrl && queue.radioName && !queue.radioStopped) {
        console.log(`Resuming radio: ${queue.radioName}`)
        tellChannel(queue, "warming the radio back up~")
        setTimeout(() => playStation(guild, queue.radioUrl!, queue.radioName!), 3000)
        resumedCount++
      } else if (queue.songs.length > 0) {
        voiceChannel.send("Test message")
        console.log(`Resuming music queue - ${queue.songs.length} songs`)
        let posStr = ""
        if (queue.playing && queue.currentSong && !queue.currentSong.isRadio) {
          const startedAt = new Date(queue.currentSong.startedAt)
          const elapsedSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000)
          queue.songs[0].resumeFrom = elapsedSeconds
          posStr = ` (${Math.floor(elapsedSeconds / 60)}:${(elapsedSeconds % 60).toString().padStart(2, "0")})`
          console.log(`Resuming from ${elapsedSeconds}s for "${queue.currentSong.title}"`)
        }
        tellChannel(queue, "picking up where we left off~")
        setTimeout(() => playTrack(guild, queue.songs[0]), 2000)
        resumedCount++
      } else {
        console.log(`No active playback to resume for guild ${guildId}`)
      }
    } catch (err) {
      console.error(`Error resuming music for guild ${guildId}:`, err)
      tellChannel(queue, "couldn't reconnect after the restart~ try playing something fresh")
      failedCount++
    }
  }

  console.log(`Resume summary: ${resumedCount} successful, ${failedCount} failed`)
}

function registerVoiceStateUpdateHandler(): void {
  // Pending auto-joins: guildId -> timeout. Cancelled if the owner
  // leaves before the delay elapses.
  const pendingJoins = new Map<string, NodeJS.Timeout>()
  const AUTOJOIN_DELAY_MS = 10_000

  clientRef!.on("voiceStateUpdate", (oldState: any, newState: any) => {
    if (!oldState.member) return

    // --- Owner auto-join: 10s after the owner joins ANY voice channel,
    // the bot slips in after them. Cancelled if they leave first. ---
    if (newState.member?.id === config.ownerId && newState.channel) {
      const guild: Guild | undefined = clientRef!.guilds.cache.get(newState.guild.id)
      if (guild) {
        const channel = newState.channel as VoiceChannel
        const channelId = channel.id

        const prev = pendingJoins.get(guild.id)
        if (prev) clearTimeout(prev)

        console.log(`[AUTOJOIN] Owner joined "${channel.name}" — joining in 10s`)
        const t = setTimeout(() => {
          pendingJoins.delete(guild.id)
          try {
            // Still there? Don't chase a ghost.
            const member = guild.members.cache.get(config.ownerId) as any
            const stillThere = member?.voice?.channel?.id === channelId
            if (!stillThere) {
              console.log("[AUTOJOIN] Owner left before the 10s delay — not joining")
              return
            }

            const existing = queues.get(guild.id)
            const alreadyThere = !!existing?.voiceChannelId && existing.voiceChannelId === channelId && !!existing.connection
            if (alreadyThere) return

            console.log(`[AUTOJOIN] Joining "${channel.name}" now`)
            try { existing?.connection?.destroy() } catch {}
            const connection = joinVoiceChannel({
              channelId,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
              selfDeaf: false,
              selfMute: false
            })
            const player = existing?.player ?? createAudioPlayer()
            connection.subscribe(player)

            if (!existing) {
              const textChannel = (guild.systemChannel ||
                guild.channels.cache.find((c: any) => c.isTextBased && c.type === 0) ||
                guild.channels.cache.first()) as TextChannel
              const queue = createDefaultQueue({
                textChannel: textChannel as any,
                connection,
                player,
                voiceChannelId: channelId,
                userId: config.ownerId
              })
              queues.set(guild.id, queue)
            } else {
              existing.connection = connection
              existing.player = player
              existing.voiceChannelId = channelId
            }
            saveState()
          } catch (err) {
            console.error("[AUTOJOIN] Failed to join owner's voice channel:", err)
          }
        }, AUTOJOIN_DELAY_MS)
        pendingJoins.set(guild.id, t)
      }
      return
    }

    // --- Owner left the voice channel the bot is sitting in: leave too. ---
    if (oldState.member?.id === config.ownerId && oldState.channel && !newState.channel) {
      // Cancel any pending join — they changed their mind.
      const pending = pendingJoins.get(oldState.guild.id)
      if (pending) {
        clearTimeout(pending)
        pendingJoins.delete(oldState.guild.id)
        console.log("[AUTOJOIN] Cancelled pending join (owner left)")
      }

      const queue = queues.get(oldState.guild.id)
      if (queue && queue.voiceChannelId === oldState.channel.id) {
        console.log("[AUTOJOIN] Owner left the voice channel — leaving too")
        markIntentionalLeave(oldState.guild.id)
        try { queue.connection?.destroy() } catch {}
        queue.connection = null
        queue.voiceChannelId = null
        try { queue.player.stop() } catch {}
        saveState()
      }
      return
    }

    if (oldState.member.id === clientRef!.user!.id && oldState.channel && !newState.channel) {
      // She left on purpose (auto-leave / leave command) — stay out, don't creep back in.
      if (takeIntentionalLeave(oldState.guild.id)) {
        console.log("[voice-state] Left that voice channel on purpose — staying out")
        return
      }
      console.log("Bot was kicked from voice channel")
      const queue = queues.get(oldState.guild.id)
      if (queue) {
        let posStr = ""
        if (queue.currentSong && !queue.currentSong.isRadio) {
          const startedAt = new Date(queue.currentSong.startedAt)
          const currentTime = new Date()
          const elapsedSeconds = Math.floor((currentTime.getTime() - startedAt.getTime()) / 1000)

          if (queue.songs && queue.songs.length > 0 && queue.songs[0]) {
            queue.songs[0].resumeFrom = elapsedSeconds
            posStr = ` (${Math.floor(elapsedSeconds / 60)}:${(elapsedSeconds % 60).toString().padStart(2, "0")})`
            console.log(`Saved resume time: ${elapsedSeconds}s${posStr} for "${queue.currentSong.title}"`)
          }
        }

        queue.voiceChannelId = oldState.channel.id
        tellChannel(queue, "oops, I got kicked~ sneaking back in...").catch((err: any) => {
          if (err.code === 50001) {
            console.error("[voice-state] Missing Access: Bot tidak memiliki izin untuk mengirim pesan ke channel setelah terkick dari VC")
          } else {
            console.error("[voice-state] Gagal mengirim pesan setelah terkick dari VC:", err.message)
          }
        })
        setTimeout(() => {
          const guild: Guild | undefined = clientRef!.guilds.cache.get(oldState.guild.id)
          if (guild) {
            const voiceChannel = guild.channels.cache.get(oldState.channel.id) as VoiceChannel | undefined
            if (voiceChannel) {
              try {
                const connection = joinVoiceChannel({
                  channelId: voiceChannel.id,
                  guildId: guild.id,
                  adapterCreator: guild.voiceAdapterCreator,
                  selfDeaf: false,
                  selfMute: false
                })
                connection.subscribe(queue.player)
                queue.connection = connection
                tellChannel(queue, "i'm back~")
                queue.radioReconnectAttempts = 0
                queue.musicReconnectAttempts = 0
                queue.isMusicReconnecting = false
                queue.musicReconnectMessage = null

                if (queue.radioUrl && queue.radioName && !queue.radioStopped) {
                  playStation(guild, queue.radioUrl, queue.radioName)
                } else if (queue.songs.length > 0) {
                  playTrack(guild, queue.songs[0])
                }
              } catch (err) {
                console.error("Error rejoining voice channel:", err)
                tellChannel(queue, "couldn't get back into the voice channel~")
              }
            } else {
              console.log("Voice channel tidak ditemukan, kemungkinan temporary channel dihapus")
              tellChannel(queue, "lost that voice channel~ join a new one and I'll follow")

              queue.voiceChannelId = null
              queue.connection = null

              if (queue.currentProcesses) {
                queue.currentProcesses.ytdlp?.kill()
                queue.currentProcesses.ff.kill()
                dropTemp(queue)
              }
              if (queue.radioFfmpeg) queue.radioFfmpeg.kill()
              if (queue.metadataDetector) {
                queue.metadataDetector.stop()
                queue.metadataDetector = undefined
              }

              queue.player.stop()
              saveState()
            }
          }
        }, 5000)
      }
    }

    if (oldState.member.id !== clientRef!.user!.id && !oldState.channel && newState.channel) {
      const queue = queues.get(newState.guild.id)
      if (queue && !queue.voiceChannelId && queue.connection === null) {
        console.log("User join ke voice channel baru, bot siap untuk resume")

        queue.voiceChannelId = newState.channel.id
        // Never store a voice channel as the text channel — find a real one.
        const ch = queue.textChannel as any
        if (!ch || typeof ch.send !== "function") {
          const g = clientRef!.guilds.cache.get(newState.guild.id)
          const textChannel = (g?.systemChannel ||
            g?.channels.cache.find((c: any) => c.isTextBased && c.type === 0) ||
            g?.channels.cache.first()) as TextChannel | undefined
          if (textChannel && typeof (textChannel as any).send === "function") {
            queue.textChannel = textChannel as any
          }
        }

        tellChannel(queue, "i'm ready when you are~ just mention me with play")
        saveState()
      }
    }
  })
}

export { setClient, resumeAllMusic, registerVoiceStateUpdateHandler }
