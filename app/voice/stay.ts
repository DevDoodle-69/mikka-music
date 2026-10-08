/**
 * stay.ts — "stay mode": when ON, the bot does NOT auto-leave when the
 * owner leaves the voice channel. It keeps playing in place.
 *
 * Stay turns itself OFF the moment the owner joins a DIFFERENT voice
 * channel — from then on she follows/leaves with them normally again,
 * until `stay` is used again.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { logline } from "../tools/log"

const FILE = path.join(os.tmpdir(), "mikka-stay.json")
let stay = false

try {
  if (fs.existsSync(FILE)) {
    stay = JSON.parse(fs.readFileSync(FILE, "utf8"))?.stay === true
  }
} catch {}

export function isStayMode(): boolean {
  return stay
}

export function setStayMode(on: boolean): void {
  stay = on
  try {
    fs.writeFileSync(FILE, JSON.stringify({ stay }))
  } catch {}
  logline("voice", `stay mode ${on ? "ON — I'll hold the channel" : "OFF — back to following you"}`)
}
