import { t, tf } from './i18n.js'
import { api } from './api.js'
import { loc } from './page-market.js'
import { rolloutPanel } from './rollout.js'
import {
  badge, busy, button, callout, confirmAction, empty, field, h, icon, lineDiff, openDialog, stableJson, pageHead, panel, select, table,
  tabs, timeCell, toast,
} from './ui.js'

// ---------- vocabulary ----------

const TOOL_GROUPS = [
  { title: t('命令行与代码执行'), tools: [
    { id: ['bash'], label: t('Bash 命令'), desc: t('在电脑上运行任意 shell 命令') },
    { id: ['pwsh'], label: 'PowerShell', desc: t('Windows 上运行 PowerShell 命令') },
    { id: ['run_code'], label: t('运行代码'), desc: t('让模型写一段程序并直接执行') },
    { id: ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'], label: t('终端会话'), desc: t('打开并操作交互式终端') },
  ] },
  { title: t('修改文件'), tools: [
    { id: ['write'], label: t('写入文件'), desc: t('新建或覆盖文件') },
    { id: ['edit', 'str_replace_editor'], label: t('编辑文件'), desc: t('修改已有文件的内容') },
    { id: ['apply_patch'], label: t('应用补丁'), desc: t('一次修改多个文件') },
  ] },
  { title: t('联网'), tools: [
    { id: ['web_fetch'], label: t('打开网页'), desc: t('读取指定网址的内容') },
    { id: ['web_search'], label: t('网页搜索'), desc: t('用搜索引擎查资料') },
  ] },
  { title: t('多智能体'), tools: [
    { id: ['subagent', 'subagent_fork'], label: t('子智能体'), desc: t('把任务交给另一个智能体') },
    { id: ['workflow'], label: t('工作流'), desc: t('按预设流程连续执行多步任务') },
  ] },
]
const KNOWN_TOOLS = new Set(TOOL_GROUPS.flatMap(group => group.tools.flatMap(tool => tool.id)))

const TEMPLATES = [
  { id: 'blank', label: t('空白'), desc: t('从零开始配置。'), spec: {} },
  { id: 'office', label: t('通用办公'), desc: t('禁用命令行、代码执行和终端，适合非技术岗位。'), spec: { tools: { deny: ['bash', 'pwsh', 'run_code', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'], message: t('公司 IT 已禁用命令行和代码执行工具。') } } },
  { id: 'readonly', label: t('只读助理'), desc: t('在通用办公的基础上，再禁用写文件和联网。'), spec: { tools: { deny: ['bash', 'pwsh', 'run_code', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list', 'write', 'edit', 'str_replace_editor', 'apply_patch', 'web_fetch', 'web_search'], message: t('公司 IT 只允许读取和分析，不允许修改文件或联网。') } } },
]

const API_LABEL = { 'openai-completions': t('OpenAI 兼容（Chat Completions）'), 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }

function contentSummary(spec) {
  const parts = []
  const routes = Object.keys(spec.models?.providers ?? {}).length
  if (routes) parts.push(badge(tf('{n} 个模型网关', { n: routes }), 'plain'))
  const plugins = (spec.plugins?.required?.length ?? 0) + (spec.plugins?.indexes?.length ?? 0)
  if (plugins) parts.push(badge(tf('插件 {n}', { n: plugins }), 'plain'))
  if (spec.skills?.length) parts.push(badge('Skill ' + spec.skills.length, 'plain'))
  if (spec.tools?.deny?.length) parts.push(badge(tf('禁用 {n} 个工具', { n: spec.tools.deny.length }), 'warn plain'))
  return parts.length === 0 ? h('span', { class: 'faint' }, t('空')) : h('div', { class: 'title-line' }, parts)
}

function targetLabel(binding, departments, users) {
  if (binding.target_type === 'tenant') return t('全员')
  if (binding.target_type === 'department') return departments.find(dep => dep.id === binding.target_id)?.name ?? t('已删除的部门')
  return users.find(user => user.id === binding.target_id)?.name ?? t('已删除的成员')
}

// ---------- list ----------

export async function renderList(ctx) {
  const [profiles, bindings, departments, users] = await Promise.all([
    api('GET', '/admin/api/profiles'), api('GET', '/admin/api/bindings'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/users'),
  ])
  const specs = new Map(await Promise.all(profiles.map(async profile => [profile.id, (await api('GET', '/admin/api/profiles/' + profile.id)).versions[0]?.spec ?? {}])))
  const writable = ctx.canWrite()
  ctx.render([{ label: t('场景包') }], [
    pageHead({
      title: t('场景包'),
      description: t('场景包描述一类人应该拿到的 DSH 环境：用哪些模型、装哪些插件和 Skill、哪些工具不能用。分配给全员、部门或个人后，一个人收到的是所有适用场景包合并的结果。'),
      actions: writable ? [button(t('新建场景包'), { kind: 'primary', iconName: 'plus', onclick: () => createDialog() })] : [],
    }),
    callout('info', t('合并规则：全员 → 部门（从上级到下级）→ 个人，越具体越优先；禁用的工具和禁止的插件只会累加，更具体的场景包也取消不了。')),
    panel({
      flush: true,
      body: table([
        { label: t('场景包'), cell: profile => h('div', {}, h('div', { class: 'cell-title' }, profile.name), h('div', { class: 'cell-sub' }, profile.description || '—')) },
        { label: t('分配给'), cell: profile => {
          const mine = bindings.filter(binding => binding.profile_id === profile.id)
          return mine.length === 0 ? badge(t('未分配'), 'warn') : mine.map(binding => targetLabel(binding, departments, users)).join('、')
        } },
        { label: t('内容'), cell: profile => contentSummary(specs.get(profile.id) ?? {}) },
        { label: t('版本'), cell: profile => h('span', { class: 'num' }, 'v' + profile.current_version) },
        { label: t('更新'), cell: profile => timeCell(profile.updated_at) },
      ], profiles, {
        onRow: profile => { location.hash = '#/profiles/' + profile.id },
        emptyState: empty({ iconName: 'layers', title: t('还没有场景包'), text: t('先建一个「通用办公」场景包分配给全员，再按部门补充。'), action: writable ? button(t('新建场景包'), { kind: 'primary', onclick: () => createDialog() }) : null }),
      }),
    }),
  ])
}

function createDialog() {
  const name = h('input', { autocomplete: 'off', placeholder: t('例如：通用办公、财务部') })
  const description = h('input', { autocomplete: 'off', placeholder: t('一句话说明给谁用') })
  let template = TEMPLATES[1]
  const choices = h('div', { class: 'checks' })
  const drawChoices = () => choices.replaceChildren(...TEMPLATES.map(item => h('label', { class: 'check' + (item === template ? ' on' : '') },
    h('input', { type: 'radio', name: 'template', checked: item === template, onchange: () => { template = item; drawChoices() } }),
    h('div', {}, h('div', { class: 'check-title' }, item.label), h('div', { class: 'check-desc' }, item.desc)))))
  drawChoices()
  return openDialog({
    title: t('新建场景包'),
    build: (close) => {
      const save = button(t('新建并编辑'), { kind: 'primary', onclick: () => busy(save, async () => {
        const created = await api('POST', '/admin/api/profiles', { name: name.value, description: description.value, spec: template.spec })
        close(true)
        location.hash = '#/profiles/' + created.id
      }) })
      return { body: [field(t('名称'), name), field(t('说明'), description), h('div', { class: 'field' }, h('div', { class: 'label' }, t('起点')), choices)], actions: [button(t('取消'), { onclick: () => close() }), save] }
    },
  })
}

// ---------- detail ----------

/** Unsaved drafts per profile, kept while switching tabs. */
const drafts = new Map()

export async function renderDetail(ctx, id, tab = 'config') {
  const [profile, bindings, departments, users, devices] = await Promise.all([
    api('GET', '/admin/api/profiles/' + id), api('GET', '/admin/api/bindings'), api('GET', '/admin/api/departments'), api('GET', '/admin/api/users'), api('GET', '/admin/api/devices'),
  ])
  const saved = profile.versions[0]?.spec ?? {}
  let draft = drafts.get(id)
  if (draft === undefined || draft.base !== profile.current_version) {
    draft = { base: profile.current_version, spec: structuredClone(saved), name: profile.name, description: profile.description ?? '' }
    drafts.set(id, draft)
  }
  const writable = ctx.canWrite()
  const mine = bindings.filter(binding => binding.profile_id === id)
  const scope = '#/profiles/' + id
  const isDirty = () => JSON.stringify(draft.spec) !== JSON.stringify(saved) || draft.name !== profile.name || draft.description !== (profile.description ?? '')

  const saveNote = h('input', { placeholder: t('这次改了什么（会记在版本历史里）'), autocomplete: 'off' })
  const validity = h('span', { class: 'muted' })
  let validateTimer
  const savebar = h('div', { class: 'savebar hidden', role: 'region', 'aria-label': t('未保存的修改') },
    icon('info'), h('span', {}, t('有未保存的修改')), validity, h('span', { class: 'spacer' }), saveNote,
    button(t('放弃修改'), { onclick: () => { drafts.delete(id); ctx.setDirty(false); ctx.refresh() } }),
    button(tf('保存为 v{n}', { n: profile.current_version + 1 }), { kind: 'primary', onclick: (event) => busy(event.currentTarget, async () => {
      await api('PUT', '/admin/api/profiles/' + id, { spec: draft.spec, note: saveNote.value, name: draft.name, description: draft.description })
      drafts.delete(id)
      ctx.setDirty(false)
      toast(tf('已保存为 v{n}，在线设备几秒内就会用上', { n: profile.current_version + 1 }))
      ctx.refresh()
    }) }))
  const changed = () => {
    const value = isDirty()
    savebar.classList.toggle('hidden', !value || !writable)
    ctx.setDirty(value, scope)
    clearTimeout(validateTimer)
    validateTimer = setTimeout(async () => {
      const result = await api('POST', '/admin/api/profiles/validate', draft.spec).catch(error => ({ ok: false, path: '', reason: error.message }))
      validity.textContent = result.ok ? '' : tf('有问题：{path} {reason}', { path: result.path, reason: result.reason })
      validity.className = result.ok ? 'muted' : 'error'
    }, 300)
  }

  const reach = mine.reduce((set, binding) => {
    for (const user of users.filter(item => item.status === 'active')) {
      if (binding.target_type === 'tenant' || (binding.target_type === 'user' && user.id === binding.target_id)
        || (binding.target_type === 'department' && inDepartment(user.department_id, binding.target_id, departments))) set.add(user.id)
    }
    return set
  }, new Set())

  const tabItems = [
    { id: 'config', label: t('配置'), href: scope + '/config', dirty: isDirty() },
    { id: 'assign', label: t('分配'), href: scope + '/assign', count: mine.length },
    { id: 'history', label: t('版本历史'), href: scope + '/history', count: profile.versions.length },
    { id: 'json', label: 'JSON', href: scope + '/json' },
  ]
  let body
  if (tab === 'assign') body = assignTab(ctx, profile, mine, departments, users, devices, reach)
  else if (tab === 'history') body = historyTab(ctx, profile, users)
  else if (tab === 'json') body = jsonTab(draft, changed, writable)
  else body = configTab(ctx, draft, changed, writable)

  ctx.render([{ label: t('场景包'), href: '#/profiles' }, { label: profile.name }], [
    pageHead({
      title: profile.name,
      badges: [badge('v' + profile.current_version, 'plain'), mine.length === 0 ? badge(t('未分配'), 'warn') : badge(tf('影响 {n} 人', { n: reach.size }), 'accent plain')],
      description: profile.description || t('还没有说明。'),
      actions: writable ? [button(t('重命名'), { iconName: 'edit', onclick: () => renameDialog(draft, changed) })] : [],
    }),
    tabs(tabItems, tab),
    body,
    savebar,
  ])
  changed()
}

function inDepartment(userDepartment, target, departments) {
  const byId = new Map(departments.map(dep => [dep.id, dep]))
  let current = userDepartment
  for (let guard = 0; current && guard < 50; guard += 1) {
    if (current === target) return true
    current = byId.get(current)?.parent_id ?? null
  }
  return false
}

function renameDialog(draft, changed) {
  const name = h('input', { value: draft.name })
  const description = h('input', { value: draft.description })
  return openDialog({
    title: t('重命名场景包'),
    build: (close) => ({
      body: [field(t('名称'), name), field(t('说明'), description)],
      actions: [button(t('取消'), { onclick: () => close() }), button(t('完成'), { kind: 'primary', onclick: () => {
        draft.name = name.value.trim() || draft.name
        draft.description = description.value
        changed()
        close(true)
        toast(t('保存场景包后生效'))
      } })],
    }),
  })
}

// ---------- config tab ----------

function chips(values, onRemove, writable) {
  return h('div', {}, values.map(value => h('span', { class: 'chip' }, value, writable && h('button', { type: 'button', title: tf('移除 {name}', { name: value }), onclick: () => onRemove(value) }, icon('x')))))
}

function addRow(placeholder, onAdd, writable, validate) {
  if (!writable) return null
  const input = h('input', { placeholder, autocomplete: 'off' })
  const error = h('div', { class: 'error' })
  const add = () => {
    const value = input.value.trim()
    if (value === '') return
    const problem = validate?.(value)
    if (problem) { error.textContent = problem; return }
    error.textContent = ''
    onAdd(value)
    input.value = ''
  }
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } })
  return h('div', {}, h('div', { class: 'inline-add' }, input, button(t('添加'), { onclick: add })), error)
}

function configTab(ctx, draft, changed, writable) {
  const spec = draft.spec
  const host = h('div')
  const redraw = () => { changed(); host.replaceChildren(...sections()) }
  const gatewayCredential = ctx.me.gatewayCredential ?? 'DSH_ORG_GATEWAY_KEY'

  const sections = () => [
    // models
    panel({
      title: t('模型'),
      description: t('员工在 DSH 里能选的模型，和新会话默认用哪一个。设置后，官方 DeepSeek 账号和 API Key 入口会关闭，所有请求都走这里的网关。'),
      actions: writable ? [ctx.me.gateway === 'direct' && button(t('从模型目录选择'), { kind: 'small', iconName: 'cpu', onclick: () => pickFromCatalog(ctx, spec, gatewayCredential, redraw) }), button(t('添加模型网关'), { kind: 'small', iconName: 'plus', onclick: () => {
        spec.models ??= { providers: {} }
        let key = 'org-gateway'
        for (let n = 2; spec.models.providers[key]; n += 1) key = 'org-gateway-' + n
        spec.models.providers[key] = { displayName: t('公司模型网关'), api: 'openai-completions', baseURL: ctx.me.gatewayUrl ?? 'https://', credential: gatewayCredential, models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }
        redraw()
      } })] : [],
      body: Object.keys(spec.models?.providers ?? {}).length === 0
        ? h('p', { class: 'muted' }, t('没有指定模型：员工需要自己配置模型和 API Key。'))
        : [
          ...Object.entries(spec.models.providers).map(([key, route]) => routeEditor(key, route, spec, redraw, writable, gatewayCredential)),
          field(t('新会话默认模型'), select(
            [['', t('不指定')], ...Object.entries(spec.models.providers).flatMap(([key, route]) => route.models.map(model => [key + '\u0000' + model.id, (route.displayName ?? key) + '：' + (model.name ?? model.id)]))],
            spec.models.default ? spec.models.default.provider + '\u0000' + spec.models.default.model : '',
            (value) => { if (value === '') delete spec.models.default; else { const [provider, model] = value.split('\u0000'); spec.models.default = { provider, model } } changed() },
            t('默认模型'))),
        ],
    }),
    // tools
    panel({
      title: t('工具权限'),
      description: t('勾选的工具会在模型调用时被拦下，模型收到下面的原因。这是防误操作的设置，真正的限制（能用哪些模型、额度）在模型网关上。'),
      body: [
        ...TOOL_GROUPS.map(group => h('div', {}, h('div', { class: 'section-title' }, group.title), h('div', { class: 'checks' }, group.tools.map(tool => {
          const on = tool.id.every(name => spec.tools?.deny?.includes(name))
          return h('label', { class: 'check' + (on ? ' on' : '') },
            h('input', { type: 'checkbox', checked: on, disabled: !writable, onchange: (event) => {
              spec.tools ??= {}
              const deny = new Set(spec.tools.deny ?? [])
              for (const name of tool.id) {
                if (event.target.checked) deny.add(name)
                else deny.delete(name)
              }
              spec.tools.deny = [...deny]
              if (spec.tools.deny.length === 0) delete spec.tools.deny
              redraw()
            } }),
            h('div', {}, h('div', { class: 'check-title' }, tf('禁用{space}{label}', { space: /^[A-Za-z]/.test(tool.label) ? ' ' : '', label: tool.label })), h('div', { class: 'check-desc' }, tool.desc)))
        })))),
        h('div', { class: 'field' }, h('div', { class: 'label' }, t('其他禁用的工具')),
          chips((spec.tools?.deny ?? []).filter(name => !KNOWN_TOOLS.has(name)), (name) => { spec.tools.deny = spec.tools.deny.filter(item => item !== name); redraw() }, writable),
          addRow(t('工具名，比如 job_kill'), (name) => { spec.tools ??= {}; spec.tools.deny = [...new Set([...(spec.tools.deny ?? []), name])]; redraw() }, writable,
            value => (/^[a-z][a-z0-9_]*$/.test(value) ? undefined : t('工具名只能是小写字母、数字和下划线')))),
        field(t('告诉模型的原因'), h('input', { value: spec.tools?.message ?? '', disabled: !writable, placeholder: t('这个工具已被组织的策略禁用。'), oninput: (event) => {
          spec.tools ??= {}
          if (event.target.value === '') delete spec.tools.message; else spec.tools.message = event.target.value
          changed()
        } }), t('模型会把它转告给员工，写清楚为什么不能用、可以找谁。')),
      ],
    }),
    // plugins
    panel({
      title: t('插件'),
      body: [
        h('div', { class: 'section-title' }, t('插件订阅')),
        h('p', { class: 'section-desc' }, t('员工在插件页「发现」里能看到的插件列表。公司插件市场上架了插件时，会自动排在最前面，不用在这里添加。')),
        chips(spec.plugins?.indexes ?? [], (url) => { spec.plugins.indexes = spec.plugins.indexes.filter(item => item !== url); redraw() }, writable),
        addRow('https://example.com/index.json', (url) => { spec.plugins ??= {}; spec.plugins.indexes = [...new Set([...(spec.plugins.indexes ?? []), url])]; redraw() }, writable,
          value => (/^https?:\/\/[^\s#]+$/.test(value) ? undefined : t('需要 http(s) 开头的完整地址'))),
        h('div', { class: 'section-title split' }, t('必装插件'), writable && button(t('从插件市场选择'), { kind: 'small', iconName: 'store', onclick: () => pickFromMarket(spec, redraw) })),
        h('p', { class: 'section-desc' }, t('员工电脑上会自动安装。必须写死版本，比如 dsh-im@1.2.3，或者固定到某个提交的 Git 地址。')),
        table([
          { label: t('插件'), cell: plugin => h('span', { class: 'mono' }, plugin.name) },
          { label: t('版本'), cell: plugin => h('span', { class: 'mono' }, plugin.spec.slice(plugin.name.length + 1) || plugin.spec) },
          { label: '', className: 'right', cell: plugin => writable && button('', { kind: 'ghost icon-only small', iconName: 'x', title: tf('移除 {name}', { name: plugin.name }), onclick: () => { spec.plugins.required = spec.plugins.required.filter(item => item !== plugin); redraw() } }) },
        ], spec.plugins?.required ?? [], { emptyState: h('p', { class: 'faint' }, t('没有必装插件。')) }),
        addRow(t('插件名@版本，比如 dsh-im@1.2.3'), (value) => {
          const at = value.lastIndexOf('@')
          spec.plugins ??= {}
          spec.plugins.required = [...(spec.plugins.required ?? []).filter(item => item.name !== value.slice(0, at)), { name: value.slice(0, at), spec: value }]
          redraw()
        }, writable, value => (/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(-[\w.-]+)?$/i.test(value) ? undefined : t('写成 插件名@完整版本号，比如 dsh-im@1.2.3（Git 地址请在 JSON 里写）'))),
        h('div', { class: 'section-title' }, t('禁止的插件')),
        h('p', { class: 'section-desc' }, t('已经装了的会被卸载，以后也不会装。')),
        chips(spec.plugins?.blocked ?? [], (name) => { spec.plugins.blocked = spec.plugins.blocked.filter(item => item !== name); redraw() }, writable),
        addRow(t('插件名'), (name) => { spec.plugins ??= {}; spec.plugins.blocked = [...new Set([...(spec.plugins.blocked ?? []), name])]; redraw() }, writable),
        h('div', { class: 'section-title' }, t('npm 源')),
        h('p', { class: 'section-desc' }, t('内网私服地址。留空就用员工电脑上 pnpm 的默认设置。')),
        h('input', { value: spec.plugins?.registry ?? '', disabled: !writable, placeholder: 'https://npm.example.com/', oninput: (event) => {
          spec.plugins ??= {}
          if (event.target.value === '') delete spec.plugins.registry; else spec.plugins.registry = event.target.value
          changed()
        } }),
      ],
    }),
    // skills
    panel({
      title: 'Skill',
      description: t('下发到员工电脑的 Skill，员工可以在对话里直接用。同名的个人 Skill 不会被覆盖。'),
      actions: writable ? [button(t('添加 Skill'), { kind: 'small', iconName: 'plus', onclick: () => {
        spec.skills ??= []
        let name = 'new-skill'
        for (let n = 2; spec.skills.some(skill => skill.name === name); n += 1) name = 'new-skill-' + n
        spec.skills.push({ name, files: { 'SKILL.md': tf('---\nname: {name}\ndescription: 一句话说明什么时候用它\n---\n\n', { name }) } })
        redraw()
      } })] : [],
      body: (spec.skills ?? []).length === 0 ? h('p', { class: 'muted' }, t('没有下发 Skill。')) : spec.skills.map(skill => h('div', { class: 'subsection' },
        h('div', { class: 'subsection-head' }, icon('book'),
          h('input', { value: skill.name, disabled: !writable, 'aria-label': t('Skill 名称'), class: 'mono', oninput: (event) => { skill.name = event.target.value; changed() } }),
          Object.keys(skill.files).length > 1 && h('span', { class: 'faint' }, tf('另有 {n} 个附带文件，在 JSON 里编辑', { n: Object.keys(skill.files).length - 1 })),
          writable && button(t('移除'), { kind: 'small ghost', onclick: () => { spec.skills = spec.skills.filter(item => item !== skill); if (spec.skills.length === 0) delete spec.skills; redraw() } })),
        h('textarea', { class: 'skill', disabled: !writable, 'aria-label': tf('{name} 的 SKILL.md', { name: skill.name }), value: skill.files['SKILL.md'] ?? '', oninput: (event) => { skill.files['SKILL.md'] = event.target.value; changed() } }))),
    }),
    // updates & offline
    panel({
      title: t('更新与离线'),
      body: [
        h('div', { class: 'field-row' },
          field(t('客户端更新源'), h('input', { value: spec.updates?.feedUrl ?? '', disabled: !writable, placeholder: t('留空用公开发布页'), oninput: (event) => {
            spec.updates ??= {}
            if (event.target.value === '') delete spec.updates.feedUrl; else spec.updates.feedUrl = event.target.value
            if (Object.keys(spec.updates).length === 0) delete spec.updates
            changed()
          } }), t('内网镜像的 latest.json 地址。')),
          field(t('自动检查更新'), select([['', t('跟随客户端默认')], ['on', t('开启')], ['off', t('关闭')]], spec.updates?.autoCheck === undefined ? '' : spec.updates.autoCheck ? 'on' : 'off', (value) => {
            spec.updates ??= {}
            if (value === '') delete spec.updates.autoCheck; else spec.updates.autoCheck = value === 'on'
            if (Object.keys(spec.updates).length === 0) delete spec.updates
            changed()
          }, t('自动检查更新')), t('关闭后由 IT 统一推送新版本。')),
          field(t('离线宽限（天）'), h('input', { type: 'number', min: '0', max: '365', value: spec.offline?.graceDays ?? '', placeholder: '7', disabled: !writable, oninput: (event) => {
            if (event.target.value === '') delete spec.offline; else spec.offline = { graceDays: Number(event.target.value) }
            changed()
          } }), t('连不上服务端时，继续用上次配置的天数。'))),
      ],
    }),
  ]
  host.replaceChildren(...sections())
  return host
}

/**
 * Choose models from the catalog for the organisation gateway route: the route
 * is created when missing and its model list replaced with the chosen ones.
 */
/** The install target the client runs for an approved market version. */
function installSpec(plugin) {
  const source = plugin.version.source
  if (source.type === 'npm') return plugin.name + '@' + plugin.version.version
  return 'git+' + source.url + '.git#' + source.commit + (source.path ? '&path:/' + source.path : '')
}

async function pickFromMarket(spec, redraw) {
  const market = await api('GET', '/admin/api/market')
  const approved = market.plugins.filter(plugin => plugin.status === 'approved' && plugin.version)
  const chosen = new Set((spec.plugins?.required ?? []).map(plugin => plugin.name))
  const picked = await openDialog({
    title: t('从插件市场选择必装插件'),
    build: (close) => ({
      body: approved.length === 0
        ? empty({ iconName: 'store', title: t('插件市场还没有上架插件'), text: t('先在插件市场审核并上架插件。'), action: h('a', { class: 'btn', href: '#/market', onclick: () => close() }, t('去插件市场')) })
        : [
          h('p', { class: 'muted' }, t('勾选的插件会按市场里审核过的版本，自动装到分配了这个场景包的员工电脑上。')),
          h('div', { class: 'checks' }, approved.map(plugin => h('label', { class: 'check' + (chosen.has(plugin.name) ? ' on' : '') },
            h('input', { type: 'checkbox', checked: chosen.has(plugin.name), onchange: (event) => {
              if (event.target.checked) chosen.add(plugin.name); else chosen.delete(plugin.name)
              event.target.closest('.check').classList.toggle('on', event.target.checked)
            } }),
            h('div', {}, h('div', { class: 'check-title' }, loc(plugin.title) || plugin.name), h('div', { class: 'check-desc mono' }, plugin.name + ' ' + plugin.version.version))))),
        ],
      actions: approved.length === 0 ? [] : [button(t('取消'), { onclick: () => close() }), button(t('设为必装'), { kind: 'primary', onclick: () => close(true) })],
    }),
  })
  if (!picked) return
  const fromMarket = new Set(approved.map(plugin => plugin.name))
  // Required plugins that are not in the market stay as they are.
  const kept = (spec.plugins?.required ?? []).filter(plugin => !fromMarket.has(plugin.name) || chosen.has(plugin.name))
  const byName = new Map(kept.map(plugin => [plugin.name, plugin]))
  for (const plugin of approved) if (chosen.has(plugin.name)) byName.set(plugin.name, { name: plugin.name, spec: installSpec(plugin) })
  spec.plugins ??= {}
  spec.plugins.required = [...byName.values()]
  if (spec.plugins.required.length === 0) delete spec.plugins.required
  if (Object.keys(spec.plugins).length === 0) delete spec.plugins
  redraw()
}

async function pickFromCatalog(ctx, spec, gatewayCredential, redraw) {
  const catalog = await api('GET', '/admin/api/catalog')
  const routes = Object.entries(spec.models?.providers ?? {})
  const existing = routes.find(([, route]) => route.credential === gatewayCredential)
  const chosen = new Set(existing ? existing[1].models.map(model => model.id) : [])
  const picked = await openDialog({
    title: t('从模型目录选择'),
    build: (close) => ({
      body: catalog.models.length === 0
        ? empty({ iconName: 'cpu', title: t('模型目录是空的'), text: t('先在模型目录里登记模型和价格。'), action: h('a', { class: 'btn', href: '#/models', onclick: () => close() }, t('去模型目录')) })
        : [
          h('p', { class: 'muted' }, t('勾选的模型会出现在员工的模型列表里，请求经公司网关转发并按目录价格计费。')),
          h('div', { class: 'checks' }, catalog.models.map(model => h('label', { class: 'check' + (chosen.has(model.id) ? ' on' : '') + (model.enabled ? '' : ' faint') },
            h('input', { type: 'checkbox', checked: chosen.has(model.id), disabled: !model.enabled, onchange: (event) => {
              if (event.target.checked) chosen.add(model.id); else chosen.delete(model.id)
              event.target.closest('.check').classList.toggle('on', event.target.checked)
            } }),
            h('div', {}, h('div', { class: 'check-title' }, model.name, model.recommended ? ' · ' + t('推荐') : ''), h('div', { class: 'check-desc mono' }, model.id + (model.enabled ? '' : ' · ' + t('已停用'))))))),
        ],
      actions: catalog.models.length === 0 ? [] : [button(t('取消'), { onclick: () => close() }), button(t('使用这些模型'), { kind: 'primary', onclick: () => close(true) })],
    }),
  })
  if (!picked) return
  const models = catalog.models.filter(model => chosen.has(model.id)).map(model => ({ id: model.id, name: model.name, ...model.contextWindow && { contextWindow: model.contextWindow } }))
  spec.models ??= { providers: {} }
  let key = existing?.[0]
  if (key === undefined) {
    key = 'org-gateway'
    for (let n = 2; spec.models.providers[key]; n += 1) key = 'org-gateway-' + n
    spec.models.providers[key] = { displayName: t('公司模型网关'), api: 'openai-completions', baseURL: ctx.me.gatewayUrl ?? 'https://', credential: gatewayCredential, models }
  }
  if (models.length === 0) {
    spec.models.providers = Object.fromEntries(Object.entries(spec.models.providers).filter(([name]) => name !== key))
    if (spec.models.default?.provider === key) delete spec.models.default
    if (Object.keys(spec.models.providers).length === 0) delete spec.models
  } else {
    spec.models.providers[key].models = models
    if (spec.models.default?.provider === key && !models.some(model => model.id === spec.models.default.model)) delete spec.models.default
    const recommended = catalog.models.find(model => model.recommended && chosen.has(model.id))
    if (spec.models.default === undefined && recommended) spec.models.default = { provider: key, model: recommended.id }
  }
  redraw()
}

function routeEditor(key, route, spec, redraw, writable, gatewayCredential) {
  const changeKey = (event) => {
    const next = event.target.value.trim()
    if (next === key || next === '' || spec.models.providers[next]) return
    spec.models.providers = Object.fromEntries(Object.entries(spec.models.providers).map(([name, value]) => [name === key ? next : name, value]))
    if (spec.models.default?.provider === key) spec.models.default.provider = next
    redraw()
  }
  const update = (mutate) => (event) => { mutate(event.target.value); redraw() }
  return h('div', { class: 'subsection' },
    h('div', { class: 'subsection-head' }, icon('gateway'), h('strong', {}, route.displayName ?? key),
      writable && button(t('移除'), { kind: 'small ghost', onclick: () => {
        spec.models.providers = Object.fromEntries(Object.entries(spec.models.providers).filter(([name]) => name !== key))
        if (spec.models.default?.provider === key) delete spec.models.default
        if (Object.keys(spec.models.providers).length === 0) delete spec.models
        redraw()
      } })),
    h('div', { class: 'field-row' },
      field(t('显示名'), h('input', { value: route.displayName ?? '', disabled: !writable, onchange: update(value => { route.displayName = value || undefined }) })),
      field(t('标识'), h('input', { value: key, class: 'mono', disabled: !writable, onchange: changeKey }), t('小写字母和连字符')),
      field(t('协议'), select(Object.entries(API_LABEL), route.api, (value) => { route.api = value; redraw() }, t('协议')))),
    field(t('网关地址'), h('input', { value: route.baseURL, class: 'mono', disabled: !writable, onchange: update(value => { route.baseURL = value }) }), t('比如 https://llm.example.com/v1')),
    field(t('凭据'), select([[gatewayCredential, tf('服务端为每个人签发的网关 Key（{name}）', { name: gatewayCredential })], ...(route.credential && route.credential !== gatewayCredential ? [[route.credential, route.credential]] : []), ['', t('不需要凭据')]],
      route.credential ?? '', (value) => { route.credential = value || undefined; redraw() }, t('凭据'))),
    h('div', { class: 'label section-title' }, t('模型')),
    table([
      { label: t('模型 ID'), cell: model => h('input', { value: model.id, class: 'mono', disabled: !writable, 'aria-label': t('模型 ID'), onchange: (event) => { const old = model.id; model.id = event.target.value; if (spec.models.default?.provider === key && spec.models.default.model === old) spec.models.default.model = model.id; redraw() } }) },
      { label: t('显示名'), cell: model => h('input', { value: model.name ?? '', disabled: !writable, 'aria-label': t('显示名'), onchange: (event) => { model.name = event.target.value || undefined; redraw() } }) },
      { label: t('上下文长度'), cell: model => h('input', { type: 'number', value: model.contextWindow ?? '', placeholder: t('自动'), disabled: !writable, 'aria-label': t('上下文长度'), onchange: (event) => { model.contextWindow = event.target.value === '' ? undefined : Number(event.target.value); redraw() } }) },
      { label: '', className: 'right', cell: model => writable && route.models.length > 1 && button('', { kind: 'ghost icon-only small', iconName: 'x', title: tf('移除 {name}', { name: model.id }), onclick: () => { route.models = route.models.filter(item => item !== model); redraw() } }) },
    ], route.models),
    writable && h('div', { class: 'inline-add' }, button(t('添加模型'), { kind: 'small', iconName: 'plus', onclick: () => { route.models.push({ id: 'model-' + (route.models.length + 1) }); redraw() } })))
}

// ---------- assign tab ----------

function assignTab(ctx, profile, mine, departments, users, devices, reach) {
  const writable = ctx.canWrite()
  const scoped = devices.filter(device => device.status === 'active' && reach.has(device.user_id))
  return h('div', {},
    panel({
      title: t('分配给'),
      description: t('这个场景包对哪些人生效。下级部门会继承上级部门的分配。'),
      actions: writable ? [button(t('添加分配'), { kind: 'primary small', iconName: 'plus', onclick: () => assignDialog(ctx, profile, departments, users) })] : [],
      flush: true,
      body: table([
        { label: t('对象'), cell: binding => h('div', { class: 'title-line' }, icon(binding.target_type === 'tenant' ? 'overview' : binding.target_type === 'department' ? 'tree' : 'user'), targetLabel(binding, departments, users)) },
        { label: t('类型'), cell: binding => ({ tenant: t('全员'), department: t('部门'), user: t('个人') })[binding.target_type] },
        { label: '', className: 'right', cell: binding => writable && button(t('取消分配'), { kind: 'small ghost', onclick: async () => {
          if (!await confirmAction({ title: t('取消分配'), text: tf('「{target}」将不再收到「{profile}」，在线设备几秒内就会移除对应配置。', { target: targetLabel(binding, departments, users), profile: profile.name }), confirmLabel: t('取消分配') })) return
          await busy(null, async () => { await api('DELETE', '/admin/api/bindings/' + binding.id); toast(t('已取消分配')); ctx.refresh() })
        } }) },
      ], mine, { emptyState: empty({ iconName: 'layers', title: t('还没有分配给任何人'), text: t('分配给全员、某个部门或个人后，这个场景包才会生效。') }) }),
    }),
    panel({ title: t('生效情况'), description: tf('受这个场景包影响的 {n} 人名下的设备，是否已经用上当前配置。', { n: reach.size }), flush: true, body: rolloutPanel(scoped, ctx.me.organization.revision, { compact: true }) }),
  )
}

function assignDialog(ctx, profile, departments, users) {
  let kind = 'department'
  const target = h('div')
  const drawTarget = () => target.replaceChildren(kind === 'tenant' ? h('p', { class: 'muted' }, t('组织里的所有人都会收到。'))
    : kind === 'department' ? field(t('部门'), select(departments.map(dep => [dep.id, dep.name]), departments[0]?.id ?? '', () => {}, t('部门')), t('下级部门也会收到。'))
    : field(t('成员'), select(users.filter(user => user.status === 'active').map(user => [user.id, user.name + '（' + (user.email ?? '') + '）']), '', () => {}, t('成员'))))
  const kinds = h('div', { class: 'checks' })
  const drawKinds = () => kinds.replaceChildren(...[['tenant', t('全员')], ['department', t('部门')], ['user', t('个人')]].map(([value, label]) => h('label', { class: 'check' + (kind === value ? ' on' : '') },
    h('input', { type: 'radio', name: 'kind', checked: kind === value, onchange: () => { kind = value; drawKinds(); drawTarget() } }), h('div', { class: 'check-title' }, label))))
  drawKinds()
  drawTarget()
  return openDialog({
    title: tf('分配「{name}」', { name: profile.name }),
    build: (close) => {
      const save = button(t('分配'), { kind: 'primary', onclick: () => busy(save, async () => {
        const chosen = target.querySelector('select')?.value ?? ''
        await api('POST', '/admin/api/bindings', { profileId: profile.id, targetType: kind, targetId: chosen })
        toast(t('已分配，在线设备几秒内就会用上'))
        close(true)
        ctx.refresh()
      }) })
      return { body: [h('div', { class: 'field' }, h('div', { class: 'label' }, t('分配给')), kinds), target], actions: [button(t('取消'), { onclick: () => close() }), save] }
    },
  })
}

// ---------- history tab ----------

function historyTab(ctx, profile, users) {
  const writable = ctx.canWrite()
  const names = new Map(users.map(user => [user.id, user.name]))
  const versions = profile.versions
  return panel({
    title: t('版本历史'),
    description: t('每次保存都是一个新版本，旧版本不会被改动。回滚会把旧版本的内容保存成一个新版本。'),
    flush: true,
    body: table([
      { label: t('版本'), cell: version => h('div', { class: 'title-line' }, h('span', { class: 'num cell-title' }, 'v' + version.version), version.version === profile.current_version && badge(t('当前'), 'ok')) },
      { label: t('说明'), className: 'wrap', cell: version => version.note || h('span', { class: 'faint' }, '—') },
      { label: t('保存人'), cell: version => (version.created_by === 'bootstrap' ? t('初始管理员') : names.get(version.created_by) ?? version.created_by ?? '—') },
      { label: t('时间'), cell: version => timeCell(version.created_at) },
      { label: '', className: 'right', cell: version => h('div', { class: 'row-actions' },
        button(t('对比'), { kind: 'small', onclick: () => compareDialog(versions, version) }),
        writable && version.version !== profile.current_version && button(t('回滚到此版本'), { kind: 'small', onclick: async () => {
          if (!await confirmAction({ title: tf('回滚到 v{n}', { n: version.version }), text: tf('会把 v{from} 的内容保存成 v{to}，在线设备几秒内就会用上。', { from: version.version, to: profile.current_version + 1 }), confirmLabel: t('回滚'), danger: false })) return
          await busy(null, async () => { await api('POST', '/admin/api/profiles/' + profile.id + '/rollback', { version: version.version }); toast(t('已回滚')); ctx.refresh() })
        } })) },
    ], versions),
  })
}

function compareDialog(versions, version) {
  const index = versions.indexOf(version)
  const previous = versions[index + 1]
  return openDialog({
    title: previous ? tf('v{from} 到 v{to} 的变化', { from: previous.version, to: version.version }) : tf('v{n}（第一个版本）', { n: version.version }),
    wide: true,
    build: (close) => ({
      body: lineDiff(stableJson(previous?.spec ?? {}), stableJson(version.spec)),
      actions: [button(t('关闭'), { onclick: () => close() })],
    }),
  })
}

// ---------- json tab ----------

function jsonTab(draft, changed, writable) {
  const editor = h('textarea', { class: 'code', spellcheck: 'false', disabled: !writable, 'aria-label': t('场景包 JSON') })
  editor.value = JSON.stringify(draft.spec, null, 2)
  const status = h('div', { class: 'help' }, t('和「配置」页编辑的是同一份内容。这里可以写表单里没有的字段，比如 Git 形式的必装插件、Skill 附带文件。'))
  editor.addEventListener('input', () => {
    try {
      draft.spec = JSON.parse(editor.value)
      status.className = 'help'
      status.textContent = t('JSON 格式正确。')
      changed()
    } catch (error) {
      status.className = 'error'
      status.textContent = tf('JSON 格式错误：{message}', { message: error.message })
    }
  })
  return panel({ body: [editor, status] })
}

