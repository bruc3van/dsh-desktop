/**
 * Installed-runtime preference integration check.
 *
 * Smart mode prefers, in order: an official instance already running on this
 * machine, a dsh the user installed themselves, then the bundled runtime. This
 * covers the middle rung and its safety net, against a synthetic `dsh` on PATH
 * so the result does not depend on what the developer has installed:
 *
 *  1. a working installed dsh is detected and preferred over the bundled one;
 *  2. an installed dsh that cannot start falls back to the bundled runtime
 *     instead of spending the recovery budget on the same failure;
 *  3. switching Smart-mode sources while a local child is running (ready, or
 *     still booting) respawns from the new set without treating the stop as a
 *     crash — PATH/npx stay eligible, and the retry budget is not spent;
 *  4. the connection surfaces can see a live instance on the default port, so
 *     switching to it is one click rather than a typed address.
 * @module desktop/scripts/check-installed-runtime
 */

import { createServer } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(APP_DIR, 'scripts', 'fixtures', 'fake-dsh.mjs')
const FIXTURE_VERSION = '0.9.9-fake'

const checkHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-installed-'))
// Registered rather than trailing: a check that throws partway through must
// still take its sandbox with it.
process.on('exit', () => { rmSync(checkHome, { recursive: true, force: true }) })
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}

/** Publish the fixture on PATH under the name a real installation would use. */
function fixtureBinDir() {
  const binDir = join(checkHome, 'bin')
  mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'dsh.cmd'),
      ['@echo off', '"' + process.execPath + '" "' + FIXTURE + '" %*', ''].join('\r\n'))
    return binDir
  }
  const shim = join(binDir, 'dsh')
  writeFileSync(shim, ['#!/bin/sh', 'exec "' + process.execPath + '" "' + FIXTURE + '" "$@"', ''].join('\n'))
  chmodSync(shim, 0o755)
  return binDir
}

const binDir = fixtureBinDir()

/**
 * A stand-in for what `npx @deepseek-ai/dsh web` leaves behind — the runtime
 * the OFFICIAL instruction produces on both macOS and Windows, which puts
 * nothing on PATH. Returns the cache root to pass as npm_config_cache.
 *
 * A decoy entry is planted beside it: same cache layout, but a package.json
 * naming `@deepseek-ai/dsh-root` (what a source checkout carries). The client
 * must reject it on identity rather than launch whatever sits at that path.
 */
function fixtureNpxCache(home, version) {
  const root = join(home, 'npm-cache')
  const real = join(root, '_npx', 'aaaa1111', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(real, 'lib'), { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  }))
  writeFileSync(join(real, 'lib', 'bin.js'), 'import ' + JSON.stringify(pathToFileURL(FIXTURE).href) + '\n')

  const decoy = join(root, '_npx', 'bbbb2222', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(decoy, 'lib'), { recursive: true })
  writeFileSync(join(decoy, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    version: '0.0.1',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  }))
  writeFileSync(join(decoy, 'lib', 'bin.js'), 'process.exit(3)\n')
  // Newer than the real entry: if identity were not checked, "most recently
  // touched wins" would select this one.
  const later = new Date(Date.now() + 60_000)
  utimesSync(decoy, later, later)
  return root
}

/** One Electron run against its own homes, with the fixture ahead on PATH. */
async function launch(name, extraEnv = {}, { pathDsh = true } = {}) {
  const home = join(checkHome, name)
  mkdirSync(join(home, 'desktop'), { recursive: true })
  writeFileSync(join(home, 'desktop', 'settings.json'), JSON.stringify({ connectionMode: 'smart' }, null, 2) + '\n')
  // Spreading process.env drops the case-insensitivity Windows env vars have:
  // the system spells the search path `Path`, so a literal `PATH` override
  // would leave the inherited `Path` beside it and libuv's case-insensitive
  // deduplication could keep either. Strip every casing first, then set one.
  const env = {}
  let inheritedPath = ''
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    if (upper === 'ELECTRON_RUN_AS_NODE') continue
    if (upper === 'PATH') {
      inheritedPath = value ?? ''
      continue
    }
    // A leftover diagnostic from a previous packaged run must not skip PATH
    // detection or pin a command this check did not ask for.
    if (upper === 'DSH_DESKTOP_SKIP_INSTALLED_DSH') continue
    if (upper === 'DSH_DESKTOP_DSH') continue
    if (upper === 'DSH_FIXTURE_FAIL') continue
    if (upper === 'DSH_FIXTURE_DELAY_MS') continue
    env[key] = value
  }
  Object.assign(env, extraEnv)
  env.DSH_HOME = join(home, 'dsh')
  env.DSH_DESKTOP_HOME = join(home, 'desktop')
  // Without the fixture dir the run has no `dsh` on PATH at all — the state
  // every user who followed `npx @deepseek-ai/dsh web` is actually in.
  env.PATH = pathDsh ? binDir + delimiter + inheritedPath : inheritedPath
  return electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env,
  })
}

/**
 * Evaluate in the main window, tolerating a navigation in flight. Saving an
 * address reconnects, so the context a call lands in can be torn down under it.
 */
async function evaluateStable(app, fn, arg, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      return await app.windows()[0].evaluate(fn, arg)
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  throw last ?? new Error('evaluate timed out')
}

/** Poll the desktop bridge until a status satisfies the predicate. */
async function waitForStatus(app, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await app.windows()[0]?.evaluate(() => window.desktop?.connection.getStatus())
      if (last && predicate(last)) return last
    } catch { /* the window swaps documents between reconnection attempts */ }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('status condition timed out: ' + JSON.stringify(last))
}

/** Whether a pid is still live. Signal 0 only probes; it delivers nothing. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// 1. A working installed dsh wins over the bundled runtime, and does not
//    outlive the client that started it.
let app
let startedPid
try {
  app = await launch('prefer', { DSH_DESKTOP_SKIP_PROBE: '1' })
  await app.firstWindow()
  const status = await waitForStatus(app, s => s.mode === 'local' && s.runtimeSource !== undefined)
  check('installed dsh is preferred over the bundled runtime', status.runtimeSource === 'installed', status.runtimeSource)
  check('the detected version is reported', status.installedDshVersion === FIXTURE_VERSION, status.installedDshVersion)
  const ready = await waitForStatus(app, s => typeof s.childPid === 'number' && s.targetUrl !== '')
  startedPid = ready.childPid
  check('the installed runtime serves the window', ready.targetUrl.startsWith('http://127.0.0.1:'), ready.targetUrl)
  // The explicit `null` is the page-function argument: Playwright's signature
  // is (pageFunction, arg, options), so passing options second silently makes
  // them the argument and leaves the default timeout in force.
  await app.windows()[0].waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  check('the window loads the installed runtime\'s Web UI', true, 'Installed Harness Fixture')
} finally {
  await app?.close().catch(() => {})
}
if (startedPid !== undefined) {
  // The client owns what it started: quitting must take the runtime with it,
  // whether that runtime was bundled or the user's own.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && alive(startedPid)) await new Promise(resolve => setTimeout(resolve, 100))
  check('quitting stops the runtime the client started', !alive(startedPid), 'PID ' + String(startedPid))
}

function attachLog(app) {
  let log = ''
  const runner = app.process()
  runner.stdout?.on('data', chunk => { log += chunk.toString() })
  runner.stderr?.on('data', chunk => { log += chunk.toString() })
  return {
    text: () => log,
    sawCrashLadder: () => /trying the next enabled runtime/.test(log)
      || /本地服务意外退出/.test(log)
      || /The local service exited; restarting/.test(log),
  }
}

// 1b. Toggling Smart-mode sources after the installed child is ready must
//     respawn from the new set, not walk the crash ladder (which would reject
//     PATH for the rest of the session and spend a retry).
try {
  app = await launch('switch-ready', { DSH_DESKTOP_SKIP_PROBE: '1' })
  const log = attachLog(app)
  await app.firstWindow()
  await waitForStatus(app, s => s.runtimeSource === 'installed' && typeof s.childPid === 'number' && s.targetUrl !== '')
  await app.windows()[0].waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  const switched = await evaluateStable(app, () => window.desktop.connection.setSmartRuntimes(['bundled']))
  check('a ready-child source save is accepted', switched.saved === true
    && JSON.stringify(switched.smartRuntimes) === JSON.stringify(['bundled']), JSON.stringify(switched))
  const bundled = await waitForStatus(app, s => s.runtimeSource === 'bundled' && s.targetUrl !== '')
  check('the ready child is replaced by the bundled runtime', bundled.runtimeSource === 'bundled', bundled.runtimeSource)
  check('that stop is not treated as a crash', !log.sawCrashLadder(), log.text().match(/dsh runtime: \w+|trying the next|意外退出|exited; restarting/g)?.join(' → '))
  const restored = await evaluateStable(app,
    () => window.desktop.connection.setSmartRuntimes(['probe', 'installed', 'npx', 'bundled']))
  check('re-enabling every source is accepted', restored.saved === true, JSON.stringify(restored))
  const back = await waitForStatus(app, s => s.runtimeSource === 'installed' && s.targetUrl !== '')
  check('PATH is still eligible after the toggle', back.runtimeSource === 'installed', back.runtimeSource)
} finally {
  await app?.close().catch(() => {})
}

// 1c. The same toggle while the installed child is still booting must not
//     mark PATH rejected — lastSource is already `installed` and wasReady is
//     still false, which is exactly the crash-ladder's "give up on PATH" case.
try {
  app = await launch('switch-boot', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_FIXTURE_DELAY_MS: '4000' })
  const log = attachLog(app)
  await app.firstWindow()
  const spawnedDeadline = Date.now() + 15_000
  while (Date.now() < spawnedDeadline && !/dsh runtime: installed/.test(log.text())) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  check('the installed runtime was spawned before the toggle',
    /dsh runtime: installed/.test(log.text()), log.text().match(/dsh runtime: \w+/g)?.join(' → '))
  const switched = await evaluateStable(app, () => window.desktop.connection.setSmartRuntimes(['bundled']))
  check('a booting-child source save is accepted', switched.saved === true
    && JSON.stringify(switched.smartRuntimes) === JSON.stringify(['bundled']), JSON.stringify(switched))
  const bundled = await waitForStatus(app, s => s.runtimeSource === 'bundled' && s.targetUrl !== '', 60_000)
  check('the booting child is replaced by the bundled runtime', bundled.runtimeSource === 'bundled', bundled.runtimeSource)
  check('a stop before readiness does not reject PATH', !log.sawCrashLadder(), log.text().match(/dsh runtime: \w+|trying the next|意外退出|exited; restarting/g)?.join(' → '))
} finally {
  await app?.close().catch(() => {})
}

// 2. An installed dsh that cannot start falls back to the bundled runtime.
//    The switch is asserted from the main process's own log: a failing runtime
//    can be replaced faster than the status bridge can be polled.
try {
  app = await launch('fallback', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_FIXTURE_FAIL: '1' })
  let log = ''
  const runner = app.process()
  runner.stdout?.on('data', chunk => { log += chunk.toString() })
  runner.stderr?.on('data', chunk => { log += chunk.toString() })
  await app.firstWindow()
  const fellBack = await waitForStatus(app, s => s.runtimeSource === 'bundled')
  check('the failing installed runtime is tried first', /dsh runtime: installed/.test(log),
    log.match(/dsh runtime: \w+/g)?.join(' → '))
  check('a failed installed runtime falls back to the bundled one',
    /trying the next enabled runtime/.test(log) && fellBack.runtimeSource === 'bundled')
  check('the rejected runtime is no longer offered', fellBack.installedDshVersion === undefined, fellBack.installedDshVersion)
} finally {
  await app?.close().catch(() => {})
}

// 3. With nothing on PATH — the state `npx @deepseek-ai/dsh web` leaves users
//    in, on macOS and Windows alike — the npx cache is found and preferred.
try {
  const home = join(checkHome, 'npx')
  mkdirSync(home, { recursive: true })
  const cacheRoot = fixtureNpxCache(home, '9.9.9-npxfake')
  app = await launch('npx', { DSH_DESKTOP_SKIP_PROBE: '1', npm_config_cache: cacheRoot }, { pathDsh: false })
  await app.firstWindow()
  const status = await waitForStatus(app, s => s.mode === 'local' && s.runtimeSource !== undefined)
  check('an npx-cached dsh is used when PATH has none', status.runtimeSource === 'npx', status.runtimeSource)
  check('the cached package\'s real version is reported',
    status.installedDshVersion === '9.9.9-npxfake', status.installedDshVersion)
  check('a cache newer than the bundled runtime is not flagged',
    status.npxCacheOutdated === undefined, status.npxCacheOutdated)
  const ready = await waitForStatus(app, s => typeof s.childPid === 'number' && s.targetUrl !== '')
  check('the cached runtime serves the window', ready.targetUrl.startsWith('http://127.0.0.1:'), ready.targetUrl)
  // The decoy is newer, so reaching the fixture page proves identity was
  // checked rather than the most recent path being launched blindly.
  await app.windows()[0].waitForFunction(() => document.title === 'Installed Harness Fixture', null, { timeout: 20_000 })
  check('a cache entry that is not @deepseek-ai/dsh is rejected', true, 'decoy @deepseek-ai/dsh-root ignored')
} finally {
  await app?.close().catch(() => {})
}

// 3b. A cache OLDER than the bundled runtime stays preferred — it is the
//     user's own runtime — but the status carries the non-blocking note, so
//     the connection surfaces can say "re-run npx to refresh".
try {
  const home = join(checkHome, 'npx-old')
  mkdirSync(home, { recursive: true })
  const cacheRoot = fixtureNpxCache(home, '0.0.1-npxold')
  app = await launch('npx-old', { DSH_DESKTOP_SKIP_PROBE: '1', npm_config_cache: cacheRoot }, { pathDsh: false })
  await app.firstWindow()
  const status = await waitForStatus(app, s => s.mode === 'local' && s.runtimeSource !== undefined)
  check('an outdated npx cache is still preferred over the bundled runtime',
    status.runtimeSource === 'npx', status.runtimeSource)
  check('its real version is still the one reported',
    status.installedDshVersion === '0.0.1-npxold', status.installedDshVersion)
  check('and the lag behind the bundled runtime is flagged',
    status.npxCacheOutdated === true, status.npxCacheOutdated)
} finally {
  await app?.close().catch(() => {})
}

// 4. Saving the default probe address must NOT pin it, and a pinned address
//    that stops answering must have a way back to a client-started runtime.
try {
  const probeUrl = 'http://127.0.0.1:59991'
  const settingsFile = join(checkHome, 'pin', 'desktop', 'settings.json')
  app = await launch('pin', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_PROBE_URL: probeUrl })
  await app.firstWindow()
  await waitForStatus(app, s => s.mode === 'local' && s.targetUrl !== '')

  // The default probe address is what Smart mode already prefers; pinning it
  // would only cost the fallback when that instance goes away.
  const savedDefault = await evaluateStable(app,
    url => window.desktop.connection.saveServerUrl(url), probeUrl)
  check('saving the default probe address stays in Smart mode',
    savedDefault.saved === true && savedDefault.mode === 'smart', JSON.stringify(savedDefault))
  check('and Smart mode is what gets persisted',
    JSON.parse(readFileSync(settingsFile, 'utf8')).connectionMode === 'smart',
    readFileSync(settingsFile, 'utf8').replace(/\s+/g, ' '))

  // Any other address is a deliberate pin and still behaves as one. The save
  // above reconnected, so let the window settle before driving it again.
  await waitForStatus(app, s => s.mode === 'local' && s.targetUrl !== '')
  const dead = 'http://127.0.0.1:59992'
  const savedOther = await evaluateStable(app,
    url => window.desktop.connection.saveServerUrl(url), dead)
  check('saving any other address still pins it',
    savedOther.saved === true && savedOther.mode === 'connect', JSON.stringify(savedOther))
  const pinned = await waitForStatus(app, s => s.selectedMode === 'connect')
  check('the pinned address is the active selection', pinned.savedServerUrl === dead, pinned.savedServerUrl)

  // That address answers nothing, so the failure surface owns the window — and
  // must offer the way out rather than stranding the user there.
  const offered = await app.windows()[0].waitForFunction(
    () => document.getElementById('error-use-smart')?.textContent ?? null, null, { timeout: 30_000 })
  // The surface follows the OS locale, so both spellings are correct here.
  const label = await offered.jsonValue()
  check('a pinned failure offers the escape to Smart mode',
    label === '切换到智能模式' || label === 'Switch to Smart mode', label)
  await evaluateStable(app, () => { window.desktop.local.useSmart() })
  const recovered = await waitForStatus(app, s => s.mode === 'local' && s.targetUrl !== '', 60_000)
  check('taking it recovers onto a client-started runtime',
    recovered.runtimeSource === 'installed', recovered.runtimeSource)
  check('and the address is kept for one-click return',
    recovered.savedServerUrl === dead && recovered.canSwitch === true, recovered.savedServerUrl)
} finally {
  await app?.close().catch(() => {})
}

// 5. A live instance on the default port is offered to the connection surfaces.
const probeServer = createServer((req, res) => {
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probe Offer Fixture</title></head><body></body></html>')
})
await new Promise((resolve, reject) => { probeServer.once('error', reject); probeServer.listen(0, '127.0.0.1', resolve) })
const probeOrigin = 'http://127.0.0.1:' + String(probeServer.address().port)
try {
  // SKIP_PROBE keeps the client on its own runtime, which is exactly the state
  // where the address is worth offering: a live instance the client is not on.
  app = await launch('offer', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_PROBE_URL: probeOrigin })
  await app.firstWindow()
  const ready = await waitForStatus(app, s => s.mode === 'local' && s.targetUrl !== '')
  const offered = await app.windows()[0].evaluate(() => window.desktop.connection.probeLocal())
  check('a live instance on the default port is offered', offered.url === probeOrigin, JSON.stringify(offered))
  check('the offer is not the address already in use', offered.url !== ready.targetUrl, ready.targetUrl)

  await new Promise(resolve => probeServer.close(resolve))
  const gone = await app.windows()[0].evaluate(() => window.desktop.connection.probeLocal())
  check('nothing is offered once that instance is gone', gone.url === null, JSON.stringify(gone))
} finally {
  await app?.close().catch(() => {})
  if (probeServer.listening) await new Promise(resolve => probeServer.close(resolve))
}

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('\nAll installed-runtime checks passed.')
