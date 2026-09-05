/** Permission-policy regression checks, including Electron's null-WebContents notification path. */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function bundledModule(relativeUrl) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relativeUrl, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  })
  const source = result.outputFiles[0]?.text
  if (source === undefined) throw new Error(relativeUrl + ' did not compile')
  return await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}

const policy = await bundledModule('../src/main/permission-policy.ts')

const local = 'http://127.0.0.1:3080/'
const remote = 'https://harness.example/'
const thirdParty = 'https://embed.example/'

function check(name, value) {
  if (!value) throw new Error('permission policy: ' + name)
  console.log('✓ ' + name)
}

const granted = (permission, overrides = {}) => policy.permissionGrantedForContext({
  permission,
  visibleUrl: local,
  targetUrl: local,
  requestingUrl: local,
  isMainFrame: true,
  clientOwned: true,
  ...overrides,
})

check('loopback notification check works without relying on WebContents', granted('notifications'))
check('localhost and IPv6 loopback receive the same policy',
  granted('notifications', {
    visibleUrl: 'http://localhost:3080/',
    targetUrl: 'http://localhost:3080/',
    requestingUrl: 'http://localhost:3080/',
  })
  && granted('notifications', {
    visibleUrl: 'http://[::1]:3080/',
    targetUrl: 'http://[::1]:3080/',
    requestingUrl: 'http://[::1]:3080/',
  }))
check('unowned loopback does not acquire device or file permissions',
  !granted('media', { clientOwned: false }) && !granted('clipboard-read', { clientOwned: false })
  && !granted('fileSystem', { clientOwned: false }))
check('loopback voice input is not blocked', granted('media'))
check('loopback clipboard read is not blocked', granted('clipboard-read'))
check('loopback file picker survives Chromium non-main-frame reporting', granted('fileSystem', { isMainFrame: false }))
check('cross-origin sub-frame notification is denied', !granted('notifications', {
  requestingUrl: thirdParty,
  isMainFrame: false,
}))
check('unrelated WebContents target is denied', !granted('notifications', { visibleUrl: thirdParty }))
check('remote target keeps clipboard writes', granted('clipboard-sanitized-write', {
  visibleUrl: remote,
  targetUrl: remote,
  requestingUrl: remote,
}))
check('remote target may show user-authorized notifications', granted('notifications', {
  visibleUrl: remote,
  targetUrl: remote,
  requestingUrl: remote,
}))
check('remote target cannot acquire microphone or camera', !granted('media', {
  visibleUrl: remote,
  targetUrl: remote,
  requestingUrl: remote,
}))
check('device, geolocation, and display capture stay denied locally',
  !granted('usb') && !granted('geolocation') && !granted('display-capture'))
check('packaged Windows identity matches electron-builder appId',
  policy.windowsAppUserModelId(true, 'C:/electron.exe') === 'io.github.bruc3van.dsh-desktop')
check('development Windows identity follows Electron executable',
  policy.windowsAppUserModelId(false, 'C:/electron.exe') === 'C:/electron.exe')

// The macOS fallback runs in Chromium's page world, but its core contract can
// be guarded on every CI platform with this deliberately tiny DOM fixture.
// It catches accidental closure captures (executeInMainWorld serializes the
// function), Notification API drift, lost in-app toasts, and broken clearing.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.listeners = new Map()
    this.style = { cssText: '' }
    this.className = ''
    this.textContent = ''
    this.removed = false
  }
  append(...children) {
    for (const child of children) child.parent = this
    this.children.push(...children)
  }
  prepend(...children) {
    for (const child of children) child.parent = this
    this.children.unshift(...children)
  }
  setAttribute() {}
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }
  attachShadow() {
    this.shadow = new FakeElement('shadow-root')
    return this.shadow
  }
  querySelector(selector) {
    if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) return this
    for (const child of this.children) {
      const found = child.querySelector?.(selector)
      if (found !== undefined && found !== null) return found
    }
    return null
  }
  querySelectorAll(selector) {
    const matches = []
    if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) matches.push(this)
    for (const child of this.children) matches.push(...(child.querySelectorAll?.(selector) ?? []))
    return matches
  }
  remove() {
    this.removed = true
    if (this.parent !== undefined) this.parent.children = this.parent.children.filter(child => child !== this)
  }
}

const posts = []
const clears = []
const documentElement = new FakeElement('html')
const originalWindow = globalThis.window
const originalDocument = globalThis.document
globalThis.document = {
  documentElement,
  body: new FakeElement('body'),
  createElement: tagName => new FakeElement(tagName),
}
globalThis.window = {
  desktop: {
    notificationFallback: {
      post: payload => { posts.push(payload) },
      clear: id => { clears.push(id) },
    },
  },
  Notification: class NativeNotification {},
}

try {
  const fallback = await bundledModule('../src/main/mac-notification-fallback.ts')
  // Prove the serialized function has no module closure dependency.
  const install = (0, eval)('(' + fallback.installMacNotificationFallback.toString() + ')')
  install()
  let callbackPermission
  const requested = await globalThis.window.Notification.requestPermission(value => { callbackPermission = value })
  check('unsigned macOS fallback reports granted to the existing Web Notification plugin',
    requested === 'granted' && callbackPermission === 'granted' && globalThis.window.Notification.permission === 'granted')

  const notification = new globalThis.window.Notification('Session · Done', {
    body: 'The background turn completed.',
    tag: 'turn:7',
    requireInteraction: true,
  })
  await Promise.resolve()
  check('unsigned macOS fallback forwards Dock attention and renders an in-app reminder',
    posts.length === 1
    && posts[0].title === 'Session · Done'
    && posts[0].tag === 'turn:7'
    && documentElement.children[0]?.shadow?.querySelector('.toast') !== null)

  const replacement = new globalThis.window.Notification('Session · Updated', {
    body: 'A newer state replaced the completed turn.',
    tag: 'turn:7',
  })
  await Promise.resolve()
  const stack = documentElement.children[0]?.shadow?.querySelector('.stack')
  check('same-tag macOS fallback replaces the stale toast and Dock entry',
    posts.length === 2
    && clears.length === 1
    && clears[0] === posts[0].id
    && stack?.querySelectorAll('.toast').length === 1)

  const otherTag = new globalThis.window.Notification('Another session', { tag: 'session:other' })
  const untaggedOne = new globalThis.window.Notification('Untagged one')
  const untaggedTwo = new globalThis.window.Notification('Untagged two')
  check('different and empty tags remain independent notifications',
    stack?.querySelectorAll('.toast').length === 4 && posts.length === 5)

  notification.close() // replaced already: must stay idempotent
  replacement.close()
  otherTag.close()
  untaggedOne.close()
  untaggedTwo.close()
  check('closing or opening fallback reminders clears every Dock entry',
    clears.length === 5 && new Set(clears).size === 5 && stack?.querySelectorAll('.toast').length === 0)
} finally {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
}

// Windows keeps the real Web Notification UI, but its renderer click must
// cross the preload bridge to restore/show the native BrowserWindow. Exercise
// the serialized page-world hook with an EventTarget-backed native stand-in.
let activations = 0
let pluginClicks = 0
class FakeNativeNotification extends EventTarget {
  static permission = 'granted'
  static requestPermission() { return Promise.resolve('granted') }
  dispatchEvent(event) {
    const dispatched = super.dispatchEvent(event)
    this.onclick?.(event)
    return dispatched
  }
}
globalThis.window = {
  desktop: {
    notificationActivation: {
      activate: () => { activations += 1 },
    },
  },
  Notification: FakeNativeNotification,
}

try {
  const activation = await bundledModule('../src/main/windows-notification-activation.ts')
  const install = (0, eval)('(' + activation.installWindowsNotificationActivation.toString() + ')')
  install()
  install()
  const notification = new globalThis.window.Notification('Session · Done')
  notification.onclick = () => { pluginClicks += 1 }
  notification.dispatchEvent(new Event('click'))
  notification.dispatchEvent(new Event('click'))
  check('Windows notification click activates the native window exactly once without swallowing the plugin click',
    activations === 1 && pluginClicks === 2)
  check('Windows notification activation preserves the native API surface',
    notification instanceof FakeNativeNotification
    && globalThis.window.Notification.permission === 'granted'
    && await globalThis.window.Notification.requestPermission() === 'granted')
} finally {
  globalThis.window = originalWindow
}
