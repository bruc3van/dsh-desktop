/**
 * Feishu (and Lark, with other base URLs): one self-built app for both
 * sign-in and the contact directory.
 *
 * - Sign-in: OAuth 2.0 with PKCE at `accounts.feishu.cn`, then
 *   `authen/v1/user_info`. Feishu issues no ID token, so this is not OIDC.
 * - Directory: contact v3 with the app's tenant token — the department tree
 *   from the root (`0`), then each department's direct members.
 * - The person's key on both sides is `union_id`: stable across the
 *   organisation's own apps and needing no extra permission. Feishu documents
 *   e-mail and mobile as admin-entered and unverified, so they never identify
 *   anyone here.
 * @module @dsh-desktop-pro/server/identity/feishu
 */

import { cachedToken, callJson, IdentityError, type DirectoryConnector, type DirectoryUser, type SignInConnector } from './types.ts'

export interface FeishuConfig {
  appId: string
  appSecret: string
  /** `https://open.feishu.cn`; Lark: `https://open.larksuite.com`. */
  apiUrl: string
  /** `https://accounts.feishu.cn`; Lark: `https://accounts.larksuite.com`. */
  accountsUrl: string
}

interface FeishuEnvelope<T> { code: number; msg?: string; data?: T }

function ok<T>(what: string, body: FeishuEnvelope<T>): T {
  if (body.code !== 0 || body.data === undefined) throw new IdentityError('idp_error', what + ' failed: ' + String(body.code) + ' ' + (body.msg ?? ''), 502)
  return body.data
}

export function createFeishu(config: FeishuConfig, fetchImpl: typeof fetch = fetch): { signIn: SignInConnector; directory: DirectoryConnector } {
  const tenantToken = cachedToken(async () => {
    const body = await callJson<{ code: number; msg?: string; tenant_access_token?: string; expire?: number }>(fetchImpl, config.apiUrl + '/open-apis/auth/v3/tenant_access_token/internal', {
      what: 'Feishu tenant token', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    })
    if (body.code !== 0 || typeof body.tenant_access_token !== 'string') throw new IdentityError('idp_error', 'Feishu tenant token failed: ' + String(body.code) + ' ' + (body.msg ?? ''), 502)
    return { token: body.tenant_access_token, expiresInSeconds: body.expire ?? 7200 }
  })

  async function get<T>(path: string, query: Record<string, string>, what: string): Promise<T> {
    const url = new URL(config.apiUrl + path)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return ok(what, await callJson<FeishuEnvelope<T>>(fetchImpl, url.href, { what, headers: { authorization: 'Bearer ' + await tenantToken() } }))
  }

  /** Every page of a paged contact v3 list. */
  async function all<T>(path: string, query: Record<string, string>, what: string): Promise<T[]> {
    const items: T[] = []
    let pageToken = ''
    for (let page = 0; page < 10_000; page += 1) {
      const data = await get<{ items?: T[]; has_more?: boolean; page_token?: string }>(path, { ...query, page_size: '50', ...pageToken !== '' && { page_token: pageToken } }, what)
      items.push(...data.items ?? [])
      if (data.has_more !== true || data.page_token === undefined || data.page_token === '') return items
      pageToken = data.page_token
    }
    throw new IdentityError('idp_error', what + ' did not stop paging', 502)
  }

  const signIn: SignInConnector = {
    id: 'feishu',
    label: { zh: '飞书', en: 'Feishu' },
    async authorizeUrl(input) {
      const url = new URL(config.accountsUrl + '/open-apis/authen/v1/authorize')
      url.searchParams.set('client_id', config.appId)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.href
    },
    async complete(params, input) {
      if (params.get('error') !== null) throw new IdentityError('idp_refused', 'Feishu did not complete the sign-in: ' + (params.get('error') ?? ''))
      const token = await callJson<{ code: number; access_token?: string; error?: string; error_description?: string }>(fetchImpl, config.apiUrl + '/open-apis/authen/v2/oauth/token', {
        what: 'Feishu sign-in', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.appId, client_secret: config.appSecret, code: params.get('code') ?? '', redirect_uri: input.redirectUri, code_verifier: input.verifier }),
      })
      if (token.code !== 0 || typeof token.access_token !== 'string') throw new IdentityError('idp_token', 'Feishu did not issue a token: ' + (token.error_description ?? token.error ?? String(token.code)), 502)
      const info = ok('Feishu user info', await callJson<FeishuEnvelope<{ union_id?: string; name?: string; email?: string; enterprise_email?: string }>>(
        fetchImpl, config.apiUrl + '/open-apis/authen/v1/user_info', { what: 'Feishu user info', headers: { authorization: 'Bearer ' + token.access_token } }))
      if (typeof info.union_id !== 'string' || info.union_id === '') throw new IdentityError('idp_token', 'Feishu returned no union_id', 502)
      const email = info.enterprise_email || info.email
      return { provider: 'feishu', subject: info.union_id, name: info.name ?? info.union_id, ...email ? { email } : {}, emailVerified: false, directoryBound: true }
    },
  }

  const directory: DirectoryConnector = {
    source: 'feishu',
    async fetch() {
      const departments = await all<{ open_department_id?: string; name?: string; parent_department_id?: string; status?: { is_deleted?: boolean } }>(
        '/open-apis/contact/v3/departments/0/children', { fetch_child: 'true', department_id_type: 'open_department_id' }, 'Feishu departments')
      const live = departments.filter(dep => typeof dep.open_department_id === 'string' && dep.status?.is_deleted !== true)
      const users = new Map<string, DirectoryUser>()
      // The root (0) holds people outside any department; each department lists its direct members.
      for (const departmentId of ['0', ...live.map(dep => dep.open_department_id as string)]) {
        const members = await all<{ union_id?: string; name?: string; email?: string; enterprise_email?: string; department_ids?: string[]; status?: { is_resigned?: boolean; is_frozen?: boolean; is_exited?: boolean } }>(
          '/open-apis/contact/v3/users/find_by_department', { department_id: departmentId, department_id_type: 'open_department_id', user_id_type: 'union_id' }, 'Feishu department members')
        for (const member of members) {
          if (typeof member.union_id !== 'string' || users.has(member.union_id)) continue
          users.set(member.union_id, {
            externalId: member.union_id,
            name: member.name ?? member.union_id,
            email: (member.enterprise_email || member.email || '').toLowerCase() || null,
            active: member.status?.is_resigned !== true && member.status?.is_frozen !== true && member.status?.is_exited !== true,
            departmentExternalId: member.department_ids?.find(id => id !== '0') ?? null,
          })
        }
      }
      return {
        departments: live.map(dep => ({
          externalId: dep.open_department_id as string,
          name: dep.name ?? (dep.open_department_id as string),
          parentExternalId: dep.parent_department_id === undefined || dep.parent_department_id === '0' ? null : dep.parent_department_id,
        })),
        users: [...users.values()],
      }
    },
  }

  return { signIn, directory }
}
