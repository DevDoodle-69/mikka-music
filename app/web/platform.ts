/**
 * platform.ts — global music platform preference.
 *
 * "youtube" (default) or "spotify". Switched via `@Mikka proxyset`.
 * Persisted to disk so it survives restarts.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { logline } from "../tools/log"

export type Platform = "youtube" | "spotify"

const FILE = path.join(os.tmpdir(), "mikka-platform.json")
let current: Platform = "youtube"

// Load persisted choice at startup.
try {
  if (fs.existsSync(FILE)) {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"))
    if (saved?.platform === "spotify" || saved?.platform === "youtube") {
      current = saved.platform
    }
  }
} catch {}

export function getPlatform(): Platform {
  return current
}

export function setPlatform(p: Platform): void {
  current = p
  try {
    fs.writeFileSync(FILE, JSON.stringify({ platform: p }))
  } catch {}
  logline("music", `platform switched to ${p}`)
}
