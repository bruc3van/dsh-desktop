import { originOf } from './runtime-lock.ts'
import type { ClientSettings } from './client-settings.ts'

/** Normalize a user-supplied Web UI address to an origin, or undefined when blank/invalid. */
export function normalizeServerUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let candidate = value.trim()
  // Case-insensitive: `HTTPS://host` is a scheme, not a hostname, and a
  // case-sensitive test would misread it as `http://https//host` — an origin
  // that can never connect, followed by a misleading plaintext warning.
  if (!/^https?:\/\//i.test(candidate)) candidate = 'http://' + candidate
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Loopback origins are the client's own surfaces; anything else is a
 * user-configured remote.
 */
export function originIsLoopback(value: string): boolean {
  try {
    const host = new URL(value).hostname
    // WHATWG `URL.hostname` is `::1`. `[::1]` is only seen when a caller
    // passes a still-bracketed host.
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * Whether a navigation is the same server telling us to use TLS. A bare
 * hostname normalizes to `http://`, so a Web UI that redirects plaintext to
 * its own HTTPS origin is the ordinary case, not a detour: same host, same
 * port, scheme strictly better. Anything else is a real origin change.
 */
export function isSecureUpgrade(from: string, to: string): boolean {
  try {
    const before = new URL(from)
    const after = new URL(to)
    return before.protocol === 'http:' && after.protocol === 'https:'
      && before.hostname === after.hostname && before.port === after.port
  } catch {
    return false
  }
}

/** Whether persisted settings currently select the reusable remote origin. */
export function usesConfiguredServer(settings: ClientSettings): boolean {
  return normalizeServerUrl(settings.serverUrl) !== undefined && settings.connectionMode !== 'smart'
}

/** The official Web UI origin (the window must stay inside it). */
export function appOrigin(url: string): string {
  return originOf(url)
}
