#!/usr/bin/env node
/**
 * File mode signing for IT, without a server.
 *
 *   node scripts/org-key.mjs generate <dir>
 *     writes <dir>/organization-key.pem (keep it secret, off the employees' machines)
 *     and <dir>/organization-keys.json (distribute beside managed.json)
 *
 *   node scripts/org-key.mjs sign <managed.json> <organization-key.pem> [out]
 *     validates the document and writes it signed (in place unless [out])
 *
 * When organization-keys.json sits beside managed.json, DSH Desktop Pro accepts
 * only a managed.json signed by one of those keys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateOrganizationKey, isSignedDocument, signDocument, validateDesiredState } from '@dsh-desktop-pro/protocol'

const [command, first, second, third] = process.argv.slice(2)
const fail = (message) => { console.error(message); process.exit(1) }

if (command === 'generate' && first !== undefined) {
  mkdirSync(first, { recursive: true })
  const keyFile = join(first, 'organization-key.pem')
  if (existsSync(keyFile)) fail(keyFile + ' already exists; refusing to overwrite a signing key')
  const key = generateOrganizationKey()
  writeFileSync(keyFile, key.privateKeyPem, { mode: 0o600 })
  writeFileSync(join(first, 'organization-keys.json'), JSON.stringify({ keys: [key.record] }, null, 2) + '\n')
  console.log('private key: ' + keyFile + '\npublic keys: ' + join(first, 'organization-keys.json') + '\nkey id:      ' + key.record.keyId)
} else if (command === 'sign' && first !== undefined && second !== undefined) {
  const parsed = JSON.parse(readFileSync(first, 'utf8'))
  const payload = isSignedDocument(parsed) ? parsed.payload : parsed
  const checked = validateDesiredState(payload)
  if (!checked.ok) fail('managed.json is invalid at ' + checked.path + ': ' + checked.reason)
  writeFileSync(third ?? first, JSON.stringify(signDocument(checked.value, readFileSync(second, 'utf8')), null, 2) + '\n')
  console.log('signed revision ' + String(checked.value.revision) + ' → ' + (third ?? first))
} else {
  fail('usage:\n  node scripts/org-key.mjs generate <dir>\n  node scripts/org-key.mjs sign <managed.json> <organization-key.pem> [out]')
}
