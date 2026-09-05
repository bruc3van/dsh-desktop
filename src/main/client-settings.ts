import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateSmartRuntimes, type SmartRuntimeId } from './smart-runtimes.ts'
import { normalizeLocalWebPort } from './local-web-port.ts'
import { normalizeDshDataMode, normalizePluginPackageName, type DshDataMode } from './data-home.ts'

export interface ClientSettings {
  /** A reusable fixed Web UI origin. Empty/absent means Smart mode only. */
  serverUrl?: string
  /** Missing preserves the legacy behavior: a saved serverUrl is active. */
  connectionMode?: 'smart' | 'connect'
  /** Last in-app update the user chose to ignore. */
  updateDismissedVersion?: string
  /**
   * The one-time notice about the pre-rename macOS bundle has been shown.
   * Durable: it is a migration aid, and one that reappeared on every launch
   * until the user tidied Applications would be a standing complaint instead.
   */
  legacyBundleNoticeShown?: boolean
  /** Epoch ms of the last completed update check (auto-check throttle). */
  updateLastCheckedAt?: number
  /**
   * The user asked this client to stop seating the bundled marketplace.
   *
   * Durable, and kept HERE rather than in the profile: opting out is a
   * statement about this client, and the profile is the user's own file. It
   * has to be durable at all because the seat is re-offered on every start —
   * without a record, removing the market would simply undo itself the next
   * time the app opened, which reads as "it will not go away".
   */
  bundledMarketDisabled?: boolean
  /**
   * Which Smart-mode sources this client will try, in ladder order.
   * Missing means all four (legacy). An empty list is refused on save.
   */
  smartRuntimes?: SmartRuntimeId[]
  /**
   * Bind port for a `dsh web` this client starts. Missing or 0 means automatic:
   * 3080, then 13080, then an OS-assigned port. A positive value is passed as
   * `--port` on that spawn only — never written into the shared profile patch layer.
   */
  localWebPort?: number
  /** Shared official ~/.dsh, or the client-owned isolated DSH home. */
  dshDataMode?: DshDataMode
  /** Why compatibility recovery selected the isolated environment. */
  dshDataFallbackReason?: 'plugin-compatibility'
  /** Package named by the compatibility diagnostic, when it was safe to extract. */
  dshDataFallbackPlugin?: string
  /** All packages named by the compatibility diagnostic, in diagnostic order. */
  dshDataFallbackPlugins?: string[]
  /** The one-time compatibility fallback explanation has been acknowledged. */
  dshDataFallbackNoticeShown?: boolean
}

export function createClientSettingsStore(home: string) {
  const clientHome = (): string => home
  /** The client's own settings document (connection configuration). */
  const SETTINGS_FILE = join(home, 'settings.json')
  let reportedReadFailure = false
  function loadSettings(): ClientSettings {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as ClientSettings
      reportedReadFailure = false
      return settings
    } catch (error) {
      // A missing file is normal on first launch. Do not log parser messages:
      // newer Node versions include a fragment of the settings JSON in them.
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!missing && !reportedReadFailure) {
        reportedReadFailure = true
        console.warn('[desktop] could not load settings.json ('
          + (error instanceof SyntaxError ? 'invalid JSON' : 'read failed') + '); using defaults')
      }
      return {}
    }
  }

  function saveSettings(settings: ClientSettings): void {
    // The document holds no credential, but it does hold the address every
    // session connects to. On a shared POSIX machine the default umask would
    // leave that world-readable (and, worse, group-writable under a lax umask).
    mkdirSync(clientHome(), { recursive: true, mode: 0o700 })
    // Written through a temporary file and renamed, for the same reason the
    // runtime lock is: a torn read parses as "no settings", silently dropping
    // the connection mode, the pinned address, and the ignored-update record.
    const temporary = SETTINGS_FILE + '.' + String(process.pid) + '.tmp'
    const backup = SETTINGS_FILE + '.' + String(process.pid) + '.bak'
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    try {
      renameSync(temporary, SETTINGS_FILE)
    } catch {
      // Windows: a rename onto a live file can fail transiently (a scanner
      // holding it open). Move the current document ASIDE first, put the new
      // one in place, then drop the backup — so a failed swap can never leave
      // NEITHER version in place, and the user's configured address cannot be
      // lost to a transient lock.
      try { rmSync(backup, { force: true }) } catch { /* nothing to clean up */ }
      try {
        try { renameSync(SETTINGS_FILE, backup) } catch { /* nothing there yet */ }
        renameSync(temporary, SETTINGS_FILE)
      } catch (error) {
        if (!existsSync(SETTINGS_FILE)) {
          try { renameSync(backup, SETTINGS_FILE) } catch { /* best effort */ }
        }
        try { rmSync(temporary, { force: true }) } catch { /* nothing to clean up */ }
        throw error
      }
      try { rmSync(backup, { force: true }) } catch { /* litter, not failure */ }
    }
    // The mode above applies only when the file is created, so an install that
    // predates it would keep its old permissions forever. chmod every save
    // instead; on Windows it is a no-op, and a read-only path is not worth
    // failing a settings write over.
    if (process.platform !== 'win32') {
      try {
        chmodSync(clientHome(), 0o700)
        chmodSync(SETTINGS_FILE, 0o600)
      } catch { /* best effort: the write itself already succeeded */ }
    }
  }

  /** Merge settings and persist. `unset` drops keys so a later save cannot leak them. */
  function patchSettings(patch: Partial<ClientSettings> = {}, unset: readonly (keyof ClientSettings)[] = []): void {
    const merged: ClientSettings = { ...loadSettings(), ...patch }
    const skip = new Set(unset)
    const next: ClientSettings = {}
    if (!skip.has('serverUrl') && merged.serverUrl !== undefined) next.serverUrl = merged.serverUrl
    if (!skip.has('connectionMode') && merged.connectionMode !== undefined) next.connectionMode = merged.connectionMode
    if (!skip.has('bundledMarketDisabled') && merged.bundledMarketDisabled !== undefined) {
      next.bundledMarketDisabled = merged.bundledMarketDisabled
    }
    if (!skip.has('smartRuntimes')) {
      const parsed = validateSmartRuntimes(merged.smartRuntimes)
      if (parsed !== undefined) next.smartRuntimes = parsed
    }
    if (!skip.has('localWebPort')) {
      const parsed = normalizeLocalWebPort(merged.localWebPort)
      if (parsed > 0) next.localWebPort = parsed
    }
    if (!skip.has('dshDataMode') && merged.dshDataMode !== undefined) {
      next.dshDataMode = normalizeDshDataMode(merged.dshDataMode)
    }
    if (!skip.has('dshDataFallbackReason') && merged.dshDataFallbackReason === 'plugin-compatibility') {
      next.dshDataFallbackReason = merged.dshDataFallbackReason
    }
    if (!skip.has('dshDataFallbackPlugin')) {
      const plugin = normalizePluginPackageName(merged.dshDataFallbackPlugin)
      if (plugin !== undefined) next.dshDataFallbackPlugin = plugin
    }
    if (!skip.has('dshDataFallbackPlugins') && Array.isArray(merged.dshDataFallbackPlugins)) {
      const plugins = [...new Set(merged.dshDataFallbackPlugins
        .map(normalizePluginPackageName)
        .filter((plugin): plugin is string => plugin !== undefined))]
      if (plugins.length > 0) next.dshDataFallbackPlugins = plugins
    }
    if (!skip.has('dshDataFallbackNoticeShown') && merged.dshDataFallbackNoticeShown !== undefined) {
      next.dshDataFallbackNoticeShown = merged.dshDataFallbackNoticeShown
    }
    if (!skip.has('updateDismissedVersion') && merged.updateDismissedVersion !== undefined) {
      next.updateDismissedVersion = merged.updateDismissedVersion
    }
    if (!skip.has('updateLastCheckedAt') && merged.updateLastCheckedAt !== undefined) {
      next.updateLastCheckedAt = merged.updateLastCheckedAt
    }
    if (!skip.has('legacyBundleNoticeShown') && merged.legacyBundleNoticeShown !== undefined) {
      next.legacyBundleNoticeShown = merged.legacyBundleNoticeShown
    }
    saveSettings(next)
  }

  return { loadSettings, patchSettings }
}
