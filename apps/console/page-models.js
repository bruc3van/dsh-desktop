// Model catalog: the upstream model services, and the models people use with their names and prices.
import { t, tf } from './i18n.js'
import { api } from './api.js'
import { compact, price } from './format.js'
import { badge, busy, button, callout, confirmAction, empty, field, h, openDialog, pageHead, panel, select, table, toast } from './ui.js'

const TAGS = [['reasoning', t('推理')], ['vision', t('看图')], ['code', t('编程')], ['fast', t('快速')], ['long', t('长上下文')]]
const TAG_LABEL = Object.fromEntries(TAGS)

export async function render(ctx) {
  const catalog = await api('GET', '/admin/api/catalog')
  const writable = ctx.canWrite()
  const upstreamName = new Map(catalog.upstreams.map(upstream => [upstream.id, upstream.builtin ? t('默认上游') : upstream.name]))

  const test = async (upstream, node) => busy(node, async () => {
    const result = await api('POST', '/admin/api/catalog/upstreams/' + encodeURIComponent(upstream.id) + '/test')
    if (result.ok) toast(tf('连接正常，用时 {ms} ms，上游提供 {n} 个模型', { ms: result.ms, n: result.models.length }))
    else toast(tf('连接失败：{reason}', { reason: result.error ?? 'HTTP ' + result.status }), 'bad')
  })
  const removeUpstream = async (upstream) => {
    if (!await confirmAction({ title: tf('删除上游 {name}', { name: upstream.name }), text: t('删除后，它保存的 API Key 一并删除。还有模型指向它时不能删除。'), confirmLabel: t('删除') })) return
    await busy(null, async () => { await api('DELETE', '/admin/api/catalog/upstreams/' + encodeURIComponent(upstream.id)); toast(t('已删除上游')); ctx.refresh() })
  }
  const removeModel = async (model) => {
    if (!await confirmAction({ title: tf('删除模型 {name}', { name: model.name }), text: t('删除后，场景包里仍然列着它的员工请求会直接发给默认上游，并且不再计费。想暂时停用，用「停用」更合适。'), confirmLabel: t('删除') })) return
    await busy(null, async () => { await api('DELETE', '/admin/api/catalog/models/' + encodeURIComponent(model.id)); toast(t('已删除模型')); ctx.refresh() })
  }
  const toggle = (model, node) => busy(node, async () => {
    await api('PUT', '/admin/api/catalog/models/' + encodeURIComponent(model.id), { enabled: !model.enabled })
    toast(model.enabled ? tf('已停用 {name}', { name: model.name }) : tf('已启用 {name}', { name: model.name }))
    ctx.refresh()
  })

  ctx.render([{ label: t('模型目录') }], [
    pageHead({
      title: t('模型目录'),
      description: t('登记公司能用的模型：员工看到的名字、实际发往哪个上游、按什么价格计费。场景包从这里选模型，用量和额度按这里的价格算钱。'),
      actions: writable ? [
        button(t('添加上游'), { iconName: 'plus', onclick: () => upstreamDialog(ctx) }),
        button(t('添加模型'), { kind: 'primary', iconName: 'plus', disabled: catalog.upstreams.length === 0, onclick: () => modelDialog(ctx, catalog) }),
      ] : [],
    }),
    ctx.me.gateway !== 'direct' && callout('warn', t('模型目录只对内置网关生效（DSH_GATEWAY=direct）。')),
    panel({
      title: t('模型'),
      description: t('员工请求里的模型名对应这里的「模型 ID」。停用的模型立即不能再用。'),
      flush: true,
      body: table([
        { label: t('模型'), cell: model => h('div', {},
          h('div', { class: 'title-line' }, h('span', { class: 'cell-title' }, model.name), model.recommended && badge(t('推荐'), 'accent'), model.tags.map(tag => badge(TAG_LABEL[tag] ?? tag, 'plain'))),
          h('div', { class: 'cell-sub mono' }, model.id)) },
        { label: t('上游'), cell: model => h('div', {}, h('div', {}, upstreamName.get(model.upstreamId) ?? model.upstreamId), model.upstreamModel !== model.id && h('div', { class: 'cell-sub mono' }, '→ ' + model.upstreamModel)) },
        { label: t('输入 / 输出（每百万 Token）'), className: 'num', cell: model => model.prices.input === null ? badge(t('未定价'), 'warn') : h('div', {}, price(model.prices.input) + ' / ' + price(model.prices.output), model.prices.cacheRead !== null && h('div', { class: 'cell-sub' }, tf('缓存命中 {p}', { p: price(model.prices.cacheRead) }))) },
        { label: t('上下文'), className: 'num', cell: model => (model.contextWindow ? compact(model.contextWindow) : '—') },
        { label: t('状态'), cell: model => badge(model.enabled ? t('启用') : t('已停用'), model.enabled ? 'ok' : '') },
        { label: '', className: 'right', cell: model => writable && h('div', { class: 'row-actions' },
          button(t('修改'), { kind: 'small ghost', onclick: () => modelDialog(ctx, catalog, model) }),
          button(model.enabled ? t('停用') : t('启用'), { kind: 'small ghost', onclick: (event) => toggle(model, event.currentTarget) }),
          button(t('删除'), { kind: 'small ghost', onclick: () => removeModel(model) })) },
      ], catalog.models, { emptyState: empty({ iconName: 'cpu', title: t('还没有登记模型'), text: catalog.upstreams.length === 0 ? t('先添加一个上游（DeepSeek、通义千问、Kimi、内网 vLLM 等任意 OpenAI 兼容接口），再登记模型和价格。') : t('登记模型后，就能按价格统计费用、设置额度，并在场景包里勾选。'), action: writable && catalog.upstreams.length > 0 && button(t('添加模型'), { kind: 'primary', iconName: 'plus', onclick: () => modelDialog(ctx, catalog) }) }) }),
    }),
    panel({
      title: t('上游'),
      description: t('网关实际转发到的模型服务。API Key 加密保存在服务端，员工和控制台都看不到。'),
      flush: true,
      body: table([
        { label: t('名称'), cell: upstream => h('div', {}, h('div', { class: 'title-line' }, h('span', { class: 'cell-title' }, upstream.builtin ? t('默认上游') : upstream.name), upstream.builtin && badge(t('环境变量'), 'plain')), h('div', { class: 'cell-sub mono' }, upstream.baseUrl)) },
        { label: 'API Key', cell: upstream => upstream.hasKey ? badge(t('已设置'), 'ok') : badge(t('未设置'), '') },
        { label: t('模型'), className: 'num', cell: upstream => String(upstream.models) },
        { label: '', className: 'right', cell: upstream => h('div', { class: 'row-actions' },
          button(t('测试连接'), { kind: 'small ghost', onclick: (event) => test(upstream, event.currentTarget) }),
          writable && !upstream.builtin && button(t('修改'), { kind: 'small ghost', onclick: () => upstreamDialog(ctx, upstream) }),
          writable && !upstream.builtin && button(t('删除'), { kind: 'small ghost', onclick: () => removeUpstream(upstream) })) },
      ], catalog.upstreams, { emptyState: empty({ iconName: 'gateway', title: t('还没有上游'), text: t('添加一个 OpenAI 兼容接口作为上游；也可以在服务端 .env 里用 DSH_UPSTREAM_URL 设置默认上游。'), action: writable && button(t('添加上游'), { kind: 'primary', iconName: 'plus', onclick: () => upstreamDialog(ctx) }) }) }),
    }),
    callout('info', h('span', {}, t('登记好的模型不会自动给员工用：在场景包的「模型」里勾选，再分配给全员或部门。'), ' ', h('a', { href: '#/profiles' }, t('去场景包')))),
  ])
}

function upstreamDialog(ctx, upstream) {
  const draft = { name: upstream?.name ?? '', baseUrl: upstream?.baseUrl ?? '', apiKey: '' }
  return openDialog({
    title: upstream ? tf('修改上游 {name}', { name: upstream.name }) : t('添加上游'),
    build: (close) => {
      const save = button(t('保存'), { kind: 'primary', onclick: () => busy(save, async () => {
        const body = { name: draft.name, baseUrl: draft.baseUrl, ...draft.apiKey && { apiKey: draft.apiKey } }
        if (upstream) await api('PATCH', '/admin/api/catalog/upstreams/' + encodeURIComponent(upstream.id), body)
        else await api('POST', '/admin/api/catalog/upstreams', body)
        toast(t('已保存上游'))
        close(true)
        ctx.refresh()
      }) })
      return {
        body: [
          field(t('名称'), h('input', { value: draft.name, placeholder: t('比如 DeepSeek 官方'), oninput: (event) => { draft.name = event.target.value } })),
          field(t('接口地址'), h('input', { value: draft.baseUrl, class: 'mono', placeholder: 'https://api.deepseek.com/v1', oninput: (event) => { draft.baseUrl = event.target.value } }), t('OpenAI 兼容接口的地址，通常以 /v1 结尾。')),
          field('API Key', h('input', { type: 'password', autocomplete: 'off', value: '', placeholder: upstream?.hasKey ? t('已设置，留空则不修改') : 'sk-…', oninput: (event) => { draft.apiKey = event.target.value } }), t('加密保存在服务端，保存后不再显示。')),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

function modelDialog(ctx, catalog, model) {
  const draft = model
    ? { ...model, prices: { ...model.prices }, tags: [...model.tags] }
    : { id: '', name: '', upstreamId: catalog.upstreams[0]?.id ?? '', upstreamModel: '', prices: { input: null, output: null, cacheRead: null }, contextWindow: null, tags: [], recommended: false, enabled: true }
  const offered = h('datalist', { id: 'upstream-models' })
  const loadOffered = async () => {
    try {
      const result = await api('POST', '/admin/api/catalog/upstreams/' + encodeURIComponent(draft.upstreamId) + '/test')
      offered.replaceChildren(...result.models.map(id => h('option', { value: id })))
    } catch { offered.replaceChildren() }
  }
  if (draft.upstreamId) void loadOffered()
  const num = (value) => (value === '' || value === null || value === undefined ? null : Number(value))
  return openDialog({
    title: model ? tf('修改模型 {name}', { name: model.name }) : t('添加模型'),
    wide: true,
    build: (close) => {
      const save = button(t('保存'), { kind: 'primary', onclick: () => busy(save, async () => {
        const id = (model ? model.id : draft.id).trim()
        if (!id) throw new Error(t('请填写模型 ID。'))
        if ((draft.prices.input === null) !== (draft.prices.output === null)) throw new Error(t('输入和输出价格要么都填，要么都不填。'))
        await api('PUT', '/admin/api/catalog/models/' + encodeURIComponent(id), {
          name: draft.name || id, upstreamId: draft.upstreamId, upstreamModel: draft.upstreamModel || id, prices: draft.prices,
          contextWindow: draft.contextWindow, tags: draft.tags, recommended: draft.recommended, enabled: draft.enabled,
        })
        toast(t('已保存模型'))
        close(true)
        ctx.refresh()
      }) })
      const priceField = (key, label) => field(label, h('input', { type: 'number', min: '0', step: '0.01', value: draft.prices[key] ?? '', placeholder: '—', oninput: (event) => { draft.prices[key] = num(event.target.value) } }))
      return {
        body: [
          h('div', { class: 'field-row' },
            field(t('模型 ID'), h('input', { value: draft.id, class: 'mono', disabled: Boolean(model), placeholder: 'deepseek-chat', oninput: (event) => { draft.id = event.target.value } }), t('员工请求里用的名字，也是场景包里的模型 ID。保存后不能修改。')),
            field(t('显示名'), h('input', { value: draft.name, placeholder: t('比如 公司通用'), oninput: (event) => { draft.name = event.target.value } }))),
          h('div', { class: 'field-row' },
            field(t('上游'), select(catalog.upstreams.map(upstream => [upstream.id, upstream.builtin ? t('默认上游') : upstream.name]), draft.upstreamId, (value) => { draft.upstreamId = value; void loadOffered() }, t('上游'))),
            field(t('上游的模型名'), h('input', { value: draft.upstreamModel, class: 'mono', list: 'upstream-models', placeholder: t('留空则与模型 ID 相同'), oninput: (event) => { draft.upstreamModel = event.target.value } }), t('上游实际认的名字。以后换模型版本只改这里，员工那边不用动。'))),
          offered,
          h('div', { class: 'section-title' }, t('价格（元 / 百万 Token）')),
          h('div', { class: 'field-row' }, priceField('input', t('输入')), priceField('output', t('输出')), priceField('cacheRead', t('缓存命中'))),
          h('p', { class: 'help' }, t('按实际采购价填写。缓存命中留空时按输入价计算；都不填表示未定价，用量照常统计但不计费用。')),
          h('div', { class: 'field-row' },
            field(t('上下文长度'), h('input', { type: 'number', min: '0', value: draft.contextWindow ?? '', placeholder: t('可选'), oninput: (event) => { draft.contextWindow = num(event.target.value) } })),
            field(t('标签'), h('div', { class: 'checks inline' }, TAGS.map(([value, label]) => h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: draft.tags.includes(value), onchange: (event) => { draft.tags = event.target.checked ? [...draft.tags, value] : draft.tags.filter(tag => tag !== value) } }), label))))),
          h('div', { class: 'checks inline' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.recommended, onchange: (event) => { draft.recommended = event.target.checked } }), t('推荐给员工')),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.enabled, onchange: (event) => { draft.enabled = event.target.checked } }), t('启用'))),
        ],
        actions: [button(t('取消'), { onclick: () => close() }), save],
      }
    },
  })
}

