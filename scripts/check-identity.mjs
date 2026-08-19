/**
 * Client identity fingerprint: the handful of fields that say this checkout is
 * still dsh-desktop and not something a stray write replaced. This
 * repository's package.json was once overwritten with Electron's default_app
 * manifest (name=electron, productName=Electron, main=main.js) — a packaging
 * tool pointed at the wrong directory is enough — which silently hands the
 * whole toolchain to the Electron default app: the build succeeds, the
 * installer ships, and the product is gone.
 *
 * This lives outside audit.mjs so the release workflow can afford to run it.
 * The audit is a full Playwright walk of the booted UI (minutes, and it needs
 * a display); this is two file reads, so it belongs in the validate job,
 * before anything is built.
 * Usage: node scripts/check-identity.mjs
 * @module desktop/scripts/check-identity
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * The version is matched by shape, not by value: the release workflow writes
 * the tag into package.json at build time, so any semver-looking string is the
 * client's own — what this rejects is `undefined` and Electron's own version
 * string arriving with the rest of the default_app manifest.
 */
const EXPECTED = {
  name: 'dsh-desktop',
  main: '.build/main.mjs',
  appId: 'io.github.bruc3van.dsh-desktop',
  productName: 'DSH Desktop',
}

/**
 * Reading is part of the check. A package.json that no longer parses is the
 * same accident as one that parses into the wrong product, so it reports as an
 * identity mismatch with the same remedy rather than as a bare JSON error from
 * somewhere up the stack.
 * @returns {{ failures: string[], version: string | undefined }}
 */
export function checkClientIdentity() {
  const failures = []
  const describe = error => (error instanceof Error ? error.message : String(error))

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'))
  } catch (error) {
    return { failures: ['package.json is unreadable: ' + describe(error)], version: undefined }
  }
  let builderYml
  try {
    builderYml = readFileSync(join(APP_DIR, 'electron-builder.yml'), 'utf8')
  } catch (error) {
    return { failures: ['electron-builder.yml is unreadable: ' + describe(error)], version: manifest.version }
  }

  // Quoted and unquoted scalars both occur in hand-edited YAML; the value ends
  // at a closing quote, a trailing comment, or the line.
  const ymlField = key => builderYml
    .match(new RegExp('^' + key + ":\\s*['\"]?([^'\"#\\n]+)", 'm'))?.[1]?.trim()
  const check = (name, actual, ok) => { if (!ok) failures.push(name + ': ' + String(actual)) }

  check('package.json name', manifest.name, manifest.name === EXPECTED.name)
  check('package.json main', manifest.main, manifest.main === EXPECTED.main)
  check('package.json version', manifest.version,
    typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version))
  check('electron-builder.yml appId', ymlField('appId'), ymlField('appId') === EXPECTED.appId)
  check('electron-builder.yml productName', ymlField('productName'), ymlField('productName') === EXPECTED.productName)

  return { failures, version: manifest.version }
}

/**
 * Reports the fingerprint and exits non-zero on a mismatch. Callers that have
 * their own reporting (the audit prints it as its first check) use
 * `checkClientIdentity` directly.
 */
export function assertClientIdentity() {
  const { failures, version } = checkClientIdentity()
  if (failures.length > 0) {
    for (const failure of failures) console.log('✗ identity: ' + failure)
    console.log('Client identity fingerprint mismatch — a stray write may have replaced the manifest '
      + '(Electron default_app?); restore from git before building.')
    process.exit(1)
  }
  console.log('✓ identity: ' + EXPECTED.name + ' ' + String(version) + ' / ' + EXPECTED.productName)
}

// Only when run as the script, so importing it costs nothing. pathToFileURL,
// not a string concat: a Windows argv[1] is `C:\...`, which does not survive
// being pasted after `file://`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertClientIdentity()
}
