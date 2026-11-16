/**
 * DingTalk: one internal app for both sign-in and the contact directory.
 *
 * - Sign-in: OAuth 2.0 at `login.dingtalk.com` with `scope=openid corpid`
 *   (no PKCE). The callback carries `authCode`; the user token response names
 *   the organisation the person chose, which must be ours; `contact/users/me`
 *   gives the `unionId`.
 * - Directory: the department tree from the root (`1`) through
 *   `topapi/v2/department/listsub`, then each department's members through
 *   `topapi/v2/user/list`. People who left are simply no longer listed.
 * - The person's key on both sides is the `unionId`.
 * @module @dsh-desktop-pro/server/identity/dingtalk
 */

import { cachedToken, callJson, IdentityError, type DirectoryConnector, type DirectoryDepartment, type DirectoryUser, type SignInConnector } from './types.ts'

export interface DingTalkConfig {
  /** The app's Client ID (AppKey). */
  clientId: string
  clientSecret: string
  /** The organisation's CorpId: sign-ins choosing another organisation are refused. */
  corpId: string
  /** `https://api.dingtalk.com` */
  apiUrl: string
  /** `https://oapi.dingtalk.com` */
  oapiUrl: string
  /** `https://login.dingtalk.com` */
  loginUrl: string
}

const ROOT = '1'

export function createDingTalk(config: DingTalkConfig, fetchImpl: typeof fetch = fetch): { signIn: SignInConnector; directory: DirectoryConnector } {
  const appToken = cachedToken(async () => {
    const body = await callJson<{ accessToken?: string; expireIn?: number }>(fetchImpl, config.apiUrl + '/v1.0/oauth2/accessToken', {
      what: 'DingTalk app token', method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: config.clientId, appSecret: config.clientSecret }),
    })
    if (typeof body.accessToken !== 'string') throw new IdentityError('idp_error', 'DingTalk issued no app token', 502)
    return { token: body.accessToken, expiresInSeconds: body.expireIn ?? 7200 }
  })

  async function topapi<T>(path: string, body: Record<string, unknown>, what: string): Promise<T> {
    const answer = await callJson<{ errcode: number; errmsg?: string; result?: T }>(fetchImpl, config.oapiUrl + path + '?access_token=' + encodeURIComponent(await appToken()), {
      what, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (answer.errcode !== 0 || answer.result === undefined) throw new IdentityError('idp_error', what + ' failed: ' + String(answer.errcode) + ' ' + (answer.errmsg ?? ''), 502)
    return answer.result
  }

  const signIn: SignInConnector = {
    id: 'dingtalk',
    label: { zh: '钉钉', en: 'DingTalk' },
    async authorizeUrl(input) {
      const url = new URL(config.loginUrl + '/oauth2/auth')
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'openid corpid')
      url.searchParams.set('state', input.state)
      url.searchParams.set('prompt', 'consent')
      return url.href
    },
    async complete(params) {
      if (params.get('error') !== null) throw new IdentityError('idp_refused', 'DingTalk did not complete the sign-in: ' + (params.get('error') ?? ''))
      const code = params.get('authCode') ?? params.get('code') ?? ''
      const token = await callJson<{ accessToken?: string; corpId?: string }>(fetchImpl, config.apiUrl + '/v1.0/oauth2/userAccessToken', {
        what: 'DingTalk sign-in', method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret, code, grantType: 'authorization_code' }),
      })
      if (typeof token.accessToken !== 'string') throw new IdentityError('idp_token', 'DingTalk did not issue a token', 502)
      // The person picks an organisation on DingTalk's page; only ours signs in.
      if (token.corpId !== config.corpId) throw new IdentityError('wrong_organization', 'This DingTalk organisation is not the one this server serves', 403)
      const me = await callJson<{ unionId?: string; nick?: string; email?: string }>(fetchImpl, config.apiUrl + '/v1.0/contact/users/me', {
        what: 'DingTalk user info', headers: { 'x-acs-dingtalk-access-token': token.accessToken },
      })
      if (typeof me.unionId !== 'string' || me.unionId === '') throw new IdentityError('idp_token', 'DingTalk returned no unionId', 502)
      return { provider: 'dingtalk', subject: me.unionId, name: me.nick ?? me.unionId, ...me.email ? { email: me.email } : {}, emailVerified: false, directoryBound: true }
    },
  }

  const directory: DirectoryConnector = {
    source: 'dingtalk',
    async fetch() {
      // listsub returns one level; walk the tree breadth first.
      const departments: DirectoryDepartment[] = []
      const queue = [ROOT]
      const seen = new Set(queue)
      while (queue.length > 0) {
        const parent = queue.shift() as string
        const children = await topapi<Array<{ dept_id?: number; name?: string; parent_id?: number }>>('/topapi/v2/department/listsub', { dept_id: Number(parent) }, 'DingTalk departments')
        for (const child of children) {
          if (child.dept_id === undefined) continue
          const id = String(child.dept_id)
          if (seen.has(id)) continue
          seen.add(id)
          queue.push(id)
          departments.push({ externalId: id, name: child.name ?? id, parentExternalId: parent === ROOT ? null : parent })
        }
      }
      const users = new Map<string, DirectoryUser>()
      for (const departmentId of [ROOT, ...departments.map(dep => dep.externalId)]) {
        let cursor = 0
        for (let page = 0; page < 10_000; page += 1) {
          const result = await topapi<{ has_more?: boolean; next_cursor?: number; list?: Array<{ unionid?: string; name?: string; email?: string; org_email?: string; dept_id_list?: number[] }> }>(
            '/topapi/v2/user/list', { dept_id: Number(departmentId), cursor, size: 50 }, 'DingTalk department members')
          for (const member of result.list ?? []) {
            if (typeof member.unionid !== 'string' || users.has(member.unionid)) continue
            const primary = member.dept_id_list?.map(String).find(id => id !== ROOT) ?? null
            users.set(member.unionid, {
              externalId: member.unionid,
              name: member.name ?? member.unionid,
              email: (member.org_email || member.email || '').toLowerCase() || null,
              // Listed means still in the organisation; leaving removes them from the list.
              active: true,
              departmentExternalId: primary,
            })
          }
          if (result.has_more !== true || result.next_cursor === undefined) break
          cursor = result.next_cursor
        }
      }
      return { departments, users: [...users.values()] }
    },
  }

  return { signIn, directory }
}
