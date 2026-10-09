import { createAudioResource, AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus } from "@discordjs/voice"
import { spawn } from "child_process"
import { Readable } from "stream"
import fs from "fs"
import config from "../setup"
import { queues, saveState } from "./shelf"
import { Song, Processes } from "../types"
import { tellChannel } from "../tools/say"
import * as lines from "../chat/lines"
import { logline, logerr } from "../tools/log"
import { formatDuration } from "../tools/timefmt"
import { dropTemp } from "../web/fetchmp3"
import { resolveStream, downloadSnowpingMp3 } from "../web/snowping"
import { resolveSpotifyDownload, findOnSpotify } from "../web/spotify"
import { getPlatform } from "../web/platform"

interface StreamWithProcesses extends Readable {
  processes: Processes
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


/**
 * Download a song's audio to a temp file. Mutates song with resolved
 * title/thumbnail/platform. Returns the temp file path. Throws on failure.
 * Used by playTrack AND the background pre-downloader.
 */
async function fetchSongFile(song: Song, notify?: (msg: string) => Promise<void>): Promise<string> {
  const platform = song.platform || getPlatform()
  try {
    if (platform === "direct") {
      const tmpPath = await downloadSnowpingMp3(song.url)
      logline("music", `fetched direct audio "${song.title}"`)
      return tmpPath
    }
    if (platform === "spotify") {
      const dl = await resolveSpotifyDownload(song.url)
      if (dl.title && dl.title !== "Unknown title") {
        song.title = dl.artist ? `${dl.artist} - ${dl.title}` : dl.title
      }
      if (dl.cover) song.thumbnail = dl.cover
      const tmpPath = await downloadSnowpingMp3(dl.downloadUrl)
      logline("music", `fetched "${song.title}" via spotify`)
      return tmpPath
    }
    // YouTube path.
    const track = await resolveStream(song.url)
    if (track.title && track.title !== "Unknown title") song.title = track.title
    if (track.thumbnail) song.thumbnail = track.thumbnail
    const tmpPath = await downloadSnowpingMp3(track.streamUrl)
    logline("music", `fetched "${song.title}" from downloaded file`)
    return tmpPath
  } catch (err) {
    const lastError = (err as Error).message || "download failed"
    logerr("music", `${platform} download failed:`, lastError)
    // Auto-fallback: YouTube failed -> try the same song on Spotify.
    if (platform === "youtube") {
      const alt = await findOnSpotify(song.title)
      if (alt) {
        logline("music", `auto-switching to spotify for "${song.title}"`)
        if (notify) await notify(`youtube flopped~ trying spotify for **${song.title}**`)
        const dl = await resolveSpotifyDownload(alt.url)
        if (dl.cover) song.thumbnail = dl.cover
        const tmpPath = await downloadSnowpingMp3(dl.downloadUrl)
        song.platform = "spotify"
        song.url = alt.url
        logline("music", `fetched "${song.title}" via spotify fallback`)
        return tmpPath
      }
    }
    throw err
  }
}

/** Probe the real duration of a downloaded audio file (seconds). */
async function probeDuration(tmpPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", tmpPath,
    ])
    let out = ""
    ff.stdout.on("data", (d: any) => (out += d.toString()))
    ff.on("close", () => {
      const v = parseFloat(out.trim())
      resolve(isFinite(v) && v > 0 ? Math.floor(v) : null)
    })
    ff.on("error", () => resolve(null))
    setTimeout(() => { try { ff.kill() } catch {}; resolve(null) }, 8000)
  })
}

/** Set the live playback volume (no-op if nothing playing). */
function setLiveVolume(queue: any, vol: number, persist = true): void {
  if (persist) queue.volume = vol
  try {
    const st = queue.player?.state
    if (st?.status === AudioPlayerStatus.Playing && st.resource?.volume) {
      st.resource.volume.setVolume(Math.max(0, vol))
    }
  } catch {}
}

/** Smooth volume ramp. Returns the interval timer. */
function fadeVolume(queue: any, from: number, to: number, ms: number, persist = true): NodeJS.Timeout {
  const steps = Math.max(4, Math.floor(ms / 150))
  const stepMs = ms / steps
  let step = 0
  const timer = setInterval(() => {
    step++
    setLiveVolume(queue, from + ((to - from) * step) / steps, persist)
    if (step >= steps) clearInterval(timer)
  }, stepMs)
  return timer
}

/** Clear any pending pre-download / fade timers for a queue. */
export function clearSongTimers(queue: any): void {
  if (queue.predownloadTimer) { clearTimeout(queue.predownloadTimer); queue.predownloadTimer = undefined }
  if (queue.fadeoutTimer) { clearTimeout(queue.fadeoutTimer); queue.fadeoutTimer = undefined }
  if (queue.fadeTimer) { clearInterval(queue.fadeTimer); queue.fadeTimer = undefined }
  // Drop a preloaded file that will never be used.
  if (queue.preloaded) {
    try { fs.unlinkSync(queue.preloaded.tempFile) } catch {}
    queue.preloaded = null
  }
}

/**
 * While a song plays: 60s before it ends, download the next song in the
 * background; 6s before it ends, fade the volume out. When the song ends,
 * the next one starts instantly from the preloaded file with a fade-in.
 * No gaps, no silence — DJ-style.
 */
function scheduleNextSongPrep(guild: any, queue: any, song: Song): void {
  clearSongTimers(queue)
  const next = queue.songs[1]
  const duration = song.duration
  if (!next || !duration || duration < 30) return

  const targetVol = queue.volume ?? 1.0

  // 1) Pre-download the next song 60s before this one ends
  //    (short songs: start almost immediately so it's ready in time).
  const preMs = duration > 75 ? (duration - 60) * 1000 : 5_000
  queue.predownloadTimer = setTimeout(async () => {
    // Still the same song playing? (Skip/stop clears the timer anyway.)
    if (queue.songs[0] !== song) return
    try {
      logline("music", `pre-downloading next: "${next.title}"`)
      const tmpPath = await fetchSongFile(next)
      // Song changed while downloading — drop it.
      if (queue.songs[0] !== song || queue.songs[1] !== next) {
        try { fs.unlinkSync(tmpPath) } catch {}
        return
      }
      queue.preloaded = { songUrl: next.url, tempFile: tmpPath, title: next.title, thumbnail: next.thumbnail }
      logline("music", `preloaded "${next.title}" — ready for zero-gap switch`)
    } catch (err) {
      logerr("music", "pre-download failed (will retry on switch):", (err as Error).message?.slice(0, 100))
    }
  }, preMs)

  // 2) Fade out 6s before the end, gliding down over 5s.
  const fadeMs = Math.max(1_000, (duration - 6) * 1000)
  queue.fadeoutTimer = setTimeout(() => {
    if (queue.songs[0] !== song) return
    logline("music", "fading out for crossfade")
    queue.fadeTimer = fadeVolume(queue, targetVol, 0, 5000, false)
  }, fadeMs)
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

  logline("music", `now playing :: "${song.title}"`)

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

  // ONLY PATH: snowping API -> download the MP3 to a temp file ->
  // play the local file in voice (the classic reliable way).
  // No API keys, no yt-dlp, no other fallbacks.
  // Preloaded file from the background pre-downloader? Use it instantly — zero gap.
  const pre = queue.preloaded
  const _wasPre = !!(pre && pre.songUrl === song.url)
  if (!_wasPre) {
    await tellChannel(queue, lines.fetching(song.title))
  }
  let audio: StreamWithProcesses | null = null
  const wasPreloaded = !!(pre && pre.songUrl === song.url)
  if (wasPreloaded) {
    queue.preloaded = null
    queue.currentTempFile = pre!.tempFile
    if (pre.title) song.title = pre.title
    if (pre.thumbnail) song.thumbnail = pre.thumbnail
    logline("music", `playing "${song.title}" from preloaded file (zero gap)`)
    probeDuration(pre.tempFile).then((d) => {
      if (d && queue.songs[0] === song) {
        song.duration = d
        // Re-schedule with the true duration for pixel-perfect fade timing.
        scheduleNextSongPrep(guild, queue, song)
      }
    })
    audio = pipeFile(pre.tempFile, seekTime)
  } else {
    if (pre) {
      // Stale preload (skip/queue changed) — clean it up.
      try { fs.unlinkSync(pre.tempFile) } catch {}
      queue.preloaded = null
    }
    try {
      const tmpPath = await fetchSongFile(song, (m) => tellChannel(queue, m))
      queue.currentTempFile = tmpPath
      const realDur = await probeDuration(tmpPath)
      if (realDur) {
        if (song.duration && Math.abs(song.duration - realDur) > 3) {
          logline("music", `duration corrected: ${song.duration}s -> ${realDur}s`)
        }
        song.duration = realDur
      }
      audio = pipeFile(tmpPath, seekTime)
    } catch (err) {
      const reason = ((err as Error).message || "unknown").slice(0, 120)
      logerr("music", `fetch failed for "${song.title}":`, reason)
      await tellChannel(queue, `couldn't fetch **${song.title}** (${reason})~ skipping ahead`)
      queue.playing = false
      dropTemp(queue)
      queue.songs.shift()
      if (queue.songs.length > 0) playTrack(guild, queue.songs[0])
      return
    }
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

  // Crossfade in: if we faded the previous song out, rise back up smoothly.
  // (Fresh plays start at full volume; only preloaded zero-gap switches fade in.)
  if (wasPreloaded) {
    const targetVol = queue.volume ?? 1.0
    setLiveVolume(queue, 0, false)
    queue.fadeTimer = fadeVolume(queue, 0, targetVol, 2000, true)
  }

  // DJ mode: pre-download the next song 20s before this ends + fade out.
  scheduleNextSongPrep(guild, queue, song)

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
  await tellChannel(queue, lines.nowPlaying(song.title, durStr))
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
