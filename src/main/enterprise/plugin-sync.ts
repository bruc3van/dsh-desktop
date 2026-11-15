/**
 * Bring the profile's plugin packages in line with the desired state.
 *
 * Installation goes through the runtime's own `dsh plugin --profile web`
 * command — the same package manager, registry plan and compatibility checks
 * a person's own `dsh plugin add` gets — and runs after the runtime is up, so
 * DSH's module reload picks the change up without a restart.
 *
 * Only `required` and `blocked` packages are touched. Anything else the
 * person installed stays; organisations that want an allow-list enforce it at
 * the registry they point `plugins.registry` at.
 * @module dsh-desktop-pro/enterprise/plugin-sync
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesiredState } from '@dsh-desktop-pro/protocol'
import { WEB_PROFILE } from '../web-profile.ts'

export interface PluginPlan {
  install: Array<{ name: string; spec: string }>
  remove: string[]
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function installedVersion(dshHome: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', WEB_PROFILE, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** What has to change, judged from the profile on disk. */
export function planPluginSync(state: DesiredState, dshHome: string): PluginPlan {
  let manifest: ProfileManifest = {}
  try {
    manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', WEB_PROFILE, 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    manifest = {}
  }
  const dependencies = manifest.dependencies ?? {}
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const plan: PluginPlan = { install: [], remove: [] }
  for (const plugin of state.plugins?.required ?? []) {
    const declared = dependencies[plugin.name]
    const exactVersion = plugin.spec.startsWith(plugin.name + '@') ? plugin.spec.slice(plugin.name.length + 1) : undefined
    const satisfied = declared !== undefined && bundles.has(plugin.name) && (exactVersion !== undefined
      ? installedVersion(dshHome, plugin.name) === exactVersion
      // A pinned Git or tarball spec is satisfied when the profile records that same target.
      : declared === plugin.spec || declared.includes(plugin.spec.replace(/^git\+/, '').split('#')[1] ?? '\u0000'))
    if (!satisfied) plan.install.push(plugin)
  }
  for (const name of state.plugins?.blocked ?? []) {
    if (Object.hasOwn(dependencies, name) || bundles.has(name)) plan.remove.push(name)
  }
  return plan
}

export type PluginCommandRunner = (args: string[]) => Promise<{ ok: boolean; output: string }>

/** Run the plan; every step is attempted and failures are returned as problems. */
export async function runPluginSync(plan: PluginPlan, run: PluginCommandRunner): Promise<string[]> {
  const problems: string[] = []
  if (plan.remove.length > 0) {
    const result = await run(['plugin', '--profile', WEB_PROFILE, 'remove', ...plan.remove])
    if (!result.ok) problems.push('could not remove blocked plugins ' + plan.remove.join(', ') + ': ' + result.output.slice(-400))
  }
  for (const plugin of plan.install) {
    const result = await run(['plugin', '--profile', WEB_PROFILE, 'add', plugin.spec])
    if (!result.ok) problems.push('could not install ' + plugin.spec + ': ' + result.output.slice(-400))
  }
  return problems
}
