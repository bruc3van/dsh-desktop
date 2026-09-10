import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-recovery-dialog-'))
let app
try {
  await build({ entryPoints: ['src/main/plugin-recovery-dialog.ts'], outfile: join(work, 'dialog.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
  writeFileSync(join(work, 'main.mjs'), `import { app } from 'electron';
    import { showPluginRecoveryDialog, showConfirmationDialog } from './dialog.mjs';
    app.on('window-all-closed', () => {});
    void app.whenReady().then(() => {
    globalThis.openConfirmation = (owner = null) => {
      globalThis.answer = undefined;
      void showConfirmationDialog(owner, {
        message: '当前页面请求更改智能连接来源',
        detail: '这会决定智能模式下尝试哪些来源（本机已运行、本机已安装、npx 缓存、客户端内置）。请求来自：http://127.0.0.1:3080',
        buttons: ['取消', '继续'], defaultId: 0, cancelId: 0,
      }, true).then(value => { globalThis.answer = value });
    };
    globalThis.openRecovery = (chinese, count, canRemove = true) => {
      const buttons = chinese ? ['卸载全部并重试', '使用独立环境', '取消'] : ['Remove all and retry', 'Use isolated environment', 'Cancel'];
      if (!canRemove) buttons.shift();
      globalThis.answer = undefined;
      void showPluginRecoveryDialog(null, {
        message: chinese ? '共享环境中的插件与当前 DSH 不兼容' : 'Plugins in the shared environment are incompatible with this DSH version',
        detail: chinese ? '原来的对话、凭据和模型配置没有丢失。你可以一次卸载下面列出的插件并重试，或保留它们并使用桌面端独立环境。' : 'Your conversations, credentials, and model configuration are still intact. Remove all plugins listed below and retry, or keep them and use the isolated desktop environment.',
        buttons, defaultId: canRemove ? 1 : 0, cancelId: buttons.length - 1,
      }, Array.from({length: count}, (_, i) => '@example/dsh-' + 'long-plugin-name-'.repeat(5) + i), chinese).then(value => { globalThis.answer = value });
    };
    globalThis.openRecovery(true, 100);
    });`)
  app = await electron.launch({ args: [join(work, 'main.mjs'), '--user-data-dir=' + join(work, 'chromium')], env: sanitizedElectronEnv() })
  for (const [index, chinese, count, key, answer, canRemove = true] of [[0, true, 100, 'Escape', 2], [1, false, 100, 'Enter', 1], [2, true, 2, null, 0], [3, true, 0, 'Enter', 0, false], [4, false, 2, 'Escape', 1, false], [5, true, 2, 'Close', 2]]) {
    if (index) await app.evaluate((_, args) => globalThis.openRecovery(...args), [chinese, count, canRemove])
    const page = await app.firstWindow()
    // The DOM loads before prompt.show(); do not close a still-opening native window.
    for (let attempt = 0; attempt < 50 && !await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()), true)
    await page.locator('#default-action').waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'default-action', null, { timeout: 15_000 })
    const layout = await page.evaluate(() => {
      const list = document.querySelector('ul')
      const footer = document.querySelector('footer').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('footer a')].map(button => button.getBoundingClientRect())
      return { sameRow: buttons.every(button => button.top === buttons[0].top && button.height === buttons[0].height), listHeight: list?.clientHeight ?? 0, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, scroll: list ? list.scrollHeight > list.clientHeight : false, footerVisible: footer.bottom <= innerHeight && footer.top >= 0 }
    })
    const windowSize = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return {
        outerWidth: window.getBounds().width,
        contentWidth: window.getContentBounds().width,
        expectedWidth: Math.min(560, screen.getPrimaryDisplay().workAreaSize.width),
      }
    })
    // BrowserWindow width includes the native frame; innerWidth does not.
    assert.equal(windowSize.outerWidth, windowSize.expectedWidth)
    assert.ok(Math.abs(layout.width - windowSize.contentWidth) <= 1, 'DOM width matches native content bounds within DPI rounding')
    assert.equal(layout.sameRow, true)
    if (count) assert.ok(layout.listHeight > 200)
    assert.equal(layout.overflow, false)
    assert.equal(layout.footerVisible, true)
    if (count === 100) assert.equal(layout.scroll, true)
    if (key === 'Close') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    else if (key) await app.evaluate(({ BrowserWindow }, key) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    }, key)
    else await page.locator('a').first().click()
    for (let attempt = 0; attempt < 50 && await app.evaluate(() => globalThis.answer) === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await app.evaluate(() => globalThis.answer), answer)
    console.log('✓', chinese ? 'Chinese' : 'English', count, 'plugins: bounded layout and action', answer)
  }
  for (const [theme, action, expected] of [['light', 'Enter', 0], ['dark', 'Escape', 0], ['light', 'Continue', 1], ['dark', 'Close', 0]]) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; globalThis.openConfirmation() }, theme)
    const page = await app.firstWindow()
    await page.waitForFunction(() => document.activeElement?.id === 'default-action')
    for (let attempt = 0; attempt < 50 && !await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()), true)
    await page.emulateMedia({ colorScheme: theme })
    await page.waitForFunction(theme => matchMedia('(prefers-color-scheme: dark)').matches === (theme === 'dark'), theme, { timeout: 5000 })
    assert.equal(await page.locator('#default-action').innerText(), '取消')
    assert.equal(await page.locator('.primary').innerText(), '继续')
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('footer').getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth > innerWidth, footerVisible: footer.bottom <= innerHeight, textVisible: document.querySelector('.content').scrollHeight <= document.querySelector('.content').clientHeight }
    })
    assert.deepEqual(layout, { overflow: false, footerVisible: true, textVisible: true })
    await page.screenshot({ path: join(tmpdir(), 'dsh-confirmation-' + theme + '.png') })
    if (action === 'Continue') await page.locator('.primary').click()
    else await app.evaluate(({ BrowserWindow }, action) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (action === 'Close') window.close()
      else {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: action })
        if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode: action })
      }
    }, action)
    for (let attempt = 0; attempt < 50 && await app.evaluate(() => globalThis.answer) === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await app.evaluate(() => globalThis.answer), expected)
    console.log('✓ confirmation', theme, action, 'layout and response', expected)
  }
  await app.evaluate(async ({ BrowserWindow }) => {
    globalThis.confirmationOwner = new BrowserWindow({ width: 640, height: 480 })
    await globalThis.confirmationOwner.loadURL('data:text/html,<title>Confirmation owner</title>')
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = app.waitForEvent('window', { timeout: 10_000 })
    await app.evaluate(() => { globalThis.openConfirmation(globalThis.confirmationOwner) })
    const page = await opened
    const native = await app.browserWindow(page)
    for (let poll = 0; poll < 100 && !await native.evaluate(window => window.isVisible()); poll++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await native.evaluate(window => window.isVisible() && window.isModal()), true)
    await page.waitForFunction(() => document.activeElement?.id === 'default-action', null, { timeout: 10_000 })
    const closed = page.waitForEvent('close', { timeout: 10_000 })
    await page.locator('.primary').click({ noWaitAfter: true }).catch(error => { if (!page.isClosed()) throw error })
    await closed
    for (let poll = 0; poll < 100 && await app.evaluate(() => globalThis.answer) === undefined; poll++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await app.evaluate(() => globalThis.answer), 1)
  }
  console.log('✓ consecutive parent-owned confirmations become visible and accept real button clicks')
} finally {
  await app?.close()
  rmSync(work, { recursive: true, force: true })
}
