import { preflightMacUpdate, prepareMacUpdate } from './mac-update.ts'
import { mainContentHeightScript } from './window-content.ts'
import { app, BrowserWindow, dialog, net, shell } from 'electron'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { type ClientSettings } from './client-settings.ts'
import { devFlag } from './development-options.ts'
import { renderUpdatePromptPageUrl } from './pages/update.ts'
import { renderReleaseNotes } from './release-notes.ts'
import {
  AUTO_CHECK_DELAY_MS,
  defaultGithubApiUrl,
  defaultUpdateFeedUrl,
  describeFetchError,
  DesktopUpdater,
  manualCheckAnswer,
  RELEASES_PAGE_URL,
  type UpdateInfo,
  type UpdateState
} from './updater.ts'
import type { WebUiManager } from './web-ui-manager.ts'
interface Options {
  loadSettings: () => ClientSettings
  patchSettings: (patch?: Partial<ClientSettings>, unset?: readonly (keyof ClientSettings)[]) => void
  desktopClientVersion: () => string
  clientHome: () => string
  getMainWindow: () => BrowserWindow | null
  mainWindowShowsRemote: () => boolean
  refreshTrayMenu: () => void
  localeChinese: () => boolean
  loadingIconTag: () => string
  windowIcon: () => string
  windowBackgroundColor: () => string
  getDesktopUpdater: () => DesktopUpdater | undefined
  openExternal: (url: string) => void
  launchWindow: (generation?: number, force?: boolean) => void
  getQuitting: () => boolean
  getWebUiEverLoaded: () => boolean
  getWebUi: () => Pick<WebUiManager, 'stop'> | undefined
}

export function createUpdateController(services: Options) {
  const { loadSettings, patchSettings, desktopClientVersion, clientHome, mainWindowShowsRemote, refreshTrayMenu, localeChinese, loadingIconTag, windowBackgroundColor, openExternal, launchWindow } = services

  /**
   * Set from the moment an installer is about to be handed this process
   * tree until the client exits. The relaunch ladder must not fire in that
   * window: the runtime was stopped on purpose, and a child respawned 250ms
   * later is precisely the orphan the stop exists to prevent — the installer
   * kills this app by name, which does not match a `node.exe` runtime child.
   * Cleared only when the installer turns out not to have started at all.
   */
  let installerHandoff = false


  function loadUpdatePersistence(): { dismissedVersion?: string; lastCheckedAt?: number } {
    const settings = loadSettings()
    return {
      ...settings.updateDismissedVersion !== undefined && { dismissedVersion: settings.updateDismissedVersion },
      ...settings.updateLastCheckedAt !== undefined && { lastCheckedAt: settings.updateLastCheckedAt },
    }
  }


  function saveUpdatePersistence(next: { dismissedVersion?: string; lastCheckedAt?: number }): void {
    const unset: (keyof ClientSettings)[] = []
    if (next.dismissedVersion === undefined) unset.push('updateDismissedVersion')
    patchSettings({
      ...next.dismissedVersion !== undefined && { updateDismissedVersion: next.dismissedVersion },
      ...next.lastCheckedAt !== undefined && { updateLastCheckedAt: next.lastCheckedAt },
    }, unset)
  }


  /**
   * The updater's transport. Node's own fetch talks to the network directly: it
   * ignores the system proxy (and any PAC script) and trusts only its built-in CA
   * list. That is how a Windows machine could read the update feed — the API host
   * it happens to reach — and then fail the installer download with a bare "fetch
   * failed", since the release assets live on a different host that only the
   * configured proxy or the OS trust store can reach.
   *
   * Chromium's stack knows all of that, so net.fetch goes first. Node's fetch
   * stays as the fallback for whatever net refuses outright, and the fallback is
   * skipped once the caller has aborted — a timeout must not start a second
   * request behind it.
   */
  const updaterFetch: typeof fetch = async (input, init) => {
    const target = input instanceof URL ? input.href : input
    try {
      // Chromium's stack owns a cookie jar; Node's fetch does not. An update feed
      // and an installer download need no identity, so the transport swap must
      // not start sending the session's cookies to GitHub.
      return await net.fetch(target as string | Request, { credentials: 'omit', ...init })
    } catch (error) {
      if (init?.signal?.aborted === true) throw error
      console.log('[desktop] update transport fell back to node fetch: ' + describeFetchError(error))
      return await fetch(input, init)
    }
  }


  function createDesktopUpdater(): DesktopUpdater {
    // Same gate as devOverride(): the packaged client keeps its own feed, its own
    // timeouts, and its own answer to "should I check at all".
    const allowEnvOverrides = !app.isPackaged || process.env.DSH_DESKTOP_ALLOW_UNSAFE === '1'
    return new DesktopUpdater({
      fetchImpl: updaterFetch,
      currentVersion: desktopClientVersion(),
      feedUrl: defaultUpdateFeedUrl(allowEnvOverrides),
      githubApiUrl: defaultGithubApiUrl(allowEnvOverrides),
      allowEnvOverrides,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      downloadDir: join(clientHome(), 'updates'),
      preflightMac: async () => { await preflightMacUpdate(process.execPath, localeChinese()) },
      installMac: async (file, version) => {
        // Preparation cleans its own staging directory if it fails.
        const prepared = await prepareMacUpdate(file, process.execPath, version, localeChinese())
        try {
          await beginInstallerHandoff()
          await prepared.start()
        } catch (error) {
          await prepared.dispose()
          throw error
        }
      },
      loadPersistence: loadUpdatePersistence,
      savePersistence: saveUpdatePersistence,
      dryRun: devFlag('DSH_DESKTOP_UPDATE_DRY_RUN'),
      // The runtime must not outlive this app into the installer's process
      // sweep, and must not die before the download that may never succeed.
      // Both constraints meet at exactly this point in the install.
      //
      // macOS stops the runtime in installMac, after staging and verification.
      // Linux still opens the installer without stopping the runtime here.
      onBeforeInstall: async () => {
        if (process.platform !== 'win32') return
        await beginInstallerHandoff()
      },
    })
  }


  let lastTrayUpdateSignature = ''


  /**
   * The update state as a remote page may see it. `error` is whatever the
   * download, the SHA-256 check, or the installer threw, and those routinely
   * name absolute paths on this machine; `phase` already tells the page that
   * something failed, and the card falls back to its own wording when the
   * reason is absent. Same rule as `getStatusJson`'s `includeLocalDetail`.
   */
  function updateStateForCaller(state: UpdateState, remote: boolean): UpdateState {
    if (!remote || state.error === null) return state
    return { ...state, error: localeChinese() ? '更新失败，请在桌面设置中查看详情' : 'Update failed. Open desktop settings for details.' }
  }



  function broadcastUpdateState(state: UpdateState): void {
    const mainWindow = services.getMainWindow()
    if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('desktop:update:changed', updateStateForCaller(state, mainWindowShowsRemote()))
    }
    const signature = [
      state.phase,
      state.info?.availableVersion ?? '',
      state.dismissed ? '1' : '0',
      state.error ?? '',
    ].join('\0')
    if (signature === lastTrayUpdateSignature) return
    lastTrayUpdateSignature = signature
    refreshTrayMenu()
  }



  function updateDialogCopy(): {
    found: string
    latest: string
    unsupported: string
    unsupportedDetail: string
    releases: string
    later: string
    ignore: string
    install: string
    failed: string
    checking: string
    downloading: string
    installing: string
    restart: string
  } {
    if (localeChinese()) {
      return {
        found: '发现新版本',
        latest: '已是最新版本',
        later: '稍后',
        ignore: '忽略此版本',
        install: '下载并安装',
        failed: '检查更新失败',
        unsupported: '已有更新版本，但没有本平台的安装包',
        unsupportedDetail: '这次发布没有为本平台构建安装包。发布页可以确认该版本覆盖了哪些平台。',
        releases: '打开发布页',
        checking: '正在检查更新…',
        downloading: '正在下载新版本…',
        installing: process.platform === 'darwin' ? '正在验证并准备更新，随后将自动重启…' : '正在启动安装程序…',
        restart: process.platform === 'darwin' ? '即将退出并自动重启…' : '请安装新版本后重新打开应用',
      }
    }
    return {
      found: 'A new version is available',
      latest: 'You are on the latest version',
      later: 'Later',
      ignore: 'Skip this version',
      install: 'Download and install',
      failed: 'Could not check for updates',
      unsupported: 'A newer version exists, but not for this platform',
      unsupportedDetail: 'That release was not built for this platform. The releases page shows which platforms it covers.',
      releases: 'Open the releases page',
      checking: 'Checking for updates…',
      downloading: 'Downloading the new version…',
      installing: process.platform === 'darwin' ? 'Verifying and preparing the update; the app will restart…' : 'Starting the installer…',
      restart: process.platform === 'darwin' ? 'The app will quit and restart automatically…' : 'Install the new copy, then reopen the app',
    }
  }


  let updatePromptWindow: BrowserWindow | null = null


  /**
   * The update prompt is one of the client's own surfaces, so it uses the same
   * restrained type, spacing, buttons, and dark-mode palette as connection
   * settings. Keeping release notes in a bounded reading pane prevents a long
   * changelog from turning a decision into a full-screen wall of text.
   */
  function updatePromptPageUrl(info: UpdateInfo): string {
    return renderUpdatePromptPageUrl(info, localeChinese(), loadingIconTag(), updateDialogCopy())
  }


  function showUpdateAvailableDialog(info: UpdateInfo): void {
    const mainWindow = services.getMainWindow()
    const desktopUpdater = services.getDesktopUpdater()
    if (devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
    if (updatePromptWindow !== null && !updatePromptWindow.isDestroyed()) {
      updatePromptWindow.focus()
      return
    }
    const owner = mainWindow
    const prompt = new BrowserWindow({
      width: 580,
      height: 590,
      minWidth: 520,
      minHeight: 460,
      maxWidth: 720,
      title: localeChinese() ? '应用更新' : 'App update',
      icon: services.windowIcon(),
      resizable: true,
      minimizable: false,
      maximizable: false,
      backgroundColor: windowBackgroundColor(),
      show: false,
      ...(owner !== null && !owner.isDestroyed() ? { parent: owner, modal: true } : {}),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    updatePromptWindow = prompt
    // Start with enough room for the longest supported notes, then shrink the
    // hidden window to its natural content height. The footer remains at the
    // bottom and a short changelog does not leave a blank half-window below it.
    prompt.webContents.once('did-finish-load', () => {
      const measure = mainContentHeightScript(560)
      void prompt.webContents.executeJavaScript(measure, true)
        .then((height: unknown) => {
          if (prompt.isDestroyed() || typeof height !== 'number') return
          const width = prompt.getContentSize()[0] ?? 580
          prompt.setContentSize(width, Math.max(430, Math.min(560, height)))
        })
        .catch(() => { })
        .finally(() => { if (!prompt.isDestroyed()) prompt.show() })
    })
    prompt.on('closed', () => { if (updatePromptWindow === prompt) updatePromptWindow = null })
    prompt.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') prompt.close()
    })
    const handleAction = (targetUrl: string): boolean => {
      if (!targetUrl.startsWith('dsh-update-action:')) return false
      const action = targetUrl.slice('dsh-update-action:'.length)
      prompt.close()
      if (action === 'ignore') {
        desktopUpdater?.dismiss()
        return true
      }
      if (action === 'install') void installDesktopUpdate().then((installed) => {
        if (installed.started) scheduleQuitAfterWindowsInstall()
      })
      return true
    }
    prompt.webContents.setWindowOpenHandler(({ url }) => {
      handleAction(url)
      if (/^https?:\/\//i.test(url)) openExternal(url)
      return { action: 'deny' }
    })
    prompt.webContents.on('will-navigate', (event, targetUrl) => {
      event.preventDefault()
      if (!handleAction(targetUrl) && /^https?:\/\//i.test(targetUrl)) openExternal(targetUrl)
    })
    void prompt.loadURL(updatePromptPageUrl(info)).catch(() => { prompt.close() })
  }


  async function handleManualUpdateCheck(prompt: boolean): Promise<void> {
    const mainWindow = services.getMainWindow()
    const desktopUpdater = services.getDesktopUpdater()
    if (desktopUpdater === undefined) return
    const busyPhase = desktopUpdater.getState().phase
    if (busyPhase === 'downloading' || busyPhase === 'installing' || busyPhase === 'restartRequired') {
      if (!prompt || devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
      const copy = updateDialogCopy()
      // Say what is actually running: this branch is reached only while a
      // download, an install, or a finished install is holding the updater, and
      // "checking for updates" would describe none of them.
      const busyMessage = busyPhase === 'downloading'
        ? copy.downloading
        : busyPhase === 'installing' ? copy.installing : copy.restart
      const options: Electron.MessageBoxOptions = {
        type: 'info',
        title: 'DSH Desktop',
        message: busyMessage,
        buttons: ['OK'],
      }
      const owner = mainWindow
      if (owner === null || owner.isDestroyed()) void dialog.showMessageBox(options)
      else void dialog.showMessageBox(owner, options)
      return
    }
    desktopUpdater.resetDismiss()
    const result = await desktopUpdater.check()
    if (!prompt || devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
    const copy = updateDialogCopy()
    if (result.hasUpdate) {
      showUpdateAvailableDialog(result.info)
      return
    }
    const state = desktopUpdater.getState()
    // Three answers here, not two. "Nothing newer exists" and "something newer
    // exists that this platform has no installer for" are both hasUpdate:false,
    // and telling the second one it is up to date is precisely the lie
    // `unsupportedPlatform` was added to stop — on this dialog as much as on the
    // settings page. It is also the only answer with somewhere to go, so it is
    // the only one that offers a second button.
    const answer = manualCheckAnswer(state.phase)
    const unsupported = answer === 'unsupportedPlatform'
    const options: Electron.MessageBoxOptions = {
      type: answer === 'failed' ? 'error' : 'info',
      title: 'DSH Desktop',
      message: answer === 'failed' ? copy.failed : unsupported ? copy.unsupported : copy.latest,
      ...state.error !== null && { detail: state.error },
      ...unsupported && { detail: copy.unsupportedDetail, defaultId: 0, cancelId: 1 },
      buttons: unsupported ? [copy.releases, 'OK'] : ['OK'],
    }
    const owner = mainWindow
    const answered = owner === null || owner.isDestroyed()
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(owner, options)
    // The page opens in the system browser, so this process is done either way;
    // a dialog dismissed by the platform itself simply answers nothing.
    void answered.then(({ response }) => {
      if (unsupported && response === 0) openExternal(RELEASES_PAGE_URL)
    }, () => { })
  }


  /**
   * Hand this process tree over to the Windows installer. Quitting waits
   * briefly on one thing first: an installer that starts and then dies
   * immediately (a SmartScreen refusal, another installer holding its mutex)
   * leaves the runtime stopped and, without this watch, an app that has
   * already quit — no error, no way back. A quick non-zero exit is caught and
   * recovered; an installer still running past the watch owns the machine from
   * here, and the client quits as before. The ShellExecute fallback (a spawn
   * that needed elevation) has no handle to watch: it reports a clean handoff
   * and this quits immediately.
   */
  function scheduleQuitAfterWindowsInstall(): void {
    const desktopUpdater = services.getDesktopUpdater()
    if (process.platform !== 'win32' || devFlag('DSH_DESKTOP_UPDATE_DRY_RUN')) return
    const timer = setTimeout(() => { app.quit() }, 5_000)
    timer.unref()
    const outcome = desktopUpdater?.installerOutcome()
    if (outcome === undefined) return
    void outcome.then(({ code }) => {
      clearTimeout(timer)
      if (code !== null && code !== 0) {
        console.warn('[desktop] the Windows installer exited early with code ' + String(code) + '; restoring the local runtime')
        installerHandoff = false
        desktopUpdater?.recoverInstallerFailure(code)
        launchWindow()
        return
      }
      // The installer finished (or left cleanly) on its own; quit regardless.
      app.quit()
    })
  }


  async function installDesktopUpdate(): Promise<{ started: boolean; error?: string }> {
    const desktopUpdater = services.getDesktopUpdater()
    if (desktopUpdater === undefined) return { started: false, error: 'updater not ready' }
    const result = await desktopUpdater.install()
    // The installer never ran (a failed spawn, a declined elevation), so nothing
    // is going to sweep this process tree and nothing is going to quit. Lift the
    // suppression and give the client its runtime back rather than leaving a
    // working app with no service behind it.
    if (!result.started && installerHandoff) {
      installerHandoff = false
      console.warn('[desktop] the installer did not start; restoring the local runtime')
      launchWindow()
    }
    if (result.started && process.platform === 'darwin' && !devFlag('DSH_DESKTOP_UPDATE_DRY_RUN')) app.quit()
    return result
  }


  /**
   * The bundle this client installed as before it was renamed to "DSH Desktop".
   *
   * A macOS update is a Finder drag, and Finder replaces by FILE NAME — so the
   * first release carrying the new name lands BESIDE the old bundle instead of
   * over it. Nothing breaks: both carry the same bundle id and read the same
   * two data homes, so settings, conversations and credentials are shared. What
   * the user is left with is two applications, and a Dock icon that still opens
   * the version they believed they had just replaced.
   */
  const LEGACY_MAC_BUNDLE = '/Applications/DeepSeek Harness Desktop.app'


  /** Whether a pre-rename install is still sitting beside this one. */
  function legacyMacBundleLeftBehind(): boolean {
    // Packaged only: a development run is not an install, and has no predecessor
    // to have replaced.
    if (process.platform !== 'darwin' || !app.isPackaged) return false
    // Not when this IS that bundle. A user who has not yet moved to a renamed
    // build would otherwise be told to delete the copy they are running.
    if (app.getPath('exe').startsWith(LEGACY_MAC_BUNDLE + '/')) return false
    try {
      return statSync(LEGACY_MAC_BUNDLE).isDirectory()
    } catch {
      return false
    }
  }


  /**
   * Say it once, and never delete anything.
   *
   * Removing an application the user installed is not a step a client takes on
   * its own — and "reveal it in Finder" is the step they would take next anyway,
   * so it is the one offered. The notice is recorded as shown BEFORE the dialog
   * rather than after an answer: a migration aid that reappears every launch
   * until the folder is tidy reads as nagging, and the release notes carry the
   * same instruction for anyone who dismisses it.
   */
  function promptLegacyMacBundle(): void {
    const mainWindow = services.getMainWindow()
    if (!legacyMacBundleLeftBehind()) return
    if (loadSettings().legacyBundleNoticeShown === true) return
    patchSettings({ legacyBundleNoticeShown: true })
    const chinese = localeChinese()
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'DSH Desktop',
      message: chinese ? '「应用程序」里还留着旧版本' : 'An older copy is still in Applications',
      detail: chinese
        ? '本客户端已更名为「DSH Desktop」，你正在运行的就是它。\n'
        + '更名前的「DeepSeek Harness Desktop」还留在「应用程序」里，可以删掉了——'
        + '两者共用同一份设置和会话记录，删除旧的不会丢任何数据。'
        : 'This client is now called DSH Desktop, and that is what you are running.\n'
        + 'The pre-rename “DeepSeek Harness Desktop” is still in Applications and can be '
        + 'deleted — both read the same settings and conversations, so removing the old '
        + 'copy loses nothing.',
      buttons: chinese ? ['在访达中显示', '稍后'] : ['Show in Finder', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }
    const owner = mainWindow
    const shown = owner === null || owner.isDestroyed()
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(owner, options)
    void shown.then((answer) => {
      if (answer.response === 0) shell.showItemInFolder(LEGACY_MAC_BUNDLE)
    })
  }


  /**
   * Hold the notice until there is a window to attach it to. A sheet on a window
   * that has not been shown yet is a sheet nobody sees, and the client paints
   * its first window before the runtime is anywhere near ready.
   */
  function scheduleLegacyBundleNotice(): void {
    const mainWindow = services.getMainWindow()
    if (!legacyMacBundleLeftBehind()) return
    const window = mainWindow
    if (window === null || window.isDestroyed() || window.isVisible()) {
      promptLegacyMacBundle()
      return
    }
    window.once('show', promptLegacyMacBundle)
  }


  let autoUpdateCheckScheduled = false


  /**
   * Queue the one automatic check only after the official Web UI is usable.
   * A tray-resident session can run for days without a single reload, and the
   * 12-hour throttle would then never be asked again — the hourly re-ask below
   * gives the throttle the chance to say yes without checking on its own.
   */
  function scheduleAutoUpdateCheck(): void {
    const desktopUpdater = services.getDesktopUpdater()
    if (autoUpdateCheckScheduled || desktopUpdater === undefined || !desktopUpdater.shouldAutoCheck()) return
    autoUpdateCheckScheduled = true
    setTimeout(() => {
      autoUpdateCheckScheduled = false
      const updater = desktopUpdater
      if (services.getQuitting() || updater === undefined) return
      void updater.check().then((result) => {
        if (!result.hasUpdate || updater.getState().dismissed) return
        showUpdateAvailableDialog(result.info)
      })
    }, AUTO_CHECK_DELAY_MS).unref()
  }


  /** The throttle (persisted last-checked time) decides; this interval re-asks. */
  function schedulePeriodicAutoUpdateChecks(): void {
    const timer = setInterval(() => {
      if (services.getWebUiEverLoaded()) scheduleAutoUpdateCheck()
    }, 60 * 60 * 1000)
    timer.unref()
  }


  /**
   * The update state as the client's own settings page consumes it. Release
   * notes are Markdown; the page has no renderer, so the HTML is produced here
   * (escaped, closed subset) and travels beside the source text.
   */
  function updateStateForPage(state: UpdateState): UpdateState & { notesHtml: string } {
    return { ...state, notesHtml: renderedNotesHtml(state.info?.notes ?? '') }
  }


  let notesHtmlCache: { source: string; html: string } = { source: '', html: '' }


  /** The page polls several times a second during a download; render once. */
  function renderedNotesHtml(source: string): string {
    if (notesHtmlCache.source !== source) {
      notesHtmlCache = { source, html: renderReleaseNotes(source) }
    }
    return notesHtmlCache.html
  }


  function pageUpdateState(): (UpdateState & { notesHtml: string }) | undefined {
    const desktopUpdater = services.getDesktopUpdater()
    const state = desktopUpdater?.getState()
    return state === undefined ? undefined : updateStateForPage(state)
  }


  async function beginInstallerHandoff(): Promise<void> {
    installerHandoff = true
    await services.getWebUi()?.stop()
  }


  function getUpdatePromptWindow(): BrowserWindow | null { return updatePromptWindow }


  function isInstallerHandoff(): boolean { return installerHandoff }
  return { createDesktopUpdater, updateStateForCaller, broadcastUpdateState, showUpdateAvailableDialog, handleManualUpdateCheck, scheduleQuitAfterWindowsInstall, installDesktopUpdate, scheduleLegacyBundleNotice, scheduleAutoUpdateCheck, schedulePeriodicAutoUpdateChecks, updateStateForPage, renderedNotesHtml, pageUpdateState, getUpdatePromptWindow, isInstallerHandoff }
}
