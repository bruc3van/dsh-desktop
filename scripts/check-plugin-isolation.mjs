/** A plugin-only startup failure selects the isolated home exactly once. */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { killProcessTree } from '../src/main/process-tree.ts'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugin-isolation-'))
const clientHome = join(work, '.bruc3van-dsh-desktop')
const failingRuntime = join(work, 'plugin-failure.mjs')
const pluginDiagnostic = [
  "Error: failed to import loader entry better-sidebar (dsh-better-sidebar): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'",
  "Error: failed to import loader entry old-tools (@example/dsh-old-tools): The requested module '@deepseek-ai/dsh-tools' does not provide an export named 'legacyTool'",
  'Error: dsh: plugin(s) failed to load: dsh-better-sidebar, @example/dsh-old-tools; see errors above',
].join('\n')
mkdirSync(clientHome, { recursive: true })
writeFileSync(join(clientHome, 'settings.json'), JSON.stringify({
  connectionMode: 'smart',
  smartRuntimes: ['bundled'],
}, null, 2) + '\n')
writeFileSync(failingRuntime, 'process.stderr.write(' + JSON.stringify(pluginDiagnostic + '\n') + ')\nprocess.exit(1)\n')

const env = sanitizedElectronEnv()
env.USERPROFILE = work
env.HOME = work
env.DSH_DESKTOP_HOME = clientHome
env.DSH_DESKTOP_DSH = failingRuntime
env.DSH_DESKTOP_SKIP_PROBE = '1'
env.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
env.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
env.DSH_DESKTOP_SKIP_RELAUNCH = '1'
env.DSH_DESKTOP_PLUGIN_RECOVERY_CHOICE = 'isolated'

let app
try {
  if (process.platform !== 'win32') {
    const orphanMarker = join(work, 'orphan-package-manager-ran')
    const groupReadyMarker = join(work, 'plugin-removal-group-ready')
    const descendantCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'orphaned'), 800)`
    const parentCode = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' })
      require('node:fs').writeFileSync(${JSON.stringify(groupReadyMarker)}, 'ready')
      setInterval(() => {}, 10_000)
    `
    const parent = spawn(process.execPath, ['-e', parentCode], { detached: true, stdio: 'ignore' })
    const parentExited = new Promise(resolve => parent.once('exit', resolve))
    for (let attempt = 0; attempt < 40 && !existsSync(groupReadyMarker); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!existsSync(groupReadyMarker)) {
      killProcessTree(parent, true)
      throw new Error('process-group fixture did not start its package-manager descendant')
    }
    killProcessTree(parent, true)
    await parentExited
    await new Promise(resolve => setTimeout(resolve, 900))
    if (existsSync(orphanMarker)) throw new Error('timed-out plugin removal left its package-manager descendant alive')
    console.log('✓ plugin-removal timeout kills the complete POSIX process group')
  }

  const mainSource = readFileSync(join(APP_DIR, 'src', 'main', 'index.ts'), 'utf8')
  if (!mainSource.slice(mainSource.indexOf('function schedulePluginCompatibilityFallback'), mainSource.indexOf('function schedulePluginCompatibilityFallback') + 6000).includes('defaultId: isolatedIndex')) {
    throw new Error('destructive plugin removal is still the recovery dialog default')
  }
  console.log('✓ plugin removal is not the recovery dialog default')

  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(work, 'chromium')],
    env,
  })
  await app.firstWindow()
  await app.waitForEvent('close', { timeout: 35_000 })
  app = undefined
  const settings = JSON.parse(readFileSync(join(clientHome, 'settings.json'), 'utf8'))
  if (settings.dshDataMode !== 'isolated') throw new Error('plugin failure did not select the isolated environment')
  if (settings.dshDataFallbackReason !== 'plugin-compatibility') throw new Error('plugin fallback reason was not persisted')
  if (JSON.stringify(settings.dshDataFallbackPlugins) !== JSON.stringify(['dsh-better-sidebar', '@example/dsh-old-tools'])) {
    throw new Error('all failing plugin packages were not persisted')
  }
  if (settings.dshDataFallbackNoticeShown !== true) throw new Error('the explicit recovery choice was not acknowledged')
  console.log('✓ one plugin startup failure can name multiple incompatible plugins')
  console.log('✓ the explicit recovery choice selects the isolated environment')
  console.log('✓ the compatibility explanation is persisted for the recovered launch')
  console.log('✓ the test quit without spawning a relaunch loop')

  const removalHome = join(work, 'remove-all')
  const removalClientHome = join(removalHome, '.bruc3van-dsh-desktop')
  const removalRuntime = join(removalHome, 'plugin-removal-runtime.mjs')
  const removalManifest = join(removalHome, '.dsh', 'profiles', 'web', 'package.json')
  mkdirSync(removalClientHome, { recursive: true })
  mkdirSync(dirname(removalManifest), { recursive: true })
  writeFileSync(join(removalClientHome, 'settings.json'), JSON.stringify({
    connectionMode: 'smart',
    smartRuntimes: ['bundled'],
  }, null, 2) + '\n')
  writeFileSync(removalManifest, JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'dsh-better-sidebar': '^0.13.0',
      '@example/dsh-old-tools': '^0.1.0',
      'plugin-kept': '^1.0.0',
    },
    dsh: { profile: { bundles: ['dsh-better-sidebar', '@example/dsh-old-tools', 'plugin-kept'] } },
  }, null, 2) + '\n')
  writeFileSync(removalRuntime, `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('0.1.2-rc.1\\n')
  process.exit(0)
}
if (args[0] === 'plugin') {
  const removeAt = args.indexOf('remove')
  const names = removeAt < 0 ? [] : args.slice(removeAt + 1)
  const file = join(process.env.DSH_HOME, 'profiles', 'web', 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  for (const name of names) delete manifest.dependencies[name]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !names.includes(name))
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n')
  process.exit(0)
}
process.stderr.write(${JSON.stringify(pluginDiagnostic + '\n')})
process.exit(1)
`.trimStart())
  const removalEnv = sanitizedElectronEnv()
  removalEnv.USERPROFILE = removalHome
  removalEnv.HOME = removalHome
  removalEnv.DSH_DESKTOP_HOME = removalClientHome
  removalEnv.DSH_DESKTOP_DSH = removalRuntime
  removalEnv.DSH_DESKTOP_SKIP_PROBE = '1'
  removalEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
  removalEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
  removalEnv.DSH_DESKTOP_SKIP_RELAUNCH = '1'
  removalEnv.DSH_DESKTOP_PLUGIN_RECOVERY_CHOICE = 'remove'
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(removalHome, 'chromium')],
    env: removalEnv,
  })
  await app.firstWindow()
  await app.waitForEvent('close', { timeout: 35_000 })
  app = undefined
  const removalSettings = JSON.parse(readFileSync(join(removalClientHome, 'settings.json'), 'utf8'))
  if (removalSettings.dshDataMode === 'isolated') throw new Error('removing plugins unexpectedly selected isolation')
  if ('dshDataFallbackReason' in removalSettings || 'dshDataFallbackPlugins' in removalSettings) {
    throw new Error('successful plugin removal retained compatibility fallback state')
  }
  const removedManifest = JSON.parse(readFileSync(removalManifest, 'utf8'))
  for (const name of ['dsh-better-sidebar', '@example/dsh-old-tools']) {
    if (name in removedManifest.dependencies || removedManifest.dsh.profile.bundles.includes(name)) {
      throw new Error('the combined recovery did not remove ' + name)
    }
  }
  if (!('plugin-kept' in removedManifest.dependencies) || !removedManifest.dsh.profile.bundles.includes('plugin-kept')) {
    throw new Error('the combined recovery changed an unrelated plugin')
  }
  console.log('✓ one confirmed action removes every diagnosed direct plugin together')
  console.log('✓ successful removal preserves the shared environment and unrelated plugins')

  // A non-plugin failure must stay on the selected isolated home long enough
  // for the user to choose Shared manually from the native recovery settings.
  writeFileSync(failingRuntime, "process.stderr.write('EACCES: permission denied\\n')\nprocess.exit(1)\n")
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(work, 'manual-chromium')],
    env,
  })
  const failureWindow = await app.firstWindow()
  await failureWindow.waitForSelector('#error-settings', { timeout: 35_000 })
  await failureWindow.locator('#error-settings').click()
  const settingsWindow = await app.waitForEvent('window', { timeout: 10_000 })
  await settingsWindow.waitForSelector('#data-shared')
  // The settings DOM appears before its asynchronous data environment response.
  await settingsWindow.waitForFunction(() => {
    const note = document.querySelector('#data-note')?.textContent ?? ''
    return note.includes('dsh-better-sidebar') && note.includes('@example/dsh-old-tools')
  }, null, { timeout: 15_000 })
  const compatibilityNote = await settingsWindow.locator('#data-note').textContent()
  if (!compatibilityNote?.includes('dsh-better-sidebar') || !compatibilityNote.includes('@example/dsh-old-tools')) {
    throw new Error('recovery settings did not name every failing plugin: ' + compatibilityNote)
  }
  if (await settingsWindow.locator('#data-shared').isDisabled()) throw new Error('manual data mode choice was unexpectedly disabled')
  await settingsWindow.locator('#data-shared').click()
  await app.waitForEvent('close', { timeout: 10_000 })
  app = undefined
  const restored = JSON.parse(readFileSync(join(clientHome, 'settings.json'), 'utf8'))
  if (restored.dshDataMode !== 'shared') throw new Error('manual switch did not restore shared mode')
  if ('dshDataFallbackReason' in restored || 'dshDataFallbackPlugin' in restored
    || 'dshDataFallbackPlugins' in restored || 'dshDataFallbackNoticeShown' in restored) {
    throw new Error('manual selection retained the automatic fallback explanation')
  }
  console.log('✓ the recovery settings can switch manually back to the shared environment')
  console.log('✓ the recovery settings name every failing plugin package')
  console.log('✓ a manual choice clears the automatic compatibility explanation')

  writeFileSync(join(clientHome, 'settings.json'), JSON.stringify({
    connectionMode: 'smart',
    smartRuntimes: ['probe'],
    dshDataMode: 'shared',
  }, null, 2) + '\n')
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(work, 'probe-only-chromium')],
    env,
  })
  const probeOnlyFailure = await app.firstWindow()
  await probeOnlyFailure.waitForSelector('#error-settings', { timeout: 35_000 })
  await probeOnlyFailure.locator('#error-settings').click()
  const probeOnlySettings = await app.waitForEvent('window', { timeout: 10_000 })
  await probeOnlySettings.locator('#data-isolated').click()
  await probeOnlySettings.waitForFunction(() => {
    const note = document.querySelector('#data-note')?.textContent ?? ''
    return note.includes('请先启用') || note.includes('enable installed')
  })
  const probeOnly = JSON.parse(readFileSync(join(clientHome, 'settings.json'), 'utf8'))
  if (probeOnly.dshDataMode !== 'shared') throw new Error('probe-only settings entered an unbootable isolated mode')
  console.log('✓ probe-only configuration is refused before entering the isolated environment')
  await app.close()
  app = undefined

  // An installed-only source used to be rejected before compatibility
  // fallback ran. Command resolution then replaced the plugin diagnostic with
  // "no enabled runtime", leaving the client on the failure page.
  const installedHome = join(work, 'installed-only')
  const installedClientHome = join(installedHome, '.bruc3van-dsh-desktop')
  const installedRuntime = join(installedHome, 'installed-plugin-failure.mjs')
  const installedBin = join(installedHome, 'bin')
  mkdirSync(installedClientHome, { recursive: true })
  mkdirSync(installedBin, { recursive: true })
  writeFileSync(join(installedClientHome, 'settings.json'), JSON.stringify({
    connectionMode: 'smart',
    smartRuntimes: ['installed'],
  }, null, 2) + '\n')
  writeFileSync(installedRuntime, [
    "if (process.argv.includes('--version')) { process.stdout.write('0.1.2-rc.1\\n'); process.exit(0) }",
    'process.stderr.write(' + JSON.stringify('x'.repeat(9_000) + '\n' + pluginDiagnostic + '\n') + ')',
    'process.exit(1)',
    '',
  ].join('\n'))
  if (process.platform === 'win32') {
    writeFileSync(join(installedBin, 'dsh.cmd'), [
      '@echo off',
      '"' + process.execPath + '" "' + installedRuntime + '" %*',
      '',
    ].join('\r\n'))
  } else {
    const shim = join(installedBin, 'dsh')
    writeFileSync(shim, [
      '#!/bin/sh',
      'exec "' + process.execPath + '" "' + installedRuntime + '" "$@"',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
  }
  const installedEnv = sanitizedElectronEnv({}, ['PATH'])
  installedEnv.USERPROFILE = installedHome
  installedEnv.HOME = installedHome
  installedEnv.DSH_DESKTOP_HOME = installedClientHome
  installedEnv.DSH_DESKTOP_SKIP_PROBE = '1'
  installedEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
  installedEnv.DSH_DESKTOP_SKIP_RELAUNCH = '1'
  installedEnv.DSH_DESKTOP_PLUGIN_RECOVERY_CHOICE = 'isolated'
  installedEnv.PATH = installedBin + delimiter + (process.env.PATH ?? '')
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(installedHome, 'chromium')],
    env: installedEnv,
  })
  let installedLog = ''
  app.process().stdout?.on('data', chunk => { installedLog += chunk.toString() })
  app.process().stderr?.on('data', chunk => { installedLog += chunk.toString() })
  await app.firstWindow()
  await app.waitForEvent('close', { timeout: 35_000 })
  app = undefined
  const installedSettings = JSON.parse(readFileSync(join(installedClientHome, 'settings.json'), 'utf8'))
  if (installedSettings.dshDataMode !== 'isolated') {
    throw new Error('installed-only plugin failure did not select the isolated environment\n' + installedLog)
  }
  if (JSON.stringify(installedSettings.dshDataFallbackPlugins) !== JSON.stringify(['dsh-better-sidebar', '@example/dsh-old-tools'])) {
    throw new Error('installed-only fallback lost the failing plugin names\n' + installedLog)
  }
  if (/trying the next enabled runtime|No enabled Smart-mode runtime/.test(installedLog)) {
    throw new Error('installed-only plugin diagnosis was overwritten by source fallback\n' + installedLog)
  }
  console.log('✓ an installed-only plugin failure isolates before its diagnostic can be overwritten')
  console.log('✓ a plugin failure remains actionable after the runtime output tail is truncated')

  // The npx-cache rung has its own rejection flag and resolution path. Keep a
  // dedicated regression so parity with PATH-installed dsh cannot drift.
  const npxHome = join(work, 'npx-only')
  const npxClientHome = join(npxHome, '.bruc3van-dsh-desktop')
  const npxPackage = join(npxHome, 'npm-cache', '_npx', 'fixture', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(npxClientHome, { recursive: true })
  mkdirSync(join(npxPackage, 'lib'), { recursive: true })
  writeFileSync(join(npxClientHome, 'settings.json'), JSON.stringify({
    connectionMode: 'smart',
    smartRuntimes: ['npx'],
  }, null, 2) + '\n')
  writeFileSync(join(npxPackage, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.2-rc.1',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  }))
  writeFileSync(join(npxPackage, 'lib', 'bin.js'),
    'process.stderr.write(' + JSON.stringify(pluginDiagnostic + '\n') + ')\nprocess.exit(1)\n')
  const npxEnv = sanitizedElectronEnv({}, ['PATH', 'NPM_CONFIG_CACHE'])
  npxEnv.USERPROFILE = npxHome
  npxEnv.HOME = npxHome
  npxEnv.DSH_DESKTOP_HOME = npxClientHome
  npxEnv.DSH_DESKTOP_SKIP_PROBE = '1'
  npxEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
  npxEnv.DSH_DESKTOP_SKIP_RELAUNCH = '1'
  npxEnv.DSH_DESKTOP_PLUGIN_RECOVERY_CHOICE = 'isolated'
  npxEnv.npm_config_cache = join(npxHome, 'npm-cache')
  npxEnv.PATH = dirname(process.execPath) + delimiter + (process.env.PATH ?? '')
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(npxHome, 'chromium')],
    env: npxEnv,
  })
  let npxLog = ''
  app.process().stdout?.on('data', chunk => { npxLog += chunk.toString() })
  app.process().stderr?.on('data', chunk => { npxLog += chunk.toString() })
  await app.firstWindow()
  await app.waitForEvent('close', { timeout: 35_000 }).catch((error) => {
    throw new Error(String(error) + '\n' + npxLog)
  })
  app = undefined
  const npxSettings = JSON.parse(readFileSync(join(npxClientHome, 'settings.json'), 'utf8'))
  if (npxSettings.dshDataMode !== 'isolated') {
    throw new Error('npx-only plugin failure did not select the isolated environment\n' + npxLog)
  }
  if (JSON.stringify(npxSettings.dshDataFallbackPlugins) !== JSON.stringify(['dsh-better-sidebar', '@example/dsh-old-tools'])) {
    throw new Error('npx-only fallback lost the failing plugin names\n' + npxLog)
  }
  if (/trying the next enabled runtime|No enabled Smart-mode runtime/.test(npxLog)) {
    throw new Error('npx-only plugin diagnosis was overwritten by source fallback\n' + npxLog)
  }
  console.log('✓ an npx-only plugin failure isolates before its diagnostic can be overwritten')

  // A failure while the client-owned market is seated gets one same-source
  // retry after that seat is withdrawn. It must not isolate the user's whole
  // profile unless the runtime still reports a plugin failure afterwards.
  const seatHome = join(work, 'bundled-seat')
  const seatDshHome = join(seatHome, '.dsh')
  const seatClientHome = join(seatHome, '.bruc3van-dsh-desktop')
  const seatRuntime = join(seatHome, 'seat-sensitive-runtime.mjs')
  const seatBin = join(seatHome, 'bin')
  const seatManifest = join(seatDshHome, 'profiles', 'web', 'package.json')
  mkdirSync(join(seatDshHome, 'profiles', 'web'), { recursive: true })
  mkdirSync(seatClientHome, { recursive: true })
  mkdirSync(seatBin, { recursive: true })
  writeFileSync(seatManifest, JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + '\n')
  writeFileSync(join(seatClientHome, 'settings.json'), JSON.stringify({
    connectionMode: 'smart',
    smartRuntimes: ['installed'],
  }, null, 2) + '\n')
  writeFileSync(seatRuntime, `
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
if (process.argv.includes('--version')) {
  process.stdout.write('0.9.9-fake\\n')
  process.exit(0)
}
const manifest = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'), 'utf8'))
if (manifest.dsh.profile.bundles.includes('dsh-desktop-safe-market')) {
  process.stderr.write('Error: plugin(s) failed to activate: dsh-desktop-safe-market\\n')
  process.exit(1)
}
const server = createServer((req, res) => {
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: {
      version: '0.9.9-fake', cwd: '/', attachedSessions: 0, canOpenPath: false,
    } } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><p id="seat-ready">ready without client seat</p></body></html>')
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('dsh web: http://127.0.0.1:' + server.address().port + '\\n')
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
`.trimStart())
  if (process.platform === 'win32') {
    writeFileSync(join(seatBin, 'dsh.cmd'), [
      '@echo off',
      '"' + process.execPath + '" "' + seatRuntime + '" %*',
      '',
    ].join('\r\n'))
  } else {
    const shim = join(seatBin, 'dsh')
    writeFileSync(shim, [
      '#!/bin/sh',
      'exec "' + process.execPath + '" "' + seatRuntime + '" "$@"',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
  }
  const seatEnv = sanitizedElectronEnv({}, ['PATH', 'NPM_CONFIG_CACHE'])
  seatEnv.USERPROFILE = seatHome
  seatEnv.HOME = seatHome
  seatEnv.DSH_DESKTOP_HOME = seatClientHome
  seatEnv.DSH_DESKTOP_SKIP_PROBE = '1'
  seatEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
  seatEnv.npm_config_cache = join(seatHome, 'empty-npm-cache')
  seatEnv.PATH = seatBin + delimiter + (process.env.PATH ?? '')
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(seatHome, 'chromium')],
    env: seatEnv,
  })
  let seatLog = ''
  app.process().stdout?.on('data', chunk => { seatLog += chunk.toString() })
  app.process().stderr?.on('data', chunk => { seatLog += chunk.toString() })
  const seatWindow = await app.firstWindow()
  await seatWindow.waitForSelector('#seat-ready', { timeout: 60_000 }).catch((error) => {
    throw new Error(String(error) + '\n' + seatLog)
  })
  const seatSettings = JSON.parse(readFileSync(join(seatClientHome, 'settings.json'), 'utf8'))
  const manifestAfterRetry = JSON.parse(readFileSync(seatManifest, 'utf8'))
  const installedStarts = seatLog.match(/dsh runtime: installed/g)?.length ?? 0
  if (seatSettings.dshDataMode === 'isolated'
    || manifestAfterRetry.dsh.profile.bundles.includes('dsh-desktop-safe-market')
    || installedStarts < 2
    || !seatLog.includes('retrying the same dsh runtime without the bundled plugin seat')) {
    throw new Error('the bundled plugin seat did not get one clean same-source retry\n' + seatLog)
  }
  console.log('✓ a client-owned plugin failure withdraws its seat and retries the same runtime once')
  await app.close()
  app = undefined
} finally {
  await app?.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
