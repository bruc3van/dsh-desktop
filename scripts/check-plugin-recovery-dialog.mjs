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
    import { showPluginRecoveryDialog } from './dialog.mjs';
    app.on('window-all-closed', () => {});
    void app.whenReady().then(() => {
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
    assert.equal(layout.width, 560)
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
} finally {
  await app?.close()
  rmSync(work, { recursive: true, force: true })
}
