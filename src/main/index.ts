import { mainContentHeightScript } from './window-content.ts'
import { createBridgePolicy,type BridgeCaller } from './bridge-policy.ts'
import { createDesktopIpc } from './desktop-ipc.ts'
import { createLocaleController } from './locale-controller.ts'
import { createMainWindowFactory } from './main-window.ts'
import { buildApplicationMenu,buildTrayMenu } from './native-menus.ts'
import { createPluginRecoveryController } from './plugin-recovery-controller.ts'
import { createSettingsCommands } from './settings-commands.ts'
import { createSettingsServer } from './settings-server.ts'
import { createUpdateController } from './update-controller.ts'
import { createWindowHealth } from './window-health.ts'
import { createWindowTheme } from './window-theme.ts'
/**
 * Electron main process for the DSH Desktop client.
 *
 * The client consumes the official dsh Web UI and its documented browser-
 * session record: it manages a local `dsh web` child (or connects to a
 * configured Web UI origin) and loads the **official Web UI** itself in the
 * client window — the interface, session titles/renaming, and every button
 * interaction are the official product's. Desktop settings have their own
 * native window and an optional entry in the official settings dialog.
 * Runtime, connection and persistence modules are assembled here; none imports
 * a harness package.
 *
 * Path expressions resolve at runtime from the BUILT bundle
 * (.build/main.mjs), so relative URLs are written against that layout, not
 * the source tree.
 * @module dsh-desktop/main
 */

import { createRuntimeEnvironment } from './runtime-environment.ts'
import { installEmergencyRuntimeDisposal } from './runtime-process.ts'

import { createClientSettingsStore,type ClientSettings } from './client-settings.ts'
import { createConnectionController } from './connection-controller.ts'
import { appOrigin,normalizeServerUrl,usesConfiguredServer } from './connection-policy.ts'
import type { ConnectionFailure } from './connection-types.ts'
import { devFlag,devOverride } from './development-options.ts'
import { createRuntimeCatalog } from './runtime-catalog.ts'
import { sanitizeRuntimeOutput } from './runtime-output.ts'
import { createRuntimeSurvivor } from './runtime-survivor.ts'
import type { DshCommand } from './runtime-types.ts'
import { WebUiManager } from './web-ui-manager.ts'
import { createWebUiProbe } from './web-ui-probe.ts'

import { renderErrorPageUrl } from './pages/error.ts'
import { renderLoadingPageUrl } from './pages/loading.ts'
import { renderClientNoticePageUrl } from './pages/notice.ts'
import { renderSettingsPageScript } from './pages/settings-script.ts'
import { renderSettingsPageHtml } from './pages/settings.ts'
import { parseSettingsIntegrationStatus,type SettingsIntegrationStatus } from './settings-integration.ts'

import { app,BrowserWindow,dialog,ipcMain,Menu,nativeImage,nativeTheme,powerMonitor,screen,session,shell,Tray } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync,readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abandonBundledPlugin,BUNDLED_PLUGIN_NAME,seatBundledPlugin,withdrawBundledPlugin } from './bundled-plugin.ts'
import {
dshHomeForMode,
migrateLegacyClientHome,
normalizeDshDataMode,
normalizePluginPackageName,
type DshDataMode
} from './data-home.ts'
import {
NO_OPEN_SINCE,
normalizeLocalWebPort,
webSpawnArgs
} from './local-web-port.ts'
import { officialDshPackageVersion } from './official-dsh-bin.ts'
import { windowsAppUserModelId } from './permission-policy.ts'
import { PNPM_ENTRY_VARIABLE } from './runtime-spawn.ts'
import {
normalizeSmartRuntimes,
type SmartRuntimeId
} from './smart-runtimes.ts'
import {
compareVersions,
DesktopUpdater,
type UpdateState
} from './updater.ts'

/** The built bundle sits at <project>/.build/main.mjs. */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const { loadSettings, patchSettings } = createClientSettingsStore(clientHome())
const webProbe = createWebUiProbe({ childHome, configuredLocalWebPort })
const { defaultWebProbeUrl, inspectWebUi, probeWebUi, waitForWebUiReady } = webProbe
const runtimeSurvivor = createRuntimeSurvivor({
  childHome, managedPid: () => webUi?.pid(), enabledSmartRuntimes, probeWebUi,
  connection: () => ({ adopted: connection.probeConnected, target: currentTarget() }),
})

const runtimeEnvironment = createRuntimeEnvironment({ appDir: APP_DIR, clientHome, childHome })
const runtimeCatalog = createRuntimeCatalog({ environment: runtimeEnvironment, clientHome, enabledSmartRuntimes, bundledDshVersion, localeChinese })
const { resolveDshCommand, selectedInstalledDsh } = runtimeCatalog
const { bundledPnpmEntry, childPath, resolveBundledDsh, restoreMacGuiPath } = runtimeEnvironment
const connection = createConnectionController({
  runtime: () => webUi, catalog: runtimeCatalog, probe: webProbe, survivor: runtimeSurvivor,
  childHome, loadSettings, sharedDshDiscoveryEnabled, localeChinese,
  isQuitting: () => quitting, isInstallerHandoff,
  plugins: { releaseBundledPluginSeat, reseatForAdoptedRuntime, onManagedReady, withdrawFailedSeat, schedulePluginCompatibilityFallback },
  presentation: {
    windowRequested: () => mainWindowRequested, isLoading: () => loadingDocumentActive,
    launchWindow, loadMainWindow, showLoadingDocument, updateLoadingStatus, showConnectionError,
    showPinnedPortStartupFailure, showLocalRuntimeStartupFailure, rememberSmartBridgeHandoff,
  },
})
const { currentTarget, applyConnectionSettings, applySmartLocalRuntimeChange, handleProbedInstanceFailure,
  fallbackFromProbedInstance, instanceOccupyingLocalSpawn, isOwnManagedOrigin, localWebSpawnPort,
  probeWithGrace, refuseUnauthenticatedProbeTarget, resetRuntimeRecoveryBudget } = connection

/**
 * Every background subprocess this file starts is headless on Windows.
 * A `.cmd`/`taskkill`/`powershell` CreateProcess otherwise flashes a console
 * — including in a packaged build, every time Smart mode probes a PATH dsh
 * or the manager stops a child.
 */
const SPAWN_NO_WINDOW = { windowsHide: true } as const

/** The client's branded private home (settings, shims and update downloads). */
function clientHome(): string {
  return devOverride('DSH_DESKTOP_HOME') ?? join(homedir(), '.bruc3van-dsh-desktop')
}

/**
 * The local child's data home is frozen for this process: shared official
 * ~/.dsh by default, or the client-owned isolated home. DSH_HOME overrides.
 */
let activeDshHome: string | undefined
let activeDshDataMode: DshDataMode | undefined
function childHome(): string {
  return activeDshHome ?? devOverride('DSH_HOME')
    ?? dshHomeForMode(normalizeDshDataMode(loadSettings().dshDataMode), homedir(), clientHome())
}

function selectedDshDataMode(settings: ClientSettings = loadSettings()): DshDataMode {
  return normalizeDshDataMode(settings.dshDataMode)
}

/** A development DSH_HOME override is an explicit fixture and wins over the UI. */
function dshDataModeSelectable(): boolean {
  return devOverride('DSH_HOME') === undefined
}

/** Generic localhost discovery is meaningful only for the shared official home. */
function sharedDshDiscoveryEnabled(): boolean {
  return (activeDshDataMode ?? selectedDshDataMode()) === 'shared'
}

function enabledSmartRuntimes(): SmartRuntimeId[] {
  return normalizeSmartRuntimes(loadSettings().smartRuntimes)
}

/** The saved bind choice for a client-started `dsh web`. 0 = automatic. */
function configuredLocalWebPort(): number {
  return normalizeLocalWebPort(loadSettings().localWebPort)
}

/** True when this runtime's CLI accepts `--no-open` (and would open a browser without it). */
function runtimeSupportsNoOpen(version: string | undefined): boolean {
  if (version === undefined || version.trim() === '') return false
  return compareVersions(version, NO_OPEN_SINCE) >= 0
}

/**
 * Whether the client-owned seat is on the profile this boot (added now, or
 * already present). A runtime that then never reaches readiness has the
 * entry taken back before the retry — a plugin that throws while loading
 * fails the whole plugin tree, not just itself, including after upgrades
 * where the name is no longer a first write.
 */
let bundledPluginSeatInUse = false
/**
 * Session-scoped: this process already withdrew a seat after a failed boot.
 * Retries must not put the name back, or a deterministic bad plugin burns
 * the whole launch budget without ever trying the one config that can work
 * (the bundled runtime with no plugin).
 */
let bundledPluginSuppressed = false

/**
 * The bundled plugin's directory inside the client's runtime closure.
 *
 * Resolved the same way `resolveBundledDsh` resolves the runtime itself, and
 * deliberately NOT by walking up from the runtime's bin path: a packaged
 * closure is hoisted (the plugin sits beside `@deepseek-ai`), while a source
 * checkout keeps pnpm's symlinked layout (the same arithmetic lands inside
 * `.pnpm/@deepseek-ai+dsh@…/node_modules`, where the plugin is not). Asking
 * the resolver instead makes the seat work in both.
 * @returns the plugin directory, or undefined when this build carries none.
 */
function bundledPluginDir(): string | undefined {
  try {
    if (app.isPackaged) {
      const dir = join(process.resourcesPath, 'dsh-runtime', 'node_modules', BUNDLED_PLUGIN_NAME)
      return existsSync(join(dir, 'package.json')) ? dir : undefined
    }
    const anchor = join(APP_DIR, 'dsh-runtime', 'package.json')
    return dirname(createRequire(anchor).resolve(BUNDLED_PLUGIN_NAME + '/package.json'))
  } catch {
    return undefined
  }
}

/**
 * Offer — or stop offering — the bundled plugin to the profile about to boot.
 *
 * Every runtime this client STARTS is a candidate, not just its own. The
 * plugin is copied into `profiles/node_modules` rather than linked into the
 * closure, so its `@deepseek-ai/*` imports resolve through the graph the
 * harness heals there for whichever installation is serving — the same way a
 * plugin installed with `dsh plugin add` resolves. What used to make the seat
 * unsafe elsewhere (a second copy of the Service classes, reached through the
 * link's realpath) is therefore gone.
 *
 * What replaces it is a version gate: the plugin is built against the runtime
 * this client ships, so an older one is refused rather than risked. See
 * `runtimeRefusal`.
 *
 * A pinned address still releases the seat: it may not even be this machine,
 * and the client cannot know when a change to a profile it is not booting
 * would take effect. A LOCAL instance the client adopts (probe, survivor) is
 * different — it serves this very profile, and releasing the seat under it
 * left the market unable to see itself in the profile it manages; that path
 * re-seats instead (see `reseatForAdoptedRuntime`).
 * @param dsh - the resolved command this spawn is about to run.
 */
function applyBundledPluginSeat(dsh: DshCommand): void {
  if (loadSettings().bundledMarketDisabled === true) {
    // The user's own answer, and it outranks every other reason to seat. The
    // copy goes too: withdrawing the entry alone would leave a plugin tree in
    // their profile that nothing loads and nothing ever cleans up.
    if (abandonBundledPlugin(childHome())) {
      console.log('[desktop] bundled plugin removed: turned off in connection settings')
    }
    bundledPluginSeatInUse = false
    return
  }
  if (bundledPluginSuppressed) {
    releaseBundledPluginSeat('suppressed after a failed boot this session')
    return
  }
  offerBundledPluginSeat(dsh)
}

function releaseBundledPluginSeat(reason: string): void {
  if (withdrawBundledPlugin(childHome())) {
    console.log('[desktop] bundled plugin seat withdrawn: ' + reason)
  }
  bundledPluginSeatInUse = false
}

/**
 * Put the seat back when adopting a runtime that is already serving this
 * profile (a probed instance the user started, a surviving child).
 * `resolveRuntime` released the seat before it knew who would serve; leaving
 * it released here strands the running market outside the manifest its
 * installed panel reads — it cannot see, disable, or uninstall itself. The
 * version gate does not run against an adopted instance — host.describe
 * carries a version, but this adoption path keeps only the origin — so the
 * seat rides on `serving`: the instance demonstrably boots this profile,
 * and the client's own spawns re-gate with the real version.
 */
function reseatForAdoptedRuntime(): void {
  if (loadSettings().bundledMarketDisabled === true || bundledPluginSuppressed) return
  const pluginDir = bundledPluginDir()
  if (pluginDir === undefined) return
  const result = seatBundledPlugin(pluginDir, childHome(), {
    serving: true,
    builtAgainst: bundledDshVersion() ?? undefined,
  })
  bundledPluginSeatInUse = result.seated
  if (result.added) console.log('[desktop] bundled plugin re-seated under the adopted runtime: ' + BUNDLED_PLUGIN_NAME)
  else if (!result.seated && result.error !== undefined) {
    console.log('[desktop] bundled plugin not seated: ' + result.error)
  }
}

function offerBundledPluginSeat(dsh: DshCommand): void {
  const home = childHome()
  const pluginDir = bundledPluginDir()
  if (pluginDir === undefined) {
    if (abandonBundledPlugin(home)) {
      console.log('[desktop] bundled plugin seat withdrawn: the runtime closure carries no bundled plugin')
    }
    bundledPluginSeatInUse = false
    return
  }
  const result = seatBundledPlugin(pluginDir, home, {
    version: dsh.source === 'bundled' ? (bundledDshVersion() ?? undefined) : dsh.version,
    builtAgainst: bundledDshVersion() ?? undefined,
  })
  bundledPluginSeatInUse = result.seated
  if (result.lifted) {
    console.log('[desktop] bundled plugin overlay was older than the closure; using ' + BUNDLED_PLUGIN_NAME
      + ' from the runtime closure')
  }
  if (result.added) console.log('[desktop] bundled plugin seated: ' + BUNDLED_PLUGIN_NAME)
  else if (!result.seated && result.error !== undefined) {
    console.log('[desktop] bundled plugin not seated: ' + result.error)
  }
}

function onManagedReady(command: DshCommand | undefined): void {
  if (command !== undefined && !bundledPluginSeatInUse && !bundledPluginSuppressed) offerBundledPluginSeat(command)
  promptPluginCompatibilityFallback()
}

function withdrawFailedSeat(): boolean {
  if (!bundledPluginSeatInUse) return false
  bundledPluginSeatInUse = false
  if (!withdrawBundledPlugin(childHome())) return false
  bundledPluginSuppressed = true
  console.warn('[desktop] dsh web did not start with ' + BUNDLED_PLUGIN_NAME
    + ' seated; the seat was withdrawn and will not be offered again this session')
  return true
}

let mainWindow: BrowserWindow | null = null
const macFallbackNotificationIds = new Set<string>()
let macDockBounceId: number | undefined

function updateMacNotificationBadge(): void {
  if (process.platform !== 'darwin') return
  app.dock?.setBadge(macFallbackNotificationIds.size === 0 ? '' : String(macFallbackNotificationIds.size))
}

function clearMacNotificationAttention(id?: string): void {
  if (process.platform !== 'darwin') return
  if (id === undefined) macFallbackNotificationIds.clear()
  else macFallbackNotificationIds.delete(id)
  if (macDockBounceId !== undefined) {
    app.dock?.cancelBounce(macDockBounceId)
    macDockBounceId = undefined
  }
  updateMacNotificationBadge()
}

function requestMacNotificationAttention(id: string): void {
  if (process.platform !== 'darwin' || id === '' || macFallbackNotificationIds.has(id)) return
  macFallbackNotificationIds.add(id)
  updateMacNotificationBadge()
  const window = mainWindow
  if (window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused()) return
  if (macDockBounceId === undefined) macDockBounceId = app.dock?.bounce('critical')
}

/** Whether a caller is waiting for the main window, as opposed to tray-only recovery. */
let mainWindowRequested = false
/** Whether the main window still shows the local loading document. */
let loadingDocumentActive = false
/** Invalidates delayed loading hints from an older startup/reconnect surface. */
let loadingHintGeneration = 0
/** Whether the main window shows the local connection-failure document. */
let errorDocumentActive = false
let settingsWindow: BrowserWindow | null = null
const settingsServer = createSettingsServer({
  updater: () => desktopUpdater,
  getStatusJson,
  setBundledMarketEnabled,
  probeDefaultWebUi,
  desktopClientVersion,
  updateStateForPage,
  pageUpdateState,
  installDesktopUpdate,
  scheduleQuitAfterWindowsInstall,
  settingsPageScript,
  requestServerUrlSave,
  loadSettings,
  configuredLocalWebPort,
  requestSmartRuntimesSave,
  requestLocalWebPortSave,
  requestDshDataModeSave,
  switchConnectionMode,
  settingsPageHtml,
})
let tray: Tray | null = null
let desktopUpdater: DesktopUpdater | undefined
let webUi: WebUiManager | undefined
let quitting = false
/**
 * Set when this quit is a restart, so the stop ladder also disposes of a
 * runtime the client adopted rather than spawned. Read only inside the
 * shutdown path: by then `quitting` already suppresses every recovery route,
 * so stopping the harness the window is pointed at cannot be mistaken for an
 * outage and answered with a second writer.
 */
let restarting = false
let windowHealthTimer: NodeJS.Timeout | undefined
const WINDOW_HEALTH_INTERVAL_MS = 60_000

/**
 * Open external links in the system browser; never in a client window.
 * Parsed rather than prefix-matched: the scheme is what decides, and a prefix
 * test both misses `HTTPS://` and would accept a lookalike like
 * `http://x@evil` only by accident of spelling.
 */
function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(url)
}
function recoverBlankWindow(reason: string, force = false): Promise<void> {
  return windowHealth.recoverBlankWindow(reason, force)
}

function scheduleWindowHealthCheck(reason: string, delayMs = 1_000): void {
  return windowHealth.scheduleWindowHealthCheck(reason, delayMs)
}


/** The official DeepSeek Harness logo: rounded-corner dark tile with the white glyph. */
const ICON_PNG = join(APP_DIR, 'resources', 'icon-app.png')
/** Windows taskbar variant: same tile with a larger glyph for small icon sizes. */
const WINDOW_ICON_PNG = process.platform === 'win32'
  ? join(APP_DIR, 'resources', 'icon-win.png')
  : ICON_PNG

/**
 * The logo as an inline data URI, or an empty tag when the resource cannot be
 * read: the first window is now on the startup path, so a missing icon must
 * degrade to a plain loading page rather than abort the launch.
 */
function loadingIconTag(): string {
  try {
    return '<img class="mark" alt="" src="data:image/png;base64,' + readFileSync(ICON_PNG).toString('base64') + '">'
  } catch (error) {
    console.warn('[desktop] loading icon unavailable:', error instanceof Error ? error.message : String(error))
    return ''
  }
}

/** The small first-paint surface shown while Smart mode resolves the Web UI. */
function loadingPageUrl(): string {
  return renderLoadingPageUrl(localeChinese(), loadingIconTag())
}

/** Reassure the user as a first launch moves beyond its usual 10–20 seconds. */
function scheduleLoadingHints(): void {
  const generation = ++loadingHintGeneration
  const chinese = localeChinese()
  const steps = chinese
    ? [
        [10_000, '正在初始化运行时，通常还需要几秒钟…'],
        [20_000, '仍在准备中，首次启动有时会超过 20 秒…'],
        [35_000, '正在等待本地服务就绪，请继续稍候…'],
      ] as const
    : [
        [10_000, 'Initializing the runtime — usually just a few more seconds…'],
        [20_000, 'Still preparing — the first launch can sometimes take over 20 seconds…'],
        [35_000, 'Waiting for the local service to become ready…'],
      ] as const
  for (const [delay, message] of steps) {
    setTimeout(() => {
      const window = mainWindow
      if (generation !== loadingHintGeneration || !loadingDocumentActive
        || window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
      void window.webContents.executeJavaScript(
        `document.querySelector('.hint')?.replaceChildren(${JSON.stringify(message)});`,
        true,
      ).catch(() => {})
    }, delay).unref()
  }
}

/**
 * Update the loading document. Busy-path copy stays off the splash (title +
 * hint + dots are enough); the 'failed' state reveals the status line and
 * withdraws the activity indicator and estimated-time hint. A launch that
 * cannot proceed must not keep animating, nor keep promising progress. It
 * reveals the connection button instead — with no page, the official settings
 * dialog (which now owns the connection form) cannot be reached.
 */
function updateLoadingStatus(chinese: string, english: string, state: 'busy' | 'failed' = 'busy'): void {
  const window = mainWindow
  // Not webContents.getURL(): it stays empty until the data document commits,
  // which is exactly when the first status update is issued. Electron holds
  // the script until the page stops loading, so an early call still lands.
  if (!loadingDocumentActive || window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
  const message = localeChinese() ? chinese : english
  const failed = String(state === 'failed')
  void window.webContents.executeJavaScript(
    `document.getElementById('loading-status')?.replaceChildren(${JSON.stringify(message)});`
    + `document.getElementById('loading-status')?.toggleAttribute('hidden', ${state !== 'failed'});`
    + `document.querySelector('.activity')?.toggleAttribute('hidden', ${failed});`
    + `document.querySelector('.hint')?.toggleAttribute('hidden', ${failed});`
    // The page's own CSP forbids inline script, so the click seat is bound
    // from here. onclick (not addEventListener) keeps repeat calls idempotent.
    + `(() => { const b = document.getElementById('loading-action'); if (b === null) return;`
    + ` b.hidden = !${failed};`
    + ` b.onclick = () => { window.desktop?.openConnectionSettings?.() } })();`,
    true,
  ).catch(() => {})
}

/**
 * Plain-language cause for a Chromium net error. The numbers are stable
 * (net_error_list.h) and the user cannot be expected to know any of them; what
 * they need is the one thing to change — scheme, port, certificate, network.
 */
function loadFailureHint(code: number, url: string, chinese: boolean): string {
  const secure = url.startsWith('https://')
  switch (code) {
    // CERT_COMMON_NAME_INVALID / DATE_INVALID / AUTHORITY_INVALID / REVOKED /
    // INVALID / WEAK_SIGNATURE_ALGORITHM / CERT_AUTHORITY_INVALID variants.
    case -200: case -201: case -202: case -203: case -204: case -206: case -207: case -208: case -501:
      return chinese
        ? '服务器的 TLS 证书不被信任，自签名证书最常见。请为该地址配置受信任的证书，或改用已签发证书的地址。'
        : 'The server’s TLS certificate is not trusted — a self-signed certificate is the usual cause. Install a trusted certificate for that address, or use one that already has one.'
    case -105:
      return chinese
        ? '域名无法解析。请检查地址拼写，以及本机的 DNS 或 VPN。'
        : 'The host name could not be resolved. Check the spelling, and this machine’s DNS or VPN.'
    case -102:
      return chinese
        ? '目标端口没有服务在监听。请确认服务端已启动，端口正确且防火墙已放行。'
        : 'Nothing is listening on that port. Check that the server is running, the port is right, and the firewall allows it.'
    case -7: case -21: case -118:
      return chinese
        ? '连接超时。请检查网络、代理设置，以及服务端是否仍在运行。'
        : 'The connection timed out. Check the network, any proxy, and whether the server is still running.'
    case -100: case -101: case -107:
      return secure
        ? (chinese
            ? '连接被中断。该端口可能并不提供 HTTPS，可尝试把地址改成 http://。'
            : 'The connection was closed. That port may not speak HTTPS — try http:// instead.')
        : (chinese
            ? '连接被中断。该端口可能只接受 HTTPS，可尝试把地址改成 https://。'
            : 'The connection was closed. That port may require HTTPS — try https:// instead.')
    case -106:
      return chinese ? '本机当前没有网络连接。' : 'This machine is offline.'
    default:
      return chinese
        ? '请确认地址、端口与网络可达后重试，或在连接设置中换一个地址。'
        : 'Check the address, the port, and network reachability, then retry — or set a different address in the connection settings.'
  }
}

/**
 * Plain-language cause for an HTTP status. The body behind such a status is
 * the SERVER's error page (nginx's, typically), which is exactly what must not
 * be handed to the user as if it were the app.
 */
function httpFailureHint(status: number, url: string, chinese: boolean): string {
  if (!url.startsWith('https://') && (status === 400 || status === 426 || status === 497)) {
    return chinese
      ? '服务器按明文 HTTP 拒绝了这次请求，该端口很可能只接受 HTTPS。请把地址改成 https:// 后重试。'
      : 'The server rejected the request as plaintext HTTP; that port most likely requires HTTPS. Change the address to https:// and retry.'
  }
  if (status === 401 || status === 403) {
    return chinese
      ? '服务器拒绝了这次访问。该地址可能需要登录，或不允许来自本机的请求。'
      : 'The server refused the request. That address may require a sign-in, or may not allow requests from this machine.'
  }
  if (status === 404) {
    return chinese
      ? '该地址上没有 Web UI。请确认端口与路径是否正确。'
      : 'There is no Web UI at that address. Check the port and the path.'
  }
  if (status >= 500) {
    return chinese
      ? '服务端返回了错误。请稍后重试，或检查服务端进程与反向代理的日志。'
      : 'The server returned an error. Retry later, or check the server process and reverse-proxy logs.'
  }
  return chinese
    ? '服务器返回的不是 Web UI 页面。请确认地址指向 dsh web 服务。'
    : 'The server did not return the Web UI. Check that the address points at a dsh web service.'
}

/**
 * The in-app connection-failure surface: the same visual language as the
 * loading page and the connection window. It replaces a native message box on
 * purpose — a modal dialog over an empty frame is the one thing a user cannot
 * work with, and a server's own 4xx/5xx page is not an interface either.
 */
function errorPageUrl(copy: {
  title: string
  hint: string
  addressLabel: string
  address: string
  reasonLabel: string
  reason: string
  reasonLimit?: number
  retry: string
  settings: string
  quit: string
  /** Offered only when a pinned address failed: leave it for Smart mode. */
  useSmart?: string
  /** Lock / record path. Shown in full — a long DSH_HOME must not be sliced off. */
  recordLabel?: string
  recordPath?: string
}): string {
  return renderErrorPageUrl(copy, localeChinese(), loadingIconTag())
}

/**
 * A failure raised while no window was open. This client is tray-resident, so
 * closing the window during a slow startup leaves the app running with nothing
 * to render into — and the runtime can fail after that. The failure waits here
 * and takes over the next window instead of being lost.
 */
let pendingConnectionFailure: { failure: ConnectionFailure; generation: number } | undefined

/**
 * Show the failure surface in the main window. One at a time: a single
 * navigation can raise both a load failure and a status, and the first
 * description is the one that explains it. Retry clears the flag.
 */
function showConnectionError(failure: ConnectionFailure): void {
  if (quitting) return
  const window = mainWindow
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) {
    reportConnectionFailureWithoutWindow(failure)
    return
  }
  if (errorDocumentActive) return
  const chinese = localeChinese()
  let title: string
  let hint: string
  let address = ''
  let reason: string
  if (failure.kind === 'runtime') {
    title = failure.headline
    reason = failure.detail
    address = failure.url ?? ''
    hint = failure.hint ?? (chinese
      ? '可以重试启动本地服务，或在连接设置中填写另一个可用的 Web UI 地址。'
      : 'Retry the local service, or set a different Web UI address in the connection settings.')
  } else if (failure.kind === 'http') {
    title = chinese ? '无法打开 Web UI' : 'The Web UI did not load'
    address = failure.url
    reason = 'HTTP ' + String(failure.status) + (failure.statusText === '' ? '' : ' ' + failure.statusText)
    hint = httpFailureHint(failure.status, failure.url, chinese)
  } else {
    title = chinese ? '无法连接 Web UI' : 'Could not reach the Web UI'
    address = failure.url
    reason = failure.description + ' (' + String(failure.code) + ')'
    hint = loadFailureHint(failure.code, failure.url, chinese)
  }

  errorDocumentActive = true
  loadingDocumentActive = false
  resetPageAppearance()
  void window.loadURL(errorPageUrl({
    title,
    hint,
    addressLabel: chinese ? '地址' : 'Address',
    address,
    reasonLabel: chinese ? '原因' : 'Reason',
    reason: failure.kind === 'runtime' ? reason.slice(0, 4_000) : reason,
    reasonLimit: failure.kind === 'runtime' ? 4_000 : undefined,
    retry: chinese ? '重试' : 'Retry',
    settings: chinese ? '连接设置…' : 'Connection settings…',
    quit: chinese ? '退出' : 'Quit',
    // Only a pinned address has a Smart mode to fall back to; a local runtime
    // that failed is already what Smart would have chosen.
    ...usesConfiguredServer(loadSettings()) && {
      useSmart: chinese ? '切换到智能模式' : 'Switch to Smart mode',
    },
    ...failure.kind === 'runtime' && failure.recordPath !== undefined && {
      recordLabel: chinese ? '记录文件' : 'Record',
      recordPath: failure.recordPath,
    },
  })).catch(() => {})
  // The seats are NOT bound from that promise. This navigation supersedes the
  // 4xx response Chromium was still committing, and the abort event that
  // produces can settle loadURL as a rejection even though the failure surface
  // renders — leaving every button dead with no second chance to bind. The
  // document's own did-finish-load is the event that actually describes what
  // is on screen, so bindErrorPageSeats runs from there.
}

/**
 * Bind the failure surface's seats. The page's own CSP forbids inline script,
 * so the handlers are assigned from the main process. onclick (not
 * addEventListener) keeps repeat calls idempotent, and the null check makes a
 * call that lands on any other document a no-op.
 */
function bindErrorPageSeats(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  void window.webContents.executeJavaScript(
    '(() => { const bind = (id, run) => { const b = document.getElementById(id); if (b !== null) b.onclick = run };'
    + ' bind("error-retry", () => { window.desktop?.local?.retry?.() });'
    + ' bind("error-use-smart", () => { window.desktop?.local?.useSmart?.() });'
    + ' bind("error-settings", () => { window.desktop?.openConnectionSettings?.() });'
    + ' bind("error-quit", () => { window.desktop?.local?.quit?.() }) })();',
    true,
  ).catch(() => {})
}

/**
 * The same failure, with no window to draw it in. An ownerless native dialog
 * is the only surface left — this is what the pre-error-page code did for
 * exactly this case, and dropping it made a tray-resident startup failure
 * silent. Opening the window renders the real error surface, because the
 * failure is held for it.
 */
function reportConnectionFailureWithoutWindow(failure: ConnectionFailure): void {
  if (pendingConnectionFailure !== undefined) return
  // Tagged with the attempt it describes. Any deliberate reconnection bumps
  // the generation, which retires this failure rather than letting it take
  // over the window the new attempt is opening.
  pendingConnectionFailure = { failure, generation: connection.generation }
  const chinese = localeChinese()
  const detail = failure.kind === 'runtime'
    ? failure.detail + (failure.recordPath === undefined
      ? ''
      : '\n\n' + (chinese ? '记录文件：' : 'Record: ') + failure.recordPath)
    : failure.url + '\n' + (failure.kind === 'http'
      ? 'HTTP ' + String(failure.status) + (failure.statusText === '' ? '' : ' ' + failure.statusText)
      : failure.description + ' (' + String(failure.code) + ')')
  void dialog.showMessageBox({
    type: 'error',
    title: 'DSH Desktop',
    message: failure.kind === 'runtime'
      ? failure.headline
      : (chinese ? '无法连接 Web UI' : 'Could not reach the Web UI'),
    detail,
    buttons: [
      chinese ? '显示主窗口' : 'Show Window',
      chinese ? '连接设置…' : 'Connection settings…',
      chinese ? '退出' : 'Quit',
    ],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 0) showMainWindow()
    else if (response === 1) openSettingsWindow()
    else app.quit()
  }, () => {})
}

/** The failure surface's 重试: re-resolve the connection from the saved settings. */
function retryConnection(): void {
  if (quitting) return
  errorDocumentActive = false
  showLoadingDocument()
  updateLoadingStatus('正在重新连接…', 'Reconnecting…')
  resetRuntimeRecoveryBudget()
  applyConnectionSettings(loadSettings(), true)
}
function windowBackgroundColor(): string {
  return windowTheme.windowBackgroundColor()
}

function syncWindowBackgrounds(): void {
  return windowTheme.syncWindowBackgrounds()
}

function onRendererTheme(event: Electron.IpcMainEvent, payload: unknown): void {
  return windowTheme.onRendererTheme(event, payload)
}

/** Create the client window immediately; the official Web UI replaces its loading surface when ready. */
function createWindow(): void {
  mainWindow = createMainWindow()
}

function onMainWindowClosed(): void { mainWindow = null; loadingDocumentActive = false; errorDocumentActive = false }
function markMainWindowUnrequested(): void { mainWindowRequested = false }
function resetSettingsIntegrationStatus(): void { settingsIntegrationStatus = { state: 'absent' }; reportedSettingsIntegrationFailures.clear() }
function markWebUiLoaded(): void { webUiEverLoaded = true }
function markLoadingDocument(): void { loadingDocumentActive = true; errorDocumentActive = false }
function createMainWindow(): BrowserWindow {
  return mainWindowFactory.createMainWindow()
}


/**
 * Navigate the existing loading/client window to one official Web UI origin.
 * `force` marks a reconnect the user explicitly asked for: startup resolves to
 * the origin already on screen all the time and must not reload it, but
 * "保存并连接" resolving to the same origin has to rebuild the session anyway —
 * doing nothing leaves the card's "正在重连…" note true forever.
 */
function loadMainWindow(url: string, force = false): void {
  if (mainWindow === null) createWindow()
  if (mainWindow === null) return
  if (appOrigin(mainWindow.webContents.getURL()) === appOrigin(url)) {
    if (!force) return
    mainWindow.webContents.reload()
    return
  }
  loadingDocumentActive = false
  errorDocumentActive = false
  void mainWindow.loadURL(url).catch(() => { /* did-fail-load owns user recovery */ })
}

/** The small connection-settings window (menu → "Web UI 连接…"). */
function openSettingsWindow(): void {
  if (settingsWindow !== null) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 720,
    title: localeChinese() ? 'DSH Desktop 设置' : 'DSH Desktop settings',
    // Without this the window keeps Electron's own default icon in its title
    // bar and taskbar entry — the one place the client still looked like a
    // generic Electron app.
    icon: WINDOW_ICON_PNG,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindowFactory.installPageContextMenu(settingsWindow.webContents)
  settingsWindow.on('closed', () => { settingsWindow = null })
  // The page carries links now — the ones inside rendered release notes — and
  // they must leave for the system browser rather than do nothing at all. The
  // window itself still never navigates anywhere (see will-navigate below).
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  settingsWindow.webContents.on('will-navigate', (event, targetUrl) => {
    // Compare parsed origin + path prefix rather than the raw string: a prefix
    // test on the whole URL is decided by spelling (`...token/x` vs a
    // credential-prefixed lookalike), not by where the request actually goes.
    const allowed = new URL(settingsServer.url)
    try {
      const target = new URL(targetUrl)
      if (target.origin === allowed.origin && target.pathname.startsWith(allowed.pathname)) return
    } catch { /* unparseable: deny below */ }
    event.preventDefault()
  })
  void settingsWindow.loadURL(settingsServer.url)
}

/**
 * The tray (menu-bar) seat: closing the window keeps the client running.
 * macOS and Windows agree on the gesture — left-click reopens the window,
 * right-click shows the menu. Only the way the menu is attached differs, and
 * Linux (AppIndicator) delivers no click event at all, so there the menu is
 * the whole interaction.
 */
function createTray(): void {
  // macOS recolours a Template image to match the menu bar automatically.
  // Windows renders the source pixels as-is, so the glyph colour is chosen
  // here — see windowsTaskbarPrefersDark for why nativeTheme cannot answer it.
  const icon = trayImage()
  if (icon.isEmpty()) return
  tray = new Tray(icon)
  tray.setToolTip('DSH Desktop')
  // Windows emits this too, and used to have nobody listening: a left-click on
  // the notification-area icon did nothing at all, and the window could only be
  // reached through the right-click menu. A double-click emits two clicks plus
  // this event, and showMainWindow is idempotent, so both gestures are safe.
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  if (process.platform === 'darwin') {
    tray.on('right-click', () => { tray?.popUpContextMenu(Menu.buildFromTemplate(trayMenuTemplate())) })
  }
  // Moving the window to a display with different scaling, or changing the
  // scaling itself, changes the notification-area slot size. Without this the
  // icon rendered for the old slot stays and gets stretched by the shell.
  if (process.platform === 'win32') screen.on('display-metrics-changed', refreshTrayImage)
  refreshTrayMenu()
}

/** Re-pick the tray glyph for the current taskbar brightness and display scale. */
function refreshTrayImage(): void {
  if (tray === null || tray.isDestroyed()) return
  const next = trayImage()
  if (!next.isEmpty()) tray.setImage(next)
}

/** Windows broadcasts this to every top-level window when a shell-wide setting changes. */
const WM_SETTINGCHANGE = 0x001a
/** Collapses the burst of messages one settings change produces. */
let taskbarThemeProbe: NodeJS.Timeout | null = null

/**
 * The taskbar's colour mode has no Electron event, so listen for the broadcast.
 *
 * `nativeTheme`'s 'updated' does not fire for it at all — Chromium tracks the
 * APP mode — which is what left a white glyph seated on a taskbar the user had
 * just turned light, the one combination where it is invisible. Every
 * shell-wide change instead reaches each top-level window as WM_SETTINGCHANGE,
 * hidden ones included, so the client's own window still hears it while the
 * client sits in the tray. The message says nothing usable about what changed
 * and arrives for far more than colour, hence the debounced re-read: it costs
 * one registry query and can only ever swap an icon.
 */
function watchTaskbarTheme(window: BrowserWindow): void {
  if (process.platform !== 'win32') return
  window.hookWindowMessage(WM_SETTINGCHANGE, () => {
    if (taskbarThemeProbe !== null) return
    taskbarThemeProbe = setTimeout(() => {
      taskbarThemeProbe = null
      taskbarPrefersDark = undefined
      refreshTrayImage()
    }, 150)
    taskbarThemeProbe.unref()
  })
}

/**
 * Windows notification-area icon sizes, in device pixels: the slot is
 * SM_CXSMICON, which is 16 at 100% scaling and grows with it (20 at 125%,
 * 24 at 150%, 32 at 200%). One rendered file per slot, so the shell has an
 * exact-size icon to draw instead of a stretched 16px one — Windows takes the
 * 1x representation of a NativeImage and scales it up, which is what made the
 * tray icon look soft on every display above 100%.
 *
 * Rendered from resources/icon.svg by scripts/make-tray-icons.cjs; that list
 * and this one have to stay in step.
 */
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48] as const

/** The rendered size for the current display scale, snapped up to a real file. */
function trayIconSize(): number {
  let scale = 1
  try {
    scale = screen.getPrimaryDisplay().scaleFactor
  } catch {
    // Called before the screen module is usable: 16px is the 100% slot.
  }
  const wanted = Math.round(16 * (Number.isFinite(scale) && scale > 0 ? scale : 1))
  // Above the largest rendered size (400% scaling and beyond), the biggest file
  // is still the closest fit the shell can be given.
  return TRAY_ICON_SIZES.find(size => size >= wanted) ?? 48
}

/** Where the Windows shell keeps the two colour-mode switches. */
const WINDOWS_PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/** Cached reading; cleared when the OS announces a theme change. */
let taskbarPrefersDark: boolean | undefined

/**
 * Whether the notification area is dark, i.e. whether the white glyph reads.
 *
 * 设置 › 个性化 › 颜色 carries TWO switches — "Windows mode" (the taskbar) and
 * "app mode" (window chrome) — and a user may set them differently. Only the
 * first one paints the surface a tray icon sits on, and nativeTheme reports the
 * second: `shouldUseDarkColors` follows the app mode, and this process
 * overwrites it outright via `themeSource` whenever the Web UI pins an
 * appearance (see syncThemeSource). Reading SystemUsesLightTheme is asking the
 * same value the shell itself draws from, so it stays right in both the mixed
 * configuration and the pinned one.
 *
 * A missing value means an older Windows with no separate system mode, where
 * the taskbar is dark; every failure path lands on the same default, which is
 * the icon the client shipped before this choice existed.
 */
function windowsTaskbarPrefersDark(): boolean {
  if (taskbarPrefersDark !== undefined) return taskbarPrefersDark
  let dark = true
  try {
    const query = spawnSync('reg', ['query', WINDOWS_PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'], {
      encoding: 'utf8',
      timeout: 4_000,
      ...SPAWN_NO_WINDOW,
    })
    const value = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(query.stdout ?? '')?.[1]
    if (value !== undefined) dark = Number.parseInt(value, 16) === 0
  } catch {
    // reg.exe unavailable or blocked: keep the dark-taskbar default.
  }
  taskbarPrefersDark = dark
  return dark
}

function trayImage(): Electron.NativeImage {
  if (process.platform !== 'win32') {
    // macOS recolours a Template image to match the menu bar, and reads the @2x
    // companion beside it for Retina; nothing to choose per display here.
    return nativeImage.createFromPath(join(APP_DIR, 'resources', 'iconMenuTemplate.png'))
  }
  const size = trayIconSize()
  const prefix = windowsTaskbarPrefersDark() ? 'iconTray-' : 'iconTrayDark-'
  const exact = nativeImage.createFromPath(join(APP_DIR, 'resources', prefix + String(size) + '.png'))
  if (!exact.isEmpty()) return exact
  // A resource set older than this code: the 16px glyph still shows an icon.
  return nativeImage.createFromPath(join(APP_DIR, 'resources', 'iconTrayWhite.png'))
}

/** Shared by the trusted native settings page and the origin-checked IPC bridge. */
async function setBundledMarketEnabled(enabled: unknown, remoteCaller: boolean): Promise<{ enabled: boolean }> {
  if (typeof enabled !== 'boolean') return { enabled: loadSettings().bundledMarketDisabled !== true }
  // A state change asked for by a REMOTE origin gets the same native
  // confirmation an address change does. Turning the seat off deletes a
  // directory inside the user's own `~/.dsh`; a page served from
  // somewhere else must not be able to do that quietly just because the
  // window happens to be pointed at it.
  if (remoteCaller) {
    const confirmed = await confirmSensitiveAction(
      enabled ? '接入内置安全市场？' : '移除内置安全市场？',
      enabled
        ? '当前页面来自远端来源，它请求让本客户端在下次启动时接入内置安全市场。'
        : '当前页面来自远端来源，它请求移除内置安全市场：本机 profile 中的插件条目与复制的插件目录都会被删除。',
    )
    if (!confirmed) return { enabled: loadSettings().bundledMarketDisabled !== true }
  }
  patchSettings({ bundledMarketDisabled: !enabled })
  if (!enabled) {
    // Do it now rather than at the next spawn: the user just asked for it
    // to be gone, and a profile that still lists it until the next start
    // is the same "it will not go away" the durable flag exists to avoid.
    if (abandonBundledPlugin(childHome())) {
      console.log('[desktop] bundled plugin removed: turned off in connection settings')
    }
    bundledPluginSeatInUse = false
  }
  return { enabled }
}

const nativeMenuActions = {
  openSettings: openSettingsWindow,
  showWindow: showMainWindow,
  checkUpdates: () => { void handleManualUpdateCheck(true) },
  restart: restartApp,
  quit: () => { app.quit() },
}

function trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return buildTrayMenu({ chinese: localeChinese(), state: desktopUpdater?.getState(), actions: nativeMenuActions })
}

/**
 * Restart the whole client. A plugin that only takes effect on a fresh runtime
 * needs the harness replaced, not the page reloaded, and this is the one
 * gesture that does both without the user hunting for the app again.
 *
 * `relaunch` hands the successor to Electron's relauncher helper, which waits
 * for this process to exit before spawning — so `before-quit` still runs the
 * stop ladder, and the single-instance lock is free by the time the new
 * instance asks for it.
 *
 * Refused during the Windows installer handoff: `isInstallerHandoff()` is set
 * seconds before that quit lands, and a successor started into a half-written
 * installation is exactly the damage no relaunch can repair.
 */
function restartApp(): void {
  if (quitting || restarting || isInstallerHandoff()) return
  restarting = true
  // Integration checks need to observe the persisted handoff without leaving
  // an unattached successor process behind. Packaged builds ignore this flag.
  if (devFlag('DSH_DESKTOP_SKIP_RELAUNCH')) {
    app.quit()
    return
  }
  app.relaunch()
  app.quit()
}
function compatibilityFallbackPlugins(settings: ClientSettings): string[] {
  return pluginRecovery.compatibilityFallbackPlugins(settings)
}

function schedulePluginCompatibilityFallback(code: number | null, signal: NodeJS.Signals | null): boolean {
  return pluginRecovery.schedulePluginCompatibilityFallback(code, signal)
}

function promptPluginCompatibilityFallback(): void {
  return pluginRecovery.promptPluginCompatibilityFallback()
}


function refreshTrayMenu(): void {
  if (tray === null) return
  const state = desktopUpdater?.getState()
  const tip = state?.phase === 'available' && state.info !== null && !state.dismissed
    ? 'DSH Desktop · v' + state.info.availableVersion
    : 'DSH Desktop'
  tray.setToolTip(tip)
  const menu = Menu.buildFromTemplate(trayMenuTemplate())
  if (process.platform === 'darwin') return
  tray.setContextMenu(menu)
}

/**
 * The connection facts shared by the settings server and the IPC bridge.
 * `includeLocalDetail` is false for a remote page: the child's pid and the
 * runtime's last error (which carries local paths) describe this machine, and
 * a configured remote origin has no business reading them.
 */
let settingsIntegrationStatus: SettingsIntegrationStatus = { state: 'absent' }
const reportedSettingsIntegrationFailures = new Set<string>()

function getStatusJson(includeLocalDetail = true): Record<string, unknown> {
  const settings = loadSettings()
  const savedServerUrl = normalizeServerUrl(settings.serverUrl)
  const selectedInstalled = selectedInstalledDsh()
  return {
    mode: connection.probeConnected ? 'probe' : connection.configuredTarget !== undefined ? 'connect' : 'local',
    targetUrl: currentTarget() ?? '',
    desktopVersion: desktopClientVersion(),
    settingsIntegration: settingsIntegrationStatus,
    bundledMarketEnabled: settings.bundledMarketDisabled !== true,
    dshVersion: bundledDshVersion(),
    // NOT gated by includeLocalDetail: in Connect mode the saved address IS
    // the caller's own origin (targetUrl is not redacted either), so hiding
    // it yields no privacy — while the connection card treats this field as
    // the editable address and probes to fill it when empty, so an empty
    // value breaks the card and can be overwritten by a probe offer.
    savedServerUrl: savedServerUrl ?? '',
    selectedMode: usesConfiguredServer(settings) ? 'connect' : 'smart',
    canSwitch: savedServerUrl !== undefined,
    smartRuntimes: enabledSmartRuntimes(),
    localWebPort: configuredLocalWebPort(),
    dshDataMode: activeDshDataMode ?? selectedDshDataMode(settings),
    dshDataModeSelectable: dshDataModeSelectable(),
    dshDataFallbackReason: settings.dshDataFallbackReason,
    dshDataFallbackPlugin: normalizePluginPackageName(settings.dshDataFallbackPlugin),
    dshDataFallbackPlugins: compatibilityFallbackPlugins(settings),
    ...includeLocalDetail && { dshDataHome: childHome() },
    ...includeLocalDetail && webUi?.pid() !== undefined && { childPid: webUi.pid() },
    ...includeLocalDetail && webUi?.lastError !== null && webUi?.lastError !== undefined && { lastError: webUi.lastError },
    // Which dsh the local child came from. Names a path on this machine, so it
    // travels under the same rule as the pid and the runtime error.
    ...includeLocalDetail && webUi?.lastSource !== undefined && { runtimeSource: webUi.lastSource },
    ...includeLocalDetail && selectedInstalled !== undefined
      && { installedDshVersion: selectedInstalled.version },
    // A cache lagging the bundled runtime is a note, not a veto: the cache
    // stays selected, and re-running npx is how the user updates it.
    ...includeLocalDetail && selectedInstalled?.source === 'npx' && runtimeCatalog.npxCacheOutdated
      && { npxCacheOutdated: true },
  }
}

/**
 * Whether an official Web UI is answering on the default port right now. The
 * connection surfaces offer the result as a ready-made address, so switching
 * to an instance the user just started is one click instead of typing it.
 */
async function probeDefaultWebUi(): Promise<{ url: string | null }> {
  const result = await inspectWebUi(defaultWebProbeUrl())
  return { url: result.kind === 'verified' ? result.url : null }
}
function bridgeCaller(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BridgeCaller {
  return bridgePolicy.bridgeCaller(event)
}

function rememberSmartBridgeHandoff(): void {
  return bridgePolicy.rememberSmartBridgeHandoff()
}

function releaseSmartBridgeHandoff(loadedUrl: string): void {
  return bridgePolicy.releaseSmartBridgeHandoff(loadedUrl)
}

function bridgeDenied(): Error {
  return bridgePolicy.bridgeDenied()
}

function localDocumentCaller(event: Electron.IpcMainEvent): boolean {
  return bridgePolicy.localDocumentCaller(event)
}


/** Replace the current page with the local startup surface before recovery. */
function showLoadingDocument(): void {
  const window = mainWindow
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
  loadingDocumentActive = true
  errorDocumentActive = false
  resetPageAppearance()
  void window.loadURL(loadingPageUrl()).catch(() => {})
  scheduleLoadingHints()
}

let cachedDesktopVersion: string | undefined

/** The desktop shell version is independent from Electron and dsh versions. */
function desktopClientVersion(): string {
  if (cachedDesktopVersion !== undefined) return cachedDesktopVersion
  try {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { version?: unknown }
    cachedDesktopVersion = typeof manifest.version === 'string' ? manifest.version : app.getVersion()
  } catch {
    cachedDesktopVersion = app.getVersion()
  }
  return cachedDesktopVersion
}

let cachedBundledDshVersion: string | null | undefined

/** Version of the official runtime shipped with this desktop release. */
function bundledDshVersion(): string | null {
  if (cachedBundledDshVersion !== undefined) return cachedBundledDshVersion
  const bin = resolveBundledDsh()?.binPath
  if (bin === undefined) return (cachedBundledDshVersion = null)
  cachedBundledDshVersion = officialDshPackageVersion(bin) ?? null
  return cachedBundledDshVersion
}
function createDesktopUpdater(): DesktopUpdater {
  return updateController.createDesktopUpdater()
}

function updateStateForCaller(state: UpdateState, remote: boolean): UpdateState {
  return updateController.updateStateForCaller(state, remote)
}

function mainWindowShowsRemote(): boolean {
  return bridgePolicy.mainWindowShowsRemote()
}

function permissionTrustedSurface(contents: Electron.WebContents | null): boolean {
  return bridgePolicy.permissionTrustedSurface(contents)
}

function permissionGranted(contents: Electron.WebContents | null, permission: string, requestingUrl: string, isMainFrame: boolean): boolean {
  return bridgePolicy.permissionGranted(contents, permission, requestingUrl, isMainFrame)
}
function broadcastUpdateState(state: UpdateState): void {
  return updateController.broadcastUpdateState(state)
}


function showMainWindow(): void {
  if (mainWindow === null) {
    launchWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
function localeChinese(): boolean {
  return localeController.localeChinese()
}

function watchLocalePreference(): void {
  return localeController.watchLocalePreference()
}

/**
 * A native confirmation for an action a page asked for. Native on purpose: the
 * requesting document can neither draw this over its own UI, nor dismiss it,
 * nor pre-click it.
 */
async function confirmSensitiveAction(message: string, detail: string): Promise<boolean> {
  const chinese = localeChinese()
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'DSH Desktop',
    message,
    detail,
    buttons: [chinese ? '取消' : 'Cancel', chinese ? '继续' : 'Continue'],
    defaultId: 0,
    cancelId: 0,
  }
  const owner = mainWindow
  const { response } = owner === null || owner.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(owner, options)
  return response === 1
}
let clientNoticeWindow: BrowserWindow | null = null

function handleManualUpdateCheck(prompt: boolean): Promise<void> {
  return updateController.handleManualUpdateCheck(prompt)
}

function scheduleQuitAfterWindowsInstall(): void {
  return updateController.scheduleQuitAfterWindowsInstall()
}

function installDesktopUpdate(): Promise<{ started: boolean; error?: string; }> {
  return updateController.installDesktopUpdate()
}

function scheduleLegacyBundleNotice(): void {
  return updateController.scheduleLegacyBundleNotice()
}

/** Whether the official Web UI has loaded at least once (re-arms the auto check). */
let webUiEverLoaded = false
function scheduleAutoUpdateCheck(): void {
  return updateController.scheduleAutoUpdateCheck()
}

function schedulePeriodicAutoUpdateChecks(): void {
  return updateController.schedulePeriodicAutoUpdateChecks()
}

function updateStateForPage(state: UpdateState): UpdateState & { notesHtml: string; } {
  return updateController.updateStateForPage(state)
}


function pageUpdateState(): (UpdateState & { notesHtml: string; }) | undefined {
  return updateController.pageUpdateState()
}


/**
 * Behavior for the loopback connection-settings page, served under the same
 * origin. Built per request rather than kept in a const: the page follows the
 * client locale, which is not known at module load and can change while the
 * client runs (the Web UI's own language switch). `settings.js` is served
 * no-cache, so a reopened page picks the new language up.
 *
 * `t()` emits a complete JS string literal, quotes included, so a translated
 * value sits exactly where the Chinese literal used to.
 */
function settingsPageScript(): string {
  return renderSettingsPageScript(localeChinese())
}

/**
 * The connection-settings page, styled to match the loading page aesthetic.
 * Bilingual on the same rule as the failure page and the update prompt: this
 * is the client's own surface, and it is the one an English-locale user is
 * sent to when a connection needs fixing.
 */
function settingsPageHtml(): string {
  return renderSettingsPageHtml(localeChinese(), loadingIconTag())
}

/**
 * A one-button notice in the same visual language as connection settings and
 * the update prompt. Native message boxes stay reserved for confirmations a
 * remote page must not be able to draw or dismiss.
 */
function clientNoticePageUrl(copy: {
  heading: string
  hint: string
  addressLabel: string
  address: string
  action: string
}): string {
  return renderClientNoticePageUrl(copy, localeChinese(), loadingIconTag())
}

function showClientNotice(copy: {
  heading: string
  hint: string
  addressLabel: string
  address: string
  action: string
}): void {
  const pageUrl = clientNoticePageUrl(copy)
  if (clientNoticeWindow !== null && !clientNoticeWindow.isDestroyed()) {
    void clientNoticeWindow.loadURL(pageUrl).catch(() => { clientNoticeWindow?.close() })
    clientNoticeWindow.focus()
    return
  }
  const owner = settingsWindow !== null && !settingsWindow.isDestroyed()
    ? settingsWindow
    : (mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null)
  const notice = new BrowserWindow({
    width: 440,
    height: 320,
    minWidth: 400,
    minHeight: 240,
    maxWidth: 520,
    title: localeChinese() ? '连接' : 'Connection',
    icon: WINDOW_ICON_PNG,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackgroundColor(),
    show: false,
    ...(owner !== null ? { parent: owner, modal: true } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  clientNoticeWindow = notice
  const fitToContent = (): void => {
    const measure = mainContentHeightScript(300)
    void notice.webContents.executeJavaScript(measure, true)
      .then((height: unknown) => {
        if (notice.isDestroyed() || typeof height !== 'number') return
        const width = notice.getContentSize()[0] ?? 440
        notice.setContentSize(width, Math.max(240, Math.min(420, height)))
      })
      .catch(() => {})
      .finally(() => { if (!notice.isDestroyed()) notice.show() })
  }
  notice.webContents.on('did-finish-load', fitToContent)
  notice.on('closed', () => { if (clientNoticeWindow === notice) clientNoticeWindow = null })
  notice.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') notice.close()
  })
  const dismiss = (targetUrl: string): boolean => {
    if (!targetUrl.startsWith('dsh-notice-action:')) return false
    notice.close()
    return true
  }
  notice.webContents.setWindowOpenHandler(({ url }) => {
    dismiss(url)
    return { action: 'deny' }
  })
  notice.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('data:')) return
    event.preventDefault()
    dismiss(targetUrl)
  })
  void notice.loadURL(pageUrl).catch(() => { notice.close() })
}

/**
 * Warn before a settings change that would only land on the occupancy
 * surface: this client never terminates the user's process.
 */
function warnOccupiedUserInstance(url: string): void {
  const chinese = localeChinese()
  showClientNotice({
    heading: chinese ? '请先退出本机官方实例' : 'Quit the running instance first',
    hint: chinese
      ? '现在排除来源或切到智能模式后，客户端不会再连接这个实例，也不能在它占用会话数据时另起一份。请先在启动它的终端里退出（Ctrl+C），然后再试。客户端不能替你结束这个进程。'
      : 'Changing sources or switching to Smart mode would disconnect from this instance, and this client cannot start another runtime while it occupies the session data. Quit it in the terminal that started it (Ctrl+C), then try again. This client will not terminate that process.',
    addressLabel: chinese ? '地址' : 'Address',
    address: url,
    action: chinese ? '知道了' : 'OK',
  })
}

function pinnedPortAddress(port: number): string {
  return 'http://127.0.0.1:' + String(port)
}

/** A pinned bind that something else already holds — not a dsh we could reuse. */
function warnPinnedPortHeld(port: number): void {
  const chinese = localeChinese()
  showClientNotice({
    heading: chinese ? '该端口已被占用' : 'That port is already in use',
    hint: chinese
      ? '固定端口被占用时客户端不会换口。请关掉占用方，或改用其他端口 / 自动端口。'
      : 'This client will not pick another port when the one you pinned is taken. Free it, or choose a different port or automatic mode.',
    addressLabel: chinese ? '端口' : 'Port',
    address: pinnedPortAddress(port),
    action: chinese ? '知道了' : 'OK',
  })
}

function showPinnedPortStartupFailure(port: number): void {
  const chinese = localeChinese()
  showConnectionError({
    kind: 'runtime',
    headline: chinese ? '该端口已被占用' : 'That port is already in use',
    detail: chinese
      ? '已固定为 ' + String(port) + '，被占用时不会换口。请关掉占用方，或在连接设置里改用其他端口 / 自动端口。'
      : 'Pinned to ' + String(port) + ', and this client will not pick another port. Free it, or choose a different port or automatic mode in Connection settings.',
  })
}

async function refuseOccupiedLocalSpawn(
  ids: readonly SmartRuntimeId[],
  extraPorts: readonly number[] = [],
): Promise<string | undefined> {
  const occupied = await instanceOccupyingLocalSpawn(ids, extraPorts)
  if (occupied === undefined) return undefined
  warnOccupiedUserInstance(occupied)
  return occupied
}
function persistSmartRuntimes(ids: SmartRuntimeId[]): Promise<{ saved: boolean; smartRuntimes: SmartRuntimeId[]; error?: string; }> {
  return settingsCommands.persistSmartRuntimes(ids)
}

function requestSmartRuntimesSave(value: unknown): Promise<{ saved: boolean; smartRuntimes: SmartRuntimeId[]; error?: string; }> {
  return settingsCommands.requestSmartRuntimesSave(value)
}

function requestLocalWebPortSave(value: unknown, remoteCaller: boolean): Promise<{ saved: boolean; localWebPort: number; applied?: boolean; error?: string; }> {
  return settingsCommands.requestLocalWebPortSave(value, remoteCaller)
}

function requestDshDataModeSave(value: unknown): { saved: boolean; dshDataMode: DshDataMode; applied?: boolean; error?: string; } {
  return settingsCommands.requestDshDataModeSave(value)
}

function requestServerUrlSave(serverUrl: unknown, remoteCaller: boolean): Promise<{ saved: boolean; mode?: "smart" | "connect"; error?: string; }> {
  return settingsCommands.requestServerUrlSave(serverUrl, remoteCaller)
}

function switchConnectionMode(): Promise<{ switched: boolean; mode?: "smart" | "connect"; error?: string; }> {
  return settingsCommands.switchConnectionMode()
}


/** Open the window at the CURRENT target, waiting for local readiness if needed. */
function launchWindow(generation = connection.generation, force = false): void {
  if (generation !== connection.generation || quitting) return
  mainWindowRequested = true
  if (mainWindow === null) createWindow()
  // A failure that arrived while the window was closed owns this window: it is
  // the real explanation, and its seats (retry, settings, quit) are live. A
  // failure from a superseded attempt is stale — drop it and connect.
  const held = pendingConnectionFailure
  pendingConnectionFailure = undefined
  if (held !== undefined && held.generation === generation) {
    showConnectionError(held.failure)
    return
  }
  if (connection.configuredTarget !== undefined) {
    updateLoadingStatus('正在连接 Web UI…', 'Connecting to the Web UI…')
    loadMainWindow(connection.configuredTarget, force)
    return
  }
  updateLoadingStatus('正在启动本地 dsh 服务…', 'Starting the local dsh service…')
  void connection.readyForConnection(generation).then((url) => {
    if (url === undefined || generation !== connection.generation || quitting) return
    if (!mainWindowRequested) return
    if (connection.configuredTarget === undefined) loadMainWindow(url, force)
  }, () => {
    // The first failure already took over this window through onExit — either
    // as the error surface, or held and rendered above. A repeat request (dock
    // activate, second instance) rejects without one, so the loading surface
    // must carry the state instead of spinning forever.
    if (generation !== connection.generation || quitting) return
    updateLoadingStatus('本地服务启动失败。可在下方设置 Web UI 连接。',
      'The local service failed to start. Set the Web UI connection below.', 'failed')
  })
}

/**
 * The application menu carries standard roles and an independent desktop
 * settings entry.
 * macOS keeps it: the system draws that menu bar outside the window, and its
 * roles carry the standard edit accelerators. Windows/Linux would paint the
 * bar inside the frame above the Web UI's own chrome, so the menu is dropped
 * there entirely — Chromium keeps the editing accelerators on its own.
 *
 * Every item states its own label. A `role` alone takes Electron's built-in
 * label, and those are English literals that no locale changes — which is
 * what produced a bar reading "About … / 检查更新… / Hide …". The roles are
 * still what gives each item its behaviour and standard accelerator; only the
 * text is ours, in the language `localeChinese` reports, using the wording
 * macOS itself uses for these items. Rebuilt on a language switch by
 * `watchLocalePreference`.
 */
function installMenu(): void {
  Menu.setApplicationMenu(process.platform !== 'darwin' ? null : Menu.buildFromTemplate(buildApplicationMenu({
    chinese: localeChinese(), name: app.name, development: !app.isPackaged, actions: nativeMenuActions,
  })))
}

function showLocalRuntimeStartupFailure(code: number | null, signal: NodeJS.Signals | null): void {
  const chinese = localeChinese()
  const command = webUi?.lastCommand
  const version = command?.version ?? (command?.source === 'bundled' ? bundledDshVersion() ?? undefined : undefined)
  const source = command === undefined
    ? undefined
    : command.source + (version === undefined ? '' : ' · dsh ' + version)
  const diagnostic = sanitizeRuntimeOutput(webUi?.lastDiagnostic ?? webUi?.lastError ?? '')
  const exitStatus = [
    code === null ? undefined : (chinese ? '代码 ' : 'code ') + String(code),
    signal === null ? undefined : (chinese ? '信号 ' : 'signal ') + signal,
  ].filter((part): part is string => part !== undefined).join(chinese ? '、' : ', ')
  const detail = [
    source === undefined ? undefined : (chinese ? '运行时：' : 'Runtime: ') + source,
    command === undefined ? undefined : (chinese ? '启动目标：' : 'Launch target: ') + command.label,
    (chinese ? '退出状态：' : 'Exit status: ') + (exitStatus === '' ? (chinese ? '未知' : 'unknown') : exitStatus),
    diagnostic === ''
      ? undefined
      : (chinese ? '诊断输出：\n' : 'Diagnostic output:\n') + diagnostic,
  ].filter((line): line is string => line !== undefined).join('\n\n')
  showConnectionError({
    kind: 'runtime',
    headline: chinese ? '本地服务无法启动' : 'The local service could not start',
    detail,
  })
}

function boot(): void {
  const settings = loadSettings()
  installEmergencyRuntimeDisposal(() => webUi?.pid())
  webUi = new WebUiManager({
    home: childHome,
    resolveCommand: resolveDshCommand,
    prepareCommand(dsh) {
      applyBundledPluginSeat(dsh)
      const pnpm = bundledPnpmEntry()
      const version = dsh.version ?? (dsh.source === 'bundled' ? bundledDshVersion() ?? undefined : undefined)
      return {
        args: webSpawnArgs(localWebSpawnPort(), runtimeSupportsNoOpen(version)),
        env: {
          ...process.env,
          DSH_HOME: childHome(),
          PATH: childPath(),
          ...dsh.entry !== undefined && { DSH_DESKTOP_RUNTIME_ENTRY: dsh.entry },
          ...pnpm !== undefined && { [PNPM_ENTRY_VARIABLE]: pnpm },
          ...app.isPackaged && dsh.command === process.execPath && { ELECTRON_RUN_AS_NODE: '1' },
        },
      }
    },
    waitForReady: waitForWebUiReady,
    onLog: (line) => { console.log('[dsh web] ' + line) },
    onExit: connection.onExit,
  })

  applyConnectionSettings(settings)
}

const settingsCommands = createSettingsCommands({
  enabledSmartRuntimes,
  loadSettings,
  refuseOccupiedLocalSpawn,
  localeChinese,
  resetRuntimeFailure: () => { runtimeCatalog.resetRejectedSources(); webUi?.clearFatalError() },
  patchSettings,
  applySmartLocalRuntimeChange,
  configuredLocalWebPort,
  pinnedPortAddress,
  isOwnManagedOrigin,
  warnPinnedPortHeld,
  confirmSensitiveAction,
  currentTarget,
  getActiveDshDataMode: () => activeDshDataMode,
  selectedDshDataMode,
  dshDataModeSelectable,
  restartApp,
  defaultWebProbeUrl,
  applyConnectionSettings,
})

const pluginRecovery = createPluginRecoveryController({
  bundledPnpmEntry,
  childHome,
  childPath,
  spawnOptions: () => SPAWN_NO_WINDOW,
  dshDataModeSelectable,
  loadSettings,
  selectedDshDataMode,
  getWebUi: () => webUi,
  showLoadingDocument,
  updateLoadingStatus,
  localeChinese,
  getMainWindow: () => mainWindow,
  windowIcon: () => WINDOW_ICON_PNG,
  windowBackgroundColor,
  showLocalRuntimeStartupFailure,
  patchSettings,
  restartApp,
  openSettingsWindow,
})

const localeController = createLocaleController({
  childHome,
  installMenu,
  refreshTrayMenu,
})

function useSmartFromLocalDocument(): void {
  patchSettings({ connectionMode: 'smart' })
  errorDocumentActive = false
  showLoadingDocument()
  applyConnectionSettings(loadSettings(), true)
}
function registerDesktopIpc(): void {
  return desktopIpc.registerDesktopIpc()
}


const desktopIpc = createDesktopIpc({
  bridgeCaller,
  bridgeDenied,
  getStatusJson,
  loadSettings,
  setBundledMarketEnabled,
  enabledSmartRuntimes,
  localeChinese,
  confirmSensitiveAction,
  currentTarget,
  persistSmartRuntimes,
  requestLocalWebPortSave,
  selectedDshDataMode,
  requestDshDataModeSave,
  probeDefaultWebUi,
  requestServerUrlSave,
  switchConnectionMode,
  openSettingsWindow,
  localDocumentCaller,
  retryConnection,
  useSmartFromLocalDocument,
  getDesktopUpdater: () => desktopUpdater,
  updateStateForCaller,
  installDesktopUpdate,
  scheduleQuitAfterWindowsInstall,
})

const bridgePolicy = createBridgePolicy({
  getMainWindow: () => mainWindow,
  getLoadingDocumentActive: () => loadingDocumentActive,
  getErrorDocumentActive: () => errorDocumentActive,
  currentTarget,
})
function getUpdatePromptWindow(): BrowserWindow | null {
  return updateController.getUpdatePromptWindow()
}

function isInstallerHandoff(): boolean {
  return updateController.isInstallerHandoff()
}


const updateController = createUpdateController({
  loadSettings,
  patchSettings,
  desktopClientVersion,
  clientHome,
  getMainWindow: () => mainWindow,
  mainWindowShowsRemote,
  refreshTrayMenu,
  localeChinese,
  loadingIconTag,
  windowIcon: () => WINDOW_ICON_PNG,
  windowBackgroundColor,
  getDesktopUpdater: () => desktopUpdater,
  openExternal,
  launchWindow,
  getQuitting: () => quitting,
  getWebUiEverLoaded: () => webUiEverLoaded,
  getWebUi: () => webUi,
})
function resetPageAppearance(): void {
  return windowTheme.resetPageAppearance()
}


const windowTheme = createWindowTheme({
  getMainWindow: () => mainWindow,
  getSettingsWindow: () => settingsWindow,
  getUpdatePromptWindow,
  getClientNoticeWindow: () => clientNoticeWindow,
  bridgeCaller,
})

const windowHealth = createWindowHealth({
  getMainWindow: () => mainWindow,
  currentTarget,
  getQuitting: () => quitting,
  getConnection: () => connection,
  probeWithGrace,
  refuseUnauthenticatedProbeTarget,
  fallbackFromProbedInstance,
  probeWebUi,
})

const mainWindowFactory = createMainWindowFactory({
  localeChinese,
  openExternal,
  windowBackgroundColor,
  windowIcon: () => WINDOW_ICON_PNG,
  watchTaskbarTheme,
  scheduleWindowHealthCheck,
  clearMacNotificationAttention,
  getQuitting: () => quitting,
  isInstallerHandoff,
  onMainWindowClosed,
  markMainWindowUnrequested,
  getLoadingDocumentActive: () => loadingDocumentActive,
  getErrorDocumentActive: () => errorDocumentActive,
  currentTarget,
  getConnection: () => connection,
  resetSettingsIntegrationStatus,
  settingsServerReady: () => settingsServer.port !== 0,
  openSettingsWindow,
  handleProbedInstanceFailure,
  showConnectionError,
  releaseSmartBridgeHandoff,
  bindErrorPageSeats,
  markWebUiLoaded,
  scheduleAutoUpdateCheck,
  recoverBlankWindow,
  markLoadingDocument,
  resetPageAppearance,
  loadingPageUrl,
  scheduleLoadingHints,
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) {
      launchWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // Every webContents, including any the runtime or a dependency creates
  // later, inherits the same rule: nothing opens a second window, http(s)
  // links leave for the system browser, everything else is dropped.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
  })

  void app.whenReady().then(async () => {
    // The old generic name is easy for an unrelated third-party client to
    // choose too. Move it only for a normal packaged launch, only after this
    // process owns the single-instance lock, and only when the branded home
    // has never been created. Development overrides remain exact fixtures.
    if (app.isPackaged && devOverride('DSH_DESKTOP_HOME') === undefined) {
      try {
        const migrated = migrateLegacyClientHome(join(homedir(), '.dsh-desktop'), clientHome())
        if (migrated !== 'not-needed') {
          console.log('[desktop] client data home ' + (migrated === 'moved' ? 'moved' : 'copied')
            + ' to ' + clientHome())
        }
      } catch (error) {
        console.warn('[desktop] client data home migration failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
    }
    // Freeze this process on one DSH_HOME. A setting change is persisted for
    // the successor, while the old runtime's shutdown still clears the lock
    // and plugin seat belonging to the home it actually used.
    activeDshDataMode = selectedDshDataMode()
    activeDshHome = devOverride('DSH_HOME')
      ?? dshHomeForMode(activeDshDataMode, homedir(), clientHome())
    app.setName('DSH Desktop')
    // Installed Windows notifications must match electron-builder's shortcut
    // identity. Development has no such shortcut, so use Electron's documented
    // process.execPath identity (the Electron executable may still need to be
    // pinned to Start for Windows to register its toast activator).
    if (process.platform === 'win32') {
      app.setAppUserModelId(windowsAppUserModelId(app.isPackaged, process.execPath))
    }
    // Electron grants most permission requests when an app installs no
    // handler. Grant the trusted loopback UI the ordinary desktop capabilities
    // its plugins use, keep a custom remote origin narrower, and deny unrelated
    // frames and device APIs. Both handlers are required: many Web APIs check
    // first and request only after that check is denied.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(permissionGranted(contents, permission, details.requestingUrl, details.isMainFrame))
    })
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => permissionGranted(
      contents,
      permission,
      details.requestingUrl ?? requestingOrigin,
      details.isMainFrame,
    ))
    session.defaultSession.setDevicePermissionHandler(() => false)
    // Downloads otherwise land in ~/Downloads silently. Only the client's own
    // active target may trigger one; anything else — a stray frame, an
    // adopted impostor — is denied rather than allowed to fill the disk or
    // drop files for the user to click.
    session.defaultSession.on('will-download', (event, item, webContents) => {
      if (permissionTrustedSurface(webContents)) return
      event.preventDefault()
      void item.cancel()
    })
    // Packaged macOS builds use the bundle icon. Do not replace it at runtime
    // with the pre-masked PNG: macOS 26 adds its own enclosure around that
    // image and produces a visible double border. An unpackaged run has no
    // bundle icon at all, so there the PNG is still better than Electron's
    // default dock tile.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const dockIcon = nativeImage.createFromPath(ICON_PNG)
      if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon)
    }
    // Paint immediately. Runtime probing/boot continues behind this one window
    // and replaces the loading document with the official Web UI when ready.
    nativeTheme.on('updated', syncWindowBackgrounds)
    ipcMain.on('desktop:theme', onRendererTheme)
    ipcMain.on('desktop:settings-integration', (event, payload: unknown) => {
      if (!bridgeCaller(event).trusted) return
      const status = parseSettingsIntegrationStatus(payload)
      if (status === undefined) return
      settingsIntegrationStatus = status
      if (status.state === 'unsupported' && !reportedSettingsIntegrationFailures.has(status.reason)) {
        reportedSettingsIntegrationFailures.add(status.reason)
        console.warn('[desktop] settings integration unavailable:', status.reason,
          '— Desktop settings remains available from the native menu or tray.')
      }
    })
    ipcMain.on('desktop:notification:fallback', (event, payload: unknown) => {
      if (process.platform !== 'darwin' || !bridgeCaller(event).trusted || typeof payload !== 'object' || payload === null) return
      const id = (payload as { id?: unknown }).id
      if (typeof id !== 'string' || id === '' || id.length > 160 || macFallbackNotificationIds.size >= 99) return
      requestMacNotificationAttention(id)
    })
    ipcMain.on('desktop:notification:clear', (event, id: unknown) => {
      if (process.platform !== 'darwin' || !bridgeCaller(event).trusted || typeof id !== 'string' || id.length > 160) return
      clearMacNotificationAttention(id)
    })
    ipcMain.on('desktop:notification:activate', (event) => {
      if (process.platform !== 'win32' || !bridgeCaller(event).trusted) return
      showMainWindow()
    })
    mainWindowRequested = true
    createWindow()
    const guiPathReady = restoreMacGuiPath()
    desktopUpdater = createDesktopUpdater()
    desktopUpdater.onChange(broadcastUpdateState)
    await settingsServer.start()
    installMenu()
    createTray()
    // After both exist: the watcher's first pass rebuilds them if the Web UI's
    // language setting disagrees with the system locale they were built from.
    watchLocalePreference()
    // After the locale watcher: the notice's wording follows the Web UI's
    // language setting, and this is the first point where that is settled.
    scheduleLegacyBundleNotice()
    powerMonitor.on('resume', () => { scheduleWindowHealthCheck('system resume', 3_000) })
    windowHealthTimer = setInterval(() => { void recoverBlankWindow('periodic health check') }, WINDOW_HEALTH_INTERVAL_MS)
    windowHealthTimer.unref()
    schedulePeriodicAutoUpdateChecks()
    registerDesktopIpc()
    await guiPathReady
    boot()
    app.on('activate', () => {
      if (mainWindow === null) launchWindow()
    })
  }).catch((error: unknown) => {
    dialog.showErrorBox('DSH Desktop', '桌面客户端启动失败。\n' + (error instanceof Error ? error.message : String(error)))
    app.quit()
  })

  app.on('window-all-closed', () => {
    // Tray-resident client: closing the last window keeps the app running.
    // Quit happens through the tray menu, the app menu, or Cmd+Q.
  })

  // Quit owns the local child: the stop ladder runs before the process exits,
  // so the runtime never outlives the client as an orphan holding the data
  // home and a port.
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (windowHealthTimer !== undefined) clearInterval(windowHealthTimer)
    connection.dispose()
    void (async () => {
      // A restart carries one extra step: the owned child is stopped below
      // either way, but an adopted one would otherwise outlive this process
      // and be adopted right back by the successor.
      try {
        await connection.stop(restarting)
      } catch (error) {
        // Never strand the app in a half-quit state over a failed stop: the
        // ladder is best-effort, the quit is not.
        console.error('[desktop] shutdown ladder failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      app.quit()
    })()
  })
}
