/**
 * Packaged-pnpm contract: the bundled Electron binary can run the closure's
 * `pnpm.mjs` (`--version`), and can install a local tarball with `--offline`
 * (no network — CI-safe).
 *
 * Usage: node scripts/check-pnpm-runtime.mjs [packaged-executable]
 * @module desktop/scripts/check-pnpm-runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

const executable = await findExecutable()
if (executable === undefined) throw new Error('packaged executable not found under ' + RELEASE_DIR)
if (!existsSync(executable)) throw new Error('packaged executable does not exist: ' + executable)

const resources = packagedResourcesDir(executable)
const launcher = join(resources, 'runtime-launcher.mjs')
const pnpmEntry = join(resources, 'dsh-runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
if (!existsSync(launcher)) throw new Error('packaged runtime-launcher.mjs missing: ' + launcher)
if (!existsSync(pnpmEntry)) throw new Error('packaged pnpm.mjs missing: ' + pnpmEntry)
const artifacts = join(resources, 'dsh-runtime', 'node_modules', 'pnpm', 'artifacts')
if (existsSync(artifacts)) throw new Error('packaged pnpm artifacts/ was not pruned: ' + artifacts)

const workDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-pnpm-runtime-'))

function runPnpm(args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_RUNTIME_ENTRY: pnpmEntry }
    const child = spawn(executable, [launcher, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
} finally {
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
