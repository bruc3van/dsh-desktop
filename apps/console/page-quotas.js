// Limits on the built-in gateway: company, department and per-person budgets, and what happens when one is spent.
import { lang, t, tf } from './i18n.js'
import { api } from './api.js'
import { METRIC_LABEL, PERIOD_LABEL, meter, quotaAmount } from './format.js'
import { badge, busy, button, callout, confirmAction, empty, field, h, openDialog, pageHead, panel, select, table, toast } from './ui.js'

export const SCOPE_LABEL = { tenant: t('全公司合计'), department: t('部门合计'), member_default: t('每位成员（默认）'), user: t('指定成员') }

export function scopeName(quota, people, departments) {
  if (quota.scopeType === 'department') return tf('{d}（部门合计）', { d: departments.get(quota.scopeId) ?? quota.scopeId })
  if (quota.scopeType === 'user') return people.get(quota.scopeId)?.name ?? quota.scopeId
  return SCOPE_LABEL[quota.scopeType]
}

export function actionText(quota, modelName) {
  return quota.action === 'fallback'
    ? tf('改用 {m}', { m: modelName.get(quota.fallbackModel) ?? quota.fallbackModel })
    : t('拦截请求')
}

export function resetText(reset) {
  if (!reset) return t('滚动窗口')
  const at = new Date(reset)
  const midnight = at.getHours() === 0 && at.getMinutes() === 0
  return tf('{at} 重置', { at: at.toLocaleString(lang === 'en' ? 'en' : 'zh-CN', midnight ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
}

export async function render(ctx) {
  const [overview, users, departments, catalog] = await Promise.all([
    api('GET', '/admin/api/quotas'), api('GET', '/admin/api/users'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/catalog'),
  ])
  const people = new Map(users.map(user => [user.id, user]))
  const deptName = new Map(departments.map(dep => [dep.id, dep.name]))
  const modelName = new Map(catalog.models.map(model => [model.id, model.name]))
  const writable = ctx.canWrite()
  const order = { tenant: 0, department: 1, member_default: 2, user: 3 }
  const rows = [...overview].sort((a, b) => order[a.quota.scopeType] - order[b.quota.scopeType])
  const watch = []
  for (const item of overview) {
    if (item.quota.scopeType === 'member_default') for (const person of item.people) watch.push({ userId: person.userId, used: person.used, quota: item.quota, reset: item.reset })
    if (item.quota.scopeType === 'user' && item.used >= item.quota.amount * 0.8) watch.push({ userId: item.quota.scopeId, used: item.used, quota: item.quota, reset: item.reset })
  }
  watch.sort((a, b) => b.used / b.quota.amount - a.used / a.quota.amount)

  const remove = async (quota) => {
    if (!await confirmAction({ title: t('删除这条额度'), text: t('删除后，这条额度立即不再生效。已有的用量记录不受影响。'), confirmLabel: t('删除') })) return
    await busy(null, async () => { await api('DELETE', '/admin/api/quotas/' + quota.id); toast(t('已删除额度')); ctx.refresh() })
  }

  ctx.render([{ label: t('额度') }], [
    pageHead({
      title: t('额度'),
      description: t('给全公司、部门和每个人设置用量上限。网关在转发每个请求前检查：所有相关额度都还有余量才放行。'),
      actions: writable ? [button(t('新建额度'), { kind: 'primary', iconName: 'plus', onclick: () => quotaDialog(ctx, { users, departments, catalog }) })] : [],
    }),
    ctx.me.gateway !== 'direct' && callout('warn', t('额度只对内置网关生效（DSH_GATEWAY=direct）。')),
    panel({
      title: t('额度规则'),
      flush: true,
      body: table([
        { label: t('适用于'), cell: item => h('div', {}, h('div', { class: 'cell-title' }, scopeName(item.quota, people, deptName)), h('div', { class: 'cell-sub' }, PERIOD_LABEL[item.quota.period] + ' · ' + METRIC_LABEL[item.quota.metric])) },
        { label: t('上限'), className: 'num', cell: item => quotaAmount(item.quota.metric, item.quota.amount) },
        { label: t('已用'), cell: item => item.used === null
          ? h('div', { class: 'cell-sub' }, item.people.length === 0 ? t('没有人超过 80%') : tf('{n} 人超过 80%', { n: item.people.length }))
          : h('div', { class: 'quota-use' }, meter(item.used, item.quota.amount), h('div', { class: 'cell-sub' }, quotaAmount(item.quota.metric, item.used) + ' · ' + resetText(item.reset))) },
        { label: t('用完后'), cell: item => badge(actionText(item.quota, modelName), item.quota.action === 'fallback' ? 'accent' : 'bad') },
        { label: '', className: 'right', cell: item => writable && h('div', { class: 'row-actions' },
          button(t('修改'), { kind: 'small ghost', onclick: () => quotaDialog(ctx, { users, departments, catalog }, item.quota) }),
          button(t('删除'), { kind: 'small ghost', onclick: () => remove(item.quota) })) },
      ], rows, { emptyState: empty({ iconName: 'gauge', title: t('还没有额度'), text: t('不设额度时不限用量。建议先给每位成员设一个每月费用上限，再按部门设预算。'), action: writable && button(t('新建额度'), { kind: 'primary', iconName: 'plus', onclick: () => quotaDialog(ctx, { users, departments, catalog }) }) }) }),
    }),
    panel({
      title: t('接近或已用完额度的成员'),
      description: t('个人额度用到 80% 以上的人。用完后，按规则拦截或改用便宜的模型。'),
      flush: true,
      body: table([
        { label: t('成员'), cell: row => h('a', { href: '#/members/' + row.userId }, people.get(row.userId)?.name ?? row.userId) },
        { label: t('额度'), cell: row => PERIOD_LABEL[row.quota.period] + ' ' + quotaAmount(row.quota.metric, row.quota.amount) },
        { label: t('已用'), cell: row => h('div', { class: 'quota-use' }, meter(row.used, row.quota.amount), h('div', { class: 'cell-sub' }, quotaAmount(row.quota.metric, row.used))) },
        { label: t('状态'), cell: row => row.used >= row.quota.amount ? badge(row.quota.action === 'fallback' ? t('已降级') : t('已用完'), row.quota.action === 'fallback' ? 'warn' : 'bad') : badge(t('接近上限'), 'warn') },
      ], watch, { emptyState: empty({ iconName: 'check', title: t('没有人接近上限') }) }),
    }),
    callout('info', t('「每位成员（默认）」对每个人单独计算；给某个人单独设了同周期、同指标的额度后，以他自己的为准。部门合计包含下级部门。')),
  ])
}

export function quotaDialog(ctx, { users, departments, catalog }, quota, preset = {}) {
  const draft = quota
    ? { ...quota, amount: quota.metric === 'cost' ? quota.amount / 1e6 : quota.amount }
    : { scopeType: 'member_default', scopeId: null, period: 'month', metric: 'cost', amount: '', action: 'block', fallbackModel: null, ...preset }
  return openDialog({
    title: quota ? t('修改额度') : t('新建额度'),
    build: (close) => {
      const host = h('div')
      const save = button(t('保存'), { kind: 'primary', onclick: () => busy(save, async () => {
        const body = { scopeType: draft.scopeType, scopeId: draft.scopeId, period: draft.period, metric: draft.metric, amount: Number(draft.amount), action: draft.action, fallbackModel: draft.fallbackModel }
        if (!(body.amount > 0)) throw new Error(t('请填写大于 0 的上限。'))
        if (quota) await api('PATCH', '/admin/api/quotas/' + quota.id, body)
        else await api('POST', '/admin/api/quotas', body)
        toast(t('已保存额度'))
        close(true)
        ctx.refresh()
      }) })
      const unit = () => (draft.metric === 'cost' ? t('元') : draft.metric === 'tokens' ? 'Token' : t('次'))
      const draw = () => host.replaceChildren(...[
        field(t('适用于'), select(Object.entries(SCOPE_LABEL), draft.scopeType, (value) => { draft.scopeType = value; draft.scopeId = null; draw() }, t('适用于')),
          { tenant: t('全公司所有人的用量加在一起计算。'), department: t('这个部门（含下级部门）所有人的用量加在一起计算。'), member_default: t('每个人分别计算，适合做人均上限。'), user: t('只对这个人生效，优先于「每位成员（默认）」。') }[draft.scopeType]),
        draft.scopeType === 'department' && field(t('部门'), select([['', t('选择部门')], ...departments.map(dep => [dep.id, dep.name])], draft.scopeId ?? '', (value) => { draft.scopeId = value || null }, t('部门'))),
        draft.scopeType === 'user' && field(t('成员'), select([['', t('选择成员')], ...users.filter(user => user.status === 'active').map(user => [user.id, user.name + (user.email ? '（' + user.email + '）' : '')])], draft.scopeId ?? '', (value) => { draft.scopeId = value || null }, t('成员'))),
        h('div', { class: 'field-row' },
          field(t('统计'), select(Object.entries(METRIC_LABEL), draft.metric, (value) => { draft.metric = value; draw() }, t('统计'))),
          field(t('周期'), select(Object.entries(PERIOD_LABEL), draft.period, (value) => { draft.period = value }, t('周期')))),
        field(tf('上限（{u}）', { u: unit() }), h('input', { type: 'number', min: '0', step: draft.metric === 'cost' ? '0.01' : '1', value: draft.amount, oninput: (event) => { draft.amount = event.target.value } }),
          draft.metric === 'cost' ? t('按模型目录里的价格计算；没有定价的模型不计费用。') : draft.metric === 'tokens' ? t('输入（含缓存命中）加输出的 Token。') : t('每分钟请求数适合用来防止脚本刷接口。')),
        field(t('用完后'), select([['block', t('拦截请求，提示额度已用完')], ['fallback', t('改用指定的模型继续')]], draft.action, (value) => { draft.action = value; draw() }, t('用完后'))),
        draft.action === 'fallback' && field(t('改用的模型'), select([['', t('选择模型')], ...catalog.models.filter(model => model.enabled).map(model => [model.id, model.name + ' · ' + model.id])], draft.fallbackModel ?? '', (value) => { draft.fallbackModel = value || null }, t('改用的模型')),
          catalog.models.length === 0 ? t('先在模型目录里添加模型。') : t('通常选一个便宜的模型，让员工在额度用完后还能继续工作。')),
      ].filter(Boolean))
      draw()
      return { body: host, actions: [button(t('取消'), { onclick: () => close() }), save] }
    },
  })
}
