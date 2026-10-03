const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const { buildSync } = req("esbuild");
const { runInNewContext } = require("node:vm");
const { EventEmitter } = require("node:events");
const assert = require("node:assert/strict");
const root = process.cwd();
function load(name, mocks = {}, globals = {}) {
  const code = buildSync({ entryPoints: [root + "/src/main/" + name + ".ts"], bundle: true, platform: "node", format: "cjs", packages: "external", write: false }).outputFiles[0].text;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: (id) => mocks[id] ?? req(id), process, console, Buffer, URL, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, ...globals });
  return module.exports;
}
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
(async () => {
  for (const held of [true, false]) {
    const sockets = [];
    const { createConnectionController } = load("connection-controller", { "electron": { app: { isPackaged: true } }, "node:net": { createConnection() {
      const socket = new EventEmitter();
      socket.setTimeout = () => {
      };
      socket.destroy = () => {
      };
      sockets.push(socket);
      return socket;
    } } });
    let settings = { connectionMode: "smart", localWebPort: 45678 };
    let failures = [];
    let launches = 0;
    let recoveries = 0;
    const runtime = { stop: async () => {
    }, pid: () => 12345, lastSource: "bundled", ready: async () => "http://127.0.0.1:45679" };
    const c = createConnectionController({ runtime: () => runtime, childHome: () => require("node:os").tmpdir(), loadSettings: () => settings, sharedDshDiscoveryEnabled: () => false, isQuitting: () => false, isInstallerHandoff: () => false, localeChinese: () => false, catalog: { detectionStarted: true, detectInstalledDsh: async () => {
    }, rejectFailedSource: () => {
      recoveries++;
      return false;
    } }, probe: { prepareLocalWebPort: async () => 45679, probeSmartTargets: async () => ({ kind: "unavailable" }), inspectWebUi: async () => ({ kind: "unavailable" }) }, survivor: { adoptOrClearSurvivingRuntime: async () => ({ kind: "spawn" }) }, plugins: { releaseBundledPluginSeat() {
    }, reseatForAdoptedRuntime() {
    }, onManagedReady() {
    }, withdrawFailedSeat: () => false, schedulePluginCompatibilityFallback: () => false }, presentation: { windowRequested: () => true, isLoading: () => true, launchWindow() {
      launches++;
    }, loadMainWindow() {
    }, showLoadingDocument() {
    }, updateLoadingStatus() {
    }, showConnectionError() {
    }, showPinnedPortStartupFailure(port) {
      failures.push(port);
    }, showLocalRuntimeStartupFailure() {
    }, rememberSmartBridgeHandoff() {
    } } });
    c.onExit({ wasReady: false, code: 1, signal: null, retryable: true });
    assert.equal(sockets.length, 1);
    settings = { connectionMode: "smart", localWebPort: 0 };
    c.applySmartLocalRuntimeChange();
    for (let i = 0; i < 8; i++) await tick();
    await c.readyForConnection(c.generation);
    sockets[0].emit(held ? "connect" : "error");
    await tick();
    assert.equal(failures.length, 0);
    console.log("PASS stale-pinned-probe", JSON.stringify({ newTarget: c.currentTarget(), newGeneration: c.generation, staleErrorPort: failures[0], launches }));
    assert.equal(recoveries, 0);
    assert.equal(launches, 1);
    c.dispose();
  }
  const { createWindowHealth } = load("window-health", { "electron": {} });
  for (const probed of [true, false]) {
    for (const change of ["target", "generation", "quit"]) {
      let quitting = false;
      let target = "http://127.0.0.1:30001", generation = 1, reloads = [];
      const pending = deferred();
      const win = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false, reload() {
        reloads.push(target);
      } } };
      const health = createWindowHealth({ getMainWindow: () => win, currentTarget: () => target, getQuitting: () => quitting, getConnection: () => ({ probeConnected: probed, generation }), probeWithGrace: () => pending.promise, probeWebUi: () => pending.promise, refuseUnauthenticatedProbeTarget() {
      }, fallbackFromProbedInstance() {
      } });
      const recovering = health.recoverBlankWindow("old renderer failure", true);
      if (change === "target") target = "https://new-connection.example";
      if (change === "generation") generation++;
      if (change === "quit") quitting = true;
      pending.resolve(probed ? { kind: "verified", url: "http://127.0.0.1:30001" } : target);
      await recovering;
      assert.equal(reloads.length, 0);
      quitting = false;
      await health.recoverBlankWindow("current renderer failure", true);
      assert.equal(reloads.length, 1, "stale checks must not consume the new page's reload cooldown");
      console.log("PASS health recovery guards", { probed, change });
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
