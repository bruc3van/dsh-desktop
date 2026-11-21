/**
 * Render every tray icon from resources/icon.svg (see JOBS): one PNG per
 * Windows tray slot size (SM_CXSMICON: 16 at 100% scaling, 20 at 125%, 24 at
 * 150%, 32 at 200%, and the larger slots above them), the Windows fallback, and
 * the macOS menu-bar Template image.
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
/**
 * Clear margin around the glyph, as a fraction of the icon box. None: the whale
 * is about 1.6 times wider than tall, so even edge to edge it stands shorter
 * than the square glyphs beside it in the notification area.
 */
const PADDING_RATIO = 0
/**
 * Outline added around the glyph, in output pixels at every size. The striped
 * belly breaks into grey noise at 16-24px; a half-pixel outline in the glyph's
 * own colour closes those gaps and gives it the weight of the shell's icons.
 */
const STROKE_PX = 0.5
/**
 * One rendered set per taskbar brightness, keyed by the resource prefix
 * src/main/index.ts asks for. Windows draws the notification area from the
 * SYSTEM colour mode, which the user can set independently of the app mode, so
 * a white-only glyph disappears entirely on a light taskbar. Near-black rather
 * than pure black for the light set: it matches the weight the shell's own
 * icons carry there.
 */
const FILLS = [
  { prefix: 'iconTray-', fill: '#ffffff' },
  { prefix: 'iconTrayDark-', fill: '#181818' },
]

/**
 * Every file this script writes. `square` files fit the glyph inside a size x
 * size box (the Windows notification-area slots); `wide` files keep the glyph's
 * own aspect at a fixed height. `scale` is the pixel density the file is drawn
 * for, so the outline stays STROKE_PX points wide on a @2x file too.
 *
 * - iconTray-* / iconTrayDark-*: Windows, one per slot size and taskbar mode.
 * - iconTrayWhite: Windows fallback when an exact slot file is missing.
 * - iconMenuTemplate: the macOS menu-bar Template image (and the Linux
 *   indicator). The menu bar takes items wider than tall, and a square box
 *   would leave the whale about 10pt high beside 16pt neighbours — yet full
 *   16pt height stretches the ~1.6:1 whale to 26pt wide, looking noticeably
 *   larger than square/compact neighbours. 14pt tall keeps it around 22-23pt
 *   wide for balanced optical weight. Black: macOS reads only the alpha of a
 *   Template image and paints it to suit the menu bar.
 */
const JOBS = [
  ...FILLS.flatMap(({ prefix, fill }) => SIZES.map(size => ({ file: prefix + String(size) + '.png', fill, shape: 'square', size, scale: 1 }))),
  { file: 'iconTrayWhite.png', fill: '#ffffff', shape: 'square', size: 16, scale: 1 },
  { file: 'iconTrayWhite@2x.png', fill: '#ffffff', shape: 'square', size: 32, scale: 2 },
  { file: 'iconMenuTemplate.png', fill: '#000000', shape: 'wide', size: 14, scale: 1 },
  { file: 'iconMenuTemplate@2x.png', fill: '#000000', shape: 'wide', size: 28, scale: 2 },
]

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
 * a prefers-color-scheme rule that recolours it; a tray icon is drawn over the
 * taskbar rather than over a page, so the rule cannot apply and both fills are
 * rasterised explicitly instead (see FILLS).
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
      const jobs = ${JSON.stringify(JOBS)}
      const padding = ${String(PADDING_RATIO)}
      const strokePx = ${String(STROKE_PX)}
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

      // A viewBox centred on that extent with the canvas's own aspect: any
      // other lets the renderer letterbox the glyph and undoes the fit. The
      // outline is a fixed width in points, so its width in viewBox units — and
      // the room the box keeps for it — depends on the output size.
      const fit = ({ shape, size, scale }) => {
        const long = shape === 'square' ? Math.max(box.width, box.height) : box.height
        const base = long / (1 - 2 * padding)
        const strokeWidth = base / size * strokePx * scale
        const height = base + strokeWidth
        const width = shape === 'square' ? height : box.width + (height - box.height)
        const viewBox = [
          box.x + box.width / 2 - width / 2,
          box.y + box.height / 2 - height / 2,
          width,
          height,
        ].join(' ')
        return { strokeWidth, viewBox, width: Math.round((size / scale) * width / height) * scale, height: size }
      }

      const draw = (job) => new Promise((resolve, reject) => {
        const { strokeWidth, viewBox, width, height } = fit(job)
        const markup = '<svg xmlns="' + NS + '" width="' + width + '" height="' + height + '"'
          + ' viewBox="' + viewBox + '" preserveAspectRatio="xMidYMid meet"><path d="' + glyph.d + '" fill="' + job.fill + '" fill-rule="nonzero"'
          + ' stroke="' + job.fill + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round"/></svg>'
        const image = new Image(width, height)
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          context.clearRect(0, 0, width, height)
          context.drawImage(image, 0, 0, width, height)
          resolve({ file: job.file, width, height, data: canvas.toDataURL('image/png'), viewBox })
        }
        image.onerror = () => { reject(new Error('could not rasterise ' + job.file)) }
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
      })

      const rendered = []
      for (const job of jobs) rendered.push(await draw(job))
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
    for (const { file: name, width, height, data, viewBox } of rendered) {
      const file = join(RESOURCES, name)
      writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'))
      log('wrote ' + file + ' (' + String(width) + 'x' + String(height) + ', viewBox ' + viewBox + ')')
    }
    clearTimeout(guard)
    app.exit(0)
  } catch (error) {
    log('failed: ' + (error instanceof Error ? error.message : String(error)))
    clearTimeout(guard)
    app.exit(1)
  }
})
