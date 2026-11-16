/**
 * What the built-in gateway knows about models and money: the model catalog
 * (the names people use, the upstream each goes to, and its price), one record
 * per request, the totals the console reads, and the limits checked before a
 * request is forwarded.
 *
 * Money is kept as integers: prices in micro-yuan per million tokens, costs in
 * micro-yuan. A model without a price is "unpriced": its calls add no cost and
 * are counted apart, never as free.
 * @module @dsh-desktop-pro/server/metering
 */

import type { ServerConfig } from './config.ts'
import { newId, type Sealer } from './crypto.ts'
import type { Db, Param } from './db.ts'
import { HttpError } from './http.ts'

export const PERIODS = ['minute', '5h', 'day', 'week', 'month'] as const
export const METRICS = ['tokens', 'cost', 'requests'] as const
export const SCOPES = ['tenant', 'department', 'member_default', 'user'] as const
export const QUOTA_ACTIONS = ['block', 'fallback'] as const
export type Period = typeof PERIODS[number]
export type Metric = typeof METRICS[number]
export type Scope = typeof SCOPES[number]
export type QuotaAction = typeof QUOTA_ACTIONS[number]

const MILLION = 1_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

// ---------- time ----------

/** Milliseconds to add to a UTC instant to read the wall clock in `timeZone`. */
function zoneOffset(at: number, timeZone: string): number {
  const parts: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)) parts[part.type] = part.value
  const wall = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']))
  return wall - Math.floor(at / 1000) * 1000
}

/** The local calendar day of an instant, `YYYY-MM-DD`. */
export function localDay(at: number, timeZone: string): string {
  return new Date(at + zoneOffset(at, timeZone)).toISOString().slice(0, 10)
}

/**
 * Where a limit's current window starts, and when it next resets. Day, week
 * (from Monday) and month follow the local calendar; minute and 5h roll.
 */
export function periodWindow(period: Period, now: number, timeZone: string): { start: number; reset?: number; rolling: boolean; length?: number } {
  if (period === 'minute') return { start: now - 60_000, rolling: true, length: 60_000 }
  if (period === '5h') return { start: now - 5 * HOUR, rolling: true, length: 5 * HOUR }
  const offset = zoneOffset(now, timeZone)
  const local = now + offset
  const midnight = Math.floor(local / DAY) * DAY
  if (period === 'day') return { start: midnight - offset, reset: midnight + DAY - offset, rolling: false }
  if (period === 'week') {
    const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7
    const monday = midnight - sinceMonday * DAY
    return { start: monday - offset, reset: monday + 7 * DAY - offset, rolling: false }
  }
  const date = new Date(midnight)
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return { start: first - offset, reset: next - offset, rolling: false }
}

// ---------- tokens and cost ----------

export interface Tokens { input: number; cacheRead: number; output: number; reasoning: number }

/**
 * Token counts from an OpenAI-style `usage` object. Chat Completions,
 * Responses and DeepSeek's cache fields are all read; `input` is the part of
 * the prompt that was not served from the provider's cache.
 */
export function tokensFrom(usage: Record<string, unknown> | undefined): Tokens {
  const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0 }
  const nested = (key: string, field: string): unknown => (usage?.[key] as Record<string, unknown> | undefined)?.[field]
  const prompt = num(usage?.['prompt_tokens'] ?? usage?.['input_tokens'])
  const cached = num(nested('prompt_tokens_details', 'cached_tokens') ?? nested('input_tokens_details', 'cached_tokens') ?? usage?.['prompt_cache_hit_tokens'])
  const cacheRead = Math.min(cached, prompt)
  return {
    input: prompt - cacheRead,
    cacheRead,
    output: num(usage?.['completion_tokens'] ?? usage?.['output_tokens']),
    reasoning: num(nested('completion_tokens_details', 'reasoning_tokens') ?? nested('output_tokens_details', 'reasoning_tokens')),
  }
}

export interface Prices { input: number | null; output: number | null; cacheRead: number | null }

/** Cost in micro-yuan, or null when the model has no price. Cache reads fall back to the input price. */
export function costOf(tokens: Tokens, prices: Prices): number | null {
  if (prices.input === null || prices.output === null) return null
  const cacheRead = prices.cacheRead ?? prices.input
  return Math.round((tokens.input * prices.input + tokens.cacheRead * cacheRead + tokens.output * prices.output) / MILLION)
}

// ---------- shapes ----------

export interface Upstream { id: string; name: string; baseUrl: string; hasKey: boolean; builtin: boolean; models: number }

export interface CatalogModel {
  id: string
  name: string
  upstreamId: string
  upstreamModel: string
  /** Yuan per million tokens. */
  prices: { input: number | null; output: number | null; cacheRead: number | null }
  contextWindow: number | null
  tags: string[]
  recommended: boolean
  enabled: boolean
  updatedAt: number
}

export interface Quota {
  id: string
  scopeType: Scope
  scopeId: string | null
  period: Period
  metric: Metric
  /** Tokens, requests, or micro-yuan for cost. */
  amount: number
  action: QuotaAction
  fallbackModel: string | null
  updatedAt: number
}

export interface RequestRecord {
  userId: string
  /** The device whose key sent the request. */
  deviceId?: string | null
  departmentId: string | null
  startedAt: number
  endpoint: string
  model: string
  servedModel?: string | null
  upstreamId?: string | null
  fallbackFrom?: string | null
  client?: string | null
  stream: boolean
  status: 'ok' | 'error' | 'refused'
  httpStatus: number
  error?: string | null
  stopReason?: string | null
  tokens: Tokens
  costMicros: number | null
  ttftMs?: number | null
  durationMs: number
}

export interface UsageFilter { from: string; to: string; userId?: string; departmentIds?: string[]; model?: string; status?: string; client?: string }

interface ModelRow {
  id: string; name: string; upstream_id: string; upstream_model: string; input_price: number | null; output_price: number | null
  cache_read_price: number | null; context_window: number | null; tags: string; recommended: number; enabled: number; updated_at: number
}
interface QuotaRow {
  id: string; scope_type: Scope; scope_id: string | null; period: Period; metric: Metric; amount: number; action: QuotaAction; fallback_model: string | null; updated_at: number
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/
const toYuan = (micros: number | null): number | null => (micros === null || micros === undefined ? null : Number(micros) / MILLION)
const toMicros = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, 'invalid_' + field)
  return Math.round(n * MILLION)
}

function modelFromRow(row: ModelRow): CatalogModel {
  let tags: string[] = []
  try { tags = (JSON.parse(row.tags) as unknown[]).filter((tag): tag is string => typeof tag === 'string') } catch { tags = [] }
  return {
    id: row.id, name: row.name, upstreamId: row.upstream_id, upstreamModel: row.upstream_model,
    prices: { input: toYuan(row.input_price), output: toYuan(row.output_price), cacheRead: toYuan(row.cache_read_price) },
    contextWindow: row.context_window === null ? null : Number(row.context_window), tags,
    recommended: Number(row.recommended) === 1, enabled: Number(row.enabled) === 1, updatedAt: Number(row.updated_at),
  }
}

function quotaFromRow(row: QuotaRow): Quota {
  return {
    id: row.id, scopeType: row.scope_type, scopeId: row.scope_id, period: row.period, metric: row.metric, amount: Number(row.amount),
    action: row.action, fallbackModel: row.fallback_model, updatedAt: Number(row.updated_at),
  }
}

/** The SQL aggregate for one metric over `gateway_requests`, counting only requests that reached a model. */
function metricSql(metric: Metric): string {
  if (metric === 'tokens') return "SUM(CASE WHEN status = 'ok' THEN input_tokens + cache_read_tokens + output_tokens ELSE 0 END)"
  if (metric === 'cost') return "SUM(CASE WHEN status = 'ok' THEN COALESCE(cost_micros, 0) ELSE 0 END)"
  return "SUM(CASE WHEN status <> 'refused' THEN 1 ELSE 0 END)"
}

export function createMetering(db: Db, tenantId: string, sealer: Sealer, config: ServerConfig) {
  const timeZone = config.timeZone
  const builtin = config.gateway.upstreamUrl

  // ---------- upstreams ----------

  async function upstreams(): Promise<Upstream[]> {
    const rows = await db.all<{ id: string; name: string; base_url: string; key_sealed: string | null }>(
      'SELECT id, name, base_url, key_sealed FROM upstreams WHERE tenant_id = $1 ORDER BY created_at', [tenantId])
    const counts = new Map((await db.all<{ upstream_id: string; n: number }>(
      'SELECT upstream_id, COUNT(*) AS n FROM catalog_models WHERE tenant_id = $1 GROUP BY upstream_id', [tenantId])).map(row => [row.upstream_id, Number(row.n)]))
    return [
      ...builtin !== undefined ? [{ id: 'default', name: 'DSH_UPSTREAM_URL', baseUrl: builtin, hasKey: config.gateway.upstreamKey !== undefined, builtin: true, models: counts.get('default') ?? 0 }] : [],
      ...rows.map(row => ({ id: row.id, name: row.name, baseUrl: row.base_url, hasKey: row.key_sealed !== null, builtin: false, models: counts.get(row.id) ?? 0 })),
    ]
  }

  /** Where to send a request for this upstream, with its key; undefined when it does not exist. */
  async function upstreamTarget(id: string): Promise<{ url: string; key?: string } | undefined> {
    if (id === 'default') return builtin === undefined ? undefined : { url: builtin, ...config.gateway.upstreamKey !== undefined && { key: config.gateway.upstreamKey } }
    const row = await db.get<{ base_url: string; key_sealed: string | null }>('SELECT base_url, key_sealed FROM upstreams WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    if (row === undefined) return undefined
    return { url: row.base_url, ...row.key_sealed !== null && { key: sealer.open(row.key_sealed) } }
  }

  function baseUrl(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_base_url')
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new HttpError(400, 'invalid_base_url') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'invalid_base_url')
    return url.href.replace(/\/+$/, '')
  }

  async function saveUpstream(id: string | undefined, input: { name?: unknown; baseUrl?: unknown; apiKey?: unknown }): Promise<Upstream> {
    if (id === 'default') throw new HttpError(400, 'builtin_upstream')
    const name = typeof input.name === 'string' && input.name.trim() !== '' && input.name.length <= 80 ? input.name.trim() : undefined
    const now = Date.now()
    const key = typeof input.apiKey === 'string' && input.apiKey.trim() !== '' ? sealer.seal(input.apiKey.trim()) : undefined
    if (id === undefined) {
      if (name === undefined) throw new HttpError(400, 'invalid_name')
      const created = newId('up')
      await db.run('INSERT INTO upstreams (id, tenant_id, name, base_url, key_sealed, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
        [created, tenantId, name, baseUrl(input.baseUrl), key ?? null, now])
      id = created
    } else {
      const existing = await db.get('SELECT id FROM upstreams WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      if (existing === undefined) throw new HttpError(404, 'upstream_not_found')
      if (name !== undefined) await db.run('UPDATE upstreams SET name = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4', [name, now, tenantId, id])
      if (input.baseUrl !== undefined) await db.run('UPDATE upstreams SET base_url = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4', [baseUrl(input.baseUrl), now, tenantId, id])
      if (key !== undefined) await db.run('UPDATE upstreams SET key_sealed = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4', [key, now, tenantId, id])
    }
    const saved = (await upstreams()).find(item => item.id === id)
    if (saved === undefined) throw new HttpError(404, 'upstream_not_found')
    return saved
  }

  async function deleteUpstream(id: string): Promise<void> {
    if (id === 'default') throw new HttpError(400, 'builtin_upstream')
    const used = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM catalog_models WHERE tenant_id = $1 AND upstream_id = $2', [tenantId, id])
    if (Number(used?.n ?? 0) > 0) throw new HttpError(409, 'upstream_in_use')
    await db.run('DELETE FROM upstreams WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  }

  // ---------- catalog ----------

  async function models(): Promise<CatalogModel[]> {
    return (await db.all<ModelRow>('SELECT * FROM catalog_models WHERE tenant_id = $1 ORDER BY recommended DESC, id', [tenantId])).map(modelFromRow)
  }

  async function model(id: string): Promise<CatalogModel | undefined> {
    const row = await db.get<ModelRow>('SELECT * FROM catalog_models WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    return row === undefined ? undefined : modelFromRow(row)
  }

  async function saveModel(id: string, input: Record<string, unknown>): Promise<CatalogModel> {
    if (!MODEL_ID.test(id)) throw new HttpError(400, 'invalid_model_id')
    const existing = await model(id)
    const upstreamId = typeof input['upstreamId'] === 'string' ? input['upstreamId'] : existing?.upstreamId
    if (upstreamId === undefined || await upstreamTarget(upstreamId) === undefined) throw new HttpError(400, 'upstream_not_found')
    const upstreamModel = typeof input['upstreamModel'] === 'string' && input['upstreamModel'].trim() !== '' ? input['upstreamModel'].trim() : existing?.upstreamModel ?? id
    const name = typeof input['name'] === 'string' && input['name'].trim() !== '' ? input['name'].trim().slice(0, 80) : existing?.name ?? id
    const prices = (input['prices'] ?? {}) as Record<string, unknown>
    const priceOf = (field: 'input' | 'output' | 'cacheRead'): number | null =>
      field in prices ? toMicros(prices[field], 'price') : existing?.prices[field] === null || existing === undefined ? null : Math.round((existing.prices[field] ?? 0) * MILLION)
    const contextWindow = input['contextWindow'] === undefined ? existing?.contextWindow ?? null
      : input['contextWindow'] === null || input['contextWindow'] === '' ? null : Math.max(0, Math.round(Number(input['contextWindow']) || 0)) || null
    const tags = Array.isArray(input['tags']) ? input['tags'].filter((tag): tag is string => typeof tag === 'string' && tag.length <= 20).slice(0, 8) : existing?.tags ?? []
    const flag = (key: string, fallback: boolean): number => (typeof input[key] === 'boolean' ? (input[key] ? 1 : 0) : fallback ? 1 : 0)
    const now = Date.now()
    const values: Param[] = [name, upstreamId, upstreamModel, priceOf('input'), priceOf('output'), priceOf('cacheRead'), contextWindow, JSON.stringify(tags),
      flag('recommended', existing?.recommended ?? false), flag('enabled', existing?.enabled ?? true), now, tenantId, id]
    if (existing === undefined) {
      await db.run('INSERT INTO catalog_models (name, upstream_id, upstream_model, input_price, output_price, cache_read_price, context_window, tags, recommended, enabled, updated_at, tenant_id, id, created_at) '
        + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $11)', values)
    } else {
      await db.run('UPDATE catalog_models SET name = $1, upstream_id = $2, upstream_model = $3, input_price = $4, output_price = $5, cache_read_price = $6, context_window = $7, '
        + 'tags = $8, recommended = $9, enabled = $10, updated_at = $11 WHERE tenant_id = $12 AND id = $13', values)
    }
    const saved = await model(id)
    if (saved === undefined) throw new HttpError(500, 'model_not_saved')
    return saved
  }

  async function deleteModel(id: string): Promise<void> {
    await db.run('DELETE FROM catalog_models WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  }

  // ---------- requests ----------

  async function record(entry: RequestRecord): Promise<void> {
    await db.run('INSERT INTO gateway_requests (id, tenant_id, user_id, department_id, started_at, day, endpoint, model, served_model, upstream_id, fallback_from, client, stream, '
      + 'status, http_status, error, stop_reason, input_tokens, cache_read_tokens, output_tokens, reasoning_tokens, cost_micros, ttft_ms, duration_ms, device_id) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)', [
      newId('req'), tenantId, entry.userId, entry.departmentId, entry.startedAt, localDay(entry.startedAt, timeZone), entry.endpoint, entry.model,
      entry.servedModel ?? null, entry.upstreamId ?? null, entry.fallbackFrom ?? null, entry.client ?? null, entry.stream ? 1 : 0,
      entry.status, entry.httpStatus, entry.error ?? null, entry.stopReason ?? null,
      entry.tokens.input, entry.tokens.cacheRead, entry.tokens.output, entry.tokens.reasoning, entry.costMicros, entry.ttftMs ?? null, entry.durationMs, entry.deviceId ?? null,
    ])
  }

  function where(filter: UsageFilter): { sql: string; params: Param[] } {
    const params: Param[] = [tenantId, filter.from, filter.to]
    let sql = 'tenant_id = $1 AND day >= $2 AND day <= $3'
    if (filter.userId !== undefined) { params.push(filter.userId); sql += ' AND user_id = $' + String(params.length) }
    if (filter.departmentIds !== undefined) {
      if (filter.departmentIds.length === 0) sql += ' AND 1 = 0'
      else sql += ' AND department_id IN (' + filter.departmentIds.map(id => { params.push(id); return '$' + String(params.length) }).join(', ') + ')'
    }
    if (filter.model !== undefined) { params.push(filter.model); sql += ' AND model = $' + String(params.length) }
    if (filter.client !== undefined) { params.push(filter.client); sql += ' AND client = $' + String(params.length) }
    if (filter.status !== undefined) {
      if (filter.status === 'fallback') sql += ' AND fallback_from IS NOT NULL'
      else { params.push(filter.status); sql += ' AND status = $' + String(params.length) }
    }
    return { sql, params }
  }

  const SUMS = "COUNT(*) AS requests, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, "
    + "SUM(CASE WHEN status = 'refused' THEN 1 ELSE 0 END) AS refused, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read, "
    + 'SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning, SUM(cost_micros) AS cost, '
    + "SUM(CASE WHEN status = 'ok' AND cost_micros IS NULL THEN 1 ELSE 0 END) AS unpriced, COUNT(DISTINCT user_id) AS people, "
    + 'SUM(CASE WHEN fallback_from IS NOT NULL THEN 1 ELSE 0 END) AS fallbacks'

  type Sums = { requests: number; ok: number; errors: number; refused: number; input: number; cacheRead: number; output: number; reasoning: number; tokens: number; costMicros: number; unpriced: number; people: number; fallbacks: number }
  const sums = (row: Record<string, unknown> | undefined): Sums => {
    const n = (key: string): number => Number(row?.[key] ?? 0) || 0
    return {
      requests: n('requests'), ok: n('ok'), errors: n('errors'), refused: n('refused'), input: n('input'), cacheRead: n('cache_read'), output: n('output'),
      reasoning: n('reasoning'), tokens: n('input') + n('cache_read') + n('output'), costMicros: n('cost'), unpriced: n('unpriced'), people: n('people'), fallbacks: n('fallbacks'),
    }
  }

  async function percentile(clause: { sql: string; params: Param[] }, column: string, fraction: number): Promise<number | null> {
    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gateway_requests WHERE ' + clause.sql + ' AND ' + column + ' IS NOT NULL', clause.params)
    const total = Number(count?.n ?? 0)
    if (total === 0) return null
    const row = await db.get<{ v: number }>('SELECT ' + column + ' AS v FROM gateway_requests WHERE ' + clause.sql + ' AND ' + column + ' IS NOT NULL ORDER BY ' + column
      + ' LIMIT 1 OFFSET ' + String(Math.min(total - 1, Math.floor(total * fraction))), clause.params)
    return row === undefined ? null : Number(row.v)
  }

  async function summary(filter: UsageFilter) {
    const clause = where(filter)
    const group = async (column: string) => (await db.all<Record<string, unknown>>('SELECT ' + column + ' AS k, ' + SUMS + ' FROM gateway_requests WHERE ' + clause.sql
      + ' GROUP BY ' + column, clause.params)).map(row => ({ key: row['k'] === null || row['k'] === undefined ? null : String(row['k']), ...sums(row) }))
      .sort((a, b) => b.costMicros - a.costMicros || b.tokens - a.tokens || b.requests - a.requests)
    const totals = sums(await db.get<Record<string, unknown>>('SELECT ' + SUMS + ' FROM gateway_requests WHERE ' + clause.sql, clause.params))
    const speed = await db.get<{ out: number; ms: number }>("SELECT SUM(output_tokens) AS out, SUM(duration_ms - ttft_ms) AS ms FROM gateway_requests WHERE " + clause.sql
      + " AND status = 'ok' AND stream = 1 AND ttft_ms IS NOT NULL AND duration_ms - ttft_ms >= 1000", clause.params)
    return {
      from: filter.from,
      to: filter.to,
      totals: {
        ...totals,
        ttftP50: await percentile(clause, 'ttft_ms', 0.5),
        ttftP95: await percentile(clause, 'ttft_ms', 0.95),
        outputSpeed: Number(speed?.ms ?? 0) > 0 ? Math.round(Number(speed?.out ?? 0) / (Number(speed?.ms) / 1000)) : null,
      },
      series: (await group('day')).sort((a, b) => String(a.key).localeCompare(String(b.key))),
      byUser: await group('user_id'),
      byDepartment: await group('department_id'),
      byModel: await group('model'),
      byClient: await group('client'),
      byStatus: await group('error'),
    }
  }

  async function requests(filter: UsageFilter, limit: number, before?: number) {
    const clause = where(filter)
    if (before !== undefined) { clause.params.push(before); clause.sql += ' AND started_at < $' + String(clause.params.length) }
    return db.all<Record<string, unknown>>('SELECT id, user_id, department_id, started_at, endpoint, model, served_model, upstream_id, fallback_from, client, stream, status, http_status, '
      + 'error, stop_reason, input_tokens, cache_read_tokens, output_tokens, reasoning_tokens, cost_micros, ttft_ms, duration_ms FROM gateway_requests WHERE '
      + clause.sql + ' ORDER BY started_at DESC LIMIT ' + String(Math.max(1, Math.min(limit, 100_000))), clause.params)
  }

  // ---------- departments ----------

  async function departmentTree(): Promise<Map<string, string | null>> {
    return new Map((await db.all<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM departments WHERE tenant_id = $1', [tenantId])).map(row => [row.id, row.parent_id]))
  }

  /** A department and everything under it. */
  async function subtree(departmentId: string): Promise<string[]> {
    const tree = await departmentTree()
    const out = [departmentId]
    for (let index = 0; index < out.length; index += 1) for (const [id, parent] of tree) if (parent === out[index] && !out.includes(id)) out.push(id)
    return out
  }

  async function ancestors(departmentId: string | null): Promise<string[]> {
    if (departmentId === null) return []
    const tree = await departmentTree()
    const out: string[] = []
    for (let id: string | null | undefined = departmentId; id !== null && id !== undefined && !out.includes(id); id = tree.get(id)) out.push(id)
    return out
  }

  // ---------- quotas ----------

  async function quotas(): Promise<Quota[]> {
    return (await db.all<QuotaRow>('SELECT * FROM quotas WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).map(quotaFromRow)
  }

  async function saveQuota(id: string | undefined, input: Record<string, unknown>): Promise<Quota> {
    const existing = id === undefined ? undefined : (await quotas()).find(quota => quota.id === id)
    if (id !== undefined && existing === undefined) throw new HttpError(404, 'quota_not_found')
    const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T | undefined, field: string): T => {
      const chosen = value === undefined ? fallback : value
      if (!(list as readonly unknown[]).includes(chosen)) throw new HttpError(400, 'invalid_' + field)
      return chosen as T
    }
    const scopeType = pick(SCOPES, input['scopeType'], existing?.scopeType, 'scope')
    const scopeId = scopeType === 'tenant' || scopeType === 'member_default' ? null
      : typeof input['scopeId'] === 'string' && input['scopeId'] !== '' ? input['scopeId'] : existing?.scopeId ?? null
    if ((scopeType === 'department' || scopeType === 'user') && scopeId === null) throw new HttpError(400, 'invalid_scope_id')
    if (scopeType === 'department' && await db.get('SELECT id FROM departments WHERE tenant_id = $1 AND id = $2', [tenantId, scopeId]) === undefined) throw new HttpError(400, 'invalid_scope_id')
    if (scopeType === 'user' && await db.get('SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [tenantId, scopeId]) === undefined) throw new HttpError(400, 'invalid_scope_id')
    const period = pick(PERIODS, input['period'], existing?.period, 'period')
    const metric = pick(METRICS, input['metric'], existing?.metric, 'metric')
    const action = pick(QUOTA_ACTIONS, input['action'], existing?.action ?? 'block', 'action')
    let amount = existing?.amount
    if (input['amount'] !== undefined) {
      const n = Number(input['amount'])
      if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'invalid_amount')
      amount = metric === 'cost' ? Math.round(n * MILLION) : Math.round(n)
    }
    if (amount === undefined) throw new HttpError(400, 'invalid_amount')
    const fallbackModel = action === 'fallback' ? (typeof input['fallbackModel'] === 'string' ? input['fallbackModel'] : existing?.fallbackModel ?? null) : null
    if (action === 'fallback' && (fallbackModel === null || await model(fallbackModel) === undefined)) throw new HttpError(400, 'invalid_fallback_model')
    const now = Date.now()
    if (existing === undefined) {
      id = newId('quota')
      await db.run('INSERT INTO quotas (id, tenant_id, scope_type, scope_id, period, metric, amount, action, fallback_model, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)',
        [id, tenantId, scopeType, scopeId, period, metric, amount, action, fallbackModel, now])
    } else {
      await db.run('UPDATE quotas SET scope_type = $1, scope_id = $2, period = $3, metric = $4, amount = $5, action = $6, fallback_model = $7, updated_at = $8 WHERE tenant_id = $9 AND id = $10',
        [scopeType, scopeId, period, metric, amount, action, fallbackModel, now, tenantId, id as string])
    }
    const saved = (await quotas()).find(quota => quota.id === id)
    if (saved === undefined) throw new HttpError(500, 'quota_not_saved')
    return saved
  }

  async function deleteQuota(id: string): Promise<void> {
    await db.run('DELETE FROM quotas WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  }

  /** The limits that cover one person: the organisation's, their departments', and their own or the member default. */
  async function quotasFor(person: { id: string; department_id: string | null }): Promise<Quota[]> {
    const all = await quotas()
    const departments = await ancestors(person.department_id)
    const own = all.filter(quota => quota.scopeType === 'user' && quota.scopeId === person.id)
    return all.filter(quota => quota.scopeType === 'tenant'
      || (quota.scopeType === 'department' && quota.scopeId !== null && departments.includes(quota.scopeId))
      || (quota.scopeType === 'user' && quota.scopeId === person.id)
      || (quota.scopeType === 'member_default' && !own.some(mine => mine.period === quota.period && mine.metric === quota.metric)))
  }

  /** What a limit has used in its current window, for one person when the limit is per person. */
  async function usedBy(quota: Quota, personId: string | undefined, now: number): Promise<{ used: number; reset: number | null }> {
    const window = periodWindow(quota.period, now, timeZone)
    const params: Param[] = [tenantId, window.start]
    let scope = ''
    if (quota.scopeType === 'department' && quota.scopeId !== null) {
      scope = ' AND department_id IN (' + (await subtree(quota.scopeId)).map(id => { params.push(id); return '$' + String(params.length) }).join(', ') + ')'
    } else if (quota.scopeType === 'user' || quota.scopeType === 'member_default') {
      params.push(personId ?? quota.scopeId ?? '')
      scope = ' AND user_id = $' + String(params.length)
    }
    const row = await db.get<{ used: number; oldest: number }>('SELECT ' + metricSql(quota.metric) + ' AS used, MIN(started_at) AS oldest FROM gateway_requests WHERE tenant_id = $1 AND started_at >= $2'
      + scope + " AND status <> 'refused'", params)
    const used = Number(row?.used ?? 0) || 0
    const reset = window.rolling ? (row?.oldest !== null && row?.oldest !== undefined ? Number(row.oldest) + (window.length ?? 0) : null) : window.reset ?? null
    return { used, reset }
  }

  /** Every limit that covers a person, with what is used and when it resets. */
  async function statusFor(person: { id: string; department_id: string | null }, now = Date.now()) {
    const out = []
    for (const quota of await quotasFor(person)) {
      const { used, reset } = await usedBy(quota, person.id, now)
      out.push({ quota, used, reset, spent: used >= quota.amount })
    }
    return out
  }

  /**
   * Whether a request may go ahead. A spent blocking limit refuses it; a
   * spent fallback limit sends it to its fallback model instead.
   */
  async function check(person: { id: string; department_id: string | null }, now = Date.now()) {
    const status = await statusFor(person, now)
    const blocking = status.filter(item => item.spent && item.quota.action === 'block').sort((a, b) => (b.reset ?? Infinity) - (a.reset ?? Infinity))[0]
    if (blocking !== undefined) return { kind: 'blocked' as const, ...blocking }
    const fallback = status.find(item => item.spent && item.quota.action === 'fallback' && item.quota.fallbackModel !== null)
    if (fallback !== undefined) return { kind: 'fallback' as const, model: fallback.quota.fallbackModel as string, ...fallback }
    return { kind: 'ok' as const }
  }

  /** Each limit with how much of it is used; per-person limits list the people at 80% or more. */
  async function overview(now = Date.now()) {
    const out = []
    for (const quota of await quotas()) {
      if (quota.scopeType !== 'member_default') {
        const { used, reset } = await usedBy(quota, undefined, now)
        out.push({ quota, used, reset, people: [] as Array<{ userId: string; used: number }> })
        continue
      }
      const window = periodWindow(quota.period, now, timeZone)
      const rows = await db.all<{ user_id: string; used: number }>('SELECT user_id, ' + metricSql(quota.metric) + " AS used FROM gateway_requests WHERE tenant_id = $1 AND started_at >= $2 AND status <> 'refused' GROUP BY user_id",
        [tenantId, window.start])
      const overridden = new Set((await quotas()).filter(item => item.scopeType === 'user' && item.period === quota.period && item.metric === quota.metric).map(item => item.scopeId))
      const people = rows.map(row => ({ userId: row.user_id, used: Number(row.used) || 0 }))
        .filter(row => !overridden.has(row.userId) && row.used >= quota.amount * 0.8).sort((a, b) => b.used - a.used)
      out.push({ quota, used: null, reset: window.rolling ? null : window.reset ?? null, people })
    }
    return out
  }

  return {
    timeZone, upstreams, upstreamTarget, saveUpstream, deleteUpstream, models, model, saveModel, deleteModel,
    record, summary, requests, subtree, quotas, saveQuota, deleteQuota, quotasFor, statusFor, check, overview,
  }
}

export type Metering = ReturnType<typeof createMetering>
