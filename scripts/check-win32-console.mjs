/** Verify the deployed Issue #16 patches; Windows also exercises the native runner. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const modules = join(root, '.runtime', 'node_modules')
const acl = join(modules, '@deepseek-ai', 'dsh-sandbox-windows-acl')
const subprocess = join(modules, '@deepseek-ai', 'dsh-subprocess-local')
for (const directory of [acl, subprocess]) {
  if (!existsSync(join(directory, 'package.json'))) {
    throw new Error('deployed dsh runtime is missing; run `pnpm run prepare:runtime` before `pnpm run check:win32-console`')
  }
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version, '0.1.2-rc.1',
    'Reconcile the console patches when upgrading the runtime')
}
const { prepareRunnerConsole } = await import(pathToFileURL(join(acl, 'lib', 'types-desktop-console.js')).href)
const runner = await readFile(join(acl, 'lib', 'runner.js'), 'utf8')
assert.match(runner, /import \{ prepareRunnerConsole \} from "\.\/types-desktop-console\.js"/)
assert.ok(runner.includes('prepareRunnerConsole(api)'))
assert.ok(runner.indexOf('prepareRunnerConsole(api)') < runner.indexOf('sandbox = new AclSandbox'))

function fixture({ existing = null, allocation = 1, restoreFailure, handler = 1 } = {}) {
  const calls = []
  let window = existing
  const handles = new Map([[-10, 101n], [-11, 102n], [-12, 103n]])
  const api = {
    getConsoleWindow: () => window,
    getStdHandle: selector => handles.get(selector),
    allocConsole() {
      calls.push('allocate')
      if (allocation) {
        window = 77n
        for (const selector of handles.keys()) handles.set(selector, 999n)
      }
      return allocation
    },
    showWindow(value, mode) { calls.push(['hide', value, mode]); return 0 },
    setStdHandle(selector, value) {
      calls.push(['restore', selector])
      handles.set(selector, value)
      return selector === restoreFailure ? 0 : 1
    },
    setConsoleCtrlHandler(value, add) { calls.push(['handler', value, add]); return handler },
    getLastError: () => 5,
  }
  return { api, calls, handles }
}

for (const existing of [null, 0, 0n]) {
  const f = fixture({ existing })
  prepareRunnerConsole(f.api)
  assert.deepEqual(f.calls, ['allocate', ['hide', 77n, 0], ['restore', -10], ['restore', -11],
    ['restore', -12], ['handler', null, 1]])
  assert.deepEqual([...f.handles.values()], [101n, 102n, 103n])
}
const inherited = fixture({ existing: 88n })
prepareRunnerConsole(inherited.api)
assert.deepEqual(inherited.calls, [['handler', null, 1]], 'Never hide a user-owned console')
const failedAllocation = fixture({ allocation: 0 })
prepareRunnerConsole(failedAllocation.api)
assert.deepEqual(failedAllocation.calls, ['allocate', ['handler', null, 1]])
const failedRestore = fixture({ restoreFailure: -10 })
assert.throws(() => prepareRunnerConsole(failedRestore.api), /SetStdHandle failed/)
assert.deepEqual(failedRestore.calls.at(-1), ['restore', -12], 'Attempt all handle restores before failing')
const failedHide = fixture()
failedHide.api.showWindow = () => { throw new Error('hide failed') }
assert.throws(() => prepareRunnerConsole(failedHide.api), /hide failed/)
assert.deepEqual([...failedHide.handles.values()], [101n, 102n, 103n], 'Restore pipes even if hiding throws')
assert.throws(() => prepareRunnerConsole(fixture({ handler: 0 }).api), /SetConsoleCtrlHandler failed/)

// Execute the deployed spawn options, not a second copy of the implementation.
const source = await readFile(join(subprocess, 'lib', 'index.js'), 'utf8')
const spawnBody = source.slice(source.indexOf('function spawnSubprocess('))
const options = /const child = spawn\(program, args, (\{[\s\S]*?\n\t\})\);/.exec(spawnBody)?.[1]
assert.ok(options, 'Cannot locate deployed subprocess spawn options')
const readOptions = new Function('platform', 'spec', 'env', 'stdinMode', 'outMode', 'errMode', `return (${options})`)
for (const platform of ['win32', 'darwin', 'linux']) {
  const actual = readOptions(platform, { cwd: '/fixture' }, { FIXTURE: '1' }, 'pipe', 'pipe', 'inherit')
  assert.equal(actual.windowsHide, platform === 'win32')
  assert.equal(actual.detached, platform !== 'win32')
  assert.deepEqual(actual.stdio, ['pipe', 'pipe', 'inherit'])
  assert.deepEqual(actual.env, { FIXTURE: '1' })
}
console.log('✓ deployed console patches preserve console ownership, stdio, handler order and spawn options')

if (process.platform !== 'win32') {
  console.log('Windows native console / sandbox smoke skipped on ' + process.platform)
  process.exit(0)
}

const electron = createRequire(import.meta.url)('electron')
const home = await mkdtemp(join(tmpdir(), 'dsh-console-smoke-'))
const workspace = join(home, 'workspace')
const temp = join(home, 'temp')
await mkdir(workspace)
await mkdir(temp)

async function run(args, input = '') {
  const child = spawn(electron, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: workspace,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => { /* early child failure is reported by exit/output assertions */ })
  child.stdin.end(input)
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Console smoke timed out')) }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  return { code, stdout, stderr }
}

try {
  // Exercise the actual Koffi bindings under Electron, with original pipe handles.
  const probe = `
    const { createRequire } = require('node:module');
    (async () => {
      const { o: win32 } = await import(${JSON.stringify(pathToFileURL(join(acl, 'lib', 'types-DuU3lSVe.js')).href)});
      const { prepareRunnerConsole } = await import(${JSON.stringify(pathToFileURL(join(acl, 'lib', 'types-desktop-console.js')).href)});
      const api = await win32();
      const handles = [-10, -11, -12].map(n => api.getStdHandle(n));
      prepareRunnerConsole(api);
      const koffi = createRequire(${JSON.stringify(join(acl, 'package.json'))})('koffi');
      const visible = koffi.load('user32.dll').func('__stdcall', 'IsWindowVisible', 'int', ['void *']);
      if (!api.getConsoleWindow() || visible(api.getConsoleWindow())) throw Error('Missing or visible console');
      if (handles.some((h, i) => h !== api.getStdHandle(-10 - i))) throw Error('Stdio changed');
      process.stdout.write('hidden-console-ok');
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `
  const native = await run(['-e', probe])
  assert.equal(native.code, 0, native.stderr)
  assert.equal(native.stdout, 'hidden-console-ok')

  // Native restricted-token children must retain stdin, stdout, stderr and exit codes.
  // All ACL mutations are confined to this disposable fixture, never a real profile.
  for (const mode of ['read-only', 'workspace-write']) {
    const target = join(workspace, mode + '.txt')
    const outside = join(home, mode + '-outside.txt')
    const prefix = [join(acl, 'lib', 'runner.js'), '--workspace', workspace, '--temp', temp, '--mode', mode, '--']
    // run() fixes cwd to workspace. Use fixture-owned relative names so the
    // runner's argv quoting cannot turn embedded cmd quotes into literal paths.
    const command = `set /p DSH_CONSOLE_INPUT=& echo stdout-ok& echo stderr-ok 1>&2& echo !DSH_CONSOLE_INPUT!& echo write-ok>${mode}.txt& echo forbidden>..\\${mode}-outside.txt& exit /b 7`
    const result = await run([...prefix, process.env.ComSpec || 'cmd.exe', '/d', '/v:on', '/s', '/c', command], 'stdin-ok\r\n')
    assert.equal(result.code, 7, JSON.stringify(result))
    assert.match(result.stdout, /stdout-ok/)
    assert.match(result.stdout, /stdin-ok/)
    assert.match(result.stderr, /stderr-ok/)
    if (mode === 'workspace-write') assert.match(await readFile(target, 'utf8'), /write-ok/)
    else await assert.rejects(readFile(target), { code: 'ENOENT' })
    await assert.rejects(readFile(outside), { code: 'ENOENT' })
  }
  console.log('✓ Electron native hidden console and restricted runner stdio / exit / write boundaries')
} finally {
  await rm(home, { recursive: true, force: true })
}
