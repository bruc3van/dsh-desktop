/**
 * What one person's device should hold: the merge of the person's profiles,
 * the gateway key of that device, the tenant revision, signed with the
 * organisation key.
 *
 * Two things are kept apart on purpose:
 *
 * - The **revision** is the tenant's counter. It only orders documents, so a
 *   client never takes an older one for news. It moves on every change
 *   anywhere in the organisation.
 * - The **fingerprint** says what a device should hold: a hash of the
 *   person's merged configuration and of the device's key. It moves only when
 *   that device has something new to apply. "Is this device up to date" and
 *   "should this device be woken" are answered by fingerprints, never by
 *   comparing revisions.
 *
 * Gateway keys belong to a device, not to a person: revoking one device ends
 * its key and leaves the person's other devices alone.
 * @module @dsh-desktop-pro/server/compose
 */

import {
  canonicalJson, DESIRED_STATE_SCHEMA, DESIRED_STATE_VERSION, mergeProfiles, signDocument, validateDesiredState,
  type DesiredState, type ProfileSpec, type SignedDocument,
} from '@dsh-desktop-pro/protocol'
import type { ServerConfig } from './config.ts'
import { sha256, type Sealer } from './crypto.ts'
import type { GatewayAdapter } from './gateway.ts'
import type { Market } from './market.ts'
import type { Store, User } from './store.ts'

/** Reissue a gateway key this long before it expires. */
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000

/** Stands in for the key in a preview: keys exist per device and are never shown. */
const PREVIEW_KEY = 'issued-per-device'

export interface Composer {
  /** Without a device this is a preview: nothing is issued, the key is a placeholder. */
  compose(person: User, deviceId?: string): Promise<DesiredState>
  /** The signed document for a device, and the fingerprint of what it carries. */
  signedFor(person: User, deviceId: string): Promise<{ signed: SignedDocument<DesiredState>; fingerprint: string }>
  /** The fingerprint each device should currently hold. Read-only: issues nothing. */
  expected(devices: ReadonlyArray<{ id: string; user_id: string }>): Promise<Map<string, string>>
  /** End one device's gateway key. */
  revokeDeviceKey(deviceId: string): Promise<void>
  /** End every gateway key of a person. */
  revokeGatewayKey(userId: string): Promise<void>
}

interface Content {
  state: DesiredState
  /** Models routed through the organisation gateway; empty when no key is needed. */
  gatewayModels: string[]
  fingerprint: string
}

export function createComposer(store: Store, config: ServerConfig, sealer: Sealer, gateway: GatewayAdapter | undefined, market?: Market): Composer {
  /** One entry per person, valid for one tenant revision: every change that can alter it moves the revision. */
  const cache = new Map<string, { revision: number; content: Content }>()

  /** The person's configuration without credentials. Pure: nothing is issued or written. */
  async function content(person: User): Promise<Content> {
    const tenant = await store.tenant()
    const cached = cache.get(person.id)
    if (cached !== undefined && cached.revision === tenant.config_revision) return cached.content
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
    const routes = Object.values(state.models?.providers ?? {}).filter(route => route.credential === config.gateway.credential)
    const gatewayModels = gateway === undefined ? [] : [...new Set(routes.flatMap(route => route.models.map(model => model.id)))]
    const result: Content = {
      state, gatewayModels,
      // Everything but the two fields that change without the configuration changing.
      fingerprint: sha256(canonicalJson({ ...state, revision: 0, issuedAt: '' })),
    }
    cache.set(person.id, { revision: tenant.config_revision, content: result })
    return result
  }

  interface KeyRow { key_sealed: string; expires_at: number | null; created_at: number }

  async function keyRow(deviceId: string): Promise<KeyRow | undefined> {
    if (gateway === undefined) return undefined
    return store.db.get<KeyRow>(
      'SELECT key_sealed, expires_at, created_at FROM device_keys WHERE tenant_id = $1 AND device_id = $2 AND gateway = $3', [store.tenantId, deviceId, gateway.kind])
  }

  /** The device's key, issued on first need and renewed shortly before it expires. */
  async function deviceKey(person: User, deviceId: string, models: string[]): Promise<string> {
    if (gateway === undefined) throw new Error('no gateway configured')
    const row = await keyRow(deviceId)
    if (row !== undefined && (row.expires_at === null || row.expires_at - Date.now() > RENEW_BEFORE_MS)) return sealer.open(row.key_sealed)
    const issued = await gateway.issue(person, models, deviceId)
    await store.db.transaction(async (tx) => {
      await tx.run('DELETE FROM device_keys WHERE tenant_id = $1 AND device_id = $2 AND gateway = $3', [store.tenantId, deviceId, gateway.kind])
      await tx.run('INSERT INTO device_keys (tenant_id, device_id, user_id, gateway, key_sealed, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [store.tenantId, deviceId, person.id, gateway.kind, sealer.seal(issued.key), issued.expiresAt ?? null, Date.now()])
    })
    await store.audit({ actorType: 'system', action: 'gateway.key.issued', target: deviceId, detail: { gateway: gateway.kind, user: person.id, models } })
    if (row !== undefined) await gateway.revoke(sealer.open(row.key_sealed)).catch(() => undefined)
    return issued.key
  }

  /** A device's fingerprint: the person's configuration, and which key the device was given. */
  function deviceFingerprint(configuration: Content, key: { created_at: number } | undefined): string {
    return sha256(configuration.fingerprint + '|' + (configuration.gatewayModels.length > 0 && key !== undefined ? String(key.created_at) : ''))
  }

  async function compose(person: User, deviceId?: string): Promise<DesiredState> {
    const configuration = await content(person)
    // A fresh object each time: the cached one must not pick up a device's key.
    const state: DesiredState = { ...configuration.state, issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }
    if (configuration.gatewayModels.length > 0) {
      // Deliver the key under the reference the routes name.
      state.credentials = { [config.gateway.credential]: deviceId === undefined ? PREVIEW_KEY : await deviceKey(person, deviceId, configuration.gatewayModels) }
    }
    const checked = validateDesiredState(state)
    if (!checked.ok) throw new Error('composed state is invalid at ' + checked.path + ': ' + checked.reason)
    return checked.value
  }

  async function revoke(rows: Array<{ key_sealed: string }>): Promise<void> {
    if (gateway === undefined) return
    for (const row of rows) await gateway.revoke(sealer.open(row.key_sealed))
  }

  return {
    compose,
    async signedFor(person, deviceId) {
      const state = await compose(person, deviceId)
      const key = await store.signingKey()
      return { signed: signDocument(state, key.privateKeyPem), fingerprint: deviceFingerprint(await content(person), await keyRow(deviceId)) }
    },
    async expected(devices) {
      const out = new Map<string, string>()
      if (devices.length === 0) return out
      const keys = gateway === undefined ? [] : await store.db.all<{ device_id: string; created_at: number }>(
        'SELECT device_id, created_at FROM device_keys WHERE tenant_id = $1 AND gateway = $2', [store.tenantId, gateway.kind])
      const keyOf = new Map(keys.map(row => [row.device_id, row]))
      const people = new Map((await store.users()).map(person => [person.id, person]))
      for (const device of devices) {
        const person = people.get(device.user_id)
        if (person !== undefined) out.set(device.id, deviceFingerprint(await content(person), keyOf.get(device.id)))
      }
      return out
    },
    async revokeDeviceKey(deviceId) {
      const rows = await store.db.all<{ key_sealed: string }>('SELECT key_sealed FROM device_keys WHERE tenant_id = $1 AND device_id = $2', [store.tenantId, deviceId])
      await revoke(rows)
      await store.db.run('DELETE FROM device_keys WHERE tenant_id = $1 AND device_id = $2', [store.tenantId, deviceId])
      if (rows.length > 0) await store.audit({ actorType: 'system', action: 'gateway.key.revoked', target: deviceId })
    },
    async revokeGatewayKey(userId) {
      const rows = await store.db.all<{ key_sealed: string }>('SELECT key_sealed FROM device_keys WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
      await revoke(rows)
      await store.db.run('DELETE FROM device_keys WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
      if (rows.length > 0) await store.audit({ actorType: 'system', action: 'gateway.key.revoked', target: userId, detail: { keys: rows.length } })
    },
  }
}
