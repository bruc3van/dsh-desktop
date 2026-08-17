/**
 * Unit check for `src/main/bundled-plugin.ts`.
 *
 * The seat mutates a user-shared `~/.dsh` profile. These cases pin the
 * contracts the client relies on (add / already-present / user-owned /
 * stale overlay lifted / withdraw / abandon / foreign directory /
 * missing plugin / no profile / upgrade re-copies / an older client's link
 * replaced / the version gate) against a temporary home, without booting
 * Electron.
 *
 * The seat is a COPY, and several cases exist only to hold that: a link made
 * the plugin resolve its `@deepseek-ai/*` imports inside the client's own
 * closure, which is what once confined the market to the bundled runtime.
 *
 * The module is bundled through esbuild rather than imported directly, so this
 * check does not depend on the host Node's TypeScript stripping.
 * @module desktop/scripts/check-bundled-plugin
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-bundled-plugin-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

const outfile = join(outDir, 'bundled-plugin.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'bundled-plugin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const {
  BUNDLED_PLUGIN_NAME,
  abandonBundledPlugin,
  runtimeRefusal,
  seatBundledPlugin,
  withdrawBundledPlugin,
} = await import(pathToFileURL(outfile).href)

/**
 * The runtime the fixtures seat into: same version as the one this client
 * would ship, which is the ordinary case the gate lets through.
 */
const RUNTIME = { version: '0.1.0-rc.7', builtAgainst: '0.1.0-rc.7' }

/** The marker naming a seat directory as the client's own. */
const SEAT_MARKER = '.dsh-desktop-seat.json'

/** Whether the seat is this client's copy of the plugin at the given version. */
const seatedCopy = (home, version) => {
  const seat = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  if (!existsSync(seat) || lstatSync(seat).isSymbolicLink()) return false
  if (!existsSync(join(seat, 'package.json'))) return false
  try {
    const marker = JSON.parse(readFileSync(join(seat, SEAT_MARKER), 'utf8'))
    return marker.owner === 'dsh-desktop' && (version === undefined || marker.version === version)
  } catch {
    return false
  }
}

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}

const fixtureHome = () => mkdtemp(join(tmpdir(), 'dsh-desktop-plugin-home-'))

const writeProfile = (home, manifest) => {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

const readProfile = (home) => JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))

const pluginDir = join(outDir, 'plugin')
mkdirSync(pluginDir)
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version: '0.2.1' }) + '\n')

const writeOverlay = (home, version) => {
  const dir = join(home, 'profiles', 'web', 'node_modules', BUNDLED_PLUGIN_NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version }) + '\n')
  return dir
}

const emptyBundles = {
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}

console.log('\n# seatBundledPlugin')
{
  const home = await fixtureHome()
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('no profile yet is not seated', result.seated === false && result.added === false,
    result.error)
}

{
  const home = await fixtureHome()
  writeProfile(home, { name: 'dsh-profile-web', private: true })
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('a profile with no bundle list is not seated', result.seated === false && result.added === false,
    result.error)
}

{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  const first = seatBundledPlugin(pluginDir, home, RUNTIME)
  const bundles = readProfile(home).dsh.profile.bundles
  const link = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  check('first seat adds the bundle name', first.seated === true && first.added === true)
  check('the name is in dsh.profile.bundles', bundles.includes(BUNDLED_PLUGIN_NAME),
    JSON.stringify(bundles))
  check('the official bundles stay in place', bundles[0] === '@deepseek-ai/dsh-base')
  check('the seat is a real directory carrying the plugin, not a link into the closure',
    seatedCopy(home, '0.2.1'),
    'a link would make the plugin resolve its @deepseek-ai imports inside the closure')
  check('no staging directory is left beside the seat',
    existsSync(link + '.' + String(process.pid) + '.tmp') === false)
  const leftover = existsSync(join(home, 'profiles', 'web', 'package.json.' + String(process.pid) + '.tmp'))
  check('atomic write leaves no sibling .tmp', leftover === false)
  const second = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('a second seat reports already present', second.seated === true && second.added === false)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  const oldDir = join(outDir, 'plugin-old')
  mkdirSync(oldDir)
  writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version: '0.0.0-old' }) + '\n')
  const first = seatBundledPlugin(oldDir, home, RUNTIME)
  const upgraded = seatBundledPlugin(pluginDir, home, RUNTIME)
  const listed = readProfile(home).dsh.profile.bundles.filter(name => name === BUNDLED_PLUGIN_NAME)
  check('a first seat against an old closure is seated', first.seated === true && first.added === true)
  check('upgrading the closure re-copies the seat without rewriting bundles',
    upgraded.seated === true && upgraded.added === false
    && seatedCopy(home, '0.2.1') && listed.length === 1)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED_PLUGIN_NAME] } },
  })
  const link = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  mkdirSync(dirname(link), { recursive: true })
  // What a client up to 0.2.0 left behind: a link into its own closure.
  symlinkSync(pluginDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('a link left by an older client is replaced by a copy',
    result.seated === true && seatedCopy(home, '0.2.1'),
    'the link is what confined the plugin to the client\'s own runtime')
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.3.0' },
  })
  writeOverlay(home, '0.3.0')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  const bundles = readProfile(home).dsh?.profile?.bundles ?? []
  const link = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  const overlay = join(home, 'profiles', 'web', 'node_modules', BUNDLED_PLUGIN_NAME)
  check('a newer user overlay is reported seated and not added',
    result.seated === true && result.added === false && result.lifted !== true)
  check('a newer user overlay is not written into bundles', !bundles.includes(BUNDLED_PLUGIN_NAME),
    JSON.stringify(bundles))
  check('a newer user overlay keeps its dependency',
    Object.hasOwn(readProfile(home).dependencies ?? {}, BUNDLED_PLUGIN_NAME))
  check('a newer user overlay gets no client-owned copy', existsSync(link) === false)
  check('a newer user overlay keeps its nearer install', existsSync(join(overlay, 'package.json')))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.2.1' },
  })
  writeOverlay(home, '0.2.1')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('an equal user overlay is left in place',
    result.seated === true && result.added === false && result.lifted !== true
    && Object.hasOwn(readProfile(home).dependencies ?? {}, BUNDLED_PLUGIN_NAME)
    && !readProfile(home).dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.1.4' },
  })
  const overlay = writeOverlay(home, '0.1.4')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  const profile = readProfile(home)
  check('an older user overlay is lifted onto the closure',
    result.seated === true && result.added === true && result.lifted === true)
  check('a lifted overlay is listed in bundles', profile.dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  check('a lifted overlay is no longer a profile dependency',
    Object.hasOwn(profile.dependencies ?? {}, BUNDLED_PLUGIN_NAME) === false)
  check('a lifted overlay leaves the client-owned copy in the module fallback',
    seatedCopy(home, '0.2.1'))
  check('a lifted overlay removes the nearer older install', existsSync(overlay) === false)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.1.4' },
  })
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('a listed overlay with no installed files is lifted',
    result.seated === true && result.added === true && result.lifted === true
    && Object.hasOwn(readProfile(home).dependencies ?? {}, BUNDLED_PLUGIN_NAME) === false
    && readProfile(home).dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.1.4' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED_PLUGIN_NAME] } },
  })
  writeOverlay(home, '0.1.4')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  check('lifting an already-listed older overlay does not rewrite bundles',
    result.seated === true && result.added === false && result.lifted === true
    && readProfile(home).dsh.profile.bundles.filter(name => name === BUNDLED_PLUGIN_NAME).length === 1
    && Object.hasOwn(readProfile(home).dependencies ?? {}, BUNDLED_PLUGIN_NAME) === false)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.1.4' },
  })
  const foreign = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'package.json'), '{"name":"impostor"}\n')
  writeOverlay(home, '0.1.4')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  const profile = readProfile(home)
  check('a blocked link does not take a stale overlay away',
    result.seated === false && result.lifted !== true
    && Object.hasOwn(profile.dependencies ?? {}, BUNDLED_PLUGIN_NAME)
    && existsSync(join(home, 'profiles', 'web', 'node_modules', BUNDLED_PLUGIN_NAME, 'package.json')))
  rmSync(home, { recursive: true, force: true })
}

console.log('\n# the seat copy vs bundles')
{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  const foreign = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'package.json'), '{"name":"impostor"}\n')
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  const bundles = readProfile(home).dsh.profile.bundles
  check('a foreign real directory is not treated as seated', result.seated === false && result.added === false,
    result.error)
  check('a foreign real directory is not listed in bundles', !bundles.includes(BUNDLED_PLUGIN_NAME),
    JSON.stringify(bundles))
  check('a foreign real directory is left in place', existsSync(join(foreign, 'package.json')))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED_PLUGIN_NAME] } },
  })
  const foreign = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  mkdirSync(foreign, { recursive: true })
  const result = seatBundledPlugin(pluginDir, home, RUNTIME)
  const bundles = readProfile(home).dsh.profile.bundles
  check('a leftover name in front of a foreign directory is withdrawn',
    result.seated === false && !bundles.includes(BUNDLED_PLUGIN_NAME),
    JSON.stringify(bundles))
  rmSync(home, { recursive: true, force: true })
}

console.log('\n# the version gate')
{
  // The gate is what replaces "bundled runtimes only". The copy makes the
  // plugin resolvable anywhere; this decides where it SHOULD go.
  check('an equal runtime is accepted', runtimeRefusal(RUNTIME) === undefined)
  check('a newer runtime is accepted — every future dsh is newer than the one we tested',
    runtimeRefusal({ version: '0.2.0', builtAgainst: '0.1.0-rc.6' }) === undefined)
  // dsh ships an `rc` sequence, so this is the ordering that actually decides
  // whether the gate keeps working past rc.9 — string order puts rc.10 first.
  check('rc.10 is newer than rc.6, not older',
    runtimeRefusal({ version: '0.1.0-rc.10', builtAgainst: '0.1.0-rc.6' }) === undefined)
  check('rc.10 is newer than rc.9',
    runtimeRefusal({ version: '0.1.0-rc.10', builtAgainst: '0.1.0-rc.9' }) === undefined)
  check('rc.6 is still older than rc.10',
    typeof runtimeRefusal({ version: '0.1.0-rc.6', builtAgainst: '0.1.0-rc.10' }) === 'string')
  check('a numeric identifier sorts below an alphanumeric one (semver §11)',
    typeof runtimeRefusal({ version: '0.1.0-1', builtAgainst: '0.1.0-alpha' }) === 'string')
  check('a longer prerelease list outranks its own prefix',
    runtimeRefusal({ version: '0.1.0-rc.1.1', builtAgainst: '0.1.0-rc.1' }) === undefined)
  check('an older runtime is refused',
    typeof runtimeRefusal({ version: '0.1.0-rc.3', builtAgainst: '0.1.0-rc.6' }) === 'string')
  check('an older release line is refused',
    typeof runtimeRefusal({ version: '0.0.9', builtAgainst: '0.1.0-rc.6' }) === 'string')
  check('an unknown runtime version is refused, not guessed',
    typeof runtimeRefusal({ builtAgainst: '0.1.0-rc.6' }) === 'string')
  // A reused instance's dsh version is unreadable, but it is up and serving
  // this very profile — that standing fact substitutes for the comparison.
  check('a runtime already serving the profile is accepted without a version',
    runtimeRefusal({ serving: true, builtAgainst: '0.1.0-rc.6' }) === undefined)
  check('serving outranks an older version reading',
    runtimeRefusal({ serving: true, version: '0.0.9', builtAgainst: '0.1.0-rc.6' }) === undefined)
}

console.log('\n# re-seating under a serving runtime (adopt path)')
{
  // The reported bug's exact shape: released before the probe, adopted after.
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  withdrawBundledPlugin(home)
  const result = seatBundledPlugin(pluginDir, home, { serving: true, builtAgainst: RUNTIME.builtAgainst })
  const bundles = readProfile(home).dsh.profile.bundles
  check('a withdrawn seat is restored by name under a serving runtime',
    result.seated === true && bundles.includes(BUNDLED_PLUGIN_NAME), result.error)
}

{
  // Client upgraded, then adopted a still-running instance: the copy that
  // live process may hold open is NOT swapped — a failed retire-rename
  // (EBUSY on Windows) would withdraw the entry and re-open the bug. The
  // next spawn upgrades the copy behind the real version gate.
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  withdrawBundledPlugin(home)
  const newerPlugin = join(outDir, 'plugin-newer')
  mkdirSync(newerPlugin, { recursive: true })
  writeFileSync(join(newerPlugin, 'package.json'), JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version: '0.3.0' }) + '\n')
  const result = seatBundledPlugin(newerPlugin, home, { serving: true, builtAgainst: RUNTIME.builtAgainst })
  check('a serving re-seat leaves the existing copy alone (the next spawn upgrades)',
    result.seated === true && seatedCopy(home, '0.2.1'), result.error)
  const spawned = seatBundledPlugin(newerPlugin, home, { version: '0.1.0-rc.6', builtAgainst: '0.1.0-rc.6' })
  check('the next gated spawn does upgrade that copy',
    spawned.seated === true && seatedCopy(home, '0.3.0'), spawned.error)
}

{
  // No copy in place at all (fresh home): nothing a live process can be
  // holding, so the full copy runs — a name alone would fail loadProfile.
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  const result = seatBundledPlugin(pluginDir, home, { serving: true, builtAgainst: RUNTIME.builtAgainst })
  check('a serving seat with no copy in place still copies',
    result.seated === true && seatedCopy(home, '0.2.1'), result.error)
  check('an unparseable runtime version is refused',
    typeof runtimeRefusal({ version: 'nightly', builtAgainst: '0.1.0-rc.6' }) === 'string')
  check('with nothing to compare against the gate stands down',
    runtimeRefusal({ version: '0.0.1' }) === undefined)
}

{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  const result = seatBundledPlugin(pluginDir, home, { version: '0.1.0-rc.3', builtAgainst: '0.1.0-rc.6' })
  const bundles = readProfile(home).dsh.profile.bundles
  check('an older runtime is not seated', result.seated === false && result.added === false, result.error)
  check('an older runtime is not listed in bundles', !bundles.includes(BUNDLED_PLUGIN_NAME))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  const downgraded = seatBundledPlugin(pluginDir, home, { version: '0.1.0-rc.3', builtAgainst: '0.1.0-rc.6' })
  const bundles = readProfile(home).dsh.profile.bundles
  check('booting an older runtime withdraws a seat taken by a newer one',
    downgraded.seated === false && !bundles.includes(BUNDLED_PLUGIN_NAME),
    'the entry must not outlive the runtime that could carry it')
  check('the withdrawn seat keeps its copy, so returning costs no copy', seatedCopy(home, '0.2.1'))
  rmSync(home, { recursive: true, force: true })
}

{
  // The same comparison decides whether a user's own install is stale, and
  // there it does not merely skip the seat — it deletes the tree. A version
  // ordering bug is therefore a data-loss bug, not only a gating one.
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.2.1-rc.10' },
  })
  const overlay = writeOverlay(home, '0.2.1-rc.10')
  const rcClosure = join(outDir, 'plugin-rc6')
  mkdirSync(rcClosure, { recursive: true })
  writeFileSync(join(rcClosure, 'package.json'),
    JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version: '0.2.1-rc.6' }) + '\n')
  const result = seatBundledPlugin(rcClosure, home, RUNTIME)
  check('a user overlay at rc.10 is not mistaken for older than a bundled rc.6',
    result.seated === true && result.added === false && result.lifted === undefined)
  check("the user's newer install is still on disk", existsSync(join(overlay, 'package.json')),
    'string ordering would have deleted it as stale')
  check('the user keeps their dependency entry',
    readProfile(home).dependencies?.[BUNDLED_PLUGIN_NAME] === '0.2.1-rc.10')
  rmSync(home, { recursive: true, force: true })
}

{
  // A user-owned copy plus a runtime the gate would refuse: the client is not
  // touching the seat either way, so it must not report the market as absent.
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '0.3.0' },
  })
  writeOverlay(home, '0.3.0')
  const result = seatBundledPlugin(pluginDir, home, { version: '0.1.0-rc.3', builtAgainst: '0.1.0-rc.6' })
  check('a user-owned copy is reported seated even on a runtime the gate refuses',
    result.seated === true && result.error === undefined,
    'the gate has no say over a seat this client is not taking')
  rmSync(home, { recursive: true, force: true })
}

{
  // Seat replacement must never leave the name empty: `dsh.profile.bundles`
  // lists it, and a boot landing in that window fails loadProfile for every
  // consumer of the shared profile.
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  const seat = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  const litter = seat + '.99999.tmp'
  mkdirSync(litter, { recursive: true })
  writeFileSync(join(litter, 'package.json'), '{}')
  const newer = join(outDir, 'plugin-newer')
  mkdirSync(newer, { recursive: true })
  writeFileSync(join(newer, 'package.json'),
    JSON.stringify({ name: BUNDLED_PLUGIN_NAME, version: '0.9.9' }) + '\n')
  seatBundledPlugin(newer, home, RUNTIME)
  check('re-copying leaves the seat populated at the new version', seatedCopy(home, '0.9.9'))
  check('a staging tree left by a dead process is swept', existsSync(litter) === false)
  const siblings = readdirSync(join(home, 'profiles', 'node_modules'))
    .filter(name => name.startsWith(BUNDLED_PLUGIN_NAME + '.'))
  check('no staging or retired trees survive the swap', siblings.length === 0, JSON.stringify(siblings))
  rmSync(home, { recursive: true, force: true })
}

console.log('\n# withdraw / abandon')
{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  const withdrawn = withdrawBundledPlugin(home)
  const bundles = readProfile(home).dsh.profile.bundles
  check('withdraw removes the bundle name', withdrawn === true && !bundles.includes(BUNDLED_PLUGIN_NAME))
  check('withdraw leaves the copy for a cheap re-seat',
    seatedCopy(home, '0.2.1'),
    're-seating is then one array entry again, with nothing to copy')
  check('withdraw is a no-op the second time', withdrawBundledPlugin(home) === false)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dependencies: { [BUNDLED_PLUGIN_NAME]: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED_PLUGIN_NAME] } },
  })
  check('withdraw never touches a user-owned copy', withdrawBundledPlugin(home) === false)
  check('the user-owned name stays in bundles',
    readProfile(home).dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, emptyBundles)
  seatBundledPlugin(pluginDir, home, RUNTIME)
  const abandoned = abandonBundledPlugin(home)
  const link = join(home, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
  check('abandon removes the bundle name',
    abandoned === true && !readProfile(home).dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  check('abandon removes the client-owned copy', existsSync(link) === false)
  rmSync(home, { recursive: true, force: true })
}

{
  const home = await fixtureHome()
  writeProfile(home, {
    ...emptyBundles,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLED_PLUGIN_NAME] } },
  })
  const missing = join(outDir, 'missing-plugin')
  mkdirSync(missing, { recursive: true })
  const result = seatBundledPlugin(missing, home)
  check('a missing plugin package is not seated', result.seated === false, result.error)
  check('a missing plugin drops a leftover bundle name',
    !readProfile(home).dsh.profile.bundles.includes(BUNDLED_PLUGIN_NAME))
  rmSync(home, { recursive: true, force: true })
}

console.log('\n# the pinned market carries what the docs promise')
{
  // The client's docs promise that the market's own installed panel lists
  // this seat and can remove it — the ONLY way to remove it once the client
  // is uninstalled. That promise is kept by the market, not by this repo, so
  // it is only true if `dsh-runtime/package.json` pins a version that has it.
  // A release where the two drift ships a manual that lies about the one
  // escape hatch it documents.
  const require_ = createRequire(join(APP_DIR, 'dsh-runtime', 'package.json'))
  let body = ''
  try {
    body = readFileSync(join(dirname(require_.resolve(BUNDLED_PLUGIN_NAME + '/package.json')), 'lib', 'plugin.js'), 'utf8')
  } catch (error) {
    check('the pinned market is resolvable', false, String(error))
  }
  if (body !== '') {
    check('the pinned market can list and remove its own in-box seat',
      body.includes('dsh-desktop-seat.json') && body.includes('inBox'),
      'the pinned dsh-desktop-safe-market does not read the ownership marker — bump the tarball in '
      + 'dsh-runtime/package.json to a release that does, or the removal path the README documents does not exist')
  }
}

console.log('\n# closure resolve (dev layout)')
{
  const anchor = join(APP_DIR, 'dsh-runtime', 'package.json')
  let resolved
  try {
    resolved = dirname(createRequire(anchor).resolve(BUNDLED_PLUGIN_NAME + '/package.json'))
  } catch (error) {
    resolved = undefined
    check('createRequire from dsh-runtime finds the plugin', false, String(error))
  }
  if (resolved !== undefined) {
    check('createRequire from dsh-runtime finds the plugin',
      existsSync(join(resolved, 'package.json')), resolved)
  }
}

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('\nAll bundled-plugin checks passed.')
