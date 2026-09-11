/** Exercise real sandboxed preload against upstream DOM changes, in isolated homes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'
import { respondToConfirmations } from './lib/confirmation-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-settings-integration-'))
const desktopHome = join(home, 'desktop')
mkdirSync(desktopHome)
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>Settings compatibility fixture</title>'
    + '<style>body{font:14px sans-serif} [role=dialog]{width:800px;min-height:400px}'
    + '.content{display:flex}.navList{width:160px}.options{flex:1}</style><body><main>Chat</main></body>')
})
let app
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  writeFileSync(join(desktopHome, 'settings.json'), JSON.stringify({ serverUrl: origin, connectionMode: 'connect' }))
  app = await electron.launch({
    args: [join(root, '.build/main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env: { ...sanitizedElectronEnv(), DSH_HOME: join(home, 'dsh'), DSH_DESKTOP_HOME: desktopHome,
      DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_SKIP_INSTALLED_DSH: '1', DSH_DESKTOP_SKIP_UPDATE_PROMPT: '1' },
  })
  const page = await app.firstWindow()
  const pressSettingsShortcut = async () => {
    // Native focus transfer is asynchronous on Windows, especially directly
    // after closing the settings window. Queue input only after it completes.
    await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Settings compatibility fixture')
      if (!main.isFocused()) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            main.removeListener('focus', focused)
            reject(new Error('main window did not regain focus'))
          }, 10_000)
          function focused() { clearTimeout(timeout); resolve() }
          main.once('focus', focused)
          main.focus()
        })
      }
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers })
    })
  }
  const closeSettings = async settings => {
    const window = await app.browserWindow(settings)
    // Page.close() can finish when WebContents closes, before BrowserWindow's
    // closed event resets the main-process settings-window reference.
    await window.evaluate(window => new Promise(resolve => {
      window.once('closed', resolve)
      window.close()
    }))
    await window.dispose()
  }
  const warnings = []
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('settings integration unavailable')) warnings.push(message.text())
  })
  await page.waitForFunction(() => document.title === 'Settings compatibility fixture')
  const waitStatus = async (state, reason) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const status = await page.evaluate(async () => (await window.desktop.connection.getStatus()).settingsIntegration)
      if (status.state === state && (reason === undefined || status.reason === reason)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('settings integration did not reach ' + state + ': ' + reason)
  }
  await waitStatus('absent')
  assert.equal(warnings.length, 0, 'closed settings must not produce compatibility warnings')

  const openDialog = async (english = false) => {
    await page.evaluate(english => {
      document.querySelector('[role=dialog]')?.remove()
      const dialog = document.createElement('section')
      dialog.setAttribute('role', 'dialog')
      dialog.innerHTML = '<h1>' + (english ? 'Settings' : '设置') + '</h1>'
        + '<div class="content"><nav class="navList"><button class="active_test">'
        + (english ? 'General' : '通用设置') + '</button><button>Models</button></nav>'
        + '<div class="options"><div id="official-panel" style="display:flex">Official settings</div></div></div>'
      document.body.append(dialog)
    }, english)
    await page.waitForSelector('#dsh-desktop-tab')
    await waitStatus('mounted')
    assert.equal(await page.locator('#dsh-desktop-tab').count(), 1)
  }
  await openDialog()
  await page.locator('#dsh-desktop-tab').click()
  await page.waitForSelector('#dsh-desktop-panel')
  assert.equal(await page.locator('#official-panel').evaluate(el => el.style.display), 'none')

  // The fixture is a custom connection, so applying sources persists the
  // preference without replacing the test server. Exercise the actual IPC.
  await page.waitForFunction(() => !document.querySelector('[data-smart-runtime="bundled"]').disabled)
  await page.locator('#dsh-enhance-smart').evaluate(el => { el.hidden = false })
  const sourcesBefore = await page.evaluate(async () => (await window.desktop.connection.getStatus()).smartRuntimes)
  await page.locator('[data-smart-runtime="installed"]').click()
  await page.locator('[data-smart-runtime="npx"]').click()
  assert.deepEqual(await page.evaluate(async () => (await window.desktop.connection.getStatus()).smartRuntimes), sourcesBefore)
  await page.locator('.navList button').first().click()
  await page.waitForSelector('dialog[open]')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#dsh-desktop-panel').count(), 1)
  assert.equal(await page.locator('dialog[open]').count(), 0)
  assert.equal(await page.locator('[data-smart-runtime="installed"]').getAttribute('aria-pressed'), 'false', 'closing warning retains draft')
  assert.equal(await page.locator('[data-runtime-apply]').isEnabled(), true)
  await respondToConfirmations(app)
  await page.locator('[data-runtime-apply]').click()
  await page.waitForFunction(() => document.querySelector('[data-runtime-status]').textContent === '已应用来源设置', null, { timeout: 10000 }).catch(async error => {
    console.error('runtime editor:', await page.locator('#dsh-enhance-runtime-editor').innerText())
    throw error
  })
  assert.deepEqual(await page.evaluate(async () => (await window.desktop.connection.getStatus()).smartRuntimes), ['probe', 'bundled'])
  console.log('✓ source draft stays local; navigation warning preserves edits; one batch persists through real IPC')

  // A new wrapper breaks the known content hierarchy while preserving live
  // official elements. Cleanup must restore their exact inline display/class.
  await page.evaluate(() => {
    const content = document.querySelector('.content')
    const wrapper = document.createElement('div')
    content.parentElement.insertBefore(wrapper, content)
    wrapper.append(content)
  })
  await waitStatus('unsupported', 'missing-content')
  assert.equal(await page.locator('#dsh-desktop-tab, #dsh-desktop-panel').count(), 0)
  assert.equal(await page.locator('#official-panel').evaluate(el => el.style.display), 'flex')
  assert.equal(await page.locator('.navList button').first().evaluate(el => el.classList.contains('active_test')), true)
  assert.equal(await page.locator('[data-dsh-hidden], [data-dsh-nav-hooked]').count(), 0)

  // Native entry is usable even while integration is unsupported. Exercise the
  // real menu callback on macOS and the cross-platform keyboard path elsewhere.
  const settingsOpened = app.waitForEvent('window')
  if (process.platform === 'darwin') {
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().getMenuItemById('desktop-settings')
      if (!item) throw new Error('native settings entry missing')
      item.click()
    })
  } else {
    await pressSettingsShortcut()
  }
  const settings = await settingsOpened
  await settings.waitForSelector('#versions')
  await settings.waitForFunction(() => document.getElementById('versions').textContent.includes('v'))
  assert.equal(await settings.locator('#update-check').count(), 1)
  assert.equal(await settings.evaluate(async () => (await (await fetch('desktop/status')).json()).settingsIntegration.reason), 'missing-content')
  await settings.waitForFunction(() => !document.getElementById('market-toggle').disabled)
  await settings.waitForFunction(() => /未安装|Not installed/.test(document.getElementById('market-status').textContent))
  const marketProfile = join(home, 'dsh/profiles/web')
  const marketPackage = join(marketProfile, 'node_modules/dsh-desktop-safe-market')
  mkdirSync(marketPackage, { recursive: true })
  writeFileSync(join(marketPackage, 'package.json'), JSON.stringify({ name: 'dsh-desktop-safe-market', version: '0.5.1' }))
  writeFileSync(join(marketProfile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-desktop-safe-market'] } } }))
  await settings.waitForFunction(() => document.getElementById('market-status').textContent.includes('0.5.1'))
  // Model self-uninstall's disk changes while the settings panel stays open.
  writeFileSync(join(marketProfile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  rmSync(marketPackage, { recursive: true })
  await settings.waitForFunction(() => /未安装|Not installed/.test(document.getElementById('market-status').textContent))
  assert.equal(await settings.locator('#market-toggle').getAttribute('aria-checked'), 'true', 'automatic-loading preference is distinct from installation')
  assert.match(await settings.locator('#market-label').textContent(), /启动时|on startup/)
  assert.equal(await settings.locator('#market-restart').isVisible(), false)
  await settings.locator('#market-toggle').click()
  await settings.waitForFunction(() => document.getElementById('market-toggle').getAttribute('aria-checked') === 'false'
    && !document.getElementById('market-toggle').disabled)
  assert.equal(JSON.parse(readFileSync(join(desktopHome, 'settings.json'), 'utf8')).bundledMarketDisabled, true)
  assert.equal(await settings.locator('#market-restart').isVisible(), false, 'connect mode must not offer to apply settings by restart')
  assert.doesNotMatch(await settings.locator('#market-note').textContent(), /可立即重启|Restart now/)
  // Electron's intercepted responses report status 0 here. Use explicit Response
  // fixtures for capability/error states, leaving saves and the real status read intact.
  await settings.evaluate(() => {
    const original = window.fetch.bind(window)
    window.restoreRestartFixture = () => { window.fetch = original }
    window.restartFixture = { started: false, error: 'fixture busy' }
    window.fetch = async (url, init) => {
      if (String(url) === 'desktop/restart') return new Response(JSON.stringify(window.restartFixture), { status: window.restartFixture.started ? 200 : 409 })
      const response = await original(url, init)
      if (String(url) !== 'desktop/status') return response
      return new Response(JSON.stringify({ ...await response.json(), marketRestartAvailable: true }), { status: 200 })
    }
    window.dispatchEvent(new Event('focus'))
  })
  await settings.locator('#market-restart').waitFor({ state: 'visible' })
  await settings.locator('#market-restart').click()
  await settings.waitForFunction(() => document.getElementById('market-note').textContent.includes('fixture busy'))
  assert.equal(await settings.locator('#market-restart').isEnabled(), true)
  assert.equal(await settings.locator('#market-toggle').isEnabled(), true)
  await settings.evaluate(() => { window.restartFixture = { started: false } })
  await settings.locator('#market-restart').click()
  await settings.waitForFunction(() => document.getElementById('market-note').textContent === '重启未完成：重启失败')
  await settings.evaluate(() => { window.restartFixture = { started: true } })
  await settings.locator('#market-restart').click()
  await settings.waitForFunction(() => !document.getElementById('market-restart').disabled, null, { timeout: 20_000 })
  assert.match(await settings.locator('#market-note').textContent(), /尚未确认|not been confirmed/)
  assert.equal(await page.evaluate(async () => (await window.desktop.connection.getMarket()).enabled), false)
  await settings.locator('#market-toggle').click()
  await settings.waitForFunction(() => document.getElementById('market-toggle').getAttribute('aria-checked') === 'true'
    && !document.getElementById('market-toggle').disabled)
  assert.equal(JSON.parse(readFileSync(join(desktopHome, 'settings.json'), 'utf8')).bundledMarketDisabled, false)
  assert.match(await settings.locator('#market-restart').textContent(), /立即重启|Restart now/)
  await settings.evaluate(() => window.restoreRestartFixture())
  await settings.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settings.locator('#market-restart').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(async () => (await window.desktop.connection.getMarket()).enabled), true)
  await settings.screenshot({ path: join(tmpdir(), 'dsh-desktop-settings-integration.png'), fullPage: true })
  await closeSettings(settings)
  const shortcutOpened = app.waitForEvent('window')
  await pressSettingsShortcut()
  const shortcutSettings = await shortcutOpened
  await shortcutSettings.waitForSelector('#market-toggle')
  await closeSettings(shortcutSettings)

  // Repeated streaming mutations do not flood diagnostics.
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) document.querySelector('main').append(document.createElement('span'))
  })
  await openDialog(true)
  await page.locator('#dsh-desktop-tab').click()
  await page.waitForSelector('#dsh-desktop-panel')
  // Official keyboard/programmatic tab changes must regain control.
  await page.evaluate(() => {
    document.querySelectorAll('.navList button')[2].classList.add('active_test')
  })
  await page.waitForFunction(() => !document.getElementById('dsh-desktop-panel'))
  assert.equal(await page.locator('#official-panel').evaluate(el => el.style.display), 'flex')
  await page.evaluate(() => {
    document.querySelector('.navList').className = 'redesigned-navigation'
  })
  await waitStatus('unsupported', 'missing-navigation')
  await page.evaluate(() => { document.querySelector('.redesigned-navigation').className = 'navList' })
  await waitStatus('mounted')
  await page.evaluate(() => { document.querySelector('.navList button').textContent = 'Preferences' })
  await waitStatus('unsupported', 'missing-general-tab')
  await page.evaluate(() => document.querySelector('[role=dialog]').remove())
  await waitStatus('absent')
  await openDialog()
  assert.equal(warnings.filter(text => text.includes('missing-content')).length, 1)
  assert.equal(warnings.filter(text => text.includes('missing-navigation')).length, 1)
  assert.equal(warnings.filter(text => text.includes('missing-general-tab')).length, 1)
  // Teardown disconnects observers and restores the official surface; a
  // cached document restoration installs exactly one new integration.
  await page.locator('#dsh-desktop-tab').click()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  assert.equal(await page.locator('#dsh-desktop-tab').count(), 0)
  assert.equal(await page.locator('#dsh-desktop-panel').count(), 0)
  await page.evaluate(() => document.body.append(document.createElement('div')))
  await page.waitForTimeout(100)
  assert.equal(await page.locator('#dsh-desktop-tab').count(), 0)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await page.waitForSelector('#dsh-desktop-tab')
  assert.equal(await page.locator('#dsh-desktop-tab').count(), 1)
  console.log('✓ page teardown restores official DOM; cached-document restoration remounts once')
  console.log('✓ absent / mounted / unsupported diagnostics, bounded warnings, Chinese and English remount')
  console.log('✓ structural changes restore official styles and navigation; programmatic tab changes regain control')
  console.log('✓ native settings opens and loads live status independently of injection; market changes persist and agree with IPC')
} finally {
  await app?.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
