import { joinVoiceChannel, createAudioPlayer } from "@discordjs/voice"
import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import { queues, saveState, createDefaultQueue, isConnectionLive } from "../voice/shelf"
import { playStation } from "../voice/jukebox"
import { resolveRadioMetadata } from "../web/airwaves"
import { Queue } from "../types"
import { tellUser, pick } from "../tools/say"
import { dropTemp } from "../web/fetchmp3"

async function handleRadio(msg: Message, args: string[], guild: Guild, voice: VoiceChannel | null, queue: Queue | undefined): Promise<void> {
  const query = args.join(" ")

  if (!query) {
    await tellUser(msg, queue, "tell me which station~ like @Mikka radio <name>")
    return
  }

  try {
    await tellUser(msg, queue, pick(["hunting for that station~", "let me find that station for you~"]))

    const radio = await resolveRadioMetadata(query)

    await tellUser(msg, queue, `found **${radio.name}**${radio.country ? ` (${radio.country})` : ""}~ tuning in`)

    if (!queue || !isConnectionLive(queue)) {
      if (!voice) {
        await tellUser(msg, queue, "join a voice channel first, silly~")
        return
      }
      try { queue?.connection?.destroy() } catch {}
      const connection = joinVoiceChannel({
        channelId: voice.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      })

      const player = queue?.player ?? createAudioPlayer()
      connection.subscribe(player)

      const playbackChannel = (msg.channel as any).guild
        ? msg.channel
        : (voice.guild.systemChannel || voice.guild.channels.cache.find(c => {
            const ch = c as any
            return ch.isTextBased && ch.type === 0
          }) || voice.guild.channels.cache.first())

      if (!queue) {
        queue = createDefaultQueue({
          textChannel: playbackChannel as any,
          connection,
          player,
          voiceChannelId: voice.id,
          userId: msg.author.id
        })

        queues.set(guild.id, queue)
      } else {
        queue.connection = connection
        queue.player = player
        queue.voiceChannelId = voice.id
        queue.textChannel = playbackChannel as any
        queue.userId = msg.author.id
      }
    }

    if (queue.currentProcesses) {
      queue.currentProcesses.ytdlp?.kill()
      queue.currentProcesses.ff.kill()
      dropTemp(queue)
    }

    playStation(guild, radio.url, radio.name)

  } catch (err) {
    console.error("Radio error:", err)
    await tellUser(msg, queue, "oops~ " + (err as Error).message)
  }
}

async function handleRadioStats(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue || !queue.radioFfmpeg) {
    await tellUser(msg, queue, "no radio playing right now~")
    return
  }

  const stats = queue.radioFfmpeg.getStreamStats
    ? queue.radioFfmpeg.getStreamStats()
    : { sizeMB: "Unknown", lastRestart: "Unknown" }

  let statsMsg = `📊 **Radio Stream Statistics** 📊\n\n`
  statsMsg += `📻 **Station:** ${queue.radioName || "Unknown"}\n`
  statsMsg += `📏 **Stream Size:** ${stats.sizeMB}MB\n`
  statsMsg += `🔄 **Last Restart:** ${stats.lastRestart}\n`
  statsMsg += `🔁 **Reconnect Attempts:** ${queue.radioReconnectAttempts || 0}/5\n`
  statsMsg += `📡 **Status:** ${queue.isReconnecting ? "Reconnecting..." : "Connected"}\n`

  if (queue.metadataDetector) {
    const detectorStatus = queue.metadataDetector.getStatus()
    statsMsg += `🎵 **Metadata Detector:** Active\n`
    statsMsg += `   • Current Song: ${detectorStatus.currentSong || "No data"}\n`
    statsMsg += `   • Last Detection: ${new Date(detectorStatus.lastSuccessfulDetection).toLocaleString()}\n`
    statsMsg += `   • Consecutive Errors: ${detectorStatus.consecutiveErrors}\n`
  } else {
    statsMsg += `🎵 **Metadata Detector:** Inactive\n`
  }

  await tellUser(msg, queue, statsMsg)
}

export { handleRadio, handleRadioStats }
