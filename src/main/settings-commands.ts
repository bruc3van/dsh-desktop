import type { ClientSettings } from './client-settings.ts'
import { normalizeServerUrl, originIsLoopback, usesConfiguredServer } from './connection-policy.ts'
import {
  hasIsolatedRuntimeSource,
  type DshDataMode
} from './data-home.ts'
import { devFlag } from './development-options.ts'
import {
  isOfficialWebPort,
  localWebPortRangeLabel,
  parseLocalWebPort
} from './local-web-port.ts'
import { loopbackPortHeld } from './loopback-port.ts'
import {
  validateSmartRuntimes,
  type SmartRuntimeId
} from './smart-runtimes.ts'
interface Options {
  resetRuntimeFailure: () => void
  enabledSmartRuntimes: () => SmartRuntimeId[]
  loadSettings: () => ClientSettings
  refuseOccupiedLocalSpawn: (ids: readonly SmartRuntimeId[], extraPorts?: readonly number[]) => Promise<string | undefined>
  localeChinese: () => boolean
  patchSettings: (patch?: Partial<ClientSettings>, unset?: readonly (keyof ClientSettings)[]) => void
  applySmartLocalRuntimeChange: () => void
  configuredLocalWebPort: () => number
  pinnedPortAddress: (port: number) => string
  isOwnManagedOrigin: (url: string) => boolean
  warnPinnedPortHeld: (port: number) => void
  confirmSensitiveAction: (message: string, detail: string) => Promise<boolean>
  currentTarget: () => string | undefined
  getActiveDshDataMode: () => DshDataMode | undefined
  selectedDshDataMode: (settings?: ClientSettings) => DshDataMode
  dshDataModeSelectable: () => boolean
  restartApp: () => void
  defaultWebProbeUrl: () => string
  applyConnectionSettings: (settings: ClientSettings, force?: boolean) => void
}

export function createSettingsCommands(options: Options) {
  const { enabledSmartRuntimes, loadSettings, refuseOccupiedLocalSpawn, localeChinese, patchSettings, applySmartLocalRuntimeChange, configuredLocalWebPort, pinnedPortAddress, isOwnManagedOrigin, warnPinnedPortHeld, confirmSensitiveAction, currentTarget, selectedDshDataMode, dshDataModeSelectable, restartApp, defaultWebProbeUrl, applyConnectionSettings } = options

  /** Occupancy + persist of source toggles: the latest click must not race. */
  let smartRuntimesSaveChain: Promise<void> = Promise.resolve()

  /** Occupancy + persist of a local bind: a later click must invalidate an earlier one. */
  let localWebPortSaveEpoch = 0

  let dataModeRestartScheduled = false


  /**
   * Persist which Smart-mode sources are live. In Smart mode the change is
   * applied immediately (the current child is stopped so the next spawn is
   * chosen from the new set). A change that would spawn beside a user-started
   * instance is refused — the occupancy surface is not a substitute for
   * quitting it. Client-started runtimes (installed / npx / bundled) are
   * stopped by this client; only a process it did not start blocks the save.
   * Pinned-address mode only records the preference.
   *
   * The stop must not run the recovery ladder: unlike `connectTo`, this stays
   * in Smart mode (`configuredTarget` stays unset), so a child exit would
   * otherwise look like a crash — marking PATH/npx rejected for the session
   * when the child had not become ready, or spending a retry and showing
   * "本地服务意外退出" when it had.
   */
  async function persistSmartRuntimes(ids: SmartRuntimeId[]): Promise<{
    saved: boolean
    smartRuntimes: SmartRuntimeId[]
    error?: string
  }> {
    const run = smartRuntimesSaveChain.then(
      () => persistSmartRuntimesNow(ids),
      () => persistSmartRuntimesNow(ids),
    )
    smartRuntimesSaveChain = run.then(() => undefined, () => undefined)
    return run
  }


  async function persistSmartRuntimesNow(ids: SmartRuntimeId[]): Promise<{
    saved: boolean
    smartRuntimes: SmartRuntimeId[]
    error?: string
  }> {
    const previous = enabledSmartRuntimes()
    const settings = loadSettings()
    if (!usesConfiguredServer(settings)) {
      const occupied = await refuseOccupiedLocalSpawn(ids)
      if (occupied !== undefined) {
        return {
          saved: false,
          smartRuntimes: previous,
          error: localeChinese()
            ? '请先退出本机已运行的实例，再排除或切换来源'
            : 'Quit the running instance before changing sources',
        }
      }
    }
    options.resetRuntimeFailure()
    patchSettings({ smartRuntimes: ids })
    if (usesConfiguredServer(loadSettings())) return { saved: true, smartRuntimes: ids }
    applySmartLocalRuntimeChange()
    return { saved: true, smartRuntimes: ids }
  }


  async function requestSmartRuntimesSave(value: unknown): Promise<{
    saved: boolean
    smartRuntimes: SmartRuntimeId[]
    error?: string
  }> {
    const parsed = validateSmartRuntimes(value)
    if (parsed === undefined) {
      return {
        saved: false,
        smartRuntimes: enabledSmartRuntimes(),
        error: localeChinese() ? '至少保留一种来源' : 'Keep at least one source',
      }
    }
    return persistSmartRuntimes(parsed)
  }


  async function persistLocalWebPort(port: number, epoch: number): Promise<{
    saved: boolean
    localWebPort: number
    applied?: boolean
    error?: string
  }> {
    if (epoch !== localWebPortSaveEpoch) {
      return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
    }
    const current = configuredLocalWebPort()
    const chinese = localeChinese()
    const settings = loadSettings()
    if (!usesConfiguredServer(settings) && port > 0) {
      const occupied = await refuseOccupiedLocalSpawn(enabledSmartRuntimes(), [port])
      if (epoch !== localWebPortSaveEpoch) {
        return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
      }
      if (occupied !== undefined) {
        return {
          saved: false,
          localWebPort: current,
          error: chinese ? '请先退出本机已运行的实例，再固定该端口' : 'Quit the running instance before pinning that port',
        }
      }
      if (!devFlag('DSH_DESKTOP_SKIP_PROBE')) {
        const origin = pinnedPortAddress(port)
        if (await loopbackPortHeld(port) && !isOwnManagedOrigin(origin)) {
          if (epoch !== localWebPortSaveEpoch) {
            return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
          }
          warnPinnedPortHeld(port)
          return {
            saved: false,
            localWebPort: current,
            error: chinese ? '该端口已被占用' : 'That port is already in use',
          }
        }
      }
    }
    if (epoch !== localWebPortSaveEpoch) {
      return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
    }
    if (port === 0) patchSettings({}, ['localWebPort'])
    else patchSettings({ localWebPort: port })
    if (usesConfiguredServer(loadSettings())) {
      return { saved: true, localWebPort: port, applied: false }
    }
    if (current === port) return { saved: true, localWebPort: port, applied: false }
    options.resetRuntimeFailure()
    applySmartLocalRuntimeChange()
    return { saved: true, localWebPort: port, applied: true }
  }


  async function requestLocalWebPortSave(value: unknown, remoteCaller: boolean): Promise<{
    saved: boolean
    localWebPort: number
    applied?: boolean
    error?: string
  }> {
    const chinese = localeChinese()
    const parsed = parseLocalWebPort(value)
    const cancelled = { saved: false, localWebPort: configuredLocalWebPort(), error: chinese ? '已取消' : 'Cancelled' }
    if (parsed === undefined) {
      return {
        saved: false,
        localWebPort: configuredLocalWebPort(),
        error: chinese
          ? '请输入 ' + localWebPortRangeLabel() + ' 之间的端口，或留空使用自动端口'
          : 'Enter a port from ' + localWebPortRangeLabel() + ', or leave it blank for automatic selection',
      }
    }
    // Claim this request before either confirmation dialog. A later port choice
    // must supersede this one even while the user is still deciding whether to
    // approve 3080 (and, for remote callers, the additional sensitive action).
    const epoch = ++localWebPortSaveEpoch
    if (remoteCaller) {
      const confirmed = await confirmSensitiveAction(
        chinese ? '当前页面请求更改本地服务端口' : 'The current page asked to change the local service port',
        (chinese
          ? '这会决定客户端自己启动的 dsh 绑在哪个端口。请求来自：'
          : 'This chooses which port a client-started dsh binds to. Requested by: ')
        + (currentTarget() ?? '') + '\n'
        + (chinese ? '新端口：' : 'New port: ') + (parsed === 0 ? (chinese ? '自动' : 'automatic') : String(parsed)),
      )
      if (!confirmed) return cancelled
      if (epoch !== localWebPortSaveEpoch) {
        return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
      }
    }
    if (isOfficialWebPort(parsed) && configuredLocalWebPort() !== parsed) {
      const confirmed = await confirmSensitiveAction(
        chinese ? '这会占用官方默认端口 3080' : 'This occupies the official default port 3080',
        chinese
          ? '终端里的 dsh web 将无法再使用默认端口。自动模式在 3080 被占用时会回退到 13080 或随机端口；固定为 3080 后不会自动回退。'
          : 'A dsh web you start in a terminal will no longer be able to use the default port. Automatic mode falls back to 13080 or an OS-assigned port when 3080 is occupied; pinning 3080 disables that fallback.',
      )
      if (!confirmed) return cancelled
      if (epoch !== localWebPortSaveEpoch) {
        return { saved: true, localWebPort: configuredLocalWebPort(), applied: false }
      }
    }
    return persistLocalWebPort(parsed, epoch)
  }


  function requestDshDataModeSave(value: unknown): {
    saved: boolean
    dshDataMode: DshDataMode
    applied?: boolean
    error?: string
  } {
    const current = options.getActiveDshDataMode() ?? selectedDshDataMode()
    const chinese = localeChinese()
    if (value !== 'shared' && value !== 'isolated') {
      return { saved: false, dshDataMode: current, error: chinese ? '未知的数据环境' : 'Unknown data environment' }
    }
    if (!dshDataModeSelectable()) {
      return {
        saved: false,
        dshDataMode: current,
        error: chinese ? '当前由 DSH_HOME 开发环境变量控制' : 'Currently controlled by the DSH_HOME development override',
      }
    }
    if (dataModeRestartScheduled) {
      return {
        saved: false,
        dshDataMode: current,
        error: chinese ? '数据环境切换已保存，客户端正在重启' : 'A data-environment change is saved and the client is restarting',
      }
    }
    if (value === 'isolated' && !hasIsolatedRuntimeSource(enabledSmartRuntimes())) {
      return {
        saved: false,
        dshDataMode: current,
        error: chinese
          ? '独立环境无法复用本机已运行实例；请先启用本机已安装、npx 缓存或客户端内置运行时'
          : 'The isolated environment cannot reuse an already-running instance; enable installed, npx cache, or bundled first',
      }
    }
    if (value === current) return { saved: true, dshDataMode: current, applied: false }
    patchSettings(
      { dshDataMode: value },
      ['dshDataFallbackReason', 'dshDataFallbackPlugin', 'dshDataFallbackPlugins', 'dshDataFallbackNoticeShown'],
    )
    dataModeRestartScheduled = true
    // A process restart makes the selected home immutable for the lifetime of
    // every runtime generation. In-process switching could let an old child's
    // late exit clear the new home's lock or withdraw its plugin seat.
    setTimeout(restartApp, 500)
    return { saved: true, dshDataMode: value, applied: true }
  }


  /**
   * Whether an origin is the address Smart mode itself would probe: the default
   * probe port on any loopback spelling (`localhost` included). Pinning that
   * one origin is strictly worse than Smart — identical while it is up, and on
   * the wrong side of the only difference that matters: when the instance goes
   * away, Connect mode holds the dead address and stops at the failure surface,
   * while Smart falls through to a local runtime. The address is still
   * recorded, so the switch button can pin it as a deliberate act.
   */
  function isSmartProbeEquivalent(origin: string): boolean {
    const probe = normalizeServerUrl(defaultWebProbeUrl())
    if (probe === undefined) return false
    if (!originIsLoopback(origin)) return origin === probe
    try {
      return new URL(origin).port === new URL(probe).port
    } catch {
      return false
    }
  }


  /**
   * Save an address edit. A non-empty valid address becomes the active target —
   * except the default probe address, which Smart mode already prefers.
   *
   * Pinning that one origin is strictly worse than Smart: identical while it is
   * up, and on the wrong side of the only difference that matters — when the
   * instance goes away, Connect mode holds the dead address and stops at the
   * failure surface, while Smart falls through to a local runtime. The address
   * is still recorded, so the switch button can pin it as a deliberate act.
   */
  function saveServerUrlAndReconnect(serverUrl: unknown): { saved: boolean; mode?: 'smart' | 'connect'; error?: string } {
    try {
      const raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
      if (raw === '') {
        patchSettings({ connectionMode: 'smart' }, ['serverUrl'])
        applyConnectionSettings(loadSettings(), true)
        return { saved: true, mode: 'smart' }
      }
      const explicit = normalizeServerUrl(raw)
      if (explicit === undefined) return { saved: false, error: '请输入有效的 HTTP 或 HTTPS 地址' }
      const mode = isSmartProbeEquivalent(explicit) ? 'smart' : 'connect'
      patchSettings({ serverUrl: explicit, connectionMode: mode })
      applyConnectionSettings(loadSettings(), true)
      return { saved: true, mode }
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : String(error) }
    }
  }


  /**
   * The guarded entry point for an address change. Two native confirmations,
   * each for a different reason: one when a remote page is the one asking to
   * repoint the client (a persistent redirect is the whole prize for a hostile
   * or compromised Web UI), one when the address itself is plaintext HTTP off
   * this machine — the official UI carries the API key and every message, and
   * http:// puts both on the wire in clear.
   */
  async function requestServerUrlSave(serverUrl: unknown, remoteCaller: boolean): Promise<{ saved: boolean; mode?: 'smart' | 'connect'; error?: string }> {
    const chinese = localeChinese()
    const raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
    const explicit = raw === '' ? undefined : normalizeServerUrl(raw)
    if (raw !== '' && explicit === undefined) {
      return { saved: false, error: chinese ? '请输入有效的 HTTP 或 HTTPS 地址' : 'Enter a valid HTTP or HTTPS address' }
    }
    const cancelled = { saved: false, error: chinese ? '已取消' : 'Cancelled' }

    if (remoteCaller) {
      const confirmed = await confirmSensitiveAction(
        chinese ? '当前页面请求更改 Web UI 连接地址' : 'The current page asked to change the Web UI address',
        (chinese
          ? '这会让客户端在以后每次启动时都连接到新地址。请求来自：'
          : 'This repoints the client on every future launch. Requested by: ')
        + (currentTarget() ?? '') + '\n'
        + (chinese ? '新地址：' : 'New address: ') + (explicit ?? (chinese ? '（智能模式）' : '(Smart mode)')),
      )
      if (!confirmed) return cancelled
    }
    if (explicit !== undefined && explicit.startsWith('http://') && !originIsLoopback(explicit)) {
      const confirmed = await confirmSensitiveAction(
        chinese ? '该地址使用明文 HTTP' : 'That address uses plaintext HTTP',
        (chinese
          ? 'API Key、全部会话内容都会以未加密方式在网络上传输，同网络中的任何人都可以读取或篡改。可用的话请改用 https://。\n\n地址：'
          : 'The API key and every message travel unencrypted; anyone on the path can read or alter them. Prefer https:// when the server offers it.\n\nAddress: ')
        + explicit,
      )
      if (!confirmed) return cancelled
    }
    if (explicit === undefined || isSmartProbeEquivalent(explicit)) {
      const occupied = await refuseOccupiedLocalSpawn(enabledSmartRuntimes())
      if (occupied !== undefined) {
        return {
          saved: false,
          error: chinese ? '请先退出本机已运行的实例，再切换到智能模式' : 'Quit the running instance before switching to Smart mode',
        }
      }
    }
    return saveServerUrlAndReconnect(serverUrl)
  }


  /** Toggle between Smart local selection and the saved fixed origin. */
  async function switchConnectionMode(): Promise<{ switched: boolean; mode?: 'smart' | 'connect'; error?: string }> {
    try {
      const current = loadSettings()
      const explicit = normalizeServerUrl(current.serverUrl)
      if (explicit === undefined) return { switched: false, error: '请先保存 Web UI 地址' }
      const mode = usesConfiguredServer(current) ? 'smart' : 'connect'
      if (mode === 'smart') {
        const occupied = await refuseOccupiedLocalSpawn(enabledSmartRuntimes())
        if (occupied !== undefined) {
          return {
            switched: false,
            error: localeChinese()
              ? '请先退出本机已运行的实例，再切换到智能模式'
              : 'Quit the running instance before switching to Smart mode',
          }
        }
      }
      patchSettings({ serverUrl: explicit, connectionMode: mode })
      applyConnectionSettings(loadSettings(), true)
      return { switched: true, mode }
    } catch (error) {
      return { switched: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { persistSmartRuntimes, requestSmartRuntimesSave, requestLocalWebPortSave, requestDshDataModeSave, requestServerUrlSave, switchConnectionMode }
}
