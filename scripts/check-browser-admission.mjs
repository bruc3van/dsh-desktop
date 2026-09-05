/** Exercise Chromium's actual Cookie header across loopback ports in an isolated Electron session. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dsh-browser-admission-'))
let app
try {
  const bundle = join(work, 'admission.cjs')
  await build({ entryPoints: [join(root, 'src/main/browser-admission.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: bundle })
  writeFileSync(join(work, '.credentials.yaml'), JSON.stringify({ version: 1, records: {
    'client-connection/browser-session': { kind: 'grant', payload: { version: 1, secret: Buffer.alloc(32, 9).toString('base64url') } },
  } }))
  const main = join(work, 'main.cjs')
  writeFileSync(main, `const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('node:http');
const { createBrowserAdmission } = require(${JSON.stringify(bundle)});
app.setPath('userData', ${JSON.stringify(join(work, 'chromium'))});
app.whenReady().then(async () => {
  const received = [];
  const servers = [0, 1].map(index => createServer((req, res) => {
    received.push({ index, hasDshCookie: /dsh-auth-/.test(req.headers.cookie || '') });
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>admission fixture</title>');
  }));
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origins = servers.map(server => 'http://127.0.0.1:' + server.address().port);
  let target = origins[0];
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const admission = createBrowserAdmission({ home: () => ${JSON.stringify(work)}, target: () => target,
    mainContentsId: () => window.webContents.id, verify: async () => true });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: admission.headers(details.url, details.webContentsId, details.requestHeaders) });
  });
  await admission.select(target);
  // This deliberately host-scoped synthetic cookie must never leak to port 1.
  await session.defaultSession.cookies.set({ url: target, name: 'dsh-auth-old-fixture', value: 'synthetic', httpOnly: true, sameSite: 'strict', path: '/' });
  await window.loadURL(target);
  await window.webContents.executeJavaScript('fetch(' + JSON.stringify(origins[1]) + ', {mode:"no-cors",credentials:"include"}).then(()=>true)');
  const first = received.filter(request => request.index === 0);
  const other = received.filter(request => request.index === 1);
  const onlyOldStored = (await session.defaultSession.cookies.get({})).filter(cookie => cookie.name.startsWith('dsh-auth-')).every(cookie => cookie.name === 'dsh-auth-old-fixture');
  target = origins[1];
  await admission.select(target);
  const before = received.length;
  await window.loadURL(target);
  await window.webContents.executeJavaScript('fetch(' + JSON.stringify(origins[0]) + ', {mode:"no-cors",credentials:"include"}).then(()=>true)');
  const after = received.slice(before);
  globalThis.admissionResult = { selectedAuthenticated: first.some(request => request.hasDshCookie),
    otherPortClean: other.length > 0 && other.every(request => !request.hasDshCookie),
    nativeNotStored: onlyOldStored,
    switchedAuthenticated: after.some(request => request.index === 1 && request.hasDshCookie),
    previousPortClean: after.filter(request => request.index === 0).every(request => !request.hasDshCookie) };
  for (const server of servers) server.close();
}).catch(error => { globalThis.admissionError = String(error); });
`)
  app = await electron.launch({ args: [main], env: sanitizedElectronEnv(), timeout: 25_000 })
  const deadline = Date.now() + 20_000
  let result
  while (Date.now() < deadline) {
    const state = await app.evaluate(() => ({ result: globalThis.admissionResult, error: globalThis.admissionError }))
    if (state.error) throw new Error(state.error)
    if (state.result) { result = state.result; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(result, 'Electron admission fixture timed out')
  for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name)
  console.log('✓ Chromium authenticates selected origin, strips cross-port cookies, clears old-target admission and never stores the native credential')
} finally {
  await app?.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
