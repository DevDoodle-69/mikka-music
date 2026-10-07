import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import config from "../setup"
import { queues } from "../voice/shelf"
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

  const liveQueueOf = (g: Guild | undefined): Queue | undefined => {
    const q = g ? queues.get(g.id) : undefined
    return q && q.connection ? q : undefined
  }

  // 1. Live session in this guild?
  queue = liveQueueOf(guild)

  // 2. Live session ANYWHERE? Control her from DMs, inbox, or another
  //    server — she plays in the voice channel she's already in.
  if (!queue) {
    for (const [gid, q] of queues) {
      if (q.connection) {
        const g = msg.client.guilds.cache.get(gid)
        if (g) {
          guild = g
          queue = q
          console.log(`[COMMAND] Routing to her active session in "${g.name}"`)
          break
        }
      }
    }
  }

  // Best-effort: the voice channel she's sitting in.
  if (queue && guild && !voice && queue.voiceChannelId) {
    voice = (guild.channels.cache.get(queue.voiceChannelId) as VoiceChannel) || null
  }

  // 3. No live session anywhere — find YOUR voice channel to start fresh.
  if (!queue) {
    if (!msg.member) {
      for (const [, g] of msg.client.guilds.cache) {
        try {
          const member = await g.members.fetch(msg.author.id)
          if (member.voice.channel) {
            guild = g
            voice = member.voice.channel as VoiceChannel
            console.log(`[DM] Found you in voice: ${voice.name} (${g.name})`)
            break
          }
        } catch {
          continue
        }
      }
    } else {
      voice = msg.member.voice.channel as VoiceChannel | null
    }

    if (!voice && cmd !== "help" && cmd !== "state" && cmd !== "test") {
      await replySoft(msg, "join a voice channel first~ I'll follow you in")
      return
    }
  }

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
      const localVoice = (msg.member?.voice.channel as VoiceChannel) || null
      const localQueue = queues.get(localGuild.id)
      await handleSync(msg, args, localGuild, localVoice, localQueue)
      return
    }
    case "join": {
      // Local move: always the message's own server.
      const localGuild = msg.guild || undefined
      if (!localGuild) { await replySoft(msg, "that one only works in a server, not DMs~"); return }
      const localVoice = (msg.member?.voice.channel as VoiceChannel) || null
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
