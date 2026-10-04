/**
 * Create the project's long-lived self-signed macOS code-signing certificate.
 * Run once; every future release must be signed with the result (see
 * scripts/sign-mac.mjs for why the identity has to stay the same).
 *
 * Writes into the output directory (default ~/.dsh-desktop-signing, mode 700):
 *   dsh-desktop-mac-signing.p12   certificate + private key; back it up
 *   p12-password.txt              its export password
 *   certificate.pem               public certificate, for reference
 * and pins the certificate's SHA-1 in scripts/mac-signing-cert.sha1.
 *
 * The private key never exists outside the .p12. Losing the .p12 means the
 * next release needs a new certificate, and every user is asked for folder
 * access once more.
 *
 * Uses /usr/bin/openssl (LibreSSL) on purpose: OpenSSL 3 writes .p12 files
 * with AES/PBKDF2, which macOS `security import` rejects without -legacy.
 *
 * Usage: node scripts/create-mac-signing-cert.mjs [--out <dir>]
 * @module desktop/scripts/create-mac-signing-cert
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PIN_FILE, readPinnedFingerprint } from './sign-mac.mjs'

const OPENSSL = '/usr/bin/openssl'
const COMMON_NAME = 'DSH Desktop Code Signing (bruc3van)'
// codesign refuses an expired identity, so the certificate has to outlive the
// project. Nothing checks the dates after signing: neither TCC nor
// `codesign --verify` evaluates trust for a self-signed leaf.
const VALID_DAYS = 365 * 30

const outIndex = process.argv.indexOf('--out')
const outDir = resolve(outIndex === -1 ? join(homedir(), '.dsh-desktop-signing') : process.argv[outIndex + 1])
const p12Path = join(outDir, 'dsh-desktop-mac-signing.p12')

if (!existsSync(OPENSSL)) throw new Error(OPENSSL + ' not found; run this on macOS')
if (existsSync(p12Path)) {
  console.error(p12Path + ' already exists. Refusing to replace the release signing identity.')
  process.exit(1)
}
const previous = readPinnedFingerprint()
if (previous !== undefined) {
  console.error(PIN_FILE + ' already pins ' + previous + '. A new certificate resets every user\'s folder permissions;\n'
    + 'delete the pin file first only if rotating the certificate is intended.')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true, mode: 0o700 })
chmodSync(outDir, 0o700)
const work = mkdtempSync(join(tmpdir(), 'dsh-mac-cert-'))
try {
  const config = join(work, 'cert.cnf')
  writeFileSync(config, [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = ext',
    '[dn]',
    'CN = ' + COMMON_NAME,
    '[ext]',
    'basicConstraints = critical, CA:false',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = critical, codeSigning',
    'subjectKeyIdentifier = hash',
    '',
  ].join('\n'))
  const key = join(work, 'key.pem')
  const certificate = join(outDir, 'certificate.pem')
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', String(VALID_DAYS), '-nodes',
    '-keyout', key, '-out', certificate, '-config', config], { stdio: ['ignore', 'ignore', 'inherit'] })

  const password = randomBytes(24).toString('base64url')
  const passwordFile = join(outDir, 'p12-password.txt')
  // No trailing newline: `gh secret set < file` stores stdin verbatim.
  writeFileSync(passwordFile, password, { mode: 0o600 })
  execFileSync(OPENSSL, ['pkcs12', '-export', '-inkey', key, '-in', certificate, '-name', COMMON_NAME,
    '-out', p12Path, '-passout', 'file:' + passwordFile])
  chmodSync(p12Path, 0o600)

  const fingerprint = execFileSync(OPENSSL, ['x509', '-in', certificate, '-noout', '-fingerprint', '-sha1'], { encoding: 'utf8' })
    .replace(/^.*=/, '').replace(/:/g, '').trim().toLowerCase()
  writeFileSync(PIN_FILE, fingerprint + '\n')

  console.log('✓ created ' + p12Path)
  console.log('  certificate  ' + COMMON_NAME + ', SHA-1 ' + fingerprint + ', valid ' + VALID_DAYS + ' days')
  console.log('  pinned in    ' + PIN_FILE + ' (commit this file)')
  console.log('')
  console.log('Back up the whole directory (' + outDir + ') somewhere safe, then add the GitHub secrets:')
  console.log('  base64 -i "' + p12Path + '" | gh secret set MAC_SIGN_P12_BASE64')
  console.log('  gh secret set MAC_SIGN_P12_PASSWORD < "' + passwordFile + '"')
  console.log('')
  console.log('Local signed build:')
  console.log('  DSH_MAC_SIGN_P12_BASE64="$(base64 -i "' + p12Path + '")" \\')
  console.log('  DSH_MAC_SIGN_P12_PASSWORD="$(cat "' + passwordFile + '")" pnpm run pack')
} finally {
  rmSync(work, { recursive: true, force: true })
}
