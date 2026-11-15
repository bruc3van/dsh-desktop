/**
 * Organisation signatures over JSON documents.
 *
 * A signed document is `{ payload, signature }`, where the signature is
 * Ed25519 over the canonical JSON of `payload` (object keys sorted, no
 * insignificant whitespace). The client pins the organisation's public key at
 * enrollment and refuses any document whose signature does not verify against
 * a pinned key — so a compromised network path or a tampered cache cannot
 * hand it a different configuration.
 * @module @dsh-desktop-pro/protocol/signing
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { asResult, fail, onlyKeys, record, string, type Result } from './validation.ts'

export interface SignedDocument<T = unknown> {
  payload: T
  signature: {
    alg: 'ed25519'
    /** Identifies the signing key, so rotation can pin more than one. */
    keyId: string
    /** Base64 Ed25519 signature over `canonicalJson(payload)`. */
    value: string
  }
}

/** A public key as distributed in enrollment files: base64 SPKI DER. */
export interface PublicKeyRecord {
  keyId: string
  publicKey: string
}

/** Deterministic JSON: sorted object keys, no whitespace, no undefined members. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical JSON cannot encode ' + String(value))
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item === undefined ? null : item)).join(',') + ']'
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}'
  }
  throw new Error('canonical JSON cannot encode a ' + typeof value)
}

/** A key id derived from the public key itself, so it can never be mislabelled. */
export function keyIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return 'ed25519:' + createHash('sha256').update(der).digest('base64url').slice(0, 16)
}

export function generateOrganizationKey(): { privateKeyPem: string; record: PublicKeyRecord } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    record: publicKeyRecord(publicKey),
  }
}

export function publicKeyRecord(publicKey: KeyObject): PublicKeyRecord {
  return {
    keyId: keyIdFor(publicKey),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

export function publicKeyFromPrivatePem(privateKeyPem: string): KeyObject {
  return createPublicKey(createPrivateKey(privateKeyPem))
}

export function signDocument<T>(payload: T, privateKeyPem: string): SignedDocument<T> {
  const privateKey = createPrivateKey(privateKeyPem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('organisation keys must be Ed25519')
  const value = sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64')
  return { payload, signature: { alg: 'ed25519', keyId: keyIdFor(createPublicKey(privateKey)), value } }
}

export function isSignedDocument(value: unknown): value is SignedDocument {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'payload') && Object.hasOwn(value, 'signature')
}

function parseSigned(value: unknown): SignedDocument {
  const doc = record(value, '$')
  onlyKeys(doc, '$', ['payload', 'signature'])
  const signature = record(doc['signature'], '$.signature')
  onlyKeys(signature, '$.signature', ['alg', 'keyId', 'value'])
  if (signature['alg'] !== 'ed25519') fail('$.signature.alg', 'must be ed25519')
  return {
    payload: doc['payload'],
    signature: {
      alg: 'ed25519',
      keyId: string(signature['keyId'], '$.signature.keyId', { max: 128 }),
      value: string(signature['value'], '$.signature.value', { max: 512, pattern: /^[A-Za-z0-9+/]+={0,2}$/ }),
    },
  }
}

/**
 * Verify a signed document against the pinned keys. Returns the payload only
 * when a pinned key with the document's key id verifies the signature.
 */
export function verifyDocument(value: unknown, trusted: readonly PublicKeyRecord[]): Result<unknown> {
  const parsed = asResult(() => parseSigned(value))
  if (!parsed.ok) return parsed
  const { payload, signature } = parsed.value
  const pinned = trusted.find(key => key.keyId === signature.keyId)
  if (pinned === undefined) return { ok: false, path: '$.signature.keyId', reason: 'is not a pinned organisation key' }
  let publicKey: KeyObject
  try {
    publicKey = createPublicKey({ key: Buffer.from(pinned.publicKey, 'base64'), format: 'der', type: 'spki' })
  } catch {
    return { ok: false, path: '$.signature.keyId', reason: 'the pinned key is not a valid public key' }
  }
  if (keyIdFor(publicKey) !== pinned.keyId) return { ok: false, path: '$.signature.keyId', reason: 'the pinned key does not match its id' }
  let valid = false
  try {
    valid = verify(null, Buffer.from(canonicalJson(payload), 'utf8'), publicKey, Buffer.from(signature.value, 'base64'))
  } catch {
    valid = false
  }
  return valid ? { ok: true, value: payload } : { ok: false, path: '$.signature.value', reason: 'does not verify' }
}
