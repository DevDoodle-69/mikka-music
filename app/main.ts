import { Client, Guild, VoiceChannel, TextChannel } from "selfbotsdk-discordjs"
import config from "./setup"
import http from "http"
import os from "os"
import fs from "fs"
import path from "path"
import { queues, loadState, saveState } from "./voice/shelf"
import { playTrack, playStation } from "./voice/jukebox"
import { setClient, resumeAllMusic, registerVoiceStateUpdateHandler } from "./voice/session"
import { handleMessageCreate, setOwnerSelfbotActive } from "./orders/desk"
import { handleOwnerMessageCreate, setOwnerClientOnline } from "./orders/ownerdesk"
import { setPlayTrackFunction, setPlayStationFunction } from "./chat/panel"
import { joinVoiceChannel, createAudioPlayer } from "@discordjs/voice"
import { Queue } from "./types"
import { tellChannel } from "./tools/say"
import { dropTemp } from "./web/fetchmp3"
import { setDashboardClient, handleRequest } from "./web/dashboard"
import { logline } from "./tools/log"

const client = new Client()
setClient(client)
setDashboardClient(client)

function gracefulShutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`)
  for (const [, queue] of queues) {
    if (queue.radioFfmpeg) queue.radioFfmpeg.kill()
    if (queue.currentProcesses) {
      queue.currentProcesses.ytdlp?.kill()
      queue.currentProcesses.ff.kill()
    }
    dropTemp(queue)
    if (queue.metadataDetector) queue.metadataDetector.stop()
  }
  // Sweep any stray mikka-*.mp3 files left in the temp dir.
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("mikka-") && f.endsWith(".mp3")) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch {}
      }
    }
  } catch {}
  process.exit(0)
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err))

client.on("ready", async () => {
  console.log("✅ Logged in as", client.user!.tag)

  // Restore My Playlist from the DM backup (survives Render redeploys).
  try {
    const { setPlaylistBackup, restorePlaylist } = await import("./web/playlist")
    setPlaylistBackup(client, config.ownerId)
    const restored = await restorePlaylist(client, config.ownerId)
    if (restored > 0) console.log(`🎵 Playlist restored: ${restored} tracks`)
  } catch (err) {
    console.error("playlist restore error:", (err as Error).message?.slice(0, 80))
  }

  // Clean up stale temp files from crashes/restarts.
  try {
    const fs = await import("fs")
    const os = await import("os")
    const path = await import("path")
    const files = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("mikka-") && f.endsWith(".mp3"))
    for (const f of files) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch {}
    }
    if (files.length > 0) console.log(`🧹 Cleaned ${files.length} stale temp file(s)`)
  } catch {}

  setPlayTrackFunction(playTrack)
  setPlayStationFunction(playStation)

  const state = loadState()
  if (state) {
    console.log(`📋 Found state for ${Object.keys(state).length} guild(s)`)
    for (const [guildId, guildState] of Object.entries(state)) {
      const guild: Guild | undefined = client.guilds.cache.get(guildId)
      if (!guild) {
        console.log(`⚠️ Guild ${guildId} not found in cache`)
        continue
      }

      const gs = guildState as Record<string, unknown>
      const voiceChannel = guild.channels.cache.get(gs.voiceChannelId as string) as VoiceChannel | undefined
      if (!voiceChannel) {
        console.log(`⚠️ Voice channel ${gs.voiceChannelId} not found in guild ${guildId}`)
        continue
      }

      const textChannel = (guild.systemChannel ||
        guild.channels.cache.find((c: any) => c.isTextBased && c.type === 0) ||
        guild.channels.cache.first()) as TextChannel | undefined
      console.log(`📝 Found voice channel: ${voiceChannel.name} (${voiceChannel.id})`)

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        })

        const player = createAudioPlayer()
        connection.subscribe(player)

        const queue: Queue = {
          voiceChannelId: gs.voiceChannelId as string,
          songs: (gs.songs || []) as any,
          radioUrl: (gs.radioUrl as string) || null,
          radioName: (gs.radioName as string) || null,
          radioStopped: (gs.radioStopped as boolean) ?? true,
          textChannel: textChannel,
          player: player,
          connection: connection,
          volume: (gs.volume as number) ?? 1.0,
          playHistory: (gs.playHistory || []) as any,
          loopMode: (gs.loopMode as number) || 0,
          isSkipping: false,
          playing: (gs.playing as boolean) || false,
          musicReconnectAttempts: (gs.musicReconnectAttempts as number) || 0,
          musicReconnectMessage: null,
          isMusicReconnecting: (gs.isMusicReconnecting as boolean) || false,
          radioFfmpeg: null,
          reactionCollector: null,
          panelCollector: null,
          reconnectMessage: null,
          silent: (gs.silent as boolean) || false,
          userId: (gs.userId as string) || null
        }
        queues.set(guildId, queue)

        console.log(`🔄 Resuming playback for guild ${guildId} - Queue: ${queue.songs.length} songs, Radio: ${queue.radioName || "None"}`)

        if (gs.radioUrl && gs.radioName && !gs.radioStopped) {
          console.log(`🔄 Resuming radio on startup: ${gs.radioName}`)
          tellChannel(queue, "warming the radio back up~")
          setTimeout(() => playStation(guild, gs.radioUrl as string, gs.radioName as string), 3000)
        } else if (gs.songs && (gs.songs as any[]).length > 0) {
          console.log(`🔄 Resuming music queue on startup - ${queue.songs.length} songs`)
          const songs = gs.songs as Array<Record<string, unknown>>
          const resumeFrom = songs[0]?.resumeFrom as number | undefined
          const posStr = resumeFrom ? ` (${Math.floor(resumeFrom / 60)}:${(resumeFrom % 60).toString().padStart(2, "0")})` : ""
          tellChannel(queue, "picking up where we left off~")
          setTimeout(() => playTrack(guild, queue.songs[0]), 3000)
        } else {
          console.log(`ℹ️ No active playback to resume for guild ${guildId}`)
        }
      } catch (err) {
        console.error(`❌ Error resuming playback for guild ${guildId}:`, err)
      }
    }
  } else {
    console.log("ℹ️ No state file found - starting fresh")
  }
})

client.on("disconnect", () => {
  console.log("⚠️ Discord client disconnected, attempting to reconnect...")
  setTimeout(() => {
    if ((client as any).ws.status === 0) client.login(config.token)
  }, 5000)
})

client.on("reconnecting", () => console.log("🔄 Reconnecting to Discord..."))

client.on("resume", (replayed: number) => {
  console.log("✅ Resumed connection, replayed", replayed, "events")
  resumeAllMusic()
})

client.on("error", (err: Error) => console.error("Discord client error:", err))

registerVoiceStateUpdateHandler()

client.on("messageCreate", handleMessageCreate)

client.login(config.token)

// ---------------------------------------------------------------------------
// Owner shadow client: when OWNER_TOKEN is set, we also log in as the
// owner's own account. It only handles its own ^self-commands (currently
// just ^sleep) and replies from the owner's account. The robot ignores ^
// while this client is active (see setOwnerSelfbotActive).
// ---------------------------------------------------------------------------
if (process.env.OWNER_TOKEN) {
  const ownerClient = new Client()
  ownerClient.on("ready", () => {
    console.log("✅ Owner client logged in as", (ownerClient.user as any)?.tag)
    setOwnerSelfbotActive(true)
    setOwnerClientOnline(true)
  })
  ownerClient.on("messageCreate", handleOwnerMessageCreate)
  ownerClient.on("disconnect", () => {
    console.log("⚠️ Owner client disconnected")
    setOwnerSelfbotActive(false)
    setOwnerClientOnline(false)
  })
  ownerClient.on("error", (err: Error) => console.error("Owner client error:", err.message?.slice(0, 80)))
  ownerClient.login(process.env.OWNER_TOKEN)
  console.log("👤 Owner shadow client starting…")
} else {
  console.log("ℹ️ OWNER_TOKEN not set — ^sleep falls back to the robot")
}

// Web dashboard + health endpoint so hosts like Render (web services)
// see the process as alive. Uses only Node's built-in http module.
const PORT = Number(process.env.PORT) || 3000
http
  .createServer((req, res) => {
    if (handleRequest(req, res)) return
    // Fallback: plain health check for uptime monitors
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("ok")
  })
  .listen(PORT, () => logline("net", `dashboard live on port ${PORT}`))
