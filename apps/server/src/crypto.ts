/**
 * Server-side secrets: opaque tokens stored only as hashes, and AES-256-GCM
 * sealing for values the server must read back (gateway keys, the
 * organisation signing key). The sealing key is derived from
 * `DSH_SERVER_SECRET`; losing that secret makes sealed values unreadable.
 * @module @dsh-desktop-pro/server/crypto
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function newId(prefix: string): string {
  return prefix + '_' + randomBytes(12).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createSealer(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'dsh-desktop-pro-server', 'seal-v1', 32))
  return {
    seal(plain: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    open(sealed: string): string {
      if (!sealed.startsWith('v1.')) throw new Error('unknown sealed value format')
      const raw = Buffer.from(sealed.slice(3), 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

export type Sealer = ReturnType<typeof createSealer>
