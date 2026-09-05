import { BrowserWindow, nativeTheme } from 'electron'
import type { BridgeCaller } from './bridge-policy.ts'
interface Options {
  getMainWindow: () => BrowserWindow | null
  getSettingsWindow: () => BrowserWindow | null
  getUpdatePromptWindow: () => BrowserWindow | null
  getClientNoticeWindow: () => BrowserWindow | null
  bridgeCaller: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BridgeCaller
}

export function createWindowTheme(options: Options) {
  const { getUpdatePromptWindow, bridgeCaller } = options


  const WINDOW_BG_DARK = '#17181a'

  const WINDOW_BG_LIGHT = '#FFFFFF'


  type AppearanceMode = 'system' | 'fixed'


  /** Last OS app-theme reading taken while themeSource was still following the system. */
  let osPrefersDark = nativeTheme.shouldUseDarkColors

  /** Official page paint, once the renderer has reported it. */
  let pagePrefersDark: boolean | undefined

  /** Official appearance control: pin only for an explicit light/dark choice. */
  let pageAppearanceMode: AppearanceMode | undefined

  /** themeSource writes emit 'updated'; ignore that echo so we do not loop. */
  let applyingThemeSource = false


  function effectiveWindowDark(): boolean {
    if (pageAppearanceMode === 'fixed') return pagePrefersDark ?? osPrefersDark
    return osPrefersDark
  }


  function windowBackgroundColor(): string {
    return effectiveWindowDark() ? WINDOW_BG_DARK : WINDOW_BG_LIGHT
  }


  function applyWindowBackground(window: BrowserWindow | null, dark: boolean): void {
    if (window === null || window.isDestroyed()) return
    window.setBackgroundColor(dark ? WINDOW_BG_DARK : WINDOW_BG_LIGHT)
  }


  function paintWindowBackgrounds(): void {
    const dark = effectiveWindowDark()
    applyWindowBackground(options.getMainWindow(), dark)
    applyWindowBackground(options.getSettingsWindow(), dark)
    applyWindowBackground(getUpdatePromptWindow(), dark)
    applyWindowBackground(options.getClientNoticeWindow(), dark)
  }


  function refreshOsPrefersDark(): void {
    if (nativeTheme.themeSource === 'system') osPrefersDark = nativeTheme.shouldUseDarkColors
  }


  /**
   * Windows title bar follows Chromium's NativeTheme, not setBackgroundColor.
   * Pin themeSource only when the official control is an explicit light/dark
   * choice. "Follow system" must stay on 'system' so matchMedia still sees
   * the real OS — comparing painted color to OS is how the previous pin
   * wedged that mode.
   */
  function syncThemeSource(): void {
    const want: typeof nativeTheme.themeSource = pageAppearanceMode === 'fixed'
      ? ((pagePrefersDark ?? osPrefersDark) ? 'dark' : 'light')
      : 'system'
    if (nativeTheme.themeSource === want) return
    applyingThemeSource = true
    nativeTheme.themeSource = want
    setImmediate(() => {
      applyingThemeSource = false
      refreshOsPrefersDark()
      paintWindowBackgrounds()
      const mainWindow = options.getMainWindow()
      if (want !== 'system' || mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('desktop:theme:refresh')
    })
  }


  function syncWindowBackgrounds(): void {
    if (applyingThemeSource) return
    refreshOsPrefersDark()
    paintWindowBackgrounds()
    syncThemeSource()
  }


  function onRendererTheme(event: Electron.IpcMainEvent, payload: unknown): void {
    if (!bridgeCaller(event).trusted) return
    if (typeof payload !== 'object' || payload === null) return
    const body = payload as { dark?: unknown; mode?: unknown }
    if (typeof body.dark !== 'boolean') return
    const mode: AppearanceMode = body.mode === 'fixed' ? 'fixed' : 'system'
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === options.getMainWindow()) {
      pagePrefersDark = body.dark
      pageAppearanceMode = mode
      syncThemeSource()
    }
    applyWindowBackground(window, effectiveWindowDark())
  }


  function resetPageAppearance(): void {
    pagePrefersDark = undefined
    pageAppearanceMode = undefined
  }
  return { windowBackgroundColor, syncWindowBackgrounds, onRendererTheme, resetPageAppearance }
}
