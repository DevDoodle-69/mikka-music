# Mikka Music v2 — Selfbot Music Player

A Discord **self-account** music bot with a coy personality: your own
account joins voice channels and plays music from YouTube, controlled
by mentioning it.

## What it does

- **Mention commands** — type `@YourBotName play shape of you` in any text
  channel (the classic `?` prefix also works, e.g. `?play shape of you`)
- **Owner-only** — it only answers to one Discord user ID (yours).
  Everyone else is ignored.
- **Auto-join** — the moment you join any voice channel, it joins instantly.
  When you leave, it leaves too.
- **Coy, human-like replies** — every response has a typing delay scaled to
  its length, plain text (zero emojis), and she picks from several playful
  variants so she never sounds like a robot.
- **Full music kit** — YouTube search/play/playlists, queue, skip, loop,
  shuffle, volume, internet radio, reaction control panel, persistent
  state that resumes after restarts.

### Command list

| Command | What it does |
|---|---|
| `@bot play <song name>` | Search YouTube and play |
| `@bot play <url>` | Play a video, playlist, or several URLs |
| `@bot skip` | Skip current song |
| `@bot queue` | Show the queue |
| `@bot loop` | Toggle Off / Single / All |
| `@bot shuffle` | Shuffle the queue |
| `@bot volume 0-100` | Set volume |
| `@bot radio <name or url>` | Play an internet radio station |
| `@bot panel` | Reaction control panel (tap the buttons) |
| `@bot join <voice_channel_id>` | Join a voice channel by ID |
| `@bot leave` | Leave voice + clear queue |
| `@bot stop` | Stop and clear queue |
| `@bot state` | Show current status |
| `@bot help` | Show help |

Replace `@bot` with an actual mention of the account.

## How playback works (fallback chains)

YouTube blocks datacenter IPs, so every step has a primary path and
a backup:

1. **Find the song**
   - Text search → YouTube Data API v3 → fallback: yt-dlp search
     (with your cookies)
   - Direct link → oEmbed, no auth needed at all
   - Playlist → YouTube Data API v3 (paginated) → fallback: yt-dlp
2. **Get the audio**
   - Your MP3 downloader API converts the URL → direct mp3 → downloaded
     to temp storage → played through ffmpeg
   - If the API hiccups → fallback: yt-dlp live stream
   - Temp files are deleted when the song ends, is skipped, or is stopped

## Configuration

The bot reads `config.json` (see `config.example.json`):

```json
{
  "token": "YOUR_DISCORD_TOKEN_HERE",
  "ownerId": "YOUR_OWNER_DISCORD_ID_HERE",
  "prefix": "?",
  "mp3ApiKey": "YOUR_MP3_API_KEY_HERE",
  "youtubeApiKey": "YOUR_YOUTUBE_DATA_API_V3_KEY_HERE"
}
```

- `token` — your Discord **user** token (not a bot token).
- `ownerId` — your Discord user ID. Only this ID can command the bot,
  and the bot auto-follows this ID into voice channels.
  Yours: `1306646391325589529`
- `prefix` — fallback prefix, default `?`.
- `mp3ApiKey` — your YouTube MP3 downloader API key (required for playback).
- `youtubeApiKey` — YouTube Data API v3 key (for search + playlists).
  Optional, but strongly recommended — without it, search falls back to
  yt-dlp, which YouTube often blocks from datacenters.

Environment variables (`DISCORD_TOKEN`, `OWNER_ID`, `DISCORD_PREFIX`,
`MP3_API_KEY`, `MP3_API_BASE`, `YOUTUBE_API_KEY`, `YOUTUBE_COOKIES`)
override `config.json` when set.
**Never commit a real token or API key to git.**

### Getting a YouTube Data API v3 key (free)

1. Go to [Google Cloud Console](https://console.cloud.google.com),
   create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → Credentials** → Create Credentials → API key.
4. Paste it as `YOUTUBE_API_KEY` on Render (or `youtubeApiKey` in
   `config.json` for local runs).

The free quota is 10,000 units/day; a search costs 100 units, so that's
roughly 100 song searches per day — plenty for personal use. Playlist
fetches are cheap (1 unit each).

## Run on Render (example)

This repo ships with a `render.yaml` blueprint and a `Dockerfile`
(ffmpeg + yt-dlp included, timezone `Asia/Dhaka`).

1. Push this folder to a **private** GitHub repo.
2. Render dashboard → **New → Web Service** → connect the repo.
   Render picks up `render.yaml` automatically. Use the **Docker**
   runtime (the build command field is ignored for Docker).
3. In **Environment**, add:
   - `DISCORD_TOKEN` = your Discord user token
   - `OWNER_ID` = `1306646391325589529`
   - `MP3_API_KEY` = your downloader API key
   - `YOUTUBE_API_KEY` = your YouTube Data API v3 key
   - `YOUTUBE_COOKIES` = full content of your exported YouTube cookies.txt
     (backup for search if the API key hits quota)
   - `DISCORD_PREFIX` = `?` (optional)
4. Deploy. In the logs look for `Logged in as <your tag>`.
5. Join any voice channel — the bot follows you in instantly.
   Then type `@bot play shape of you`.

Render's free tier sleeps after inactivity; the bot reconnects and
resumes the queue automatically on wake.

## Run locally (example)

```bash
npm install
cp config.example.json config.json   # then fill in your keys
npm start
```

Needs `ffmpeg` and `yt-dlp` on PATH for local runs
(Docker installs both automatically).

## Project layout

```
app/
  main.ts          entry point, login, health check, graceful shutdown
  setup.ts         configuration (env vars + config.json)
  types.ts         shared types
  voice/
    session.ts     voice connections + owner auto-join
    jukebox.ts     playback engine (mp3 api -> temp file -> ffmpeg)
    shelf.ts       queue store + persistent state
  orders/
    desk.ts        command router (mention parsing, owner-only gate)
    tunes.ts       music commands
    tuner.ts       radio commands
    handy.ts       utility commands
  web/
    tube.ts        YouTube Data v3 + oEmbed + yt-dlp fallbacks
    fetchmp3.ts    MP3 downloader API client
    airwaves.ts    radio stream helpers
    nowonair.ts    radio metadata detection
  chat/
    cards.ts       now-playing cards
    panel.ts       reaction control panel
  tools/
    say.ts         message composer (coy personality, typing delays)
    timefmt.ts     duration/url formatting helpers
```

## Notes

- **Self-bots violate Discord's Terms of Service** and can get the
  account banned. An alt account is safer than your main.
- If YouTube search starts failing even with an API key (quota
  exhausted), give the bot your own login via cookies:
  1. In your browser, install a cookie-editor extension (e.g.
     "Get cookies.txt LOCALLY"), log into YouTube, and export cookies
     for youtube.com — you get a `cookies.txt` file in Netscape format.
     (If your extension exports JSON instead, that works too — the bot
     converts it automatically.)
  2. Open that file, copy its **entire content**, and paste it into the
     `YOUTUBE_COOKIES` environment variable on Render (multiline is fine).
  3. Redeploy. The bot writes it to a temp cookies file at startup and
     yt-dlp searches YouTube as your account, which bypasses the bot check.
  (For local runs you can instead drop that `cookies.txt` next to
  `config.json`.)
