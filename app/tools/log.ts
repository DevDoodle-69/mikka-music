/**
 * Mikka's console voice — one consistent, pretty log style.
 *
 *   10:23:45 ▸ command · @Mikka play despacito
 *   10:23:46 ▸ music   · now spinning "Blinding Lights"
 *
 * logline() for normal events, logerr() for errors (red).
 */
const RESET = "\x1b[0m"
const DIM = "\x1b[90m"
const RED = "\x1b[31m"

const COLORS: Record<string, string> = {
  command: "\x1b[36m", // cyan
  resolve: "\x1b[35m", // magenta
  autojoin: "\x1b[33m", // yellow
  voice: "\x1b[34m", // blue
  music: "\x1b[32m", // green
  cinema: "\x1b[95m", // bright pink
  radio: "\x1b[96m", // bright cyan
  tube: "\x1b[93m", // bright yellow
  mp3: "\x1b[94m", // bright blue
  net: "\x1b[37m" // white
}

function stamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false })
}

/* ------------------------------------------------------------------ */
/* Live log ring buffer — the dashboard streams these to the website.  */
/* ------------------------------------------------------------------ */
export interface LogEntry {
  t: string
  tag: string
  level: "info" | "error"
  msg: string
}
const LOG_CAP = 120
const logBuffer: LogEntry[] = []

function capture(tag: string, level: "info" | "error", parts: unknown[]): void {
  try {
    const msg = parts
      .map((p) => {
        if (typeof p === "string") return p
        try { return JSON.stringify(p) } catch { return String(p) }
      })
      .join(" ")
    logBuffer.push({ t: stamp(), tag: tag.toLowerCase(), level, msg: msg.slice(0, 500) })
    if (logBuffer.length > LOG_CAP) logBuffer.splice(0, logBuffer.length - LOG_CAP)
  } catch {
    // log capture never breaks logging
  }
}

/** Last N captured log entries, newest last. */
function recentLogs(n = 60): LogEntry[] {
  return logBuffer.slice(-n)
}

function paint(tag: string, ...parts: unknown[]): void {
  const key = tag.toLowerCase()
  const color = COLORS[key] ?? DIM
  const label = tag.padEnd(8, " ")
  console.log(`${DIM}${stamp()}${RESET} ${color}▸ ${label}${RESET} ·`, ...parts)
}

function logline(tag: string, ...parts: unknown[]): void {
  paint(tag, ...parts)
  capture(tag, "info", parts)
}

function logerr(tag: string, ...parts: unknown[]): void {
  const key = tag.toLowerCase()
  const color = COLORS[key] ?? DIM
  const label = tag.padEnd(8, " ")
  console.error(`${DIM}${stamp()}${RESET} ${RED}▸ ${label}${RESET} ·`, ...parts.map(p => `${color}${p}${RESET}`))
  capture(tag, "error", parts)
}

export { logline, logerr, recentLogs }
