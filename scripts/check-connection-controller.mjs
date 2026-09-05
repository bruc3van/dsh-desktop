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
  {
    const detection = deferred()
    let occupied = false
    const { controller, state } = make(({ options, state }) => {
      state.shared = true
      options.catalog.detectInstalledDsh = () => detection.promise
      options.probe.probeSmartTargets = async () => {
        state.probes++
        return occupied ? { kind: 'verified', url: 'http://127.0.0.1:3080' } : { kind: 'unavailable' }
      }
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => state.probes === 1)
    occupied = true
    detection.resolve()
    await until(() => state.errors.length === 1)
    assert.equal(state.launches.length, 0)
    assert.equal(state.readyCalls, 0)
    assert.equal(state.probes, 2)
  }
  console.log('✓ an external instance appearing during slow CLI detection blocks the local launch')

  {
    const { controller, state } = make(({ options }) => {
      options.probe.probeSmartTargets = async () => ({ kind: 'verified', url: 'http://127.0.0.1:3080' })
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => state.launches.length === 1)
    state.shared = true
    assert.equal(await controller.readyForConnection(controller.generation), undefined)
    assert.equal(state.readyCalls, 0)
    assert.equal(state.errors.length, 1)
  }
  console.log('✓ the last readiness gate also refuses an instance appearing after port selection')

  {
    const { controller, runtime, state } = make(({ options, state }) => {
      options.presentation.showLocalRuntimeStartupFailure = () => state.errors.push('stop failed')
    })
    runtime.stop = async () => { throw new Error('tree disposal unconfirmed') }
    controller.applySmartLocalRuntimeChange()
    await until(() => state.errors.length === 1)
    assert.equal(state.launches.length, 0)
    assert.equal(state.readyCalls, 0)
  }
  console.log('✓ a failed intentional stop never applies a successor runtime')

  {
    const { controller, runtime, state } = make(({ options, state }) => {
      options.presentation.showLocalRuntimeStartupFailure = () => state.errors.push('stop failed')
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => state.launches.length === 1)
    await controller.readyForConnection(controller.generation)
    const localTarget = controller.currentTarget()
    runtime.stop = async () => { throw new Error('tree disposal unconfirmed') }
    controller.applyConnectionSettings({ connectionMode: 'connect', serverUrl: 'http://127.0.0.1:45681' })
    await until(() => state.errors.length === 1)
    assert.equal(controller.currentTarget(), localTarget)
    assert.equal(state.launches.length, 1)
  }
  console.log('✓ a failed stop keeps the managed target instead of applying a pinned successor')

  {
    let offerSuccessor = false
    const { controller, runtime, state } = make(({ options, state }) => {
      options.presentation.showLocalRuntimeStartupFailure = () => state.errors.push('stop failed')
      options.probe.probeSmartTargets = async () => offerSuccessor
        ? { kind: 'verified', url: 'http://127.0.0.1:45682' }
        : { kind: 'unavailable' }
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => state.launches.length === 1)
    await controller.readyForConnection(controller.generation)
    const localTarget = controller.currentTarget()
    state.shared = true
    offerSuccessor = true
    runtime.stop = async () => { throw new Error('tree disposal unconfirmed') }
    controller.applyConnectionSettings(state.settings)
    await until(() => state.errors.length === 1)
    assert.equal(controller.currentTarget(), localTarget)
    assert.equal(controller.probeConnected, false)
    assert.equal(state.launches.length, 1)
  }
  console.log('✓ a failed stop keeps the managed target instead of adopting a probed successor')

  for (const reuse of [true, false]) {
    const { controller, state } = make(({ options, state }) => {
      state.shared = true
      state.settings.smartRuntimes = reuse ? ['probe', 'bundled'] : ['bundled']
      options.probe.probeSmartTargets = async () => ({ kind: 'uncertain', url: 'http://127.0.0.1:45683' })
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => state.errors.length === 1)
    assert.equal(state.ports.length, 0)
    assert.equal(state.launches.length, 0)
    assert.equal(state.readyCalls, 0)
    assert.match(state.errors[0].headline, /uncertain/)
    await controller.readyForConnection(controller.generation)
    assert.equal(state.readyCalls, 0, 'readiness must also block a late spawn')
  }
  console.log('✓ uncertain occupancy blocks reuse-disabled startup, reuse-enabled startup and readiness')

  for (const result of ['uncertain', 'authentication-required', 'verified', 'unavailable']) {
    const oldOrigin = 'http://127.0.0.1:45684'
    const { controller, state } = make(({ options, state }) => {
      state.shared = true
      options.probe.probeSmartTargets = async () => ({ kind: 'verified', url: oldOrigin })
      options.probe.inspectWebUi = async url => {
        assert.equal(url, oldOrigin)
        return result === 'unavailable' ? { kind: result } : { kind: result, url }
      }
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => controller.probeConnected)
    assert.equal(controller.fallbackFromProbedInstance('fixture'), true)
    await until(() => state.errors.length > 0 || state.launches.length === 2)
    assert.equal(state.ports.length, result === 'unavailable' ? 1 : 0)
    assert.equal(controller.probeConnected, result === 'verified')
    if (result === 'uncertain' || result === 'authentication-required') assert.equal(state.launches.length, 1)
  }
  console.log('✓ adopted fallback rechecks its original port and only selects a local bind once it is gone')

  {
    const inspected = deferred()
    const { controller, state } = make(({ options, state }) => {
      state.shared = true
      options.probe.probeSmartTargets = async () => ({ kind: 'verified', url: 'http://127.0.0.1:45685' })
      options.probe.inspectWebUi = () => inspected.promise
    })
    controller.applyConnectionSettings(state.settings)
    await until(() => controller.probeConnected)
    controller.fallbackFromProbedInstance('fixture')
    await new Promise(resolve => setImmediate(resolve))
    controller.applyConnectionSettings({ connectionMode: 'connect', serverUrl: 'https://example.invalid' })
    await until(() => controller.currentTarget() === 'https://example.invalid')
    inspected.resolve({ kind: 'uncertain', url: 'http://127.0.0.1:45685' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.errors.length, 0)
    assert.equal(controller.currentTarget(), 'https://example.invalid')
  }
  console.log('✓ an old occupancy recheck cannot overwrite a newer connection choice')
} finally {
  for (const controller of controllers) controller.dispose()
  rmSync(home, { recursive: true, force: true })
}
