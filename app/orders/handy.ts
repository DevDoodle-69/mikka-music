import { joinVoiceChannel, createAudioPlayer, AudioPlayerStatus } from "@discordjs/voice"
import { watchConnection } from "../voice/watchdog"
import { clearSongTimers } from "../voice/jukebox"
import { isStayMode, setStayMode } from "../voice/stay"
import { resolveStream, downloadSnowpingMp3 } from "../web/snowping"
import { searchSpotify, resolveSpotifyDownload } from "../web/spotify"
import { Message, Guild, VoiceChannel, Channel } from "selfbotsdk-discordjs"
import { queues, saveState, createDefaultQueue, markIntentionalLeave, leaveAllVoiceSessions } from "../voice/shelf"
import { playTrack, playStation } from "../voice/jukebox"
import { removeAllReactionsFromChannel, createCommandPanel } from "../chat/panel"
import config from "../setup"
import { Queue } from "../types"
import { tellUser, replySoft, saySoft } from "../tools/say"
import * as lines from "../chat/lines"
import { getPlatform, setPlatform } from "../web/platform"
import { startSleep, startSleepMs, cancelSleep, getSleepInfo } from "../voice/sleep"
import { disconnectOwnerFromVoice } from "../voice/session"
import { dropTemp } from "../web/fetchmp3"

function handleTest(msg: Message): Promise<Message> {
  console.log("Test : ", msg)
  return replySoft(msg, lines.testReply())
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
    "**play** <playlist link> shuffle - the whole playlist, surprise order",
    "**play** <link1 link2 ...> - several links at once, I'm not shy",
    "**aiplay** <describe the vibe> [limit] - I pick the songs with AI~",
    "**playlist** play all - shuffle everything you uploaded on the dashboard",
    "**playlist** play <n> - shuffle n of your uploads (playlist list to peek)",
    "**playlist** add <link> - download a song link into your playlist",
    "**skip** - next song, no hard feelings",
    "**loop** - round and round: Off / Single / All",
    "**shuffle** - let fate pick the order",
    "**queue** - peek at what's coming up",
    "**stop** - stop playback",
    "**clear** - wipe everything: queue, playback, temp files",
    "**volume** [0-100] - louder or softer, you decide",
    "**radio** <name or link> - tune into a station",
    "**radiostats** - nerdy radio numbers",
    "**leave** - I'll slip out of the voice channel",
    "**sync** - pull me into the voice channel you're in (works from inbox too~)",
    "**state** - how I'm feeling right now",
    "**panel** - cute little control panel",
    "**silent** - shh mode: I whisper in DMs instead",
    "**sleep** <30sec|1min|1h> - fade out, say goodnight, then you AND I both leave voice (sleep off to cancel)",
    "**proxyset** <youtube|spotify> - switch music platform (auto-fallback included)",
    "tip: direct .mp3 links play too, and songs crossfade with zero gaps~",
    "**stay** - I'll hold the voice channel when you leave (off when you join elsewhere)",
    "**proxy** [next|on|off] - check or switch my outbound IP",
    "**clearchat** [number] - tidy up messages",
    "",
    "*join a voice channel first, and I'll follow you in (I take about 10 seconds, gotta look cute)~*",
    "*psst~ if I'm already singing somewhere, order me around from DMs or any other server — I'll play it right where I am*"
  ].join("\n")

  saySoft(msg.channel as any, helpEmbed)
}

async function handleLeave(msg: Message, guild: Guild | undefined, queue: Queue | undefined): Promise<void> {
  if (queue) clearSongTimers(queue)
  if (isStayMode()) setStayMode(false)
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

  await tellUser(msg, queue, lines.leaving())
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
    watchConnection(guild, queue)

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

    await tellUser(msg, queue, lines.synced())

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
    await replySoft(msg, lines.proxyQuery(cur))
    return
  }
  if (want !== "spotify" && want !== "youtube") {
    await replySoft(msg, `hmm, I only know **spotify** and **youtube**~ which one?`)
    return
  }
  setPlatform(want)
  await replySoft(msg, lines.proxySet(want))
}

/** Parse "30sec" / "1min" / "1h" / "90" (bare number = minutes) → ms. */
function parseSleepDuration(arg: string): number | null {
  const m = arg.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (isNaN(n) || n <= 0) return null
  const unit = (m[2] || "m")[0]
  const ms = unit === "s" ? n * 1000 : unit === "h" ? n * 3600_000 : n * 60_000
  if (ms < 10_000 || ms > 8 * 3600_000) return null // 10s .. 8h
  return Math.round(ms)
}

function formatSleepDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}sec`
  if (ms < 3600_000) {
    const min = ms / 60_000
    return Number.isInteger(min) ? `${min}min` : `${min.toFixed(1)}min`
  }
  const h = ms / 3600_000
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`
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
      const leftMs = Math.max(1000, info.endsAt - Date.now())
      await replySoft(msg, `sleep timer's on~ **${formatSleepDuration(leftMs)}** left before I say goodnight`)
    } else {
      await replySoft(msg, "no sleep timer set~ try `@Mikka sleep 30sec` or `@Mikka sleep 1h`")
    }
    return
  }
  if (arg === "off" || arg === "cancel" || arg === "stop") {
    if (cancelSleep(guild.id)) {
      await replySoft(msg, lines.sleepOff())
    } else {
      await replySoft(msg, "there was no sleep timer running~")
    }
    return
  }
  const totalMs = parseSleepDuration(arg)
  if (totalMs === null) {
    await replySoft(msg, "give me a time like `30sec`, `1min` or `1h` (10sec – 8h)~")
    return
  }
  const label = formatSleepDuration(totalMs)
  startSleepMs(guild.id, totalMs, queue, async () => {
    // Goodnight: stop everything, whisper, disconnect the OWNER's account
    // from voice too (via OWNER_TOKEN), then remove the bot as well.
    clearSongTimers(queue)
    try { queue.player.removeAllListeners(AudioPlayerStatus.Idle) } catch {}
    try { queue.player.stop() } catch {}
    try { queue.currentProcesses?.ff?.kill() } catch {}
    dropTemp(queue)
    queue.songs = []
    queue.playing = false
    const goodnight = lines.goodnight()
    await tellUser(msg, queue, goodnight)
    // Owner leaves the voice channel as well — not just the bot.
    await disconnectOwnerFromVoice(guild.id)
    markIntentionalLeave(guild.id)
    try { queue.connection?.destroy() } catch {}
    queues.delete(guild.id)
    saveState()
  })
  await replySoft(msg, `sleep timer set for **${label}**~ I'll fade out, say goodnight, and we'll both leave voice`)
}

async function handleStay(msg: Message): Promise<void> {
  const on = !isStayMode()
  setStayMode(on)
  if (on) {
    await replySoft(msg, lines.stayOn())
  } else {
    await replySoft(msg, lines.stayOff())
  }
}

async function handleDiag(msg: Message): Promise<void> {
  const out: string[] = []
  out.push("running diagnostics~ one sec")

  // 1. YouTube API resolve
  try {
    const t = await resolveStream("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 20000)
    out.push(`youtube API: OK (${t.title.slice(0, 30)})`)
    // 2. YouTube file download (first 64KB only)
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 20000)
      const dl = await fetch(t.streamUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0" },
      })
      out.push(`youtube download: HTTP ${dl.status} (${dl.headers.get("content-type")})`)
    } catch (e: any) {
      out.push(`youtube download: FAIL ${(e.message || e).slice(0, 80)}`)
    }
  } catch (e: any) {
    out.push(`youtube API: FAIL ${(e.message || e).slice(0, 80)}`)
  }

  // 3. Spotify API resolve
  try {
    const dl = await resolveSpotifyDownload("https://open.spotify.com/track/709ZIqPHyFOpx2QdjmeWAM")
    out.push(`spotify API: OK (${dl.title.slice(0, 30)})`)
    // 4. Spotify file download (headers only)
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 20000)
      const res = await fetch(dl.downloadUrl, {
        signal: ctrl.signal,
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0" },
      })
      out.push(`spotify download: HTTP ${res.status} (${res.headers.get("content-type")})`)
    } catch (e: any) {
      out.push(`spotify download: FAIL ${(e.message || e).slice(0, 80)}`)
    }
  } catch (e: any) {
    out.push(`spotify API: FAIL ${(e.message || e).slice(0, 80)}`)
  }

  await replySoft(msg, out.join("\n"))
}

async function handleProxy(msg: Message, args: string[]): Promise<void> {
  const { proxyCount, isProxyEnabled, currentProxy, nextProxy, setProxyEnabled, checkOutboundIp } =
    await import("../web/proxy")

  const sub = (args[0] || "").toLowerCase()

  if (sub === "next") {
    const p = nextProxy()
    if (!p) {
      await msg.channel.send("no proxies configured~ set PROXY_LIST on Render first")
      return
    }
    const ip = await checkOutboundIp()
    await msg.channel.send(`switched IP~ now coming from **${ip}** via ${p.masked}`)
    return
  }
  if (sub === "off") {
    setProxyEnabled(false)
    await msg.channel.send("proxy off~ back to direct connection")
    return
  }
  if (sub === "on") {
    if (proxyCount() === 0) {
      await msg.channel.send("no proxies configured~ set PROXY_LIST on Render first")
      return
    }
    setProxyEnabled(true)
    const ip = await checkOutboundIp()
    await msg.channel.send(`proxy on~ outbound IP is **${ip}**`)
    return
  }
  // Status
  const count = proxyCount()
  if (count === 0) {
    await msg.channel.send("no proxies set~ add PROXY_LIST in Render env vars to enable IP switching")
    return
  }
  const cur = currentProxy()
  const ip = await checkOutboundIp()
  await msg.channel.send(
    `proxy **${isProxyEnabled() ? "ON" : "OFF"}** — ${count} configured\n` +
    `current: ${cur?.masked || "none"}\n` +
    `outbound IP: **${ip}**\n` +
    `use \`proxy next\` to switch IP, \`proxy off\` to go direct`
  )
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
  handleSleep,
  handleStay,
  handleDiag,
  handleProxy
}
