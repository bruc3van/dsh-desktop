/**
 * Connection-mode integration check: legacy remote settings remain active,
 * then the shortcut toggles to Smart local mode and back without losing the
 * saved remote origin.
 */

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const checkHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-connection-'))
const desktopHome = join(checkHome, 'desktop')
mkdirSync(desktopHome, { recursive: true })

/**
 * A stand-in for the official settings dialog. The STRUCTURE is what the
 * preload's heuristics read (a visible [role="dialog"] mentioning 设置, a
 * navList whose active item is 通用设置, and a content > options > panel
 * column — the preload clones the 通用设置 item into its own 桌面设置 tab,
 * which is where the connection card lives); the styling below only makes
 * the window legible when a run is watched, so a bare fixture is not
 * mistaken for a broken product surface.
 * The official theme variables are declared for the same reason: the injected
 * card resolves its colors from them, exactly as it does in the real UI.
 */
const FIXTURE_STYLE = ':root{color-scheme:light;'
  + '--dsw-alias-label-primary:#0F1115;--dsw-alias-label-secondary:#6E7480;--dsw-alias-label-tertiary:#8A9099;'
  + '--dsw-alias-label-dimmed:#9AA0A6;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-module-platform:#EBEEF2;'
  + '--dsw-alias-border-l2:#D8D8D4;--dsw-alias-interactive-bg-hover:#F5F6F7;'
  + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
  + '*{box-sizing:border-box}'
  + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eceef1;color:#0f1115;font-size:14px}'
  + '[role="dialog"]{display:flex;flex-direction:column;width:min(880px,calc(100vw - 64px));'
  + 'height:min(620px,calc(100vh - 64px));background:#fff;border-radius:16px;box-shadow:0 24px 64px rgba(15,17,21,.18);overflow:hidden}'
  + '.head{display:flex;align-items:center;padding:20px 24px 12px;font-size:18px;font-weight:600;letter-spacing:-.01em}'
  + '.content{display:flex;flex:1;min-height:0}'
  + '.navList{width:200px;flex:0 0 auto;padding:8px 12px;display:flex;flex-direction:column;gap:4px}'
  + '.navList button{width:100%;text-align:left;padding:9px 12px;border:none;border-radius:8px;background:transparent;'
  + 'font:inherit;color:#0f1115;cursor:pointer}'
  + '.navList .active,.navList button.active{background:#f0f1f3;font-weight:500}'
  + '.options{flex:1;min-width:0;overflow:auto;padding:0 24px 24px}'
  + '.options>div>p{margin:0;padding:16px 0;color:#6e7480}'

// A THIRD origin, standing in for an OAuth callback or an embedded preview: a
// sub-frame of the Web UI is entitled to redirect off-origin. Only the top
// frame carries the preload, so only the top frame is the navigation guard's
// business — see the sub-frame assertion below.
const thirdPartyServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>Third Party</title><body><p id="landed">third-party frame</p>')
})
await new Promise((resolve, reject) => {
  thirdPartyServer.once('error', reject)
  thirdPartyServer.listen(0, '127.0.0.1', resolve)
})
const thirdPartyAddress = thirdPartyServer.address()
if (typeof thirdPartyAddress !== 'object' || thirdPartyAddress === null) throw new Error('third-party server did not bind')
const thirdPartyOrigin = 'http://127.0.0.1:' + String(thirdPartyAddress.port)

const remoteServer = createServer((req, res) => {
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    return
  }
  if (req.url === '/redirect-frame') {
    res.writeHead(302, { location: thirdPartyOrigin + '/landed' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>Remote Harness Fixture</title><style>' + FIXTURE_STYLE + '</style></head><body>'
    + '<div role="dialog"><div class="head">设置</div>'
    + '<div class="content"><div class="navList"><button class="active">通用设置</button></div>'
    + '<div class="options"><div><p>fixture setting</p></div></div></div></div>'
    + '<iframe id="cross-origin-frame" src="/redirect-frame" hidden></iframe></body></html>')
})
await new Promise((resolve, reject) => {
  remoteServer.once('error', reject)
  remoteServer.listen(0, '127.0.0.1', resolve)
})
const address = remoteServer.address()
if (typeof address !== 'object' || address === null) throw new Error('fixture server did not bind')
const remoteOrigin = 'http://127.0.0.1:' + String(address.port)

// Legacy documents had only serverUrl. They must still boot in Pinned address mode.
writeFileSync(join(desktopHome, 'settings.json'), JSON.stringify({ serverUrl: remoteOrigin }, null, 2) + '\n')

const electronEnv = { ...process.env }
Reflect.deleteProperty(electronEnv, 'ELECTRON_RUN_AS_NODE')
electronEnv.DSH_HOME = join(checkHome, 'dsh')
electronEnv.DSH_DESKTOP_HOME = desktopHome
// Keep Smart mode deterministic without booting the full bundled runtime:
// this same live fixture is both the legacy pinned target and Smart's probe.
electronEnv.DSH_DESKTOP_PROBE_URL = remoteOrigin
Reflect.deleteProperty(electronEnv, 'DSH_DESKTOP_SKIP_PROBE')
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'

/** Poll through document swaps until the connection state settles. */
async function waitForStatus(app, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    for (const window of app.windows()) {
      try {
        last = await window.evaluate(() => window.desktop?.connection.getStatus())
        if (last && predicate(last)) return { window, status: last }
      } catch { /* reconnecting replaces the current document */ }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('status condition timed out: ' + JSON.stringify(last))
}

let app
try {
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'chromium')],
    env: electronEnv,
  })
  let window = await app.firstWindow()
  await window.waitForFunction(() => document.title === 'Remote Harness Fixture', null, { timeout: 10_000 })
  const legacyStatus = await window.evaluate(() => window.desktop.connection.getStatus())
  if (legacyStatus.selectedMode !== 'connect' || legacyStatus.savedServerUrl !== remoteOrigin || !legacyStatus.canSwitch) {
    throw new Error('legacy remote settings were not exposed as switchable Pinned address mode: ' + JSON.stringify(legacyStatus))
  }
  // will-redirect fires for EVERY frame, unlike will-navigate. Guarding it
  // without the isMainFrame test cancels this ordinary sub-frame 302 and pops
  // the system browser for it; the frame would then sit empty forever.
  const framedOrigin = await window
    .frameLocator('#cross-origin-frame').locator('#landed')
    .waitFor({ state: 'attached', timeout: 5_000 })
    .then(() => window.frames().map(frame => new URL(frame.url()).origin).find(origin => origin === thirdPartyOrigin) ?? 'none',
      () => 'frame never landed')
  if (framedOrigin !== thirdPartyOrigin) {
    throw new Error('cross-origin sub-frame redirect was blocked by the top-frame navigation guard: ' + framedOrigin)
  }
  if (new URL(window.url()).origin !== remoteOrigin) {
    throw new Error('the top frame left the configured origin: ' + window.url())
  }

  // The connection card lives on the injected 桌面设置 tab now, not the
  // general panel — select it the way a user would.
  await window.locator('#dsh-desktop-tab').waitFor({ state: 'visible', timeout: 3_000 })
  await window.click('#dsh-desktop-tab')
  await window.locator('#dsh-desktop-enhance').waitFor({ state: 'visible', timeout: 3_000 })
  if (await window.locator('#dsh-enhance-switch').textContent() !== '切换到智能模式'
    || await window.locator('#dsh-enhance-url').inputValue() !== remoteOrigin) {
    throw new Error('enhanced connection card did not expose the saved remote shortcut')
  }
  if (await window.locator('#dsh-enhance-runtimes [data-smart-runtime]').count() !== 4) {
    throw new Error('enhanced connection card is missing Smart-mode source toggles')
  }
  const remoteSettingsPagePromise = app.waitForEvent('window')
  await window.evaluate(() => { window.desktop.openConnectionSettings() })
  const remoteSettingsPage = await remoteSettingsPagePromise
  await remoteSettingsPage.waitForFunction(() => document.querySelector('#switch')?.hidden === false)
  if (await remoteSettingsPage.locator('#switch').textContent() !== '切换到智能模式') {
    throw new Error('pinned-address shortcut did not offer Smart mode')
  }
  if (await remoteSettingsPage.locator('[data-smart-runtime]').count() !== 4) {
    throw new Error('native connection page is missing Smart-mode source toggles')
  }
  // This page is the client's own loopback, so the save does not go through
  // the remote-origin confirmation the injected card would hit.
  const emptySources = await remoteSettingsPage.evaluate(async () => {
    const response = await fetch('desktop/smart-runtimes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ smartRuntimes: [] }),
    })
    return response.json()
  })
  if (emptySources.saved) {
    throw new Error('an empty Smart-mode source list was accepted: ' + JSON.stringify(emptySources))
  }
  const onlyBundled = await remoteSettingsPage.evaluate(async () => {
    const response = await fetch('desktop/smart-runtimes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ smartRuntimes: ['bundled'] }),
    })
    return response.json()
  })
  if (!onlyBundled.saved || JSON.stringify(onlyBundled.smartRuntimes) !== JSON.stringify(['bundled'])) {
    throw new Error('Smart-mode source save failed: ' + JSON.stringify(onlyBundled))
  }
  const savedRuntimes = JSON.parse(readFileSync(join(desktopHome, 'settings.json'), 'utf8'))
  if (JSON.stringify(savedRuntimes.smartRuntimes) !== JSON.stringify(['bundled'])) {
    throw new Error('Smart-mode sources were not persisted: ' + JSON.stringify(savedRuntimes))
  }
  if (new URL(window.url()).origin !== remoteOrigin) {
    throw new Error('toggling Smart-mode sources in Connect mode left the pinned origin: ' + window.url())
  }
  const restoredSources = await remoteSettingsPage.evaluate(async () => {
    const response = await fetch('desktop/smart-runtimes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ smartRuntimes: ['probe', 'installed', 'npx', 'bundled'] }),
    })
    return response.json()
  })
  if (!restoredSources.saved) {
    throw new Error('restoring Smart-mode sources failed: ' + JSON.stringify(restoredSources))
  }
  const toSmart = await window.evaluate(() => window.desktop.connection.switchMode())
  if (!toSmart.switched || toSmart.mode !== 'smart') throw new Error('failed to switch to Smart mode: ' + JSON.stringify(toSmart))
  ({ window } = await waitForStatus(app, status => status.selectedMode === 'smart' && status.targetUrl !== ''))
  const smartSettings = JSON.parse(readFileSync(join(desktopHome, 'settings.json'), 'utf8'))
  if (smartSettings.serverUrl !== remoteOrigin || smartSettings.connectionMode !== 'smart') {
    throw new Error('Smart switch did not preserve the remote origin: ' + JSON.stringify(smartSettings))
  }
  await remoteSettingsPage.reload()
  await remoteSettingsPage.waitForFunction(() => document.querySelector('#save')?.textContent === '保存并连接')
  if (!await remoteSettingsPage.locator('#switch').isHidden()
    || await remoteSettingsPage.locator('#save').textContent() !== '保存并连接'
    || await remoteSettingsPage.locator('#url').inputValue() !== remoteOrigin) {
    throw new Error('Smart mode did not retain the address behind one clear save-and-connect action')
  }
  await remoteSettingsPage.close()
  await new Promise(resolve => setTimeout(resolve, 100))

  const toRemote = await window.evaluate(() => window.desktop.connection.switchMode())
  if (!toRemote.switched || toRemote.mode !== 'connect') throw new Error('failed to switch back to Pinned address mode: ' + JSON.stringify(toRemote))
  await window.waitForFunction(() => document.title === 'Remote Harness Fixture', null, { timeout: 10_000 })
  const remoteSettings = JSON.parse(readFileSync(join(desktopHome, 'settings.json'), 'utf8'))
  if (remoteSettings.serverUrl !== remoteOrigin || remoteSettings.connectionMode !== 'connect') {
    throw new Error('Connect switch was not persisted: ' + JSON.stringify(remoteSettings))
  }

  // Saving an empty address while already in Smart local mode resolves to the
  // origin the window is ALREADY showing. That still has to reconnect: without
  // it the card's "已保存，正在重连…" note stays on screen forever. Left for
  // last, because an empty save legitimately drops the saved remote address.
  const backToSmart = await window.evaluate(() => window.desktop.connection.switchMode())
  if (!backToSmart.switched || backToSmart.mode !== 'smart') {
    throw new Error('failed to return to Smart mode: ' + JSON.stringify(backToSmart))
  }
  ({ window } = await waitForStatus(app, status => status.selectedMode === 'smart' && status.targetUrl !== ''))
  await window.evaluate(() => { window.__dshReconnectMarker = 1 })
  const resaved = await window.evaluate(() => window.desktop.connection.saveServerUrl(''))
  if (!resaved.saved) throw new Error('saving the unchanged Smart selection failed: ' + JSON.stringify(resaved))
  await window.waitForFunction(() => window.__dshReconnectMarker === undefined, null, { timeout: 30_000 })
  await waitForStatus(app, status => status.selectedMode === 'smart' && status.targetUrl !== '')

  console.log('✓ legacy remote configuration remains active')
  console.log('✓ a cross-origin sub-frame redirect is not treated as a top-frame navigation')
  console.log('✓ enhanced connection card shows the saved remote shortcut')
  console.log('✓ Smart-mode source toggles persist without leaving Connect mode')
  console.log('✓ native settings shows the context-aware shortcut')
  console.log('✓ shortcut switches to Smart mode without deleting the remote address')
  console.log('✓ shortcut switches back to the saved remote origin')
  console.log('✓ saving an unchanged selection still reconnects the window')
} finally {
  await app?.close().catch(() => {})
  await new Promise(resolve => remoteServer.close(resolve))
  await new Promise(resolve => thirdPartyServer.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}
