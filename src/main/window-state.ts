import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, Rectangle, Screen } from 'electron'

interface WindowState { bounds: Rectangle; maximized: boolean }
const normalBounds = new WeakMap<BrowserWindow, Rectangle>()
const relocating = new WeakSet<BrowserWindow>()
const defaults = { width: 1280, height: 820, minWidth: 1024, minHeight: 680 }

function validBounds(value: unknown): value is Rectangle {
  if (value === null || typeof value !== 'object') return false
  const bounds = value as Rectangle
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
    && Math.abs(bounds.x) <= 1_000_000 && Math.abs(bounds.y) <= 1_000_000
    && bounds.width > 0 && bounds.width <= 100_000 && bounds.height > 0 && bounds.height <= 100_000
}

/** Electron bounds and display work areas both use DIP, including negative origins. */
export function resolveWindowState(value: unknown, areas: Rectangle[], primary: Rectangle, minimum: { minWidth: number; minHeight: number } = defaults) {
  const saved = value !== null && typeof value === 'object' ? value as Partial<WindowState> : undefined
  const bounds = validBounds(saved?.bounds) ? saved.bounds : undefined
  const overlap = (area: Rectangle): number => bounds === undefined ? 0
    : Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
      * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y))
  const area = areas.reduce((best, candidate) => overlap(candidate) > overlap(best) ? candidate : best, primary)
  const minWidth = Math.min(minimum.minWidth, area.width)
  const minHeight = Math.min(minimum.minHeight, area.height)
  // Preserve deliberate spanning/partially off-screen layouts when a useful
  // title-bar segment remains reachable. A one-pixel intersection is not enough.
  const reachable = bounds !== undefined && areas.some(candidate =>
    bounds.y >= candidate.y && bounds.y + 32 <= candidate.y + candidate.height
    && Math.min(bounds.x + bounds.width, candidate.x + candidate.width) - Math.max(bounds.x, candidate.x) >= Math.min(160, bounds.width))
  if (bounds && reachable && bounds.width >= minWidth && bounds.height >= minHeight) {
    return { ...bounds, minWidth, minHeight, maximized: saved?.maximized === true }
  }
  const width = Math.min(area.width, Math.max(minWidth, bounds?.width ?? defaults.width))
  const height = Math.min(area.height, Math.max(minHeight, bounds?.height ?? defaults.height))
  const visible = overlap(area) > 0
  return {
    x: visible && bounds ? Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)) : area.x + Math.floor((area.width - width) / 2),
    y: visible && bounds ? Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) : area.y + Math.floor((area.height - height) / 2),
    width, height, minWidth, minHeight,
    maximized: bounds !== undefined && saved?.maximized === true,
  }
}

export function createWindowStateStore(home: string) {
  const file = join(home, 'window-state.json')
  let warned = false
  const warn = (): void => {
    if (!warned) console.warn('[desktop] window state unavailable; continuing without persistence')
    warned = true
  }
  function load(): unknown {
    try { return JSON.parse(readFileSync(file, 'utf8')) as unknown } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn()
      return undefined
    }
  }
  function save(state: WindowState): void {
    const temporary = file + '.' + String(process.pid) + '.tmp'
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 })
      // Keep the previous state intact if replacement fails (e.g. a Windows file lock).
      renameSync(temporary, file)
      warned = false
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
      warn()
    }
  }
  return { load, save }
}

/** Keep our own normal rectangle: macOS can overwrite getNormalBounds on minimize. */
export function trackWindowState(window: BrowserWindow, save: (state: WindowState) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let bounds = window.getBounds()
  normalBounds.set(window, bounds)
  let maximized = window.isMaximized()
  const capture = (): void => {
    if (window.isDestroyed() || relocating.has(window)) return
    if (!window.isMinimized() && !window.isFullScreen()) {
      maximized = window.isMaximized()
      if (!maximized) {
        const current = window.getBounds()
        if (validBounds(current)) { bounds = current; normalBounds.set(window, bounds) }
      }
    }
  }
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    bounds = normalBounds.get(window) ?? bounds
    if (validBounds(bounds)) save({ bounds: { ...bounds }, maximized })
  }
  const schedule = (): void => {
    clearTimeout(timer)
    // Sample after native resize/mode transitions, not in the intermediate resize event.
    timer = setTimeout(() => { capture(); flush() }, 300)
    timer.unref()
  }
  window.on('move', schedule)
  window.on('resize', schedule)
  window.on('maximize', () => { maximized = true; schedule() })
  window.on('unmaximize', schedule)
  window.on('leave-full-screen', schedule)
  window.on('restore', schedule)
  window.on('close', () => { capture(); flush() })
  window.once('closed', () => { clearTimeout(timer) })
}

/** Recover off-screen windows, preserving native modes and avoiding explicit show calls. */
export function guardWindowVisibility(window: BrowserWindow, displays: Screen, minimum: { minWidth: number; minHeight: number } = defaults) {
  let adjusting = false
  let recovery: { maximized: boolean; fullscreen: boolean; visible: boolean } | undefined
  let normal = window.getNormalBounds()
  const ensureVisible = (): void => {
    if (adjusting || window.isDestroyed() || window.isMinimized()) return
    const current = window.getBounds()
    const areas = displays.getAllDisplays().map(display => display.workArea)
    const fullscreen = window.isFullScreen()
    const maximized = window.isMaximized()
    if (fullscreen || maximized) {
      const visible = areas.some(area => Math.min(current.x + current.width, area.x + area.width) > Math.max(current.x, area.x)
        && Math.min(current.y + current.height, area.y + area.height) > Math.max(current.y, area.y))
      if (recovery) {
        if (!fullscreen && maximized) window.unmaximize()
        return
      }
      if (visible) return
      normal = normalBounds.get(window) ?? normal
      recovery = { maximized, fullscreen, visible: window.isVisible() }
      relocating.add(window)
      // Resume on the actual native exit event; never show a hidden tray window.
      if (fullscreen) window.setFullScreen(false)
      else window.unmaximize()
      return
    }
    const source = recovery ? normal : current
    const { maximized: _maximized, minWidth, minHeight, ...next } = resolveWindowState(
      { bounds: source }, areas, displays.getPrimaryDisplay().workArea, minimum,
    )
    adjusting = true
    try {
      window.setMinimumSize(minWidth, minHeight)
      if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) window.setBounds(next)
      normal = next
      normalBounds.set(window, next)
      const restore = recovery
      recovery = undefined
      if (restore?.fullscreen) {
        if (!restore.visible) window.once('enter-full-screen', () => { if (!window.isDestroyed()) window.hide() })
        window.setFullScreen(true)
      } else if (restore?.maximized) window.maximize()
      // Electron maximize may show an unmapped window; preserve tray visibility.
      if (restore && !restore.visible) window.hide()
    } finally { adjusting = false; relocating.delete(window) }
  }
  // Restore/unmaximize/fullscreen exits defer until the native transition settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(ensureVisible, 100)
    timer.unref()
  }
  displays.on('display-added', schedule)
  displays.on('display-removed', schedule)
  displays.on('display-metrics-changed', schedule)
  window.on('show', ensureVisible)
  window.on('focus', ensureVisible)
  window.on('restore', schedule)
  window.on('unmaximize', schedule)
  window.on('leave-full-screen', schedule)
  window.once('closed', () => {
    clearTimeout(timer)
    relocating.delete(window)
    displays.removeListener('display-added', schedule)
    displays.removeListener('display-removed', schedule)
    displays.removeListener('display-metrics-changed', schedule)
  })
  return ensureVisible
}

export function centeredWindowBounds(area: Rectangle, width: number, height: number): Rectangle {
  width = Math.min(width, area.width)
  height = Math.min(height, area.height)
  return { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height }
}
