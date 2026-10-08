/**
 * dashboard.ts — Mikka's live web dashboard.
 *
 * Served by the bot's built-in http server (same PORT as the health check):
 *   GET /            -> responsive dashboard page (live, auto-refreshing)
 *   GET /api/status  -> JSON: online state, voice, now playing, queue
 *
 * No extra dependencies — plain Node http.
 */
import { queues } from "../voice/shelf"

let botClient: any = null
const startedAt = Date.now()

export function setDashboardClient(client: any): void {
  botClient = client
}

interface SongInfo {
  title: string
  url: string
  duration?: string
}

interface VoiceInfo {
  guildId: string
  guildName: string
  channelId: string | null
  channelName: string | null
}

function songInfo(s: any): SongInfo | null {
  if (!s) return null
  return { title: s.title || "Unknown", url: s.url || "", duration: s.durationFormatted || s.duration || "" }
}

export function getStatus(): any {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000)
  const user = botClient?.user

  const voices: VoiceInfo[] = []
  let nowPlaying: SongInfo | null = null
  let queue: SongInfo[] = []
  let history: SongInfo[] = []
  let playing = false
  let volume = 100
  let loopMode = 0

  for (const [guildId, q] of queues) {
    const conn: any = q.connection
    const live = conn && conn.state?.status !== "destroyed"
    if (live || (q.songs && q.songs.length > 0)) {
      let guildName = guildId
      let channelName: string | null = null
      try {
        const guild = botClient?.guilds?.cache?.get(guildId)
        if (guild) guildName = guild.name || guildId
        const chId = q.voiceChannelId
        if (chId && guild) {
          const ch = guild.channels?.cache?.get(chId)
          if (ch) channelName = ch.name || null
        }
      } catch {}
      voices.push({ guildId, guildName, channelId: q.voiceChannelId, channelName })
      if (q.playing) {
        playing = true
        nowPlaying = songInfo(q.songs[0]) || songInfo(q.currentSong)
        queue = (q.songs || []).slice(1, 11).map(songInfo).filter(Boolean) as SongInfo[]
        history = (q.playHistory || []).slice(0, 5).map((h: any) => songInfo(h)).filter(Boolean) as SongInfo[]
        volume = q.volume ?? 100
        loopMode = q.loopMode ?? 0
      }
    }
  }

  return {
    online: !!user,
    tag: user?.tag || null,
    avatar: typeof user?.avatarURL === "function" ? user.avatarURL({ size: 256 }) : null,
    uptimeSec,
    voices,
    playing,
    nowPlaying,
    queue,
    history,
    volume,
    loopMode,
    timestamp: Date.now(),
  }
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mikka~ · Live</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --bg: #0d0a14; --card: #171224; --pink: #ff7ab8; --violet: #a78bfa; --text: #f3eefc; --dim: #9b8fc0; }
  body { background: radial-gradient(1200px 600px at 50% -10%, #241b3d 0%, var(--bg) 60%); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; padding: 24px 16px 48px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
  .avatar { width: 72px; height: 72px; border-radius: 50%; border: 2px solid var(--pink);
    box-shadow: 0 0 24px rgba(255,122,184,.35); object-fit: cover; background: var(--card); }
  .avatar.fallback { display: flex; align-items: center; justify-content: center; font-size: 32px; }
  h1 { font-size: 28px; letter-spacing: .5px; }
  h1 span { color: var(--pink); }
  .sub { color: var(--dim); font-size: 14px; margin-top: 4px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid #2c2347;
    padding: 8px 14px; border-radius: 999px; font-size: 14px; margin-top: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px #4ade80; animation: pulse 2s infinite; }
  .dot.off { background: #f87171; box-shadow: 0 0 10px #f87171; }
  @keyframes pulse { 50% { opacity: .5; } }
  .card { background: var(--card); border: 1px solid #2c2347; border-radius: 16px; padding: 18px; margin-bottom: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,.35); }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--dim); margin-bottom: 12px; }
  .now-title { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .now-title a { color: var(--text); text-decoration: none; }
  .now-title a:hover { color: var(--pink); }
  .meta { color: var(--dim); font-size: 14px; }
  .bars { display: flex; gap: 4px; align-items: flex-end; height: 28px; margin-top: 12px; }
  .bars i { width: 5px; background: linear-gradient(to top, var(--pink), var(--violet)); border-radius: 3px; animation: eq 1s ease-in-out infinite; }
  .bars i:nth-child(1){height:40%;animation-delay:0s}.bars i:nth-child(2){height:80%;animation-delay:.15s}
  .bars i:nth-child(3){height:55%;animation-delay:.3s}.bars i:nth-child(4){height:95%;animation-delay:.45s}
  .bars i:nth-child(5){height:65%;animation-delay:.6s}.bars i:nth-child(6){height:85%;animation-delay:.75s}
  .bars i:nth-child(7){height:45%;animation-delay:.9s}
  @keyframes eq { 50% { transform: scaleY(.4); } }
  .bars.paused i { animation-play-state: paused; opacity: .35; }
  .song { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #241d3d; align-items: center; }
  .song:last-child { border-bottom: none; }
  .num { color: var(--dim); font-size: 13px; width: 22px; text-align: right; flex-shrink: 0; }
  .song a { color: var(--text); text-decoration: none; font-size: 15px; }
  .song a:hover { color: var(--pink); }
  .dur { margin-left: auto; color: var(--dim); font-size: 13px; flex-shrink: 0; }
  .empty { color: var(--dim); font-style: italic; padding: 8px 0; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .stat { background: #1e1830; border-radius: 12px; padding: 14px; text-align: center; }
  .stat b { display: block; font-size: 22px; color: var(--pink); }
  .stat span { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; }
  footer { text-align: center; color: var(--dim); font-size: 13px; margin-top: 28px; }
  footer b { color: var(--pink); }
  @media (max-width: 480px) { h1 { font-size: 22px; } .avatar { width: 56px; height: 56px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img id="avatar" class="avatar" alt="Mikka" style="display:none">
    <div id="avatarFallback" class="avatar fallback">🎵</div>
    <div>
      <h1>Mikka<span>~</span></h1>
      <div class="sub" id="tagline">warming up…</div>
      <div class="pill"><span id="dot" class="dot off"></span><span id="statusText">connecting…</span></div>
    </div>
  </header>

  <div class="card">
    <h2>Now Playing</h2>
    <div id="nowPlaying"><div class="empty">quiet for now~ ask me to play something</div></div>
  </div>

  <div class="card">
    <h2>Up Next</h2>
    <div id="queue"><div class="empty">queue's empty~</div></div>
  </div>

  <div class="card">
    <h2>Stats</h2>
    <div class="stats">
      <div class="stat"><b id="stUptime">–</b><span>uptime</span></div>
      <div class="stat"><b id="stVoice">–</b><span>voice sessions</span></div>
      <div class="stat"><b id="stQueue">–</b><span>in queue</span></div>
      <div class="stat"><b id="stVol">–</b><span>volume</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Voice</h2>
    <div id="voices"><div class="empty">not in any voice channel~</div></div>
  </div>

  <footer>made with <b>~</b> by mikka · refreshes live every 5s</footer>
</div>
<script>
  const $ = id => document.getElementById(id);
  function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function fmtUptime(s){ const h=Math.floor(s/3600), m=Math.floor(s%3600/60); return h>0? h+'h '+m+'m' : m+'m'; }
  async function tick(){
    try {
      const r = await fetch('/api/status', {cache:'no-store'});
      const d = await r.json();
      $('dot').className = 'dot' + (d.online ? '' : ' off');
      $('statusText').textContent = d.online ? 'online' : 'offline';
      $('tagline').textContent = d.tag ? d.tag + ' · self-hosted jukebox' : 'warming up…';
      if (d.avatar) { $('avatar').src = d.avatar; $('avatar').style.display='block'; $('avatarFallback').style.display='none'; }
      // now playing
      if (d.playing && d.nowPlaying) {
        const np = d.nowPlaying;
        $('nowPlaying').innerHTML =
          '<div class="now-title"><a href="'+esc(np.url)+'" target="_blank" rel="noopener">'+esc(np.title)+'</a></div>' +
          (np.duration ? '<div class="meta">'+esc(np.duration)+'</div>' : '') +
          '<div class="bars" id="eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
      } else {
        $('nowPlaying').innerHTML = '<div class="empty">quiet for now~ ask me to play something</div><div class="bars paused"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
      }
      // queue
      $('queue').innerHTML = d.queue.length
        ? d.queue.map((s,i)=>'<div class="song"><span class="num">'+(i+1)+'</span><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.title)+'</a>'+(s.duration?'<span class="dur">'+esc(s.duration)+'</span>':'')+'</div>').join('')
        : '<div class="empty">queue\\'s empty~</div>';
      // stats
      $('stUptime').textContent = fmtUptime(d.uptimeSec);
      $('stVoice').textContent = d.voices.length;
      $('stQueue').textContent = d.queue.length;
      $('stVol').textContent = d.volume + '%';
      // voices
      $('voices').innerHTML = d.voices.length
        ? d.voices.map(v=>'<div class="song"><span class="num">🔊</span><span>'+esc(v.guildName)+(v.channelName?' · '+esc(v.channelName):'')+'</span></div>').join('')
        : '<div class="empty">not in any voice channel~</div>';
    } catch(e) { $('statusText').textContent = 'unreachable'; }
  }
  tick(); setInterval(tick, 5000);
</script>
</body>
</html>`

export function handleRequest(req: any, res: any): boolean {
  const url = (req.url || "/").split("?")[0]
  if (url === "/api/status") {
    const body = JSON.stringify(getStatus())
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    res.end(body)
    return true
  }
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(PAGE)
    return true
  }
  return false
}
