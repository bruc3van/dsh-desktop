import { ipcRenderer } from 'electron'
import { findSettingsDialog } from '../settings-adapter.ts'

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

export function watchPageTheme(): () => void {
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
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', report)
  ipcRenderer.on('desktop:theme:refresh', report)
  const observerOptions: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-appearance', 'aria-pressed', 'aria-checked', 'aria-selected', 'data-state'],
  }
  const observer = new MutationObserver(report)
  observer.observe(document.documentElement, observerOptions)
  if (document.body !== null) observer.observe(document.body, observerOptions)
  const timer = setInterval(report, 2000)
  report()
  return () => {
    observer.disconnect()
    clearInterval(timer)
    document.removeEventListener('click', onAppearanceGesture, true)
    document.removeEventListener('change', onAppearanceGesture, true)
    media.removeEventListener('change', report)
    ipcRenderer.removeListener('desktop:theme:refresh', report)
  }
}
