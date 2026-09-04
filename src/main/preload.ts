/**
 * Desktop client preload: the minimal fixed surface exposed to the official
 * Web UI page, plus the client's own 桌面设置 tab — a nav item injected into
 * the OFFICIAL settings dialog below 通用设置, whose panel carries the
 * connection and app-update cards. Optional: if the official dialog cannot be
 * detected the injection silently does nothing and the official UI is untouched.
 * Runs sandboxed, so only Electron APIs are available.
 *
 * The bridge below is exposed on every document the window loads, which in
 * Connect mode is an address the user typed. It therefore carries no local
 * facts of its own (the OS username used to ride here on an argv flag and was
 * removed — nothing consumed it), and every channel it calls is authorized
 * against the sender's origin in the main process.
 * @module dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import { releaseNotesCss, renderReleaseNotes } from './release-notes.ts'
import { installMacNotificationFallback } from './mac-notification-fallback.ts'
import { installWindowsNotificationActivation } from './windows-notification-activation.ts'

/** Connection facts mirrored from the main process. */
interface ConnectionStatus {
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
  /** Bind port for a client-started dsh. 0 = random. */
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
const connection = {
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
  /** Bind port for a client-started dsh. 0 / blank = random. */
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

interface UpdateState {
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

const update = {
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

/**
 * The official UI owns appearance (light / dark / system). Window chrome
 * still has to match whatever the page is actually painting, including the
 * in-app 深色 control that does not touch nativeTheme.
 */
function parseCssColor(color: string): { r: number; g: number; b: number; a: number } | undefined {
  const value = color.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex.charAt(0) + hex.charAt(0), 16)
      const g = Number.parseInt(hex.charAt(1) + hex.charAt(1), 16)
      const b = Number.parseInt(hex.charAt(2) + hex.charAt(2), 16)
      const a = hex.length === 4 ? Number.parseInt(hex.charAt(3) + hex.charAt(3), 16) / 255 : 1
      return { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
      }
    }
    return undefined
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)(?:\s*[,/]\s*|\s+)([\d.]+)(?:\s*[,/]\s*|\s+)([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
  if (rgb === null) return undefined
  const red = rgb[1]
  const green = rgb[2]
  const blue = rgb[3]
  if (red === undefined || green === undefined || blue === undefined) return undefined
  const alpha = rgb[4]
  return {
    r: Number(red),
    g: Number(green),
    b: Number(blue),
    a: alpha === undefined ? 1 : alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha),
  }
}

function colorIsDark(color: string): boolean | undefined {
  const parsed = parseCssColor(color)
  if (parsed === undefined || Number.isNaN(parsed.r + parsed.g + parsed.b) || parsed.a < 0.5) return undefined
  return (0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b) < 128
}

const THEME_TOKEN_NAMES = ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-0', '--dsw-alias-bg-app']

function themeFrom(el: Element | null): boolean | undefined {
  if (el === null) return undefined
  const style = getComputedStyle(el)
  for (const name of THEME_TOKEN_NAMES) {
    const token = style.getPropertyValue(name).trim()
    const fromToken = token === '' ? undefined : colorIsDark(token)
    if (fromToken !== undefined) return fromToken
  }
  return colorIsDark(style.backgroundColor)
}

/** Whether pageLooksDark's latest answer came from real page paint. */
let pageLookKnown = false

function pageLooksDark(): boolean {
  const root = document.documentElement
  const scheme = getComputedStyle(root).colorScheme
  const hasDark = /\bdark\b/.test(scheme)
  const hasLight = /\blight\b/.test(scheme)
  let look: boolean | undefined
  if (hasDark && !hasLight) look = true
  else if (hasLight && !hasDark) look = false
  if (look === undefined) look = themeFrom(root)
  const body = document.body
  if (look === undefined) look = themeFrom(body)
  if (look === undefined) look = themeFrom(body?.firstElementChild ?? null)
  pageLookKnown = look !== undefined
  return look ?? matchMedia('(prefers-color-scheme: dark)').matches
}

type AppearanceMode = 'system' | 'fixed'

const APPEARANCE_MODE_KEY = 'dsh-desktop-appearance-mode'

function readRememberedAppearanceMode(): AppearanceMode | undefined {
  try {
    const stored = sessionStorage.getItem(APPEARANCE_MODE_KEY)
    return stored === 'system' || stored === 'fixed' ? stored : undefined
  } catch {
    return undefined
  }
}

function writeRememberedAppearanceMode(mode: AppearanceMode): void {
  rememberedAppearanceMode = mode
  try { sessionStorage.setItem(APPEARANCE_MODE_KEY, mode) } catch { /* data: origins / quota */ }
}

let rememberedAppearanceMode: AppearanceMode | undefined = readRememberedAppearanceMode()

function appearanceButtonMode(el: Element): AppearanceMode | undefined {
  const labelled = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, '')
  if (/^(浅色|深色|Light|Dark)$/i.test(labelled)) return 'fixed'
  if (/^(系统|跟随系统|System|Auto|Automatic)$/i.test(labelled)) return 'system'
  return undefined
}

function isAppearancePressed(el: Element): boolean {
  const state = el.getAttribute('data-state')
  return el.getAttribute('aria-pressed') === 'true'
    || el.getAttribute('aria-checked') === 'true'
    || el.getAttribute('aria-selected') === 'true'
    || state === 'on' || state === 'checked' || state === 'active'
}

function appearanceModeFromDialog(): AppearanceMode | undefined {
  const dialog = findSettingsDialog()
  if (dialog === null) return undefined
  let sawFixed = false
  let sawSystem = false
  for (const el of dialog.querySelectorAll('button, [role="button"], [role="radio"]')) {
    const mode = appearanceButtonMode(el)
    if (mode === undefined || !isAppearancePressed(el)) continue
    if (mode === 'system') sawSystem = true
    else sawFixed = true
  }
  if (sawSystem) return 'system'
  if (sawFixed) return 'fixed'
  return undefined
}

/**
 * Prefer the official appearance control over painted color. Color vs
 * matchMedia is only a bootstrap guess, and it is wrong once themeSource is
 * pinned (matchMedia then reports the pin, not the OS): re-reading it after
 * the pin flips the guess to the opposite answer, and the main process
 * pinning/unpinning in response is the fixed ↔ system loop that keeps
 * repainting the Windows window chrome. The guess is therefore taken at most
 * once per document and remembered; an explicit in-app appearance click or
 * an open settings dialog overrides it and re-syncs the memory.
 */
function currentAppearanceMode(dark: boolean): AppearanceMode {
  const fromDialog = appearanceModeFromDialog()
  if (fromDialog !== undefined) {
    writeRememberedAppearanceMode(fromDialog)
    return fromDialog
  }
  if (rememberedAppearanceMode !== undefined) return rememberedAppearanceMode
  // No real paint signal yet: pageLooksDark fell back to matchMedia, so the
  // comparison below is trivially equal and would latch a guess with no
  // information in it (a fixed dark choice the page applies after load would
  // be locked to "system"). Report "system" — it never pins themeSource, so
  // matchMedia keeps reading the real OS and the guess can still be taken
  // correctly once the page actually paints.
  if (!pageLookKnown) return 'system'
  const guessed = dark === matchMedia('(prefers-color-scheme: dark)').matches ? 'system' : 'fixed'
  writeRememberedAppearanceMode(guessed)
  return guessed
}

function watchPageTheme(): void {
  let lastDark: boolean | undefined
  let lastMode: AppearanceMode | undefined
  const report = (): void => {
    const dark = pageLooksDark()
    const mode = currentAppearanceMode(dark)
    if (dark === lastDark && mode === lastMode) return
    lastDark = dark
    lastMode = mode
    ipcRenderer.send('desktop:theme', { dark, mode })
  }
  const onAppearanceGesture = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button, [role="button"], [role="radio"]')
    if (button === null) return
    const mode = appearanceButtonMode(button)
    if (mode === undefined) return
    writeRememberedAppearanceMode(mode)
    report()
  }
  document.addEventListener('click', onAppearanceGesture, true)
  document.addEventListener('change', onAppearanceGesture, true)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report)
  ipcRenderer.on('desktop:theme:refresh', report)
  const observerOptions: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-appearance', 'aria-pressed', 'aria-checked', 'aria-selected', 'data-state'],
  }
  new MutationObserver(report).observe(document.documentElement, observerOptions)
  if (document.body !== null) new MutationObserver(report).observe(document.body, observerOptions)
  setInterval(report, 2000)
  report()
}

// ---------------------------------------------------------------------------
// The client's own 桌面设置 tab inside the OFFICIAL settings dialog.
//
// The official UI is a black box. A cloned nav item is inserted below
// 通用设置; while it is selected the official panels are hidden (inline
// display only — their DOM is otherwise untouched) and one appended panel
// carries the connection and app-update cards. Everything is reverted the
// moment an official tab is clicked. Detection is heuristic (ARIA dialog /
// modal-like container mentioning 设置); when it fails the tab is simply
// absent — official behavior is never affected.
// ---------------------------------------------------------------------------

const ENHANCE_ID = 'dsh-desktop-enhance'
const UPDATE_ID = 'dsh-desktop-update'
const DESKTOP_TAB_ID = 'dsh-desktop-tab'
const DESKTOP_PANEL_ID = 'dsh-desktop-panel'
const RELEASES_PAGE_URL = 'https://github.com/bruc3van/dsh-desktop/releases'

/**
 * The "open the releases page" glyph, beside 检查更新. An in-app download can
 * fail on a machine that reaches GitHub only through a proxy this process does
 * not use, and the manual page is then the way out. Inline SVG so it follows
 * the official theme's text colour; the anchor leaves through the main
 * process's window-open handler, i.e. in the system browser.
 */
const EXTERNAL_LINK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'
  + '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>'

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** Heuristic: the official settings dialog, when open. */
function findSettingsDialog(): Element | null {
  for (const el of document.querySelectorAll('[role="dialog"]')) {
    if (!visible(el)) continue
    const text = el.textContent ?? ''
    if (text.includes('设置') || text.includes('Settings')) return el
  }
  for (const el of document.querySelectorAll('[class*="modal" i], [class*="dialog" i], [class*="popover" i], [class*="drawer" i], [class*="sheet" i]')) {
    if (!visible(el) || el.tagName === 'BUTTON' || el.tagName === 'INPUT') continue
    const text = el.textContent ?? ''
    if (text.includes('设置') && text.length < 6000) return el
  }
  return null
}

/** The settings dialog's form-flow container (the nav's content column). */
function findOptions(dialog: Element): Element | null {
  const content = [...dialog.children].find(c => String(c.className ?? '').includes('content'))
  if (content === undefined) return null
  return [...content.children].find(c => String(c.className ?? '').includes('options')) ?? null
}

/** The settings dialog's tab list. */
function findNavList(dialog: Element): Element | null {
  return dialog.querySelector('[class*="navList"]')
}

/** CSS-module "active" tokens ("active_ab12c", "navItem--active") — not "interactive". */
function isActiveToken(cls: string): boolean {
  return /(^|[-_])active/i.test(cls)
}

/** Monitor glyph for the injected nav item, in place of the cloned tab's icon. */
const DESKTOP_TAB_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path></svg>'

let desktopTabSelected = false
/** The official active class, learned from whichever tab was active when ours was selected. */
let officialActiveClass = ''
/** Exactly which elements lost that class to us, so deselecting restores them. */
let strippedActive: { el: Element; cls: string; label: string }[] = []

function desktopTabLabel(english: boolean): string {
  return english ? 'Desktop' : '桌面设置'
}

/** Retext the cloned item's visible label without disturbing its icon. */
function setNavLabel(item: Element, label: string): void {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if ((node.textContent ?? '').trim() !== '') {
      if (node.textContent !== label) node.textContent = label
      return
    }
    node = walker.nextNode()
  }
  item.appendChild(document.createTextNode(label))
}

/** The label of the nav item (navList child) an active token sits on or inside. */
function navItemLabel(el: Element, navList: Element): string {
  let node: Element | null = el
  while (node !== null && node.parentElement !== navList) node = node.parentElement
  return (node ?? el).textContent?.trim() ?? ''
}

function findGeneralNavItem(navList: Element): Element | null {
  for (const child of navList.children) {
    if (child.id === DESKTOP_TAB_ID) continue
    const label = child.textContent?.trim() ?? ''
    if (label === '通用设置' || label === 'General' || label === 'General Settings') return child
  }
  return null
}

/**
 * Keep the 桌面设置 nav item seated below 通用设置. It is a deep clone of the
 * 通用设置 item so it inherits the official look; the clone is then scrubbed
 * of anything the official code might key on (active tokens, data-*, ARIA
 * state) and its clicks never reach the official handlers.
 */
function ensureDesktopTab(navList: Element): void {
  let item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && item.parentElement !== navList) {
    item.remove()
    item = null
  }
  if (item === null) {
    const general = findGeneralNavItem(navList)
    if (general === null) return
    const clone = general.cloneNode(true) as HTMLElement
    clone.id = DESKTOP_TAB_ID
    for (const el of [clone, ...clone.querySelectorAll('[class]')]) {
      for (const cls of [...el.classList]) if (isActiveToken(cls)) el.classList.remove(cls)
    }
    for (const name of clone.getAttributeNames()) {
      if (name.startsWith('data-') || name === 'aria-current' || name === 'aria-selected') clone.removeAttribute(name)
    }
    // Inline on* handlers never belong on this tab: its clicks are routed by
    // this preload alone, and a template change upstream must not smuggle a
    // live handler into the clone.
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('on')) el.removeAttribute(name)
      }
    }
    const icon = clone.querySelector('svg')
    if (icon !== null) {
      const template = document.createElement('template')
      template.innerHTML = DESKTOP_TAB_SVG
      const monitor = template.content.firstElementChild
      if (monitor !== null) {
        for (const name of ['class', 'width', 'height']) {
          const value = icon.getAttribute(name)
          if (value !== null) monitor.setAttribute(name, value)
        }
        icon.replaceWith(monitor)
      }
    }
    clone.addEventListener('click', (event) => {
      // The clone may carry official routing hooks (href, delegated handlers);
      // this tab exists only client-side, so the click must not leave it.
      event.preventDefault()
      event.stopPropagation()
      desktopTabSelected = true
      applyDesktopSelection()
    })
    navList.insertBefore(clone, general.nextElementSibling)
    item = clone
  }
  setNavLabel(item, desktopTabLabel(currentEnglish()))
  const list = navList as HTMLElement
  if (list.dataset.dshNavHooked === undefined) {
    list.dataset.dshNavHooked = '1'
    navList.addEventListener('click', onOfficialNavClick, true)
  }
}

/** Capture-phase: an official tab was clicked while ours was selected — hand everything back. */
function onOfficialNavClick(event: Event): void {
  if (!desktopTabSelected) return
  const target = event.target
  if (!(target instanceof Element)) return
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && (target === item || item.contains(target))) return
  deselectDesktopTab()
}

/**
 * Revert every change selection made. On a direct click this runs BEFORE the
 * official handler: React bails out when the clicked tab is the one it still
 * believes active, and would then never repaint the class we removed. When
 * the official UI has already moved on by itself (restoreActive=false) the
 * class is NOT put back — React repainted the nav and re-adding it would
 * highlight two tabs at once.
 */
function deselectDesktopTab(restoreActive = true): void {
  desktopTabSelected = false
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && officialActiveClass !== '') item.classList.remove(officialActiveClass)
  document.getElementById(DESKTOP_PANEL_ID)?.remove()
  if (restoreActive) for (const entry of strippedActive) entry.el.classList.add(entry.cls)
  strippedActive = []
  for (const el of document.querySelectorAll('[data-dsh-hidden]')) {
    const hidden = el as HTMLElement
    hidden.style.display = hidden.dataset.dshHidden ?? ''
    delete hidden.dataset.dshHidden
  }
}

/** Selection, resolved from the live dialog (the click handler's entry point). */
function applyDesktopSelection(): void {
  const dialog = findSettingsDialog()
  if (dialog === null) return
  const navList = findNavList(dialog)
  const options = findOptions(dialog)
  if (navList === null || options === null) return
  enforceDesktopSelection(navList, options)
}

/**
 * While our tab is selected: strip the official active token (remembering
 * where it was), wear it ourselves, hide the official panels, and keep our
 * panel — with the connection and app-update cards — seated in the options
 * column. Idempotent; the probe re-runs it so official re-renders (which
 * neither see nor preserve our changes) are re-overridden.
 */
function enforceDesktopSelection(navList: Element, options: Element): void {
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item === null) return
  const activeEls: Element[] = []
  for (const el of navList.querySelectorAll('[class*="active"]')) {
    if (el === item || item.contains(el)) continue
    if ([...el.classList].some(isActiveToken)) activeEls.push(el)
  }
  // An active token on a tab we never stripped means the official UI switched
  // tabs by a path other than a click (keyboard navigation, programmatic):
  // yield to the tab the user chose instead of suppressing it.
  if (strippedActive.length > 0) {
    for (const el of activeEls) {
      const label = navItemLabel(el, navList)
      if (!strippedActive.some(entry => entry.label === label)) {
        deselectDesktopTab(false)
        return
      }
    }
  }
  for (const el of activeEls) {
    const label = navItemLabel(el, navList)
    for (const cls of [...el.classList]) {
      if (!isActiveToken(cls)) continue
      officialActiveClass = cls
      el.classList.remove(cls)
      if (!strippedActive.some(entry => entry.el === el && entry.cls === cls)) strippedActive.push({ el, cls, label })
    }
  }
  if (officialActiveClass !== '') item.classList.add(officialActiveClass)
  for (const child of options.children) {
    if (child.id === DESKTOP_PANEL_ID) continue
    const el = child as HTMLElement
    if (el.dataset.dshHidden === undefined) {
      el.dataset.dshHidden = el.style.display
      el.style.display = 'none'
    }
  }
  let panel = document.getElementById(DESKTOP_PANEL_ID)
  if (panel !== null && panel.parentElement !== options) {
    panel.remove()
    panel = null
  }
  if (panel === null) {
    panel = document.createElement('div')
    panel.id = DESKTOP_PANEL_ID
    options.appendChild(panel)
  }
  injectEnhance(panel)
  injectUpdate(panel)
  const card = document.getElementById(UPDATE_ID)
  if (card !== null) refreshUpdateLanguage(card as HTMLElement, currentEnglish())
}

/** Append the connection block to the 桌面设置 panel, matching the official rows. */
function injectEnhance(panel: Element): void {
  if (panel.querySelector('#' + ENHANCE_ID) !== null) return

  if (document.getElementById(ENHANCE_ID + '-style') === null) {
    const style = document.createElement('style')
    style.id = ENHANCE_ID + '-style'
    // Official form language: block flow under the options column (padding
    // 0 24px 24px), rows are flex columns, labels #0F1115 14px, secondary
    // text #6E7480 13px, inputs 13px/8px radius/#D8D8D4, ghost buttons 28px.
    style.textContent = [
      // Our own panel replicates the official options-column flow (padding
      // 0 24px 24px), with a hairline between the two cards.
      '#' + DESKTOP_PANEL_ID + '{padding:0 24px 24px}',
      '#' + ENHANCE_ID + '{margin:0;padding:16px 0}',
      '#' + ENHANCE_ID + ' .dsh-enhance-title{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-status{margin:0 0 12px;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-row{display:flex;gap:8px;align-items:center}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);outline:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input:focus{border-color:var(--dsw-alias-brand-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input::placeholder{color:var(--dsw-alias-label-dimmed,#9AA0A6)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-actions{display:flex;gap:8px;align-items:center;margin-left:auto}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:28px;padding:6px 16px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:disabled{cursor:default;opacity:.55}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch{background:var(--dsw-alias-label-primary,#0F1115);border-color:var(--dsw-alias-label-primary,#0F1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch:hover{opacity:.88;background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-note{margin:10px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketBlock{margin:16px 0 0;padding:16px 0 0;'
        + 'border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketRow{justify-content:space-between;gap:12px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketLabel{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataBlock{margin:16px 0 0;padding:16px 0 0;'
        + 'border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataModes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataModes .dsh-enhance-button{min-height:44px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataPath{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099);overflow-wrap:anywhere;word-break:break-word}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle{position:relative;flex-shrink:0;width:40px;height:22px;padding:0;'
        + 'border:none;border-radius:999px;background:var(--dsw-alias-border-l2,#D8D8D4);cursor:pointer;'
        + 'transition:background .15s ease,opacity .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"]{background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle:disabled{cursor:default;opacity:.55}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;'
        + 'border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);pointer-events:none;'
        + 'transition:transform .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"] .dsh-enhance-toggle-thumb{transform:translateX(18px)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-modes{flex-wrap:wrap;margin:0 0 4px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-smart[hidden],#' + ENHANCE_ID + ' .dsh-enhance-custom[hidden],'
        + '#' + ENHANCE_ID + ' #dsh-enhance-port-block[hidden]{display:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtimes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtime{padding:5px 12px}',
      '#' + UPDATE_ID + '{margin:0;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + UPDATE_ID + ' .dsh-update-title{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + UPDATE_ID + ' .dsh-update-version{margin:0 0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099)}',
      '#' + UPDATE_ID + ' .dsh-update-status{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + UPDATE_ID + ' .dsh-update-status.is-error{color:var(--dsw-alias-status-error,#D93F3F)}',
      // The notes are release Markdown; the stylesheet for what it renders
      // into is shared with the client's own settings page.
      releaseNotesCss('#' + UPDATE_ID + ' .dsh-update-notes', {
        text: 'var(--dsw-alias-label-secondary,#6E7480)',
        strong: 'var(--dsw-alias-label-primary,#0F1115)',
        border: 'var(--dsw-alias-border-l2,#D8D8D4)',
        surface: 'var(--dsw-alias-bg-module-platform,#EBEEF2)',
      }),
      '#' + UPDATE_ID + ' .dsh-update-bar{height:4px;margin:0 0 10px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#EBEEF2);overflow:hidden}',
      '#' + UPDATE_ID + ' .dsh-update-bar span{display:block;height:100%;width:0;border-radius:999px;background:var(--dsw-alias-label-primary,#0F1115);transition:width .2s ease}',
      '#' + UPDATE_ID + ' .dsh-enhance-actions{display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap}',
      '#' + UPDATE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:28px;padding:6px 16px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
      '#' + UPDATE_ID + ' .dsh-enhance-button:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7)}',
      '#' + UPDATE_ID + ' .dsh-enhance-button:disabled{cursor:default;opacity:.55}',
      '#' + UPDATE_ID + ' .dsh-enhance-switch{background:var(--dsw-alias-label-primary,#0F1115);border-color:var(--dsw-alias-label-primary,#0F1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + UPDATE_ID + ' .dsh-enhance-switch:hover{opacity:.88;background:var(--dsw-alias-label-primary,#0F1115)}',
      // A glyph rather than a fourth button: the row keeps one primary action,
      // and this stays a way out rather than a competing choice.
      '#' + UPDATE_ID + ' .dsh-update-link{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;'
        + 'border-radius:999px;text-decoration:none;color:var(--dsw-alias-label-secondary,#6E7480);'
        + 'transition:background .15s ease,color .15s ease}',
      '#' + UPDATE_ID + ' .dsh-update-link:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7);color:var(--dsw-alias-label-primary,#0F1115)}',
    ].join('')
    document.head.appendChild(style)
  }

  const runtimePick = (id: string, label: string, tip: string): string =>
    '<button class="dsh-enhance-button dsh-enhance-runtime dsh-enhance-switch" type="button" data-smart-runtime="' + id
    + '" data-tip="' + tip + '" aria-description="' + tip + '">' + label + '</button>'

  const block = document.createElement('div')
  block.id = ENHANCE_ID
  block.innerHTML =
    '<div class="dsh-enhance-title">连接</div>'
    + '<p class="dsh-enhance-status" id="dsh-enhance-status">连接状态读取中…</p>'
    + '<div class="dsh-enhance-row dsh-enhance-modes" role="radiogroup" aria-label="连接方式">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-mode-smart" type="button" role="radio" aria-checked="true">智能</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-mode-custom" type="button" role="radio" aria-checked="false">自定义</button>'
    + '</div>'
    + '<div class="dsh-enhance-smart" id="dsh-enhance-smart">'
    + '<p class="dsh-enhance-note">可多选，按优先级依次尝试</p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes" id="dsh-enhance-runtimes">'
    + runtimePick('probe', '本机已运行', '本机已有官方 Web UI 在跑时直接连上（默认 3080），不另起一份。')
    + runtimePick('installed', '本机已安装', '用你 PATH 上自己安装的 dsh，由客户端在后台启动。')
    + runtimePick('npx', 'npx 缓存', '用你跑过 npx @deepseek-ai/dsh 留下的缓存包启动，不联网。')
    + runtimePick('bundled', '客户端内置', '用安装包自带的官方运行时，不用另装 Node 或 dsh。')
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-runtimeNote">关掉的来源会跳过。至少保留一种。</p>'
    + '<p class="dsh-enhance-note" style="margin-top:14px">本地服务端口</p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes" role="radiogroup" aria-label="本地服务端口">'
    + '<button class="dsh-enhance-button dsh-enhance-runtime dsh-enhance-switch" id="dsh-enhance-port-random" type="button">随机</button>'
    + '<button class="dsh-enhance-button dsh-enhance-runtime" id="dsh-enhance-port-fixed" type="button">固定</button>'
    + '</div>'
    + '<div id="dsh-enhance-port-block" hidden>'
    + '<div class="dsh-enhance-row" style="margin-top:8px">'
    + '<input class="dsh-enhance-input" id="dsh-enhance-port" spellcheck="false" inputmode="numeric" placeholder="例如 13080">'
    + '<button class="dsh-enhance-button" id="dsh-enhance-port-save" type="button">保存</button>'
    + '</div>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-portNote">仅影响客户端自己启动的 dsh。默认随机，不占用 3080。被占用时不会换口。</p>'
    + '</div>'
    + '<div class="dsh-enhance-custom" id="dsh-enhance-custom" hidden>'
    + '<div class="dsh-enhance-row" style="margin-top:10px">'
    + '<input class="dsh-enhance-input" id="dsh-enhance-url" spellcheck="false" placeholder="例如 http://127.0.0.1:3080">'
    + '<button class="dsh-enhance-button" id="dsh-enhance-save" type="button">保存并连接</button>'
    + '</div>'
    + '<p class="dsh-enhance-note">直连该地址上的 Web UI。服务停掉后不会自动改用本地运行时。</p>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-note"></p>'
    + '<div class="dsh-enhance-marketBlock">'
    + '<div class="dsh-enhance-row dsh-enhance-marketRow">'
    + '<span class="dsh-enhance-marketLabel" id="dsh-enhance-marketLabel">安全市场</span>'
    + '<button class="dsh-enhance-toggle" id="dsh-enhance-market" type="button" role="switch" aria-checked="false" aria-labelledby="dsh-enhance-marketLabel">'
    + '<span class="dsh-enhance-toggle-thumb"></span></button>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-marketNote"></p>'
    + '</div>'
    + '<div class="dsh-enhance-dataBlock">'
    + '<div class="dsh-enhance-title">数据环境</div>'
    + '<div class="dsh-enhance-row dsh-enhance-dataModes" role="radiogroup" aria-label="DSH 数据环境">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-data-shared" type="button" role="radio" aria-checked="true">共享环境</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-data-isolated" type="button" role="radio" aria-checked="false">桌面端独立环境</button>'
    + '</div>'
    + '<p class="dsh-enhance-dataPath" id="dsh-enhance-dataPath"></p>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-dataNote" aria-live="polite">正在读取数据环境…</p>'
    + '</div>'
  const statusEl = block.querySelector('#dsh-enhance-status') as HTMLElement
  const urlEl = block.querySelector('#dsh-enhance-url') as HTMLInputElement
  const noteEl = block.querySelector('#dsh-enhance-note') as HTMLElement
  const modeSmartEl = block.querySelector('#dsh-enhance-mode-smart') as HTMLButtonElement
  const modeCustomEl = block.querySelector('#dsh-enhance-mode-custom') as HTMLButtonElement
  const smartBlockEl = block.querySelector('#dsh-enhance-smart') as HTMLElement
  const customBlockEl = block.querySelector('#dsh-enhance-custom') as HTMLElement
  const runtimeNoteEl = block.querySelector('#dsh-enhance-runtimeNote') as HTMLElement
  const portRandomEl = block.querySelector('#dsh-enhance-port-random') as HTMLButtonElement
  const portFixedEl = block.querySelector('#dsh-enhance-port-fixed') as HTMLButtonElement
  const portBlockEl = block.querySelector('#dsh-enhance-port-block') as HTMLElement
  const portEl = block.querySelector('#dsh-enhance-port') as HTMLInputElement
  const portNoteEl = block.querySelector('#dsh-enhance-portNote') as HTMLElement
  const runtimeDefaultNote = '关掉的来源会跳过。至少保留一种。'
  const dataSharedEl = block.querySelector('#dsh-enhance-data-shared') as HTMLButtonElement
  const dataIsolatedEl = block.querySelector('#dsh-enhance-data-isolated') as HTMLButtonElement
  const dataPathEl = block.querySelector('#dsh-enhance-dataPath') as HTMLElement
  const dataNoteEl = block.querySelector('#dsh-enhance-dataNote') as HTMLElement
  let dataMode: 'shared' | 'isolated' = 'shared'
  const paintDataMode = (status: ConnectionStatus): void => {
    dataMode = status.dshDataMode === 'isolated' ? 'isolated' : 'shared'
    dataSharedEl.classList.toggle('dsh-enhance-switch', dataMode === 'shared')
    dataIsolatedEl.classList.toggle('dsh-enhance-switch', dataMode === 'isolated')
    dataSharedEl.setAttribute('aria-checked', dataMode === 'shared' ? 'true' : 'false')
    dataIsolatedEl.setAttribute('aria-checked', dataMode === 'isolated' ? 'true' : 'false')
    dataSharedEl.disabled = status.dshDataModeSelectable === false
    dataIsolatedEl.disabled = status.dshDataModeSelectable === false
    const probe = block.querySelector('[data-smart-runtime="probe"]') as HTMLButtonElement | null
    if (probe !== null) probe.disabled = dataMode === 'isolated'
    dataPathEl.textContent = status.dshDataHome ?? ''
    dataNoteEl.textContent = status.dshDataModeSelectable === false
      ? '当前由 DSH_HOME 开发环境变量控制。'
      : status.dshDataFallbackReason === 'plugin-compatibility'
        ? '因共享环境中的插件与当前 DSH 不兼容，当前使用独立环境。解决后可切回共享环境。'
          + (status.dshDataFallbackPlugins === undefined || status.dshDataFallbackPlugins.length === 0
            ? (status.dshDataFallbackPlugin === undefined ? '' : ` 问题插件：${status.dshDataFallbackPlugin}`)
            : ` 问题插件：${status.dshDataFallbackPlugins.join('、')}`)
        : dataMode === 'shared'
          ? '与命令行和浏览器版 DSH 共用对话、凭据、模型配置与插件。'
          : '使用桌面端独立的数据、凭据与插件。切换会重启客户端。'
  }
  const saveDataMode = (mode: 'shared' | 'isolated'): void => {
    if (mode === dataMode) return
    dataSharedEl.disabled = true
    dataIsolatedEl.disabled = true
    dataNoteEl.textContent = '正在保存并重启客户端…'
    void connection.setDshDataMode(mode).then((result) => {
      if (!result.saved) {
        dataSharedEl.disabled = false
        dataIsolatedEl.disabled = false
        dataNoteEl.textContent = '切换失败：' + (result.error ?? '未知错误')
        return
      }
      dataMode = result.dshDataMode
      if (result.applied === true) {
        dataNoteEl.textContent = '已保存，正在重启客户端…'
        return
      }
      void connection.getStatus().then((status) => {
        paintDataMode(status)
        dataNoteEl.textContent = '当前已经是这个环境'
      }, () => {
        dataSharedEl.disabled = false
        dataIsolatedEl.disabled = false
        dataNoteEl.textContent = '当前已经是这个环境'
      })
    }, (error: unknown) => {
      dataSharedEl.disabled = false
      dataIsolatedEl.disabled = false
      dataNoteEl.textContent = '切换失败：' + (error instanceof Error ? error.message : String(error))
    })
  }
  dataSharedEl.addEventListener('click', () => { saveDataMode('shared') })
  dataIsolatedEl.addEventListener('click', () => { saveDataMode('isolated') })
  const paintPort = (port: number | undefined): void => {
    const n = port !== undefined && port > 0 ? port : 0
    const fixed = n > 0
    portRandomEl.classList.toggle('dsh-enhance-switch', !fixed)
    portFixedEl.classList.toggle('dsh-enhance-switch', fixed)
    portBlockEl.hidden = !fixed
    if (fixed) portEl.value = String(n)
  }
  const savePort = (value: number | string): void => {
    void connection.setLocalWebPort(value).then((result) => {
      paintPort(result.localWebPort)
      portNoteEl.textContent = result.saved
        ? (result.applied === true
          ? (result.localWebPort > 0 ? '已固定端口，正在重新启动本地服务…' : '已改回随机端口，正在重新启动本地服务…')
          : '已保存')
        : ('保存失败：' + (result.error ?? '未知错误'))
    }, (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      portNoteEl.textContent = '保存失败：' + (text.includes('sender is not the active Web UI')
        ? '正在重新启动本地服务，请稍后再试' : text)
    })
  }
  portRandomEl.addEventListener('click', () => { paintPort(0); savePort(0) })
  portFixedEl.addEventListener('click', () => {
    portRandomEl.classList.remove('dsh-enhance-switch')
    portFixedEl.classList.add('dsh-enhance-switch')
    portBlockEl.hidden = false
    portEl.focus()
  })
  block.querySelector('#dsh-enhance-port-save')?.addEventListener('click', () => {
    const value = portEl.value.trim()
    if (value === '') {
      portNoteEl.textContent = '请输入端口'
      return
    }
    savePort(value)
  })
  const paintMode = (mode: 'smart' | 'connect'): void => {
    const custom = mode === 'connect'
    modeSmartEl.setAttribute('aria-checked', custom ? 'false' : 'true')
    modeCustomEl.setAttribute('aria-checked', custom ? 'true' : 'false')
    modeSmartEl.classList.toggle('dsh-enhance-switch', !custom)
    modeCustomEl.classList.toggle('dsh-enhance-switch', custom)
    smartBlockEl.hidden = custom
    customBlockEl.hidden = !custom
  }
  modeSmartEl.addEventListener('click', async () => {
    paintMode('smart')
    try {
      const status = await connection.getStatus()
      if (status.selectedMode !== 'connect') return
      const result = await connection.switchMode()
      if (!result.switched) {
        paintMode('connect')
        noteEl.textContent = '切换失败：' + (result.error ?? '未知错误')
        return
      }
      noteEl.textContent = '正在切换到智能模式…'
    } catch (error) {
      paintMode('connect')
      noteEl.textContent = '切换失败：' + (error instanceof Error ? error.message : String(error))
    }
  })
  modeCustomEl.addEventListener('click', () => {
    paintMode('connect')
    if (urlEl.value !== '') return
    void connection.probeLocal().then((probe) => {
      if (probe.url === null || urlEl.value !== '') return
      urlEl.value = probe.url
      noteEl.textContent = '检测到本机已有 Web UI，可直接保存并连接。'
    }).catch(() => { /* offering a live instance is optional */ })
  })
  block.querySelector('#dsh-enhance-save')?.addEventListener('click', async () => {
    try {
      if (urlEl.value.trim() === '') {
        noteEl.textContent = '请先填写地址'
        return
      }
      const result = await connection.saveServerUrl(urlEl.value.trim())
      noteEl.textContent = result.saved
        ? (result.mode === 'smart' ? '正在连接（智能模式：该实例停止时自动回落）' : '已保存，正在连接…')
        : ('保存失败：' + (result.error ?? '未知错误'))
    } catch (error) {
      noteEl.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error))
    }
  })
  const marketEl = block.querySelector('#dsh-enhance-market') as HTMLButtonElement
  const marketNoteEl = block.querySelector('#dsh-enhance-marketNote') as HTMLElement
  const paintMarket = (enabled: boolean): void => {
    marketEl.setAttribute('aria-checked', enabled ? 'true' : 'false')
  }
  void connection.getMarket().then((state) => { paintMarket(state.enabled) }, () => {
    // The row is an enhancement; a bridge that will not answer just leaves it
    // out rather than putting a switch nobody can trust in front of anyone.
    ;(block.querySelector('.dsh-enhance-marketBlock') as HTMLElement | null)?.remove()
  })
  marketEl.addEventListener('click', async () => {
    const wanted = marketEl.getAttribute('aria-checked') !== 'true'
    marketEl.disabled = true
    try {
      const result = await connection.setMarket(wanted)
      paintMarket(result.enabled)
      marketNoteEl.textContent = result.enabled
        ? '已开启。重启客户端后，安全市场会接入当前运行时。'
        : '已关闭并从 profile 中移除。当前会话里它仍然加载着，重启后消失。'
    } catch (error) {
      paintMarket(!wanted)
      marketNoteEl.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      marketEl.disabled = false
    }
  })
  const runtimeButtons = [...block.querySelectorAll('[data-smart-runtime]')] as HTMLButtonElement[]
  const allRuntimes: Array<'probe' | 'installed' | 'npx' | 'bundled'> = ['probe', 'installed', 'npx', 'bundled']
  const paintRuntimes = (ids: Array<'probe' | 'installed' | 'npx' | 'bundled'> | undefined): void => {
    const on = new Set(ids !== undefined && ids.length > 0 ? ids : allRuntimes)
    for (const button of runtimeButtons) {
      const id = button.getAttribute('data-smart-runtime')
      button.classList.toggle('dsh-enhance-switch', id !== null && on.has(id as typeof allRuntimes[number]))
    }
  }
  type SmartRuntimePick = 'probe' | 'installed' | 'npx' | 'bundled'
  let runtimeSaveBusy = false
  let runtimeSaveQueued: SmartRuntimePick[] | undefined
  const selectedRuntimes = (): SmartRuntimePick[] => runtimeButtons
    .filter((entry) => entry.classList.contains('dsh-enhance-switch'))
    .map((entry) => entry.getAttribute('data-smart-runtime'))
    .filter((entry): entry is SmartRuntimePick => entry !== null)
  const bridgeFailure = (error: unknown): string => {
    const text = error instanceof Error ? error.message : String(error)
    if (text.includes('sender is not the active Web UI') || text.includes('Render frame was disposed')) {
      return '正在重新启动本地服务，请稍后再试'
    }
    return text
  }
  const commitRuntimes = (ids: SmartRuntimePick[]): void => {
    paintRuntimes(ids)
    runtimeNoteEl.textContent = '正在更新智能连接来源…'
    if (runtimeSaveBusy) {
      runtimeSaveQueued = ids
      return
    }
    runtimeSaveBusy = true
    void connection.setSmartRuntimes(ids).then((result) => {
      runtimeSaveBusy = false
      if (runtimeSaveQueued !== undefined) {
        const queued = runtimeSaveQueued
        runtimeSaveQueued = undefined
        commitRuntimes(queued)
        return
      }
      paintRuntimes(result.smartRuntimes)
      runtimeNoteEl.textContent = result.saved
        ? '已更新智能连接来源'
        : ('保存失败：' + (result.error ?? '至少保留一种来源'))
    }, (error: unknown) => {
      runtimeSaveBusy = false
      if (runtimeSaveQueued !== undefined) {
        const queued = runtimeSaveQueued
        runtimeSaveQueued = undefined
        commitRuntimes(queued)
        return
      }
      runtimeNoteEl.textContent = '保存失败：' + bridgeFailure(error)
      void connection.getStatus().then((status) => { paintRuntimes(status.smartRuntimes) }, () => {})
    })
  }
  for (const button of runtimeButtons) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-smart-runtime')
      if (id === null) return
      const current = selectedRuntimes()
      const next = current.includes(id as SmartRuntimePick)
        ? current.filter((entry) => entry !== id)
        : [...current, id as SmartRuntimePick]
      if (next.length === 0) {
        runtimeNoteEl.textContent = '至少保留一种来源'
        return
      }
      commitRuntimes(next)
    })
    const tip = button.getAttribute('data-tip') ?? ''
    button.addEventListener('mouseenter', () => { runtimeNoteEl.textContent = tip })
    button.addEventListener('focus', () => { runtimeNoteEl.textContent = tip })
    button.addEventListener('mouseleave', () => {
      if (runtimeNoteEl.textContent === tip) runtimeNoteEl.textContent = runtimeDefaultNote
    })
    button.addEventListener('blur', () => {
      if (runtimeNoteEl.textContent === tip) runtimeNoteEl.textContent = runtimeDefaultNote
    })
  }
  void connection.getStatus().then((status) => {
    // Named by WHO started the runtime, then which dsh it is — "本地"/"内置"
    // used to overlap, and a reused instance the user started got neither.
    const version = status.installedDshVersion === undefined ? '' : ' v' + status.installedDshVersion
    const startedByClient = status.runtimeSource === 'installed'
      ? '客户端启动·本机已安装' + version
      : status.runtimeSource === 'npx'
        ? '客户端启动·npx 缓存' + version
        : status.runtimeSource === 'bundled' ? '客户端启动·客户端内置' : '客户端启动'
    const modeLabel = status.mode === 'probe'
      ? '本机已运行'
      : status.mode === 'connect' ? '自定义地址' : startedByClient
    statusEl.textContent = modeLabel + ' → ' + (status.targetUrl || '（未就绪）')
      + (status.childPid !== undefined ? ' · PID ' + String(status.childPid) : '')
      + (status.lastError !== undefined ? ' · ' + status.lastError : '')
      // Non-blocking: the cache stays in use; re-running npx is how it updates.
      + (status.mode === 'local' && status.npxCacheOutdated === true
        ? ' · npx 缓存低于内置' + (status.dshVersion === null ? '' : ' v' + status.dshVersion) + '，重新运行 npx 可更新'
        : '')
    urlEl.value = status.savedServerUrl
    paintMode(status.selectedMode)
    paintRuntimes(status.smartRuntimes)
    paintPort(status.localWebPort)
    paintDataMode(status)
  }).catch(() => { statusEl.textContent = '连接状态不可用' })
  panel.appendChild(block)
}

function updateCopy(english: boolean): {
  title: string
  check: string
  checking: string
  install: string
  dismiss: string
  releases: string
  upToDate: string
  unsupported: string
  found: string
  preparing: string
  downloading: string
  installing: string
  restart: string
  failed: string
  failedNoReason: string
  cancelled: string
  unknown: string
  unavailable: string
  client: string
  bundled: string
  dshUnavailable: string
} {
  if (english) {
    return {
      title: 'App updates',
      check: 'Check for updates',
      checking: 'Checking…',
      install: 'Download and install',
      dismiss: 'Remind me later',
      releases: 'Open the releases page to download manually',
      upToDate: 'You are on the latest version',
      unsupported: 'A newer version exists, but this release ships no installer for this platform',
      found: 'New version available',
      preparing: 'Preparing the download…',
      downloading: 'Downloading',
      installing: 'Starting the installer…',
      restart: 'Install the new copy, then reopen the app',
      failed: 'Update failed: ',
      failedNoReason: 'Update failed — the reason is shown on the client itself',
      cancelled: 'Update cancelled',
      unknown: 'unknown error',
      unavailable: 'Update status unavailable',
      client: 'Desktop client v',
      bundled: 'bundled dsh',
      dshUnavailable: 'unavailable',
    }
  }
  return {
    title: '应用更新',
    check: '检查更新',
    checking: '检查中…',
    install: '下载并安装',
    dismiss: '稍后提醒',
    releases: '打开 GitHub 发布页手动下载',
    upToDate: '已是最新版本',
    unsupported: '已有更新版本，但该版本没有发布本平台的安装包',
    found: '发现新版本',
    preparing: '正在准备下载…',
    downloading: '下载中',
    installing: '正在启动安装程序…',
    restart: '请安装新版本后重新打开应用',
    failed: '更新失败：',
    failedNoReason: '更新失败，失败原因只在客户端本机显示',
    cancelled: '已取消更新',
    unknown: '未知错误',
    unavailable: '更新状态不可用',
    client: '桌面客户端 v',
    bundled: '内置 dsh',
    dshUnavailable: '不可用',
  }
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message === '' ? fallback : error.message
  const text = String(error)
  return text === '' ? fallback : text
}

/** MB, one decimal — the only unit an installer download ever needs. */
function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

/**
 * A message the card owns rather than the state: the refusals that never reach
 * a phase change (a denied bridge call, a rejected invoke) would otherwise
 * leave the button looking dead.
 */
function showUpdateMessage(text: string, isError: boolean): void {
  const statusEl = document.getElementById(UPDATE_ID)?.querySelector('#dsh-update-status') as HTMLElement | null
  if (statusEl === null || statusEl === undefined) return
  statusEl.hidden = false
  statusEl.textContent = text
  statusEl.classList.toggle('is-error', isError)
}

/** The notes source each notes box currently shows, keyed by the box itself. */
const paintedNotes = new WeakMap<HTMLElement, string>()

function paintUpdateCard(state: UpdateState, english: boolean): void {
  const block = document.getElementById(UPDATE_ID)
  if (block === null) return
  const copy = updateCopy(english)
  const versionEl = block.querySelector('#dsh-update-version') as HTMLElement | null
  const statusEl = block.querySelector('#dsh-update-status') as HTMLElement | null
  const notesEl = block.querySelector('#dsh-update-notes') as HTMLElement | null
  const barEl = block.querySelector('#dsh-update-bar') as HTMLElement | null
  const barFillEl = block.querySelector('#dsh-update-bar span') as HTMLElement | null
  const checkEl = block.querySelector('#dsh-update-check') as HTMLButtonElement | null
  const installEl = block.querySelector('#dsh-update-install') as HTMLButtonElement | null
  const dismissEl = block.querySelector('#dsh-update-dismiss') as HTMLButtonElement | null
  if (versionEl === null || statusEl === null || notesEl === null || checkEl === null || installEl === null || dismissEl === null) return
  if (barEl === null || barFillEl === null) return

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  checkEl.disabled = busy
  checkEl.textContent = state.phase === 'checking' ? copy.checking : copy.check
  // A failed attempt keeps the offer on screen: the update is still there and
  // retrying is the obvious next move. Without this the state would say
  // "hide" while the click handler said "show", and they would fight.
  const showInstall = (state.phase === 'available' || state.phase === 'error') && state.info !== null && !busy
  installEl.hidden = !showInstall
  dismissEl.hidden = !showInstall || state.dismissed
  installEl.disabled = busy

  const dsh = block.dataset.dshVersion || copy.dshUnavailable
  versionEl.textContent = copy.client + state.currentVersion + ' · ' + copy.bundled + ' ' + dsh

  let line = ''
  if (state.phase === 'checking') line = copy.checking
  else if (state.phase === 'upToDate') line = copy.upToDate
  // Not an error and not up to date: the releases link beside this line is the
  // only way forward, so the line says why rather than reporting a failure.
  else if (state.phase === 'unsupportedPlatform') line = copy.unsupported
  else if (state.phase === 'available' && state.info !== null) line = copy.found + ' v' + state.info.availableVersion
  else if (state.phase === 'downloading') {
    // A download with no percentage still has to look alive, so the byte
    // counter carries it when the response arrives without a content-length.
    const progress = state.progress
    const percent = progress?.percent ?? 0
    const total = progress?.total ?? 0
    line = copy.downloading + (percent > 0 ? ' ' + String(percent) + '%' : '…')
    if (progress !== null && progress.downloaded > 0) {
      line += ' · ' + megabytes(progress.downloaded) + (total > 0 ? '/' + megabytes(total) : '') + ' MB'
    }
  } else if (state.phase === 'installing') line = copy.installing
  else if (state.phase === 'restartRequired') line = copy.restart
  // A refusal leaves the phase alone and publishes only a reason, so the
  // reason — not the phase — is what decides this line.
  const failed = state.phase === 'error' || state.error !== null
  // A remote page never receives the reason (it names local paths), so say
  // where the reason is rather than inventing one.
  if (failed) line = state.error === null ? copy.failedNoReason : copy.failed + state.error
  statusEl.textContent = line
  statusEl.hidden = line === ''
  statusEl.classList.toggle('is-error', failed)

  const downloading = state.phase === 'downloading'
  barEl.hidden = !downloading
  if (downloading) barFillEl.style.width = String(state.progress?.percent ?? 0) + '%'

  const notes = state.info?.notes ?? ''
  notesEl.hidden = notes === ''
  // Rebuilding the box resets its scroll position and drops any selection, and
  // a download repaints this card several times a second — so it is rebuilt
  // only when the source text actually moved.
  if (paintedNotes.get(notesEl) !== notes) {
    paintedNotes.set(notesEl, notes)
    notesEl.innerHTML = renderReleaseNotes(notes)
  }
}

/**
 * The labels the card owns rather than the state. The official language
 * setting can change while the card is on screen, and the card is only
 * rebuilt when its panel goes away — so these are retexted in place instead
 * of waiting for the next injection.
 */
function applyUpdateStaticCopy(block: HTMLElement, english: boolean): void {
  const copy = updateCopy(english)
  const setText = (selector: string, text: string): void => {
    const el = block.querySelector(selector)
    if (el !== null) el.textContent = text
  }
  setText('#dsh-update-title-text', copy.title)
  setText('#dsh-update-install', copy.install)
  setText('#dsh-update-dismiss', copy.dismiss)
  const link = block.querySelector('#dsh-update-releases')
  if (link !== null) {
    link.setAttribute('title', copy.releases)
    link.setAttribute('aria-label', copy.releases)
  }
  // The check button doubles as a progress label while a check runs, and that
  // wording belongs to paintUpdateCard — only the resting label is ours.
  const checkEl = block.querySelector('#dsh-update-check') as HTMLButtonElement | null
  if (checkEl !== null && !checkEl.disabled) checkEl.textContent = copy.check
}

/** Follow a mid-session language switch, without repainting on every probe. */
function refreshUpdateLanguage(block: HTMLElement, english: boolean): void {
  const language = english ? 'en' : 'zh'
  if (block.dataset.dshLanguage === language) return
  block.dataset.dshLanguage = language
  applyUpdateStaticCopy(block, english)
  // The state-derived lines (version, status, notes) are painted from a state,
  // so the new language reaches them only by painting one now.
  void update.getStatus().then((state) => { paintUpdateCard(state, english) }).catch(() => {})
}

function injectUpdate(panel: Element): void {
  if (panel.querySelector('#' + UPDATE_ID) !== null) return
  const english = currentEnglish()
  const copy = updateCopy(english)
  const block = document.createElement('div')
  block.id = UPDATE_ID
  block.dataset.dshLanguage = english ? 'en' : 'zh'
  block.innerHTML =
    '<div class="dsh-update-title"><span id="dsh-update-title-text">' + copy.title + '</span>'
    + '<div class="dsh-enhance-actions">'
    + '<a class="dsh-update-link" id="dsh-update-releases" href="' + RELEASES_PAGE_URL + '" target="_blank"'
    + ' rel="noreferrer" title="' + copy.releases + '" aria-label="' + copy.releases + '">' + EXTERNAL_LINK_SVG + '</a>'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-update-install" type="button" hidden>' + copy.install + '</button>'
    + '<button class="dsh-enhance-button" id="dsh-update-check" type="button">' + copy.check + '</button>'
    + '<button class="dsh-enhance-button" id="dsh-update-dismiss" type="button" hidden>' + copy.dismiss + '</button>'
    + '</div></div>'
    + '<p class="dsh-update-version" id="dsh-update-version"></p>'
    + '<p class="dsh-update-status" id="dsh-update-status" hidden></p>'
    + '<div class="dsh-update-bar" id="dsh-update-bar" hidden><span></span></div>'
    + '<div class="dsh-update-notes" id="dsh-update-notes" hidden></div>'
  // Every handler resolves the language when it runs, not when it was
  // attached: the card outlives a language switch made in this same dialog.
  block.querySelector('#dsh-update-check')?.addEventListener('click', () => {
    const live = updateCopy(currentEnglish())
    showUpdateMessage(live.checking, false)
    void update.check()
      .then(() => update.getStatus())
      .then((state) => { paintUpdateCard(state, currentEnglish()) })
      .catch((error: unknown) => { showUpdateMessage(live.failed + errorText(error, live.unknown), true) })
  })
  const installEl = block.querySelector('#dsh-update-install') as HTMLButtonElement | null
  installEl?.addEventListener('click', () => {
    // The install runs to completion inside one invoke, so the answer arrives
    // minutes later. Say something now, and treat every way it can come back
    // unstarted — a refusal in the result, a rejected call — as a message.
    // Visibility stays with the state; only the disabled flag is ours.
    installEl.disabled = true
    showUpdateMessage(updateCopy(currentEnglish()).preparing, false)
    void update.install()
      .then((result) => update.getStatus().then((state) => {
        const live = updateCopy(currentEnglish())
        paintUpdateCard(state, currentEnglish())
        if (result.started) return
        installEl.disabled = false
        // Declining the confirmation is an answer, not a failure.
        if (result.cancelled === true) showUpdateMessage(live.cancelled, false)
        else showUpdateMessage(live.failed + (result.error ?? live.unknown), true)
      }))
      .catch((error: unknown) => {
        const live = updateCopy(currentEnglish())
        installEl.disabled = false
        showUpdateMessage(live.failed + errorText(error, live.unknown), true)
      })
  })
  block.querySelector('#dsh-update-dismiss')?.addEventListener('click', () => {
    void update.dismiss().then(() => update.getStatus()).then((state) => { paintUpdateCard(state, currentEnglish()) }).catch(() => {})
  })
  panel.appendChild(block)
  void Promise.allSettled([update.getStatus(), connection.getStatus()]).then((results) => {
    const state = results[0].status === 'fulfilled' ? results[0].value : null
    const conn = results[1].status === 'fulfilled' ? results[1].value : null
    if (conn !== null) block.dataset.dshVersion = conn.dshVersion ?? ''
    if (state !== null) {
      paintUpdateCard(state, currentEnglish())
      return
    }
    const statusEl = block.querySelector('#dsh-update-status') as HTMLElement | null
    if (statusEl !== null) {
      statusEl.hidden = false
      statusEl.textContent = updateCopy(currentEnglish()).unavailable
    }
  })
}

// ---------------------------------------------------------------------------
// "Where do I get a key?" line under the OFFICIAL DeepSeek credential field.
//
// The official first-run modal ("添加一个 API Key 开始使用") and the Models
// provider editor both ask for a key without saying where to create one, which
// strands a user who has never visited the platform. One appended line, same
// append-only rule as the card above: DeepSeek surfaces only, silently absent
// when the heuristic misses. The anchor opens through the main process's
// window-open handler, i.e. in the system browser.
// ---------------------------------------------------------------------------

const KEY_HELP_CLASS = 'dsh-desktop-key-help'
const DEEPSEEK_KEY_URL = 'https://platform.deepseek.com/api_keys'

/**
 * The container to append the hint to: the credential field's own row, but
 * only when its nearest provider card is the official DeepSeek card, or the
 * field belongs to the dedicated first-run DeepSeek dialog. Never climb to
 * the whole Models section: that section also contains custom-provider forms.
 */
function keyHelpHost(input: HTMLInputElement): Element | null {
  const row = input.parentElement
  if (row === null) return null

  const providerCard = input.closest('li')
  if (providerCard !== null) {
    return /deepseek-official/i.test(providerCard.textContent ?? '') ? row : null
  }

  const dialog = input.closest('[role="dialog"]')
  const dialogText = dialog?.textContent ?? ''
  if (/official DeepSeek provider|DeepSeek 官方模型/i.test(dialogText)) return row
  return null
}

/** Append the platform link under every visible DeepSeek key field. */
function injectKeyHelp(): void {
  const inputs = document.querySelectorAll('input[type="password"]')
  if (inputs.length === 0) return

  if (document.getElementById(KEY_HELP_CLASS + '-style') === null) {
    const style = document.createElement('style')
    style.id = KEY_HELP_CLASS + '-style'
    // Official secondary-text language, via the official theme variables so
    // the line follows the appearance setting (light/dark/system).
    style.textContent = '.' + KEY_HELP_CLASS + '{margin:8px 0 0;font-size:13px;line-height:20px;'
      + 'color:var(--dsw-alias-label-secondary,#6E7480)}'
      + '.' + KEY_HELP_CLASS + ' a{color:var(--dsw-alias-label-primary,#0F1115);text-decoration:underline;cursor:pointer}'
    document.head.appendChild(style)
  }

  for (const element of inputs) {
    const input = element as HTMLInputElement
    if (!visible(input)) continue
    const host = keyHelpHost(input)
    if (host === null || host.querySelector('.' + KEY_HELP_CLASS) !== null) continue
    // The official copy follows the language setting; match it off the field's
    // own placeholder rather than a document-level guess.
    const english = /^Enter (your |an )?API key/i.test(input.placeholder)
    const help = document.createElement('p')
    help.className = KEY_HELP_CLASS
    const anchor = document.createElement('a')
    anchor.href = DEEPSEEK_KEY_URL
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    anchor.textContent = english ? 'Create one on the DeepSeek platform' : '前往 DeepSeek 开放平台创建'
    help.append(english ? 'No API key yet? ' : '还没有 API Key？', anchor)
    host.appendChild(help)
  }
}

let watching = false

/** Watch for the official settings dialog and keep the card injected. */
function watchSettingsDialog(): void {
  if (watching) return
  watching = true
  const probe = (): void => {
    injectKeyHelp()
    const dialog = findSettingsDialog()
    if (dialog === null) {
      // The dialog unmounted (taking our nav item, panel, and the elements we
      // stripped with it): drop the selection so the next open starts clean.
      if (document.getElementById(DESKTOP_TAB_ID) === null) {
        desktopTabSelected = false
        strippedActive = []
      }
      return
    }
    const navList = findNavList(dialog)
    const options = findOptions(dialog)
    if (navList === null || options === null) return
    ensureDesktopTab(navList)
    if (desktopTabSelected) enforceDesktopSelection(navList, options)
  }
  // The observer sees every mutation of a streaming chat surface, and a probe
  // measures element boxes. Running one per animation frame both collapses
  // bursts and moves the reads to a point where layout is already clean,
  // instead of forcing a synchronous relayout inside the observer callback.
  let scheduled = false
  const scheduleProbe = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      probe()
    })
  }
  new MutationObserver(scheduleProbe).observe(document.documentElement, { childList: true, subtree: true })
  ipcRenderer.on('desktop:update:changed', (_event, state: UpdateState) => {
    paintUpdateCard(state, currentEnglish())
  })
  probe()
}

/**
 * The cards' language, resolved from the official nav labels at the moment of
 * the call — the active tab is ours while they are showing, so the language
 * has to be read off the tab list itself. Chinese when the dialog is away.
 */
function currentEnglish(): boolean {
  const dialog = findSettingsDialog()
  if (dialog === null) return false
  const navList = findNavList(dialog)
  if (navList === null) return false
  for (const child of navList.children) {
    const label = child.textContent?.trim() ?? ''
    if (label === '通用设置') return false
    if (label === 'General' || label === 'General Settings') return true
  }
  return false
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    watchPageTheme()
    watchSettingsDialog()
  }, { once: true })
} else {
  watchPageTheme()
  watchSettingsDialog()
}
