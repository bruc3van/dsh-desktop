/**
 * Apply a desired-state document to one DSH home, idempotently.
 *
 * Only files are touched, so the same code runs in two places: in the managed
 * CLI child right before DSH reads its profile (the first launch has no
 * profile until then), and in the main process while a runtime is serving —
 * DSH watches the patch layer and the credential file, so most changes apply
 * live without a restart.
 *
 * Everything the client writes is either inside one delimited block at the
 * end of the profile patch layer, or recorded in a ledger next to the home.
 * The block is replaced whole on every pass, which is also drift correction:
 * a hand edit inside it does not survive the next pass, and because the block
 * comes last it wins over any earlier row the user or the official UI wrote.
 * Nothing outside the block or the ledger is ever modified or removed.
 *
 * Installing and removing plugin packages is not done here: that needs the
 * runtime's own package manager, see `plugin-sync.ts`.
 * @module dsh-desktop-pro/enterprise/reconcile
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DesiredState } from '@dsh-desktop-pro/protocol'
import { dump, load } from 'js-yaml'
import { parsePatch, PLUGIN_MARKET_BUNDLE } from '../preset-subscription.ts'
import { WEB_PROFILE } from '../web-profile.ts'

export const MANAGED_BLOCK_START = '# --- dsh-desktop-pro managed (written by DSH Desktop Pro; edits here are replaced) ---'
export const MANAGED_BLOCK_END = '# --- end dsh-desktop-pro managed ---'
export const LEDGER_FILE = '.dsh-desktop-pro-managed.json'
export const SKILL_MARKER = '.dsh-desktop-pro-managed'
export const POLICY_PLUGIN_ID = 'dsh-desktop-pro-policy'
/** Where the policy plugin records refused calls until the client uploads them. */
export const DENIAL_LOG_FILE = '.dsh-desktop-pro-denials.jsonl'

export interface ReconcileOptions {
  dshHome: string
  /** Absolute path of the tool-policy plugin shipped with the client. */
  policyPluginPath?: string
}

export interface ReconcileResult {
  /** Human-readable reasons a part of the document could not be applied. */
  problems: string[]
  /** Whether any file changed on this pass. */
  changed: boolean
}

interface Ledger {
  credentials: string[]
  skills: string[]
  bundles: string[]
}

function profileDir(dshHome: string): string {
  return join(dshHome, 'profiles', WEB_PROFILE)
}

function readLedger(dshHome: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, LEDGER_FILE), 'utf8')) as Partial<Ledger> | null
    const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    return { credentials: list(parsed?.credentials), skills: list(parsed?.skills), bundles: list(parsed?.bundles) }
  } catch {
    return { credentials: [], skills: [], bundles: [] }
  }
}

/** Same-directory temporary file and rename: a torn read must never reach DSH. */
function writeAtomic(file: string, content: string): boolean {
  let previous: string | undefined
  try { previous = readFileSync(file, 'utf8') } catch { previous = undefined }
  if (previous === content) return false
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.' + String(process.pid) + '.managed.tmp'
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
  return true
}

function writeLedger(dshHome: string, ledger: Ledger): boolean {
  return writeAtomic(join(dshHome, LEDGER_FILE), JSON.stringify(ledger, undefined, 2) + '\n')
}

/** The patch rows this document asks for, in the order they are written. */
export function managedPatchEntries(state: DesiredState, policyPluginPath?: string, dshHome?: string): unknown[] {
  const entries: unknown[] = []
  if (state.models !== undefined && Object.keys(state.models.providers).length > 0) {
    const providers: Record<string, unknown> = {}
    for (const [key, route] of Object.entries(state.models.providers)) {
      providers[key] = {
        ...route.displayName !== undefined && { displayName: route.displayName },
        api: route.api,
        baseURL: route.baseURL,
        ...route.credential !== undefined && { apiKeyEnv: route.credential },
        models: route.models.map(model => ({ ...model })),
      }
    }
    entries.push({ id: 'llm-pi-ai', config: { providers } })
    // All model traffic goes through the organisation's routes: the official
    // DeepSeek account and API-key providers would otherwise ask for a key.
    entries.push({ id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true })
    if (state.models.default !== undefined) {
      entries.push({ id: 'agent-default-model', config: { provider: state.models.default.provider, model: state.models.default.model } })
    }
  }
  const indexes = state.plugins?.indexes ?? []
  if (indexes.length > 0) entries.push({ id: 'plugin-market', config: { indexes } })
  if (state.plugins?.registry !== undefined) {
    entries.push({ id: 'plugin-manager', config: {
      registry: state.plugins.registry,
      fallbackRegistries: state.plugins.fallbackRegistries ?? [],
    } })
  }
  const deny = state.tools?.deny ?? []
  if (deny.length > 0 && policyPluginPath !== undefined) {
    entries.push({ insert: [{
      id: POLICY_PLUGIN_ID,
      name: policyPluginPath,
      config: {
        deny,
        ...state.tools?.message !== undefined && { message: state.tools.message },
        ...dshHome !== undefined && { log: join(dshHome, DENIAL_LOG_FILE) },
      },
    }] })
  }
  return entries
}

/** The patch source without our block, or undefined when the rest is in a shape we do not edit. */
function withoutManagedBlock(source: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.indexOf(MANAGED_BLOCK_START)
  if (start < 0) return source
  const endOffset = lines.slice(start).indexOf(MANAGED_BLOCK_END)
  const end = endOffset < 0 ? lines.length - 1 : start + endOffset
  lines.splice(start, end - start + 1)
  return lines.join('\n')
}

/** The patch layer with exactly this block at its end, or undefined for a layer we cannot edit safely. */
export function patchWithManagedBlock(source: string, entries: readonly unknown[]): string | undefined {
  let rest = withoutManagedBlock(source.replace(/\r\n/g, '\n'))
  const content = rest.split('\n').map((line, index) => ({ line, index, text: line.trim() }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'))
  const first = content[0]
  if (entries.length === 0) {
    // Nothing managed: leave an empty layer valid YAML for the loader.
    if (first === undefined) rest = rest.replace(/\n*$/, '\n') + '[]\n'
  } else if (first !== undefined && content.length === 1 && /^\[\s*\](?:\s+#.*)?$/.test(first.text)) {
    const lines = rest.split('\n')
    lines.splice(first.index, 1)
    rest = lines.join('\n')
  } else if (first !== undefined && !/^-(?:\s|$)/.test(first.line)) {
    return undefined
  }
  rest = rest.replace(/\n*$/, '')
  const block = entries.length === 0 ? '' : MANAGED_BLOCK_START + '\n'
    + dump(entries, { lineWidth: -1, noRefs: true, quotingType: '"' }) + MANAGED_BLOCK_END + '\n'
  const next = (rest === '' ? '' : rest + '\n') + block
  try {
    const parsed = parsePatch(next)
    if (!Array.isArray(parsed)) return undefined
  } catch {
    return undefined
  }
  return next
}

function reconcilePatch(dshHome: string, state: DesiredState | undefined, options: ReconcileOptions, result: ReconcileResult): void {
  const file = join(profileDir(dshHome), 'cordis.patch.yml')
  let source = ''
  try { source = readFileSync(file, 'utf8') } catch { source = '' }
  const entries = state === undefined ? [] : managedPatchEntries(state, options.policyPluginPath, dshHome)
  if (entries.length === 0 && !source.includes(MANAGED_BLOCK_START)) return
  const next = patchWithManagedBlock(source, entries)
  if (next === undefined) {
    result.problems.push('the profile patch layer is not a YAML list; managed settings were not written to it')
    return
  }
  if (writeAtomic(file, next)) result.changed = true
  if ((state?.tools?.deny?.length ?? 0) > 0 && options.policyPluginPath === undefined) {
    result.problems.push('the tool policy plugin is not available in this build; denied tools are not enforced')
  }
}

function reconcileBundles(dshHome: string, state: DesiredState | undefined, ledger: Ledger, result: ReconcileResult): void {
  const file = join(profileDir(dshHome), 'package.json')
  if (!existsSync(file)) return
  let manifest: { dsh?: { profile?: { bundles?: unknown } } } & Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as typeof manifest
  } catch {
    result.problems.push('the web profile manifest could not be read')
    return
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return
  const wanted = new Set<string>()
  if ((state?.plugins?.indexes?.length ?? 0) > 0) wanted.add(PLUGIN_MARKET_BUNDLE)
  let edited = false
  for (const bundle of wanted) {
    if (bundles.includes(bundle)) continue
    bundles.push(bundle)
    if (!ledger.bundles.includes(bundle)) ledger.bundles.push(bundle)
    edited = true
  }
  // Only a bundle this client added is ever taken out again.
  for (const bundle of [...ledger.bundles]) {
    if (wanted.has(bundle)) continue
    const index = bundles.indexOf(bundle)
    if (index >= 0) { bundles.splice(index, 1); edited = true }
    ledger.bundles.splice(ledger.bundles.indexOf(bundle), 1)
  }
  if (edited && writeAtomic(file, JSON.stringify(manifest, undefined, 2) + '\n')) result.changed = true
}

interface CredentialDocument { version?: unknown; refs?: Record<string, unknown> | null; [key: string]: unknown }

function reconcileCredentials(dshHome: string, state: DesiredState | undefined, ledger: Ledger, result: ReconcileResult): void {
  const desired = state?.credentials ?? {}
  if (Object.keys(desired).length === 0 && ledger.credentials.length === 0) return
  const file = join(dshHome, '.credentials.yaml')
  let doc: CredentialDocument = { version: 1 }
  if (existsSync(file)) {
    try {
      const parsed = load(readFileSync(file, 'utf8')) as CredentialDocument | null | undefined
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a mapping')
        doc = parsed
      }
    } catch {
      // Never overwrite a credential file DSH itself would refuse to read.
      result.problems.push('the DSH credential file could not be parsed; managed credentials were not written')
      return
    }
  }
  const refs: Record<string, unknown> = doc.refs !== null && typeof doc.refs === 'object' && !Array.isArray(doc.refs) ? { ...doc.refs } : {}
  for (const name of ledger.credentials) if (!Object.hasOwn(desired, name)) Reflect.deleteProperty(refs, name)
  for (const [name, value] of Object.entries(desired)) refs[name] = value
  ledger.credentials = Object.keys(desired)
  const next: CredentialDocument = { ...doc, version: doc.version ?? 1 }
  if (Object.keys(refs).length > 0) next.refs = refs
  else Reflect.deleteProperty(next, 'refs')
  if (writeAtomic(file, dump(next, { lineWidth: -1, noRefs: true }))) result.changed = true
}

function readMarker(dir: string): boolean {
  try {
    return readFileSync(join(dir, SKILL_MARKER), 'utf8').startsWith('dsh-desktop')
  } catch {
    return false
  }
}

function skillContent(dir: string): Record<string, string> | undefined {
  const files: Record<string, string> = {}
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : relative + '/' + entry.name
      if (entry.isDirectory()) walk(path)
      else if (path !== SKILL_MARKER) files[path] = readFileSync(join(dir, path), 'utf8')
    }
  }
  try { walk('') } catch { return undefined }
  return files
}

function sameFiles(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (a === undefined) return false
  const keys = Object.keys(b)
  return Object.keys(a).length === keys.length && keys.every(key => a[key] === b[key])
}

function reconcileSkills(dshHome: string, state: DesiredState | undefined, ledger: Ledger, result: ReconcileResult): void {
  const root = join(dshHome, 'skills')
  const desired = new Map((state?.skills ?? []).map(skill => [skill.name, skill.files]))
  for (const name of [...ledger.skills]) {
    if (desired.has(name)) continue
    const dir = join(root, name)
    if (readMarker(dir)) { rmSync(dir, { recursive: true, force: true }); result.changed = true }
    ledger.skills.splice(ledger.skills.indexOf(name), 1)
  }
  for (const [name, files] of desired) {
    const dir = join(root, name)
    if (existsSync(dir) && !readMarker(dir)) {
      result.problems.push('skill "' + name + '" already exists and was not created by DSH Desktop Pro; it was left as is')
      continue
    }
    if (!ledger.skills.includes(name)) ledger.skills.push(name)
    if (sameFiles(skillContent(dir), files)) continue
    // Stage the whole skill and swap it in: DSH watches this directory and
    // must never pick up a half-written skill.
    const staging = join(root, '.' + name + '.' + String(process.pid) + '.staging')
    rmSync(staging, { recursive: true, force: true })
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(staging, path)), { recursive: true })
      writeFileSync(join(staging, path), content)
    }
    writeFileSync(join(staging, SKILL_MARKER), 'dsh-desktop managed skill; replaced on every sync\n')
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    result.changed = true
  }
}

/** Apply a document. Every part is attempted; failures become `problems`. */
export function applyDesiredState(state: DesiredState, options: ReconcileOptions): ReconcileResult {
  return reconcile(state, options)
}

/** Remove everything the client wrote for an organisation (sign-out or a revoked device). */
export function removeManagedConfiguration(options: ReconcileOptions): ReconcileResult {
  return reconcile(undefined, options)
}

function reconcile(state: DesiredState | undefined, options: ReconcileOptions): ReconcileResult {
  const result: ReconcileResult = { problems: [], changed: false }
  const ledger = readLedger(options.dshHome)
  const steps: Array<[string, () => void]> = [
    ['profile patch layer', () => { reconcilePatch(options.dshHome, state, options, result) }],
    ['profile bundles', () => { reconcileBundles(options.dshHome, state, ledger, result) }],
    ['credentials', () => { reconcileCredentials(options.dshHome, state, ledger, result) }],
    ['skills', () => { reconcileSkills(options.dshHome, state, ledger, result) }],
  ]
  for (const [label, step] of steps) {
    try {
      step()
    } catch (error) {
      result.problems.push(label + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (state === undefined && ledger.credentials.length + ledger.skills.length + ledger.bundles.length === 0) {
    rmSync(join(options.dshHome, LEDGER_FILE), { force: true })
  } else {
    try {
      if (existsSync(options.dshHome) && writeLedger(options.dshHome, ledger)) result.changed = true
    } catch (error) {
      result.problems.push('ledger: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return result
}
