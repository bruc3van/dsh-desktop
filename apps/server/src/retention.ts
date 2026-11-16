/**
 * Housekeeping: what the server keeps, and for how long.
 *
 * - Sign-in leftovers (expired flows, codes, access tokens, ended sessions)
 *   go as soon as they can no longer be used.
 * - Per-request gateway records go after `DSH_REQUEST_RETENTION_DAYS`
 *   (400 by default: a year of month-over-month comparisons).
 * - The audit log is kept for good unless `DSH_AUDIT_RETENTION_DAYS` is set.
 *   Pruning keeps the chain checkable: the hash of the last removed event is
 *   written down as a checkpoint, and verification starts from it, so cutting
 *   events off the start without a checkpoint is still detected.
 * @module @dsh-desktop-pro/server/retention
 */

import { appendAudit } from './audit.ts'
import type { Db } from './db.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export interface RetentionConfig {
  /** Days of per-request gateway records; 0 keeps them. */
  requestDays: number
  /** Days of audit events; 0 keeps them. */
  auditDays: number
}

export interface RetentionResult {
  signIn: number
  requests: number
  audit: number
}

export async function runRetention(db: Db, tenantId: string, config: RetentionConfig, now = Date.now()): Promise<RetentionResult> {
  let signIn = 0
  signIn += await db.run('DELETE FROM login_flows WHERE tenant_id = $1 AND expires_at < $2', [tenantId, now])
  signIn += await db.run('DELETE FROM auth_codes WHERE tenant_id = $1 AND expires_at < $2', [tenantId, now])
  signIn += await db.run('DELETE FROM access_tokens WHERE tenant_id = $1 AND expires_at < $2', [tenantId, now])
  // Ended sessions stay a while so a reused refresh token is still recognised.
  signIn += await db.run('DELETE FROM sessions WHERE tenant_id = $1 AND (expires_at < $2 OR revoked = 1) AND created_at < $3', [tenantId, now, now - 30 * DAY_MS])

  let requests = 0
  if (config.requestDays > 0) {
    requests = await db.run('DELETE FROM gateway_requests WHERE tenant_id = $1 AND started_at < $2', [tenantId, now - config.requestDays * DAY_MS])
  }

  let audit = 0
  if (config.auditDays > 0) {
    audit = await db.transaction(async (tx) => {
      // Never remove the newest event: the chain needs a tip to append to.
      const tip = await tx.get<{ seq: number }>('SELECT seq FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [tenantId])
      if (tip === undefined) return 0
      const last = await tx.get<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM audit_events WHERE tenant_id = $1 AND at < $2 AND seq < $3 ORDER BY seq DESC LIMIT 1', [tenantId, now - config.auditDays * DAY_MS, tip.seq])
      if (last === undefined) return 0
      await tx.run('DELETE FROM audit_checkpoints WHERE tenant_id = $1', [tenantId])
      await tx.run('INSERT INTO audit_checkpoints (tenant_id, seq, hash, pruned_at) VALUES ($1, $2, $3, $4)', [tenantId, last.seq, last.hash, now])
      return tx.run('DELETE FROM audit_events WHERE tenant_id = $1 AND seq <= $2', [tenantId, last.seq])
    })
    if (audit > 0) await appendAudit(db, tenantId, { actorType: 'system', action: 'audit.pruned', detail: { events: audit, olderThanDays: config.auditDays } })
  }
  return { signIn, requests, audit }
}

/** Run now and then every hour until the returned function is called. */
export function startRetention(db: Db, tenantId: string, config: RetentionConfig): () => void {
  let running: Promise<unknown> = Promise.resolve()
  const run = (): void => {
    running = runRetention(db, tenantId, config).catch((error: unknown) => { console.error('[retention]', error) })
  }
  run()
  const timer = setInterval(run, HOUR_MS)
  timer.unref()
  return () => { clearInterval(timer); void running }
}
