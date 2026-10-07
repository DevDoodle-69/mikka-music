import dotenv from "dotenv"
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
  mp3ApiKey: process.env.MP3_API_KEY || ""
}

if (!config.token || !config.ownerId || !config.mp3ApiKey) {
  try {
    const fileConfig: { prefix?: string; token?: string; ownerId?: string; allowedUsers?: string[]; mp3ApiBase?: string; mp3ApiKey?: string } = require("../config.json")
    config.prefix = fileConfig.prefix || config.prefix
    config.token = fileConfig.token || config.token
    config.ownerId = fileConfig.ownerId || config.ownerId
    config.allowedUsers = fileConfig.allowedUsers || config.allowedUsers
    config.mp3ApiBase = fileConfig.mp3ApiBase || config.mp3ApiBase
    config.mp3ApiKey = fileConfig.mp3ApiKey || config.mp3ApiKey
  } catch {
    // config.json is optional when env vars are set
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
