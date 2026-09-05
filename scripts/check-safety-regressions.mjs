/** Behavioral regression fixtures for bridge trust, process disposal, logging and updater recovery. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const work = fs.mkdtempSync(join(tmpdir(), 'dsh-safety-'))
function load(file, mocks = {}, globals = {}) {
  const code = buildSync({ entryPoints: [join(root, 'src/main', file + '.ts')], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require: id => mocks[id] ?? require(id),
    process, console, Buffer, URL, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ...globals })
  return module.exports
}
const turn = () => new Promise(resolve => setImmediate(resolve))
try {
  const { createBridgePolicy } = load('bridge-policy')
  const local = 'http://127.0.0.1:49123'
  let target = local
  let owned = false
  const contents = { getURL: () => local, isDestroyed: () => false }
  const window = { webContents: contents, isDestroyed: () => false }
  const bridge = createBridgePolicy({ getMainWindow: () => window, getLoadingDocumentActive: () => false,
    getErrorDocumentActive: () => false, currentTarget: () => target, isClientOwnedOrigin: origin => owned && origin === target })
  const event = { sender: contents, senderFrame: { url: local, parent: null } }
  assert.equal(bridge.bridgeCaller(event).remote, true)
  assert.equal(bridge.mainWindowShowsRemote(), true)
  for (const permission of ['media', 'clipboard-read', 'fileSystem']) assert.equal(bridge.permissionGranted(contents, permission, local, true), false)
  bridge.rememberSmartBridgeHandoff()
  target = 'http://127.0.0.1:49124'
  assert.equal(bridge.bridgeCaller(event).trusted, false, 'Connect page must not gain handoff privileges')
  target = local
  owned = true
  assert.equal(bridge.bridgeCaller(event).remote, false)
  bridge.rememberSmartBridgeHandoff()
  target = undefined
  assert.equal(bridge.bridgeCaller(event).trusted, true)
  assert.equal(bridge.mainWindowShowsRemote(), true, 'old page must not receive privileged push state after ownership changes')
  bridge.releaseSmartBridgeHandoff('data:text/html,loading')
  assert.equal(bridge.bridgeCaller(event).trusted, false)
  console.log('✓ Connect loopback stays gated across permissions, push and handoff; owned UI keeps its bridge')

  const { createQuitCoordinator } = load('quit-coordinator')
  let release, begins = 0, quits = 0, prevented = 0
  const pending = new Promise(resolve => { release = resolve })
  const quit = createQuitCoordinator({ begin: () => begins++, stop: () => pending,
    quit: () => quits++, failed: error => { throw error } })
  quit({ preventDefault: () => prevented++ }); quit({ preventDefault: () => prevented++ })
  assert.equal(prevented, 2); assert.equal(begins, 1); assert.equal(quits, 0)
  release(); await turn()
  quit({ preventDefault: () => prevented++ })
  assert.equal(quits, 1); assert.equal(prevented, 2)
  let timedOut = false
  const bounded = createQuitCoordinator({ begin() {}, stop: () => new Promise(() => {}),
    quit() {}, failed: () => { timedOut = true }, timeoutMs: 5 })
  bounded({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(timedOut, true)
  console.log('✓ repeated quit waits for one shutdown, with a bounded failure path')

  const { createRuntimeLineReader, sanitizeRuntimeOutput } = load('runtime-output')
  const lines = []
  const reader = createRuntimeLineReader(line => lines.push(sanitizeRuntimeOutput(line)), 64)
  reader.write(Buffer.from('pass')); reader.write(Buffer.from('word=synthetic-secret\n'))
  reader.write(Buffer.from('token=')); reader.write(Buffer.from('x'.repeat(128)))
  reader.write(Buffer.from('trailing-sensitive-value\nnormal\n'))
  reader.end()
  assert.equal(lines.some(line => line.includes('synthetic-secret') || line.includes('trailing-sensitive-value')), false)
  assert.equal(lines.at(-1), 'normal')
  assert.equal(lines.length, 3)
  console.log('✓ split credentials are redacted and oversized lines are omitted without leaking their suffix')

  const lock = load('runtime-lock')
  const invalid = join(work, 'file-not-directory'); fs.writeFileSync(invalid, 'fixture')
  assert.throws(() => lock.writeRuntimeLock(invalid, { childPid: 42, startedAt: 1, desktopPid: 1 }))
  let child, taskkills = 0, directKills = 0, writes = 0, failure = true
  const managedHome = join(work, 'managed'); fs.mkdirSync(managedHome)
  const fakeProcess = Object.create(process)
  Object.defineProperty(fakeProcess, 'platform', { value: 'win32' })
  const { WebUiManager } = load('web-ui-manager', {
    'node:fs': { ...fs, writeFileSync: (...args) => {
      writes++
      if (failure && writes > 1) throw new Error('synthetic disk full')
      return fs.writeFileSync(...args)
    } },
    'node:child_process': { spawn(command) {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
      proc.pid = 4242; proc.exitCode = null; proc.signalCode = null
      proc.kill = () => { directKills++; return true }
      if (command === 'taskkill') {
        taskkills++
        queueMicrotask(() => proc.emit('exit', 1, null))
      } else child = proc
      return proc
    } },
  }, { process: fakeProcess })
  const manager = new WebUiManager({ home: () => managedHome, resolveCommand: () => ({ command: 'fixture', args: [], source: 'bundled', label: 'fixture' }),
    prepareCommand: () => ({ args: [], env: {} }), waitForReady: async () => {}, onLog() {}, onExit() {} })
  await assert.rejects(manager.ready(), /disk full/)
  await turn(); await turn()
  assert.equal(taskkills, 2); assert.equal(directKills, 0)
  assert.equal(lock.readRuntimeLock(managedHome).launchPending, true)
  assert.equal(manager.pid(), child.pid)
  manager.clearFatalError()
  await assert.rejects(manager.ready(), /Could not stop/, 'manual retry cannot clear unconfirmed tree disposal')
  const { createRuntimeSurvivor } = load('runtime-survivor')
  const survivor = createRuntimeSurvivor({ childHome: () => managedHome, managedPid: () => undefined,
    enabledSmartRuntimes: () => ['bundled'], probeWebUi: async () => undefined, connection: () => ({ adopted: false }) })
  assert.equal((await survivor.adoptOrClearSurvivingRuntime()).kind, 'blocked')
  failure = false
  console.log('✓ failed child-record write and failed Windows tree kill preserve a blocking reservation; wrapper is never killed alone')

  let installer
  const { DesktopUpdater, pruneOldInstallers } = load('updater', { electron: { shell: {} }, 'node:child_process': {
    spawn() { installer = new EventEmitter(); installer.unref = () => {}; queueMicrotask(() => installer.emit('spawn')); return installer },
  } })
  const updater = new DesktopUpdater({ currentVersion: '1.0.0', feedUrl: 'https://example.invalid', platform: 'win32', arch: 'x64',
    packaged: true, downloadDir: work, loadPersistence: () => ({}), savePersistence() {}, dryRun: false })
  const payload = Buffer.from('inert synthetic installer')
  updater.info = { availableVersion: '2.0.0', fileName: 'dsh-desktop-2.0.0-win-x64.exe', sha256: createHash('sha256').update(payload).digest('hex') }
  updater.downloadToFile = async (_info, destination) => fs.writeFileSync(destination, payload)
  assert.equal((await updater.install()).started, true)
  let recoveredWindows = 0
  const { createUpdateController } = load('update-controller', { electron: { app: { isPackaged: true, quit() {} } } }, { process: fakeProcess })
  const controller = createUpdateController({ getDesktopUpdater: () => updater,
    launchWindow: () => recoveredWindows++, localeChinese: () => false })
  controller.scheduleQuitAfterWindowsInstall()
  installer.emit('exit', 1, null)
  await turn()
  assert.equal(recoveredWindows, 1)
  assert.equal(updater.getState().phase, 'error')
  assert.equal((await updater.install()).started, true, 'retry must no longer short-circuit as busy')
  installer.emit('exit', 0, null)
  for (const name of ['dsh-desktop-1.0.0-win-x64.exe', 'unrelated.txt']) fs.writeFileSync(join(work, name), 'fixture')
  pruneOldInstallers(work, updater.info.fileName)
  assert.equal(fs.existsSync(join(work, 'dsh-desktop-1.0.0-win-x64.exe')), false)
  assert.equal(fs.existsSync(join(work, updater.info.fileName)), true)
  assert.equal(fs.existsSync(join(work, 'unrelated.txt')), true)
  console.log('✓ failed installer can be retried, and cleanup retains current installer and unrelated files')

  const { createBrowserAdmission } = load('browser-admission')
  fs.writeFileSync(join(work, '.credentials.yaml'), JSON.stringify({ version: 1, records: {
    'client-connection/browser-session': { kind: 'grant', payload: { version: 1, secret: Buffer.alloc(32, 7).toString('base64url') } },
  } }))
  target = local
  let verified = true
  const admission = createBrowserAdmission({ home: () => work, target: () => target, mainContentsId: () => 1, verify: async () => verified })
  await admission.select(local)
  const native = admission.headers(local, 1, {}).Cookie
  assert.match(native, /^dsh-auth-/)
  assert.equal(admission.headers('http://127.0.0.1:49124', 1, { Cookie: native + '; unrelated=value' }).Cookie, 'unrelated=value')
  assert.equal(admission.headers(local, 2, { Cookie: native }).Cookie, undefined)
  target = 'http://127.0.0.1:49124'
  assert.equal(admission.headers(local, 1, { Cookie: native }).Cookie, undefined)
  verified = false
  await admission.select(target)
  assert.equal(admission.headers(target, 1, {}).Cookie, undefined)
  target = 'https://remote.example:9443'
  await admission.select(target)
  const remoteCookie = 'dsh-auth-' + createHash('sha256').update(new URL(target).host).digest('base64url') + '=server-issued'
  assert.equal(admission.headers(target, 1, { Cookie: remoteCookie }).Cookie, remoteCookie)
  console.log('✓ native browser credentials only follow verified selected origin in main contents, never another port or old target')
  const managerBundle = join(work, 'manager.cjs')
  buildSync({ entryPoints: [join(root, 'src/main/web-ui-manager.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: managerBundle, logLevel: 'silent' })
  const emitter = join(work, 'emitter.cjs')
  fs.writeFileSync(emitter, `process.stdout.write('token=' + 'x'.repeat(128 * 1024) + '\\n', () => {
    process.stderr.write('pass');
    setTimeout(() => process.stderr.write('word=synthetic-pipe-secret', () => process.exit(1)), 10);
  });`)
  const runner = join(work, 'runner.cjs')
  const pipeHome = join(work, 'pipe-home')
  fs.writeFileSync(runner, `const { WebUiManager } = require(${JSON.stringify(managerBundle)});
    const manager = new WebUiManager({ home: () => ${JSON.stringify(pipeHome)},
      resolveCommand: () => ({ command: process.execPath, args: [${JSON.stringify(emitter)}], source: 'bundled', label: 'pipe fixture' }),
      prepareCommand: () => ({ args: [], env: process.env }), waitForReady: async () => {},
      onLog: line => console.log(line), onExit: () => console.log('PIPE_FIXTURE_EXIT') });
    manager.ready().catch(() => {});`)
  const output = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let text = ''
    const timeout = setTimeout(() => { proc.kill(); reject(new Error('real pipe fixture timed out')) }, 10_000)
    proc.stdout.on('data', chunk => { text += chunk.toString() })
    proc.stderr.on('data', chunk => { text += chunk.toString() })
    proc.once('error', error => { clearTimeout(timeout); reject(error) })
    proc.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve(text)
      else reject(new Error('pipe fixture exit ' + code))
    })
  })
  assert.equal(output.includes('synthetic-pipe-secret'), false)
  assert.ok(output.includes('password=[redacted]'))
  assert.ok(output.includes('output line omitted'))
  assert.ok(output.includes('PIPE_FIXTURE_EXIT'))
  assert.equal(lock.readRuntimeLock(pipeHome), undefined)
  console.log('✓ real child pipes redact split stderr at EOF, bound oversized stdout and clear the exited runtime record')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
