/**
 * Sign-in for the desktop client and the console.
 *
 * The server is an OAuth 2.0 authorization server for one public client
 * (`dsh-desktop`, PKCE required, loopback redirect only) and federates the
 * actual authentication to the organisation's identity provider: any
 * OpenID Connect provider, or a development login for evaluation. People are
 * matched by IdP subject, then by e-mail; unknown people are refused unless
 * automatic provisioning is on.
 *
 * Tokens are opaque random strings stored only as SHA-256 hashes. Refresh
 * tokens rotate on every use; access tokens are short-lived.
 * @module @dsh-desktop-pro/server/auth
 */

import { pkceChallenge } from '@dsh-desktop-pro/protocol'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { ServerConfig } from './config.ts'
import { newId, randomToken, safeEqual, sha256 } from './crypto.ts'
import { HttpError } from './http.ts'
import type { Store, User } from './store.ts'

const FLOW_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 2 * 60 * 1000

export type FlowKind = 'client' | 'console'

interface Flow {
  id: string
  kind: FlowKind
  client_redirect: string | null
  client_state: string | null
  code_challenge: string | null
  oidc_state: string | null
  oidc_nonce: string | null
  oidc_verifier: string | null
}

interface OidcMetadata { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }

/** Only the loopback redirect of a native app (RFC 8252 §7.3). */
export function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/callback' && url.username === '' && url.hash === ''
  } catch {
    return false
  }
}

export function createAuth(store: Store, config: ServerConfig, fetchImpl: typeof fetch = fetch) {
  let oidcMetadata: Promise<OidcMetadata> | undefined
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  function discover(): Promise<OidcMetadata> {
    if (config.oidc === undefined) return Promise.reject(new Error('OIDC is not configured'))
    oidcMetadata ??= fetchImpl(config.oidc.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error('OIDC discovery answered HTTP ' + String(response.status))
        return await response.json() as OidcMetadata
      })
      .catch((error: unknown) => { oidcMetadata = undefined; throw error })
    return oidcMetadata
  }

  function signInMethods(): Array<{ id: string; label: string }> {
    return [
      ...config.oidc !== undefined ? [{ id: 'oidc', label: config.oidc.label }] : [],
      ...config.devLogin ? [{ id: 'dev', label: 'Development login' }] : [],
    ]
  }

  async function startFlow(kind: FlowKind, client?: { redirect: string; state: string; challenge: string }): Promise<Flow> {
    const flow: Flow = {
      id: randomToken(24), kind,
      client_redirect: client?.redirect ?? null, client_state: client?.state ?? null, code_challenge: client?.challenge ?? null,
      oidc_state: null, oidc_nonce: null, oidc_verifier: null,
    }
    await store.db.run('DELETE FROM login_flows WHERE expires_at < $1', [Date.now()])
    await store.db.run('INSERT INTO login_flows (id, tenant_id, kind, client_redirect, client_state, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [flow.id, store.tenantId, kind, flow.client_redirect, flow.client_state, flow.code_challenge, Date.now() + FLOW_TTL_MS])
    return flow
  }

  async function flow(id: string): Promise<Flow> {
    const row = await store.db.get<Flow & { expires_at: number }>(
      'SELECT id, kind, client_redirect, client_state, code_challenge, oidc_state, oidc_nonce, oidc_verifier, expires_at FROM login_flows WHERE tenant_id = $1 AND id = $2', [store.tenantId, id])
    if (row === undefined || row.expires_at < Date.now()) throw new HttpError(400, 'login_expired', 'This sign-in link expired. Start again from DSH Desktop Pro.')
    return row
  }

  /** The IdP leg: redirect to the provider, remembering PKCE and nonce for the callback. */
  async function oidcRedirect(current: Flow): Promise<string> {
    if (config.oidc === undefined) throw new HttpError(400, 'oidc_disabled')
    const metadata = await discover()
    const verifier = randomToken(32)
    const nonce = randomToken(16)
    await store.db.run('UPDATE login_flows SET oidc_state = $1, oidc_nonce = $2, oidc_verifier = $3 WHERE id = $4', [current.id, nonce, verifier, current.id])
    const url = new URL(metadata.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.oidc.clientId)
    url.searchParams.set('redirect_uri', config.publicUrl + '/v1/auth/oidc/callback')
    url.searchParams.set('scope', config.oidc.scopes)
    url.searchParams.set('state', current.id)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', pkceChallenge(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return url.href
  }

  /** The IdP came back: exchange its code, verify the ID token, find the person. */
  async function oidcCallback(params: URLSearchParams): Promise<{ flow: Flow; person: User }> {
    if (config.oidc === undefined) throw new HttpError(400, 'oidc_disabled')
    if (params.get('error') !== null) throw new HttpError(400, 'idp_error', 'The identity provider refused the sign-in: ' + (params.get('error_description') ?? params.get('error') ?? ''))
    const current = await flow(params.get('state') ?? '')
    if (current.oidc_verifier === null || current.oidc_nonce === null) throw new HttpError(400, 'login_state')
    const metadata = await discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: params.get('code') ?? '', redirect_uri: config.publicUrl + '/v1/auth/oidc/callback',
      client_id: config.oidc.clientId, code_verifier: current.oidc_verifier,
      ...config.oidc.clientSecret !== undefined && { client_secret: config.oidc.clientSecret },
    })
    const response = await fetchImpl(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new HttpError(502, 'idp_token', 'The identity provider did not issue a token (HTTP ' + String(response.status) + ')')
    const tokens = await response.json() as { id_token?: string }
    if (typeof tokens.id_token !== 'string') throw new HttpError(502, 'idp_token', 'The identity provider returned no ID token')
    jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri))
    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: metadata.issuer, audience: config.oidc.clientId })
    if (payload['nonce'] !== current.oidc_nonce) throw new HttpError(400, 'idp_nonce')
    const subject = String(payload.sub ?? '')
    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined
    const name = typeof payload['name'] === 'string' ? payload['name'] : email ?? subject
    return { flow: current, person: await resolvePerson('oidc', subject, email, name) }
  }

  async function resolvePerson(provider: string, subject: string, email: string | undefined, name: string): Promise<User> {
    let person = await store.userByIdentity(provider, subject)
    if (person === undefined && email !== undefined) person = await store.userByEmail(email)
    if (person === undefined && config.autoProvision) {
      person = await store.createUser({ name, email: email ?? null })
      await store.audit({ actorType: 'system', action: 'user.provisioned', target: person.id, detail: { provider } })
    }
    if (person === undefined) {
      await store.audit({ actorType: 'system', action: 'login.refused', detail: { provider, reason: 'unknown', email: email ?? '' } })
      throw new HttpError(403, 'not_a_member', 'Your account is not set up for DSH Desktop Pro yet. Ask your IT administrator to add you.')
    }
    if (person.status !== 'active') throw new HttpError(403, 'user_disabled', 'Your DSH Desktop Pro access is disabled.')
    await store.linkIdentity(person.id, provider, subject)
    return person
  }

  /** Development login: an e-mail form. Never enable it on a reachable deployment. */
  async function devLogin(flowId: string, email: string): Promise<{ flow: Flow; person: User }> {
    if (!config.devLogin) throw new HttpError(404, 'not_found')
    const current = await flow(flowId)
    return { flow: current, person: await resolvePerson('dev', email.toLowerCase(), email.toLowerCase(), email.split('@')[0] ?? email) }
  }

  /** Finish a client flow: a one-time code for the loopback redirect. */
  async function issueCode(current: Flow, person: User): Promise<string> {
    if (current.client_redirect === null || current.code_challenge === null) throw new HttpError(400, 'login_state')
    const code = randomToken(32)
    await store.db.run('INSERT INTO auth_codes (code_hash, tenant_id, user_id, client_redirect, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [sha256(code), store.tenantId, person.id, current.client_redirect, current.code_challenge, Date.now() + CODE_TTL_MS])
    await store.db.run('DELETE FROM login_flows WHERE id = $1', [current.id])
    const redirect = new URL(current.client_redirect)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', current.client_state ?? '')
    await store.audit({ actorType: 'user', actorId: person.id, action: 'login.succeeded', detail: { client: 'dsh-desktop-pro' } })
    return redirect.href
  }

  async function createSession(person: User, kind: 'client' | 'console'): Promise<{ sessionId: string; refreshToken: string; accessToken: string; expiresIn: number }> {
    const sessionId = newId('ses')
    const refreshToken = randomToken(32)
    const now = Date.now()
    await store.db.run('INSERT INTO sessions (id, tenant_id, user_id, kind, refresh_hash, created_at, expires_at, revoked) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)',
      [sessionId, store.tenantId, person.id, kind, sha256(refreshToken), now, now + config.refreshTokenDays * 86_400_000])
    const accessToken = await issueAccess(sessionId, person.id)
    return { sessionId, refreshToken, accessToken, expiresIn: config.accessTokenSeconds }
  }

  async function issueAccess(sessionId: string, userId: string): Promise<string> {
    const token = randomToken(32)
    await store.db.run('DELETE FROM access_tokens WHERE expires_at < $1', [Date.now()])
    await store.db.run('INSERT INTO access_tokens (token_hash, tenant_id, session_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [sha256(token), store.tenantId, sessionId, userId, Date.now() + config.accessTokenSeconds * 1000])
    return token
  }

  /** POST /v1/auth/token for both grants. */
  async function token(form: URLSearchParams): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; user: { id: string; name: string; email?: string } }> {
    if (form.get('client_id') !== 'dsh-desktop-pro') throw new HttpError(400, 'invalid_client')
    const grant = form.get('grant_type')
    let person: User | undefined
    let issued: { refreshToken: string; accessToken: string; expiresIn: number }
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? ''
      const row = await store.db.get<{ user_id: string; client_redirect: string; code_challenge: string; expires_at: number }>(
        'SELECT user_id, client_redirect, code_challenge, expires_at FROM auth_codes WHERE code_hash = $1 AND tenant_id = $2', [sha256(code), store.tenantId])
      // Single use, whatever happens next.
      await store.db.run('DELETE FROM auth_codes WHERE code_hash = $1', [sha256(code)])
      if (row === undefined || row.expires_at < Date.now()) throw new HttpError(400, 'invalid_grant')
      if (row.client_redirect !== form.get('redirect_uri')) throw new HttpError(400, 'invalid_grant')
      if (!safeEqual(pkceChallenge(form.get('code_verifier') ?? ''), row.code_challenge)) throw new HttpError(400, 'invalid_grant')
      person = await store.user(row.user_id)
      if (person?.status !== 'active') throw new HttpError(400, 'invalid_grant')
      issued = await createSession(person, 'client')
    } else if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? ''
      const session = await store.db.get<{ id: string; user_id: string; expires_at: number; revoked: number }>(
        "SELECT id, user_id, expires_at, revoked FROM sessions WHERE refresh_hash = $1 AND tenant_id = $2 AND kind = 'client'", [sha256(presented), store.tenantId])
      if (session === undefined) throw new HttpError(400, 'invalid_grant')
      person = await store.user(session.user_id)
      // Off-boarded: say so explicitly (before "revoked", which off-boarding
      // also sets), so the device removes the organisation's configuration.
      if (person?.status !== 'active') throw new HttpError(403, 'user_disabled')
      if (session.revoked !== 0 || session.expires_at < Date.now()) throw new HttpError(400, 'invalid_grant')
      // Rotate: the presented refresh token stops working now.
      const refreshToken = randomToken(32)
      await store.db.run('UPDATE sessions SET refresh_hash = $1 WHERE id = $2', [sha256(refreshToken), session.id])
      issued = { refreshToken, accessToken: await issueAccess(session.id, session.user_id), expiresIn: config.accessTokenSeconds }
    } else {
      throw new HttpError(400, 'unsupported_grant_type')
    }
    return {
      access_token: issued.accessToken, token_type: 'Bearer', expires_in: issued.expiresIn, refresh_token: issued.refreshToken,
      user: { id: person.id, name: person.name, ...person.email !== null && { email: person.email } },
    }
  }

  async function logout(refreshToken: string): Promise<void> {
    const session = await store.db.get<{ id: string; user_id: string }>('SELECT id, user_id FROM sessions WHERE refresh_hash = $1 AND tenant_id = $2', [sha256(refreshToken), store.tenantId])
    if (session === undefined) return
    await revokeSession(session.id)
    await store.audit({ actorType: 'user', actorId: session.user_id, action: 'logout' })
  }

  async function revokeSession(sessionId: string): Promise<void> {
    await store.db.run('UPDATE sessions SET revoked = 1 WHERE id = $1', [sessionId])
    await store.db.run('DELETE FROM access_tokens WHERE session_id = $1', [sessionId])
  }

  async function revokeUserSessions(userId: string): Promise<void> {
    await store.db.run('UPDATE sessions SET revoked = 1 WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
    await store.db.run('DELETE FROM access_tokens WHERE tenant_id = $1 AND user_id = $2', [store.tenantId, userId])
  }

  /** The person behind a bearer access token, or undefined. */
  async function authenticate(accessToken: string | undefined): Promise<{ person: User; sessionId: string } | undefined> {
    if (accessToken === undefined || accessToken === '') return undefined
    const row = await store.db.get<{ user_id: string; session_id: string; expires_at: number }>(
      'SELECT user_id, session_id, expires_at FROM access_tokens WHERE token_hash = $1 AND tenant_id = $2', [sha256(accessToken), store.tenantId])
    if (row === undefined || row.expires_at < Date.now()) return undefined
    const session = await store.db.get<{ revoked: number }>('SELECT revoked FROM sessions WHERE id = $1', [row.session_id])
    if (session === undefined || session.revoked !== 0) return undefined
    const person = await store.user(row.user_id)
    return person === undefined ? undefined : { person, sessionId: row.session_id }
  }

  /** Console sign-in finished: a browser session cookie value. */
  async function consoleSession(person: User): Promise<string> {
    if (person.role === 'member') throw new HttpError(403, 'not_an_administrator', 'Only administrators and auditors can open the console.')
    const { refreshToken } = await createSession(person, 'console')
    await store.audit({ actorType: 'admin', actorId: person.id, action: 'console.login' })
    return refreshToken
  }

  async function consolePerson(cookie: string | undefined): Promise<User | undefined> {
    if (cookie === undefined || cookie === '') return undefined
    const session = await store.db.get<{ user_id: string; expires_at: number; revoked: number }>(
      "SELECT user_id, expires_at, revoked FROM sessions WHERE refresh_hash = $1 AND tenant_id = $2 AND kind = 'console'", [sha256(cookie), store.tenantId])
    if (session === undefined || session.revoked !== 0 || session.expires_at < Date.now()) return undefined
    const person = await store.user(session.user_id)
    return person?.status === 'active' && person.role !== 'member' ? person : undefined
  }

  async function consoleLogout(cookie: string): Promise<void> {
    await store.db.run("UPDATE sessions SET revoked = 1 WHERE refresh_hash = $1 AND kind = 'console'", [sha256(cookie)])
  }

  return {
    signInMethods, startFlow, flow, oidcRedirect, oidcCallback, devLogin, issueCode, token, logout, revokeUserSessions,
    authenticate, consoleSession, consolePerson, consoleLogout,
  }
}

export type Auth = ReturnType<typeof createAuth>
