/**
 * vcchat.ts — real-time voice chat mode.
 *
 * `@Mikka vc on` makes Mikka listen to the owner's microphone in the
 * current voice channel:
 *
 *   owner speaks -> Opus captured -> decoded to PCM -> ffmpeg to 16k WAV
 *   -> Groq Whisper STT -> AI brain (voice assistant persona)
 *   -> Sarvam TTS (cute female voice) -> played back into the channel
 *
 * An utterance ends after ~1.2s of silence (EndBehaviorType.AfterSilence).
 * While she's thinking/speaking, new speech is ignored (no overlap).
 * `@Mikka vc off` stops listening and returns to music mode.
 */
import {
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice"
import * as prism from "prism-media"
import { spawn } from "child_process"
import { mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { logline, logerr } from "../tools/log"
import { transcribeAudio, isSttConfigured } from "../web/stt"
import { synthesizeSpeech, dropTtsFile } from "../web/tts"
import { voiceChatReply } from "../web/brain"
import { Queue } from "../types"

let vcOn = false
let vcGuildId: string | null = null
let ownerIdRef = ""
let busy = false // true while transcribing/thinking/speaking one turn
let stopped = false
let vcPlayer: any = null
let activeSub: any = null

export function isVcChatOn(): boolean {
  return vcOn
}
export function vcChatGuildId(): string | null {
  return vcGuildId
}

function connReady(conn: VoiceConnection): boolean {
  try {
    return (conn.state as any)?.status === VoiceConnectionStatus.Ready
  } catch {
    return false
  }
}

function cleanupSub(): void {
  try {
    activeSub?.destroy()
  } catch {}
  activeSub = null
}

function forceStop(): void {
  vcOn = false
  stopped = true
  vcGuildId = null
  cleanupSub()
  try {
    vcPlayer?.stop(true)
  } catch {}
  vcPlayer = null
  busy = false
}

/** 48kHz stereo s16le PCM -> 16kHz mono WAV via ffmpeg (Whisper-friendly). */
function pcmToWav16k(pcm: Buffer): Promise<string | null> {
  return new Promise(async (resolve) => {
    let done = false
    const finish = (v: string | null) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const dir = join(tmpdir(), "mikka-vc")
      await mkdir(dir, { recursive: true })
      const out = join(dir, `in-${Date.now()}.wav`)
      const ff = spawn(
        "ffmpeg",
        ["-y", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-ar", "16000", "-ac", "1", out],
        { stdio: ["pipe", "ignore", "ignore"] }
      )
      const killer = setTimeout(() => {
        try {
          ff.kill("SIGKILL")
        } catch {}
        finish(null)
      }, 20000)
      ff.on("error", () => {
        clearTimeout(killer)
        finish(null)
      })
      ff.on("close", (code) => {
        clearTimeout(killer)
        finish(code === 0 ? out : null)
      })
      ff.stdin.write(pcm)
      ff.stdin.end()
    } catch {
      finish(null)
    }
  })
}

/** Play a TTS mp3 into the voice channel; resolves when done. */
function playReply(mp3Path: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    try {
      if (!vcPlayer) return finish()
      const resource = createAudioResource(mp3Path)
      const onIdle = () => {
        cleanup()
        finish()
      }
      const onError = () => {
        cleanup()
        finish()
      }
      const cleanup = () => {
        try {
          vcPlayer?.removeListener(AudioPlayerStatus.Idle, onIdle)
          vcPlayer?.removeListener("error", onError)
        } catch {}
      }
      vcPlayer.once(AudioPlayerStatus.Idle, onIdle)
      vcPlayer.once("error", onError)
      vcPlayer.play(resource)
      setTimeout(() => {
        cleanup()
        finish()
      }, 90000)
    } catch {
      finish()
    }
  })
}

async function handleUtterance(pcm: Buffer): Promise<void> {
  if (busy || stopped || !vcOn) return
  // 48k*2ch*2bytes = 192000 bytes/sec — ignore blips under ~0.6s.
  if (pcm.length < 115000) return
  busy = true
  try {
    const wav = await pcmToWav16k(pcm)
    if (!wav || stopped || !vcOn) return
    const text = await transcribeAudio(wav)
    try {
      const { unlink } = await import("fs/promises")
      await unlink(wav)
    } catch {}
    if (!text || text.length < 2 || stopped || !vcOn) return
    logline("vcchat", `heard: "${text.slice(0, 70)}"`)
    const reply = await voiceChatReply(text)
    if (!reply || stopped || !vcOn) return
    logline("vcchat", `reply: "${reply.slice(0, 70)}"`)
    const mp3 = await synthesizeSpeech(reply)
    if (!mp3 || stopped || !vcOn) {
      await dropTtsFile(mp3)
      return
    }
    await playReply(mp3)
    await dropTtsFile(mp3)
  } catch (err: any) {
    logerr("vcchat", "utterance failed:", (err.message || err).slice(0, 80))
  } finally {
    busy = false
  }
}

/**
 * Subscribe to the owner's mic. Each subscription ends after ~1.2s of
 * silence; we re-arm immediately so the next utterance is caught.
 */
function listenOnce(conn: VoiceConnection): void {
  if (stopped || !vcOn || !connReady(conn)) {
    if (vcOn && !connReady(conn)) forceStop()
    return
  }
  cleanupSub()
  let opusStream: any
  try {
    opusStream = conn.receiver.subscribe(ownerIdRef, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 },
    })
  } catch (err: any) {
    logerr("vcchat", "subscribe failed:", (err.message || err).slice(0, 60))
    if (vcOn && !stopped) setTimeout(() => listenOnce(conn), 2000)
    return
  }
  activeSub = opusStream
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
  const pcmChunks: Buffer[] = []
  decoder.on("data", (c: Buffer) => pcmChunks.push(c))
  decoder.on("error", () => {})
  try {
    opusStream.pipe(decoder)
  } catch {
    if (vcOn && !stopped) setTimeout(() => listenOnce(conn), 1000)
    return
  }
  opusStream.on("end", () => {
    const pcm = Buffer.concat(pcmChunks)
    // Re-arm first so we keep listening even while processing this one.
    if (!stopped && vcOn && connReady(conn)) listenOnce(conn)
    else if (vcOn) forceStop()
    handleUtterance(pcm)
  })
  opusStream.on("error", () => {
    if (!stopped && vcOn && connReady(conn)) setTimeout(() => listenOnce(conn), 1000)
    else if (vcOn) forceStop()
  })
}

/**
 * Turn voice chat on for the live voice session.
 * Returns a human-readable result message.
 */
export async function startVcChat(queue: Queue, guildId: string, ownerId: string): Promise<string> {
  if (!isSttConfigured()) {
    return "voice chat needs ears~ set **GROQ_API_KEY** on Render first (free at console.groq.com), redeploy, then try again"
  }
  const conn = queue.connection as VoiceConnection | null
  if (!conn || !connReady(conn)) {
    return "I'm not in a voice channel right now~ join one and I'll follow you, then turn it on"
  }
  if (vcOn) return "voice chat is already on~ just talk to me, I'm listening"
  vcOn = true
  stopped = false
  busy = false
  vcGuildId = guildId
  ownerIdRef = ownerId
  // Stop the music so we can actually hear each other.
  try {
    queue.player.stop(true)
  } catch {}
  queue.playing = false
  vcPlayer = createAudioPlayer()
  vcPlayer.on("error", () => {})
  try {
    conn.subscribe(vcPlayer)
  } catch (err: any) {
    forceStop()
    return "couldn't hook into the voice channel~ try rejoining voice and turning it on again"
  }
  listenOnce(conn)
  logline("vcchat", `voice chat ON (guild ${guildId})`)
  return "voice chat is **on**~ talk to me, I'm listening"
}

/** Turn voice chat off. Returns a human-readable result message. */
export function stopVcChat(): string {
  if (!vcOn) return "voice chat wasn't on~"
  const hadGuild = vcGuildId
  forceStop()
  logline("vcchat", `voice chat OFF (was guild ${hadGuild})`)
  return "voice chat **off**~ back to music mode"
}

/** Call when the voice connection dies so vc mode doesn't linger. */
export function vcChatConnectionLost(): void {
  if (vcOn) {
    forceStop()
    logline("vcchat", "connection lost — voice chat auto-off")
  }
}
