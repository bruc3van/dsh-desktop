/** Test the shipped DSH resolver and the actual managed launcher, in disposable homes. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, copyFile, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const modules = join(root, '.runtime/node_modules')
const name = 'dsh-desktop-safe-market'
const payload = join(root, '.runtime/bundled-plugins', name)
const anchor = join(modules, '@deepseek-ai/dsh/package.json')
const entry = join(dirname(anchor), 'lib/bin.js')
const launcher = join(root, '.build/runtime-launcher.mjs')
assert.ok(existsSync(launcher), 'run pnpm run build first')
assert.ok(existsSync(join(payload, 'package.json')), 'run pnpm run prepare:runtime first')
assert.equal(existsSync(join(modules, name)), false, 'installation must not shadow a profile market')
const pinned = JSON.parse(await readFile(join(root, 'dsh-runtime/package.json'))).dependencies[name]
assert.equal(JSON.parse(await readFile(join(payload, 'package.json'))).version, pinned)
const { loadProfileDirectory, healProfilesModuleFallback } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js')))
const temp = await mkdtemp(join(tmpdir(), 'dsh-market-boot-'))
try {
  const output = join(temp, 'boot.mjs')
  await build({ entryPoints: [join(root, 'src/main/bundled-market-boot.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' })
  const { prepareBundledMarket, marketPeerIssues } = await import(pathToFileURL(output))
  const home = join(temp, 'fresh')
  const request = { home, pluginDir: payload, mode: 'offer' }
  await prepareBundledMarket(entry, request)
  const profileDir = join(home, 'profiles/web')
  const marketDir = join(profileDir, 'node_modules', name)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json')))
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
  assert.ok(manifest.dsh.profile.bundles.includes(name))
  assert.equal(manifest.dependencies[name], undefined)
  assert.match(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'), /autoInstallPeers: false/)
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  assert.equal(resolve(profile.layers.find(layer => layer.packageName === name).packageDir), resolve(marketDir))
  await healProfilesModuleFallback({ installAnchor: anchor, profile, home })
  const fromMarket = createRequire(join(marketDir, 'package.json'))
  const fromRuntime = createRequire(anchor)
  assert.equal(fromMarket.resolve('@deepseek-ai/cordis'), fromRuntime.resolve('@deepseek-ai/cordis'))
  assert.equal(fromMarket.resolve('@deepseek-ai/dsh-settings'), fromRuntime.resolve('@deepseek-ai/dsh-settings'))
  console.log('✓ cold profile uses official defaults; patch and module come from its owned package with runtime peers')

  // User payloads are deliberately different, so a stale in-box patch cannot pass.
  for (const version of ['0.1.0', '99.0.0']) {
    const userHome = join(temp, 'user-' + version)
    const userProfile = join(userHome, 'profiles/web')
    const userPackage = join(userProfile, 'node_modules', name)
    await mkdir(userPackage, { recursive: true })
    await writeFile(join(userPackage, 'package.json'), JSON.stringify({ name, version, main: './index.js', dsh: { bundle: { patch: './user.patch.yml' } } }))
    await writeFile(join(userPackage, 'index.js'), 'module.exports = ' + JSON.stringify(version))
    await writeFile(join(userPackage, 'user.patch.yml'), '[]\n')
    const userManifest = JSON.stringify({ dependencies: { [name]: version }, dsh: { profile: { bundles: [name] } } })
    await writeFile(join(userProfile, 'package.json'), userManifest)
    await writeFile(join(userProfile, 'pnpm-lock.yaml'), 'lockfile-owned-by-user')
    await prepareBundledMarket(entry, { ...request, home: userHome })
    const loaded = loadProfileDirectory('dsh', userProfile, anchor)
    assert.equal(resolve(loaded.layers[0].packageDir), resolve(userPackage))
    assert.ok(loaded.layers[0].patchPath.endsWith('user.patch.yml'))
    await healProfilesModuleFallback({ installAnchor: anchor, profile: loaded, home: userHome })
    assert.equal(createRequire(join(userProfile, 'package.json'))(name), version)
    assert.equal(await readFile(join(userProfile, 'package.json'), 'utf8'), userManifest)
    assert.equal(await readFile(join(userProfile, 'pnpm-lock.yaml'), 'utf8'), 'lockfile-owned-by-user')
    await prepareBundledMarket(entry, { ...request, home: userHome, mode: 'disabled' })
    assert.ok(existsSync(join(userPackage, 'index.js')))
  }
  console.log('✓ official resolver uses user patch AND module for older and newer overlays; disable preserves them')

  await prepareBundledMarket(entry, { ...request, mode: 'disabled' })
  assert.equal(existsSync(marketDir), false)
  assert.equal(JSON.parse(await readFile(join(profileDir, 'package.json'))).dsh.profile.bundles.includes(name), false)
  await prepareBundledMarket(entry, request)
  assert.ok(existsSync(marketDir))
  await prepareBundledMarket(entry, { ...request, mode: 'suppressed' })
  assert.equal(JSON.parse(await readFile(join(profileDir, 'package.json'))).dsh.profile.bundles.includes(name), false)
  assert.ok(existsSync(marketDir))

  const badPayload = join(temp, 'incompatible')
  await cp(payload, badPayload, { recursive: true })
  const badManifest = JSON.parse(await readFile(join(badPayload, 'package.json')))
  badManifest.peerDependencies['@deepseek-ai/dsh-settings'] = '^0.2.0'
  await writeFile(join(badPayload, 'package.json'), JSON.stringify(badManifest))
  const badHome = join(temp, 'unsupported')
  await prepareBundledMarket(entry, { home: badHome, pluginDir: badPayload, mode: 'offer' })
  assert.equal(existsSync(join(badHome, 'profiles/web/package.json')), false)
  console.log('✓ disabled/suppressed restart and unsupported peers do not silently re-enable a seat')

  const independentCli = join(temp, 'independent-cli')
  await mkdir(join(independentCli, 'lib'), { recursive: true })
  await writeFile(join(independentCli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '99.0.0' }))
  await symlink(modules, join(independentCli, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const independentHome = join(temp, 'independent-home')
  await prepareBundledMarket(join(independentCli, 'lib/bin.js'), { ...request, home: independentHome })
  assert.ok(JSON.parse(await readFile(join(independentHome, 'profiles/web/package.json'))).dsh.profile.bundles.includes(name))
  console.log('✓ compatible peer packages are accepted independently of CLI version numbering')

  const driftHome = join(temp, 'drift-user')
  const driftProfile = join(driftHome, 'profiles/web')
  const driftMarket = join(driftProfile, 'node_modules', name)
  await cp(payload, driftMarket, { recursive: true })
  const driftManifest = JSON.stringify({ dependencies: { [name]: '0.5.0' }, dsh: { profile: { bundles: [name] } } })
  await writeFile(join(driftProfile, 'package.json'), driftManifest)
  const slots = join(driftProfile, 'node_modules/@deepseek-ai/dsh-client-ui-slots')
  const staleSlots = join(temp, 'old-npx/node_modules/@deepseek-ai/dsh-client-ui-slots')
  await mkdir(staleSlots, { recursive: true })
  await mkdir(dirname(slots), { recursive: true })
  await symlink(staleSlots, slots, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(staleSlots, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-slots', version: '0.1.0-rc.7' }))
  const warnings = []
  const warn = console.warn
  try {
    console.warn = (...args) => warnings.push(args.join(' '))
    await prepareBundledMarket(entry, { ...request, home: driftHome })
  } finally { console.warn = warn }
  assert.ok(warnings.some(text => text.includes('market dependency drift') && text.includes('0.1.0-rc.7')))
  assert.equal(await readFile(join(driftProfile, 'package.json'), 'utf8'), driftManifest)
  assert.ok(marketPeerIssues(driftHome).some(text => text.includes('dsh-client-ui-slots')))
  const ownedDrift = join(temp, 'drift-owned')
  const ownedSlots = join(ownedDrift, 'profiles/web/node_modules/@deepseek-ai/dsh-client-ui-slots')
  await mkdir(ownedSlots, { recursive: true })
  await cp(join(slots, 'package.json'), join(ownedSlots, 'package.json'))
  await prepareBundledMarket(entry, { ...request, home: ownedDrift })
  assert.equal(JSON.parse(await readFile(join(ownedDrift, 'profiles/web/package.json'))).dsh.profile.bundles.includes(name), false)
  assert.ok(existsSync(join(ownedSlots, 'package.json')))
  console.log('✓ actual profile peer drift warns for user installs and withdraws only owned registration')

  // Exercise real discovery and launcher invocation for both preferred sources.
  const catalogFile = join(temp, 'catalog.mjs')
  await build({ entryPoints: [join(root, 'src/main/runtime-catalog.ts')], bundle: true,
    platform: 'node', format: 'esm', outfile: catalogFile, logLevel: 'silent',
    plugins: [{ name: 'electron-fixture', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app = { isPackaged: false }; export const shell = {};' }))
    } }] })
  const { createRuntimeCatalog } = await import(pathToFileURL(catalogFile))
  const savedEnv = { ...process.env }
  try {
    const bin = join(temp, 'path-bin')
    await mkdir(join(bin, 'node_modules/@deepseek-ai'), { recursive: true })
    await symlink(dirname(anchor), join(bin, 'node_modules/@deepseek-ai/dsh'), process.platform === 'win32' ? 'junction' : 'dir')
    await copyFile(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'dsh.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0/node_modules/@deepseek-ai/dsh/lib/bin.js" %*\r\n')
    } else {
      await symlink(entry, join(bin, 'dsh'))
      await chmod(join(bin, 'node'), 0o755)
    }
    const cache = join(temp, 'npm-cache')
    const cachedScope = join(cache, '_npx/fixture/node_modules/@deepseek-ai')
    await mkdir(cachedScope, { recursive: true })
    await symlink(dirname(anchor), join(cachedScope, 'dsh'), process.platform === 'win32' ? 'junction' : 'dir')
    process.env.PATH = bin + delimiter + (process.env.PATH ?? '')
    process.env.npm_config_cache = cache
    process.env.DSH_HOME = join(temp, 'discovery-home')
    delete process.env.DSH_DESKTOP_DSH
    delete process.env.DSH_DESKTOP_SKIP_INSTALLED_DSH
    for (const source of ['installed', 'npx']) {
      const catalog = createRuntimeCatalog({
        environment: { nodeForChild: () => process.execPath, runtimeLauncher: () => launcher, resolveBundledDsh: () => undefined },
        clientHome: () => join(temp, 'client-home'), enabledSmartRuntimes: () => [source],
        bundledDshVersion: () => null, localeChinese: () => false,
      })
      await catalog.detectInstalledDsh()
      const selected = catalog.resolveDshCommand()
      assert.equal(selected.source, source)
      assert.ok(selected.entry, source + ' must carry an official entry')
      assert.deepEqual(selected.args, [launcher])
      assert.equal(selected.shell, false)
      const launchHome = join(temp, 'source-' + source)
      const launchEnv = { ...process.env, DSH_HOME: launchHome, DSH_DESKTOP_RUNTIME_ENTRY: selected.entry,
        DSH_DESKTOP_BUNDLED_MARKET: JSON.stringify({ ...request, home: launchHome }) }
      delete launchEnv.ELECTRON_RUN_AS_NODE
      const run = spawnSync(selected.command, [...selected.args, 'web', '--dump-default-config'], {
        env: launchEnv, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      assert.equal(run.status, 0, run.stderr + String(run.error ?? ''))
      assert.match(run.stdout, /bundled market prepared: client-owned/)
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key)
    Object.assign(process.env, savedEnv)
  }
  console.log('✓ PATH and npx discovery route official entries through the launcher on user Node and prepare the market')

  const cliHome = join(temp, 'launcher-home')
  const env = { ...process.env, DSH_HOME: cliHome, DSH_DESKTOP_RUNTIME_ENTRY: entry,
    DSH_DESKTOP_BUNDLED_MARKET: JSON.stringify({ ...request, home: cliHome }) }
  delete env.ELECTRON_RUN_AS_NODE
  const cli = spawnSync(process.execPath, [launcher, 'web', '--dump-default-config'], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  assert.equal(cli.status, 0, cli.stderr + String(cli.error ?? ''))
  assert.match(cli.stdout, /bundled market prepared: client-owned/)
  assert.ok(JSON.parse(await readFile(join(cliHome, 'profiles/web/package.json'))).dsh.profile.bundles.includes(name))
  const fixture = join(temp, 'env-fixture.mjs')
  await writeFile(fixture, 'export function runCli() { console.log("MARKET_ENV=" + String(process.env.DSH_DESKTOP_BUNDLED_MARKET)); }')
  const ordinaryHome = join(temp, 'ordinary')
  const ordinary = spawnSync(process.execPath, [launcher, 'plugin'], { env: { ...env,
    DSH_DESKTOP_RUNTIME_ENTRY: fixture,
    DSH_DESKTOP_BUNDLED_MARKET: JSON.stringify({ ...request, home: ordinaryHome }) }, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(ordinary.status, 0, ordinary.stderr)
  assert.match(ordinary.stdout, /MARKET_ENV=undefined/)
  assert.equal(existsSync(ordinaryHome), false)
  console.log('✓ actual launcher prepares before runCli; ordinary CLI calls clear the private request without applying it')
} finally {
  await rm(temp, { recursive: true, force: true })
}
