/**
 * Directory sync (ADR-0008): one engine for every upstream directory.
 *
 * A run reads a complete snapshot, compares it with the departments and
 * people this source manages, and turns the difference into a plan. Applying
 * the plan writes everything in one transaction and moves the configuration
 * revision once. People who left are disabled, not deleted, and go through
 * the same off-boarding as a manual disable. A plan that would disable more
 * than the allowed share of managed people is not applied unless forced.
 *
 * The snapshot is the truth; nothing here depends on change events, so a run
 * repairs whatever an earlier one missed.
 * @module @dsh-desktop-pro/server/identity/sync
 */

import { newId } from '../crypto.ts'
import type { Db } from '../db.ts'
import type { Store } from '../store.ts'
import type { DirectoryConnector, DirectoryDepartment, DirectorySnapshot, DirectoryUser } from './types.ts'

export interface DirectorySyncConfig {
  intervalMinutes: number
  /** Largest share of managed, active people one run may disable without being forced. */
  maxDisablePercent: number
}

interface ManagedUser { id: string; name: string; email: string | null; status: string; disabled_by: string | null; department_id: string | null; external_id: string }
interface ManagedDepartment { id: string; name: string; parent_id: string | null; external_id: string }

export interface SyncPlan {
  source: string
  departments: {
    create: DirectoryDepartment[]
    update: Array<{ id: string; externalId: string; name: string; parentExternalId: string | null; was: { name: string; parentExternalId: string | null } }>
    remove: Array<{ id: string; externalId: string; name: string }>
  }
  users: {
    create: DirectoryUser[]
    /** An existing, unmanaged member with the same e-mail becomes managed by the source. */
    adopt: Array<{ id: string; name: string; user: DirectoryUser }>
    update: Array<{ id: string; name: string; user: DirectoryUser; fields: Array<'name' | 'email' | 'department'> }>
    disable: Array<{ id: string; name: string; externalId: string; reason: 'inactive' | 'missing' }>
    enable: Array<{ id: string; name: string; externalId: string }>
  }
  /** Set when the plan disables more people than allowed. */
  blocked: { disabling: number; managedActive: number; limit: number } | null
  /** Directory people already in step. */
  unchanged: number
}

export interface SyncRun {
  id: string
  source: string
  trigger: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'applied' | 'unchanged' | 'blocked' | 'failed'
  summary: Record<string, number>
  error: string | null
}

function changes(plan: SyncPlan): number {
  const d = plan.departments
  const u = plan.users
  return d.create.length + d.update.length + d.remove.length + u.create.length + u.adopt.length + u.update.length + u.disable.length + u.enable.length
}

function summary(plan: SyncPlan): Record<string, number> {
  return {
    departmentsCreated: plan.departments.create.length, departmentsUpdated: plan.departments.update.length, departmentsRemoved: plan.departments.remove.length,
    usersCreated: plan.users.create.length, usersAdopted: plan.users.adopt.length, usersUpdated: plan.users.update.length,
    usersDisabled: plan.users.disable.length, usersEnabled: plan.users.enable.length, unchanged: plan.unchanged,
  }
}

export interface DirectorySyncOptions {
  db: Db
  store: Store
  connector: DirectoryConnector
  config: DirectorySyncConfig
  /** The same off-boarding as a manual disable: sessions, gateway keys, devices. */
  onDisabled(userId: string): Promise<void>
}

export function createDirectorySync(options: DirectorySyncOptions) {
  const { db, store, connector, config } = options
  const source = connector.source
  const tenantId = store.tenantId
  let running: Promise<SyncRun> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let starter: ReturnType<typeof setTimeout> | undefined

  async function plan(snapshot: DirectorySnapshot): Promise<SyncPlan> {
    const managedDepartments = await db.all<ManagedDepartment>('SELECT id, name, parent_id, external_id FROM departments WHERE tenant_id = $1 AND source = $2', [tenantId, source])
    const managedUsers = await db.all<ManagedUser>('SELECT id, name, email, status, disabled_by, department_id, external_id FROM users WHERE tenant_id = $1 AND source = $2', [tenantId, source])
    const unmanaged = await db.all<{ id: string; name: string; email: string | null }>('SELECT id, name, email FROM users WHERE tenant_id = $1 AND source IS NULL AND email IS NOT NULL', [tenantId])

    // Departments: only ones the snapshot can place (a parent outside the visible range makes it top level).
    const listed = new Map(snapshot.departments.map(dep => [dep.externalId, dep]))
    const parentOf = (dep: DirectoryDepartment): string | null => dep.parentExternalId !== null && listed.has(dep.parentExternalId) ? dep.parentExternalId : null
    const departmentByExternal = new Map(managedDepartments.map(dep => [dep.external_id, dep]))
    const externalOfDepartment = new Map(managedDepartments.map(dep => [dep.id, dep.external_id]))
    const result: SyncPlan = {
      source,
      departments: { create: [], update: [], remove: [] },
      users: { create: [], adopt: [], update: [], disable: [], enable: [] },
      blocked: null,
      unchanged: 0,
    }
    for (const dep of snapshot.departments) {
      const existing = departmentByExternal.get(dep.externalId)
      const parent = parentOf(dep)
      if (existing === undefined) { result.departments.create.push({ ...dep, parentExternalId: parent }); continue }
      const wasParent = existing.parent_id === null ? null : externalOfDepartment.get(existing.parent_id) ?? null
      if (existing.name !== dep.name || wasParent !== parent) {
        result.departments.update.push({ id: existing.id, externalId: dep.externalId, name: dep.name, parentExternalId: parent, was: { name: existing.name, parentExternalId: wasParent } })
      }
    }
    for (const dep of managedDepartments) {
      if (!listed.has(dep.external_id)) result.departments.remove.push({ id: dep.id, externalId: dep.external_id, name: dep.name })
    }

    // People.
    const userByExternal = new Map(managedUsers.map(person => [person.external_id, person]))
    const unmanagedByEmail = new Map(unmanaged.map(person => [person.email as string, person]))
    const seen = new Set<string>()
    for (const person of snapshot.users) {
      seen.add(person.externalId)
      const department = person.departmentExternalId !== null && listed.has(person.departmentExternalId) ? person.departmentExternalId : null
      const normalised: DirectoryUser = { ...person, departmentExternalId: department }
      const existing = userByExternal.get(person.externalId)
      if (existing === undefined) {
        if (!person.active) continue
        const adoptable = person.email === null ? undefined : unmanagedByEmail.get(person.email)
        if (adoptable !== undefined) {
          unmanagedByEmail.delete(person.email as string)
          result.users.adopt.push({ id: adoptable.id, name: adoptable.name, user: normalised })
        } else {
          result.users.create.push(normalised)
        }
        continue
      }
      const fields: Array<'name' | 'email' | 'department'> = []
      if (existing.name !== person.name) fields.push('name')
      if (person.email !== null && existing.email !== person.email) fields.push('email')
      const currentDepartment = existing.department_id === null ? null : externalOfDepartment.get(existing.department_id) ?? null
      if (currentDepartment !== department) fields.push('department')
      if (fields.length > 0) result.users.update.push({ id: existing.id, name: existing.name, user: normalised, fields })
      if (!person.active && existing.status === 'active') result.users.disable.push({ id: existing.id, name: existing.name, externalId: existing.external_id, reason: 'inactive' })
      else if (person.active && existing.status !== 'active' && existing.disabled_by === 'sync') result.users.enable.push({ id: existing.id, name: existing.name, externalId: existing.external_id })
      else if (fields.length === 0) result.unchanged += 1
    }
    for (const person of managedUsers) {
      if (!seen.has(person.external_id) && person.status === 'active') result.users.disable.push({ id: person.id, name: person.name, externalId: person.external_id, reason: 'missing' })
    }

    // A narrowed visible range or an empty answer must not off-board the company.
    const managedActive = managedUsers.filter(person => person.status === 'active').length
    const limit = Math.max(3, Math.ceil(managedActive * config.maxDisablePercent / 100))
    // Disabling everyone it manages is always held, however small the organisation.
    const everyone = managedActive > 0 && result.users.disable.length >= managedActive
    if (result.users.disable.length > limit || everyone) result.blocked = { disabling: result.users.disable.length, managedActive, limit }
    return result
  }

  async function apply(planned: SyncPlan): Promise<void> {
    const disabled = await db.transaction(async (tx) => {
      const now = Date.now()
      const departmentId = new Map((await tx.all<{ id: string; external_id: string }>('SELECT id, external_id FROM departments WHERE tenant_id = $1 AND source = $2', [tenantId, source])).map(dep => [dep.external_id, dep.id]))
      for (const dep of planned.departments.create) {
        const id = newId('dep')
        departmentId.set(dep.externalId, id)
        await tx.run('INSERT INTO departments (id, tenant_id, parent_id, name, external_id, source, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)', [id, tenantId, dep.name, dep.externalId, source, now])
      }
      // Parents once every department exists, so order within the snapshot does not matter.
      for (const dep of [...planned.departments.create, ...planned.departments.update]) {
        const parent = dep.parentExternalId === null ? null : departmentId.get(dep.parentExternalId) ?? null
        await tx.run('UPDATE departments SET name = $1, parent_id = $2 WHERE tenant_id = $3 AND id = $4', [dep.name, parent, tenantId, departmentId.get(dep.externalId) as string])
      }
      const departmentOf = (user: DirectoryUser): string | null => user.departmentExternalId === null ? null : departmentId.get(user.departmentExternalId) ?? null
      const emailFree = async (email: string | null, self: string | null): Promise<string | null> => {
        if (email === null) return null
        const holder = await tx.get<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1 AND email = $2', [tenantId, email])
        return holder === undefined || holder.id === self ? email : null
      }
      for (const person of planned.users.create) {
        const id = newId('usr')
        await tx.run("INSERT INTO users (id, tenant_id, name, email, role, status, department_id, source, external_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 'member', 'active', $5, $6, $7, $8, $8)",
          [id, tenantId, person.name, await emailFree(person.email, null), departmentOf(person), source, person.externalId, now])
        await tx.run('INSERT INTO external_identities (tenant_id, provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4, $5)', [tenantId, source, person.externalId, id, now])
      }
      for (const adopted of planned.users.adopt) {
        await tx.run('UPDATE users SET name = $1, department_id = $2, source = $3, external_id = $4, updated_at = $5 WHERE tenant_id = $6 AND id = $7',
          [adopted.user.name, departmentOf(adopted.user), source, adopted.user.externalId, now, tenantId, adopted.id])
        await tx.run('DELETE FROM external_identities WHERE tenant_id = $1 AND provider = $2 AND subject = $3', [tenantId, source, adopted.user.externalId])
        await tx.run('INSERT INTO external_identities (tenant_id, provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4, $5)', [tenantId, source, adopted.user.externalId, adopted.id, now])
      }
      for (const updated of planned.users.update) {
        const email = updated.fields.includes('email') ? await emailFree(updated.user.email, updated.id) : undefined
        await tx.run('UPDATE users SET name = $1, department_id = $2, email = COALESCE($3, email), updated_at = $4 WHERE tenant_id = $5 AND id = $6',
          [updated.user.name, departmentOf(updated.user), email ?? null, now, tenantId, updated.id])
      }
      for (const person of planned.users.disable) {
        await tx.run("UPDATE users SET status = 'disabled', disabled_by = 'sync', updated_at = $1 WHERE tenant_id = $2 AND id = $3", [now, tenantId, person.id])
      }
      for (const person of planned.users.enable) {
        await tx.run("UPDATE users SET status = 'active', disabled_by = NULL, updated_at = $1 WHERE tenant_id = $2 AND id = $3", [now, tenantId, person.id])
      }
      for (const dep of planned.departments.remove) {
        // Its people move to no department, its assignments go, its sub-departments move up.
        await tx.run('UPDATE users SET department_id = NULL WHERE tenant_id = $1 AND department_id = $2', [tenantId, dep.id])
        await tx.run("DELETE FROM profile_bindings WHERE tenant_id = $1 AND target_type = 'department' AND target_id = $2", [tenantId, dep.id])
        await tx.run('UPDATE departments SET parent_id = NULL WHERE tenant_id = $1 AND parent_id = $2', [tenantId, dep.id])
        await tx.run('DELETE FROM departments WHERE tenant_id = $1 AND id = $2', [tenantId, dep.id])
      }
      await tx.run('UPDATE tenants SET config_revision = config_revision + 1 WHERE id = $1', [tenantId])
      return planned.users.disable.map(person => person.id)
    })
    for (const id of disabled) await options.onDisabled(id)
    // Who came, went and came back is part of the audit trail; renames are in the run summary.
    for (const person of planned.users.create) await store.audit({ actorType: 'system', action: 'directory.user.created', target: person.externalId, detail: { source, name: person.name } })
    for (const adopted of planned.users.adopt) await store.audit({ actorType: 'system', action: 'directory.user.adopted', target: adopted.id, detail: { source, externalId: adopted.user.externalId } })
    for (const person of planned.users.disable) await store.audit({ actorType: 'system', action: 'directory.user.disabled', target: person.id, detail: { source, reason: person.reason } })
    for (const person of planned.users.enable) await store.audit({ actorType: 'system', action: 'directory.user.enabled', target: person.id, detail: { source } })
    for (const dep of planned.departments.remove) await store.audit({ actorType: 'system', action: 'directory.department.removed', target: dep.id, detail: { source, name: dep.name } })
  }

  async function record(run: SyncRun): Promise<void> {
    await db.run('UPDATE directory_runs SET finished_at = $1, status = $2, summary = $3, error = $4 WHERE id = $5', [run.finishedAt, run.status, JSON.stringify(run.summary), run.error, run.id])
  }

  /** Read the directory and say what a run would change. Changes nothing. */
  async function preview(): Promise<SyncPlan> {
    return plan(await connector.fetch())
  }

  /** One run at a time; a request made during a run gets that run's result. */
  function run(input: { trigger: string; force?: boolean; actor?: string }): Promise<SyncRun> {
    running ??= (async () => {
      const current: SyncRun = { id: newId('dsr'), source, trigger: input.trigger, startedAt: Date.now(), finishedAt: null, status: 'running', summary: {}, error: null }
      await db.run('INSERT INTO directory_runs (id, tenant_id, source, trigger, started_at, status) VALUES ($1, $2, $3, $4, $5, $6)', [current.id, tenantId, source, input.trigger, current.startedAt, 'running'])
      try {
        const planned = await plan(await connector.fetch())
        current.summary = summary(planned)
        if (planned.blocked !== null && input.force !== true) {
          current.status = 'blocked'
          current.summary = { ...current.summary, limit: planned.blocked.limit, managedActive: planned.blocked.managedActive }
        } else if (changes(planned) === 0) {
          current.status = 'unchanged'
        } else {
          await apply(planned)
          current.status = 'applied'
        }
      } catch (error) {
        current.status = 'failed'
        current.error = error instanceof Error ? error.message.slice(0, 1000) : String(error)
      }
      current.finishedAt = Date.now()
      await record(current)
      if (current.status !== 'unchanged') {
        await store.audit({
          actorType: input.actor === undefined ? 'system' : 'admin', ...input.actor !== undefined && { actorId: input.actor },
          action: 'directory.sync.' + current.status, target: source, detail: { ...current.summary, trigger: input.trigger, ...input.force === true && { forced: true }, ...current.error !== null && { error: current.error.slice(0, 200) } },
        })
      }
      return current
    })().finally(() => { running = undefined })
    return running
  }

  async function runs(limit = 20): Promise<SyncRun[]> {
    const rows = await db.all<{ id: string; source: string; trigger: string; started_at: number; finished_at: number | null; status: SyncRun['status']; summary: string | null; error: string | null }>(
      'SELECT id, source, trigger, started_at, finished_at, status, summary, error FROM directory_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT ' + String(Math.max(1, Math.min(100, limit))), [tenantId])
    return rows.map(row => ({ id: row.id, source: row.source, trigger: row.trigger, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, summary: row.summary === null ? {} : JSON.parse(row.summary) as Record<string, number>, error: row.error }))
  }

  return {
    source,
    intervalMinutes: config.intervalMinutes,
    preview,
    run,
    runs,
    isRunning: () => running !== undefined,
    start() {
      // A run shortly after start, then on the interval; a run interrupted by a restart is marked failed.
      void db.run("UPDATE directory_runs SET status = 'failed', error = 'interrupted', finished_at = $1 WHERE tenant_id = $2 AND status = 'running'", [Date.now(), tenantId])
      starter = setTimeout(() => { void run({ trigger: 'schedule' }) }, 10_000)
      starter.unref()
      timer = setInterval(() => { void run({ trigger: 'schedule' }) }, config.intervalMinutes * 60_000)
      timer.unref()
    },
    async stop() {
      if (starter !== undefined) clearTimeout(starter)
      if (timer !== undefined) clearInterval(timer)
      await running?.catch(() => undefined)
    },
  }
}

export type DirectorySync = ReturnType<typeof createDirectorySync>
