/**
 * Native DSH browser-session admission for the desktop shell.
 *
 * DSH 0.1.2-alpha.1 and later authenticate every Host API request. Their process launch
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
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'

const AUTH_RECORD_KEY = 'client-connection/browser-session'
const SECRET_BYTES = 32
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const CREDENTIAL_DOCUMENT_VERSION = 1
const MAX_CREDENTIAL_DOCUMENT_BYTES = 1024 * 1024
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

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
  if (Buffer.byteLength(source, 'utf8') > MAX_CREDENTIAL_DOCUMENT_BYTES) return undefined
  let root: Record<string, unknown> | undefined
  try {
    // JSON_SCHEMA admits the mapping/scalar shapes the official credential
    // document persists, without constructing arbitrary YAML-specific types.
    // js-yaml rejects duplicate mapping keys by default.
    root = object(parseYaml(source, { schema: JSON_SCHEMA }))
  } catch {
    return undefined
  }
  const records = object(root?.records)
  const record = object(records?.[AUTH_RECORD_KEY])
  const payload = object(record?.payload)
  if (root?.version !== CREDENTIAL_DOCUMENT_VERSION
    || record?.kind !== 'grant'
    || payload?.version !== STORED_SECRET_VERSION) return undefined
  const encoded = payload.secret
  if (typeof encoded !== 'string') return undefined
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
 * browser admission when requests approach expiry.
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
