/**
 * Assert a packaged macOS app carries the release code identity: signed by the
 * pinned certificate, with a designated requirement that names the app id and
 * that certificate rather than the bundle's own hash.
 *
 * This is the property macOS privacy grants hang on (see scripts/sign-mac.mjs).
 * An ad-hoc or wrongly signed bundle still launches, still passes
 * `codesign --verify`, and still installs — users would only notice when the
 * Documents prompt returned after updating.
 *
 * Usage: node scripts/check-mac-signature.mjs [path/to/DSH Desktop.app]
 * @module desktop/scripts/check-mac-signature
 */

import { execFile as execFileCallback } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PIN_FILE, readPinnedFingerprint } from './sign-mac.mjs'

const execFile = promisify(execFileCallback)
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const APP_ID = 'io.github.bruc3van.dsh-desktop'
const BUNDLE = 'DSH Desktop.app'

if (process.platform !== 'darwin') {
  console.error('check-mac-signature is macOS-only')
  process.exit(1)
}

/** electron-builder writes release/mac-arm64 or release/mac (x64). */
function findApp() {
  const requested = process.argv.slice(2).find(arg => arg !== '--')
  if (requested !== undefined) return resolve(requested)
  const release = join(APP_DIR, 'release')
  const candidates = existsSync(release)
    ? readdirSync(release).filter(name => /^mac(-|$)/.test(name)).map(name => join(release, name, BUNDLE)).filter(existsSync)
    : []
  if (candidates.length !== 1) {
    throw new Error('expected one packaged app under release/mac*/, found ' + candidates.length + '; pass its path explicitly')
  }
  return candidates[0]
}

async function designatedRequirement(path) {
  const { stdout, stderr } = await execFile('/usr/bin/codesign', ['-d', '-r-', path])
  // Ad-hoc bundles print an implicit requirement as `# designated => cdhash …`.
  const match = /^(?:# )?designated => (.*)$/m.exec(stdout + stderr)
  if (match === null) throw new Error('no designated requirement for ' + path)
  return match[1]
}

const pinned = readPinnedFingerprint()
if (pinned === undefined) {
  console.log('✗ no pinned certificate at ' + PIN_FILE)
  process.exit(1)
}

const app = findApp()
const failures = []
// Integrity first: a requirement read off a broken seal proves nothing.
try {
  await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
} catch (error) {
  failures.push('codesign --verify --deep --strict failed: ' + String(error.stderr || error.message).trim())
}

const leaf = 'certificate leaf = H"' + pinned + '"'
const main = await designatedRequirement(app)
if (main !== 'identifier "' + APP_ID + '" and ' + leaf) failures.push('main app requirement is ' + main)

// TCC attributes file access to the main app, but every helper is signed in
// the same pass; one left ad-hoc means the pass did not do what it claims.
const frameworks = join(app, 'Contents', 'Frameworks')
for (const name of readdirSync(frameworks).filter(entry => entry.endsWith('.app') || entry.endsWith('.framework'))) {
  const requirement = await designatedRequirement(join(frameworks, name))
  if (!requirement.includes(leaf)) failures.push(name + ' requirement is ' + requirement)
}

if (failures.length > 0) {
  for (const failure of failures) console.log('✗ ' + failure)
  console.log('The app is not signed with the pinned certificate; macOS would forget folder permissions on update.')
  process.exit(1)
}
console.log('✓ ' + app + ' is signed by the pinned certificate ' + pinned)
console.log('  designated => ' + main)
