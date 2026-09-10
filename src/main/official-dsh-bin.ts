/**
 * The version of an official `@deepseek-ai/dsh` CLI entry, when the path is
 * that package's `lib/bin.js`.
 *
 * Two directories up from an arbitrary executable is often some other
 * project's `package.json` (`project/bin/dsh.exe` → this desktop client's
 * `0.2.5`). Feeding that to the `--no-open` gate would treat an old dsh as
 * new enough, then abort on the unknown flag. Only the official package
 * layout plus its own name may be trusted; everything else must use
 * `--version`.
 * @module dsh-desktop/official-dsh-bin
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const OFFICIAL_BIN = /(?:^|[/\\])lib[/\\]bin\.js$/i
const OFFICIAL_PACKAGE = '@deepseek-ai/dsh'

/** Recognize direct entries, POSIX links and npm/pnpm's relative bin shims. */
export function officialDshEntry(command: string): string | undefined {
  try {
    const direct = realpathSync(command)
    if (officialDshPackageVersion(direct) !== undefined) return direct
    const body = readFileSync(command, 'utf8')
    // Match the actual shim target, never assume an adjacent package is invoked.
    const targets = [...body.matchAll(/(?:%dp0%|%~dp0|\$basedir)[/\\]([^"\r\n]*?[/\\]lib[/\\]bin\.js)/g)]
    const entries = new Set(targets.flatMap(match => match[1] === undefined ? [] : [resolve(dirname(command), match[1])]))
    if (entries.size !== 1) return undefined
    const entry = [...entries][0]
    if (entry !== undefined && existsSync(entry) && officialDshPackageVersion(entry) !== undefined) return realpathSync(entry)
  } catch { /* executable or unrecognized wrapper stays on its original path */ }
  return undefined
}

export function officialDshPackageVersion(bin: string): string | undefined {
  if (!OFFICIAL_BIN.test(bin)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(bin, '..', '..', 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (manifest.name !== OFFICIAL_PACKAGE) return undefined
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}
