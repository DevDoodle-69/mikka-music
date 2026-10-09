import { logline } from "../tools/log"
import { joinVoiceChannel, createAudioPlayer, AudioPlayerStatus } from "@discordjs/voice"
import { spawn } from "child_process"
import fs from "fs"
import { Message, Guild, VoiceChannel, MessageAttachment } from "selfbotsdk-discordjs"
import { queues, saveState, createDefaultQueue, isConnectionLive, leaveAllVoiceSessions } from "../voice/shelf"
import { playTrack, clearSongTimers } from "../voice/jukebox"
import { findTrack, linkTrack, v3Playlist } from "../web/tube"
import { descriptionToQuery, descriptionToPlaylist } from "../web/brain"
import { formatDuration } from "../tools/timefmt"
import config from "../setup"
import { Queue, PlaylistVideoEntry, Song } from "../types"
import { tellUser, stripEmojis } from "../tools/say"
import * as lines from "../chat/lines"
import { dropTemp } from "../web/fetchmp3"
import { watchConnection } from "../voice/watchdog"
import { searchSpotify, findOnSpotify, resolveSpotifyPlaylist } from "../web/spotify"
import { getPlatform } from "../web/platform"

interface PlaylistJSON {
  entries: Array<{
    title?: string
    id?: string
    duration?: number
  }>
}

async function playlistViaYtdlp(url: string): Promise<PlaylistVideoEntry[]> {
  return new Promise((resolve, reject) => {
    const ytdlpArgs: string[] = ["--dump-single-json", "--flat-playlist", "--js-runtimes", "node"]

    if (fs.existsSync(config.cookiesFile)) {
      console.log("Cookie masuk (playlist)")
      ytdlpArgs.push("--cookies", config.cookiesFile)
    }

    ytdlpArgs.push(url)

    const ytdlp = spawn(config.ytdlpExecutable, ytdlpArgs)

    let output = ""
    let errorOutput = ""
    ytdlp.stdout!.on("data", (data: Buffer) => { output += data.toString() })
    ytdlp.stderr!.on("data", (data: Buffer) => { errorOutput += data.toString() })

    ytdlp.on("close", (code: number | null) => {
      if (code !== 0) {
        console.error("yt-dlp stderr:", errorOutput)
        reject(new Error("yt-dlp failed: " + errorOutput))
        return
      }

      try {
        const data: PlaylistJSON = JSON.parse(output)
        const videos = data.entries
          .filter(video => video && video.title && video.id)
          .map(video => ({
            title: video.title!,
            url: `https://www.youtube.com/watch?v=${video.id}`,
            duration: video.duration || 0,
            durationFormatted: formatDuration(video.duration ?? null)
          }))
        resolve(videos)
      } catch (err) {
        console.error("Error parsing JSON:", err)
        reject(new Error("Failed to parse yt-dlp JSON output"))
      }
    })

    ytdlp.on("error", reject)
  })
}

/**
 * Resolve a playlist: YouTube Data v3 first (clean, paginated),
 * yt-dlp flat-playlist as backup.
 */
async function resolvePlaylist(url: string): Promise<Song[]> {
  if (config.youtubeApiKey) {
    try {
      console.log("[tube] v3 playlist:", url)
      const tracks = await v3Playlist(url)
      return tracks.map((t) => ({
        title: t.title,
        url: t.url,
        duration: t.duration,
        durationFormatted: t.durationFormatted
      }))
    } catch (err) {
      console.log("[tube] v3 playlist failed, trying yt-dlp:", (err as Error).message)
    }
  }
  return playlistViaYtdlp(url)
}

/**
 * Shared tail: join voice if needed, push songs to the queue, start playing.
 * Used by handlePlay and handleAiPlay.
 */
async function enqueueAndPlay(msg: Message, guild: Guild, voice: VoiceChannel | null, queue: Queue | undefined, songs: Song[]): Promise<Queue | undefined> {
  if (!queue || !isConnectionLive(queue)) {
    if (!voice) {
      await tellUser(msg, queue, "join a voice channel first, silly~ I can't sing to an empty room")
      return
    }
    // Tear down any dead connection before (re)joining. Single voice session:
    // leave every other guild first or Discord yanks sessions and audio dies.
    // Always start a fresh audio player — a reused one can be stuck "playing"
    // into the void.
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
      // Stale queue shell: revive it in the new voice channel, keep the songs.
      queue.connection = connection
      queue.player = player
      queue.voiceChannelId = voice.id
      queue.textChannel = playbackChannel as any
      queue.userId = msg.author.id
    }
  }

  if (queue.radioFfmpeg) {
    queue.radioFfmpeg.kill()
    queue.radioFfmpeg = null
  }
  queue.radioStopped = true
  queue.playing = false
  queue.isReconnecting = false
  queue.isMusicReconnecting = false
  queue.musicReconnectAttempts = 0
  queue.musicReconnectMessage = null

  queue.songs.push(...songs)
  logline("music", `+${songs.length} song(s) → queue total ${queue.songs.length}`)
  saveState()
  console.log(`💾 State saved. Queue songs count: ${queue.songs.length}`)

  if (queue.player.state.status === AudioPlayerStatus.Idle) {
    playTrack(guild, queue.songs[0])
  }
  return queue
}

/**
 * @Mikka aiplay <description> [limit]
 * AI-powered play: describe the mood/topic, AI picks the song(s).
 * e.g. "@Mikka aiplay sad lofi for rainy night"
 * e.g. "@Mikka aiplay upbeat workout songs 5"
 */
async function handleAiPlay(msg: Message, args: string[], guild: Guild, voice: VoiceChannel | null, queue: Queue | undefined): Promise<void> {
  if (args.length === 0) {
    await tellUser(msg, queue, "describe what you want to hear~ like @Mikka aiplay chill jazz for sunday morning")
    return
  }

  // Last arg might be a limit number.
  let limit = 1
  let descArgs = args
  const lastArg = args[args.length - 1]
  if (/^\d+$/.test(lastArg) && args.length > 1) {
    limit = Math.min(Math.max(parseInt(lastArg), 1), 25)
    descArgs = args.slice(0, -1)
  }
  const description = descArgs.join(" ")

  await tellUser(msg, queue, `ooh, let me think about what fits "${description}"~`)

  let songs: Song[] = []
  try {
    if (limit === 1) {
      const query = await descriptionToQuery(description)
      if (!query) throw new Error("AI couldn't think of a song")
      await tellUser(msg, queue, `I picked **${query}** for you~`)
      const songData = await findTrack(query)
      songs.push({
        title: songData.title,
        url: songData.url,
        duration: songData.duration,
        durationFormatted: songData.durationFormatted
      })
    } else {
      const queries = await descriptionToPlaylist(description, limit)
      if (queries.length === 0) throw new Error("AI couldn't build the playlist")
      await tellUser(msg, queue, `made you a ${queries.length}-song playlist~ hunting them down one by one`)
      for (const q of queries) {
        try {
          const songData = await findTrack(q)
          songs.push({
            title: songData.title,
            url: songData.url,
            duration: songData.duration,
            durationFormatted: songData.durationFormatted
          })
        } catch {
          logline("music", `aiplay: couldn't find "${q.slice(0, 40)}", skipping`)
        }
      }
      if (songs.length === 0) throw new Error("couldn't find any of the songs")
      await tellUser(msg, queue, `found ${songs.length} of them~ enjoy your vibe`)
    }
  } catch (err: any) {
    await tellUser(msg, queue, `hmm, my brain glitched~ ${(err.message || "try again?").slice(0, 80)}`)
    return
  }

  if (songs.length === 0) {
    await tellUser(msg, queue, "couldn't find anything for that vibe~ try describing it differently?")
    return
  }

  await enqueueAndPlay(msg, guild, voice, queue, songs)
}

async function handlePlay(msg: Message, args: string[], guild: Guild, voice: VoiceChannel | null, queue: Queue | undefined): Promise<void> {
  const query = args.join(" ")

  if (!query) {
    await tellUser(msg, queue, "tell me what to play first~ like @Mikka play <song name or link>")
    return
  }

  let songs: Song[] = []
  let limit: number | null = null

  const urls = query.split(" ").filter(part => part.startsWith("http"))

  if (urls.length > 1) {
    await tellUser(msg, queue, `ooh, ${urls.length} links at once? greedy~ let me grab them all`)

    for (const url of urls) {
      try {
        if (/\.(mp3|m4a|ogg|oga|wav|flac|opus|aac|m3u8)(\?|#|$)/i.test(url) || (/^https?:\/\//i.test(url) && !/youtube\.com|youtu\.be|spotify\.com/i.test(url) && !url.includes("list="))) {
          const fname = decodeURIComponent((url.split("/").pop() || "audio file").split("?")[0])
          songs.push({ title: fname.replace(/\.(mp3|m4a|ogg|oga|wav|flac|opus|aac|m3u8)$/i, ""), url, platform: "direct" })
        } else if (/open\.spotify\.com\/(playlist|album)/.test(url)) {
          const tracks = await resolveSpotifyPlaylist(url)
          for (const t of tracks) songs.push({ title: t.name, url: t.url, platform: "spotify", duration: t.duration || 0, durationFormatted: t.durationFormatted || "" })
        } else if (/open\.spotify\.com\/(track|episode)/.test(url)) {
          const m = url.match(/open\.spotify\.com\/(?:track|episode)\/([A-Za-z0-9]+)/)
          const tracks = await searchSpotify(m ? m[1] : url, 1)
          if (tracks[0]) songs.push({ title: tracks[0].name, url: tracks[0].url, thumbnail: tracks[0].image, platform: "spotify", duration: tracks[0].duration || 0, durationFormatted: tracks[0].durationFormatted || "" })
        } else if (url.includes("list=")) {
          await tellUser(msg, queue, "ooh, a playlist~ let me unwrap it for you")
          const playlistSongs = await resolvePlaylist(url)
          songs.push(...playlistSongs)
        } else {
          const songData = await findTrack(url)
          songs.push({
            title: songData.title,
            url: songData.url,
            duration: songData.duration,
            durationFormatted: songData.durationFormatted
          })
        }
      } catch (error) {
        console.error(`Error processing URL ${url}:`, error)
        await tellUser(msg, queue, "hmm, that link misbehaved~ skipping it")
      }
    }

    await tellUser(msg, queue, lines.bulkAdded(songs.length))

  } else if (query.startsWith("http")) {
    const parts = query.split(" ")
    const url = parts[0]
    const rest = parts.slice(1).map((x) => x.toLowerCase())
    const wantShuffle = rest.includes("shuffle")
    const numPart = rest.find((x) => /^\d+$/.test(x))
    limit = numPart ? parseInt(numPart) : null

    if (url.includes("list=")) {
      await tellUser(msg, queue, "unwrapping your playlist~ one sec")
      try {
        songs = await resolvePlaylist(url)
      } catch (error) {
        console.error("Error fetching playlist:", error)
        await tellUser(msg, queue, "that playlist wouldn't open for me~ try another one?")
        saveState()
        return
      }

      if (getPlatform() === "spotify" && songs.length > 0) {
        // Cross-platform: find each YouTube track on Spotify instead.
        await tellUser(msg, queue, `mapping **${songs.length}** songs to spotify~ one sec`)
        const mapped: Song[] = []
        for (const song of songs) {
          const hit = await findOnSpotify(song.title)
          if (hit) {
            mapped.push({ title: hit.name, url: hit.url, thumbnail: hit.image, platform: "spotify" })
          } else {
            mapped.push(song) // keep the YouTube original as fallback
          }
        }
        songs = mapped
        logline("music", `playlist cross-mapped to spotify: ${songs.filter(x => x.platform === "spotify").length}/${songs.length}`)
      }
      if (limit && limit > 0) {
        songs = songs.slice(0, limit)
      }
      if (wantShuffle && songs.length > 1) {
        // Fisher-Yates: every song plays, but in surprise order.
        for (let i = songs.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[songs[i], songs[j]] = [songs[j], songs[i]]
        }
        logline("music", `playlist shuffled: ${songs.length} songs`)
        await tellUser(msg, queue, `shuffled **${songs.length}** songs~ every one will play, in surprise order`)
      } else if (limit && limit > 0) {
        await tellUser(msg, queue, `added **${songs.length}** songs~ kept it to ${limit} like you asked`)
      } else {
        await tellUser(msg, queue, lines.playlistUnwrapped(songs.length))
      }
    } else {
      try {
        if (/\.(mp3|m4a|ogg|oga|wav|flac|opus|aac|m3u8)(\?|#|$)/i.test(url) || (/^https?:\/\//i.test(url) && !/youtube\.com|youtu\.be|spotify\.com/i.test(url) && !url.includes("list="))) {
          // Direct audio file: download and play, no search needed.
          const fname = decodeURIComponent((url.split("/").pop() || "audio file").split("?")[0])
          songs.push({ title: fname.replace(/\.(mp3|m4a|ogg|oga|wav|flac|opus|aac|m3u8)$/i, ""), url, platform: "direct" })
          await tellUser(msg, queue, `grabbing that audio file for you~`)
        } else if (/open\.spotify\.com\/(playlist|album)/.test(url)) {
          // Spotify playlist/album: unwrap via embed page, queue each track.
          const tracks = await resolveSpotifyPlaylist(url)
          for (const t of tracks) {
            songs.push({ title: t.name, url: t.url, platform: "spotify", duration: t.duration || 0, durationFormatted: t.durationFormatted || "" })
          }
          await tellUser(msg, queue, lines.playlistUnwrapped(tracks.length))
        } else if (/open\.spotify\.com\/(track|episode)/.test(url)) {
          // Spotify link: search it to get clean metadata, play via Spotify.
          const m = url.match(/open\.spotify\.com\/(?:track|episode)\/([A-Za-z0-9]+)/)
          const tracks = await searchSpotify(m ? m[1] : url, 1)
          const t = tracks[0]
          if (!t) throw new Error("spotify track not found")
          songs.push({ title: t.name, url: t.url, thumbnail: t.image, platform: "spotify", duration: t.duration || 0, durationFormatted: t.durationFormatted || "" })
        } else {
          // Direct links bypass yt-dlp entirely (no YouTube bot wall)
          const songData = await linkTrack(url)
          songs.push({
            title: songData.title,
            url: songData.url,
            duration: songData.duration,
            durationFormatted: songData.durationFormatted
          })
        }
        await tellUser(msg, queue, await lines.songAddedFresh(songs[0].title))
      } catch (error) {
        console.error("Error fetching single URL:", error)
        await tellUser(msg, queue, "couldn't open that link~ is it valid?")
        saveState()
        return
      }
    }
  } else {
    try {
      if (getPlatform() === "spotify") {
        const tracks = await searchSpotify(query, 1)
        if (tracks.length === 0) throw new Error("no spotify results")
        const t = tracks[0]
        songs.push({ title: t.name, url: t.url, thumbnail: t.image, platform: "spotify", duration: t.duration || 0, durationFormatted: t.durationFormatted || "" })
      } else {
        const songData = await findTrack(query)
        songs.push({
          title: songData.title,
          url: songData.url,
          duration: songData.duration,
          durationFormatted: songData.durationFormatted
        })
      }
      await tellUser(msg, queue, await lines.songAddedFresh(songs[0].title))
    } catch (error) {
      console.error("Error searching for song:", error)
      await tellUser(msg, queue, `couldn't find anything for "${query}"~ try another name?`)
      saveState()
      return
    }
  }

  if (songs.length === 0) {
    saveState()
    return
  }

  await enqueueAndPlay(msg, guild, voice, queue, songs)
}


async function handleSkip(msg: Message, queue: Queue | undefined): Promise<void> {
  if (queue) {
    queue.isSkipping = true
    clearSongTimers(queue)
    if (queue.currentProcesses) {
      queue.currentProcesses.ytdlp?.kill()
      queue.currentProcesses.ff.kill()
      dropTemp(queue)
    }
    queue.player.stop()
    saveState()
    await tellUser(msg, queue, lines.skipped())
  }
}

async function handleLoop(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue) {
    await tellUser(msg, queue, "nothing's playing right now~")
    return
  }
  queue.loopMode = ((queue.loopMode || 0) + 1) % 3
  const modes = ["Off", "Single", "All"]
  await tellUser(msg, queue, lines.loopMode(modes[queue.loopMode]))
  saveState()
}

async function handleShuffle(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue || queue.songs.length < 3) {
    await tellUser(msg, queue, "need at least 2 songs to shuffle, cutie~")
    return
  }

  const playing = queue.songs.shift()
  for (let i = queue.songs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]]
  }
  if (playing) queue.songs.unshift(playing)
  await tellUser(msg, queue, lines.shuffled())
  saveState()
}

async function handleQueue(msg: Message, queue: Queue | undefined): Promise<void> {
  if (!queue || queue.songs.length === 0) {
    await tellUser(msg, queue, "the queue's empty~ add something with @Mikka play")
    return
  }

  const modes = ["Off", "Single", "All"]
  const loopStatus = modes[queue.loopMode || 0]
  const currentSong = queue.currentSong

  // Build .txt content
  let txtContent = ""

  if (currentSong) {
    txtContent += `Now Playing: ${currentSong.title}\n`
    txtContent += `${currentSong.url}\n`
    txtContent += `${"=".repeat(50)}\n\n`
  }

  txtContent += `Queue (${queue.songs.length} songs) | Loop: ${loopStatus}\n`
  txtContent += `${"=".repeat(50)}\n\n`

  queue.songs.forEach((song, i) => {
    const title = song?.title || "Unknown Song"
    const duration = song?.durationFormatted || "Unknown"
    const url = song?.url || "No URL"
    txtContent += `${i + 1}. ${title}\n`
    txtContent += `   Duration: ${duration}\n`
    txtContent += `   ${url}\n\n`
  })

  const buffer = Buffer.from(txtContent, "utf-8")
  const attachment = new MessageAttachment(buffer, "queue.txt")

  // Kirim preview singkat + file .txt
  const rawPreview = `here's our little lineup~ (${queue.songs.length} songs${currentSong ? ` | now playing: **${currentSong.title}**` : ""} | loop: ${loopStatus}) - details in \`queue.txt\``
  const preview = stripEmojis(rawPreview)

  if (queue?.silent) {
    try {
      await msg.author.send({ content: preview, files: [attachment] })
    } catch {
      await msg.channel.send({ content: preview, files: [attachment] }).catch(() => {})
    }
  } else {
    await msg.channel.send({ content: preview, files: [attachment] })
  }
}

async function handleStop(msg: Message, queue: Queue | undefined): Promise<void> {
  if (queue) clearSongTimers(queue)
  if (!queue) {
    await tellUser(msg, queue, "nothing's playing at the moment~")
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

  queue.radioStopped = true
  queue.playing = false
  queue.isReconnecting = false
  queue.isMusicReconnecting = false
  queue.radioUrl = null
  queue.radioName = null
  queue.hasReactionUI = false
  queue.radioMessage = undefined
  queue.musicReconnectMessage = null
  queue.songs = []
  queue.player.stop()
  saveState()
  await tellUser(msg, queue, lines.stopped())
}

async function handleVolume(msg: Message, args: string[], queue: Queue | undefined): Promise<void> {
  if (!queue) {
    await tellUser(msg, queue, "nothing's playing though~")
    return
  }
  const volArg = args[0]
  if (!volArg) {
    await tellUser(msg, queue, `volume's at **${Math.round((queue.volume ?? 1.0) * 100)}%**~`)
    return
  }

  let vol = parseFloat(volArg)
  if (isNaN(vol)) {
    await tellUser(msg, queue, "give me a number between 0 and 100~")
    return
  }
  if (vol > 1) vol = vol / 100
  if (vol < 0) vol = 0
  if (vol > 5) vol = 5

  queue.volume = vol

  if (queue.player.state.status === AudioPlayerStatus.Playing && queue.player.state.resource?.volume) {
    queue.player.state.resource.volume.setVolume(vol)
  }

  saveState()
  await tellUser(msg, queue, lines.volumeSet(Math.round(vol * 100)))
}

export {
  handlePlay,
  handleAiPlay,
  handleSkip,
  handleLoop,
  handleShuffle,
  handleQueue,
  handleStop,
  handleVolume,
  playlistViaYtdlp
}
