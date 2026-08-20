/**
 * Browser permission policy for the official Web UI.
 *
 * Electron supplies two different permission callbacks. In particular,
 * notification checks may have no WebContents at all, so the decision must be
 * made from the visible, target, and requesting origins rather than from a
 * WebContents identity alone.
 */

export interface PermissionContext {
  permission: string
  visibleUrl: string
  targetUrl: string | undefined
  requestingUrl: string
  isMainFrame: boolean
}

/** Capabilities a user-selected remote Web UI needs without gaining device access. */
const REMOTE_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'notifications',
])

/**
 * Capabilities available to the client-owned loopback Web UI.
 *
 * Media keeps voice input viable, fileSystem covers user-mediated file/directory
 * pickers, and clipboard-read supports explicit paste/import actions. Device
 * APIs (USB/HID/serial), geolocation, screen capture, and storage escalation
 * remain denied because they need separate product UX and tighter scoping.
 */
const LOOPBACK_PERMISSIONS = new Set([
  ...REMOTE_PERMISSIONS,
  'clipboard-read',
  'fileSystem',
  'fullscreen',
  'media',
  'speaker-selection',
])

function httpOrigin(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1'
}

/**
 * Decide a renderer permission from the actual requesting origin.
 * Cross-origin frames are denied even when they share the trusted top-level
 * WebContents. Chromium reports fileSystem checks as non-main-frame even for a
 * top-level picker, so that permission is scoped by exact origin instead.
 */
export function permissionGrantedForContext(context: PermissionContext): boolean {
  const visible = httpOrigin(context.visibleUrl)
  const target = context.targetUrl === undefined ? undefined : httpOrigin(context.targetUrl)
  const requesting = httpOrigin(context.requestingUrl)
  if (visible === undefined || target === undefined || requesting === undefined) return false
  if (visible.origin !== target.origin || requesting.origin !== target.origin) return false
  if (!context.isMainFrame && context.permission !== 'fileSystem') return false

  const permissions = loopbackHost(target.hostname) ? LOOPBACK_PERMISSIONS : REMOTE_PERMISSIONS
  return permissions.has(context.permission)
}

/** Match the installed shortcut in production and Electron's documented dev identity locally. */
export function windowsAppUserModelId(packaged: boolean, executablePath: string): string {
  return packaged ? 'io.github.bruc3van.dsh-desktop' : executablePath
}
