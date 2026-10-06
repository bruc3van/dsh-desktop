import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const home = mkdtempSync(join(tmpdir(), 'dsh-window-state-'))
const originalWarn = console.warn
try {
  const outfile = join(home, 'state.mjs')
  await build({ entryPoints: ['src/main/window-state.ts'], bundle: true, platform: 'node', format: 'esm', outfile })
  const { resolveWindowState, createWindowStateStore, trackWindowState, guardWindowVisibility, centeredWindowBounds } = await import(pathToFileURL(outfile).href)
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const secondary = { x: -1920, y: -200, width: 1920, height: 1080 }
  const saved = { bounds: { x: -1800, y: -100, width: 1200, height: 800 }, maximized: true }
  const resolve = (value, areas = [primary, secondary]) => resolveWindowState(value, areas, primary)
  assert.deepEqual(resolve(saved), { ...saved.bounds, minWidth: 1024, minHeight: 680, maximized: true })
  const disconnected = resolve(saved, [primary])
  assert.equal(disconnected.x, 360)
  assert.equal(disconnected.y, 120)
  assert.equal(disconnected.maximized, true)
  for (const value of [null, {}, { bounds: { ...saved.bounds, x: NaN } }, { bounds: { ...saved.bounds, width: -1 } }]) {
    assert.equal(resolve(value).width, 1280)
    assert.equal(resolve(value).maximized, false)
  }
  const clipped = resolve({ bounds: { x: 1900, y: -400, width: 3000, height: 2000 } }, [primary])
  assert.equal(clipped.x, 0)
  assert.equal(clipped.y, 0)
  assert.equal(clipped.width, 1920)
  assert.equal(clipped.height, 1040)
  const small = { x: 0, y: 24, width: 800, height: 560 }
  const fitted = resolveWindowState(saved, [small], small)
  assert.equal(fitted.minWidth, 800)
  assert.equal(fitted.height, 560)
  assert.equal(fitted.y, 24)

  const right = { x: 1920, y: 0, width: 1920, height: 1040 }
  const spanning = { x: 1200, y: 100, width: 2200, height: 800 }
  const restoredSpan = resolveWindowState({ bounds: spanning }, [primary, right], primary)
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(restoredSpan[key], spanning[key], 'preserve reachable spanning layout')
  const unreachableTitle = resolve({ bounds: { x: 100, y: -10, width: 1280, height: 820 } }, [primary])
  assert.equal(unreachableTitle.y, 0)
  const sliver = resolve({ bounds: { x: 1919, y: 100, width: 1280, height: 820 } }, [primary])
  assert.ok(sliver.x < 1919, 'one-pixel title intersection is insufficient')
  assert.deepEqual(centeredWindowBounds(secondary, 640, 720), { x: -1280, y: -20, width: 640, height: 720 })
  assert.deepEqual(centeredWindowBounds(small, 640, 720), { x: 80, y: 24, width: 640, height: 560 })

  const store = createWindowStateStore(home)
  assert.equal(store.load(), undefined)
  store.save(saved)
  store.save({ ...saved, maximized: false })
  assert.equal(store.load().maximized, false)
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  writeFileSync(join(home, 'window-state.json'), '{secret broken JSON')
  assert.equal(store.load(), undefined)
  store.load()
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes('secret'))
  store.save(saved)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'window-state.json'), 'utf8')), saved)
  const blocked = join(home, 'blocked')
  mkdirSync(blocked)
  mkdirSync(join(blocked, 'window-state.json'))
  assert.doesNotThrow(() => createWindowStateStore(blocked).save(saved))

  class Window extends EventEmitter {
    bounds = { ...saved.bounds }
    minimized = false
    fullscreen = false
    destroyed = false
    maximized = false
    visible = false
    isVisible() { return this.visible }
    hide() { this.visible = false }
    changes = 0
    unmaximize() { this.maximized = false; this.emit('unmaximize') }
    maximize() { this.visible = true; this.maximized = true; this.emit('maximize') }
    setFullScreen(value) { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen') }
    isMaximized() { return this.maximized }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds) { this.bounds = { ...bounds }; this.changes++ }
    setMinimumSize(width, height) { this.minimum = [width, height] }
    isMinimized() { return this.minimized }
    isFullScreen() { return this.fullscreen }
    isDestroyed() { return this.destroyed }
    getNormalBounds() { return { ...this.bounds } }
  }
  const displays = new EventEmitter()
  let areas = [primary, secondary]
  displays.getAllDisplays = () => areas.map(workArea => ({ workArea }))
  displays.getPrimaryDisplay = () => ({ workArea: primary })
  const guarded = new Window()
  const ensure = guardWindowVisibility(guarded, displays)
  ensure()
  assert.equal(guarded.changes, 0)
  areas = [primary]
  displays.emit('display-removed')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(guarded.bounds.x, 360, 'hot unplug repairs hidden window too')
  guarded.bounds = { ...saved.bounds }
  guarded.emit('show')
  assert.equal(guarded.bounds.x, 360, 'tray show repairs position immediately')
  guarded.bounds = { ...saved.bounds }
  guarded.emit('focus')
  assert.equal(guarded.bounds.x, 360, 'second-instance focus repairs position')
  // Hidden maximized/fullscreen window on a removed display: exit, relocate,
  // restore the native mode without showing the window.
  for (const mode of ['maximized', 'fullscreen']) {
    guarded.maximized = false
    guarded.fullscreen = false
    guarded.bounds = { ...saved.bounds }
    guarded[mode] = true
    displays.emit('display-removed')
    guarded.emit('show')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(guarded.bounds.x, 360)
    assert.equal(guarded[mode], true, 'native mode restored after relocation')
    assert.equal(guarded.visible, false, 'recovery preserves hidden tray state')
    const before = guarded.changes
    ensure()
    assert.equal(guarded.changes, before, 'visible native window is untouched')
  }
  guarded.fullscreen = false
  guarded.minimized = true
  guarded.bounds = { ...saved.bounds }
  ensure()
  assert.equal(guarded.bounds.x, saved.bounds.x)
  guarded.minimized = false
  guarded.emit('restore')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(guarded.bounds.x, 360)
  displays.emit('display-metrics-changed')
  guarded.destroyed = true
  guarded.emit('closed')
  const changes = guarded.changes
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(displays.listenerCount(event), 0)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(guarded.changes, changes, 'closed window cancels pending topology work')

  const window = new Window()
  const writes = []
  trackWindowState(window, state => writes.push(state))
  window.emit('move')
  window.bounds.x = -1600
  window.emit('move')
  window.emit('resize')
  assert.equal(writes.length, 0)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(writes.length, 1, 'burst writes are debounced')
  assert.equal(writes[0].bounds.x, -1600)
  window.emit('maximize')
  window.minimized = true
  window.bounds = { x: -32000, y: -32000, width: 1, height: 1 }
  window.emit('resize')
  window.emit('close')
  assert.equal(writes.at(-1).maximized, true)
  assert.equal(writes.at(-1).bounds.x, -1600, 'minimized geometry is never persisted')
  window.minimized = false
  window.fullscreen = true
  window.emit('resize')
  window.emit('close')
  assert.equal(writes.at(-1).bounds.x, -1600, 'fullscreen geometry is never persisted')
  window.fullscreen = false
  window.bounds = { ...saved.bounds }
  window.emit('unmaximize')
  window.emit('close') // canceled close-to-tray still flushes
  assert.equal(writes.at(-1).maximized, false)
  window.bounds.x = -1500
  window.emit('move')
  window.emit('close')
  window.destroyed = true
  window.emit('closed')
  assert.equal(writes.at(-1).bounds.x, -1500, 'close flushes latest normal bounds')
  const count = writes.length
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(writes.length, count, 'no pending write survives window destruction')
} finally {
  console.warn = originalWarn
  rmSync(home, { recursive: true, force: true })
}
console.log('window-state: PASS (display geometry, persistence failures, debounce, tray/quit, minimized/fullscreen)')
