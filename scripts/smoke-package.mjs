/**
 * Release-package smoke: launch the unpacked application with an empty PATH,
 * require it to select the bundled official dsh CLI, and probe the resulting
 * Web UI. This catches installers that work only on a developer machine.
 * Usage: node scripts/smoke-package.mjs [packaged-executable]
 * @module desktop/scripts/smoke-package
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RELEASE_DIR = join(APP_DIR, 'release')
const PRODUCT_NAME = 'DeepSeek Harness Desktop'
// A freshly installed Windows build starts cold: thousands of bundled runtime
// files are still being scanned on first touch, so its first launch is far
// slower than the already-warm unpacked directory this also runs against.
const READY_TIMEOUT_MS = Number(process.env.DSH_SMOKE_TIMEOUT_MS) || (process.platform === 'win32' ? 180_000 : 60_000)

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
  // `pnpm run <script> -- <path>` forwards the separator itself as an argument,
  // so a literal `--` must not be mistaken for the requested executable: that
  // resolved to a non-existent path and the run failed as an opaque readiness
  // timeout instead of naming the real problem.
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

const executable = await findExecutable()
if (executable === undefined) throw new Error('packaged executable not found under ' + RELEASE_DIR)
// Fail on the path itself rather than 60 seconds later on a silent spawn.
if (!existsSync(executable)) throw new Error('packaged executable does not exist: ' + executable)

/**
 * electron-builder.yml's electronLanguages keeps only zh and en. Two spellings
 * are required per platform (zh-CN.pak on Windows, zh_CN.lproj on macOS)
 * because the matcher is a reverse-prefix check: one spelling alone silently
 * deletes the other platform's Chinese pack. This assertion turns that silent
 * deletion into a red build on both release matrix legs. Linux is not covered:
 * the release matrix ships no Linux artifact (revisit if one is added).
 */
async function assertLocalePacks(packagedExecutable) {
  if (process.platform === 'win32') {
    const dir = join(dirname(packagedExecutable), 'locales')
    const packs = (await readdir(dir)).filter(name => name.endsWith('.pak')).sort()
    const expected = ['en-US.pak', 'zh-CN.pak']
    if (JSON.stringify(packs) !== JSON.stringify(expected)) {
      throw new Error('unexpected Windows locale packs in ' + dir + ': ' + packs.join(', '))
    }
    return
  }
  if (process.platform === 'darwin') {
    // executable = <app>/Contents/MacOS/DeepSeek Harness Desktop
    const contents = join(dirname(packagedExecutable), '..')
    const resources = join(contents, 'Resources')
    // electron-builder keeps the .lproj shells for the wanted languages here;
    // every other shell is removed (they only declare CFBundleLocalizations).
    const shells = (await readdir(resources)).filter(name => name.endsWith('.lproj')).sort()
    if (JSON.stringify(shells) !== JSON.stringify(['en.lproj', 'zh_CN.lproj'])) {
      throw new Error('unexpected .lproj shells in ' + resources + ': ' + shells.join(', '))
    }
    const framework = join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    const packs = (await readdir(framework)).filter(name => name.endsWith('.lproj')).sort()
    const expected = ['en.lproj', 'zh_CN.lproj']
    if (JSON.stringify(packs) !== JSON.stringify(expected)) {
      throw new Error('unexpected macOS .lproj packs in ' + framework + ': ' + packs.join(', '))
    }
    return
  }
}

/**
 * The dsh shim's gateway lives beside runtime-launcher.mjs, outside app.asar,
 * because the Agent child reads it as an ordinary file. A pack that omitted it
 * would leave the shim pointing at a missing path — `dsh --version` would fail
 * as a missing file rather than as the classified CLI.
 */
function packagedResourcesDir(packagedExecutable) {
  if (process.platform === 'darwin') return join(dirname(packagedExecutable), '..', 'Resources')
  return join(dirname(packagedExecutable), 'resources')
}

function assertPackagedGateway(packagedExecutable) {
  const resources = packagedResourcesDir(packagedExecutable)
  const cli = join(resources, 'dsh-cli.mjs')
  if (!existsSync(cli)) throw new Error('packaged resources missing dsh-cli.mjs: ' + cli)
}

function assertPackagedPnpm(packagedExecutable) {
  const resources = packagedResourcesDir(packagedExecutable)
  const pnpm = join(resources, 'dsh-runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  if (!existsSync(pnpm)) throw new Error('packaged resources missing pnpm/bin/pnpm.mjs: ' + pnpm)
  const artifacts = join(resources, 'dsh-runtime', 'node_modules', 'pnpm', 'artifacts')
  if (existsSync(artifacts)) throw new Error('packaged pnpm artifacts/ was not pruned: ' + artifacts)
}

await assertLocalePacks(executable)
assertPackagedGateway(executable)
assertPackagedPnpm(executable)

const smokeHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-package-smoke-'))
const emptyPath = join(smokeHome, 'empty-path')
// Spreading process.env drops the case-insensitivity Windows env vars have:
// the system spells the search path `Path`, so a literal `PATH` override would
// leave the inherited `Path` in the object and libuv's case-insensitive
// deduplication could keep either one. Strip every casing first, so this smoke
// really runs with no system PATH on all platforms. `ELECTRON_RUN_AS_NODE`
// (Codex and some CI wrappers set it) is uppercase everywhere, but goes
// through the same filter for consistency. `DSH_DESKTOP_SKIP_LOGIN_PATH` goes
// too: an inherited opt-out would suppress the very restore this smoke asserts.
const childEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  const upper = key.toUpperCase()
  // Inherited DSH_DESKTOP_* (especially DSH_DESKTOP_DSH) would be honoured
  // under ALLOW_UNSAFE below and steal the run away from the artifact.
  if (upper === 'PATH' || upper === 'ELECTRON_RUN_AS_NODE' || upper.startsWith('DSH_DESKTOP_')) continue
  childEnv[key] = value
}
// This is the one caller that runs a PACKAGED build, where every DSH_* override
// is ignored by design — the whole point of that gate is that a stray variable
// cannot move a real user's data home or skip their probe. The sandboxed homes
// below are what keeps this smoke off the developer's own ~/.dsh, so it opens
// the documented escape hatch deliberately rather than writing to the real one.
// The trade: this run does not exercise the packaged default of ignoring them.
const child = spawn(executable, ['--user-data-dir=' + join(smokeHome, 'chromium')], {
  env: {
    ...childEnv,
    DSH_DESKTOP_ALLOW_UNSAFE: '1',
    DSH_HOME: join(smokeHome, 'dsh'),
    DSH_DESKTOP_HOME: join(smokeHome, 'desktop'),
    DSH_DESKTOP_SKIP_PROBE: '1',
    // Empty PATH is not enough to isolate the artifact on macOS: packaged
    // builds restore the login shell's PATH on purpose (so an Agent launched
    // from Finder finds the user's tools), and that restore hands the runtime
    // resolver the developer's own npx-cached dsh — which it then prefers over
    // the bundled one, failing the assertion below on any machine that has run
    // `npx @deepseek-ai/dsh`. Force the artifact's bundled runtime, as audit
    // does — this smoke asserts the RELEASE's runtime, not whichever dsh the
    // person building it happens to have.
    DSH_DESKTOP_SKIP_INSTALLED_DSH: '1',
    PATH: emptyPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
let settled = false
const append = chunk => {
  output += chunk.toString()
  if (output.length > 100_000) output = output.slice(-100_000)
}
const readiness = new Promise((resolveReady, rejectReady) => {
  const finishError = error => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    rejectReady(error)
  }
  const timeout = setTimeout(
    () => finishError(new Error('timed out waiting for packaged dsh web after ' + READY_TIMEOUT_MS + 'ms')),
    READY_TIMEOUT_MS,
  )
  const inspect = chunk => {
    append(chunk)
    const match = /\[desktop\] dsh runtime ready:\s+(http:\/\/\S+)/.exec(output)
    if (match === null || settled) return
    settled = true
    clearTimeout(timeout)
    resolveReady(match[1])
  }
  child.stdout.on('data', inspect)
  child.stderr.on('data', inspect)
  // Without this listener a spawn failure is an unhandled 'error' event, which
  // never settles the readiness promise through the normal path.
  child.once('error', error => {
    finishError(new Error('failed to spawn ' + executable + ': ' + error.message))
  })
  child.once('exit', code => {
    finishError(new Error('packaged app exited before readiness (code=' + String(code) + ')'))
  })
})

try {
  const url = await readiness
  if (!output.includes('[desktop] dsh runtime: bundled')) {
    throw new Error('packaged app did not select the bundled dsh runtime')
  }
  if (process.platform === 'darwin' && !output.includes('[desktop] restored PATH from the macOS login shell')) {
    throw new Error('packaged macOS app did not restore its login-shell PATH')
  }
  // This run has no system PATH at all, so the shims are the only `node` /
  // `dsh` / `pnpm` the Agent could find — exactly the position an end user
  // who never installed those tools is in. Assert they exist and actually run.
  const shimMatch = /\[desktop\] runtime shims ready:\s+(.+)/.exec(output)
  if (shimMatch === null) throw new Error('packaged app did not publish runtime shims')
  const shimDir = shimMatch[1].trim()
  const shimName = (name) => process.platform === 'win32' ? name + '.cmd' : name
  const runShim = (name, args) => spawnSync(join(shimDir, shimName(name)), args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 30_000,
  })
  const nodeShim = join(shimDir, shimName('node'))
  const shimRun = runShim('node', ['--version'])
  if (!/^v\d+\./.test((shimRun.stdout ?? '').trim())) {
    throw new Error('bundled node shim did not report a version: ' + JSON.stringify(shimRun.stdout ?? shimRun.error?.message))
  }
  const dshShim = join(shimDir, shimName('dsh'))
  if (!existsSync(dshShim)) throw new Error('packaged app did not publish a dsh shim: ' + dshShim)
  const dshRun = runShim('dsh', ['--version'])
  if (dshRun.status !== 0 || !/\d+\.\d+/.test((dshRun.stdout ?? '') + (dshRun.stderr ?? ''))) {
    throw new Error('bundled dsh shim did not report a version: '
      + JSON.stringify({ status: dshRun.status, stdout: dshRun.stdout, stderr: dshRun.stderr, error: dshRun.error?.message }))
  }
  const pnpmShim = join(shimDir, shimName('pnpm'))
  if (!existsSync(pnpmShim)) throw new Error('packaged app did not publish a pnpm shim: ' + pnpmShim)
  const pnpmRun = runShim('pnpm', ['--version'])
  if (pnpmRun.status !== 0 || !/\d+\.\d+/.test((pnpmRun.stdout ?? '').trim())) {
    throw new Error('bundled pnpm shim did not report a version: '
      + JSON.stringify({ status: pnpmRun.status, stdout: pnpmRun.stdout, stderr: pnpmRun.stderr, error: pnpmRun.error?.message }))
  }
  // Same contract as `pnpm run check:runtime-env`, but on the Electron Node a
  // release actually runs: only there is "spawn my own executable and get
  // Node" — the native picker's and the sandbox runner's code path — real.
  const contract = spawnSync(process.execPath, [join(APP_DIR, 'scripts', 'check-runtime-env.mjs'), executable], { encoding: 'utf8' })
  if (contract.status !== 0) {
    throw new Error('packaged runtime environment contract failed:\n' + (contract.stdout ?? '') + (contract.stderr ?? ''))
  }
  const response = await fetch(url + '/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'package-smoke', method: 'host.describe', payload: {} }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  if (!response.ok || body?.result?.ok !== true) throw new Error('packaged Web UI probe failed')
  console.log('✓ packaged app selected its bundled @deepseek-ai/dsh runtime')
  if (process.platform === 'darwin') console.log('✓ packaged app restored the macOS login-shell PATH')
  console.log('✓ packaged resources include dsh-cli.mjs')
  console.log('✓ packaged pnpm.mjs is present and artifacts/ was pruned')
  console.log('✓ bundled node shim runs with no system PATH: ' + nodeShim)
  console.log('✓ bundled dsh shim reports a version')
  console.log('✓ bundled pnpm shim reports a version')
  console.log('✓ packaged runtime keeps ELECTRON_RUN_AS_NODE out of the Agent environment')
  console.log('✓ packaged Web UI answered host.describe at ' + url)
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (child.exitCode === null) child.kill()
  if (child.exitCode === null) {
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
    ])
  }
  if (child.exitCode === null) child.kill('SIGKILL')
  // Chromium utility processes can release Cookies-journal a fraction after
  // the main Electron process exits on Windows. Node's recursive rm retry
  // handles that transient EBUSY without weakening any runtime assertion.
  await rm(smokeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
