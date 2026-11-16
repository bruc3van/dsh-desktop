/**
 * The HTTP application: client API, sign-in pages, admin API and console.
 * @module @dsh-desktop-pro/server/app
 */

import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { createPublicKey } from 'node:crypto'
import {
  API, checkDeviceProof, DEVICE_ID_HEADER, DEVICE_PROOF_HEADER, DEVICE_PROOF_WINDOW_MS, ENROLLMENT_SCHEMA, PROTOCOL_VERSION,
  validateProfileSpec, type AuditBatch, type DiscoveryResponse, type SkillListResponse, type Enrollment, type EnrollRequest, type StatusReport, type WatchResponse,
} from '@dsh-desktop-pro/protocol'
import { queryAudit, verifyAudit } from './audit.ts'
import { createAuth, isLoopbackRedirect, type Auth } from './auth.ts'
import { messagePage, pageLanguage, signInPage } from './pages.ts'
import { createComposer, type Composer } from './compose.ts'
import type { ServerConfig } from './config.ts'
import { createSealer, newId } from './crypto.ts'
import { parseCsv } from './csv.ts'
import type { Db } from './db.ts'
import { createGateway } from './gateway.ts'
import {
  bearer, cookies, createRouter, HttpError, readForm, readJson, readText, redirect, securityHeaders, sendHtml, sendJson, setCookie, type Context,
} from './http.ts'
import { migrate } from './migrations.ts'
import { createMarket, type Market } from './market.ts'
import { createMetering, localDay, type Metering } from './metering.ts'
import { startRetention } from './retention.ts'
import { installProxy, PROXY_PREFIX } from './proxy.ts'
import { createStore, ROLES, type Role, type Store, type User } from './store.ts'

const CONSOLE_COOKIE = 'dsh_console'

export interface AppOptions {
  config: ServerConfig
  db: Db
  fetchImpl?: typeof fetch
}

export interface App {
  server: Server
  store: Store
  metering: Metering
  market: Market
  auth: Auth
  composer: Composer
  listen(): Promise<string>
  close(): Promise<void>
}

/** The same shape the CSV import accepts: one @, no spaces. Intranet domains need no dot. */
const EMAIL = /^[^@\s]+@[^@\s]+$/

/** Chinese wording for the reasons a browser sign-in step can stop; other codes keep their own message. */
const SIGN_IN_ERRORS_ZH: Record<string, string> = {
  not_a_member: '你的账号还没有开通 DSH Desktop Pro，请联系公司 IT 管理员添加。',
  user_disabled: '你的 DSH Desktop Pro 账号已被停用，请联系公司 IT 管理员。',
  not_an_administrator: '只有管理员和审计员可以打开控制台。',
  login_expired: '这个登录链接已过期，请回到 DSH Desktop Pro 重新点击登录。',
  login_state: '登录步骤不完整，请回到 DSH Desktop Pro 重新点击登录。',
  idp_error: '公司登录系统拒绝了这次登录，请重试，或联系公司 IT 管理员。',
  idp_token: '公司登录系统没有返回登录凭据，请稍后重试，或联系公司 IT 管理员。',
  idp_nonce: '登录校验没有通过，请回到 DSH Desktop Pro 重新点击登录。',
  oidc_disabled: '这台服务端没有配置公司登录，请联系公司 IT 管理员。',
}

function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new HttpError(400, 'invalid_' + field)
  return value.trim()
}

export async function createApp(options: AppOptions): Promise<App> {
  const { config, db } = options
  const fetchImpl = options.fetchImpl ?? fetch
  await migrate(db)
  const sealer = createSealer(config.secret)
  const store = createStore(db, config.tenant.id, sealer)
  await store.ensureTenant(config.tenant.name)
  const auth = createAuth(store, config, fetchImpl)
  const market = createMarket(db, store.tenantId, config, fetchImpl)
  const composer = createComposer(store, config, sealer, createGateway(config.gateway, fetchImpl, db, store.tenantId), market)
  const metering = createMetering(db, store.tenantId, sealer, config)
  const router = createRouter()
  /** The server's own address, named on browser pages so people can see who serves them. */
  const host = (): string => { try { return new URL(config.publicUrl).host } catch { return '' } }
  const secureCookies = config.publicUrl.startsWith('https:')
  /** Ends waiting long polls before the database closes. */
  let shuttingDown = false
  const stopRetention = startRetention(db, store.tenantId, config.retention)

  /**
   * The console authenticates with a cookie, so a change must come from the
   * console's own pages. Browsers name the page behind every write (Origin,
   * Sec-Fetch-Site); a write that another site's page sent is refused even
   * when SameSite let the cookie through. Scripts send neither header.
   */
  function crossSiteWrite(req: { method?: string; headers: Record<string, string | string[] | undefined> }, pathname: string): boolean {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || !pathname.startsWith('/admin/api/')) return false
    const origin = req.headers['origin']
    const site = req.headers['sec-fetch-site']
    // Read each time: tests (and the demo) learn their port only after start.
    if (typeof origin === 'string' && origin !== new URL(config.publicUrl).origin) return true
    return typeof site === 'string' && site !== 'same-origin' && site !== 'none'
  }

  // ---------- client API ----------

  router.get(API.discovery, async ({ res }) => {
    const tenant = await store.tenant()
    const body: DiscoveryResponse = { protocol: PROTOCOL_VERSION, organization: { id: tenant.id, name: tenant.name }, signIn: auth.signInMethods() }
    sendJson(res, 200, body)
  })

  router.get(API.authorize, async ({ req, res, url }) => {
    const lang = pageLanguage(req.headers['accept-language'])
    const zh = lang === 'zh'
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    if (url.searchParams.get('client_id') !== 'dsh-desktop-pro' || !isLoopbackRedirect(redirectUri)) {
      // Never redirect to an unverified address: show the error here.
      sendHtml(res, 400, messagePage(lang, zh ? '无法开始登录' : 'This sign-in link is not valid', zh ? '请回到 DSH Desktop Pro，从客户端里点击登录。' : 'Go back to DSH Desktop Pro and sign in from there.', host()))
      return
    }
    if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
      || (url.searchParams.get('code_challenge') ?? '').length < 43) {
      sendHtml(res, 400, messagePage(lang, zh ? '无法开始登录' : 'This sign-in link is not valid', zh ? '这个客户端版本发起的登录请求不完整（缺少 PKCE），请更新 DSH Desktop Pro 后重试。' : 'This client sent an incomplete request (PKCE is missing). Update DSH Desktop Pro and try again.', host()))
      return
    }
    const flow = await auth.startFlow('client', { redirect: redirectUri, state: url.searchParams.get('state') ?? '', challenge: url.searchParams.get('code_challenge') ?? '' })
    const methods = auth.signInMethods()
    // One real provider and no development login: go straight to it.
    if (methods.length === 1 && methods[0]?.id === 'oidc') { redirect(res, await auth.oidcRedirect(flow)); return }
    sendHtml(res, 200, signInPage({ organization: (await store.tenant()).name, flowId: flow.id, methods, devLogin: config.devLogin, audience: 'client', lang, host: host() }))
  })

  router.get('/v1/auth/start/oidc', async ({ res, url }) => {
    redirect(res, await auth.oidcRedirect(await auth.flow(url.searchParams.get('flow') ?? '')))
  })

  async function finishLogin(ctx: Context, done: { flow: Awaited<ReturnType<Auth['flow']>>; person: User }): Promise<void> {
    if (done.flow.kind === 'console') {
      const cookie = await auth.consoleSession(done.person)
      setCookie(ctx.res, CONSOLE_COOKIE, cookie, { secure: secureCookies, maxAge: config.refreshTokenDays * 86_400 })
      redirect(ctx.res, '/console/')
      return
    }
    redirect(ctx.res, await auth.issueCode(done.flow, done.person))
  }

  router.get('/v1/auth/oidc/callback', async (ctx) => { await finishLogin(ctx, await auth.oidcCallback(ctx.url.searchParams)) })
  router.post('/v1/auth/dev', async (ctx) => {
    const form = await readForm(ctx.req)
    await finishLogin(ctx, await auth.devLogin(form.get('flow') ?? '', str(form.get('email'), 'email')))
  })

  router.post(API.token, async ({ req, res }) => {
    sendJson(res, 200, await auth.token(await readForm(req)))
  })

  router.post(API.logout, async ({ req, res }) => {
    await auth.logout((await readForm(req)).get('refresh_token') ?? '')
    sendJson(res, 200, { ok: true })
  })

  async function signedIn(ctx: Context): Promise<{ person: User; sessionId: string }> {
    const found = await auth.authenticate(bearer(ctx.req))
    if (found === undefined) throw new HttpError(401, 'unauthorized')
    if (found.person.status !== 'active') throw new HttpError(403, 'user_disabled')
    return found
  }

  /** Proofs already accepted, until they expire: each one is good for a single request. */
  const usedProofs = new Map<string, number>()

  /**
   * Bearer token plus a proof from the device key the server enrolled. The
   * proof signs the body too, so the body is read here and handed back parsed.
   */
  async function device(ctx: Context): Promise<{ person: User; deviceId: string; body: unknown }> {
    const { person } = await signedIn(ctx)
    const raw = ctx.method === 'GET' || ctx.method === 'HEAD' ? '' : await readText(ctx.req, 1_000_000)
    const deviceId = String(ctx.req.headers[DEVICE_ID_HEADER] ?? '')
    const row = await db.get<{ user_id: string; public_key: string; status: string }>(
      'SELECT user_id, public_key, status FROM devices WHERE tenant_id = $1 AND id = $2', [store.tenantId, deviceId])
    if (row === undefined || row.user_id !== person.id) throw new HttpError(401, 'unknown_device')
    if (row.status !== 'active') throw new HttpError(403, 'device_revoked')
    const key = createPublicKey({ key: Buffer.from(row.public_key, 'base64'), format: 'der', type: 'spki' })
    const proof = String(ctx.req.headers[DEVICE_PROOF_HEADER] ?? '')
    const now = Date.now()
    if (!checkDeviceProof(key, proof, ctx.method, ctx.url.pathname, now, raw)) throw new HttpError(401, 'invalid_device_proof')
    if ((usedProofs.get(proof) ?? 0) > now) throw new HttpError(401, 'replayed_device_proof')
    for (const [seen, until] of usedProofs) if (until <= now) usedProofs.delete(seen)
    usedProofs.set(proof, now + DEVICE_PROOF_WINDOW_MS * 2)
    await db.run('UPDATE devices SET last_seen_at = $1 WHERE id = $2', [now, deviceId])
    let body: unknown = {}
    if (raw !== '') {
      try { body = JSON.parse(raw) as unknown } catch { throw new HttpError(400, 'invalid_json') }
    }
    return { person, deviceId, body }
  }

  router.post(API.devices, async (ctx) => {
    const { person } = await signedIn(ctx)
    const body = await readJson(ctx.req) as Partial<EnrollRequest>
    const publicKey = str(body.publicKey, 'public_key', 1024)
    try {
      const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
    } catch {
      throw new HttpError(400, 'invalid_public_key')
    }
    const id = newId('dev')
    const now = Date.now()
    await db.run('INSERT INTO devices (id, tenant_id, user_id, public_key, platform, arch, hostname, client_version, status, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)',
      [id, store.tenantId, person.id, publicKey, String(body.platform ?? '').slice(0, 40), String(body.arch ?? '').slice(0, 40),
        String(body.hostname ?? '').slice(0, 200), String(body.clientVersion ?? '').slice(0, 40), 'active', now])
    await store.audit({ actorType: 'user', actorId: person.id, action: 'device.enrolled', target: id, detail: { platform: String(body.platform ?? ''), hostname: String(body.hostname ?? '') } })
    sendJson(ctx.res, 200, { deviceId: id })
  })

  router.get(API.desiredState, async (ctx) => {
    const { person, deviceId } = await device(ctx)
    const { signed, fingerprint } = await composer.signedFor(person, deviceId)
    const served = await db.get<{ served_fingerprint: string | null }>('SELECT served_fingerprint FROM devices WHERE id = $1', [deviceId])
    await db.run('UPDATE devices SET served_revision = $1, served_fingerprint = $2 WHERE id = $3', [signed.payload.revision, fingerprint, deviceId])
    // Audited when the device is given something new, not on every fetch.
    if (served?.served_fingerprint !== fingerprint) {
      await store.audit({ actorType: 'device', actorId: person.id, action: 'desired-state.served', target: deviceId, detail: { revision: signed.payload.revision } })
    }
    sendJson(ctx.res, 200, signed)
  })

  /**
   * Long poll, so a change in the console reaches online devices within
   * seconds instead of at the next five-minute check. A device is woken when
   * what it should hold differs from what it was last given — a change for
   * someone else moves the revision but wakes nobody else. One query every two
   * seconds keeps it correct with several server instances behind one address;
   * the expected content is recomputed only when the revision moves.
   */
  router.get(API.watch, async (ctx) => {
    const { person, deviceId } = await device(ctx)
    const deadline = Date.now() + 50_000
    let closed = false
    ctx.res.on('close', () => { closed = true })
    let seenRevision = -1
    let expected: string | undefined
    for (;;) {
      if (shuttingDown) { if (!ctx.res.headersSent) sendJson(ctx.res, 503, { error: 'shutting_down' }); return }
      const row = await db.get<{ revision: number; device_status: string | null; served_fingerprint: string | null; person_status: string | null }>(
        'SELECT t.config_revision AS revision, d.status AS device_status, d.served_fingerprint AS served_fingerprint, u.status AS person_status FROM tenants t LEFT JOIN devices d ON d.id = $2 AND d.tenant_id = t.id LEFT JOIN users u ON u.id = $3 AND u.tenant_id = t.id WHERE t.id = $1',
        [store.tenantId, deviceId, person.id])
      const revision = row?.revision ?? 0
      if (revision !== seenRevision) {
        seenRevision = revision
        const current = await store.user(person.id)
        expected = current === undefined ? undefined : (await composer.expected([{ id: deviceId, user_id: person.id }])).get(deviceId)
      }
      const changed = row?.device_status !== 'active' || row.person_status !== 'active' || expected !== row.served_fingerprint
      if (changed || closed || Date.now() >= deadline) {
        if (!closed) sendJson(ctx.res, 200, { revision, changed } satisfies WatchResponse)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
      if (shuttingDown) continue
    }
  })

  router.post(API.status, async (ctx) => {
    const { person, deviceId, body } = await device(ctx)
    const report = body as Partial<StatusReport>
    const result = report.result === 'applied' || report.result === 'partial' || report.result === 'failed' ? report.result : 'failed'
    const problems = Array.isArray(report.problems) ? report.problems.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 500)).slice(0, 20) : []
    const revision = typeof report.revision === 'number' ? report.revision : null
    const before = await db.get<{ served_revision: number | null; served_fingerprint: string | null; applied_fingerprint: string | null; applied_result: string | null }>(
      'SELECT served_revision, served_fingerprint, applied_fingerprint, applied_result FROM devices WHERE id = $1', [deviceId])
    // The report names the revision it applied; it applied what was served if
    // that is the document last handed to this device. An older report (a
    // newer document is already on its way) leaves the record as it was.
    const applied = revision !== null && revision === before?.served_revision ? before.served_fingerprint : before?.applied_fingerprint ?? null
    await db.run("UPDATE devices SET applied_revision = $1, applied_result = $2, applied_problems = $3, applied_at = $4, client_version = $5, dsh_version = $6, mode = 'organization', applied_fingerprint = $7 WHERE id = $8", [
      revision, result, JSON.stringify(problems), Date.now(),
      String(report.clientVersion ?? '').slice(0, 40), String(report.dshVersion ?? '').slice(0, 40), applied, deviceId,
    ])
    // Audited when the outcome changes, not on every report.
    if (applied !== before?.applied_fingerprint || result !== before?.applied_result || result !== 'applied') {
      await store.audit({ actorType: 'device', actorId: person.id, action: 'desired-state.' + result, target: deviceId, detail: { revision, problems: problems.length } })
    }
    sendJson(ctx.res, 200, { ok: true })
  })

  router.post(API.audit, async (ctx) => {
    const { person, deviceId, body } = await device(ctx)
    const batch = body as Partial<AuditBatch>
    const events = Array.isArray(batch.events) ? batch.events.slice(0, 500) : []
    for (const event of events) {
      if (typeof event.action !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(event.action)) continue
      // The person switched this enrolled machine to personal mode (allowed by IT).
      if (event.action === 'mode.personal') await db.run("UPDATE devices SET mode = 'personal' WHERE id = $1", [deviceId])
      const at = Date.parse(String(event.at))
      await store.audit({
        actorType: 'user', actorId: person.id, action: 'client.' + event.action, source: 'client', target: typeof event.target === 'string' ? event.target.slice(0, 200) : deviceId,
        ...Number.isFinite(at) && { at },
        ...event.detail !== undefined && typeof event.detail === 'object' && { detail: event.detail },
      })
    }
    sendJson(ctx.res, 200, { accepted: events.length })
  })

  // ---------- console sign-in ----------

  router.get('/admin/login', async ({ req, res }) => {
    const flow = await auth.startFlow('console')
    sendHtml(res, 200, signInPage({ organization: (await store.tenant()).name, flowId: flow.id, methods: auth.signInMethods(), devLogin: config.devLogin, audience: 'console', lang: pageLanguage(req.headers['accept-language']), host: host() }))
  })

  router.post('/admin/api/session', async ({ req, res }) => {
    // The bootstrap token is only for the first administrator.
    const body = await readJson(req) as { token?: unknown }
    const session = await auth.bootstrapSession(typeof body.token === 'string' ? body.token : '')
    setCookie(res, CONSOLE_COOKIE, 'bootstrap:' + session, { secure: secureCookies, maxAge: 8 * 3600 })
    await store.audit({ actorType: 'admin', actorId: 'bootstrap', action: 'console.login', detail: { method: 'bootstrap-token' } })
    sendJson(res, 200, { ok: true })
  })

  router.post('/admin/api/logout', async ({ req, res }) => {
    const cookie = cookies(req)[CONSOLE_COOKIE] ?? ''
    await auth.consoleLogout(cookie.startsWith('bootstrap:') ? cookie.slice(10) : cookie)
    setCookie(res, CONSOLE_COOKIE, '', { secure: secureCookies, maxAge: 0 })
    sendJson(res, 200, { ok: true })
  })

  interface Admin { id: string; name: string; role: Role | 'bootstrap' }
  async function admin(ctx: Context, write = true): Promise<Admin> {
    const cookie = cookies(ctx.req)[CONSOLE_COOKIE] ?? bearer(ctx.req) ?? ''
    if (cookie.startsWith('bootstrap:')) {
      if (await auth.bootstrapValid(cookie.slice(10))) return { id: 'bootstrap', name: 'Bootstrap administrator', role: 'bootstrap' }
      throw new HttpError(401, 'unauthorized')
    }
    const person = await auth.consolePerson(cookie)
    if (person === undefined) throw new HttpError(401, 'unauthorized')
    // Auditors read everything and change nothing.
    if (write && person.role !== 'admin') throw new HttpError(403, 'read_only')
    return { id: person.id, name: person.name, role: person.role }
  }

  // ---------- admin API ----------

  router.get('/admin/api/me', async (ctx) => {
    const me = await admin(ctx, false)
    const tenant = await store.tenant()
    sendJson(ctx.res, 200, { ...me, organization: { id: tenant.id, name: tenant.name, revision: tenant.config_revision }, gateway: config.gateway.kind, gatewayCredential: config.gateway.credential, ...config.gateway.kind === 'direct' && { gatewayUrl: config.publicUrl + PROXY_PREFIX, ...config.gateway.upstreamUrl !== undefined && { upstream: new URL(config.gateway.upstreamUrl).host } }, timeZone: config.timeZone, today: localDay(Date.now(), config.timeZone) })
  })

  router.get('/admin/api/users', async (ctx) => { await admin(ctx, false); sendJson(ctx.res, 200, await store.users()) })

  router.post('/admin/api/users', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { name?: unknown; email?: unknown; role?: unknown; departmentId?: unknown }
    const role = (ROLES as readonly unknown[]).includes(body.role) ? body.role as Role : 'member'
    const name = str(body.name, 'name')
    // The e-mail is how sign-in finds this person: a mistyped one locks them out silently.
    const email = typeof body.email === 'string' && body.email.trim() !== '' ? body.email.trim().toLowerCase() : null
    if (email !== null && (email.length > 254 || !EMAIL.test(email))) throw new HttpError(400, 'invalid_email')
    if (email !== null && await store.userByEmail(email) !== undefined) throw new HttpError(409, 'email_taken')
    const person = await store.createUser({ name, email, role, departmentId: typeof body.departmentId === 'string' && body.departmentId !== '' ? body.departmentId : null })
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'user.created', target: person.id, detail: { role } })
    sendJson(ctx.res, 200, person)
  })

  router.patch('/admin/api/users/:id', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { role?: unknown; status?: unknown; departmentId?: unknown; name?: unknown }
    const patch: Parameters<Store['updateUser']>[1] = {}
    if (body.role !== undefined) { if (!(ROLES as readonly unknown[]).includes(body.role)) throw new HttpError(400, 'invalid_role'); patch.role = body.role as Role }
    if (body.status !== undefined) { if (body.status !== 'active' && body.status !== 'disabled') throw new HttpError(400, 'invalid_status'); patch.status = body.status }
    if (body.departmentId !== undefined) patch.departmentId = typeof body.departmentId === 'string' && body.departmentId !== '' ? body.departmentId : null
    if (body.name !== undefined) patch.name = str(body.name, 'name')
    const person = await store.updateUser(ctx.params['id'] ?? '', patch)
    if (patch.status === 'disabled') {
      // Off-boarding: sessions end now, the gateway key stops working now,
      // and devices are told to remove the organisation's configuration.
      await auth.revokeUserSessions(person.id)
      await composer.revokeGatewayKey(person.id)
      await db.run("UPDATE devices SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2", [store.tenantId, person.id])
    }
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'user.updated', target: person.id, detail: patch as Record<string, unknown> })
    sendJson(ctx.res, 200, person)
  })

  /** CSV columns: name,email,department[,role] — department as a path like Finance/Payables. */
  router.post('/admin/api/users/import', async (ctx) => {
    const me = await admin(ctx)
    const rows = parseCsv(await readText(ctx.req))
    const header = rows[0]?.map(cell => cell.trim().toLowerCase()) ?? []
    const column = (name: string): number => header.indexOf(name)
    if (column('name') < 0 || column('email') < 0) throw new HttpError(400, 'csv_header', 'The first row must name the columns: name,email,department,role')
    let created = 0
    let updated = 0
    const errors: string[] = []
    for (const [index, row] of rows.slice(1).entries()) {
      const name = row[column('name')]?.trim() ?? ''
      const email = row[column('email')]?.trim().toLowerCase() ?? ''
      const role = (row[column('role')]?.trim() || 'member') as Role
      if (name === '' || !EMAIL.test(email) || !ROLES.includes(role)) { errors.push('row ' + String(index + 2) + ': invalid name, email or role'); continue }
      const departmentId = column('department') >= 0 && (row[column('department')]?.trim() ?? '') !== '' ? await store.departmentByPath(row[column('department')] ?? '') : null
      const existing = await store.userByEmail(email)
      if (existing === undefined) { await store.createUser({ name, email, role, departmentId }); created += 1 }
      else { await store.updateUser(existing.id, { name, role, departmentId }); updated += 1 }
    }
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'users.imported', detail: { created, updated, errors: errors.length } })
    sendJson(ctx.res, 200, { created, updated, errors })
  })

  router.get('/admin/api/departments', async (ctx) => { await admin(ctx, false); sendJson(ctx.res, 200, await store.departments()) })
  router.post('/admin/api/departments', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { name?: unknown; parentId?: unknown }
    const department = await store.createDepartment(str(body.name, 'name'), typeof body.parentId === 'string' && body.parentId !== '' ? body.parentId : null)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'department.created', target: department.id })
    sendJson(ctx.res, 200, department)
  })

  router.get('/admin/api/profiles', async (ctx) => { await admin(ctx, false); sendJson(ctx.res, 200, await store.profiles()) })
  router.post('/admin/api/profiles', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { name?: unknown; description?: unknown; spec?: unknown }
    const profile = await store.createProfile({ name: str(body.name, 'name'), ...typeof body.description === 'string' && { description: body.description }, spec: body.spec ?? {} }, me.id)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'profile.created', target: profile.id })
    sendJson(ctx.res, 200, profile)
  })
  router.get('/admin/api/profiles/:id', async (ctx) => {
    await admin(ctx, false)
    const profile = await store.profile(ctx.params['id'] ?? '')
    if (profile === undefined) throw new HttpError(404, 'profile_not_found')
    sendJson(ctx.res, 200, { ...profile, versions: await store.profileVersions(profile.id) })
  })
  router.put('/admin/api/profiles/:id', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { spec?: unknown; note?: unknown; name?: unknown; description?: unknown }
    const profile = await store.updateProfile(ctx.params['id'] ?? '', {
      spec: body.spec ?? {}, ...typeof body.note === 'string' && { note: body.note.slice(0, 500) },
      ...typeof body.name === 'string' && { name: body.name }, ...typeof body.description === 'string' && { description: body.description },
    }, me.id)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'profile.updated', target: profile.id, detail: { version: profile.current_version } })
    sendJson(ctx.res, 200, profile)
  })
  /** Rollback writes the chosen version's spec as a new version: history stays linear. */
  router.post('/admin/api/profiles/:id/rollback', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { version?: unknown }
    const versions = await store.profileVersions(ctx.params['id'] ?? '')
    const target = versions.find(entry => entry.version === body.version)
    if (target === undefined) throw new HttpError(404, 'version_not_found')
    const profile = await store.updateProfile(ctx.params['id'] ?? '', { spec: target.spec, note: 'rollback to v' + String(target.version) }, me.id)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'profile.rolled-back', target: profile.id, detail: { to: target.version, version: profile.current_version } })
    sendJson(ctx.res, 200, profile)
  })
  router.post('/admin/api/profiles/validate', async (ctx) => {
    await admin(ctx, false)
    const result = validateProfileSpec(await readJson(ctx.req))
    sendJson(ctx.res, 200, result.ok ? { ok: true } : result)
  })

  router.get('/admin/api/bindings', async (ctx) => { await admin(ctx, false); sendJson(ctx.res, 200, await store.bindings()) })
  router.post('/admin/api/bindings', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as { profileId?: unknown; targetType?: unknown; targetId?: unknown; priority?: unknown }
    const binding = await store.bind({
      profileId: str(body.profileId, 'profile'), targetType: str(body.targetType, 'target_type') as 'tenant' | 'department' | 'user',
      targetId: typeof body.targetId === 'string' ? body.targetId : '', ...typeof body.priority === 'number' && { priority: body.priority },
    })
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'binding.created', target: binding.id, detail: { profile: binding.profile_id, targetType: binding.target_type, targetId: binding.target_id } })
    sendJson(ctx.res, 200, binding)
  })
  router.delete('/admin/api/bindings/:id', async (ctx) => {
    const me = await admin(ctx)
    await store.unbind(ctx.params['id'] ?? '')
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'binding.deleted', target: ctx.params['id'] ?? '' })
    sendJson(ctx.res, 200, { ok: true })
  })

  /** What one person would receive now — credentials masked. */
  router.get('/admin/api/users/:id/desired-state', async (ctx) => {
    await admin(ctx, false)
    const person = await store.user(ctx.params['id'] ?? '')
    if (person === undefined) throw new HttpError(404, 'user_not_found')
    const state = await composer.compose(person)
    if (state.credentials !== undefined) state.credentials = Object.fromEntries(Object.keys(state.credentials).map(name => [name, '••••••']))
    sendJson(ctx.res, 200, state)
  })

  router.get('/admin/api/devices', async (ctx) => {
    await admin(ctx, false)
    const rows = await db.all('SELECT d.id AS id, d.user_id AS user_id, u.name AS user_name, d.platform AS platform, d.arch AS arch, d.hostname AS hostname, d.client_version AS client_version, d.dsh_version AS dsh_version, d.status AS status, d.applied_revision AS applied_revision, d.applied_result AS applied_result, d.applied_problems AS applied_problems, d.applied_at AS applied_at, d.served_revision AS served_revision, d.last_seen_at AS last_seen_at, d.created_at AS created_at, d.mode AS mode FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.tenant_id = $1 ORDER BY d.last_seen_at DESC', [store.tenantId])
    const fingerprints = await db.all<{ id: string; user_id: string; applied_fingerprint: string | null }>(
      "SELECT id, user_id, applied_fingerprint FROM devices WHERE tenant_id = $1 AND status = 'active'", [store.tenantId])
    const expected = await composer.expected(fingerprints)
    const inSync = new Map(fingerprints.map(row => [row.id, row.applied_fingerprint !== null && row.applied_fingerprint === expected.get(row.id)]))
    sendJson(ctx.res, 200, rows.map(row => ({
      ...row,
      applied_problems: typeof row['applied_problems'] === 'string' ? JSON.parse(row['applied_problems']) as unknown : [],
      // Whether the device holds what its person should have now: per device, not the organisation-wide revision.
      in_sync: inSync.get(String(row['id'])) === true,
    })))
  })
  router.post('/admin/api/devices/:id/revoke', async (ctx) => {
    const me = await admin(ctx)
    const id = ctx.params['id'] ?? ''
    if ((await db.run("UPDATE devices SET status = 'revoked' WHERE tenant_id = $1 AND id = $2", [store.tenantId, id])) === 0) throw new HttpError(404, 'device_not_found')
    // The device's gateway key stops working now, wherever a copy of it went.
    await composer.revokeDeviceKey(id)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'device.revoked', target: id })
    sendJson(ctx.res, 200, { ok: true })
  })

  router.get('/admin/api/audit', async (ctx) => {
    await admin(ctx, false)
    const q = ctx.url.searchParams
    const number = (name: string): number | undefined => (q.get(name) === null || q.get(name) === '' ? undefined : Number(q.get(name)))
    sendJson(ctx.res, 200, await queryAudit(db, store.tenantId, {
      ...q.get('action') !== null && { action: q.get('action') ?? '' }, ...q.get('actor') !== null && { actorId: q.get('actor') ?? '' },
      ...number('since') !== undefined && { since: number('since') }, ...number('until') !== undefined && { until: number('until') },
      ...number('limit') !== undefined && { limit: number('limit') }, ...number('before') !== undefined && { beforeSeq: number('before') },
    }))
  })
  router.get('/admin/api/audit/verify', async (ctx) => { await admin(ctx, false); sendJson(ctx.res, 200, await verifyAudit(db, store.tenantId)) })

  /** The file IT distributes with the installer. */
  router.get('/admin/api/enrollment', async (ctx) => {
    await admin(ctx, false)
    const tenant = await store.tenant()
    const enrollment: Enrollment = { schema: ENROLLMENT_SCHEMA, version: 1, server: config.publicUrl, organization: { id: tenant.id, name: tenant.name }, keys: await store.publicKeys() }
    // IT decides per distribution whether employees may opt out to personal mode.
    if (ctx.url.searchParams.get('personal') === '1') enrollment.allowPersonal = true
    ctx.res.setHeader('content-disposition', 'attachment; filename="enrollment.json"')
    sendJson(ctx.res, 200, enrollment)
  })

  /** Built-in gateway: requests per person over the last days. */
  router.get('/admin/api/usage', async (ctx) => {
    await admin(ctx, false)
    const days = Math.min(Math.max(Number(ctx.url.searchParams.get('days') ?? 30) || 30, 1), 365)
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    const rows = await db.all<{ user_id: string; day: string; requests: number; prompt_tokens: number; completion_tokens: number }>(
      'SELECT user_id, day, requests, prompt_tokens, completion_tokens FROM gateway_usage WHERE tenant_id = $1 AND day >= $2 ORDER BY day', [store.tenantId, since])
    sendJson(ctx.res, 200, { since, rows: rows.map(row => ({ ...row, requests: Number(row.requests), prompt_tokens: Number(row.prompt_tokens), completion_tokens: Number(row.completion_tokens) })) })
  })

  // ---------- model catalog, usage and limits (built-in gateway) ----------

  const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
  const shiftDay = (day: string, days: number): string => new Date(Date.parse(day + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10)
  /** Range and filters from the query string; the last 30 days by default. */
  async function usageFilter(ctx: Context): Promise<Parameters<Metering['summary']>[0]> {
    const query = ctx.url.searchParams
    const today = localDay(Date.now(), config.timeZone)
    const to = DAY_PATTERN.test(query.get('to') ?? '') ? query.get('to') as string : today
    const from = DAY_PATTERN.test(query.get('from') ?? '') ? query.get('from') as string : shiftDay(to, -29)
    const filter: Parameters<Metering['summary']>[0] = { from: from <= to ? from : to, to }
    if (query.get('user')) filter.userId = query.get('user') as string
    if (query.get('department')) filter.departmentIds = await metering.subtree(query.get('department') as string)
    if (query.get('model')) filter.model = query.get('model') as string
    if (query.get('client')) filter.client = query.get('client') as string
    if (query.get('status')) filter.status = query.get('status') as string
    return filter
  }

  router.get('/admin/api/catalog', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, { upstreams: await metering.upstreams(), models: await metering.models() })
  })
  router.post('/admin/api/catalog/upstreams', async (ctx) => {
    const me = await admin(ctx)
    const saved = await metering.saveUpstream(undefined, await readJson(ctx.req) as Record<string, unknown>)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'catalog.upstream.created', target: saved.id, detail: { name: saved.name, baseUrl: saved.baseUrl } })
    sendJson(ctx.res, 200, saved)
  })
  router.patch('/admin/api/catalog/upstreams/:id', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as Record<string, unknown>
    const saved = await metering.saveUpstream(ctx.params['id'], body)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'catalog.upstream.updated', target: saved.id, detail: { name: saved.name, baseUrl: saved.baseUrl, keyChanged: typeof body['apiKey'] === 'string' && body['apiKey'] !== '' } })
    sendJson(ctx.res, 200, saved)
  })
  router.delete('/admin/api/catalog/upstreams/:id', async (ctx) => {
    const me = await admin(ctx)
    await metering.deleteUpstream(ctx.params['id'] ?? '')
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'catalog.upstream.deleted', target: ctx.params['id'] })
    sendJson(ctx.res, 200, { ok: true })
  })
  /** Reach the upstream with its key and list what it serves. */
  router.post('/admin/api/catalog/upstreams/:id/test', async (ctx) => {
    await admin(ctx)
    const target = await metering.upstreamTarget(ctx.params['id'] ?? '')
    if (target === undefined) throw new HttpError(404, 'upstream_not_found')
    const started = Date.now()
    try {
      const response = await fetchImpl(target.url + '/models', { headers: target.key === undefined ? {} : { authorization: 'Bearer ' + target.key }, signal: AbortSignal.timeout(10_000) })
      const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null
      const models = (body?.data ?? []).map(item => item.id).filter((id): id is string => typeof id === 'string').slice(0, 200)
      sendJson(ctx.res, 200, { ok: response.ok, status: response.status, ms: Date.now() - started, models })
    } catch (error) {
      sendJson(ctx.res, 200, { ok: false, ms: Date.now() - started, models: [], error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.put('/admin/api/catalog/models/:id', async (ctx) => {
    const me = await admin(ctx)
    const saved = await metering.saveModel(ctx.params['id'] ?? '', await readJson(ctx.req) as Record<string, unknown>)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'catalog.model.saved', target: saved.id, detail: { upstream: saved.upstreamId, upstreamModel: saved.upstreamModel, prices: saved.prices, enabled: saved.enabled } })
    sendJson(ctx.res, 200, saved)
  })
  router.delete('/admin/api/catalog/models/:id', async (ctx) => {
    const me = await admin(ctx)
    await metering.deleteModel(ctx.params['id'] ?? '')
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'catalog.model.deleted', target: ctx.params['id'] })
    sendJson(ctx.res, 200, { ok: true })
  })

  router.get('/admin/api/usage/summary', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, await metering.summary(await usageFilter(ctx)))
  })
  router.get('/admin/api/usage/requests', async (ctx) => {
    await admin(ctx, false)
    const before = Number(ctx.url.searchParams.get('before') ?? '')
    sendJson(ctx.res, 200, await metering.requests(await usageFilter(ctx), Number(ctx.url.searchParams.get('limit') ?? 50) || 50, Number.isFinite(before) && before > 0 ? before : undefined))
  })
  /** Every request in the range as CSV, for finance and compliance. Metadata only: no prompts or replies. */
  router.get('/admin/api/usage/export', async (ctx) => {
    const me = await admin(ctx, false)
    const filter = await usageFilter(ctx)
    const rows = await metering.requests(filter, 100_000)
    const people = new Map((await store.users()).map(user => [user.id, user]))
    const departments = new Map((await store.departments()).map(department => [department.id, department.name]))
    const cell = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\n\r]/.test(text) || /^[=+\-@]/.test(text) ? '"' + text.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : text
    }
    const header = ['time', 'member', 'email', 'department', 'model', 'served_model', 'fallback_from', 'upstream', 'client', 'endpoint', 'stream', 'status', 'http_status', 'error', 'stop_reason',
      'input_tokens', 'cache_read_tokens', 'output_tokens', 'reasoning_tokens', 'cost_yuan', 'ttft_ms', 'duration_ms']
    const lines = [header.join(',')]
    for (const row of rows) {
      const person = people.get(String(row['user_id']))
      lines.push([new Date(Number(row['started_at'])).toISOString(), person?.name ?? row['user_id'], person?.email ?? '', departments.get(String(row['department_id'])) ?? '',
        row['model'], row['served_model'], row['fallback_from'], row['upstream_id'], row['client'], row['endpoint'], Number(row['stream']) === 1 ? 'yes' : 'no', row['status'], row['http_status'],
        row['error'], row['stop_reason'], row['input_tokens'], row['cache_read_tokens'], row['output_tokens'], row['reasoning_tokens'],
        row['cost_micros'] === null ? '' : (Number(row['cost_micros']) / 1_000_000).toFixed(6), row['ttft_ms'], row['duration_ms']].map(cell).join(','))
    }
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'usage.exported', detail: { from: filter.from, to: filter.to, rows: rows.length } })
    ctx.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dsh-usage-' + filter.from + '-' + filter.to + '.csv"' })
    ctx.res.end('\ufeff' + lines.join('\r\n') + '\r\n')
  })

  router.get('/admin/api/quotas', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, await metering.overview())
  })
  router.post('/admin/api/quotas', async (ctx) => {
    const me = await admin(ctx)
    const saved = await metering.saveQuota(undefined, await readJson(ctx.req) as Record<string, unknown>)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'quota.created', target: saved.id, detail: { ...saved } })
    sendJson(ctx.res, 200, saved)
  })
  router.patch('/admin/api/quotas/:id', async (ctx) => {
    const me = await admin(ctx)
    const saved = await metering.saveQuota(ctx.params['id'], await readJson(ctx.req) as Record<string, unknown>)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'quota.updated', target: saved.id, detail: { ...saved } })
    sendJson(ctx.res, 200, saved)
  })
  router.delete('/admin/api/quotas/:id', async (ctx) => {
    const me = await admin(ctx)
    await metering.deleteQuota(ctx.params['id'] ?? '')
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'quota.deleted', target: ctx.params['id'] })
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get('/admin/api/users/:id/quotas', async (ctx) => {
    await admin(ctx, false)
    const person = await store.user(ctx.params['id'] ?? '')
    if (person === undefined) throw new HttpError(404, 'user_not_found')
    sendJson(ctx.res, 200, await metering.statusFor(person))
  })

  // ---------- organisation market ----------

  /** The approved plugins as a format 1 index, for the person the token names. */
  router.get('/v1/market/:token/index.json', async (ctx) => {
    const userId = market.tokenUser(ctx.params['token'] ?? '')
    const person = userId === undefined ? undefined : await store.user(userId)
    if (person === undefined || person.status !== 'active') throw new HttpError(404, 'not_found')
    const tenant = await store.tenant()
    ctx.res.setHeader('cache-control', 'private, max-age=60')
    sendJson(ctx.res, 200, await market.index(tenant.name))
  })

  router.get(API.skills, async (ctx) => {
    const { person } = await device(ctx)
    sendJson(ctx.res, 200, { skills: await market.skillsForClient(person.id) } satisfies SkillListResponse)
  })
  router.put(API.skills + '/:id/subscription', async (ctx) => {
    const { person, deviceId, body: payload } = await device(ctx)
    const body = payload as { installed?: unknown }
    if (typeof body.installed !== 'boolean') throw new HttpError(400, 'invalid_installed')
    const id = ctx.params['id'] ?? ''
    if (await market.subscribe(person.id, id, body.installed)) {
      await store.bumpRevision()
      await store.audit({ actorType: 'user', actorId: person.id, action: body.installed ? 'skill.installed' : 'skill.removed', target: id, detail: { device: deviceId } })
    }
    sendJson(ctx.res, 200, { skills: await market.skillsForClient(person.id) } satisfies SkillListResponse)
  })

  router.get('/admin/api/market', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, { plugins: await market.plugins(), sources: await market.sources() })
  })
  /** The index as employees' clients read it. */
  router.get('/admin/api/market/index', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, await market.index((await store.tenant()).name))
  })
  router.post('/admin/api/market/sources', async (ctx) => {
    const me = await admin(ctx)
    const source = await market.addSource(await readJson(ctx.req) as Record<string, unknown>)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'market.source.added', target: source.id, detail: { url: source.url, plugins: source.pluginCount } })
    sendJson(ctx.res, 200, source)
  })
  router.post('/admin/api/market/sources/:id/refresh', async (ctx) => {
    await admin(ctx)
    sendJson(ctx.res, 200, await market.refreshSource(ctx.params['id'] ?? ''))
  })
  router.delete('/admin/api/market/sources/:id', async (ctx) => {
    const me = await admin(ctx)
    await market.deleteSource(ctx.params['id'] ?? '')
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'market.source.removed', target: ctx.params['id'] })
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get('/admin/api/market/sources/:id/plugins', async (ctx) => {
    await admin(ctx, false)
    const query = ctx.url.searchParams
    const offset = Math.max(0, Math.floor(Number(query.get('offset') ?? 0)) || 0)
    sendJson(ctx.res, 200, await market.browse(ctx.params['id'] ?? '', (query.get('q') ?? '').slice(0, 200), offset, 20))
  })
  router.post('/admin/api/market/plugins', async (ctx) => {
    const me = await admin(ctx)
    const body = await readJson(ctx.req) as Record<string, unknown>
    const previous = typeof body['name'] === 'string' ? await market.plugin(body['name']) : undefined
    const saved = await market.approve(body, me.id)
    await store.bumpRevision()
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'market.plugin.approved', target: saved.name, detail: {
      version: saved.version?.version ?? '', source: saved.version?.source.type ?? '', ...previous?.version !== undefined && { previous: previous.version.version },
      ...saved.note !== null && { note: saved.note.slice(0, 200) },
    } })
    sendJson(ctx.res, 200, saved)
  })
  router.patch('/admin/api/market/plugins/:name', async (ctx) => {
    const me = await admin(ctx)
    const saved = await market.update(ctx.params['name'] ?? '', await readJson(ctx.req) as Record<string, unknown>, me.id)
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'market.plugin.updated', target: saved.name, detail: { featured: saved.featured } })
    sendJson(ctx.res, 200, saved)
  })
  router.post('/admin/api/market/blocked', async (ctx) => {
    const me = await admin(ctx)
    const saved = await market.block(await readJson(ctx.req) as Record<string, unknown>, me.id)
    await store.bumpRevision()
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'market.plugin.blocked', target: saved.name, detail: saved.note === null ? {} : { note: saved.note.slice(0, 200) } })
    sendJson(ctx.res, 200, saved)
  })
  router.delete('/admin/api/market/plugins/:name', async (ctx) => {
    const me = await admin(ctx)
    const name = ctx.params['name'] ?? ''
    const previous = await market.plugin(name)
    await market.remove(name)
    await store.bumpRevision()
    await store.audit({ actorType: 'admin', actorId: me.id, action: previous?.status === 'blocked' ? 'market.plugin.unblocked' : 'market.plugin.removed', target: name })
    sendJson(ctx.res, 200, { ok: true })
  })

  router.get('/admin/api/skills', async (ctx) => {
    await admin(ctx, false)
    sendJson(ctx.res, 200, (await market.skills()).map(({ files, ...item }) => ({ ...item, files: Object.keys(files) })))
  })
  router.get('/admin/api/skills/:id', async (ctx) => {
    await admin(ctx, false)
    const found = await market.skill(ctx.params['id'] ?? '')
    if (found === undefined) throw new HttpError(404, 'skill_not_found')
    sendJson(ctx.res, 200, { ...found, subscriberIds: await market.subscribers(found.id) })
  })
  router.put('/admin/api/skills/:id', async (ctx) => {
    const me = await admin(ctx)
    const result = await market.saveSkill(ctx.params['id'] ?? '', await readJson(ctx.req, 3_000_000) as Record<string, unknown>, me.id)
    await store.bumpRevision()
    await store.audit({ actorType: 'admin', actorId: me.id, action: result.created ? 'skill.created' : 'skill.updated', target: result.skill.id, detail: {
      version: result.skill.version, distribution: result.skill.distribution, files: Object.keys(result.skill.files).length,
    } })
    sendJson(ctx.res, 200, result.skill)
  })
  router.delete('/admin/api/skills/:id', async (ctx) => {
    const me = await admin(ctx)
    await market.deleteSkill(ctx.params['id'] ?? '')
    await store.bumpRevision()
    await store.audit({ actorType: 'admin', actorId: me.id, action: 'skill.deleted', target: ctx.params['id'] })
    sendJson(ctx.res, 200, { ok: true })
  })

  installProxy(router, store, config, fetchImpl, metering)

  // ---------- console static files ----------

  const consoleDir = config.consoleDir ?? join(import.meta.dirname, '..', '..', 'console')
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
  async function serveConsole(ctx: Context): Promise<void> {
    const relative = ctx.url.pathname.replace(/^\/console\/?/, '') || 'index.html'
    const file = normalize(join(consoleDir, relative))
    if (!file.startsWith(normalize(consoleDir) + sep)) throw new HttpError(404, 'not_found')
    let body: Buffer
    try { body = await readFile(file) } catch { throw new HttpError(404, 'not_found') }
    ctx.res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    ctx.res.end(body)
  }
  router.get('/console', ({ res }) => { redirect(res, '/console/') })
  router.get('/console/', serveConsole)
  router.get('/console/:file', serveConsole)
  router.get('/', ({ res }) => { redirect(res, '/console/') })
  router.get('/healthz', async ({ res }) => { await db.get('SELECT 1 AS ok'); sendJson(res, 200, { ok: true }) })

  const server = createServer((req, res) => {
    securityHeaders(res)
    const url = new URL(req.url ?? '/', config.publicUrl)
    const method = (req.method ?? 'GET').toUpperCase()
    const found = router.match(method, url.pathname)
    if (found === undefined) { sendJson(res, 404, { error: 'not_found' }); return }
    if (found === 'method') { sendJson(res, 405, { error: 'method_not_allowed' }); return }
    if (crossSiteWrite(req, url.pathname)) { sendJson(res, 403, { error: 'cross_site_request' }); return }
    Promise.resolve(found.handler({ req, res, url, params: found.params, method })).catch((error: unknown) => {
      if (res.headersSent) { res.end(); return }
      if (error instanceof HttpError) {
        // Browser-facing sign-in steps answer with a page; APIs answer with JSON.
        const browserStep = (method === 'GET' && (url.pathname.startsWith('/v1/auth/') || url.pathname === '/admin/login'))
          || (method === 'POST' && url.pathname === '/v1/auth/dev')
        if (browserStep) {
          const lang = pageLanguage(req.headers['accept-language'])
          const reason = lang === 'zh' ? SIGN_IN_ERRORS_ZH[error.code] ?? error.message : error.message
          sendHtml(res, error.status, messagePage(lang, lang === 'zh' ? '登录没有完成' : 'Sign-in did not complete', reason, host()))
        }
        else sendJson(res, error.status, { error: error.code, message: error.message })
        return
      }
      console.error('[server]', error)
      sendJson(res, 500, { error: 'internal' })
    })
  })

  return {
    server, store, metering, market, auth, composer,
    listen: () => new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        const address = server.address()
        resolve('http://' + (config.host === '0.0.0.0' ? '127.0.0.1' : config.host) + ':' + String(typeof address === 'object' && address !== null ? address.port : config.port))
      })
    }),
    close: async () => {
      shuttingDown = true
      stopRetention()
      const closing = new Promise<void>(resolve => { server.close(() => { resolve() }) })
      // Long polls wake every two seconds; idle keep-alive sockets close now.
      server.closeIdleConnections()
      await closing
      await db.close()
    },
  }
}
