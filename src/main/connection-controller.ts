/** Owns connection intent, source transitions, port selection and recovery budgets.
 * Dependencies expose operations and observations; no mutable application state is shared.
 */
import type { ClientSettings } from './client-settings.ts'
import type { ConnectionFailure } from './connection-types.ts'
import type { WebUiManager, RuntimeExit } from './web-ui-manager.ts'
import type { RuntimeCatalog } from './runtime-catalog.ts'
import type { RuntimeSurvivor, SurvivingRuntime } from './runtime-survivor.ts'
import type { WebUiProbe, WebUiProbeResult } from './web-ui-probe.ts'
import type { DshCommand } from './runtime-types.ts'
import { normalizeServerUrl, originIsLoopback, usesConfiguredServer, appOrigin } from './connection-policy.ts'
import { recordRuntimeLockUrl, runtimeLockFile } from './runtime-lock.ts'
import { loopbackPortHeld } from './loopback-port.ts'
import { devFlag } from './development-options.ts'
import { smartRuntimeEnabled, normalizeSmartRuntimes, type SmartRuntimeId } from './smart-runtimes.ts'
import { normalizeLocalWebPort } from './local-web-port.ts'

interface ConnectionOptions {
  runtime(): Readonly<Pick<WebUiManager, 'ready' | 'stop' | 'pid' | 'lastSource' | 'lastCommand'>> | undefined
  catalog: Pick<RuntimeCatalog, 'detectInstalledDsh' | 'detectionStarted' | 'rejectFailedSource'>
  probe: Pick<WebUiProbe, 'probeSmartTargets' | 'inspectWebUi' | 'probeWebUi' | 'prepareLocalWebPort'>
  survivor: RuntimeSurvivor
  childHome(): string
  loadSettings(): ClientSettings
  sharedDshDiscoveryEnabled(): boolean
  isQuitting(): boolean
  isInstallerHandoff(): boolean
  localeChinese(): boolean
  plugins: {
    releaseBundledPluginSeat(reason: string): void
    reseatForAdoptedRuntime(): void
    onManagedReady(command: DshCommand | undefined): void
    withdrawFailedSeat(): boolean
    schedulePluginCompatibilityFallback(code: number | null, signal: NodeJS.Signals | null): boolean
  }
  presentation: {
    windowRequested(): boolean
    isLoading(): boolean
    launchWindow(generation: number, force?: boolean): void
    loadMainWindow(url: string, force?: boolean): void
    showLoadingDocument(): void
    updateLoadingStatus(zh: string, en: string, state?: 'busy' | 'failed'): void
    showConnectionError(failure: ConnectionFailure): void
    showPinnedPortStartupFailure(port: number): void
    showLocalRuntimeStartupFailure(code: number | null, signal: NodeJS.Signals | null): void
    rememberSmartBridgeHandoff(): void
  }
}

export function createConnectionController(options: ConnectionOptions) {
  const { catalog: runtimeCatalog, plugins, presentation, childHome, loadSettings, sharedDshDiscoveryEnabled, localeChinese } = options
  const { detectInstalledDsh } = runtimeCatalog
  const { probeSmartTargets, inspectWebUi, probeWebUi, prepareLocalWebPort } = options.probe
  const { adoptOrClearSurvivingRuntime } = options.survivor
  const { releaseBundledPluginSeat, reseatForAdoptedRuntime, schedulePluginCompatibilityFallback } = plugins
  const { launchWindow, loadMainWindow, showLoadingDocument, updateLoadingStatus, showConnectionError,
    showPinnedPortStartupFailure, showLocalRuntimeStartupFailure, rememberSmartBridgeHandoff } = presentation
  const enabledSmartRuntimes = (): SmartRuntimeId[] => normalizeSmartRuntimes(loadSettings().smartRuntimes)
  const configuredLocalWebPort = (): number => normalizeLocalWebPort(loadSettings().localWebPort)
  /** Resolved bind for the next managed-child spawn. Recomputed before retries. */
  let selectedLocalWebPort = 0
  const MAX_LAUNCH_RETRIES = 3
  const INITIAL_RELAUNCH_DELAY_MS = 250
  const STABLE_RUNTIME_RESET_MS = 60_000
  let launchBudget = MAX_LAUNCH_RETRIES
  let launchBudgetResetTimer: NodeJS.Timeout | undefined
  /** Monotonic connection intent; stale probes/readiness callbacks cannot win. */
  let connectionGeneration = 0
  /**
   * The current local child is being stopped because Smart-mode sources changed,
   * not because it crashed. `connectTo` can lean on `configuredTarget` to keep
   * `onExit` off the recovery ladder; a source toggle stays in Smart mode, so
   * that gate is open and this flag has to close it.
   */
  let replacingLocalRuntime = false
  /** Last Smart-mode source apply; a faster toggle supersedes an in-flight stop. */
  let smartRuntimeApply = 0
  /** The current Web UI origin: the probed/configured address, or the local child's URL. */
  let configuredTarget: string | undefined
  /** True when configuredTarget came from the startup probe (not the settings). */
  let probeConnected = false
  let childTarget: string | undefined
  /** Re-probe attempts before a probed instance is declared gone. */
  const PROBED_FALLBACK_GRACE_ATTEMPTS = 3
  const PROBED_FALLBACK_GRACE_INTERVAL_MS = 1_000
  /** One recovery task at a time: overlapping grace windows double the probes. */
  let probedFallbackInFlight = false
  /** Automatic reloads against a probed instance, to cap a reload→fail loop. */
  let probedRecoveryReloads = 0
  const PROBED_RECOVERY_RELOAD_CAP = 2

  /** The bind passed to the managed child after automatic selection. */
  function localWebSpawnPort(): number {
    const configured = configuredLocalWebPort()
    return configured > 0 ? configured : selectedLocalWebPort
  }

  function currentTarget(): string | undefined {
    return configuredTarget ?? childTarget
  }

  /** Exponential delay derived from the number of retries already consumed. */
  function relaunchDelayMs(remainingRetries: number): number {
    const attemptsConsumed = MAX_LAUNCH_RETRIES - remainingRetries
    return INITIAL_RELAUNCH_DELAY_MS * 2 ** Math.max(0, attemptsConsumed - 1)
  }

  /**
   * Classify a probed origin across a short grace window.
   * "One probe that goes unanswered" is how a wrong port is dismissed; a live
   * instance is owed more patience than that.
   */
  async function probeWithGrace(base: string): Promise<WebUiProbeResult> {
    let authenticationRequired: WebUiProbeResult | undefined
    for (let attempt = 0; attempt < PROBED_FALLBACK_GRACE_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, PROBED_FALLBACK_GRACE_INTERVAL_MS))
      const result = await inspectWebUi(base)
      if (result.kind === 'verified') return result
      if (result.kind === 'authentication-required') authenticationRequired ??= result
    }
    return authenticationRequired ?? { kind: 'unavailable' }
  }

  /**
   * A probed instance misbehaved: a load failed, a health probe came back
   * empty. "Not answering" is not "not running" — the harness can be briefly
   * busy (a GC pause, a heavy request, a plugin reload) while fully alive, and
   * spawning a second writer beside a live one is exactly the corruption the
   * runtime lock exists to prevent. Re-probe across the grace window first;
   * only an origin that keeps failing gets the local-runtime fallback. When it
   * does answer, the window is rebuilt instead — bounded, so a server that
   * answers the API but cannot serve the page ends at the failure surface
   * rather than in a reload loop.
   */
  async function handleProbedInstanceFailure(reason: string): Promise<void> {
    if (!probeConnected || options.isQuitting() || probedFallbackInFlight) return
    probedFallbackInFlight = true
    try {
      const failedTarget = configuredTarget
      if (failedTarget === undefined) return
      const generation = connectionGeneration
      const probe = await probeWithGrace(failedTarget)
      if (probe.kind === 'verified') {
        if (generation !== connectionGeneration || !probeConnected || currentTarget() !== failedTarget) return
        if (probedRecoveryReloads >= PROBED_RECOVERY_RELOAD_CAP) {
          probedRecoveryReloads = 0
          console.warn('[desktop] probed Web UI keeps failing after recovery reloads (' + reason + ')')
          showConnectionError({ kind: 'load', url: failedTarget, code: 0, description: reason })
          return
        }
        probedRecoveryReloads += 1
        console.warn('[desktop] probed Web UI recovered (' + reason + '); reloading it')
        loadMainWindow(failedTarget, true)
        return
      }
      // The grace window is seconds long; the user may have switched to another
      // instance in the meantime. A stale failure must not tear down a target it
      // does not describe — the same generation guard the recovery path above
      // already carries.
      if (generation !== connectionGeneration || !probeConnected || currentTarget() !== failedTarget) return
      if (probe.kind === 'authentication-required') {
        refuseUnauthenticatedProbeTarget(probe.url)
        return
      }
      fallbackFromProbedInstance(reason)
    } finally {
      probedFallbackInFlight = false
    }
  }

  /** Connect to a fixed Web UI origin: stop any local child, point the window at it. */
  function connectTo(url: string, force = false): void {
    const generation = ++connectionGeneration
    if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
    configuredTarget = url
    probeConnected = false
    childTarget = undefined
    // This process will not spawn its bundled runtime; a leftover entry would
    // hand the next `dsh web` (or a later local spawn) a second Service copy.
    releaseBundledPluginSeat('connecting to a pinned address')
    void options.runtime()?.stop()
    launchWindow(generation, force)
  }

  /** Use the local `dsh web` child (spawned on demand, awaited via readiness). */
  async function startLocalRuntime(generation: number, force = false): Promise<void> {
    if (generation !== connectionGeneration || options.isQuitting()) return
    // Never two harnesses on one DSH_HOME. A survivor that still serves is
    // adopted like any other running instance — including the fallback path, so
    // this connection is not pinned to it if it later goes away — unless its
    // source is one the user has since turned off, which stops it instead.
    const survivor = await adoptOrClearSurvivingRuntime()
    if (generation !== connectionGeneration || options.isQuitting()) return
    if (settleSurvivingRuntime(survivor, generation, force)) return
    const port = await prepareLocalWebPort()
    if (generation !== connectionGeneration || options.isQuitting()) return
    selectedLocalWebPort = port
    configuredTarget = undefined
    probeConnected = false
    launchWindow(generation, force)
  }

  /** Re-resolve automatic mode before every retry or runtime-source fallback. */
  async function respawnLocalRuntime(generation: number): Promise<void> {
    const port = await prepareLocalWebPort()
    if (generation !== connectionGeneration || options.isQuitting() || configuredTarget !== undefined) return
    selectedLocalWebPort = port
    if (presentation.windowRequested()) {
      launchWindow(generation)
      return
    }
    void readyForConnection(generation).catch(() => {})
  }

  /**
   * Apply a runtime-lock verdict. Returns true when this start is done
   * (adopted or blocked) and the caller must not spawn.
   */
  function settleSurvivingRuntime(survivor: SurvivingRuntime, generation: number, force: boolean): boolean {
    if (survivor.kind === 'adopt') {
      configuredTarget = survivor.url
      probeConnected = true
      childTarget = undefined
      reseatForAdoptedRuntime()
      launchWindow(generation, force)
      return true
    }
    if (survivor.kind === 'blocked') {
      const chinese = localeChinese()
      const pid = String(survivor.pid)
      showConnectionError({
        kind: 'runtime',
        headline: chinese ? '已有 dsh 运行时占用会话数据' : 'A dsh runtime is already using this session data',
        detail: chinese
          ? '上一次运行留下的 dsh 运行时（PID ' + pid + '）仍在运行，且既无法连接也无法结束。两个运行时同时写入同一份会话数据会造成永久损坏，因此这次没有启动新的运行时。确认该进程结束后可删除记录文件并重试。'
          : 'A leftover dsh runtime (PID ' + pid + ') is still running and could not be reached or stopped. Starting another writer on the same session data would corrupt it, so this launch was refused. After that process exits, delete the record file and retry.',
        recordPath: runtimeLockFile(childHome()),
      })
      return true
    }
    return false
  }

  /** Start a fresh bounded recovery window for an intentional local selection. */
  function resetRuntimeRecoveryBudget(): void {
    launchBudget = MAX_LAUNCH_RETRIES
    if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
    launchBudgetResetTimer = undefined
  }

  /** Restore the retry budget only after one local generation proves stable. */
  function markLocalRuntimeReady(url: string): void {
    childTarget = url
    // With an origin attached, a survivor of this client can be adopted by the
    // next start rather than merely detected and killed. Runtime-lock owns the
    // origin normalization so the readiness token never reaches disk.
    recordRuntimeLockUrl(childHome(), url, options.runtime()?.pid())
    // A first-ever DSH_HOME has no web profile until the child creates it
    // during boot, so the pre-spawn offer is a no-op. Take the seat now so
    // the next start actually loads the plugin (this process will not).
    plugins.onManagedReady(options.runtime()?.lastCommand)
    if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
    launchBudgetResetTimer = setTimeout(() => {
      if (configuredTarget === undefined && childTarget === url) launchBudget = MAX_LAUNCH_RETRIES
      launchBudgetResetTimer = undefined
    }, STABLE_RUNTIME_RESET_MS)
    launchBudgetResetTimer.unref()
  }

  /**
   * A Smart-mode probed instance disappeared; fall back to the managed child.
   * Occupancy is not re-checked here: the instance already failed its probe,
   * and another pass would only delay the fallback.
   */
  function fallbackFromProbedInstance(reason: string): boolean {
    if (!probeConnected || options.isQuitting()) return false
    const failedTarget = configuredTarget
    const generation = ++connectionGeneration
    configuredTarget = undefined
    probeConnected = false
    childTarget = undefined
    probedRecoveryReloads = 0
    resetRuntimeRecoveryBudget()
    console.warn('[desktop] probed Web UI unavailable; starting local runtime (' + reason + '): ' + (failedTarget ?? 'unknown'))
    showLoadingDocument()
    // Detection can spend its full deadline on an unresponsive `dsh --version`,
    // so this path names what it is waiting for rather than leaving the surface
    // on the previous message.
    if (!runtimeCatalog.detectionStarted) {
      updateLoadingStatus('正在检查本机 dsh 运行时…', 'Looking for a dsh runtime on this machine…')
    }
    void detectInstalledDsh().then(async () => {
      if (options.isQuitting() || generation !== connectionGeneration) return
      await startLocalRuntime(generation)
    })
    return true
  }

  /**
   * An official instance is still answering, and this client is not allowed to
   * connect to it (reuse is off). It also must not spawn a second writer on the
   * same DSH_HOME. The instance is the user's — this client never terminates it.
   */
  function refuseOccupiedProbeTarget(url: string): void {
    configuredTarget = undefined
    probeConnected = false
    childTarget = undefined
    console.warn('[desktop] refusing local runtime: an official instance is already answering at ' + url)
    const chinese = localeChinese()
    showConnectionError({
      kind: 'runtime',
      headline: chinese ? '本机已有官方实例占用会话数据' : 'An official instance is already using this session data',
      detail: chinese
        ? '检测到正在运行的官方 Web UI：' + url
        : 'An official Web UI is already answering at ' + url,
      url,
      hint: chinese
        ? '智能模式当前不会复用该实例，也不能在它仍占用会话数据时另起本机已安装、npx 或内置运行时。请先在启动它的终端里退出，然后重试。'
        : 'Smart mode will not reuse that instance, and it will not start an installed, npx, or bundled runtime while it occupies the session data. Quit it in the terminal that started it, then retry.',
    })
  }

  /**
   * A loopback service answered the authenticated DSH routes with 401. Treat it
   * as occupied, never as empty: the running Harness may still hold the previous
   * browser-session secret in memory after its credentials document changed.
   * Starting another writer against the same DSH_HOME would risk session loss.
   */
  function refuseUnauthenticatedProbeTarget(url: string): void {
    configuredTarget = undefined
    probeConnected = false
    childTarget = undefined
    console.warn('[desktop] refusing local runtime: a loopback service requires different DSH browser credentials at ' + url)
    const chinese = localeChinese()
    showConnectionError({
      kind: 'runtime',
      headline: chinese ? '无法认证正在运行的 dsh' : 'The running dsh could not be authenticated',
      detail: chinese
        ? '本机地址返回了 dsh 浏览器会话认证失败：' + url
        : 'The local address rejected the DSH browser-session credential: ' + url,
      url,
      hint: chinese
        ? '运行中的 dsh 可能仍在使用凭据文件修改前的会话密钥。为避免两个进程同时写入同一份会话数据，本次没有启动新的运行时。请先退出并重新启动原 dsh，再重试。'
        : 'The running dsh may still hold the browser-session secret from before its credentials file changed. No new runtime was started, because two writers could corrupt the same session data. Quit and restart the original dsh, then retry.',
    })
  }

  /**
   * Smart mode, in order: an official instance already running on this machine,
   * then a dsh the user installed themselves, then the bundled runtime. The
   * detection step runs only here — on the branch that is actually about to
   * start something — so reusing a running instance stays as fast as it was.
   *
   * Turning reuse off does not kill that instance. The same probe still runs as
   * an occupancy gate before a local spawn: two writers on one DSH_HOME corrupt
   * the session store. `DSH_DESKTOP_SKIP_PROBE` skips the gate as well as the
   * reuse connection, which is why an isolated test home can spawn a child
   * while this machine's real 3080 is busy.
   */
  function resolveRuntime(force = false): void {
    const generation = ++connectionGeneration
    resetRuntimeRecoveryBudget()
    // Drop the seat until this process knows who will serve. A spawn re-seats
    // behind the version gate; adopting a running local instance re-seats on
    // the strength of it already serving this profile (`reseatForAdoptedRuntime`);
    // only a pinned address leaves the seat released.
    releaseBundledPluginSeat('resolving which runtime will serve')
    const startLocal = async (skipOccupancy = false): Promise<void> => {
      // Reclaim our leftover before occupancy / pinned-port gates. Those gates
      // cannot see the runtime lock, and on a cold start `isOwnManagedOrigin`
      // is always false — a pinned port still held by this client's crash
      // leftover would otherwise look like a stranger ("quit it in the
      // terminal") and never reach adopt-or-kill.
      const survivor = await adoptOrClearSurvivingRuntime()
      if (options.isQuitting() || generation !== connectionGeneration) return
      if (settleSurvivingRuntime(survivor, generation, force)) return
      // Occupancy is a safety gate, not a connection source. Skip it when the
      // probe just established the ports are empty, or when tests isolate
      // DSH_HOME and must not treat this machine's 3080 as a writer on it.
      if (!skipOccupancy && sharedDshDiscoveryEnabled() && !devFlag('DSH_DESKTOP_SKIP_PROBE')) {
        configuredTarget = undefined
        probeConnected = false
        if (!presentation.isLoading()) showLoadingDocument()
        updateLoadingStatus('正在确认会话数据未被占用…', 'Checking that this session data is not already in use…')
        const occupied = await probeSmartTargets()
        if (options.isQuitting() || generation !== connectionGeneration) return
        if (occupied.kind === 'verified') {
          refuseOccupiedProbeTarget(occupied.url)
          return
        }
        if (occupied.kind === 'authentication-required') {
          refuseUnauthenticatedProbeTarget(occupied.url)
          return
        }
      }
      const pinned = configuredLocalWebPort()
      if (pinned > 0 && !devFlag('DSH_DESKTOP_SKIP_PROBE')) {
        const origin = 'http://127.0.0.1:' + String(pinned)
        if (await loopbackPortHeld(pinned) && !isOwnManagedOrigin(origin)) {
          if (options.isQuitting() || generation !== connectionGeneration) return
          showPinnedPortStartupFailure(pinned)
          return
        }
      }
      if (!runtimeCatalog.detectionStarted) {
        updateLoadingStatus('正在检查本机 dsh 运行时…', 'Looking for a dsh runtime on this machine…')
      }
      await detectInstalledDsh()
      if (options.isQuitting() || generation !== connectionGeneration) return
      await startLocalRuntime(generation, force)
    }
    // Reclaim before the reuse probe: a leftover on a pinned port still
    // answering host.describe would otherwise be adopted as "already running".
    void (async () => {
      const survivor = await adoptOrClearSurvivingRuntime()
      if (options.isQuitting() || generation !== connectionGeneration) return
      if (settleSurvivingRuntime(survivor, generation, force)) return
      if (!sharedDshDiscoveryEnabled() || devFlag('DSH_DESKTOP_SKIP_PROBE')
        || !smartRuntimeEnabled(enabledSmartRuntimes(), 'probe')) {
        void startLocal()
        return
      }
      const probed = await probeSmartTargets()
      if (options.isQuitting() || generation !== connectionGeneration) return
      if (probed.kind === 'verified') {
        configuredTarget = probed.url
        probeConnected = true
        console.log('[desktop] reusing running dsh web: ' + probed.url)
        childTarget = undefined
        probedRecoveryReloads = 0
        reseatForAdoptedRuntime()
        void options.runtime()?.stop()
        launchWindow(generation, force)
        return
      }
      if (probed.kind === 'authentication-required') {
        refuseUnauthenticatedProbeTarget(probed.url)
        return
      }
      await startLocal(true)
    })()
  }

  /**
   * Apply one persisted connection choice without changing its saved address.
   * `force` is set by the seats the user drives (save, switch, retry); startup
   * leaves it off so the first paint is never a redundant reload.
   */
  function applyConnectionSettings(settings: ClientSettings, force = false): void {
    const explicit = normalizeServerUrl(settings.serverUrl)
    if (explicit !== undefined && usesConfiguredServer(settings)) connectTo(explicit, force)
    else resolveRuntime(force)
  }

  /**
   * True when `url` is the managed child this process is serving — never a
   * user-started instance. Client-started runtimes in automatic mode prefer
   * 3080 and 13080 before an OS-assigned port; a pinned local port still has to be
   * recognised as ours, so toggling installed / npx / bundled is not mistaken
   * for occupancy of a process we can already stop.
   */
  function isOwnManagedOrigin(url: string): boolean {
    if (probeConnected) return false
    if (options.runtime()?.pid() === undefined) return false
    const own = childTarget
    return own !== undefined && appOrigin(own) === appOrigin(url)
  }

  /**
   * A user-started harness still answering on this machine, if the next Smart
   * resolve would try to spawn beside it. Probe/reuse being enabled is the
   * way through: the client will connect to that instance instead of starting
   * another writer. Installed / npx / bundled are the spawn rungs — turning
   * those while reuse is off hits the same wall as turning reuse off itself.
   * This client never kills a process it did not start.
   */
  async function instanceOccupyingLocalSpawn(
    ids: readonly SmartRuntimeId[],
    extraPorts: readonly number[] = [],
  ): Promise<string | undefined> {
    if (devFlag('DSH_DESKTOP_SKIP_PROBE')) return undefined
    // A service discovered from the shared profile cannot occupy the isolated
    // profile: the two runtimes write different roots and use different browser
    // credentials. The isolated runtime lock remains the same-home safety gate.
    if (!sharedDshDiscoveryEnabled()) return undefined
    if (smartRuntimeEnabled(ids, 'probe')) return undefined
    const probed = await probeSmartTargets(extraPorts)
    if (probed.kind !== 'unavailable' && !isOwnManagedOrigin(probed.url)) return probed.url
    const target = currentTarget()
    if (target === undefined || !originIsLoopback(target)) return undefined
    if (isOwnManagedOrigin(target)) return undefined
    if (!probeConnected && !usesConfiguredServer(loadSettings())) return undefined
    return await probeWebUi(target)
  }

  /**
   * Stop the current child and re-resolve Smart mode. Shared by source toggles
   * and a local-port change: both stay in Smart (`configuredTarget` stays unset),
   * so a child exit must not look like a crash.
   */
  function applySmartLocalRuntimeChange(): void {
    rememberSmartBridgeHandoff()
    const epoch = ++smartRuntimeApply
    replacingLocalRuntime = true
    connectionGeneration += 1
    void (async () => {
      try {
        await options.runtime()?.stop()
      } catch { /* apply anyway: a wedged child must not pin the old source */ }
      if (epoch !== smartRuntimeApply) return
      replacingLocalRuntime = false
      applyConnectionSettings(loadSettings(), true)
    })()
  }

  function onExit({ wasReady, code, signal, retryable }: RuntimeExit): void {
    if (options.isQuitting() || options.isInstallerHandoff()) return
    if (configuredTarget !== undefined) {
      // Connect/probe mode: a child exit is irrelevant (there should be none).
      return
    }
    if (replacingLocalRuntime) {
      // Intentional stop from a Smart-mode source toggle. Not a crash, and
      // not a reason to reject PATH/npx for the rest of the session.
      childTarget = undefined
      return
    }
    childTarget = undefined
    if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
    launchBudgetResetTimer = undefined
    // A runtime that never came up while this client's seat was on the
    // profile is the one failure the client can undo by itself: a plugin
    // that throws while loading fails the WHOLE plugin tree. The seat goes
    // back before the retry, and this session will not reseat — otherwise
    // spawn() puts the name back and a bad plugin (especially one shipped
    // by a client upgrade, when the entry is already present) burns the
    // launch budget without ever trying the runtime alone.
    const bundledSeatWithdrawn = !wasReady && plugins.withdrawFailedSeat()
    // A user-installed runtime that never reached readiness is not a base
    // this session can build on, and the client does not control it. Skip
    // that source for the rest of the session and try the next enabled one
    // (npx, then bundled) rather than spending the shared retry budget on
    // identical failures — the budget still covers the fallback. A pinned
    // port that is still held is the exception: every source would fail the
    // same bind, so walking the ladder only stacks identical errors.
    const recoverFromChildExit = (): void => {
      // The client-owned plugin is the one boot failure we can remove
      // without touching user state. Retry the SAME source once after a
      // successful withdrawal: rejecting an installed-only source here
      // would overwrite the actionable plugin diagnostic with "no enabled
      // runtime" before the data-home fallback could inspect it.
      if (!wasReady && bundledSeatWithdrawn) {
        const generation = connectionGeneration
        console.warn('[desktop] retrying the same dsh runtime without the bundled plugin seat')
        if (presentation.windowRequested()) {
          showLoadingDocument()
          updateLoadingStatus(
            '桌面端插件加载失败，已撤回并正在重试…',
            'The desktop plugin failed to load; retrying without it…',
          )
        }
        void respawnLocalRuntime(generation)
        return
      }
      // Loader import/apply errors are deterministic for this data home.
      // Preserve and act on that diagnosis before source rejection, command
      // resolution, or generic retries can replace it with a secondary
      // error or run the same broken profile again.
      if (!wasReady && schedulePluginCompatibilityFallback(code, signal)) return
      if (!wasReady && runtimeCatalog.rejectFailedSource(options.runtime()?.lastSource)) {
        console.warn('[desktop] user-installed dsh failed to start ('
          + String(code) + '/' + String(signal) + '); trying the next enabled runtime')
        const generation = connectionGeneration
        if (presentation.windowRequested()) {
          showLoadingDocument()
          updateLoadingStatus('本机 dsh 启动失败，正在改用其他来源…',
            'The installed dsh did not start; trying the next enabled runtime…')
        }
        void respawnLocalRuntime(generation)
        return
      }
      if (retryable && launchBudget > 0) {
        launchBudget -= 1
        const delayMs = relaunchDelayMs(launchBudget)
        const generation = connectionGeneration
        console.error('[desktop] dsh web ' + (wasReady ? 'exited' : 'failed to start') + ' (' + String(code) + '/' + String(signal)
          + '); relaunching in ' + String(delayMs) + 'ms (' + String(launchBudget) + ' left)')
        if (presentation.windowRequested()) {
          showLoadingDocument()
          updateLoadingStatus(
            wasReady ? '本地服务意外退出，正在重启…' : '本地服务启动失败，正在重试…',
            wasReady ? 'The local service exited; restarting…' : 'The local service did not start; retrying…',
          )
        }
        setTimeout(() => {
          if (options.isQuitting() || configuredTarget !== undefined || generation !== connectionGeneration) return
          void respawnLocalRuntime(generation)
        }, delayMs)
        return
      }
      if (!wasReady) {
        console.error('[desktop] dsh web failed to start (' + String(code) + '/' + String(signal) + '); no relaunches left')
        showLocalRuntimeStartupFailure(code, signal)
        return
      }
      console.error('[desktop] dsh web exited (' + String(code) + '/' + String(signal) + ')')
      const chinese = localeChinese()
      showConnectionError({
        kind: 'runtime',
        headline: chinese ? '本地服务意外退出' : 'The local service exited unexpectedly',
        detail: (chinese ? '代码 ' : 'code ') + String(code) + (chinese ? ' / 信号 ' : ' / signal ') + String(signal),
      })
    }
    if (!wasReady) {
      const pinned = configuredLocalWebPort()
      // `lastSource` is cleared when command resolution fails before spawn.
      // In that case another process holding the requested port is
      // incidental and must not hide the real runtime/configuration error.
      if (pinned > 0 && options.runtime()?.lastSource !== undefined) {
        void loopbackPortHeld(pinned).then((held) => {
          if (options.isQuitting() || options.isInstallerHandoff() || configuredTarget !== undefined || replacingLocalRuntime) return
          if (held) {
            console.error('[desktop] pinned port ' + String(pinned)
              + ' is still held after a failed spawn; not trying other runtimes')
            showPinnedPortStartupFailure(pinned)
            return
          }
          recoverFromChildExit()
        })
        return
      }
    }
    recoverFromChildExit()
  }

  /** Readiness belongs to the connection intent that requested it. */
  async function readyForConnection(generation: number): Promise<string | undefined> {
    if (generation !== connectionGeneration || options.isQuitting()) return undefined
    const url = await options.runtime()?.ready()
    if (url === undefined || generation !== connectionGeneration || options.isQuitting()) return undefined
    console.log('[desktop] dsh runtime ready: ' + appOrigin(url))
    markLocalRuntimeReady(url)
    return url
  }

  async function stop(restarting = false): Promise<void> {
    if (restarting) await options.survivor.stopAdoptedRuntimeForRestart()
    await options.runtime()?.stop()
  }

  return {
    currentTarget, applyConnectionSettings, applySmartLocalRuntimeChange,
    handleProbedInstanceFailure, fallbackFromProbedInstance, readyForConnection, stop,
    probeWithGrace, refuseUnauthenticatedProbeTarget, resetRuntimeRecoveryBudget,
    instanceOccupyingLocalSpawn, isOwnManagedOrigin, localWebSpawnPort, onExit,
    get generation() { return connectionGeneration },
    get configuredTarget() { return configuredTarget },
    get probeConnected() { return probeConnected },
    get childTarget() { return childTarget },
    upgradeConfiguredTarget(url: string): void { configuredTarget = appOrigin(url) },
    resetProbeRecovery(): void { probedRecoveryReloads = 0 },
    dispose(): void {
      if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
      launchBudgetResetTimer = undefined
    },
  }
}
export type ConnectionController = ReturnType<typeof createConnectionController>
