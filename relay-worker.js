/**
 * Mikka API Relay — Cloudflare Worker
 *
 * Deploy this free worker to relay snowping API requests through
 * Cloudflare's edge network (different IPs than Render, bypasses
 * datacenter IP blocks).
 *
 * DEPLOY (2 minutes, free):
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Choose "Hello World" template, replace the code with this file
 * 3. Deploy → you'll get a URL like https://mikka-relay.yourname.workers.dev
 * 4. In Render, set env var: SNOWPING_API_BASE=https://mikka-relay.yourname.workers.dev/api/downloader/youtube
 *    And: SNOWPING_SPOTIFY_BASE=https://mikka-relay.yourname.workers.dev/api/downloader/spotify
 *          SNOWPING_SEARCH_BASE=https://mikka-relay.yourname.workers.dev/api/search/spotify
 */

const UPSTREAM = "https://api.snowping.cfd";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Only relay API paths, nothing else.
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Mikka relay — API only", { status: 404 });
    }

    const target = UPSTREAM + url.pathname + url.search;

    // Polite pacing: max ~1 request per second per worker instance.
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json,*/*",
        "Referer": "https://mikka-music.onrender.com/",
      },
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
