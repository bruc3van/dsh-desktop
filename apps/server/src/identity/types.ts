/**
 * Identity sources (ADR-0008): every way people sign in, and the one upstream
 * directory people come from, behind two small interfaces. The rest of the
 * server only sees the normalised shapes below.
 * @module @dsh-desktop-pro/server/identity/types
 */

/** Who the provider says signed in. */
export interface SignedInIdentity {
  /** The provider's name, also the `external_identities.provider` key. */
  provider: string
  /** The provider's immutable ID for the person; for a directory source, the same ID the directory uses. */
  subject: string
  name: string
  email?: string
  /** Whether the provider vouches that the person controls the e-mail. */
  emailVerified: boolean
  /**
   * People of a directory source come only from its directory: their sign-in
   * is matched by subject alone — never by e-mail, never provisioned.
   */
  directoryBound: boolean
}

export interface AuthorizeInput {
  /** Echoed back by the provider; the server's sign-in flow ID. */
  state: string
  nonce: string
  /** PKCE S256 challenge; providers without PKCE ignore it. */
  challenge: string
  redirectUri: string
}

export interface CompleteInput {
  nonce: string
  verifier: string
  redirectUri: string
}

/** One way to sign in through an external provider. */
export interface SignInConnector {
  /** URL segment and provider key: `oidc`, `feishu`, `dingtalk`, `wecom`. */
  readonly id: string
  readonly label: { zh: string; en: string }
  authorizeUrl(input: AuthorizeInput): Promise<string>
  /** The provider's redirect came back with these query parameters. */
  complete(params: URLSearchParams, input: CompleteInput): Promise<SignedInIdentity>
}

/** A department as the directory has it; IDs are the directory's own. */
export interface DirectoryDepartment {
  externalId: string
  name: string
  /** `null` for a top-level department. */
  parentExternalId: string | null
}

/** A person as the directory has it. Shaped like a SCIM User: externalId, active. */
export interface DirectoryUser {
  externalId: string
  name: string
  /** For display and notices; never used to identify the person. */
  email: string | null
  /** Still a member: not resigned, not frozen or disabled. */
  active: boolean
  /** Primary department; `null` when none or outside the app's visible range. */
  departmentExternalId: string | null
}

export interface DirectorySnapshot {
  departments: DirectoryDepartment[]
  users: DirectoryUser[]
}

/** Reads the whole directory the app can see. Read-only; the sync engine decides what changes. */
export interface DirectoryConnector {
  readonly source: string
  fetch(): Promise<DirectorySnapshot>
}

/** A provider answered with an error the person or IT can act on. */
export class IdentityError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** A JSON call to a provider API, failing with the provider's own error text. */
export async function callJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit & { what: string }): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    throw new IdentityError('idp_unreachable', init.what + ' is unreachable: ' + (error instanceof Error ? error.message : String(error)), 502)
  }
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new IdentityError('idp_error', init.what + ' answered HTTP ' + String(response.status) + ' with no JSON', 502) }
  if (!response.ok) throw new IdentityError('idp_error', init.what + ' answered HTTP ' + String(response.status) + ': ' + text.slice(0, 300), 502)
  return body as T
}

/** An application access token kept until shortly before it expires. */
export function cachedToken(issue: () => Promise<{ token: string; expiresInSeconds: number }>): () => Promise<string> {
  let current: { token: string; until: number } | undefined
  let pending: Promise<string> | undefined
  return async () => {
    if (current !== undefined && current.until > Date.now()) return current.token
    pending ??= issue().then(({ token, expiresInSeconds }) => {
      current = { token, until: Date.now() + Math.max(60, expiresInSeconds - 120) * 1000 }
      return token
    }).finally(() => { pending = undefined })
    return pending
  }
}
