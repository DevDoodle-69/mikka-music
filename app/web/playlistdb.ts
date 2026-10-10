/**
 * playlistdb.ts — Mikka's personal playlist database.
 *
 * A local JSON database of { name, url } entries, managed entirely from
 * Discord chat:
 *
 *   @Mikka playlist add <url> <song name>  — save a song (direct MP3 link,
 *                                            YouTube or Spotify URL)
 *   @Mikka playlist                        — show all songs with names
 *   @Mikka playlist play <n|name>           — play one
 *   @Mikka playlist play all                — shuffle everything
 *   @Mikka playlist remove <n|name>         — delete one
 *
 * Direct audio URLs play WITHOUT any API (resilient when YouTube/Spotify
 * APIs are down). YouTube/Spotify URLs resolve through the normal chain.
 *
 * Durability: the DB file lives on local disk AND is mirrored to a marker
 * message in the owner's DM (survives Render redeploys, which wipe disk).
 */
import fs from "fs"
import path from "path"
import { logline, logerr } from "../tools/log"

export interface PlaylistEntry {
  name: string
  url: string
  addedAt: number
}

const DB_DIR = process.env.PLAYLISTDB_DIR || path.join(process.cwd(), "data", "playlistdb")
const DB_FILE = path.join(DB_DIR, "playlist.json")

function ensureDir(): void {
  try { fs.mkdirSync(DB_DIR, { recursive: true }) } catch {}
}

function readDb(): PlaylistEntry[] {
  ensureDir()
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8")
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      return arr.filter((e) => e && typeof e.name === "string" && typeof e.url === "string")
    }
  } catch {}
  return []
}

function writeDb(entries: PlaylistEntry[]): void {
  ensureDir()
  const tmp = DB_FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 1))
  fs.renameSync(tmp, DB_FILE)
}

/** Normalize a name for duplicate detection. */
function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

export function listSongs(): PlaylistEntry[] {
  return readDb()
}

export function songCount(): number {
  return readDb().length
}

/** Add or update an entry. Returns the stored entry. */
export function addSong(name: string, url: string): PlaylistEntry {
  const cleanName = name.trim().slice(0, 120)
  const cleanUrl = url.trim()
  if (!cleanName) throw new Error("give the song a name")
  if (!/^https?:\/\//i.test(cleanUrl)) throw new Error("that doesn't look like a link")
  const entries = readDb()
  const key = normName(cleanName)
  const existing = entries.findIndex((e) => normName(e.name) === key)
  const entry: PlaylistEntry = { name: cleanName, url: cleanUrl, addedAt: Date.now() }
  if (existing >= 0) entries[existing] = entry
  else entries.push(entry)
  writeDb(entries)
  logline("playlist", `${existing >= 0 ? "updated" : "added"} "${cleanName}"`)
  scheduleBackup()
  return entry
}

/** Remove by exact name (case-insensitive) or 1-based index. Returns removed or null. */
export function removeSong(query: string): PlaylistEntry | null {
  const entries = readDb()
  let idx = -1
  const n = parseInt(query, 10)
  if (!isNaN(n) && n >= 1 && n <= entries.length) {
    idx = n - 1
  } else {
    const key = normName(query)
    idx = entries.findIndex((e) => normName(e.name) === key || normName(e.name).includes(key))
  }
  if (idx < 0) return null
  const [removed] = entries.splice(idx, 1)
  writeDb(entries)
  logline("playlist", `removed "${removed.name}"`)
  scheduleBackup()
  return removed
}

/** Find by 1-based index or (fuzzy) name. */
export function findSong(query: string): PlaylistEntry | null {
  const entries = readDb()
  const n = parseInt(query, 10)
  if (!isNaN(n) && n >= 1 && n <= entries.length) return entries[n - 1]
  const key = normName(query)
  return entries.find((e) => normName(e.name) === key || normName(e.name).includes(key)) || null
}

export function clearSongs(): number {
  const count = readDb().length
  writeDb([])
  logline("playlist", `cleared ${count} songs`)
  scheduleBackup()
  return count
}

/** Guess the platform for a URL: direct audio vs youtube vs spotify. */
export function platformForUrl(url: string): "direct" | "youtube" | "spotify" {
  const u = url.toLowerCase()
  if (u.includes("spotify.com")) return "spotify"
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube"
  return "direct"
}

// ---------------------------------------------------------------------------
// DM backup / restore — the DB survives Render redeploys.
// ---------------------------------------------------------------------------

const BACKUP_MARKER = "MIKKA-PLAYLISTDB-v1"

let backupClient: any = null
let backupOwnerId: string = ""
let backupTimer: NodeJS.Timeout | null = null

export function setPlaylistDbBackup(client: any, ownerId: string): void {
  backupClient = client
  backupOwnerId = ownerId
}

async function findBackupMessage(dm: any, client: any): Promise<any | null> {
  try {
    const msgs = await dm.messages.fetch({ limit: 30 })
    const list = msgs.values ? [...msgs.values()] : msgs
    for (const m of list) {
      if (m?.author?.id === client?.user?.id && typeof m.content === "string" && m.content.startsWith(BACKUP_MARKER)) {
        return m
      }
    }
  } catch {}
  return null
}

/** Debounced backup (max once per 15s, trailing). */
export function scheduleBackup(): void {
  if (!backupClient || !backupOwnerId) return
  if (backupTimer) return
  backupTimer = setTimeout(async () => {
    backupTimer = null
    try {
      const entries = readDb()
      const payload = `${BACKUP_MARKER}\n\`\`\`json\n${JSON.stringify({ songs: entries }, null, 1)}\n\`\`\``
      const user = await backupClient.users.fetch(backupOwnerId)
      const dm = user.dmChannel || (await user.createDM())
      const existing = await findBackupMessage(dm, backupClient)
      if (existing) await existing.edit(payload)
      else await dm.send(payload)
      logline("playlist", `playlist DB backed up (${entries.length} songs)`)
    } catch (err) {
      logerr("playlist", "DB backup failed:", (err as Error).message?.slice(0, 60))
    }
  }, 15000)
}

/** Restore DB from the DM backup on startup. Returns restored count. */
export async function restorePlaylistDb(client: any, ownerId: string): Promise<number> {
  try {
    const user = await client.users.fetch(ownerId)
    const dm = user.dmChannel || (await user.createDM())
    const found = await findBackupMessage(dm, client)
    if (!found) return 0
    const jsonStr = found.content.slice(BACKUP_MARKER.length).replace(/```json|```/g, "").trim()
    const data = JSON.parse(jsonStr)
    if (!data || !Array.isArray(data.songs)) return 0
    const current = readDb()
    if (current.length > 0) return 0 // disk already has data — don't overwrite
    const valid: PlaylistEntry[] = data.songs.filter(
      (e: any) => e && typeof e.name === "string" && typeof e.url === "string"
    )
    if (valid.length > 0) {
      writeDb(valid)
      logline("playlist", `restored ${valid.length} songs from DM backup`)
    }
    return valid.length
  } catch (err) {
    logerr("playlist", "DB restore failed:", (err as Error).message?.slice(0, 60))
    return 0
  }
}
