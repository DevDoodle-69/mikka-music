/**
 * proxy.ts — outbound IP control via HTTP/HTTPS proxies.
 *
 * A server can't change its own IP, but it CAN route traffic through
 * a proxy — the target site then sees the proxy's IP instead.
 *
 * Setup (Render → Environment):
 *   PROXY_LIST=http://user:pass@host1:port,http://user:pass@host2:port
 *   (comma-separated; the bot rotates through them)
 *   — or a single proxy —
 *   HTTP_PROXY=http://user:pass@host:port
 *
 * Commands:
 *   @Mikka proxy         — show current proxy + outbound IP status
 *   @Mikka proxy next    — switch to the next proxy (changes IP)
 *   @Mikka proxy off     — disable proxying (direct connection)
 *   @Mikka proxy on      — re-enable proxying
 *
 * Free/cheap proxy sources: webshare.io (10 free), proxyscrape, or any
 * residential proxy provider. Residential IPs dodge datacenter blocks.
 */
import { logline, logerr } from "../tools/log"

interface ProxyEntry {
  url: string
  /** Masked for logs, e.g. "http://***@1.2.3.4:8080" */
  masked: string
  /** Consecutive failures. At MAX_FAILURES the proxy is cooled down. */
  failures: number
  /** Timestamp until which this proxy is skipped (0 = healthy). */
  badUntil: number
}

const MAX_FAILURES = 3
const COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function maskProxy(url: string): string {
  try {
    const u = new URL(url)
    const auth = u.username ? "***@" : ""
    return `${u.protocol}//${auth}${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`
  } catch {
    return "***"
  }
}

function loadProxies(): ProxyEntry[] {
  const list: string[] = []
  const multi = (process.env.PROXY_LIST || "").split(",").map((s) => s.trim()).filter(Boolean)
  list.push(...multi)
  const single = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy
  if (single && !list.includes(single)) list.push(single.trim())
  // Dedupe — the same proxy listed twice makes rotation look broken.
  const seen = new Set<string>()
  const unique = list.filter((u) => {
    const key = u.replace(/:\/\/[^@]+@/, "://") // ignore credentials when deduping
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length !== list.length) {
    logline("proxy", `removed ${list.length - unique.length} duplicate proxies`)
  }
  return unique.map((url) => ({ url, masked: maskProxy(url), failures: 0, badUntil: 0 }))
}

let proxies: ProxyEntry[] = loadProxies()
let proxyIndex = 0
let proxyEnabled = proxies.length > 0

/** Reload from env (call after env changes, or periodically). */
export function reloadProxies(): void {
  const fresh = loadProxies()
  // Preserve health stats for proxies that still exist.
  for (const f of fresh) {
    const old = proxies.find((p) => p.url === f.url)
    if (old) { f.failures = old.failures; f.badUntil = old.badUntil }
  }
  proxies = fresh
  if (proxyIndex >= proxies.length) proxyIndex = 0
  logline("proxy", `loaded ${proxies.length} prox${proxies.length === 1 ? "y" : "ies"}`)
}

/** Is this proxy currently usable? (cooldown expired) */
function isHealthy(p: ProxyEntry): boolean {
  if (p.badUntil && Date.now() < p.badUntil) return false
  if (p.badUntil && Date.now() >= p.badUntil) { p.badUntil = 0; p.failures = 0 }
  return true
}

/** Number of currently healthy proxies. */
export function healthyProxyCount(): number {
  return proxies.filter(isHealthy).length
}

/** Full list with 1-based index and health — for the status command. */
export function proxyList(): Array<{ index: number; masked: string; healthy: boolean; current: boolean; failures: number }> {
  return proxies.map((p, i) => ({
    index: i + 1,
    masked: p.masked,
    healthy: isHealthy(p),
    current: isProxyEnabled() && (proxyIndex % proxies.length) === i,
    failures: p.failures,
  }))
}

/** Current proxy's 1-based index (0 if none). */
export function currentProxyIndex(): number {
  if (!isProxyEnabled() || proxies.length === 0) return 0
  return (proxyIndex % proxies.length) + 1
}

export function proxyCount(): number {
  return proxies.length
}

/** Health summary for the proxy command: "3/10 healthy". */
export function proxyHealth(): string {
  return `${healthyProxyCount()}/${proxies.length} healthy`
}

/** Record a failure. After MAX_FAILURES consecutive failures, cool down. */
function markFailure(p: ProxyEntry): void {
  p.failures++
  if (p.failures >= MAX_FAILURES) {
    p.badUntil = Date.now() + COOLDOWN_MS
    logerr("proxy", `${p.masked} failed ${p.failures}x — cooling down 10min`)
  }
}

/** Record a success — resets the failure counter. */
function markSuccess(p: ProxyEntry): void {
  if (p.failures > 0) p.failures = 0
  if (p.badUntil && Date.now() >= p.badUntil) p.badUntil = 0
}

export function isProxyEnabled(): boolean {
  return proxyEnabled && proxies.length > 0
}

export function currentProxy(): ProxyEntry | null {
  if (!isProxyEnabled()) return null
  return proxies[proxyIndex % proxies.length]
}

/**
 * Switch to the next HEALTHY proxy (skips cooled-down ones).
 * Returns the new proxy (or null if none).
 */
export function nextProxy(): ProxyEntry | null {
  if (proxies.length === 0) return null
  for (let i = 0; i < proxies.length; i++) {
    proxyIndex = (proxyIndex + 1) % proxies.length
    const p = proxies[proxyIndex]
    if (isHealthy(p)) {
      proxyEnabled = true
      logline("proxy", `switched to ${p.masked} (${proxyIndex + 1}/${proxies.length})`)
      return p
    }
  }
  // All proxies cooling down — use the least-bad one anyway.
  proxyIndex = (proxyIndex + 1) % proxies.length
  const p = proxies[proxyIndex]
  p.badUntil = 0; p.failures = 0
  proxyEnabled = true
  logline("proxy", `all cooling down — retrying ${p.masked} anyway`)
  return p
}

export function setProxyEnabled(on: boolean): void {
  proxyEnabled = on
  logline("proxy", on ? "enabled" : "disabled")
}

/**
 * Build an undici dispatcher for the current proxy, or undefined for direct.
 * Pass as `dispatcher` in fetch options.
 */
export async function proxyDispatcher(): Promise<any> {
  const p = currentProxy()
  if (!p) return undefined
  try {
    const { ProxyAgent } = await import("undici")
    return new ProxyAgent(p.url)
  } catch (err: any) {
    logerr("proxy", "failed to create proxy agent:", (err.message || err).slice(0, 80))
    return undefined
  }
}

/**
 * fetch() wrapper that routes through the current proxy when enabled.
 * Tries EVERY healthy proxy in turn: on 403/429/5xx or connection error
 * it marks the proxy failed and rotates. Only throws after all proxies
 * (and a final direct attempt) have failed.
 */
export async function proxiedFetch(url: string, init: any = {}): Promise<any> {
  const tried = new Set<number>()
  const maxAttempts = Math.max(1, proxies.length)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const p = currentProxy()
    if (!p) {
      // No proxies (or disabled) — direct fetch.
      return fetch(url, init)
    }
    const idx = proxyIndex % proxies.length
    if (tried.has(idx)) break
    tried.add(idx)

    const dispatcher = await proxyDispatcher()
    try {
      const res = await fetch(url, { ...init, dispatcher })
      if (res.ok || (res.status < 500 && res.status !== 403 && res.status !== 429)) {
        markSuccess(p)
        return res
      }
      // Burned IP (403/429) or server error (5xx) — rotate.
      markFailure(p)
      logline("proxy", `got ${res.status} via ${p.masked}, rotating… (${attempt + 1}/${maxAttempts})`)
      try { await res.arrayBuffer().catch(() => {}) } catch {}
      nextProxy()
    } catch (err: any) {
      markFailure(p)
      logline("proxy", `proxy error via ${p.masked}, rotating… (${(err.message || err).slice(0, 50)})`)
      nextProxy()
    }
  }
  // Every proxy failed — one last direct attempt so a bad proxy list
  // can't take the whole bot down.
  logerr("proxy", "all proxies failed — trying direct")
  return fetch(url, init)
}

/** Check what outbound IP the world sees (via api.ipify.org). */
export async function checkOutboundIp(): Promise<string> {
  try {
    const res = await proxiedFetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(15000) })
    const j: any = await res.json()
    return j.ip || "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Test ONE specific proxy (by 0-based index): route an IP check through it
 * and report the outbound IP. Does not change the current proxy.
 */
export async function testProxyAt(index: number): Promise<{ ok: boolean; ip: string; ms: number }> {
  const p = proxies[index]
  if (!p) return { ok: false, ip: "no such proxy", ms: 0 }
  // Validate the URL shape first — catches malformed PROXY_LIST entries.
  try {
    const u = new URL(p.url)
    if (!u.hostname || !u.port) return { ok: false, ip: "bad URL (no host/port)", ms: 0 }
  } catch {
    return { ok: false, ip: "bad URL (unparseable)", ms: 0 }
  }
  const start = Date.now()
  try {
    const { ProxyAgent } = await import("undici")
    let dispatcher: any
    try {
      dispatcher = new ProxyAgent(p.url)
    } catch (err: any) {
      return { ok: false, ip: "bad proxy URL: " + (err.message || "invalid").slice(0, 40), ms: Date.now() - start }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const res: any = await fetch("https://api.ipify.org?format=json", {
        signal: ctrl.signal,
        dispatcher,
        headers: { "User-Agent": "Mozilla/5.0" },
      })
      clearTimeout(timer)
      if (!res.ok) {
        markFailure(p)
        return { ok: false, ip: res.status === 407 ? "auth failed (407)" : `HTTP ${res.status}`, ms: Date.now() - start }
      }
      const j = await res.json()
      markSuccess(p)
      return { ok: true, ip: j.ip || "unknown", ms: Date.now() - start }
    } catch (err: any) {
      clearTimeout(timer)
      markFailure(p)
      return { ok: false, ip: describeNetError(err), ms: Date.now() - start }
    }
  } catch (err: any) {
    return { ok: false, ip: (err.message || "error").slice(0, 50), ms: Date.now() - start }
  }
}

/** Human-readable network failure reason from an undici/fetch error. */
function describeNetError(err: any): string {
  const cause: any = err?.cause || err
  const code = String(cause?.code || "")
  if (code === "ECONNREFUSED") return "connection refused (server down)"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS failed (bad hostname)"
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "connect timeout"
  if (cause?.name === "TimeoutError" || /aborted/i.test(err?.message || "")) return "timed out (15s)"
  if (/407|proxy.*auth/i.test(err?.message || "")) return "proxy auth failed"
  return (err.message || "fetch failed").slice(0, 50)
}
