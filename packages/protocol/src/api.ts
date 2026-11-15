/**
 * Client ↔ server API v1: paths, payloads and the device proof.
 *
 * Sign-in is OAuth 2.0 authorization code + PKCE through the system browser,
 * with a loopback redirect. Every later call carries the bearer token and a
 * device proof: an Ed25519 signature, by the key generated at enrollment,
 * over the method, path and a timestamp — so a token copied off one machine
 * does not work from another.
 * @module @dsh-desktop-pro/protocol/api
 */

import { createHash, sign, verify, type KeyObject } from 'node:crypto'

export const PROTOCOL_VERSION = 1

export const API = {
  authorize: '/v1/auth/authorize',
  token: '/v1/auth/token',
  logout: '/v1/auth/logout',
  devices: '/v1/devices',
  desiredState: '/v1/desired-state',
  /** Long poll: answers when the document may have changed, or after about a minute. */
  watch: '/v1/desired-state/watch',
  status: '/v1/status',
  audit: '/v1/audit',
  discovery: '/v1/discovery',
  /** The organisation's skill library; `/v1/skills/<id>/subscription` installs or removes an optional one. */
  skills: '/v1/skills',
} as const

export const DEVICE_ID_HEADER = 'x-dsh-device-id'
export const DEVICE_PROOF_HEADER = 'x-dsh-device-proof'
export const PROTOCOL_HEADER = 'x-dsh-protocol'

/** Maximum clock skew accepted on a device proof. */
export const DEVICE_PROOF_WINDOW_MS = 5 * 60 * 1000

export interface DiscoveryResponse {
  protocol: number
  organization: { id: string; name: string }
  /** Sign-in methods the server offers, for the client's first screen. */
  signIn: Array<{ id: string; label: string }>
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  user: { id: string; name: string; email?: string }
}

export interface EnrollRequest {
  /** Base64 SPKI DER of the device's Ed25519 public key. */
  publicKey: string
  platform: string
  arch: string
  clientVersion: string
  hostname?: string
}

export interface EnrollResponse {
  deviceId: string
}

export interface StatusReport {
  revision: number
  result: 'applied' | 'partial' | 'failed'
  problems: string[]
  clientVersion: string
  dshVersion?: string
  appliedAt: string
}

export interface WatchResponse {
  /** The organisation's configuration revision now. */
  revision: number
  /** Something changed for this device: fetch the document again. */
  changed: boolean
}

/** One skill of the organisation's library, as one person sees it. */
export interface CompanySkill {
  id: string
  title: string
  description?: string
  /** `everyone`: always installed. `optional`: the person chooses. */
  distribution: 'everyone' | 'optional'
  version: number
  updatedAt: string
  installed: boolean
}

export interface SkillListResponse {
  skills: CompanySkill[]
}

export interface AuditEventInput {
  at: string
  action: string
  target?: string
  detail?: Record<string, string | number | boolean>
}

export interface AuditBatch {
  events: AuditEventInput[]
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function proofMessage(method: string, path: string, timestamp: string): Buffer {
  return Buffer.from(method.toUpperCase() + '\n' + path + '\n' + timestamp, 'utf8')
}

/** `<timestamp>.<base64 signature>` for one request. */
export function createDeviceProof(privateKey: KeyObject, method: string, path: string, now = Date.now()): string {
  const timestamp = String(now)
  return timestamp + '.' + sign(null, proofMessage(method, path, timestamp), privateKey).toString('base64')
}

export function checkDeviceProof(publicKey: KeyObject, proof: string, method: string, path: string, now = Date.now()): boolean {
  const match = /^(\d{10,16})\.([A-Za-z0-9+/]+={0,2})$/.exec(proof)
  if (match === null) return false
  const [, timestamp = '', signature = ''] = match
  if (Math.abs(now - Number(timestamp)) > DEVICE_PROOF_WINDOW_MS) return false
  try {
    return verify(null, proofMessage(method, path, timestamp), publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
