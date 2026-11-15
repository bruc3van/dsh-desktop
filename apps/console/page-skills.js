// Skill library: the organisation's skills, installed for everyone or chosen by each person in the client.
import { lang, t, tf } from './i18n.js'
import { api } from './api.js'
import { badge, busy, button, callout, confirmAction, empty, field, h, icon, pageHead, panel, table, timeCell, toast } from './ui.js'

export const DISTRIBUTION = {
  everyone: { label: t('所有人'), help: t('每位员工的电脑都会装上，员工不能移除。') },
  optional: { label: t('员工自选'), help: t('员工在客户端「设置 → 公司 Skill」里自己选择安装。') },
}

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function starter(id, title) {
  return lang === 'en'
    ? '---\nname: ' + id + '\ndescription: One sentence on when to use this skill\n---\n\n# ' + title + '\n\n'
    : '---\nname: ' + id + '\ndescription: 一句话说明什么时候用它\n---\n\n# ' + title + '\n\n'
}

export async function renderList(ctx) {
  const skills = await api('GET', '/admin/api/skills')
  const writable = ctx.canWrite()
  const everyone = skills.filter(skill => skill.distribution === 'everyone').length

  ctx.render([{ label: t('Skill 库') }], [
    pageHead({
      title: t('Skill 库'),
      description: t('把公司的做事方法写成 Skill：周报格式、代码规范、合同审阅要点……员工在对话里直接用。可以给所有人装上，也可以放进库里让员工自己选。'),
      actions: writable ? [button(t('新建 Skill'), { kind: 'primary', iconName: 'plus', onclick: () => { location.hash = '#/skills/new' } })] : [],
    }),
    panel({
      flush: true,
      body: table([
        { label: 'Skill', cell: skill => h('div', { class: 'plugin-cell' }, h('span', { class: 'plugin-icon letter' }, icon('book')), h('div', { class: 'plugin-text' },
          h('div', { class: 'cell-title' }, skill.title),
          h('div', { class: 'cell-sub' }, h('span', { class: 'mono' }, skill.id), skill.description && [' · ', skill.description]))) },
        { label: t('下发方式'), cell: skill => badge(DISTRIBUTION[skill.distribution].label, skill.distribution === 'everyone' ? 'accent' : 'plain') },
        { label: t('已安装'), className: 'num', cell: skill => skill.distribution === 'everyone' ? h('span', { class: 'muted' }, t('全员')) : tf('{n} 人', { n: skill.subscribers }) },
        { label: t('文件'), className: 'num', cell: skill => String(skill.files.length) },
        { label: t('版本'), cell: skill => h('div', {}, 'v' + String(skill.version), h('div', { class: 'cell-sub' }, timeCell(skill.updatedAt))) },
      ], skills, {
        onRow: skill => { location.hash = '#/skills/' + encodeURIComponent(skill.id) },
        emptyState: empty({ iconName: 'book', title: t('Skill 库还是空的'), text: t('Skill 是一个 SKILL.md 文件（可以附带参考文件），告诉模型某类事情怎么做。写好后保存，员工电脑在几秒内收到。'), action: writable && button(t('新建 Skill'), { kind: 'primary', iconName: 'plus', onclick: () => { location.hash = '#/skills/new' } }) }),
      }),
    }),
    skills.length > 0 && callout('info', tf('{a} 个给所有人，{b} 个由员工自选。场景包里也能下发 Skill；同名时以场景包里的为准。', { a: everyone, b: skills.length - everyone })),
  ])
}

export async function renderDetail(ctx, rawId) {
  const id = decodeURIComponent(rawId)
  const creating = id === 'new'
  const [skill, users] = await Promise.all([creating ? Promise.resolve(null) : api('GET', '/admin/api/skills/' + encodeURIComponent(id)), api('GET', '/admin/api/users')])
  const writable = ctx.canWrite()
  const people = new Map(users.map(user => [user.id, user.name]))
  const draft = skill
    ? { id: skill.id, title: skill.title, description: skill.description ?? '', distribution: skill.distribution, files: { ...skill.files } }
    : { id: '', title: '', description: '', distribution: 'optional', files: { 'SKILL.md': '' } }
  let current = 'SKILL.md'
  let touchedStarter = !creating

  const host = h('div')
  const changed = () => ctx.setDirty(true)
  const save = button(creating ? t('创建') : t('保存'), { kind: 'primary', disabled: !writable, onclick: () => busy(save, async () => {
    const target = creating ? draft.id.trim() : skill.id
    if (!SKILL_ID.test(target)) throw new Error(t('Skill ID 只能用小写字母、数字和 . _ -，并以字母或数字开头。'))
    const saved = await api('PUT', '/admin/api/skills/' + encodeURIComponent(target), { title: draft.title.trim(), description: draft.description, distribution: draft.distribution, files: draft.files })
    ctx.setDirty(false)
    toast(creating ? t('已创建 Skill，员工电脑会在几秒内收到') : tf('已保存，当前版本 v{n}', { n: saved.version }))
    if (creating) location.hash = '#/skills/' + encodeURIComponent(saved.id)
    else ctx.refresh()
  }) })
  const remove = async () => {
    if (!await confirmAction({ title: tf('删除 Skill {name}', { name: skill.title }), text: t('删除后，员工电脑在下次同步时移除它。'), confirmLabel: t('删除'), typeToConfirm: skill.id })) return
    await busy(null, async () => { await api('DELETE', '/admin/api/skills/' + encodeURIComponent(skill.id)); ctx.setDirty(false); toast(t('已删除 Skill')); location.hash = '#/skills' })
  }
  const addFile = () => {
    const name = prompt(t('文件路径，例如 reference/checklist.md'))
    if (name === null) return
    const path = name.trim()
    if (!/^[\w./ -]{1,200}$/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) { toast(t('文件路径只能是 Skill 目录里的相对路径。'), 'bad'); return }
    if (Object.hasOwn(draft.files, path)) { current = path; draw(); return }
    draft.files[path] = ''
    current = path
    changed()
    draw()
  }

  const draw = () => host.replaceChildren(...[
    panel({
      title: t('基本信息'),
      body: [
        h('div', { class: 'field-row' },
          field(t('名称'), h('input', { value: draft.title, disabled: !writable, placeholder: t('例如：周报格式'), oninput: (event) => {
            draft.title = event.target.value
            changed()
          } })),
          field('Skill ID', h('input', { class: 'mono', value: draft.id, disabled: !creating || !writable, placeholder: 'weekly-report', oninput: (event) => {
            draft.id = event.target.value
            // Until someone edits SKILL.md, keep the starter's name in step with the ID.
            if (!touchedStarter) { draft.files['SKILL.md'] = SKILL_ID.test(draft.id) ? starter(draft.id, draft.title || draft.id) : ''; draw(); event.target.focus() }
            changed()
          } }), creating ? t('员工电脑上 Skill 目录的名字，创建后不能修改。') : null)),
        field(t('一句话介绍'), h('input', { value: draft.description, disabled: !writable, placeholder: t('员工在客户端里看到的说明'), oninput: (event) => { draft.description = event.target.value; changed() } })),
        field(t('下发方式'), h('div', { class: 'checks two' }, Object.entries(DISTRIBUTION).map(([value, item]) => h('label', { class: 'check' + (draft.distribution === value ? ' on' : '') },
          h('input', { type: 'radio', name: 'distribution', value, checked: draft.distribution === value, disabled: !writable, onchange: () => { draft.distribution = value; changed(); draw() } }),
          h('div', {}, h('div', { class: 'check-title' }, item.label), h('div', { class: 'check-desc' }, item.help)))))),
      ],
    }),
    panel({
      title: t('文件'),
      description: t('SKILL.md 必须有；开头的 name 和 description 决定模型什么时候用它。可以附带参考文件，模型需要时会读取。'),
      actions: writable ? [button(t('添加文件'), { kind: 'small', iconName: 'plus', onclick: addFile })] : [],
      body: h('div', { class: 'file-editor' },
        h('div', { class: 'file-list', role: 'tablist' }, Object.keys(draft.files).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b))).map(path => h('button', {
          type: 'button', role: 'tab', class: 'file-tab' + (path === current ? ' active' : ''), 'aria-selected': path === current ? 'true' : 'false',
          onclick: () => { current = path; draw() },
        }, path))),
        h('div', { class: 'file-body' },
          h('div', { class: 'subsection-head' }, h('span', { class: 'mono' }, current),
            writable && current !== 'SKILL.md' && button(t('删除文件'), { kind: 'small ghost', onclick: () => { draft.files = Object.fromEntries(Object.entries(draft.files).filter(([path]) => path !== current)); current = 'SKILL.md'; changed(); draw() } })),
          h('textarea', { class: 'skill tall', disabled: !writable, spellcheck: 'false', 'aria-label': current, value: draft.files[current] ?? '', placeholder: creating && current === 'SKILL.md' ? t('先填写 Skill ID，这里会生成一个模板。') : '', oninput: (event) => {
            draft.files[current] = event.target.value
            if (current === 'SKILL.md') touchedStarter = true
            changed()
          } }))),
    }),
    skill && skill.distribution === 'optional' && panel({
      title: tf('已安装的员工（{n}）', { n: skill.subscriberIds.length }),
      body: skill.subscriberIds.length === 0
        ? h('p', { class: 'muted' }, t('还没有人安装。员工在客户端的「设置 → 公司 Skill」里可以看到它。'))
        : h('div', { class: 'chips' }, skill.subscriberIds.map(userId => h('a', { class: 'chip', href: '#/members/' + encodeURIComponent(userId) }, people.get(userId) ?? userId))),
    }),
    h('div', { class: 'form-actions' }, writable && skill && button(t('删除 Skill'), { kind: 'danger ghost', onclick: remove }), h('span', { class: 'spacer' }),
      skill && h('span', { class: 'faint' }, tf('v{n} · 更新于 ', { n: skill.version }), timeCell(skill.updatedAt)), save),
  ].filter(Boolean))
  draw()

  ctx.render([{ label: t('Skill 库'), href: '#/skills' }, { label: creating ? t('新建 Skill') : skill.title }], [
    pageHead({ title: creating ? t('新建 Skill') : skill.title, badges: skill ? [badge(DISTRIBUTION[skill.distribution].label, skill.distribution === 'everyone' ? 'accent' : 'plain')] : [] }),
    host,
  ])
}
