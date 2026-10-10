/**
 * playlist.ts — "My Playlist": user-uploaded audio files.
 *
 * The dashboard exposes an upload section; files land in PLAYLIST_DIR
 * (default ./data/playlist) and can be played with:
 *   @Mikka playlist play all   — shuffle-play every uploaded song
 *   @Mikka playlist play 10    — shuffle-play up to 10 of them
 *   @Mikka playlist list       — show what's uploaded
 *   @Mikka playlist add <url>   — download a song link into the playlist
 *
 * An index.json remembers each track's source URL, so if a file ever
 * goes missing (e.g. Render's ephemeral disk after a redeploy), the bot
 * silently re-downloads it from the source instead of failing.
 *
 * NOTE on Render's free tier: the filesystem is ephemeral — uploads
 * survive until the next redeploy/restart. Tracks added via URL
 * self-heal; dashboard uploads need a re-upload after a redeploy.
 */
import fs from "fs"
import path from "path"
import { logline, logerr } from "../tools/log"
import { resolveStream, downloadSnowpingMp3 } from "./snowping"
import { resolveSpotifyDownload } from "./spotify"

export interface PlaylistTrack {
  name: string
  size: number
  addedAt: number
  sourceUrl?: string | null
}

const DIR = process.env.PLAYLIST_DIR || path.join(process.cwd(), "data", "playlist")
const INDEX_FILE = "index.json"
const MAX_BYTES = 100 * 1024 * 1024 // 100MB per file
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac", ".wma"])

function ensureDir(): void {
  try { fs.mkdirSync(DIR, { recursive: true }) } catch {}
}

export function playlistDir(): string {
  ensureDir()
  return DIR
}

/** Strip path tricks and junk chars; null if not an audio file. */
export function sanitizeName(raw: string): string | null {
  const base = path.basename((raw || "").trim())
  if (!base) return null
  const clean = base.replace(/[^a-zA-Z0-9 _.\-()[\]]/g, "").slice(0, 100)
  const ext = path.extname(clean).toLowerCase()
  if (!AUDIO_EXT.has(ext) || clean.length <= ext.length) return null
  return clean
}

interface IndexData { [name: string]: { sourceUrl: string | null; addedAt: number } }

function indexPath(): string {
  ensureDir()
  return path.join(DIR, INDEX_FILE)
}

function readIndex(): IndexData {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8")
    const j = JSON.parse(raw)
    return j && typeof j === "object" ? j : {}
  } catch { return {} }
}

function writeIndex(idx: IndexData): void {
  try { fs.writeFileSync(indexPath(), JSON.stringify(idx)) } catch {}
}

function setIndexEntry(name: string, sourceUrl: string | null): void {
  const idx = readIndex()
  idx[name] = { sourceUrl, addedAt: Date.now() }
  writeIndex(idx)
}

function dropIndexEntry(name: string): void {
  const idx = readIndex()
  if (idx[name]) { delete idx[name]; writeIndex(idx) }
}

export function listTracks(): PlaylistTrack[] {
  ensureDir()
  const idx = readIndex()
  let files: string[] = []
  try { files = fs.readdirSync(DIR) } catch { return [] }
  return files
    .filter((f) => f !== INDEX_FILE && AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .map((f): PlaylistTrack | null => {
      try {
        const st = fs.statSync(path.join(DIR, f))
        return { name: f, size: st.size, addedAt: st.mtimeMs, sourceUrl: idx[f]?.sourceUrl || null }
      } catch { return null }
    })
    .filter((t): t is PlaylistTrack => t !== null)
    .sort((a, b) => b.addedAt - a.addedAt)
}

/** Absolute path for a track name, or null (missing/unsafe). */
export function trackPath(name: string): string | null {
  const safe = sanitizeName(name)
  if (!safe) return null
  ensureDir()
  const p = path.join(DIR, safe)
  if (!p.startsWith(DIR + path.sep)) return null
  try { return fs.existsSync(p) ? p : null } catch { return null }
}

/** Unique non-colliding file name inside the playlist dir. */
function uniqueName(safe: string): string {
  ensureDir()
  let name = safe
  let i = 1
  const ext = path.extname(safe)
  const stem = path.basename(safe, ext)
  while (fs.existsSync(path.join(DIR, name))) {
    name = `${stem} (${i})${ext}`
    i++
    if (i > 999) break
  }
  return name
}

export async function saveUpload(rawName: string, data: Buffer): Promise<{ ok: boolean; name?: string; error?: string }> {
  const safe = sanitizeName(rawName)
  if (!safe) return { ok: false, error: "only audio files (mp3/m4a/wav/ogg/flac/opus/aac)" }
  if (!data || data.length === 0) return { ok: false, error: "empty file" }
  if (data.length > MAX_BYTES) return { ok: false, error: "file too big (100MB max)" }
  const name = uniqueName(safe)
  try {
    await fs.promises.writeFile(path.join(DIR, name), data)
  } catch {
    return { ok: false, error: "couldn't save file" }
  }
  setIndexEntry(name, null) // dashboard upload: no source URL to re-fetch from
  logline("playlist", `uploaded "${name}" (${(data.length / 1048576).toFixed(1)}MB)`)
  scheduleBackup()
  return { ok: true, name }
}

/**
 * Download a song link into the playlist.
 * Accepts: direct audio URLs, YouTube links/queries, Spotify track links.
 * If preferName is given (re-download), the same file name is reused.
 */
export async function addFromUrl(url: string, preferName?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  const u = (url || "").trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: "give me a proper http(s) link~" }
  let dlUrl: string
  let title: string
  try {
    if (/open\.spotify\.com/i.test(u)) {
      const dl = await resolveSpotifyDownload(u)
      if (!dl.downloadUrl) throw new Error("no download for that spotify link")
      dlUrl = dl.downloadUrl
      title = dl.artist ? `${dl.artist} - ${dl.title}` : dl.title
    } else if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)(\?|#|$)/i.test(u)) {
      dlUrl = u
      const tail = decodeURIComponent(u.split("/").pop() || "track").split("?")[0]
      title = tail.replace(/\.[^.]+$/, "") || "track"
    } else {
      const track = await resolveStream(u)
      if (!track.streamUrl) throw new Error("couldn't resolve that link")
      dlUrl = track.streamUrl
      title = track.title || "track"
    }
  } catch (err) {
    return { ok: false, error: `couldn't resolve that link (${((err as Error).message || "").slice(0, 60)})` }
  }

  let tmp = ""
  try {
    tmp = await downloadSnowpingMp3(dlUrl)
    const st = fs.statSync(tmp)
    if (st.size > MAX_BYTES) { try { fs.unlinkSync(tmp) } catch {} return { ok: false, error: "file too big (100MB max)" } }
    if (st.size === 0) { try { fs.unlinkSync(tmp) } catch {} return { ok: false, error: "download came back empty" }
    }
    const wanted = (preferName && sanitizeName(preferName)) || sanitizeName(`${title}.mp3`) || "track.mp3"
    // Re-download of a known name: overwrite it in place.
    const name = preferName && sanitizeName(preferName) ? (sanitizeName(preferName) as string) : uniqueName(wanted)
    ensureDir()
    await fs.promises.copyFile(tmp, path.join(DIR, name))
    try { fs.unlinkSync(tmp) } catch {}
    setIndexEntry(name, u)
    logline("playlist", `added "${name}" from url (${(st.size / 1048576).toFixed(1)}MB)`)
    scheduleBackup()
    return { ok: true, name }
  } catch (err) {
    if (tmp) { try { fs.unlinkSync(tmp) } catch {} }
    logerr("playlist", "addFromUrl failed:", (err as Error).message?.slice(0, 80))
    return { ok: false, error: `download failed (${((err as Error).message || "").slice(0, 60)})` }
  }
}

/**
 * Resolve a playable path for a track name. If the file is missing but we
 * know its source URL, re-download it on the fly (self-healing).
 */
export async function ensureTrack(name: string): Promise<string | null> {
  const direct = trackPath(name)
  if (direct) return direct
  const safe = sanitizeName(name)
  if (!safe) {
    logerr("playlist", `ensureTrack: sanitize failed for "${name}"`)
    return null
  }
  const entry = readIndex()[safe]
  if (!entry?.sourceUrl) {
    let files: string[] = []
    try { files = fs.readdirSync(DIR) } catch {}
    logerr("playlist", `ensureTrack miss: name="${name}" safe="${safe}" dir="${DIR}" files=[${files.slice(0, 8).join(", ")}]`)
    return null
  }
  logline("playlist", `file gone, re-fetching "${safe}" from source`)
  const r = await addFromUrl(entry.sourceUrl, safe)
  if (!r.ok || !r.name) return null
  return trackPath(r.name)
}

export function deleteTrack(name: string): boolean {
  const p = trackPath(name)
  if (!p) return false
  try {
    fs.unlinkSync(p)
    dropIndexEntry(path.basename(p))
    logline("playlist", `deleted "${name}"`)
    scheduleBackup()
    return true
  } catch { return false }
}

/** Debug snapshot: dir, files on disk, and per-track resolution. */
export function debugPlaylist(): { dir: string; files: string[]; index: IndexData; resolved: Array<{ name: string; path: string | null }> } {
  ensureDir()
  let files: string[] = []
  try { files = fs.readdirSync(DIR) } catch {}
  const idx = readIndex()
  const tracks = listTracks()
  return {
    dir: DIR,
    files,
    index: idx,
    resolved: tracks.map((t) => ({ name: t.name, path: trackPath(t.name) })),
  }
}

// ---------------------------------------------------------------------------
// DM backup / restore — makes My Playlist survive Render redeploys.
//
// Render's free disk wipes on every deploy, so the playlist index (track
// names + source URLs) is mirrored into a marker message in the owner's DM.
// On startup the bot reads it back and re-downloads anything missing.
// ---------------------------------------------------------------------------

const BACKUP_MARKER = "MIKKA-PLAYLIST-BACKUP-v1"

let backupClient: any = null
let backupOwnerId: string = ""
let backupTimer: NodeJS.Timeout | null = null

export function setPlaylistBackup(client: any, ownerId: string): void {
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

/** Debounced: backs up at most once per 15s, always trailing. */
export function scheduleBackup(): void {
  if (!backupClient || !backupOwnerId) return
  if (backupTimer) return
  backupTimer = setTimeout(async () => {
    backupTimer = null
    try {
      const idx = readIndex()
      const tracks = Object.entries(idx).map(([name, e]) => ({ name, url: e.sourceUrl }))
      const payload = `${BACKUP_MARKER}\n\`\`\`json\n${JSON.stringify({ tracks }, null, 1)}\n\`\`\``
      const user = await backupClient.users.fetch(backupOwnerId)
      const dm = user.dmChannel || (await user.createDM())
      const existing = await findBackupMessage(dm, backupClient)
      if (existing) await existing.edit(payload)
      else await dm.send(payload)
      logline("playlist", `index backed up (${tracks.length} tracks)`)
    } catch (err) {
      logerr("playlist", "backup failed:", (err as Error).message?.slice(0, 60))
    }
  }, 15000)
}

/** On startup: restore index from the DM backup, re-download what's missing. Returns restored count. */
export async function restorePlaylist(client: any, ownerId: string): Promise<number> {
  try {
    const user = await client.users.fetch(ownerId)
    const dm = user.dmChannel || (await user.createDM())
    const found = await findBackupMessage(dm, client)
    if (!found) return 0
    const jsonStr = found.content.slice(BACKUP_MARKER.length).replace(/```json|```/g, "").trim()
    const data = JSON.parse(jsonStr)
    if (!data || !Array.isArray(data.tracks)) return 0
    const idx = readIndex()
    let added = 0
    const missing: Array<{ name: string; url: string }> = []
    for (const t of data.tracks) {
      const safe = sanitizeName(t?.name || "")
      if (!safe || idx[safe]) continue
      idx[safe] = { sourceUrl: t.url || null, addedAt: Date.now() }
      added++
      if (t.url && !trackPath(safe)) missing.push({ name: safe, url: t.url })
    }
    if (added > 0) writeIndex(idx)
    if (missing.length > 0) {
      logline("playlist", `restored ${added} tracks from backup — re-downloading ${missing.length} in background`)
      ;(async () => {
        for (const m of missing) {
          try { await addFromUrl(m.url, m.name) } catch {}
        }
        logline("playlist", "background restore done")
      })()
    } else if (added > 0) {
      logline("playlist", `restored ${added} tracks from backup`)
    }
    return added
  } catch (err) {
    logerr("playlist", "restore failed:", (err as Error).message?.slice(0, 60))
    return 0
  }
}
