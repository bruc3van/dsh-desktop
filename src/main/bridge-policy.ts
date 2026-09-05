import type { BrowserWindow } from 'electron'
import { appOrigin, originIsLoopback } from './connection-policy.ts'
import { permissionGrantedForContext } from './permission-policy.ts'
export interface BridgeCaller {
  /** The main window's top frame, showing an origin this client itself selected. */
  trusted: boolean
  /** The selected page is not owned by this client, even when its address is loopback. */
  remote: boolean
}

interface Options {
  getMainWindow: () => BrowserWindow | null
  getLoadingDocumentActive: () => boolean
  getErrorDocumentActive: () => boolean
  currentTarget: () => string | undefined
  isClientOwnedOrigin: (origin: string) => boolean
}

export function createBridgePolicy(options: Options) {
  const { currentTarget } = options


  /**
   * Loopback origin still painted while a Smart-mode source/port apply has
   * already cleared `currentTarget` (or already named the next child). The
   * injected settings card keeps sending from that document until navigation
   * actually replaces it; without this, a second toggle during the restart
   * is denied as "sender is not the active Web UI".
   */
  let smartBridgeHandoffOrigin: string | undefined


  /** Who is calling the desktop bridge, from the main process's point of view. */



  const UNTRUSTED_CALLER: BridgeCaller = { trusted: false, remote: true }


  /**
   * Resolve an IPC sender to a trust decision. The preload rides on whatever the
   * window loads, and in Connect mode that is an address the user typed — a page
   * served there must not be able to silently repoint the client or start an
   * installer. Only the main window's TOP frame, showing the origin the client
   * currently targets (or the client's own loading document), may drive the
   * bridge; an origin without client ownership is additionally treated as remote, which
   * costs it the local details and adds a native confirmation to state changes.
   */
  function bridgeCaller(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BridgeCaller {
    const mainWindow = options.getMainWindow()
    if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return UNTRUSTED_CALLER
    let frameUrl: string
    try {
      const frame = event.senderFrame
      // Sub-frames do not receive this preload today; deny explicitly so that
      // stays true if nodeIntegrationInSubFrames is ever turned on.
      if (frame === null || frame.parent !== null) return UNTRUSTED_CALLER
      frameUrl = frame.url
    } catch {
      // The frame was destroyed between send and dispatch.
      return UNTRUSTED_CALLER
    }
    if (frameUrl.startsWith('data:')) return { trusted: options.getLoadingDocumentActive() || options.getErrorDocumentActive(), remote: false }
    const origin = appOrigin(frameUrl)
    if (origin === '') return UNTRUSTED_CALLER
    const target = currentTarget()
    if (target !== undefined && origin === appOrigin(target)) {
      return { trusted: true, remote: !options.isClientOwnedOrigin(origin) }
    }
    // Source / port apply stops the child before the window leaves the previous
    // loopback UI. A remote Connect page left on screen after the target moved
    // stays untrusted; only that handoff origin may keep driving the bridge.
    if (smartBridgeHandoffOrigin !== undefined && origin === smartBridgeHandoffOrigin) {
      return { trusted: true, remote: false }
    }
    return UNTRUSTED_CALLER
  }


  function loopbackPageOrigin(value: string): string | undefined {
    if (value === '' || value.startsWith('data:')) return undefined
    return originIsLoopback(value) ? appOrigin(value) : undefined
  }


  function rememberSmartBridgeHandoff(): void {
    const origin = loopbackPageOrigin(currentTarget() ?? '')
    smartBridgeHandoffOrigin = origin !== undefined && options.isClientOwnedOrigin(origin) ? origin : undefined
  }


  function releaseSmartBridgeHandoff(loadedUrl: string): void {
    if (smartBridgeHandoffOrigin === undefined) return
    if (loadedUrl.startsWith('data:') || appOrigin(loadedUrl) !== smartBridgeHandoffOrigin) {
      smartBridgeHandoffOrigin = undefined
    }
  }


  function bridgeDenied(): Error {
    return new Error('desktop bridge: sender is not the active Web UI')
  }


  /**
   * Whether the sender is one of the client's OWN local documents — the data:
   * loading and connection-failure surfaces in the main window. Reconnecting and
   * quitting are reachable only from there: the same preload rides on a remote
   * page in Connect mode, and that page has no business restarting the client's
   * connection or ending the application.
   */
  function localDocumentCaller(event: Electron.IpcMainEvent): boolean {
    const mainWindow = options.getMainWindow()
    if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
    if (!options.getLoadingDocumentActive() && !options.getErrorDocumentActive()) return false
    try {
      const frame = event.senderFrame
      if (frame === null || frame.parent !== null) return false
      return frame.url.startsWith('data:')
    } catch {
      // The frame was destroyed between send and dispatch.
      return false
    }
  }


  /**
   * Whether the document in the main window is a remote origin. The push channel
   * has no sender to inspect, so it reads the URL actually loaded rather than the
   * target the client is aiming at: during a mode switch the window still shows
   * the old remote page after `currentTarget()` has already moved, and that page
   * is the one about to receive the broadcast. The client's own data: surfaces
   * carry no origin and are not remote.
   */
  function mainWindowShowsRemote(): boolean {
    const mainWindow = options.getMainWindow()
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false
    const url = mainWindow.webContents.getURL()
    // A data: document serializes its opaque origin as the string "null", not
    // an empty one — spell that out rather than letting it fall through as an
    // origin that merely fails the loopback test.
    if (url === '' || url.startsWith('data:')) return false
    const origin = appOrigin(url)
    return origin !== '' && origin !== 'null' && !options.isClientOwnedOrigin(origin)
  }


  /** Whether `contents` is the main window showing the client's current target. */
  function permissionTrustedSurface(contents: Electron.WebContents | null): boolean {
    const mainWindow = options.getMainWindow()
    if (contents === null || mainWindow === null || mainWindow.isDestroyed() || contents !== mainWindow.webContents) return false
    const url = contents.getURL()
    // The client's own data: surfaces (loading, failure) are trusted by
    // definition; everything else must be the origin the client currently
    // targets — the same test the bridge applies to IPC callers.
    if (url === '' || url.startsWith('data:')) return options.getLoadingDocumentActive() || options.getErrorDocumentActive()
    const target = currentTarget()
    return target !== undefined && appOrigin(url) === appOrigin(target)
  }


  /**
   * Permission decisions follow the bridge's trust model but use the requesting
   * frame's URL. Electron passes null WebContents for notification checks and
   * cross-origin sub-frame checks, so WebContents identity alone is neither
   * sufficient nor always available.
   */
  function permissionGranted(
    contents: Electron.WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean {
    const mainWindow = options.getMainWindow()
    const window = mainWindow
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return false
    if (contents !== null && contents !== window.webContents) return false
    return permissionGrantedForContext({
      permission,
      visibleUrl: window.webContents.getURL(),
      targetUrl: currentTarget(),
      requestingUrl,
      isMainFrame,
      clientOwned: options.isClientOwnedOrigin(appOrigin(currentTarget() ?? '')),
    })
  }
  return { bridgeCaller, rememberSmartBridgeHandoff, releaseSmartBridgeHandoff, bridgeDenied, localDocumentCaller, mainWindowShowsRemote, permissionTrustedSurface, permissionGranted }
}
