/**
 * File mode end to end: IT drops `managed.json` on a machine, the person opens
 * the client and talks to the organisation's model with nothing to configure.
 *
 * A fake OpenAI-compatible gateway stands in for the organisation's LiteLLM.
 * The client must start the bundled runtime in its separate enterprise home,
 * apply the document (route, credential, skill, index, tool policy), lock the
 * connection settings, and the official Web UI's first message must reach the
 * gateway with the organisation credential.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-enterprise-file-'))
const requests = []
const gateway = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    requests.push({ url: req.url, authorization: req.headers.authorization, body })
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'acme-chat' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'acme-chat' }
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'ACME-GATEWAY-REPLY' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
const gatewayUrl = 'http://127.0.0.1:' + String(gateway.address().port) + '/v1'

const managedDir = join(home, 'managed')
mkdirSync(managedDir)
writeFileSync(join(managedDir, 'managed.json'), JSON.stringify({
  schema: 'dsh-desktop-pro/desired-state', version: 1, revision: 7, issuedAt: '2026-11-15T00:00:00Z',
  organization: { id: 'acme', name: 'Acme' },
  models: {
    providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: gatewayUrl, credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64000 }] } },
    default: { provider: 'acme-gateway', model: 'acme-chat' },
  },
  credentials: { DSH_ORG_GATEWAY_KEY: 'sk-acme-file-mode' },
  plugins: { indexes: ['https://bruc3van.com/dsh-plugins/index.json'] },
  skills: [{ name: 'acme-invoice', files: { 'SKILL.md': '---\nname: acme-invoice\ndescription: Acme invoice helper\n---\nUse the Acme template.\n' } }],
  tools: { deny: ['bash', 'pwsh'], message: 'Disabled by Acme IT' },
}))
// A personal setting that enterprise mode must not honour.
mkdirSync(join(home, 'desktop'))
writeFileSync(join(home, 'desktop', 'settings.json'), JSON.stringify({ connectionMode: 'connect', serverUrl: 'http://127.0.0.1:9', smartRuntimes: ['installed'] }))

let app
let log = ''
try {
  app = await electron.launch({
    args: [join(root, '.build/main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env: {
      ...sanitizedElectronEnv(), HOME: home, USERPROFILE: home,
      DSH_DESKTOP_HOME: join(home, 'desktop'), DSH_DESKTOP_MANAGED_DIR: managedDir,
      DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_SKIP_INSTALLED_DSH: '1', DSH_DESKTOP_SKIP_UPDATE_PROMPT: '1',
    },
  })
  app.process().stdout?.on('data', chunk => { log += chunk })
  app.process().stderr?.on('data', chunk => { log += chunk })
  const page = await app.firstWindow()
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 90_000 })
    .catch(error => { throw new Error(String(error) + '\n' + log) })

  const enterpriseHome = join(home, 'desktop', 'enterprise', 'dsh')
  const patch = readFileSync(join(enterpriseHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-desktop-pro managed/, 'the managed block is in the enterprise profile')
  assert.match(patch, /apiKeyEnv: DSH_ORG_GATEWAY_KEY/)
  assert.match(patch, /policy-plugin\.mjs/)
  assert.match(readFileSync(join(enterpriseHome, '.credentials.yaml'), 'utf8'), /DSH_ORG_GATEWAY_KEY: sk-acme-file-mode/)
  assert.ok(existsSync(join(enterpriseHome, 'skills', 'acme-invoice', 'SKILL.md')))
  assert.equal(existsSync(join(home, '.dsh')), false, 'the personal ~/.dsh is never touched')
  assert.match(log, /managed profile: revision 7 applied/)
  console.log('✓ the bundled runtime starts in the enterprise home with the document applied')

  const status = await page.evaluate(() => window.desktop.connection.getStatus())
  assert.equal(status.enterprise.mode, 'file')
  assert.equal(status.enterprise.organization, 'Acme')
  assert.equal(status.enterprise.revision, 7)
  assert.equal(status.runtimeSource, 'bundled', 'the personal runtime choice is overridden')
  assert.equal(status.dshDataHome, enterpriseHome)
  const save = await page.evaluate(() => window.desktop.connection.saveServerUrl('http://127.0.0.1:3080'))
  assert.equal(save.saved, false)
  assert.match(save.error, /Acme/)
  console.log('✓ connection settings are fixed and say who manages them')

  // Zero configuration: the model is preselected and no key is asked for.
  // The official preview notice is product copy for everyone; acknowledge it.
  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  // isVisible() answers at once and ignores its timeout, so a notice that mounts a
  // moment later was skipped and then covered the composer. Wait for it instead.
  await notice.waitFor({ state: 'visible', timeout: 10_000 }).then(() => notice.click(), () => undefined)
  await page.getByText('Acme Chat').first().waitFor({ timeout: 30_000 })
  // The composer is a textarea in older Web UIs and a rich editor in newer ones.
  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await page.keyboard.type('hello from acme')
  await page.keyboard.press('Enter')
  await page.getByText('ACME-GATEWAY-REPLY').first().waitFor({ timeout: 60_000 })
    .catch(error => { throw new Error(String(error) + '\nrequests: ' + JSON.stringify(requests.map(r => r.url)) + '\n' + log.slice(-3000)) })
  const chat = requests.find(request => request.url?.endsWith('/chat/completions'))
  assert.equal(chat?.authorization, 'Bearer sk-acme-file-mode')
  assert.equal(JSON.parse(chat.body).model, 'acme-chat')
  console.log('✓ the first message reaches the organisation gateway with the managed credential')
} finally {
  await app?.close().catch(() => {})
  gateway.close()
  rmSync(home, { recursive: true, force: true })
}
