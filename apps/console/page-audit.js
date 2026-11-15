import { t, tf } from './i18n.js'
import { ACTION_GROUPS, actionLabel, actionTone, api } from './api.js'
import { absolute, badge, busy, button, empty, h, icon, openDialog, pageHead, panel, select, table, timeCell } from './ui.js'

const PAGE = 100

export async function render(ctx) {
  const users = await api('GET', '/admin/api/users')
  const names = new Map(users.map(user => [user.id, user.name]))
  const filters = { action: '', actor: '', days: '30' }
  let events = []
  const tableHost = h('div')
  const more = button(t('加载更早的记录'), { kind: 'small' })
  const integrity = h('div', { class: 'title-line integrity' })

  const actorName = (event) => (event.actorId === 'bootstrap' ? t('初始管理员') : event.actorId ? names.get(event.actorId) ?? event.actorId : event.actorType === 'system' ? t('系统') : '—')
  const query = (before) => {
    const params = new URLSearchParams({ limit: String(PAGE) })
    if (filters.action) params.set('action', filters.action)
    if (filters.actor) params.set('actor', filters.actor)
    if (filters.days) params.set('since', String(Date.now() - Number(filters.days) * 86_400_000))
    if (before) params.set('before', String(before))
    return '/admin/api/audit?' + params.toString()
  }
  const draw = () => {
    tableHost.replaceChildren(table([
      { label: t('时间'), cell: event => timeCell(event.at) },
      { label: t('操作人'), cell: event => event.actorId && names.has(event.actorId) ? h('a', { href: '#/members/' + event.actorId }, actorName(event)) : actorName(event) },
      { label: t('事件'), cell: event => h('div', { class: 'title-line' }, actionTone(event.action) && h('span', { class: 'badge plain ' + actionTone(event.action) }, actionTone(event.action) === 'bad' ? t('异常') : actionTone(event.action) === 'warn' ? t('注意') : t('成功')), actionLabel(event.action)) },
      { label: t('来源'), cell: event => (event.source === 'client' ? badge(t('员工端'), 'plain') : badge(t('服务端'), 'plain')) },
      { label: t('序号'), className: 'right', cell: event => h('span', { class: 'num faint' }, '#' + event.seq) },
    ], events, {
      onRow: event => detail(event, actorName(event)),
      emptyState: empty({ iconName: 'shield', title: t('没有符合条件的记录'), text: t('放宽时间范围或动作筛选试试。') }),
    }))
    more.classList.toggle('hidden', events.length === 0 || events.length % PAGE !== 0)
  }
  const load = async () => { events = await api('GET', query()); draw() }
  more.addEventListener('click', () => busy(more, async () => {
    const older = await api('GET', query(events.at(-1)?.seq))
    events = [...events, ...older]
    draw()
  }))
  const verify = button(t('校验完整性'), { iconName: 'shield', onclick: () => busy(verify, async () => {
    const result = await api('GET', '/admin/api/audit/verify')
    integrity.replaceChildren(result.ok
      ? badge(tf('完整，共 {n} 条，未被删改', { n: result.events }), 'ok')
      : badge(tf('第 {n} 条起记录被删改过', { n: result.brokenAt }), 'bad'))
  }) })

  ctx.render([{ label: t('审计日志') }], [
    pageHead({
      title: t('审计日志'),
      description: t('登录、设备注册、配置下发与生效、员工端的工具拦截、所有管理操作都会记录在这里。日志只能追加，每条都带上一条的哈希，任何删改都会被校验发现。'),
      actions: [verify],
    }),
    integrity,
    panel({
      flush: true,
      body: [
        h('div', { class: 'toolbar' },
          select(ACTION_GROUPS, '', value => { filters.action = value; void load() }, t('动作')),
          select([['', t('全部人员')], ...users.map(user => [user.id, user.name])], '', value => { filters.actor = value; void load() }, t('操作人')),
          select([['1', t('最近 24 小时')], ['7', t('最近 7 天')], ['30', t('最近 30 天')], ['', t('全部时间')]], '30', value => { filters.days = value; void load() }, t('时间范围')),
          h('span', { class: 'spacer' }),
          h('span', { class: 'result' }, icon('info'), t(' 点击一行查看详情'))),
        tableHost,
      ],
      foot: more,
    }),
  ])
  await load()
}

function detail(event, actor) {
  return openDialog({
    title: actionLabel(event.action),
    drawer: true,
    build: (close) => ({
      body: [
        h('dl', { class: 'props' },
          h('dt', {}, t('时间')), h('dd', {}, absolute(event.at)),
          h('dt', {}, t('操作人')), h('dd', {}, actor),
          h('dt', {}, t('动作')), h('dd', { class: 'mono' }, event.action),
          h('dt', {}, t('对象')), h('dd', { class: 'mono' }, event.target ?? '—'),
          h('dt', {}, t('来源')), h('dd', {}, event.source === 'client' ? t('员工端上报') : t('服务端记录')),
          h('dt', {}, t('序号')), h('dd', { class: 'num' }, '#' + event.seq),
          h('dt', {}, t('哈希')), h('dd', { class: 'mono faint' }, event.hash)),
        event.detail !== undefined && h('div', { class: 'section-title' }, t('详情')),
        event.detail !== undefined && h('pre', { class: 'code' }, JSON.stringify(event.detail, null, 2)),
      ],
      actions: [button(t('关闭'), { onclick: () => close() })],
    }),
  })
}
