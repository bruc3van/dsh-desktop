/**
 * Server configuration from the environment. Everything has a safe default
 * except what identifies the deployment: its public URL and a server secret.
 * @module @dsh-desktop-pro/server/config
 */

import type { DingTalkConfig } from './identity/dingtalk.ts'
import type { FeishuConfig } from './identity/feishu.ts'
import type { DirectorySyncConfig } from './identity/sync.ts'
import type { WeComConfig } from './identity/wecom.ts'

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

/**
 * The organisation's upstream directory (ADR-0008): one of Feishu, DingTalk or
 * WeCom. It is also a sign-in method, and the only place its people come from.
 */
export type DirectoryConfig =
  | { kind: 'feishu'; feishu: FeishuConfig }
  | { kind: 'dingtalk'; dingtalk: DingTalkConfig }
  | { kind: 'wecom'; wecom: WeComConfig }

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
  directory?: DirectoryConfig
  directorySync: DirectorySyncConfig
}

function directoryFrom(env: NodeJS.ProcessEnv): DirectoryConfig | undefined {
  const kind = env['DSH_DIRECTORY']?.trim() ?? ''
  if (kind === '' || kind === 'none') return undefined
  // Base URLs are settable for Lark (international Feishu) and for tests.
  const base = (name: string, fallback: string): string => new URL(env[name]?.trim() || fallback).origin
  if (kind === 'feishu') {
    return { kind, feishu: {
      appId: required(env, 'FEISHU_APP_ID'), appSecret: required(env, 'FEISHU_APP_SECRET'),
      apiUrl: base('FEISHU_API_URL', 'https://open.feishu.cn'), accountsUrl: base('FEISHU_ACCOUNTS_URL', 'https://accounts.feishu.cn'),
    } }
  }
  if (kind === 'dingtalk') {
    return { kind, dingtalk: {
      clientId: required(env, 'DINGTALK_CLIENT_ID'), clientSecret: required(env, 'DINGTALK_CLIENT_SECRET'), corpId: required(env, 'DINGTALK_CORP_ID'),
      apiUrl: base('DINGTALK_API_URL', 'https://api.dingtalk.com'), oapiUrl: base('DINGTALK_OAPI_URL', 'https://oapi.dingtalk.com'), loginUrl: base('DINGTALK_LOGIN_URL', 'https://login.dingtalk.com'),
    } }
  }
  if (kind === 'wecom') {
    return { kind, wecom: {
      corpId: required(env, 'WECOM_CORP_ID'), agentId: required(env, 'WECOM_AGENT_ID'), secret: required(env, 'WECOM_SECRET'),
      apiUrl: base('WECOM_API_URL', 'https://qyapi.weixin.qq.com'), loginUrl: base('WECOM_LOGIN_URL', 'https://login.work.weixin.qq.com'),
    } }
  }
  throw new Error('DSH_DIRECTORY must be feishu, dingtalk, wecom or empty')
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
    directorySync: {
      intervalMinutes: Math.max(1, days(env['DSH_DIRECTORY_SYNC_MINUTES'], 15)),
      maxDisablePercent: Math.min(100, days(env['DSH_DIRECTORY_MAX_DISABLE_PERCENT'], 20)),
    },
  }
  const directory = directoryFrom(env)
  if (directory !== undefined) config.directory = directory
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
  if (!config.devLogin && config.oidc === undefined && config.directory === undefined) throw new Error('configure a sign-in: DSH_DIRECTORY (feishu, dingtalk, wecom), OIDC_ISSUER, or DSH_DEV_LOGIN=1 for evaluation')
  return config
}
