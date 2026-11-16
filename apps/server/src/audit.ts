/**
 * The append-only audit log, hash-chained.
 *
 * Each event stores the hash of the one before it and its own hash over a
 * canonical encoding of its fields, so deleting, reordering or editing any
 * stored event breaks verification from that point on. Events are appended
 * inside a transaction that reads the current tip, so concurrent writers
 * cannot fork the chain.
 * @module @dsh-desktop-pro/server/audit
 */

import { canonicalJson } from '@dsh-desktop-pro/protocol'
import { sha256 } from './crypto.ts'
import type { Db } from './db.ts'

export interface AuditInput {
  actorType: 'user' | 'admin' | 'system' | 'device'
  actorId?: string
  action: string
  target?: string
  detail?: Record<string, unknown>
  /** `server` for events the server observed, `client` for events a device reported. */
  source?: 'server' | 'client'
  at?: number
}

interface StoredEvent {
  seq: number
  at: number
  actor_type: string
  actor_id: string | null
  action: string
  target: string | null
  detail: string | null
  source: string
  prev_hash: string
  hash: string
}

const GENESIS = '0'.repeat(64)

function eventHash(tenantId: string, event: Omit<StoredEvent, 'hash'>): string {
  return sha256(canonicalJson({
    tenantId, seq: event.seq, at: event.at, actorType: event.actor_type, actorId: event.actor_id, action: event.action,
    target: event.target, detail: event.detail, source: event.source, prev: event.prev_hash,
  }))
}

export async function appendAudit(db: Db, tenantId: string, input: AuditInput): Promise<void> {
  await db.transaction(async (tx) => {
    const tip = await tx.get<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [tenantId])
    const event: Omit<StoredEvent, 'hash'> = {
      seq: (tip?.seq ?? 0) + 1,
      at: input.at ?? Date.now(),
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
      source: input.source ?? 'server',
      prev_hash: tip?.hash ?? GENESIS,
    }
    await tx.run(
      'INSERT INTO audit_events (seq, tenant_id, at, actor_type, actor_id, action, target, detail, source, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [event.seq, tenantId, event.at, event.actor_type, event.actor_id, event.action, event.target, event.detail, event.source, event.prev_hash, eventHash(tenantId, event)],
    )
  })
}

/**
 * Walk the whole chain. Returns the first broken sequence number, if any.
 * After pruning, the chain starts from the recorded checkpoint instead of the
 * genesis: removing events from the start without one still breaks it.
 */
export async function verifyAudit(db: Db, tenantId: string): Promise<{ ok: true; events: number } | { ok: false; brokenAt: number; events: number }> {
  const rows = await db.all<StoredEvent>(
    'SELECT seq, at, actor_type, actor_id, action, target, detail, source, prev_hash, hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq', [tenantId])
  const checkpoint = await db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_checkpoints WHERE tenant_id = $1', [tenantId])
  let previous = checkpoint?.hash ?? GENESIS
  let expectedSeq = (checkpoint?.seq ?? 0) + 1
  for (const row of rows) {
    if (row.seq !== expectedSeq || row.prev_hash !== previous || eventHash(tenantId, row) !== row.hash) {
      return { ok: false, brokenAt: row.seq, events: rows.length }
    }
    previous = row.hash
    expectedSeq += 1
  }
  return { ok: true, events: rows.length }
}

export interface AuditQuery {
  action?: string
  actorId?: string
  since?: number
  until?: number
  limit?: number
  beforeSeq?: number
}

export async function queryAudit(db: Db, tenantId: string, query: AuditQuery): Promise<Array<Record<string, unknown>>> {
  const clauses = ['tenant_id = $1']
  const params: Array<string | number> = [tenantId]
  const add = (sql: string, value: string | number): void => { params.push(value); clauses.push(sql.replace('?', '$' + String(params.length))) }
  if (query.action !== undefined && query.action !== '') add('action LIKE ?', query.action.replace(/[%_]/g, '') + '%')
  if (query.actorId !== undefined && query.actorId !== '') add('actor_id = ?', query.actorId)
  if (query.since !== undefined) add('at >= ?', query.since)
  if (query.until !== undefined) add('at <= ?', query.until)
  if (query.beforeSeq !== undefined) add('seq < ?', query.beforeSeq)
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const rows = await db.all<StoredEvent>(
    'SELECT seq, at, actor_type, actor_id, action, target, detail, source, prev_hash, hash FROM audit_events WHERE '
      + clauses.join(' AND ') + ' ORDER BY seq DESC LIMIT ' + String(limit), params)
  return rows.map(row => ({
    seq: row.seq, at: row.at, actorType: row.actor_type, actorId: row.actor_id, action: row.action, target: row.target,
    detail: row.detail === null ? undefined : JSON.parse(row.detail) as unknown, source: row.source, hash: row.hash,
  }))
}
