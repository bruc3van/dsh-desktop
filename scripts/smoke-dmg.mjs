/**
 * Installed-DMG smoke: mount the release DMG, take the .app out of the volume
 * the way a user dragging it to /Applications would, unmount, and run the
 * package smoke against that copy.
 *
 * Windows already has this gate — release.yml installs the NSIS package
 * silently and smokes the installed exe. macOS had nothing equivalent:
 * `smoke:package` runs against the unpacked `.app` directory electron-builder
 * leaves under `release/`, so the DMG itself was never mounted, copied out, or
 * started. A DMG that mounts to nothing, carries a broken bundle, or
 * loses the ad-hoc signature on the way in would have shipped unnoticed.
 *
 * Usage: node scripts/smoke-dmg.mjs [path/to.dmg]
 * @module desktop/scripts/smoke-dmg
 */

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RELEASE_DIR = join(APP_DIR, 'release')
const PRODUCT_NAME = 'DSH Desktop'

if (process.platform !== 'darwin') {
  console.error('smoke-dmg is macOS-only: a DMG can only be mounted where hdiutil exists')
  process.exit(1)
}

/**
 * The DMG to smoke. `pnpm run <script> -- <path>` forwards the separator
 * itself, so a literal `--` must not be taken for the requested file (the same
 * trap smoke-package.mjs documents).
 */
async function findDmg() {
  const requested = process.argv.slice(2).find(argument => argument !== '--')
  if (requested !== undefined) return resolve(requested)
  const entries = existsSync(RELEASE_DIR) ? await readdir(RELEASE_DIR) : []
  const found = entries.filter(name => name.endsWith('.dmg')).sort()
  if (found.length === 0) throw new Error('no .dmg found under ' + RELEASE_DIR)
  if (found.length > 1) throw new Error('several DMGs under ' + RELEASE_DIR + '; name one: ' + found.join(', '))
  return join(RELEASE_DIR, found[0])
}

const dmg = await findDmg()
if (!existsSync(dmg)) throw new Error('DMG does not exist: ' + dmg)
console.log('smoking ' + dmg)

const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-dmg-'))
// Mounting under a mount point we name is what keeps this parseable: the
// default picks a name from the volume title and reports it in a plist, and
// a title that gains a version number would break the parsing rather than the
// product. Detaching then needs no lookup either.
const mountPoint = join(work, 'volume')
const staged = join(work, 'staged')

/** Unmount, tolerating the moment right after a copy when the volume is busy. */
async function detach() {
  for (const args of [[mountPoint], ['-force', mountPoint]]) {
    try {
      await execFile('hdiutil', ['detach', ...args])
      return
    } catch (error) {
      console.warn('[smoke-dmg] detach failed (' + args.join(' ') + '): ' + error.message)
      await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
    }
  }
  throw new Error('could not unmount ' + mountPoint)
}

/** Everything that has to happen while the volume is mounted. */
async function takeAppOutOfVolume() {
  const entries = await readdir(mountPoint)
  const bundle = entries.find(name => name.endsWith('.app'))
  if (bundle === undefined) throw new Error('the DMG carries no .app: ' + entries.join(', '))
  // The drag target. Without it the volume opens onto an app with nowhere to
  // drop it, and the documented install gesture does not exist.
  if (!entries.includes('Applications')) {
    throw new Error('the DMG has no Applications link to drag onto: ' + entries.join(', '))
  }
  // ditto, not cp: it preserves the symlinks, permissions, and extended
  // attributes an .app bundle is made of. A plain recursive copy strips the
  // attributes the ad-hoc signature lives in, and the copy would then fail to
  // launch for reasons the DMG is not guilty of.
  await execFile('ditto', [join(mountPoint, bundle), join(staged, bundle)])
  const copied = join(staged, bundle, 'Contents', 'MacOS', PRODUCT_NAME)
  if (!existsSync(copied)) throw new Error('copied bundle has no executable: ' + copied)
  // What Gatekeeper checks first. A signature that did not survive the round
  // trip is exactly the "app is damaged" state electron-builder.yml's ad-hoc
  // identity exists to avoid, and it is invisible in the unpacked directory.
  await execFile('codesign', ['--verify', '--strict', join(staged, bundle)])
  console.log('✓ mounted, copied out, and the bundle still verifies: ' + bundle)
  return copied
}

try {
  await execFile('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint])
  // Unmount always, but never let a detach failure replace the reason the copy
  // failed: the mount is the cleanup, the copy is the finding.
  let executable
  let failure
  try {
    executable = await takeAppOutOfVolume()
  } catch (error) {
    failure = error
  }
  try {
    await detach()
  } catch (error) {
    if (failure === undefined) failure = error
    else console.warn('[smoke-dmg] and the volume would not unmount either: ' + error.message)
  }
  if (failure !== undefined) throw failure

  // The same smoke the unpacked directory gets, now against the copy that came
  // out of the volume: empty PATH, bundled runtime, login-shell PATH restore,
  // and the shims.
  const smoke = spawn(process.execPath, [join(APP_DIR, 'scripts', 'smoke-package.mjs'), executable], {
    stdio: 'inherit',
  })
  const code = await new Promise((resolveCode, rejectCode) => {
    smoke.once('error', rejectCode)
    smoke.once('exit', resolveCode)
  })
  if (code !== 0) throw new Error('package smoke failed on the DMG copy with code ' + String(code))
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {})
}

console.log('\n✓ DMG install smoke passed.')
