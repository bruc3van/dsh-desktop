import { app } from 'electron'

/**
 * Environment overrides are development seats. A packaged client must not be
 * steerable by ambient environment: a variable left by an installer, a login
 * script, or another application would otherwise redirect the spawned runtime,
 * the Smart-mode probe, the data homes, or the update feed without the user
 * ever seeing it — a planted DSH_DESKTOP_HOME is a planted settings.json, and
 * that names the server the client connects to on every future launch.
 * DSH_DESKTOP_ALLOW_UNSAFE=1 keeps the escape hatch for deliberate debugging.
 *
 * Every DSH_* variable this file reads goes through here or `devFlag`, with
 * one deliberate exception: DSH_DESKTOP_NODE is read on a branch a packaged
 * build cannot reach (it throws on a missing bundled runtime first).
 */
export function devOverride(name: string): string | undefined {
  if (app.isPackaged && process.env.DSH_DESKTOP_ALLOW_UNSAFE !== '1') return undefined
  return process.env[name]
}

/** The `=1` test knobs, under the same packaging gate as `devOverride`. */
export function devFlag(name: string): boolean {
  return devOverride(name) === '1'
}
