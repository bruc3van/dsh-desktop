// Numbers, money and time in the console's language, plus the small bar pieces usage pages share.
import { lang, t } from './i18n.js'
import { h } from './ui.js'

/** 12,345 → 1.2万 / 12.3K; small numbers in full. */
export function compact(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  const fixed = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''))
  if (lang === 'zh') {
    if (n >= 1e8) return fixed(n / 1e8) + '亿'
    if (n >= 1e4) return fixed(n / 1e4) + '万'
    return n.toLocaleString()
  }
  if (n >= 1e9) return fixed(n / 1e9) + 'B'
  if (n >= 1e6) return fixed(n / 1e6) + 'M'
  if (n >= 1e4) return fixed(n / 1e3) + 'K'
  return n.toLocaleString()
}

export const full = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString())

/** Micro-yuan → ¥12.34; amounts under a fen keep four decimals so small tests still show. */
export function yuan(micros) {
  if (micros === null || micros === undefined) return '—'
  const value = Number(micros) / 1e6
  const digits = value === 0 || value >= 0.01 ? 2 : 4
  return '¥' + value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Yuan per million tokens, as entered in the catalog. */
export const price = (value) => (value === null || value === undefined ? '—' : '¥' + Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 }))

export function percent(part, whole) {
  if (!whole) return '—'
  const value = part / whole * 100
  return (value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)) + '%'
}

export function duration(ms) {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1) + ' s' : Math.round(ms) + ' ms'
}

/** A thin horizontal bar; widths go through the CSSOM because inline style attributes are blocked by the CSP. */
export function shareBar(part, whole, label) {
  const fill = h('span', { class: 'share-fill' })
  fill.style.width = (whole > 0 ? Math.max(1, Math.min(100, part / whole * 100)) : 0) + '%'
  return h('div', { class: 'share' }, h('div', { class: 'share-track' }, fill), label !== undefined && h('span', { class: 'share-label' }, label))
}

/** Used against a limit, coloured at 80% and 100%. */
export function meter(used, amount) {
  const ratio = amount > 0 ? used / amount : 0
  const fill = h('span')
  fill.style.width = Math.min(100, ratio * 100) + '%'
  return h('div', { class: 'meter' + (ratio >= 1 ? ' bad' : ratio >= 0.8 ? ' warn' : ''), role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(amount), 'aria-valuenow': String(used) }, fill)
}

/** A limit's amount in its own unit. */
export function quotaAmount(metric, value) {
  if (metric === 'cost') return yuan(value)
  if (metric === 'tokens') return compact(value) + ' Token'
  return full(value) + ' ' + t('次')
}

export const PERIOD_LABEL = { minute: t('每分钟'), '5h': t('每 5 小时'), day: t('每天'), week: t('每周'), month: t('每月') }
export const METRIC_LABEL = { tokens: t('Token 数'), cost: t('费用'), requests: t('请求数') }

/** Move a YYYY-MM-DD day by a number of days. */
export function shiftDay(day, days) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10)
}
