/** Native authentication is scoped to a selected origin, never to a cookie host. */
import { createHash } from 'node:crypto'
import { appOrigin } from './connection-policy.ts'
import { createDshBrowserSessionCookie, type DshBrowserSessionCookie } from './dsh-browser-session.ts'

/** WebSocket handshakes use the authentication origin of their HTTP transport. */
function requestOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    else if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin
  } catch { return '' }
}

export function scopedDshCookieHeader(existing: string, native?: string, allowedName?: string): string {
  const cookies = existing.split(';').map(value => value.trim())
    .filter(value => value !== '' && (!/^dsh-auth-/i.test(value) || (native === undefined && allowedName !== undefined && value.startsWith(allowedName + '='))))
  if (native !== undefined) cookies.push(native)
  return cookies.join('; ')
}

export function createBrowserAdmission(options: {
  home(): string
  target(): string | undefined
  mainContentsId(): number | undefined
  verify(origin: string): Promise<boolean>
}) {
  let epoch = 0
  let admitted: { origin: string; cookie: DshBrowserSessionCookie } | undefined

  async function select(url: string): Promise<boolean> {
    const generation = ++epoch
    admitted = undefined
    const origin = appOrigin(url)
    const cookie = createDshBrowserSessionCookie(options.home(), origin)
    if (cookie !== undefined && await options.verify(origin)) {
      if (generation !== epoch || appOrigin(options.target() ?? '') !== origin) return false
      admitted = { origin, cookie }
    }
    return generation === epoch && appOrigin(options.target() ?? '') === origin
  }

  function headers(url: string, contentsId: number | undefined, incoming: Record<string, string>): Record<string, string> {
    const result = { ...incoming }
    const origin = requestOrigin(url)
    let native: string | undefined
    if (admitted?.origin === origin && origin === appOrigin(options.target() ?? '')
      && contentsId !== undefined && contentsId === options.mainContentsId()) {
      if (admitted.cookie.expiresAt <= Date.now() + 60_000) {
        const refreshed = createDshBrowserSessionCookie(options.home(), origin)
        admitted = refreshed === undefined ? undefined : { origin, cookie: refreshed }
      }
      native = admitted?.cookie.header
    }
    const keys = Object.keys(result).filter(key => key.toLowerCase() === 'cookie')
    const existing = keys.map(key => result[key]).join('; ')
    for (const key of keys) Reflect.deleteProperty(result, key)
    const allowedName = contentsId !== undefined && contentsId === options.mainContentsId()
      && origin !== '' && origin === appOrigin(options.target() ?? '')
      ? 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url') : undefined
    const cookie = scopedDshCookieHeader(existing, native, allowedName)
    if (cookie !== '') result.Cookie = cookie
    return result
  }

  return { select, headers }
}
