import { cpSync, existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type DshDataMode = 'shared' | 'isolated'

export function normalizeDshDataMode(value: unknown): DshDataMode {
  return value === 'isolated' ? 'isolated' : 'shared'
}

export function dshHomeForMode(mode: DshDataMode, userHome: string, clientHome: string): string {
  return mode === 'isolated' ? join(clientHome, 'dsh') : join(userHome, '.dsh')
}

/** Isolated mode cannot use the shared-profile localhost probe. */
export function hasIsolatedRuntimeSource(runtimeIds: readonly string[]): boolean {
  return runtimeIds.some((id) => id === 'installed' || id === 'npx' || id === 'bundled')
}

/**
 * DSH wraps bundle resolution, import and activation failures in one of these
 * messages. Keep this deliberately narrow: changing data homes cannot repair a
 * port conflict, a missing runtime, filesystem permissions or arbitrary bad
 * configuration.
 */
export function isPluginCompatibilityFailure(diagnostic: string): boolean {
  return /plugin\(s\) failed to (?:load|activate)\b/i.test(diagnostic)
    || /bundle package ["'].+?["'] (?:was not found|does not declare dsh\.bundle)\b/i.test(diagnostic)
}

export type ClientHomeMigrationResult = 'not-needed' | 'moved' | 'copied'

const LEGACY_SETTING_KEYS = new Set([
  'serverUrl',
  'connectionMode',
  'updateDismissedVersion',
  'legacyBundleNoticeShown',
  'updateLastCheckedAt',
  'bundledMarketDisabled',
  'smartRuntimes',
  'localWebPort',
])

/** A generic directory name is not ownership proof; require a recognisable settings document. */
export function isLegacyClientHome(legacyHome: string): boolean {
  try {
    if (!lstatSync(legacyHome).isDirectory()) return false
    const parsed = JSON.parse(readFileSync(join(legacyHome, 'settings.json'), 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).some((key) => LEGACY_SETTING_KEYS.has(key))
  } catch {
    return false
  }
}

/**
 * Move the pre-brand namespace when the new namespace has never been used.
 * The copy fallback is for a transient/volume-specific rename refusal; it
 * intentionally leaves the legacy directory as a recoverable backup.
 */
export function migrateLegacyClientHome(legacyHome: string, nextHome: string): ClientHomeMigrationResult {
  if (!existsSync(legacyHome) || existsSync(nextHome) || !isLegacyClientHome(legacyHome)) return 'not-needed'
  try {
    renameSync(legacyHome, nextHome)
    return 'moved'
  } catch {
    const temporary = nextHome + '.migration-' + String(process.pid)
    try {
      rmSync(temporary, { recursive: true, force: true })
      cpSync(legacyHome, temporary, { recursive: true, errorOnExist: true })
      renameSync(temporary, nextHome)
      return 'copied'
    } catch (error) {
      try { rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ }
      throw error
    }
  }
}
