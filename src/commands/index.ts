import { Message, Guild, VoiceChannel } from "selfbotsdk-discordjs"
import config from "../config"
import { queues } from "../core/queue"
import { handlePlay, handleSkip, handleLoop, handleShuffle, handleQueue, handleStop, handleVolume } from "./music"
import { handleRadio, handleRadioStats } from "./radio"
import { handleTest, handleHelp, handleLeave, handleClearChat, handleClearReactions, handleSync, handleJoin, handleState, handlePanel, handleSilent } from "./utility"
import { replyHuman, sendHuman } from "../utils/send"
import { Queue } from "../types"

async function handleMessageCreate(msg: Message): Promise<void> {
  // Owner-only: this bot answers to exactly one Discord user ID.
  if (msg.author.id !== config.ownerId) return

  // Commands work two ways:
  //   @BotName play shape of you     (mention prefix)
  //   ?play shape of you             (classic prefix)
  const botId = msg.client.user?.id
  let body = msg.content
  if (botId && new RegExp(`^<@!?${botId}>\\s*`).test(body)) {
    body = body.replace(new RegExp(`^<@!?${botId}>\\s*`), "")
  } else if (body.startsWith(config.prefix)) {
    body = body.slice(config.prefix.length)
  } else {
    return
  }

  const args = body.trim().split(/ +/)
  const cmd = args.shift()?.toLowerCase() || ""
  if (!cmd) return

  const channelName = (msg.channel as any).name || "DM"
  console.log(`\x1b[36m[COMMAND]\x1b[0m \x1b[33m${cmd}\x1b[0m | \x1b[35mUser:\x1b[0m ${msg.author.tag} (${msg.author.id}) | \x1b[34mChannel:\x1b[0m ${channelName} (${msg.channel.id}) | \x1b[32mQuery:\x1b[0m ${args.join(" ") || "N/A"}`)

  let guild: Guild | undefined = msg.guild || undefined
  let voice: VoiceChannel | null = null
  let queue: Queue | undefined

  if (!msg.member) {
    for (const [, g] of msg.client.guilds.cache) {
      try {
        const member = await g.members.fetch(msg.author.id)
        if (member.voice.channel) {
          guild = g
          voice = member.voice.channel as VoiceChannel
          queue = queues.get(guild.id)
          console.log(`[DM] Found user in voice channel: ${voice.name} in guild ${g.name}`)
          break
        }
      } catch {
        continue
      }
    }

    if (!voice) {
      await replyHuman(msg, "You need to be in a voice channel on one of the servers to use this command in DM")
      return
    }
  } else {
    voice = msg.member.voice.channel as VoiceChannel | null
    if (!voice && cmd !== "help" && cmd !== "state" && cmd !== "test") {
      await replyHuman(msg, "Join a voice channel first")
      return
    }
    if (guild) queue = queues.get(guild.id)
  }

  switch (cmd) {
    case "test": {
      handleTest(msg)
      return
    }
    case "play": {
      if (!guild) { await replyHuman(msg, "Guild not found"); return }
      try {
        await handlePlay(msg, args, guild, voice, queue)
      } catch (error) {
        console.error("Error in handlePlay:", error)
        try { await sendHuman(msg.channel as any, "Something went wrong while processing the play command").catch(() => {}) } catch {}
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
      if (!guild) { await replyHuman(msg, "Guild not found"); return }
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
      if (!guild) { await replyHuman(msg, "Guild not found"); return }
      await handleSync(msg, args, guild, voice, queue)
      return
    }
    case "join": {
      if (!guild) { await replyHuman(msg, "Guild not found"); return }
      await handleJoin(msg, args, guild, voice, queue)
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
