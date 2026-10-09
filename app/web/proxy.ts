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
}

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
  return list.map((url) => ({ url, masked: maskProxy(url) }))
}

let proxies: ProxyEntry[] = loadProxies()
let proxyIndex = 0
let proxyEnabled = proxies.length > 0

/** Reload from env (call after env changes, or periodically). */
export function reloadProxies(): void {
  proxies = loadProxies()
  if (proxyIndex >= proxies.length) proxyIndex = 0
  if (proxies.length > 0 && !proxyEnabled) {
    // stay disabled until user turns it on
  }
  logline("proxy", `loaded ${proxies.length} prox${proxies.length === 1 ? "y" : "ies"}`)
}

export function proxyCount(): number {
  return proxies.length
}

export function isProxyEnabled(): boolean {
  return proxyEnabled && proxies.length > 0
}

export function currentProxy(): ProxyEntry | null {
  if (!isProxyEnabled()) return null
  return proxies[proxyIndex % proxies.length]
}

/** Switch to the next proxy. Returns the new proxy (or null if none). */
export function nextProxy(): ProxyEntry | null {
  if (proxies.length === 0) return null
  proxyIndex = (proxyIndex + 1) % proxies.length
  proxyEnabled = true
  const p = currentProxy()
  logline("proxy", `switched to ${p?.masked} (${proxyIndex + 1}/${proxies.length})`)
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
 * Automatically rotates to the next proxy on 403/429 (IP likely burned).
 */
export async function proxiedFetch(url: string, init: any = {}): Promise<any> {
  const dispatcher = await proxyDispatcher()
  try {
    const res = await fetch(url, { ...init, dispatcher })
    // If the proxy's IP is burned (403/429), try the next proxy once.
    if ((res.status === 403 || res.status === 429) && proxies.length > 1) {
      logline("proxy", `got ${res.status}, rotating IP…`)
      nextProxy()
      const d2 = await proxyDispatcher()
      return fetch(url, { ...init, dispatcher: d2 })
    }
    return res
  } catch (err: any) {
    // Connection through proxy failed — try next proxy once.
    if (proxies.length > 1) {
      logline("proxy", `proxy error, rotating IP… (${(err.message || err).slice(0, 60)})`)
      nextProxy()
      const d2 = await proxyDispatcher()
      return fetch(url, { ...init, dispatcher: d2 })
    }
    throw err
  }
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
