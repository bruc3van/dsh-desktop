/**
 * Server configuration from the environment. Everything has a safe default
 * except what identifies the deployment: its public URL and a server secret.
 * @module @dsh-desktop-pro/server/config
 */

export interface GatewayConfig {
  /**
   * `litellm`: an external LiteLLM issues and revokes personal keys.
   * `direct`: the server itself is the gateway — personal keys it issues are
   * checked here and requests are forwarded to one OpenAI-compatible upstream
   * whose key never leaves the server.
   */
  kind: 'none' | 'litellm' | 'direct'
  url?: string
  masterKey?: string
  /** `direct`: the upstream OpenAI-compatible base URL (…/v1) and its key. */
  upstreamUrl?: string
  upstreamKey?: string
  /** Credential reference name the issued key is delivered under. */
  credential: string
  /** Lifetime of an issued key, LiteLLM duration syntax. */
  duration: string
  /** Optional per-person budget in USD. */
  maxBudget?: number
  /** `direct`: requests one person may have running at once. */
  maxConcurrent: number
}

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  scopes: string
  label: string
  /**
   * Match people by an e-mail the provider does not mark as verified. Only
   * for providers that never send `email_verified` and only let their own
   * administrators set addresses.
   */
  trustEmail: boolean
}

export interface ServerConfig {
  port: number
  host: string
  /** Origin clients and browsers use, e.g. https://dsh.example.com */
  publicUrl: string
  /** 32+ random bytes; encrypts stored secrets and derives cookie keys. */
  secret: string
  databaseUrl: string
  tenant: { id: string; name: string }
  /** Console access before any administrator exists; rotate after first use. */
  bootstrapToken?: string
  devLogin: boolean
  oidc?: OidcConfig
  /** Create a member on first sign-in instead of requiring an import. */
  autoProvision: boolean
  gateway: GatewayConfig
  accessTokenSeconds: number
  refreshTokenDays: number
  consoleDir?: string
  /** IANA time zone that days, weeks and months of usage and limits follow. */
  timeZone: string
  /** How long records are kept; see retention.ts. */
  retention: { requestDays: number; auditDays: number }
}

function days(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('retention days must be 0 (keep) or a positive number: ' + value)
  return Math.floor(parsed)
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value === '') throw new Error(name + ' is required')
  return value
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicUrl = new URL(required(env, 'DSH_PUBLIC_URL')).origin
  const secret = required(env, 'DSH_SERVER_SECRET')
  if (Buffer.byteLength(secret) < 32) throw new Error('DSH_SERVER_SECRET must be at least 32 characters')
  const gatewayKind = env['DSH_GATEWAY'] ?? 'direct'
  if (gatewayKind !== 'none' && gatewayKind !== 'litellm' && gatewayKind !== 'direct') throw new Error('DSH_GATEWAY must be none, direct or litellm')
  const gateway: GatewayConfig = {
    kind: gatewayKind,
    credential: env['DSH_GATEWAY_CREDENTIAL'] ?? 'DSH_ORG_GATEWAY_KEY',
    duration: env['DSH_GATEWAY_KEY_DURATION'] ?? '30d',
    maxConcurrent: Math.max(1, Math.floor(Number(env['DSH_GATEWAY_MAX_CONCURRENT'] ?? 8)) || 8),
  }
  if (gatewayKind === 'litellm') {
    gateway.url = new URL(required(env, 'LITELLM_URL')).href.replace(/\/$/, '')
    gateway.masterKey = required(env, 'LITELLM_MASTER_KEY')
    if (env['DSH_GATEWAY_MAX_BUDGET'] !== undefined) gateway.maxBudget = Number(env['DSH_GATEWAY_MAX_BUDGET'])
  }
  if (gatewayKind === 'direct') {
    // Optional: upstreams can also be added in the console's model catalog.
    const upstream = env['DSH_UPSTREAM_URL']?.trim()
    if (upstream !== undefined && upstream !== '') {
      gateway.upstreamUrl = new URL(upstream).href.replace(/\/$/, '')
      gateway.upstreamKey = required(env, 'DSH_UPSTREAM_KEY')
    }
  }
  const timeZone = env['DSH_TIMEZONE']?.trim() || 'Asia/Shanghai'
  try { new Intl.DateTimeFormat('en-US', { timeZone }) } catch { throw new Error('DSH_TIMEZONE is not a valid IANA time zone: ' + timeZone) }
  const config: ServerConfig = {
    port: Number(env['PORT'] ?? 8080),
    host: env['HOST'] ?? '0.0.0.0',
    publicUrl,
    secret,
    databaseUrl: env['DATABASE_URL'] ?? 'sqlite:./data/dsh-server.sqlite',
    tenant: { id: env['DSH_TENANT_ID'] ?? 'default', name: env['DSH_TENANT_NAME'] ?? 'My Organisation' },
    devLogin: flag(env['DSH_DEV_LOGIN']),
    autoProvision: flag(env['DSH_AUTO_PROVISION']),
    gateway,
    accessTokenSeconds: Number(env['DSH_ACCESS_TOKEN_SECONDS'] ?? 3600),
    refreshTokenDays: Number(env['DSH_REFRESH_TOKEN_DAYS'] ?? 30),
    timeZone,
    retention: { requestDays: days(env['DSH_REQUEST_RETENTION_DAYS'], 400), auditDays: days(env['DSH_AUDIT_RETENTION_DAYS'], 0) },
  }
  if (env['DSH_BOOTSTRAP_TOKEN'] !== undefined && env['DSH_BOOTSTRAP_TOKEN'] !== '') config.bootstrapToken = env['DSH_BOOTSTRAP_TOKEN']
  if (env['OIDC_ISSUER'] !== undefined && env['OIDC_ISSUER'] !== '') {
    config.oidc = {
      issuer: env['OIDC_ISSUER'],
      clientId: required(env, 'OIDC_CLIENT_ID'),
      scopes: env['OIDC_SCOPES'] ?? 'openid profile email',
      label: env['OIDC_LABEL'] ?? 'SSO',
      trustEmail: flag(env['OIDC_TRUST_EMAIL']),
      ...env['OIDC_CLIENT_SECRET'] !== undefined && { clientSecret: env['OIDC_CLIENT_SECRET'] },
    }
  }
  if (env['DSH_CONSOLE_DIR'] !== undefined) config.consoleDir = env['DSH_CONSOLE_DIR']
  if (!config.devLogin && config.oidc === undefined) throw new Error('configure OIDC_ISSUER (or DSH_DEV_LOGIN=1 for evaluation)')
  return config
}
