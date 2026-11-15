/**
 * The enterprise reconciler and managed sources, without Electron.
 *
 * Reconcile: idempotent, drift-correcting, never touching what it did not
 * write, and fully removable. Sources: personal / file / server / invalid,
 * signed file mode, and fail-closed handling of broken files.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateOrganizationKey, signDocument } from '@dsh-desktop-pro/protocol'
import { applyDesiredState, LEDGER_FILE, MANAGED_BLOCK_START, patchWithManagedBlock, removeManagedConfiguration } from '../src/main/enterprise/reconcile.ts'
import { loadManagedSource } from '../src/main/enterprise/managed-source.ts'
import { planPluginSync } from '../src/main/enterprise/plugin-sync.ts'
import { createGuard, DEFAULT_MESSAGE, maskableNames } from '../src/main/enterprise/policy-plugin.ts'

const work = mkdtempSync(join(tmpdir(), 'dsh-enterprise-reconcile-'))
const TEMPLATE = '# Your patch layer\n[]\n'
let homes = 0
function home({ patch = TEMPLATE, credentials, bundles = ['@deepseek-ai/dsh-base'], dependencies = {} } = {}) {
  const dir = join(work, 'h' + String(++homes))
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'web', 'cordis.patch.yml'), patch)
  writeFileSync(join(dir, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies, dsh: { profile: { bundles } } }, null, 2))
  if (credentials !== undefined) writeFileSync(join(dir, '.credentials.yaml'), credentials, { mode: 0o600 })
  return dir
}
const read = (dir, ...path) => readFileSync(join(dir, ...path), 'utf8')
const base = { schema: 'dsh-desktop-pro/desired-state', version: 1, revision: 1, issuedAt: '2026-11-15T00:00:00Z', organization: { id: 'acme', name: 'Acme' } }
const state = {
  ...base,
  models: { providers: { gw: { api: 'openai-completions', baseURL: 'https://gw.acme.example/v1', credential: 'DSH_ORG_KEY', models: [{ id: 'm' }] } } },
  credentials: { DSH_ORG_KEY: 'sk-1' },
  plugins: { indexes: ['https://idx.acme.example/index.json'] },
  skills: [{ name: 'acme', files: { 'SKILL.md': 'v1', 'ref/notes.md': 'notes' } }],
  tools: { deny: ['bash'] },
}
const policy = '/opt/dsh-desktop/policy-plugin.mjs'

try {
  {
    const userCredentials = 'version: 1\nrefs:\n  MY_OWN_KEY: mine\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: s\n'
    const dir = home({ credentials: userCredentials })
    assert.deepEqual(applyDesiredState(state, { dshHome: dir, policyPluginPath: policy }), { problems: [], changed: true })
    assert.deepEqual(applyDesiredState(state, { dshHome: dir, policyPluginPath: policy }), { problems: [], changed: false }, 'idempotent')
    const credentials = read(dir, '.credentials.yaml')
    assert.match(credentials, /DSH_ORG_KEY: sk-1/)
    assert.match(credentials, /MY_OWN_KEY: mine/, 'the person\'s own credential stays')
    assert.match(credentials, /client-connection\/browser-session/, 'records stay')
    assert.ok(JSON.parse(read(dir, 'profiles', 'web', 'package.json')).dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-plugin-market-bundle'))
    assert.equal(read(dir, 'skills', 'acme', 'ref', 'notes.md'), 'notes')

    // Drift: a hand edit inside the block and a deleted skill come back.
    const drifted = read(dir, 'profiles', 'web', 'cordis.patch.yml').replace('- bash', '- nothing')
    writeFileSync(join(dir, 'profiles', 'web', 'cordis.patch.yml'), drifted)
    rmSync(join(dir, 'skills', 'acme'), { recursive: true })
    assert.equal(applyDesiredState(state, { dshHome: dir, policyPluginPath: policy }).changed, true)
    assert.match(read(dir, 'profiles', 'web', 'cordis.patch.yml'), /- bash/)
    assert.ok(existsSync(join(dir, 'skills', 'acme', 'SKILL.md')))
    console.log('✓ apply is idempotent, keeps the person\'s credentials, and corrects drift')

    // A narrower document removes exactly what the old one added.
    const next = { ...base, revision: 2, skills: [{ name: 'acme', files: { 'SKILL.md': 'v2' } }] }
    applyDesiredState(next, { dshHome: dir, policyPluginPath: policy })
    assert.doesNotMatch(read(dir, '.credentials.yaml'), /DSH_ORG_KEY/)
    assert.match(read(dir, '.credentials.yaml'), /MY_OWN_KEY/)
    assert.equal(existsSync(join(dir, 'skills', 'acme', 'ref')), false, 'stale skill files go')
    assert.equal(read(dir, 'skills', 'acme', 'SKILL.md'), 'v2')
    assert.equal(JSON.parse(read(dir, 'profiles', 'web', 'package.json')).dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-plugin-market-bundle'), false)
    assert.doesNotMatch(read(dir, 'profiles', 'web', 'cordis.patch.yml'), new RegExp(MANAGED_BLOCK_START.slice(2, 20)))

    removeManagedConfiguration({ dshHome: dir })
    assert.equal(existsSync(join(dir, 'skills', 'acme')), false)
    assert.equal(existsSync(join(dir, LEDGER_FILE)), false)
    assert.match(read(dir, '.credentials.yaml'), /MY_OWN_KEY/)
    assert.equal(read(dir, 'profiles', 'web', 'cordis.patch.yml'), TEMPLATE, 'the patch layer returns to the user template')
    console.log('✓ a narrower document and a wipe remove only what the client wrote')
  }
  {
    const dir = home()
    mkdirSync(join(dir, 'skills', 'acme'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'acme', 'SKILL.md'), 'personal')
    const result = applyDesiredState(state, { dshHome: dir })
    assert.equal(read(dir, 'skills', 'acme', 'SKILL.md'), 'personal', 'a skill the person wrote is never replaced')
    assert.ok(result.problems.some(problem => /acme/.test(problem)))
    assert.ok(result.problems.some(problem => /policy plugin/.test(problem)), 'a missing policy plugin is reported, not silent')
    console.log('✓ a same-named personal skill and a missing policy plugin are reported, not overwritten')
  }
  {
    const userPatch = '# mine\n- id: webserver\n  config:\n    port: !!js "Number(3090)"\n'
    const next = patchWithManagedBlock(userPatch, [{ id: 'x', disabled: true }])
    assert.ok(next.startsWith(userPatch), 'user rows, comments and !!js stay byte for byte')
    assert.equal(patchWithManagedBlock(patchWithManagedBlock(next, [{ id: 'y', disabled: true }]), []), userPatch, 'blocks replace and remove cleanly')
    assert.equal(patchWithManagedBlock('[{ id: webserver }]\n', [{ id: 'x' }]), undefined, 'flow lists are not edited')
    const unreadable = home({ credentials: 'version: 1\nrefs: [broken\n' })
    const result = applyDesiredState(state, { dshHome: unreadable, policyPluginPath: policy })
    assert.ok(result.problems.some(problem => /credential file/.test(problem)))
    assert.equal(read(unreadable, '.credentials.yaml'), 'version: 1\nrefs: [broken\n', 'an unparsable credential file is never overwritten')
    console.log('✓ patch and credential files in shapes the client cannot edit are left untouched')
  }
  {
    const dir = home({ bundles: ['a', 'dsh-purge'], dependencies: { a: '1.0.0', 'dsh-purge': '1.0.0' } })
    mkdirSync(join(dir, 'profiles', 'web', 'node_modules', 'a'), { recursive: true })
    writeFileSync(join(dir, 'profiles', 'web', 'node_modules', 'a', 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const plan = planPluginSync({ ...base, plugins: { required: [{ name: 'a', spec: 'a@1.0.0' }, { name: 'b', spec: 'b@2.0.0' }], blocked: ['dsh-purge'] } }, dir)
    assert.deepEqual(plan, { install: [{ name: 'b', spec: 'b@2.0.0' }], remove: ['dsh-purge'] })
    const upgrade = planPluginSync({ ...base, plugins: { required: [{ name: 'a', spec: 'a@1.1.0' }] } }, dir)
    assert.deepEqual(upgrade.install, [{ name: 'a', spec: 'a@1.1.0' }], 'a different pinned version is reinstalled')
    console.log('✓ plugin sync installs missing or mis-versioned required plugins and removes blocked ones')
  }
  {
    const guard = createGuard({ deny: ['bash'], message: 'no' })
    assert.equal(guard({ name: 'bash' }), 'no')
    assert.equal(guard({ name: 'read' }), undefined)
    assert.equal(createGuard({ deny: ['bash'] })({ name: 'bash' }), DEFAULT_MESSAGE)
    const recorded = []
    const recording = createGuard({ deny: ['bash'] }, tool => recorded.push(tool))
    recording({ name: 'read' })
    recording({ name: 'bash' })
    assert.deepEqual(recorded, ['bash'], 'only refused calls are recorded, by name')
    assert.deepEqual(maskableNames({ deny: ['bash', 'run_code', 'missing'] }, name => name !== 'missing'), ['bash'], 'present tools are masked; the code-mode transport stays guarded only')
    console.log('✓ the policy guard denies exactly the listed tools, records refusals, and masks them from agents')
  }
  {
    const dir = (name) => { const d = join(work, 'managed-' + name); mkdirSync(d); return d }
    assert.equal(loadManagedSource(dir('none')).kind, 'personal')
    const plain = dir('plain')
    writeFileSync(join(plain, 'managed.json'), JSON.stringify(state))
    assert.deepEqual([loadManagedSource(plain).kind, loadManagedSource(plain).signed], ['file', false])

    const org = generateOrganizationKey()
    const signed = dir('signed')
    writeFileSync(join(signed, 'organization-keys.json'), JSON.stringify({ keys: [org.record] }))
    writeFileSync(join(signed, 'managed.json'), JSON.stringify(signDocument(state, org.privateKeyPem)))
    assert.deepEqual([loadManagedSource(signed).kind, loadManagedSource(signed).signed], ['file', true])
    writeFileSync(join(signed, 'managed.json'), JSON.stringify(state))
    assert.equal(loadManagedSource(signed).kind, 'invalid', 'pinned keys require a signature')
    const tampered = signDocument(state, org.privateKeyPem)
    tampered.payload.tools.deny = []
    writeFileSync(join(signed, 'managed.json'), JSON.stringify(tampered))
    assert.match(loadManagedSource(signed).reason, /does not verify/)

    const broken = dir('broken')
    writeFileSync(join(broken, 'managed.json'), '{ not json')
    assert.equal(loadManagedSource(broken).kind, 'invalid', 'a broken file fails closed')
    const server = dir('server')
    writeFileSync(join(server, 'enrollment.json'), JSON.stringify({ schema: 'dsh-desktop-pro/enrollment', version: 1, server: 'https://dsh.acme.example', organization: { id: 'acme', name: 'Acme' }, keys: [org.record] }))
    writeFileSync(join(server, 'managed.json'), JSON.stringify(state))
    assert.equal(loadManagedSource(server).kind, 'server', 'an enrollment wins over a managed file')
    console.log('✓ managed sources: personal, file, signed file, server, and fail-closed invalid files')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
