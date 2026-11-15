// The rollout bar: how far the current configuration revision has reached.
import { t, tf } from './i18n.js'
import { DEVICE_STATE, deviceState } from './api.js'
import { h } from './ui.js'

const ORDER = ['current', 'pending', 'attention', 'offline']

export function tally(devices, revision) {
  const counts = { current: 0, pending: 0, attention: 0, offline: 0, revoked: 0, personal: 0 }
  for (const device of devices) counts[deviceState(device, revision)] += 1
  return counts
}

/** `compact` drops the headline figure, for use inside other pages. */
export function rolloutPanel(devices, revision, { compact = false, caption } = {}) {
  const counts = tally(devices, revision)
  const total = ORDER.reduce((sum, state) => sum + counts[state], 0)
  const percent = total === 0 ? 0 : Math.round(counts.current / total * 100)
  const bar = h('div', { class: 'rollout-bar', role: 'img', 'aria-label': tf('已生效 {n} 台，共 {total} 台', { n: counts.current, total }) },
    ORDER.filter(state => counts[state] > 0).map(state => h('span', {
      class: DEVICE_STATE[state].segment,
      'data-grow': String(counts[state]),
      title: tf('{label} {n} 台', { label: DEVICE_STATE[state].label, n: counts[state] }),
    })))
  // Widths through flex-grow set from script: inline style attributes are blocked by the CSP.
  for (const span of bar.children) span.style.flexGrow = span.dataset.grow
  const legend = h('div', { class: 'legend' }, ORDER.map(state => h('a', { href: '#/devices?state=' + state },
    h('i', { class: DEVICE_STATE[state].segment }), h('span', { class: 'legend-label' }, DEVICE_STATE[state].label), h('b', {}, counts[state]))))
  if (total === 0) {
    return h('div', { class: 'rollout' + (compact ? ' compact' : '') },
      h('div', { class: 'muted' }, t('还没有设备注册。把注册文件分发给员工电脑后，这里会显示配置的生效进度。')))
  }
  return h('div', { class: 'rollout' + (compact ? ' compact' : '') },
    !compact && h('div', { class: 'rollout-top' },
      h('div', { class: 'rollout-figure' }, percent, h('small', {}, '%')),
      h('div', { class: 'rollout-caption' }, caption ?? tf('的设备已用上当前配置（{n} / {total} 台）', { n: counts.current, total })),
      h('div', { class: 'rollout-revision' }, h('div', { class: 'faint' }, t('当前配置版本')), h('b', {}, 'r' + revision))),
    compact && h('div', { class: 'muted' }, caption ?? tf('已生效 {n} / {total} 台', { n: counts.current, total })),
    bar, legend)
}
