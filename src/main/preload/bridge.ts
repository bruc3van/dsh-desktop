import { contextBridge, ipcRenderer } from 'electron'
import { installMacNotificationFallback } from '../mac-notification-fallback.ts'
import { installWindowsNotificationActivation } from '../windows-notification-activation.ts'

/** Connection facts mirrored from the main process. */
export interface ConnectionStatus {
  mode: 'local' | 'probe' | 'connect'
  targetUrl: string
  desktopVersion: string
  dshVersion: string | null
  savedServerUrl: string
  selectedMode: 'smart' | 'connect'
  canSwitch: boolean
  childPid?: number
  lastError?: string
  /** Which dsh the local child runs. Absent for a remote caller. */
  runtimeSource?: 'override' | 'installed' | 'npx' | 'bundled' | 'checkout' | 'path'
  installedDshVersion?: string
  /** The selected npx cache lags the bundled runtime (note, not veto). */
  npxCacheOutdated?: boolean
  /** Smart-mode sources currently enabled. Missing means all four. */
  smartRuntimes?: Array<'probe' | 'installed' | 'npx' | 'bundled'>
  /** Bind port for a client-started dsh. 0 = automatic. */
  localWebPort?: number
  /** Which DSH_HOME family the desktop runtime uses. */
  dshDataMode?: 'shared' | 'isolated'
  /** Resolved local path; absent for a configured remote caller. */
  dshDataHome?: string
  dshDataModeSelectable?: boolean
  dshDataFallbackReason?: 'plugin-compatibility'
  dshDataFallbackPlugin?: string
  dshDataFallbackPlugins?: string[]
}

/** The connection bridge: read/save the Web UI origin through the main process. */
export const connection = {
  getStatus: (): Promise<ConnectionStatus> => ipcRenderer.invoke('desktop:connection:status') as Promise<ConnectionStatus>,
  saveServerUrl: (serverUrl: string): Promise<{ saved: boolean; mode?: 'smart' | 'connect'; error?: string }> =>
    ipcRenderer.invoke('desktop:connection:save', serverUrl) as Promise<{
      saved: boolean
      mode?: 'smart' | 'connect'
      error?: string
    }>,
  switchMode: (): Promise<{ switched: boolean; mode?: 'smart' | 'connect'; error?: string }> =>
    ipcRenderer.invoke('desktop:connection:switch') as Promise<{ switched: boolean; mode?: 'smart' | 'connect'; error?: string }>,
  /** Whether this client seats the bundled marketplace into the runtime it starts. */
  getMarket: (): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke('desktop:market:status') as Promise<{ enabled: boolean }>,
  /** Turn the seat on or off; turning it off also removes the copied plugin. */
  setMarket: (enabled: boolean): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke('desktop:market:set', enabled) as Promise<{ enabled: boolean }>,
  /** An official Web UI answering on the default port right now, if any. */
  probeLocal: (): Promise<{ url: string | null }> =>
    ipcRenderer.invoke('desktop:connection:probe') as Promise<{ url: string | null }>,
  /** Which Smart-mode sources this client will try. At least one must remain. */
  setSmartRuntimes: (runtimes: Array<'probe' | 'installed' | 'npx' | 'bundled'>): Promise<{
    saved: boolean
    smartRuntimes: Array<'probe' | 'installed' | 'npx' | 'bundled'>
    error?: string
  }> =>
    ipcRenderer.invoke('desktop:connection:smartRuntimes', runtimes) as Promise<{
      saved: boolean
      smartRuntimes: Array<'probe' | 'installed' | 'npx' | 'bundled'>
      error?: string
    }>,
  /** Bind port for a client-started dsh. 0 / blank = automatic. */
  setLocalWebPort: (port: number | string): Promise<{
    saved: boolean
    localWebPort: number
    applied?: boolean
    error?: string
  }> =>
    ipcRenderer.invoke('desktop:connection:localWebPort', port) as Promise<{
      saved: boolean
      localWebPort: number
      applied?: boolean
      error?: string
    }>,
  setDshDataMode: (mode: 'shared' | 'isolated'): Promise<{
    saved: boolean
    dshDataMode: 'shared' | 'isolated'
    applied?: boolean
    error?: string
  }> => ipcRenderer.invoke('desktop:data-mode:set', mode) as Promise<{
    saved: boolean
    dshDataMode: 'shared' | 'isolated'
    applied?: boolean
    error?: string
  }>,
}

interface UpdateInfo {
  currentVersion: string
  availableVersion: string
  notes?: string
  pubDate?: string
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'restartRequired' | 'upToDate'
    | 'unsupportedPlatform' | 'error'
  currentVersion: string
  info: UpdateInfo | null
  progress: { total: number; downloaded: number; percent: number } | null
  error: string | null
  dismissed: boolean
  isChecking: boolean
}

type CheckUpdateResult = { hasUpdate: false } | { hasUpdate: true; info: UpdateInfo }

export const update = {
  getStatus: (): Promise<UpdateState> => ipcRenderer.invoke('desktop:update:status') as Promise<UpdateState>,
  check: (): Promise<CheckUpdateResult> => ipcRenderer.invoke('desktop:update:check') as Promise<CheckUpdateResult>,
  install: (): Promise<{ started: boolean; error?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke('desktop:update:install') as Promise<{ started: boolean; error?: string; cancelled?: boolean }>,
  dismiss: (): Promise<void> => ipcRenderer.invoke('desktop:update:dismiss') as Promise<void>,
}

/**
 * Seats the client's OWN local documents use (the loading surface and the
 * connection-failure surface). The main process accepts them only from those
 * data: documents in the main window, so a remote page holding this same
 * bridge cannot repoint the connection or end the application with them.
 */
const local = {
  retry: (): void => { ipcRenderer.send('desktop:local:retry') },
  quit: (): void => { ipcRenderer.send('desktop:local:quit') },
  /** Leave a pinned address for Smart mode, from the failure surface. */
  useSmart: (): void => { ipcRenderer.send('desktop:local:use-smart') },
}

const notificationFallback = {
  post: (payload: { id: string; title: string; body: string; tag: string }): void => {
    ipcRenderer.send('desktop:notification:fallback', payload)
  },
  clear: (id: string): void => {
    ipcRenderer.send('desktop:notification:clear', id)
  },
}

const notificationActivation = {
  activate: (): void => {
    ipcRenderer.send('desktop:notification:activate')
  },
}

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  connection,
  update,
  local,
  ...process.platform === 'win32' && { notificationActivation },
  ...process.platform === 'darwin' && { notificationFallback },
  /** Open the client's native connection-settings window (tray-era fallback). */
  openConnectionSettings: (): void => { ipcRenderer.send('desktop:open-connection-settings') },
})

// Current macOS artifacts are intentionally ad-hoc signed. Electron's native
// UNNotification path is not reliable without a stable valid signature, so
// preserve the Web Notification contract while rendering attention through
// the Dock and an in-app toast. Windows and Linux retain the native API.
if (process.platform === 'darwin') {
  contextBridge.executeInMainWorld({ func: installMacNotificationFallback })
}
if (process.platform === 'win32') {
  contextBridge.executeInMainWorld({ func: installWindowsNotificationActivation })
}
