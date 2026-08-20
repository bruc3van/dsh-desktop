/**
 * Install the unsigned-macOS fallback in the page's main world.
 *
 * This function is serialized by contextBridge.executeInMainWorld, so it must
 * remain self-contained: no imports, closures, or module-level constants.
 */
export function installMacNotificationFallback(): void {
  type DesktopFallbackBridge = {
    post: (payload: { id: string; title: string; body: string; tag: string }) => void
    clear: (id: string) => void
  }

  type DesktopWindow = Window & typeof globalThis & {
    desktop?: { notificationFallback?: DesktopFallbackBridge }
    __dshMacNotificationFallbackInstalled?: boolean
  }

  const desktopWindow = window as DesktopWindow
  const bridge = desktopWindow.desktop?.notificationFallback
  if (bridge === undefined || desktopWindow.__dshMacNotificationFallbackInstalled === true) return
  const fallbackBridge: DesktopFallbackBridge = bridge
  desktopWindow.__dshMacNotificationFallbackInstalled = true

  const toasts = new Map<string, HTMLElement>()
  const taggedNotifications = new Map<string, { close: () => void }>()
  let nextId = 0
  let toastRoot: ShadowRoot | undefined

  const root = (): ShadowRoot => {
    if (toastRoot !== undefined) return toastRoot
    const host = document.createElement('div')
    host.id = 'dsh-desktop-notification-fallback'
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    ;(document.documentElement || document.body).append(host)
    toastRoot = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      :host{all:initial}
      .stack{position:fixed;top:18px;right:18px;display:flex;flex-direction:column;gap:10px;
        width:min(360px,calc(100vw - 36px));pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,
        "Segoe UI",sans-serif;color:#17181a}
      .toast{pointer-events:auto;display:grid;grid-template-columns:1fr auto;gap:5px 12px;padding:14px 14px 13px;
        border:1px solid rgba(15,17,21,.12);border-radius:13px;background:rgba(252,252,253,.96);
        box-shadow:0 12px 36px rgba(15,17,21,.18);backdrop-filter:blur(18px);cursor:pointer}
      .toast:hover{background:#fff}.title{font-size:14px;line-height:20px;font-weight:650;overflow-wrap:anywhere}
      .body{grid-column:1/-1;font-size:13px;line-height:19px;color:#5f636b;white-space:pre-wrap;overflow-wrap:anywhere}
      .close{grid-column:2;grid-row:1;border:0;background:transparent;color:#767b84;padding:0 2px;font-size:18px;
        line-height:20px;cursor:pointer}.close:hover{color:#17181a}
      @media(prefers-color-scheme:dark){.toast{color:#f3f4f6;background:rgba(37,39,43,.96);border-color:rgba(255,255,255,.13)}
        .toast:hover{background:#2d3035}.body{color:#b5bac3}.close{color:#9da3ad}.close:hover{color:#fff}}
    `
    const stack = document.createElement('div')
    stack.className = 'stack'
    toastRoot.append(style, stack)
    return toastRoot
  }

  class FallbackNotification extends EventTarget {
    static readonly maxActions = 0
    static readonly permission: NotificationPermission = 'granted'

    static requestPermission(deprecatedCallback?: NotificationPermissionCallback): Promise<NotificationPermission> {
      deprecatedCallback?.('granted')
      return Promise.resolve('granted')
    }

    readonly body: string
    readonly data: unknown
    readonly dir: NotificationDirection
    readonly icon: string
    readonly lang: string
    readonly requireInteraction: boolean
    readonly silent: boolean | null
    readonly tag: string
    readonly title: string
    onclick: ((this: Notification, ev: Event) => unknown) | null = null
    onclose: ((this: Notification, ev: Event) => unknown) | null = null
    onerror: ((this: Notification, ev: Event) => unknown) | null = null
    onshow: ((this: Notification, ev: Event) => unknown) | null = null

    readonly #id: string
    #closed = false

    constructor(title: string, options: NotificationOptions = {}) {
      super()
      this.#id = 'mac-fallback-' + String(Date.now()) + '-' + String(++nextId)
      this.title = String(title).slice(0, 256)
      this.body = String(options.body ?? '').slice(0, 2048)
      this.data = options.data
      this.dir = options.dir ?? 'auto'
      this.icon = options.icon ?? ''
      this.lang = options.lang ?? ''
      this.requireInteraction = options.requireInteraction ?? false
      this.silent = options.silent ?? null
      this.tag = options.tag ?? ''

      // Web Notifications use a non-empty tag as a replacement key. Close the
      // previous fallback before posting the successor so its toast and Dock
      // entry cannot survive as stale attention.
      if (this.tag !== '') {
        taggedNotifications.get(this.tag)?.close()
        taggedNotifications.set(this.tag, this)
      }

      const toast = document.createElement('div')
      toast.className = 'toast'
      toast.setAttribute('role', 'alert')
      toast.tabIndex = 0
      const heading = document.createElement('div')
      heading.className = 'title'
      heading.textContent = this.title
      const close = document.createElement('button')
      close.className = 'close'
      close.type = 'button'
      close.setAttribute('aria-label', 'Dismiss')
      close.textContent = '×'
      toast.append(heading, close)
      if (this.body !== '') {
        const body = document.createElement('div')
        body.className = 'body'
        body.textContent = this.body
        toast.append(body)
      }
      const activate = (): void => {
        const event = new Event('click')
        this.onclick?.call(this, event)
        this.dispatchEvent(event)
        this.close()
      }
      toast.addEventListener('click', activate)
      toast.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      })
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        this.close()
      })
      root().querySelector('.stack')?.prepend(toast)
      toasts.set(this.#id, toast)
      fallbackBridge.post({ id: this.#id, title: this.title, body: this.body, tag: this.tag })
      queueMicrotask(() => {
        if (this.#closed) return
        const event = new Event('show')
        this.onshow?.call(this, event)
        this.dispatchEvent(event)
      })
    }

    close(): void {
      if (this.#closed) return
      this.#closed = true
      if (this.tag !== '' && taggedNotifications.get(this.tag) === this) taggedNotifications.delete(this.tag)
      toasts.get(this.#id)?.remove()
      toasts.delete(this.#id)
      fallbackBridge.clear(this.#id)
      const event = new Event('close')
      this.onclose?.call(this, event)
      this.dispatchEvent(event)
    }
  }

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    enumerable: true,
    value: FallbackNotification,
    writable: false,
  })
}
