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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const OFFICIAL_BIN = /(?:^|[/\\])lib[/\\]bin\.js$/i
const OFFICIAL_PACKAGE = '@deepseek-ai/dsh'

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
