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

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const readmeMode = process.argv[2] === '--readme'
const outDir = readmeMode ? join(APP_DIR, 'docs', 'images') : (process.argv[2] ?? join(APP_DIR, 'shots'))
const electronEnv = { ...process.env }
Reflect.deleteProperty(electronEnv, 'ELECTRON_RUN_AS_NODE')
// Screenshots document the shipped runtime, not a developer's installed dsh.
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
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

const app = await electron.launch({ args: [join(APP_DIR, '.build', 'main.mjs')], env: electronEnv })
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
// Complete any subsequent notice/model flow before capturing the main UI.
for (let step = 0; step < 8; step += 1) {
  const mask = window.locator('div[aria-hidden="true"][class*="_mask_"]').last()
  if (!await mask.isVisible().catch(() => false)) break
  const modal = window.locator('[role="presentation"]').filter({ visible: true }).last()
  const buttons = modal.locator('button:not([disabled])').filter({ visible: true })
  const count = await buttons.count()
  if (count > 0) await buttons.nth(count - 1).click()
  else await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
}
await window.waitForTimeout(800)
await shot(window, readmeMode ? 'readme-home' : '01-empty-state')

// Open the official settings surface (sidebar footer).
const settings = window.getByRole('button', { name: /设置|Settings/ }).first()
await settings.click()
await window.waitForTimeout(600)
await shot(window, readmeMode ? 'readme-settings' : '02-settings')
await window.keyboard.press('Escape')
await window.waitForTimeout(300)

// Type into the composer when the current profile already has a workspace.
// A completely clean profile deliberately keeps the composer disabled until
// the user selects one, so the two privacy-safe screenshots above are enough.
const composer = window.locator('textarea').first()
if (!readmeMode) {
  if (await composer.isEnabled().catch(() => false)) {
    await composer.click()
    await window.keyboard.type('你好，介绍一下你自己', { delay: 12 })
    await window.waitForTimeout(300)
    await shot(window, '03-composer-draft')
  } else {
    console.log('skipped 03-composer-draft (no workspace selected)')
  }
}

await app.close()
console.log('done')
