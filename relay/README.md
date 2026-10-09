# Mikka Relay — deploy your own API gateway

Bypass datacenter IP blocks by routing the bot's API calls through
your own server.

## Option A: Railway / Fly.io (easiest)

1. Push this `relay/` folder to a new GitHub repo (or the same one)
2. Create a new service on Railway/Fly.io from that repo
   (NOT Render — Render shares the same blocked IP range as the bot,
   so a Render-hosted relay gets the same 403)
3. Set env var: `UPSTREAM=https://api.snowping.cfd`
4. Copy the public URL, e.g. `https://mikka-relay.up.railway.app`

## Option B: Your own computer (residential IP = never blocked)

1. `cd relay && npm install`
2. `UPSTREAM=https://api.snowping.cfd PORT=3000 node relay.js`
3. Expose it with a tunnel: `npx localtunnel --port 3000`
   (or ngrok / Cloudflare Tunnel for a stable URL)

## Point the bot at it

In the bot's Render env vars:

```
SNOWPING_API_BASE=https://<your-relay>/api/downloader/youtube
SNOWPING_SPOTIFY_BASE=https://<your-relay>/api/downloader/spotify
SNOWPING_SEARCH_BASE=https://<your-relay>/api/search/spotify
```

No code change needed — the bot reads these automatically.

## Why this works

The upstream API sees *your relay's* IP, not Render's blocked one.
The relay also caches responses (30 min) and paces requests, so the
upstream never gets hammered.

## Note on "rotating IPs"

A single server has one IP — you can't rotate it every few seconds
without proxy infrastructure. You don't need to: one clean IP that
isn't blocked is all it takes. If it ever gets blocked, move the
relay to another host (2-minute job).
