// Plugin market: plugins IT has reviewed for employees' Discover page, blocked plugins, and the public indexes they come from.
import { lang, t, tf } from './i18n.js'
import { api } from './api.js'
import { badge, busy, button, callout, confirmAction, empty, field, h, openDialog, pageHead, panel, searchBox, select, table, tabs, timeCell, toast } from './ui.js'

/** The community index this client offers to personal users. */
const COMMUNITY_INDEX = 'https://bruc3van.com/dsh-plugins/index.json'

/** One language of an index's LocalizedText. */
export function loc(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return (lang === 'en' ? value.en : value.zh ?? value['zh-cn'] ?? value['zh-hans']) ?? value.en ?? Object.values(value)[0] ?? ''
}

/** An inline icon, or a letter: remote images would tell third parties who is browsing. */
function pluginIcon(plugin) {
  if (typeof plugin.icon === 'string' && plugin.icon.startsWith('data:image/')) return h('img', { class: 'plugin-icon', src: plugin.icon, alt: '' })
  const letter = (loc(plugin.title) || plugin.name.replace(/^@[^/]+\//, '')).trim().slice(0, 1).toUpperCase()
  return h('span', { class: 'plugin-icon letter', 'aria-hidden': 'true' }, letter)
}

function pluginTitle(plugin, ...extra) {
  return h('div', { class: 'plugin-cell' }, pluginIcon(plugin), h('div', { class: 'plugin-text' },
    h('div', { class: 'title-line' }, h('span', { class: 'cell-title' }, loc(plugin.title) || plugin.name), extra),
    h('div', { class: 'cell-sub mono' }, plugin.name)))
}

function sourceText(version) {
  if (version === undefined) return ''
  if (version.source.type === 'git') return 'Git · ' + version.source.commit.slice(0, 7)
  return version.source.registry ? 'npm · ' + new URL(version.source.registry).host : 'npm'
}

export async function render(ctx, section = 'approved') {
  const [market, users] = await Promise.all([api('GET', '/admin/api/market'), api('GET', '/admin/api/users')])
  const writable = ctx.canWrite()
  const people = new Map(users.map(user => [user.id, user.name]))
  const reviewer = (id) => (id === 'bootstrap' ? t('初始管理员') : people.get(id) ?? id ?? '—')
  const approved = market.plugins.filter(plugin => plugin.status === 'approved')
  const blocked = market.plugins.filter(plugin => plugin.status === 'blocked')
  const sourceName = new Map(market.sources.map(source => [source.id, loc(source.title) || source.url]))

  const feature = (plugin, node) => busy(node, async () => {
    await api('PATCH', '/admin/api/market/plugins/' + encodeURIComponent(plugin.name), { featured: !plugin.featured })
    toast(plugin.featured ? t('已取消推荐') : t('已设为推荐'))
    ctx.refresh()
  })
  const remove = async (plugin) => {
    const unblock = plugin.status === 'blocked'
    if (!await confirmAction({
      title: unblock ? tf('解除禁用 {name}', { name: plugin.name }) : tf('下架 {name}', { name: loc(plugin.title) || plugin.name }),
      text: unblock ? t('解除后，员工可以重新安装它。') : t('下架后，它不再出现在员工的发现页。已经装了的员工不受影响；要让大家卸载，请改用「禁用」。'),
      confirmLabel: unblock ? t('解除禁用') : t('下架'), danger: !unblock,
    })) return
    await busy(null, async () => { await api('DELETE', '/admin/api/market/plugins/' + encodeURIComponent(plugin.name)); toast(unblock ? t('已解除禁用') : t('已下架')); ctx.refresh() })
  }
  const changeVersion = (plugin) => plugin.sourceId !== null && sourceName.has(plugin.sourceId)
    ? browseDialog(ctx, market, plugin.sourceId, plugin.name)
    : manualDialog(ctx, plugin)

  const views = {
    approved: panel({
      flush: true,
      body: table([
        { label: t('插件'), cell: plugin => pluginTitle(plugin, plugin.featured && badge(t('推荐'), 'accent'), plugin.category && badge(loc(plugin.category.title), 'plain')) },
        { label: t('版本'), cell: plugin => h('div', {}, h('div', { class: 'mono' }, plugin.version?.version ?? '—'), h('div', { class: 'cell-sub' }, sourceText(plugin.version))) },
        { label: t('来源'), cell: plugin => plugin.sourceId === null ? h('span', { class: 'muted' }, t('手动添加')) : sourceName.get(plugin.sourceId) ?? h('span', { class: 'muted' }, t('来源已删除')) },
        { label: t('审核'), className: 'wrap', cell: plugin => h('div', {}, plugin.note ? h('div', { class: 'note-text' }, plugin.note) : h('div', { class: 'faint' }, t('没有备注')), h('div', { class: 'cell-sub' }, reviewer(plugin.reviewedBy), ' · ', timeCell(plugin.reviewedAt))) },
        { label: '', className: 'right', cell: plugin => writable && h('div', { class: 'row-actions' },
          button(plugin.featured ? t('取消推荐') : t('推荐'), { kind: 'small ghost', onclick: (event) => feature(plugin, event.currentTarget) }),
          button(t('换版本'), { kind: 'small ghost', onclick: () => changeVersion(plugin) }),
          button(t('下架'), { kind: 'small ghost', onclick: () => remove(plugin) })) },
      ], approved, { emptyState: empty({
        iconName: 'store', title: t('还没有上架插件'),
        text: market.sources.length === 0 ? t('先添加一个公开插件索引作为来源，再从里面挑选审核过的插件上架；公司自己的插件可以手动添加。') : t('从来源里挑选插件，审核后上架到员工的发现页。'),
        action: writable && (market.sources.length === 0
          ? button(t('添加来源'), { kind: 'primary', iconName: 'plus', onclick: () => sourceDialog(ctx) })
          : button(t('从来源挑选'), { kind: 'primary', iconName: 'search', onclick: () => browseDialog(ctx, market) })),
      }) }),
    }),
    blocked: panel({
      description: t('被禁用的插件会从每位员工的电脑上卸载，之后也装不上。场景包里设为必装的同名插件同样不会安装。'),
      flush: true,
      body: table([
        { label: t('插件'), cell: plugin => pluginTitle(plugin) },
        { label: t('原因'), cell: plugin => plugin.note ?? h('span', { class: 'faint' }, t('没有填写')) },
        { label: t('操作人'), cell: plugin => h('div', {}, reviewer(plugin.reviewedBy), h('div', { class: 'cell-sub' }, timeCell(plugin.reviewedAt))) },
        { label: '', className: 'right', cell: plugin => writable && button(t('解除禁用'), { kind: 'small ghost', onclick: () => remove(plugin) }) },
      ], blocked, { emptyState: empty({ iconName: 'check', title: t('没有禁用的插件'), text: t('发现有风险的插件时，在这里禁用它：所有员工的电脑都会卸载它。') }) }),
    }),
    sources: panel({
      description: t('管理员从这些公开索引里挑选插件。员工看不到这里的来源，只看到审核通过的插件。'),
      actions: writable ? [button(t('添加来源'), { kind: 'small', iconName: 'plus', onclick: () => sourceDialog(ctx) })] : [],
      flush: true,
      body: table([
        { label: t('来源'), cell: source => h('div', {}, h('div', { class: 'cell-title' }, loc(source.title) || source.url), h('div', { class: 'cell-sub mono' }, source.url)) },
        { label: t('插件'), className: 'num', cell: source => String(source.pluginCount) },
        { label: t('上次读取'), cell: source => h('div', {}, timeCell(source.fetchedAt), source.error && h('div', { class: 'cell-sub bad-text' }, tf('上次刷新失败：{reason}', { reason: source.error }))) },
        { label: '', className: 'right', cell: source => h('div', { class: 'row-actions' },
          button(t('挑选插件'), { kind: 'small ghost', onclick: () => browseDialog(ctx, market, source.id) }),
          writable && button(t('刷新'), { kind: 'small ghost', onclick: (event) => busy(event.currentTarget, async () => {
            const result = await api('POST', '/admin/api/market/sources/' + encodeURIComponent(source.id) + '/refresh')
            if (result.error) toast(tf('刷新失败：{reason}', { reason: result.error }), 'bad'); else toast(tf('已刷新，共 {n} 个插件', { n: result.pluginCount }))
            ctx.refresh()
          }) }),
          writable && button(t('删除'), { kind: 'small ghost', onclick: async () => {
            if (!await confirmAction({ title: tf('删除来源 {name}', { name: loc(source.title) || source.url }), text: t('删除后不能再从它挑选插件。已经上架的插件不受影响。'), confirmLabel: t('删除') })) return
            await busy(null, async () => { await api('DELETE', '/admin/api/market/sources/' + encodeURIComponent(source.id)); toast(t('已删除来源')); ctx.refresh() })
          } })) },
      ], market.sources, { emptyState: empty({ iconName: 'book', title: t('还没有来源'), text: t('来源是公开的插件索引（格式与 DSH 发现页相同）。可以先添加 DSH 社区精选。'), action: writable && button(t('添加来源'), { kind: 'primary', iconName: 'plus', onclick: () => sourceDialog(ctx) }) }) }),
    }),
  }

  ctx.render([{ label: t('插件市场') }], [
    pageHead({
      title: t('插件市场'),
      description: t('审核过的插件上架后，出现在员工发现页的「公司精选插件」里，排在最前面。员工自己决定装不装；必须安装的插件在场景包里设为必装。'),
      actions: writable ? [
        button(t('禁用插件'), { iconName: 'ban', onclick: () => blockDialog(ctx) }),
        button(t('手动添加'), { iconName: 'plus', onclick: () => manualDialog(ctx) }),
        button(t('从来源挑选'), { kind: 'primary', iconName: 'search', disabled: market.sources.length === 0, onclick: () => browseDialog(ctx, market) }),
      ] : [],
    }),
    tabs([
      { id: 'approved', href: '#/market', label: t('已上架'), count: approved.length },
      { id: 'blocked', href: '#/market/blocked', label: t('已禁用'), count: blocked.length },
      { id: 'sources', href: '#/market/sources', label: t('来源'), count: market.sources.length },
    ], section),
    views[section] ?? views.approved,
    section === 'approved' && approved.length > 0 && callout('info', h('span', {},
      t('员工的发现页每 10 分钟左右刷新一次插件列表。插件列表本身不签名，只是推荐；哪些插件必须装、哪些不能装，以签名的场景包和禁用列表为准。'), ' ',
      h('a', { href: '/admin/api/market/index', target: '_blank', rel: 'noopener' }, t('查看员工收到的插件列表')))),
  ])
}

function sourceDialog(ctx) {
  const draft = { url: '' }
  return openDialog({
    title: t('添加来源'),
    build: (close) => {
      const input = h('input', { type: 'url', placeholder: 'https://example.com/index.json', oninput: (event) => { draft.url = event.target.value } })
      const save = button(t('添加'), { kind: 'primary', onclick: () => busy(save, async () => {
        const source = await api('POST', '/admin/api/market/sources', { url: draft.url.trim() })
        toast(tf('已添加来源，共 {n} 个插件', { n: source.pluginCount }))
        close(true)
        location.hash = '#/market/sources'
        ctx.refresh()
      }) })
      return {
        body: [
          field(t('索引地址'), input, t('DSH 发现页使用的插件索引（format 1 的 JSON）。服务端会读取它，管理员在控制台里挑选。')),
          h('div', { class: 'suggest' }, h('span', { class: 'muted' }, t('常用：')), button(t('DSH 社区精选'), { kind: 'small', onclick: () => { input.value = COMMUNITY_INDEX; draft.url = COMMUNITY_INDEX } })),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

/** Search a source and pick a version to approve; `focus` opens one plugin directly. */
function browseDialog(ctx, market, sourceId = market.sources[0]?.id, focus) {
  const state = { sourceId, query: focus ?? '', offset: 0, entries: [], total: 0, seq: 0 }
  return openDialog({
    title: t('从来源挑选插件'),
    wide: true,
    build: (close) => {
      const list = h('div', { class: 'pick-list' })
      const more = h('div', { class: 'panel-more' })
      const load = async (append) => {
        const seq = ++state.seq
        const page = await api('GET', '/admin/api/market/sources/' + encodeURIComponent(state.sourceId) + '/plugins?q=' + encodeURIComponent(state.query) + '&offset=' + String(state.offset))
        if (seq !== state.seq) return
        state.entries = append ? [...state.entries, ...page.entries] : page.entries
        state.total = page.total
        draw()
      }
      const draw = () => {
        list.replaceChildren(...(state.entries.length === 0
          ? [empty({ iconName: 'search', title: t('没有找到插件'), text: t('换个关键词试试。') })]
          : state.entries.map(entry => pickRow(entry))))
        more.replaceChildren(...(state.entries.length < state.total ? [button(tf('再加载 20 个（共 {n} 个）', { n: state.total }), { kind: 'small', onclick: () => { state.offset = state.entries.length; void busy(null, () => load(true)) } })] : []))
      }
      const pickRow = (entry) => {
        const chosen = { version: entry.versions.find(item => !item.version.includes('-'))?.version ?? entry.versions[0].version }
        const status = entry.company?.status === 'approved' ? badge(tf('已上架 {v}', { v: entry.company.version }), 'ok') : entry.company?.status === 'blocked' ? badge(t('已禁用'), 'bad') : null
        return h('div', { class: 'pick-row' },
          pluginTitle(entry, status, entry.category && badge(loc(entry.category.title), 'plain')),
          h('p', { class: 'pick-desc' }, loc(entry.description) || h('span', { class: 'faint' }, t('没有介绍'))),
          h('div', { class: 'pick-meta' },
            entry.author && h('span', {}, entry.author),
            entry.repository && h('a', { href: entry.repository.url, target: '_blank', rel: 'noopener noreferrer' }, t('源码')),
            entry.homepage && h('a', { href: entry.homepage, target: '_blank', rel: 'noopener noreferrer' }, t('主页'))),
          ctx.canWrite() && h('div', { class: 'pick-actions' },
            select(entry.versions.map(item => [item.version, item.version + ' · ' + new Date(item.publishTimestamp * 1000).toLocaleDateString(lang === 'en' ? 'en' : 'zh-CN') + (item.engines.dsh ? ' · dsh ' + item.engines.dsh : '')]), chosen.version, (value) => { chosen.version = value }, t('版本')),
            button(entry.company?.status === 'approved' ? t('换成这个版本') : t('上架'), { kind: 'small primary', onclick: async () => {
              const done = await approveDialog(ctx, { sourceId: state.sourceId, entry, version: chosen.version })
              if (done) { close(true); ctx.refresh() }
            } })))
      }
      const sources = market.sources.length > 1 && select(market.sources.map(source => [source.id, loc(source.title) || source.url]), state.sourceId, (value) => { state.sourceId = value; state.offset = 0; void busy(null, () => load(false)) }, t('来源'))
      let timer
      const search = searchBox(t('搜索名称、介绍、作者或关键词'), (value) => {
        clearTimeout(timer)
        timer = setTimeout(() => { state.query = value; state.offset = 0; void busy(null, () => load(false)) }, 250)
      }, state.query)
      void busy(null, () => load(false))
      return { body: [h('div', { class: 'filters' }, search, sources), list, more] }
    },
  })
}

function approveDialog(ctx, { sourceId, entry, version }) {
  const draft = { note: '', featured: false }
  const picked = entry.versions.find(item => item.version === version)
  return openDialog({
    title: tf('上架 {name}', { name: loc(entry.title) || entry.name }),
    build: (close) => {
      const save = button(t('上架'), { kind: 'primary', onclick: () => busy(save, async () => {
        await api('POST', '/admin/api/market/plugins', { sourceId, name: entry.name, version, note: draft.note, featured: draft.featured })
        toast(tf('已上架 {name} {v}', { name: loc(entry.title) || entry.name, v: version }))
        close(true)
      }) })
      return {
        body: [
          h('dl', { class: 'props' },
            h('dt', {}, t('插件')), h('dd', { class: 'mono' }, entry.name),
            h('dt', {}, t('版本')), h('dd', { class: 'mono' }, version),
            h('dt', {}, t('安装来源')), h('dd', {}, picked?.source.type === 'git' ? h('span', { class: 'mono' }, picked.source.url + ' @ ' + picked.source.commit.slice(0, 12)) : sourceText(picked)),
            picked?.engines.dsh && [h('dt', {}, t('需要 DSH')), h('dd', { class: 'mono' }, picked.engines.dsh)]),
          callout('info', t('员工只能看到并安装这一个版本。上游发布新版本后，需要在这里换版本才会更新。')),
          field(t('审核备注'), h('textarea', { rows: '3', placeholder: t('例如：已检查源码，不访问外网；仅限内部数据'), oninput: (event) => { draft.note = event.target.value } }), t('员工看不到备注；它和你的名字一起记入审计日志。')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (event) => { draft.featured = event.target.checked } }), t('设为公司推荐，排在发现页最前面')),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

/** An internal plugin no public index lists, or a new version of one added by hand. */
function manualDialog(ctx, plugin) {
  const source = plugin?.version?.source
  const draft = {
    name: plugin?.name ?? '', version: '', type: source?.type ?? 'npm', registry: source?.type === 'npm' ? source.registry ?? '' : '',
    url: source?.type === 'git' ? source.url : '', commit: '', path: source?.type === 'git' ? source.path ?? '' : '',
    title: loc(plugin?.title), description: loc(plugin?.description), homepage: plugin?.homepage ?? '', note: '', featured: plugin?.featured ?? false,
  }
  return openDialog({
    title: plugin ? tf('换版本：{name}', { name: loc(plugin.title) || plugin.name }) : t('手动添加插件'),
    build: (close) => {
      const host = h('div')
      const input = (key, attrs = {}) => h('input', { value: draft[key], oninput: (event) => { draft[key] = event.target.value }, ...attrs })
      const save = button(t('上架'), { kind: 'primary', onclick: () => busy(save, async () => {
        await api('POST', '/admin/api/market/plugins', {
          name: draft.name.trim(), version: draft.version.trim(),
          source: draft.type === 'git'
            ? { type: 'git', url: draft.url.trim(), commit: draft.commit.trim().toLowerCase(), ...draft.path.trim() && { path: draft.path.trim() } }
            : { type: 'npm', ...draft.registry.trim() && { registry: draft.registry.trim() } },
          title: draft.title, description: draft.description, homepage: draft.homepage.trim(), note: draft.note, featured: draft.featured,
        })
        toast(t('已上架'))
        close(true)
        ctx.refresh()
      }) })
      const draw = () => host.replaceChildren(...[
        h('div', { class: 'field-row' },
          field(t('包名'), input('name', { class: 'mono', placeholder: '@acme/dsh-crm', disabled: plugin !== undefined })),
          field(t('版本'), input('version', { class: 'mono', placeholder: '1.0.0' }), t('精确版本号，不能写范围。'))),
        field(t('安装来源'), select([['npm', t('npm 仓库')], ['git', t('Git 仓库')]], draft.type, (value) => { draft.type = value; draw() }, t('安装来源'))),
        draft.type === 'npm' && field(t('npm 仓库地址'), input('registry', { class: 'mono', placeholder: 'https://npm.example.com/' }), t('留空时用员工电脑上配置的仓库（场景包里可以统一设置）。')),
        draft.type === 'git' && [
          field(t('仓库地址'), input('url', { class: 'mono', placeholder: 'https://git.example.com/team/plugin' }), t('只支持 https。')),
          h('div', { class: 'field-row' },
            field(t('提交'), input('commit', { class: 'mono', placeholder: t('40 位提交哈希') }), t('固定到一次提交，之后的改动不会自动装到员工电脑上。')),
            field(t('子目录'), input('path', { class: 'mono', placeholder: 'packages/plugin' }), t('插件不在仓库根目录时填写。'))),
        ],
        field(t('显示名称'), input('title')),
        field(t('介绍'), h('textarea', { rows: '2', value: draft.description, oninput: (event) => { draft.description = event.target.value } })),
        field(t('主页'), input('homepage', { placeholder: 'https://' })),
        field(t('审核备注'), h('textarea', { rows: '2', oninput: (event) => { draft.note = event.target.value } })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.featured, onchange: (event) => { draft.featured = event.target.checked } }), t('设为公司推荐，排在发现页最前面')),
      ].filter(Boolean))
      draw()
      return { body: host, actions: [button(t('取消'), { onclick: () => close() }), save] }
    },
  })
}

function blockDialog(ctx) {
  const draft = { name: '', note: '' }
  return openDialog({
    title: t('禁用插件'),
    build: (close) => {
      const save = button(t('禁用'), { kind: 'danger', onclick: () => busy(save, async () => {
        await api('POST', '/admin/api/market/blocked', { name: draft.name.trim(), note: draft.note })
        toast(tf('已禁用 {name}', { name: draft.name.trim() }))
        close(true)
        location.hash = '#/market/blocked'
        ctx.refresh()
      }) })
      return {
        body: [
          callout('warn', t('禁用后，员工电脑在下次同步时卸载这个插件，之后也不会再装上。已上架的同名插件会一并下架。')),
          field(t('包名'), h('input', { class: 'mono', placeholder: 'some-plugin', oninput: (event) => { draft.name = event.target.value } }), t('插件的 npm 包名，和员工电脑上 dsh plugin 列出的名字一致。')),
          field(t('原因'), h('textarea', { rows: '2', placeholder: t('例如：会把文件上传到第三方服务'), oninput: (event) => { draft.note = event.target.value } })),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

