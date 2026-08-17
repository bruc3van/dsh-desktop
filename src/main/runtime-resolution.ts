/**
 * The platform-dependent decisions behind locating and launching a
 * user-installed `dsh`, as pure functions.
 *
 * These rules are almost entirely about Windows, and the client is developed
 * and integration-tested on macOS — so they are separated from the process and
 * filesystem work in `index.ts` deliberately. Parameterized by platform rather
 * than reading `process.platform`, every branch is assertable from any
 * machine (`scripts/check-runtime-resolution.mjs`), which is the only Windows
 * coverage that does not require a Windows host.
 *
 * What this module cannot cover, and what a real Windows run still has to
 * prove: process-tree semantics — that `taskkill /T /F` walked from a live
 * parent reaches the server behind a cmd.exe wrapper.
 * @module dsh-desktop/runtime-resolution
 */

// The win32/posix variants explicitly, never the host-dependent default: this
// module is asserted for both platforms from one machine, and `join` alone
// would silently produce the HOST's separators for the other platform's case.
import { posix, win32 } from 'node:path'

/**
 * The filenames to try for `name`, in lookup order.
 *
 * On Windows only extensions the spawn path can actually execute are
 * candidates. npm also writes an extension-less POSIX shell script beside its
 * `.cmd` shim, which Windows cannot run at all, and `.ps1` is not executable
 * through `cmd.exe` either — offering either one would resolve a "found"
 * command that then fails on every launch.
 */
export function executableCandidates(name: string, platform: NodeJS.Platform): string[] {
  // `.exe` first: Node spawns it directly, while `.cmd`/`.bat` need a shell.
  return platform === 'win32'
    ? [name + '.exe', name + '.cmd', name + '.bat']
    : [name]
}

/**
 * One PATH entry as a directory: trimmed, and unwrapped from the surrounding
 * quotes Windows permits (and some installers write).
 */
export function normalizePathEntry(entry: string): string {
  return entry.trim().replace(/^"(.*)"$/, '$1')
}

/**
 * Whether two PATH-shaped strings name the same directory.
 *
 * Windows settles this in three ways POSIX does not: `\` and `/` are both
 * separators, a trailing separator carries no meaning, and the whole
 * comparison is case-insensitive. A PATH entry a user typed themselves can
 * differ from this client's own `join()` output in all three — and this
 * comparison exists to EXCLUDE a directory (the client's node shim), so every
 * spelling that fails to match is a spelling that smuggles the shim back in as
 * a user-installed runtime.
 *
 * Textual only: no symlink, junction, or 8.3 short-name resolution. It answers
 * "the same directory as written", which is the question a PATH entry poses.
 */
export function isSameDirectory(left: string, right: string, platform: NodeJS.Platform): boolean {
  return directoryKey(left, platform) === directoryKey(right, platform)
}

function directoryKey(value: string, platform: NodeJS.Platform): string {
  const unified = platform === 'win32' ? value.replace(/\//g, '\\') : value
  // A root is nothing but its separator, so it is the one case where the
  // trailing separator has to stay.
  const trimmed = unified.replace(/[\\/]+$/, '')
  const key = trimmed === '' ? unified : trimmed
  return platform === 'win32' ? key.toLowerCase() : key
}

/**
 * How a resolved `dsh` binary must be handed to `spawn`.
 *
 * A Windows `.cmd`/`.bat` shim is a batch script, not an image Node can
 * execute: it has to go through the platform shell, which re-parses the
 * command string, so the path is quoted for that round trip. Quoting is safe
 * without escaping because a Windows path cannot contain a double quote. Every
 * other case — a real `.exe`, and everything on POSIX, where a shebang makes
 * the file directly executable — is spawned as-is, and must NOT be quoted:
 * with no shell to strip them, the quotes would become part of the filename.
 *
 * Windows callers that spawn this target must pass `windowsHide: true`. The
 * shell is `cmd.exe`, and CreateProcess otherwise flashes a console for every
 * `--version` probe and every `dsh web` start.
 */
export function spawnTargetFor(binPath: string, platform: NodeJS.Platform): { command: string; shell: boolean } {
  const shell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(binPath)
  return { command: shell ? '"' + binPath + '"' : binPath, shell }
}

/**
 * The directory npx keeps its per-spec package caches in, or undefined when it
 * cannot be located.
 *
 * This matters because the official install instruction is `npx
 * @deepseek-ai/dsh web`, which puts nothing on PATH — a PATH-only search finds
 * nothing for the users who followed the documentation. A spec that has been
 * run once leaves a complete package here, so reusing it downloads nothing.
 *
 * npm's cache root is `~/.npm` on POSIX and `%LOCALAPPDATA%\npm-cache` on
 * Windows, and `npm_config_cache` overrides both. The layout under it
 * (`_npx/<hash>/node_modules/…`) is npm's internal detail, not a public
 * contract — a miss here simply means the bundled runtime is used, so a future
 * npm reorganizing its cache costs a preference, never a failure.
 */
export function npxCacheRoot(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string | undefined {
  const path = platform === 'win32' ? win32 : posix
  const configured = env.npm_config_cache ?? env.NPM_CONFIG_CACHE
  if (configured !== undefined && configured !== '') return path.join(configured, '_npx')
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (localAppData === undefined || localAppData === '') return undefined
    return path.join(localAppData, 'npm-cache', '_npx')
  }
  if (home === '') return undefined
  return path.join(home, '.npm', '_npx')
}

/**
 * The version a `--version` run reported, or undefined when its output carries
 * none.
 *
 * Two shapes are accepted, both anchored: a line that IS a bare semver
 * (`0.2.7`, `v0.2.7`), and a line prefixed by this CLI's own names
 * (`dsh 0.2.7`, `dsh/0.3.1 darwin-arm64`, `@deepseek-ai/dsh/0.1.0-rc.6`).
 * Everything else is noise, not a version: a build stamp or a Node banner
 * misread as a bogus HIGH version would sail through the bundled-plugin
 * version gate and seat the plugin into a runtime too old to load it, while
 * a bogus low or missing version merely sends the user back to the bundled
 * runtime — safe, but still wrong.
 */
export function parseVersionOutput(stdout: string): string | undefined {
  const versionToken = '\\d+\\.\\d+(?:\\.\\d+)?(?:-[0-9A-Za-z][\\w.-]*)?(?:\\+[0-9A-Za-z][\\w.-]*)?'
  const bare = new RegExp('^\\s*(?:v)?(' + versionToken + ')\\s*$')
  // A name in front stays accepted, but only this CLI's own names: any other
  // lowercase word (`node v22.19.0`, `version 0.0.1`) is noise too, and a
  // false HIGH version from one would be the exact misread the gate exists
  // to stop.
  const prefixed = new RegExp('^\\s*(?:dsh|@deepseek-ai/dsh)[/\\s](?:v)?(' + versionToken + ')(?=\\s|$)')
  for (const entry of stdout.split('\n')) {
    const bareMatch = bare.exec(entry)
    if (bareMatch !== null) return bareMatch[1]
    const prefixedMatch = prefixed.exec(entry)
    if (prefixedMatch !== null) return prefixedMatch[1]
  }
  return undefined
}

/**
 * The age in seconds of a process, from `ps -o etime=` output, or undefined
 * when the output carries none.
 *
 * `etime` spells `[[dd-]hh:]mm:ss` (`01:23:45`, `1-02:03:04`, `12:34`),
 * possibly with the leading padding `ps` uses to align its columns.
 */
export function parsePsElapsedSeconds(output: string): number | undefined {
  const match = /(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})/.exec(output.trim())
  if (match === null) return undefined
  const days = match[1] === undefined ? 0 : Number(match[1])
  const hours = match[2] === undefined ? 0 : Number(match[2])
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return undefined
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

/**
 * How a live process's age (seconds) squares with a spawn recorded at
 * `startedAt` (epoch ms).
 *
 * - `recycled`: the pid started measurably AFTER the record. The recorded
 *   child is gone and the OS has handed the pid to another process — it must
 *   not be signalled, and the record is stale.
 * - `ours`: the pid's age tracks the record, or is OLDER than it. Older is
 *   still ours, not someone else's: the pid belonged to our child from the
 *   recorded spawn until its death, so any other process holding it now must
 *   have started after that death — strictly younger. An age older than the
 *   record can only be the surviving child under a backward clock
 *   adjustment.
 * - `unknown`: the record carries no usable `startedAt`, or the age could
 *   not be read. The caller must refuse BOTH directions — no signalling an
 *   unidentified process, and no spawning beside one.
 */
export type SpawnAgeVerdict = 'recycled' | 'ours' | 'unknown'

export function spawnAgeVerdict(
  ageSeconds: number,
  startedAtMs: number,
  nowMs: number,
  toleranceMs: number,
): SpawnAgeVerdict {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return 'unknown'
  if (!Number.isFinite(ageSeconds)) return 'unknown'
  const recordedAge = Math.max(0, (nowMs - startedAtMs) / 1000)
  if (ageSeconds < recordedAge - toleranceMs / 1000) return 'recycled'
  return 'ours'
}
