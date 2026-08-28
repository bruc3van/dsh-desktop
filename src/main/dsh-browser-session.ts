/**
 * Native DSH browser-session admission for the desktop shell.
 *
 * DSH 0.1.2 authenticates every Host API request. Its per-process launch
 * token is intentionally printed once and never persisted, while the signing
 * secret for restart-stable browser sessions lives in the shared DSH home.
 * The desktop shell already runs as the same operating-system user and uses
 * that same home, so it can mint one short-lived, authority-bound cookie
 * without weakening the Web server's uniform 401 boundary or persisting the
 * launch token.
 * @module dsh-desktop/dsh-browser-session
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTH_RECORD_KEY = 'client-connection/browser-session'
const SECRET_BYTES = 32
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
/** DSH accepts at least one day; this stays below its 30-day default. */
const NATIVE_COOKIE_LIFETIME_MS = 24 * 60 * 60 * 1000
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/** One cookie usable by both a Node probe and Electron's browser session. */
export interface DshBrowserSessionCookie {
  name: string
  value: string
  expiresAt: number
  header: string
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function scalar(value: string): string | undefined {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1)
  }
  return trimmed === '' ? undefined : trimmed
}

/** The exact owner record block, without treating refs or another record as authority. */
function browserSessionRecord(source: string): string | undefined {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const header = new RegExp(`^  (?:${AUTH_RECORD_KEY}|["']${AUTH_RECORD_KEY}["']):\\s*$`, 'u')
  const start = lines.findIndex(line => header.test(line))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== undefined && /^  \S/u.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

/**
 * Read and validate DSH's versioned browser-session signing secret.
 * Unreadable, missing, or future-format credentials are unsupported rather
 * than guessed; the caller then keeps the ordinary unauthenticated probe.
 */
export function readDshBrowserSessionSecret(dshHome: string): Buffer | undefined {
  let source: string
  try {
    source = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const record = browserSessionRecord(source)
  if (record === undefined
    || !/^    kind:\s*grant\s*$/mu.test(record)
    || !/^    payload:\s*$/mu.test(record)
    || !new RegExp(`^      version:\\s*${String(STORED_SECRET_VERSION)}\\s*$`, 'mu').test(record)) return undefined
  const secretLine = /^      secret:\s*(.+?)\s*$/mu.exec(record)?.[1]
  const encoded = secretLine === undefined ? undefined : scalar(secretLine)
  if (encoded === undefined) return undefined
  const secret = decodeBase64Url(encoded)
  return secret?.byteLength === SECRET_BYTES ? secret : undefined
}

function loopbackAuthority(base: string): string | undefined {
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:') return undefined
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    return url.host
  } catch {
    return undefined
  }
}

/**
 * Mint the same signed cookie DSH accepts, limited to one loopback authority
 * and one day. The lifetime stays below the official 30-day default, remains
 * valid across an ordinary long-running desktop session, and is refreshed by
 * the reused-instance health probe while its window is visible.
 */
export function createDshBrowserSessionCookie(
  dshHome: string,
  base: string,
  now = Date.now(),
): DshBrowserSessionCookie | undefined {
  const authority = loopbackAuthority(base)
  const secret = readDshBrowserSessionSecret(dshHome)
  if (authority === undefined || secret === undefined || !Number.isSafeInteger(now)) return undefined
  const expiresAt = now + NATIVE_COOKIE_LIFETIME_MS
  if (!Number.isSafeInteger(expiresAt)) return undefined
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: now,
    expiresAt,
  }
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest())
  const value = `v1.${body}.${signature}`
  const name = COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
  return { name, value, expiresAt, header: `${name}=${value}` }
}
