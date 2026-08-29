/**
 * A loopback origin that rejects DSH browser-session admission is occupied,
 * not absent. The desktop must show a recovery surface without starting a
 * second runtime against the same DSH_HOME.
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_FIXTURE = join(APP_DIR, 'scripts', 'fixtures', 'fake-dsh.mjs')
const checkHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-auth-occupancy-'))
const dshHome = join(checkHome, 'dsh')
const desktopHome = join(checkHome, 'desktop')
mkdirSync(dshHome, { recursive: true })
mkdirSync(desktopHome, { recursive: true })
writeFileSync(join(desktopHome, 'settings.json'), JSON.stringify({ connectionMode: 'smart' }, null, 2) + '\n')

const server = createServer((req, res) => {
  if (req.method === 'POST'
    && (req.url === '/api/host.describe' || req.url === '/api/settings/describe')) {
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end('unauthorized')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Unauthorized DSH Fixture</title>')
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (typeof address !== 'object' || address === null) throw new Error('authentication fixture did not bind')
const origin = 'http://127.0.0.1:' + String(address.port)

const env = sanitizedElectronEnv({
  DSH_HOME: dshHome,
  DSH_DESKTOP_HOME: desktopHome,
  DSH_DESKTOP_PROBE_URL: origin,
  DSH_DESKTOP_DSH: RUNTIME_FIXTURE,
  DSH_DESKTOP_NODE: process.execPath,
  DSH_DESKTOP_SKIP_INSTALLED_DSH: '1',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
})

let app
let runtimeLog = ''
try {
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'chromium')],
    env,
  })
  app.process().stdout?.on('data', chunk => { runtimeLog += chunk.toString() })
  app.process().stderr?.on('data', chunk => { runtimeLog += chunk.toString() })
  const window = await app.firstWindow()
  await window.waitForFunction(() => {
    const title = document.title.toLowerCase()
    return title.includes('could not be authenticated') || title.includes('无法认证')
  }, null, { timeout: 20_000 })
  const status = await window.evaluate(() => window.desktop?.connection.getStatus())
  if (typeof status?.childPid === 'number' || status?.targetUrl !== '') {
    throw new Error('authentication-required origin started or selected another runtime: ' + JSON.stringify(status))
  }
  if (runtimeLog.includes('dsh runtime ready:') || runtimeLog.includes('Installed Harness Fixture')) {
    throw new Error('authentication-required origin reached the managed runtime:\n' + runtimeLog)
  }
  if (!runtimeLog.includes('refusing local runtime: a loopback service requires different DSH browser credentials')) {
    throw new Error('authentication-required refusal was not logged:\n' + runtimeLog)
  }
  console.log('✓ a 401 DSH origin blocks local spawn and shows credential-restart guidance')
} finally {
  await app?.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}
