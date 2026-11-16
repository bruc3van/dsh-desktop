// Server access and the vocabulary shared by every page.
import { lang, t, tf } from './i18n.js'

export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try { data = text === '' ? null : JSON.parse(text) } catch { data = null }
  if (!response.ok) {
    const error = new Error(data?.message && data.message !== data.error ? data.message : describeError(data?.error, response.status))
    error.status = response.status
    throw error
  }
  return data
}

function describeError(code, status) {
  return ({
    unauthorized: t('登录已过期，请重新登录。'),
    read_only: t('审计员只能查看，不能修改。'),
    invalid_profile: t('场景包配置有误。'),
    profile_not_found: t('这个场景包不存在。'),
    user_not_found: t('这个成员不存在。'),
    invalid_name: t('请填写姓名。'),
    invalid_email: t('邮箱格式不正确，例如 name@example.com。'),
    email_taken: t('这个邮箱已经有成员在用了。'),
    parent_not_found: t('上级部门不存在。'),
    upstream_in_use: t('还有模型使用这个上游，先修改或删除这些模型。'),
    upstream_not_found: t('上游不存在。'),
    invalid_base_url: t('接口地址不正确，应以 http:// 或 https:// 开头。'),
    invalid_model_id: t('模型 ID 只能包含字母、数字和 . _ : / @ -。'),
    invalid_price: t('价格要填 0 或正数。'),
    invalid_amount: t('上限要大于 0。'),
    invalid_scope_id: t('请选择部门或成员。'),
    invalid_fallback_model: t('请选择用完后改用的模型。'),
    builtin_upstream: t('默认上游在服务端的 .env 里设置，不能在这里修改。'),
    invalid_url: t('地址不正确，应以 http:// 或 https:// 开头。'),
    source_exists: t('这个来源已经添加过了。'),
    source_not_found: t('这个来源不存在。'),
    index_unreachable: t('读取索引失败，请检查地址和服务端的网络。'),
    invalid_index: t('这个地址返回的不是 DSH 插件索引（format 1）。'),
    plugin_not_in_source: t('来源里已经没有这个插件，请先刷新来源。'),
    version_not_in_source: t('来源里没有这个版本，请先刷新来源。'),
    invalid_plugin_name: t('包名不正确，例如 my-plugin 或 @team/my-plugin。'),
    invalid_plugin_version: t('请填写精确版本号（如 1.2.0）；Git 来源要填 https 仓库地址和 40 位提交哈希。'),
    invalid_homepage: t('主页地址应以 http:// 或 https:// 开头。'),
    plugin_not_found: t('这个插件不在市场里。'),
    invalid_title: t('请填写名称。'),
    invalid_distribution: t('请选择下发方式。'),
    invalid_skill: t('Skill 内容有误。'),
    skill_not_found: t('这个 Skill 不存在。'),
  })[code] ?? tf('请求失败（HTTP {status}）', { status })
}

export const ROLE_LABEL = { member: lang === 'en' ? 'Member' : '成员', admin: t('管理员'), auditor: t('审计员'), bootstrap: t('初始管理员') }

/**
 * One device's place in the rollout. "Up to date" is decided by the server per
 * device: it holds what its person should have now. A change for someone else
 * does not put this device behind.
 */
export function deviceState(device) {
  if (device.status !== 'active') return 'revoked'
  if (device.mode === 'personal') return 'personal'
  if (device.applied_result === 'failed' || device.applied_result === 'partial') return 'attention'
  if (Date.now() - device.last_seen_at > 3 * 86_400_000) return 'offline'
  if (device.in_sync === true && device.applied_result === 'applied') return 'current'
  return 'pending'
}

export const DEVICE_STATE = {
  current: { label: t('已生效'), tone: 'ok', segment: 'seg-ok' },
  pending: { label: t('等待同步'), tone: 'accent', segment: 'seg-wait' },
  attention: { label: t('需要处理'), tone: 'bad', segment: 'seg-bad' },
  offline: { label: t('超过 3 天未上线'), tone: '', segment: 'seg-idle' },
  revoked: { label: t('已吊销'), tone: '', segment: '' },
  personal: { label: t('员工改用了个人模式'), tone: '', segment: 'seg-idle' },
}

const ACTIONS = {
  'login.succeeded': t('登录了 DSH Desktop Pro'),
  'login.refused': t('登录被拒绝'),
  'logout': t('退出了登录'),
  'console.login': t('登录了控制台'),
  'device.enrolled': t('注册了一台设备'),
  'device.revoked': t('吊销了设备'),
  'desired-state.served': t('设备拉取了新配置'),
  'desired-state.applied': t('设备已应用配置'),
  'desired-state.partial': t('设备部分应用了配置'),
  'desired-state.failed': t('设备应用配置失败'),
  'gateway.key.issued': t('签发了网关 Key'),
  'gateway.key.revoked': t('吊销了网关 Key'),
  'user.created': t('添加了成员'),
  'user.updated': t('修改了成员'),
  'user.provisioned': t('首次登录时自动创建了成员'),
  'users.imported': t('导入了成员'),
  'department.created': t('新建了部门'),
  'profile.created': t('新建了场景包'),
  'profile.updated': t('保存了场景包新版本'),
  'profile.rolled-back': t('回滚了场景包'),
  'binding.created': t('分配了场景包'),
  'binding.deleted': t('取消了场景包分配'),
  'client.tool.denied': t('工具调用被策略拦截'),
  'client.mode.personal': t('改用了个人模式'),
  'catalog.upstream.created': t('添加了上游'),
  'catalog.upstream.updated': t('修改了上游'),
  'catalog.upstream.deleted': t('删除了上游'),
  'catalog.model.saved': t('保存了模型'),
  'catalog.model.deleted': t('删除了模型'),
  'quota.created': t('新建了额度'),
  'quota.updated': t('修改了额度'),
  'quota.deleted': t('删除了额度'),
  'usage.exported': t('导出了用量明细'),
  'market.source.added': t('添加了插件来源'),
  'market.source.removed': t('删除了插件来源'),
  'market.plugin.approved': t('上架了插件'),
  'market.plugin.updated': t('修改了插件推荐'),
  'market.plugin.removed': t('下架了插件'),
  'market.plugin.blocked': t('禁用了插件'),
  'market.plugin.unblocked': t('解除了插件禁用'),
  'skill.created': t('新建了 Skill'),
  'skill.updated': t('修改了 Skill'),
  'skill.deleted': t('删除了 Skill'),
  'skill.installed': t('安装了公司 Skill'),
  'skill.removed': t('移除了公司 Skill'),
}

export function actionLabel(action) {
  return ACTIONS[action] ?? action
}

export function actionTone(action) {
  if (/refused|failed|revoked|denied|blocked/.test(action)) return 'bad'
  if (/partial/.test(action)) return 'warn'
  if (/applied|succeeded|enrolled|issued/.test(action)) return 'ok'
  return ''
}

/** The action groups the audit filter offers. */
export const ACTION_GROUPS = [
  ['', t('全部动作')],
  ['login', t('登录')],
  ['device', t('设备')],
  ['desired-state', t('配置下发')],
  ['profile', t('场景包')],
  ['binding', t('分配')],
  ['user', t('成员')],
  ['gateway', t('网关 Key')],
  ['catalog', t('模型目录')],
  ['quota', t('额度')],
  ['usage', t('用量导出')],
  ['market', t('插件市场')],
  ['skill', t('Skill 库')],
  ['client', t('员工端事件')],
  ['console', t('控制台')],
]
