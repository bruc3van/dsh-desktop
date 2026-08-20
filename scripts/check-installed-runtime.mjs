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
 *  5. Smart mode really binds a pinned local port, refuses to fall through
 *     when a non-dsh process holds it, and does not blame that process when
 *     command resolution failed before any child was spawned.
 * @module desktop/scripts/check-installed-runtime
 */

import { createServer } from 'node:http'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { inheritedValue, sanitizedElectronEnv } from './lib/electron-env.mjs'

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
 * A PATH prefix that publishes `node` but not `dsh`.
 *
 * npx detection spawns the found `node` without a shell, so Windows must
 * offer a real `node.exe` — a `.cmd` wrapper is found, then fails to start.
 * Prefer the directory this process is running from when it is dsh-free;
 * otherwise plant a node-only entry (hardlink, copy, or POSIX shim).
 */
function nodeOnlyPrefix() {
  const dir = dirname(process.execPath)
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh.bat'] : ['dsh']
  if (!names.some((name) => existsSync(join(dir, name)))) return dir
  const only = join(checkHome, 'node-only')
  mkdirSync(only, { recursive: true })
  if (process.platform === 'win32') {
    const target = join(only, 'node.exe')
    try { linkSync(process.execPath, target) }
    catch { copyFileSync(process.execPath, target) }
    return only
  }
  const shim = join(only, 'node')
  writeFileSync(shim, ['#!/bin/sh', 'exec "' + process.execPath + '" "$@"', ''].join('\n'))
  chmodSync(shim, 0o755)
  return only
}

const nodeOnlyDir = nodeOnlyPrefix()

/** Drop directories that themselves publish a `dsh`, so pathDsh:false cannot
 *  pick up the developer's real install. `node` is re-supplied by nodeOnlyDir. */
function pathWithoutDsh(pathValue) {
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh.bat'] : ['dsh']
  return pathValue.split(delimiter).filter((entry) => {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '') return false
    return !names.some((name) => existsSync(join(dir, name)))
  }).join(delimiter)
}

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

/**
 * Every launch records the main process's own output. A check that fails on a
 * window that never appeared has nothing else to go on: Playwright's timeout
 * carries an empty log, so without this the only report from a CI machine is
 * "firstWindow timed out". The launch PATH travels with it, because the
 * scenarios that strip `dsh` out of PATH are the ones worth reading it for.
 */
const logs = new WeakMap()
function attachLog(app, launchPath) {
  let text = ''
  const runner = app.process()
  runner.stdout?.on('data', chunk => { text += chunk.toString() })
  runner.stderr?.on('data', chunk => { text += chunk.toString() })
  const record = {
    text: () => text,
    path: () => launchPath,
    sawCrashLadder: () => /trying the next enabled runtime/.test(text)
      || /本地服务意外退出/.test(text)
      || /The local service exited; restarting/.test(text),
  }
  logs.set(app, record)
  return record
}

/** The recorder attached by launch(). */
function logFor(app) {
  return logs.get(app)
}

/**
 * What the main process itself says about its state. A window that never
 * arrives has three causes that look identical from outside — the process
 * quit, `whenReady` never resolved, or a window exists that Playwright never
 * surfaced as a page — and only the process can tell them apart. `live` is the
 * third case: the client did its job and the harness lost sight of it.
 */
async function mainProcessState(app) {
  const runner = app.process()
  if (runner.exitCode !== null || runner.signalCode !== null) {
    return {
      live: false,
      detail: 'electron exited (code ' + String(runner.exitCode) + ' / signal ' + String(runner.signalCode) + ')',
    }
  }
  try {
    const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
      ready: electronApp.isReady(),
      windows: BrowserWindow.getAllWindows().map(window => ({
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
        url: window.webContents.getURL(),
      })),
    }))
    return {
      live: state.ready && state.windows.some(window => !window.destroyed),
      detail: 'electron alive: ' + JSON.stringify(state),
    }
  } catch (error) {
    return { live: false, detail: 'electron alive, but the main process would not answer: ' + error.message }
  }
}

/**
 * How long Playwright may take to surface a window the main process already
 * has. Past this, waiting out the full firstWindow timeout only burns CI
 * minutes — the miss does not resolve later.
 */
const BLIND_ATTACH_GRACE_MS = 3_000
/**
 * Relaunches of a proven-healthy client that Playwright never attached to.
 * macos-15 misses roughly one launch in three; a single retry still fails
 * the job (this happened on npx-old: both attempts timed out with a live
 * window). Six attempts is ~0.1% per scenario at that rate, and with the
 * fail-fast below each miss costs ~3s rather than 30s.
 */
const BLIND_RELAUNCH_LIMIT = 6

/**
 * Wait for the window, and report what the main process said when it never
 * comes. Playwright's own message stops at "Timeout 30000ms exceeded".
 *
 * `blind` on the thrown error means the main process answered with a live,
 * undestroyed window: the client is up and the harness simply never got the
 * page. Only openApp() acts on that distinction.
 *
 * When that case is already observable, fail as soon as the grace period
 * elapses — do not sit on firstWindow's 30s timeout. Poll `app.windows()`
 * as well: Playwright may attach a page without the `window` event this
 * waiter is blocked on.
 */
async function firstWindow(app, timeoutMs = 30_000) {
  const started = Date.now()
  const pending = app.firstWindow({ timeout: timeoutMs })
  // If we throw early, the waiter is abandoned; swallow so it cannot
  // surface as an unhandled rejection after closeApp() tears the process down.
  pending.catch(() => {})

  let liveSince
  while (Date.now() - started < timeoutMs) {
    const attached = app.windows()[0]
    if (attached) return attached

    const state = await mainProcessState(app)
    if (state.live && app.windows().length === 0) {
      liveSince ??= Date.now()
      if (Date.now() - liveSince >= BLIND_ATTACH_GRACE_MS) {
        throw windowWaitFailure(app, Date.now() - started, new Error('Playwright did not attach to a live window'), state)
      }
    } else {
      liveSince = undefined
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  try {
    return await pending
  } catch (error) {
    throw windowWaitFailure(app, timeoutMs, error, await mainProcessState(app))
  }
}

function windowWaitFailure(app, waitedMs, error, state) {
  const record = logFor(app)
  const failure = new Error([
    'no window after ' + String(waitedMs) + 'ms: ' + error.message,
    state.detail,
    'playwright pages: ' + String(app.windows().length),
    'launch PATH: ' + (record?.path() ?? '(unrecorded)'),
    'main process output:',
    (record?.text() ?? '').trim() || '(nothing on stdout/stderr)',
  ].join('\n'))
  failure.blind = state.live
  return failure
}

/**
 * Close a run without letting the teardown outlive the check. `close()` waits
 * for the process to exit, and a run that failed before its window appeared is
 * exactly the state where it may never do so — which would turn a 30-second
 * assertion failure into a job-timeout with no output at all.
 */
async function closeApp(app) {
  if (app === undefined) return
  // Every scenario closes through the same module-level `app`, so this is also
  // handed the PREVIOUS run's handle whenever a scenario throws before its own
  // assignment lands. Playwright disposes a closed application, and both
  // close() and process() throw on the disposed object — a teardown that let
  // that through would replace the real failure with a TypeError.
  let closed
  try {
    closed = app.close().then(() => true, () => true)
  } catch {
    return
  }
  const timedOut = new Promise(resolve => { setTimeout(() => { resolve(false) }, 15_000).unref() })
  if (await Promise.race([closed, timedOut])) return
  console.warn('[check] the app did not close within 15s; killing it')
  try { app.process().kill('SIGKILL') } catch { /* already gone */ }
}

/** One Electron run against its own homes, with the fixture ahead on PATH. */
async function launch(name, extraEnv = {}, {
  pathDsh = true,
  settings = { connectionMode: 'smart' },
} = {}) {
  const home = join(checkHome, name)
  mkdirSync(join(home, 'desktop'), { recursive: true })
  writeFileSync(join(home, 'desktop', 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  // The shared sanitizer drops ELECTRON_RUN_AS_NODE and every DSH_DESKTOP_* /
  // DSH_FIXTURE_* knob — a leftover diagnostic from a previous packaged run
  // must not skip PATH detection or pin a command this check did not ask for.
  // PATH and the npm cache go on top of it, because this check owns both:
  // spreading process.env drops the case-insensitivity Windows env vars have
  // (the system spells the search path `Path`, so a literal `PATH` override
  // would leave the inherited `Path` beside it and libuv's case-insensitive
  // deduplication could keep either), and the same trap applies to
  // `npm_config_cache` vs `NPM_CONFIG_CACHE`. Strip every casing here, then
  // set exactly one spelling below.
  const inheritedPath = inheritedValue('PATH')
  const env = sanitizedElectronEnv(extraEnv, ['PATH', 'NPM_CONFIG_CACHE'])
  env.DSH_HOME = join(home, 'dsh')
  env.DSH_DESKTOP_HOME = join(home, 'desktop')
  // Without the fixture dir the run has no `dsh` on PATH at all — the state
  // every user who followed `npx @deepseek-ai/dsh web` is actually in.
  env.PATH = pathDsh
    ? binDir + delimiter + inheritedPath
    : nodeOnlyDir + delimiter + pathWithoutDsh(inheritedPath)
  if (!Object.keys(env).some((key) => key.toUpperCase() === 'NPM_CONFIG_CACHE')) {
    // Isolate every launch from the default `%LOCALAPPDATA%\npm-cache`. A
    // machine that has run `npx @deepseek-ai/dsh` would otherwise offer that
    // cache as the npx rung, including the "failed PATH → bundled" case.
    env.npm_config_cache = join(home, 'empty-npm-cache')
  }
  const app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env,
  })
  attachLog(app, env.PATH)
  return app
}

/**
 * Start a run and hand back its window.
 *
 * Relaunch only for the case the dump above can prove: the client is ready
 * with a live window, and Playwright never surfaced it as a page. That has
 * been seen on GitHub's macos-15 runners (playwright-core 1.62.1) roughly one
 * launch in three, always on the launches where the runtime reaches readiness
 * soonest after the window is created; it has never reproduced locally, under
 * CPU load or with the target already live. Every assertion still runs against
 * the relaunched app, and the retry cannot hide a client that failed to open a
 * window — that failure reports `live: false` and is raised on the first try.
 */
async function openApp(name, extraEnv = {}, options = {}) {
  for (let attempt = 1; ; attempt++) {
    // The same homes deliberately: a scenario that reads its own settings file
    // back would otherwise be pointed at a directory the retry did not write.
    const app = await launch(name, extraEnv, options)
    try {
      await firstWindow(app)
      return app
    } catch (error) {
      await closeApp(app)
      if (error.blind !== true || attempt >= BLIND_RELAUNCH_LIMIT) throw error
      console.warn('[check] ' + error.message)
      console.warn('[check] the client was up with a live window and Playwright never attached; relaunching ' + name + ' (attempt ' + String(attempt + 1) + ' of ' + String(BLIND_RELAUNCH_LIMIT) + ')')
    }
  }
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
  app = await openApp('prefer', { DSH_DESKTOP_SKIP_PROBE: '1' })
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
  await closeApp(app)
}
if (startedPid !== undefined) {
  // The client owns what it started: quitting must take the runtime with it,
  // whether that runtime was bundled or the user's own.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && alive(startedPid)) await new Promise(resolve => setTimeout(resolve, 100))
  check('quitting stops the runtime the client started', !alive(startedPid), 'PID ' + String(startedPid))
}

// 1b. Toggling Smart-mode sources after the installed child is ready must
//     respawn from the new set, not walk the crash ladder (which would reject
//     PATH for the rest of the session and spend a retry).
try {
  app = await openApp('switch-ready', { DSH_DESKTOP_SKIP_PROBE: '1' })
  const log = logFor(app)
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
  await closeApp(app)
}

// 1c. The same toggle while the installed child is still booting must not
//     mark PATH rejected — lastSource is already `installed` and wasReady is
//     still false, which is exactly the crash-ladder's "give up on PATH" case.
try {
  app = await openApp('switch-boot', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_FIXTURE_DELAY_MS: '4000' })
  const log = logFor(app)
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
  await closeApp(app)
}

// 2. An installed dsh that cannot start falls back to the bundled runtime.
//    The switch is asserted from the main process's own log: a failing runtime
//    can be replaced faster than the status bridge can be polled.
try {
  app = await openApp('fallback', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_FIXTURE_FAIL: '1' })
  const record = logFor(app)
  const fellBack = await waitForStatus(app, s => s.runtimeSource === 'bundled')
  check('the failing installed runtime is tried first', /dsh runtime: installed/.test(record.text()),
    record.text().match(/dsh runtime: \w+/g)?.join(' → '))
  check('a failed installed runtime falls back to the bundled one',
    /trying the next enabled runtime/.test(record.text()) && fellBack.runtimeSource === 'bundled')
  check('the rejected runtime is no longer offered', fellBack.installedDshVersion === undefined, fellBack.installedDshVersion)
} finally {
  await closeApp(app)
}

// 2b. A Smart-mode child must really bind the configured local port. Reserve
//     an ephemeral port first so the check does not depend on a magic number.
const portAllocator = createServer()
await new Promise((resolve, reject) => {
  portAllocator.once('error', reject)
  portAllocator.listen(0, '127.0.0.1', resolve)
})
const allocatedAddress = portAllocator.address()
if (typeof allocatedAddress !== 'object' || allocatedAddress === null) throw new Error('port allocator did not bind')
const smartPinnedPort = allocatedAddress.port
await new Promise(resolve => portAllocator.close(resolve))
try {
  app = await openApp('smart-pinned', { DSH_DESKTOP_SKIP_PROBE: '1' }, {
    settings: { connectionMode: 'smart', localWebPort: smartPinnedPort },
  })
  const pinned = await waitForStatus(app, s => s.targetUrl !== '')
  check('Smart mode starts the selected runtime on the pinned port',
    pinned.runtimeSource === 'installed'
      && pinned.targetUrl === 'http://127.0.0.1:' + String(smartPinnedPort),
    JSON.stringify({ source: pinned.runtimeSource, targetUrl: pinned.targetUrl }))
} finally {
  await closeApp(app)
}

// 2c. A non-dsh listener on the pinned port is a bind failure shared by every
//     runtime source, so the client must show the port problem and stop rather
//     than silently falling through to bundled.
const occupiedServer = createServer((_req, res) => { res.end('not dsh') })
await new Promise((resolve, reject) => {
  occupiedServer.once('error', reject)
  occupiedServer.listen(0, '127.0.0.1', resolve)
})
const occupiedAddress = occupiedServer.address()
if (typeof occupiedAddress !== 'object' || occupiedAddress === null) throw new Error('occupied-port fixture did not bind')
const occupiedPort = occupiedAddress.port
try {
  app = await openApp('smart-port-held', { DSH_DESKTOP_SKIP_PROBE: '1' }, {
    settings: { connectionMode: 'smart', localWebPort: occupiedPort },
  })
  const record = logFor(app)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !/pinned port .* is still held after a failed spawn/.test(record.text())) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  check('a non-dsh listener on the pinned port stops runtime fallback',
    /dsh runtime: installed/.test(record.text())
      && /pinned port .* is still held after a failed spawn/.test(record.text())
      && !/dsh runtime: bundled/.test(record.text()),
    record.text().match(/dsh runtime: \w+|pinned port .*|trying the next enabled runtime/g)?.join(' → '))
} finally {
  await closeApp(app)
}

// 2d. If source resolution itself fails, no child attempted the bind. A
//     coincidental listener on the chosen port must not replace the actual
//     configuration error with the occupied-port surface.
try {
  app = await openApp('pre-spawn-port-held', { DSH_DESKTOP_SKIP_PROBE: '1' }, {
    pathDsh: false,
    settings: { connectionMode: 'smart', localWebPort: occupiedPort, smartRuntimes: ['probe'] },
  })
  const failed = await waitForStatus(app, s => typeof s.lastError === 'string')
  const record = logFor(app)
  check('a pre-spawn failure keeps its real error when the pinned port is occupied',
    /No enabled Smart-mode runtime|没有启用可启动的运行时/.test(failed.lastError)
      && !/pinned port .* is still held after a failed spawn/.test(record.text()),
    JSON.stringify({ lastError: failed.lastError, log: record.text().match(/pinned port .*|failed to start[^\n]*/g) }))
} finally {
  await closeApp(app)
  await new Promise(resolve => occupiedServer.close(resolve))
}

// 3. With nothing on PATH — the state `npx @deepseek-ai/dsh web` leaves users
//    in, on macOS and Windows alike — the npx cache is found and preferred.
try {
  const home = join(checkHome, 'npx')
  mkdirSync(home, { recursive: true })
  const cacheRoot = fixtureNpxCache(home, '9.9.9-npxfake')
  app = await openApp('npx', { DSH_DESKTOP_SKIP_PROBE: '1', npm_config_cache: cacheRoot }, { pathDsh: false })
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
  await closeApp(app)
}

// 3b. A cache OLDER than the bundled runtime stays preferred — it is the
//     user's own runtime — but the status carries the non-blocking note, so
//     the connection surfaces can say "re-run npx to refresh".
try {
  const home = join(checkHome, 'npx-old')
  mkdirSync(home, { recursive: true })
  const cacheRoot = fixtureNpxCache(home, '0.0.1-npxold')
  app = await openApp('npx-old', { DSH_DESKTOP_SKIP_PROBE: '1', npm_config_cache: cacheRoot }, { pathDsh: false })
  const status = await waitForStatus(app, s => s.mode === 'local' && s.runtimeSource !== undefined)
  check('an outdated npx cache is still preferred over the bundled runtime',
    status.runtimeSource === 'npx', status.runtimeSource)
  check('its real version is still the one reported',
    status.installedDshVersion === '0.0.1-npxold', status.installedDshVersion)
  check('and the lag behind the bundled runtime is flagged',
    status.npxCacheOutdated === true, status.npxCacheOutdated)
} finally {
  await closeApp(app)
}

// 4. Saving the default probe address must NOT pin it, and a pinned address
//    that stops answering must have a way back to a client-started runtime.
try {
  const probeUrl = 'http://127.0.0.1:59991'
  const settingsFile = join(checkHome, 'pin', 'desktop', 'settings.json')
  app = await openApp('pin', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_PROBE_URL: probeUrl })
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
  await closeApp(app)
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
  app = await openApp('offer', { DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_PROBE_URL: probeOrigin })
  const ready = await waitForStatus(app, s => s.mode === 'local' && s.targetUrl !== '')
  const offered = await app.windows()[0].evaluate(() => window.desktop.connection.probeLocal())
  check('a live instance on the default port is offered', offered.url === probeOrigin, JSON.stringify(offered))
  check('the offer is not the address already in use', offered.url !== ready.targetUrl, ready.targetUrl)

  await new Promise(resolve => probeServer.close(resolve))
  const gone = await app.windows()[0].evaluate(() => window.desktop.connection.probeLocal())
  check('nothing is offered once that instance is gone', gone.url === null, JSON.stringify(gone))
} finally {
  await closeApp(app)
  if (probeServer.listening) await new Promise(resolve => probeServer.close(resolve))
}

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('\nAll installed-runtime checks passed.')
