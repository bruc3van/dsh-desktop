/**
 * The client side of server mode: sign-in, device identity, and fetching the
 * signed desired state.
 *
 * Sign-in is OAuth 2.0 authorization code with PKCE in the system browser,
 * redirected to a one-shot loopback listener — the person's company SSO page
 * runs in their real browser, never inside this app. The device gets its own
 * Ed25519 key on first sign-in; every API call carries a proof made with it,
 * so a token lifted from this machine does not work elsewhere.
 *
 * Secrets at rest (refresh token, device private key) go through the
 * `SecretCodec` the caller supplies — Electron's safeStorage in the app. This
 * module has no Electron dependency, so it runs under plain Node in tests.
 * @module dsh-desktop-pro/enterprise/server-session
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  API, createDeviceProof, DEVICE_ID_HEADER, DEVICE_PROOF_HEADER, pkceChallenge, PROTOCOL_HEADER, PROTOCOL_VERSION,
  validateDesiredState, verifyDocument,
  type AuditEventInput, type CompanySkill, type DesiredState, type Enrollment, type EnrollResponse, type StatusReport, type TokenResponse, type WatchResponse,
} from '@dsh-desktop-pro/protocol'

export interface SecretCodec {
  /** Whether values are encrypted by the OS; false means file-permission protection only. */
  readonly encrypted: boolean
  seal(plain: string): string
  open(sealed: string): string
}

/** Plain codec for platforms without an OS keyring; the files are still 0600. */
export const PLAIN_CODEC: SecretCodec = { encrypted: false, seal: plain => plain, open: sealed => sealed }

export type SessionErrorKind = 'sign-in-required' | 'device-revoked' | 'network' | 'invalid-response' | 'cancelled'

export class SessionError extends Error {
  readonly kind: SessionErrorKind
  constructor(kind: SessionErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

interface DeviceFile { server: string; deviceId?: string; publicKey: string; privateKey: string }
interface SessionFile { server: string; refreshToken: string; user: TokenResponse['user'] }

export interface ServerSessionOptions {
  enrollment: Enrollment
  /** Private directory for this organisation's files, e.g. `<client home>/enterprise`. */
  home: string
  secrets: SecretCodec
  openBrowser(url: string): void | Promise<void>
  clientVersion: string
  platform?: string
  arch?: string
  fetchImpl?: typeof fetch
  /** How long the browser sign-in may take. */
  signInTimeoutMs?: number
  /** Copy for the page the browser lands on after the redirect. */
  callbackPage?: { done: string; failed: string; doneDetail?: string; failedDetail?: string; lang?: string }
}

function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + String(process.pid) + '.tmp'
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, file)
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return undefined }
}

const CALLBACK_TICK = '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
const CALLBACK_CROSS = '<path d="M8.5 8.5l7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
/** The page the browser lands on after the redirect back to this client. */
const CALLBACK_HTML = (ok: boolean, title: string, detail: string, lang: string): string => {
  const text = (value: string): string => value.replace(/[<>&"]/g, '')
  return '<!doctype html><html lang="' + text(lang) + '"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>' + text(title) + ' · DSH Desktop Pro</title>'
    + '<style>:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.08);--tone:' + (ok ? '#248a3d' : '#d70015') + '}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--card:#2c2c2e;--text:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.08);--tone:' + (ok ? '#30d158' : '#ff453a') + '}}'
    + '*{box-sizing:border-box;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:24px;-webkit-font-smoothing:antialiased}'
    + 'main{width:min(380px,100%);background:var(--card);border-radius:16px;box-shadow:0 0 0 .5px var(--line),0 12px 40px rgba(0,0,0,.08);padding:36px 32px 30px;text-align:center}'
    + '.mark{width:52px;height:52px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;color:var(--tone);background:color-mix(in srgb,var(--tone) 14%,transparent)}.mark svg{width:28px;height:28px}'
    + 'h1{font-size:19px;font-weight:600;letter-spacing:-.01em}p{margin-top:8px;font-size:14px;line-height:1.55;color:var(--muted)}'
    + 'footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}</style>'
    + '<main><div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true">' + (ok ? CALLBACK_TICK : CALLBACK_CROSS) + '</svg></div>'
    + '<h1>' + text(title) + '</h1>' + (detail !== '' ? '<p>' + text(detail) + '</p>' : '') + '<footer>DSH Desktop Pro</footer></main></html>'
}

async function skillList(response: Response): Promise<CompanySkill[]> {
  const body = await response.json().catch(() => undefined) as { skills?: unknown } | undefined
  if (!Array.isArray(body?.skills)) throw new SessionError('invalid-response', 'the skill list is malformed')
  return body.skills.filter((item): item is CompanySkill => item !== null && typeof item === 'object'
    && typeof (item as CompanySkill).id === 'string' && typeof (item as CompanySkill).title === 'string' && typeof (item as CompanySkill).installed === 'boolean')
    .map(item => ({
      id: item.id, title: item.title.slice(0, 120), ...typeof item.description === 'string' && { description: item.description.slice(0, 500) },
      distribution: item.distribution === 'optional' ? 'optional' : 'everyone', version: Number(item.version) || 1,
      updatedAt: String(item.updatedAt), installed: item.installed,
    }))
}

export class ServerSession {
  private readonly options: ServerSessionOptions
  private readonly fetch: typeof fetch
  private accessToken: string | undefined
  private accessExpiresAt = 0
  private signInInFlight: Promise<void> | undefined

  constructor(options: ServerSessionOptions) {
    this.options = options
    this.fetch = options.fetchImpl ?? fetch
  }

  private get server(): string { return this.options.enrollment.server }
  private get deviceFile(): string { return join(this.options.home, 'device.json') }
  private get sessionFile(): string { return join(this.options.home, 'session.json') }

  private readSession(): SessionFile | undefined {
    const stored = readJson<SessionFile & { sealed?: string }>(this.sessionFile)
    if (stored?.server !== this.server || typeof stored.sealed !== 'string') return undefined
    try {
      return { server: stored.server, user: stored.user, refreshToken: this.options.secrets.open(stored.sealed) }
    } catch {
      return undefined
    }
  }

  private writeSession(session: SessionFile): void {
    writePrivate(this.sessionFile, JSON.stringify({
      server: session.server, user: session.user, sealed: this.options.secrets.seal(session.refreshToken),
      encrypted: this.options.secrets.encrypted,
    }, undefined, 2) + '\n')
  }

  /** The device key for this server, created on first use. */
  private device(): { record: DeviceFile; privateKey: KeyObject } {
    const stored = readJson<DeviceFile>(this.deviceFile)
    if (stored?.server === this.server) {
      try {
        return { record: stored, privateKey: createPrivateKey(this.options.secrets.open(stored.privateKey)) }
      } catch { /* unreadable key: create a new identity below */ }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const record: DeviceFile = {
      server: this.server,
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: this.options.secrets.seal(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    }
    writePrivate(this.deviceFile, JSON.stringify(record, undefined, 2) + '\n')
    return { record, privateKey }
  }

  isSignedIn(): boolean { return this.readSession() !== undefined }
  user(): TokenResponse['user'] | undefined { return this.readSession()?.user }
  deviceId(): string | undefined { return readJson<DeviceFile>(this.deviceFile)?.deviceId }

  /** Sign in through the system browser. Concurrent calls share one attempt. */
  signIn(signal?: AbortSignal): Promise<void> {
    this.signInInFlight ??= this.runSignIn(signal).finally(() => { this.signInInFlight = undefined })
    return this.signInInFlight
  }

  private async runSignIn(signal?: AbortSignal): Promise<void> {
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(16).toString('base64url')
    const copy = { done: 'Signed in', failed: 'Sign-in did not complete', doneDetail: 'You can return to DSH Desktop Pro.', failedDetail: 'Return to DSH Desktop Pro and sign in again.', lang: 'en', ...this.options.callbackPage }
    let server: Server | undefined
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new SessionError('cancelled', 'sign-in timed out')) }, this.options.signInTimeoutMs ?? 5 * 60_000)
      const abort = (): void => { clearTimeout(timer); reject(new SessionError('cancelled', 'sign-in cancelled')) }
      signal?.addEventListener('abort', abort, { once: true })
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code') !== null
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(ok ? CALLBACK_HTML(true, copy.done, copy.doneDetail ?? '', copy.lang) : CALLBACK_HTML(false, copy.failed, copy.failedDetail ?? '', copy.lang))
        if (!ok) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const address = server?.address()
        resolve({ code: url.searchParams.get('code') ?? '', redirectUri: 'http://127.0.0.1:' + String(typeof address === 'object' && address !== null ? address.port : 0) + '/callback' })
      })
      server.on('error', (error) => { clearTimeout(timer); reject(new SessionError('network', 'loopback listener failed: ' + error.message)) })
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        const authorize = new URL(API.authorize, this.server)
        authorize.searchParams.set('response_type', 'code')
        authorize.searchParams.set('client_id', 'dsh-desktop-pro')
        authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:' + String(port) + '/callback')
        authorize.searchParams.set('code_challenge', pkceChallenge(verifier))
        authorize.searchParams.set('code_challenge_method', 'S256')
        authorize.searchParams.set('state', state)
        Promise.resolve(this.options.openBrowser(authorize.href)).catch((error: unknown) => {
          clearTimeout(timer)
          reject(new SessionError('network', 'could not open the browser: ' + (error instanceof Error ? error.message : String(error))))
        })
      })
    }).finally(() => { server?.close() })
    const token = await this.tokenRequest({
      grant_type: 'authorization_code', code: code.code, code_verifier: verifier, redirect_uri: code.redirectUri, client_id: 'dsh-desktop-pro',
    })
    this.acceptToken(token)
    await this.ensureEnrolled()
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    let response: Response
    try {
      response = await this.fetch(new URL(API.token, this.server), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new SessionError('network', 'cannot reach ' + this.server + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    if (response.status === 403) {
      const reason = await response.json().catch(() => ({})) as { error?: string }
      if (reason.error === 'user_disabled') throw new SessionError('device-revoked', 'user_disabled')
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new SessionError('sign-in-required', 'the server refused the sign-in (' + String(response.status) + ')')
    }
    if (!response.ok) throw new SessionError('network', 'token endpoint answered HTTP ' + String(response.status))
    const token = await response.json() as Partial<TokenResponse>
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || typeof token.user?.id !== 'string') {
      throw new SessionError('invalid-response', 'the token response is incomplete')
    }
    return token as TokenResponse
  }

  private acceptToken(token: TokenResponse): void {
    this.accessToken = token.access_token
    this.accessExpiresAt = Date.now() + Math.max(30, token.expires_in - 30) * 1000
    this.writeSession({ server: this.server, refreshToken: token.refresh_token, user: token.user })
  }

  /**
   * One refresh at a time. The server rotates the refresh token on every use
   * and treats an already-used one as stolen (it ends the session), so two
   * calls refreshing side by side would sign this device out.
   */
  private refreshing: Promise<void> | undefined

  private async bearer(): Promise<string> {
    if (this.accessToken !== undefined && Date.now() < this.accessExpiresAt) return this.accessToken
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
    await this.refreshing
    return this.accessToken ?? ''
  }

  private async refresh(): Promise<void> {
    const session = this.readSession()
    if (session === undefined) throw new SessionError('sign-in-required', 'not signed in')
    try {
      this.acceptToken(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: 'dsh-desktop-pro' }))
    } catch (error) {
      if (error instanceof SessionError && error.kind === 'sign-in-required') this.forgetSession()
      throw error
    }
  }

  private forgetSession(): void {
    this.accessToken = undefined
    this.accessExpiresAt = 0
    rmSync(this.sessionFile, { force: true })
  }

  private async ensureEnrolled(): Promise<void> {
    const { record } = this.device()
    if (record.deviceId !== undefined) return
    const body = {
      publicKey: record.publicKey,
      platform: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      clientVersion: this.options.clientVersion,
      hostname: osHostname().slice(0, 200),
    }
    const response = await this.call('POST', API.devices, body, { proof: false })
    const enrolled = await response.json() as Partial<EnrollResponse>
    if (typeof enrolled.deviceId !== 'string') throw new SessionError('invalid-response', 'enrollment returned no device id')
    writePrivate(this.deviceFile, JSON.stringify({ ...record, deviceId: enrolled.deviceId }, undefined, 2) + '\n')
  }

  /** One authenticated API call, refreshing the access token once on a 401. */
  private async call(method: string, path: string, body?: unknown, options: { proof?: boolean; query?: string; timeoutMs?: number } = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers: Record<string, string> = {
        authorization: 'Bearer ' + await this.bearer(),
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      }
      if (body !== undefined) headers['content-type'] = 'application/json'
      // The proof signs these exact bytes, so they are serialised once.
      const text = body === undefined ? undefined : JSON.stringify(body)
      if (options.proof !== false) {
        const { record, privateKey } = this.device()
        if (record.deviceId === undefined) throw new SessionError('sign-in-required', 'this device is not enrolled')
        headers[DEVICE_ID_HEADER] = record.deviceId
        headers[DEVICE_PROOF_HEADER] = createDeviceProof(privateKey, method, path, Date.now(), text ?? '')
      }
      let response: Response
      try {
        // The device proof covers the path; a query only tunes the request.
        response = await this.fetch(new URL(path + (options.query ?? ''), this.server), {
          method, headers, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          ...text !== undefined && { body: text },
        })
      } catch (error) {
        throw new SessionError('network', 'cannot reach ' + this.server + ': ' + (error instanceof Error ? error.message : String(error)))
      }
      if (response.status === 401 && attempt === 0) {
        this.accessToken = undefined
        this.accessExpiresAt = 0
        continue
      }
      if (response.status === 401) { this.forgetSession(); throw new SessionError('sign-in-required', 'the session is no longer valid') }
      if (response.status === 403) {
        const reason = await response.json().catch(() => ({})) as { error?: string }
        if (reason.error === 'device_revoked' || reason.error === 'user_disabled') throw new SessionError('device-revoked', reason.error)
        throw new SessionError('sign-in-required', 'forbidden: ' + String(reason.error ?? 'unknown'))
      }
      if (!response.ok) throw new SessionError('network', method + ' ' + path + ' answered HTTP ' + String(response.status))
      return response
    }
    throw new SessionError('sign-in-required', 'the session is no longer valid')
  }

  /** The current signed document, verified against the pinned keys. */
  async fetchDesiredState(): Promise<DesiredState> {
    const response = await this.call('GET', API.desiredState)
    const verified = verifyDocument(await response.json().catch(() => undefined), this.options.enrollment.keys)
    if (!verified.ok) throw new SessionError('invalid-response', 'desired state signature ' + verified.path + ' ' + verified.reason)
    const state = validateDesiredState(verified.value)
    if (!state.ok) throw new SessionError('invalid-response', 'desired state ' + state.path + ' ' + state.reason)
    if (state.value.organization.id !== this.options.enrollment.organization.id) {
      throw new SessionError('invalid-response', 'desired state is for another organisation')
    }
    return state.value
  }

  async reportStatus(report: StatusReport): Promise<void> {
    await this.call('POST', API.status, report)
  }

  /** Wait (about a minute at most) for the server to say the document may have changed. */
  async watch(revision: number): Promise<WatchResponse> {
    const response = await this.call('GET', API.watch, undefined, { query: '?revision=' + String(revision), timeoutMs: 90_000 })
    const body = await response.json().catch(() => ({})) as Partial<WatchResponse>
    return { revision: typeof body.revision === 'number' ? body.revision : revision, changed: body.changed === true }
  }

  /** The organisation's skill library and which of its skills this person has. */
  async listSkills(): Promise<CompanySkill[]> {
    return skillList(await this.call('GET', API.skills))
  }

  /** Install or remove an optional skill; the next desired state carries the change. */
  async setSkill(id: string, installed: boolean): Promise<CompanySkill[]> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new SessionError('invalid-response', 'not a skill id')
    return skillList(await this.call('PUT', API.skills + '/' + id + '/subscription', { installed }))
  }

  async sendAudit(events: AuditEventInput[]): Promise<void> {
    if (events.length > 0) await this.call('POST', API.audit, { events })
  }

  /** Revoke the refresh token on the server (best effort) and forget it locally. */
  async signOut(): Promise<void> {
    const session = this.readSession()
    if (session !== undefined) {
      await this.fetch(new URL(API.logout, this.server), {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: session.refreshToken }).toString(), signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)
    }
    this.forgetSession()
  }

  /** Forget the device identity too: the next sign-in enrolls a new device. */
  forgetDevice(): void {
    this.forgetSession()
    rmSync(this.deviceFile, { force: true })
  }
}
