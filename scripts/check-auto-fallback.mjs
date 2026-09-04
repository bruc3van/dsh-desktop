/**
 * Smart-mode recovery integration check. Turning reuse off while a probed
 * instance is still answering must be refused (this client never kills a
 * user-started process). The same refusal applies when reuse is already off
 * and a managed source (installed / npx / bundled) would spawn beside that
 * instance. When the instance later disappears, the desktop starts its
 * managed runtime; that child is then killed once and must be relaunched
 * within the bounded recovery budget.
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
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

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
    /[\\/]\.(?:bruc3van-)?dsh-desktop[\\/]bin[\\/]/i.test(path)
    || /DSH Desktop/i.test(path)
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

// This roster now lives in one place; every check that launches the client
// strips the same set, so a knob added upstream is covered everywhere at once.
const electronEnv = sanitizedElectronEnv()
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

/**
 * Wait for the managed runtime to hold still, not merely to exist.
 *
 * A source change the client accepts is asynchronous: it stops the runtime it
 * was serving from and re-resolves under the new preference, so the child pid
 * changes a moment after the save returns. Every "is there a local runtime"
 * predicate is already true of the *outgoing* child, so sampling at the first
 * match records a pid that is about to be replaced — and a later assertion
 * about a *refused* change then reports that replacement as damage the refusal
 * did. macOS lost this race on both release runners while Windows happened to
 * settle before the sample; the timing was never the contract.
 */
const waitForSettledLocalRuntime = async (app, timeoutMs, quietMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  let candidate
  let stableSince = 0
  let last
  while (Date.now() < deadline) {
    let status
    try {
      status = await app.windows()[0]?.evaluate(() => window.desktop?.connection.getStatus())
    } catch { /* the window swaps documents while the runtime is replaced */ }
    last = status
    if (status?.mode !== 'local' || typeof status.childPid !== 'number' || status.targetUrl === '') {
      candidate = undefined
    } else if (status.childPid !== candidate) {
      candidate = status.childPid
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return { window: app.windows()[0], status }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('the managed runtime never settled on one child pid: ' + JSON.stringify(last)
    + (runtimeLog ? '\n--- log ---\n' + runtimeLog : ''))
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
  // the fixture is still answering must be refused — otherwise the window
  // lands on the occupancy surface with no way to stop the user's process.
  const disabled = await window.evaluate(() => window.desktop.connection.setSmartRuntimes(['bundled']))
  if (disabled.saved) {
    throw new Error('disabling reuse while the instance is live was accepted: ' + JSON.stringify(disabled))
  }
  if (JSON.stringify(disabled.smartRuntimes) === JSON.stringify(['bundled'])) {
    throw new Error('the refused save still dropped reuse: ' + JSON.stringify(disabled))
  }
  const stillProbed = await window.evaluate(() => window.desktop.connection.getStatus())
  if (stillProbed.mode !== 'probe' || stillProbed.targetUrl !== probeOrigin) {
    throw new Error('refusing the toggle left the probed instance: ' + JSON.stringify(stillProbed))
  }
  if (await window.title() !== 'Probed Harness Fixture') {
    throw new Error('refusing the toggle replaced the probed page: ' + await window.title())
  }
  if (!probeServer.listening) {
    throw new Error('refusing the toggle stopped the external instance')
  }
  const stillAnswering = await fetch(probeOrigin + '/api/host.describe', { method: 'POST' })
  if (!stillAnswering.ok) {
    throw new Error('refusing the toggle left the external instance unresponsive')
  }
  console.log('✓ disabling reuse while a probed instance is live is refused and leaves the instance running')

  const keepReuse = await window.evaluate(() =>
    window.desktop.connection.setSmartRuntimes(['probe', 'bundled']))
  if (!keepReuse.saved || !keepReuse.smartRuntimes.includes('probe')) {
    throw new Error('toggling managed sources while reuse stays on was refused: ' + JSON.stringify(keepReuse))
  }
  window = (await waitForStatus(app, status => status.mode === 'probe' && status.targetUrl === probeOrigin, 20_000)).window
  if (await window.title() !== 'Probed Harness Fixture') {
    throw new Error('toggling managed sources left the probed page: ' + await window.title())
  }
  console.log('✓ toggling installed/npx/bundled while reuse stays on is allowed')

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

  const pinnedLocal = await window.evaluate(() => window.desktop.connection.setSmartRuntimes(['bundled']))
  if (!pinnedLocal.saved) {
    throw new Error('pinning the managed runtime while the instance is gone was refused: ' + JSON.stringify(pinnedLocal))
  }
  // The pin is what the assertions below take their baseline from, so it has to
  // be the settled child rather than whichever one answers first.
  recovered = await waitForSettledLocalRuntime(app, 60_000)
  window = recovered.window
  const localPid = recovered.status.childPid
  await window.waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })

  const probePort = Number(new URL(probeOrigin).port)
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      probeServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      probeServer.off('error', onError)
      resolve()
    }
    probeServer.once('error', onError)
    probeServer.once('listening', onListening)
    probeServer.listen(probePort, '127.0.0.1')
  })
  const occupiedWhileLocal = await window.evaluate(() =>
    window.desktop.connection.setSmartRuntimes(['npx', 'bundled']))
  if (occupiedWhileLocal.saved) {
    throw new Error('changing managed sources while a user instance occupies was accepted: ' + JSON.stringify(occupiedWhileLocal))
  }
  const stillLocal = await window.evaluate(() => window.desktop.connection.getStatus())
  if (stillLocal.mode !== 'local' || stillLocal.childPid !== localPid) {
    throw new Error('refusing a managed-source change left the local runtime: ' + JSON.stringify(stillLocal))
  }
  if (await window.title() !== 'Installed Harness Fixture') {
    throw new Error('refusing a managed-source change replaced the local page: ' + await window.title())
  }
  console.log('✓ changing installed/npx/bundled while a user instance occupies is refused')

  const asSmart = await window.evaluate((url) => window.desktop.connection.saveServerUrl(url), probeOrigin)
  if (asSmart.saved) {
    throw new Error('saving the probe-equivalent origin while occupied was accepted: ' + JSON.stringify(asSmart))
  }
  const stillLocalAfterSave = await window.evaluate(() => window.desktop.connection.getStatus())
  if (stillLocalAfterSave.mode !== 'local' || stillLocalAfterSave.childPid !== localPid) {
    throw new Error('refusing a probe-equivalent save left the local runtime: ' + JSON.stringify(stillLocalAfterSave))
  }
  console.log('✓ saving the probe-equivalent origin while occupied is refused')

  const customServer = createServer((req, res) => {
    if (req.url === '/api/host.describe' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Custom Harness Fixture</title><p>custom fixture</p>')
  })
  await new Promise((resolve, reject) => {
    customServer.once('error', reject)
    customServer.listen(0, '127.0.0.1', resolve)
  })
  const customAddress = customServer.address()
  if (typeof customAddress !== 'object' || customAddress === null) throw new Error('custom fixture did not bind')
  const customOrigin = 'http://127.0.0.1:' + String(customAddress.port)
  const pinnedCustom = await window.evaluate((url) => window.desktop.connection.saveServerUrl(url), customOrigin)
  if (!pinnedCustom.saved || pinnedCustom.mode !== 'connect') {
    throw new Error('pinning a custom loopback was refused: ' + JSON.stringify(pinnedCustom))
  }
  window = (await waitForStatus(app, status => status.mode === 'connect' && status.targetUrl === customOrigin, 20_000)).window
  const switchOccupied = await window.evaluate(() => window.desktop.connection.switchMode())
  if (switchOccupied.switched) {
    throw new Error('switching to Smart while reuse is off and a loopback instance is live was accepted: ' + JSON.stringify(switchOccupied))
  }
  window = (await waitForStatus(app, status => status.mode === 'connect' && status.targetUrl === customOrigin, 20_000)).window
  console.log('✓ switching to Smart while reuse is off and a loopback instance occupies is refused')

  const enableReuse = await window.evaluate(() =>
    window.desktop.connection.setSmartRuntimes(['probe', 'bundled']))
  if (!enableReuse.saved || !enableReuse.smartRuntimes.includes('probe')) {
    throw new Error('re-enabling reuse in Connect mode was refused: ' + JSON.stringify(enableReuse))
  }
  const backToSmart = await window.evaluate(() => window.desktop.connection.switchMode())
  if (!backToSmart.switched || backToSmart.mode !== 'smart') {
    throw new Error('switching to Smart with reuse on was refused: ' + JSON.stringify(backToSmart))
  }
  window = (await waitForStatus(app, status => status.mode === 'probe' && status.targetUrl === probeOrigin, 20_000)).window
  await new Promise((resolve, reject) => customServer.close(error => error ? reject(error) : resolve()))
  await new Promise((resolve, reject) => probeServer.close(error => error ? reject(error) : resolve()))
  await window.reload().catch(() => {})
  recovered = await waitForStatus(app,
    status => status.mode === 'local' && typeof status.childPid === 'number' && status.targetUrl !== '',
    60_000)
  window = recovered.window
  const recoveryPid = recovered.status.childPid
  await window.waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })

  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/pid', String(recoveryPid), '/T', '/F']).catch(() => {})
  } else {
    process.kill(recoveryPid, 'SIGKILL')
  }
  recovered = await waitForStatus(app,
    status => status.mode === 'local' && typeof status.childPid === 'number' && status.childPid !== recoveryPid && status.targetUrl !== '',
    60_000)
  await recovered.window.waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  console.log('✓ exited managed runtime relaunched with a new PID (' + String(recovered.status.childPid) + ')')
} finally {
  await app?.close().catch(() => {})
  if (probeServer.listening) await new Promise(resolve => probeServer.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}
