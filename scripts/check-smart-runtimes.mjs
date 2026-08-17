/**
 * Unit check for `src/main/smart-runtimes.ts`.
 *
 * Smart mode's source ladder is now a user preference. Missing settings must
 * keep every rung enabled (legacy documents), an empty selection must be
 * refused on save, and runtime decisions must fail-open to the default rather
 * than booting with nothing to try. The module is bundled through esbuild
 * rather than imported directly, so this check does not depend on the host
 * Node's TypeScript stripping.
 * @module desktop/scripts/check-smart-runtimes
 */

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-smart-runtimes-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

const outfile = join(outDir, 'smart-runtimes.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'smart-runtimes.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const {
  SMART_RUNTIME_IDS,
  DEFAULT_SMART_RUNTIMES,
  isSmartRuntimeId,
  normalizeSmartRuntimes,
  validateSmartRuntimes,
  smartRuntimeEnabled,
  smartRuntimeForSource,
  adoptableUnderSmartRuntimes,
} = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) + (JSON.stringify(actual) === JSON.stringify(expected) ? '' : ' ≠ ' + JSON.stringify(expected)))

console.log('\n# ids')
equal('the ladder is probe → installed → npx → bundled',
  [...SMART_RUNTIME_IDS], ['probe', 'installed', 'npx', 'bundled'])
equal('the default is every rung', [...DEFAULT_SMART_RUNTIMES], [...SMART_RUNTIME_IDS])
check('probe is an id', isSmartRuntimeId('probe') === true)
check('a typo is not', isSmartRuntimeId('path') === false)
check('a non-string is not', isSmartRuntimeId(1) === false)

console.log('\n# normalize: missing / garbage fail open')
equal('undefined becomes the default', normalizeSmartRuntimes(undefined), [...DEFAULT_SMART_RUNTIMES])
equal('null becomes the default', normalizeSmartRuntimes(null), [...DEFAULT_SMART_RUNTIMES])
equal('a string becomes the default', normalizeSmartRuntimes('bundled'), [...DEFAULT_SMART_RUNTIMES])
equal('an empty array becomes the default', normalizeSmartRuntimes([]), [...DEFAULT_SMART_RUNTIMES])
equal('unknown ids only become the default', normalizeSmartRuntimes(['path', 'foo']), [...DEFAULT_SMART_RUNTIMES])

console.log('\n# normalize: valid subsets')
equal('a full list is kept in ladder order',
  normalizeSmartRuntimes(['bundled', 'probe', 'npx', 'installed']),
  ['probe', 'installed', 'npx', 'bundled'])
equal('a subset keeps ladder order',
  normalizeSmartRuntimes(['bundled', 'probe']),
  ['probe', 'bundled'])
equal('duplicates collapse',
  normalizeSmartRuntimes(['npx', 'npx', 'bundled']),
  ['npx', 'bundled'])
equal('unknown ids are dropped from a mixed list',
  normalizeSmartRuntimes(['probe', 'nope', 'bundled']),
  ['probe', 'bundled'])

console.log('\n# validate: refuse a save that would enable nothing')
check('undefined is not persistable', validateSmartRuntimes(undefined) === undefined)
check('an empty array is not persistable', validateSmartRuntimes([]) === undefined)
check('unknown ids only are not persistable', validateSmartRuntimes(['foo']) === undefined)
equal('a valid subset is persistable in ladder order',
  validateSmartRuntimes(['bundled', 'installed']),
  ['installed', 'bundled'])
equal('the full list is persistable',
  validateSmartRuntimes(['probe', 'installed', 'npx', 'bundled']),
  [...DEFAULT_SMART_RUNTIMES])

console.log('\n# enabled')
check('bundled is on in the default',
  smartRuntimeEnabled(DEFAULT_SMART_RUNTIMES, 'bundled') === true)
check('a missing rung is off',
  smartRuntimeEnabled(['bundled'], 'probe') === false)
check('the listed rung is on',
  smartRuntimeEnabled(['probe', 'bundled'], 'probe') === true)

console.log('\n# the rung a spawned runtime came from')
check('a PATH install is the installed rung',
  smartRuntimeForSource('installed') === 'installed')
check('an npx cache hit is the npx rung',
  smartRuntimeForSource('npx') === 'npx')
// `path` and `checkout` are what the bundled branch falls back to in a dev
// tree; they must gate with it, not escape the gate.
for (const source of ['bundled', 'checkout', 'path']) {
  check('"' + source + '" is the bundled rung', smartRuntimeForSource(source) === 'bundled')
}
check('an explicit override belongs to no rung',
  smartRuntimeForSource('override') === undefined)
check('an unknown label belongs to no rung',
  smartRuntimeForSource('made-up') === undefined)
check('a record written before the field existed belongs to no rung',
  smartRuntimeForSource(undefined) === undefined)

console.log('\n# adopting a survivor of an earlier run')
// The point of the gate: a leftover runtime must not keep answering from a
// source the user has since unticked, or the setting looks ignored.
check('a survivor from a disabled rung is not adoptable',
  adoptableUnderSmartRuntimes(['probe', 'installed'], 'bundled') === false)
check('a bundled dev fallback is refused with the bundled rung',
  adoptableUnderSmartRuntimes(['npx'], 'path') === false)
check('a survivor from an enabled rung is adoptable',
  adoptableUnderSmartRuntimes(['probe', 'bundled'], 'bundled') === true)
check('the default adopts every rung',
  SMART_RUNTIME_IDS.every(id => adoptableUnderSmartRuntimes(DEFAULT_SMART_RUNTIMES, id)))
// Nothing to check is not the same as "off": an override or an older record
// must stay adoptable, because refusing it would spawn a second writer.
check('an override is adoptable whatever is enabled',
  adoptableUnderSmartRuntimes(['npx'], 'override') === true)
check('a record with no source is adoptable',
  adoptableUnderSmartRuntimes(['npx'], undefined) === true)

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')
