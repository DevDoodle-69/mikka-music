/**
 * mikka-relay — Express API gateway for Mikka's music backend.
 *
 * Forwards YouTube/Spotify search + download requests to the upstream
 * APIs from THIS server's IP, bypassing datacenter IP blocks on the
 * bot's host. Add caching + polite pacing so upstream never throttles us.
 *
 * RUN:
 *   npm install
 *   UPSTREAM=https://api.snowping.cfd PORT=3000 node relay.js
 *
 * Then point the bot at it via Render env vars:
 *   SNOWPING_API_BASE=https://<your-relay>/api/downloader/youtube
 *   SNOWPING_SPOTIFY_BASE=https://<your-relay>/api/downloader/spotify
 *   SNOWPING_SEARCH_BASE=https://<your-relay>/api/search/spotify
 */
const express = require("express");

const UPSTREAM = process.env.UPSTREAM || "https://api.snowping.cfd";
const PORT = process.env.PORT || 3000;

const app = express();
app.disable("x-powered-by");

// ---- Tiny in-memory cache (30 min TTL, 500 entries max) ----
const cache = new Map();
const TTL = 30 * 60 * 1000;
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}
function cacheSet(key, data) {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + TTL });
}

// ---- Polite pacing: min 1s between upstream calls ----
let lastUpstream = 0;
async function pace() {
  const wait = 1000 - (Date.now() - lastUpstream);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastUpstream = Date.now();
}

// ---- Rotating user agents ----
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];
let uaIdx = Math.floor(Math.random() * UAS.length);
const nextUA = () => UAS[(uaIdx++) % UAS.length];

// ---- Relay handler ----
app.get("/api/*", async (req, res) => {
  const cacheKey = req.originalUrl;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set("X-Relay-Cache", "HIT");
    return res.json(cached);
  }

  await pace();
  const target = UPSTREAM + req.originalUrl;

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": nextUA(),
        Accept: "application/json,*/*",
      },
      signal: AbortSignal.timeout(30000),
    });
    const body = await upstream.arrayBuffer();
    const ct = upstream.headers.get("Content-Type") || "application/json";

    // Cache successful JSON responses.
    if (upstream.ok && ct.includes("json")) {
      try {
        cacheSet(cacheKey, JSON.parse(Buffer.from(body).toString()));
      } catch {}
    }

    res.status(upstream.status).set("Content-Type", ct).set("X-Relay-Cache", "MISS").send(Buffer.from(body));
  } catch (err) {
    console.error("relay error:", err.message);
    res.status(502).json({ status: 502, error: "relay upstream failed: " + err.message.slice(0, 120) });
  }
});

// ---- File relay (for direct MP3/CDN downloads, if needed) ----
app.get("/files/*", async (req, res) => {
  await pace();
  try {
    const upstream = await fetch(UPSTREAM + req.originalUrl, {
      headers: { "User-Agent": nextUA() },
      signal: AbortSignal.timeout(60000),
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "transfer-encoding"].includes(k.toLowerCase())) res.set(k, v);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: "file relay failed" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, upstream: UPSTREAM, cacheSize: cache.size }));

app.listen(PORT, () => console.log(`mikka-relay listening on :${PORT} → ${UPSTREAM}`));
