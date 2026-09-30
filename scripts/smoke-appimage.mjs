/** Verify the actual AppImage payload, not just electron-builder's staging tree. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

if (process.platform !== 'linux') throw new Error('smoke:appimage requires a Linux host')
const root = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const image = resolve(process.argv[2] ?? join(root, 'release', `dsh-desktop-${version}-linux-x86_64.AppImage`))
const work = await mkdtemp(join(tmpdir(), 'dsh-appimage-'))
const run = promisify(execFile)
let runtimeApp
let runtimeClosed = false
let runtimeOutput = ''
let successorPid
let successorChildPid
const alive = pid => {
  try { return !/\) Z /.test(readFileSync('/proc/' + pid + '/stat', 'utf8')) } catch { return false }
}
async function waitFor(check, description) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Timed out: ' + description)
}
try {
  await access(image, constants.X_OK)
  await run(image, ['--appimage-extract'], { cwd: work, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const payload = join(work, 'squashfs-root')
  const executable = join(payload, 'dsh-desktop')
  await access(executable, constants.X_OK)
  await access(join(payload, 'AppRun'), constants.X_OK)
  const desktopFile = (await readdir(payload)).find(name => name.endsWith('.desktop'))
  assert.ok(desktopFile, 'AppImage must contain a desktop entry')
  const desktopEntry = await readFile(join(payload, desktopFile), 'utf8')
  assert.match(desktopEntry, /^Exec=.+/m)
  assert.doesNotMatch(desktopEntry, /--no-sandbox/)
  console.log('✓ AppImage extracts executable payload and desktop entry')
  for (const [script, entry] of [
    ['check-pnpm-runtime.mjs', executable],
    ['check-linux.mjs', executable],
    ['smoke-package.mjs', join(payload, 'AppRun')],
  ]) {
    const result = await run(process.execPath, [join(root, 'scripts', script), entry], {
      cwd: root, env: process.env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    })
    process.stdout.write(result.stdout)
  }
  console.log('✓ actual AppImage payload passes offline plugin installation, native modules and runtime startup')

  // Also start through the standalone AppImage runtime: a mounted/extracted
  // resources path differs from electron-builder's staging directory.
  const home = join(work, 'runtime-desktop')
  await mkdir(home)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ smartRuntimes: ['bundled'] }))
  const env = sanitizedElectronEnv()
  Object.assign(env, { DSH_DESKTOP_ALLOW_UNSAFE: '1', DSH_DESKTOP_HOME: home,
    DSH_HOME: join(work, 'runtime-dsh'), DSH_DESKTOP_SKIP_UPDATE_CHECK: '1', DSH_DESKTOP_SKIP_PROBE: '1' })
  const args = ['--user-data-dir=' + join(work, 'runtime-chromium')]
  // Playwright prepends inspector arguments, but the AppImage runtime only
  // recognizes its extract flag in the first position. Use its env equivalent.
  if (process.env.DSH_SMOKE_APPIMAGE_FUSE !== '1') env.APPIMAGE_EXTRACT_AND_RUN = '1'
  else delete env.APPIMAGE_EXTRACT_AND_RUN
  runtimeApp = await electron.launch({ executablePath: image, args, env, chromiumSandbox: true, timeout: 60_000 })
  runtimeApp.on('close', () => { runtimeClosed = true })
  runtimeApp.process().stderr.on('data', chunk => { runtimeOutput += chunk })
  runtimeApp.process().stdout.on('data', chunk => { runtimeOutput += chunk })
  const page = await runtimeApp.firstWindow()
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  assert.equal(await runtimeApp.evaluate(({ app }) => app.isPackaged), true)
  const resources = await runtimeApp.evaluate(() => process.resourcesPath)
  assert.ok(!resources.startsWith(join(root, 'release')), 'Runtime must load resources from the actual AppImage')
  assert.match(resources, process.env.DSH_SMOKE_APPIMAGE_FUSE === '1' ? /\/\.mount_/ : /\/appimage_extracted_/)
  const workspacePath = join(work, 'linux-smoke-workspace')
  await mkdir(workspacePath)
  const workspaceResult = await page.evaluate(async path => {
    return await (await fetch('/api/workspace/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'linux-workspace-smoke',
        method: 'workspace/create', payload: { args: { request: { path } } } }),
    })).json()
  }, workspacePath)
  assert.equal(workspaceResult.result?.ok, true, JSON.stringify(workspaceResult))
  assert.equal(workspaceResult.result.value.workspace.path, workspacePath)
  console.log('✓ standalone AppImage registers a project folder through the authenticated workspace API')
  if (process.env.DSH_SMOKE_APPIMAGE_SCREENSHOT) await page.screenshot({ path: process.env.DSH_SMOKE_APPIMAGE_SCREENSHOT })
  console.log('✓ standalone AppImage runtime starts the bundled Web UI (' + (process.env.DSH_SMOKE_APPIMAGE_FUSE === '1' ? 'FUSE' : 'extract-and-run') + ')')
  const lockPath = join(env.DSH_HOME, '.dsh-desktop-runtime.json')
  const previous = JSON.parse(await readFile(lockPath, 'utf8'))
  const cookie = (await runtimeApp.context().cookies()).map(({ name, value }) => name + '=' + value).join('; ')
  console.log('Restarting packaged desktop ' + previous.desktopPid)
  await runtimeApp.evaluate(({ app, Menu }) => {
    // The successor must boot normally, without waiting for Playwright's
    // debugger to attach again. Keep the production restart menu action.
    app.commandLine.removeSwitch('inspect')
    app.commandLine.removeSwitch('inspect-brk')
    process.argv = process.argv.filter(arg => !/^--inspect(?:-brk)?(?:=|$)/.test(arg))
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(item => /^(Restart|重启客户端)$/.test(item.label))
    if (!item) throw new Error('Restart menu item is missing')
    setTimeout(() => item.click(), 100)
  })
  console.log('Restart menu scheduled; waiting for successor')
  await waitFor(async () => {
    let lock
    try { lock = JSON.parse(await readFile(lockPath, 'utf8')) } catch { return false }
    if (lock.desktopPid === previous.desktopPid) return false
    successorPid = lock.desktopPid
    successorChildPid = lock.childPid
    if (!lock.url || !alive(lock.desktopPid) || !alive(lock.childPid)) return false
    assert.equal(alive(previous.childPid), false, 'Restart must stop the previous managed runtime')
    try { return (await fetch(lock.url, { headers: { cookie }, signal: AbortSignal.timeout(2000) })).ok } catch { return false }
  }, 'AppImage restart must start a new desktop and a reachable bundled runtime')
  console.log('✓ standalone AppImage Restart replaces the desktop and managed runtime')
} catch (error) {
  process.stderr.write(runtimeOutput)
  console.error(error)
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  if (successorPid && alive(successorPid)) {
    process.kill(successorPid, 'SIGTERM')
    await waitFor(() => !alive(successorPid), 'restarted desktop exits')
  }
  if (successorChildPid && alive(successorChildPid)) {
    process.kill(successorChildPid, 'SIGTERM')
    await waitFor(() => !alive(successorChildPid), 'restarted runtime exits')
  }
  if (runtimeApp !== undefined && !runtimeClosed) await runtimeApp.close()
  await rm(work, { recursive: true, force: true })
}
