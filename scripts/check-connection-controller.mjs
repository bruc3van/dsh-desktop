/** Behavioral checks of connection intent across delayed probes, readiness and exits. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-connection-controller-'))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const until = async predicate => {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('controller did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const controllers = []
try {
  const outfile = join(home, 'connection-controller.mjs')
  await build({
    entryPoints: [join(root, 'src/main/connection-controller.ts')], bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'no-development-overrides', setup(builder) {
      // Controller tests exercise production decisions without depending on
      // Electron or the caller's development override environment.
      builder.onResolve({ filter: /development-options\.ts$/ }, () => ({ path: 'flags', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const devFlag = () => false;' }))
    } }],
  })
  const { createConnectionController } = await import(pathToFileURL(outfile).href)
  const make = (configure = () => {}) => {
    const state = { settings: { connectionMode: 'smart' }, quitting: false, installing: false,
      ports: [], launches: [], errors: [], readyCalls: 0, stops: 0, shared: false, probes: 0 }
    const options = {
      childHome: () => home,
      loadSettings: () => state.settings,
      sharedDshDiscoveryEnabled: () => state.shared,
      isQuitting: () => state.quitting,
      isInstallerHandoff: () => state.installing,
      localeChinese: () => false,
      catalog: { detectionStarted: true, detectInstalledDsh: async () => {}, rejectFailedSource: () => false },
      probe: {
        prepareLocalWebPort: async () => { const port = state.ports.length ? 13080 : 3080; state.ports.push(port); return port },
        probeSmartTargets: async () => { state.probes++; return { kind: 'unavailable' } },
        inspectWebUi: async () => ({ kind: 'unavailable' }), probeWebUi: async () => undefined,
      },
      survivor: { adoptOrClearSurvivingRuntime: async () => ({ kind: 'spawn' }), stopAdoptedRuntimeForRestart: async () => {} },
      plugins: { releaseBundledPluginSeat() {}, reseatForAdoptedRuntime() {}, onManagedReady() {},
        withdrawFailedSeat: () => false, schedulePluginCompatibilityFallback: () => false },
      presentation: { windowRequested: () => false, isLoading: () => true,
        launchWindow: generation => state.launches.push(generation), loadMainWindow() {}, showLoadingDocument() {},
        updateLoadingStatus() {}, showConnectionError: error => state.errors.push(error),
        showPinnedPortStartupFailure() {}, showLocalRuntimeStartupFailure() {}, rememberSmartBridgeHandoff() {} },
    }
    const runtime = { ready: async () => { state.readyCalls++; return 'http://127.0.0.1:13080/?token=fixture' },
      stop: async () => { state.stops++ }, pid: () => undefined, lastSource: 'bundled', lastCommand: undefined }
    configure({ options, runtime, state })
    const controller = createConnectionController({ ...options, runtime: () => runtime })
    controllers.push(controller)
    return { controller, options, runtime, state }
  }

  {
    const port = deferred()
    const { controller: delayed, state } = make(({ options, state }) => {
      options.probe.prepareLocalWebPort = () => { state.ports.push(3080); return port.promise }
    })
    delayed.applyConnectionSettings(state.settings)
    await until(() => state.ports.length === 1)
    delayed.applyConnectionSettings({ connectionMode: 'connect', serverUrl: 'http://127.0.0.1:45678' })
    port.resolve(3080)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(delayed.currentTarget(), 'http://127.0.0.1:45678')
    assert.equal(delayed.localWebSpawnPort(), 0)
    assert.equal(state.launches.length, 1)
  }
  console.log('✓ a stale automatic-port probe cannot change a newer pinned connection or launch a child')

  {
    const { controller, runtime, state } = make()
    controller.applyConnectionSettings(state.settings)
    await until(() => state.launches.length === 1)
    const ready = deferred()
    runtime.ready = () => ready.promise
    const waiting = controller.readyForConnection(controller.generation)
    controller.applyConnectionSettings({ connectionMode: 'connect', serverUrl: 'http://127.0.0.1:45679' })
    ready.resolve('http://127.0.0.1:3080/?token=fixture')
    assert.equal(await waiting, undefined)
    assert.equal(controller.childTarget, undefined)
    assert.equal(controller.currentTarget(), 'http://127.0.0.1:45679')
  }
  console.log('✓ readiness from a superseded generation cannot publish an origin or reset recovery state')

  for (const branch of ['seat', 'source', 'crash']) {
    const { controller, options, runtime, state } = make()
    controller.applyConnectionSettings(state.settings)
    await until(() => state.launches.length === 1)
    // Operation methods that are captured by the factory are stable functions;
    // these two callbacks are dispatched through their owning domain objects.
    if (branch === 'seat') options.plugins.withdrawFailedSeat = () => true
    if (branch === 'source') { runtime.lastSource = 'installed'; options.catalog.rejectFailedSource = () => true }
    controller.onExit({ wasReady: branch === 'crash', code: 1, signal: null, retryable: true })
    await until(() => state.readyCalls === 1)
    assert.deepEqual(state.ports, [3080, 13080])
    assert.equal(controller.localWebSpawnPort(), 13080)
    controller.dispose()
  }
  console.log('✓ plugin withdrawal, source rejection and crash restart each select a new port before readiness')

  {
    const { controller, runtime, state } = make()
    const stopping = deferred()
    runtime.stop = () => { state.stops++; return stopping.promise }
    controller.applySmartLocalRuntimeChange()
    controller.onExit({ wasReady: false, code: 0, signal: null, retryable: true })
    controller.applySmartLocalRuntimeChange()
    assert.equal(state.ports.length, 0)
    stopping.resolve()
    await until(() => state.launches.length === 1)
    assert.equal(state.ports.length, 1)
    assert.equal(controller.generation, 3)
    state.quitting = true
    controller.onExit({ wasReady: true, code: 1, signal: null, retryable: true })
    assert.equal(await controller.readyForConnection(controller.generation), undefined)
    assert.equal(state.readyCalls, 0)
  }
  console.log('✓ intentional overlapping stops resolve only the newest choice; quitting prevents new readiness requests')

  for (const kind of ['adopt', 'blocked']) {
    const fixture = make(({ options, state }) => {
      state.shared = true
      options.survivor.adoptOrClearSurvivingRuntime = async () => kind === 'adopt'
        ? { kind, url: 'http://127.0.0.1:45680' } : { kind, pid: 12345 }
    })
    const { controller } = fixture
    controller.applyConnectionSettings(fixture.state.settings)
    await until(() => fixture.state.launches.length + fixture.state.errors.length === 1)
    assert.equal(fixture.state.probes, 0)
    assert.equal(fixture.state.ports.length, 0)
    assert.equal(controller.probeConnected, kind === 'adopt')
  }
  console.log('✓ survivor adoption/blocking takes precedence over discovery, port allocation and spawn')
} finally {
  for (const controller of controllers) controller.dispose()
  rmSync(home, { recursive: true, force: true })
}
