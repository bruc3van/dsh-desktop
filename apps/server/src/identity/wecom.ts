/**
 * WeCom (企业微信): one self-built app for both sign-in and the contact
 * directory.
 *
 * - Sign-in: the web login page at `login.work.weixin.qq.com` (CorpApp), then
 *   `auth/getuserinfo` with the app token. Only members of this organisation
 *   get a `userid`; anyone else gets an `openid` and is refused. The callback
 *   domain must be registered in WeCom as a trusted domain.
 * - Directory: `department/list`, then `user/list` per department, within the
 *   app's visible range. Apps created after 2022-06-20 no longer receive
 *   e-mail, which is fine: nobody is identified by it here.
 * - The person's key on both sides is the `userid`.
 * @module @dsh-desktop-pro/server/identity/wecom
 */

import { cachedToken, callJson, IdentityError, type DirectoryConnector, type DirectoryUser, type SignInConnector } from './types.ts'

export interface WeComConfig {
  corpId: string
  agentId: string
  /** The self-built app's Secret. */
  secret: string
  /** `https://qyapi.weixin.qq.com` */
  apiUrl: string
  /** `https://login.work.weixin.qq.com` */
  loginUrl: string
}

interface WeComAnswer { errcode?: number; errmsg?: string }

export function createWeCom(config: WeComConfig, fetchImpl: typeof fetch = fetch): { signIn: SignInConnector; directory: DirectoryConnector } {
  const appToken = cachedToken(async () => {
    const body = await callJson<WeComAnswer & { access_token?: string; expires_in?: number }>(fetchImpl,
      config.apiUrl + '/cgi-bin/gettoken?corpid=' + encodeURIComponent(config.corpId) + '&corpsecret=' + encodeURIComponent(config.secret), { what: 'WeCom app token' })
    if (body.errcode !== 0 || typeof body.access_token !== 'string') throw new IdentityError('idp_error', 'WeCom app token failed: ' + String(body.errcode) + ' ' + (body.errmsg ?? ''), 502)
    return { token: body.access_token, expiresInSeconds: body.expires_in ?? 7200 }
  })

  async function get<T extends WeComAnswer>(path: string, query: Record<string, string>, what: string): Promise<T> {
    const url = new URL(config.apiUrl + path)
    url.searchParams.set('access_token', await appToken())
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const body = await callJson<T>(fetchImpl, url.href, { what })
    if (body.errcode !== 0) throw new IdentityError('idp_error', what + ' failed: ' + String(body.errcode) + ' ' + (body.errmsg ?? ''), 502)
    return body
  }

  const signIn: SignInConnector = {
    id: 'wecom',
    label: { zh: '企业微信', en: 'WeCom' },
    async authorizeUrl(input) {
      const url = new URL(config.loginUrl + '/wwlogin/sso/login')
      url.searchParams.set('login_type', 'CorpApp')
      url.searchParams.set('appid', config.corpId)
      url.searchParams.set('agentid', config.agentId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', input.state)
      return url.href
    },
    async complete(params) {
      const code = params.get('code') ?? ''
      if (code === '') throw new IdentityError('idp_refused', 'WeCom did not complete the sign-in')
      const who = await get<WeComAnswer & { userid?: string; openid?: string }>('/cgi-bin/auth/getuserinfo', { code }, 'WeCom sign-in')
      // Someone outside the organisation gets an openid and no userid.
      if (typeof who.userid !== 'string' || who.userid === '') throw new IdentityError('wrong_organization', 'This WeCom account is not a member of the organisation', 403)
      return { provider: 'wecom', subject: who.userid, name: who.userid, emailVerified: false, directoryBound: true }
    },
  }

  const directory: DirectoryConnector = {
    source: 'wecom',
    async fetch() {
      const list = await get<WeComAnswer & { department?: Array<{ id?: number; name?: string; parentid?: number }> }>('/cgi-bin/department/list', {}, 'WeCom departments')
      const all = (list.department ?? []).filter(dep => dep.id !== undefined)
      const ids = new Set(all.map(dep => String(dep.id)))
      // The organisation itself is the department without a parent in the list; its children are top level here.
      const roots = new Set(all.filter(dep => dep.parentid === undefined || dep.parentid === 0 || !ids.has(String(dep.parentid))).map(dep => String(dep.id)))
      const departments = all.filter(dep => !roots.has(String(dep.id))).map(dep => ({
        externalId: String(dep.id),
        name: dep.name ?? String(dep.id),
        parentExternalId: roots.has(String(dep.parentid)) ? null : String(dep.parentid),
      }))
      const users = new Map<string, DirectoryUser>()
      for (const department of all) {
        const members = await get<WeComAnswer & { userlist?: Array<{ userid?: string; name?: string; email?: string; biz_mail?: string; department?: number[]; main_department?: number; status?: number }> }>(
          '/cgi-bin/user/list', { department_id: String(department.id) }, 'WeCom department members')
        for (const member of members.userlist ?? []) {
          if (typeof member.userid !== 'string' || users.has(member.userid)) continue
          const primary = member.main_department ?? member.department?.[0]
          users.set(member.userid, {
            externalId: member.userid,
            name: member.name ?? member.userid,
            email: (member.biz_mail || member.email || '').toLowerCase() || null,
            // 1 active, 4 not yet activated: members. 2 disabled, 5 left: not.
            active: member.status !== 2 && member.status !== 5,
            departmentExternalId: primary === undefined || roots.has(String(primary)) ? null : String(primary),
          })
        }
      }
      return { departments, users: [...users.values()] }
    },
  }

  return { signIn, directory }
}
