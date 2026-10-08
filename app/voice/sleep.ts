/**
 * sleep.ts — sleep timer with gentle volume fade-out.
 *
 * `@Mikka sleep 30` → over 30 minutes, volume fades to zero,
 * then she whispers goodnight, stops everything, and leaves voice.
 */
import { AudioPlayerStatus } from "@discordjs/voice"
import { logline } from "../tools/log"

interface SleepTimer {
  timeout: NodeJS.Timeout
  fadeInterval: NodeJS.Timeout
  endsAt: number
  minutes: number
  startVolume: number
}

const timers = new Map<string, SleepTimer>()

export function getSleepInfo(guildId: string): { minutes: number; endsAt: number } | null {
  const t = timers.get(guildId)
  if (!t) return null
  return { minutes: t.minutes, endsAt: t.endsAt }
}

export function cancelSleep(guildId: string): boolean {
  const t = timers.get(guildId)
  if (!t) return false
  clearTimeout(t.timeout)
  clearInterval(t.fadeInterval)
  timers.delete(guildId)
  logline("music", "sleep timer cancelled")
  return true
}

/** Apply a volume level live to the playing resource. */
function applyVolume(queue: any, vol: number): void {
  queue.volume = vol
  try {
    if (queue.player.state.status === AudioPlayerStatus.Playing && queue.player.state.resource?.volume) {
      queue.player.state.resource.volume.setVolume(vol)
    }
  } catch {}
}

/**
 * Start a sleep timer. `onGoodnight` is called when the timer ends —
 * the caller stops music, says goodnight, and leaves voice.
 */
export function startSleep(
  guildId: string,
  minutes: number,
  queue: any,
  onGoodnight: () => Promise<void>
): void {
  cancelSleep(guildId)

  const totalMs = minutes * 60 * 1000
  const startVolume = queue.volume ?? 1.0
  const endsAt = Date.now() + totalMs

  // Fade: step down every 30s so the last minutes are whisper-quiet.
  const steps = Math.max(1, Math.floor(totalMs / 30000))
  const volStep = startVolume / steps
  let step = 0
  const fadeInterval = setInterval(() => {
    step++
    const v = Math.max(0, startVolume - volStep * step)
    applyVolume(queue, v)
    if (step >= steps) clearInterval(fadeInterval)
  }, 30000)

  const timeout = setTimeout(async () => {
    timers.delete(guildId)
    clearInterval(fadeInterval)
    // Restore volume for next time before leaving.
    queue.volume = startVolume
    logline("music", "sleep timer done — goodnight")
    try { await onGoodnight() } catch {}
  }, totalMs)

  timers.set(guildId, { timeout, fadeInterval, endsAt, minutes, startVolume })
  logline("music", `sleep timer set: ${minutes}min, fading from ${Math.round(startVolume * 100)}%`)
}
