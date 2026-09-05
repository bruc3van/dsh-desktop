/**
 * Unit check for `src/main/local-web-port.ts` and the `--no-open` version gate.
 *
 * Automatic mode prefers 3080, then 13080, then `--port 0`. A pinned port must round-trip
 * through settings without silently becoming automatic, and `--no-open` must be
 * a spawn-time flag, not a stored preference. An override next to an
 * unrelated `package.json` must not be treated as official dsh. Bundled
 * through esbuild so this check does not depend on the host Node's
 * TypeScript stripping.
 * @module desktop/scripts/check-local-web-port
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-local-web-port-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

const outfile = join(outDir, 'local-web-port.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'local-web-port.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const {
  AUTOMATIC_LOCAL_WEB_PORT,
  OFFICIAL_WEB_PORT,
  SECONDARY_WEB_PORT,
  AUTOMATIC_LOCAL_WEB_PORTS,
  NO_OPEN_SINCE,
  normalizeLocalWebPort,
  parseLocalWebPort,
  canBindLocalWebPort,
  localWebPortRangeLabel,
  isOfficialWebPort,
  selectAutomaticLocalWebPort,
  webSpawnArgs,
} = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) + (JSON.stringify(actual) === JSON.stringify(expected) ? '' : ' ≠ ' + JSON.stringify(expected)))

console.log('\n# defaults')
check('automatic is stored as 0', AUTOMATIC_LOCAL_WEB_PORT === 0)
check('the official default is 3080', OFFICIAL_WEB_PORT === 3080)
check('the stable fallback is 13080', SECONDARY_WEB_PORT === 13080)
equal('automatic mode has the required priority', AUTOMATIC_LOCAL_WEB_PORTS, [3080, 13080])
check('--no-open starts at rc.8', NO_OPEN_SINCE === '0.1.0-rc.8')
check('3080 is the official port', isOfficialWebPort(3080) === true)
check('a pinned port is not the official port', isOfficialWebPort(13080) === false)
check('automatic is not a pinned official port', isOfficialWebPort(0) === false)

console.log('\n# automatic selection')
equal('automatic mode uses 3080 when available',
  await selectAutomaticLocalWebPort(() => true), 3080)
equal('automatic mode falls back to 13080 when 3080 is occupied',
  await selectAutomaticLocalWebPort(port => port !== 3080), 13080)
equal('automatic mode falls back to an OS-assigned port when both stable ports are occupied',
  await selectAutomaticLocalWebPort(() => false), 0)

console.log('\n# parse: persistable values')
check('missing is automatic', parseLocalWebPort(undefined) === 0)
check('null is automatic', parseLocalWebPort(null) === 0)
check('empty string is automatic', parseLocalWebPort('') === 0)
check('whitespace is automatic', parseLocalWebPort('  ') === 0)
check('numeric 0 is automatic', parseLocalWebPort(0) === 0)
check('string 0 is automatic', parseLocalWebPort('0') === 0)
check('a pinned integer is kept', parseLocalWebPort(13080) === 13080)
check('a pinned numeric string is kept', parseLocalWebPort('13080') === 13080)
check('a trimmed numeric string is kept', parseLocalWebPort(' 8080 ') === 8080)
check('the official port is persistable', parseLocalWebPort(3080) === 3080)
check('port 1 is persistable on Windows', parseLocalWebPort(1, 'win32') === 1)
check('port 80 is persistable on Windows', parseLocalWebPort(80, 'win32') === 80)
check('port 1 is not persistable on macOS', parseLocalWebPort(1, 'darwin') === undefined)
check('port 80 is not persistable on Linux', parseLocalWebPort(80, 'linux') === undefined)
check('port 1023 is not persistable on macOS', parseLocalWebPort(1023, 'darwin') === undefined)
check('port 1024 is persistable on macOS', parseLocalWebPort(1024, 'darwin') === 1024)
check('port 65535 is persistable', parseLocalWebPort(65535) === 65535)

console.log('\n# parse: refuse a save that is not a port')
check('a float is not persistable', parseLocalWebPort(13080.5) === undefined)
check('a negative is not persistable', parseLocalWebPort(-1) === undefined)
check('65536 is not persistable', parseLocalWebPort(65536) === undefined)
check('a non-numeric string is not persistable', parseLocalWebPort('abc') === undefined)
check('a mixed string is not persistable', parseLocalWebPort('13080x') === undefined)
check('an object is not persistable', parseLocalWebPort({}) === undefined)
check('an array is not persistable', parseLocalWebPort([13080]) === undefined)
check('NaN is not persistable', parseLocalWebPort(Number.NaN) === undefined)

console.log('\n# normalize: missing / garbage fail open to automatic')
equal('undefined becomes automatic', normalizeLocalWebPort(undefined), 0)
equal('garbage becomes automatic', normalizeLocalWebPort('nope'), 0)
equal('a valid pin is kept', normalizeLocalWebPort('13080'), 13080)
equal('a privileged port fail-opens to automatic on macOS', normalizeLocalWebPort(80, 'darwin'), 0)
equal('a privileged port is kept on Windows', normalizeLocalWebPort(80, 'win32'), 80)
check('Windows range starts at 1', localWebPortRangeLabel('win32') === '1–65535')
check('POSIX range starts at 1024', localWebPortRangeLabel('darwin') === '1024–65535')
check('port 80 cannot bind on Linux', canBindLocalWebPort(80, 'linux') === false)
check('port 80 can bind on Windows', canBindLocalWebPort(80, 'win32') === true)

console.log('\n# spawn argv')
equal('the default spawn is random, no browser flag',
  webSpawnArgs(0, false), ['web', '--port', '0'])
equal('a pinned port is passed through',
  webSpawnArgs(13080, false), ['web', '--port', '13080'])
equal('rc.8+ adds --no-open after the port',
  webSpawnArgs(0, true), ['web', '--port', '0', '--no-open'])
equal('a pinned rc.8+ spawn has both flags',
  webSpawnArgs(13080, true), ['web', '--port', '13080', '--no-open'])
equal('an out-of-range port falls back to random rather than handing commander junk',
  webSpawnArgs(70000, false), ['web', '--port', '0'])
equal('a negative port falls back to random',
  webSpawnArgs(-1, true), ['web', '--port', '0', '--no-open'])

// Layout-sensitive guards supplement check:connection-controller and the live
// installed-runtime checks. Missing anchors deliberately fail the assertions.
console.log('\n# src/main/connection-controller.ts: startup order')
const connectionSource = readFileSync(join(APP_DIR, 'src', 'main', 'connection-controller.ts'), 'utf8')
const startLocalAt = connectionSource.indexOf('const startLocal = async')
const startLocalEnd = connectionSource.indexOf('await startLocalRuntime(generation, force)', startLocalAt)
const startLocalBody = startLocalAt >= 0 && startLocalEnd > startLocalAt
  ? connectionSource.slice(startLocalAt, startLocalEnd)
  : ''
const adoptAt = startLocalBody.indexOf('adoptOrClearSurvivingRuntime')
const pinnedFailAt = startLocalBody.indexOf('showPinnedPortStartupFailure')
check('startLocal reclaims a leftover before refusing a pinned port',
  adoptAt >= 0 && pinnedFailAt > adoptAt,
  adoptAt < 0 ? 'adoptOrClearSurvivingRuntime missing from startLocal'
    : pinnedFailAt < 0 ? 'showPinnedPortStartupFailure missing from startLocal'
    : pinnedFailAt <= adoptAt ? 'pinned-port refusal ran before the runtime lock'
    : undefined)
const startRuntimeAt = connectionSource.indexOf('async function startLocalRuntime')
const startRuntimeEnd = connectionSource.indexOf('function settleSurvivingRuntime', startRuntimeAt)
const startRuntimeBody = startRuntimeAt >= 0 && startRuntimeEnd > startRuntimeAt
  ? connectionSource.slice(startRuntimeAt, startRuntimeEnd)
  : ''
const prepareAt = startRuntimeBody.indexOf('prepareLocalWebPort()')
check('startLocal resolves the automatic port before launching a local runtime',
  prepareAt >= 0,
  prepareAt < 0 ? 'prepareLocalWebPort missing from local startup' : undefined)
const reuseProbeAt = connectionSource.indexOf('probeSmartTargets()', startLocalEnd)
const beforeReuseProbe = startLocalEnd >= 0 && reuseProbeAt > startLocalEnd
  ? connectionSource.slice(startLocalEnd, reuseProbeAt)
  : ''
check('resolveRuntime reclaims a leftover before the reuse probe',
  beforeReuseProbe.includes('adoptOrClearSurvivingRuntime'),
  beforeReuseProbe.includes('adoptOrClearSurvivingRuntime')
    ? undefined
    : 'reuse probe still ran without a runtime-lock pass in between')

console.log('\n# src/main/settings-commands.ts: save/startup race guards')
const commandsSource = readFileSync(join(APP_DIR, 'src/main/settings-commands.ts'), 'utf8')
const requestSaveAt = commandsSource.indexOf('async function requestLocalWebPortSave')
const requestSaveEnd = commandsSource.indexOf('function isSmartProbeEquivalent', requestSaveAt)
const requestSaveBody = requestSaveAt >= 0 && requestSaveEnd > requestSaveAt
  ? commandsSource.slice(requestSaveAt, requestSaveEnd)
  : ''
const epochClaimAt = requestSaveBody.indexOf('const epoch = ++localWebPortSaveEpoch')
const confirmationAt = requestSaveBody.indexOf('confirmSensitiveAction')
const persistAt = requestSaveBody.indexOf('persistLocalWebPort(parsed, epoch)')
check('a port request claims its epoch before any confirmation dialog',
  epochClaimAt >= 0 && confirmationAt > epochClaimAt && persistAt > confirmationAt,
  epochClaimAt < 0 ? 'request epoch claim is missing'
    : confirmationAt < epochClaimAt ? 'confirmation still precedes the request epoch'
    : persistAt < 0 ? 'the claimed epoch is not passed to persistence'
    : undefined)

const exitHandlerAt = connectionSource.indexOf('const recoverFromChildExit = (): void =>')
const pinnedGateAt = connectionSource.indexOf("if (pinned > 0 && options.runtime()?.lastSource !== undefined)", exitHandlerAt)
const heldProbeAt = connectionSource.indexOf('loopbackPortHeld(pinned)', pinnedGateAt)
check('a pre-spawn resolution failure bypasses the pinned-port occupancy message',
  exitHandlerAt >= 0 && pinnedGateAt > exitHandlerAt && heldProbeAt > pinnedGateAt,
  pinnedGateAt < 0 ? 'the failed-spawn port gate does not require a selected source'
    : heldProbeAt < 0 ? 'the guarded occupancy probe is missing'
    : undefined)
const retryPortSelections = connectionSource.match(/respawnLocalRuntime\(generation\)/g)?.length ?? 0
check('every retry and source fallback re-resolves automatic mode',
  retryPortSelections === 3,
  String(retryPortSelections) + ' retry path(s) use respawnLocalRuntime; expected 3')

console.log('\n# src/main/runtime-catalog.ts: override version')
const officialBinOutfile = join(outDir, 'official-dsh-bin.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'official-dsh-bin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: officialBinOutfile,
})
const { officialDshPackageVersion } = await import(pathToFileURL(officialBinOutfile).href)

const decoyRoot = join(outDir, 'unrelated-project')
mkdirSync(join(decoyRoot, 'bin'), { recursive: true })
writeFileSync(join(decoyRoot, 'package.json'), JSON.stringify({
  name: 'dsh-desktop',
  version: '0.2.5',
}))
writeFileSync(join(decoyRoot, 'bin', 'dsh.exe'), '')
writeFileSync(join(decoyRoot, 'bin', 'dsh.cmd'), '')
equal('an exe two levels below an unrelated package.json is not a dsh version',
  officialDshPackageVersion(join(decoyRoot, 'bin', 'dsh.exe')), undefined)
equal('a .cmd next to an unrelated package.json is not a dsh version',
  officialDshPackageVersion(join(decoyRoot, 'bin', 'dsh.cmd')), undefined)

const officialRoot = join(outDir, 'official-dsh')
mkdirSync(join(officialRoot, 'lib'), { recursive: true })
writeFileSync(join(officialRoot, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh',
  version: '0.1.0-rc.8',
}))
writeFileSync(join(officialRoot, 'lib', 'bin.js'), '')
equal('official lib/bin.js reads the package version after the name check',
  officialDshPackageVersion(join(officialRoot, 'lib', 'bin.js')), '0.1.0-rc.8')

const impostorRoot = join(outDir, 'impostor-cli')
mkdirSync(join(impostorRoot, 'lib'), { recursive: true })
writeFileSync(join(impostorRoot, 'package.json'), JSON.stringify({
  name: 'dsh-desktop',
  version: '0.2.5',
}))
writeFileSync(join(impostorRoot, 'lib', 'bin.js'), '')
equal('lib/bin.js with the wrong package name is not a dsh version',
  officialDshPackageVersion(join(impostorRoot, 'lib', 'bin.js')), undefined)

const catalogSource = readFileSync(join(APP_DIR, 'src', 'main', 'runtime-catalog.ts'), 'utf8')
const resolveAt = catalogSource.indexOf('function resolveDshCommand')
const resolveEnd = catalogSource.indexOf('const enabled = enabledSmartRuntimes()', resolveAt)
const resolveBody = resolveAt >= 0 && resolveEnd > resolveAt
  ? catalogSource.slice(resolveAt, resolveEnd)
  : ''
const jsVersionAt = resolveBody.indexOf('readCommandVersionSync(command, [explicit])')
const jsManifestAt = resolveBody.indexOf('officialDshPackageVersion(explicit)')
check('a .js override prefers --version over the official manifest',
  jsVersionAt >= 0 && jsManifestAt > jsVersionAt,
  jsVersionAt < 0 ? 'readCommandVersionSync missing from the .js override'
    : jsManifestAt < 0 ? 'officialDshPackageVersion missing from the .js override'
    : jsManifestAt <= jsVersionAt ? '--version was not preferred for a .js override'
    : undefined)
const cmdVersionAt = resolveBody.indexOf('readCommandVersionSync(target.command')
check('a .cmd/exe override prefers --version over the official manifest',
  cmdVersionAt >= 0 && cmdVersionAt > jsVersionAt,
  cmdVersionAt < 0 ? 'readCommandVersionSync missing from the .cmd/exe override'
    : undefined)
check('override version no longer reads any nearby package.json',
  !catalogSource.includes('dshPackageVersionNearBin'))

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')
