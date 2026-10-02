/** Exercise Linux native payloads and the real window lifecycle, without an API key. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'
import { respondToConfirmations } from './lib/confirmation-fixture.mjs'

if (process.platform !== 'linux') throw new Error('check:linux requires a Linux host')
const root = fileURLToPath(new URL('..', import.meta.url))
const executable = process.argv[2] === undefined ? createRequire(import.meta.url)('electron') : resolve(process.argv[2])
const modules = process.argv[2] === undefined ? join(root, '.runtime/node_modules') : join(executable, '..', 'resources/dsh-runtime/node_modules')
const work = await mkdtemp(join(tmpdir(), 'dsh-linux-'))
const run = promisify(execFile)
let app
let server
try {
  const worker = join(work, 'native.mjs')
  await writeFile(worker, `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const modules = ${JSON.stringify(modules)}
const work = ${JSON.stringify(work)}
const require = createRequire(join(modules, 'package.json'))
const koffi = require('koffi')
assert.equal(koffi.load('libc.so.6').func('int getpid()')(), process.pid)
console.log('✓ packaged Koffi calls libc')
const sharp = require('sharp')
const png = await sharp(Buffer.from('<svg width="3" height="2" xmlns="http://www.w3.org/2000/svg"/>')).png().toBuffer()
assert.equal((await sharp(png).metadata()).width, 3)
console.log('✓ packaged Sharp encodes and decodes an image')
const rg = await import(pathToFileURL(require.resolve('@vscode/ripgrep')).href)
const rgRun = spawnSync(rg.rgPath, ['--version'], { encoding: 'utf8' })
assert.equal(rgRun.status, 0)
assert.match(rgRun.stdout, /ripgrep/)
console.log('✓ packaged ripgrep executes')
const pty = require('node-pty')
await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf linux-pty-ready'], { cols: 80, rows: 24 })
  let output = ''
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timeout')) }, 5000)
  terminal.onData(chunk => { output += chunk })
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer)
    try { assert.equal(exitCode, 0); assert.match(output, /linux-pty-ready/); resolve() } catch (error) { reject(error) }
  })
})
console.log('✓ packaged node-pty starts a terminal')
const landlock = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/landlock-run')).href)
const enforcement = landlock.probe()
assert.notEqual(enforcement, 'unusable', 'Host kernel must enforce Landlock for this validation')
const granted = join(work, 'granted')
mkdirSync(granted)
writeFileSync(join(granted, 'allowed'), 'allowed')
writeFileSync(join(work, 'denied'), 'denied')
const grants = landlock.grantArgs({ readOnly: ['/usr', '/lib', '/lib64', '/etc', granted] })
const allowed = spawnSync(landlock.launcherPath(), [...grants, '--', '/bin/cat', join(granted, 'allowed')], { encoding: 'utf8' })
assert.equal(allowed.status, 0, allowed.stderr)
assert.equal(allowed.stdout, 'allowed')
const denied = spawnSync(landlock.launcherPath(), [...grants, '--', '/bin/cat', join(work, 'denied')], { encoding: 'utf8' })
assert.notEqual(denied.status, 0)
assert.match(denied.stderr, /Permission denied/)
console.log('✓ Landlock permits granted reads and blocks ungranted reads (' + enforcement + ')')
`)
  const native = await run(executable, ['--expose-internals', worker], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000,
  })
  process.stdout.write(native.stdout)

  // The close policy runs in the actual application, including the renderer
  // whose notification observers would disappear if the window were destroyed.
  server = createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '999.0.0', platforms: {
        'linux-x64': { url: 'https://example.invalid/update.AppImage' },
        'linux-deb-x64': { url: 'https://example.invalid/update.deb' },
      } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body id="linux-fixture"><script>window.ticks=0;setInterval(()=>window.ticks++,50)</script>Linux fixture</body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const home = join(work, 'desktop')
  await mkdir(home)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ connectionMode: 'connect', serverUrl: origin }))
  const env = sanitizedElectronEnv()
  Object.assign(env, { DSH_DESKTOP_ALLOW_UNSAFE: '1', DSH_HOME: join(work, 'dsh'), DSH_DESKTOP_HOME: home, DSH_DESKTOP_SKIP_UPDATE_CHECK: '1', DSH_DESKTOP_UPDATE_FEED: origin + '/latest.json' })
  const args = [...process.argv[2] === undefined ? [join(root, '.build/main.mjs')] : [], '--user-data-dir=' + join(work, 'chromium')]
  if (process.env.DSH_LINUX_TEST_OZONE === 'wayland') args.push('--ozone-platform=wayland')
  if (process.argv[2] !== undefined) {
    await assert.rejects(run(executable, [...args, '--no-sandbox'], { env, timeout: 15_000 }), error => {
      assert.match(error.stderr, /Chromium sandbox is required/)
      assert.equal(error.code, 1)
      return true
    })
  }
  app = await electron.launch({ executablePath: executable, args, env, chromiumSandbox: true })
  const page = await app.firstWindow()
  await page.waitForSelector('#linux-fixture')
  await respondToConfirmations(app)
  const offered = await page.evaluate(() => window.desktop.update.check())
  assert.equal(offered.hasUpdate, true)
  assert.equal(offered.info.fileName, process.argv[3] === 'deb' ? 'update.deb' : 'update.AppImage')
  console.log('✓ installed package selects its own update format')
  const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false)
  const preferences = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.getLastWebPreferences(), id)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  console.log('✓ the Linux application uses sandboxed renderers and refuses packaged sandbox-disable flags')
  const ticks = await page.evaluate(() => window.ticks)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), id)
  assert.equal(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(), id), false)
  // Hidden Wayland windows stop animation frames even while JS timers run.
  // Poll timers directly instead of Playwright's default animation-frame loop.
  await page.waitForFunction(before => window.ticks > before, ticks, { polling: 100 })
  console.log('✓ closing the Linux window hides it and preserves the live renderer')
  await run(executable, args, { env, timeout: 15_000 })
  assert.equal(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), id), true)
  const quit = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.submenu?.items.some(item => /^(Quit|退出)$/.test(item.label)))
  assert.equal(quit, true)
  console.log('✓ a second launch restores the window; the application menu offers Quit without a tray')
} finally {
  if (app !== undefined) await app.close()
  if (server !== undefined) await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}
