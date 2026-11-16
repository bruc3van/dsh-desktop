/**
 * Identity sources (ADR-0008) against local stand-ins for the Feishu, DingTalk
 * and WeCom APIs: the directory sync engine, and sign-in through each
 * platform.
 *
 * The stand-ins implement the documented endpoints and shapes; they show that
 * the connectors call them as documented and that the engine does the right
 * thing with the answers. They cannot show the platforms still answer that
 * way: a real tenant is the test for that.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'

const work = mkdtempSync(join(tmpdir(), 'dsh-directory-check-'))

/** A tiny HTTP stand-in: handlers by "METHOD /path", JSON in and out. */
async function standIn(routes) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x')
      const handler = routes[req.method + ' ' + url.pathname]
      if (handler === undefined) { res.writeHead(404).end('{}'); return }
      const answer = await handler({ url, body: body === '' ? {} : JSON.parse(body), headers: req.headers })
      if (answer?.redirect !== undefined) { res.writeHead(302, { location: answer.redirect }).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + String(server.address().port) }
}

async function startServer(env, name) {
  const config = loadConfig({
    DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'x'.repeat(40), PORT: '0', HOST: '127.0.0.1',
    DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_GATEWAY: 'none', DSH_BOOTSTRAP_TOKEN: 'boot',
    DSH_DIRECTORY_MAX_DISABLE_PERCENT: '20', ...env,
  })
  // DSH_CHECK_DATABASE_URL=postgres://… runs the same checks against PostgreSQL (needs an empty database per platform; see CI).
  const database = process.env.DSH_CHECK_DATABASE_URL === undefined ? 'sqlite:' + join(work, name + '.sqlite') : process.env.DSH_CHECK_DATABASE_URL.replace(/\/[^/]*$/, '/check_directory_' + name)
  const app = await createApp({ config, db: await openDb(database) })
  // The checks drive every run themselves.
  await app.directory.stop()
  const base = await app.listen()
  config.publicUrl = base
  const login = await fetch(base + '/admin/api/session', { method: 'POST', body: JSON.stringify({ token: 'boot' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const admin = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { cookie, ...body !== undefined && { 'content-type': 'application/json' } }, ...body !== undefined && { body: JSON.stringify(body) } })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  return { app, base, admin }
}

/** The desktop client's sign-in walked by fetch: where does it end? */
async function signIn(base) {
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(base + '/v1/auth/authorize')
  authorize.search = new URLSearchParams({
    client_id: 'dsh-desktop-pro', response_type: 'code', code_challenge_method: 'S256', state: 'xyz',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), redirect_uri: 'http://127.0.0.1:5599/callback',
  }).toString()
  let response = await fetch(authorize, { redirect: 'manual' })
  for (let hops = 0; hops < 6 && response.status === 302; hops += 1) {
    const location = response.headers.get('location')
    if (location.startsWith('http://127.0.0.1:5599/')) return { signedIn: true }
    response = await fetch(location, { redirect: 'manual' })
  }
  return { signedIn: false, status: response.status, page: await response.text() }
}

const userByName = async (app, name) => (await app.store.users()).find(user => user.name === name)
const servers = []

try {
  // ======================= Feishu =======================
  const feishu = {
    departments: [
      { open_department_id: 'od-rd', name: '研发部', parent_department_id: '0' },
      { open_department_id: 'od-platform', name: '平台组', parent_department_id: 'od-rd' },
      { open_department_id: 'od-sales', name: '销售部', parent_department_id: '0' },
    ],
    users: {
      'on-zhang': { union_id: 'on-zhang', name: '张三', enterprise_email: 'zhang@acme.example', department_ids: ['od-platform'], status: {} },
      'on-li': { union_id: 'on-li', name: '李四', email: 'li@acme.example', department_ids: ['od-sales'], status: {} },
      'on-wang': { union_id: 'on-wang', name: '王五', department_ids: ['od-rd'], status: {} },
      'on-zhao': { union_id: 'on-zhao', name: '赵六', department_ids: [], status: {} },
    },
    signingIn: 'on-zhang',
    codes: new Map(),
  }
  const feishuApi = await standIn({
    'POST /open-apis/auth/v3/tenant_access_token/internal': ({ body }) => {
      assert.deepEqual([body.app_id, body.app_secret], ['cli_test', 'feishu-secret'])
      return { code: 0, tenant_access_token: 't-feishu', expire: 7200 }
    },
    'GET /open-apis/contact/v3/departments/0/children': ({ url, headers }) => {
      assert.equal(headers.authorization, 'Bearer t-feishu')
      assert.equal(url.searchParams.get('fetch_child'), 'true')
      // Two pages, to exercise paging.
      const first = url.searchParams.get('page_token') === null
      return { code: 0, data: first ? { items: feishu.departments.slice(0, 2), has_more: true, page_token: 'p2' } : { items: feishu.departments.slice(2), has_more: false } }
    },
    'GET /open-apis/contact/v3/users/find_by_department': ({ url }) => {
      assert.equal(url.searchParams.get('user_id_type'), 'union_id')
      const department = url.searchParams.get('department_id')
      const items = Object.values(feishu.users).filter(user => department === '0' ? user.department_ids.length === 0 : user.department_ids.includes(department))
      return { code: 0, data: { items, has_more: false } }
    },
    'POST /open-apis/authen/v2/oauth/token': ({ body }) => {
      const grant = feishu.codes.get(body.code)
      assert.ok(grant, 'a code Feishu issued')
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), grant.challenge, 'PKCE verifier matches')
      return { code: 0, access_token: 'u-' + grant.who }
    },
    'GET /open-apis/authen/v1/user_info': ({ headers }) => {
      const who = headers.authorization.replace('Bearer u-', '')
      return { code: 0, data: { union_id: who, name: feishu.users[who]?.name ?? 'Stranger', enterprise_email: feishu.users[who]?.enterprise_email ?? 'zhang@acme.example', tenant_key: 't1' } }
    },
  })
  const feishuAccounts = await standIn({
    'GET /open-apis/authen/v1/authorize': ({ url }) => {
      assert.equal(url.searchParams.get('client_id'), 'cli_test')
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      const code = randomBytes(8).toString('hex')
      feishu.codes.set(code, { challenge: url.searchParams.get('code_challenge'), who: feishu.signingIn })
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state'))
      return { redirect: back.href }
    },
  })
  servers.push(feishuApi.server, feishuAccounts.server)
  const fs1 = await startServer({ DSH_DIRECTORY: 'feishu', FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'feishu-secret', FEISHU_API_URL: feishuApi.url, FEISHU_ACCOUNTS_URL: feishuAccounts.url }, 'feishu')
  servers.push(fs1.app)
  const { app } = fs1

  // An existing member, added by hand before the directory was connected.
  const handmade = await app.store.createUser({ name: 'Zhang (CSV)', email: 'zhang@acme.example', role: 'admin' })

  const preview = (await fs1.admin('POST', '/admin/api/identity/directory/preview')).body
  assert.deepEqual([preview.departments.create.length, preview.users.create.length, preview.users.adopt.length], [3, 3, 1], 'the preview says what would happen')
  assert.equal((await app.store.users()).length, 1, 'a preview changes nothing')

  const revisionBefore = (await app.store.tenant()).config_revision
  const first = (await fs1.admin('POST', '/admin/api/identity/directory/sync', {})).body
  assert.equal(first.status, 'applied')
  assert.equal((await app.store.tenant()).config_revision, revisionBefore + 1, 'one run moves the revision once')
  const departments = await app.store.departments()
  const rd = departments.find(dep => dep.name === '研发部')
  const platform = departments.find(dep => dep.name === '平台组')
  assert.equal(platform.parent_id, rd.id, 'the department tree is kept')
  assert.equal(platform.source, 'feishu')
  const zhang = await userByName(app, '张三')
  assert.equal(zhang.id, handmade.id, 'the hand-made member with the same e-mail is adopted, not duplicated')
  assert.deepEqual([zhang.role, zhang.source, zhang.department_id], ['admin', 'feishu', platform.id], 'adoption keeps the role and takes the directory name and department')
  assert.equal((await userByName(app, '赵六')).department_id, null, 'people outside any department are kept')
  console.log('✓ feishu: the department tree and people are created; a matching hand-made member is adopted')

  const again = (await fs1.admin('POST', '/admin/api/identity/directory/sync', {})).body
  assert.equal(again.status, 'unchanged')
  assert.equal((await app.store.tenant()).config_revision, revisionBefore + 1, 'nothing changed, nothing moves')
  console.log('✓ feishu: a second run with no change writes nothing')

  // Sign-in matches by the directory ID, never by e-mail.
  assert.equal((await signIn(fs1.base)).signedIn, true, 'a synced person signs in with Feishu')
  feishu.signingIn = 'on-stranger'
  const stranger = await signIn(fs1.base)
  assert.equal(stranger.signedIn, false, 'someone outside the directory is refused, even with a member\'s e-mail')
  assert.equal(stranger.status, 403)
  assert.match(stranger.page, /not in the organisation directory|通讯录/)
  feishu.signingIn = 'on-zhang'
  console.log('✓ feishu: sign-in matches the synced person by union_id; an outsider with a member\'s e-mail is refused')

  // The directory owns name and department; the console owns role and status.
  assert.equal((await fs1.admin('PATCH', '/admin/api/users/' + zhang.id, { name: 'Renamed' })).status, 409)
  assert.equal((await fs1.admin('PATCH', '/admin/api/users/' + zhang.id, { role: 'auditor' })).status, 200)
  console.log('✓ feishu: names and departments of managed people are read-only in the console; roles are not')

  // Changes upstream: a rename, a move, a resignation, a removed department.
  feishu.users['on-li'].name = '李四（销售）'
  feishu.users['on-wang'].department_ids = ['od-platform']
  feishu.users['on-zhao'].status = { is_resigned: true }
  feishu.departments = feishu.departments.filter(dep => dep.open_department_id !== 'od-sales')
  feishu.users['on-li'].department_ids = []
  const changed = (await fs1.admin('POST', '/admin/api/identity/directory/sync', {})).body
  assert.equal(changed.status, 'applied')
  assert.equal((await userByName(app, '李四（销售）')).department_id, null)
  assert.equal((await userByName(app, '王五')).department_id, platform.id)
  const zhao = await userByName(app, '赵六')
  assert.deepEqual([zhao.status, zhao.disabled_by], ['disabled', 'sync'], 'a resignation disables, it does not delete')
  assert.equal((await app.store.departments()).some(dep => dep.name === '销售部'), false, 'a removed department goes')
  const disabledAudit = await app.store.db.get("SELECT detail FROM audit_events WHERE action = 'directory.user.disabled' AND target = $1", [zhao.id])
  assert.match(disabledAudit.detail, /inactive/)
  console.log('✓ feishu: renames, moves, resignations and removed departments follow the directory; departures are audited')

  // Coming back: someone the sync disabled returns; someone IT disabled stays disabled.
  await fs1.admin('PATCH', '/admin/api/users/' + (await userByName(app, '王五')).id, { status: 'disabled' })
  feishu.users['on-zhao'].status = {}
  await fs1.admin('POST', '/admin/api/identity/directory/sync', {})
  assert.equal((await userByName(app, '赵六')).status, 'active', 'returning to the directory re-enables someone the sync disabled')
  assert.equal((await userByName(app, '王五')).status, 'disabled', 'someone IT disabled stays disabled')
  console.log('✓ feishu: the sync restores only the people it disabled itself')

  // An empty or narrowed answer must not off-board everyone.
  const saved = feishu.users
  feishu.users = {}
  const blocked = (await fs1.admin('POST', '/admin/api/identity/directory/sync', {})).body
  assert.equal(blocked.status, 'blocked')
  assert.equal((await userByName(app, '张三')).status, 'active', 'a blocked run changes nothing')
  const forced = (await fs1.admin('POST', '/admin/api/identity/directory/sync', { force: true })).body
  assert.equal(forced.status, 'applied', 'IT can confirm a large change')
  assert.equal((await userByName(app, '张三')).status, 'disabled')
  feishu.users = saved
  const runs = (await fs1.admin('GET', '/admin/api/identity')).body.directory.runs
  assert.deepEqual(runs.slice(0, 2).map(run => run.status), ['applied', 'blocked'], 'every run is recorded')
  console.log('✓ feishu: a run that would disable too many people is held until IT forces it')

  // ======================= DingTalk =======================
  const dingtalk = {
    tree: { 1: [{ dept_id: 10, name: '产品部', parent_id: 1 }], 10: [{ dept_id: 11, name: '设计组', parent_id: 10 }], 11: [] },
    members: {
      1: [{ unionid: 'u-ceo', name: '老板', dept_id_list: [1] }],
      10: [{ unionid: 'u-pm', name: '产品经理', dept_id_list: [10] }],
      11: Array.from({ length: 3 }, (_, index) => ({ unionid: 'u-d' + String(index), name: '设计师' + String(index), dept_id_list: [11] })),
    },
    corp: 'ding-acme',
    signingIn: 'u-pm',
  }
  const dingApi = await standIn({
    'POST /v1.0/oauth2/accessToken': ({ body }) => { assert.equal(body.appKey, 'ding-client'); return { accessToken: 'ding-app', expireIn: 7200 } },
    'POST /v1.0/oauth2/userAccessToken': ({ body }) => { assert.equal(body.grantType, 'authorization_code'); return { accessToken: 'ding-user-' + body.code, corpId: dingtalk.corp } },
    'GET /v1.0/contact/users/me': ({ headers }) => ({ unionId: headers['x-acs-dingtalk-access-token'].replace('ding-user-', ''), nick: 'PM' }),
  })
  const dingOapi = await standIn({
    'POST /topapi/v2/department/listsub': ({ url, body }) => {
      assert.equal(url.searchParams.get('access_token'), 'ding-app')
      return { errcode: 0, result: dingtalk.tree[body.dept_id] ?? [] }
    },
    'POST /topapi/v2/user/list': ({ body }) => {
      // Two at a time, to exercise the cursor.
      const all = dingtalk.members[body.dept_id] ?? []
      const page = all.slice(body.cursor, body.cursor + 2)
      return { errcode: 0, result: { list: page, has_more: body.cursor + 2 < all.length, ...body.cursor + 2 < all.length && { next_cursor: body.cursor + 2 } } }
    },
  })
  const dingLogin = await standIn({
    'GET /oauth2/auth': ({ url }) => {
      assert.equal(url.searchParams.get('scope'), 'openid corpid')
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('authCode', dingtalk.signingIn)
      back.searchParams.set('state', url.searchParams.get('state'))
      return { redirect: back.href }
    },
  })
  servers.push(dingApi.server, dingOapi.server, dingLogin.server)
  const dt = await startServer({
    DSH_DIRECTORY: 'dingtalk', DINGTALK_CLIENT_ID: 'ding-client', DINGTALK_CLIENT_SECRET: 'ding-secret', DINGTALK_CORP_ID: 'ding-acme',
    DINGTALK_API_URL: dingApi.url, DINGTALK_OAPI_URL: dingOapi.url, DINGTALK_LOGIN_URL: dingLogin.url,
  }, 'dingtalk')
  servers.push(dt.app)
  assert.equal((await dt.admin('POST', '/admin/api/identity/directory/sync', {})).body.status, 'applied')
  const design = (await dt.app.store.departments()).find(dep => dep.name === '设计组')
  assert.equal(design.parent_id, (await dt.app.store.departments()).find(dep => dep.name === '产品部').id)
  assert.equal((await dt.app.store.users()).length, 5, 'every page of every department is read')
  assert.equal((await userByName(dt.app, '老板')).department_id, null, 'people in the root department have no department here')
  assert.equal((await signIn(dt.base)).signedIn, true, 'a synced person signs in with DingTalk')
  dingtalk.corp = 'ding-other'
  const otherCorp = await signIn(dt.base)
  assert.deepEqual([otherCorp.signedIn, otherCorp.status], [false, 403], 'choosing another organisation on DingTalk is refused')
  dingtalk.corp = 'ding-acme'
  // Leaving DingTalk means no longer being listed.
  dingtalk.members[11] = dingtalk.members[11].slice(1)
  await dt.admin('POST', '/admin/api/identity/directory/sync', {})
  assert.equal((await userByName(dt.app, '设计师0')).status, 'disabled', 'someone no longer listed is disabled')
  console.log('✓ dingtalk: the tree is walked level by level, members page by cursor; only our corpId signs in; leavers are disabled')

  // ======================= WeCom =======================
  const wecom = {
    departments: [{ id: 1, name: 'Acme', parentid: 0 }, { id: 2, name: '市场部', parentid: 1 }, { id: 3, name: '品牌组', parentid: 2 }],
    members: {
      1: [{ userid: 'boss', name: '总经理', department: [1], main_department: 1, status: 1 }],
      2: [{ userid: 'mkt', name: '市场', department: [2, 3], main_department: 3, status: 1 }],
      3: [{ userid: 'mkt', name: '市场', department: [2, 3], main_department: 3, status: 1 }, { userid: 'left', name: '离职者', department: [3], status: 5 }, { userid: 'new', name: '未激活', department: [3], status: 4 }],
    },
    answer: { userid: 'mkt' },
  }
  const wecomApi = await standIn({
    'GET /cgi-bin/gettoken': ({ url }) => { assert.deepEqual([url.searchParams.get('corpid'), url.searchParams.get('corpsecret')], ['ww-acme', 'wecom-secret']); return { errcode: 0, access_token: 'wx-app', expires_in: 7200 } },
    'GET /cgi-bin/department/list': () => ({ errcode: 0, department: wecom.departments }),
    'GET /cgi-bin/user/list': ({ url }) => ({ errcode: 0, userlist: wecom.members[url.searchParams.get('department_id')] ?? [] }),
    'GET /cgi-bin/auth/getuserinfo': ({ url }) => { assert.equal(url.searchParams.get('code'), 'wx-code'); return { errcode: 0, ...wecom.answer } },
  })
  const wecomLogin = await standIn({
    'GET /wwlogin/sso/login': ({ url }) => {
      assert.deepEqual([url.searchParams.get('login_type'), url.searchParams.get('appid'), url.searchParams.get('agentid')], ['CorpApp', 'ww-acme', '1000002'])
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', 'wx-code')
      back.searchParams.set('state', url.searchParams.get('state'))
      return { redirect: back.href }
    },
  })
  servers.push(wecomApi.server, wecomLogin.server)
  const wc = await startServer({ DSH_DIRECTORY: 'wecom', WECOM_CORP_ID: 'ww-acme', WECOM_AGENT_ID: '1000002', WECOM_SECRET: 'wecom-secret', WECOM_API_URL: wecomApi.url, WECOM_LOGIN_URL: wecomLogin.url }, 'wecom')
  servers.push(wc.app)
  assert.equal((await wc.admin('POST', '/admin/api/identity/directory/sync', {})).body.status, 'applied')
  const wecomDepartments = await wc.app.store.departments()
  assert.deepEqual(wecomDepartments.map(dep => dep.name).sort(), ['品牌组', '市场部'], 'the organisation itself is not a department')
  assert.equal((await userByName(wc.app, '市场')).department_id, wecomDepartments.find(dep => dep.name === '品牌组').id, 'the main department is the primary one')
  assert.equal(await userByName(wc.app, '离职者'), undefined, 'someone who already left is not created')
  assert.equal((await userByName(wc.app, '未激活')).status, 'active', 'not yet activated is still a member')
  assert.equal((await signIn(wc.base)).signedIn, true, 'a member signs in with WeCom')
  wecom.answer = { openid: 'outsider' }
  const outsider = await signIn(wc.base)
  assert.deepEqual([outsider.signedIn, outsider.status], [false, 403], 'a non-member (openid, no userid) is refused')
  console.log('✓ wecom: the organisation root is not a department; main departments, statuses and non-members are handled')
} finally {
  for (const server of servers) await (server.close.length === 0 && typeof server.listen === 'function' && 'store' in server ? server.close() : new Promise(resolve => { server.close(() => resolve()) }))
  rmSync(work, { recursive: true, force: true })
}
