/**
 * The built-in model gateway (DSH_GATEWAY=direct), end to end: the real
 * management server on SQLite, a fake OpenAI-compatible upstream, and the
 * desktop client's real ServerSession for sign-in.
 *
 * Covers: personal keys delivered in the document and stored only as hashes,
 * the upstream key never leaving the server, model allow-lists read from the
 * person's profiles at request time, streamed and plain responses passed
 * through, usage counted per person, and keys refused once a person is
 * disabled.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEnrollment } from '@dsh-desktop-pro/protocol'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'
import { costOf, periodWindow, tokensFrom } from '../apps/server/src/metering.ts'
import { PLAIN_CODEC, ServerSession } from '../src/main/enterprise/server-session.ts'

// Calendar windows follow the organisation's time zone: 2026-11-15 10:00 in Shanghai is a Sunday.
{
  const now = Date.UTC(2026, 10, 15, 2, 0)
  assert.deepEqual(periodWindow('day', now, 'Asia/Shanghai'), { start: Date.UTC(2026, 10, 14, 16), reset: Date.UTC(2026, 10, 15, 16), rolling: false })
  assert.equal(periodWindow('week', now, 'Asia/Shanghai').start, Date.UTC(2026, 10, 8, 16), 'weeks start on Monday')
  assert.deepEqual([periodWindow('month', now, 'Asia/Shanghai').start, periodWindow('month', now, 'Asia/Shanghai').reset], [Date.UTC(2026, 9, 31, 16), Date.UTC(2026, 10, 30, 16)])
  assert.equal(periodWindow('5h', now, 'UTC').start, now - 5 * 3_600_000)
  assert.deepEqual(tokensFrom({ prompt_tokens: 100, prompt_cache_hit_tokens: 30, completion_tokens: 10 }), { input: 70, cacheRead: 30, output: 10, reasoning: 0 })
  assert.deepEqual(tokensFrom({ input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } }), { input: 30, cacheRead: 20, output: 5, reasoning: 3 })
  assert.equal(costOf({ input: 1, cacheRead: 0, output: 1, reasoning: 0 }, { input: null, output: null, cacheRead: null }), null, 'a model without a price has no cost, not zero')
  console.log('✓ calendar windows follow the time zone; Chat, Responses and DeepSeek token counts are read')
}

const work = mkdtempSync(join(tmpdir(), 'dsh-gateway-check-'))
const seen = []
const upstream = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const json = JSON.parse(body || '{}')
    seen.push({ path: req.url, authorization: req.headers.authorization, body: json })
    if (json.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'he' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'llo' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
// A second model service, added in the console's model catalog.
const vendorSeen = []
const vendor = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'vendor-model' }, { id: 'vendor-mini' }] })); return }
    const json = JSON.parse(body || '{}')
    vendorSeen.push({ authorization: req.headers.authorization, model: json.model })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model + '-v2', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens: 200 } }))
  })
})
await new Promise(resolve => vendor.listen(0, '127.0.0.1', resolve))
const vendorUrl = 'http://127.0.0.1:' + String(vendor.address().port) + '/v1'

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'x'.repeat(40), PORT: '0', HOST: '127.0.0.1',
  DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_DEV_LOGIN: '1', DSH_BOOTSTRAP_TOKEN: 'bootstrap-secret',
  DSH_GATEWAY: 'direct', DSH_UPSTREAM_URL: 'http://127.0.0.1:' + String(upstream.address().port) + '/v1', DSH_UPSTREAM_KEY: 'sk-real-upstream',
})
// DSH_CHECK_DATABASE_URL=postgres://… runs the same checks against PostgreSQL (an empty database).
const app = await createApp({ config, db: await openDb(process.env.DSH_CHECK_DATABASE_URL ?? 'sqlite:' + join(work, 'server.sqlite')) })
const base = await app.listen()
config.publicUrl = base

let cookie = ''
async function admin(method, path, body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...body !== undefined && { 'content-type': 'application/json' } }, ...body !== undefined && { body: JSON.stringify(body) } })
  return { status: response.status, body: await response.json() }
}
function browserFor(email) {
  return async (url) => {
    const page = await fetch(url, { redirect: 'manual' })
    const flow = /name="flow" value="([^"]+)"/.exec(await page.text())?.[1]
    const submitted = await fetch(base + '/v1/auth/dev', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ flow, email }) })
    await fetch(submitted.headers.get('location'))
  }
}
const llm = (key, path, body) => fetch(base + '/llm/v1/' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  ...body !== undefined && { body: JSON.stringify(body) },
})

try {
  const login = await fetch(base + '/admin/api/session', { method: 'POST', body: JSON.stringify({ token: 'bootstrap-secret' }) })
  cookie = login.headers.get('set-cookie').split(';')[0]
  const me = (await admin('GET', '/admin/api/me')).body
  assert.equal(me.gateway, 'direct')
  assert.equal(me.gatewayUrl, base + '/llm/v1', 'the console shows the address profiles route to')
  await admin('POST', '/admin/api/users', { name: 'Alice', email: 'alice@acme.example' })
  const profile = (await admin('POST', '/admin/api/profiles', { name: 'Company', spec: {
    models: { providers: { company: { api: 'openai-completions', baseURL: me.gatewayUrl, credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'deepseek-chat' }] } }, default: { provider: 'company', model: 'deepseek-chat' } },
  } })).body
  await admin('POST', '/admin/api/bindings', { profileId: profile.id, targetType: 'tenant' })

  const enrollment = validateEnrollment((await admin('GET', '/admin/api/enrollment')).body).value
  const session = new ServerSession({ enrollment, home: join(work, 'alice'), secrets: PLAIN_CODEC, openBrowser: browserFor('alice@acme.example'), clientVersion: '1.0.0', signInTimeoutMs: 3000 })
  await session.signIn()
  const state = await session.fetchDesiredState()
  const key = state.credentials.DSH_ORG_GATEWAY_KEY
  assert.match(key, /^sk-dsh-/, 'a personal key of the built-in gateway is delivered')
  assert.equal(JSON.stringify(state).includes('sk-real-upstream'), false, 'the upstream key never reaches the client')
  const stored = await app.store.db.all('SELECT key_hash FROM proxy_keys')
  assert.equal(stored.length, 1)
  assert.notEqual(stored[0].key_hash, key, 'personal keys are stored only as hashes')
  console.log('✓ the document carries a personal gateway key; the upstream key stays on the server')

  assert.deepEqual((await (await llm(key, 'models')).json()).data.map(model => model.id), ['deepseek-chat'])
  const plain = await llm(key, 'chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(plain.status, 200)
  assert.equal((await plain.json()).choices[0].message.content, 'hello')
  assert.equal(seen.at(-1).authorization, 'Bearer sk-real-upstream', 'the upstream sees the organisation key')
  assert.equal(seen.at(-1).path, '/v1/chat/completions')
  const streamed = await llm(key, 'chat/completions', { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.match(streamed.headers.get('content-type'), /event-stream/)
  const text = await streamed.text()
  assert.match(text, /"he"[\s\S]*"llo"[\s\S]*\[DONE\]/, 'a stream passes through in order')
  assert.deepEqual(seen.at(-1).body.stream_options, { include_usage: true }, 'streamed chat asks for usage')
  console.log('✓ plain and streamed chat completions pass through to the upstream')

  const refused = await llm(key, 'chat/completions', { model: 'gpt-secret', messages: [] })
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).error.type, 'model_not_allowed')
  assert.equal((await llm('sk-dsh-forged', 'chat/completions', { model: 'deepseek-chat' })).status, 401)
  // A profile change applies to the next request, without reissuing keys.
  await admin('PUT', '/admin/api/profiles/' + profile.id, { spec: { models: { providers: { company: { api: 'openai-completions', baseURL: me.gatewayUrl, credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] } } } } })
  assert.equal((await llm(key, 'chat/completions', { model: 'deepseek-reasoner', messages: [] })).status, 200)
  console.log('✓ only models the person\'s profiles route here are allowed, read at request time')

  const usage = (await admin('GET', '/admin/api/usage')).body.rows
  assert.equal(usage.length, 1)
  assert.deepEqual([usage[0].requests, usage[0].prompt_tokens, usage[0].completion_tokens], [3, 17, 4])
  console.log('✓ requests and tokens are counted per person and day')

  // ---- model catalog: a second upstream, names people use, prices ----
  const added = (await admin('POST', '/admin/api/catalog/upstreams', { name: 'Vendor', baseUrl: vendorUrl, apiKey: 'sk-vendor' })).body
  assert.equal(added.hasKey, true)
  assert.equal(JSON.stringify((await admin('GET', '/admin/api/catalog')).body).includes('sk-vendor'), false, 'an upstream key is never sent back')
  assert.deepEqual((await admin('POST', '/admin/api/catalog/upstreams/' + added.id + '/test')).body.models, ['vendor-model', 'vendor-mini'])
  await admin('PUT', '/admin/api/catalog/models/company-chat', { name: 'Company chat', upstreamId: added.id, upstreamModel: 'vendor-model', prices: { input: 2, output: 8, cacheRead: 0.5 } })
  await admin('PUT', '/admin/api/catalog/models/cheap', { name: 'Cheap', upstreamId: added.id, upstreamModel: 'vendor-mini', prices: { input: 1, output: 2 } })
  await admin('PUT', '/admin/api/profiles/' + profile.id, { spec: { models: { providers: { company: { api: 'openai-completions', baseURL: me.gatewayUrl, credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'company-chat' }] } } } } })
  const routed = await llm(key, 'chat/completions', { model: 'company-chat', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(routed.status, 200)
  assert.deepEqual(vendorSeen.at(-1), { authorization: 'Bearer sk-vendor', model: 'vendor-model' }, 'the catalog sends the request to its upstream, under the name that upstream knows')
  console.log('✓ the model catalog routes a model to its own upstream and key')

  const summary = (await admin('GET', '/admin/api/usage/summary')).body
  const byModel = summary.byModel.find(row => row.key === 'company-chat')
  // 600 uncached × 2 + 400 cached × 0.5 + 200 out × 8 yuan per million = 3000 micro-yuan
  assert.deepEqual([byModel.requests, byModel.input, byModel.cacheRead, byModel.output, byModel.costMicros], [1, 600, 400, 200, 3000])
  assert.ok(summary.totals.unpriced >= 3, 'calls to models without a price are counted apart, not as free')
  assert.ok(summary.totals.refused >= 1, 'refused calls are recorded too')
  assert.equal(summary.byUser.length, 1)
  const latest = (await admin('GET', '/admin/api/usage/requests?limit=1')).body[0]
  assert.deepEqual([latest.model, latest.served_model, latest.status, latest.stop_reason], ['company-chat', 'vendor-model-v2', 'ok', 'stop'])
  const csv = await (await fetch(base + '/admin/api/usage/export', { headers: { cookie } })).text()
  assert.match(csv, /^\ufeff?time,member,email,department,model/)
  assert.match(csv, /Alice,alice@acme\.example,,company-chat,vendor-model-v2/)
  console.log('✓ each request is recorded with tokens, cache, cost and how it ended; usage exports as CSV')

  // ---- limits ----
  const person = (await admin('GET', '/admin/api/users')).body.find(user => user.email === 'alice@acme.example')
  const daily = (await admin('POST', '/admin/api/quotas', { scopeType: 'member_default', period: 'day', metric: 'tokens', amount: 1000, action: 'fallback', fallbackModel: 'cheap' })).body
  const fell = await llm(key, 'chat/completions', { model: 'company-chat', messages: [] })
  assert.equal(fell.status, 200)
  assert.equal(fell.headers.get('x-dsh-fallback-model'), 'cheap')
  assert.equal(vendorSeen.at(-1).model, 'vendor-mini', 'a spent fallback limit sends the request to the cheaper model')
  assert.equal((await admin('GET', '/admin/api/usage/requests?limit=1')).body[0].fallback_from, 'company-chat')
  const own = (await admin('POST', '/admin/api/quotas', { scopeType: 'user', scopeId: person.id, period: 'day', metric: 'cost', amount: 0.001, action: 'block' })).body
  const blocked = await llm(key, 'chat/completions', { model: 'company-chat', messages: [] })
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).error.type, 'quota_exceeded')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'a refused call says when to try again')
  const status = (await admin('GET', '/admin/api/users/' + person.id + '/quotas')).body
  assert.deepEqual(status.map(item => [item.quota.metric, item.spent]).sort(), [['cost', true], ['tokens', true]])
  const overview = (await admin('GET', '/admin/api/quotas')).body
  assert.equal(overview.find(item => item.quota.id === daily.id).people[0].userId, person.id, 'the limits page lists people who used 80% or more')
  await admin('DELETE', '/admin/api/quotas/' + own.id)
  await admin('DELETE', '/admin/api/quotas/' + daily.id)
  assert.equal((await llm(key, 'chat/completions', { model: 'company-chat', messages: [] })).status, 200, 'lifting the limits lets requests through again')
  console.log('✓ limits per person: a spent one refuses with Retry-After, or falls back to a cheaper model')

  // A department budget counts everyone in it, sub-departments included.
  const sales = (await admin('POST', '/admin/api/departments', { name: 'Sales' })).body
  const east = (await admin('POST', '/admin/api/departments', { name: 'East', parentId: sales.id })).body
  await admin('PATCH', '/admin/api/users/' + person.id, { departmentId: east.id })
  await llm(key, 'chat/completions', { model: 'company-chat', messages: [] })
  const budget = (await admin('POST', '/admin/api/quotas', { scopeType: 'department', scopeId: sales.id, period: 'minute', metric: 'requests', amount: 1, action: 'block' })).body
  assert.equal((await llm(key, 'chat/completions', { model: 'company-chat', messages: [] })).status, 429, 'a sub-department\'s requests count toward the parent\'s budget')
  await admin('DELETE', '/admin/api/quotas/' + budget.id)
  console.log('✓ department limits include sub-departments')

  const alice = (await admin('GET', '/admin/api/users')).body.find(user => user.email === 'alice@acme.example')
  await admin('PATCH', '/admin/api/users/' + alice.id, { status: 'disabled' })
  assert.equal((await llm(key, 'chat/completions', { model: 'deepseek-chat', messages: [] })).status, 401, 'a disabled person\'s key stops working at once')
  assert.equal((await app.store.db.all('SELECT key_hash FROM proxy_keys')).length, 0, 'and is deleted')
  console.log('✓ disabling a person revokes their gateway key immediately')
} finally {
  await app.close()
  upstream.close()
  vendor.close()
  rmSync(work, { recursive: true, force: true })
}
