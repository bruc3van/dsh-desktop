/**
 * The desired-state document: everything an organisation decides about one
 * person's DSH environment, in one versioned JSON document.
 *
 * The same document arrives from two sources and the client applies it with
 * one reconciler: a file an administrator places on the machine (file mode),
 * or the management server (server mode). The server composes it from the
 * profiles bound to the person and signs it; a file may be signed too.
 *
 * What it can express is bounded on purpose. Hard limits (model allow-lists,
 * budgets, content audit) belong to the model gateway the credentials point
 * at; this document only configures the desktop client and its DSH profile,
 * which a determined user on their own machine can always change.
 * @module @dsh-desktop-pro/protocol/desired-state
 */

import {
  array, asResult, boolean, fail, httpUrl, integer, isoTimestamp, onlyKeys, optionalBoolean, optionalString, record,
  string, stringArray, type Result,
} from './validation.ts'

export const DESIRED_STATE_SCHEMA = 'dsh-desktop-pro/desired-state'
export const DESIRED_STATE_VERSION = 1

/** Wire protocols a gateway route can speak (the pi-ai adapter's `api`). */
export const MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ModelApi = typeof MODEL_APIS[number]

export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** One gateway route in the DSH model picker. */
export interface ModelRoute {
  displayName?: string
  api: ModelApi
  baseURL: string
  /** Name of an entry in `credentials`; the route reads it per request. */
  credential?: string
  models: ModelEntry[]
}

export interface RequiredPlugin {
  /** Package name as the profile lists it. */
  name: string
  /** Exact install target: `name@1.2.3`, or a Git/tarball URL pinned to one revision. */
  spec: string
}

export interface ManagedSkill {
  /** Directory name under `<DSH_HOME>/skills`. */
  name: string
  /** Relative path → UTF-8 content. Must include `SKILL.md`. */
  files: Record<string, string>
}

export interface DesiredState {
  schema: typeof DESIRED_STATE_SCHEMA
  version: typeof DESIRED_STATE_VERSION
  /** Monotonic per organisation and person; a client never goes back to a lower one. */
  revision: number
  issuedAt: string
  /** After this instant a cached copy is no longer used offline. */
  expiresAt?: string
  organization: { id: string; name: string }
  /** The profile versions that produced this document, echoed in status reports. */
  source?: { profiles: Array<{ id: string; version: number }> }
  models?: {
    providers: Record<string, ModelRoute>
    /** The model new sessions start with; must name one of `providers`. */
    default?: { provider: string; model: string }
  }
  /** Credential values by reference name, stored in the DSH credential file. */
  credentials?: Record<string, string>
  plugins?: {
    /** Plugin index sources the Discover page lists. */
    indexes?: string[]
    /** npm registry for plugin installation; `fallbackRegistries` are tried in order. */
    registry?: string
    fallbackRegistries?: string[]
    required?: RequiredPlugin[]
    /** Package names removed from the profile and never installed by the client. */
    blocked?: string[]
  }
  skills?: ManagedSkill[]
  /** Tool names refused before dispatch, for every agent in the profile. */
  tools?: { deny?: string[]; message?: string }
  updates?: {
    /** Replaces the public update feed, for an intranet mirror. */
    feedUrl?: string
    autoCheck?: boolean
  }
  offline?: {
    /** Days a cached document keeps working without reaching the server. */
    graceDays?: number
  }
  /** The device was revoked: remove the managed configuration and sign out. */
  wipe?: boolean
  /**
   * File mode: let the person switch this machine to personal mode. Server
   * mode decides this in the enrollment file instead, before anyone signs in.
   */
  allowPersonal?: boolean
}

const PROVIDER_KEY = /^[a-z][a-z0-9-]{0,62}$/
export const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MODEL_ID = /^[\w./:@+-]{1,200}$/
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const ID = /^[\w.-]{1,128}$/

/** A relative, forward-slash path inside a skill directory. */
function skillPath(value: string, path: string): string {
  if (value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail(path, 'must be a relative path inside the skill')
  }
  if (!/^[\w./ -]{1,200}$/.test(value)) fail(path, 'contains unsupported characters')
  return value
}

/** Install targets the client is willing to run: an exact npm version or a pinned Git/tarball URL. */
function pluginSpec(name: string, value: unknown, path: string): string {
  const spec = string(value, path, { max: 1024 })
  if (spec.startsWith(name + '@')) {
    const version = spec.slice(name.length + 1)
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) fail(path, 'must pin an exact version')
    return spec
  }
  if (/^git\+https:\/\/[^#\s]+#[0-9a-f]{40}(?:&path:\/[^\s]+)?$/.test(spec)) return spec
  if (/^https:\/\/\S+\.tgz$/.test(spec)) return spec
  fail(path, 'must be name@exact-version, git+https://…#<40-hex commit>, or an https .tgz')
}

function modelRoute(value: unknown, path: string): ModelRoute {
  const route = record(value, path)
  onlyKeys(route, path, ['displayName', 'api', 'baseURL', 'credential', 'models'])
  const api = string(route['api'], path + '.api')
  if (!(MODEL_APIS as readonly string[]).includes(api)) fail(path + '.api', 'must be one of ' + MODEL_APIS.join(', '))
  // A reference the document does not carry is allowed: the person may have
  // saved that credential themselves. Only its shape is checked.
  const credential = optionalString(route['credential'], path + '.credential', { pattern: CREDENTIAL_NAME })
  const models = array(route['models'], path + '.models', 200).map((item, index) => {
    const at = path + '.models[' + String(index) + ']'
    const model = record(item, at)
    onlyKeys(model, at, ['id', 'name', 'contextWindow', 'maxTokens'])
    const entry: ModelEntry = { id: string(model['id'], at + '.id', { pattern: MODEL_ID }) }
    const name = optionalString(model['name'], at + '.name', { max: 200 })
    if (name !== undefined) entry.name = name
    if (model['contextWindow'] !== undefined) entry.contextWindow = integer(model['contextWindow'], at + '.contextWindow', 1, 100_000_000)
    if (model['maxTokens'] !== undefined) entry.maxTokens = integer(model['maxTokens'], at + '.maxTokens', 1, 100_000_000)
    return entry
  })
  if (models.length === 0) fail(path + '.models', 'must list at least one model')
  const result: ModelRoute = { api: api as ModelApi, baseURL: httpUrl(route['baseURL'], path + '.baseURL'), models }
  const displayName = optionalString(route['displayName'], path + '.displayName', { max: 120 })
  if (displayName !== undefined) result.displayName = displayName
  if (credential !== undefined) result.credential = credential
  return result
}

function parse(value: unknown): DesiredState {
  const doc = record(value, '$')
  onlyKeys(doc, '$', ['schema', 'version', 'revision', 'issuedAt', 'expiresAt', 'organization', 'source', 'models',
    'credentials', 'plugins', 'skills', 'tools', 'updates', 'offline', 'wipe', 'allowPersonal'])
  if (doc['schema'] !== DESIRED_STATE_SCHEMA) fail('$.schema', 'must be ' + DESIRED_STATE_SCHEMA)
  if (doc['version'] !== DESIRED_STATE_VERSION) fail('$.version', 'unsupported version; update DSH Desktop Pro')
  const organization = record(doc['organization'], '$.organization')
  onlyKeys(organization, '$.organization', ['id', 'name'])
  const state: DesiredState = {
    schema: DESIRED_STATE_SCHEMA,
    version: DESIRED_STATE_VERSION,
    revision: integer(doc['revision'], '$.revision', 0, Number.MAX_SAFE_INTEGER),
    issuedAt: isoTimestamp(doc['issuedAt'], '$.issuedAt'),
    organization: {
      id: string(organization['id'], '$.organization.id', { pattern: ID }),
      name: string(organization['name'], '$.organization.name', { max: 200 }),
    },
  }
  if (doc['expiresAt'] !== undefined) state.expiresAt = isoTimestamp(doc['expiresAt'], '$.expiresAt')
  if (doc['source'] !== undefined) {
    const source = record(doc['source'], '$.source')
    onlyKeys(source, '$.source', ['profiles'])
    state.source = {
      profiles: array(source['profiles'], '$.source.profiles', 100).map((item, index) => {
        const at = '$.source.profiles[' + String(index) + ']'
        const profile = record(item, at)
        onlyKeys(profile, at, ['id', 'version'])
        return { id: string(profile['id'], at + '.id', { pattern: ID }), version: integer(profile['version'], at + '.version', 0, Number.MAX_SAFE_INTEGER) }
      }),
    }
  }
  if (doc['credentials'] !== undefined) {
    const credentials = record(doc['credentials'], '$.credentials')
    const values: Record<string, string> = {}
    for (const [name, secret] of Object.entries(credentials)) {
      const at = '$.credentials.' + name
      if (!CREDENTIAL_NAME.test(name)) fail(at, 'must be an UPPER_SNAKE reference name')
      values[name] = string(secret, at, { max: 8192 })
    }
    state.credentials = values
  }
  if (doc['models'] !== undefined) {
    const models = record(doc['models'], '$.models')
    onlyKeys(models, '$.models', ['providers', 'default'])
    const providers = record(models['providers'], '$.models.providers')
    const routes: Record<string, ModelRoute> = {}
    for (const [key, route] of Object.entries(providers)) {
      if (!PROVIDER_KEY.test(key)) fail('$.models.providers.' + key, 'must be a lowercase hyphenated route key')
      routes[key] = modelRoute(route, '$.models.providers.' + key)
    }
    state.models = { providers: routes }
    if (models['default'] !== undefined) {
      const selection = record(models['default'], '$.models.default')
      onlyKeys(selection, '$.models.default', ['provider', 'model'])
      const provider = string(selection['provider'], '$.models.default.provider', { pattern: PROVIDER_KEY })
      const model = string(selection['model'], '$.models.default.model', { pattern: MODEL_ID })
      if (!routes[provider]?.models.some(entry => entry.id === model)) fail('$.models.default', 'must name a listed provider and model')
      state.models.default = { provider, model }
    }
  }
  if (doc['plugins'] !== undefined) {
    const plugins = record(doc['plugins'], '$.plugins')
    onlyKeys(plugins, '$.plugins', ['indexes', 'registry', 'fallbackRegistries', 'required', 'blocked'])
    state.plugins = {}
    if (plugins['indexes'] !== undefined) {
      state.plugins.indexes = stringArray(plugins['indexes'], '$.plugins.indexes').map((url, index) => httpUrl(url, '$.plugins.indexes[' + String(index) + ']'))
    }
    if (plugins['registry'] !== undefined) state.plugins.registry = httpUrl(plugins['registry'], '$.plugins.registry')
    if (plugins['fallbackRegistries'] !== undefined) {
      state.plugins.fallbackRegistries = stringArray(plugins['fallbackRegistries'], '$.plugins.fallbackRegistries')
        .map((url, index) => httpUrl(url, '$.plugins.fallbackRegistries[' + String(index) + ']'))
    }
    if (plugins['blocked'] !== undefined) state.plugins.blocked = stringArray(plugins['blocked'], '$.plugins.blocked', { pattern: PACKAGE_NAME, max: 214 })
    if (plugins['required'] !== undefined) {
      const names = new Set<string>()
      state.plugins.required = array(plugins['required'], '$.plugins.required', 200).map((item, index) => {
        const at = '$.plugins.required[' + String(index) + ']'
        const plugin = record(item, at)
        onlyKeys(plugin, at, ['name', 'spec'])
        const name = string(plugin['name'], at + '.name', { pattern: PACKAGE_NAME, max: 214 })
        if (names.has(name)) fail(at + '.name', 'is a duplicate')
        if (state.plugins?.blocked?.includes(name) === true) fail(at + '.name', 'is also blocked')
        names.add(name)
        return { name, spec: pluginSpec(name, plugin['spec'], at + '.spec') }
      })
    }
  }
  if (doc['skills'] !== undefined) {
    const names = new Set<string>()
    state.skills = array(doc['skills'], '$.skills', 200).map((item, index) => {
      const at = '$.skills[' + String(index) + ']'
      const skill = record(item, at)
      onlyKeys(skill, at, ['name', 'files'])
      const name = string(skill['name'], at + '.name', { pattern: SKILL_NAME })
      if (names.has(name)) fail(at + '.name', 'is a duplicate')
      names.add(name)
      const files = record(skill['files'], at + '.files')
      const out: Record<string, string> = {}
      let bytes = 0
      for (const [file, content] of Object.entries(files)) {
        skillPath(file, at + '.files.' + file)
        if (typeof content !== 'string') fail(at + '.files.' + file, 'must be text')
        bytes += content.length
        out[file] = content
      }
      if (!Object.hasOwn(out, 'SKILL.md')) fail(at + '.files', 'must include SKILL.md')
      if (bytes > 2_000_000) fail(at + '.files', 'is larger than 2 MB')
      return { name, files: out }
    })
  }
  if (doc['tools'] !== undefined) {
    const tools = record(doc['tools'], '$.tools')
    onlyKeys(tools, '$.tools', ['deny', 'message'])
    state.tools = {}
    if (tools['deny'] !== undefined) state.tools.deny = stringArray(tools['deny'], '$.tools.deny', { pattern: TOOL_NAME })
    const message = optionalString(tools['message'], '$.tools.message', { max: 500 })
    if (message !== undefined) state.tools.message = message
  }
  if (doc['updates'] !== undefined) {
    const updates = record(doc['updates'], '$.updates')
    onlyKeys(updates, '$.updates', ['feedUrl', 'autoCheck'])
    state.updates = {}
    if (updates['feedUrl'] !== undefined) state.updates.feedUrl = httpUrl(updates['feedUrl'], '$.updates.feedUrl')
    const autoCheck = optionalBoolean(updates['autoCheck'], '$.updates.autoCheck')
    if (autoCheck !== undefined) state.updates.autoCheck = autoCheck
  }
  if (doc['offline'] !== undefined) {
    const offline = record(doc['offline'], '$.offline')
    onlyKeys(offline, '$.offline', ['graceDays'])
    state.offline = {}
    if (offline['graceDays'] !== undefined) state.offline.graceDays = integer(offline['graceDays'], '$.offline.graceDays', 0, 365)
  }
  if (doc['wipe'] !== undefined) state.wipe = boolean(doc['wipe'], '$.wipe')
  if (doc['allowPersonal'] !== undefined) state.allowPersonal = boolean(doc['allowPersonal'], '$.allowPersonal')
  return state
}

/** Validate an untrusted document. Unknown fields are refused, not ignored. */
export function validateDesiredState(value: unknown): Result<DesiredState> {
  return asResult(() => parse(value))
}

/** Default offline grace when a document does not say. */
export const DEFAULT_GRACE_DAYS = 7

/** Whether a cached document may still be applied at `now`. */
export function usableOffline(state: DesiredState, receivedAt: number, now: number): boolean {
  if (state.expiresAt !== undefined && Date.parse(state.expiresAt) <= now) return false
  const graceDays = state.offline?.graceDays ?? DEFAULT_GRACE_DAYS
  return now - receivedAt <= graceDays * 24 * 60 * 60 * 1000
}
