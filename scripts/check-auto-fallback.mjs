/**
 * Smart-mode recovery integration check. Turning reuse off while a probed
 * instance is still answering must refuse a local spawn (two writers on one
 * DSH_HOME) and leave that instance running. When the instance later
 * disappears, the desktop starts its managed runtime; that child is then
 * killed once and must be relaunched within the bounded recovery budget.
 */

import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_FIXTURE = join(APP_DIR, 'scripts', 'fixtures', 'fake-dsh.mjs')
const checkHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-fallback-'))
const desktopHome = join(checkHome, 'desktop')
mkdirSync(desktopHome, { recursive: true })
writeFileSync(join(desktopHome, 'settings.json'), JSON.stringify({ connectionMode: 'smart' }, null, 2) + '\n')

const probeServer = createServer((req, res) => {
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    return
  }
  // Plain by design (nothing is injected here), but legible enough that a
  // watched run does not look like a broken page.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probed Harness Fixture</title>'
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eceef1;color:#6e7480;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:14px}'
    + 'p{margin:0;padding:14px 22px;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(15,17,21,.12)}</style>'
    + '</head><body><p>probed fixture</p></body></html>')
})
await new Promise((resolve, reject) => {
  probeServer.once('error', reject)
  probeServer.listen(0, '127.0.0.1', resolve)
})
const address = probeServer.address()
if (typeof address !== 'object' || address === null) throw new Error('probe fixture did not bind')
const probeOrigin = 'http://127.0.0.1:' + String(address.port)

/** Node that is not this client's Electron binary (the `~/.dsh-desktop/bin` shim). */
function systemNode() {
  const rejected = (path) =>
    /[\\/]\.dsh-desktop[\\/]bin[\\/]/i.test(path)
    || /DeepSeek Harness/i.test(path)
    || /electron\.exe$/i.test(path)
  if (process.platform === 'win32') {
    for (const candidate of [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe'),
    ]) {
      if (candidate !== '' && existsSync(candidate) && !rejected(candidate)) return candidate
    }
  }
  try {
    const listing = execFileSync(
      process.platform === 'win32' ? 'where.exe' : 'which',
      process.platform === 'win32' ? ['node'] : ['-a', 'node'],
      { encoding: 'utf8' },
    )
    const found = listing.trim().split(/\r?\n/).map(line => line.trim()).find(path =>
      path !== ''
      && !rejected(path)
      && (process.platform !== 'win32' || /\bnode\.exe$/i.test(path)))
    if (found !== undefined) return found
  } catch { /* fall through */ }
  if (!rejected(process.execPath)) return process.execPath
  throw new Error('check-auto-fallback needs a system Node; PATH currently resolves to the desktop Electron binary')
}

const electronEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  const upper = key.toUpperCase()
  if (upper === 'ELECTRON_RUN_AS_NODE') continue
  if (upper === 'DSH_DESKTOP_SKIP_INSTALLED_DSH') continue
  if (upper === 'DSH_DESKTOP_DSH') continue
  if (upper === 'DSH_DESKTOP_SKIP_PROBE') continue
  if (upper === 'DSH_DESKTOP_NODE') continue
  if (upper === 'DSH_FIXTURE_FAIL') continue
  if (upper === 'DSH_FIXTURE_DELAY_MS') continue
  electronEnv[key] = value
}
electronEnv.DSH_HOME = join(checkHome, 'dsh')
electronEnv.DSH_DESKTOP_HOME = desktopHome
electronEnv.DSH_DESKTOP_PROBE_URL = probeOrigin
electronEnv.DSH_DESKTOP_DSH = RUNTIME_FIXTURE
electronEnv.DSH_DESKTOP_NODE = systemNode()
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'

const waitForStatus = async (app, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let lastStatus
  while (Date.now() < deadline) {
    const window = app.windows()[0]
    try {
      lastStatus = await window?.evaluate(() => window.desktop?.connection.getStatus())
      if (lastStatus && predicate(lastStatus)) return { window, status: lastStatus }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('status condition timed out: ' + JSON.stringify(lastStatus) + (runtimeLog ? '\n--- log ---\n' + runtimeLog : ''))
}

let app
let runtimeLog = ''
try {
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'chromium')],
    env: electronEnv,
  })
  const runner = app.process()
  runner.stdout?.on('data', chunk => { runtimeLog += chunk.toString() })
  runner.stderr?.on('data', chunk => { runtimeLog += chunk.toString() })
  let window = await app.firstWindow()
  await window.waitForFunction(() => document.title === 'Probed Harness Fixture', null, { timeout: 10_000 })
  const probed = await window.evaluate(() => window.desktop.connection.getStatus())
  if (probed.mode !== 'probe' || probed.targetUrl !== probeOrigin) {
    throw new Error('Smart mode did not select the probed instance: ' + JSON.stringify(probed))
  }

  // Reuse is a connection source, not a license to kill. Turning it off while
  // the fixture is still answering must refuse a local spawn (two writers on
  // one DSH_HOME) and leave the external instance running.
  const disabled = await window.evaluate(() => window.desktop.connection.setSmartRuntimes(['bundled']))
  if (!disabled.saved || JSON.stringify(disabled.smartRuntimes) !== JSON.stringify(['bundled'])) {
    throw new Error('disabling reuse was not saved: ' + JSON.stringify(disabled))
  }
  await window.waitForSelector('#error-retry', { timeout: 20_000 })
  const blockedTitle = await window.locator('h1').innerText()
  if (!/占用会话数据|already using this session data/.test(blockedTitle)) {
    throw new Error('occupancy refusal did not show the expected title: ' + blockedTitle)
  }
  const blocked = await window.evaluate(() => window.desktop.connection.getStatus())
  if (blocked.mode === 'probe' || typeof blocked.childPid === 'number') {
    throw new Error('occupancy refusal started a local runtime or stayed on the probed instance: ' + JSON.stringify(blocked))
  }
  if (/dsh runtime:/.test(runtimeLog)) {
    throw new Error('occupancy refusal still spawned a local runtime: ' + runtimeLog)
  }
  if (!probeServer.listening) {
    throw new Error('occupancy refusal stopped the external instance')
  }
  const stillAnswering = await fetch(probeOrigin + '/api/host.describe', { method: 'POST' })
  if (!stillAnswering.ok) {
    throw new Error('occupancy refusal left the external instance unresponsive')
  }
  console.log('✓ disabling reuse while a probed instance is live refuses a local spawn and leaves the instance running')

  const restored = await window.evaluate(() =>
    window.desktop.connection.setSmartRuntimes(['probe', 'installed', 'npx', 'bundled']))
  if (!restored.saved) {
    throw new Error('re-enabling reuse was not saved: ' + JSON.stringify(restored))
  }
  window = (await waitForStatus(app, status => status.mode === 'probe' && status.targetUrl === probeOrigin, 20_000)).window
  await window.waitForFunction(() => document.title === 'Probed Harness Fixture', null, { timeout: 10_000 })
  console.log('✓ re-enabling reuse reconnects to the live instance')

  await new Promise((resolve, reject) => probeServer.close(error => error ? reject(error) : resolve()))
  await window.reload().catch(() => {})

  let recovered = await waitForStatus(app,
    status => status.mode === 'local' && typeof status.childPid === 'number' && status.targetUrl !== '',
    60_000)
  window = recovered.window
  await window.waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  const firstChildPid = recovered.status.childPid
  console.log('✓ unavailable probed instance fell back to the managed local runtime (PID ' + String(firstChildPid) + ')')

  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/pid', String(firstChildPid), '/T', '/F']).catch(() => {})
  } else {
    process.kill(firstChildPid, 'SIGKILL')
  }
  recovered = await waitForStatus(app,
    status => status.mode === 'local' && typeof status.childPid === 'number' && status.childPid !== firstChildPid && status.targetUrl !== '',
    60_000)
  await recovered.window.waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  console.log('✓ exited managed runtime relaunched with a new PID (' + String(recovered.status.childPid) + ')')
} finally {
  await app?.close().catch(() => {})
  if (probeServer.listening) await new Promise(resolve => probeServer.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}
