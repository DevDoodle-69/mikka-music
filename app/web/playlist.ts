/**
 * playlist.ts — "My Playlist": user-uploaded audio files.
 *
 * The dashboard exposes an upload section; files land in PLAYLIST_DIR
 * (default ./data/playlist) and can be played with:
 *   @Mikka playlist play all   — shuffle-play every uploaded song
 *   @Mikka playlist play 10    — shuffle-play up to 10 of them
 *   @Mikka playlist list       — show what's uploaded
 *
 * NOTE on Render's free tier: the filesystem is ephemeral — uploads
 * survive until the next redeploy/restart. For a permanent library,
 * attach a persistent disk (PLAYLIST_DIR pointing at it) or re-upload
 * after deploys.
 */
import fs from "fs"
import path from "path"
import { logline } from "../tools/log"

export interface PlaylistTrack {
  name: string
  size: number
  addedAt: number
}

const DIR = process.env.PLAYLIST_DIR || path.join(process.cwd(), "data", "playlist")
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

export function listTracks(): PlaylistTrack[] {
  ensureDir()
  let files: string[] = []
  try { files = fs.readdirSync(DIR) } catch { return [] }
  return files
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => {
      try {
        const st = fs.statSync(path.join(DIR, f))
        return { name: f, size: st.size, addedAt: st.mtimeMs }
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

export async function saveUpload(rawName: string, data: Buffer): Promise<{ ok: boolean; name?: string; error?: string }> {
  const safe = sanitizeName(rawName)
  if (!safe) return { ok: false, error: "only audio files (mp3/m4a/wav/ogg/flac/opus/aac)" }
  if (!data || data.length === 0) return { ok: false, error: "empty file" }
  if (data.length > MAX_BYTES) return { ok: false, error: "file too big (100MB max)" }
  ensureDir()
  // Avoid overwriting: "song.mp3" -> "song (1).mp3"
  let name = safe
  let i = 1
  const ext = path.extname(safe)
  const stem = path.basename(safe, ext)
  while (fs.existsSync(path.join(DIR, name))) {
    name = `${stem} (${i})${ext}`
    i++
    if (i > 999) return { ok: false, error: "too many duplicates" }
  }
  try {
    await fs.promises.writeFile(path.join(DIR, name), data)
  } catch (err) {
    return { ok: false, error: "couldn't save file" }
  }
  logline("playlist", `uploaded "${name}" (${(data.length / 1048576).toFixed(1)}MB)`)
  return { ok: true, name }
}

export function deleteTrack(name: string): boolean {
  const p = trackPath(name)
  if (!p) return false
  try {
    fs.unlinkSync(p)
    logline("playlist", `deleted "${name}"`)
    return true
  } catch { return false }
}
