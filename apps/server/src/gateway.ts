/**
 * Model gateway adapters: issue each person their own virtual key, and revoke
 * it when they leave. The real provider keys never leave the gateway; the
 * gateway enforces budgets, model allow-lists and content rules — the hard
 * limits the desktop client cannot provide.
 *
 * LiteLLM is supported first (`/key/generate`, `/key/delete`). An adapter
 * only needs `issue` and `revoke`, so others (new-api, Higress, a built-in
 * gateway) slot in later.
 * @module @dsh-desktop-pro/server/gateway
 */

import type { GatewayConfig } from './config.ts'
import { randomToken, sha256 } from './crypto.ts'
import type { Db } from './db.ts'

export interface IssuedKey { key: string; expiresAt?: number }

export interface GatewayAdapter {
  readonly kind: string
  issue(person: { id: string; email?: string | null; name: string }, models: string[]): Promise<IssuedKey>
  revoke(key: string): Promise<void>
}

function litellm(config: GatewayConfig, fetchImpl: typeof fetch): GatewayAdapter {
  const headers = { authorization: 'Bearer ' + (config.masterKey ?? ''), 'content-type': 'application/json' }
  return {
    kind: 'litellm',
    async issue(person, models) {
      const response = await fetchImpl(config.url + '/key/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: person.id,
          key_alias: 'dsh-desktop-pro-' + person.id + '-' + String(Date.now()),
          duration: config.duration,
          ...models.length > 0 && { models },
          ...config.maxBudget !== undefined && { max_budget: config.maxBudget },
          metadata: { issued_by: 'dsh-desktop-pro-server', email: person.email ?? undefined, name: person.name },
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error('LiteLLM /key/generate answered HTTP ' + String(response.status))
      const body = await response.json() as { key?: unknown; expires?: unknown }
      if (typeof body.key !== 'string') throw new Error('LiteLLM returned no key')
      const expiresAt = typeof body.expires === 'string' ? Date.parse(body.expires) : Number.NaN
      return { key: body.key, ...Number.isFinite(expiresAt) && { expiresAt } }
    },
    async revoke(key) {
      const response = await fetchImpl(config.url + '/key/delete', {
        method: 'POST', headers, body: JSON.stringify({ keys: [key] }), signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok && response.status !== 404) throw new Error('LiteLLM /key/delete answered HTTP ' + String(response.status))
    },
  }
}

/** The built-in gateway: keys live here (as hashes); `proxy.ts` serves the traffic. */
function direct(db: Db, tenantId: string): GatewayAdapter {
  return {
    kind: 'direct',
    async issue(person) {
      const key = 'sk-dsh-' + randomToken(32)
      await db.run('INSERT INTO proxy_keys (key_hash, tenant_id, user_id, created_at) VALUES ($1, $2, $3, $4)', [sha256(key), tenantId, person.id, Date.now()])
      return { key }
    },
    async revoke(key) {
      await db.run('DELETE FROM proxy_keys WHERE key_hash = $1', [sha256(key)])
    },
  }
}

export function createGateway(config: GatewayConfig, fetchImpl: typeof fetch = fetch, db?: Db, tenantId?: string): GatewayAdapter | undefined {
  if (config.kind === 'litellm') return litellm(config, fetchImpl)
  if (config.kind === 'direct' && db !== undefined && tenantId !== undefined) return direct(db, tenantId)
  return undefined
}
