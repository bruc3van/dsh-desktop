/** The shared protocol: validation, signatures, profile merge and device proofs. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  canonicalJson, checkDeviceProof, createDeviceProof, generateOrganizationKey, mergeProfiles, signDocument,
  usableOffline, validateDesiredState, validateEnrollment, validateProfileSpec, verifyDocument,
} from '@dsh-desktop-pro/protocol'

const base = {
  schema: 'dsh-desktop-pro/desired-state', version: 1, revision: 3, issuedAt: '2026-11-15T00:00:00Z',
  organization: { id: 'acme', name: 'Acme' },
}
const full = {
  ...base,
  models: { providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://llm.acme.example/v1', credential: 'DSH_ORG_GATEWAY_KEY', models: [{ id: 'deepseek-chat', contextWindow: 128000 }] } } },
  credentials: { DSH_ORG_GATEWAY_KEY: 'sk-virtual' },
  plugins: { indexes: ['https://market.acme.example/index.json'], registry: 'https://npm.acme.example/', required: [{ name: 'dsh-im', spec: 'dsh-im@1.2.3' }], blocked: ['dsh-purge'] },
  skills: [{ name: 'invoice', files: { 'SKILL.md': '---\nname: invoice\ndescription: x\n---\n' } }],
  tools: { deny: ['bash', 'pwsh'], message: 'Blocked by Acme IT' },
  updates: { feedUrl: 'https://mirror.acme.example/latest.json' }, offline: { graceDays: 3 },
}
assert.equal(validateDesiredState(full).ok, true, JSON.stringify(validateDesiredState(full)))
for (const [label, doc, path] of [
  ['unknown field', { ...base, colour: 'blue' }, '$.colour'],
  ['future version', { ...base, version: 2 }, '$.version'],
  ['floating plugin version', { ...base, plugins: { required: [{ name: 'x', spec: 'x@^1.0.0' }] } }, '$.plugins.required[0].spec'],
  ['unpinned git', { ...base, plugins: { required: [{ name: 'x', spec: 'git+https://example.com/x.git#main' }] } }, '$.plugins.required[0].spec'],
  ['required and blocked', { ...base, plugins: { blocked: ['x'], required: [{ name: 'x', spec: 'x@1.0.0' }] } }, '$.plugins.required[0].name'],
  ['escaping skill path', { ...base, skills: [{ name: 's', files: { 'SKILL.md': '', '../x': '' } }] }, '$.skills[0].files.../x'],
  ['skill without SKILL.md', { ...base, skills: [{ name: 's', files: { 'a.md': '' } }] }, '$.skills[0].files'],
  ['credential-bearing URL', { ...base, plugins: { indexes: ['https://u:p@x.example/i.json'] } }, '$.plugins.indexes[0]'],
  ['lowercase credential', { ...base, credentials: { key: 'v' } }, '$.credentials.key'],
]) {
  const result = validateDesiredState(doc)
  assert.equal(result.ok, false, label)
  assert.equal(result.path, path, label + ': ' + JSON.stringify(result))
}
console.log('✓ desired-state validation accepts the full shape and names the first violation')

assert.equal(canonicalJson({ b: 1, a: [true, { d: null, c: 'x' }], u: undefined }), '{"a":[true,{"c":"x","d":null}],"b":1}')
const org = generateOrganizationKey()
const signed = signDocument(full, org.privateKeyPem)
assert.deepEqual(verifyDocument(JSON.parse(JSON.stringify(signed)), [org.record]), { ok: true, value: full })
const tampered = structuredClone(signed); tampered.payload.tools.deny = []
assert.equal(verifyDocument(tampered, [org.record]).ok, false, 'a changed payload fails')
assert.equal(verifyDocument(signed, [generateOrganizationKey().record]).ok, false, 'an unpinned key fails')
const forged = { ...org.record, keyId: signed.signature.keyId, publicKey: generateOrganizationKey().record.publicKey }
assert.equal(verifyDocument(signed, [forged]).ok, false, 'a key relabelled with another id fails')
console.log('✓ signatures verify only with a pinned key and only for the exact payload')

const enrollment = { schema: 'dsh-desktop-pro/enrollment', version: 1, server: 'https://dsh.acme.example', organization: { id: 'acme', name: 'Acme' }, keys: [org.record] }
assert.equal(validateEnrollment(enrollment).ok, true)
assert.equal(validateEnrollment({ ...enrollment, server: 'https://dsh.acme.example/app' }).ok, false)
assert.equal(validateEnrollment({ ...enrollment, keys: [] }).ok, false)
console.log('✓ enrollment files name an origin and pin at least one key')

const company = validateProfileSpec({ tools: { deny: ['bash'] }, plugins: { blocked: ['dsh-purge'], required: [{ name: 'a', spec: 'a@1.0.0' }] }, offline: { graceDays: 7 } })
const finance = validateProfileSpec({ tools: { deny: ['web_fetch'] }, plugins: { required: [{ name: 'a', spec: 'a@2.0.0' }, { name: 'dsh-purge', spec: 'dsh-purge@1.0.0' }] }, offline: { graceDays: 30 } })
assert.equal(company.ok && finance.ok, true)
const merged = mergeProfiles([company.value, finance.value])
assert.deepEqual(merged.tools.deny, ['bash', 'web_fetch'], 'denials accumulate')
assert.deepEqual(merged.plugins.required, [{ name: 'a', spec: 'a@2.0.0' }], 'specific wins, blocked never required')
assert.equal(merged.offline.graceDays, 7, 'the shorter grace wins')
assert.equal(validateProfileSpec({ credentials: {} }).ok, false, 'profiles never carry credentials')
console.log('✓ profile merge: settings follow the most specific profile, restrictions only accumulate')

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const proof = createDeviceProof(privateKey, 'get', '/v1/desired-state', 1_800_000_000_000)
assert.equal(checkDeviceProof(publicKey, proof, 'GET', '/v1/desired-state', 1_800_000_060_000), true)
assert.equal(checkDeviceProof(publicKey, proof, 'GET', '/v1/status', 1_800_000_060_000), false, 'bound to the path')
assert.equal(checkDeviceProof(publicKey, proof, 'GET', '/v1/desired-state', 1_800_001_000_000), false, 'expires')
const posted = createDeviceProof(privateKey, 'POST', '/v1/status', 1_800_000_000_000, '{"result":"applied"}')
assert.equal(checkDeviceProof(publicKey, posted, 'POST', '/v1/status', 1_800_000_000_000, '{"result":"applied"}'), true)
assert.equal(checkDeviceProof(publicKey, posted, 'POST', '/v1/status', 1_800_000_000_000, '{"result":"failed"}'), false, 'bound to the body')
console.log('✓ device proofs bind method, path, time and body')

const day = 86_400_000
assert.equal(usableOffline({ ...base, offline: { graceDays: 3 } }, 0, 2 * day), true)
assert.equal(usableOffline({ ...base, offline: { graceDays: 3 } }, 0, 4 * day), false)
assert.equal(usableOffline({ ...base, expiresAt: '1970-01-02T00:00:00Z' }, 0, 1.5 * day), false)
console.log('✓ cached documents expire after their grace period')
