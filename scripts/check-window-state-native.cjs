/** Real Electron regression: native minimize must not corrupt normal geometry. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildSync } = require('esbuild');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-window-native-'));
const bundle = path.join(work, 'state.cjs');
buildSync({ entryPoints: ['src/main/window-state.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const entry = path.join(work, 'main.cjs');
fs.writeFileSync(entry, `
const assert = require('node:assert/strict');
const { app, BrowserWindow, screen } = require('electron');
const { trackWindowState } = require(${JSON.stringify(bundle)});
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let stage = 'startup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('timeout: ' + stage); await wait(30); }
  await wait(350);
}
app.whenReady().then(async () => {
  let saved;
  // Keep the normal rectangle distinct from native zoom bounds on small CI displays.
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ width:Math.min(1100, Math.floor(area.width * 0.7)), height:Math.min(700, Math.floor(area.height * 0.7)), show:false });
  trackWindowState(win, state => { saved = state; });
  await win.loadURL('data:text/html,Window state regression');
  win.show();
  await until(() => win.isVisible());
  const original = win.getBounds();
  console.log('native display/normal geometry', JSON.stringify({ area, original }));
  assert.equal(win.isMaximized(), false, 'fixture starts in normal native state');
  stage = 'maximize'; win.maximize(); await until(() => win.isMaximized());
  stage = 'minimize'; win.minimize(); await until(() => win.isMinimized());
  stage = 'restore'; win.restore(); await until(() => !win.isMinimized());
  stage = 'close'; win.close(); await until(() => win.isDestroyed());
  assert.equal(saved.bounds.width, original.width, 'normal width survives native minimize');
  assert.equal(saved.bounds.height, original.height, 'normal height survives native minimize');
  assert.equal(saved.maximized, true);
  const next = new BrowserWindow({ ...saved.bounds, show:false });
  trackWindowState(next, state => { saved = state; });
  await next.loadURL('data:text/html,Restored state regression');
  next.show(); await until(() => next.isVisible());
  assert.equal(next.isMaximized(), false, 'recreated fixture starts in normal native state');
  next.maximize(); await until(() => next.isMaximized());
  stage = 'unmaximize after restart'; next.unmaximize(); await until(() => !next.isMaximized());
  assert.equal(next.getBounds().width, original.width);
  assert.equal(next.getBounds().height, original.height);
  next.close();
  console.log('PASS native maximize/minimize/restore/close and restarted normal geometry');
  app.exit(0);
}).catch(error => { console.error(stage, error); app.exit(1); });
setTimeout(() => { console.error('timeout: ' + stage); app.exit(2); }, 60000).unref();
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [entry, '--user-data-dir=' + path.join(work, 'profile')], { env, stdio: 'inherit' });
child.on('exit', code => {
  fs.rmSync(work, { recursive: true, force: true });
  assert.equal(code, 0);
});
