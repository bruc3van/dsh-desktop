/**
 * Profiles (场景包) and how several of them combine into one desired state.
 *
 * A profile is the part of a desired state an administrator authors: models,
 * plugins, skills, tool policy, update and offline settings. The server binds
 * profiles to the whole organisation, departments, groups and people, then
 * merges every profile that applies to one person, lowest priority first.
 *
 * The merge is deliberately asymmetric: settings follow the most specific
 * profile, but restrictions only accumulate. A department can add a blocked
 * plugin or a denied tool; a personal profile cannot take either away.
 * @module @dsh-desktop-pro/protocol/profile
 */

import { DESIRED_STATE_SCHEMA, DESIRED_STATE_VERSION, validateDesiredState, type DesiredState } from './desired-state.ts'
import type { Result } from './validation.ts'

export type ProfileSpec = Pick<DesiredState, 'models' | 'plugins' | 'skills' | 'tools' | 'updates' | 'offline'>

const PROFILE_KEYS = ['models', 'plugins', 'skills', 'tools', 'updates', 'offline'] as const

/** Validate an authored profile with the desired-state rules for the same fields. */
export function validateProfileSpec(value: unknown): Result<ProfileSpec> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, path: '$', reason: 'must be an object' }
  for (const key of Object.keys(value)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) return { ok: false, path: '$.' + key, reason: 'is not a profile field' }
  }
  const checked = validateDesiredState({
    ...value,
    schema: DESIRED_STATE_SCHEMA,
    version: DESIRED_STATE_VERSION,
    revision: 0,
    issuedAt: '1970-01-01T00:00:00Z',
    organization: { id: 'validation', name: 'validation' },
  })
  if (!checked.ok) return checked
  const spec: ProfileSpec = {}
  for (const key of PROFILE_KEYS) {
    if (checked.value[key] !== undefined) (spec as Record<string, unknown>)[key] = checked.value[key]
  }
  return { ok: true, value: spec }
}

function unionInOrder(...lists: Array<readonly string[] | undefined>): string[] | undefined {
  const out: string[] = []
  for (const list of lists) for (const item of list ?? []) if (!out.includes(item)) out.push(item)
  return out.length === 0 ? undefined : out
}

/** Merge profiles, lowest priority first. */
export function mergeProfiles(layers: readonly ProfileSpec[]): ProfileSpec {
  const merged: ProfileSpec = {}
  for (const layer of layers) {
    if (layer.models !== undefined) {
      const models: NonNullable<ProfileSpec['models']> = { providers: { ...merged.models?.providers, ...layer.models.providers } }
      const selection = layer.models.default ?? merged.models?.default
      if (selection !== undefined) models.default = selection
      merged.models = models
    }
    if (layer.plugins !== undefined) {
      const previous = merged.plugins ?? {}
      const next = { ...previous }
      const indexes = unionInOrder(previous.indexes, layer.plugins.indexes)
      if (indexes !== undefined) next.indexes = indexes
      if (layer.plugins.registry !== undefined) next.registry = layer.plugins.registry
      if (layer.plugins.fallbackRegistries !== undefined) next.fallbackRegistries = layer.plugins.fallbackRegistries
      const blocked = unionInOrder(previous.blocked, layer.plugins.blocked)
      if (blocked !== undefined) next.blocked = blocked
      if (layer.plugins.required !== undefined || previous.required !== undefined) {
        const byName = new Map((previous.required ?? []).map(plugin => [plugin.name, plugin]))
        for (const plugin of layer.plugins.required ?? []) byName.set(plugin.name, plugin)
        next.required = [...byName.values()]
      }
      merged.plugins = next
    }
    if (layer.skills !== undefined) {
      const byName = new Map((merged.skills ?? []).map(skill => [skill.name, skill]))
      for (const skill of layer.skills) byName.set(skill.name, skill)
      merged.skills = [...byName.values()]
    }
    if (layer.tools !== undefined) {
      const tools = { ...merged.tools }
      const deny = unionInOrder(merged.tools?.deny, layer.tools.deny)
      if (deny !== undefined) tools.deny = deny
      if (layer.tools.message !== undefined) tools.message = layer.tools.message
      merged.tools = tools
    }
    if (layer.updates !== undefined) merged.updates = { ...merged.updates, ...layer.updates }
    if (layer.offline?.graceDays !== undefined) {
      const previous = merged.offline?.graceDays
      merged.offline = { graceDays: previous === undefined ? layer.offline.graceDays : Math.min(previous, layer.offline.graceDays) }
    }
  }
  // A plugin blocked anywhere is never also required.
  if (merged.plugins?.blocked !== undefined && merged.plugins.required !== undefined) {
    const blocked = new Set(merged.plugins.blocked)
    merged.plugins.required = merged.plugins.required.filter(plugin => !blocked.has(plugin.name))
  }
  return merged
}
