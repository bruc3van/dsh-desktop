/**
 * Packaged-pnpm contract: the bundled Electron binary can run the closure's
 * `pnpm.mjs` (`--version`), and can install a local tarball with `--offline`
 * (no network — CI-safe). Also installs an approved lifecycle-script fixture
 * through the real `dsh plugin` command with no developer tools on PATH.
 *
 * Usage: node scripts/check-pnpm-runtime.mjs [packaged-executable | --source]
 * --source uses the current build, deployed closure, and development Electron.
 * @module desktop/scripts/check-pnpm-runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RELEASE_DIR = join(APP_DIR, 'release')
const PRODUCT_NAME = 'DSH Desktop'
const FIXTURE_NAME = 'dsh-desktop-pnpm-fixture'

const runtimeManifest = JSON.parse(await readFile(join(APP_DIR, 'dsh-runtime', 'package.json'), 'utf8'))
const PINNED_PNPM = runtimeManifest.dependencies?.pnpm
if (typeof PINNED_PNPM !== 'string' || PINNED_PNPM === '') {
  throw new Error('dsh-runtime/package.json has no pinned pnpm dependency')
}

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function findExecutable() {
  const requested = process.argv.slice(2).find(argument => argument !== '--')
  if (requested !== undefined) return resolve(requested)

  const files = await walk(RELEASE_DIR)
  if (process.platform === 'darwin') {
    return files.find(path => path.endsWith('.app/Contents/MacOS/' + PRODUCT_NAME))
  }
  if (process.platform === 'win32') {
    return files.find(path => basename(path).toLowerCase() === PRODUCT_NAME.toLowerCase() + '.exe'
      && path.toLowerCase().includes('win-unpacked'))
  }
  return files.find(path => path.includes('linux-unpacked') && basename(path) === 'dsh-desktop')
}

function packagedResourcesDir(packagedExecutable) {
  if (process.platform === 'darwin') return join(dirname(packagedExecutable), '..', 'Resources')
  return join(dirname(packagedExecutable), 'resources')
}

const sourceMode = process.argv.includes('--source')
const executable = sourceMode ? createRequire(import.meta.url)('electron') : await findExecutable()
if (executable === undefined) throw new Error('packaged executable not found under ' + RELEASE_DIR)
if (!existsSync(executable)) throw new Error('packaged executable does not exist: ' + executable)

const resources = packagedResourcesDir(executable)
const launcher = join(sourceMode ? join(APP_DIR, '.build') : resources, 'runtime-launcher.mjs')
const gateway = join(sourceMode ? join(APP_DIR, '.build') : resources, 'dsh-cli.mjs')
const modules = sourceMode ? join(APP_DIR, '.runtime', 'node_modules') : join(resources, 'dsh-runtime', 'node_modules')
const pnpmEntry = join(modules, 'pnpm', 'bin', 'pnpm.mjs')
const dshEntry = join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(launcher)) throw new Error('packaged runtime-launcher.mjs missing: ' + launcher)
if (!existsSync(pnpmEntry)) throw new Error('packaged pnpm.mjs missing: ' + pnpmEntry)
const artifacts = join(modules, 'pnpm', 'artifacts')
if (existsSync(artifacts)) throw new Error('packaged pnpm artifacts/ was not pruned: ' + artifacts)

// Canonicalize before computing local-tarball approval keys (macOS /tmp and
// /private/tmp otherwise produce different relative paths in pnpm).
const workDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-desktop-pnpm-runtime-')))
const home = join(workDir, 'home')
await mkdir(home)
const runtimeEnv = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'WINDIR', 'PATHEXT', 'LANG']) {
  if (process.env[key] !== undefined) runtimeEnv[key] = process.env[key]
}
Object.assign(runtimeEnv, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'appdata'),
  LOCALAPPDATA: join(home, 'localappdata'),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_DATA_HOME: join(home, 'data'),
  TMPDIR: workDir,
  TEMP: workDir,
  TMP: workDir,
  PATH: process.platform === 'win32'
    ? join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32')
    : '/usr/bin:/bin',
  DSH_HOME: join(home, 'dsh'),
  ELECTRON_RUN_AS_NODE: '1',
  CI: 'true',
})

function runEntry(args, cwd, plugin = false) {
  return new Promise((resolveRun, rejectRun) => {
    const env = {
      ...runtimeEnv,
      DSH_DESKTOP_RUNTIME_ENTRY: plugin ? dshEntry : pnpmEntry,
      DSH_DESKTOP_PNPM_ENTRY: pnpmEntry,
    }
    const child = spawn(executable, [...plugin ? ['--expose-internals'] : [], plugin ? gateway : launcher, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill()
      rejectRun(new Error('pnpm ' + args[0] + ' did not exit within 60s\n' + stdout + stderr))
    }, 60_000)
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
  })
}
const runPnpm = (args, cwd) => runEntry(args, cwd)

try {
  const versionRun = await runPnpm(['--version'], workDir)
  const reported = (versionRun.stdout ?? '').trim()
  if (versionRun.code !== 0 || reported !== PINNED_PNPM) {
    throw new Error('packaged pnpm --version expected ' + PINNED_PNPM
      + ' (code=' + String(versionRun.code) + '): ' + JSON.stringify(reported) + '\n' + versionRun.stderr)
  }
  console.log('✓ packaged pnpm --version is the pinned ' + PINNED_PNPM)

  const fixtureDir = join(workDir, 'fixture')
  const projectDir = join(workDir, 'project')
  const storeDir = join(workDir, 'store')
  await mkdir(fixtureDir)
  await mkdir(projectDir)
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({
    name: FIXTURE_NAME,
    version: '0.0.0',
    private: true,
  }, null, 2) + '\n')
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-pnpm-probe',
    version: '0.0.0',
    private: true,
  }, null, 2) + '\n')

  // A relative `file:` spec, not pathToFileURL(fixtureDir).href: Node
  // percent-encodes `~` as %7E, and pnpm resolves the URL path literally, so a
  // work dir under an 8.3 short path (`C:\Users\RUNNER~1\...`, which is what
  // os.tmpdir() returns on the GitHub Windows runner) makes it look for a
  // directory named `RUNNER%7E1` and fail with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND.
  // The relative form resolves against --dir with no URL round-trip, and is the
  // shape a real lockfile carries for a local dependency anyway.
  const addRun = await runPnpm(
    [
      '--dir', projectDir,
      'add', 'file:../' + basename(fixtureDir),
      '--offline',
      '--store-dir', storeDir,
      '--ignore-scripts',
    ],
    projectDir,
  )
  if (addRun.code !== 0) {
    throw new Error('packaged pnpm add file:fixture --offline failed (code='
      + String(addRun.code) + ')\n' + addRun.stdout + addRun.stderr)
  }
  const installed = join(projectDir, 'node_modules', FIXTURE_NAME, 'package.json')
  if (!existsSync(installed)) {
    throw new Error('offline pnpm add did not materialize ' + installed + '\n' + addRun.stdout + addRun.stderr)
  }
  console.log('✓ packaged pnpm add file:<fixture> --offline installed ' + FIXTURE_NAME)

  // Inspect the shell environment BEFORE invoking any node shim: the shim
  // intentionally reattaches Node mode and would conceal which parent leaked it.
  const postinstall = process.platform === 'win32'
    ? 'if defined ELECTRON_RUN_AS_NODE (exit /b 42) else (echo built>built.txt)'
    : 'test -z "${ELECTRON_RUN_AS_NODE+x}" && printf built > built.txt'
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({
    name: FIXTURE_NAME,
    version: '0.0.0',
    scripts: { postinstall },
    dsh: { bundle: { patch: 'patch.yaml' } },
  }))
  await writeFile(join(fixtureDir, 'patch.yaml'), '[]\n')
  const pack = await runPnpm(['pack', '--pack-destination', workDir], fixtureDir)
  if (pack.code !== 0) throw new Error('fixture pack failed\n' + pack.stdout + pack.stderr)
  const tarball = join(workDir, FIXTURE_NAME + '-0.0.0.tgz')
  const profileDir = join(runtimeEnv.DSH_HOME, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }))
  const spec = 'file:' + relative(profileDir, tarball).replaceAll('\\', '/')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  '
    + JSON.stringify(FIXTURE_NAME + '@' + spec) + ': true\n')
  const pluginRun = await runEntry([
    'plugin', '--profile', 'web', 'add', spec, '--offline', '--store-dir', join(workDir, 'plugin-store'),
  ], profileDir, true)
  if (pluginRun.code !== 0) {
    throw new Error('dsh plugin lifecycle install failed (code=' + String(pluginRun.code) + ')\n'
      + pluginRun.stdout + pluginRun.stderr)
  }
  const built = await readFile(join(profileDir, 'node_modules', FIXTURE_NAME, 'built.txt'), 'utf8')
  if (built.trim() !== 'built') throw new Error('plugin lifecycle script did not produce its marker')
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  if (!profile.dsh.profile.bundles.includes(FIXTURE_NAME)) throw new Error('dsh did not register the installed bundle')
  console.log('✓ real dsh plugin add runs approved lifecycle scripts without ELECTRON_RUN_AS_NODE')
  console.log('✓ plugin bundle registered with only OS tools on PATH')
} finally {
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
