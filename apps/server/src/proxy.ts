/**
 * The built-in model gateway (`DSH_GATEWAY=direct`): an OpenAI-compatible
 * endpoint at `<public URL>/llm/v1`. For each request it
 *
 * 1. checks the key of the person's device — a revoked device or a disabled
 *    person is refused at once;
 * 2. allows only the models their profiles route through the gateway;
 * 3. checks the limits that cover them — a spent limit refuses the request,
 *    or sends it to a cheaper model when the limit says so;
 * 4. looks the model up in the catalog to find its upstream and the name that
 *    upstream knows it by (a model not in the catalog goes to the
 *    `DSH_UPSTREAM_URL` upstream unchanged);
 * 5. forwards it with the organisation's key and passes the reply through,
 *    streamed or not;
 * 6. records the request: tokens, cost, time to first token, how it ended.
 *
 * Limits are only as good as the record they are checked against, so the
 * gateway stops forwarding while requests cannot be recorded. Each person may
 * run a bounded number of requests at once, and a slow reader slows the
 * upstream read instead of filling this process's memory.
 * @module @dsh-desktop-pro/server/proxy
 */

import { Readable } from 'node:stream'
import type { ServerResponse } from 'node:http'
import { mergeProfiles } from '@dsh-desktop-pro/protocol'
import type { ServerConfig } from './config.ts'
import { sha256 } from './crypto.ts'
import { bearer, readText, type Context, type Router } from './http.ts'
import { costOf, localDay, tokensFrom, type Metering, type RequestRecord } from './metering.ts'
import type { Store, User } from './store.ts'

export const PROXY_PREFIX = '/llm/v1'

/** Model API paths forwarded upstream; each needs a permitted `model`. */
const FORWARDED = ['chat/completions', 'completions', 'responses', 'embeddings']

const NO_TOKENS = { input: 0, cacheRead: 0, output: 0, reasoning: 0 }

function openAiError(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify({ error: { message, type, code: type } }))
}

/** A short name for what sent the request: the first product in its User-Agent. */
function clientName(userAgent: string | undefined): string | null {
  const first = (userAgent ?? '').trim().split(/\s+/)[0] ?? ''
  return first === '' ? null : first.slice(0, 60)
}

const PERIOD_TEXT: Record<string, string> = { minute: 'per minute', '5h': 'per 5 hours', day: 'per day', week: 'per week', month: 'per month' }

export function installProxy(router: Router, store: Store, config: ServerConfig, fetchImpl: typeof fetch, metering: Metering): void {
  const gateway = config.gateway
  if (gateway.kind !== 'direct') return

  /** The person behind a device key; nobody when the key, the device or the person is no longer good. */
  async function caller(ctx: Context): Promise<{ person: User; deviceId: string } | undefined> {
    const key = bearer(ctx.req) ?? String(ctx.req.headers['x-api-key'] ?? '')
    if (!key.startsWith('sk-dsh-')) return undefined
    const row = await store.db.get<{ user_id: string; device_id: string | null; device_status: string | null }>(
      'SELECT k.user_id AS user_id, k.device_id AS device_id, d.status AS device_status FROM proxy_keys k LEFT JOIN devices d ON d.id = k.device_id AND d.tenant_id = k.tenant_id WHERE k.key_hash = $1 AND k.tenant_id = $2',
      [sha256(key), store.tenantId])
    if (row === undefined || row.device_id === null || row.device_status !== 'active') return undefined
    const found = await store.user(row.user_id)
    return found?.status === 'active' ? { person: found, deviceId: row.device_id } : undefined
  }

  /** Requests each person has in flight. */
  const inFlight = new Map<string, number>()
  /** Requests in a row whose record could not be written. */
  let unrecorded = 0
  const UNRECORDED_LIMIT = 3
  const recorded = async (entry: RequestRecord): Promise<boolean> => {
    try {
      await metering.record(entry)
      unrecorded = 0
      return true
    } catch (error) {
      unrecorded += 1
      console.error('[gateway] could not record a request (' + String(unrecorded) + ' in a row)', error)
      return false
    }
  }

  /** Models the person's profiles route through this gateway, read at request time. */
  async function allowedModels(found: User): Promise<string[]> {
    const merged = mergeProfiles((await store.profilesFor(found)).map(layer => layer.spec))
    const routes = Object.values(merged.models?.providers ?? {}).filter(route => route.credential === gateway.credential)
    return [...new Set(routes.flatMap(route => route.models.map(model => model.id)))]
  }

  /** The old per-day totals, kept for deployments that read them. */
  async function countDaily(userId: string, prompt: number, completion: number): Promise<void> {
    const key = [store.tenantId, userId, localDay(Date.now(), metering.timeZone)]
    const updated = await store.db.run('UPDATE gateway_usage SET requests = requests + 1, prompt_tokens = prompt_tokens + $4, completion_tokens = completion_tokens + $5 WHERE tenant_id = $1 AND user_id = $2 AND day = $3', [...key, prompt, completion])
    if (updated === 0) {
      await store.db.run('INSERT INTO gateway_usage (tenant_id, user_id, day, requests, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, 1, $4, $5)', [...key, prompt, completion])
        .catch(() => store.db.run('UPDATE gateway_usage SET requests = requests + 1 WHERE tenant_id = $1 AND user_id = $2 AND day = $3', key))
    }
  }

  router.get(PROXY_PREFIX + '/models', async (ctx) => {
    const found = (await caller(ctx))?.person
    if (found === undefined) { openAiError(ctx.res, 401, 'invalid_api_key', 'Invalid or revoked DSH gateway key'); return }
    const catalog = new Map((await metering.models()).map(model => [model.id, model]))
    const models = (await allowedModels(found)).filter(id => catalog.get(id)?.enabled !== false)
    ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    ctx.res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'organization', ...catalog.get(id) !== undefined && { name: catalog.get(id)?.name } })) }))
  })

  for (const path of FORWARDED) {
    router.post(PROXY_PREFIX + '/' + path, async (ctx) => {
      const startedAt = Date.now()
      const from = await caller(ctx)
      if (from === undefined) { openAiError(ctx.res, 401, 'invalid_api_key', 'Invalid or revoked DSH gateway key'); return }
      const found = from.person
      const running = inFlight.get(found.id) ?? 0
      if (running >= gateway.maxConcurrent) {
        openAiError(ctx.res, 429, 'too_many_requests', 'You already have ' + String(running) + ' requests running through the organisation gateway; wait for one to finish', { 'retry-after': '5' })
        return
      }
      inFlight.set(found.id, running + 1)
      try {
        await forward(ctx, path, found, from.deviceId, startedAt)
      } finally {
        const left = (inFlight.get(found.id) ?? 1) - 1
        if (left <= 0) inFlight.delete(found.id)
        else inFlight.set(found.id, left)
      }
    })
  }

  async function forward(ctx: Context, path: string, found: User, deviceId: string, startedAt: number): Promise<void> {
    {
      const text = await readText(ctx.req, 32_000_000)
      let body: { model?: unknown; stream?: unknown; stream_options?: unknown }
      try { body = JSON.parse(text) as typeof body } catch { openAiError(ctx.res, 400, 'invalid_request_error', 'Request body is not JSON'); return }
      const asked = typeof body.model === 'string' ? body.model : ''
      const stream = body.stream === true
      const base: Omit<RequestRecord, 'status' | 'httpStatus' | 'durationMs' | 'tokens' | 'costMicros'> = {
        userId: found.id, deviceId, departmentId: found.department_id, startedAt, endpoint: path, model: asked, client: clientName(ctx.req.headers['user-agent']), stream,
      }
      const refuse = async (status: number, type: string, message: string, headers: Record<string, string> = {}): Promise<void> => {
        await recorded({ ...base, status: 'refused', httpStatus: status, error: type, tokens: NO_TOKENS, costMicros: null, durationMs: Date.now() - startedAt })
        openAiError(ctx.res, status, type, message, headers)
      }
      // Usage that cannot be written cannot be limited: stop forwarding until a
      // record goes through again. Writing this refusal is that probe.
      if (unrecorded >= UNRECORDED_LIMIT) {
        await refuse(503, 'metering_unavailable', 'The organisation gateway cannot record usage right now, so it is not forwarding requests. Try again shortly.', { 'retry-after': '30' })
        return
      }

      const allowed = await allowedModels(found)
      if (!allowed.includes(asked)) {
        await refuse(403, 'model_not_allowed', 'Model "' + asked + '" is not enabled for you by your organisation' + (allowed.length > 0 ? '; available: ' + allowed.join(', ') : ''))
        return
      }
      let entry = await metering.model(asked)
      if (entry !== undefined && !entry.enabled) { await refuse(403, 'model_disabled', 'Model "' + asked + '" is turned off by your organisation'); return }

      // Limits: a spent blocking limit refuses; a spent fallback limit changes the model.
      let model = asked
      let fallbackFrom: string | null = null
      const verdict = await metering.check(found)
      if (verdict.kind === 'blocked') {
        const quota = verdict.quota
        const what = quota.metric === 'cost' ? (quota.amount / 1_000_000).toFixed(2) + ' yuan' : String(quota.amount) + (quota.metric === 'tokens' ? ' tokens' : ' requests')
        const reset = verdict.reset === null ? '' : '; it resets at ' + new Date(verdict.reset).toISOString()
        const retry = verdict.reset === null ? 300 : Math.max(1, Math.ceil((verdict.reset - Date.now()) / 1000))
        await refuse(429, 'quota_exceeded', 'Your organisation\'s limit of ' + what + ' ' + (PERIOD_TEXT[quota.period] ?? quota.period) + ' is used up' + reset, { 'retry-after': String(retry) })
        return
      }
      if (verdict.kind === 'fallback' && verdict.model !== asked) {
        const replacement = await metering.model(verdict.model)
        if (replacement !== undefined && replacement.enabled) { fallbackFrom = asked; model = verdict.model; entry = replacement }
      }

      const upstreamId = entry?.upstreamId ?? 'default'
      const target = await metering.upstreamTarget(upstreamId)
      if (target === undefined) {
        await refuse(502, 'no_upstream', 'No model service is configured for "' + model + '". Ask your organisation to add it to the model catalog.')
        return
      }
      // Ask streamed chat for a final usage chunk, so tokens can be counted.
      const outgoing: Record<string, unknown> = { ...body, model: entry?.upstreamModel ?? model }
      if (path === 'chat/completions' && stream && body.stream_options === undefined) outgoing['stream_options'] = { include_usage: true }
      const forwarded = entry === undefined && fallbackFrom === null && outgoing['stream_options'] === undefined ? text : JSON.stringify(outgoing)
      const record = { ...base, model, fallbackFrom, upstreamId }

      const abort = new AbortController()
      ctx.res.on('close', () => { if (!ctx.res.writableFinished) abort.abort() })
      let upstream: Response
      try {
        upstream = await fetchImpl(target.url + '/' + path, {
          method: 'POST',
          headers: { ...target.key !== undefined && { authorization: 'Bearer ' + target.key }, 'content-type': 'application/json', accept: String(ctx.req.headers.accept ?? '*/*') },
          body: forwarded,
          signal: abort.signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await recorded({ ...record, status: 'error', httpStatus: 502, error: 'upstream_unreachable', tokens: NO_TOKENS, costMicros: null, durationMs: Date.now() - startedAt })
        openAiError(ctx.res, 502, 'upstream_unreachable', 'The organisation model service is unreachable: ' + message)
        return
      }
      const type = upstream.headers.get('content-type') ?? 'application/json'
      ctx.res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store', ...fallbackFrom !== null && { 'x-dsh-fallback-model': model } })
      // Pass bytes through as they arrive; keep the tail to read usage and the end reason.
      let tail = ''
      let ttftMs: number | null = null
      let cut = false
      if (upstream.body !== null) {
        try {
          for await (const chunk of Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)) {
            ttftMs ??= Date.now() - startedAt
            // A reader slower than the upstream holds the upstream back instead of growing our buffer.
            if (!ctx.res.write(chunk)) await new Promise<void>((resolve) => { ctx.res.once('drain', resolve); ctx.res.once('close', resolve) })
            tail = (tail + Buffer.from(chunk as Uint8Array).toString('utf8')).slice(-24_000)
          }
        } catch {
          // The person cancelled or the upstream dropped; nothing more to send.
          cut = true
        }
      }
      const reply = readReply(tail, type)
      const tokens = tokensFrom(reply.usage)
      const ok = upstream.ok && !cut
      await recorded({
        ...record, status: ok ? 'ok' : 'error', httpStatus: upstream.status, error: ok ? null : cut ? 'stream_interrupted' : reply.error ?? 'upstream_' + String(upstream.status),
        servedModel: reply.model ?? null, stopReason: reply.stop ?? null, tokens, costMicros: entry === undefined ? null : costOf(tokens, {
          input: entry.prices.input === null ? null : Math.round(entry.prices.input * 1_000_000),
          output: entry.prices.output === null ? null : Math.round(entry.prices.output * 1_000_000),
          cacheRead: entry.prices.cacheRead === null ? null : Math.round(entry.prices.cacheRead * 1_000_000),
        }),
        ttftMs: stream ? ttftMs : null, durationMs: Date.now() - startedAt,
      })
      if (ok) await countDaily(found.id, tokens.input + tokens.cacheRead, tokens.output).catch(() => undefined)
      // Ended only after the request is recorded, so the next request already sees it against the limits.
      ctx.res.end()
    }
  }
}

/** Usage, served model, end reason and error type from a JSON body or the last SSE events that carry them. */
function readReply(tail: string, type: string): { usage?: Record<string, unknown>; model?: string; stop?: string; error?: string } {
  const out: { usage?: Record<string, unknown>; model?: string; stop?: string; error?: string } = {}
  const take = (value: unknown): void => {
    const record = value as { usage?: unknown; model?: unknown; choices?: Array<{ finish_reason?: unknown }>; response?: { usage?: unknown; model?: unknown; status?: unknown }; error?: { type?: unknown; code?: unknown } } | null
    if (record === null || typeof record !== 'object') return
    const usage = record.usage ?? record.response?.usage
    if (out.usage === undefined && typeof usage === 'object' && usage !== null) out.usage = usage as Record<string, unknown>
    const model = record.model ?? record.response?.model
    if (out.model === undefined && typeof model === 'string') out.model = model
    const stop = record.choices?.find(choice => typeof choice.finish_reason === 'string')?.finish_reason ?? record.response?.status
    if (out.stop === undefined && typeof stop === 'string') out.stop = stop
    const error = record.error?.type ?? record.error?.code
    if (out.error === undefined && typeof error === 'string') out.error = error
  }
  if (!type.includes('event-stream')) {
    try { take(JSON.parse(tail)) } catch { /* not JSON */ }
    return out
  }
  const events = tail.split('\n').filter(line => line.startsWith('data:') && line.trim() !== 'data: [DONE]').reverse()
  for (const line of events) {
    try { take(JSON.parse(line.slice(5).trim())) } catch { /* a partial line at the start of the tail */ }
  }
  return out
}
