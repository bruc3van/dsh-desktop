/**
 * The organisation's data: tenant and signing key, people and departments,
 * profiles with immutable versions, and bindings. Every write that can change
 * what someone should receive bumps the tenant's configuration revision, which
 * is the `revision` of every desired-state document — monotonic by
 * construction, so a client never mistakes an older document for news.
 * @module @dsh-desktop-pro/server/store
 */

import { generateOrganizationKey, validateProfileSpec, type ProfileSpec, type PublicKeyRecord } from '@dsh-desktop-pro/protocol'
import { appendAudit, type AuditInput } from './audit.ts'
import { newId, type Sealer } from './crypto.ts'
import type { Db } from './db.ts'
import { HttpError } from './http.ts'

export type Role = 'member' | 'admin' | 'auditor'
export const ROLES: readonly Role[] = ['member', 'admin', 'auditor']

export interface User {
  id: string
  name: string
  email: string | null
  role: Role
  status: 'active' | 'disabled'
  department_id: string | null
  /** The upstream directory that manages this person (ADR-0008); `null` when managed here. */
  source: string | null
  /** Who disabled this person; only someone the sync disabled comes back with the directory. */
  disabled_by: 'admin' | 'sync' | null
}

export interface Department { id: string; parent_id: string | null; name: string; external_id: string | null; source: string | null }

const USER_COLUMNS = 'id, name, email, role, status, department_id, source, disabled_by'

export interface Profile { id: string; name: string; description: string | null; current_version: number; updated_at: number }

export interface Binding { id: string; profile_id: string; target_type: 'tenant' | 'department' | 'user'; target_id: string; priority: number }

export function createStore(db: Db, tenantId: string, sealer: Sealer) {
  async function audit(input: AuditInput): Promise<void> {
    await appendAudit(db, tenantId, input)
  }

  async function bumpRevision(): Promise<void> {
    await db.run('UPDATE tenants SET config_revision = config_revision + 1 WHERE id = $1', [tenantId])
  }

  async function ensureTenant(name: string): Promise<void> {
    await db.transaction(async (tx) => {
      const existing = await tx.get('SELECT id FROM tenants WHERE id = $1', [tenantId])
      if (existing === undefined) {
        await tx.run('INSERT INTO tenants (id, name, config_revision, created_at) VALUES ($1, $2, 1, $3)', [tenantId, name, Date.now()])
      } else {
        await tx.run('UPDATE tenants SET name = $1 WHERE id = $2', [name, tenantId])
      }
      const key = await tx.get('SELECT key_id FROM org_keys WHERE tenant_id = $1 AND active = 1', [tenantId])
      if (key === undefined) {
        const generated = generateOrganizationKey()
        await tx.run('INSERT INTO org_keys (tenant_id, key_id, public_key, private_key_sealed, active, created_at) VALUES ($1, $2, $3, $4, 1, $5)',
          [tenantId, generated.record.keyId, generated.record.publicKey, sealer.seal(generated.privateKeyPem), Date.now()])
      }
    })
  }

  async function tenant(): Promise<{ id: string; name: string; config_revision: number }> {
    const row = await db.get<{ id: string; name: string; config_revision: number }>('SELECT id, name, config_revision FROM tenants WHERE id = $1', [tenantId])
    if (row === undefined) throw new Error('tenant missing')
    return row
  }

  async function signingKey(): Promise<{ record: PublicKeyRecord; privateKeyPem: string }> {
    const row = await db.get<{ key_id: string; public_key: string; private_key_sealed: string }>(
      'SELECT key_id, public_key, private_key_sealed FROM org_keys WHERE tenant_id = $1 AND active = 1', [tenantId])
    if (row === undefined) throw new Error('organisation key missing')
    return { record: { keyId: row.key_id, publicKey: row.public_key }, privateKeyPem: sealer.open(row.private_key_sealed) }
  }

  async function publicKeys(): Promise<PublicKeyRecord[]> {
    // Every key that ever signed stays pinnable until IT removes it from enrollment files.
    return (await db.all<{ key_id: string; public_key: string }>('SELECT key_id, public_key FROM org_keys WHERE tenant_id = $1 ORDER BY created_at', [tenantId]))
      .map(row => ({ keyId: row.key_id, publicKey: row.public_key }))
  }

  // ---- people and departments ----

  async function users(): Promise<User[]> {
    return db.all<User>('SELECT ' + USER_COLUMNS + ' FROM users WHERE tenant_id = $1 ORDER BY name', [tenantId])
  }

  async function user(id: string): Promise<User | undefined> {
    return db.get<User>('SELECT ' + USER_COLUMNS + ' FROM users WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  }

  async function userByEmail(email: string): Promise<User | undefined> {
    return db.get<User>('SELECT ' + USER_COLUMNS + ' FROM users WHERE tenant_id = $1 AND email = $2', [tenantId, email.toLowerCase()])
  }

  async function userByIdentity(provider: string, subject: string): Promise<User | undefined> {
    const link = await db.get<{ user_id: string }>('SELECT user_id FROM external_identities WHERE tenant_id = $1 AND provider = $2 AND subject = $3', [tenantId, provider, subject])
    return link === undefined ? undefined : user(link.user_id)
  }

  async function linkIdentity(userId: string, provider: string, subject: string): Promise<void> {
    const existing = await db.get('SELECT user_id FROM external_identities WHERE tenant_id = $1 AND provider = $2 AND subject = $3', [tenantId, provider, subject])
    if (existing === undefined) {
      await db.run('INSERT INTO external_identities (tenant_id, provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4, $5)', [tenantId, provider, subject, userId, Date.now()])
    }
  }

  async function createUser(input: { name: string; email?: string | null; role?: Role; departmentId?: string | null }): Promise<User> {
    const id = newId('usr')
    const now = Date.now()
    await db.run('INSERT INTO users (id, tenant_id, name, email, role, status, department_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, tenantId, input.name, input.email?.toLowerCase() ?? null, input.role ?? 'member', 'active', input.departmentId ?? null, now, now])
    await bumpRevision()
    return (await user(id)) as User
  }

  /**
   * An administrator's change. For someone an upstream directory manages, the
   * directory owns the name and department; role and status stay here.
   */
  async function updateUser(id: string, patch: { role?: Role; status?: 'active' | 'disabled'; departmentId?: string | null; name?: string }): Promise<User> {
    const current = await user(id)
    if (current === undefined) throw new HttpError(404, 'user_not_found')
    if (current.source !== null && ((patch.name !== undefined && patch.name !== current.name) || (patch.departmentId !== undefined && patch.departmentId !== current.department_id))) {
      throw new HttpError(409, 'managed_by_directory', 'Name and department come from the organisation directory.')
    }
    const disabledBy: User['disabled_by'] = patch.status === undefined ? current.disabled_by : patch.status === 'disabled' ? 'admin' : null
    await db.run('UPDATE users SET name = $1, role = $2, status = $3, department_id = $4, disabled_by = $5, updated_at = $6 WHERE tenant_id = $7 AND id = $8', [
      patch.name ?? current.name, patch.role ?? current.role, patch.status ?? current.status,
      patch.departmentId === undefined ? current.department_id : patch.departmentId, disabledBy, Date.now(), tenantId, id,
    ])
    await bumpRevision()
    return (await user(id)) as User
  }

  async function departments(): Promise<Department[]> {
    return db.all<Department>('SELECT id, parent_id, name, external_id, source FROM departments WHERE tenant_id = $1 ORDER BY name', [tenantId])
  }

  async function createDepartment(name: string, parentId: string | null, externalId: string | null = null): Promise<Department> {
    if (parentId !== null && (await db.get('SELECT id FROM departments WHERE tenant_id = $1 AND id = $2', [tenantId, parentId])) === undefined) {
      throw new HttpError(400, 'parent_not_found')
    }
    const id = newId('dep')
    await db.run('INSERT INTO departments (id, tenant_id, parent_id, name, external_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, tenantId, parentId, name, externalId, Date.now()])
    return { id, parent_id: parentId, name, external_id: externalId, source: null }
  }

  /** A department path like `Finance/Payables`, created as needed. */
  async function departmentByPath(path: string): Promise<string | null> {
    const parts = path.split('/').map(part => part.trim()).filter(part => part !== '')
    let parent: string | null = null
    for (const part of parts) {
      const found: { id: string } | undefined = await db.get<{ id: string }>(
        parent === null
          ? 'SELECT id FROM departments WHERE tenant_id = $1 AND parent_id IS NULL AND name = $2'
          : 'SELECT id FROM departments WHERE tenant_id = $1 AND parent_id = $3 AND name = $2',
        parent === null ? [tenantId, part] : [tenantId, part, parent])
      parent = found?.id ?? (await createDepartment(part, parent)).id
    }
    return parent
  }

  /** The department and its ancestors, nearest last. */
  async function departmentChain(departmentId: string | null): Promise<string[]> {
    const all = new Map((await departments()).map(dep => [dep.id, dep]))
    const chain: string[] = []
    let current = departmentId
    while (current !== null && all.has(current) && !chain.includes(current)) {
      chain.unshift(current)
      current = all.get(current)?.parent_id ?? null
    }
    return chain
  }

  // ---- profiles ----

  async function profiles(): Promise<Profile[]> {
    return db.all<Profile>('SELECT id, name, description, current_version, updated_at FROM profiles WHERE tenant_id = $1 ORDER BY name', [tenantId])
  }

  function checkSpec(value: unknown): ProfileSpec {
    const result = validateProfileSpec(value)
    if (!result.ok) throw new HttpError(400, 'invalid_profile', result.path + ' ' + result.reason)
    return result.value
  }

  async function createProfile(input: { name: string; description?: string; spec: unknown }, actor: string): Promise<Profile> {
    const spec = checkSpec(input.spec)
    const id = newId('prf')
    const now = Date.now()
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO profiles (id, tenant_id, name, description, current_version, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $5)', [id, tenantId, input.name, input.description ?? null, now])
      await tx.run('INSERT INTO profile_versions (tenant_id, profile_id, version, spec, note, created_by, created_at) VALUES ($1, $2, 1, $3, $4, $5, $6)', [tenantId, id, JSON.stringify(spec), 'created', actor, now])
    })
    await bumpRevision()
    return (await profile(id)) as Profile
  }

  async function profile(id: string): Promise<Profile | undefined> {
    return db.get<Profile>('SELECT id, name, description, current_version, updated_at FROM profiles WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  }

  async function profileVersions(id: string): Promise<Array<{ version: number; spec: ProfileSpec; note: string | null; created_by: string | null; created_at: number }>> {
    const rows = await db.all<{ version: number; spec: string; note: string | null; created_by: string | null; created_at: number }>(
      'SELECT version, spec, note, created_by, created_at FROM profile_versions WHERE tenant_id = $1 AND profile_id = $2 ORDER BY version DESC', [tenantId, id])
    return rows.map(row => ({ ...row, spec: JSON.parse(row.spec) as ProfileSpec }))
  }

  /** Every change is a new immutable version; rollback writes an old spec as the next version. */
  async function updateProfile(id: string, input: { spec: unknown; note?: string; name?: string; description?: string }, actor: string): Promise<Profile> {
    const spec = checkSpec(input.spec)
    await db.transaction(async (tx) => {
      const current = await tx.get<{ current_version: number; name: string; description: string | null }>(
        'SELECT current_version, name, description FROM profiles WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      if (current === undefined) throw new HttpError(404, 'profile_not_found')
      const version = current.current_version + 1
      const now = Date.now()
      await tx.run('INSERT INTO profile_versions (tenant_id, profile_id, version, spec, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [tenantId, id, version, JSON.stringify(spec), input.note ?? null, actor, now])
      await tx.run('UPDATE profiles SET current_version = $1, name = $2, description = $3, updated_at = $4 WHERE tenant_id = $5 AND id = $6',
        [version, input.name ?? current.name, input.description ?? current.description, now, tenantId, id])
    })
    await bumpRevision()
    return (await profile(id)) as Profile
  }

  async function currentSpec(id: string): Promise<{ version: number; spec: ProfileSpec } | undefined> {
    const row = await db.get<{ version: number; spec: string }>(
      'SELECT v.version AS version, v.spec AS spec FROM profiles p JOIN profile_versions v ON v.profile_id = p.id AND v.version = p.current_version WHERE p.tenant_id = $1 AND p.id = $2',
      [tenantId, id])
    return row === undefined ? undefined : { version: row.version, spec: JSON.parse(row.spec) as ProfileSpec }
  }

  async function bindings(): Promise<Binding[]> {
    return db.all<Binding>('SELECT id, profile_id, target_type, target_id, priority FROM profile_bindings WHERE tenant_id = $1 ORDER BY target_type, priority', [tenantId])
  }

  async function bind(input: { profileId: string; targetType: Binding['target_type']; targetId: string; priority?: number }): Promise<Binding> {
    if ((await profile(input.profileId)) === undefined) throw new HttpError(404, 'profile_not_found')
    if (!['tenant', 'department', 'user'].includes(input.targetType)) throw new HttpError(400, 'invalid_target_type')
    const id = newId('bnd')
    await db.run('INSERT INTO profile_bindings (id, tenant_id, profile_id, target_type, target_id, priority, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, tenantId, input.profileId, input.targetType, input.targetType === 'tenant' ? tenantId : input.targetId, input.priority ?? 0, Date.now()])
    await bumpRevision()
    return { id, profile_id: input.profileId, target_type: input.targetType, target_id: input.targetType === 'tenant' ? tenantId : input.targetId, priority: input.priority ?? 0 }
  }

  async function unbind(id: string): Promise<void> {
    if ((await db.run('DELETE FROM profile_bindings WHERE tenant_id = $1 AND id = $2', [tenantId, id])) === 0) throw new HttpError(404, 'binding_not_found')
    await bumpRevision()
  }

  /**
   * The profiles that apply to a person, lowest priority first:
   * organisation-wide, then each department from the root down, then personal.
   */
  async function profilesFor(person: User): Promise<Array<{ id: string; version: number; spec: ProfileSpec }>> {
    const all = await bindings()
    const chain = await departmentChain(person.department_id)
    const ordered: Binding[] = [
      ...all.filter(binding => binding.target_type === 'tenant'),
      ...chain.flatMap(dep => all.filter(binding => binding.target_type === 'department' && binding.target_id === dep)),
      ...all.filter(binding => binding.target_type === 'user' && binding.target_id === person.id),
    ]
    const out: Array<{ id: string; version: number; spec: ProfileSpec }> = []
    for (const binding of ordered) {
      const spec = await currentSpec(binding.profile_id)
      if (spec !== undefined && !out.some(entry => entry.id === binding.profile_id)) out.push({ id: binding.profile_id, ...spec })
    }
    return out
  }

  return {
    db, tenantId, audit, bumpRevision, ensureTenant, tenant, signingKey, publicKeys,
    users, user, userByEmail, userByIdentity, linkIdentity, createUser, updateUser,
    departments, createDepartment, departmentByPath,
    profiles, profile, profileVersions, createProfile, updateProfile, bindings, bind, unbind, profilesFor,
  }
}

export type Store = ReturnType<typeof createStore>
