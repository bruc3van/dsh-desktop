/**
 * The organisation's market: plugins IT has reviewed, and a library of skills.
 *
 * Plugins are picked from public plugin indexes (or entered by hand for an
 * internal package), each pinned to one version, and served back to the
 * organisation's clients as a plugin index in the official format 1, so the
 * Discover page lists them first. A blocked package name is added to every
 * person's `plugins.blocked`, which removes it from their profile.
 *
 * Skills are stored here as files and delivered in each person's desired
 * state: those for everyone always, and the optional ones a person chose in
 * the client.
 *
 * The index carries no signature (the official reader has none): what it
 * lists is a recommendation. What a device must or must not run stays in the
 * signed desired state.
 * @module @dsh-desktop-pro/server/market
 */

import { createHmac } from 'node:crypto'
import { validateProfileSpec, type ManagedSkill } from '@dsh-desktop-pro/protocol'
import type { ServerConfig } from './config.ts'
import { newId, safeEqual } from './crypto.ts'
import type { Db } from './db.ts'
import { HttpError } from './http.ts'
import type { User } from './store.ts'

export const SKILL_DISTRIBUTIONS = ['everyone', 'optional'] as const
export type SkillDistribution = typeof SKILL_DISTRIBUTIONS[number]

/** Literal text, or translations keyed by language with an English fallback (the official LocalizedText). */
export type LocalizedText = string | Record<string, string>

export type MarketSource = { type: 'npm'; registry?: string } | { type: 'git'; url: string; commit: string; path?: string }

export interface MarketVersion {
  version: string
  publishTimestamp: number
  source: MarketSource
  engines: { dsh?: string }
}

/** Display fields of one plugin, as an index lists them. */
export interface PluginEntry {
  title?: LocalizedText
  description?: LocalizedText
  icon?: string
  author?: string
  homepage?: string
  repository?: { url: string; directory?: string }
  category?: { id: string; title: LocalizedText }
  keywords?: string[]
}

export interface CompanyPlugin extends PluginEntry {
  name: string
  status: 'approved' | 'blocked'
  version?: MarketVersion
  sourceId: string | null
  featured: boolean
  note: string | null
  reviewedBy: string | null
  reviewedAt: number
}

export interface SourceSummary {
  id: string
  url: string
  title: LocalizedText | null
  pluginCount: number
  fetchedAt: number | null
  error: string | null
}

export interface LibrarySkill {
  id: string
  title: string
  description: string | null
  distribution: SkillDistribution
  version: number
  files: Record<string, string>
  subscribers: number
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const DIRECTORY = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/
const ICON_DATA = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const COMPANY_LABEL = 'recommended'

// ---------- reading index documents ----------

function text(value: unknown, max = 2000): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
}

/** Keep a LocalizedText only in a shape the official validator accepts. */
export function localized(value: unknown, max = 2000): LocalizedText | undefined {
  const literal = text(value, max)
  if (literal !== undefined) return literal
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [language, item] of Object.entries(value)) {
    const translated = text(item, max)
    if (LANGUAGE.test(language) && translated !== undefined) out[language] = translated
  }
  return out['en'] === undefined ? undefined : out
}

function absoluteUrl(value: unknown, protocols: string[], base?: string): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base)
    if (!protocols.includes(url.protocol) || url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** A page or repository URL: http(s), no credentials, query or fragment. */
function pageUrl(value: unknown): string | undefined {
  const url = absoluteUrl(value, ['https:', 'http:'])
  if (url === undefined) return undefined
  const parsed = new URL(url)
  return parsed.search === '' && parsed.hash === '' ? url : undefined
}

function icon(value: unknown, indexUrl: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const data = ICON_DATA.exec(value)
  if (data !== null) return Buffer.from(data[1] ?? '', 'base64').length <= 32 * 1024 ? value : undefined
  // Relative references resolve against the index they came from; only https survives the move to another index.
  return absoluteUrl(value, ['https:'], indexUrl)
}

export function compareSemver(a: string, b: string): number {
  const left = SEMVER.exec(a)
  const right = SEMVER.exec(b)
  if (left === null || right === null) return a.localeCompare(b)
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  if (left[4] === undefined || right[4] === undefined) return left[4] === undefined ? (right[4] === undefined ? 0 : 1) : -1
  return left[4].localeCompare(right[4], 'en', { numeric: true })
}

function marketSource(value: unknown): MarketSource | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (source['type'] === 'npm') {
    if (source['registry'] === undefined) return { type: 'npm' }
    const registry = absoluteUrl(source['registry'], ['https:', 'http:'])
    return registry === undefined ? undefined : { type: 'npm', registry }
  }
  if (source['type'] === 'git') {
    const url = pageUrl(source['url'])
    const commit = typeof source['commit'] === 'string' ? source['commit'] : ''
    if (url === undefined || !url.startsWith('https:') || !COMMIT.test(commit)) return undefined
    const path = source['path']
    if (path !== undefined && (typeof path !== 'string' || !DIRECTORY.test(path) || path.split('/').some(part => part === '.' || part === '..'))) return undefined
    return { type: 'git', url: url.replace(/\/$/, ''), commit, ...typeof path === 'string' && { path } }
  }
  return undefined
}

export function marketVersion(value: unknown): MarketVersion | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const entry = value as Record<string, unknown>
  const version = typeof entry['version'] === 'string' && SEMVER.test(entry['version']) ? entry['version'] : undefined
  const published = entry['publishTimestamp']
  const source = marketSource(entry['source'])
  if (version === undefined || source === undefined || typeof published !== 'number' || !Number.isInteger(published) || published < 0 || published >= 1e11) return undefined
  const engines = entry['engines'] as Record<string, unknown> | undefined
  const dsh = text(engines?.['dsh'], 200)
  return { version, publishTimestamp: published, source, engines: dsh === undefined ? {} : { dsh } }
}

interface SourcePlugin extends PluginEntry {
  name: string
  versions: MarketVersion[]
  search: string
}

interface SourceDocument { title: LocalizedText; plugins: Map<string, SourcePlugin> }

function plainText(value: LocalizedText | undefined): string {
  return value === undefined ? '' : typeof value === 'string' ? value : Object.values(value).join(' ')
}

/** Every plugin of a fetched index that is usable here; malformed entries are skipped, not fatal. */
export function readSourceDocument(raw: unknown, indexUrl: string): SourceDocument {
  if (raw === null || typeof raw !== 'object' || (raw as Record<string, unknown>)['format'] !== 1) throw new HttpError(422, 'invalid_index', 'not a format 1 plugin index')
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc['plugins'])) throw new HttpError(422, 'invalid_index', 'the index lists no plugins')
  const categories = ((doc['metadata'] as Record<string, unknown> | undefined)?.['categories'] ?? {}) as Record<string, { title?: unknown } | undefined>
  const plugins = new Map<string, SourcePlugin>()
  for (const item of doc['plugins'] as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const plugin = item as Record<string, unknown>
    const name = typeof plugin['name'] === 'string' && PACKAGE_NAME.test(plugin['name']) && plugin['name'].length <= 214 ? plugin['name'] : undefined
    if (name === undefined || plugins.has(name)) continue
    const versions = (Array.isArray(plugin['versions']) ? plugin['versions'] : []).map(marketVersion).filter((entry): entry is MarketVersion => entry !== undefined)
    if (versions.length === 0) continue
    versions.sort((a, b) => compareSemver(b.version, a.version))
    const metadata = (plugin['metadata'] ?? {}) as Record<string, unknown>
    const categoryId = text(metadata['category'], 100)
    const categoryTitle = categoryId === undefined ? undefined : localized(categories[categoryId]?.title, 200)
    const repository = plugin['repository'] as Record<string, unknown> | undefined
    const repositoryUrl = pageUrl(repository?.['url'])
    const directory = repository?.['directory']
    const entry: SourcePlugin = { name, versions, search: '' }
    const title = localized(plugin['title'], 200)
    const description = localized(plugin['description'])
    const author = text(plugin['author'], 200)
    const homepage = pageUrl(plugin['homepage'])
    const image = icon(plugin['icon'], indexUrl)
    if (title !== undefined) entry.title = title
    if (description !== undefined) entry.description = description
    if (author !== undefined) entry.author = author
    if (homepage !== undefined) entry.homepage = homepage
    if (image !== undefined) entry.icon = image
    if (repositoryUrl !== undefined) entry.repository = { url: repositoryUrl, ...typeof directory === 'string' && DIRECTORY.test(directory) && { directory } }
    if (categoryId !== undefined && categoryTitle !== undefined) entry.category = { id: categoryId, title: categoryTitle }
    const keywords = Array.isArray(metadata['keywords']) ? metadata['keywords'].filter((word): word is string => typeof word === 'string' && word.length <= 100).slice(0, 40) : []
    if (keywords.length > 0) entry.keywords = keywords
    entry.search = [name, plainText(title), plainText(description), author ?? '', plainText(categoryTitle), ...keywords].join(' ').toLowerCase()
    plugins.set(name, entry)
  }
  return { title: localized(doc['title'], 200) ?? indexUrl, plugins }
}

// ---------- the market ----------

interface PluginRow {
  name: string; status: string; entry: string; version: string | null; version_entry: string | null; source_id: string | null
  featured: number; note: string | null; reviewed_by: string | null; reviewed_at: number
}

interface SkillRow {
  id: string; title: string; description: string | null; distribution: string; files: string; version: number
  created_by: string | null; created_at: number; updated_at: number
}

function toPlugin(row: PluginRow): CompanyPlugin {
  const entry = JSON.parse(row.entry) as PluginEntry
  return {
    ...entry,
    name: row.name,
    status: row.status === 'blocked' ? 'blocked' : 'approved',
    ...row.version_entry !== null && { version: JSON.parse(row.version_entry) as MarketVersion },
    sourceId: row.source_id,
    featured: row.featured === 1,
    note: row.note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  }
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'invalid_' + field)
  return value.trim() === '' ? null : value.trim()
}

export function createMarket(db: Db, tenantId: string, config: ServerConfig, fetchImpl: typeof fetch) {
  /** Parsed source documents, keyed by source id and fetch time. */
  const parsed = new Map<string, { fetchedAt: number; doc: SourceDocument }>()

  // ---------- sources ----------

  async function sources(): Promise<SourceSummary[]> {
    const rows = await db.all<{ id: string; url: string; title: string | null; plugin_count: number; fetched_at: number | null; error: string | null }>(
      'SELECT id, url, title, plugin_count, fetched_at, error FROM market_sources WHERE tenant_id = $1 ORDER BY created_at', [tenantId])
    return rows.map(row => ({ id: row.id, url: row.url, title: row.title === null ? null : JSON.parse(row.title) as LocalizedText, pluginCount: row.plugin_count, fetchedAt: row.fetched_at, error: row.error }))
  }

  async function download(url: string): Promise<{ raw: string; doc: SourceDocument }> {
    let response: Response
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new HttpError(502, 'index_unreachable', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw new HttpError(502, 'index_unreachable', 'HTTP ' + String(response.status))
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_SOURCE_BYTES) throw new HttpError(422, 'invalid_index', 'larger than 64 MB')
    let raw: unknown
    try { raw = JSON.parse(body.toString('utf8')) } catch { throw new HttpError(422, 'invalid_index', 'not JSON') }
    return { raw: body.toString('utf8'), doc: readSourceDocument(raw, url) }
  }

  async function addSource(input: Record<string, unknown>): Promise<SourceSummary> {
    const url = pageUrl(input['url']) ?? absoluteUrl(input['url'], ['https:', 'http:'])
    if (url === undefined) throw new HttpError(400, 'invalid_url')
    if ((await sources()).some(source => source.url === url)) throw new HttpError(409, 'source_exists')
    const { raw, doc } = await download(url)
    const id = newId('src')
    const now = Date.now()
    await db.run('INSERT INTO market_sources (id, tenant_id, url, title, plugin_count, document, fetched_at, error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $7)',
      [id, tenantId, url, JSON.stringify(doc.title), doc.plugins.size, raw, now])
    parsed.set(id, { fetchedAt: now, doc })
    return { id, url, title: doc.title, pluginCount: doc.plugins.size, fetchedAt: now, error: null }
  }

  async function refreshSource(id: string): Promise<SourceSummary> {
    const row = await db.get<{ url: string }>('SELECT url FROM market_sources WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    if (row === undefined) throw new HttpError(404, 'source_not_found')
    try {
      const { raw, doc } = await download(row.url)
      const now = Date.now()
      await db.run('UPDATE market_sources SET title = $1, plugin_count = $2, document = $3, fetched_at = $4, error = NULL WHERE tenant_id = $5 AND id = $6',
        [JSON.stringify(doc.title), doc.plugins.size, raw, now, tenantId, id])
      parsed.set(id, { fetchedAt: now, doc })
    } catch (error) {
      // Keep the last good copy; record why this read failed.
      await db.run('UPDATE market_sources SET error = $1 WHERE tenant_id = $2 AND id = $3', [error instanceof Error ? error.message.slice(0, 300) : String(error), tenantId, id])
    }
    const summary = (await sources()).find(source => source.id === id)
    if (summary === undefined) throw new HttpError(404, 'source_not_found')
    return summary
  }

  async function deleteSource(id: string): Promise<void> {
    await db.run('DELETE FROM market_sources WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    // Approved plugins keep working: the catalog holds its own copy of each entry.
    await db.run('UPDATE market_plugins SET source_id = NULL WHERE tenant_id = $1 AND source_id = $2', [tenantId, id])
    parsed.delete(id)
  }

  async function sourceDocument(id: string): Promise<SourceDocument> {
    const row = await db.get<{ url: string; document: string | null; fetched_at: number | null }>(
      'SELECT url, document, fetched_at FROM market_sources WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    if (row === undefined) throw new HttpError(404, 'source_not_found')
    const cached = parsed.get(id)
    if (cached !== undefined && cached.fetchedAt === row.fetched_at) return cached.doc
    if (row.document === null) throw new HttpError(409, 'source_not_fetched')
    const doc = readSourceDocument(JSON.parse(row.document), row.url)
    parsed.set(id, { fetchedAt: row.fetched_at ?? 0, doc })
    return doc
  }

  /** One page of a source's plugins, with what the organisation decided about each. */
  async function browse(id: string, query: string, offset: number, limit: number) {
    const doc = await sourceDocument(id)
    const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
    const matches = [...doc.plugins.values()].filter(plugin => words.every(word => plugin.search.includes(word)))
    const decided = new Map((await db.all<{ name: string; status: string; version: string | null }>(
      'SELECT name, status, version FROM market_plugins WHERE tenant_id = $1', [tenantId])).map(row => [row.name, row]))
    return {
      total: matches.length,
      entries: matches.slice(offset, offset + limit).map(({ search: _search, ...plugin }) => ({
        ...plugin,
        versions: plugin.versions.slice(0, 20),
        company: decided.get(plugin.name) === undefined ? null : { status: decided.get(plugin.name)?.status, version: decided.get(plugin.name)?.version },
      })),
    }
  }

  // ---------- catalog ----------

  async function plugins(): Promise<CompanyPlugin[]> {
    const rows = await db.all<PluginRow>('SELECT * FROM market_plugins WHERE tenant_id = $1 ORDER BY reviewed_at DESC', [tenantId])
    return rows.map(toPlugin)
  }

  async function plugin(name: string): Promise<CompanyPlugin | undefined> {
    const row = await db.get<PluginRow>('SELECT * FROM market_plugins WHERE tenant_id = $1 AND name = $2', [tenantId, name])
    return row === undefined ? undefined : toPlugin(row)
  }

  async function write(name: string, values: { status: 'approved' | 'blocked'; entry: PluginEntry; version: MarketVersion | null; sourceId: string | null; featured: boolean; note: string | null; actor: string }): Promise<CompanyPlugin> {
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM market_plugins WHERE tenant_id = $1 AND name = $2', [tenantId, name])
      await tx.run('INSERT INTO market_plugins (tenant_id, name, status, entry, version, version_entry, source_id, featured, note, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
        tenantId, name, values.status, JSON.stringify(values.entry), values.version?.version ?? null, values.version === null ? null : JSON.stringify(values.version),
        values.sourceId, values.featured ? 1 : 0, values.note, values.actor, Date.now(),
      ])
    })
    const saved = await plugin(name)
    if (saved === undefined) throw new Error('plugin vanished after saving')
    return saved
  }

  /**
   * Approve one version: picked from a source (`sourceId`, `name`, `version`),
   * or entered by hand for a package no index lists (`source`).
   */
  async function approve(input: Record<string, unknown>, actor: string): Promise<CompanyPlugin> {
    const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
    if (!PACKAGE_NAME.test(name) || name.length > 214) throw new HttpError(400, 'invalid_plugin_name')
    const note = optionalText(input['note'], 'note', 1000)
    const previous = await plugin(name)
    const featured = typeof input['featured'] === 'boolean' ? input['featured'] : previous?.featured ?? false
    if (typeof input['sourceId'] === 'string') {
      const doc = await sourceDocument(input['sourceId'])
      const listed = doc.plugins.get(name)
      if (listed === undefined) throw new HttpError(404, 'plugin_not_in_source')
      const version = listed.versions.find(entry => entry.version === input['version'])
      if (version === undefined) throw new HttpError(404, 'version_not_in_source')
      const { search: _search, versions: _versions, name: _name, ...entry } = listed
      return write(name, { status: 'approved', entry, version, sourceId: input['sourceId'], featured, note, actor })
    }
    const version = marketVersion({ version: input['version'], publishTimestamp: Math.floor(Date.now() / 1000), source: input['source'], engines: input['engines'] ?? {} })
    if (version === undefined) throw new HttpError(400, 'invalid_plugin_version', 'an exact version and an npm or pinned Git source are required')
    const entry: PluginEntry = previous === undefined ? {} : (({ name: _n, status: _s, version: _v, sourceId: _i, featured: _f, note: _o, reviewedBy: _b, reviewedAt: _a, ...rest }) => rest)(previous)
    const title = optionalText(input['title'], 'title', 200)
    const description = optionalText(input['description'], 'description', 2000)
    const homepage = input['homepage'] === undefined || input['homepage'] === '' ? undefined : pageUrl(input['homepage'])
    if (input['homepage'] !== undefined && input['homepage'] !== '' && homepage === undefined) throw new HttpError(400, 'invalid_homepage')
    if (title !== null) entry.title = title
    if (description !== null) entry.description = description
    if (homepage !== undefined) entry.homepage = homepage
    return write(name, { status: 'approved', entry, version, sourceId: null, featured, note, actor })
  }

  async function update(name: string, input: Record<string, unknown>, actor: string): Promise<CompanyPlugin> {
    const current = await plugin(name)
    if (current === undefined) throw new HttpError(404, 'plugin_not_found')
    const { name: _n, status, version, sourceId, featured, note, reviewedBy: _b, reviewedAt: _a, ...entry } = current
    return write(name, {
      status, entry, version: version ?? null, sourceId,
      featured: typeof input['featured'] === 'boolean' ? input['featured'] : featured,
      note: input['note'] === undefined ? note : optionalText(input['note'], 'note', 1000),
      actor,
    })
  }

  async function block(input: Record<string, unknown>, actor: string): Promise<CompanyPlugin> {
    const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
    if (!PACKAGE_NAME.test(name) || name.length > 214) throw new HttpError(400, 'invalid_plugin_name')
    const previous = await plugin(name)
    const entry: PluginEntry = previous === undefined ? {} : (({ name: _n, status: _s, version: _v, sourceId: _i, featured: _f, note: _o, reviewedBy: _b, reviewedAt: _a, ...rest }) => rest)(previous)
    return write(name, { status: 'blocked', entry, version: null, sourceId: previous?.sourceId ?? null, featured: false, note: optionalText(input['note'], 'note', 1000), actor })
  }

  async function remove(name: string): Promise<void> {
    const removed = await db.run('DELETE FROM market_plugins WHERE tenant_id = $1 AND name = $2', [tenantId, name])
    if (removed === 0) throw new HttpError(404, 'plugin_not_found')
  }

  // ---------- the organisation's index ----------

  function token(userId: string): string {
    return userId + '.' + createHmac('sha256', config.secret).update('market-index\n' + tenantId + '\n' + userId).digest('base64url').slice(0, 32)
  }

  /** The person behind an index token, if it is genuine. */
  function tokenUser(value: string): string | undefined {
    const at = value.lastIndexOf('.')
    if (at <= 0) return undefined
    const userId = value.slice(0, at)
    return safeEqual(token(userId), value) ? userId : undefined
  }

  function indexUrl(userId: string): string {
    return config.publicUrl.replace(/\/$/, '') + '/v1/market/' + token(userId) + '/index.json'
  }

  /** A format 1 plugin index of the approved plugins, recommended ones first. */
  async function index(organization: string): Promise<Record<string, unknown>> {
    const approved = (await plugins()).filter(item => item.status === 'approved' && item.version !== undefined)
    approved.sort((a, b) => Number(b.featured) - Number(a.featured) || b.reviewedAt - a.reviewedAt)
    const categories: Record<string, { title: LocalizedText }> = {}
    for (const item of approved) if (item.category !== undefined) categories[item.category.id] = { title: item.category.title }
    return {
      format: 1,
      title: { en: organization + ' plugins', zh: organization + ' 精选插件' },
      description: { en: 'Plugins reviewed and approved by ' + organization + '.', zh: organization + ' 审核通过的插件。' },
      metadata: {
        categories,
        labels: { [COMPANY_LABEL]: { title: { en: 'Recommended', zh: '公司推荐' } } },
        sortKeys: {},
      },
      plugins: approved.map(item => ({
        name: item.name,
        ...item.title !== undefined && { title: item.title },
        ...item.description !== undefined && { description: item.description },
        ...item.icon !== undefined && { icon: item.icon },
        ...item.author !== undefined && { author: item.author },
        ...item.homepage !== undefined && { homepage: item.homepage },
        ...item.repository !== undefined && { repository: item.repository },
        metadata: {
          ...item.category !== undefined && { category: item.category.id },
          keywords: item.keywords ?? [],
          labels: item.featured ? [COMPANY_LABEL] : [],
          sortKeys: {},
        },
        versions: [item.version],
      })),
    }
  }

  // ---------- skills ----------

  function toSkill(row: SkillRow, subscribers: number): LibrarySkill {
    return {
      id: row.id, title: row.title, description: row.description,
      distribution: row.distribution === 'optional' ? 'optional' : 'everyone',
      version: row.version, files: JSON.parse(row.files) as Record<string, string>, subscribers,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  async function skills(): Promise<LibrarySkill[]> {
    const rows = await db.all<SkillRow>('SELECT * FROM market_skills WHERE tenant_id = $1 ORDER BY title', [tenantId])
    const counts = new Map((await db.all<{ skill_id: string; n: number }>(
      'SELECT skill_id, COUNT(*) AS n FROM skill_subscriptions WHERE tenant_id = $1 GROUP BY skill_id', [tenantId])).map(row => [row.skill_id, Number(row.n)]))
    return rows.map(row => toSkill(row, counts.get(row.id) ?? 0))
  }

  async function skill(id: string): Promise<LibrarySkill | undefined> {
    return (await skills()).find(item => item.id === id)
  }

  async function saveSkill(id: string, input: Record<string, unknown>, actor: string): Promise<{ skill: LibrarySkill; created: boolean; filesChanged: boolean }> {
    const title = typeof input['title'] === 'string' && input['title'].trim() !== '' && input['title'].length <= 120 ? input['title'].trim() : undefined
    if (title === undefined) throw new HttpError(400, 'invalid_title')
    const distribution = input['distribution']
    if (!(SKILL_DISTRIBUTIONS as readonly unknown[]).includes(distribution)) throw new HttpError(400, 'invalid_distribution')
    const checked = validateProfileSpec({ skills: [{ name: id, files: input['files'] }] })
    if (!checked.ok) throw new HttpError(400, 'invalid_skill', checked.path.replace('$.skills[0]', 'skill') + ' ' + checked.reason)
    const files = checked.value.skills?.[0]?.files ?? {}
    const description = optionalText(input['description'], 'description', 500)
    const now = Date.now()
    const current = await db.get<SkillRow>('SELECT * FROM market_skills WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    const serialised = JSON.stringify(files)
    const filesChanged = current === undefined || current.files !== serialised
    if (current === undefined) {
      await db.run('INSERT INTO market_skills (tenant_id, id, title, description, distribution, files, version, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8)',
        [tenantId, id, title, description, distribution as string, serialised, actor, now])
    } else {
      await db.run('UPDATE market_skills SET title = $1, description = $2, distribution = $3, files = $4, version = $5, updated_at = $6 WHERE tenant_id = $7 AND id = $8',
        [title, description, distribution as string, serialised, current.version + (filesChanged ? 1 : 0), now, tenantId, id])
    }
    const saved = await skill(id)
    if (saved === undefined) throw new Error('skill vanished after saving')
    return { skill: saved, created: current === undefined, filesChanged }
  }

  async function deleteSkill(id: string): Promise<void> {
    const removed = await db.run('DELETE FROM market_skills WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    if (removed === 0) throw new HttpError(404, 'skill_not_found')
    await db.run('DELETE FROM skill_subscriptions WHERE tenant_id = $1 AND skill_id = $2', [tenantId, id])
  }

  async function subscribed(userId: string): Promise<Set<string>> {
    return new Set((await db.all<{ skill_id: string }>('SELECT skill_id FROM skill_subscriptions WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])).map(row => row.skill_id))
  }

  /** What the client's skill list shows one person. */
  async function skillsForClient(userId: string) {
    const mine = await subscribed(userId)
    return (await skills()).map(item => ({
      id: item.id, title: item.title, ...item.description !== null && { description: item.description },
      distribution: item.distribution, version: item.version, updatedAt: new Date(item.updatedAt).toISOString(),
      installed: item.distribution === 'everyone' || mine.has(item.id),
    }))
  }

  /** Whether the call changed anything. */
  async function subscribe(userId: string, id: string, on: boolean): Promise<boolean> {
    const target = await db.get<{ distribution: string }>('SELECT distribution FROM market_skills WHERE tenant_id = $1 AND id = $2', [tenantId, id])
    if (target === undefined) throw new HttpError(404, 'skill_not_found')
    if (target.distribution !== 'optional') throw new HttpError(409, 'skill_not_optional')
    const has = (await subscribed(userId)).has(id)
    if (has === on) return false
    if (on) await db.run('INSERT INTO skill_subscriptions (tenant_id, user_id, skill_id, created_at) VALUES ($1, $2, $3, $4)', [tenantId, userId, id, Date.now()])
    else await db.run('DELETE FROM skill_subscriptions WHERE tenant_id = $1 AND user_id = $2 AND skill_id = $3', [tenantId, userId, id])
    return true
  }

  async function subscribers(id: string): Promise<string[]> {
    return (await db.all<{ user_id: string }>('SELECT user_id FROM skill_subscriptions WHERE tenant_id = $1 AND skill_id = $2 ORDER BY created_at', [tenantId, id])).map(row => row.user_id)
  }

  /** The market's part of one person's desired state. */
  async function forPerson(person: User): Promise<{ indexUrl?: string; blocked: string[]; skills: ManagedSkill[] }> {
    const all = await plugins()
    const mine = await subscribed(person.id)
    const library = (await skills()).filter(item => item.distribution === 'everyone' || mine.has(item.id))
    return {
      ...all.some(item => item.status === 'approved') && { indexUrl: indexUrl(person.id) },
      blocked: all.filter(item => item.status === 'blocked').map(item => item.name),
      skills: library.map(item => ({ name: item.id, files: item.files })),
    }
  }

  return {
    sources, addSource, refreshSource, deleteSource, browse,
    plugins, plugin, approve, update, block, remove,
    tokenUser, indexUrl, index,
    skills, skill, saveSkill, deleteSkill, skillsForClient, subscribe, subscribers, forPerson,
  }
}

export type Market = ReturnType<typeof createMarket>
