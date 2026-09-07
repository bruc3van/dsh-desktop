/** Bundled official UI compatibility, using a fresh profile and no model requests. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
for (const language of ['zh', 'en']) {
const home = mkdtempSync(join(tmpdir(), 'dsh-official-settings-'))
let app
try {
  const desktopHome = join(home, 'desktop')
  mkdirSync(desktopHome)
  writeFileSync(join(desktopHome, 'settings.json'), JSON.stringify({ connectionMode: 'smart', smartRuntimes: ['bundled'], localWebPort: 0, bundledMarketDisabled: true }))
  mkdirSync(join(home, 'dsh'))
  writeFileSync(join(home, 'dsh/settings.yaml'), 'locale:\n  preference: ' + language + '\n')
  app = await electron.launch({ args: [join(root, '.build/main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env: { ...sanitizedElectronEnv(), DSH_HOME: join(home, 'dsh'), DSH_DESKTOP_HOME: desktopHome,
      DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_SKIP_INSTALLED_DSH: '1', DSH_DESKTOP_SKIP_UPDATE_PROMPT: '1' } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 60000 }).catch(async error => {
    console.error('Official UI did not load:', (await page.locator('body').innerText()).slice(0, 1500))
    throw error
  })
  // #root can render a loading screen before onboarding arrives. Let the
  // first-run surface settle, then finish onboarding before handling the
  // separate notice/model modal. Treating both as one loop can observe the
  // Settings button between the two overlays and click through a blocking mask.
  await page.waitForTimeout(3_000)
  for (let step = 0; step < 8; step += 1) {
    const onboarding = page.locator('[class*="onboardingOverlay"]').last()
    if (!await onboarding.isVisible().catch(() => false)) break
    const buttons = onboarding.getByRole('button')
    const count = await buttons.count()
    if (count === 0) break
    await buttons.nth(count - 1).click()
    await page.waitForTimeout(500)
  }
  await page.waitForFunction(() => document.querySelector('[class*="onboardingOverlay"]') === null, null, { timeout: 60_000 })
  for (let step = 0; step < 8; step += 1) {
    const mask = page.locator('div[aria-hidden="true"][class*="_mask_"]').last()
    if (!await mask.isVisible().catch(() => false)) break
    const modal = page.locator('[role="presentation"]').filter({ visible: true }).last()
    const buttons = modal.locator('button:not([disabled])').filter({ visible: true })
    const count = await buttons.count()
    if (count > 0) await buttons.nth(count - 1).click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  const settingsButton = page.getByRole('button', { name: /设置|Settings/ }).first()
  await settingsButton.waitFor({ state: 'visible', timeout: 60_000 }).catch(async error => {
    console.error('Official settings entry did not become usable:', (await page.locator('body').innerText()).slice(0, 1500))
    throw error
  })
  const open = async () => {
    await settingsButton.click()
    await page.waitForSelector('#dsh-desktop-tab')
    assert.equal(await page.locator('#dsh-desktop-tab').innerText(), language === 'en' ? 'Desktop' : '桌面设置')
    await page.locator('#dsh-desktop-tab').click()
    await page.waitForSelector('#dsh-desktop-enhance')
    await page.waitForSelector('#dsh-desktop-update')
    const state = await page.evaluate(() => window.desktop.connection.getStatus())
    assert.equal(state.runtimeSource, 'bundled')
    assert.equal(state.settingsIntegration.state, 'mounted')
    return state
  }
  const status = await open()
  await page.waitForFunction(() => !document.querySelector('[data-smart-runtime="bundled"]').disabled)
  await page.locator('[data-smart-runtime="installed"]').click()
  await page.locator('[data-smart-runtime="npx"]').click()
  const pendingStatus = await page.evaluate(() => window.desktop.connection.getStatus())
  assert.equal(pendingStatus.childPid, status.childPid, 'editing sources must not restart the runtime')
  assert.deepEqual(pendingStatus.smartRuntimes, ['bundled'], 'draft must not persist before apply')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await page.locator('[data-smart-runtime="installed"]').getAttribute('aria-pressed'), 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '放弃更改', exact: true }).click()
  await page.waitForSelector('#dsh-desktop-panel', { state: 'detached' })
  await open()
  await page.getByText(/^(通用设置|General|General Settings)$/).click()
  assert.equal(await page.locator('#dsh-desktop-panel').count(), 0)
  await page.keyboard.press('Escape')
  await open()
  assert.equal(await page.locator('#dsh-desktop-tab').count(), 1)
  console.log('official-settings: PASS; bundled DSH ' + status.dshVersion + '; ' + language + '; mount, official navigation restore, reopen')
} finally {
  await app?.close()
  rmSync(home, { recursive: true, force: true })
}
}
