/**
 * Fail the build when Electron's embedded Node is older than the bundled
 * pnpm's `engines.node`.
 *
 * pnpm 11 hard-exits (not a warning) if `process.versions.node` is below its
 * floor — currently `>=22.13`, while Electron 39 ships 22.22, a 0.09-minor
 * margin. An Electron upgrade that slipped under that floor would turn every
 * `dsh plugin add` into a hard failure with no earlier signal. Unparseable
 * range forms also fail here: silently skipping them would hide the coupling.
 *
 * Usage: node scripts/check-pnpm-engine.mjs
 * @module desktop/scripts/check-pnpm-engine
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const PNPM_PACKAGE = join(APP_DIR, '.runtime', 'node_modules', 'pnpm', 'package.json')
if (!existsSync(PNPM_PACKAGE)) {
  throw new Error('run `pnpm run prepare:runtime` first: bundled pnpm is missing at ' + PNPM_PACKAGE)
}

const manifest = JSON.parse(await readFile(PNPM_PACKAGE, 'utf8'))
const range = manifest.engines?.node
if (typeof range !== 'string' || range.trim() === '') {
  throw new Error('bundled pnpm has no engines.node string to check (got ' + JSON.stringify(manifest.engines) + ')')
}

const minimum = parseMinimumNode(range)
if (minimum === undefined) {
  throw new Error('bundled pnpm engines.node is not a supported range form (got '
    + JSON.stringify(range) + '); extend parseMinimumNode or pin a pnpm whose range is `>=x.y` / `>=x.y.z`')
}

const electronExecutable = createRequire(import.meta.url)('electron')
const nodeVersion = await readElectronNodeVersion(electronExecutable)
const actual = parseNodeVersion(nodeVersion)
if (actual === undefined) {
  throw new Error('Electron did not report a parseable Node version: ' + JSON.stringify(nodeVersion))
}

if (!satisfiesMinimum(actual, minimum)) {
  throw new Error('Electron Node ' + nodeVersion + ' does not satisfy bundled pnpm engines.node '
    + JSON.stringify(range) + ' (minimum ' + formatVersion(minimum) + ')')
}

console.log('✓ Electron Node ' + nodeVersion + ' satisfies bundled pnpm engines.node ' + JSON.stringify(range))

/**
 * Only `>=x`, `>=x.y`, and `>=x.y.z` (optional spaces, optional leading `v`).
 * Anything else — `^`, `<`, `||`, hyphen ranges — is an explicit failure.
 */
function parseMinimumNode(value) {
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(value)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  }
}

function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function satisfiesMinimum(actual, minimum) {
  if (actual.major !== minimum.major) return actual.major > minimum.major
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor
  return actual.patch >= minimum.patch
}

function formatVersion(version) {
  return String(version.major) + '.' + String(version.minor) + '.' + String(version.patch)
}

function readElectronNodeVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-e', 'process.stdout.write(process.versions.node)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0 || stdout.trim() === '') {
        reject(new Error('Electron Node probe failed (code=' + String(code) + ')\n' + stdout + stderr))
        return
      }
      resolve(stdout.trim())
    })
  })
}
