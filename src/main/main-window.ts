import { BrowserWindow, clipboard, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import type { createConnectionController } from './connection-controller.ts'
import { appOrigin, isSecureUpgrade } from './connection-policy.ts'
import type { ConnectionFailure } from './connection-types.ts'
interface Options {
  localeChinese: () => boolean
  openExternal: (url: string) => void
  windowBackgroundColor: () => string
  windowIcon: () => string
  watchTaskbarTheme: (window: BrowserWindow) => void
  scheduleWindowHealthCheck: (reason: string, delayMs?: number) => void
  clearMacNotificationAttention: (id?: string) => void
  getQuitting: () => boolean
  isInstallerHandoff: () => boolean
  onMainWindowClosed: () => void
  markMainWindowUnrequested: () => void
  getLoadingDocumentActive: () => boolean
  getErrorDocumentActive: () => boolean
  currentTarget: () => string | undefined
  getConnection: () => Readonly<Pick<ReturnType<typeof createConnectionController>, "configuredTarget" | "probeConnected" | "upgradeConfiguredTarget" | "resetProbeRecovery">>
  resetSettingsIntegrationStatus: () => void
  settingsServerReady: () => boolean
  openSettingsWindow: () => void
  handleProbedInstanceFailure: (reason: string) => Promise<void>
  showConnectionError: (failure: ConnectionFailure) => void
  releaseSmartBridgeHandoff: (loadedUrl: string) => void
  bindErrorPageSeats: (window: BrowserWindow) => void
  markWebUiLoaded: () => void
  scheduleAutoUpdateCheck: () => void
  recoverBlankWindow: (reason: string, force?: boolean) => Promise<void>
  markLoadingDocument: () => void
  resetPageAppearance: () => void
  loadingPageUrl: () => string
  scheduleLoadingHints: () => void
}

export function createMainWindowFactory(options: Options) {
  const { localeChinese, openExternal, windowBackgroundColor, watchTaskbarTheme, scheduleWindowHealthCheck, clearMacNotificationAttention, isInstallerHandoff, onMainWindowClosed, markMainWindowUnrequested, currentTarget, resetSettingsIntegrationStatus, openSettingsWindow, handleProbedInstanceFailure, showConnectionError, releaseSmartBridgeHandoff, bindErrorPageSeats, markWebUiLoaded, scheduleAutoUpdateCheck, recoverBlankWindow, markLoadingDocument, resetPageAppearance, loadingPageUrl, scheduleLoadingHints, settingsServerReady } = options



  /** Native right-click menu for page content: copy selection, edit fields, links, images. */
  function installPageContextMenu(contents: Electron.WebContents): void {
    contents.on('context-menu', (_event, params) => {
      if (contents.isDestroyed()) return
      const chinese = localeChinese()
      const template: Electron.MenuItemConstructorOptions[] = []
      const addSeparator = (): void => {
        if (template.length > 0 && template[template.length - 1]?.type !== 'separator') {
          template.push({ type: 'separator' })
        }
      }
      if (params.isEditable) {
        template.push(
          { label: chinese ? '撤销' : 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: params.editFlags.canUndo, click: () => { contents.undo() } },
          { label: chinese ? '重做' : 'Redo', accelerator: process.platform === 'darwin' ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y', enabled: params.editFlags.canRedo, click: () => { contents.redo() } },
          { type: 'separator' },
          { label: chinese ? '剪切' : 'Cut', accelerator: 'CmdOrCtrl+X', enabled: params.editFlags.canCut, click: () => { contents.cut() } },
          { label: chinese ? '复制' : 'Copy', accelerator: 'CmdOrCtrl+C', enabled: params.editFlags.canCopy, click: () => { contents.copy() } },
          { label: chinese ? '粘贴' : 'Paste', accelerator: 'CmdOrCtrl+V', enabled: params.editFlags.canPaste, click: () => { contents.paste() } },
          { label: chinese ? '全选' : 'Select All', accelerator: 'CmdOrCtrl+A', enabled: params.editFlags.canSelectAll, click: () => { contents.selectAll() } },
        )
      } else {
        template.push(
          { label: chinese ? '复制' : 'Copy', accelerator: 'CmdOrCtrl+C', enabled: params.editFlags.canCopy, click: () => { contents.copy() } },
          { label: chinese ? '全选' : 'Select All', accelerator: 'CmdOrCtrl+A', enabled: params.editFlags.canSelectAll, click: () => { contents.selectAll() } },
        )
      }
      if (params.linkURL !== '') {
        addSeparator()
        template.push(
          { label: chinese ? '打开链接' : 'Open Link', click: () => { openExternal(params.linkURL) } },
          { label: chinese ? '复制链接' : 'Copy Link', click: () => { clipboard.writeText(params.linkURL) } },
        )
      }
      if (params.mediaType === 'image') {
        addSeparator()
        template.push({
          label: chinese ? '复制图片' : 'Copy Image',
          click: () => { contents.copyImageAt(params.x, params.y) },
        })
      }
      const window = BrowserWindow.fromWebContents(contents)
      if (window === null || window.isDestroyed()) return
      Menu.buildFromTemplate(template).popup({ window, x: params.x, y: params.y })
    })
  }


  function createMainWindow(): BrowserWindow {
    let targetNavigationSucceeded = false
    let mainWindow: BrowserWindow | null = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1024,
      minHeight: 680,
      title: 'DSH Desktop',
      backgroundColor: windowBackgroundColor(),
      // The official Web UI carries its own header; a hiddenInset title bar
      // would overlap it. The standard title bar keeps the traffic lights away
      // from the page on macOS and renders the official icon on Windows/Linux.
      titleBarStyle: 'default',
      icon: options.windowIcon(),
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      },
    })
    installPageContextMenu(mainWindow.webContents)
    // Re-hooked with every window: a rebuilt window is a new HWND, and the tray
    // outlives both, so the old hook would leave the glyph stuck after a recovery.
    watchTaskbarTheme(mainWindow)
    mainWindow.once('ready-to-show', () => { mainWindow?.show() })
    mainWindow.on('show', () => { scheduleWindowHealthCheck('window shown') })
    mainWindow.on('focus', () => {
      scheduleWindowHealthCheck('window focused')
      clearMacNotificationAttention()
    })
    mainWindow.on('close', (event) => {
      // Keep the Web UI renderer alive in the tray so its notification plugin
      // can keep observing long-running sessions. A real quit sets `quitting`
      // in before-quit and passes through; installer handoff must pass too.
      if (process.platform !== 'win32' || options.getQuitting() || isInstallerHandoff()) return
      event.preventDefault()
      mainWindow?.hide()
    })
    mainWindow.on('closed', () => {
      mainWindow = null
      onMainWindowClosed()
      markMainWindowUnrequested()
    })
    // The official Web UI is loaded; anything it tries to open elsewhere goes
    // to the system browser, and no new windows exist.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    // The window must stay inside the active Web UI origin. Both events matter:
    // will-navigate covers a navigation the page starts, will-redirect covers the
    // server-side 30x that follows one — an open redirect on the target origin
    // would otherwise land a third-party document in the window that carries the
    // desktop preload. Unknown target = deny: during startup and reconnection
    // there is no origin to be inside of.
    const guardNavigation = (event: Electron.Event, targetUrl: string): void => {
      // The client's own loading and failure surfaces are data: documents, and
      // they arrive through loadURL, which emits no navigation event at all.
      // Chromium already refuses a page-initiated top-level data: navigation, so
      // this branch is a second lock on a door the engine keeps shut: allow only
      // while one of those surfaces is the one on screen, and never hand a data:
      // URL to the system browser.
      if (targetUrl.startsWith('data:')) {
        if (options.getLoadingDocumentActive() || options.getErrorDocumentActive()) return
        event.preventDefault()
        return
      }
      const allowedTarget = currentTarget()
      if (allowedTarget !== undefined && appOrigin(targetUrl) === appOrigin(allowedTarget)) return
      // Follow the configured server's own HTTPS upgrade rather than bouncing
      // the user to a browser: the target moves with it, so the bridge's origin
      // check keeps matching the document actually on screen.
      if (allowedTarget !== undefined && options.getConnection().configuredTarget === allowedTarget && isSecureUpgrade(allowedTarget, targetUrl)) {
        options.getConnection().upgradeConfiguredTarget(targetUrl)
        console.log('[desktop] target upgraded to HTTPS: ' + options.getConnection().configuredTarget)
        return
      }
      event.preventDefault()
      openExternal(targetUrl)
    }
    mainWindow.webContents.on('will-navigate', guardNavigation)
    // will-navigate is main-frame only, but will-redirect fires for every frame.
    // Guarding sub-frames would cancel an ordinary cross-origin 302 inside an
    // iframe — an OAuth callback, an embedded preview — and pop the system
    // browser for it. Only the top frame carries the preload, so only the top
    // frame is what this guard is protecting.
    mainWindow.webContents.on('will-redirect', (event, targetUrl, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      guardNavigation(event, targetUrl)
    })
    mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        targetNavigationSucceeded = false
        resetSettingsIntegrationStatus()
      }
    })
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== ',' || input.alt || input.shift) return
      if (!(process.platform === 'darwin' ? input.meta : input.control)) return
      if (!settingsServerReady()) return
      event.preventDefault()
      openSettingsWindow()
    })
    // An unreachable Web UI (connect mode) must not strand the user: offer
    // retry or the connection-settings window.
    mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || options.getQuitting() || code === -3 || failedUrl.startsWith('data:')) return // -3 = ERR_ABORTED
      if (options.getConnection().probeConnected && appOrigin(failedUrl) === appOrigin(currentTarget() ?? '')) {
        // Re-probe before falling back: a live-but-briefly-busy instance must
        // not get a second writer spawned beside it.
        void handleProbedInstanceFailure('load failed: ' + description)
        return
      }
      // A mode change can leave one late failure event from the old origin.
      if (appOrigin(failedUrl) !== appOrigin(currentTarget() ?? '')) return
      showConnectionError({ kind: 'load', url: failedUrl, code, description })
    })
    // A 4xx/5xx navigation is NOT a load failure to Chromium: the response has a
    // body, so the window would otherwise display the server's own error page
    // (an nginx "400 The plain HTTP request was sent to HTTPS port", say) as if
    // it were the app, with no way back. The status is the failure.
    mainWindow.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      releaseSmartBridgeHandoff(url)
      const target = currentTarget()
      if (!options.getQuitting() && !url.startsWith('data:') && httpResponseCode < 400
        && target !== undefined && appOrigin(url) === appOrigin(target)) {
        targetNavigationSucceeded = true
        options.getConnection().resetProbeRecovery()
      }
      if (options.getQuitting() || url.startsWith('data:') || httpResponseCode < 400) return
      if (target === undefined || appOrigin(url) !== appOrigin(target)) return
      // Even for a reused instance, an HTTP error proves the server is alive.
      // Show the error and offer retry; spawning a fallback could add a second
      // writer. The health probe handles an instance that actually goes away.
      showConnectionError({ kind: 'http', url, status: httpResponseCode, statusText: httpStatusText })
    })
    // Updating is background work, not part of getting the runtime onto the
    // screen. Wait until the official Web UI has actually loaded: local mode
    // reaches this only after dsh readiness, and Connect mode only after its
    // configured page responds. Reloads and reconnects are deduplicated by the
    // scheduler below.
    mainWindow.webContents.on('did-finish-load', () => {
      // Every finished document, before the update-check gate below returns:
      // this is the one event that reports the failure surface has actually
      // landed, and its seats are dead until they are bound.
      if (options.getErrorDocumentActive() && mainWindow !== null) bindErrorPageSeats(mainWindow)
      releaseSmartBridgeHandoff(mainWindow?.webContents.getURL() ?? '')
      if (!targetNavigationSucceeded) return
      const target = currentTarget()
      if (target === undefined) return
      const loaded = mainWindow?.webContents.getURL() ?? ''
      if (appOrigin(loaded) === appOrigin(target)) {
        markWebUiLoaded()
        scheduleAutoUpdateCheck()
      }
    })
    // Chromium may lose its renderer after sleep or resource pressure without a
    // did-fail-load event. Reloading the surviving Web UI origin recreates it.
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.warn('[desktop] renderer process gone:', details.reason, details.exitCode)
      void recoverBlankWindow('renderer ' + details.reason, true)
    })
    let rendererUnresponsive = false
    mainWindow.on('unresponsive', () => {
      rendererUnresponsive = true
      setTimeout(() => {
        if (rendererUnresponsive) void recoverBlankWindow('renderer unresponsive', true)
      }, 30_000).unref()
    })
    mainWindow.on('responsive', () => { rendererUnresponsive = false })
    markLoadingDocument()
    resetPageAppearance()
    void mainWindow.loadURL(loadingPageUrl()).catch(() => { })
    scheduleLoadingHints()
    return mainWindow
  }
  return { createMainWindow, installPageContextMenu }
}
