/**
 * Visual verification driver: launch the built desktop client under
 * Playwright's Electron support and capture screenshots of the official Web
 * UI running in the client window. Usage: node scripts/shot.mjs [outdir]
 * @module desktop/scripts/shot
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { openOfficialSettings, settleFirstRunDialogs } from './lib/open-official-settings.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const readmeMode = process.argv[2] === '--readme'
const outDir = readmeMode ? join(APP_DIR, 'docs', 'images') : (process.argv[2] ?? join(APP_DIR, 'shots'))
const electronEnv = { ...process.env }
Reflect.deleteProperty(electronEnv, 'ELECTRON_RUN_AS_NODE')
// Screenshots document the shipped runtime, not a developer's installed dsh.
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
electronEnv.DSH_DESKTOP_SKIP_ONBOARDING = '1'
// A clean DSH_HOME opens the official first-run onboarding, and keeps the
// developer's real sessions and titles out of every capture.
const shotHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-shot-'))
process.on('exit', () => { rmSync(shotHome, { recursive: true, force: true }) })
electronEnv.DSH_HOME = shotHome
electronEnv.DSH_DESKTOP_HOME = join(shotHome, 'desktop')
mkdirSync(outDir, { recursive: true })

const shot = async (page, name) => {
  const path = join(outDir, name + '.png')
  await page.screenshot({ path })
  console.log('saved ' + path)
}

// DSH_DESKTOP_SHOT_APP=<packaged executable> captures a packaged build: its
// runtime runs on Electron's own Node, exactly what users get. A source run
// uses the developer's Node, whose fetch may differ (Node 26.0 left Brotli
// index bodies undecoded behind DSH's undici dispatcher). A packaged build
// ignores DSH_HOME unless the documented escape hatch is opened.
const packagedApp = process.env.DSH_DESKTOP_SHOT_APP
if (packagedApp !== undefined) {
  // A throwaway HOME instead of the DSH_HOME override, so the settings show
  // the ordinary shared-environment wording a user sees.
  Reflect.deleteProperty(electronEnv, 'DSH_HOME')
  Reflect.deleteProperty(electronEnv, 'DSH_DESKTOP_HOME')
  electronEnv.HOME = shotHome
  electronEnv.USERPROFILE = shotHome
}
const app = await electron.launch(packagedApp === undefined
  ? { args: [join(APP_DIR, '.build', 'main.mjs')], env: electronEnv }
  : { executablePath: packagedApp, args: ['--user-data-dir=' + join(shotHome, 'chromium')], env: electronEnv })
const window = await app.firstWindow()
// The local dsh web child boots first; the official Web UI appears in the
// window once the carrier reaches it.
await window.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 60000 })
await window.waitForTimeout(3000)

// A clean DSH_HOME opens the official first-run onboarding before the main
// surface. Advance through it so screenshots are reproducible without using
// a developer's existing conversations or settings.
for (let step = 0; step < 8; step += 1) {
  const onboarding = window.locator('[class*="onboardingOverlay"]').last()
  if (!await onboarding.isVisible().catch(() => false)) break
  const buttons = onboarding.getByRole('button')
  const count = await buttons.count()
  if (count === 0) break
  await buttons.nth(count - 1).click()
  await window.waitForTimeout(500)
}
await window.waitForFunction(() => document.querySelector('[class*="onboardingOverlay"]') === null, null, { timeout: 30000 })
// Close the preview notice and the Get started dialog that follows it before
// capturing the main UI; see settleFirstRunDialogs for why this waits on the
// page rather than for a fixed time.
await settleFirstRunDialogs(window)
await window.waitForTimeout(800)
await shot(window, readmeMode ? 'dsh-desktop-home' : '01-empty-state')

// Open the official settings surface (account menu).
await openOfficialSettings(window)
await window.waitForTimeout(600)
// The README documents this client's own tab inside the official dialog.
const desktopTab = window.getByText(/^(桌面设置|Desktop settings)$/).first()
await desktopTab.click()
await window.locator('#dsh-enhance-status').waitFor({ state: 'visible', timeout: 30_000 })
await window.waitForFunction(() => document.getElementById('dsh-enhance-status')?.textContent?.includes('http'), null, { timeout: 30_000 })
await window.waitForFunction(() => !/检查中|Checking/.test(document.querySelector('#dsh-enhance-root, body')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => {})
if (readmeMode) {
  // Published images carry no session token and no machine-specific path.
  await window.evaluate((home) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? ''
      const next = text.replace(/\/\?token=[^\s·]+/g, '/').split(home).join('~')
      if (next !== text) node.nodeValue = next
    }
  }, shotHome)
}
await window.waitForTimeout(600)
await shot(window, readmeMode ? 'dsh-desktop-setting' : '02-settings')
await window.keyboard.press('Escape')
await window.waitForTimeout(300)

// The preset subscription: Plugins → Discover lists the curated index on a
// first launch, with nothing configured by hand.
await window.getByText(/^(插件|Plugins)$/).first().click()
await window.getByRole('tab', { name: /^(发现|Discover)$/ }).click()
await window.getByText(/[1-9]\d* ?(个插件|plugins?)/).first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {})
await window.waitForTimeout(2500)
await shot(window, readmeMode ? 'dsh-desktop-discover' : '03-discover')

// Type into the composer when the current profile already has a workspace.
// A completely clean profile deliberately keeps the composer disabled until
// the user selects one, so the two privacy-safe screenshots above are enough.
const composer = window.locator('textarea').first()
if (!readmeMode) {
  if (await composer.isEnabled().catch(() => false)) {
    await composer.click()
    await window.keyboard.type('你好，介绍一下你自己', { delay: 12 })
    await window.waitForTimeout(300)
    await shot(window, '04-composer-draft')
  } else {
    console.log('skipped 04-composer-draft (no workspace selected)')
  }
}

await app.close()
console.log('done')
