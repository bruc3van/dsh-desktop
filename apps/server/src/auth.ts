/**
 * Sign-in for the desktop client and the console.
 *
 * The server is an OAuth 2.0 authorization server for one public client
 * (`dsh-desktop`, PKCE required, loopback redirect only) and federates the
 * actual authentication to identity sources (ADR-0008): an OpenID Connect
 * provider, the organisation's Feishu, DingTalk or WeCom, or a development
 * login for evaluation. People are matched by the provider's subject first.
 * For a directory source that is the only match: its people come from its
 * directory. For OIDC a verified e-mail can find a member, and unknown people
 * are refused unless automatic provisioning is on.
 *
 * Tokens are opaque random strings stored only as SHA-256 hashes. Refresh
 * tokens rotate on every use, and presenting one that was already rotated
 * away ends the session: one of the two holders is not the device. Codes and
 * refresh tokens are spent by a conditional write, so two requests racing with
 * the same one cannot both succeed.
 *
 * An e-mail address only identifies someone when the identity provider says
 * it verified it (or the deployment states that it does), so an account at the
 * provider cannot claim a member by setting their address.
 * @module @dsh-desktop-pro/server/auth
 */

import { pkceChallenge } from '@dsh-desktop-pro/protocol'
import type { ServerConfig } from './config.ts'
import { newId, randomToken, safeEqual, sha256 } from './crypto.ts'
import { HttpError } from './http.ts'
import { IdentityError, type SignedInIdentity, type SignInConnector } from './identity/types.ts'
import type { Store, User } from './store.ts'

const FLOW_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 2 * 60 * 1000
const BOOTSTRAP_TTL_MS = 8 * 60 * 60 * 1000

export type FlowKind = 'client' | 'console'

interface Flow {
  id: string
  kind: FlowKind
  client_redirect: string | null
  client_state: string | null
  code_challenge: string | null
  /** The identity source this sign-in went to, and what its callback must match. */
  idp: string | null
  idp_nonce: string | null
  idp_verifier: string | null
}

/** Only the loopback redirect of a native app (RFC 8252 §7.3). */
export function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/callback' && url.username === '' && url.hash === ''
  } catch {
    return false
  }
}

export function createAuth(store: Store, config: ServerConfig, connectors: readonly SignInConnector[]) {
  const byId = new Map(connectors.map(connector => [connector.id, connector]))

  /** Where an identity source sends people back; register it with the provider. */
  function callbackUrl(idp: string): string {
    return config.publicUrl + '/v1/auth/' + idp + '/callback'
  }

  function signInMethods(): Array<{ id: string; label: string; labels: { zh: string; en: string } }> {
    return [
      ...connectors.map(connector => ({ id: connector.id, label: connector.label.en, labels: connector.label })),
      ...config.devLogin ? [{ id: 'dev', label: 'Development login', labels: { zh: '开发登录', en: 'Development login' } }] : [],
    ]
  }

  async function startFlow(kind: FlowKind, client?: { redirect: string; state: string; challenge: string }): Promise<Flow> {
    const flow: Flow = {
      id: randomToken(24), kind,
      client_redirect: client?.redirect ?? null, client_state: client?.state ?? null, code_challenge: client?.challenge ?? null,
      idp: null, idp_nonce: null, idp_verifier: null,
    }
    await store.db.run('DELETE FROM login_flows WHERE expires_at < $1', [Date.now()])
    await store.db.run('INSERT INTO login_flows (id, tenant_id, kind, client_redirect, client_state, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [flow.id, store.tenantId, kind, flow.client_redirect, flow.client_state, flow.code_challenge, Date.now() + FLOW_TTL_MS])
    return flow
  }

  async function flow(id: string): Promise<Flow> {
    const row = await store.db.get<Flow & { expires_at: number }>(
      'SELECT id, kind, client_redirect, client_state, code_challenge, idp, idp_nonce, idp_verifier, expires_at FROM login_flows WHERE tenant_id = $1 AND id = $2', [store.tenantId, id])
    if (row === undefined || row.expires_at < Date.now()) throw new HttpError(400, 'login_expired', 'This sign-in link expired. Start again from DSH Desktop Pro.')
    return row
  }

  function connector(idp: string): SignInConnector {
    const found = byId.get(idp)
    if (found === undefined) throw new HttpError(404, 'idp_disabled', 'This sign-in method is not set up on this server.')
    return found
  }

  /** The provider leg: send the person to the identity source, remembering PKCE and nonce for the callback. */
  async function redirectTo(idp: string, current: Flow): Promise<string> {
    const source = connector(idp)
    const verifier = randomToken(32)
    const nonce = randomToken(16)
    await store.db.run('UPDATE login_flows SET idp = $1, idp_nonce = $2, idp_verifier = $3 WHERE id = $4', [idp, nonce, verifier, current.id])
    return source.authorizeUrl({ state: current.id, nonce, challenge: pkceChallenge(verifier), redirectUri: callbackUrl(idp) })
  }

  /** The provider came back: let its connector establish who it is, then find the member. */
  async function callback(idp: string, params: URLSearchParams): Promise<{ flow: Flow; person: User }> {
    const source = connector(idp)
    const current = await flow(params.get('state') ?? '')
    if (current.idp !== idp || current.idp_verifier === null || current.idp_nonce === null) throw new HttpError(400, 'login_state')
    let identity: SignedInIdentity
    try {
      identity = await source.complete(params, { nonce: current.idp_nonce, verifier: current.idp_verifier, redirectUri: callbackUrl(idp) })
    } catch (error) {
      if (error instanceof IdentityError) {
        if (error.code === 'wrong_organization') await store.audit({ actorType: 'system', action: 'login.refused', detail: { provider: idp, reason: 'wrong_organization' } })
        throw new HttpError(error.status, error.code, error.message)
      }
      throw error
    }
    return { flow: current, person: await resolvePerson(identity) }
  }

  async function resolvePerson(identity: SignedInIdentity): Promise<User> {
    const { provider, subject, name } = identity
    let person = await store.userByIdentity(provider, subject)
    if (person === undefined && identity.directoryBound) {
      // People of a directory source come only from its directory.
      await store.audit({ actorType: 'system', action: 'login.refused', detail: { provider, reason: 'not_in_directory' } })
      throw new HttpError(403, 'not_in_directory', 'Your account is not in the organisation directory this server syncs. Ask your IT administrator.')
    }
    const email = identity.email !== undefined && identity.emailVerified ? identity.email : undefined
    if (identity.email !== undefined && !identity.emailVerified) {
      await store.audit({ actorType: 'system', action: 'login.email_unverified', detail: { provider, email: identity.email } })
    }
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
    const normalised = email.toLowerCase()
    return { flow: current, person: await resolvePerson({ provider: 'dev', subject: normalised, name: normalised.split('@')[0] ?? normalised, email: normalised, emailVerified: true, directoryBound: false }) }
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
      // Single use, whatever happens next: only the request that deletes the row may spend it.
      const spent = await store.db.run('DELETE FROM auth_codes WHERE code_hash = $1', [sha256(code)])
      if (row === undefined || spent !== 1 || row.expires_at < Date.now()) throw new HttpError(400, 'invalid_grant')
      if (row.client_redirect !== form.get('redirect_uri')) throw new HttpError(400, 'invalid_grant')
      if (!safeEqual(pkceChallenge(form.get('code_verifier') ?? ''), row.code_challenge)) throw new HttpError(400, 'invalid_grant')
      person = await store.user(row.user_id)
      if (person?.status !== 'active') throw new HttpError(400, 'invalid_grant')
      issued = await createSession(person, 'client')
    } else if (grant === 'refresh_token') {
      const presented = sha256(form.get('refresh_token') ?? '')
      const session = await store.db.get<{ id: string; user_id: string; expires_at: number; revoked: number }>(
        "SELECT id, user_id, expires_at, revoked FROM sessions WHERE refresh_hash = $1 AND tenant_id = $2 AND kind = 'client'", [presented, store.tenantId])
      if (session === undefined) {
        // A token rotated away is back: it was copied. End the session for both holders.
        const reused = await store.db.get<{ id: string; user_id: string }>(
          "SELECT id, user_id FROM sessions WHERE prev_refresh_hash = $1 AND tenant_id = $2 AND kind = 'client' AND revoked = 0", [presented, store.tenantId])
        if (reused !== undefined) {
          await revokeSession(reused.id)
          await store.audit({ actorType: 'system', action: 'session.refresh_reused', actorId: reused.user_id, target: reused.id })
        }
        throw new HttpError(400, 'invalid_grant')
      }
      person = await store.user(session.user_id)
      // Off-boarded: say so explicitly (before "revoked", which off-boarding
      // also sets), so the device removes the organisation's configuration.
      if (person?.status !== 'active') throw new HttpError(403, 'user_disabled')
      if (session.revoked !== 0 || session.expires_at < Date.now()) throw new HttpError(400, 'invalid_grant')
      // Rotate: the presented refresh token stops working now. The condition
      // makes the swap the single point where a racing duplicate loses.
      const refreshToken = randomToken(32)
      const rotated = await store.db.run('UPDATE sessions SET refresh_hash = $1, prev_refresh_hash = $2 WHERE id = $3 AND refresh_hash = $2', [sha256(refreshToken), presented, session.id])
      if (rotated !== 1) throw new HttpError(400, 'invalid_grant')
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
    // An administrator can sign in for real: the bootstrap token is done.
    if (person.role === 'admin') {
      const closed = await store.db.run('UPDATE tenants SET bootstrap_closed_at = $1 WHERE id = $2 AND bootstrap_closed_at IS NULL', [Date.now(), store.tenantId])
      if (closed === 1) await store.audit({ actorType: 'system', action: 'bootstrap.closed', detail: { by: person.id } })
    }
    return refreshToken
  }

  async function bootstrapOpen(): Promise<boolean> {
    if (config.bootstrapToken === undefined) return false
    const row = await store.db.get<{ bootstrap_closed_at: number | null }>('SELECT bootstrap_closed_at FROM tenants WHERE id = $1', [store.tenantId])
    return row !== undefined && row.bootstrap_closed_at === null
  }

  /**
   * The bootstrap token opens one short console session, held as a hashed
   * random value like any other; the token itself never goes into a cookie.
   * It stops working for good once an administrator signs in through the
   * identity provider.
   */
  async function bootstrapSession(token: string): Promise<string> {
    if (config.bootstrapToken === undefined || !safeEqual(token, config.bootstrapToken)) throw new HttpError(401, 'invalid_token')
    if (!await bootstrapOpen()) throw new HttpError(403, 'bootstrap_closed', 'An administrator has signed in; use your organisation account.')
    const value = randomToken(32)
    const now = Date.now()
    await store.db.run("INSERT INTO sessions (id, tenant_id, user_id, kind, refresh_hash, created_at, expires_at, revoked) VALUES ($1, $2, 'bootstrap', 'bootstrap', $3, $4, $5, 0)",
      [newId('ses'), store.tenantId, sha256(value), now, now + BOOTSTRAP_TTL_MS])
    return value
  }

  async function bootstrapValid(value: string): Promise<boolean> {
    if (value === '' || !await bootstrapOpen()) return false
    const session = await store.db.get<{ expires_at: number; revoked: number }>(
      "SELECT expires_at, revoked FROM sessions WHERE refresh_hash = $1 AND tenant_id = $2 AND kind = 'bootstrap'", [sha256(value), store.tenantId])
    return session !== undefined && session.revoked === 0 && session.expires_at >= Date.now()
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
    await store.db.run("UPDATE sessions SET revoked = 1 WHERE refresh_hash = $1 AND kind IN ('console', 'bootstrap')", [sha256(cookie)])
  }

  return {
    signInMethods, callbackUrl, startFlow, flow, redirectTo, callback, devLogin, issueCode, token, logout, revokeUserSessions,
    authenticate, consoleSession, consolePerson, consoleLogout, bootstrapSession, bootstrapValid,
  }
}

export type Auth = ReturnType<typeof createAuth>
