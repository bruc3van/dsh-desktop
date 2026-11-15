// Shell, routing and sign-in.
import { lang, setLang, t, tf } from './i18n.js'
import { api, ROLE_LABEL } from './api.js'
import { button, h, icon, initials, toast } from './ui.js'
import * as overview from './page-overview.js'
import * as members from './page-members.js'
import * as profiles from './page-profiles.js'
import * as devices from './page-devices.js'
import * as audit from './page-audit.js'
import * as settings from './page-settings.js'
import * as models from './page-models.js'
import * as usage from './page-usage.js'
import * as quotas from './page-quotas.js'
import * as market from './page-market.js'
import * as skills from './page-skills.js'

const root = document.getElementById('app')
let me = null
let counts = { members: 0, devices: 0, profiles: 0 }
let dirty = false
/** Hash prefix within which unsaved changes survive navigation (a profile's tabs). */
let dirtyScope = ''
let lastHash = location.hash

const NAV = [
  { group: null, items: [{ href: '#/overview', label: t('概览'), icon: 'overview' }] },
  { group: t('人员与组织'), items: [
    { href: '#/members', label: t('成员'), icon: 'people', count: () => counts.members },
    { href: '#/departments', label: t('部门'), icon: 'tree' },
  ] },
  { group: t('配置'), items: [
    { href: '#/profiles', label: t('场景包'), icon: 'layers', count: () => counts.profiles },
  ] },
  { group: t('插件与 Skill'), items: [
    { href: '#/market', label: t('插件市场'), icon: 'store' },
    { href: '#/skills', label: t('Skill 库'), icon: 'book' },
  ] },
  { group: t('模型与用量'), items: [
    { href: '#/models', label: t('模型目录'), icon: 'cpu' },
    { href: '#/usage', label: t('用量分析'), icon: 'chart' },
    { href: '#/quotas', label: t('额度'), icon: 'gauge' },
    { href: '#/gateway', label: t('网关设置'), icon: 'gateway' },
  ] },
  { group: t('设备与安全'), items: [
    { href: '#/devices', label: t('设备'), icon: 'device', count: () => counts.devices },
    { href: '#/audit', label: t('审计日志'), icon: 'shield' },
  ] },
  { group: t('分发'), items: [{ href: '#/distribution', label: t('注册与分发'), icon: 'download' }] },
]

const ROUTES = [
  [/^#\/overview$/, overview.render],
  [/^#\/members$/, members.renderList],
  [/^#\/members\/([^/]+)$/, members.renderDetail],
  [/^#\/departments$/, members.renderDepartments],
  [/^#\/profiles$/, profiles.renderList],
  [/^#\/profiles\/([^/]+)(?:\/([a-z-]+))?$/, profiles.renderDetail],
  [/^#\/gateway$/, settings.renderGateway],
  [/^#\/models$/, models.render],
  [/^#\/usage$/, usage.render],
  [/^#\/quotas$/, quotas.render],
  [/^#\/market$/, (ctx) => market.render(ctx, 'approved')],
  [/^#\/market\/(blocked|sources)$/, market.render],
  [/^#\/skills$/, skills.renderList],
  [/^#\/skills\/([^/]+)$/, skills.renderDetail],
  [/^#\/devices$/, devices.render],
  [/^#\/audit$/, audit.render],
  [/^#\/distribution$/, settings.renderDistribution],
]

function shell(crumbs, content) {
  const hash = (location.hash || '#/overview').split('?')[0]
  const menuHost = h('div')
  const toggleMenu = (event) => {
    event.stopPropagation()
    if (menuHost.firstChild) { menuHost.replaceChildren(); return }
    const menu = h('div', { class: 'menu', role: 'menu' },
      h('div', { class: 'menu-head' }, h('div', { class: 'cell-title' }, displayName()), h('div', { class: 'cell-sub' }, ROLE_LABEL[me.role] ?? me.role)),
      h('a', { href: '#/distribution', role: 'menuitem', onclick: () => menuHost.replaceChildren() }, icon('download'), t('注册与分发')),
      h('button', { role: 'menuitem', onclick: async () => { await api('POST', '/admin/api/logout'); history.replaceState(null, '', location.pathname); location.reload() } }, icon('logout'), t('退出登录')))
    menuHost.replaceChildren(menu)
    document.addEventListener('click', function away(click) {
      if (!menu.contains(click.target)) { menuHost.replaceChildren(); document.removeEventListener('click', away) }
    })
  }
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: '/console/logo.svg', alt: '' }), h('div', { class: 'brand-name' }, 'DSH Desktop Pro')),
      h('div', { class: 'org' }, h('div', { class: 'org-avatar' }, initials(me.organization.name)),
        h('div', {}, h('div', { class: 'org-name' }, me.organization.name), h('div', { class: 'org-meta num' }, tf('当前配置版本 r{n}', { n: me.organization.revision })))),
      h('nav', { class: 'nav', 'aria-label': t('主导航') }, NAV.map(group => h('div', { class: 'nav-group' },
        group.group && h('div', { class: 'nav-group-label' }, group.group),
        group.items.map(item => {
          const active = hash === item.href || hash.startsWith(item.href + '/')
          return h('a', { href: item.href, class: active ? 'active' : null, 'aria-current': active ? 'page' : null },
            icon(item.icon), item.label, item.count && h('span', { class: 'count' }, item.count()))
        })))),
      h('div', { class: 'sidebar-foot' }, t('开源社区项目，Apache-2.0'))),
    h('header', { class: 'topbar' },
      h('nav', { class: 'crumbs', 'aria-label': t('位置') }, crumbs.map((crumb, index) => [
        index > 0 && h('span', { class: 'sep' }, '/'),
        crumb.href && index < crumbs.length - 1 ? h('a', { href: crumb.href }, crumb.label) : h('span', { class: 'here' }, crumb.label),
      ])),
      h('div', { class: 'spacer' }),
      languageSwitch(),
      h('a', { class: 'btn ghost small', href: 'https://github.com/bruc3van/dsh-desktop-pro/blob/main/docs/enterprise' + (lang === 'zh' ? '.zh' : '') + '.md', target: '_blank', rel: 'noreferrer' }, icon('book'), t('部署指南')),
      h('button', { class: 'menu-trigger', onclick: toggleMenu, 'aria-haspopup': 'menu' }, h('span', { class: 'avatar' }, initials(displayName())), h('span', {}, displayName()), icon('down')),
      menuHost),
    h('main', { class: 'content' }, content)))
}

/** The bootstrap session has no person behind it; name it in the console's language. */
function displayName() {
  return me.role === 'bootstrap' ? t('初始管理员') : me.name
}

/** 中文 / English, remembered in this browser. Unsaved edits are guarded like any navigation. */
function languageSwitch() {
  return h('div', { class: 'lang-switch', role: 'group', 'aria-label': 'Language' },
    [['zh', '中文'], ['en', 'EN']].map(([code, label]) => h('button', {
      type: 'button', class: code === lang ? 'active' : null, 'aria-pressed': code === lang ? 'true' : 'false', lang: code === 'zh' ? 'zh-CN' : 'en',
      onclick: () => {
        if (code === lang) return
        if (dirty && !confirm(t('有未保存的修改，离开会丢失。确定离开吗？'))) return
        dirty = false
        setLang(code)
      },
    }, label)))
}

/** What every page receives. */
const ctx = {
  get me() { return me },
  query: new URLSearchParams(),
  canWrite: () => me?.role === 'admin' || me?.role === 'bootstrap',
  render: (crumbs, content) => shell(crumbs, content),
  setDirty: (value, scope = '') => { dirty = value; dirtyScope = scope },
  refresh: () => route(),
  async refreshCounts() {
    const [users, deviceList, profileList, current] = await Promise.all([
      api('GET', '/admin/api/users'), api('GET', '/admin/api/devices'), api('GET', '/admin/api/profiles'), api('GET', '/admin/api/me'),
    ])
    me = current
    counts = {
      members: users.filter(user => user.status === 'active').length,
      devices: deviceList.filter(device => device.status === 'active').length,
      profiles: profileList.length,
    }
  },
}

async function route() {
  const [hash, query = ''] = (location.hash || '#/overview').split('?')
  ctx.query = new URLSearchParams(query)
  for (const [pattern, handler] of ROUTES) {
    const match = pattern.exec(hash)
    if (match === null) continue
    try {
      await ctx.refreshCounts()
      await handler(ctx, ...match.slice(1))
    } catch (error) {
      if (error.status === 401) { login(); return }
      shell([{ label: t('出错了') }], h('div', { class: 'callout bad' }, icon('alert'), h('div', {}, error.message)))
    }
    return
  }
  location.replace('#/overview')
}

window.addEventListener('hashchange', () => {
  const staying = dirtyScope !== '' && location.hash.startsWith(dirtyScope)
  if (dirty && !staying && !confirm(t('有未保存的修改，离开会丢失。确定离开吗？'))) {
    history.replaceState(null, '', lastHash)
    return
  }
  const samePage = location.hash.split('/').slice(0, 3).join('/') === lastHash.split('/').slice(0, 3).join('/')
  if (!staying) { dirty = false; dirtyScope = '' }
  lastHash = location.hash
  void route().then(() => { if (!samePage) window.scrollTo(0, 0) })
})
window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault() })

function login() {
  const token = h('input', { type: 'password', autocomplete: 'off', id: 'bootstrap-token' })
  const error = h('div', { class: 'error', role: 'alert' })
  const submit = async (event) => {
    event.preventDefault()
    try {
      await api('POST', '/admin/api/session', { token: token.value })
      location.reload()
    } catch (failure) {
      error.textContent = failure.status === 401 ? t('令牌不正确。') : failure.message
    }
  }
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'login-card' },
    h('div', { class: 'login-top' }, h('img', { class: 'brand-mark', src: '/console/logo.svg', alt: '' }), languageSwitch()),
    h('h1', {}, t('登录 DSH Desktop Pro 控制台')),
    h('p', {}, t('管理员和审计员使用企业账号登录。')),
    h('a', { class: 'btn primary wide', href: '/admin/login' }, t('使用企业账号登录')),
    h('details', {},
      h('summary', {}, t('还没有管理员？使用初始管理员令牌')),
      h('form', { onsubmit: submit },
        h('div', { class: 'field' }, h('label', { for: 'bootstrap-token' }, t('初始管理员令牌')), token,
          h('div', { class: 'help' }, t('部署时设置的 DSH_BOOTSTRAP_TOKEN。建好管理员后，请从服务端配置里删除它。')), error),
        button(t('用令牌登录'), { type: 'submit', kind: 'wide' }))))))
}

document.title = t('DSH Desktop Pro 控制台')
try {
  me = await api('GET', '/admin/api/me')
  if (!location.hash) history.replaceState(null, '', '#/overview')
  lastHash = location.hash
  await route()
} catch (error) {
  if (error.status === 401) login()
  else toast(error.message, 'bad')
}
