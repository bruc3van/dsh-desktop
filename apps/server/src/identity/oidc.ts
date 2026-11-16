/**
 * Any standard OpenID Connect provider (Entra ID, Okta, Keycloak, Authing…):
 * discovery, PKCE, and an ID token verified against the provider's keys.
 *
 * An e-mail identifies someone only when the provider marks it verified, or
 * when the deployment says the provider can be trusted with it.
 * @module @dsh-desktop-pro/server/identity/oidc
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { OidcConfig } from '../config.ts'
import { callJson, IdentityError, type SignInConnector } from './types.ts'

interface Metadata { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }

export function createOidc(config: OidcConfig, fetchImpl: typeof fetch = fetch): SignInConnector {
  let metadata: Promise<Metadata> | undefined
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  function discover(): Promise<Metadata> {
    metadata ??= callJson<Metadata>(fetchImpl, config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', { what: 'OIDC discovery' })
      .catch((error: unknown) => { metadata = undefined; throw error })
    return metadata
  }

  return {
    id: 'oidc',
    label: { zh: config.label, en: config.label },
    async authorizeUrl(input) {
      const url = new URL((await discover()).authorization_endpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('scope', config.scopes)
      url.searchParams.set('state', input.state)
      url.searchParams.set('nonce', input.nonce)
      url.searchParams.set('code_challenge', input.challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.href
    },
    async complete(params, input) {
      if (params.get('error') !== null) throw new IdentityError('idp_refused', 'The identity provider refused the sign-in: ' + (params.get('error_description') ?? params.get('error') ?? ''))
      const found = await discover()
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: params.get('code') ?? '', redirect_uri: input.redirectUri,
        client_id: config.clientId, code_verifier: input.verifier,
        ...config.clientSecret !== undefined && { client_secret: config.clientSecret },
      })
      let response: Response
      try {
        response = await fetchImpl(found.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) })
      } catch (error) {
        throw new IdentityError('idp_unreachable', 'The identity provider is unreachable: ' + (error instanceof Error ? error.message : String(error)), 502)
      }
      if (!response.ok) throw new IdentityError('idp_token', 'The identity provider did not issue a token (HTTP ' + String(response.status) + ')', 502)
      const tokens = await response.json() as { id_token?: string }
      if (typeof tokens.id_token !== 'string') throw new IdentityError('idp_token', 'The identity provider returned no ID token', 502)
      jwks ??= createRemoteJWKSet(new URL(found.jwks_uri))
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: found.issuer, audience: config.clientId })
      if (payload['nonce'] !== input.nonce) throw new IdentityError('idp_nonce', 'The sign-in answer does not belong to this sign-in')
      const subject = String(payload.sub ?? '')
      const email = typeof payload['email'] === 'string' ? payload['email'] : undefined
      const emailVerified = payload['email_verified'] === true || payload['email_verified'] === 'true' || config.trustEmail
      const name = typeof payload['name'] === 'string' ? payload['name'] : email ?? subject
      return { provider: 'oidc', subject, name, ...email !== undefined && { email }, emailVerified, directoryBound: false }
    },
  }
}
