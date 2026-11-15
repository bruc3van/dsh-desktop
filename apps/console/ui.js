// Building blocks. Every node goes through h(): server data is never parsed as markup.
import { t, tf } from './i18n.js'

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else if (key === 'value') node.value = value
    else if (key === 'checked') node.checked = Boolean(value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

// ---------- icons (24px grid, stroked) ----------
const PATHS = {
  overview: ['M3 13h8V3H3z', 'M13 21h8V11h-8z', 'M3 21h8v-6H3z', 'M13 9h8V3h-8z'],
  people: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  tree: ['M5 3v6', 'M5 9a2 2 0 1 0 0 0', 'M5 9v9h6', 'M5 13h6', 'M14 11h6v4h-6z', 'M14 16h6v4h-6z', 'M3 3h4v4H3z'],
  layers: ['M12 2 2 7l10 5 10-5-10-5z', 'm2 17 10 5 10-5', 'm2 12 10 5 10-5'],
  gateway: ['M4 7h16', 'M4 12h16', 'M4 17h16', 'M8 4v16', 'M16 4v16'],
  device: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  chevron: ['m9 18 6-6-6-6'],
  down: ['m6 9 6 6 6-6'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  key: ['M21 2l-2 2', 'M15.5 7.5l3 3L22 7l-3-3', 'M11.4 12.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z', 'm11.4 12.6 4.1-4.1'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  copy: ['M9 9h11v11H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  ban: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'm4.9 4.9 14.2 14.2'],
  refresh: ['M21 12a9 9 0 0 1-15 6.7L3 16', 'M3 21v-5h5', 'M3 12a9 9 0 0 1 15-6.7L21 8', 'M21 3v5h-5'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  chart: ['M3 3v18h18', 'M8 17v-4', 'M13 17V8', 'M18 17v-7'],
  cpu: ['M6 6h12v12H6z', 'M10 10h4v4h-4z', 'M9 2v4', 'M15 2v4', 'M9 18v4', 'M15 18v4', 'M2 9h4', 'M2 15h4', 'M18 9h4', 'M18 15h4'],
  store: ['M3 9l1.5-5h15L21 9', 'M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z', 'M5 13v8h14v-8', 'M10 21v-5h4v5'],
  gauge: ['M3.5 18a10 10 0 1 1 17 0', 'm12 14 4-5', 'M12 14h.01'],
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

// ---------- small pieces ----------
export const badge = (text, tone = '') => h('span', { class: 'badge ' + tone }, text)
export const initials = (name) => (name ?? '?').trim().slice(0, 1).toUpperCase()

export function button(label, { kind = '', iconName, onclick, disabled, title, type = 'button' } = {}) {
  return h('button', { class: 'btn ' + kind, type, onclick, disabled, title, 'aria-label': title }, iconName && icon(iconName), label)
}

export function pageHead({ title, description, actions = [], badges = [] }) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'title-line' }, h('h1', {}, title), badges), description && h('p', {}, description)),
    actions.length > 0 && h('div', { class: 'actions' }, actions))
}

export function panel({ title, description, actions = [], body, flush = false, foot }) {
  return h('section', { class: 'panel' },
    title && h('header', { class: 'panel-head' }, h('div', {}, h('h2', {}, title), description && h('p', {}, description)), actions.length > 0 && h('div', { class: 'actions' }, actions)),
    h('div', { class: 'panel-body' + (flush ? ' flush' : '') }, body),
    foot && h('footer', { class: 'panel-foot' }, foot))
}

export function empty({ iconName = 'info', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName)), h('h3', {}, title), text && h('p', {}, text), action)
}

export function callout(tone, text) {
  return h('div', { class: 'callout ' + tone }, icon(tone === 'bad' || tone === 'warn' ? 'alert' : tone === 'ok' ? 'check' : 'info'), h('div', {}, text))
}

export function field(label, control, help, error) {
  return h('div', { class: 'field' }, h('label', {}, label), control, help && h('div', { class: 'help' }, help), error && h('div', { class: 'error' }, error))
}

export function tabs(items, active) {
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    items.map(item => h('a', { href: item.href, class: item.id === active ? 'active' : null, 'aria-current': item.id === active ? 'page' : null },
      item.label, item.count !== undefined && h('span', { class: 'count' }, item.count), item.dirty && h('span', { class: 'dot', title: t('有未保存的修改') }))))
}

/** A data table. columns: [{ label, cell(row), className }]; onRow(row) makes rows open details. */
export function table(columns, rows, { onRow, emptyState } = {}) {
  if (rows.length === 0 && emptyState) return emptyState
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, columns.map(column => h('th', { class: column.className ?? null }, column.label)))),
    h('tbody', {}, rows.map(row => h('tr', {
      class: onRow ? 'clickable' : null,
      tabindex: onRow ? '0' : null,
      onclick: onRow ? (event) => { if (!event.target.closest('button, a, select, input')) onRow(row) } : null,
      onkeydown: onRow ? (event) => { if (event.key === 'Enter') onRow(row) } : null,
    }, columns.map(column => h('td', { class: column.className ?? null }, column.cell(row))))))))
}

export function searchBox(placeholder, oninput, value = '') {
  return h('div', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder, value, oninput: (event) => oninput(event.target.value), 'aria-label': placeholder }))
}

export function select(options, value, onchange, label) {
  return h('select', { onchange: (event) => onchange(event.target.value), 'aria-label': label },
    options.map(([optionValue, text]) => h('option', { value: optionValue, selected: optionValue === value ? true : null }, text)))
}

// ---------- time ----------
export function relative(ms) {
  if (!ms) return t('从未')
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return t('刚刚')
  if (seconds < 3600) return tf('{n} 分钟前', { n: Math.floor(seconds / 60) })
  if (seconds < 86_400) return tf('{n} 小时前', { n: Math.floor(seconds / 3600) })
  if (seconds < 86_400 * 30) return tf('{n} 天前', { n: Math.floor(seconds / 86_400) })
  return new Date(ms).toLocaleDateString()
}
export const absolute = (ms) => (ms ? new Date(ms).toLocaleString() : '—')
export const timeCell = (ms) => h('span', { title: absolute(ms) }, relative(ms))

// ---------- toast ----------
let toastHost
export function toast(message, tone = '') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }))
  const node = h('div', { class: 'toast ' + tone }, icon(tone === 'bad' ? 'alert' : 'check'), h('div', {}, message))
  toastHost.append(node)
  setTimeout(() => node.remove(), tone === 'bad' ? 8000 : 4000)
}

// ---------- dialogs ----------
/**
 * A modal or right-side drawer. `build(close)` returns { body, actions }.
 * Resolves with whatever close(value) was called with (undefined when dismissed).
 */
export function openDialog({ title, wide = false, drawer = false, build }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: (wide ? 'wide ' : '') + (drawer ? 'drawer' : ''), 'aria-label': title })
    let settled = false
    const close = (value) => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      resolve(value)
    }
    const { body, actions = [] } = build(close)
    append(dialog, [
      h('header', { class: 'dialog-head' }, h('h2', {}, title), button('', { kind: 'ghost icon-only', iconName: 'x', title: t('关闭'), onclick: () => close(undefined) })),
      h('div', { class: 'dialog-body' }, body),
      actions.length > 0 && h('footer', { class: 'dialog-foot' }, actions),
    ])
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(undefined) })
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close(undefined) })
    document.body.append(dialog)
    dialog.showModal()
  })
}

/** Confirm a destructive action; with `typeToConfirm`, the person types it first. */
export function confirmAction({ title, text, confirmLabel, typeToConfirm, danger = true }) {
  return openDialog({
    title,
    build: (close) => {
      const confirmButton = button(confirmLabel, { kind: danger ? 'danger' : 'primary', disabled: typeToConfirm !== undefined, onclick: () => close(true) })
      const input = typeToConfirm === undefined ? null : h('input', {
        autocomplete: 'off', 'aria-label': tf('输入 {text} 确认', { text: typeToConfirm }),
        oninput: (event) => { confirmButton.disabled = event.target.value.trim() !== typeToConfirm },
      })
      return {
        body: [h('p', { class: 'muted' }, text), input && field(tf('输入「{text}」确认', { text: typeToConfirm }), input)],
        actions: [button(t('取消'), { onclick: () => close(false) }), confirmButton],
      }
    },
  }).then(Boolean)
}

/** Run an async action with its button busy, reporting failures as a toast. */
export async function busy(buttonNode, run) {
  if (buttonNode) buttonNode.disabled = true
  try {
    return await run()
  } catch (error) {
    toast(error.message, 'bad')
    return undefined
  } finally {
    if (buttonNode) buttonNode.disabled = false
  }
}

export function copyButton(text) {
  return button(t('复制'), { kind: 'small', iconName: 'copy', onclick: async () => { await navigator.clipboard.writeText(text); toast(t('已复制')) } })
}

/** Line diff (LCS) between two texts, for profile versions. */
export function lineDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(['same', a[i]]); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push(['del', a[i]]); i += 1 }
    else { out.push(['add', b[j]]); j += 1 }
  }
  while (i < a.length) out.push(['del', a[i++]])
  while (j < b.length) out.push(['add', b[j++]])
  // Keep three lines of context around each change; fold the rest.
  const near = out.map((_, index) => out.slice(Math.max(0, index - 3), index + 4).some(([kind]) => kind !== 'same'))
  const rows = []
  let folded = 0
  out.forEach(([kind, line], index) => {
    if (near[index]) {
      if (folded > 0) rows.push(h('div', { class: 'fold' }, tf('⋯ {n} 行没有变化', { n: folded })))
      folded = 0
      rows.push(h('div', { class: kind }, (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + line))
    } else folded += 1
  })
  if (folded > 0) rows.push(h('div', { class: 'fold' }, tf('⋯ {n} 行没有变化', { n: folded })))
  if (!out.some(([kind]) => kind !== 'same')) return h('p', { class: 'muted' }, t('两个版本的内容完全相同。'))
  return h('div', { class: 'diff' }, rows)
}

/** JSON with object keys sorted, so key order never shows up as a change. */
export function stableJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item
  return JSON.stringify(sort(value), null, 2)
}
