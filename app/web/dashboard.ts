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
import { recentLogs } from "../tools/log"

let botClient: any = null
const startedAt = Date.now()

export function setDashboardClient(client: any): void {
  botClient = client
}

interface SongInfo {
  title: string
  url: string
  duration?: string
  thumbnail?: string
}

interface VoiceInfo {
  guildId: string
  guildName: string
  channelId: string | null
  channelName: string | null
}

function songInfo(s: any): SongInfo | null {
  if (!s) return null
  return { title: s.title || "Unknown", url: s.url || "", duration: s.durationFormatted || s.duration || "", thumbnail: s.thumbnail || "" }
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
  :root {
    --bg: #0c0916; --card: #161226; --card2: #1d1633;
    --pink: #ff7ab8; --violet: #a78bfa; --cyan: #67e8f9;
    --text: #f4effd; --dim: #9c8fc4; --line: #2b2149;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24; --blue: #60a5fa;
  }
  body {
    background:
      radial-gradient(900px 400px at 15% 0%, rgba(167,139,250,.14), transparent 60%),
      radial-gradient(900px 500px at 85% 10%, rgba(255,122,184,.12), transparent 60%),
      radial-gradient(700px 500px at 50% 100%, rgba(103,232,249,.07), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh; padding: 28px 16px 40px;
  }
  .wrap { max-width: 760px; margin: 0 auto; animation: fadeUp .5s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } }
  header { display: flex; align-items: center; gap: 18px; margin-bottom: 26px; }
  .avatar-ring { position: relative; flex-shrink: 0; }
  .avatar { width: 76px; height: 76px; border-radius: 50%; object-fit: cover; background: var(--card2);
    border: 2px solid transparent;
    background: linear-gradient(var(--card2), var(--card2)) padding-box,
                linear-gradient(135deg, var(--pink), var(--violet), var(--cyan)) border-box; }
  .avatar-fb { width: 76px; height: 76px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; background: var(--card2); border: 2px solid var(--line); }
  .avatar-fb svg { width: 36px; height: 36px; fill: var(--pink); }
  .live-badge { position: absolute; bottom: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--green); border: 3px solid var(--bg); box-shadow: 0 0 12px var(--green); animation: pulse 2s infinite; }
  .live-badge.off { background: var(--red); box-shadow: 0 0 12px var(--red); animation: none; }
  @keyframes pulse { 50% { opacity: .55; } }
  h1 { font-size: 30px; letter-spacing: .5px; background: linear-gradient(90deg, var(--pink), var(--violet));
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .sub { color: var(--dim); font-size: 14px; margin-top: 4px; }
  .card { background: linear-gradient(180deg, var(--card), #130f20); border: 1px solid var(--line);
    border-radius: 20px; padding: 20px; margin-bottom: 18px;
    box-shadow: 0 12px 40px rgba(0,0,0,.4); transition: transform .2s; }
  .card:hover { transform: translateY(-1px); }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .card-head svg { width: 18px; height: 18px; fill: var(--pink); flex-shrink: 0; }
  .card-head h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: var(--dim); }
  .np { display: flex; gap: 16px; align-items: center; }
  .thumb { width: 96px; height: 96px; border-radius: 14px; object-fit: cover; flex-shrink: 0;
    box-shadow: 0 6px 20px rgba(255,122,184,.25); background: var(--card2); }
  .thumb.hidden { display: none; }
  .np-info { flex: 1; min-width: 0; }
  .now-title { font-size: 19px; font-weight: 700; margin-bottom: 6px; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .now-title a { color: var(--text); text-decoration: none; }
  .now-title a:hover { color: var(--pink); }
  .meta { color: var(--dim); font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .meta svg { width: 13px; height: 13px; fill: var(--dim); }
  .bars { display: flex; gap: 4px; align-items: flex-end; height: 30px; margin-top: 12px; }
  .bars i { width: 5px; border-radius: 3px; background: linear-gradient(to top, var(--pink), var(--violet), var(--cyan));
    animation: eq 1.1s ease-in-out infinite; box-shadow: 0 0 8px rgba(255,122,184,.4); }
  .bars i:nth-child(1){height:42%;animation-delay:0s}.bars i:nth-child(2){height:85%;animation-delay:.12s}
  .bars i:nth-child(3){height:58%;animation-delay:.24s}.bars i:nth-child(4){height:96%;animation-delay:.36s}
  .bars i:nth-child(5){height:66%;animation-delay:.48s}.bars i:nth-child(6){height:88%;animation-delay:.6s}
  .bars i:nth-child(7){height:46%;animation-delay:.72s}.bars i:nth-child(8){height:74%;animation-delay:.84s}
  @keyframes eq { 50% { transform: scaleY(.35); } }
  .bars.paused i { animation-play-state: paused; opacity: .25; box-shadow: none; }
  .song { display: flex; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); align-items: center; }
  .song:last-child { border-bottom: none; }
  .qthumb { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; flex-shrink: 0; background: var(--card2); }
  .qthumb.hidden { display: none; }
  .num { color: var(--dim); font-size: 13px; width: 20px; text-align: right; flex-shrink: 0; font-weight: 600; }
  .song a { color: var(--text); text-decoration: none; font-size: 15px; flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .song a:hover { color: var(--pink); }
  .dur { color: var(--dim); font-size: 13px; flex-shrink: 0; background: var(--card2);
    padding: 3px 9px; border-radius: 999px; }
  .empty { color: var(--dim); font-style: italic; padding: 10px 0; display: flex; align-items: center; gap: 8px; }
  .empty svg { width: 16px; height: 16px; fill: var(--dim); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
  .stat { background: var(--card2); border: 1px solid var(--line); border-radius: 14px; padding: 15px 10px;
    text-align: center; transition: transform .2s; }
  .stat:hover { transform: scale(1.03); }
  .stat svg { width: 20px; height: 20px; margin-bottom: 6px; }
  .stat b { display: block; font-size: 22px; }
  .stat span { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 1.2px; }
  .logs { background: #0a0714; border: 1px solid var(--line); border-radius: 14px; padding: 14px;
    font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.7;
    max-height: 300px; overflow-y: auto; }
  .logs::-webkit-scrollbar { width: 6px; }
  .logs::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
  .lg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 0; }
  .lg .lt { color: #5b5178; margin-right: 8px; }
  .lg .ltag { font-weight: 700; margin-right: 8px; min-width: 62px; display: inline-block; }
  .lg.err .lmsg { color: var(--red); }
  .tag-command{color:var(--cyan)} .tag-resolve{color:#e879f9} .tag-autojoin{color:var(--yellow)}
  .tag-voice{color:var(--blue)} .tag-music{color:var(--green)} .tag-mp3{color:var(--blue)}
  .tag-tube{color:var(--yellow)} .tag-net{color:#d4d4d4}
  @media (max-width: 480px) {
    h1 { font-size: 24px; } .avatar, .avatar-fb { width: 60px; height: 60px; }
    .thumb { width: 76px; height: 76px; } .now-title { font-size: 16px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="avatar-ring">
      <img id="avatar" class="avatar" alt="Mikka" style="display:none">
      <div id="avatarFb" class="avatar-fb"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
      <div id="liveBadge" class="live-badge off"></div>
    </div>
    <div>
      <h1>Mikka~</h1>
      <div class="sub" id="tagline">warming up…</div>
    </div>
  </header>

  <div class="card">
    <div class="card-head">
      <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      <h2>Now Playing</h2>
    </div>
    <div id="nowPlaying"></div>
  </div>

  <div class="card">
    <div class="card-head">
      <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
      <h2>Up Next</h2>
    </div>
    <div id="queue"></div>
  </div>

  <div class="card">
    <div class="card-head">
      <svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
      <h2>Stats</h2>
    </div>
    <div class="stats">
      <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--cyan)"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.59l-4.24 4.25-.71-.71L11.59 13H11V7h2v6.59z"/></svg><b id="stUptime">–</b><span>uptime</span></div>
      <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--violet)"><path d="M12 3a9 9 0 019 9v7a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-7a9 9 0 019-9z"/></svg><b id="stVoice">–</b><span>voice</span></div>
      <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--pink)"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg><b id="stQueue">–</b><span>queued</span></div>
      <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--green)"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.47 4.47 0 0016.5 12z"/></svg><b id="stVol">–</b><span>volume</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <svg viewBox="0 0 24 24"><path d="M6 18h12v2H6zm3-4h6v2H9zm-3-4h12v2H6zm3-4h6v2H9z" opacity="0"/><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>
      <h2>Live Logs</h2>
    </div>
    <div class="logs" id="logs"><div class="lg"><span class="lmsg" style="color:var(--dim)">connecting to log stream…</span></div></div>
  </div>
</div>
<script>
  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtUp = s => { const h=Math.floor(s/3600), m=Math.floor(s%3600/60); return h>0 ? h+'h '+m+'m' : Math.max(m,1)+'m'; };
  const musicSvg = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
  const clockSvg = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.59l-4.24 4.25-.71-.71L11.59 13H11V7h2v6.59z"/></svg>';
  async function tick(){
    try {
      const d = await (await fetch('/api/status',{cache:'no-store'})).json();
      $('liveBadge').className = 'live-badge' + (d.online ? '' : ' off');
      $('tagline').textContent = d.online ? (d.tag ? d.tag+' · self-hosted jukebox' : 'online') : 'offline';
      if (d.avatar) { $('avatar').src = d.avatar; $('avatar').style.display='block'; $('avatarFb').style.display='none'; }
      if (d.playing && d.nowPlaying) {
        const np = d.nowPlaying;
        $('nowPlaying').innerHTML =
          '<div class="np">' +
            (np.thumbnail ? '<img class="thumb" src="'+esc(np.thumbnail)+'" alt="" onerror="this.classList.add(\'hidden\')">' : '') +
            '<div class="np-info"><div class="now-title"><a href="'+esc(np.url)+'" target="_blank" rel="noopener">'+esc(np.title)+'</a></div>' +
            (np.duration ? '<div class="meta">'+clockSvg+esc(np.duration)+'</div>' : '') +
            '<div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>' +
          '</div>';
      } else {
        $('nowPlaying').innerHTML = '<div class="empty">'+musicSvg+'quiet for now~ ask me to play something</div><div class="bars paused"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
      }
      $('queue').innerHTML = d.queue.length
        ? d.queue.map((s,i)=>'<div class="song">'+(s.thumbnail?'<img class="qthumb" src="'+esc(s.thumbnail)+'" onerror="this.classList.add(\'hidden\')">' :'<span class="num">'+(i+1)+'</span>')+'<a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.title)+'</a>'+(s.duration?'<span class="dur">'+esc(s.duration)+'</span>':'')+'</div>').join('')
        : '<div class="empty">'+musicSvg+'queue\'s empty~</div>';
      $('stUptime').textContent = fmtUp(d.uptimeSec);
      $('stVoice').textContent = d.voices.length;
      $('stQueue').textContent = d.queue.length;
      $('stVol').textContent = d.volume + '%';
    } catch(e) {}
  }
  async function tickLogs(){
    try {
      const logs = await (await fetch('/api/logs',{cache:'no-store'})).json();
      $('logs').innerHTML = logs.map(l =>
        '<div class="lg'+(l.level==='error'?' err':'')+'"><span class="lt">'+esc(l.t)+'</span><span class="ltag tag-'+esc(l.tag)+'">'+esc(l.tag)+'</span><span class="lmsg">'+esc(l.msg)+'</span></div>'
      ).join('') || '<div class="lg"><span class="lmsg" style="color:var(--dim)">no logs yet~</span></div>';
      const el = $('logs'); el.scrollTop = el.scrollHeight;
    } catch(e) {}
  }
  tick(); tickLogs();
  setInterval(tick, 5000); setInterval(tickLogs, 3000);
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
  if (url === "/api/logs") {
    const body = JSON.stringify(recentLogs(80))
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
