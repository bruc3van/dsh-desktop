/** A plugin-only startup failure selects the isolated home exactly once. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugin-isolation-'))
const clientHome = join(work, '.bruc3van-dsh-desktop')
const failingRuntime = join(work, 'plugin-failure.mjs')
mkdirSync(clientHome, { recursive: true })
writeFileSync(join(clientHome, 'settings.json'), JSON.stringify({
  connectionMode: 'smart',
  smartRuntimes: ['bundled'],
}, null, 2) + '\n')
writeFileSync(failingRuntime, "process.stderr.write('Error: plugin(s) failed to activate: legacy.entry\\n')\nprocess.exit(1)\n")

const env = sanitizedElectronEnv()
env.USERPROFILE = work
env.HOME = work
env.DSH_DESKTOP_HOME = clientHome
env.DSH_DESKTOP_DSH = failingRuntime
env.DSH_DESKTOP_SKIP_PROBE = '1'
env.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
env.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
env.DSH_DESKTOP_SKIP_RELAUNCH = '1'

let app
try {
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
  if (settings.dshDataFallbackNoticeShown !== false) throw new Error('the recovery notice was not left pending')
  console.log('✓ a plugin startup failure selects the isolated environment')
  console.log('✓ the compatibility explanation is persisted for the recovered launch')
  console.log('✓ the test quit without spawning a relaunch loop')

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
  if (await settingsWindow.locator('#data-shared').isDisabled()) throw new Error('manual data mode choice was unexpectedly disabled')
  await settingsWindow.locator('#data-shared').click()
  await app.waitForEvent('close', { timeout: 10_000 })
  app = undefined
  const restored = JSON.parse(readFileSync(join(clientHome, 'settings.json'), 'utf8'))
  if (restored.dshDataMode !== 'shared') throw new Error('manual switch did not restore shared mode')
  if ('dshDataFallbackReason' in restored || 'dshDataFallbackNoticeShown' in restored) {
    throw new Error('manual selection retained the automatic fallback explanation')
  }
  console.log('✓ the recovery settings can switch manually back to the shared environment')
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
    return document.querySelector('#data-note')?.textContent?.includes('请先启用') === true
  })
  const probeOnly = JSON.parse(readFileSync(join(clientHome, 'settings.json'), 'utf8'))
  if (probeOnly.dshDataMode !== 'shared') throw new Error('probe-only settings entered an unbootable isolated mode')
  console.log('✓ probe-only configuration is refused before entering the isolated environment')
} finally {
  await app?.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
