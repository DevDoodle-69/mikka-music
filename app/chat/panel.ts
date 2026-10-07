import { Message, TextChannel, MessageReaction, ReactionCollector, User } from "selfbotsdk-discordjs"
import { Queue } from "../types"
import { saySoft, pick } from "../tools/say"
import { dropTemp } from "../web/fetchmp3"

async function removeAllReactionsFromChannel(channel: TextChannel): Promise<void> {
  try {
    let lastId: string | null = null
    let hasMore = true
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000

    while (hasMore) {
      const options: { limit: number; before?: string } = { limit: 100 }
      if (lastId) options.before = lastId

      const messages = await channel.messages.fetch(options)

      if (messages.size === 0) {
        hasMore = false
        break
      }

      for (const [, msg] of messages) {
        if (msg.reactions.cache.size > 0 && msg.author.bot && msg.createdTimestamp > twoWeeksAgo) {
          try {
            await msg.reactions.removeAll()
            console.log("Removed reactions from message:", msg.id)
          } catch (err) {
            const discordErr = err as { code?: number }
            if (discordErr.code === 50013) {
              console.log("Skipping message due to permissions:", msg.id)
            } else {
              console.error("Error removing reactions from message:", msg.id, err)
            }
          }
        }
      }

      lastId = messages.last()?.id || null
      if (messages.size < 100) hasMore = false
    }
  } catch (err) {
    console.error("Error removing reactions from channel:", err)
  }
}

async function removeReactionUI(message: Message | null | undefined, collector: ReactionCollector | null | undefined): Promise<void> {
  if (!message) return

  try {
    await message.reactions.removeAll()
    console.log("Removed reactions from message:", message.id)
  } catch (err) {
    console.error("Error removing reactions:", err)
  }

  if (collector && typeof collector.stop === "function") {
    collector.stop()
    console.log("Stopped reaction collector")
  }
}

async function createReactionUI(message: Message, queue: Queue): Promise<ReactionCollector> {
  const controls = ["⏯", "⏭", "🔉", "🔊", "⏹"]

  console.log("Creating reaction UI for message:", message.id)

  await removeAllReactionsFromChannel(message.channel as TextChannel)

  if (queue.reactionCollector && typeof queue.reactionCollector.stop === "function") {
    queue.reactionCollector.stop()
    queue.reactionCollector = null
  }

  try {
    for (const emoji of controls) {
      await message.react(emoji)
    }
    console.log("Reactions added successfully")
  } catch (err) {
    console.error("Error adding reactions:", err)
  }

  const filter = (_reaction: MessageReaction, user: User) => !!(_reaction.emoji.name) && controls.includes(_reaction.emoji.name!) && !user.bot

  const collector = message.createReactionCollector({ filter })

  collector.on("collect", (reaction: MessageReaction) => {
    switch (reaction.emoji.name!) {
      case "⏯":
        if (queue.player.state.status === "paused")
          queue.player.unpause()
        else
          queue.player.pause()
        break

      case "⏭":
        queue.isSkipping = true
        if (queue.currentProcesses) {
          queue.currentProcesses.ytdlp?.kill()
          queue.currentProcesses.ff.kill()
          dropTemp(queue)
        }
        queue.player.stop()
        break

      case "🔉":
        queue.volume = Math.max(0, (queue.volume ?? 1.0) - 0.1)
        if (queue.player.state.status === "playing" && queue.player.state.resource?.volume) {
          queue.player.state.resource.volume.setVolume(queue.volume)
        }
        message.channel.send(`🔉 Volume: **${Math.round(queue.volume * 100)}%**`)
        break

      case "🔊":
        queue.volume = Math.min(5, (queue.volume ?? 1.0) + 0.1)
        if (queue.player.state.status === "playing" && queue.player.state.resource?.volume) {
          queue.player.state.resource.volume.setVolume(queue.volume)
        }
        message.channel.send(`🔊 Volume: **${Math.round(queue.volume * 100)}%**`)
        break

      case "⏹":
        if (queue.currentProcesses) {
          queue.currentProcesses.ytdlp?.kill()
          queue.currentProcesses.ff.kill()
          dropTemp(queue)
        }
        if (queue.radioFfmpeg) queue.radioFfmpeg.kill()
        queue.songs = []
        queue.radioStopped = true
        queue.isReconnecting = false
        queue.player.stop()
        collector.stop()
        break
    }
  })

  queue.reactionMessage = message
  queue.reactionCollector = collector

  return collector
}

let playTrackRef: ((guild: any, song: any) => Promise<void>) | null = null
let playRadioRef: ((guild: any, radioUrl: string, radioName: string) => Promise<void>) | null = null

function setPlayTrackFunction(fn: (guild: any, song: any) => Promise<void>): void {
  playTrackRef = fn
}

function setPlayStationFunction(fn: (guild: any, radioUrl: string, radioName: string) => Promise<void>): void {
  playRadioRef = fn
}

async function createCommandPanel(message: Message, queue: Queue): Promise<ReactionCollector> {
  const controls = ["⏮", "⏯️", "⏭", "🔉", "🔊", "⏹", "📻", "🎵", "🗑️", "ℹ️"]

  console.log("Creating command panel for message:", message.id)

  await removeAllReactionsFromChannel(message.channel as TextChannel)

  if (queue.panelCollector && typeof queue.panelCollector.stop === "function") {
    queue.panelCollector.stop()
    queue.panelCollector = null
  }

  const panelContent = `**my little control panel~**

**tap a reaction below, cutie:**
[prev] - previous song
[play/pause] - shh / sing
[next] - skip it
[vol-] - softer
[vol+] - louder
[stop] - hush, clear everything
[radio] - back to radio
[music] - music mode
[clear] - tidy the chat
[info] - what's playing

**or just mention me:**
**@Mikka play** <song name> - I'll find it for you
**@Mikka play** <link> - straight from the link
**@Mikka play** <playlist link> [limit] - the whole bunch
**@Mikka skip / loop / shuffle / queue / stop**
**@Mikka volume** [0-100]
**@Mikka radio** <name> - tune in somewhere
**@Mikka leave** - I'll slip away`

  const panelMsg = await saySoft(message.channel as any, panelContent)

  try {
    for (const emoji of controls) {
      await panelMsg.react(emoji)
    }
    console.log("Panel reactions added successfully")
  } catch (err) {
    console.error("Error adding panel reactions:", err)
  }

  const filter = (_reaction: MessageReaction, user: User) => !!(_reaction.emoji.name) && controls.includes(_reaction.emoji.name!) && !user.bot

  const collector = panelMsg.createReactionCollector({ filter })

  collector.on("collect", async (reaction: MessageReaction, user: User) => {
    switch (reaction.emoji.name!) {
      case "⏮":
        if (queue.songs.length > 1) {
          const popped = queue.songs.pop()
          if (popped) queue.songs.unshift(popped)
          if (queue.currentProcesses) {
            queue.currentProcesses.ytdlp?.kill()
            queue.currentProcesses.ff.kill()
            dropTemp(queue)
          }
          queue.player.stop()
          saySoft(message.channel as any, "back to the last one~")
        } else {
          saySoft(message.channel as any, "no earlier song, cutie~")
        }
        break

      case "⏯️":
        if (queue.player.state.status === "paused") {
          queue.player.unpause()
          saySoft(message.channel as any, "and~ we're back")
        } else {
          queue.player.pause()
          saySoft(message.channel as any, "paused~ take your time")
        }
        break

      case "⏭":
        queue.isSkipping = true
        if (queue.currentProcesses) {
          queue.currentProcesses.ytdlp?.kill()
          queue.currentProcesses.ff.kill()
          dropTemp(queue)
        }
        queue.player.stop()
        saySoft(message.channel as any, pick(["skipped~", "next~", "onwards~"]))
        break

      case "🔉":
        queue.volume = Math.max(0, (queue.volume ?? 1.0) - 0.2)
        if (queue.player.state.status === "playing" && queue.player.state.resource?.volume) {
          queue.player.state.resource.volume.setVolume(queue.volume)
        }
        message.channel.send(`🔉 Volume: **${Math.round(queue.volume * 100)}%**`)
        break

      case "🔊":
        queue.volume = Math.min(5, (queue.volume ?? 1.0) + 0.2)
        if (queue.player.state.status === "playing" && queue.player.state.resource?.volume) {
          queue.player.state.resource.volume.setVolume(queue.volume)
        }
        message.channel.send(`🔊 Volume: **${Math.round(queue.volume * 100)}%**`)
        break

      case "⏹":
        if (queue.currentProcesses) {
          queue.currentProcesses.ytdlp?.kill()
          queue.currentProcesses.ff.kill()
          dropTemp(queue)
        }
        if (queue.radioFfmpeg) queue.radioFfmpeg.kill()
        queue.songs = []
        queue.radioStopped = true
        queue.player.stop()
        saySoft(message.channel as any, "stopped and all cleared~")
        break

      case "🎵":
        if (queue.songs.length > 0) {
          if (queue.radioFfmpeg) {
            queue.radioFfmpeg.kill()
            queue.radioFfmpeg = null
          }
          queue.radioStopped = true
          saySoft(message.channel as any, "music mode~")
          if (playTrackRef) playTrackRef(queue.textChannel?.guild, queue.songs[0])
        } else {
          saySoft(message.channel as any, "queue's empty~ mention me with play first")
        }
        break

      case "📻":
        if (queue.radioUrl && queue.radioName) {
          if (queue.currentProcesses) {
            queue.currentProcesses.ytdlp?.kill()
            queue.currentProcesses.ff.kill()
            dropTemp(queue)
          }
          queue.radioStopped = false
          saySoft(message.channel as any, "back to radio~")
          setTimeout(() => {
            if (playRadioRef) playRadioRef(queue.textChannel?.guild, queue.radioUrl!, queue.radioName!)
          }, 100)
        } else {
          saySoft(message.channel as any, "no station tuned in yet~")
        }
        break

      case "🗑️":
        const messages = await message.channel.messages.fetch({ limit: 11 })
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
        const messagesToDelete = messages.filter((m: Message) => m.createdTimestamp > twoWeeksAgo && m.id !== panelMsg.id)

        let deletedCount = 0
        for (const [, msg] of messagesToDelete) {
          try {
            await msg.delete()
            deletedCount++
          } catch (err) {
            console.error("Error deleting message:", err)
          }
        }
        message.channel.send(`🗑️ Deleted **${deletedCount}** messages`)
        break

      case "ℹ️":
        let queueInfo = `📋 **Queue Info**\n\n`
        if (queue.currentSong) {
          queueInfo += `🎵 Now Playing: **${queue.currentSong?.title || "Unknown Song"}**\n`
        }
        queueInfo += `🔊 Volume: **${Math.round((queue.volume ?? 1.0) * 100)}%**\n`
        queueInfo += `📝 Songs in Queue: **${queue.songs.length}**\n`
        if (queue.songs.length > 0) {
          queueInfo += `\n📜 **Queue List:**\n`
          queue.songs.slice(0, 10).forEach((song, i) => {
            if (song && song.title) queueInfo += `${i + 1}. ${song.title}\n`
          })
          if (queue.songs.length > 10) queueInfo += `... and ${queue.songs.length - 10} more\n`
        }
        if (queue.radioUrl && queue.radioName && !queue.radioStopped) {
          queueInfo += `📻 Radio: **${queue.radioName}**\n`
        }
        if (queue.playHistory && queue.playHistory.length > 0) {
          queueInfo += `\n🕐 **Recently Played:**\n`
          queue.playHistory.slice(0, 5).forEach((song, i) => {
            if (song && song.title) queueInfo += `${i + 1}. ${song.title}\n`
          })
        }
        message.channel.send(queueInfo)
        break
    }

    reaction.users.remove(user.id).catch(console.error)
  })

  queue.panelMessage = panelMsg
  queue.panelCollector = collector

  return collector
}

export {
  removeAllReactionsFromChannel,
  removeReactionUI,
  createReactionUI,
  createCommandPanel,
  setPlayTrackFunction,
  setPlayStationFunction
}
