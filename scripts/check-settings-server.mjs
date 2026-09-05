/** Exercise the private transport without starting Electron or touching a profile. */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-server-'))
let server
try {
  const outfile = join(directory, 'server.mjs')
  await build({ entryPoints: ['src/main/settings-server.ts'], bundle: true, platform: 'node', format: 'esm', outfile })
  const { createSettingsServer } = await import(pathToFileURL(outfile).href)
  const calls = []
  let updater
  const save = (name) => async (value, remote) => {
    calls.push({ name, value, remote })
    if (value === 'throw') throw new Error('fixture rejected')
    return { saved: value !== 'invalid' }
  }
  server = createSettingsServer({
    updater: () => updater,
    getStatusJson: () => ({ mode: 'smart' }),
    setBundledMarketEnabled: async (enabled, remote) => { calls.push({ enabled, remote }); return { enabled } },
    probeDefaultWebUi: async () => ({ reachable: true }),
    desktopClientVersion: () => '1.0.0',
    updateStateForPage: state => state,
    pageUpdateState: () => updater?.getState(),
    installDesktopUpdate: async () => ({ started: false }),
    scheduleQuitAfterWindowsInstall: () => { throw new Error('unexpected quit') },
    settingsPageScript: () => '/* settings fixture */',
    settingsPageHtml: () => '<title>settings fixture</title>',
    loadSettings: () => ({ connectionMode: 'smart' }),
    configuredLocalWebPort: () => 3080,
    requestServerUrlSave: save('server'),
    requestSmartRuntimesSave: save('runtimes'),
    requestLocalWebPortSave: save('port'),
    requestDshDataModeSave: value => ({ saved: value === 'isolated' }),
    switchConnectionMode: async () => ({ switched: true }),
  })
  await server.start()
  const request = (path, body, headers = {}) => fetch(server.url + path, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const page = await request('')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.match(await page.text(), /settings fixture/)
  assert.equal((await fetch(new URL('/desktop/settings', server.url))).status, 404)
  const forbiddenStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(server.url + 'desktop/settings', { method: 'POST', headers: { host: 'attacker.example' } }, res => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode) })
    })
    req.on('error', reject)
    req.end(JSON.stringify({ serverUrl: 'blocked' }))
  })
  assert.equal(forbiddenStatus, 403)
  assert.equal(calls.length, 0)
  assert.equal((await request('desktop/settings', 'x'.repeat(16385))).status, 413)
  assert.equal((await request('desktop/settings', '{')).status, 400)
  assert.equal(calls.length, 0)
  for (const [route, key, name, remote] of [
    ['settings', 'serverUrl', 'server', false],
    ['smart-runtimes', 'smartRuntimes', 'runtimes', undefined],
    ['local-web-port', 'localWebPort', 'port', false],
  ]) {
    assert.equal((await request('desktop/' + route, { [key]: 'valid' })).status, 200)
    assert.deepEqual(calls.at(-1), { name, value: 'valid', remote })
    assert.equal((await request('desktop/' + route, { [key]: 'invalid' })).status, 400)
    assert.equal((await request('desktop/' + route, { [key]: 'throw' })).status, route === 'settings' ? 500 : 400)
  }
  // Limit bytes rather than decoded characters, and validate every body route.
  for (const route of ['settings', 'smart-runtimes', 'local-web-port', 'dsh-data-mode']) {
    const before = calls.length
    assert.equal((await request('desktop/' + route, '中'.repeat(6000))).status, 413)
    assert.equal((await request('desktop/' + route, '{')).status, 400)
    assert.equal(calls.length, before)
    await new Promise(resolve => {
      const req = httpRequest(server.url + 'desktop/' + route, { method: 'POST', headers: { 'content-length': 1000 } })
      req.on('error', () => {}) // Client intentionally closes an incomplete upload.
      req.on('close', resolve)
      req.write('{"serverUrl":')
      setTimeout(() => { req.destroy() }, 30)
    })
    assert.equal((await request('desktop/status')).status, 200, 'server survives an interrupted body')
    assert.equal(calls.length, before, 'an incomplete body cannot reach a save')
  }
  const utf8 = Buffer.from(JSON.stringify({ serverUrl: '中文' }))
  const split = utf8.indexOf(Buffer.from('中')) + 1
  const splitStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(server.url + 'desktop/settings', { method: 'POST' }, res => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode) })
    })
    req.on('error', reject)
    req.write(utf8.subarray(0, split))
    setTimeout(() => { req.end(utf8.subarray(split)) }, 20)
  })
  assert.equal(splitStatus, 200)
  assert.equal(calls.at(-1).value, '中文', 'UTF-8 survives a chunk boundary inside a character')
  assert.equal((await request('desktop/dsh-data-mode', { dshDataMode: 'isolated' })).status, 200)
  assert.deepEqual(await (await request('desktop/settings')).json(), { connectionMode: 'smart', localWebPort: 3080 })
  assert.equal((await request('desktop/market/enable', {})).status, 200)
  assert.deepEqual(calls.at(-1), { enabled: true, remote: false })
  assert.equal((await request('desktop/update/check', {})).status, 503)
  assert.equal((await (await request('desktop/update')).json()).error, 'updater not ready')
  let reset = false
  updater = { getState: () => ({ phase: 'idle' }), resetDismiss: () => { reset = true }, check: async () => ({ hasUpdate: false }), dismiss() {} }
  assert.equal((await request('desktop/update/check', {})).status, 200)
  assert.equal(reset, true)
  assert.equal((await request('desktop/update/install', {})).status, 400)
  assert.equal((await request('desktop/switch', {})).status, 200)
  assert.equal((await request('unknown')).status, 404)
  console.log('settings-server: PASS (private boundary, routing, validation results and updater readiness)')
} finally {
  await server?.close()
  rmSync(directory, { recursive: true, force: true })
}
