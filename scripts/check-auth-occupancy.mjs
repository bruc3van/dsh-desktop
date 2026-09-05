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

let responseMode = 'auth'
const server = createServer((req, res) => {
  if (responseMode === 'silent') return
  if (req.method === 'POST'
    && (req.url === '/api/host.describe' || req.url === '/api/settings/describe')) {
    if (responseMode === 'verified') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ result: { ok: true, value: { version: 'fixture', cwd: dshHome } } }))
      return
    }
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

  await app.close()
  responseMode = 'verified'
  runtimeLog = ''
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'chromium')], env,
  })
  app.process().stdout?.on('data', chunk => { runtimeLog += chunk.toString() })
  app.process().stderr?.on('data', chunk => { runtimeLog += chunk.toString() })
  const adoptedWindow = await app.firstWindow()
  await adoptedWindow.waitForFunction(async () => (await window.desktop?.connection.getStatus())?.mode === 'probe', null, { timeout: 20_000 })
  responseMode = 'silent'
  // Exercise Electron's load-failure recovery against a real listener that
  // stays alive but stops answering. The injected event avoids Chromium's
  // unrelated, platform-dependent navigation timeout.
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith(url))
      .webContents.emit('did-fail-load', {}, -7, 'fixture timeout', url, true)
  }, origin)
  await adoptedWindow.waitForFunction(() => {
    const title = document.title.toLowerCase()
    return title.includes('state is uncertain') || title.includes('状态尚未确认')
  }, null, { timeout: 25_000 })
  const uncertainStatus = await adoptedWindow.evaluate(() => window.desktop.connection.getStatus())
  if (typeof uncertainStatus.childPid === 'number' || uncertainStatus.targetUrl !== '') {
    throw new Error('silent adopted instance spawned a second runtime: ' + JSON.stringify(uncertainStatus))
  }
  if (runtimeLog.includes('dsh runtime:') || !runtimeLog.includes('still listening but could not be verified')) {
    throw new Error('uncertain occupancy did not block the actual runtime path:\n' + runtimeLog)
  }
  console.log('✓ a silent adopted instance shows uncertain-state guidance in Electron without spawning a second runtime')
} finally {
  await app?.close().catch(() => {})
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}
