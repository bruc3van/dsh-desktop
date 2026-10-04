/**
 * electron-builder `mac.sign` hook: sign every macOS build with the project's
 * one long-lived self-signed certificate, so each release carries the same
 * code identity.
 *
 * macOS privacy grants (Documents, Desktop, Downloads, Full Disk Access) are
 * stored against the app's designated requirement. An ad-hoc signature can
 * only describe itself by its own hash (`cdhash H"…"`), which every rebuild
 * changes, so each update arrived as a stranger and the Documents prompt came
 * back. A certificate signature yields
 * `identifier "<appId>" and certificate leaf = H"<sha1>"` instead, which is
 * the same for every release signed with the same certificate.
 *
 * The certificate is self-signed, not a Developer ID: Gatekeeper still shows
 * its "unidentified developer" prompt on first open, exactly as with ad-hoc.
 * It is also untrusted, so electron-builder's own identity lookup
 * (`security find-identity -v`) never sees it. This hook therefore imports it
 * into a throwaway keychain and hands its SHA-1 straight to @electron/osx-sign,
 * keeping osx-sign's inside-out signing of helpers and frameworks.
 *
 * Inputs (environment):
 *   DSH_MAC_SIGN_P12_BASE64    base64 of the .p12 (certificate + private key)
 *   DSH_MAC_SIGN_P12_PASSWORD  its export password
 *   DSH_MAC_SIGN_REQUIRED=1    fail instead of falling back to ad-hoc
 *
 * Without a certificate, local builds stay ad-hoc as before. The release
 * workflow sets DSH_MAC_SIGN_REQUIRED, because one ad-hoc release would reset
 * every user's grants twice: once on the way to it and once on the way back.
 *
 * The certificate's SHA-1 is pinned in scripts/mac-signing-cert.sha1. A
 * different certificate is refused rather than shipped: rotating it silently
 * would bring the prompt back for every existing user.
 *
 * Create the certificate once with scripts/create-mac-signing-cert.mjs.
 * @module desktop/scripts/sign-mac
 */

import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
export const PIN_FILE = fileURLToPath(new URL('mac-signing-cert.sha1', import.meta.url))

/** The pinned certificate SHA-1 (lowercase hex), or undefined before one exists. */
export function readPinnedFingerprint() {
  if (!existsSync(PIN_FILE)) return undefined
  const value = readFileSync(PIN_FILE, 'utf8').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(PIN_FILE + ' does not hold a SHA-1 fingerprint: ' + JSON.stringify(value))
  return value
}

/**
 * The osx-sign copy electron-builder itself uses. It is not a direct
 * dependency, and pnpm only exposes it from app-builder-lib's own directory.
 */
async function loadOsxSign() {
  const requireFromHere = createRequire(import.meta.url)
  const electronBuilder = requireFromHere.resolve('electron-builder/package.json')
  const appBuilderLib = createRequire(electronBuilder).resolve('app-builder-lib/package.json')
  const entry = createRequire(join(dirname(appBuilderLib), 'package.json')).resolve('@electron/osx-sign')
  return import(entry)
}

/** `security`, with its own output in the error rather than a bare exit code. */
async function security(args) {
  try {
    return (await execFile('/usr/bin/security', args)).stdout
  } catch (error) {
    throw new Error('security ' + args[0] + ' failed: ' + String(error.stderr || error.message).trim())
  }
}

/**
 * The one code-signing identity in the keychain. `find-identity` without `-v`
 * on purpose: a self-signed certificate is listed as CSSMERR_TP_NOT_TRUSTED,
 * which codesign does not care about.
 */
async function findSigningIdentity(keychain) {
  const output = await security(['find-identity', '-p', 'codesigning', keychain])
  const found = [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]*)"/gm)]
  const unique = [...new Map(found.map(match => [match[1], match[2]])).entries()]
  if (unique.length !== 1) {
    throw new Error('expected exactly one code-signing identity in the .p12, found ' + unique.length + ':\n' + output.trim())
  }
  const [hash, name] = unique[0]
  return { hash: hash.toLowerCase(), name }
}

/** The user keychain search list, as `security list-keychains` prints it. */
async function userKeychains() {
  const output = await security(['list-keychains', '-d', 'user'])
  return [...output.matchAll(/"([^"]+)"/g)].map(match => match[1])
}

/** Import the certificate into a private keychain, sign, then delete the keychain. */
async function signWithCertificate(signAsync, opts, p12Base64) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mac-sign-'))
  const keychain = join(dir, 'signing.keychain-db')
  const keychainPassword = randomBytes(24).toString('hex')
  const p12 = join(dir, 'signing.p12')
  const searchList = await userKeychains()
  try {
    await writeFile(p12, Buffer.from(p12Base64, 'base64'), { mode: 0o600 })
    await security(['create-keychain', '-p', keychainPassword, keychain])
    // No arguments: never auto-lock, so a long build cannot outlive the unlock.
    await security(['set-keychain-settings', keychain])
    await security(['unlock-keychain', '-p', keychainPassword, keychain])
    await security(['import', p12, '-k', keychain, '-P', process.env.DSH_MAC_SIGN_P12_PASSWORD ?? '', '-T', '/usr/bin/codesign'])
    // Lets codesign use the key without a keychain-access dialog no CI can click.
    await security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain])
    await rm(p12, { force: true })
    // `--keychain` picks the certificate, but on GitHub's macOS runners
    // codesign still resolves the private key through the search list and
    // fails with "The specified item could not be found in the keychain"
    // unless the keychain is on it. Restored in `finally`.
    await security(['list-keychains', '-d', 'user', '-s', keychain, ...searchList])

    const identity = await findSigningIdentity(keychain)
    const pinned = readPinnedFingerprint()
    if (pinned === undefined) {
      throw new Error('no pinned certificate at ' + PIN_FILE + '; commit the SHA-1 printed by scripts/create-mac-signing-cert.mjs')
    }
    if (identity.hash !== pinned) {
      throw new Error('the provided certificate ' + identity.hash + ' (' + identity.name + ') is not the pinned ' + pinned
        + '. Shipping it would make macOS forget every user\'s folder permissions; restore the pinned certificate, '
        + 'or update ' + PIN_FILE + ' only if rotating it is intended.')
    }
    console.log('  • signing with pinned certificate  name=' + JSON.stringify(identity.name) + ' sha1=' + identity.hash)
    await signAsync({ ...opts, identity: identity.hash, keychain, identityValidation: false })
  } finally {
    await security(['list-keychains', '-d', 'user', '-s', ...searchList]).catch(() => {})
    await security(['delete-keychain', keychain]).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/** @param {import('@electron/osx-sign').SignOptions} opts */
export default async function signMac(opts) {
  const { signAsync } = await loadOsxSign()
  const p12Base64 = process.env.DSH_MAC_SIGN_P12_BASE64?.trim()
  if (p12Base64) return signWithCertificate(signAsync, opts, p12Base64)
  if (process.env.DSH_MAC_SIGN_REQUIRED === '1') {
    throw new Error('DSH_MAC_SIGN_REQUIRED=1 but DSH_MAC_SIGN_P12_BASE64 is empty; refusing to ship an ad-hoc signed release')
  }
  console.log('  • no DSH_MAC_SIGN_P12_BASE64; signing ad-hoc (privacy grants will not survive updates of this build)')
  return signAsync({ ...opts, identity: '-', identityValidation: false })
}
