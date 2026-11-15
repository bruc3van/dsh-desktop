/**
 * Server mode end to end, without Electron: the real management server on
 * SQLite, a fake LiteLLM, and the desktop client's real ServerSession. A small
 * fetch-driven "browser" walks the sign-in redirects.
 *
 * Covers: CSV import with department paths, profile merge across department
 * inheritance, per-person gateway keys, PKCE sign-in, device enrollment and
 * proofs, signed documents, token refresh and rotation, status reports,
 * revision bumps and rollback, off-boarding, device revocation, read-only
 * auditors, and the hash-chained audit log.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, validateEnrollment, verifyDocument } from '@dsh-desktop-pro/protocol'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'
import { PLAIN_CODEC, ServerSession, SessionError } from '../src/main/enterprise/server-session.ts'

const work = mkdtempSync(join(tmpdir(), 'dsh-server-check-'))
const litellm = { issued: [], deleted: [] }
const gateway = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    assert.equal(req.headers.authorization, 'Bearer sk-master')
    const json = JSON.parse(body || '{}')
    if (req.url === '/key/generate') {
      const key = 'sk-litellm-' + String(litellm.issued.length + 1)
      litellm.issued.push({ key, ...json })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ key, expires: new Date(Date.now() + 30 * 86_400_000).toISOString() }))
    } else if (req.url === '/key/delete') {
      litellm.deleted.push(...json.keys)
      res.writeHead(200).end('{}')
    } else res.writeHead(404).end()
  })
})
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'x'.repeat(40), PORT: '0', HOST: '127.0.0.1',
  DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_DEV_LOGIN: '1', DSH_BOOTSTRAP_TOKEN: 'bootstrap-secret',
  DSH_GATEWAY: 'litellm', LITELLM_URL: 'http://127.0.0.1:' + String(gateway.address().port), LITELLM_MASTER_KEY: 'sk-master',
  DSH_ACCESS_TOKEN_SECONDS: '1',
})
// DSH_CHECK_DATABASE_URL=postgres://… runs the same flow against PostgreSQL (an empty database).
const app = await createApp({ config, db: await openDb(process.env.DSH_CHECK_DATABASE_URL ?? 'sqlite:' + join(work, 'server.sqlite')) })
const base = await app.listen()
// The port is known only now; the enrollment file names the public URL.
config.publicUrl = base

let consoleCookie = ''
async function admin(method, path, body, cookie = consoleCookie) {
  const response = await fetch(base + path, {
    method, headers: { cookie, ...typeof body === 'string' ? { 'content-type': 'text/csv' } : body !== undefined && { 'content-type': 'application/json' } },
    ...body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) },
  })
  const text = await response.text()
  return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text }
}

/** The person's browser: show the chooser, submit the development login, follow to the loopback. */
function browserFor(email) {
  return async (url) => {
    const page = await fetch(url, { redirect: 'manual' })
    const flow = /name="flow" value="([^"]+)"/.exec(await page.text())?.[1]
    assert.ok(flow, 'the sign-in page offers the development login')
    const submitted = await fetch(base + '/v1/auth/dev', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ flow, email }) })
    if (submitted.status !== 302) return
    await fetch(submitted.headers.get('location'))
  }
}

function client(email, enrollment, dir) {
  return new ServerSession({ enrollment, home: join(work, dir), secrets: PLAIN_CODEC, openBrowser: browserFor(email), clientVersion: '1.0.0', signInTimeoutMs: 3000 })
}

try {
  // ---- administration ----
  assert.equal((await admin('GET', '/admin/api/me', undefined, '')).status, 401)
  const login = await fetch(base + '/admin/api/session', { method: 'POST', body: JSON.stringify({ token: 'bootstrap-secret' }) })
  consoleCookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await admin('GET', '/admin/api/me')).body.organization.name, 'Acme')

  const imported = await admin('POST', '/admin/api/users/import', 'name,email,department,role\nAlice,alice@acme.example,Finance/Payables,member\nBob,bob@acme.example,Sales,member\nAudrey,audit@acme.example,,auditor\nBroken,not-an-email,,member\n')
  assert.deepEqual([imported.body.created, imported.body.updated, imported.body.errors.length], [3, 0, 1])
  const users = (await admin('GET', '/admin/api/users')).body
  const alice = users.find(user => user.email === 'alice@acme.example')
  const departments = (await admin('GET', '/admin/api/departments')).body
  const finance = departments.find(dep => dep.name === 'Finance')
  assert.equal(departments.find(dep => dep.name === 'Payables').parent_id, finance.id, 'department paths become a tree')

  const company = (await admin('POST', '/admin/api/profiles', { name: 'Company', spec: {
    models: { providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://llm.acme.example/v1', credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'acme-chat' }] } }, default: { provider: 'acme-gateway', model: 'acme-chat' } },
    tools: { deny: ['bash'] }, plugins: { indexes: ['https://market.acme.example/index.json'], blocked: ['dsh-purge'] },
  } })).body
  const financeProfile = (await admin('POST', '/admin/api/profiles', { name: 'Finance', spec: {
    skills: [{ name: 'invoice', files: { 'SKILL.md': '---\nname: invoice\ndescription: invoices\n---\n' } }],
    tools: { deny: ['web_fetch'] }, plugins: { required: [{ name: 'dsh-im', spec: 'dsh-im@1.2.3' }] },
  } })).body
  const invalid = await admin('POST', '/admin/api/profiles', { name: 'Bad', spec: { tools: { deny: ['Bash!'] } } })
  assert.equal(invalid.status, 400, 'an invalid profile is refused with its path')
  assert.match(invalid.body.message, /\$\.tools\.deny\[0\]/)
  await admin('POST', '/admin/api/bindings', { profileId: company.id, targetType: 'tenant' })
  await admin('POST', '/admin/api/bindings', { profileId: financeProfile.id, targetType: 'department', targetId: finance.id })
  console.log('✓ administration: CSV import with department tree, validated profiles and bindings')

  const enrollment = validateEnrollment((await admin('GET', '/admin/api/enrollment')).body)
  assert.equal(enrollment.ok, true)
  assert.equal(enrollment.value.server, base)

  // ---- sign-in and the document ----
  const session = client('alice@acme.example', enrollment.value, 'alice')
  await session.signIn()
  assert.equal(session.user().email, 'alice@acme.example')
  assert.ok(session.deviceId())
  const state = await session.fetchDesiredState()
  assert.equal(state.organization.id, 'acme')
  assert.deepEqual(state.tools.deny, ['bash', 'web_fetch'], 'the department profile reaches a sub-department member')
  assert.deepEqual(state.skills.map(skill => skill.name), ['invoice'])
  assert.deepEqual(state.plugins.required, [{ name: 'dsh-im', spec: 'dsh-im@1.2.3' }])
  assert.equal(state.credentials.DSH_ORG_GATEWAY_KEY, 'sk-litellm-1', 'a personal gateway key is delivered')
  assert.deepEqual(litellm.issued[0].models, ['acme-chat'])
  assert.equal(litellm.issued[0].user_id, alice.id)
  assert.equal(state.source.profiles.length, 2)
  console.log('✓ PKCE sign-in, device enrollment, and a signed, merged document with a personal gateway key')

  const bob = await (async () => { const s = client('bob@acme.example', enrollment.value, 'bob'); await s.signIn(); return s.fetchDesiredState() })()
  assert.deepEqual(bob.tools.deny, ['bash'], 'another department does not receive Finance settings')
  assert.equal(bob.credentials.DSH_ORG_GATEWAY_KEY, 'sk-litellm-2')

  // ---- device proof and token lifetime ----
  const sessionFile = JSON.parse((await import('node:fs')).readFileSync(join(work, 'alice', 'session.json'), 'utf8'))
  const token = await fetch(base + API.token, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sessionFile.sealed, client_id: 'dsh-desktop-pro' }) })
  assert.equal(token.status, 200)
  const { access_token: stolen, refresh_token: rotated } = await token.json()
  const proofless = await fetch(base + API.desiredState, { headers: { authorization: 'Bearer ' + stolen, 'x-dsh-device-id': session.deviceId() } })
  assert.equal(proofless.status, 401, 'a token without the device key is useless')
  const replay = await fetch(base + API.token, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sessionFile.sealed, client_id: 'dsh-desktop-pro' }) })
  assert.equal(replay.status, 400, 'refresh tokens rotate on use')
  // Put the rotated token back where the client keeps it, then let the 1 s access token expire.
  ;(await import('node:fs')).writeFileSync(join(work, 'alice', 'session.json'), JSON.stringify({ ...sessionFile, sealed: rotated }))
  await new Promise(resolve => setTimeout(resolve, 1200))
  const refreshed = await session.fetchDesiredState()
  assert.equal(refreshed.revision, state.revision, 'an expired access token is refreshed transparently')
  console.log('✓ device proofs are required, refresh tokens rotate, expired access tokens refresh')

  await session.reportStatus({ revision: state.revision, result: 'partial', problems: ['could not install dsh-im@1.2.3'], clientVersion: '1.0.0', appliedAt: new Date().toISOString() })
  const device = (await admin('GET', '/admin/api/devices')).body.find(row => row.id === session.deviceId())
  assert.deepEqual([device.applied_revision, device.applied_result, device.applied_problems[0]], [state.revision, 'partial', 'could not install dsh-im@1.2.3'])
  await session.sendAudit([{ at: new Date().toISOString(), action: 'tool.denied', target: 'bash' }])
  console.log('✓ status reports and client audit events reach the console')

  // ---- change, rollback ----
  await admin('PUT', '/admin/api/profiles/' + financeProfile.id, { spec: { tools: { deny: ['web_fetch', 'web_search'] } }, note: 'tighten' })
  const changed = await session.fetchDesiredState()
  assert.ok(changed.revision > state.revision, 'any change bumps the revision')
  assert.deepEqual(changed.tools.deny, ['bash', 'web_fetch', 'web_search'])
  await admin('POST', '/admin/api/profiles/' + financeProfile.id + '/rollback', { version: 1 })
  const rolledBack = await session.fetchDesiredState()
  assert.ok(rolledBack.revision > changed.revision)
  assert.deepEqual(rolledBack.skills.map(skill => skill.name), ['invoice'], 'rollback restores the old spec as a new version')
  assert.equal((await admin('GET', '/admin/api/profiles/' + financeProfile.id)).body.versions.length, 3)
  const preview = (await admin('GET', '/admin/api/users/' + alice.id + '/desired-state')).body
  assert.equal(preview.credentials.DSH_ORG_GATEWAY_KEY, '••••••', 'previews never show keys')
  console.log('✓ edits bump the revision; rollback is a new version; previews mask credentials')

  // ---- people the server does not know ----
  const stranger = client('eve@evil.example', enrollment.value, 'eve')
  await assert.rejects(stranger.signIn(), error => error instanceof SessionError && error.kind === 'cancelled')
  assert.equal(stranger.isSignedIn(), false)

  // ---- auditors read, never write ----
  const audrey = users.find(user => user.email === 'audit@acme.example')
  const auditorCookie = 'dsh_console=' + await app.auth.consoleSession(await app.store.user(audrey.id))
  assert.equal((await admin('GET', '/admin/api/devices', undefined, auditorCookie)).status, 200)
  assert.equal((await admin('POST', '/admin/api/devices/' + session.deviceId() + '/revoke', undefined, auditorCookie)).status, 403)
  console.log('✓ unknown people cannot sign in; auditors are read-only')

  // ---- off-boarding and device revocation ----
  const bobSession = client('bob@acme.example', enrollment.value, 'bob')
  const bobDevice = (await admin('GET', '/admin/api/devices')).body.find(row => row.id === bobSession.deviceId())
  await admin('POST', '/admin/api/devices/' + bobDevice.id + '/revoke')
  await assert.rejects(bobSession.fetchDesiredState(), error => error instanceof SessionError && error.kind === 'device-revoked')

  await admin('PATCH', '/admin/api/users/' + alice.id, { status: 'disabled' })
  assert.ok(litellm.deleted.includes('sk-litellm-1'), 'the gateway key is revoked at once')
  await assert.rejects(session.fetchDesiredState(), error => error instanceof SessionError && error.kind === 'device-revoked')
  console.log('✓ a revoked device and a disabled person are told to remove the organisation configuration')

  // ---- the audit chain ----
  const verified = (await admin('GET', '/admin/api/audit/verify')).body
  assert.equal(verified.ok, true)
  const actions = (await admin('GET', '/admin/api/audit?limit=1000')).body.map(event => event.action)
  for (const action of ['users.imported', 'login.succeeded', 'device.enrolled', 'gateway.key.issued', 'desired-state.served', 'desired-state.partial', 'client.tool.denied', 'profile.rolled-back', 'login.refused', 'device.revoked', 'gateway.key.revoked']) {
    assert.ok(actions.includes(action), 'audited: ' + action)
  }
  await app.store.db.run("UPDATE audit_events SET action = 'nothing.happened' WHERE seq = 3")
  const tampered = (await admin('GET', '/admin/api/audit/verify')).body
  assert.deepEqual([tampered.ok, tampered.brokenAt], [false, 3])
  console.log('✓ every step is audited, and editing a stored event breaks the chain at that event')

  const signedDoc = await app.composer.signedFor(await app.store.user(users.find(user => user.email === 'bob@acme.example').id))
  assert.equal(verifyDocument(signedDoc, enrollment.value.keys).ok, true)
} finally {
  await app.close()
  gateway.close()
  rmSync(work, { recursive: true, force: true })
}
