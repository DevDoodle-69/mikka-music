import dotenv from "dotenv"
import fs from "fs"
import os from "os"
import path from "path"
import { Config } from "./types"

dotenv.config()

const config: Config = {
  prefix: process.env.DISCORD_PREFIX || "?",
  token: process.env.DISCORD_TOKEN || "",
  ownerId: process.env.OWNER_ID || "",
  allowedUsers: process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(",") : [],
  ytdlpExecutable: process.platform === "win32" ? "./yt-dlp.exe" : "yt-dlp",
  ffmpeg: process.platform === "win32" ? require("ffmpeg-static") : "ffmpeg",
  stateFile: process.env.STATE_FILE || path.join(__dirname, "..", "state.json"),
  cookiesFile: process.env.COOKIES_FILE || path.join(__dirname, "..", "cookies.txt"),
  mp3ApiBase: process.env.MP3_API_BASE || "https://fgsi.dpdns.org/api/downloader/youtube/v2",
  mp3ApiKey: process.env.MP3_API_KEY || "",
  youtubeCookies: process.env.YOUTUBE_COOKIES || ""
}

if (!config.token || !config.ownerId || !config.mp3ApiKey) {
  try {
    const fileConfig: { prefix?: string; token?: string; ownerId?: string; allowedUsers?: string[]; mp3ApiBase?: string; mp3ApiKey?: string; youtubeCookies?: string } = require("../config.json")
    config.prefix = fileConfig.prefix || config.prefix
    config.token = fileConfig.token || config.token
    config.ownerId = fileConfig.ownerId || config.ownerId
    config.allowedUsers = fileConfig.allowedUsers || config.allowedUsers
    config.mp3ApiBase = fileConfig.mp3ApiBase || config.mp3ApiBase
    config.mp3ApiKey = fileConfig.mp3ApiKey || config.mp3ApiKey
    config.youtubeCookies = fileConfig.youtubeCookies || config.youtubeCookies
  } catch {
    // config.json is optional when env vars are set
  }
}

// If raw cookie content was provided (env YOUTUBE_COOKIES or config.json),
// write it to a temp Netscape-format cookies file so yt-dlp can use it.
// This is how you pass your own YouTube login: export cookies.txt from a
// cookie-editor extension and paste the whole file content.
if (config.youtubeCookies && config.youtubeCookies.trim()) {
  try {
    const cookiePath = path.join(os.tmpdir(), "youtube-cookies.txt")
    fs.writeFileSync(cookiePath, config.youtubeCookies.trim() + "\n")
    config.cookiesFile = cookiePath
    console.log("YouTube cookies loaded, yt-dlp will search as your account")
  } catch (err) {
    console.error("Failed to write YouTube cookies file:", (err as Error).message)
  }
}

if (!config.token) {
  console.error("Error: DISCORD_TOKEN environment variable or config.json \"token\" is required")
  process.exit(1)
}

if (!config.ownerId) {
  console.error("Error: OWNER_ID environment variable or config.json \"ownerId\" is required")
  process.exit(1)
}

export default config
