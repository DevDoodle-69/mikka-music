import fs from "fs"
import config from "../setup"
import { AudioPlayerStatus } from "@discordjs/voice"
import { Queue, Song } from "../types"

const queues: Map<string, Queue> = new Map()

// Guilds where the bot left a voice channel ON PURPOSE (auto-leave when the
// owner leaves, or the leave command). The "kicked" rejoin logic must not
// resurrect these — otherwise the bot creeps back into the channel it just
// left.
//
// Timestamp window (NOT single-use): Discord can deliver duplicate or late
// voice-state events for one leave. A consume-once marker gets eaten by the
// first event, and the second is then mistaken for a kick → ghost rejoin
// loop. A 30s window treats every event in that span as intentional.
const intentionalLeaves = new Map<string, number>()

function markIntentionalLeave(guildId: string): void {
  intentionalLeaves.set(guildId, Date.now())
}

/**
 * Non-consuming check — safe to call from multiple overlapping event
 * handlers (watchdog stateChange + voiceStateUpdate) for the same leave.
 */
function hadIntentionalLeave(guildId: string, windowMs = 30_000): boolean {
  const t = intentionalLeaves.get(guildId)
  if (!t) return false
  if (Date.now() - t > windowMs) {
    intentionalLeaves.delete(guildId)
    return false
  }
  return true
}

// Kept for compatibility — now a window check, no longer consumes.
function takeIntentionalLeave(guildId: string): boolean {
  return hadIntentionalLeave(guildId)
}

// A queue whose voice connection is missing or destroyed counts as dead —
// routing and (re)join logic must treat it like no session at all, otherwise
// commands get sent to a ghost connection and nothing is heard.
function isConnectionLive(q: Queue | undefined): boolean {
  if (!q || !q.connection) return false
  const status = (q.connection as any).state?.status
  return status !== "destroyed"
}

// A user account can only hold ONE voice session at a time. If she joins a
// second voice channel, Discord yanks the first session, the "kicked" handler
// mistakes it for a kick, and she ping-pongs between channels forever —
// "playing" messages with no stable audio anywhere except the first server.
// This enforces the invariant: before joining anywhere, leave everywhere else.
function leaveAllVoiceSessions(exceptGuildId?: string): void {
  for (const [gid, q] of queues) {
    if (exceptGuildId && gid === exceptGuildId) continue
    if (!q.connection && !q.voiceChannelId) continue
    console.log(`[voice] Leaving voice session in guild ${gid} (single-session invariant)`)
    markIntentionalLeave(gid)
    try { q.connection?.destroy() } catch {}
    q.connection = null
    q.voiceChannelId = null
    try { q.player.removeAllListeners(AudioPlayerStatus.Idle) } catch {}
    try { q.player.stop() } catch {}
  }
  saveState()
}

function saveState(stateLog: boolean = true): void {
  const state: Record<string, unknown> = {}
  for (const [guildId, queue] of queues) {
    let songs: Song[] = queue.songs

    if (queue.playing && queue.currentSong && !queue.currentSong.isRadio && queue.songs.length > 0) {
      const startedAt = new Date(queue.currentSong.startedAt)
      const elapsedSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000)
      songs = queue.songs.map((s, i) => {
        if (i === 0) return { ...s, resumeFrom: elapsedSeconds }
        return s
      })
    }

    state[guildId] = {
      voiceChannelId: queue.voiceChannelId,
      volume: queue.volume ?? 0.3,
      songs: songs,
      radioUrl: queue.radioUrl,
      radioName: queue.radioName,
      radioStopped: queue.radioStopped,
      playHistory: queue.playHistory || [],
      loopMode: queue.loopMode || 0,
      playing: queue.playing || false,
      musicReconnectAttempts: queue.musicReconnectAttempts || 0,
      isMusicReconnecting: queue.isMusicReconnecting || false,
      silent: queue.silent || false,
      userId: queue.userId || null
    }
  }

  try {
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2))
    if (stateLog) {
      console.log(" State saved to", config.stateFile)
    }
  } catch (err) {
    console.error("Error saving state:", err)
  }
}

function loadState(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(config.stateFile)) {
      console.log("No state file found, creating new one...")
      console.log(`State file location: ${config.stateFile}`)
      fs.writeFileSync(config.stateFile, JSON.stringify({}, null, 2))
      return {}
    }
    const data = fs.readFileSync(config.stateFile, "utf8")
    const state = JSON.parse(data)
    console.log("State loaded from", config.stateFile)
    console.log(`State contains ${Object.keys(state).length} guild(s)`)
    return state
  } catch (err) {
    console.error("Error loading state:", err)
    console.log(`Attempted to load from: ${config.stateFile}`)
    return null
  }
}

function createDefaultQueue(overrides: Partial<Queue> = {}): Queue {
  return {
    songs: [],
    voiceChannelId: null,
    volume: 0.3,
    playHistory: [],
    loopMode: 0,
    isSkipping: false,
    playing: false,
    radioUrl: null,
    radioName: null,
    radioStopped: true,
    radioFfmpeg: null,
    musicReconnectAttempts: 0,
    musicReconnectMessage: null,
    isMusicReconnecting: false,
    connection: null,
    reactionCollector: null,
    panelCollector: null,
    reconnectMessage: null,
    silent: false,
    userId: null,
    ...overrides
  } as Queue
}

export { queues, saveState, loadState, createDefaultQueue, markIntentionalLeave, takeIntentionalLeave, hadIntentionalLeave, isConnectionLive, leaveAllVoiceSessions }
