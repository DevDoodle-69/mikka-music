/**
 * grabber.ts — professional multi-layer YouTube audio downloader.
 *
 * Strategy (in order):
 *   1. yt-dlp-exec  — npm-managed fresh yt-dlp binary (primary)
 *   2. system yt-dlp — the Docker image's bundled binary (fallback)
 *   3. @distube/ytdl-core — pure-JS, no binary needed (last resort)
 *
 * Every layer downloads best-audio to a temp file and returns the path.
 * Throws only when ALL layers fail.
 */
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import config from "../setup"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ytdlpExec = require("yt-dlp-exec") as (url: string, opts: Record<string, any>) => Promise<string>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ytdlCore = require("@distube/ytdl-core") as any

function tmpFile(): string {
  return path.join(os.tmpdir(), `mikka-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.dl`)
}

function cookieArgs(): string[] {
  return fs.existsSync(config.cookiesFile) ? ["--cookies", config.cookiesFile] : []
}

/** Layer 1: yt-dlp via the npm-managed binary (always fresh). */
async function viaYtdlpExec(url: string, tmp: string): Promise<void> {
  const clients = ["android", "tv", "web"]
  let lastErr: any = null
  for (const client of clients) {
    try {
      console.log(`[grabber] yt-dlp-exec attempt (client: ${client})`)
      await ytdlpExec(url, {
        format: "bestaudio",
        output: tmp,
        noPlaylist: true,
        retries: 3,
        fragmentRetries: 3,
        jsRuntimes: "node",
        extractorArgs: `youtube:player_client=${client}`,
        ...(fs.existsSync(config.cookiesFile) ? { cookies: config.cookiesFile } : {}),
      })
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0
      if (size > 0) {
        console.log(`[grabber] yt-dlp-exec grabbed ${(size / 1024).toFixed(0)}KB (client: ${client})`)
        return
      }
      throw new Error("empty download")
    } catch (err: any) {
      lastErr = err
      const msg = String(err?.message || err)
      console.error(`[grabber] yt-dlp-exec failed (client: ${client}): ${msg.slice(-200)}`)
      try { fs.unlinkSync(tmp) } catch {}
      // Only retry with the next client on bot-check style errors
      if (!/sign in to confirm|not a bot|429|too many requests|forbidden/i.test(msg)) break
    }
  }
  throw lastErr || new Error("yt-dlp-exec failed")
}

/** Layer 2: system yt-dlp binary (bundled in Docker image). */
async function viaSystemYtdlp(url: string, tmp: string, timeoutMs: number): Promise<void> {
  const clients: string[][] = [
    ["--extractor-args", "youtube:player_client=android"],
    ["--extractor-args", "youtube:player_client=tv"],
    [],
  ]
  let lastErr = ""
  for (let i = 0; i < clients.length; i++) {
    const args = ["-f", "bestaudio", "--no-playlist", "--retries", "3",
      "--fragment-retries", "3", "--js-runtimes", "node", "-o", tmp,
      ...cookieArgs(), ...clients[i], url]
    console.log(`[grabber] system yt-dlp attempt ${i + 1}`)
    const errMsg: string | null = await new Promise((resolve) => {
      let stderr = ""
      let done = false
      const finish = (msg: string | null) => { if (!done) { done = true; resolve(msg) } }
      const timer = setTimeout(() => { try { dl.kill("SIGKILL") } catch {} ; finish("timed out") }, timeoutMs)
      let dl: any
      try {
        dl = spawn(config.ytdlpExecutable, args)
      } catch (e: any) {
        clearTimeout(timer)
        finish(`spawn failed: ${e.message}`)
        return
      }
      dl.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      dl.on("error", (e: Error) => { clearTimeout(timer); try { fs.unlinkSync(tmp) } catch {} ; finish(`error: ${e.message}`) })
      dl.on("close", (code: number | null) => {
        clearTimeout(timer)
        let size = 0
        try { size = fs.statSync(tmp).size } catch {}
        if (code === 0 && size > 0) {
          console.log(`[grabber] system yt-dlp grabbed ${(size / 1024).toFixed(0)}KB`)
          finish(null)
        } else {
          try { fs.unlinkSync(tmp) } catch {}
          finish(`code ${code}: ${stderr.slice(-200).trim().split("\n").pop() || "unknown"}`)
        }
      })
    })
    if (errMsg === null) return
    lastErr = errMsg
    console.error(`[grabber] system yt-dlp failed: ${errMsg.slice(-160)}`)
    if (!/sign in to confirm|not a bot|429|too many requests|forbidden/i.test(errMsg)) break
  }
  throw new Error(`system yt-dlp failed: ${lastErr.slice(-160)}`)
}

/** Layer 3: @distube/ytdl-core — pure JS, no binary. Picks highest-audio format. */
async function viaYtdlCore(url: string, tmp: string, timeoutMs: number): Promise<void> {
  console.log("[grabber] ytdl-core attempt (pure JS)")
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) { try { fs.unlinkSync(tmp) } catch {} ; reject(err) }
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error("ytdl-core timed out")), timeoutMs)
    let stream: any
    try {
      stream = ytdlCore(url, {
        filter: "audioonly",
        quality: "highestaudio",
        highWaterMark: 1 << 25,
      })
    } catch (e: any) {
      finish(new Error(`ytdl-core start failed: ${e.message}`))
      return
    }
    const out = fs.createWriteStream(tmp)
    stream.on("error", (e: Error) => finish(new Error(`ytdl-core stream: ${e.message.slice(0, 160)}`)))
    out.on("error", (e: Error) => finish(new Error(`ytdl-core write: ${e.message.slice(0, 160)}`)))
    out.on("finish", () => {
      let size = 0
      try { size = fs.statSync(tmp).size } catch {}
      if (size > 0) {
        console.log(`[grabber] ytdl-core grabbed ${(size / 1024).toFixed(0)}KB`)
        finish(null)
      } else {
        finish(new Error("ytdl-core produced an empty file"))
      }
    })
    stream.pipe(out)
  })
}

/**
 * Download best-audio for a YouTube URL to a temp file.
 * Tries yt-dlp-exec -> system yt-dlp -> ytdl-core. Returns temp path.
 */
export async function grabAudio(url: string): Promise<string> {
  const tmp = tmpFile()
  const errors: string[] = []

  try { await viaYtdlpExec(url, tmp); return tmp } catch (e: any) {
    errors.push(`yt-dlp-exec: ${(e.message || e).toString().slice(0, 120)}`)
  }
  try { await viaSystemYtdlp(url, tmp, 120000); return tmp } catch (e: any) {
    errors.push(`system yt-dlp: ${(e.message || e).toString().slice(0, 120)}`)
  }
  try { await viaYtdlCore(url, tmp, 120000); return tmp } catch (e: any) {
    errors.push(`ytdl-core: ${(e.message || e).toString().slice(0, 120)}`)
  }
  try { fs.unlinkSync(tmp) } catch {}
  const blocked = /sign in|not a bot|429|too many requests|forbidden|sabr/i.test(errors.join(" "))
  const hint = blocked && !fs.existsSync(config.cookiesFile)
    ? " — YouTube is blocking this server's IP. Set YOUTUBE_COOKIES (your YouTube login cookies) to bypass it."
    : ""
  throw new Error(`all download layers failed${hint} — ${errors.join(" | ")}`)
}
