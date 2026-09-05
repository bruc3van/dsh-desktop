import { app, ipcMain } from 'electron'
import type { ClientSettings } from './client-settings.ts'
import type { DshDataMode } from './data-home.ts'
import {
  validateSmartRuntimes,
  type SmartRuntimeId
} from './smart-runtimes.ts'
import type { DesktopUpdater, UpdateState } from './updater.ts'
interface BridgeCaller { trusted: boolean; remote: boolean }
interface Options {
  bridgeCaller: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BridgeCaller
  bridgeDenied: () => Error
  getStatusJson: (includeLocalDetail?: boolean) => Record<string, unknown>
  loadSettings: () => ClientSettings
  setBundledMarketEnabled: (enabled: unknown, remoteCaller: boolean) => Promise<{ enabled: boolean }>
  enabledSmartRuntimes: () => SmartRuntimeId[]
  localeChinese: () => boolean
  confirmSensitiveAction: (message: string, detail: string) => Promise<boolean>
  currentTarget: () => string | undefined
  persistSmartRuntimes: (ids: SmartRuntimeId[]) => Promise<{ saved: boolean; smartRuntimes: SmartRuntimeId[]; error?: string }>
  requestLocalWebPortSave: (value: unknown, remoteCaller: boolean) => Promise<{ saved: boolean; localWebPort: number; applied?: boolean; error?: string }>
  selectedDshDataMode: (settings?: ClientSettings) => DshDataMode
  requestDshDataModeSave: (value: unknown) => { saved: boolean; dshDataMode: DshDataMode; applied?: boolean; error?: string }
  probeDefaultWebUi: () => Promise<{ url: string | null }>
  requestServerUrlSave: (serverUrl: unknown, remoteCaller: boolean) => Promise<{ saved: boolean; mode?: "smart" | "connect"; error?: string }>
  switchConnectionMode: () => Promise<{ switched: boolean; mode?: "smart" | "connect"; error?: string }>
  openSettingsWindow: () => void
  localDocumentCaller: (event: Electron.IpcMainEvent) => boolean
  retryConnection: () => void
  useSmartFromLocalDocument: () => void
  getDesktopUpdater: () => Pick<DesktopUpdater, 'getState' | 'resetDismiss' | 'check' | 'dismiss'> | undefined
  updateStateForCaller: (state: UpdateState, remote: boolean) => UpdateState
  installDesktopUpdate: () => Promise<{ started: boolean; error?: string }>
  scheduleQuitAfterWindowsInstall: () => void
}

export function createDesktopIpc(options: Options) {
  const { bridgeCaller, bridgeDenied, getStatusJson, loadSettings, setBundledMarketEnabled, enabledSmartRuntimes, localeChinese, confirmSensitiveAction, currentTarget, persistSmartRuntimes, requestLocalWebPortSave, selectedDshDataMode, requestDshDataModeSave, probeDefaultWebUi, requestServerUrlSave, switchConnectionMode, openSettingsWindow, localDocumentCaller, retryConnection, useSmartFromLocalDocument, updateStateForCaller, installDesktopUpdate, scheduleQuitAfterWindowsInstall } = options


  function registerDesktopIpc(): void {
    // The official page's enhanced-features card bridges through these. Every
    // handler resolves its sender first (see bridgeCaller): the preload rides
    // on whatever the window loads, so "the renderer asked" is not by itself
    // evidence that the client's own UI asked.
    ipcMain.handle('desktop:connection:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return getStatusJson(!caller.remote)
    })
    // The marketplace opt-out. Read and write only: taking the seat back is
    // the client's own job on the next spawn, and doing it here would fight
    // whatever the running child already loaded.
    ipcMain.handle('desktop:market:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return { enabled: loadSettings().bundledMarketDisabled !== true }
    })
    ipcMain.handle('desktop:market:set', async (event, enabled: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return setBundledMarketEnabled(enabled, caller.remote)
    })
    ipcMain.handle('desktop:connection:smartRuntimes', async (event, runtimes: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      const parsed = validateSmartRuntimes(runtimes)
      if (parsed === undefined) {
        return {
          saved: false,
          smartRuntimes: enabledSmartRuntimes(),
          error: localeChinese() ? '至少保留一种来源' : 'Keep at least one source',
        }
      }
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求更改智能连接来源' : 'The current page asked to change Smart-mode sources',
          (localeChinese()
            ? '这会决定智能模式下尝试哪些来源（本机已运行、本机已安装、npx 缓存、客户端内置）。请求来自：'
            : 'This chooses which sources Smart mode may try (already running, installed, npx cache, bundled). Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) {
          return {
            saved: false,
            smartRuntimes: enabledSmartRuntimes(),
            error: localeChinese() ? '已取消' : 'Cancelled',
          }
        }
      }
      return persistSmartRuntimes(parsed)
    })
    ipcMain.handle('desktop:connection:localWebPort', async (event, port: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return requestLocalWebPortSave(port, caller.remote)
    })
    ipcMain.handle('desktop:data-mode:set', async (event, mode: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求切换本机数据环境' : 'The current page asked to switch the local data environment',
          (localeChinese()
            ? '这会重启客户端，并决定本机运行时使用共享数据还是桌面端独立数据。请求来自：'
            : 'This restarts the client and chooses whether its local runtime uses shared or isolated desktop data. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) {
          return {
            saved: false,
            dshDataMode: selectedDshDataMode(),
            error: localeChinese() ? '已取消' : 'Cancelled',
          }
        }
      }
      return requestDshDataModeSave(mode)
    })
    ipcMain.handle('desktop:connection:probe', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // What answers on this machine's loopback is local detail: a configured
      // remote page may render the connection card, not survey the port.
      if (caller.remote) return { url: null }
      return probeDefaultWebUi()
    })
    ipcMain.handle('desktop:connection:save', async (event, serverUrl: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return requestServerUrlSave(serverUrl, caller.remote)
    })
    ipcMain.handle('desktop:connection:switch', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // A persistent mode flip asked for by a REMOTE origin gets the same
      // native confirmation every other state change does: the window may be
      // pointed at a page that must not repoint the client silently.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求切换连接模式' : 'The current page asked to switch the connection mode',
          (localeChinese()
            ? '这会让客户端在智能模式与自定义地址之间切换。请求来自：'
            : 'This flips the client between Smart mode and a custom address. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) return { switched: false, error: localeChinese() ? '已取消' : 'Cancelled' }
      }
      return switchConnectionMode()
    })
    ipcMain.on('desktop:open-connection-settings', (event) => {
      if (!bridgeCaller(event).trusted) return
      openSettingsWindow()
    })
    ipcMain.on('desktop:local:retry', (event) => {
      if (!localDocumentCaller(event)) return
      retryConnection()
    })
    ipcMain.on('desktop:local:quit', (event) => {
      if (!localDocumentCaller(event)) return
      app.quit()
    })
    // The way out of a pinned address that stopped answering. The address is
    // kept, so switching back is one click once it is up again.
    ipcMain.on('desktop:local:use-smart', (event) => {
      if (!localDocumentCaller(event)) return
      useSmartFromLocalDocument()
    })
    ipcMain.handle('desktop:update:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      const state = options.getDesktopUpdater()?.getState()
      return state === undefined ? undefined : updateStateForCaller(state, caller.remote)
    })
    ipcMain.handle('desktop:update:check', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // A check also clears "ignore this version" and spends this machine's
      // requests against the update host; a remote page may not do either
      // without the person at the keyboard.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求检查更新' : 'The current page asked to check for updates',
          (localeChinese() ? '这会清除「忽略此版本」记录并访问更新服务器。请求来自：' : 'This clears the "skip this version" record and contacts the update server. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) return { hasUpdate: false }
      }
      options.getDesktopUpdater()?.resetDismiss()
      return options.getDesktopUpdater()?.check() ?? { hasUpdate: false }
    })
    ipcMain.handle('desktop:update:install', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      const chinese = localeChinese()
      // Installing runs an executable this machine downloaded. A remote page
      // may ask; only the person at the keyboard may answer.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          chinese ? '当前页面请求下载并安装更新' : 'The current page asked to download and install an update',
          (chinese ? '安装程序会在本机运行。请求来自：' : 'The installer will run on this machine. Requested by: ')
          + (currentTarget() ?? ''),
        )
        // Declining is an answer, not a failure: the card says so, and says
        // it without the "update failed" prefix.
        if (!confirmed) return { started: false, cancelled: true }
      }
      const result = await installDesktopUpdate()
      if (result.started) scheduleQuitAfterWindowsInstall()
      // The failure reason names local paths for the same reasons the status
      // does; a remote caller learns that it failed, not where.
      if (!result.started && caller.remote && result.error !== undefined) {
        return { started: false, error: chinese ? '更新失败' : 'Update failed' }
      }
      return result
    })
    ipcMain.handle('desktop:update:dismiss', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) return
      // The third button on the card that check and install are the other two
      // of, and it needs an answer from the same person they do: dismissing
      // writes the version into THIS machine's settings, which silences the
      // tray entry, the status tip and every automatic prompt for that version
      // until someone checks by hand. A remote page may ask to be left alone;
      // only the person at the keyboard may make this client quiet about a
      // version it has already found.
      if (caller.remote) {
        const chinese = localeChinese()
        const confirmed = await confirmSensitiveAction(
          chinese ? '当前页面请求忽略此版本更新' : 'The current page asked to skip this update',
          (chinese
            ? '客户端将不再提示该版本，直到你手动检查更新。请求来自：'
            : 'This client will stop offering that version until you check for updates by hand. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) return
      }
      options.getDesktopUpdater()?.dismiss()
    })
  }
  return { registerDesktopIpc }
}
