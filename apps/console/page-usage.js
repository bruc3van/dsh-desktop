// Usage: requests, tokens and cost through the built-in gateway, by person, department, model and client.
import { t, tf } from './i18n.js'
import { api } from './api.js'
import { compact, duration, full, percent, shareBar, shiftDay, yuan } from './format.js'
import { badge, button, callout, empty, h, icon, pageHead, panel, select, table, tabs, timeCell } from './ui.js'

const RANGES = [['1', t('今天')], ['7', t('7 天')], ['30', t('30 天')], ['90', t('90 天')]]
const MEASURES = { cost: t('费用'), tokens: 'Token', requests: t('请求') }

/** The usage filter from the page's query: range plus optional person, department and model. */
export function usageQuery(ctx) {
  const range = RANGES.some(([value]) => value === ctx.query.get('range')) ? ctx.query.get('range') : '30'
  const to = ctx.me.today
  const params = new URLSearchParams({ from: shiftDay(to, -(Number(range) - 1)), to })
  for (const key of ['user', 'department', 'model']) if (ctx.query.get(key)) params.set(key, ctx.query.get(key))
  return { range, params }
}

export async function render(ctx) {
  if (ctx.me.gateway !== 'direct') {
    ctx.render([{ label: t('用量分析') }], [
      pageHead({ title: t('用量分析') }),
      empty({ iconName: 'chart', title: t('用量来自内置网关'), text: t('启用内置网关（DSH_GATEWAY=direct）后，员工的每个模型请求都会记录在这里。用 LiteLLM 时，请在 LiteLLM 的管理界面查看用量。'), action: h('a', { class: 'btn', href: '#/gateway' }, t('查看网关设置')) }),
    ])
    return
  }
  const { range, params } = usageQuery(ctx)
  const [summary, users, departments, catalog] = await Promise.all([
    api('GET', '/admin/api/usage/summary?' + params), api('GET', '/admin/api/users'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/catalog'),
  ])
  const people = new Map(users.map(user => [user.id, user]))
  const deptName = new Map(departments.map(dep => [dep.id, dep.name]))
  const modelName = new Map(catalog.models.map(model => [model.id, model.name]))
  const totals = summary.totals
  const here = (changes) => {
    const next = new URLSearchParams(ctx.query)
    for (const [key, value] of Object.entries(changes)) { if (value === '' || value === null) next.delete(key); else next.set(key, value) }
    return '#/usage' + (next.toString() ? '?' + next : '')
  }
  const go = (changes) => { location.hash = here(changes) }
  const measure = MEASURES[ctx.query.get('measure')] ? ctx.query.get('measure') : 'cost'
  const breakdown = ['user', 'department', 'model', 'client'].includes(ctx.query.get('by')) ? ctx.query.get('by') : 'user'
  const filtered = ['user', 'department', 'model'].some(key => ctx.query.get(key))

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': t('时间范围') }, RANGES.map(([value, label]) => h('a', { href: here({ range: value }), class: value === range ? 'active' : null, 'aria-current': value === range ? 'true' : null }, label))),
    select([['', t('全部部门')], ...departments.map(dep => [dep.id, dep.name])], ctx.query.get('department') ?? '', (value) => go({ department: value }), t('部门')),
    select([['', t('全部成员')], ...users.map(user => [user.id, user.name])], ctx.query.get('user') ?? '', (value) => go({ user: value }), t('成员')),
    select([['', t('全部模型')], ...[...new Set([...catalog.models.map(model => model.id), ...summary.byModel.map(row => row.key)])].filter(Boolean).map(id => [id, modelName.get(id) ?? id])], ctx.query.get('model') ?? '', (value) => go({ model: value }), t('模型')),
    filtered && h('a', { class: 'btn ghost small', href: here({ user: '', department: '', model: '' }) }, icon('x'), t('清除筛选')),
    h('span', { class: 'spacer' }),
    h('span', { class: 'faint' }, summary.from === summary.to ? summary.to : summary.from + ' — ' + summary.to))

  const kpi = (label, value, sub, tone) => h('div', { class: 'kpi' + (tone ? ' ' + tone : '') }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub && h('div', { class: 'kpi-sub' }, sub))
  const kpis = h('div', { class: 'kpis' },
    kpi(t('请求'), full(totals.requests), tf('成功率 {p}', { p: percent(totals.ok, totals.requests) })),
    kpi('Token', compact(totals.tokens), tf('输入 {i} · 输出 {o}', { i: compact(totals.input + totals.cacheRead), o: compact(totals.output) })),
    kpi(t('缓存命中'), percent(totals.cacheRead, totals.input + totals.cacheRead), tf('{n} Token 来自缓存', { n: compact(totals.cacheRead) })),
    kpi(t('费用'), yuan(totals.costMicros), totals.unpriced > 0 ? tf('另有 {n} 次请求的模型没有定价', { n: full(totals.unpriced) }) : t('按模型目录里的价格估算'), totals.unpriced > 0 ? 'warn' : ''),
    kpi(t('活跃成员'), full(totals.people), totals.refused > 0 ? tf('被拦截 {n} 次', { n: full(totals.refused) }) : t('没有被拦截的请求')),
    kpi(t('首字延迟'), duration(totals.ttftP50), totals.ttftP95 === null ? t('流式请求的中位数') : tf('P95 {v}', { v: duration(totals.ttftP95) }) + (totals.outputSpeed ? ' · ' + tf('{n} Token/秒', { n: totals.outputSpeed }) : '')))

  const breakdownRows = { user: summary.byUser, department: summary.byDepartment, model: summary.byModel, client: summary.byClient }[breakdown]
  const nameOf = (row) => {
    if (breakdown === 'user') return h('a', { href: '#/members/' + row.key }, people.get(row.key)?.name ?? row.key)
    if (breakdown === 'department') return row.key === null ? h('span', { class: 'faint' }, t('未分配部门')) : h('a', { href: here({ department: row.key }) }, deptName.get(row.key) ?? row.key)
    if (breakdown === 'model') return h('a', { href: here({ model: row.key }) }, h('div', { class: 'cell-title' }, modelName.get(row.key) ?? row.key), modelName.has(row.key) && h('div', { class: 'cell-sub mono' }, row.key))
    return row.key === null ? h('span', { class: 'faint' }, t('未知')) : h('span', { class: 'mono' }, row.key)
  }
  const shareBase = measure === 'cost' ? totals.costMicros : measure === 'tokens' ? totals.tokens : totals.requests
  const shareOf = (row) => (measure === 'cost' ? row.costMicros : measure === 'tokens' ? row.tokens : row.requests)

  ctx.render([{ label: t('用量分析') }], [
    pageHead({
      title: t('用量分析'),
      description: t('经过内置网关的每一个模型请求：谁在用、用了哪些模型、花了多少。只记录用量，不记录对话内容。'),
      actions: [h('a', { class: 'btn', href: '/admin/api/usage/export?' + params, download: '' }, icon('download'), t('导出 CSV'))],
    }),
    filters,
    totals.requests === 0
      ? panel({ body: empty({ iconName: 'chart', title: t('这段时间没有请求'), text: t('员工通过公司模型网关对话后，这里会显示用量。换一个时间范围或清除筛选试试。') }) })
      : [
        kpis,
        panel({
          title: t('趋势'),
          actions: [h('div', { class: 'segmented small', role: 'group', 'aria-label': t('指标') }, Object.entries(MEASURES).map(([value, label]) => h('a', { href: here({ measure: value }), class: value === measure ? 'active' : null }, label)))],
          body: trendChart(summary, measure),
        }),
        panel({
          title: t('分布'),
          flush: true,
          body: [
            h('div', { class: 'toolbar' }, tabs([
              { id: 'user', label: t('按成员'), href: here({ by: 'user' }) },
              { id: 'department', label: t('按部门'), href: here({ by: 'department' }) },
              { id: 'model', label: t('按模型'), href: here({ by: 'model' }) },
              { id: 'client', label: t('按客户端'), href: here({ by: 'client' }) },
            ], breakdown)),
            table([
              { label: { user: t('成员'), department: t('部门'), model: t('模型'), client: t('客户端') }[breakdown], cell: nameOf },
              { label: t('请求'), className: 'num', cell: row => full(row.requests) },
              { label: 'Token', className: 'num', cell: row => compact(row.tokens) },
              { label: t('费用'), className: 'num', cell: row => yuan(row.costMicros) },
              { label: t('失败 / 拦截'), className: 'num', cell: row => (row.errors + row.refused > 0 ? h('span', { class: 'bad-text' }, full(row.errors) + ' / ' + full(row.refused)) : h('span', { class: 'faint' }, '0')) },
              { label: tf('占比（{m}）', { m: MEASURES[measure] }), cell: row => shareBar(shareOf(row), shareBase, percent(shareOf(row), shareBase)) },
            ], breakdownRows.slice(0, 50)),
          ],
        }),
        await requestsPanel(ctx, params, people, modelName),
      ],
    callout('info', t('费用按模型目录里填写的价格估算，以上游账单为准。没有定价的模型不计入费用，会单独标出。')),
  ])
}

/** Daily bars for the chosen measure; missing days show as empty. */
function trendChart(summary, measure) {
  const byDay = new Map(summary.series.map(row => [row.key, row]))
  const days = []
  for (let day = summary.from; day <= summary.to; day = shiftDay(day, 1)) days.push(day)
  const value = (row) => (row === undefined ? 0 : measure === 'cost' ? row.costMicros : measure === 'tokens' ? row.tokens : row.requests)
  const max = Math.max(1, ...days.map(day => value(byDay.get(day))))
  const format = (v) => (measure === 'cost' ? yuan(v) : compact(v))
  const columns = days.map(day => {
    const row = byDay.get(day)
    const bar = h('span', { class: 'chart-bar' })
    bar.style.height = (value(row) / max * 100) + '%'
    return h('div', { class: 'chart-col', title: day + '\n' + t('请求') + ' ' + full(row?.requests ?? 0) + '\nToken ' + full(row?.tokens ?? 0) + '\n' + t('费用') + ' ' + yuan(row?.costMicros ?? 0) }, bar)
  })
  const ticks = days.length <= 1 ? days : [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]]
  return h('div', { class: 'chart', role: 'img', 'aria-label': t('每日用量趋势') },
    h('div', { class: 'chart-scale' }, h('span', {}, format(max)), h('span', {}, format(max / 2)), h('span', {}, '0')),
    h('div', { class: 'chart-plot' }, h('div', { class: 'chart-grid' }, h('i'), h('i'), h('i')), h('div', { class: 'chart-cols' }, columns)),
    h('div', { class: 'chart-axis' }, ticks.map(day => h('span', {}, day.slice(5)))))
}

const STATUS_FILTERS = [['', t('全部')], ['error', t('失败')], ['refused', t('被拦截')], ['fallback', t('已降级')]]
const ERROR_TEXT = {
  model_not_allowed: t('场景包里没有这个模型'),
  model_disabled: t('模型已停用'),
  quota_exceeded: t('额度已用完'),
  no_upstream: t('没有配置上游'),
  upstream_unreachable: t('连不上上游'),
  stream_interrupted: t('输出中断'),
}

async function requestsPanel(ctx, params, people, modelName) {
  const status = STATUS_FILTERS.some(([value]) => value === ctx.query.get('status')) ? ctx.query.get('status') ?? '' : ''
  const query = new URLSearchParams(params)
  if (status) query.set('status', status)
  query.set('limit', '50')
  const rows = await api('GET', '/admin/api/usage/requests?' + query)
  const host = h('div')
  const here = (value) => { const next = new URLSearchParams(ctx.query); if (value) next.set('status', value); else next.delete('status'); return '#/usage?' + next }
  const columns = [
    { label: t('时间'), cell: row => timeCell(row.started_at) },
    { label: t('成员'), cell: row => h('a', { href: '#/members/' + row.user_id }, people.get(row.user_id)?.name ?? row.user_id) },
    { label: t('模型'), cell: row => h('div', {},
      h('div', { class: 'cell-title' }, modelName.get(row.model) ?? row.model),
      row.fallback_from && h('div', { class: 'cell-sub' }, badge(tf('从 {m} 降级', { m: modelName.get(row.fallback_from) ?? row.fallback_from }), 'warn')),
      row.served_model && row.served_model !== row.model && h('div', { class: 'cell-sub mono' }, '→ ' + row.served_model)) },
    { label: t('输入 / 输出'), className: 'num', cell: row => compact(row.input_tokens + row.cache_read_tokens) + ' / ' + compact(row.output_tokens) },
    { label: t('费用'), className: 'num', cell: row => yuan(row.cost_micros) },
    { label: t('首字 / 总耗时'), className: 'num', cell: row => duration(row.ttft_ms) + ' / ' + duration(row.duration_ms) },
    { label: t('结果'), cell: row => row.status === 'ok' ? badge(t('成功'), 'ok') : h('div', {}, badge(row.status === 'refused' ? t('被拦截') : t('失败'), row.status === 'refused' ? 'warn' : 'bad'), h('div', { class: 'cell-sub' }, ERROR_TEXT[row.error] ?? row.error ?? 'HTTP ' + row.http_status)) },
  ]
  let last = rows.at(-1)?.started_at
  const more = button(t('加载更多'), { kind: 'small', onclick: async () => {
    more.disabled = true
    const next = await api('GET', '/admin/api/usage/requests?' + query + '&before=' + last)
    rows.push(...next)
    last = rows.at(-1)?.started_at
    draw(next.length === 50)
  } })
  const draw = (hasMore) => host.replaceChildren(...[table(columns, rows, { emptyState: empty({ iconName: 'check', title: t('没有符合条件的请求') }) }), hasMore && h('div', { class: 'panel-more' }, more)].filter(Boolean))
  draw(rows.length === 50)
  return panel({
    title: t('请求明细'),
    description: t('最近的请求，最新的在前。只有用量和结果，不含对话内容。'),
    flush: true,
    body: [h('div', { class: 'toolbar' }, tabs(STATUS_FILTERS.map(([value, label]) => ({ id: value, label, href: here(value) })), status)), host],
  })
}
