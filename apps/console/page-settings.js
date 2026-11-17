import { t, tf } from './i18n.js'
import { api } from './api.js'
import { badge, callout, copyButton, h, icon, pageHead, panel, tabs } from './ui.js'

const PLATFORMS = {
  macos: {
    label: 'macOS',
    dir: '/Library/Application Support/DSH Desktop Pro',
    steps: [
      t('用 MDM（Jamf、Kandji、Intune 等）把 enrollment.json 推到下面的目录，或者在安装包的 postinstall 脚本里写入。'),
      t('目录归 root 所有，员工改不了；客户端下次启动时就进入企业模式。'),
    ],
    command: (file) => 'sudo mkdir -p "/Library/Application Support/DSH Desktop Pro" && sudo cp ' + file + ' "/Library/Application Support/DSH Desktop Pro/enrollment.json"',
  },
  windows: {
    label: 'Windows',
    dir: '%ProgramData%\\DSH Desktop Pro',
    steps: [
      t('用 Intune、SCCM 或组策略把 enrollment.json 复制到下面的目录。'),
      t('普通用户对 ProgramData 只有读权限；客户端下次启动时就进入企业模式。'),
    ],
    command: (file) => 'New-Item -ItemType Directory -Force "$env:ProgramData\\DSH Desktop Pro"; Copy-Item ' + file + ' "$env:ProgramData\\DSH Desktop Pro\\enrollment.json"',
  },
  linux: {
    label: 'Linux',
    dir: '/etc/dsh-desktop-pro',
    steps: [
      t('用 Ansible、Salt 等配置管理工具，或者在 DEB 安装后脚本里写入。'),
      t('客户端下次启动时就进入企业模式。'),
    ],
    command: (file) => 'sudo install -D -m 0644 ' + file + ' /etc/dsh-desktop-pro/enrollment.json',
  },
}

export async function renderDistribution(ctx) {
  const personal = ctx.query.get('personal') === '1'
  const [enrollment, joining] = await Promise.all([
    api('GET', '/admin/api/enrollment' + (personal ? '?personal=1' : '')),
    api('GET', '/admin/api/join-address'),
  ])
  const platform = ctx.query.get('os') ?? 'macos'
  const here = (changes) => {
    const query = new URLSearchParams({ os: platform, ...personal && { personal: '1' }, ...changes })
    if (query.get('personal') !== '1') query.delete('personal')
    return '#/distribution?' + query.toString()
  }
  const chosen = PLATFORMS[platform] ?? PLATFORMS.macos
  const command = chosen.command('enrollment.json')
  ctx.render([{ label: t('注册与分发') }], [
    pageHead({
      title: t('注册与分发'),
      description: t('让员工电脑认识这个组织：把加入地址发给员工自己加入；或者把注册文件放进系统目录统一安装，员工打开 DSH Desktop Pro 时就只看到「使用企业账号登录」。'),
      actions: [h('a', { class: 'btn primary', href: '/admin/api/enrollment' + (personal ? '?personal=1' : ''), download: 'enrollment.json' }, icon('download'), t('下载 enrollment.json'))],
    }),
    h('div', { class: 'grid-2' },
      h('div', {},
        panel({
          title: t('员工自己加入'),
          description: t('没有 MDM 时，把下面的加入地址发给员工。员工在 DSH Desktop Pro 的「桌面设置 → 组织」里粘贴这个地址，用公司账号登录后就加入了组织。'),
          body: [
            h('div', { class: 'field' }, h('div', { class: 'label' }, t('加入地址')), h('div', { class: 'title-line' }, h('code', { class: 'mono' }, joining.address), copyButton(joining.address))),
            h('p', { class: 'muted' }, t('地址末尾的校验码对应组织的签名公钥。客户端登录后会核对它，对不上就拒绝加入，所以内网用 HTTP 也不会被同网段的人冒充。请用企业微信、邮件等其他渠道发送，不要只靠这个服务端本身告诉员工。')),
            ...joining.secure ? [] : [callout('warn', t('服务地址是 HTTP：员工必须用带校验码的加入地址才能加入。登录令牌和组织下发的网关 Key 在内网里仍是明文传输，条件允许时请改用 HTTPS（内网 CA 也可以）。'))],
          ],
        }),
        panel({
          title: t('安装到员工电脑'),
          body: [
            tabs(Object.entries(PLATFORMS).map(([id, item]) => ({ id, label: item.label, href: here({ os: id }) })), platform),
            h('ol', { class: 'muted' }, chosen.steps.map(step => h('li', {}, step))),
            h('div', { class: 'field' }, h('div', { class: 'label' }, t('放置目录')), h('div', { class: 'title-line' }, h('code', { class: 'mono' }, chosen.dir), copyButton(chosen.dir))),
            h('div', { class: 'field' }, h('div', { class: 'label' }, t('手动安装命令')), h('pre', { class: 'code' }, command), h('div', {}, copyButton(command))),
          ],
        }),
        panel({
          title: t('员工能否改用个人模式'),
          description: t('决定登录页上有没有「改用个人模式」。个人模式下员工用自己的模型 Key 和自己的数据目录，不受组织配置约束；组织的数据仍然单独保存，随时可以切回企业账号。'),
          body: [
            tabs([
              { id: 'no', label: t('不允许（公司电脑推荐）'), href: here({ personal: '0' }) },
              { id: 'yes', label: t('允许（员工自带电脑）'), href: here({ personal: '1' }) },
            ], personal ? 'yes' : 'no'),
            h('p', { class: 'muted' }, personal
              ? t('下载的 enrollment.json 会带上 "allowPersonal": true。')
              : t('员工只能使用企业账号登录，绕不开组织配置。')),
          ],
        }),
        panel({ title: t('文件内容'), description: t('只有服务地址和组织公钥，不含任何密钥，可以放心分发。'), body: h('pre', { class: 'code' }, JSON.stringify(enrollment, null, 2)) })),
      panel({
        title: t('这个文件做什么'),
        body: h('dl', { class: 'props' },
          h('dt', {}, t('服务地址')), h('dd', { class: 'mono' }, enrollment.server),
          h('dt', {}, t('组织')), h('dd', {}, enrollment.organization.name),
          h('dt', {}, t('个人模式')), h('dd', {}, personal ? t('允许员工改用') : t('不允许')),
          h('dt', {}, t('签名公钥')), h('dd', {}, tf('{n} 把', { n: enrollment.keys.length }), h('div', { class: 'cell-sub mono' }, enrollment.keys.map(key => key.keyId).join('\n'))),
          h('dt', {}, t('作用')), h('dd', { class: 'muted' }, t('客户端只接受用这些公钥签过名的配置。即使网络被劫持、本地缓存被改，员工电脑也不会用上别人伪造的配置。'))),
      })),
    callout('info', t('还没有服务端、只想给小团队统一配置？可以不用注册文件，直接放一份 managed.json（文件模式），见部署指南。')),
  ])
}

export async function renderGateway(ctx) {
  const kind = ctx.me.gateway
  ctx.render([{ label: t('网关设置') }], [
    pageHead({
      title: t('网关设置'),
      description: t('真实的模型 Key 只放在网关里。员工拿到的是网关为每个人签发的个人 Key：只能用场景包里列出的模型，停用员工时立即作废。'),
      badges: [kind === 'direct' ? badge(t('内置网关'), 'ok') : kind === 'litellm' ? badge(t('已接入 LiteLLM'), 'ok') : badge(t('未接入'), 'warn')],
    }),
    kind === 'direct' ? directPanel(ctx) : kind === 'litellm' ? litellmPanel(ctx) : setupPanel(),
    callout('info', t('硬限制都在网关上执行：能用哪些模型、额度、个人 Key 何时作废。客户端上的工具禁用是防误操作的，不是安全边界。')),
    h('div', { class: 'title-line' },
      kind === 'direct' && h('a', { class: 'btn', href: '#/models' }, icon('cpu'), t('模型目录')),
      kind === 'direct' && h('a', { class: 'btn', href: '#/usage' }, icon('chart'), t('用量分析')),
      kind === 'direct' && h('a', { class: 'btn', href: '#/quotas' }, icon('gauge'), t('额度')),
      h('a', { class: 'btn', href: '#/profiles' }, icon('layers'), t('场景包'))),
  ])
}

function directPanel(ctx) {
  return panel({
    title: t('内置网关'),
    description: t('服务端自己做网关：检查每个人的 Key 和可用模型，再用组织的真实 Key 转发给上游。'),
    body: h('dl', { class: 'props' },
      h('dt', {}, t('上游')), h('dd', {}, h('a', { href: '#/models' }, t('在模型目录里管理')), h('div', { class: 'cell-sub' }, ctx.me.upstream ? tf('默认上游 {host}（服务端 .env 里的 DSH_UPSTREAM_URL）；模型目录里可以再添加其他上游。', { host: ctx.me.upstream }) : t('任意 OpenAI 兼容接口，可以添加多个；不在模型目录里的模型发往默认上游 DSH_UPSTREAM_URL。'))),
      h('dt', {}, t('网关地址')), h('dd', {}, h('div', { class: 'title-line' }, h('code', { class: 'mono' }, ctx.me.gatewayUrl), copyButton(ctx.me.gatewayUrl)), h('div', { class: 'cell-sub' }, t('场景包里模型路由的「网关地址」填这个；新建的模型路由会自动填好。'))),
      h('dt', {}, t('凭据名称')), h('dd', {}, h('span', { class: 'mono' }, ctx.me.gatewayCredential), h('div', { class: 'cell-sub' }, t('场景包里模型路由的「凭据」选这个名字，员工就会自动拿到自己的 Key。'))),
      h('dt', {}, t('可用模型')), h('dd', {}, t('只放行这个人的场景包里、路由到内置网关的模型；场景包一改，下一个请求就按新的来。')),
      h('dt', {}, t('额度')), h('dd', {}, t('转发前检查对他生效的所有额度；用完时拦截，或改用指定的模型。')),
      h('dt', {}, t('记录')), h('dd', {}, t('每个请求记下成员、模型、Token、费用、耗时和结果，不记录对话内容。')),
      h('dt', {}, t('吊销')), h('dd', {}, t('停用员工时，他的 Key 立即失效。'))),
  })
}

function litellmPanel(ctx) {
  return panel({
    title: 'LiteLLM',
    body: h('dl', { class: 'props' },
      h('dt', {}, t('签发方式')), h('dd', {}, t('员工第一次拉取配置时，通过 LiteLLM 的 /key/generate 为他签发；快到期时自动换新。')),
      h('dt', {}, t('凭据名称')), h('dd', {}, h('span', { class: 'mono' }, ctx.me.gatewayCredential), h('div', { class: 'cell-sub' }, t('场景包里模型路由的「凭据」选这个名字，员工就会自动拿到自己的 Key。'))),
      h('dt', {}, t('吊销')), h('dd', {}, t('停用员工时调用 /key/delete，立即作废。'))),
  })
}

function setupPanel() {
  return panel({
    title: t('接入网关'),
    body: [
      h('p', { class: 'muted' }, t('直接对接一个 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、智谱、内网 vLLM 等）：在服务端的 .env 里设置下面几项，然后重启服务端。')),
      h('pre', { class: 'code' }, 'DSH_GATEWAY=direct\nDSH_UPSTREAM_URL=https://api.deepseek.com/v1\nDSH_UPSTREAM_KEY=sk-…'),
      h('p', { class: 'muted' }, t('需要接多家模型、按人设预算时，改用 LiteLLM：DSH_GATEWAY=litellm，Docker Compose 部署可以用 --profile litellm 一起启动。')),
      h('p', { class: 'muted' }, t('没有网关时，场景包里的模型路由可以不填凭据，由员工自己在 DSH 里保存 API Key。')),
    ],
  })
}
