import { t, tf } from './i18n.js'
import { actionLabel, actionTone, api, deviceState } from './api.js'
import { rolloutPanel } from './rollout.js'
import { empty, h, icon, pageHead, panel, relative } from './ui.js'
import { shiftDay, yuan } from './format.js'

export async function render(ctx) {
  const [users, devices, profiles, events] = await Promise.all([
    api('GET', '/admin/api/users'), api('GET', '/admin/api/devices'), api('GET', '/admin/api/profiles'), api('GET', '/admin/api/audit?limit=200'),
  ])
  const usage = ctx.me.gateway === 'direct' ? await api('GET', '/admin/api/usage/summary?' + new URLSearchParams({ from: shiftDay(ctx.me.today, -29), to: ctx.me.today })).catch(() => null) : null
  const revision = ctx.me.organization.revision
  const active = devices.filter(device => device.status === 'active')
  const attention = active.filter(device => deviceState(device, revision) === 'attention')
  const dayAgo = Date.now() - 86_400_000
  const people = new Map(users.map(user => [user.id, user.name]))
  const changes = events.filter(event => event.actorType === 'admin').slice(0, 8)

  ctx.render([{ label: t('概览') }], [
    pageHead({ title: t('概览'), description: tf('{org} 的 DSH Desktop Pro 部署情况。配置修改后，在线设备几秒内就会用上新版本。', { org: ctx.me.organization.name }) }),
    h('section', { class: 'panel' }, rolloutPanel(active, revision)),
    h('div', { class: 'grid-2' },
      h('div', {},
        panel({
          title: t('需要处理'),
          description: t('应用配置时出了问题的设备。'),
          flush: true,
          body: attention.length === 0
            ? empty({ iconName: 'check', title: t('没有需要处理的设备'), text: t('所有上报了结果的设备都完整应用了配置。') })
            : h('ul', { class: 'feed' }, attention.map(device => h('li', {},
              h('div', { class: 'feed-icon bad' }, icon('alert')),
              h('div', { class: 'feed-text' },
                h('div', {}, h('a', { href: '#/members/' + device.user_id }, device.user_name ?? device.user_id), t(' 的 '), device.hostname || t('设备'), h('span', { class: 'faint' }, '（r' + (device.applied_revision ?? '—') + '）')),
                h('div', { class: 'cell-sub' }, (device.applied_problems ?? []).join('；') || t('部分配置没有生效'))),
              h('div', { class: 'feed-time' }, relative(device.applied_at))))),
        }),
        panel({
          title: t('最近的管理操作'),
          actions: [h('a', { class: 'btn small', href: '#/audit' }, t('查看审计日志'))],
          flush: true,
          body: changes.length === 0
            ? empty({ iconName: 'history', title: t('还没有管理操作') })
            : h('ul', { class: 'feed' }, changes.map(event => h('li', {},
              h('div', { class: 'feed-icon ' + actionTone(event.action) }, icon('edit')),
              h('div', { class: 'feed-text' }, h('div', {}, (event.actorId === 'bootstrap' ? t('初始管理员') : people.get(event.actorId) ?? event.actorId), ' ', actionLabel(event.action))),
              h('div', { class: 'feed-time' }, relative(event.at))))),
        })),
      panel({
        title: t('组织'),
        flush: true,
        body: h('ul', { class: 'stat-list' },
          stat(t('在职成员'), users.filter(user => user.status === 'active').length, '#/members'),
          stat(t('已停用成员'), users.filter(user => user.status !== 'active').length, '#/members'),
          stat(t('24 小时内在线设备'), active.filter(device => device.last_seen_at > dayAgo).length, '#/devices'),
          stat(t('场景包'), profiles.length, '#/profiles'),
          stat(t('模型网关'), ctx.me.gateway === 'litellm' ? 'LiteLLM' : ctx.me.gateway === 'direct' ? t('内置网关') : t('未接入'), '#/gateway'),
          usage && stat(t('近 30 天模型费用'), yuan(usage.totals.costMicros), '#/usage'),
          usage && stat(t('近 30 天活跃成员'), usage.totals.people, '#/usage?by=user')),
      })),
  ])
}

function stat(label, value, href) {
  return h('li', {}, h('a', { href }, label), h('span', { class: 'value' }, value))
}
