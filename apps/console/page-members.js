import { t, tf } from './i18n.js'
import { actionLabel, actionTone, api, DEVICE_STATE, deviceState, ROLE_LABEL } from './api.js'
import {
  badge, busy, button, callout, confirmAction, empty, field, h, icon, initials, openDialog, pageHead, panel, relative, searchBox, select,
  table, timeCell, toast,
} from './ui.js'
import { compact, full, meter, percent, PERIOD_LABEL, quotaAmount, shareBar, shiftDay, yuan } from './format.js'
import { quotaDialog, resetText, scopeName } from './page-quotas.js'

const roleBadge = (role) => badge(ROLE_LABEL[role] ?? role, role === 'admin' ? 'accent plain' : 'plain')
const statusBadge = (status) => (status === 'active' ? badge(t('在职'), 'ok') : badge(t('已停用'), 'bad'))

function departmentPaths(departments) {
  const byId = new Map(departments.map(dep => [dep.id, dep]))
  const path = (id) => {
    const parts = []
    let current = byId.get(id)
    while (current && parts.length < 20) { parts.unshift(current.name); current = byId.get(current.parent_id) }
    return parts.join(' / ')
  }
  return path
}

function departmentOptions(departments, path) {
  return [['', t('不属于任何部门')], ...departments.map(dep => [dep.id, path(dep.id)]).sort((a, b) => a[1].localeCompare(b[1], 'zh'))]
}

// ---------- list ----------

export async function renderList(ctx) {
  const [users, departments, devices] = await Promise.all([api('GET', '/admin/api/users'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/devices')])
  const path = departmentPaths(departments)
  const filters = { text: '', department: ctx.query.get('department') ?? '', role: '', status: 'active' }
  const deviceCount = new Map()
  const lastSeen = new Map()
  for (const device of devices.filter(item => item.status === 'active')) {
    deviceCount.set(device.user_id, (deviceCount.get(device.user_id) ?? 0) + 1)
    lastSeen.set(device.user_id, Math.max(lastSeen.get(device.user_id) ?? 0, device.last_seen_at))
  }
  const tableHost = h('div')
  const result = h('span', { class: 'result' })
  const draw = () => {
    const text = filters.text.trim().toLowerCase()
    const rows = users.filter(user =>
      (text === '' || user.name.toLowerCase().includes(text) || (user.email ?? '').includes(text))
      && (filters.department === '' || path(user.department_id) === path(filters.department) || path(user.department_id).startsWith(path(filters.department) + ' / '))
      && (filters.role === '' || user.role === filters.role)
      && (filters.status === '' || user.status === filters.status))
    result.textContent = tf('{n} 人', { n: rows.length })
    tableHost.replaceChildren(table([
      { label: t('成员'), cell: user => h('div', { class: 'title-line' }, h('span', { class: 'avatar' }, initials(user.name)),
        h('div', {}, h('div', { class: 'cell-title' }, user.name), h('div', { class: 'cell-sub' }, user.email ?? '—'))) },
      { label: t('部门'), cell: user => path(user.department_id) || h('span', { class: 'faint' }, '—') },
      { label: t('角色'), cell: user => roleBadge(user.role) },
      { label: t('状态'), cell: user => statusBadge(user.status) },
      { label: t('设备'), className: 'right', cell: user => h('span', { class: 'num' }, deviceCount.get(user.id) ?? 0) },
      { label: t('最后在线'), cell: user => (lastSeen.has(user.id) ? timeCell(lastSeen.get(user.id)) : h('span', { class: 'faint' }, t('从未'))) },
    ], rows, {
      onRow: user => { location.hash = '#/members/' + user.id },
      emptyState: empty({ iconName: 'people', title: t('没有符合条件的成员'), text: t('换个筛选条件，或者导入成员。') }),
    }))
  }
  const writable = ctx.canWrite()
  ctx.render([{ label: t('成员') }], [
    pageHead({
      title: t('成员'),
      description: t('能登录 DSH Desktop Pro 的人。部门决定他们拿到哪些场景包；停用后会立即结束登录、吊销网关 Key，并让他们的设备清除企业配置。'),
      actions: writable ? [
        button(t('导入 CSV'), { iconName: 'upload', onclick: () => importDialog(ctx) }),
        button(t('添加成员'), { kind: 'primary', iconName: 'plus', onclick: () => memberDialog(ctx, departments, path) }),
      ] : [],
    }),
    panel({
      flush: true,
      body: [
        h('div', { class: 'toolbar' },
          searchBox(t('按姓名或邮箱搜索'), value => { filters.text = value; draw() }),
          select(departmentOptions(departments, path).map(([id, label]) => [id, id === '' ? t('全部部门') : label]), filters.department, value => { filters.department = value; draw() }, t('部门')),
          select([['', t('全部角色')], ['member', t('成员')], ['admin', t('管理员')], ['auditor', t('审计员')]], '', value => { filters.role = value; draw() }, t('角色')),
          select([['active', t('在职')], ['disabled', t('已停用')], ['', t('全部状态')]], 'active', value => { filters.status = value; draw() }, t('状态')),
          h('span', { class: 'spacer' }), result),
        tableHost,
      ],
    }),
  ])
  draw()
}

// ---------- add / edit ----------

function memberDialog(ctx, departments, path, person) {
  const name = h('input', { value: person?.name ?? '', autocomplete: 'off' })
  const email = h('input', { type: 'email', value: person?.email ?? '', autocomplete: 'off', disabled: person !== undefined })
  const department = select(departmentOptions(departments, path), person?.department_id ?? '', () => {}, t('部门'))
  const role = select([['member', t('成员')], ['admin', t('管理员')], ['auditor', t('审计员（只读）')]], person?.role ?? 'member', () => {}, t('角色'))
  return openDialog({
    title: person ? tf('修改 {name}', { name: person.name }) : t('添加成员'),
    drawer: true,
    build: (close) => {
      const save = button(person ? t('保存修改') : t('添加成员'), { kind: 'primary', onclick: () => busy(save, async () => {
        const body = { name: name.value, role: role.value, departmentId: department.value }
        if (person) await api('PATCH', '/admin/api/users/' + person.id, body)
        else await api('POST', '/admin/api/users', { ...body, email: email.value })
        toast(person ? t('已保存') : tf('已添加 {name}', { name: name.value }))
        close(true)
        ctx.refresh()
      }) })
      return {
        body: [
          field(t('姓名'), name),
          field(t('邮箱'), email, person ? t('邮箱用来匹配企业账号登录，添加后不能修改。') : t('必须和企业 SSO 里的邮箱一致，登录时靠它认出这个人。')),
          field(t('部门'), department, t('决定这个人拿到哪个部门的场景包。')),
          field(t('角色'), role, t('管理员可以修改所有配置；审计员可以查看控制台，但不能修改。')),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

// ---------- import ----------

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1 }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some(value => value.trim() !== '')) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell)
  if (row.some(value => value.trim() !== '')) rows.push(row)
  return rows
}

function importDialog(ctx) {
  const text = h('textarea', { class: 'code', rows: 8, placeholder: t('name,email,department,role\n张三,zhangsan@example.com,财务部/应付组,member') })
  text.style.minHeight = '140px'
  const preview = h('div')
  const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'hidden' })
  return openDialog({
    title: t('导入成员'),
    wide: true,
    build: (close) => {
      const run = button(t('导入'), { kind: 'primary', disabled: true, onclick: () => busy(run, async () => {
        const result = await api('POST', '/admin/api/users/import', text.value)
        toast(tf('新增 {created} 人，更新 {updated} 人', { created: result.created, updated: result.updated }) + (result.errors.length ? tf('，{n} 行没有导入', { n: result.errors.length }) : ''), result.errors.length ? 'bad' : '')
        close(true)
        ctx.refresh()
      }) })
      const check = () => {
        const rows = parseCsv(text.value.replace(/^﻿/, ''))
        const header = (rows[0] ?? []).map(cell => cell.trim().toLowerCase())
        const col = (name) => header.indexOf(name)
        if (rows.length === 0) { preview.replaceChildren(); run.disabled = true; return }
        if (col('name') < 0 || col('email') < 0) {
          preview.replaceChildren(callout('bad', t('第一行必须是列名，至少包含 name 和 email。')))
          run.disabled = true
          return
        }
        const body = rows.slice(1)
        const valid = (row) => (row[col('name')] ?? '').trim() !== '' && /^[^@\s]+@[^@\s]+$/.test((row[col('email')] ?? '').trim())
          && ['', 'member', 'admin', 'auditor'].includes((row[col('role')] ?? '').trim())
        const bad = body.filter(row => !valid(row)).length
        run.disabled = body.length === bad
        run.textContent = tf('导入 {n} 人', { n: body.length - bad })
        preview.replaceChildren(
          bad > 0 ? callout('warn', tf('{n} 行格式不对，不会导入（姓名为空、邮箱无效或角色不认识）。', { n: bad })) : callout('info', tf('共 {n} 行。已存在的邮箱会更新姓名、部门和角色。', { n: body.length })),
          table([
            { label: t('姓名'), cell: row => row[col('name')] ?? '' },
            { label: t('邮箱'), cell: row => row[col('email')] ?? '' },
            { label: t('部门'), cell: row => (col('department') >= 0 ? row[col('department')] : '') || '—' },
            { label: t('角色'), cell: row => ROLE_LABEL[(row[col('role')] ?? '').trim() || 'member'] ?? row[col('role')] },
            { label: '', cell: row => (valid(row) ? '' : badge(t('跳过'), 'bad')) },
          ], body.slice(0, 50)))
      }
      text.addEventListener('input', check)
      file.addEventListener('change', async () => { text.value = await file.files[0].text(); check() })
      return {
        body: [
          h('p', { class: 'muted' }, t('第一行是列名：name、email、department、role。部门用「/」分隔上下级，比如「财务部/应付组」，不存在的部门会自动创建。role 可以是 member、admin、auditor，留空就是 member。')),
          h('div', { class: 'inline-add' }, button(t('选择 CSV 文件'), { iconName: 'upload', onclick: () => file.click() }), file),
          text, preview,
        ],
        actions: [button(t('取消'), { onclick: () => close() }), run],
      }
    },
  })
}

// ---------- detail ----------

export async function renderDetail(ctx, id) {
  const [users, departments, devices, events] = await Promise.all([
    api('GET', '/admin/api/users'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/devices'), api('GET', '/admin/api/audit?limit=50&actor=' + encodeURIComponent(id)),
  ])
  const person = users.find(user => user.id === id)
  if (!person) throw new Error(t('这个成员不存在。'))
  const path = departmentPaths(departments)
  const mine = devices.filter(device => device.user_id === id)
  const revision = ctx.me.organization.revision
  const writable = ctx.canWrite()
  const preview = h('div', {}, h('p', { class: 'muted' }, t('正在计算…')))
  const usageHost = h('div', {}, h('p', { class: 'muted' }, t('正在读取…')))

  const toggleStatus = async () => {
    const disabling = person.status === 'active'
    const ok = disabling
      ? await confirmAction({ title: tf('停用 {name}', { name: person.name }), text: tf('会立即结束 {name} 的所有登录、吊销他的网关 Key 和全部设备。设备几秒内就会删除组织下发的凭据、插件配置和 Skill（离线的设备在下次联网时删除）。他的会话记录会保留。', { name: person.name }), confirmLabel: t('停用'), typeToConfirm: person.name })
      : await confirmAction({ title: tf('恢复 {name}', { name: person.name }), text: t('恢复后，他需要重新用企业账号登录；之前吊销的设备会重新注册。'), confirmLabel: t('恢复'), danger: false })
    if (!ok) return
    await busy(null, async () => {
      await api('PATCH', '/admin/api/users/' + id, { status: disabling ? 'disabled' : 'active' })
      toast(disabling ? tf('已停用 {name}', { name: person.name }) : tf('已恢复 {name}', { name: person.name }))
      ctx.refresh()
    })
  }

  ctx.render([{ label: t('成员'), href: '#/members' }, { label: person.name }], [
    pageHead({
      title: person.name,
      badges: [roleBadge(person.role), statusBadge(person.status)],
      description: person.email ?? undefined,
      actions: writable ? [
        button(t('修改'), { iconName: 'edit', onclick: () => memberDialog(ctx, departments, path, person) }),
        person.status === 'active'
          ? button(t('停用'), { kind: 'danger-outline', iconName: 'ban', onclick: toggleStatus })
          : button(t('恢复'), { iconName: 'refresh', onclick: toggleStatus }),
      ] : [],
    }),
    person.status !== 'active' ? callout('warn', t('这个成员已停用：不能登录，网关 Key 已吊销，设备会清除企业配置。')) : null,
    h('div', { class: 'grid-2' },
      h('div', {},
        panel({
          title: t('设备'),
          description: t('这个人登录过的电脑，以及每台电脑用上的配置版本。'),
          flush: true,
          body: table([
            { label: t('设备'), cell: device => h('div', {}, h('div', { class: 'cell-title' }, device.hostname || t('未命名设备')), h('div', { class: 'cell-sub' }, platformLabel(device))) },
            { label: t('配置'), cell: device => { const state = DEVICE_STATE[deviceState(device, revision)]; return badge(state.label, state.tone) } },
            { label: t('版本'), cell: device => h('span', { class: 'num' }, device.applied_revision === null ? '—' : 'r' + device.applied_revision) },
            { label: t('最后在线'), cell: device => timeCell(device.last_seen_at) },
          ], mine, { onRow: () => { location.hash = '#/devices?user=' + id }, emptyState: empty({ iconName: 'device', title: t('还没有设备'), text: tf('{name} 第一次在电脑上登录 DSH Desktop Pro 后，设备会出现在这里。', { name: person.name }) }) }),
        }),
        ctx.me.gateway === 'direct' && panel({
          title: t('用量与额度'),
          description: t('最近 30 天经过内置网关的用量，以及对他生效的额度。'),
          actions: [h('a', { class: 'btn small', href: '#/usage?user=' + encodeURIComponent(id) }, t('查看明细'))],
          body: usageHost,
        }),
        panel({ title: t('当前会收到的配置'), description: t('按他的部门和个人分配合并后的结果，和设备下次拉取到的一致。密钥已隐藏。'), body: preview }),
        panel({
          title: t('最近活动'),
          flush: true,
          body: events.length === 0 ? empty({ iconName: 'history', title: t('还没有活动记录') }) : h('ul', { class: 'feed' }, events.slice(0, 12).map(event => h('li', {},
            h('div', { class: 'feed-icon ' + actionTone(event.action) }, icon('history')),
            h('div', { class: 'feed-text' }, actionLabel(event.action)),
            h('div', { class: 'feed-time' }, relative(event.at))))),
        })),
      panel({
        title: t('基本信息'),
        body: h('dl', { class: 'props' },
          h('dt', {}, t('部门')), h('dd', {}, path(person.department_id) || '—'),
          h('dt', {}, t('角色')), h('dd', {}, ROLE_LABEL[person.role]),
          h('dt', {}, t('邮箱')), h('dd', {}, person.email ?? '—'),
          h('dt', {}, t('成员 ID')), h('dd', { class: 'mono' }, person.id)),
      })),
  ])
  if (ctx.me.gateway === 'direct') void memberUsage(ctx, person, departments).then(nodes => usageHost.replaceChildren(...nodes.filter(Boolean)), error => usageHost.replaceChildren(callout('bad', error.message)))
  try {
    const state = await api('GET', '/admin/api/users/' + id + '/desired-state')
    preview.replaceChildren(summarizeState(state))
  } catch (error) {
    preview.replaceChildren(callout('bad', error.message))
  }
}

/** Thirty days of one person's usage, their top models, and every limit that covers them. */
async function memberUsage(ctx, person, departments) {
  const to = ctx.me.today
  const [summary, status, catalog, users] = await Promise.all([
    api('GET', '/admin/api/usage/summary?' + new URLSearchParams({ from: shiftDay(to, -29), to, user: person.id })),
    api('GET', '/admin/api/users/' + person.id + '/quotas'), api('GET', '/admin/api/catalog'), api('GET', '/admin/api/users'),
  ])
  const modelName = new Map(catalog.models.map(model => [model.id, model.name]))
  const people = new Map(users.map(user => [user.id, user]))
  const deptName = new Map(departments.map(dep => [dep.id, dep.name]))
  const totals = summary.totals
  const figure = (label, value) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value))
  return [
    h('div', { class: 'usage-figures' }, figure(t('请求'), full(totals.requests)), figure('Token', compact(totals.tokens)), figure(t('费用'), yuan(totals.costMicros))),
    summary.byModel.length > 0 && h('div', { class: 'section-title' }, t('常用模型')),
    summary.byModel.length > 0 && table([
      { label: t('模型'), cell: row => modelName.get(row.key) ?? row.key },
      { label: t('请求'), className: 'num', cell: row => full(row.requests) },
      { label: t('费用'), className: 'num', cell: row => yuan(row.costMicros) },
      { label: t('占比'), cell: row => shareBar(row.tokens, totals.tokens, percent(row.tokens, totals.tokens)) },
    ], summary.byModel.slice(0, 5)),
    h('div', { class: 'section-title' }, t('生效的额度')),
    status.length === 0
      ? h('p', { class: 'muted' }, t('没有额度限制他的用量。'))
      : h('ul', { class: 'quota-lines' }, status.map(item => h('li', {},
        h('div', { class: 'quota-head' }, h('span', {}, scopeName(item.quota, people, deptName) + ' · ' + PERIOD_LABEL[item.quota.period] + ' ' + quotaAmount(item.quota.metric, item.quota.amount)),
          h('span', { class: item.spent ? 'bad-text' : 'faint' }, item.spent ? (item.quota.action === 'fallback' ? tf('已用完，改用 {m}', { m: modelName.get(item.quota.fallbackModel) ?? item.quota.fallbackModel }) : t('已用完')) : quotaAmount(item.quota.metric, item.used))),
        meter(item.used, item.quota.amount),
        h('div', { class: 'cell-sub' }, resetText(item.reset))))),
    ctx.canWrite() && h('div', { class: 'inline-add' }, button(t('给他单独设额度'), { kind: 'small', iconName: 'plus', onclick: async () => {
      quotaDialog(ctx, { users, departments, catalog }, undefined, { scopeType: 'user', scopeId: person.id })
    } })),
  ]
}

function platformLabel(device) {
  const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[device.platform] ?? device.platform
  return [os, device.arch, device.client_version && tf('客户端 {version}', { version: device.client_version })].filter(Boolean).join('，')
}

/** A readable summary of a desired state, with the raw JSON one click away. */
export function summarizeState(state) {
  const routes = Object.entries(state.models?.providers ?? {})
  const rows = [
    [t('模型'), routes.length === 0 ? t('未指定（员工自己配置）') : routes.map(([key, route]) => (route.displayName ?? key) + '：' + route.models.map(model => model.name ?? model.id).join('、')).join('；')],
    [t('默认模型'), state.models?.default ? state.models.default.model : '—'],
    [t('凭据'), Object.keys(state.credentials ?? {}).join('、') || '—'],
    [t('插件订阅'), (state.plugins?.indexes ?? []).join('\n') || '—'],
    [t('必装插件'), (state.plugins?.required ?? []).map(plugin => plugin.spec).join('、') || '—'],
    [t('禁止的插件'), (state.plugins?.blocked ?? []).join('、') || '—'],
    ['Skill', (state.skills ?? []).map(skill => skill.name).join('、') || '—'],
    [t('禁用的工具'), (state.tools?.deny ?? []).join('、') || '—'],
  ]
  const raw = h('pre', { class: 'code hidden' }, JSON.stringify(state, null, 2))
  return h('div', {},
    h('dl', { class: 'props' }, rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
    h('div', { class: 'inline-add' }, button(t('查看 JSON'), { kind: 'small ghost', onclick: (event) => { raw.classList.toggle('hidden'); event.currentTarget.textContent = raw.classList.contains('hidden') ? t('查看 JSON') : t('收起 JSON') } })),
    raw)
}

// ---------- departments ----------

export async function renderDepartments(ctx) {
  const [departments, users] = await Promise.all([api('GET', '/admin/api/departments'), api('GET', '/admin/api/users')])
  const children = new Map()
  for (const dep of departments) {
    const parent = dep.parent_id ?? ''
    children.set(parent, [...(children.get(parent) ?? []), dep])
  }
  const direct = new Map()
  for (const user of users.filter(item => item.status === 'active')) direct.set(user.department_id, (direct.get(user.department_id) ?? 0) + 1)
  const total = (id) => (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, child) => sum + total(child.id), 0)
  const writable = ctx.canWrite()
  const rows = []
  const walk = (parent, depth) => {
    for (const dep of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      const indent = h('span', {})
      indent.style.width = String(depth * 20) + 'px'
      indent.style.flex = 'none'
      rows.push(h('li', { class: 'tree-row' }, indent, icon(children.has(dep.id) ? 'tree' : 'people'),
        h('a', { href: '#/members?department=' + dep.id }, dep.name),
        h('span', { class: 'count' }, tf('{n} 人', { n: total(dep.id) })),
        writable && h('span', { class: 'tree-actions' }, button('', { kind: 'ghost icon-only small', iconName: 'plus', title: tf('在「{name}」下新建部门', { name: dep.name }), onclick: () => departmentDialog(ctx, dep) }))))
      walk(dep.id, depth + 1)
    }
  }
  walk('', 0)
  ctx.render([{ label: t('部门') }], [
    pageHead({
      title: t('部门'),
      description: t('场景包可以分配给部门，下级部门会继承上级部门的配置。导入成员时，CSV 里写到的部门会自动建好。'),
      actions: writable ? [button(t('新建部门'), { kind: 'primary', iconName: 'plus', onclick: () => departmentDialog(ctx) })] : [],
    }),
    panel({
      flush: true,
      body: rows.length === 0
        ? empty({ iconName: 'tree', title: t('还没有部门'), text: t('新建部门，或者在导入成员时一起建好。'), action: writable ? button(t('新建部门'), { kind: 'primary', onclick: () => departmentDialog(ctx) }) : null })
        : h('ul', { class: 'tree' }, rows),
    }),
  ])
}

function departmentDialog(ctx, parent) {
  const name = h('input', { autocomplete: 'off' })
  return openDialog({
    title: parent ? tf('在「{name}」下新建部门', { name: parent.name }) : t('新建部门'),
    build: (close) => {
      const save = button(t('新建'), { kind: 'primary', onclick: () => busy(save, async () => {
        await api('POST', '/admin/api/departments', { name: name.value, parentId: parent?.id ?? '' })
        toast(tf('已新建「{name}」', { name: name.value }))
        close(true)
        ctx.refresh()
      }) })
      return { body: [field(t('部门名称'), name)], actions: [button(t('取消'), { onclick: () => close() }), save] }
    },
  })
}
