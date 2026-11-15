import { t, tf } from './i18n.js'
import { api, DEVICE_STATE, deviceState } from './api.js'
import { rolloutPanel } from './rollout.js'
import { absolute, badge, busy, button, callout, confirmAction, empty, h, openDialog, pageHead, panel, searchBox, select, table, timeCell, toast } from './ui.js'

const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export async function render(ctx) {
  const devices = await api('GET', '/admin/api/devices')
  const revision = ctx.me.organization.revision
  const filters = { text: '', state: ctx.query.get('state') ?? '', user: ctx.query.get('user') ?? '' }
  const tableHost = h('div')
  const result = h('span', { class: 'result' })
  const draw = () => {
    const text = filters.text.trim().toLowerCase()
    const rows = devices.filter(device =>
      (filters.state === '' ? device.status === 'active' : deviceState(device, revision) === filters.state)
      && (filters.user === '' || device.user_id === filters.user)
      && (text === '' || (device.hostname ?? '').toLowerCase().includes(text) || (device.user_name ?? '').toLowerCase().includes(text)))
    result.textContent = tf('{n} 台', { n: rows.length })
    tableHost.replaceChildren(table([
      { label: t('设备'), cell: device => h('div', {}, h('div', { class: 'cell-title' }, device.hostname || t('未命名设备')), h('div', { class: 'cell-sub' }, (OS[device.platform] ?? device.platform) + ' ' + device.arch)) },
      { label: t('成员'), cell: device => h('a', { href: '#/members/' + device.user_id }, device.user_name ?? device.user_id) },
      { label: t('配置'), cell: device => { const state = DEVICE_STATE[deviceState(device, revision)]; return badge(state.label, state.tone) } },
      { label: t('已用版本'), cell: device => h('span', { class: 'num' }, device.applied_revision === null ? '—' : 'r' + device.applied_revision) },
      { label: t('客户端'), cell: device => h('span', { class: 'num' }, device.client_version || '—') },
      { label: t('最后在线'), cell: device => timeCell(device.last_seen_at) },
    ], rows, {
      onRow: device => deviceDrawer(ctx, device, revision),
      emptyState: empty({ iconName: 'device', title: devices.length === 0 ? t('还没有设备') : t('没有符合条件的设备'), text: devices.length === 0 ? t('员工第一次用企业账号登录 DSH Desktop Pro 后，设备会出现在这里。') : t('换个筛选条件试试。') }),
    }))
  }
  ctx.render([{ label: t('设备') }], [
    pageHead({ title: t('设备'), description: t('员工登录过 DSH Desktop Pro 的电脑。配置一改，在线设备几秒内就会拉取新版本；离线的设备在下次联网时拉取。每台设备都会上报自己用上了哪个版本。') }),
    h('section', { class: 'panel' }, rolloutPanel(devices.filter(device => device.status === 'active'), revision, { compact: true })),
    panel({
      flush: true,
      body: [
        h('div', { class: 'toolbar' },
          searchBox(t('按设备名或成员搜索'), value => { filters.text = value; draw() }),
          select([['', t('全部在用设备')], ...Object.entries(DEVICE_STATE).map(([key, state]) => [key, state.label])], filters.state, value => { filters.state = value; draw() }, t('配置状态')),
          filters.user && button(t('只看这个成员'), { kind: 'small', iconName: 'x', onclick: () => { filters.user = ''; draw() } }),
          h('span', { class: 'spacer' }), result),
        tableHost,
      ],
    }),
  ])
  draw()
}

function deviceDrawer(ctx, device, revision) {
  const state = DEVICE_STATE[deviceState(device, revision)]
  return openDialog({
    title: device.hostname || t('未命名设备'),
    drawer: true,
    build: (close) => {
      const revoke = device.status === 'active' && ctx.canWrite()
        ? button(t('吊销设备'), { kind: 'danger-outline', onclick: async () => {
          const name = device.hostname || device.id
          if (!await confirmAction({ title: t('吊销设备'), text: t('这台设备会在下次联网检查时删除组织下发的凭据、插件配置和 Skill，并退出企业账号。员工可以重新登录，登录后会作为一台新设备注册。'), confirmLabel: t('吊销'), typeToConfirm: name })) return
          await busy(revoke, async () => { await api('POST', '/admin/api/devices/' + device.id + '/revoke'); toast(t('已吊销')); close(true); ctx.refresh() })
        } })
        : null
      return {
        body: [
          device.applied_problems?.length > 0 && callout('bad', device.applied_problems.join('；')),
          panel({ body: h('dl', { class: 'props' },
            h('dt', {}, t('配置')), h('dd', {}, badge(state.label, state.tone)),
            h('dt', {}, t('已用版本')), h('dd', { class: 'num' }, device.applied_revision === null ? t('还没有上报') : tf('r{applied}（当前 r{current}）', { applied: device.applied_revision, current: revision })),
            h('dt', {}, t('最近拉取')), h('dd', { class: 'num' }, device.served_revision === null ? '—' : 'r' + device.served_revision),
            h('dt', {}, t('上报时间')), h('dd', {}, absolute(device.applied_at)),
            h('dt', {}, t('成员')), h('dd', {}, h('a', { href: '#/members/' + device.user_id, onclick: () => close() }, device.user_name ?? device.user_id)),
            h('dt', {}, t('系统')), h('dd', {}, (OS[device.platform] ?? device.platform) + ' ' + device.arch),
            h('dt', {}, t('客户端')), h('dd', {}, device.client_version || '—'),
            h('dt', {}, t('DSH 运行时')), h('dd', {}, device.dsh_version || '—'),
            h('dt', {}, t('注册时间')), h('dd', {}, absolute(device.created_at)),
            h('dt', {}, t('最后在线')), h('dd', {}, absolute(device.last_seen_at)),
            h('dt', {}, t('设备 ID')), h('dd', { class: 'mono' }, device.id)) }),
        ],
        actions: [revoke, button(t('关闭'), { onclick: () => close() })],
      }
    },
  })
}
