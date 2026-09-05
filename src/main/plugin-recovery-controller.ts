import { app, BrowserWindow, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_PROFILE } from './bundled-plugin.ts'
import { type ClientSettings } from './client-settings.ts'
import {
  isPluginCompatibilityFailure,
  normalizePluginPackageName,
  pluginCompatibilityFailureNames,
  type DshDataMode
} from './data-home.ts'
import { devOverride } from './development-options.ts'
import { showPluginRecoveryDialog } from './plugin-recovery-dialog.ts'
import { killProcessTree } from './process-tree.ts'
import { sanitizeRuntimeOutput } from './runtime-output.ts'
import { PNPM_ENTRY_VARIABLE } from './runtime-spawn.ts'
import type { DshCommand } from './runtime-types.ts'
import type { WebUiManager } from './web-ui-manager.ts'
interface Options {
  bundledPnpmEntry: () => string | undefined
  childHome: () => string
  childPath: () => string
  spawnOptions: () => { readonly windowsHide: true }
  dshDataModeSelectable: () => boolean
  loadSettings: () => ClientSettings
  selectedDshDataMode: (settings?: ClientSettings) => DshDataMode
  getWebUi: () => Readonly<Pick<WebUiManager, 'lastDiagnostic' | 'lastError' | 'lastCommand'>> | undefined
  showLoadingDocument: () => void
  updateLoadingStatus: (chinese: string, english: string, state?: "busy" | "failed") => void
  localeChinese: () => boolean
  getMainWindow: () => BrowserWindow | null
  windowIcon: () => string
  windowBackgroundColor: () => string
  showLocalRuntimeStartupFailure: (code: number | null, signal: NodeJS.Signals | null) => void
  patchSettings: (patch?: Partial<ClientSettings>, unset?: readonly (keyof ClientSettings)[]) => void
  restartApp: () => void
  openSettingsWindow: () => void
}

export function createPluginRecoveryController(services: Options) {
  const { bundledPnpmEntry, childHome, childPath, dshDataModeSelectable, loadSettings, selectedDshDataMode, showLoadingDocument, updateLoadingStatus, localeChinese, windowBackgroundColor, showLocalRuntimeStartupFailure, patchSettings, restartApp, openSettingsWindow } = services


  let compatibilityFallbackScheduled = false


  function compatibilityFallbackPlugins(settings: ClientSettings): string[] {
    const plugins = Array.isArray(settings.dshDataFallbackPlugins)
      ? settings.dshDataFallbackPlugins.map(normalizePluginPackageName)
      : []
    const legacy = normalizePluginPackageName(settings.dshDataFallbackPlugin)
    return [...new Set([...plugins, legacy].filter((plugin): plugin is string => plugin !== undefined))]
  }


  /** Only direct profile plugins explicitly named by the diagnostic may be removed. */
  function removableProfilePlugins(home: string, candidates: readonly string[]): string[] {
    try {
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', WEB_PROFILE, 'package.json'), 'utf8')) as {
        dependencies?: unknown
        dsh?: { profile?: { bundles?: unknown } }
      }
      const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object'
        ? new Set(Object.keys(manifest.dependencies))
        : new Set<string>()
      const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
        ? new Set(manifest.dsh.profile.bundles.filter((value): value is string => typeof value === 'string'))
        : new Set<string>()
      return candidates.filter(name => dependencies.has(name) && bundles.has(name))
    } catch {
      return []
    }
  }


  function profilePluginsRemoved(home: string, plugins: readonly string[]): boolean {
    try {
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', WEB_PROFILE, 'package.json'), 'utf8')) as {
        dependencies?: unknown
        dsh?: { profile?: { bundles?: unknown } }
      }
      const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object'
        ? new Set(Object.keys(manifest.dependencies))
        : new Set<string>()
      const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
        ? new Set(manifest.dsh.profile.bundles.filter((value): value is string => typeof value === 'string'))
        : new Set<string>()
      return plugins.every(name => !dependencies.has(name) && !bundles.has(name))
    } catch {
      return false
    }
  }


  /** Run the same official CLI and pnpm path as a user-issued `dsh plugin remove`. */
  function removeProfilePlugins(command: DshCommand, plugins: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const pnpm = bundledPnpmEntry()
      const args = [...command.args, 'plugin', '--profile', WEB_PROFILE, 'remove', ...plugins]
      // The official CLI waits synchronously on pnpm. Give that CLI and all of
      // its descendants a private POSIX process group so a timeout cannot leave
      // an orphan package manager modifying the shared profile in the background.
      const detachedProcessGroup = process.platform !== 'win32'
      const child = spawn(command.command, args, {
        cwd: childHome(),
        env: {
          ...process.env,
          DSH_HOME: childHome(),
          PATH: childPath(),
          ...command.entry !== undefined && { DSH_DESKTOP_RUNTIME_ENTRY: command.entry },
          ...pnpm !== undefined && { [PNPM_ENTRY_VARIABLE]: pnpm },
          ...app.isPackaged && command.command === process.execPath && { ELECTRON_RUN_AS_NODE: '1' },
        },
        stdio: 'ignore',
        ...services.spawnOptions(),
        detached: detachedProcessGroup,
        ...command.shell === true && { shell: true },
      })
      let settled = false
      let timedOut = false
      let stopConfirmationTimer: NodeJS.Timeout | undefined
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stopConfirmationTimer !== undefined) clearTimeout(stopConfirmationTimer)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child, detachedProcessGroup)
        // Prefer the real exit event: it confirms the command tree was stopped
        // before recovery presents another action against the same profile.
        stopConfirmationTimer = setTimeout(() => {
          settle(new Error('plugin removal timed out and process termination could not be confirmed'))
        }, 10_000)
      }, 120_000)
      child.once('error', error => { settle(error) })
      child.once('exit', code => {
        if (timedOut) {
          settle(new Error('plugin removal timed out'))
          return
        }
        if (code !== 0) {
          settle(new Error('plugin removal exited with code ' + String(code)))
          return
        }
        settle(profilePluginsRemoved(childHome(), plugins)
          ? undefined
          : new Error('plugin removal did not update the profile manifest'))
      })
    })
  }


  /** Let the user remove every confirmed failing plugin together or use isolation. */
  function schedulePluginCompatibilityFallback(code: number | null, signal: NodeJS.Signals | null): boolean {
    if (compatibilityFallbackScheduled || !dshDataModeSelectable()) return false
    const settings = loadSettings()
    if (selectedDshDataMode(settings) !== 'shared') return false
    const diagnostic = sanitizeRuntimeOutput(services.getWebUi()?.lastDiagnostic ?? services.getWebUi()?.lastError ?? '')
    if (!isPluginCompatibilityFailure(diagnostic)) return false
    const candidates = pluginCompatibilityFailureNames(diagnostic)
    const plugins = removableProfilePlugins(childHome(), candidates)
    const command = services.getWebUi()?.lastCommand
    compatibilityFallbackScheduled = true
    showLoadingDocument()
    updateLoadingStatus(
      '检测到插件兼容问题，正在等待你的选择…',
      'A plugin compatibility problem was detected; waiting for your choice…',
    )
    void (async () => {
      const chinese = localeChinese()
      const canRemove = command !== undefined && plugins.length > 0
      const listedPlugins = canRemove ? plugins : candidates
      const buttons = canRemove
        ? (chinese ? ['卸载全部并重试', '使用独立环境', '取消'] : ['Remove all and retry', 'Use isolated environment', 'Cancel'])
        : (chinese ? ['使用独立环境', '取消'] : ['Use isolated environment', 'Cancel'])
      const isolatedIndex = canRemove ? 1 : 0
      const cancelIndex = buttons.length - 1
      const forced = devOverride('DSH_DESKTOP_PLUGIN_RECOVERY_CHOICE')
      let response: number
      if (forced === 'remove' && canRemove) response = 0
      else if (forced === 'isolated') response = canRemove ? 1 : 0
      else if (forced === 'cancel') response = canRemove ? 2 : 1
      else {
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          title: 'DSH Desktop',
          message: chinese ? '共享环境中的插件与当前 DSH 不兼容' : 'Plugins in the shared environment are incompatible with this DSH version',
          detail: (canRemove
            ? (chinese
              ? '原来的对话、凭据和模型配置没有丢失。你可以一次卸载下面列出的插件并重试，或保留它们并使用桌面端独立环境。\n\n'
              : 'Your conversations, credentials, and model configuration are still intact. Remove all plugins listed below and retry, or keep them and use the isolated desktop environment.\n\n')
            : (chinese
              ? '原来的对话、凭据和模型配置没有丢失。启动诊断无法安全确认可卸载的直接依赖；你仍可保留现有数据并使用桌面端独立环境。\n\n'
              : 'Your conversations, credentials, and model configuration are still intact. The startup diagnostic did not safely identify a removable direct dependency; you can still keep the existing data and use the isolated desktop environment.\n\n'))
            + (listedPlugins.length === 0
              ? (chinese ? '启动诊断未能安全确认可卸载的插件包。' : 'The startup diagnostic did not safely identify a removable plugin package.')
              : ''),
          buttons,
          // Keep habitual Enter presses from removing plugins.
          defaultId: isolatedIndex,
          cancelId: cancelIndex,
          noLink: true,
        }
        response = await showPluginRecoveryDialog(services.getMainWindow(), options, listedPlugins, chinese, {
          icon: services.windowIcon(), backgroundColor: windowBackgroundColor(),
        })
      }
      if (response === cancelIndex) {
        compatibilityFallbackScheduled = false
        showLocalRuntimeStartupFailure(code, signal)
        return
      }
      if (response === isolatedIndex) {
        patchSettings({
          dshDataMode: 'isolated',
          dshDataFallbackReason: 'plugin-compatibility',
          dshDataFallbackPlugins: candidates,
          dshDataFallbackNoticeShown: true,
        }, ['dshDataFallbackPlugin'])
        console.warn('[desktop] shared DSH home failed on plugin compatibility; the user selected the isolated home')
        updateLoadingStatus(
          '已选择桌面端独立环境，正在重启客户端…',
          'The isolated desktop environment was selected; restarting the client…',
        )
        setTimeout(restartApp, 500)
        return
      }
      if (!canRemove || command === undefined) {
        showLocalRuntimeStartupFailure(code, signal)
        return
      }
      updateLoadingStatus(
        '正在卸载不兼容插件…',
        'Removing incompatible plugins…',
      )
      try {
        await removeProfilePlugins(command, plugins)
        patchSettings({}, [
          'dshDataFallbackReason',
          'dshDataFallbackPlugin',
          'dshDataFallbackPlugins',
          'dshDataFallbackNoticeShown',
        ])
        console.log('[desktop] incompatible profile plugins removed: ' + plugins.join(', '))
        updateLoadingStatus(
          '不兼容插件已卸载，正在用共享环境重试…',
          'The incompatible plugins were removed; retrying the shared environment…',
        )
        setTimeout(restartApp, 500)
      } catch (error) {
        console.warn('[desktop] incompatible plugin removal failed: '
          + (error instanceof Error ? error.message : String(error)))
        await dialog.showMessageBox({
          type: 'error',
          title: 'DSH Desktop',
          message: chinese ? '未能卸载不兼容插件' : 'Could not remove the incompatible plugins',
          detail: chinese
            ? '卸载可能只完成了一部分。客户端没有切换数据环境；请检查共享环境中的插件状态后重试，或在设置中选择桌面端独立环境。'
            : 'Removal may have completed only partially. The client did not switch data environments; inspect the shared profile before retrying, or select the isolated desktop environment in Settings.',
          buttons: [chinese ? '知道了' : 'OK'],
        })
        compatibilityFallbackScheduled = false
        showLocalRuntimeStartupFailure(code, signal)
      }
    })().catch((error: unknown) => {
      console.warn('[desktop] compatibility recovery prompt failed: '
        + (error instanceof Error ? error.message : String(error)))
      compatibilityFallbackScheduled = false
      showLocalRuntimeStartupFailure(code, signal)
    })
    return true
  }


  /** Explain an automatic move once the isolated runtime has actually recovered. */
  function promptPluginCompatibilityFallback(): void {
    const settings = loadSettings()
    if (settings.dshDataFallbackReason !== 'plugin-compatibility'
      || settings.dshDataFallbackNoticeShown === true
      || selectedDshDataMode(settings) !== 'isolated') return
    const chinese = localeChinese()
    const plugins = compatibilityFallbackPlugins(settings)
    const pluginDetail = plugins.length === 0
      ? ''
      : chinese ? `\n\n问题插件：${plugins.join('、')}` : `\n\nProblem plugins: ${plugins.join(', ')}`
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'DSH Desktop',
      message: chinese ? '已切换到桌面端独立环境' : 'Switched to the isolated desktop environment',
      detail: chinese
        ? '共享环境中的插件与当前 DSH 不兼容，客户端已改用独立数据目录。原来的插件和数据没有删除。\n\n建议重新安装兼容版本；解决兼容问题后，可在设置中切回共享环境。' + pluginDetail
        : 'A plugin in the shared environment is incompatible with the current DSH, so the client is now using its isolated data directory. The original plugins and data were not deleted.\n\nReinstall a compatible version, then switch back to the shared environment in Settings after resolving the compatibility problem.' + pluginDetail,
      buttons: chinese ? ['打开设置', '知道了'] : ['Open Settings', 'OK'],
      defaultId: 0,
      cancelId: 1,
    }
    const owner = services.getMainWindow()
    const shown = owner === null || owner.isDestroyed()
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(owner, options)
    void shown.then((answer) => {
      patchSettings({ dshDataFallbackNoticeShown: true })
      if (answer.response === 0) openSettingsWindow()
    }, (error: unknown) => {
      console.warn('[desktop] compatibility fallback notice failed: '
        + (error instanceof Error ? error.message : String(error)))
    })
  }
  return { compatibilityFallbackPlugins, schedulePluginCompatibilityFallback, promptPluginCompatibilityFallback }
}
