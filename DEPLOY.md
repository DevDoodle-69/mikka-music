# Mikka Music — Selfbot Music Player

A Discord **self-account** music bot: your own account joins voice channels
and plays music from YouTube, controlled by mentioning it.

## What it does

- **Mention commands** — type `@YourBotName play shape of you` in any text
  channel (the classic `?` prefix also works, e.g. `?play shape of you`)
- **Owner-only** — it only answers to one Discord user ID (yours).
  Everyone else is ignored.
- **Auto-join** — the moment you join any voice channel, it joins instantly.
  When you leave, it leaves too.
- **Human-like replies** — every response has a typing delay scaled to its
  length, and all responses are plain text (zero emojis).
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

## How playback works

YouTube blocks datacenter IPs, so the bot does **not** stream from YouTube
directly. Instead:

1. `?play <name>` / `@bot play <name>` searches YouTube (via yt-dlp) to
   find the video URL.
2. Your MP3 downloader API converts that URL to a direct mp3 link
   (polled until ready).
3. The bot downloads the mp3 to temp storage, then plays the local file
   through ffmpeg into the voice channel.
4. The temp file is deleted when the song ends, is skipped, or is stopped.

## Configuration

The bot reads `config.json` (see `config.example.json`):

```json
{
  "token": "YOUR_DISCORD_TOKEN_HERE",
  "ownerId": "YOUR_OWNER_DISCORD_ID_HERE",
  "prefix": "?"
}
```

- `token` — your Discord **user** token (not a bot token).
- `ownerId` — your Discord user ID. Only this ID can command the bot,
  and the bot auto-follows this ID into voice channels.
  Yours: `1306646391325589529`
- `prefix` — fallback prefix, default `?`.
- `mp3ApiKey` — your YouTube MP3 downloader API key (required for playback).

Environment variables (`DISCORD_TOKEN`, `OWNER_ID`, `DISCORD_PREFIX`,
`MP3_API_KEY`, `MP3_API_BASE`) override `config.json` when set.
**Never commit a real token or API key to git.**

## Run on Render (example)

This repo ships with a `render.yaml` blueprint and a `Dockerfile`
(ffmpeg + yt-dlp included, timezone `Asia/Dhaka`).

1. Push this folder to a **private** GitHub repo.
2. Render dashboard → **New → Web Service** → connect the repo.
   Render picks up `render.yaml` automatically.
3. In **Environment**, add:
   - `DISCORD_TOKEN` = your Discord user token
   - `OWNER_ID` = `1306646391325589529`
   - `MP3_API_KEY` = your downloader API key
   - `YOUTUBE_COOKIES` = full content of your exported YouTube cookies.txt
   - `DISCORD_PREFIX` = `?` (optional)
4. Deploy. In the logs look for `Logged in as <your tag>`.
5. Join any voice channel — the bot follows you in instantly.
   Then type `@bot play shape of you`.

Render's free tier sleeps after inactivity; the bot reconnects and
resumes the queue automatically on wake.

## Run locally (example)

```bash
npm install
cp config.example.json config.json   # then fill in token + ownerId
npm start
```

Needs `ffmpeg` and `yt-dlp` on PATH for local runs
(Docker installs both automatically).

## Notes

- **Self-bots violate Discord's Terms of Service** and can get the
  account banned. An alt account is safer than your main.
- If YouTube search starts failing from Render's IP ("Sign in to confirm
  you're not a bot"), give the bot your own login via cookies:
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
