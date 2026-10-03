const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { buildSync } = req("esbuild");
const { runInNewContext } = require("node:vm");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
function load(name, platform = process.platform) {
  const p = Object.create(process);
  Object.defineProperty(p, "platform", { value: platform });
  const code = buildSync({ entryPoints: ["src/main/" + name + ".ts"], bundle: true, platform: "node", format: "cjs", packages: "external", write: false }).outputFiles[0].text;
  const m = { exports: {} };
  runInNewContext(code, { module: m, exports: m.exports, require: (id) => id === "electron" ? { app: { isPackaged: true }, net: {}, shell: {} } : req(id), process: p, console, Buffer, URL, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask });
  return m.exports;
}
(async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "dsh-adopt-update-"));
  let child;
  let c;
  try {
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const { writeRuntimeLock, isProcessAlive } = load("runtime-lock");
    const { readProcessIdentity } = load("runtime-process");
    const { createRuntimeSurvivor } = load("runtime-survivor");
    const { createConnectionController } = load("connection-controller");
    const url = "http://127.0.0.1:45001";
    let managedStops = 0;
    let launched = false;
    const runtime = { stop: async () => {
      managedStops++;
    }, pid: () => void 0 };
    const survivor = createRuntimeSurvivor({ childHome: () => home, managedPid: () => void 0, enabledSmartRuntimes: () => ["bundled"], probeWebUi: async () => url, connection: () => ({ adopted: c.probeConnected, target: c.currentTarget() }) });
    writeRuntimeLock(home, { childPid: child.pid, desktopPid: process.pid, startedAt: Date.now(), source: "bundled", url, processIdentity: await readProcessIdentity(child.pid) });
    c = createConnectionController({ runtime: () => runtime, catalog: {}, probe: {}, survivor, childHome: () => home, loadSettings: () => ({ connectionMode: "smart", smartRuntimes: ["bundled"] }), sharedDshDiscoveryEnabled: () => false, isQuitting: () => false, isInstallerHandoff: () => false, localeChinese: () => false, plugins: { releaseBundledPluginSeat() {
    }, reseatForAdoptedRuntime() {
    } }, presentation: { launchWindow() {
      launched = true;
    }, showLocalRuntimeStartupFailure() {
      throw Error("adoption failed");
    } } });
    c.applyConnectionSettings({ connectionMode: "smart" });
    for (let i = 0; i < 20 && !launched; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.probeConnected, true);
    const { createUpdateController } = load("update-controller", "win32");
    let updater;
    const update = createUpdateController({ loadSettings: () => ({}), patchSettings() {
    }, desktopClientVersion: () => "0.5.15", clientHome: () => home, localeChinese: () => false, confirmClose: async () => true, stopRuntimeForUpdate: () => c.stop(true), getDesktopUpdater: () => updater });
    updater = update.createDesktopUpdater();
    const exited = once(child, "exit");
    await updater.options.onBeforeInstall();
    assert.equal(isProcessAlive(child.pid), false, "update must stop the verified adopted runtime");
    await exited;
    assert.equal(managedStops, 1);
    console.log("PASS update handoff stops the real owned survivor");
    for (const cancelled of [true, false]) {
      let stops = 0;
      const failed = createUpdateController({
        loadSettings: () => ({}), patchSettings() {}, desktopClientVersion: () => "0.5.15",
        clientHome: () => home, localeChinese: () => false,
        confirmClose: async () => !cancelled,
        stopRuntimeForUpdate: async () => { stops++; throw new Error("fixture stop failed"); },
      });
      const candidate = failed.createDesktopUpdater();
      await assert.rejects(candidate.options.onBeforeInstall(), cancelled ? /cancelled/ : /stop failed/);
      assert.equal(stops, cancelled ? 0 : 1);
      assert.equal(failed.isInstallerHandoff(), !cancelled);
    }
    console.log("PASS cancelled settings and failed shutdown reject installer handoff");
  } finally {
    c?.dispose();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
