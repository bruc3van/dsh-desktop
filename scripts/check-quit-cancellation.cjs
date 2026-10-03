/** Real Electron beforeunload cancellation must leave shutdown and relaunch untouched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildSync } = require('esbuild');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quit-cancellation-'));
const bundle = path.join(work, 'quit.cjs');
buildSync({ entryPoints: ['src/main/quit-coordinator.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const entry = path.join(work, 'main.cjs');
fs.writeFileSync(entry, `
const assert = require('node:assert/strict');
const {app, BrowserWindow} = require('electron');
app.disableHardwareAcceleration();
let stage = 'Electron startup';
let beforeQuits = 0, closes = 0, prevents = 0;
app.on('before-quit', () => { beforeQuits++; });
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const {createQuitCoordinator, confirmWindowClose} = require(${JSON.stringify(bundle)});
let win, allow = false, begins = 0, stops = 0, prepares = 0, cancellations = 0;
app.on('window-all-closed', () => {});
app.on('before-quit', createQuitCoordinator({
  confirm: () => confirmWindowClose(win),
  prepare: async () => { prepares++; },
  cancelled: () => { cancellations++; },
  begin: () => { begins++; },
  stop: async () => { stops++; },
  quit: () => { app.quit(); },
  failed: error => { throw error; },
}));
app.on('will-quit', () => {
  assert.equal(begins, 1); assert.equal(stops, 1); assert.equal(prepares, 1);
  console.log('PASS real Electron cancelled close/quit, retry and confirmed shutdown');
});
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
app.whenReady().then(async () => {
  stage = 'window creation';
  win = new BrowserWindow({show:false, webPreferences:{contextIsolation:true, nodeIntegration:false}});
  win.on('close', () => { closes++; });
  win.webContents.on('will-prevent-unload', event => { prevents++; if (allow) event.preventDefault(); });
  await win.loadURL('data:text/html,<body>unsaved settings</body>');
  await win.webContents.executeJavaScript("window.addEventListener('beforeunload', event => {event.preventDefault(); event.returnValue='';})");
  stage = 'cancel window close';
  assert.equal(await confirmWindowClose(win), false);
  for (let i = 1; i <= 2; i++) {
    stage = 'cancel quit ' + i;
    app.quit(); app.quit();
    while (cancellations < i) await tick();
    assert.equal(begins, 0); assert.equal(stops, 0); assert.equal(prepares, 0);
    assert.equal(win.isDestroyed(), false);
    assert.equal(await win.webContents.executeJavaScript('1+1'), 2);
  }
  stage = 'confirm quit';
  allow = true;
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => {console.error('Quit regression timed out: ' + JSON.stringify({stage,beforeQuits,closes,prevents,cancellations,begins,stops,prepares})); app.exit(2);}, 60000).unref();
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [entry, '--user-data-dir=' + path.join(work, 'profile')], { env, stdio: 'inherit' });
child.on('exit', code => {
  fs.rmSync(work, { recursive: true, force: true });
  assert.equal(code, 0);
});
