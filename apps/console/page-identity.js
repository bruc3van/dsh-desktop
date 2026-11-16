// Identity sources (ADR-0008): how people sign in, and the directory they come from.
import { lang, t, tf } from './i18n.js'
import { api } from './api.js'
import { absolute, badge, busy, button, callout, confirmAction, copyButton, empty, h, openDialog, pageHead, panel, table, timeCell, toast } from './ui.js'

export const SOURCE_LABEL = { feishu: t('飞书'), dingtalk: t('钉钉'), wecom: t('企业微信'), oidc: 'OIDC' }

const RUN_STATE = {
  running: { label: t('进行中'), tone: 'accent' },
  applied: { label: t('已同步'), tone: 'ok' },
  unchanged: { label: t('没有变化'), tone: '' },
  blocked: { label: t('已拦截'), tone: 'warn' },
  failed: { label: t('失败'), tone: 'bad' },
}

const TRIGGER = { schedule: t('定时'), manual: t('手动'), startup: t('启动') }

function runSummary(run) {
  const s = run.summary ?? {}
  const parts = [
    s.usersCreated && tf('新增 {n} 人', { n: s.usersCreated }),
    s.usersAdopted && tf('认领 {n} 人', { n: s.usersAdopted }),
    s.usersUpdated && tf('更新 {n} 人', { n: s.usersUpdated }),
    s.usersDisabled && tf('停用 {n} 人', { n: s.usersDisabled }),
    s.usersEnabled && tf('恢复 {n} 人', { n: s.usersEnabled }),
    (s.departmentsCreated || s.departmentsUpdated || s.departmentsRemoved) && tf('部门 +{a} ~{u} -{r}', { a: s.departmentsCreated ?? 0, u: s.departmentsUpdated ?? 0, r: s.departmentsRemoved ?? 0 }),
  ].filter(Boolean)
  if (run.status === 'blocked') return tf('要停用 {n} 人，超过上限 {limit} 人，没有执行', { n: s.usersDisabled ?? 0, limit: s.limit ?? 0 })
  if (run.status === 'failed') return run.error ?? ''
  return parts.length > 0 ? parts.join('，') : tf('{n} 人与通讯录一致', { n: s.unchanged ?? 0 })
}

/** A plan from the preview, as lists a person can read before anything changes. */
function planBody(plan) {
  const u = plan.users
  const d = plan.departments
  const list = (title, items, line) => items.length === 0 ? null : h('div', { class: 'plan-group' },
    h('h3', {}, title, ' ', h('span', { class: 'count' }, items.length)),
    h('ul', { class: 'plan-list' }, items.slice(0, 200).map(item => h('li', {}, line(item)))),
    items.length > 200 && h('p', { class: 'faint' }, tf('还有 {n} 项未列出', { n: items.length - 200 })))
  const total = u.create.length + u.adopt.length + u.update.length + u.disable.length + u.enable.length + d.create.length + d.update.length + d.remove.length
  return [
    plan.blocked && callout('bad', tf('这次会停用 {n} 人，超过允许的上限（{limit} 人，受管理在职 {active} 人）。常见原因是应用的通讯录权限范围被改小，或接口暂时返回了空列表。确认无误才强制同步。', { n: plan.blocked.disabling, limit: plan.blocked.limit, active: plan.blocked.managedActive })),
    total === 0 && empty({ iconName: 'check', title: t('与通讯录一致'), text: tf('{n} 人没有变化。', { n: plan.unchanged }) }),
    list(t('新增成员'), u.create, user => [user.name, user.email && h('span', { class: 'faint' }, ' · ' + user.email)]),
    list(t('认领已有成员'), u.adopt, item => [item.name, h('span', { class: 'faint' }, ' → ' + item.user.name + t('（同一邮箱，保留角色和设备）'))]),
    list(t('更新成员'), u.update, item => [item.name, h('span', { class: 'faint' }, ' · ' + item.fields.map(field => ({ name: t('姓名'), email: t('邮箱'), department: t('部门') })[field]).join('、'))]),
    list(t('停用成员'), u.disable, item => [item.name, h('span', { class: 'faint' }, ' · ' + (item.reason === 'missing' ? t('已不在通讯录') : t('已离职或被冻结')))]),
    list(t('恢复成员'), u.enable, item => item.name),
    list(t('新增部门'), d.create, dep => dep.name),
    list(t('更新部门'), d.update, dep => [dep.was.name, dep.was.name !== dep.name ? ' → ' + dep.name : h('span', { class: 'faint' }, t('（上级部门变了）'))]),
    list(t('删除部门'), d.remove, dep => [dep.name, h('span', { class: 'faint' }, t('（成员改为不属于任何部门，这个部门的场景包分配一并删除）'))]),
  ]
}

async function syncNow(ctx, force) {
  const run = await api('POST', '/admin/api/identity/directory/sync', { force })
  const state = RUN_STATE[run.status] ?? RUN_STATE.failed
  toast(state.label + (run.status === 'applied' || run.status === 'blocked' || run.status === 'failed' ? '：' + runSummary(run) : ''), run.status === 'failed' || run.status === 'blocked' ? 'bad' : '')
  ctx.refresh()
}

function previewDialog(ctx, source) {
  const host = h('div', {}, h('p', { class: 'muted' }, t('正在读取通讯录…')))
  let plan
  return openDialog({
    title: tf('预览{source}同步', { source: SOURCE_LABEL[source] ?? source }),
    wide: true,
    build: (close) => {
      const apply = button(t('按预览同步'), { kind: 'primary', disabled: true, onclick: () => busy(apply, async () => {
        if (plan.blocked && !await confirmAction({ title: t('强制同步'), text: tf('将停用 {n} 人，他们的登录、网关 Key 和设备会立即失效。', { n: plan.blocked.disabling }), confirmLabel: t('强制同步'), typeToConfirm: String(plan.blocked.disabling) })) return
        await syncNow(ctx, plan.blocked !== null)
        close(true)
      }) })
      api('POST', '/admin/api/identity/directory/preview').then((result) => {
        plan = result
        host.replaceChildren(...planBody(result).filter(Boolean))
        apply.disabled = !ctx.canWrite()
        if (result.blocked) apply.textContent = t('确认后强制同步')
      }, (error) => { host.replaceChildren(callout('bad', error.message)) })
      return { body: host, actions: [button(t('关闭'), { onclick: () => close() }), apply] }
    },
  })
}

export async function render(ctx) {
  const info = await api('GET', '/admin/api/identity')
  const writable = ctx.canWrite()
  const directory = info.directory
  const sourceName = directory ? SOURCE_LABEL[directory.source] ?? directory.source : ''

  const signIn = panel({
    title: t('登录方式'),
    description: t('员工和管理员可以用哪些方式登录。在身份提供方那里登记下面的回调地址。'),
    flush: true,
    body: table([
      { label: t('方式'), cell: method => h('div', {}, h('div', { class: 'cell-title' }, method.labels?.[lang] ?? method.label), method.id === 'dev' && h('div', { class: 'cell-sub' }, t('只填邮箱、不校验密码，只能用于内网试用'))) },
      { label: t('回调地址'), cell: method => method.callbackUrl ? h('div', { class: 'title-line' }, h('code', {}, method.callbackUrl), copyButton(method.callbackUrl)) : h('span', { class: 'faint' }, '—') },
      { label: t('谁能登录'), className: 'wrap', cell: method => method.id === 'dev' ? t('成员列表里的任何邮箱')
        : method.id === 'oidc' ? t('已关联的账号，或 IdP 标明已验证邮箱的成员')
          : tf('只有从{source}通讯录同步来的成员', { source: SOURCE_LABEL[method.id] ?? method.id }) },
    ], info.signIn, { emptyState: empty({ iconName: 'key', title: t('没有配置登录方式'), text: t('在服务端 .env 里设置 DSH_DIRECTORY（飞书、钉钉、企业微信）或 OIDC_ISSUER。') }) }),
  })

  const last = directory?.runs[0]
  const sync = directory === null
    ? panel({
      title: t('通讯录同步'),
      body: [
        empty({ iconName: 'people', title: t('没有接入通讯录'), text: t('成员现在由控制台和 CSV 导入维护。接入飞书、钉钉或企业微信后，入职、调岗、离职会自动同步过来。') }),
        callout('info', t('在服务端 .env 里设置 DSH_DIRECTORY=feishu（或 dingtalk、wecom）和对应应用的凭据，重启后生效。见部署指南「身份源」一节。')),
      ],
    })
    : panel({
      title: tf('{source}通讯录同步', { source: sourceName }),
      description: tf('每 {n} 分钟按通讯录全量对一次账：新增、更新、停用都以通讯录为准。离职是停用，不删除；重新出现会自动恢复。一次要停用超过 {p}% 的人时会先拦下。', { n: directory.intervalMinutes, p: directory.maxDisablePercent }),
      actions: [
        button(t('预览'), { kind: 'small', iconName: 'search', onclick: () => previewDialog(ctx, directory.source) }),
        writable && button(t('立即同步'), { kind: 'small primary', iconName: 'refresh', onclick: (event) => busy(event.currentTarget, () => syncNow(ctx, false)) }),
      ],
      body: [
        h('dl', { class: 'props' },
          h('dt', {}, t('受管理的在职成员')), h('dd', { class: 'num' }, directory.managed),
          h('dt', {}, t('上次同步')), h('dd', {}, last ? [timeCell(last.startedAt), ' ', badge((RUN_STATE[last.status] ?? RUN_STATE.failed).label, (RUN_STATE[last.status] ?? RUN_STATE.failed).tone)] : t('还没有同步过')),
          last && last.status !== 'unchanged' && [h('dt', {}, t('结果')), h('dd', { class: 'wrap' }, runSummary(last))]),
        last?.status === 'blocked' && callout('bad', t('上次同步被拦截：要停用的人太多。点「预览」看清楚是谁，确认无误再强制同步。')),
      ],
    })

  const history = directory && panel({
    title: t('同步记录'),
    flush: true,
    body: table([
      { label: t('时间'), cell: run => h('span', { title: absolute(run.startedAt) }, timeCell(run.startedAt)) },
      { label: t('触发'), cell: run => TRIGGER[run.trigger] ?? run.trigger },
      { label: t('结果'), cell: run => { const state = RUN_STATE[run.status] ?? RUN_STATE.failed; return badge(state.label, state.tone) } },
      { label: t('变化'), className: 'wrap', cell: run => runSummary(run) },
      { label: t('耗时'), className: 'right', cell: run => run.finishedAt ? h('span', { class: 'num' }, Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) + ' s') : '—' },
    ], directory.runs, { emptyState: empty({ iconName: 'history', title: t('还没有同步记录'), text: t('服务端启动后几秒内会做第一次同步，也可以点「立即同步」。') }) }),
  })

  ctx.render([{ label: t('身份源') }], [
    pageHead({ title: t('身份源'), description: t('员工怎么登录，成员从哪里来。接入通讯录后，入职、调岗、离职由通讯录决定；角色、停用和场景包仍在这里管理。') }),
    signIn,
    sync,
    history,
  ].filter(Boolean))
}
