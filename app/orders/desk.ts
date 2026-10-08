import { AudioPlayerStatus } from "@discordjs/voice"
import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import config from "../setup"
import { queues, isConnectionLive, markIntentionalLeave, saveState } from "../voice/shelf"
import { handlePlay, handleSkip, handleLoop, handleShuffle, handleQueue, handleStop, handleVolume } from "./tunes"
import { handleRadio, handleRadioStats } from "./tuner"
import { handleTest, handleHelp, handleLeave, handleClearChat, handleClearReactions, handleSync, handleJoin, handleState, handlePanel, handleSilent } from "./handy"
import { replySoft, saySoft } from "../tools/say"
import { Queue } from "../types"

async function handleMessageCreate(msg: Message): Promise<void> {
  // Owner-only: this bot answers to exactly one Discord user ID.
  if (msg.author.id !== config.ownerId) return

  // Commands work one way: mention her.
  //   @BotName play shape of you
  const botId = msg.client.user?.id
  if (!botId) return
  const mentionRe = new RegExp("^<@!?" + botId + ">\\s*")
  if (!mentionRe.test(msg.content)) return
  const body = msg.content.replace(mentionRe, "")

  const args = body.trim().split(/ +/)
  const cmd = args.shift()?.toLowerCase() || ""
  if (!cmd) return

  const channelName = (msg.channel as any).name || "DM"
  console.log(`\x1b[36m[COMMAND]\x1b[0m \x1b[33m${cmd}\x1b[0m | \x1b[35mUser:\x1b[0m ${msg.author.tag} (${msg.author.id}) | \x1b[34mChannel:\x1b[0m ${channelName} (${msg.channel.id}) | \x1b[32mQuery:\x1b[0m ${args.join(" ") || "N/A"}`)

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
      const liveQ = liveGuild ? queues.get(liveGuild.id) : undefined
      const botChannelId = liveQ?.voiceChannelId || null
      if (liveQ && isConnectionLive(liveQ) && botChannelId !== ownerVoice.id) {
        console.log(`[COMMAND] Moving her to you (${ownerGuild.name}/${ownerVoice.name}) for play`)
        markIntentionalLeave(liveGuild!.id)
        try { liveQ.connection?.destroy() } catch {}
        liveQ.connection = null
        liveQ.voiceChannelId = null
        try { liveQ.player.removeAllListeners(AudioPlayerStatus.Idle) } catch {}
        try { liveQ.player.stop() } catch {}
        saveState()
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

  if (!queue && !["help", "state", "test", "leave"].includes(cmd) && !voice) {
    await replySoft(msg, "join a voice channel first~ I'll follow you in")
    return
  }

  console.log(`[RESOLVE] cmd=${cmd} guild=${guild?.name}(${guild?.id}) voice=${(voice as any)?.name}(${voice?.id}) queue=${queue ? (isConnectionLive(queue) ? "live" : "STALE") : "none"} conn=${(queue?.connection as any)?.state?.status || "none"} owner=${ownerGuild?.name}(${ownerGuild?.id})`)

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
      // Local move: always the message's own server.
      const localGuild = msg.guild || undefined
      if (!localGuild) { await replySoft(msg, "that one only works in a server, not DMs~"); return }
      const localVoice = (msg.member?.voice?.channel as VoiceChannel) || null
      const localQueue = queues.get(localGuild.id)
      await handleSync(msg, args, localGuild, localVoice, localQueue)
      return
    }
    case "join": {
      // Local move: always the message's own server.
      const localGuild = msg.guild || undefined
      if (!localGuild) { await replySoft(msg, "that one only works in a server, not DMs~"); return }
      const localVoice = (msg.member?.voice?.channel as VoiceChannel) || null
      const localQueue = queues.get(localGuild.id)
      await handleJoin(msg, args, localGuild, localVoice, localQueue)
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
