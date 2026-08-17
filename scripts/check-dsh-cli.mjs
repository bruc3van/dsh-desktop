/**
 * Unit check for `src/main/dsh-cli-policy.ts`.
 *
 * The gateway in front of the bundled `dsh` is fail-closed: only invocations
 * that cannot boot a profile are forwarded. These cases pin that table, so a
 * later upstream change to `web` / `plugin` / `--dump-config` that would
 * silently start a second profile on the same DSH_HOME is a red build here
 * rather than a surprise in a packaged Agent shell.
 *
 * The module is bundled through esbuild rather than imported directly, so this
 * check does not depend on the host Node's TypeScript stripping.
 * @module desktop/scripts/check-dsh-cli
 */

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-dsh-cli-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

const outfile = join(outDir, 'dsh-cli-policy.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'dsh-cli-policy.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const { classifyDshInvocation, DSH_CLI_BLOCKED_MESSAGE } = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}

const allows = (args) => {
  const decision = classifyDshInvocation(args)
  check(JSON.stringify(args) + ' is forwarded', decision.allow === true,
    decision.allow === true ? undefined : decision.reason)
}
const blocks = (args) => {
  const decision = classifyDshInvocation(args)
  const ok = decision.allow === false && decision.reason === DSH_CLI_BLOCKED_MESSAGE
  check(JSON.stringify(args) + ' is refused', ok,
    ok ? undefined : (decision.allow === true ? 'forwarded' : decision.reason))
}

console.log('\n# refused: would boot a profile')
blocks(['web'])
blocks(['--profile', 'web'])
blocks(['--profile=web'])
blocks(['--profile', 'tui', '--resume', 'abc'])
blocks(['--profile', 'web', '--', '--dump-config'])
blocks(['web', '--', '--dump-config'])
blocks(['web', '--help'])
blocks(['--profile', 'headless', 'do something'])
blocks(['--', 'web'])
blocks(['--', 'web', '--port', '0'])

console.log('\n# forwarded: dump-config / version never boot')
allows(['--profile', 'web', '--dump-config'])
allows(['web', '--dump-config'])
allows(['web', '--dump-default-config'])
allows(['--profile', 'web', '--dump-default-config'])
allows(['--dump-config'])
allows(['--version'])
allows(['-V'])
allows(['web', '--version'])
allows(['--profile', 'web', '--version'])

console.log('\n# forwarded: plugin is a pnpm forwarder')
allows(['plugin', '--profile', 'web', 'add', 'x'])
allows(['plugin', '--profile', 'web', 'remove', 'x'])

console.log('\n# forwarded: the official CLI itself would error or print help')
allows([])
allows(['--help'])
allows(['-h'])
allows(['plugin'])

if (failures.length > 0) throw new Error('dsh CLI policy contract violated: ' + failures.join(', '))
