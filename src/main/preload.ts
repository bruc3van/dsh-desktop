/**
 * Desktop client preload: the minimal fixed surface exposed to the official
 * Web UI page, plus the client's own 桌面设置 tab — a nav item injected into
 * the OFFICIAL settings dialog below 通用设置, whose panel carries the
 * connection and app-update cards. Optional: if the official dialog cannot be
 * detected the native settings entry remains available. Recognized but unsupported
 * structures are reported through a bounded diagnostic without page content.
 * Runs sandboxed, so only Electron APIs are available.
 *
 * The bridge below is exposed on every document the window loads, which in
 * Connect mode is an address the user typed. It therefore carries no local
 * facts of its own (the OS username used to ride here on an argv flag and was
 * removed — nothing consumed it), and every channel it calls is authorized
 * against the sender's origin in the main process.
 * @module dsh-desktop/preload
 */

import './preload/bridge.ts'
import { watchPageTheme } from './preload/theme.ts'
import { watchSettingsDialog } from './preload/settings-observer.ts'

function start(): void {
  const stopTheme = watchPageTheme()
  const stopSettings = watchSettingsDialog()
  window.addEventListener('pagehide', () => {
    stopSettings()
    stopTheme()
  }, { once: true })
}

// A document restored from Chromium's back-forward cache needs fresh observers.
window.addEventListener('pageshow', event => { if (event.persisted) start() })

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
