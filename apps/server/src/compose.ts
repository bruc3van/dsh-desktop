/**
 * One person's desired state: the merge of their profiles, their personal
 * gateway key, the tenant revision, signed with the organisation key.
 * @module @dsh-desktop-pro/server/compose
 */

import {
  DESIRED_STATE_SCHEMA, DESIRED_STATE_VERSION, mergeProfiles, signDocument, validateDesiredState,
  type DesiredState, type ProfileSpec, type SignedDocument,
} from '@dsh-desktop-pro/protocol'
import type { ServerConfig } from './config.ts'
import type { Sealer } from './crypto.ts'
import type { GatewayAdapter } from './gateway.ts'
import type { Market } from './market.ts'
import type { Store, User } from './store.ts'

/** Reissue a gateway key this long before it expires. */
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000

export interface Composer {
  compose(person: User): Promise<DesiredState>
  signedFor(person: User): Promise<SignedDocument<DesiredState>>
  revokeGatewayKey(userId: string): Promise<void>
}

export function createComposer(store: Store, config: ServerConfig, sealer: Sealer, gateway: GatewayAdapter | undefined, market?: Market): Composer {
  async function gatewayKey(person: User, models: string[]): Promise<string> {
    if (gateway === undefined) throw new Error('no gateway configured')
    const row = await store.db.get<{ key_sealed: string; expires_at: number | null }>(
      'SELECT key_sealed, expires_at FROM gateway_keys WHERE tenant_id = $1 AND user_id = $2 AND gateway = $3', [store.tenantId, person.id, gateway.kind])
    if (row !== undefined && (row.expires_at === null || row.expires_at - Date.now() > RENEW_BEFORE_MS)) return sealer.open(row.key_sealed)
    const issued = await gateway.issue(person, models)
    await store.db.transaction(async (tx) => {
      await tx.run('DELETE FROM gateway_keys WHERE tenant_id = $1 AND user_id = $2 AND gateway = $3', [store.tenantId, person.id, gateway.kind])
      await tx.run('INSERT INTO gateway_keys (tenant_id, user_id, gateway, key_sealed, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [store.tenantId, person.id, gateway.kind, sealer.seal(issued.key), issued.expiresAt ?? null, Date.now()])
    })
    await store.audit({ actorType: 'system', action: 'gateway.key.issued', target: person.id, detail: { gateway: gateway.kind, models } })
    if (row !== undefined) await gateway.revoke(sealer.open(row.key_sealed)).catch(() => undefined)
    return issued.key
  }

  async function compose(person: User): Promise<DesiredState> {
    const tenant = await store.tenant()
    const layers = await store.profilesFor(person)
    // The market goes under every profile: a profile's skill of the same name
    // wins, and its blocked plugins only add to the market's.
    const fromMarket = market === undefined ? undefined : await market.forPerson(person)
    const base: ProfileSpec = {}
    if (fromMarket !== undefined) {
      if (fromMarket.indexUrl !== undefined || fromMarket.blocked.length > 0) {
        base.plugins = {
          ...fromMarket.indexUrl !== undefined && { indexes: [fromMarket.indexUrl] },
          ...fromMarket.blocked.length > 0 && { blocked: fromMarket.blocked },
        }
      }
      if (fromMarket.skills.length > 0) base.skills = fromMarket.skills
    }
    const merged = mergeProfiles([base, ...layers.map(layer => layer.spec)])
    const state: DesiredState = {
      schema: DESIRED_STATE_SCHEMA,
      version: DESIRED_STATE_VERSION,
      revision: tenant.config_revision,
      issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      organization: { id: tenant.id, name: tenant.name },
      source: { profiles: layers.map(layer => ({ id: layer.id, version: layer.version })) },
      ...merged,
    }
    // Deliver the personal key under the reference the routes name.
    const routes = Object.values(state.models?.providers ?? {}).filter(route => route.credential === config.gateway.credential)
    if (gateway !== undefined && routes.length > 0) {
      const models = [...new Set(routes.flatMap(route => route.models.map(model => model.id)))]
      state.credentials = { [config.gateway.credential]: await gatewayKey(person, models) }
    }
    const checked = validateDesiredState(state)
    if (!checked.ok) throw new Error('composed state is invalid at ' + checked.path + ': ' + checked.reason)
    return checked.value
  }

  return {
    compose,
    async signedFor(person) {
      const key = await store.signingKey()
      return signDocument(await compose(person), key.privateKeyPem)
    },
    async revokeGatewayKey(userId) {
      if (gateway === undefined) return
      const rows = await store.db.all<{ key_sealed: string }>('SELECT key_sealed FROM gateway_keys WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
      for (const row of rows) await gateway.revoke(sealer.open(row.key_sealed))
      await store.db.run('DELETE FROM gateway_keys WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
      if (rows.length > 0) await store.audit({ actorType: 'system', action: 'gateway.key.revoked', target: userId })
    },
  }
}
