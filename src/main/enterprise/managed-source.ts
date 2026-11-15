/**
 * Where an organisation's configuration comes from on this machine.
 *
 * IT places files in one system directory (MDM, a configuration profile, a
 * software-distribution package, or the installer itself):
 *
 * - `enrollment.json` — server mode: the management server and its pinned
 *   signing keys. The person signs in; the server supplies the document.
 * - `managed.json` — file mode: the desired-state document itself, for teams
 *   without a server. It may be signed; when `organization-keys.json` is
 *   present beside it, it must be, and must verify against those keys.
 *
 * With neither file the client is in personal mode and behaves exactly as it
 * always has. A file that is present but invalid fails closed: the client
 * does not quietly fall back to personal mode on a managed machine.
 * @module dsh-desktop-pro/enterprise/managed-source
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSignedDocument, validateDesiredState, validateEnrollment, verifyDocument,
  type DesiredState, type Enrollment, type PublicKeyRecord,
} from '@dsh-desktop-pro/protocol'

export const ENROLLMENT_FILE = 'enrollment.json'
export const MANAGED_FILE = 'managed.json'
export const KEYS_FILE = 'organization-keys.json'

export type ManagedSource =
  | { kind: 'personal'; dir: string }
  | { kind: 'file'; dir: string; state: DesiredState; signed: boolean }
  | { kind: 'server'; dir: string; enrollment: Enrollment }
  | { kind: 'invalid'; dir: string; file: string; reason: string }

/** The system-wide directory IT writes to. Not writable by a standard user on a managed machine. */
export function systemManagedDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return '/Library/Application Support/DSH Desktop Pro'
  if (platform === 'win32') return join(env['ProgramData'] ?? env['PROGRAMDATA'] ?? 'C:\\ProgramData', 'DSH Desktop Pro')
  return '/etc/dsh-desktop-pro'
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown }
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EACCES' ? 'cannot be read (permission denied)' : 'is not valid JSON' }
  }
}

function readKeys(file: string): PublicKeyRecord[] | string {
  const parsed = readJson(file)
  if (!parsed.ok) return parsed.reason
  const list = Array.isArray(parsed.value) ? parsed.value : (parsed.value as { keys?: unknown } | null)?.keys
  if (!Array.isArray(list) || list.length === 0) return 'must list at least one key'
  const keys: PublicKeyRecord[] = []
  for (const item of list) {
    const key = item as { keyId?: unknown; publicKey?: unknown } | null
    if (typeof key?.keyId !== 'string' || typeof key.publicKey !== 'string') return 'every key needs keyId and publicKey'
    keys.push({ keyId: key.keyId, publicKey: key.publicKey })
  }
  return keys
}

export function loadManagedSource(dir: string): ManagedSource {
  const enrollmentFile = join(dir, ENROLLMENT_FILE)
  if (existsSync(enrollmentFile)) {
    const parsed = readJson(enrollmentFile)
    if (!parsed.ok) return { kind: 'invalid', dir, file: enrollmentFile, reason: parsed.reason }
    const enrollment = validateEnrollment(parsed.value)
    if (!enrollment.ok) return { kind: 'invalid', dir, file: enrollmentFile, reason: enrollment.path + ' ' + enrollment.reason }
    return { kind: 'server', dir, enrollment: enrollment.value }
  }
  const managedFile = join(dir, MANAGED_FILE)
  if (!existsSync(managedFile)) return { kind: 'personal', dir }
  const parsed = readJson(managedFile)
  if (!parsed.ok) return { kind: 'invalid', dir, file: managedFile, reason: parsed.reason }
  const keysFile = join(dir, KEYS_FILE)
  let payload = parsed.value
  let signed = false
  if (existsSync(keysFile)) {
    const keys = readKeys(keysFile)
    if (typeof keys === 'string') return { kind: 'invalid', dir, file: keysFile, reason: keys }
    if (!isSignedDocument(parsed.value)) return { kind: 'invalid', dir, file: managedFile, reason: 'must be signed: organisation keys are pinned on this machine' }
    const verified = verifyDocument(parsed.value, keys)
    if (!verified.ok) return { kind: 'invalid', dir, file: managedFile, reason: 'signature ' + verified.path + ' ' + verified.reason }
    payload = verified.value
    signed = true
  } else if (isSignedDocument(parsed.value)) {
    return { kind: 'invalid', dir, file: managedFile, reason: 'is signed, but no organisation keys are pinned (' + KEYS_FILE + ')' }
  }
  const state = validateDesiredState(payload)
  if (!state.ok) return { kind: 'invalid', dir, file: managedFile, reason: state.path + ' ' + state.reason }
  return { kind: 'file', dir, state: state.value, signed }
}
