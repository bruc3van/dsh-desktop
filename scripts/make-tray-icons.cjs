/**
 * Render the notification-area icons from resources/icon.svg, one PNG per
 * Windows tray slot size (SM_CXSMICON: 16 at 100% scaling, 20 at 125%, 24 at
 * 150%, 32 at 200%, and the larger slots above them).
 *
 * A single 16px source is what made the shipped tray icon look soft: Windows
 * takes the 1x representation of the image and stretches it to whatever slot the
 * display scale asks for. Rasterising the vector at each exact size removes the
 * stretch, so createTray can hand the shell an icon that already fits.
 *
 * The glyph is fitted to its own bounding box rather than to the artboard: the
 * whale is wider than tall, and the 50x50 viewBox leaves empty bands above and
 * below it — at 16px that padding is most of the icon's visual weight.
 *
 * CommonJS on purpose, unlike the rest of scripts/: this file is an Electron
 * MAIN entry, and an ESM entry passed to the electron binary never reaches
 * app.whenReady() (the process starts, logs, and then sits there). Every other
 * script here runs under plain Node, where .mjs is fine.
 *
 * Run: npm run icons:tray
 * @module desktop/scripts/make-tray-icons
 */

const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const APP_DIR = join(__dirname, '..')
const RESOURCES = join(APP_DIR, 'resources')
const SOURCE_SVG = join(RESOURCES, 'icon.svg')
/**
 * Electron is a GUI subsystem binary on Windows, so console output from this
 * process does not reliably reach the shell that started it. The progress log
 * goes to a file as well, which is what makes a failed run diagnosable at all.
 */
const LOG_FILE = join(APP_DIR, '.build', 'make-tray-icons.log')

/** Kept in sync with TRAY_ICON_SIZES in src/main/index.ts. */
const SIZES = [16, 20, 24, 32, 40, 48]
/** Clear margin around the glyph, as a fraction of the icon box. */
const PADDING_RATIO = 0.06

function log(message) {
  const line = '[icons] ' + message
  console.log(line)
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // No .build directory on a source-only checkout: the console line stands.
  }
}

/**
 * The glyph path, taken from the source artwork. The file carries one path plus
 * a prefers-color-scheme rule that recolours it; the tray variant is always the
 * white one (see createTray — the Windows taskbar can be dark while the app is
 * in light mode), so the rule is dropped and the fill is set explicitly.
 */
function readGlyphPath() {
  const svg = readFileSync(SOURCE_SVG, 'utf8')
  const path = /<path\b[^>]*\bd="([^"]+)"/.exec(svg)
  if (path === null) throw new Error('no <path d="…"> found in ' + SOURCE_SVG)
  const viewBox = /viewBox="([^"]+)"/.exec(svg)
  if (viewBox === null) throw new Error('no viewBox found in ' + SOURCE_SVG)
  return { d: path[1], viewBox: viewBox[1] }
}

/**
 * Rasterise the glyph in a hidden window. Measuring (getBBox) and drawing both
 * need a real engine, so they share one page: the SVG goes in as a data URL,
 * which leaves the canvas untainted and lets toDataURL return the pixels with
 * their alpha intact.
 */
async function renderSizes(glyph) {
  const window = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>',
    ))
    log('rasteriser ready')
    return await window.webContents.executeJavaScript(`(async () => {
      const glyph = ${JSON.stringify(glyph)}
      const sizes = ${JSON.stringify(SIZES)}
      const padding = ${String(PADDING_RATIO)}
      const NS = 'http://www.w3.org/2000/svg'

      // Measure the drawn extent of the path, not the artboard it sits in.
      const probe = document.createElementNS(NS, 'svg')
      probe.setAttribute('viewBox', glyph.viewBox)
      const probePath = document.createElementNS(NS, 'path')
      probePath.setAttribute('d', glyph.d)
      probe.appendChild(probePath)
      document.body.appendChild(probe)
      const box = probePath.getBBox()
      probe.remove()
      if (!(box.width > 0 && box.height > 0)) throw new Error('empty glyph bounding box')

      // A square viewBox centred on that extent: a non-square one lets the
      // renderer letterbox the glyph and undoes the fit.
      const side = Math.max(box.width, box.height) / (1 - 2 * padding)
      const viewBox = [
        box.x + box.width / 2 - side / 2,
        box.y + box.height / 2 - side / 2,
        side,
        side,
      ].join(' ')

      const draw = (size) => new Promise((resolve, reject) => {
        const markup = '<svg xmlns="' + NS + '" width="' + size + '" height="' + size + '"'
          + ' viewBox="' + viewBox + '"><path d="' + glyph.d + '" fill="#ffffff" fill-rule="nonzero"/></svg>'
        const image = new Image(size, size)
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const context = canvas.getContext('2d')
          context.clearRect(0, 0, size, size)
          context.drawImage(image, 0, 0, size, size)
          resolve({ size, data: canvas.toDataURL('image/png'), viewBox })
        }
        image.onerror = () => { reject(new Error('could not rasterise at ' + size + 'px')) }
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
      })

      const rendered = []
      for (const size of sizes) rendered.push(await draw(size))
      return rendered
    })()`, true)
  } finally {
    window.destroy()
  }
}

// One rasterisation pass has no use for a GPU, and asking for one is a way to
// hang on a machine with no usable graphics stack.
app.disableHardwareAcceleration()
// A hang must not leave an invisible GUI process holding the checkout.
const guard = setTimeout(() => {
  log('timed out waiting for the rasteriser')
  app.exit(1)
}, 60_000)

app.whenReady().then(async () => {
  try {
    const rendered = await renderSizes(readGlyphPath())
    log('fitted viewBox ' + String(rendered[0].viewBox))
    for (const { size, data } of rendered) {
      const file = join(RESOURCES, 'iconTray-' + String(size) + '.png')
      writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'))
      log('wrote ' + file)
    }
    clearTimeout(guard)
    app.exit(0)
  } catch (error) {
    log('failed: ' + (error instanceof Error ? error.message : String(error)))
    clearTimeout(guard)
    app.exit(1)
  }
})
