/**
 * Sign-in through a real OpenID Connect exchange against a local identity
 * provider: discovery, PKCE, a signed ID token checked against the provider's
 * keys, and how the server decides who a person is.
 *
 * The point it pins down: an e-mail address only identifies a member when the
 * provider says it verified it. Otherwise anyone able to create an account at
 * the provider with a member's address would sign in as that member.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'

const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(requireFromServer.resolve('jose')).href)

const work = mkdtempSync(join(tmpdir(), 'dsh-oidc-check-'))
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' }

/** What the provider says about the next person who signs in. */
let next = { sub: '', email: '', email_verified: undefined }
const pending = new Map()
const idp = createServer((req, res) => {
  const url = new URL(req.url, issuer)
  if (url.pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
    }))
  } else if (url.pathname === '/jwks') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
  } else if (url.pathname === '/authorize') {
    const code = randomBytes(8).toString('hex')
    pending.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), who: next })
    const back = new URL(url.searchParams.get('redirect_uri'))
    back.searchParams.set('code', code)
    back.searchParams.set('state', url.searchParams.get('state'))
    res.writeHead(302, { location: back.href }).end()
  } else if (url.pathname === '/token') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      const form = new URLSearchParams(body)
      const grant = pending.get(form.get('code'))
      const verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (grant === undefined || verifier !== grant.challenge) { res.writeHead(400).end('{}'); return }
      const claims = { nonce: grant.nonce, email: grant.who.email, name: grant.who.email.split('@')[0], ...grant.who.email_verified !== undefined && { email_verified: grant.who.email_verified } }
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('dsh-console')
        .setSubject(grant.who.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }))
    })
  } else {
    res.writeHead(404).end()
  }
})
await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve))
const issuer = 'http://127.0.0.1:' + String(idp.address().port)

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'x'.repeat(40), PORT: '0', HOST: '127.0.0.1',
  DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_GATEWAY: 'none',
  OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'dsh-console', OIDC_CLIENT_SECRET: 'secret',
})
// DSH_CHECK_DATABASE_URL=postgres://… runs the same checks against PostgreSQL (an empty database).
const app = await createApp({ config, db: await openDb(process.env.DSH_CHECK_DATABASE_URL ?? 'sqlite:' + join(work, 'server.sqlite')) })
const base = await app.listen()
config.publicUrl = base

/** The desktop client's sign-in, walked by a fetch "browser": where does it end? */
async function signIn(who) {
  next = who
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(base + '/v1/auth/authorize')
  authorize.search = new URLSearchParams({
    client_id: 'dsh-desktop-pro', response_type: 'code', code_challenge_method: 'S256', state: 'xyz',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), redirect_uri: 'http://127.0.0.1:5599/callback',
  }).toString()
  let response = await fetch(authorize, { redirect: 'manual' })
  for (let hops = 0; hops < 5 && response.status === 302; hops += 1) {
    const location = response.headers.get('location')
    if (location.startsWith('http://127.0.0.1:5599/')) return { signedIn: true, location }
    response = await fetch(location, { redirect: 'manual' })
  }
  return { signedIn: false, status: response.status, page: await response.text() }
}

try {
  await app.store.createUser({ name: 'Alice', email: 'alice@acme.example' })
  await app.store.createUser({ name: 'Bob', email: 'bob@acme.example' })

  const spoofed = await signIn({ sub: 'attacker-1', email: 'alice@acme.example', email_verified: false })
  assert.equal(spoofed.signedIn, false, 'an unverified e-mail does not sign anyone in as Alice')
  assert.equal(spoofed.status, 403)
  const unverified = await app.store.db.get("SELECT detail FROM audit_events WHERE action = 'login.email_unverified'")
  assert.match(unverified.detail, /alice@acme\.example/, 'the attempt is audited')
  const silent = await signIn({ sub: 'attacker-2', email: 'alice@acme.example' })
  assert.equal(silent.signedIn, false, 'a provider that says nothing about verification is not trusted by default')
  console.log('✓ an e-mail the provider did not verify identifies nobody')

  const alice = await signIn({ sub: 'alice-at-idp', email: 'alice@acme.example', email_verified: true })
  assert.equal(alice.signedIn, true, 'a verified e-mail finds the member')
  const relinked = await signIn({ sub: 'alice-at-idp', email: 'changed@elsewhere.example', email_verified: false })
  assert.equal(relinked.signedIn, true, 'once linked, the provider subject identifies the member whatever the e-mail says')
  console.log('✓ a verified e-mail links the member; afterwards the provider subject is enough')

  config.oidc.trustEmail = true
  const trusted = await signIn({ sub: 'bob-at-idp', email: 'bob@acme.example' })
  assert.equal(trusted.signedIn, true, 'OIDC_TRUST_EMAIL accepts providers that never send email_verified')
  console.log('✓ OIDC_TRUST_EMAIL opts in for providers that do not send email_verified')
} finally {
  await app.close()
  idp.close()
  rmSync(work, { recursive: true, force: true })
}
