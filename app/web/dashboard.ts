/**
 * dashboard.ts — Mikka's live web dashboard.
 *
 * Served by the bot's built-in http server (same PORT as the health check):
 *   GET  /                      -> dashboard page (live, auto-refreshing)
 *   GET  /api/status            -> JSON: online state, voice, now playing, queue
 *   GET  /api/logs              -> JSON: recent log lines
 *   GET  /api/playlist          -> JSON: uploaded playlist tracks
 *   POST /api/playlist/upload?filename=<name>  -> raw audio body upload
 *   DELETE /api/playlist?name=<name>           -> delete a track
 *
 * Upload/delete are open unless DASHBOARD_KEY is set — then they require
 * ?key=<DASHBOARD_KEY>. Viewing is always public.
 *
 * No extra dependencies — plain Node http.
 */
import { queues } from "../voice/shelf"
import { recentLogs, logline, logerr } from "../tools/log"
import { listTracks, saveUpload, deleteTrack } from "./playlist"

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
<title>Mikka~ · Control Deck</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0b0817; --card: #151122; --card2: #1c1533; --inset: #0d0a18;
    --pink: #ff7ab8; --violet: #a78bfa; --cyan: #67e8f9;
    --text: #f4effd; --dim: #9c8fc4; --faint: #6b5f94; --line: #2b2149;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24;
  }
  body {
    background:
      radial-gradient(1000px 420px at 12% -4%, rgba(167,139,250,.15), transparent 60%),
      radial-gradient(900px 480px at 88% 6%, rgba(255,122,184,.12), transparent 60%),
      radial-gradient(800px 520px at 50% 108%, rgba(103,232,249,.06), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    min-height: 100vh; padding: 0 0 48px;
    -webkit-font-smoothing: antialiased;
  }
  .topbar {
    position: sticky; top: 0; z-index: 20;
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    background: rgba(11,8,23,.78); border-bottom: 1px solid var(--line);
  }
  .topbar-in { max-width: 860px; margin: 0 auto; padding: 14px 20px;
    display: flex; align-items: center; gap: 14px; }
  .avatar-ring { position: relative; flex-shrink: 0; }
  .avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover;
    border: 2px solid transparent;
    background: linear-gradient(var(--card2), var(--card2)) padding-box,
                linear-gradient(135deg, var(--pink), var(--violet), var(--cyan)) border-box; }
  .avatar-fb { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; background: var(--card2); border: 2px solid var(--line); }
  .avatar-fb svg { width: 24px; height: 24px; fill: var(--pink); }
  .live-dot { position: absolute; bottom: 1px; right: 1px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--green); border: 3px solid var(--bg); box-shadow: 0 0 10px var(--green); animation: pulse 2s infinite; }
  .live-dot.off { background: var(--red); box-shadow: 0 0 10px var(--red); animation: none; }
  @keyframes pulse { 50% { opacity: .5; } }
  .brand h1 { font-size: 21px; letter-spacing: .4px;
    background: linear-gradient(90deg, var(--pink), var(--violet));
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .brand .sub { color: var(--dim); font-size: 12.5px; margin-top: 2px; }
  .pill { margin-left: auto; font-size: 11px; font-weight: 700; letter-spacing: 1.6px;
    padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--dim); background: var(--card); white-space: nowrap; }
  .pill.on { color: var(--green); border-color: rgba(74,222,128,.35); background: rgba(74,222,128,.08); }
  .wrap { max-width: 860px; margin: 0 auto; padding: 22px 20px 0; animation: fadeUp .45s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: linear-gradient(180deg, var(--card), #120e20); border: 1px solid var(--line);
    border-radius: 18px; padding: 20px; margin-bottom: 16px;
    box-shadow: 0 14px 44px rgba(0,0,0,.42); }
  .card.wide { grid-column: 1 / -1; }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .card-head svg { width: 17px; height: 17px; fill: var(--pink); flex-shrink: 0; }
  .card-head h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 2.2px; color: var(--dim); font-weight: 700; }
  .card-head .right { margin-left: auto; font-size: 12px; color: var(--faint); }
  .np { display: flex; gap: 16px; align-items: center; }
  .thumb { width: 92px; height: 92px; border-radius: 14px; object-fit: cover; flex-shrink: 0;
    box-shadow: 0 8px 24px rgba(255,122,184,.28); background: var(--card2); }
  .thumb.hidden { display: none; }
  .np-info { flex: 1; min-width: 0; }
  .now-title { font-size: 18px; font-weight: 700; line-height: 1.35; margin-bottom: 6px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .now-title a { color: var(--text); text-decoration: none; }
  .now-title a:hover { color: var(--pink); }
  .meta { color: var(--dim); font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .meta svg { width: 13px; height: 13px; fill: var(--dim); }
  .bars { display: flex; gap: 4px; align-items: flex-end; height: 28px; margin-top: 12px; }
  .bars i { width: 5px; border-radius: 3px; background: linear-gradient(to top, var(--pink), var(--violet), var(--cyan));
    animation: eq 1.1s ease-in-out infinite; box-shadow: 0 0 8px rgba(255,122,184,.4); }
  .bars i:nth-child(1){height:42%;animation-delay:0s}.bars i:nth-child(2){height:85%;animation-delay:.12s}
  .bars i:nth-child(3){height:58%;animation-delay:.24s}.bars i:nth-child(4){height:96%;animation-delay:.36s}
  .bars i:nth-child(5){height:66%;animation-delay:.48s}.bars i:nth-child(6){height:88%;animation-delay:.6s}
  .bars i:nth-child(7){height:46%;animation-delay:.72s}.bars i:nth-child(8){height:74%;animation-delay:.84s}
  @keyframes eq { 50% { transform: scaleY(.35); } }
  .bars.paused i { animation-play-state: paused; opacity: .22; box-shadow: none; }
  .song { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); align-items: center; }
  .song:last-child { border-bottom: none; }
  .qthumb { width: 42px; height: 42px; border-radius: 10px; object-fit: cover; flex-shrink: 0; background: var(--card2); }
  .qthumb.hidden { display: none; }
  .num { color: var(--faint); font-size: 13px; width: 20px; text-align: right; flex-shrink: 0; font-weight: 600; }
  .song a { color: var(--text); text-decoration: none; font-size: 14.5px; flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .song a:hover { color: var(--pink); }
  .dur { color: var(--dim); font-size: 12px; flex-shrink: 0; background: var(--card2);
    padding: 3px 9px; border-radius: 999px; }
  .empty { color: var(--dim); font-style: italic; padding: 12px 0; display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .empty svg { width: 16px; height: 16px; fill: var(--dim); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .stat { background: var(--inset); border: 1px solid var(--line); border-radius: 14px; padding: 14px 8px;
    text-align: center; transition: transform .18s; }
  .stat:hover { transform: translateY(-2px); }
  .stat svg { width: 19px; height: 19px; margin-bottom: 6px; }
  .stat b { display: block; font-size: 20px; }
  .stat span { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 1.4px; }
  .drop { border: 1.5px dashed var(--line); border-radius: 14px; padding: 26px 16px; text-align: center;
    cursor: pointer; transition: all .2s; background: var(--inset); }
  .drop:hover, .drop.over { border-color: var(--pink); background: rgba(255,122,184,.05); }
  .drop svg { width: 30px; height: 30px; fill: var(--pink); margin-bottom: 8px; }
  .drop b { display: block; font-size: 15px; margin-bottom: 4px; }
  .drop span { color: var(--dim); font-size: 12.5px; }
  .track { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .track:last-child { border-bottom: none; }
  .track .ticon { width: 38px; height: 38px; border-radius: 10px; background: var(--card2);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .track .ticon svg { width: 18px; height: 18px; fill: var(--violet); }
  .track .tname { flex: 1; min-width: 0; font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track .tsize { color: var(--faint); font-size: 12px; flex-shrink: 0; }
  .icon-btn { border: 1px solid var(--line); background: var(--card2); color: var(--dim);
    width: 32px; height: 32px; border-radius: 10px; cursor: pointer; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; transition: all .18s; }
  .icon-btn:hover { color: var(--red); border-color: var(--red); }
  .icon-btn svg { width: 15px; height: 15px; fill: currentColor; }
  .up-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .up-row:last-child { border-bottom: none; }
  .up-row .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--card2); overflow: hidden; }
  .up-row .bar i { display: block; height: 100%; width: 0; border-radius: 3px;
    background: linear-gradient(90deg, var(--pink), var(--violet)); transition: width .2s; }
  .up-row .st { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .up-row .st.ok { color: var(--green); } .up-row .st.bad { color: var(--red); }
  .logs { background: #090614; border: 1px solid var(--line); border-radius: 14px; padding: 14px;
    font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.7;
    max-height: 320px; overflow-y: auto; }
  .logs::-webkit-scrollbar { width: 6px; }
  .logs::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
  .lg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 0; }
  .lg .lt { color: #5b5178; margin-right: 8px; }
  .lg .ltag { font-weight: 700; margin-right: 8px; min-width: 62px; display: inline-block; }
  .lg.err .lmsg { color: var(--red); }
  .tag-command{color:var(--cyan)} .tag-resolve{color:#e879f9} .tag-autojoin{color:var(--yellow)}
  .tag-voice{color:#60a5fa} .tag-music{color:var(--green)} .tag-mp3{color:#60a5fa}
  .tag-tube{color:var(--yellow)} .tag-net{color:#d4d4d4} .tag-playlist{color:var(--pink)} .tag-sleep{color:var(--violet)}
  .hint { color: var(--faint); font-size: 12px; margin-top: 10px; line-height: 1.6; }
  .hint code { background: var(--card2); padding: 2px 7px; border-radius: 6px; color: var(--cyan); font-size: 11.5px; }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .brand h1 { font-size: 18px; }
    .thumb { width: 72px; height: 72px; } .now-title { font-size: 16px; }
  }
</style>
</head>
<body>
<div class="topbar"><div class="topbar-in">
  <div class="avatar-ring">
    <img id="avatar" class="avatar" alt="Mikka" style="display:none">
    <div id="avatarFb" class="avatar-fb"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
    <div id="liveDot" class="live-dot off"></div>
  </div>
  <div class="brand">
    <h1>Mikka~</h1>
    <div class="sub" id="tagline">warming up…</div>
  </div>
  <div class="pill" id="statusPill">OFFLINE</div>
</div></div>

<div class="wrap">
  <div class="grid">
    <div class="card wide">
      <div class="card-head">
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        <h2>Now Playing</h2><span class="right" id="voiceInfo"></span>
      </div>
      <div id="nowPlaying"></div>
    </div>

    <div class="card wide">
      <div class="card-head">
        <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
        <h2>My Playlist</h2><span class="right" id="plCount"></span>
      </div>
      <div class="drop" id="drop">
        <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        <b>Drop audio files here, or tap to browse</b>
        <span>mp3 · m4a · wav · ogg · flac · opus — up to 100MB each</span>
        <input type="file" id="fileInput" accept="audio/*,.mp3,.m4a,.wav,.ogg,.oga,.opus,.flac,.aac,.wma" multiple style="display:none">
      </div>
      <div id="uploads"></div>
      <div id="playlist" style="margin-top:6px"></div>
      <div class="hint">Then in Discord: <code>@Mikka playlist play all</code> shuffles everything, <code>@Mikka playlist play 10</code> shuffles 10.</div>
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
        <svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        <h2>Stats</h2>
      </div>
      <div class="stats">
        <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--cyan)"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.59l-4.24 4.25-.71-.71L11.59 13H11V7h2v6.59z"/></svg><b id="stUptime">–</b><span>uptime</span></div>
        <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--violet)"><path d="M12 3a9 9 0 019 9v7a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-7a9 9 0 019-9z"/></svg><b id="stVoice">–</b><span>voice</span></div>
        <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--pink)"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg><b id="stQueue">–</b><span>queued</span></div>
        <div class="stat"><svg viewBox="0 0 24 24" style="fill:var(--green)"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.47 4.47 0 0016.5 12z"/></svg><b id="stVol">–</b><span>volume</span></div>
      </div>
    </div>

    <div class="card wide">
      <div class="card-head">
        <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v7a9 9 0 019-9z"/></svg>
        <h2>Live Logs</h2>
      </div>
      <div class="logs" id="logs"><div class="lg"><span class="lmsg" style="color:var(--dim)">connecting to log stream…</span></div></div>
    </div>
  </div>
</div>
<script>
  const NEEDS_KEY = __NEEDS_KEY__;
  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtUp = s => { const h=Math.floor(s/3600), m=Math.floor(s%3600/60); return h>0 ? h+'h '+m+'m' : Math.max(m,1)+'m'; };
  const fmtMB = b => b > 1048576 ? (b/1048576).toFixed(1)+'MB' : Math.max(1,Math.round(b/1024))+'KB';
  const musicSvg = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
  const clockSvg = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.59l-4.24 4.25-.71-.71L11.59 13H11V7h2v6.59z"/></svg>';
  const trashSvg = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  function dashKey(){
    let k = sessionStorage.getItem('dashKey') || '';
    if (NEEDS_KEY && !k) { k = prompt('Dashboard key:') || ''; sessionStorage.setItem('dashKey', k); }
    return k;
  }
  async function tick(){
    try {
      const d = await (await fetch('/api/status',{cache:'no-store'})).json();
      const pill = $('statusPill');
      pill.textContent = d.online ? 'LIVE' : 'OFFLINE';
      pill.className = 'pill' + (d.online ? ' on' : '');
      $('liveDot').className = 'live-dot' + (d.online ? '' : ' off');
      $('tagline').textContent = d.online ? (d.tag ? d.tag+' · self-hosted jukebox' : 'online · self-hosted jukebox') : "offline — she'll be back";
      if (d.avatar) { $('avatar').src = d.avatar; $('avatar').style.display='block'; $('avatarFb').style.display='none'; }
      $('voiceInfo').textContent = d.voices.length && d.voices[0].channelName ? '🔊 '+d.voices[0].channelName : '';
      if (d.playing && d.nowPlaying) {
        const np = d.nowPlaying;
        $('nowPlaying').innerHTML =
          '<div class="np">' +
            (np.thumbnail ? '<img class="thumb" src="'+esc(np.thumbnail)+'" alt="" onerror="this.classList.add(\\'hidden\\')">' : '') +
            '<div class="np-info"><div class="now-title"><a href="'+esc(np.url)+'" target="_blank" rel="noopener">'+esc(np.title)+'</a></div>' +
            (np.duration ? '<div class="meta">'+clockSvg+esc(np.duration)+'</div>' : '') +
            '<div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>' +
          '</div>';
      } else {
        $('nowPlaying').innerHTML = '<div class="empty">'+musicSvg+'quiet for now~ ask me to play something</div><div class="bars paused"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
      }
      $('queue').innerHTML = d.queue.length
        ? d.queue.map((s,i)=>'<div class="song">'+(s.thumbnail?'<img class="qthumb" src="'+esc(s.thumbnail)+'" onerror="this.classList.add(\\'hidden\\')">' :'<span class="num">'+(i+1)+'</span>')+'<a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.title)+'</a>'+(s.duration?'<span class="dur">'+esc(s.duration)+'</span>':'')+'</div>').join('')
        : '<div class="empty">'+musicSvg+'queue\\'s empty~</div>';
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
  async function loadPlaylist(){
    try {
      const j = await (await fetch('/api/playlist',{cache:'no-store'})).json();
      const tracks = j.tracks || [];
      $('plCount').textContent = tracks.length + (tracks.length===1?' song':' songs');
      $('playlist').innerHTML = tracks.length ? tracks.map(t =>
        '<div class="track"><div class="ticon">'+musicSvg+'</div>' +
        '<div class="tname">'+esc(t.name)+'</div><div class="tsize">'+fmtMB(t.size)+'</div>' +
        '<button class="icon-btn" title="Delete" data-name="'+esc(t.name)+'">'+trashSvg+'</button></div>'
      ).join('') : '<div class="empty">'+musicSvg+'nothing here yet~ upload your first song above</div>';
      $('playlist').querySelectorAll('.icon-btn').forEach(b =>
        b.addEventListener('click', () => delTrack(b.getAttribute('data-name'))));
    } catch(e) {}
  }
  async function delTrack(name){
    if (!confirm('Delete "'+name+'" from the playlist?')) return;
    let url = '/api/playlist?name='+encodeURIComponent(name);
    if (NEEDS_KEY) url += '&key='+encodeURIComponent(dashKey());
    try { await fetch(url, {method:'DELETE'}); } catch(e) {}
    loadPlaylist();
  }
  function upRow(name){
    const div = document.createElement('div');
    div.className = 'up-row';
    div.innerHTML = '<div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(name)+'</div><div class="bar"><i></i></div><div class="st">uploading…</div>';
    $('uploads').appendChild(div);
    return {
      done: okName => { div.querySelector('.bar i').style.width='100%'; const st=div.querySelector('.st'); st.textContent = okName ? 'done ✓' : 'failed'; st.className='st '+(okName?'ok':'bad'); setTimeout(()=>div.remove(), 4000); },
      fail: msg => { const st=div.querySelector('.st'); st.textContent = msg || 'failed'; st.className='st bad'; setTimeout(()=>div.remove(), 5000); }
    };
  }
  async function uploadFiles(files){
    for (const f of files) {
      const row = upRow(f.name);
      try {
        let url = '/api/playlist/upload?filename='+encodeURIComponent(f.name);
        if (NEEDS_KEY) url += '&key='+encodeURIComponent(dashKey());
        const r = await fetch(url, {method:'POST', body:f});
        const j = await r.json().catch(()=>({}));
        if (r.ok && j.ok) row.done(j.name); else row.fail(j.error || ('HTTP '+r.status));
      } catch(e) { row.fail('network error'); }
    }
    loadPlaylist();
  }
  const drop = $('drop'), fi = $('fileInput');
  drop.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files.length) uploadFiles(fi.files); fi.value=''; });
  ['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) uploadFiles(fs); });
  tick(); tickLogs(); loadPlaylist();
  setInterval(tick, 5000); setInterval(tickLogs, 3000); setInterval(loadPlaylist, 15000);
</script>
</body>
</html>`

const DASH_KEY = process.env.DASHBOARD_KEY || ""
function checkKey(k: string | null): boolean {
  return !DASH_KEY || k === DASH_KEY
}

function json(res: any, code: number, obj: any): void {
  const body = JSON.stringify(obj)
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(body)
}

export function handleRequest(req: any, res: any): boolean {
  const rawUrl = req.url || "/"
  const url = rawUrl.split("?")[0]
  const q = new URL(rawUrl, "http://x").searchParams

  if (url === "/api/status") {
    json(res, 200, getStatus())
    return true
  }
  if (url === "/api/logs") {
    json(res, 200, recentLogs(80))
    return true
  }
  if (url === "/api/playlist" && req.method === "GET") {
    json(res, 200, { tracks: listTracks() })
    return true
  }
  if (url === "/api/playlist" && req.method === "DELETE") {
    if (!checkKey(q.get("key"))) { json(res, 403, { ok: false, error: "bad key" }); return true }
    const ok = deleteTrack(q.get("name") || "")
    json(res, ok ? 200 : 404, { ok, error: ok ? undefined : "not found" })
    return true
  }
  if (url === "/api/playlist/upload" && req.method === "POST") {
    if (!checkKey(q.get("key"))) { json(res, 403, { ok: false, error: "bad key" }); return true }
    const filename = q.get("filename") || "upload"
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on("data", (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > 105 * 1024 * 1024) {
        failed = true
        try { req.destroy() } catch {}
        json(res, 413, { ok: false, error: "file too big (100MB max)" })
        return
      }
      chunks.push(c)
    })
    req.on("end", async () => {
      if (failed) return
      try {
        const r = await saveUpload(filename, Buffer.concat(chunks))
        json(res, r.ok ? 200 : 400, r)
      } catch (err) {
        logerr("playlist", "upload failed:", (err as Error).message?.slice(0, 80))
        json(res, 500, { ok: false, error: "server error" })
      }
    })
    req.on("error", () => {
      if (!failed) { try { json(res, 500, { ok: false, error: "upload interrupted" }) } catch {} }
    })
    return true
  }
  if (url === "/" || url === "/index.html") {
    const html = PAGE.replace("__NEEDS_KEY__", DASH_KEY ? "true" : "false")
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(html)
    return true
  }
  return false
}
