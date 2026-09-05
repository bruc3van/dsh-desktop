/**
 * Spawn-family patches applied by `runtime-launcher.ts` before the official
 * CLI (or bundled pnpm) loads.
 *
 * Two independent concerns share this module because they both have to rewrite
 * `child_process` exports before any harness import binds them:
 *
 *  1. `ELECTRON_RUN_AS_NODE` is stripped from the ambient environment, then
 *     reattached only for children that ARE this executable.
 *  2. A `pnpm` / `pnpm.cmd` spawn is rewritten onto `process.execPath` plus
 *     the launcher targeting packaged `pnpm.mjs`. The launcher removes Node
 *     mode again before pnpm starts any lifecycle-script children.
 *     Official `runPlugin` uses `spawnSync("pnpm", {
 *     shell: true })` on Windows, which opens a console, steals stdio, and
 *     can hang on an ignored-builds prompt. The rewrite is `shell: false`,
 *     `windowsHide: true` on win32, and `CI=true` on that child only — hide
 *     without CI would turn a visible hang into an invisible one. Unrelated
 *     spawns (Agent shells, `node`, `dsh`) are left alone.
 * @module dsh-desktop/runtime-spawn
 */

/** `(file, args?, options?)`, the shape spawn/spawnSync/fork share. */
export type SpawnLike = (...callArguments: unknown[]) => unknown
export interface SpawnHost { [name: string]: SpawnLike }
export interface SpawnOptions {
  env?: NodeJS.ProcessEnv
  shell?: boolean | string
  windowsHide?: boolean
}

const NODE_MODE = 'ELECTRON_RUN_AS_NODE'

/** Main process / shims set this so the launcher can find packaged `pnpm.mjs`. */
export const PNPM_ENTRY_VARIABLE = 'DSH_DESKTOP_PNPM_ENTRY'
/** CLI target passed through the environment so its arguments stay unchanged. */
export const RUNTIME_ENTRY_VARIABLE = 'DSH_DESKTOP_RUNTIME_ENTRY'

/**
 * Whether a spawn target is this process's own executable — under Electron's
 * Node mode that is the Electron binary, which needs the variable back or it
 * starts a second copy of the GUI application instead of running the script.
 */
export function isSelfExecutable(
  command: unknown,
  execPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (typeof command !== 'string') return false
  if (command === execPath) return true
  return platform === 'win32' && command.toLowerCase() === execPath.toLowerCase()
}

/** A PATH/`shell: true` pnpm invocation the harness uses for `dsh plugin`. */
export function isPnpmCommand(command: unknown): boolean {
  if (typeof command !== 'string' || command === '') return false
  // Split on both separators so a Windows `…\pnpm.cmd` still matches when
  // this helper is unit-tested on POSIX (path.basename would not).
  const slash = command.replaceAll('\\', '/')
  const name = slash.slice(slash.lastIndexOf('/') + 1).toLowerCase()
  return name === 'pnpm' || name === 'pnpm.cmd' || name === 'pnpm.ps1' || name === 'pnpm.exe'
}

/**
 * Merge the Node-mode variable into one call's options. An absent `env` means
 * "inherit", and the inherited environment no longer carries the variable, so
 * the ambient values are materialized here rather than left implicit.
 */
export function withNodeMode(
  options: unknown,
  value: string,
  ambient: NodeJS.ProcessEnv,
): SpawnOptions {
  const base = typeof options === 'object' && options !== null ? options as SpawnOptions : {}
  return { ...base, env: { ...base.env ?? ambient, [NODE_MODE]: value } }
}

function optionsIndex(callArguments: unknown[]): number {
  return Array.isArray(callArguments[1]) ? 2 : 1
}

/**
 * Rewrite a `pnpm` spawn onto the packaged CLI. Mutates `callArguments` into
 * `(execPath, [launcher, ...args], options)` and returns whether it did.
 */
export function applyPnpmRewrite(
  callArguments: unknown[],
  execPath: string,
  platform: NodeJS.Platform,
  ambient: NodeJS.ProcessEnv,
  pnpmEntry: string | undefined,
  launcher: string,
): boolean {
  if (pnpmEntry === undefined || pnpmEntry === '') return false
  if (!isPnpmCommand(callArguments[0])) return false
  const hasArgs = Array.isArray(callArguments[1])
  const originalArgs = hasArgs ? callArguments[1] as unknown[] : []
  const originalOptions = hasArgs ? callArguments[2] : callArguments[1]
  const base = typeof originalOptions === 'object' && originalOptions !== null
    ? originalOptions as SpawnOptions
    : {}
  const options: SpawnOptions = {
    ...base,
    shell: false,
    env: {
      ...base.env ?? ambient,
      CI: 'true',
      [RUNTIME_ENTRY_VARIABLE]: pnpmEntry,
      [PNPM_ENTRY_VARIABLE]: pnpmEntry,
    },
  }
  if (platform === 'win32') options.windowsHide = true
  callArguments[0] = execPath
  callArguments[1] = [launcher, ...originalArgs]
  callArguments[2] = options
  return true
}

/**
 * Wrap spawn/spawnSync/fork. `always` is for `fork()`, which always runs on
 * this executable through a module-internal spawn the self-check cannot see.
 */
export function patchSpawnLike(
  host: SpawnHost,
  name: string,
  nodeMode: string,
  always: boolean,
  execPath: string,
  platform: NodeJS.Platform,
  ambient: NodeJS.ProcessEnv,
  pnpmEntry: string | undefined,
  launcher: string,
): void {
  const original = host[name]
  if (typeof original !== 'function') return
  host[name] = function patched(this: unknown, ...callArguments: unknown[]): unknown {
    applyPnpmRewrite(callArguments, execPath, platform, ambient, pnpmEntry, launcher)
    if (always || isSelfExecutable(callArguments[0], execPath, platform)) {
      const index = optionsIndex(callArguments)
      callArguments[index] = withNodeMode(callArguments[index], nodeMode, ambient)
    }
    return original.apply(this, callArguments)
  }
}

/** Patch the three spawn-family exports the launcher can see. */
export function patchRuntimeSpawns(
  host: SpawnHost,
  nodeMode: string,
  execPath: string,
  platform: NodeJS.Platform,
  ambient: NodeJS.ProcessEnv,
  pnpmEntry: string | undefined,
  launcher: string,
): void {
  patchSpawnLike(host, 'spawn', nodeMode, false, execPath, platform, ambient, pnpmEntry, launcher)
  patchSpawnLike(host, 'spawnSync', nodeMode, false, execPath, platform, ambient, pnpmEntry, launcher)
  patchSpawnLike(host, 'fork', nodeMode, true, execPath, platform, ambient, pnpmEntry, launcher)
}
