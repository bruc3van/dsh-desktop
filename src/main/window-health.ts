import { BrowserWindow } from 'electron'
import type { createConnectionController } from './connection-controller.ts'
import type { WebUiProbeResult } from './web-ui-probe.ts'
interface Options {
  getMainWindow: () => BrowserWindow | null
  currentTarget: () => string | undefined
  getQuitting: () => boolean
  getConnection: () => Readonly<Pick<ReturnType<typeof createConnectionController>, "probeConnected" | "generation">>
  probeWithGrace: (base: string) => Promise<WebUiProbeResult>
  refuseUnauthenticatedProbeTarget: (url: string) => void
  fallbackFromProbedInstance: (reason: string) => boolean
  probeWebUi: (base: string, timeoutMs?: number) => Promise<string | undefined>
}

export function createWindowHealth(options: Options) {
  const { currentTarget, probeWithGrace, refuseUnauthenticatedProbeTarget, fallbackFromProbedInstance, probeWebUi } = options

  /** Avoid concurrent health probes and reload loops after sleep/wake churn. */
  let windowRecoveryInFlight = false

  let lastAutomaticReloadAt = 0

  const AUTOMATIC_RELOAD_COOLDOWN_MS = 30_000


  /** The official UI always renders visible text; an empty body after settling is a blank renderer. */
  async function hasVisiblePageContent(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return true
    try {
      return await window.webContents.executeJavaScript(`(() => {
      const body = document.body
      if (document.readyState !== 'complete' || body === null) return true
      const rect = body.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (body.innerText || '').trim().length > 0
    })()`, true) as boolean
    } catch {
      return false
    }
  }


  /**
   * Recover a renderer that went blank after a long idle or system resume.
   * Two DOM samples avoid reloading a page during a normal React transition;
   * the runtime probe prevents turning a temporary server outage into a loop.
   */
  async function recoverBlankWindow(reason: string, force = false): Promise<void> {
    const window = options.getMainWindow()
    const target = currentTarget()
    if (window === null || target === undefined || window.isDestroyed() || options.getQuitting() || windowRecoveryInFlight) return
    if (Date.now() - lastAutomaticReloadAt < AUTOMATIC_RELOAD_COOLDOWN_MS) return
    if (!force && (window.isMinimized() || !window.isVisible())) return

    windowRecoveryInFlight = true
    try {
      // A reused local instance is an optimization, not a durable dependency.
      // Probe it even while the renderer still contains stale visible content,
      // but with a grace window: a busy instance must not be replaced by a
      // second writer (see handleProbedInstanceFailure).
      if (options.getConnection().probeConnected) {
        const generation = options.getConnection().generation
        const probe = await probeWithGrace(target)
        if (probe.kind !== 'verified') {
          if (generation === options.getConnection().generation && options.getConnection().probeConnected && currentTarget() === target) {
            if (probe.kind === 'authentication-required') refuseUnauthenticatedProbeTarget(probe.url)
            else fallbackFromProbedInstance(reason)
          }
          return
        }
        // The instance is alive. A renderer that died or went blank is rebuilt
        // against the surviving origin — the same recovery the local branch
        // gets, so a probed instance is not stuck with a dead window.
        if (!force && await hasVisiblePageContent(window)) return
        if (!force) {
          await new Promise(resolve => setTimeout(resolve, 2_000))
          if (window !== options.getMainWindow() || await hasVisiblePageContent(window)) return
        }
        if (window !== options.getMainWindow() || window.isDestroyed()) return
        lastAutomaticReloadAt = Date.now()
        console.warn('[desktop] reloading blank Web UI (' + reason + ')')
        window.webContents.reload()
        return
      }
      if (!force && await hasVisiblePageContent(window)) return
      if (!force) {
        await new Promise(resolve => setTimeout(resolve, 2_000))
        if (window !== options.getMainWindow() || await hasVisiblePageContent(window)) return
      }
      if (await probeWebUi(target) === undefined || window !== options.getMainWindow() || window.isDestroyed()) return

      lastAutomaticReloadAt = Date.now()
      console.warn('[desktop] reloading blank Web UI (' + reason + ')')
      window.webContents.reload()
    } finally {
      windowRecoveryInFlight = false
    }
  }


  /** Check only a visible window; hidden tray sessions must not be refreshed in the background. */
  function scheduleWindowHealthCheck(reason: string, delayMs = 1_000): void {
    setTimeout(() => { void recoverBlankWindow(reason) }, delayMs).unref()
  }
  return { recoverBlankWindow, scheduleWindowHealthCheck }
}
