import { logline } from "../tools/log"
import { AudioPlayerStatus } from "@discordjs/voice"
import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import config from "../setup"
import { queues, isConnectionLive, leaveAllVoiceSessions } from "../voice/shelf"
import { handlePlay, handleAiPlay, handlePlaylist, handleSkip, handleLoop, handleShuffle, handleQueue, handleStop, handleClear, handleVolume } from "./tunes"
import { handleRadio, handleRadioStats } from "./tuner"
import { handleTest, handleHelp, handleLeave, handleClearChat, handleClearReactions, handleSync, handleState, handlePanel, handleSilent, handleProxySet, handleSleep, handleStay, handleDiag, handleProxy } from "./handy"
import { replySoft, saySoft } from "../tools/say"
import { Queue } from "../types"

let ownerSelfbotActive = false
/** Called by main.ts when the owner shadow client logs in/out. */
export function setOwnerSelfbotActive(v: boolean): void {
  ownerSelfbotActive = v
}

async function handleMessageCreate(msg: Message): Promise<void> {
  // Owner-only: this bot answers to exactly one Discord user ID.
  if (msg.author.id !== config.ownerId) return

  // Command styles, split by account:
  // - @mention (@BotName play ...) → the robot's interface. Always on.
  // - ^ prefix: on the owner's own account it works for everything
  //   (self-bot mode); on the robot it's reserved for the personal
  //   sleep command only (^sleep 30sec). The robot ignores ^ otherwise.
  const botId = msg.client.user?.id
  if (!botId) return
  const isOwnerAccount = botId === config.ownerId
  const mentionRe = new RegExp("^<@!?" + botId + ">\\s*")
  const caretRe = /^\^\s*/
  let body: string | null = null
  let viaCaret = false
  if (mentionRe.test(msg.content)) {
    body = msg.content.replace(mentionRe, "")
  } else if (caretRe.test(msg.content)) {
    body = msg.content.replace(caretRe, "")
    viaCaret = true
  }
  if (body === null) return

  const args = body.trim().split(/ +/)
  const cmd = args.shift()?.toLowerCase() || ""
  if (!cmd) return
  // ^ on the robot: only the sleep fallback, and only while the owner
  // shadow client isn't running (it owns ^sleep when active).
  if (viaCaret && !isOwnerAccount && (ownerSelfbotActive || cmd !== "sleep")) return

  const channelName = (msg.channel as any).name || "DM"
  logline("command", `${cmd} · ${msg.author.tag} · ${args.join(" ") || "—"}`)

  let guild: Guild | undefined = msg.guild || undefined
  let voice: VoiceChannel | null = null
  let queue: Queue | undefined

  // Where is the owner sitting in voice RIGHT NOW?
  // - play/radio follow the owner across servers: message guild first (cheap),
  //   then scan the other guilds (fetch) so a cross-server play lands where
  //   they actually are.
  // - control commands only need the message guild's voice state (cheap);
  //   remote control rides on the bot's live session.
  const START_AUDIO = cmd === "play" || cmd === "radio"

  let ownerGuild: Guild | undefined
  let ownerVoice: VoiceChannel | null = null
  // Note: optional-chaining through .voice too — selfbot member objects can be
  // partial and accessing .channel on undefined would throw and kill the command.
  const memberVoice = msg.member?.voice?.channel as VoiceChannel | null | undefined
  if (memberVoice) {
    ownerGuild = msg.guild || undefined
    ownerVoice = memberVoice
  } else if (START_AUDIO) {
    for (const [, g] of msg.client.guilds.cache) {
      if (msg.guild && g.id === msg.guild.id) continue
      try {
        const m = await g.members.fetch(msg.author.id)
        const vc = m?.voice?.channel as VoiceChannel | null | undefined
        if (vc) {
          ownerGuild = g
          ownerVoice = vc
          console.log(`[COMMAND] Found you in voice: ${ownerVoice.name} (${g.name})`)
          break
        }
      } catch {
        continue
      }
    }
  }

  // Guild where she currently holds a LIVE voice connection, if any.
  let liveGuild: Guild | undefined
  for (const [gid, q] of queues) {
    if (isConnectionLive(q)) {
      const g = msg.client.guilds.cache.get(gid)
      if (g) { liveGuild = g; break }
    }
  }

  const bestEffortVoice = (g: Guild, q: Queue | undefined): VoiceChannel | null =>
    q?.voiceChannelId ? ((g.channels.cache.get(q.voiceChannelId) as VoiceChannel) || null) : null

  if (START_AUDIO) {
    // Play follows the OWNER: wherever they sit in voice, that's the stage —
    // even if the command came from another server, DM, or inbox.
    if (ownerGuild && ownerVoice) {
      // She's live, but not where you are (different server OR different
      // voice channel)? Move her to you — no playing to an empty room.
      // Single voice session: everything else gets torn down first.
      const liveQ = liveGuild ? queues.get(liveGuild.id) : undefined
      const botChannelId = liveQ?.voiceChannelId || null
      if (liveQ && isConnectionLive(liveQ) && botChannelId !== ownerVoice.id) {
        console.log(`[COMMAND] Moving her to you (${ownerGuild.name}/${ownerVoice.name}) for play`)
        leaveAllVoiceSessions(ownerGuild.id)
      }
      guild = ownerGuild
      voice = ownerVoice
      queue = queues.get(guild.id)
    } else if (liveGuild) {
      // Remote control: owner isn't in voice, but she's live somewhere — play there.
      guild = liveGuild
      queue = queues.get(guild.id)
      voice = bestEffortVoice(guild, queue)
      console.log(`[COMMAND] Remote play routed to her live session in "${guild.name}"`)
    }
  } else {
    // Control commands: her live session wins from anywhere (remote control).
    if (liveGuild) {
      guild = liveGuild
      queue = queues.get(guild.id)
      voice = bestEffortVoice(guild, queue)
      if (msg.guild && msg.guild.id !== liveGuild.id) {
        console.log(`[COMMAND] Routing to her active session in "${liveGuild.name}"`)
      }
    } else if (ownerGuild && ownerVoice) {
      guild = ownerGuild
      voice = ownerVoice
      queue = queues.get(guild.id)
    }
  }

  if (!queue && !["help", "state", "test", "leave", "proxyset", "stay", "diag", "proxy"].includes(cmd) && !voice) {
    await replySoft(msg, "join a voice channel first~ I'll follow you in")
    return
  }

  logline("resolve", `${cmd} → ${guild?.name || "?"} · voice=${(voice as any)?.name || "—"} · queue=${queue ? (isConnectionLive(queue) ? "live" : "STALE") : "none"}`)

  switch (cmd) {
    case "test": {
      handleTest(msg)
      return
    }
    case "play": {
      if (!guild) { await replySoft(msg, "hmm, can't find that server~"); return }
      try {
        await handlePlay(msg, args, guild, voice, queue)
      } catch (error) {
        console.error("Error in handlePlay:", error)
        try { await saySoft(msg.channel as any, "oopsie, something tripped~ try again?").catch(() => {}) } catch {}
      }
      return
    }
    case "aiplay": {
      if (!guild) { await replySoft(msg, "hmm, can't find that server~"); return }
      try {
        await handleAiPlay(msg, args, guild, voice, queue)
      } catch (error) {
        console.error("Error in handleAiPlay:", error)
        try { await saySoft(msg.channel as any, "oopsie, something tripped~ try again?").catch(() => {}) } catch {}
      }
      return
    }
    case "playlist": {
      if (!guild) { await replySoft(msg, "hmm, can't find that server~"); return }
      try {
        await handlePlaylist(msg, args, guild, voice, queue)
      } catch (error) {
        console.error("Error in handlePlaylist:", error)
        try { await saySoft(msg.channel as any, "oopsie, something tripped~ try again?").catch(() => {}) } catch {}
      }
      return
    }
    case "skip": {
      handleSkip(msg, queue)
      return
    }
    case "loop": {
      handleLoop(msg, queue)
      return
    }
    case "shuffle": {
      handleShuffle(msg, queue)
      return
    }
    case "queue": {
      handleQueue(msg, queue)
      return
    }
    case "stop": {
      handleStop(msg, queue)
      return
    }
    case "clear": {
      await handleClear(msg, guild, queue)
      return
    }
    case "volume":
    case "vol": {
      handleVolume(msg, args, queue)
      return
    }
    case "radio": {
      if (!guild) { await replySoft(msg, "hmm, can't find that server~"); return }
      await handleRadio(msg, args, guild, voice, queue)
      return
    }
    case "radiostats": {
      handleRadioStats(msg, queue)
      return
    }
    case "leave": {
      handleLeave(msg, guild, queue)
      return
    }
    case "clearchat": {
      await handleClearChat(msg, args, queue)
      return
    }
    case "clearreactions": {
      await handleClearReactions(msg, queue)
      return
    }
    case "sync": {
      // Works from anywhere — inbox, DMs, any server: finds the voice channel
      // you're sitting in and pulls her to you.
      let syncGuild: Guild | undefined = msg.guild || undefined
      let syncVoice = (msg.member?.voice?.channel as VoiceChannel) || null
      if (!syncVoice) {
        for (const [, g] of msg.client.guilds.cache) {
          if (msg.guild && g.id === msg.guild.id) continue
          try {
            const m = await g.members.fetch(msg.author.id)
            const vc = m?.voice?.channel as VoiceChannel | null | undefined
            if (vc) { syncGuild = g; syncVoice = vc; break }
          } catch {
            continue
          }
        }
      }
      if (!syncGuild || !syncVoice) {
        await replySoft(msg, "join a voice channel first, silly~ then I'll come to you")
        return
      }
      const syncQueue = queues.get(syncGuild.id)
      await handleSync(msg, args, syncGuild, syncVoice, syncQueue)
      return
    }
    case "proxyset": {
      await handleProxySet(msg, args)
      return
    }
    case "sleep": {
      await handleSleep(msg, args, guild, queue)
      return
    }
    case "stay": {
      await handleStay(msg)
      return
    }
    case "diag": {
      await handleDiag(msg)
      return
    }
    case "proxy": {
      await handleProxy(msg, args)
      return
    }
    case "help": {
      handleHelp(msg)
      return
    }
    case "panel": {
      handlePanel(msg, queue)
      return
    }
    case "state": {
      handleState(msg)
      return
    }
    case "silent": {
      await handleSilent(msg, queue)
      return
    }
  }
}

export { handleMessageCreate }
