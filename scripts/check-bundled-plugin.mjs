/** Exercise client-owned seats and preserve all package-manager owned state. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'dsh-market-seat-'))
const output = join(temp, 'seat.mjs')
await build({ entryPoints: [join(root, 'src/main/bundled-plugin.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' })
const { seatBundledPlugin, withdrawBundledPlugin, abandonBundledPlugin, inspectBundledPlugin, runtimeRefusal, BUNDLED_PLUGIN_NAME: name } = await import(pathToFileURL(output))
const runtime = { version: '0.1.5-rc.1', peerRanges: ['^0.1.5-rc.1'] }
const marker = '.dsh-desktop-seat.json'
const manifestPath = home => join(home, 'profiles/web/package.json')
const seat = home => join(home, 'profiles/web/node_modules', name)
const legacy = home => join(home, 'profiles/node_modules', name)
const read = home => JSON.parse(readFileSync(manifestPath(home), 'utf8'))
let sequence = 0
function pkg(dir, version, owned = false) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  writeFileSync(join(dir, 'entry.js'), 'export default ' + JSON.stringify(version))
  if (owned) writeFileSync(join(dir, marker), JSON.stringify({ owner: 'dsh-desktop', version }))
  return dir
}
function home({ dependencies, listed = false } = {}) {
  const dir = join(temp, 'home-' + ++sequence)
  mkdirSync(dirname(manifestPath(dir)), { recursive: true })
  writeFileSync(manifestPath(dir), JSON.stringify({ private: true, dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...listed ? [name] : []] } } }))
  return dir
}
const payload = pkg(join(temp, 'payload'), '0.5.0')
try {
  assert.equal(seatBundledPlugin(payload, join(temp, 'missing'), runtime).seated, false)
  const owned = home()
  assert.deepEqual(seatBundledPlugin(payload, owned, runtime), { seated: true, added: true, owned: true })
  assert.equal(inspectBundledPlugin(owned).owned, true)
  assert.equal(existsSync(join(seat(owned), marker)), true)
  assert.equal(existsSync(legacy(owned)), false)
  assert.equal(seatBundledPlugin(payload, owned, runtime).added, false)
  const updated = pkg(join(temp, 'updated'), '0.5.1')
  seatBundledPlugin(updated, owned, runtime)
  assert.equal(JSON.parse(readFileSync(join(seat(owned), 'package.json'))).version, '0.5.1')
  assert.equal(read(owned).dsh.profile.bundles.filter(x => x === name).length, 1)
  assert.equal(withdrawBundledPlugin(owned), true)
  assert.equal(existsSync(seat(owned)), true)
  seatBundledPlugin(updated, owned, runtime)
  assert.equal(abandonBundledPlugin(owned), true)
  assert.equal(existsSync(seat(owned)), false)
  console.log('✓ profile-local owned copy upgrades, withdraws and removes without duplicate bundles')

  for (const version of ['0.1.4', '0.5.0', '99.0.0', 'git-custom']) {
    for (const listed of [false, true]) {
      const dir = home({ dependencies: { [name]: version }, listed })
      pkg(seat(dir), version)
      const lock = join(dirname(manifestPath(dir)), 'pnpm-lock.yaml')
      writeFileSync(lock, 'user-owned lockfile: ' + version)
      const before = readFileSync(manifestPath(dir), 'utf8')
      const result = seatBundledPlugin(payload, dir, runtime)
      assert.equal(result.owned, false)
      assert.equal(result.seated, listed)
      assert.equal(readFileSync(manifestPath(dir), 'utf8'), before)
      assert.equal(readFileSync(lock, 'utf8'), 'user-owned lockfile: ' + version)
      assert.equal(JSON.parse(readFileSync(join(seat(dir), 'package.json'))).version, version)
      assert.equal(withdrawBundledPlugin(dir), false)
      assert.equal(abandonBundledPlugin(dir), false)
      assert.equal(existsSync(join(seat(dir), 'package.json')), true)
    }
  }
  const broken = home({ dependencies: { [name]: '0.1.4' }, listed: true })
  const beforeBroken = readFileSync(manifestPath(broken), 'utf8')
  seatBundledPlugin(payload, broken, runtime)
  assert.equal(readFileSync(manifestPath(broken), 'utf8'), beforeBroken)
  assert.equal(existsSync(seat(broken)), false)
  const foreign = home({ listed: true })
  pkg(seat(foreign), 'unmanaged')
  seatBundledPlugin(payload, foreign, runtime)
  abandonBundledPlugin(foreign)
  assert.equal(JSON.parse(readFileSync(join(seat(foreign), 'package.json'))).version, 'unmanaged')
  console.log('✓ old/new/pinned/missing user installs, lockfiles and unregistered local packages remain untouched')

  for (const anotherProfile of [false, true]) {
    const dir = home({ listed: true })
    pkg(legacy(dir), '0.4.3', true)
    if (anotherProfile) {
      const other = join(dir, 'profiles/custom/package.json')
      mkdirSync(dirname(other), { recursive: true })
      writeFileSync(other, JSON.stringify({ dsh: { profile: { bundles: [name] } } }))
    }
    seatBundledPlugin(payload, dir, runtime)
    assert.equal(JSON.parse(readFileSync(join(seat(dir), 'package.json'))).version, '0.5.0')
    assert.equal(existsSync(legacy(dir)), anotherProfile)
    abandonBundledPlugin(dir)
    assert.equal(existsSync(legacy(dir)), anotherProfile)
  }
  for (const anotherProfile of [false, true]) {
    const dir = home({ dependencies: { [name]: '0.5.0' }, listed: true })
    pkg(seat(dir), '0.5.0')
    pkg(legacy(dir), '0.4.3', true)
    const before = readFileSync(manifestPath(dir), 'utf8')
    if (anotherProfile) {
      const other = join(dir, 'profiles/custom/package.json')
      mkdirSync(dirname(other), { recursive: true })
      writeFileSync(other, JSON.stringify({ dependencies: { [name]: '0.4.3' } }))
    }
    seatBundledPlugin(payload, dir, runtime)
    assert.equal(existsSync(legacy(dir)), anotherProfile)
    assert.equal(readFileSync(manifestPath(dir), 'utf8'), before)
    assert.equal(JSON.parse(readFileSync(join(seat(dir), 'package.json'))).version, '0.5.0')
  }
  const missingUser = home({ dependencies: { [name]: '0.5.0' }, listed: true })
  pkg(legacy(missingUser), '0.4.3', true)
  seatBundledPlugin(payload, missingUser, runtime)
  assert.ok(existsSync(legacy(missingUser)))
  const knownLink = home({ listed: true })
  mkdirSync(dirname(legacy(knownLink)), { recursive: true })
  symlinkSync(payload, legacy(knownLink), process.platform === 'win32' ? 'junction' : 'dir')
  seatBundledPlugin(payload, knownLink, runtime)
  assert.equal(existsSync(legacy(knownLink)), false)
  assert.ok(existsSync(payload))
  const disabledLink = home({ listed: true })
  mkdirSync(dirname(legacy(disabledLink)), { recursive: true })
  symlinkSync(payload, legacy(disabledLink), process.platform === 'win32' ? 'junction' : 'dir')
  abandonBundledPlugin(disabledLink, payload)
  assert.equal(read(disabledLink).dsh.profile.bundles.includes(name), false)
  assert.equal(existsSync(legacy(disabledLink)), false)
  assert.ok(existsSync(payload))
  const unknownLink = home({ listed: true })
  const unknownTarget = pkg(join(temp, 'unknown-target'), '0.4.3')
  mkdirSync(dirname(legacy(unknownLink)), { recursive: true })
  symlinkSync(unknownTarget, legacy(unknownLink), process.platform === 'win32' ? 'junction' : 'dir')
  rmSync(unknownTarget, { recursive: true, force: true })
  seatBundledPlugin(payload, unknownLink, runtime)
  assert.ok(lstatSync(legacy(unknownLink)).isSymbolicLink())
  console.log('✓ user install retires only unused owned legacy copies; known payload links are unlinked without deleting targets')
  const foreignLink = home({ listed: true })
  const target = pkg(join(temp, 'foreign-link-target'), '0.1.0')
  mkdirSync(dirname(seat(foreignLink)), { recursive: true })
  symlinkSync(target, seat(foreignLink), process.platform === 'win32' ? 'junction' : 'dir')
  seatBundledPlugin(payload, foreignLink, runtime)
  abandonBundledPlugin(foreignLink)
  assert.equal(existsSync(seat(foreignLink)), true)
  assert.equal(existsSync(target), true)
  console.log('✓ legacy shared seats migrate to web; other profiles and foreign links survive')

  const running = home({ listed: true })
  pkg(legacy(running), '0.4.3', true)
  const beforeRunning = readFileSync(manifestPath(running), 'utf8')
  assert.equal(seatBundledPlugin(payload, running, { serving: true }).owned, true)
  assert.equal(readFileSync(manifestPath(running), 'utf8'), beforeRunning)
  assert.equal(existsSync(seat(running)), false)
  assert.equal(JSON.parse(readFileSync(join(legacy(running), 'package.json'))).version, '0.4.3')
  const unlisted = home()
  seatBundledPlugin(payload, unlisted, { serving: true })
  assert.equal(read(unlisted).dsh.profile.bundles.includes(name), false)
  assert.equal(existsSync(seat(unlisted)), false)
  console.log('✓ adopted runtimes are inspected without adding, swapping or withdrawing a seat')

  for (const version of ['0.1.5-rc.1', '0.1.5-rc.10', '0.1.5', '0.1.6']) {
    assert.equal(runtimeRefusal({ ...runtime, version }), undefined)
  }
  for (const version of [undefined, 'garbage', '0.1.2', '0.1.5-alpha.2', '0.2.0', '0.1.6-rc.1']) {
    assert.equal(typeof runtimeRefusal({ ...runtime, version }), 'string')
  }
  assert.equal(typeof runtimeRefusal({ version: '0.1.5' }), 'string')
  assert.equal(typeof runtimeRefusal({ ...runtime, serving: true }), 'string')
  const incompatible = home()
  seatBundledPlugin(payload, incompatible, runtime)
  seatBundledPlugin(payload, incompatible, { ...runtime, version: '0.2.0' })
  assert.equal(read(incompatible).dsh.profile.bundles.includes(name), false)
  assert.equal(existsSync(seat(incompatible)), true)
  console.log('✓ actual semver peer ranges gate prereleases and upper bounds')

  const damaged = home()
  seatBundledPlugin(payload, damaged, runtime)
  rmSync(join(seat(damaged), 'package.json'))
  seatBundledPlugin(payload, damaged, runtime)
  assert.equal(existsSync(join(seat(damaged), 'package.json')), true)
  seatBundledPlugin(join(temp, 'missing-payload'), damaged, runtime)
  assert.equal(read(damaged).dsh.profile.bundles.includes(name), false)
  assert.equal(existsSync(seat(damaged)), false)

  const fromRuntime = createRequire(join(root, 'dsh-runtime/package.json'))
  const packageFile = fromRuntime.resolve(name + '/package.json')
  const pinned = JSON.parse(readFileSync(join(root, 'dsh-runtime/package.json'))).dependencies[name]
  assert.equal(JSON.parse(readFileSync(packageFile)).version, pinned)
  const body = readFileSync(join(dirname(packageFile), 'lib/plugin.js'), 'utf8')
  assert.ok(body.includes('dsh-desktop-seat.json') && body.includes('inBox'))
  console.log('✓ damaged owned copies recover; published market recognizes the ownership marker')
} finally {
  await rm(temp, { recursive: true, force: true })
}
