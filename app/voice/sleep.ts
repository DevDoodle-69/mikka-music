/**
 * sleep.ts — sleep timer with gentle volume fade-out.
 *
 * `@Mikka sleep 30` / `^sleep 30min` → over the duration, volume fades to
 * zero, then she whispers goodnight, stops everything, and leaves voice.
 * `^sleep 30sec` / `^sleep 1h` also work.
 */
import { AudioPlayerStatus } from "@discordjs/voice"
import { logline } from "../tools/log"

interface SleepTimer {
  timeout: NodeJS.Timeout
  fadeInterval: NodeJS.Timeout
  endsAt: number
  totalMs: number
  startVolume: number
}

const timers = new Map<string, SleepTimer>()

export function getSleepInfo(guildId: string): { totalMs: number; endsAt: number } | null {
  const t = timers.get(guildId)
  if (!t) return null
  return { totalMs: t.totalMs, endsAt: t.endsAt }
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
 * Start a sleep timer. `totalMs` is the duration in milliseconds.
 * `onGoodnight` is called when the timer ends — the caller stops music,
 * says goodnight, disconnects the owner, and leaves voice.
 */
export function startSleepMs(
  guildId: string,
  totalMs: number,
  queue: any,
  onGoodnight: () => Promise<void>
): void {
  cancelSleep(guildId)

  const startVolume = queue.volume ?? 1.0
  const endsAt = Date.now() + totalMs

  // Fade: up to 10 gentle steps; step interval adapts to short timers
  // (30s timer → 3s steps) instead of the fixed 30s cadence.
  const steps = Math.min(10, Math.max(1, Math.floor(totalMs / 3000)))
  const stepMs = Math.max(1000, Math.floor(totalMs / steps))
  const volStep = startVolume / steps
  let step = 0
  const fadeInterval = setInterval(() => {
    step++
    const v = Math.max(0, startVolume - volStep * step)
    applyVolume(queue, v)
    if (step >= steps) clearInterval(fadeInterval)
  }, stepMs)

  const timeout = setTimeout(async () => {
    timers.delete(guildId)
    clearInterval(fadeInterval)
    // Restore volume for next time before leaving.
    queue.volume = startVolume
    logline("music", "sleep timer done — goodnight")
    try { await onGoodnight() } catch {}
  }, totalMs)

  timers.set(guildId, { timeout, fadeInterval, endsAt, totalMs, startVolume })
  logline("music", `sleep timer set: ${Math.round(totalMs / 1000)}s, fading from ${Math.round(startVolume * 100)}%`)
}

/** Back-compat wrapper: minutes → ms. */
export function startSleep(
  guildId: string,
  minutes: number,
  queue: any,
  onGoodnight: () => Promise<void>
): void {
  startSleepMs(guildId, minutes * 60 * 1000, queue, onGoodnight)
}
