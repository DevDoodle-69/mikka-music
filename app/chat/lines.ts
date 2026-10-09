import { pick } from "../tools/say"

// Mikka's voice: every playful, expressive reply variant lives here.
// One file to edit when she needs new words — nothing scattered across the codebase.

export function testReply(): string {
  return pick([
    "all good on my end~",
    "yep, I'm here~",
    "loud and clear, cutie~",
    "awake and fabulous~",
    "testing, testing~ can you hear me?",
    "yep yep~ all systems go",
  ])
}

export function leaving(): string {
  return pick([
    "leaving the voice channel~ bye for now",
    "slipping out~ call me when you need me",
    "okay okay~ I'm out, call me when the mood strikes",
    "heading out~ the stage is all yours",
    "bye for now~ it was fun singing for you",
    "floating away~ ping me when you want me back",
  ])
}

export function synced(): string {
  return pick([
    "synced~ I'm with you now",
    "found you~ I'm right here",
    "locked onto you~ I'm here",
    "there you are~ synced and ready",
    "found your voice~ I'm right beside you",
    "teleporting to you~ done",
  ])
}

export function proxyQuery(platform: string): string {
  return pick([
    `we're on **${platform}** right now~ say @Mikka proxyset spotify or youtube to switch`,
    `current platform: **${platform}**~ want spotify or youtube?`,
    `we're vibing on **${platform}** right now~ want to switch it up?`,
    `**${platform}** mode~ spotify or youtube, your call`,
  ])
}

export function proxySet(platform: string): string {
  return pick([
    `switched to **${platform}**~ fresh vibes incoming`,
    `**${platform}** it is~ let's go`,
    `platform set to **${platform}**~ play something!`,
    `flipping to **${platform}**~ let's see how it sounds`,
    `**${platform}** engaged~ fresh ears, fresh tunes`,
    `done~ **${platform}** from here on out`,
  ])
}

export function sleepSet(minutes: number): string {
  return pick([
    `sleep timer set for **${minutes}** min~ I'll fade out gently and say goodnight`,
    `**${minutes}** minutes till dreamland~ volume fading slowly`,
    `got it~ **${minutes}** min, then I tuck you in`,
    `okay~ in **${minutes}** min I'll dim the lights and say goodnight`,
    `**${minutes}** minutes of music left~ then sweet dreams`,
    `timer's on~ **${minutes}** min of vibes before bedtime`,
  ])
}

export function sleepOff(): string {
  return pick([
    "sleep timer off~ wide awake now",
    "cancelled~ no sleepy time",
    "sleep timer cancelled~ no dreamland yet",
    "fine, I'll stay up with you~",
    "timer off~ wide awake and ready to jam",
  ])
}

export function goodnight(): string {
  return pick([
    "goodnight~ sleep tight, dream sweet",
    "shhh~ off to dreamland you go",
    "night night~ I'll be here when you wake up",
    "sweet dreams~ the music fades, you drift away",
    "sleep well~ I'll keep the night quiet for you",
    "goodnight, cutie~ dream in surround sound",
    "lights out~ I'll hum you to sleep",
    "drift off~ the stars are playing your song",
    "nighty night~ see you in your dreams",
    "rest easy~ I'll be right here when you wake up",
  ])
}

export function stayOn(): string {
  return pick([
    "stay mode **on**~ I'll hold this channel even if you wander off",
    "got it~ I'm not going anywhere now, stay mode **on**",
    "**staying** put~ leave whenever, I'll keep the music going",
    "anchored~ I'm holding this channel till you say otherwise",
    "gotcha~ I'm glued to this channel now",
    "staying right here~ the music doesn't stop",
  ])
}

export function stayOff(): string {
  return pick([
    "stay mode **off**~ I'll follow you like always now",
    "back to normal~ I'll leave with you from now on",
    "stay mode **off**~ attached to you again",
    "following you again~ back to your shadow",
    "roger that~ I'll trail you like before",
    "stay mode off~ we're a duo again",
  ])
}

export function songAdded(title: string): string {
  return pick([
    `added **${title}** just for you~`,
    `ooh, good taste~ **${title}** is in the queue`,
    `**${title}**~ coming right up`,
    `slipped **${title}** into the queue~ nice pick`,
    `**${title}** locked in~ the queue keeps getting better`,
    `one **${title}**, queued with love~`,
    `**${title}**~ oh I know you'll love this one`,
    `added~ **${title}** waiting its turn to shine`,
  ])
}

export function bulkAdded(count: number): string {
  return pick([
    `added **${count}** songs to our little queue~`,
    `**${count}** bangers added~ the queue's getting juicy`,
    `piled **${count}** songs in~ let's go`,
    `loaded up **${count}** tracks~ enjoy the ride`,
    `queue stuffed with **${count}** songs~ you're spoiled`,
    `**${count}** songs added~ your taste never misses`,
  ])
}

export function playlistUnwrapped(count: number): string {
  return pick([
    `unwrapped **${count}** songs from that playlist~ enjoy`,
    `that playlist gave me **${count}** songs~ all yours`,
    `peeled open the playlist~ **${count}** tracks inside`,
    `**${count}** songs rescued from that playlist~ enjoy`,
    `cracked it open~ **${count}** songs ready to play`,
  ])
}

export function skipped(): string {
  return pick([
    "skipped~ next one!",
    "okay~ next song",
    "poof~ gone, playing the next",
    "bye-bye that one~ up next",
    "skipping ahead~",
    "next track, coming in hot~",
    "alright~ moving on to the next banger",
    "cut~ next one please",
  ])
}

export function panelSkipped(): string {
  return pick([
    "skipped~",
    "next~",
    "onwards~",
    "bye~",
    "next up~",
    "moving on~",
  ])
}

export function radioHunt(): string {
  return pick([
    "hunting for that station~",
    "let me find that station for you~",
    "scanning the airwaves for you~",
    "tuning the dial~ hunting your station",
    "let me catch that signal for you~",
    "one sec~ finding your frequency",
  ])
}

export function fetching(title: string): string {
  return pick([
    `fetching **${title}** for you~ one sec`,
    `on it~ grabbing **${title}**`,
    `let me get **${title}** ready~`,
    `running to the record store for **${title}**~ be right back`,
    `warming up the decks~ **${title}** incoming`,
    `chasing down **${title}** for you~ hold tight`,
    `digging **${title}** out of the crates~`,
    `almost got it~ **${title}** loading`,
  ])
}

export function nowPlaying(title: string, durStr: string): string {
  return pick([
    `now playing **${title}**${durStr}`,
    `**${title}**${durStr} — enjoy`,
    `playing **${title}**${durStr}`,
    `now spinning **${title}**${durStr}~ this one's for you`,
    `**${title}**${durStr}~ sing along with me`,
    `ooh I love this one~ **${title}**${durStr}`,
    `**${title}**${durStr} is on~ turn it up`,
    `pressed play on **${title}**${durStr}`,
    `your ears are in for a treat~ **${title}**${durStr}`,
    `**${title}**${durStr} — great pick`,
  ])
}

export function shuffled(): string {
  return pick([
    "shuffled~ let's see what fate picks",
    "mixing it up~ fate's in charge now",
    "shuffled~ the order is a mystery now",
    "songs scrambled~ let's see what we get",
  ])
}

export function stopped(): string {
  return pick([
    "stopped~ the stage is yours again",
    "all quiet~ cleared the stage",
    "stopped~ the crowd goes silent",
    "hushed~ everything's cleared",
  ])
}

export function cleared(): string {
  return pick([
    "all cleared~ fresh start, what should we play?",
    "wiped clean~ queue's empty, stage is yours",
    "everything's cleared~ ready for something new",
    "clean slate~ hit me with your next vibe",
    "cleared it all~ let's start fresh, shall we?",
  ])
}

export function volumeSet(percent: number): string {
  return pick([
    `volume set to **${percent}%**~`,
    `**${percent}%**~ how's that sound?`,
    `volume cranked to **${percent}%**~`,
    `dialed to **${percent}%**~ enjoy`,
  ])
}

export function loopMode(mode: string): string {
  return pick([
    `loop is now **${mode}**~`,
    `looping set to **${mode}**~`,
    `loop: **${mode}**~ got it`,
  ])
}

// --- AI-fresh variants: try the brain for a brand-new line, fall back to static. ---
import { freshLine } from "../web/brain"

/** AI now-playing line, or static fallback. */
export async function nowPlayingFresh(title: string, durStr: string): Promise<string> {
  try {
    const fresh = await freshLine("nowPlaying", title)
    if (fresh) return `${fresh} **${title}**${durStr}`
  } catch {}
  return nowPlaying(title, durStr)
}

/** AI song-added line, or static fallback. */
export async function songAddedFresh(title: string): Promise<string> {
  try {
    const fresh = await freshLine("songAdded", title)
    if (fresh) return fresh
  } catch {}
  return songAdded(title)
}

/** AI fetching line, or static fallback. */
export async function fetchingFresh(title: string): Promise<string> {
  try {
    const fresh = await freshLine("fetching", title)
    if (fresh) return fresh
  } catch {}
  return fetching(title)
}
