import { createAudioResource, AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus } from "@discordjs/voice"
import { spawn } from "child_process"
import { Readable } from "stream"
import fs from "fs"
import config from "../setup"
import { queues, saveState } from "./shelf"
import { Song, Processes } from "../types"
import { tellChannel, pick } from "../tools/say"
import { logline, logerr } from "../tools/log"
import { formatDuration } from "../tools/timefmt"
import { fetchMp3, grabMp3, dropTemp } from "../web/fetchmp3"
import { resolveStream } from "../web/snowping"

interface StreamWithProcesses extends Readable {
  processes: Processes
}

/**
 * Stream audio straight from a remote URL (e.g. snowping MP3 link).
 * No temp file — ffmpeg pulls and transcodes on the fly.
 */
function pipeUrl(mediaUrl: string, seekTime: number | null = null): StreamWithProcesses {
  const ffArgs: string[] = []

  if (seekTime) {
    const hh = Math.floor(seekTime / 3600)
    const mm = Math.floor((seekTime % 3600) / 60)
    const ss = Math.floor(seekTime % 60)
    ffArgs.push("-ss", `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`)
  }

  ffArgs.push(
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", mediaUrl,
    "-f", "opus",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  )

  const ff = spawn(config.ffmpeg, ffArgs)

  ff.stderr!.on("data", (data: Buffer) => { console.error("ffmpeg-url stderr:", data.toString().slice(0, 500)) })
  ff.on("error", (err: Error) => { console.error("ffmpeg-url error:", err) })
  ff.on("close", (code: number | null) => {
    if (code !== 0 && code !== null) console.error("ffmpeg-url exited with code:", code)
  })

  const outStream = ff.stdout as unknown as StreamWithProcesses
  outStream.processes = { ff }
  return outStream
}

function pipeFile(filePath: string, seekTime: number | null = null): StreamWithProcesses {
  const ffArgs: string[] = []

  if (seekTime) {
    const hh = Math.floor(seekTime / 3600)
    const mm = Math.floor((seekTime % 3600) / 60)
    const ss = Math.floor(seekTime % 60)
    ffArgs.push("-ss", `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`)
  }

  ffArgs.push(
    "-i", filePath,
    "-f", "opus",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  )

  const ff = spawn(config.ffmpeg, ffArgs)

  ff.stderr!.on("data", (data: Buffer) => { console.error("ffmpeg stderr:", data.toString()) })
  ff.on("error", (err: Error) => { console.error("ffmpeg error:", err) })
  ff.on("close", (code: number | null) => {
    if (code !== 0 && code !== null) console.error("ffmpeg exited with code:", code)
  })

  const outStream = ff.stdout as unknown as StreamWithProcesses
  outStream.processes = { ff }
  return outStream
}

function fixStreamError(guild: any, song: Song, source: string, error: Error | null = null): void {
  const queue = queues.get(guild.id)
  if (!queue) return

  if (queue.songs[0] && queue.songs[0].url !== song.url) return

  console.log(`[music] ${source} failed, attempting reconnect...`)
  if (error) console.log(`[music] Error details:`, error.message || error)

  const isBrokenPipe = error && (
    (error.message && (
      error.message.includes("Broken pipe") ||
      error.message.includes("EPIPE") ||
      error.message.includes("Connection reset") ||
      error.message.includes("Connection timed out")
    )) ||
    (error as NodeJS.ErrnoException).code === "EPIPE" ||
    (error as NodeJS.ErrnoException).code === "ECONNRESET"
  )

  if (isBrokenPipe) {
    console.log(`[music] Broken pipe detected in ${source}, will attempt aggressive reconnect...`)
  }

  queue.isMusicReconnecting = true
  queue.musicReconnectAttempts++

  const MAX_MUSIC_RECONNECT_ATTEMPTS = isBrokenPipe ? 5 : 3

  if (queue.musicReconnectAttempts >= MAX_MUSIC_RECONNECT_ATTEMPTS) {
    const errorMsg = isBrokenPipe
      ? `lost that one after ${MAX_MUSIC_RECONNECT_ATTEMPTS} tries~ moving to the next song`
      : `couldn't get that song to play~ skipping ahead`

    tellChannel(queue, errorMsg)
    queue.musicReconnectAttempts = 0
    queue.isMusicReconnecting = false
    queue.musicReconnectMessage = null
    queue.songs.shift()
    if (queue.songs.length > 0) {
      playTrack(guild, queue.songs[0])
    }
    return
  }

  const baseDelay = isBrokenPipe ? 1500 : 3000
  const delay = Math.min(baseDelay * Math.pow(2, queue.musicReconnectAttempts - 1), 10000)
  const reconnectText = `oops, the music tripped~ trying again (${queue.musicReconnectAttempts}/${MAX_MUSIC_RECONNECT_ATTEMPTS})`

  if (queue.musicReconnectMessage) {
    queue.musicReconnectMessage.edit(reconnectText).catch(console.error)
  } else {
    tellChannel(queue, reconnectText).then((msg) => {
      queue.musicReconnectMessage = msg
    }).catch(console.error)
  }

  setTimeout(() => {
    const currentQueue = queues.get(guild.id)
    if (currentQueue && !currentQueue.radioStopped && currentQueue.connection?.state.status === "ready") {
      if (currentQueue.songs[0] && currentQueue.songs[0].url === song.url) {
        console.log(`[music] Attempting to reconnect to: ${song.title}`)
        queue.isMusicReconnecting = false
        playTrack(guild, song)
      } else {
        queue.isMusicReconnecting = false
        queue.musicReconnectAttempts = 0
        if (queue.musicReconnectMessage) {
          queue.musicReconnectMessage.delete().catch(() => {})
          queue.musicReconnectMessage = null
        }
      }
    } else {
      queue.isMusicReconnecting = false
    }
  }, delay)
}

async function playTrack(guild: any, song: Song | undefined): Promise<void> {
  const queue = queues.get(guild.id)
  if (!queue) return

  const { removeReactionUI } = await import("../chat/panel")

  if (!song) {
    queue.playing = false
    dropTemp(queue)

    if (queue.currentProcesses) {
      queue.currentProcesses.ytdlp?.kill()
      queue.currentProcesses.ff.kill()
    }
    if (queue.reactionCollector && typeof queue.reactionCollector.stop === "function") {
      queue.reactionCollector.stop()
      queue.reactionCollector = null
    }
    if (queue.reactionMessage) {
      await removeReactionUI(queue.reactionMessage, null)
      queue.reactionMessage = undefined
    }
    if (queue.radioUrl && queue.radioName) {
      queue.radioStopped = false
      tellChannel(queue, "songs are done~ back to the radio for you")
      playStation(guild, queue.radioUrl, queue.radioName)
      return
    }
    tellChannel(queue, "that's everything~ the queue is all done")
    return
  }

  console.log("Playing:", song)

  queue.playing = true

  queue.playHistory.unshift({
    title: song.title,
    url: song.url,
    playedAt: new Date().toISOString(),
    isRadio: false
  })
  if (queue.playHistory.length > 10) {
    queue.playHistory = queue.playHistory.slice(0, 10)
  }

  if (queue.currentProcesses) {
    queue.currentProcesses.ytdlp?.kill()
    queue.currentProcesses.ff.kill()
  }
  dropTemp(queue)

  let seekTime: number | null = null
  if (song.resumeFrom) {
    seekTime = song.resumeFrom
    console.log(`Resuming from ${seekTime} seconds`)
    delete song.resumeFrom
  }

  // PRIMARY: snowping API -> direct MP3 stream URL -> ffmpeg straight
  // into voice. No download, no temp file, no API key.
  // BACKUP: the downloader API (MP3_API_KEY), only if configured.
  await tellChannel(queue, pick([`fetching **${song.title}** for you~ one sec`, `on it~ grabbing **${song.title}**`, `let me get **${song.title}** ready~`]))
  let audio: StreamWithProcesses | null = null
  let lastError = ""
  try {
    const track = await resolveStream(song.url)
    if (track.title && track.title !== "Unknown title") song.title = track.title
    console.log(`[music] streaming directly from snowping for "${song.title}"`)
    audio = pipeUrl(track.streamUrl, seekTime)
    queue.currentTempFile = null
  } catch (err) {
    lastError = (err as Error).message || "stream resolve failed"
    logerr("music", "snowping failed, falling back:", lastError)
  }
  if (!audio && config.mp3ApiKey) {
    try {
      await tellChannel(queue, `stream hiccup~ trying the backup way for **${song.title}**`)
      const mp3 = await fetchMp3(song.url)
      if (mp3.title && mp3.title !== "Unknown title") song.title = mp3.title
      if (mp3.duration > 0) {
        song.duration = mp3.duration
        song.durationFormatted = formatDuration(mp3.duration)
      }
      const tmpPath = await grabMp3(mp3.link, mp3.proxyUrl)
      queue.currentTempFile = tmpPath
      audio = pipeFile(tmpPath, seekTime)
    } catch (err) {
      lastError = (err as Error).message || "backup failed"
      logerr("music", "backup downloader API failed:", lastError)
    }
  }
  if (!audio) {
    const blocked = /sign in|not a bot|429|too many requests|forbidden|sabr|all download layers failed/i.test(lastError)
    const cookiesSet = fs.existsSync(config.cookiesFile)
    if (blocked && !cookiesSet) {
      await tellChannel(queue, `youtube's blocking my downloads right now~ set **YOUTUBE_COOKIES** on Render (your logged-in YouTube cookies) and I'll slip right through`)
    } else {
      await tellChannel(queue, `couldn't grab **${song.title}** anywhere~ skipping ahead`)
    }
    logerr("music", `all audio sources failed for ${song.url}:`, lastError)
    queue.playing = false
    dropTemp(queue)
    queue.songs.shift()
    if (queue.songs.length > 0) playTrack(guild, queue.songs[0])
    return
  }

  // Never play into the void: the voice connection must actually be ready.
  // ("now spinning" with no audible audio almost always means the connection
  // never became ready.)
  const conn = queue.connection as any
  if (!conn || conn.state?.status === VoiceConnectionStatus.Destroyed) {
    logerr("music", "no live voice connection — refusing to play into the void")
    queue.playing = false
    dropTemp(queue)
    await tellChannel(queue, "hmm, I lost my voice connection~ ask me to rejoin?")
    return
  }
  if (conn.state?.status !== VoiceConnectionStatus.Ready) {
    console.log(`[music] voice connection is "${conn.state?.status}", waiting for ready...`)
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 12_000)
    } catch {
      console.error("[music] voice connection never became ready")
      queue.playing = false
      dropTemp(queue)
      await tellChannel(queue, "I can't get a clear voice line in this channel~ try having me rejoin?")
      return
    }
  }

  const startedAt = seekTime
    ? new Date(Date.now() - seekTime * 1000).toISOString()
    : new Date().toISOString()
  queue.currentSong = {
    title: song.title,
    url: song.url,
    startedAt,
    isRadio: false
  }

  const resource = createAudioResource(audio, { inlineVolume: true })
  resource.volume?.setVolume(queue.volume ?? 1.0)

  queue.currentProcesses = audio.processes

  audio.processes.ff.on("error", (err: Error) => {
    if (queue.currentProcesses !== audio.processes) return
    console.error("ffmpeg error:", err)
    if (!queue.isMusicReconnecting && !queue.radioStopped) {
      fixStreamError(guild, song, "ffmpeg", err)
    }
  })

  audio.processes.ytdlp?.on("error", (err: Error) => {
    if (queue.currentProcesses !== audio.processes) return
    console.error("yt-dlp fallback error:", err)
    if (!queue.isMusicReconnecting && !queue.radioStopped) {
      fixStreamError(guild, song, "yt-dlp", err)
    }
  })

  audio.processes.ytdlp?.on("close", (code: number | null) => {
    if (queue.currentProcesses !== audio.processes) return
    if (code !== 0 && code !== null && !queue.isMusicReconnecting && !queue.radioStopped) {
      console.error("yt-dlp fallback exited with code:", code)
      const error = new Error(`yt-dlp exited with code ${code}`)
      ;(error as NodeJS.ErrnoException).code = String(code)
      fixStreamError(guild, song, "yt-dlp", error)
    }
  })

  audio.processes.ff.on("close", (code: number | null) => {
    if (queue.currentProcesses !== audio.processes) return
    if (code !== 0 && code !== null && !queue.isMusicReconnecting && !queue.radioStopped) {
      console.error("ffmpeg exited with code:", code)
      const error = new Error(`ffmpeg exited with code ${code}`)
      ;(error as NodeJS.ErrnoException).code = String(code)
      fixStreamError(guild, song, "ffmpeg", error)
    }
  })

  queue.player.play(resource)

  queue.player.removeAllListeners("error")
  queue.connection?.removeAllListeners("error")

  queue.player.on("error", (err: Error) => {
    if (queue.currentProcesses !== audio.processes) return
    console.error("Audio player error:", err)
    if (!queue.isMusicReconnecting && !queue.radioStopped) {
      fixStreamError(guild, song, "player", err)
    }
  })

  queue.connection?.on("error", (err: Error) => {
    console.error("Voice connection error:", err)
    tellChannel(queue, "lost the voice connection~ stopping the music")
    queue.player.stop()
  })

  const durStr = song.durationFormatted
    ? ` [${song.durationFormatted}]`
    : song.duration
      ? ` [${Math.floor(song.duration / 60)}:${(song.duration % 60).toString().padStart(2, "0")}]`
      : ""
  await tellChannel(queue, pick([`now spinning **${song.title}**${durStr}~ this one's for you`, `**${song.title}**${durStr}~ sing along with me`, `ooh I love this one~ **${song.title}**${durStr}`]))
  saveState()

  if (queue._saveInterval) clearInterval(queue._saveInterval)
  queue._saveInterval = setInterval(() => {
    if (queue.playing && queue.currentSong && !queue.currentSong.isRadio) {
      saveState(false)
    }
  }, 15000)

  queue.player.once(AudioPlayerStatus.Idle, () => {
    if (queue._saveInterval) {
      clearInterval(queue._saveInterval)
      queue._saveInterval = undefined
    }

    if (queue.currentProcesses) {
      queue.currentProcesses.ytdlp?.kill()
      queue.currentProcesses.ff.kill()
    }
    dropTemp(queue)

    if (queue.isMusicReconnecting) {
      queue.playing = false
      return
    }

    queue.playing = false
    queue.musicReconnectAttempts = 0
    queue.musicReconnectMessage = null

    if (queue.isSkipping || (queue.loopMode || 0) === 0) {
      queue.songs.shift()
      queue.isSkipping = false
    } else if (queue.loopMode === 2) {
      const shiftedSong = queue.songs.shift()
      if (shiftedSong) queue.songs.push(shiftedSong)
    }

    playTrack(guild, queue.songs[0])
  })
}

async function playStation(guild: any, radioUrl: string, radioName: string): Promise<void> {
  const queue = queues.get(guild.id)
  const { startRadioMetadataDetection } = await import("../web/nowonair")
  const { detectStreamCodec, spawnRadioFfmpeg } = await import("../web/airwaves")

  if (!queue) {
    console.error("Queue not found for radio")
    return
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resolvedUrl = await fetch(radioUrl, { signal: controller.signal }).then(res => {
      clearTimeout(timeout)
      return res.url
    })
    radioUrl = resolvedUrl
  } catch (err) {
    console.log(`[radio] Failed to resolve radio URL, using original: ${(err as Error).message}`)
  }

  console.log("Playing radio:", radioName)

  try {
    if (queue.radioFfmpeg) {
      queue.radioFfmpeg._intentionalKill = true
      queue.radioFfmpeg.kill()
    }

    // Clean up old listeners to prevent leak on reconnect
    queue.player.removeAllListeners("error")
    queue.player.removeAllListeners(AudioPlayerStatus.Idle)
    queue.connection?.removeAllListeners("error")

    queue.radioStopped = false
    queue.radioUrl = radioUrl
    queue.radioName = radioName
    if (!queue.isReconnecting) {
      queue.radioReconnectAttempts = 0
      queue.reconnectMessage = null
    }
    const MAX_RECONNECT_ATTEMPTS = 5

    if (queue.metadataDetector) {
      queue.metadataDetector.stop()
      queue.metadataDetector = undefined
    }

    const codec = await detectStreamCodec(radioUrl)

    const doRadioReconnect = (reason: string) => {
      if (queue.radioStopped || queue.isReconnecting) return false

      console.log(`[radio] Triggering reconnect due to: ${reason}`)

      if (queue.metadataDetector) {
        queue.metadataDetector.stop()
        queue.metadataDetector = undefined
      }

      queue.isReconnecting = true
      queue.radioReconnectAttempts!++

      if (queue.radioReconnectAttempts! >= MAX_RECONNECT_ATTEMPTS) {
        const errorMsg = `the radio slipped away~ try again in a bit?`
        tellChannel(queue, errorMsg)
        queue.radioStopped = true
        queue.isReconnecting = false
        return false
      }

      const delay = 3000
      const reconnectMsg = `tuning back into **${radioName}**~ (take ${queue.radioReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`

      if (queue.radioMessage) {
        queue.radioMessage.edit(reconnectMsg).catch(console.error)
      } else {
        tellChannel(queue, reconnectMsg)
      }

      setTimeout(() => {
        const currentQueue = queues.get(guild.id)
        if (currentQueue && !currentQueue.radioStopped) {
          playStation(guild, radioUrl, radioName)
        } else {
          console.log(`[radio] Reconnect cancelled - Queue: ${!!currentQueue}, Stopped: ${currentQueue?.radioStopped}`)
          queue.isReconnecting = false
        }
      }, delay)

      return true
    }

    const ff = spawnRadioFfmpeg(radioUrl, codec, (code: number | null, signal: string | null) => {
      // Explicit SIGTERM or intentional kill: we intentionally killed ffmpeg (stop, new radio, etc.)
      // On Windows, kill("SIGTERM") produces code=255 signal=null, so we also check _intentionalKill
      if (signal === "SIGTERM" || signal === "15" || ff._intentionalKill) {
        console.log("[radio] ffmpeg terminated normally (intentional kill), no reconnect needed")
        return
      }

      // If radio was already stopped, ignore this close event
      if (queue.radioStopped) return

      // For radio streams, ANY exit (clean code 0, error, or killed by unexpected signal)
      // means the stream is gone and we need to reconnect
      const isBrokenPipe = ((code === 32 || code === 1) && signal === null) || ff._brokenPipeDetected
      const exitReason = code === 0 && signal === null
        ? "stream ended cleanly"
        : isBrokenPipe
          ? "broken pipe"
          : `exit code=${code} signal=${signal}`

      console.log(`[radio] ffmpeg closed: ${exitReason}, triggering reconnect...`)
      doRadioReconnect(exitReason)
    })
    queue.radioFfmpeg = ff

    const resource = createAudioResource(ff.stdout!, { inlineVolume: true, inputType: StreamType.OggOpus })
    resource.volume?.setVolume(queue.volume ?? 1.0)
    queue.player.play(resource)

    // Player error → reconnect
    queue.player.on("error", async (err: Error) => {
      console.error("Radio player error:", err)
      doRadioReconnect(`player error: ${err.message}`)
    })

    // Player Idle → stream ended without error, reconnect
    queue.player.once(AudioPlayerStatus.Idle, () => {
      if (queue.radioStopped || queue.isReconnecting) return
      console.log("[radio] Audio player went idle while radio should be playing, triggering reconnect...")
      doRadioReconnect("player idle")
    })

    queue.connection?.on("error", (err: Error) => {
      console.error("Voice connection error:", err)
      tellChannel(queue, "lost the voice connection~ stopping the radio")
      if (queue.radioFfmpeg) queue.radioFfmpeg.kill()
      if (queue._saveInterval) {
        clearInterval(queue._saveInterval)
        queue._saveInterval = undefined
      }
      queue.radioStopped = true
      queue.playing = false
      queue.isReconnecting = false
      queue.radioReconnectAttempts = 0
      saveState()
    })

    if (queue.radioMessage && queue.isReconnecting) {
      queue.radioMessage.edit(`tuning into **${radioName}** for you~`).catch(console.error)
    } else {
      try {
        const radioMsg = await tellChannel(queue, `tuning into **${radioName}** for you~`)
        queue.radioMessage = radioMsg || undefined
      } catch (sendErr) {
        console.error(`[radio] Failed to send radio message: ${(sendErr as Error).message}`)
        queue.radioMessage = undefined
      }
    }

    if (queue.reconnectMessage) {
      queue.reconnectMessage.edit("radio's back~").catch(console.error)
      queue.reconnectMessage = null
    }

    queue.isReconnecting = false
    queue.playing = true

    setTimeout(() => {
      queue.metadataDetector = startRadioMetadataDetection(radioUrl, queue)
    }, 2000)

    saveState()
  } catch (err) {
    console.error(`[radio] Unexpected error in playStation: ${(err as Error).message}`)
    const errMsg = (err as Error).message
    if (errMsg && errMsg.includes("Missing Access")) {
      console.error("[radio] Stopping radio due to Missing Access (bot likely removed from channel/server)")
      if (queue) {
        queue.radioStopped = true
        queue.isReconnecting = false
        queue.playing = false
      }
      return
    }
    if (queue && !queue.radioStopped && !queue.isReconnecting) {
      queue.isReconnecting = true
      queue.radioReconnectAttempts = (queue.radioReconnectAttempts || 0) + 1
      const delay = 3000
      setTimeout(() => {
        const currentQueue = queues.get(guild.id)
        if (currentQueue && !currentQueue.radioStopped) {
          playStation(guild, radioUrl, radioName)
        }
      }, delay)
    }
  }
}

export { pipeFile, playTrack, playStation, fixStreamError }
