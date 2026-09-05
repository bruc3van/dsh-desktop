/** Diagnostic payloads contain only fixed codes, never DOM text or credentials. */
export type SettingsIntegrationFailure = 'missing-navigation' | 'missing-content' | 'missing-general-tab' | 'mount-failed'
export type SettingsIntegrationStatus =
  | { state: 'absent' | 'mounted' }
  | { state: 'unsupported'; reason: SettingsIntegrationFailure }

export function parseSettingsIntegrationStatus(value: unknown): SettingsIntegrationStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { state, reason } = value as { state?: unknown; reason?: unknown }
  if (state === 'absent' || state === 'mounted') return { state }
  if (state === 'unsupported' && (reason === 'missing-navigation' || reason === 'missing-content'
    || reason === 'missing-general-tab' || reason === 'mount-failed')) return { state, reason }
  return undefined
}
