/**
 * The managed launch step: apply the cached desired state to the profile
 * inside the CLI child, after `initProfile()` and before DSH reads it.
 *
 * The main process writes the document it accepted (verified, validated) to
 * a cache file and passes only that path. The child validates it again: the
 * file sits in the client home, and the child must not trust it blindly.
 * @module dsh-desktop-pro/enterprise/managed-boot
 */

import { readFileSync } from 'node:fs'
import { validateDesiredState } from '@dsh-desktop-pro/protocol'
import { initWebProfile } from '../profile-boot.ts'
import { applyDesiredState } from './reconcile.ts'

export const MANAGED_STATE_VARIABLE = 'DSH_DESKTOP_MANAGED_STATE'

export interface ManagedBootRequest {
  home: string
  statePath: string
  policyPluginPath?: string
}

export async function prepareManagedProfile(entry: string, request: ManagedBootRequest): Promise<void> {
  try {
    await initWebProfile(entry, request.home)
    const cached = JSON.parse(readFileSync(request.statePath, 'utf8')) as { state?: unknown }
    const state = validateDesiredState(cached.state)
    if (!state.ok) throw new Error('cached desired state ' + state.path + ' ' + state.reason)
    const result = applyDesiredState(state.value, {
      dshHome: request.home,
      ...request.policyPluginPath !== undefined && { policyPluginPath: request.policyPluginPath },
    })
    console.log('[desktop] managed profile: revision ' + String(state.value.revision)
      + (result.changed ? ' applied' : ' unchanged')
      + (result.problems.length > 0 ? '; problems: ' + result.problems.join('; ') : ''))
  } catch (error) {
    // The runtime still starts: the previous managed block stays in place,
    // and the main process reports the failure in its status.
    console.warn('[desktop] managed profile not applied: ' + (error instanceof Error ? error.message : String(error)))
  }
}
