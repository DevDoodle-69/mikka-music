import { joinVoiceChannel, createAudioPlayer, AudioPlayerStatus } from "@discordjs/voice"
import { Message, Guild, VoiceChannel, Channel } from "selfbotsdk-discordjs"
import { queues, saveState, createDefaultQueue, markIntentionalLeave, leaveAllVoiceSessions } from "../voice/shelf"
import { playTrack, playStation } from "../voice/jukebox"
import { removeAllReactionsFromChannel, createCommandPanel } from "../chat/panel"
import config from "../setup"
import { Queue } from "../types"
import { tellUser, replySoft, saySoft, pick } from "../tools/say"
import { getPlatform, setPlatform } from "../web/platform"
import { startSleep, cancelSleep, getSleepInfo } from "../voice/sleep"
import { dropTemp } from "../web/fetchmp3"

function handleTest(msg: Message): Promise<Message> {
  console.log("Test : ", msg)
  return replySoft(msg, pick(["all good on my end~", "yep, I'm here~", "loud and clear, cutie~"]))
}

function handleHelp(msg: Message): void {
  const helpEmbed = [
    "**hey~ here's what I can do for you**",
    "",
    "just mention me, like @Mikka play shape of you",
    "",
    "**play** <song name> - I'll find it and sing it for you",
    "**play** <link> - play a YouTube link directly",
    "**play** <playlist link> [limit] - a whole playlist, your call how many",
    "**play** <link1 link2 ...> - several links at once, I'm not shy",
    "**skip** - next song, no hard feelings",
    "**loop** - round and round: Off / Single / All",
    "**shuffle** - let fate pick the order",
    "**queue** - peek at what's coming up",
    "**stop** - hush, clearing everything",
    "**volume** [0-100] - louder or softer, you decide",
    "**radio** <name or link> - tune into a station",
    "**radiostats** - nerdy radio numbers",
    "**leave** - I'll slip out of the voice channel",
    "**sync** - pull me into the voice channel you're in (works from inbox too~)",
    "**state** - how I'm feeling right now",
    "**panel** - cute little control panel",
    "**silent** - shh mode: I whisper in DMs instead",
    "**sleep** <minutes> - fade out gently and tuck you in (sleep off to cancel)",
    "**proxyset** <youtube|spotify> - switch music platform (auto-fallback included)",
    "**clearchat** [number] - tidy up messages",
    "",
    "*join a voice channel first, and I'll follow you in (I take about 10 seconds, gotta look cute)~*",
    "*psst~ if I'm already singing somewhere, order me around from DMs or any other server — I'll play it right where I am*"
  ].join("\n")

  saySoft(msg.channel as any, helpEmbed)
}

async function handleLeave(msg: Message, guild: Guild | undefined, queue: Queue | undefined): Promise<void> {
  if (!queue) {
    await tellUser(msg, queue, "i'm not in a voice channel right now~")
    return
  }

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
  if (queue.reactionCollector) {
    queue.reactionCollector.stop()
    queue.reactionCollector = null
  }

  await tellUser(msg, queue, pick(["leaving the voice channel~ bye for now", "slipping out~ call me when you need me"]))
  queue.songs = []
  try { queue.player.removeAllListeners(AudioPlayerStatus.Idle) } catch {}
  queue.player.stop()
  if (guild) markIntentionalLeave(guild.id)
  queue.connection?.destroy()
  if (guild) queues.delete(guild.id)
  saveState()
}

async function handleClearChat(msg: Message, args: string[], queue: Queue | undefined): Promise<void> {
  if (!queue) {
    await tellUser(msg, queue, "i'm not in a voice channel right now~")
    return
  }

  const textChannel = msg.channel as any
  const isDM = !textChannel.guild

  const targetChannel = isDM ? queue.textChannel : textChannel
  if (!targetChannel) {
    await tellUser(msg, queue, "which channel, though?~")
    return
  }

  const countArg = args[0]
  let limit = 100
  if (countArg) {
    limit = parseInt(countArg)
    if (isNaN(limit) || limit < 1) {
      await tellUser(msg, queue, "that's not a number, silly~")
      return
    }
    if (limit > 100) {
      await tellUser(msg, queue, "max 100 at a time, cutie~")
      return
    }
  }

  try {
    await tellUser(msg, queue, `tidying up ${limit} messages~`)

    const messages = await targetChannel.messages.fetch({ limit })
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000

    const messagesToDelete = messages.filter((m: any) => m.createdTimestamp > twoWeeksAgo && m.author.id === msg.client.user!.id)

    if (messagesToDelete.size === 0) {
      await tellUser(msg, queue, "nothing I can delete~ (messages older than 14 days are untouchable)")
      return
    }

    let deletedCount = 0
    for (const [, message] of messagesToDelete) {
      try {
        await message.delete()
        deletedCount++
      } catch (err) {
        console.error("Error deleting message:", err)
      }
    }

    await tellUser(msg, queue, `all clean~ removed **${deletedCount}** messages`)
  } catch (err) {
    console.error("Error deleting messages:", err)
    await tellUser(msg, queue, "couldn't delete those~ " + (err as Error).message)
  }
}

async function handleClearReactions(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue) {
    await tellUser(msg, queue, "i'm not in a voice channel right now~")
    return
  }

  const textChannel = queue.textChannel
  if (!textChannel) {
    await tellUser(msg, queue, "no text channel to work with~")
    return
  }

  if (!textChannel.guild) {
    await tellUser(msg, queue, "that one only works in a server, not DMs~")
    return
  }

  try {
    await tellUser(msg, queue, "clearing all the reactions~")
    await removeAllReactionsFromChannel(textChannel)
    await tellUser(msg, queue, "all reactions gone~ squeaky clean")
  } catch (err) {
    console.error("Error clearing reactions:", err)
    await tellUser(msg, queue, "couldn't clear those~ " + (err as Error).message)
  }
}

async function handleSync(msg: Message, args: string[], guild: Guild, voice: VoiceChannel | null, queue: Queue | undefined): Promise<void> {
  if (!voice) {
    await tellUser(msg, queue, "join a voice channel first, silly~")
    return
  }

  try {
    // Single voice session: leave every other guild first.
    leaveAllVoiceSessions(guild.id)
    try { queue?.connection?.destroy() } catch {}
    try { queue?.player?.removeAllListeners() } catch {}

    const connection = joinVoiceChannel({
      channelId: voice.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    })

    const player = createAudioPlayer()
    connection.subscribe(player)

    if (!queue) {
      queue = createDefaultQueue({
        textChannel: msg.channel as any,
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
      queue.textChannel = msg.channel as any
      queue.userId = msg.author.id
    }

    await tellUser(msg, queue, pick(["synced~ I'm with you now", "found you~ I'm right here"]))

    if (queue.radioUrl && queue.radioName && !queue.radioStopped) {
      playStation(guild, queue.radioUrl, queue.radioName)
    } else if (queue.songs && queue.songs.length > 0) {
      playTrack(guild, queue.songs[0])
    }

    saveState()
  } catch (err) {
    console.error("Error syncing channel:", err)
    await tellUser(msg, queue, "couldn't sync~ " + (err as Error).message)
  }
}


function handleState(msg: Message): void {
  let stateMsg = "📊 **Current Bot State**\n\n"

  if (queues.size === 0) {
    stateMsg += "❌ No active queues"
  } else {
    for (const [guildId, queue] of queues) {
      const guild = msg.client.guilds.cache.get(guildId)
      const guildName = guild ? guild.name : "Unknown Guild"
      stateMsg += `🏠 **Guild:** ${guildName} (${guildId})\n`

      const voiceChannel = guild?.channels.cache.get(queue.voiceChannelId || "") as VoiceChannel | undefined
      const voiceChannelName = voiceChannel ? voiceChannel.name : queue.voiceChannelId
      const textChannelName = queue.textChannel?.name || queue.textChannel?.id || "N/A"

      stateMsg += `   📢 **Voice Channel:** ${voiceChannelName} (${queue.voiceChannelId})\n`
      stateMsg += `   💬 **Text Channel:** ${textChannelName} (${queue.textChannel?.id || "N/A"})\n`
      stateMsg += `   🔊 **Volume:** ${Math.round((queue.volume ?? 1.0) * 100)}%\n`

      if (queue.songs && queue.songs.length > 0 && queue.radioStopped) {
        const currentSong = queue.songs[0]
        let nowPlayingInfo = `🎶 **Now Playing:** ${currentSong?.title || "Unknown Song"}`

        if (currentSong?.duration) {
          const currentTime = queue.currentSong && !queue.currentSong.isRadio
            ? Math.floor((Date.now() - new Date(queue.currentSong.startedAt).getTime()) / 1000)
            : 0

          const formatTime = (seconds: number): string => {
            const mins = Math.floor(seconds / 60)
            const secs = Math.floor(seconds % 60)
            return `${mins}:${secs.toString().padStart(2, "0")}`
          }

          nowPlayingInfo += ` (${formatTime(currentTime)}/${formatTime(currentSong.duration)})`
        }

        stateMsg += `   ${nowPlayingInfo}\n`
      } else if (queue.radioUrl && queue.radioName && !queue.radioStopped) {
        stateMsg += `   📻 **Now Playing Radio:** ${queue.radioName}\n`
      } else {
        stateMsg += `   ⏸️ **Now Playing:** Nothing\n`
      }

      if (queue.radioUrl && queue.radioName) {
        stateMsg += `   📻 **Radio:** ${queue.radioName}\n`
        stateMsg += `   📻 **Radio URL:** ${queue.radioUrl}\n`
        stateMsg += `   ⏸️ **Radio Stopped:** ${queue.radioStopped ? "Yes" : "No"}\n`
      }

      if (queue.songs && queue.songs.length > 0) {
        stateMsg += `   🎵 **Songs in Queue:** ${queue.songs.length}\n`
        queue.songs.slice(0, 5).forEach((song, index) => {
          stateMsg += `      ${index + 1}. ${song?.title || "Unknown Song"}\n`
        })
        if (queue.songs.length > 5) {
          stateMsg += `      ... and ${queue.songs.length - 5} more\n`
        }
      } else {
        stateMsg += `   🎵 **Songs in Queue:** 0\n`
      }

      if (queue.playHistory && queue.playHistory.length > 0) {
        stateMsg += `   📜 **Recently Played (Last 5):**\n`
        queue.playHistory.slice(0, 5).forEach((song, index) => {
          const playTime = new Date(song.playedAt).toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit"
          })
          stateMsg += `      ${index + 1}. ${song?.title || "Unknown Song"} (${playTime})\n`
        })
      } else {
        stateMsg += `   📜 **Recently Played:** None\n`
      }

      stateMsg += "\n"
    }
  }

  stateMsg += `\n💾 **State File:** ${config.stateFile}`
  stateMsg += `\n✅ **Total Active Queues:** ${queues.size}`

  saySoft(msg.channel as any, stateMsg)
}

function handlePanel(msg: Message, queue: Queue | undefined): void {
  if (!queue) {
    tellUser(msg, queue, "i'm not in a voice channel~ play something and I'll come")
    return
  }
  createCommandPanel(msg, queue)
}

async function handleSilent(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue) {
    tellUser(msg, queue, "no active queue~ join a voice channel first")
    return
  }

  queue.silent = !queue.silent
  queue.userId = msg.author.id
  saveState()

  if (queue.silent) {
    await tellUser(msg, queue, "going quiet~ I'll whisper in DMs now")
  } else {
    await saySoft(msg.channel as any, "I'm back to talking here~")
  }
}

async function handleProxySet(msg: Message, args: string[]): Promise<void> {
  const want = (args[0] || "").toLowerCase()
  if (!want) {
    const cur = getPlatform()
    await replySoft(msg, pick([
      `we're on **${cur}** right now~ say @Mikka proxyset spotify or youtube to switch`,
      `current platform: **${cur}**~ want spotify or youtube?`,
    ]))
    return
  }
  if (want !== "spotify" && want !== "youtube") {
    await replySoft(msg, `hmm, I only know **spotify** and **youtube**~ which one?`)
    return
  }
  setPlatform(want)
  await replySoft(msg, pick([
    `switched to **${want}**~ fresh vibes incoming`,
    `**${want}** it is~ let's go`,
    `platform set to **${want}**~ play something!`,
  ]))
}

async function handleSleep(msg: Message, args: string[], guild: Guild | undefined, queue: Queue | undefined): Promise<void> {
  if (!guild || !queue) {
    await replySoft(msg, "join a voice channel and play something first~ then I'll tuck you in")
    return
  }
  const arg = (args[0] || "").toLowerCase()
  if (!arg) {
    const info = getSleepInfo(guild.id)
    if (info) {
      const left = Math.max(1, Math.round((info.endsAt - Date.now()) / 60000))
      await replySoft(msg, `sleep timer's on~ **${left}** min left before I say goodnight`)
    } else {
      await replySoft(msg, "no sleep timer set~ try @Mikka sleep 30")
    }
    return
  }
  if (arg === "off" || arg === "cancel" || arg === "stop") {
    if (cancelSleep(guild.id)) {
      await replySoft(msg, pick(["sleep timer off~ wide awake now", "cancelled~ no sleepy time"]))
    } else {
      await replySoft(msg, "there was no sleep timer running~")
    }
    return
  }
  const minutes = parseInt(arg)
  if (isNaN(minutes) || minutes < 1 || minutes > 480) {
    await replySoft(msg, "give me minutes between 1 and 480~ like @Mikka sleep 30")
    return
  }
  startSleep(guild.id, minutes, queue, async () => {
    // Goodnight: stop everything, whisper, and leave.
    try { queue.player.removeAllListeners(AudioPlayerStatus.Idle) } catch {}
    try { queue.player.stop() } catch {}
    try { queue.currentProcesses?.ff?.kill() } catch {}
    dropTemp(queue)
    queue.songs = []
    queue.playing = false
    const goodnight = pick([
      "goodnight~ sleep tight, dream sweet",
      "shhh~ off to dreamland you go",
      "night night~ I'll be here when you wake up",
      "sweet dreams~ the music fades, you drift away",
    ])
    await tellUser(msg, queue, goodnight)
    markIntentionalLeave(guild.id)
    try { queue.connection?.destroy() } catch {}
    queues.delete(guild.id)
    saveState()
  })
  await replySoft(msg, pick([
    `sleep timer set for **${minutes}** min~ I'll fade out gently and say goodnight`,
    `**${minutes}** minutes till dreamland~ volume fading slowly`,
    `got it~ **${minutes}** min, then I tuck you in`,
  ]))
}

export {
  handleTest,
  handleHelp,
  handleLeave,
  handleClearChat,
  handleClearReactions,
  handleSync,
  handleState,
  handlePanel,
  handleSilent,
  handleProxySet,
  handleSleep
}
