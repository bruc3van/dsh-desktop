/**
 * The enrollment file: how a machine learns which organisation manages it.
 *
 * IT distributes it with the installer (MDM, a configuration profile, a
 * registry-backed file, or a download from the console). It names the
 * management server and pins the organisation's signing keys; it holds no
 * secret, so it is safe to publish inside the organisation.
 * @module @dsh-desktop-pro/protocol/enrollment
 */

import type { PublicKeyRecord } from './signing.ts'
import { array, asResult, fail, httpUrl, onlyKeys, optionalBoolean, record, string, type Result } from './validation.ts'

export const ENROLLMENT_SCHEMA = 'dsh-desktop-pro/enrollment'

export interface Enrollment {
  schema: typeof ENROLLMENT_SCHEMA
  version: 1
  /** Origin of the management server, e.g. https://dsh.example.com */
  server: string
  organization: { id: string; name: string }
  /** Organisation signing keys; desired-state documents must verify against one. */
  keys: PublicKeyRecord[]
  /**
   * Let the person choose personal mode on this machine instead of signing
   * in (their own model key, their own ~/.dsh, no organisation policy). The
   * organisation's data stays apart and the choice can be undone from the
   * tray or settings. Off unless IT says so: a company laptop normally has
   * no way around the organisation's configuration.
   */
  allowPersonal?: boolean
}

function parse(value: unknown): Enrollment {
  const doc = record(value, '$')
  onlyKeys(doc, '$', ['schema', 'version', 'server', 'organization', 'keys', 'allowPersonal'])
  if (doc['schema'] !== ENROLLMENT_SCHEMA) fail('$.schema', 'must be ' + ENROLLMENT_SCHEMA)
  if (doc['version'] !== 1) fail('$.version', 'unsupported version; update DSH Desktop Pro')
  const server = httpUrl(doc['server'], '$.server')
  if (new URL(server).pathname !== '/' || new URL(server).search !== '') fail('$.server', 'must be an origin without a path')
  const organization = record(doc['organization'], '$.organization')
  onlyKeys(organization, '$.organization', ['id', 'name'])
  const keys = array(doc['keys'], '$.keys', 8).map((item, index) => {
    const at = '$.keys[' + String(index) + ']'
    const key = record(item, at)
    onlyKeys(key, at, ['keyId', 'publicKey'])
    return {
      keyId: string(key['keyId'], at + '.keyId', { max: 128 }),
      publicKey: string(key['publicKey'], at + '.publicKey', { max: 1024, pattern: /^[A-Za-z0-9+/]+={0,2}$/ }),
    }
  })
  if (keys.length === 0) fail('$.keys', 'must pin at least one organisation key')
  const enrollment: Enrollment = {
    schema: ENROLLMENT_SCHEMA,
    version: 1,
    server: new URL(server).origin,
    organization: {
      id: string(organization['id'], '$.organization.id', { pattern: /^[\w.-]{1,128}$/ }),
      name: string(organization['name'], '$.organization.name', { max: 200 }),
    },
    keys,
  }
  const personal = optionalBoolean(doc['allowPersonal'], '$.allowPersonal')
  if (personal !== undefined) enrollment.allowPersonal = personal
  return enrollment
}

export function validateEnrollment(value: unknown): Result<Enrollment> {
  return asResult(() => parse(value))
}
