/** Both settings surfaces must stage one batch and retain failed edits. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-selection-'))
let app
try {
  const entry = join(scratch, 'main.cjs')
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadURL('about:blank')})`)
  const rendered = join(scratch, 'settings.mjs')
  await build({ stdin: { contents: "export {renderSettingsPageHtml} from './src/main/pages/settings.ts';export {renderSettingsPageScript} from './src/main/pages/settings-script.ts'", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: rendered, plugins: [{ name: 'release-link', setup(builder) {
    builder.onResolve({ filter: /\/updater\.ts$/ }, () => ({ path: 'updater', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const RELEASES_PAGE_URL="https://example.invalid/releases"' }))
  } }] })
  const { renderSettingsPageHtml, renderSettingsPageScript } = await import(pathToFileURL(rendered).href)
  const card = await build({ entryPoints: [join(root, 'src/main/preload/connection-card.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'TestCard', write: false, plugins: [{ name: 'fixture-bridge', setup(builder) {
    builder.onResolve({ filter: /^\.\/bridge\.ts$/ }, () => ({ path: 'bridge', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const connection={getStatus:async()=>window.fixtureStatus,getMarket:async()=>({enabled:false}),setSmartRuntimes:ids=>window.saveSources(ids)}' }))
  } }] })
  app = await electron.launch({ args: [entry, '--user-data-dir=' + join(scratch, 'profile')], env: sanitizedElectronEnv() })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const surface of ['injected', 'standalone-zh', 'standalone-en']) {
    await page.goto('about:blank')
    const injected = surface === 'injected'
    const chinese = surface !== 'standalone-en'
    await page.setContent(injected
      ? '<section role="dialog"><h1>设置</h1><button id="leave">关闭</button><div id="panel"></div></section>'
      : renderSettingsPageHtml(chinese, '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''))
    await page.evaluate(() => {
      window.fixtureStatus = { mode: 'local', selectedMode: 'smart', smartRuntimes: ['probe', 'installed', 'npx', 'bundled'], dshDataMode: 'shared', desktopVersion: 'test', dshVersion: 'test', savedServerUrl: '', localWebPort: 0 }
      window.saves = []
      window.saveSources = ids => new Promise((resolve, reject) => { window.saves.push(ids); window.finishSave = resolve; window.failSave = reject })
      window.fetch = async (url, init) => {
        let value = {}
        if (url === 'desktop/status' || url === 'desktop/settings') value = window.fixtureStatus
        if (url === 'desktop/update') value = { phase: 'idle' }
        if (url === 'desktop/smart-runtimes') value = await window.saveSources(JSON.parse(init.body).smartRuntimes)
        return { ok: true, json: async () => value }
      }
      if (!document.getElementById('leave')) {
        const leave = document.createElement('button'); leave.id = 'leave'; leave.textContent = 'Close'; document.body.appendChild(leave)
      }
      document.getElementById('leave').onclick = () => { window.left = true }
    })
    if (injected) {
      await page.addScriptTag({ content: card.outputFiles[0].text })
      await page.evaluate(() => TestCard.injectEnhance(document.getElementById('panel')))
    } else await page.addScriptTag({ content: renderSettingsPageScript(chinese) })
    const pick = id => page.locator('[data-smart-runtime="' + id + '"]')
    const apply = page.locator('[data-runtime-apply]')
    const undo = page.locator('[data-runtime-undo]')
    await page.waitForFunction(() => !document.querySelector('[data-smart-runtime="bundled"]').disabled)
    // Hover hints must never insert rows or move the actions below the sources.
    const layout = () => page.locator('[data-smart-runtime],[data-runtime-apply]').evaluateAll(elements =>
      elements.map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }))
    const baselineLayout = await layout()
    for (let pass = 0; pass < 3; pass++) {
      for (const id of ['probe', 'installed', 'npx', 'bundled']) {
        const box = await pick(id).boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        assert.deepEqual(await layout(), baselineLayout, surface + ': hover must not shift layout')
        assert.ok(await pick(id).getAttribute('title'), 'hover description remains available')
      }
      await page.mouse.move(0, 0)
      assert.deepEqual(await layout(), baselineLayout, surface + ': mouseleave must not shift layout')
    }
    assert.equal(await apply.isDisabled(), true)
    await pick('installed').click()
    await pick('npx').click()
    assert.deepEqual(await page.evaluate(() => window.saves), [], 'editing must not save or reconnect')
    assert.equal(await pick('installed').getAttribute('aria-pressed'), 'false')
    await pick('bundled').hover()
    assert.match(await page.locator('[data-runtime-status]').innerText(), /未应用|Unapplied/)
    await apply.click()
    assert.equal(await apply.isDisabled(), true)
    assert.equal(await pick('probe').isDisabled(), true)
    await apply.evaluate(el => el.click())
    assert.deepEqual(await page.evaluate(() => window.saves), [['probe', 'bundled']], 'exactly one final batch')
    await page.evaluate(() => window.finishSave({ saved: false, smartRuntimes: window.fixtureStatus.smartRuntimes, error: 'occupied fixture' }))
    await page.waitForFunction(() => !document.querySelector('[data-runtime-apply]').disabled)
    assert.equal(await pick('installed').getAttribute('aria-pressed'), 'false', 'refusal retains draft')
    assert.match(await page.locator('[data-runtime-status]').innerText(), /occupied fixture/)
    await apply.click()
    await page.evaluate(() => window.failSave(new Error('network fixture')))
    await page.waitForFunction(() => !document.querySelector('[data-runtime-apply]').disabled)
    assert.match(await page.locator('[data-runtime-status]').innerText(), /network fixture/)
    await apply.click()
    await page.evaluate(() => window.finishSave({ saved: true, smartRuntimes: ['probe', 'bundled'] }))
    await page.waitForFunction(() => document.querySelector('[data-runtime-undo]').disabled)
    await pick('probe').click()
    await pick('bundled').click()
    assert.equal(await apply.isDisabled(), true, 'empty draft cannot apply')
    await undo.click()
    assert.equal(await pick('probe').getAttribute('aria-pressed'), 'true')
    assert.equal(await apply.isDisabled(), true)
    await pick('installed').click()
    await pick('installed').click()
    assert.equal(await apply.isDisabled(), true, 'return to baseline is clean')
    await pick('installed').click()
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog[open]')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('dialog[open]').count(), 0, 'Escape dismisses only the warning')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: chinese ? '继续编辑' : 'Continue editing', exact: true }).click()
    assert.equal(await pick('installed').getAttribute('aria-pressed'), 'true')
    await page.locator('#leave').click()
    assert.equal(await page.evaluate(() => window.left), undefined)
    await page.getByRole('button', { name: chinese ? '放弃更改' : 'Discard changes', exact: true }).click()
    assert.equal(await page.evaluate(() => window.left), true)
    assert.equal(await pick('installed').getAttribute('aria-pressed'), 'false')
    if (injected) await page.screenshot({ path: join(tmpdir(), 'dsh-runtime-selection.png'), fullPage: true })
    console.log('runtime-selection: PASS ' + surface + '; batch, duplicate apply, validation, failure/retry, undo, dismissal')
  }
  assert.deepEqual(errors, [])
} finally {
  await app?.close()
  rmSync(scratch, { recursive: true, force: true })
}
