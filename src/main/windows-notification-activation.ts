/**
 * Make renderer Web Notification clicks raise the native Electron window.
 *
 * A DOM `window.focus()` only focuses the page; it cannot restore a minimized
 * BrowserWindow or show one hidden in the tray. This hook runs in the page
 * world and asks the narrow preload bridge to perform that native activation
 * before the notification plugin handles its own click-to-session routing.
 */
export function installWindowsNotificationActivation(): void {
  const desktopWindow = window as typeof window & {
    desktop?: { notificationActivation?: { activate: () => void } }
    __dshWindowsNotificationActivationInstalled?: boolean
  }
  const bridge = desktopWindow.desktop?.notificationActivation
  if (bridge === undefined || desktopWindow.__dshWindowsNotificationActivationInstalled === true) return

  const NativeNotification = desktopWindow.Notification
  if (typeof NativeNotification !== 'function') return
  desktopWindow.__dshWindowsNotificationActivationInstalled = true

  const ActivatingNotification = new Proxy(NativeNotification, {
    construct(target, args) {
      // Use the native constructor as newTarget as well: WebIDL constructors
      // need not support subclassing, while the Proxy should remain invisible
      // to plugins (`instanceof Notification` and the native prototype stay).
      const notification = Reflect.construct(target, args, target) as Notification
      notification.addEventListener('click', () => { bridge.activate() }, { once: true })
      return notification
    },
    // Some browser statics are accessors whose receiver must be the native
    // constructor rather than the Proxy (notably `permission`).
    get(target, property) {
      return Reflect.get(target, property, target) as unknown
    },
  })

  Object.defineProperty(desktopWindow, 'Notification', {
    configurable: true,
    writable: true,
    value: ActivatingNotification,
  })
}
