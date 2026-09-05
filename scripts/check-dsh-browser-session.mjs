/** Unit checks for native admission to DSH 0.1.2-alpha.1+'s authenticated Web API. */

import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-browser-session-'))
process.on('exit', () => { rmSync(work, { recursive: true, force: true }) })

const outfile = join(work, 'dsh-browser-session.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'dsh-browser-session.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
})
const { createDshBrowserSessionCookie, readDshBrowserSessionSecret } =
  await import(pathToFileURL(outfile).href)

const home = join(work, 'home')
mkdirSync(home)
const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const encodedSecret = secret.toString('base64url')
writeFileSync(join(home, '.credentials.yaml'), [
  'version: 1',
  'refs:',
  '  unrelated: value',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${encodedSecret}`,
  '  another-owner/key:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${Buffer.alloc(32, 255).toString('base64url')}`,
  '',
].join('\n'))

if (!readDshBrowserSessionSecret(home)?.equals(secret)) {
  throw new Error('the exact browser-session owner secret was not read')
}

for (const compatible of [
  [
    'version: 1',
    'records:',
    `  "client-connection/browser-session": { kind: grant, payload: { version: 1, secret: ${encodedSecret} } }`,
    '',
  ].join('\n'),
  [
    'version: 1',
    'records:',
    '    client-connection/browser-session: # user-preserved formatting is valid YAML',
    '      kind: grant',
    '      payload:',
    '        version: 1',
    `        secret: '${encodedSecret}'`,
    '',
  ].join('\n'),
]) {
  writeFileSync(join(home, '.credentials.yaml'), compatible)
  if (!readDshBrowserSessionSecret(home)?.equals(secret)) {
    throw new Error('a valid DSH YAML spelling of the browser-session record was rejected')
  }
}
console.log('✓ quoted, inline, commented, and re-indented DSH credential YAML is accepted')

writeFileSync(join(home, '.credentials.yaml'), [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${encodedSecret}`,
  '',
].join('\n'))

const now = 1_800_000_000_000
const cookie = createDshBrowserSessionCookie(home, 'http://127.0.0.1:3080/?ignored=yes', now)
if (cookie === undefined) throw new Error('a valid loopback credential minted no cookie')
const expectedName = 'dsh-auth-' + createHash('sha256').update('127.0.0.1:3080').digest('base64url')
if (cookie.name !== expectedName || cookie.header !== `${cookie.name}=${cookie.value}`) {
  throw new Error('cookie name/header do not match the authority-bound DSH format')
}
const [version, body, signature] = cookie.value.split('.')
if (version !== 'v1' || body === undefined || signature === undefined) {
  throw new Error('cookie does not use DSH v1 framing')
}
const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
if (JSON.stringify(payload) !== JSON.stringify({
  version: 1,
  authority: '127.0.0.1:3080',
  issuedAt: now,
  expiresAt: now + 24 * 60 * 60 * 1000,
})) throw new Error('cookie payload is not the short-lived authority grant')
const expectedSignature = createHmac('sha256', secret).update(body).digest('base64url')
if (signature !== expectedSignature) throw new Error('cookie signature does not match the stored DSH secret')
console.log('✓ the desktop cookie matches DSH v1 signing, authority, and lifetime')

for (const remote of ['https://127.0.0.1:3080', 'http://example.com:3080', 'file:///tmp/index.html']) {
  if (createDshBrowserSessionCookie(home, remote, now) !== undefined) {
    throw new Error('a non-loopback HTTP origin received native admission: ' + remote)
  }
}
console.log('✓ native admission is limited to loopback HTTP')

for (const invalid of [
  '',
  'records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ' + encodedSecret,
  'records:\n  client-connection/browser-session:\n    kind: api-key\n    payload:\n      version: 1\n      secret: ' + encodedSecret,
  'records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 2\n      secret: ' + encodedSecret,
  'records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: short',
]) {
  writeFileSync(join(home, '.credentials.yaml'), invalid)
  if (readDshBrowserSessionSecret(home) !== undefined) {
    throw new Error('an unsupported credential record was accepted')
  }
}
console.log('✓ missing, malformed, and future credential records fail closed')

// Exercise EOF framing through the same reader used by both runtime streams.
const outputBundle = join(work, 'runtime-output.mjs')
await esbuild.build({ entryPoints: [join(APP_DIR, 'src/main/runtime-output.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: outputBundle, logLevel: 'silent' })
const { createRuntimeLineReader, sanitizeRuntimeOutput } = await import(pathToFileURL(outputBundle).href)
const lines = []
const reader = createRuntimeLineReader(line => lines.push(sanitizeRuntimeOutput(line)))
reader.write(Buffer.from('token='))
reader.write(Buffer.from('synthetic-final-fragment'))
reader.end()
if (lines.length !== 1 || lines[0].includes('synthetic-final-fragment') || !lines[0].includes('[redacted]')) {
  throw new Error('the final unterminated runtime fragment bypasses credential redaction')
}
console.log('✓ an unterminated final runtime line cannot bypass credential redaction')
