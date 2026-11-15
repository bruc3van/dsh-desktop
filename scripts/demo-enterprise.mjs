/**
 * Local enterprise demo: management server (with its built-in gateway) + a stand-in model API + the
 * development client in server mode. Nothing touches the real client home or
 * ~/.dsh; everything lives in one temporary directory, removed on exit.
 *
 *   pnpm run build && node scripts/demo-enterprise.mjs
 *
 * Console:  http://127.0.0.1:18080/console/   (bootstrap token: demo)
 * Sign in:  the client opens your browser; use zhangsan@youjigeyisi.example
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const COMMUNITY_INDEX = 'https://bruc3van.com/dsh-plugins/index.json'
/** Used when the demo machine cannot reach the community index: a few of its entries, without icons. */
const FALLBACK_INDEX = {
  format: 1,
  title: { en: 'DSH community picks (offline copy)', zh: 'DSH 社区精选（离线副本）' },
  metadata: { categories: {
    'agents-workflows': { title: { en: 'Agents & workflows', zh: 'Agent 工作流' } },
    'integrations-sharing': { title: { en: 'Integrations & sharing', zh: '集成与分享' } },
    'ui-experience': { title: { en: 'UI & experience', zh: '界面与体验' } },
    'media-vision': { title: { en: 'Design, media & vision', zh: '设计与视觉' } },
  } },
  plugins: [
    { name: 'dsh-mole', title: { en: 'Mole · Computer cleanup', zh: 'Mole · 电脑清理' }, author: 'Tw93', description: { en: 'Analyse disk usage and preview cleanup through the Mole CLI.', zh: '通过 Mole CLI 分析磁盘占用、预览清理，征得同意后再清理。' }, metadata: { category: 'agents-workflows' }, versions: [{ version: '0.1.4', publishTimestamp: 1794366340, source: { type: 'npm' }, engines: { dsh: '>=0.2.0 <0.3.0' } }] },
    { name: '@xmanrui/dsh-im', title: { en: 'IM chat bots', zh: 'IM 聊天机器人' }, author: 'xmanrui', description: { en: 'Talk to DSH from Feishu, DingTalk, WeCom and other chat apps.', zh: '在飞书、钉钉、企业微信等聊天工具里使用 DSH。' }, metadata: { category: 'integrations-sharing' }, versions: [{ version: '5.10.0', publishTimestamp: 1793724813, source: { type: 'npm' } }] },
    { name: 'dsh-context', title: { en: 'Context insight', zh: '上下文洞察与管理' }, author: 'bowenliang123', description: { en: 'See and manage what fills the conversation context.', zh: '查看并管理对话上下文里占用了什么。' }, metadata: { category: 'ui-experience' }, versions: [{ version: '0.84.1', publishTimestamp: 1794540314, source: { type: 'npm' } }] },
    { name: 'dsh-image-gen', title: { en: 'Image generation', zh: 'DSH 图像生成' }, author: 'shanliuling', description: { en: 'Generate images from a conversation.', zh: '在对话里生成图片。' }, metadata: { category: 'media-vision' }, versions: [{ version: '0.11.2', publishTimestamp: 1794496628, source: { type: 'npm' } }] },
  ],
}
const home = mkdtempSync(join(tmpdir(), 'dsh-enterprise-demo-'))
const PORT = 18080
const GATEWAY_PORT = 18081

// A stand-in for an OpenAI-compatible model API (DeepSeek, Qwen, ...). The
// management server's built-in gateway forwards to it with the organisation key.
const gateway = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    // Offline stand-in for the public community index the market picks from.
    if (req.url === '/market/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(FALLBACK_INDEX))
      return
    }
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'company-chat' }] }))
      return
    }
    const request = JSON.parse(body || '{}')
    const last = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    const asked = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
    const reply = '（演示模型）收到你的消息：「' + asked.slice(0, 200) + '」\n\n'
      + '这条回复经过管理服务端的内置网关转发：你的电脑只拿到个人 Key，网关核对后，用组织的 Key（`'
      + String(req.headers.authorization ?? '').replace(/^Bearer /, '').slice(0, 10) + '…`）请求上游。停用你的账号，这个个人 Key 立即失效。'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'company-chat' }
    for (const piece of reply.match(/[\s\S]{1,12}/g) ?? []) {
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }) + '\n\n')
    }
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    // The gateway asks for usage (stream_options.include_usage) so it can count tokens and cost.
    const prompt = Math.ceil(JSON.stringify(request.messages ?? []).length / 2) + 1800
    if (request.stream_options?.include_usage) res.write('data: ' + JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: prompt, prompt_cache_hit_tokens: Math.floor(prompt * 0.6), completion_tokens: Math.ceil(reply.length / 1.5) } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(resolve => gateway.listen(GATEWAY_PORT, '127.0.0.1', resolve))
const gatewayUrl = 'http://127.0.0.1:' + String(GATEWAY_PORT)

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1:' + String(PORT), DSH_SERVER_SECRET: 'demo-secret-'.repeat(4), PORT: String(PORT), HOST: '127.0.0.1',
  DSH_TENANT_ID: 'youjigeyisi', DSH_TENANT_NAME: '广州有几个意思科技有限公司', DSH_DEV_LOGIN: '1', DSH_BOOTSTRAP_TOKEN: 'demo',
  DSH_GATEWAY: 'direct', DSH_UPSTREAM_URL: gatewayUrl + '/v1', DSH_UPSTREAM_KEY: 'sk-demo-organisation-key',
})
const server = await createApp({ config, db: await openDb('sqlite:' + join(home, 'server.sqlite')) })
await server.listen()
const { store } = server

// Demo organisation: four people, three departments, two profiles.
const finance = await store.departmentByPath('财务部')
await store.departmentByPath('财务部/应付组')
const sales = await store.departmentByPath('销售部')
const rd = await store.departmentByPath('研发部')
await store.createUser({ name: '张三', email: 'zhangsan@youjigeyisi.example', departmentId: await store.departmentByPath('财务部/应付组') })
await store.createUser({ name: '李四', email: 'lisi@youjigeyisi.example', departmentId: sales })
await store.createUser({ name: '王五', email: 'wangwu@youjigeyisi.example', departmentId: rd, role: 'admin' })
await store.createUser({ name: '赵六', email: 'zhaoliu@youjigeyisi.example', role: 'auditor' })
const company = await store.createProfile({ name: '通用办公', description: '全员默认配置', spec: {
  models: {
    providers: { 'company-gateway': { displayName: '公司模型网关', api: 'openai-completions', baseURL: 'http://127.0.0.1:' + String(PORT) + '/llm/v1', credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'company-chat', name: '公司智能助手', contextWindow: 64000 }, { id: 'company-reasoner', name: '公司推理', contextWindow: 64000 }, { id: 'company-lite', name: '公司轻量' }] } },
    default: { provider: 'company-gateway', model: 'company-chat' },
  },
  tools: { deny: ['bash', 'pwsh', 'run_code'], message: '公司 IT 已禁用命令行和代码执行工具，请告诉用户在这里不可用。' },
} }, 'demo')
const financeProfile = await store.createProfile({ name: '财务部', description: '财务专属 Skill', spec: {
  skills: [{ name: 'invoice-helper', files: { 'SKILL.md': '---\nname: invoice-helper\ndescription: 按公司财务模板整理发票信息\n---\n\n把用户给的发票信息整理成表格：发票号、开票日期、金额、税额、销售方。金额保留两位小数。\n' } }],
  tools: { deny: ['web_fetch'] },
} }, 'demo')
await store.bind({ profileId: company.id, targetType: 'tenant', targetId: '' })
await store.bind({ profileId: financeProfile.id, targetType: 'department', targetId: finance ?? '' })

// Demo devices in every rollout state, so the console has something to show
// before anyone signs in. Real devices appear beside them once people do.
await seedDemoDevices(store)

// The model catalog, a month of gateway traffic and a few limits, so the
// usage and limits pages have something to show.
await seedDemoUsage(server, gatewayUrl)

// A reviewed plugin catalog and a skill library, for the market pages and the client's Discover page.
await seedDemoMarket(server, gatewayUrl)

// What IT would install on the machine.
const managedDir = join(home, 'managed')
mkdirSync(managedDir)
const tenant = await store.tenant()
writeFileSync(join(managedDir, 'enrollment.json'), JSON.stringify({
  schema: 'dsh-desktop-pro/enrollment', version: 1, server: config.publicUrl, organization: { id: tenant.id, name: tenant.name }, keys: await store.publicKeys(),
  // So the demo shows the "use personal mode" option too; off unless IT allows it.
  allowPersonal: true,
}, null, 2))

const electron = createRequire(import.meta.url)('electron')
const client = spawn(electron, [join(root, '.build/main.mjs'), '--user-data-dir=' + join(home, 'chromium')], {
  env: {
    ...process.env,
    DSH_DESKTOP_HOME: join(home, 'desktop'),
    DSH_DESKTOP_MANAGED_DIR: managedDir,
    // Never adopt or reuse the developer's own dsh.
    DSH_DESKTOP_SKIP_PROBE: '1', DSH_DESKTOP_SKIP_INSTALLED_DSH: '1', DSH_DESKTOP_SKIP_UPDATE_PROMPT: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
client.stdout.on('data', chunk => { process.stdout.write(String(chunk).split('\n').filter(line => /enterprise|managed|preset|desktop\]/.test(line)).map(line => '[client] ' + line + '\n').join('')) })
client.stderr.on('data', () => {})

console.log('\nDSH Desktop Pro 企业模式演示已启动')
console.log('  控制台：      ' + config.publicUrl + '/console/   （初始管理员令牌：demo）')
console.log('  员工登录：    客户端会打开浏览器，填 zhangsan@youjigeyisi.example（财务部）或 lisi@youjigeyisi.example（销售部）')
console.log('  临时目录：    ' + home + '\n')

const shutdown = async () => {
  client.kill()
  await server.close().catch(() => {})
  gateway.close()
  rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
client.on('exit', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

async function seedDemoDevices(store) {
  const revision = (await store.tenant()).config_revision
  const people = await store.users()
  const by = (email) => people.find(person => person.email === email)?.id
  const hour = 3_600_000
  const rows = [
    [by('lisi@youjigeyisi.example'), 'lisi-thinkpad', 'win32', 'x64', revision, 'applied', [], 0.2],
    [by('wangwu@youjigeyisi.example'), 'wangwu-mbp', 'darwin', 'arm64', revision, 'applied', [], 0.5],
    [by('wangwu@youjigeyisi.example'), 'build-ubuntu', 'linux', 'x64', revision - 3, 'applied', [], 1],
    [by('zhaoliu@youjigeyisi.example'), 'zhaoliu-imac', 'darwin', 'x64', revision, 'partial', ['could not install dsh-im@1.2.3: registry unreachable'], 2],
    [by('lisi@youjigeyisi.example'), 'lisi-old-laptop', 'win32', 'x64', revision - 6, 'applied', [], 24 * 5],
  ]
  for (const [userId, hostname, platform, arch, applied, result, problems, ageHours] of rows) {
    const seen = Date.now() - ageHours * hour
    await store.db.run('INSERT INTO devices (id, tenant_id, user_id, public_key, platform, arch, hostname, client_version, dsh_version, status, applied_revision, applied_result, applied_problems, applied_at, served_revision, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)',
      ['dev_demo_' + hostname, store.tenantId, userId, 'demo', platform, arch, hostname, '0.7.0', '0.2.2-rc.3', 'active', applied, result, JSON.stringify(problems), seen, applied, seen - 7 * 24 * hour, seen])
  }
}

async function seedDemoUsage({ store, metering }, upstreamBase) {
  const qwen = await metering.saveUpstream(undefined, { name: '通义千问（演示）', baseUrl: upstreamBase + '/v1', apiKey: 'sk-demo-qwen-key' })
  const catalog = [
    ['company-chat', { name: '公司智能助手', upstreamId: 'default', upstreamModel: 'deepseek-chat', prices: { input: 2, output: 8, cacheRead: 0.5 }, contextWindow: 64000, tags: ['fast'], recommended: true }],
    ['company-reasoner', { name: '公司推理', upstreamId: 'default', upstreamModel: 'deepseek-reasoner', prices: { input: 4, output: 16, cacheRead: 1 }, contextWindow: 64000, tags: ['reasoning'] }],
    ['company-lite', { name: '公司轻量', upstreamId: qwen.id, upstreamModel: 'qwen-turbo', prices: { input: 0.3, output: 0.6 }, contextWindow: 128000, tags: ['fast', 'long'] }],
  ]
  for (const [id, model] of catalog) await metering.saveModel(id, model)
  const prices = Object.fromEntries((await metering.models()).map(model => [model.id, model.prices]))
  const micros = (value) => (value === null ? null : Math.round(value * 1e6))
  const people = await store.users()
  const by = (email) => people.find(person => person.email === email)
  // Deterministic "random", so every demo looks the same.
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  const plan = [['zhangsan@youjigeyisi.example', 18, 'company-chat'], ['lisi@youjigeyisi.example', 46, 'company-chat'], ['wangwu@youjigeyisi.example', 70, 'company-reasoner'], ['zhaoliu@youjigeyisi.example', 6, 'company-lite']]
  const clients = ['DSH/0.2.2-rc.3', 'DSH/0.2.2-rc.3', 'DSH/0.2.2-rc.3', 'OpenAI/JS']
  const day = 86_400_000
  for (const [email, perDay, favourite] of plan) {
    const person = by(email)
    for (let back = 29; back >= 0; back -= 1) {
      const weekday = new Date(Date.now() - back * day).getDay()
      const count = Math.round(perDay * (weekday === 0 || weekday === 6 ? 0.15 : 0.6 + rand() * 0.8) * (back === 0 ? 0.4 : 1))
      for (let n = 0; n < count; n += 1) {
        const startedAt = Date.now() - back * day - Math.floor(rand() * (back === 0 ? 6 : 10) * 3_600_000)
        const model = rand() < 0.7 ? favourite : ['company-chat', 'company-reasoner', 'company-lite'][Math.floor(rand() * 3)]
        const prompt = 1500 + Math.floor(rand() * 9000)
        const tokens = { input: Math.floor(prompt * 0.45), cacheRead: prompt - Math.floor(prompt * 0.45), output: 200 + Math.floor(rand() * (model === 'company-reasoner' ? 2600 : 900)), reasoning: model === 'company-reasoner' ? 400 + Math.floor(rand() * 1200) : 0 }
        const roll = rand()
        const status = roll < 0.015 ? 'error' : 'ok'
        const ttft = 280 + Math.floor(rand() * (model === 'company-reasoner' ? 2600 : 900))
        await metering.record({
          userId: person.id, departmentId: person.department_id, startedAt, endpoint: 'chat/completions', model, servedModel: catalog.find(([id]) => id === model)[1].upstreamModel,
          upstreamId: model === 'company-lite' ? qwen.id : 'default', client: clients[Math.floor(rand() * clients.length)], stream: true,
          status, httpStatus: status === 'ok' ? 200 : 502, error: status === 'ok' ? null : 'upstream_502', stopReason: status === 'ok' ? 'stop' : null,
          tokens: status === 'ok' ? tokens : { input: 0, cacheRead: 0, output: 0, reasoning: 0 },
          costMicros: status === 'ok' ? Math.round((tokens.input * micros(prices[model].input) + tokens.cacheRead * micros(prices[model].cacheRead ?? prices[model].input) + tokens.output * micros(prices[model].output)) / 1e6) : null,
          ttftMs: ttft, durationMs: ttft + Math.floor(tokens.output / (40 + rand() * 40) * 1000),
        })
      }
    }
  }
  // Limits: a company budget, a monthly cap per person, and a sales budget that falls back to the light model.
  await metering.saveQuota(undefined, { scopeType: 'tenant', period: 'month', metric: 'cost', amount: 2000, action: 'block' })
  await metering.saveQuota(undefined, { scopeType: 'member_default', period: 'month', metric: 'cost', amount: 30, action: 'block' })
  const sales = (await store.departments()).find(dep => dep.name === '销售部')
  await metering.saveQuota(undefined, { scopeType: 'department', scopeId: sales.id, period: 'month', metric: 'cost', amount: 80, action: 'fallback', fallbackModel: 'company-lite' })
  await metering.saveQuota(undefined, { scopeType: 'member_default', period: 'minute', metric: 'requests', amount: 30, action: 'block' })
}

/** Plugins IT has reviewed, one blocked plugin, and a small skill library with a few people's choices. */
async function seedDemoMarket({ market, store }, upstreamBase) {
  let source
  try {
    source = await market.addSource({ url: COMMUNITY_INDEX })
  } catch {
    source = await market.addSource({ url: upstreamBase + '/market/index.json' })
  }
  const picks = [
    ['dsh-mole', true, '已检查：只在本机运行 Mole CLI，清理前会询问。'],
    ['@xmanrui/dsh-im', true, '接入公司飞书机器人前，请先在 IT 登记 App ID。'],
    ['dsh-context', false, '只读取本地会话，不联网。'],
    ['dsh-image-gen', false, '会调用外部图像服务，不要上传客户资料。'],
  ]
  for (const [name, featured, note] of picks) {
    const page = await market.browse(source.id, name, 0, 20)
    const entry = page.entries.find(item => item.name === name)
    if (entry === undefined) continue
    const version = entry.versions.find(item => !item.version.includes('-')) ?? entry.versions[0]
    await market.approve({ sourceId: source.id, name, version: version.version, featured, note }, 'demo')
  }
  await market.approve({
    name: '@youjigeyisi/dsh-crm', version: '1.4.0', source: { type: 'npm', registry: 'https://npm.youjigeyisi.example/' },
    title: '客户资料查询', description: '在对话里查公司 CRM 里的客户、联系人和最近的订单（内部插件）。', note: '内部开发，仅连接内网 CRM。',
  }, 'demo')
  await market.block({ name: 'dsh-free-upload', note: '会把本地文件上传到第三方网盘。' }, 'demo')

  const skill = (title, description, body) => '---\nname: ' + title + '\ndescription: ' + description + '\n---\n\n' + body
  await market.saveSkill('weekly-report', { title: '周报格式', description: '按公司模板写周报', distribution: 'everyone', files: {
    'SKILL.md': skill('weekly-report', '写周报、总结本周工作时使用', '# 周报格式\n\n按这四段写，每段不超过五条：\n\n1. 本周完成\n2. 进行中（写明预计完成日期）\n3. 遇到的问题和需要的支持\n4. 下周计划\n\n数字写具体值，不写「大幅提升」。\n'),
  } }, 'demo')
  await market.saveSkill('contract-review', { title: '合同审阅要点', description: '法务部整理的合同初审清单', distribution: 'optional', files: {
    'SKILL.md': skill('contract-review', '审阅、比对或总结合同时使用', '# 合同审阅要点\n\n先按 checklist.md 逐项检查，再列出风险条款，每条写明：条款位置、风险、建议改法。\n不确定的条款标注「请法务确认」，不要给出法律结论。\n'),
    'checklist.md': '- 合同主体与签约方是否一致\n- 金额、币种、付款节点\n- 违约责任是否对等\n- 知识产权归属\n- 保密期限\n- 争议解决方式与管辖地\n',
  } }, 'demo')
  await market.saveSkill('code-review-rules', { title: '代码评审规范', description: '研发部的评审清单和提交规范', distribution: 'optional', files: {
    'SKILL.md': skill('code-review-rules', '评审代码、写提交说明时使用', '# 代码评审规范\n\n评审时依次看：正确性、安全（输入校验、密钥）、可读性、测试。\n每条意见标明「必须改」或「建议」。提交说明用中文，第一行不超过 50 字。\n'),
  } }, 'demo')
  await market.saveSkill('meeting-minutes', { title: '会议纪要', description: '把会议记录整理成纪要和待办', distribution: 'optional', files: {
    'SKILL.md': skill('meeting-minutes', '整理会议记录、生成待办时使用', '# 会议纪要\n\n输出三部分：结论、待办（负责人 + 截止日期）、待确认事项。没有说明负责人的待办，标注「待指派」。\n'),
  } }, 'demo')
  const people = new Map((await store.users()).map(user => [user.email, user.id]))
  await market.subscribe(people.get('lisi@youjigeyisi.example'), 'contract-review', true)
  await market.subscribe(people.get('wangwu@youjigeyisi.example'), 'code-review-rules', true)
  await market.subscribe(people.get('zhangsan@youjigeyisi.example'), 'meeting-minutes', true)
  await store.bumpRevision()
}
