/**
 * Server mode end to end in the real client: IT installs `enrollment.json`,
 * the person sees only "sign in with your organisation account", signs in,
 * and their first message goes to the organisation gateway with a personal
 * key the server issued. When IT disables them, the client removes the
 * organisation configuration and returns to the sign-in surface.
 *
 * The system browser is replaced in the main process by a fetch-driven one
 * that completes the development login; everything else is the shipping code.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-enterprise-server-'))
const issued = []
const chats = []
const upstream = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.url === '/key/generate') {
      const key = 'sk-personal-' + String(issued.length + 1)
      issued.push(key)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ key }))
      return
    }
    if (req.url === '/key/delete') { res.writeHead(200).end('{}'); return }
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'acme-chat' }] })); return }
    chats.push({ authorization: req.headers.authorization, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'acme-chat' }
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'SERVER-MODE-REPLY' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = 'http://127.0.0.1:' + String(upstream.address().port)

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'y'.repeat(40), PORT: '0', HOST: '127.0.0.1',
  DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_DEV_LOGIN: '1',
  DSH_GATEWAY: 'litellm', LITELLM_URL: upstreamUrl, LITELLM_MASTER_KEY: 'sk-master',
})
const server = await createApp({ config, db: await openDb('sqlite:' + join(home, 'server.sqlite')) })
const base = await server.listen()
config.publicUrl = base
const alice = await server.store.createUser({ name: 'Alice', email: 'alice@acme.example' })
const profile = await server.store.createProfile({ name: 'Company', spec: {
  models: {
    providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: upstreamUrl + '/v1', credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'acme-chat', name: 'Acme Chat' }] } },
    default: { provider: 'acme-gateway', model: 'acme-chat' },
  },
  tools: { deny: ['bash'] },
} }, 'test')
await server.store.bind({ profileId: profile.id, targetType: 'tenant', targetId: '' })

const managedDir = join(home, 'managed')
mkdirSync(managedDir)
const tenant = await server.store.tenant()
writeFileSync(join(managedDir, 'enrollment.json'), JSON.stringify({
  schema: 'dsh-desktop-pro/enrollment', version: 1, server: base, organization: { id: tenant.id, name: tenant.name }, keys: await server.store.publicKeys(),
}))

let app
let log = ''
try {
  app = await electron.launch({
    args: [join(root, '.build/main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env: {
      ...sanitizedElectronEnv(), HOME: home, USERPROFILE: home, DSH_DESKTOP_HOME: join(home, 'desktop'), DSH_DESKTOP_MANAGED_DIR: managedDir,
      DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_SKIP_INSTALLED_DSH: '1', DSH_DESKTOP_SKIP_UPDATE_PROMPT: '1',
      // Off-boarding restarts the client; a test must not leave the successor running.
      DSH_DESKTOP_SKIP_RELAUNCH: '1',
    },
  })
  app.process().stdout?.on('data', chunk => { log += chunk })
  app.process().stderr?.on('data', chunk => { log += chunk })
  let page = await app.firstWindow()
  let signIn = page.locator('#error-retry')
  await signIn.waitFor({ timeout: 60_000 }).catch(error => { throw new Error(String(error) + '\n' + log) })
  assert.match(await page.locator('h1').textContent(), /Acme/)
  assert.match(await signIn.textContent(), /企业账号登录|organisation account/)
  assert.equal(existsSync(join(home, 'desktop', 'enterprise', 'dsh')), false, 'nothing starts before sign-in')
  console.log('✓ an enrolled client opens on "sign in with your organisation account" and starts nothing yet')

  // macOS destroys a closed window; the Dock icon then asks for a new one. The
  // organisation has still not admitted this launch, so the new window is the
  // same sign-in surface and no runtime starts behind it.
  const reopened = app.waitForEvent('window')
  await app.evaluate(({ app: client, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    client.emit('activate')
  })
  page = await reopened
  signIn = page.locator('#error-retry')
  await signIn.waitFor({ timeout: 30_000 }).catch(error => { throw new Error('a reopened window left the sign-in surface: ' + String(error) + '\n' + log.slice(-3000)) })
  assert.match(await signIn.textContent(), /企业账号登录|organisation account/)
  assert.equal(existsSync(join(home, 'desktop', 'enterprise', 'dsh')), false, 'reopening the window starts nothing before sign-in')
  console.log('✓ reopening the window before sign-in shows the same surface and still starts nothing')

  // The person's browser, inside the main process (shell.openExternal is the only door out).
  await app.evaluate(({ shell }, server) => {
    shell.openExternal = async (url) => {
      const chooser = await fetch(url, { redirect: 'manual' })
      const flow = /name="flow" value="([^"]+)"/.exec(await chooser.text())?.[1] ?? ''
      const done = await fetch(server + '/v1/auth/dev', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ flow, email: 'alice@acme.example' }) })
      await fetch(done.headers.get('location') ?? '')
    }
  }, base)
  await signIn.click()
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 90_000 })
    .catch(error => { throw new Error(String(error) + '\n' + log.slice(-3000)) })
  const status = await page.evaluate(() => window.desktop.connection.getStatus())
  assert.deepEqual([status.enterprise.mode, status.enterprise.organization, status.enterprise.user], ['server', 'Acme', 'Alice'])
  assert.match(readFileSync(join(home, 'desktop', 'enterprise', 'dsh', '.credentials.yaml'), 'utf8'), /DSH_ORG_GATEWAY_KEY: sk-personal-1/)
  console.log('✓ sign-in in the browser enrolls the device and applies a document with a personal gateway key')

  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  // isVisible() answers at once and ignores its timeout, so a notice that mounts a
  // moment later was skipped and then covered the composer. Wait for it instead.
  await notice.waitFor({ state: 'visible', timeout: 10_000 }).then(() => notice.click(), () => undefined)
  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await page.keyboard.type('hello from server mode')
  await page.keyboard.press('Enter')
  await page.getByText('SERVER-MODE-REPLY').first().waitFor({ timeout: 60_000 })
  assert.equal(chats.at(-1).authorization, 'Bearer sk-personal-1')
  // Several requests per turn (the reply, a title); the agent's own carries the tool list.
  const withTools = chats.map(chat => JSON.parse(chat.body)).find(body => Array.isArray(body.tools) && body.tools.length > 0)
  assert.ok(withTools !== undefined, 'the model is offered tools: ' + chats.map(chat => Object.keys(JSON.parse(chat.body)).join('/')).join(' | '))
  const offered = withTools.tools.map(tool => tool.function?.name ?? tool.name)
  assert.equal(offered.includes('bash'), false, 'a denied tool is not offered to the model: ' + offered.join(', '))
  assert.ok(offered.includes('read') || offered.includes('write') || offered.length > 3, 'other tools are still offered: ' + offered.join(', '))
  console.log('  offered: ' + offered.join(', '))
  console.log('✓ the first message reaches the gateway with the person\'s own key, without the denied tool on offer')

  // The client reports what it applied.
  let device
  for (let attempt = 0; attempt < 40 && device?.applied_result === undefined; attempt += 1) {
    device = await server.store.db.get('SELECT id, applied_result, applied_revision FROM devices WHERE user_id = $1', [alice.id])
    if (device?.applied_result === null || device?.applied_result === undefined) await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(device.applied_result, 'applied')
  console.log('✓ the device reports the revision it applied')

  // A refused call recorded by the policy plugin, then a change in the console:
  // the long poll brings the new revision within seconds, and the refusal reaches the audit log.
  writeFileSync(join(home, 'desktop', 'enterprise', 'dsh', '.dsh-desktop-pro-denials.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'bash' }) + '\n')
  const before = device.applied_revision
  const changedAt = Date.now()
  await server.store.updateProfile(profile.id, { spec: { ...profile.spec ?? {}, models: {
    providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: upstreamUrl + '/v1', credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'acme-chat', name: 'Acme Chat' }] } },
    default: { provider: 'acme-gateway', model: 'acme-chat' },
  }, tools: { deny: ['bash', 'web_fetch'] } } }, 'test')
  for (let attempt = 0; attempt < 60 && device.applied_revision === before; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    device = await server.store.db.get('SELECT id, applied_result, applied_revision FROM devices WHERE user_id = $1', [alice.id])
  }
  assert.ok(device.applied_revision > before, 'the new revision is applied without waiting for the five-minute check')
  assert.ok(Date.now() - changedAt < 30_000)
  let denied
  for (let attempt = 0; attempt < 20 && denied === undefined; attempt += 1) {
    denied = await server.store.db.get("SELECT target FROM audit_events WHERE action = 'client.tool.denied'")
    if (denied === undefined) await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(denied?.target, 'bash', 'a refused tool call reaches the organisation audit log')
  console.log('✓ a console change reaches the device in ' + String(Math.round((Date.now() - changedAt) / 1000)) + ' s, and refused calls are audited')

  // Off-boarding: IT disables Alice; on its next check the client cleans up.
  await server.store.updateUser(alice.id, { status: 'disabled' })
  await server.auth.revokeUserSessions(alice.id)
  await server.composer.revokeGatewayKey(alice.id)
  const closed = app.waitForEvent('close').catch(() => undefined)
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume') })
  await closed
  const credentials = join(home, 'desktop', 'enterprise', 'dsh', '.credentials.yaml')
  assert.doesNotMatch(existsSync(credentials) ? readFileSync(credentials, 'utf8') : '', /DSH_ORG_GATEWAY_KEY/, 'the organisation key is gone from the device')
  assert.equal(existsSync(join(home, 'desktop', 'enterprise', 'session.json')), false, 'the session is gone')
  console.log('✓ disabling the person removes the organisation configuration from the device')
} finally {
  await app?.close().catch(() => {})
  await server.close()
  upstream.close()
  rmSync(home, { recursive: true, force: true })
}
