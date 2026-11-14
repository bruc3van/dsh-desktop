/**
 * The one-time preset subscription for the official Discover page.
 *
 * DSH ships a custom-index plugin market as an optional bundle
 * (`@deepseek-ai/dsh-experimental-plugin-market-bundle`): enabling it lists the
 * bundle in the web profile's `dsh.profile.bundles`, and its index sources live
 * on the `plugin-market` row of the profile patch layer. This module does those
 * two edits once per DSH home, so a first launch opens to a Discover page that
 * already lists the curated index.
 *
 * It is an OFFER, not a managed setting. The profile is the user's own file:
 * once the offer is recorded the client never touches either edit again, so a
 * user who removes the index or turns the market off keeps it that way. A
 * profile that already has a `plugin-market` row is the user's configuration
 * and is recorded as offered without any edit.
 *
 * The patch layer is edited as text, never re-serialised: it carries the
 * user's comments and `!!js` expressions, and other tools keep marked blocks in
 * it. The edit is only made in the two shapes the official profile writes (an
 * empty `[]` template or a block sequence), and the result must still parse.
 * @module dsh-desktop/preset-subscription
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { WEB_PROFILE } from './web-profile.ts'

/** The curated index this client offers (built from awesome-dsh-plugin). */
export const PRESET_INDEX_URL = 'https://bruc3van.com/dsh-plugins/index.json'

/** The official optional bundle that mounts the Discover tab. */
export const PLUGIN_MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'

/** The service row the bundle inserts; its `config.indexes` are the sources. */
const MARKET_ROW_ID = 'plugin-market'
const MARKET_ROW_NAME = '@deepseek-ai/dsh-plugin-market'

/** Client-owned record, per DSH home: shared and isolated homes each get one offer. */
export const PRESET_RECORD_FILE = '.dsh-desktop-preset.json'

export type PresetOutcome =
  /** This call enabled the market and/or added the index. */
  | 'offered'
  /** An earlier launch already made the offer for this URL. */
  | 'already-offered'
  /** The profile already configures the market row; left as the user has it. */
  | 'user-configured'
  /** The profile files are in a shape this client will not edit. */
  | 'unsupported-profile'
  /** No web profile exists yet. Not recorded: the next launch tries again. */
  | 'no-profile'

interface PresetRecord { offered?: unknown }

interface ProfileManifest { dsh?: { profile?: { bundles?: unknown } } }

/** `!!js` expressions are opaque strings here; only the structure matters. */
const PATCH_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data: unknown) => String(data) }),
  new Type('tag:yaml.org,2002:js', { kind: 'mapping', construct: (data: unknown) => data }),
  new Type('tag:yaml.org,2002:js', { kind: 'sequence', construct: (data: unknown) => data }),
])

function profileDir(dshHome: string): string {
  return join(dshHome, 'profiles', WEB_PROFILE)
}

function readOffered(dshHome: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, PRESET_RECORD_FILE), 'utf8')) as PresetRecord | null
    return Array.isArray(parsed?.offered) ? parsed.offered.filter((url): url is string => typeof url === 'string') : []
  } catch {
    return []
  }
}

/** Same-directory temporary file + rename: a torn read must never reach the loader. */
function writeAtomic(file: string, content: string): void {
  const temporary = file + '.' + String(process.pid) + '.preset.tmp'
  writeFileSync(temporary, content, { mode: 0o600 })
  try {
    renameSync(temporary, file)
  } catch {
    try {
      rmSync(file, { force: true })
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

function recordOffered(dshHome: string, url: string): void {
  const offered = readOffered(dshHome)
  if (offered.includes(url)) return
  writeAtomic(join(dshHome, PRESET_RECORD_FILE), JSON.stringify({ offered: [...offered, url] }, undefined, 2) + '\n')
}

function parsePatch(source: string): unknown {
  return load(source, { schema: PATCH_SCHEMA }) ?? []
}

/** Any entry, top level or inside an `insert` list, that targets the market row. */
function patchConfiguresMarket(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const record = entry as { id?: unknown; insert?: unknown }
    if (record.id === MARKET_ROW_ID) return true
    return Array.isArray(record.insert) && patchConfiguresMarket(record.insert)
  })
}

function marketRowBlock(url: string): string {
  return '# Added once by DSH Desktop: the curated plugin index for the Discover page.\n'
    + '# Remove the index in Plugins → Discover → Manage sources; it will not be added again.\n'
    + '- id: ' + MARKET_ROW_ID + '\n'
    + '  name: "' + MARKET_ROW_NAME + '"\n'
    + '  config:\n'
    + '    indexes:\n'
    + '      - ' + url + '\n'
}

/**
 * The patch source with the market row added, or undefined when the document
 * is in a shape this client does not edit (a non-empty flow sequence, a
 * mapping, anything that is not the official template or a block sequence).
 */
export function patchWithMarketRow(source: string, url: string): string | undefined {
  // Keep the file's own line endings: a Windows editor may have written CRLF.
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const content = lines
    .map((line, index) => ({ index, line, text: line.trim() }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'))
  const block = marketRowBlock(url).replace(/\n/g, eol)
  const first = content[0]
  let next: string
  if (first === undefined) {
    next = source + (source === '' || source.endsWith('\n') ? '' : eol) + block
  } else if (content.length === 1 && /^\[\s*\](?:\s+#.*)?$/.test(first.text)) {
    // The official template: comments, then a lone `[]`. Replace that line.
    const replaced = [...lines]
    replaced.splice(first.index, 1, block.slice(0, -eol.length))
    next = replaced.join(eol)
    if (!next.endsWith(eol)) next += eol
  } else if (/^-(?:\s|$)/.test(first.line)) {
    // A top-level block sequence: append one more entry at column 0.
    next = source + (source.endsWith('\n') ? '' : eol) + block
  } else {
    return undefined
  }
  // The edit must leave a document the loader accepts, with our row in it.
  try {
    const parsed = parsePatch(next)
    if (!Array.isArray(parsed) || !patchConfiguresMarket(parsed)) return undefined
  } catch {
    return undefined
  }
  return next
}

/**
 * Offer the preset subscription to a DSH home's web profile, once.
 * @param bundleAvailable - the selected runtime can resolve the market bundle.
 *   Listing a bundle the runtime does not ship would fail `loadProfile`, so an
 *   older runtime gets no edit (and no record: a later runtime may offer it).
 */
export function offerPresetSubscription(dshHome: string, bundleAvailable: boolean, url = PRESET_INDEX_URL): PresetOutcome {
  if (readOffered(dshHome).includes(url)) return 'already-offered'
  const dir = profileDir(dshHome)
  const manifestFile = join(dir, 'package.json')
  if (!existsSync(manifestFile)) return 'no-profile'
  if (!bundleAvailable) return 'unsupported-profile'

  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ProfileManifest
  } catch {
    return 'unsupported-profile'
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every((name): name is string => typeof name === 'string')) {
    return 'unsupported-profile'
  }

  const patchFile = join(dir, 'cordis.patch.yml')
  let patchSource = ''
  try {
    patchSource = readFileSync(patchFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsupported-profile'
  }
  let entries: unknown
  try {
    entries = parsePatch(patchSource)
  } catch {
    return 'unsupported-profile'
  }
  if (!Array.isArray(entries)) return 'unsupported-profile'
  if (patchConfiguresMarket(entries)) {
    recordOffered(dshHome, url)
    return 'user-configured'
  }
  const nextPatch = patchWithMarketRow(patchSource, url)
  if (nextPatch === undefined) return 'unsupported-profile'

  // Bundle first: an index row without the bundle is inert (the official UI
  // keeps saved sources when the market is turned off), the reverse is not
  // worse, but this order never leaves a half edit that changes behaviour.
  if (!bundles.includes(PLUGIN_MARKET_BUNDLE)) {
    // Re-read right before writing: the user's own `dsh plugin add` writes the
    // same manifest and must not lose a concurrent change.
    const fresh = JSON.parse(readFileSync(manifestFile, 'utf8')) as ProfileManifest & Record<string, unknown>
    const freshBundles = fresh.dsh?.profile?.bundles
    if (!Array.isArray(freshBundles)) return 'unsupported-profile'
    if (!freshBundles.includes(PLUGIN_MARKET_BUNDLE)) freshBundles.push(PLUGIN_MARKET_BUNDLE)
    writeAtomic(manifestFile, JSON.stringify(fresh, undefined, 2) + '\n')
  }
  writeAtomic(patchFile, nextPatch)
  recordOffered(dshHome, url)
  return 'offered'
}
