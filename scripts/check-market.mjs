/**
 * The organisation market, end to end: the real management server, a fake
 * public plugin index, and the desktop client's real ServerSession.
 *
 * Covers: reading a public index (malformed entries skipped), approving one
 * pinned version and entering an internal plugin by hand, the organisation
 * index served in format 1 (checked with the official validator) behind a
 * per-person address that stops working when the person is disabled, blocked
 * plugins reaching everyone's document, and the skill library: skills for
 * everyone, optional skills a person installs from the client, profile skills
 * of the same name winning, and every change audited.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateEnrollment } from '@dsh-desktop-pro/protocol'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { openDb } from '../apps/server/src/db.ts'
import { compareSemver, readSourceDocument } from '../apps/server/src/market.ts'
import { PLAIN_CODEC, ServerSession } from '../src/main/enterprise/server-session.ts'

// The official validator, from the bundled DSH runtime's dependencies. pnpm
// shortens long store directory names to a hash on Windows, so find the package
// by what the directory holds, not by how the directory is spelled.
const store = join(import.meta.dirname, '..', 'node_modules', '.pnpm')
const validatorEntry = readdirSync(store)
  .map(name => join(store, name, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js'))
  .find(entry => existsSync(entry))
assert.ok(validatorEntry, 'the official plugin index validator is installed with the DSH runtime')
const { parseMarketIndex } = await import(pathToFileURL(validatorEntry).href)

const COMMIT = 'a'.repeat(40)
const PNG = 'data:image/png;base64,' + Buffer.from('not really a png').toString('base64')
const publicIndex = {
  format: 1,
  title: { en: 'Community picks', zh: '社区精选' },
  metadata: { categories: { tools: { title: { en: 'Tools', zh: '工具' } } }, labels: { hot: { title: 'Hot' } } },
  plugins: [
    {
      name: 'dsh-weekly', title: { en: 'Weekly report', zh: '周报助手' }, description: 'Drafts a weekly report from your commits.', author: 'Ann',
      icon: PNG, homepage: 'https://example.com/weekly', repository: { url: 'https://github.com/ann/dsh-weekly' },
      metadata: { category: 'tools', keywords: ['report', '周报'], labels: ['hot'], sortKeys: { stars: 9 } },
      versions: [
        { version: '1.2.0', publishTimestamp: 1_790_000_000, source: { type: 'npm' }, engines: { dsh: '>=0.2.0' } },
        { version: '1.10.0', publishTimestamp: 1_791_000_000, source: { type: 'npm' } },
        { version: '2.0.0-beta.1', publishTimestamp: 1_792_000_000, source: { type: 'npm' } },
      ],
    },
    {
      name: '@acme/git-tool', title: 'Git tool', icon: 'icons/git.svg',
      metadata: { category: 'undeclared' },
      versions: [{ version: '0.3.1', publishTimestamp: 1_790_500_000, source: { type: 'git', url: 'https://github.com/acme/git-tool', commit: COMMIT, path: 'packages/tool' } }],
    },
    { name: 'Bad Name', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] },
    { name: 'no-versions', versions: [{ version: 'latest', publishTimestamp: 1, source: { type: 'npm' } }] },
  ],
}

assert.ok(compareSemver('1.10.0', '1.2.0') > 0 && compareSemver('2.0.0', '2.0.0-beta.1') > 0)
{
  const doc = readSourceDocument(publicIndex, 'https://index.example/plugins/index.json')
  assert.deepEqual([...doc.plugins.keys()], ['dsh-weekly', '@acme/git-tool'], 'entries without a valid name or exact version are skipped')
  assert.deepEqual(doc.plugins.get('dsh-weekly').versions.map(entry => entry.version), ['2.0.0-beta.1', '1.10.0', '1.2.0'], 'versions are in SemVer order')
  assert.equal(doc.plugins.get('@acme/git-tool').icon, 'https://index.example/plugins/icons/git.svg', 'a relative icon resolves against its index')
  assert.equal(doc.plugins.get('@acme/git-tool').category, undefined, 'an undeclared category is dropped')
  console.log('✓ a public index is read leniently: bad entries are skipped, icons resolved, versions ordered')
}

const work = mkdtempSync(join(tmpdir(), 'dsh-market-check-'))
let served = publicIndex
const indexServer = createServer((req, res) => {
  if (req.url === '/broken.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"format": 2}'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(served))
})
await new Promise(resolve => indexServer.listen(0, '127.0.0.1', resolve))
const indexBase = 'http://127.0.0.1:' + String(indexServer.address().port)

const config = loadConfig({
  DSH_PUBLIC_URL: 'http://127.0.0.1', DSH_SERVER_SECRET: 'm'.repeat(40), PORT: '0', HOST: '127.0.0.1',
  DSH_TENANT_ID: 'acme', DSH_TENANT_NAME: 'Acme', DSH_DEV_LOGIN: '1', DSH_BOOTSTRAP_TOKEN: 'bootstrap-secret',
})
const app = await createApp({ config, db: await openDb(process.env.DSH_CHECK_DATABASE_URL ?? 'sqlite:' + join(work, 'server.sqlite')) })
const base = await app.listen()
config.publicUrl = base

let cookie = ''
async function admin(method, path, body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...body !== undefined && { 'content-type': 'application/json' } }, ...body !== undefined && { body: JSON.stringify(body) } })
  return { status: response.status, body: await response.json() }
}
function browserFor(email) {
  return async (url) => {
    const page = await fetch(url, { redirect: 'manual' })
    const flow = /name="flow" value="([^"]+)"/.exec(await page.text())?.[1]
    const submitted = await fetch(base + '/v1/auth/dev', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ flow, email }) })
    await fetch(submitted.headers.get('location'))
  }
}

try {
  const login = await fetch(base + '/admin/api/session', { method: 'POST', body: JSON.stringify({ token: 'bootstrap-secret' }) })
  cookie = login.headers.get('set-cookie').split(';')[0]
  const alice = (await admin('POST', '/admin/api/users', { name: 'Alice', email: 'alice@acme.example' })).body
  await admin('POST', '/admin/api/users', { name: 'Bob', email: 'bob@acme.example' })
  const enrollment = validateEnrollment((await admin('GET', '/admin/api/enrollment')).body).value
  const sessionFor = (name) => new ServerSession({ enrollment, home: join(work, name), secrets: PLAIN_CODEC, openBrowser: browserFor(name + '@acme.example'), clientVersion: '1.0.0', signInTimeoutMs: 3000 })
  const session = sessionFor('alice')
  await session.signIn()
  const bob = sessionFor('bob')
  await bob.signIn()

  let state = await session.fetchDesiredState()
  assert.equal(state.plugins, undefined, 'an empty market adds nothing to the document')

  // ---- sources ----
  assert.equal((await admin('POST', '/admin/api/market/sources', { url: indexBase + '/broken.json' })).body.error, 'invalid_index')
  const source = (await admin('POST', '/admin/api/market/sources', { url: indexBase + '/index.json' })).body
  assert.equal(source.pluginCount, 2)
  assert.deepEqual(source.title, { en: 'Community picks', zh: '社区精选' })
  assert.equal((await admin('POST', '/admin/api/market/sources', { url: indexBase + '/index.json' })).status, 409, 'a source is added once')
  const page = (await admin('GET', '/admin/api/market/sources/' + source.id + '/plugins?q=周报')).body
  assert.deepEqual([page.total, page.entries[0].name, page.entries[0].company], [1, 'dsh-weekly', null], 'search covers translated titles and keywords')
  console.log('✓ a public index is added as a source and searched from the console')

  // ---- approving ----
  const approved = (await admin('POST', '/admin/api/market/plugins', { sourceId: source.id, name: 'dsh-weekly', version: '1.10.0', note: 'Reviewed by IT', featured: true })).body
  assert.equal(approved.version.version, '1.10.0')
  assert.equal((await admin('POST', '/admin/api/market/plugins', { sourceId: source.id, name: 'dsh-weekly', version: '9.9.9' })).body.error, 'version_not_in_source')
  const internal = (await admin('POST', '/admin/api/market/plugins', {
    name: '@acme/crm', version: '3.1.0', source: { type: 'npm', registry: 'https://npm.acme.example/' }, title: 'CRM lookup', description: 'Look up customers in the company CRM.',
  })).body
  assert.equal(internal.version.source.registry, 'https://npm.acme.example/')
  assert.equal((await admin('POST', '/admin/api/market/plugins', { name: 'x', version: '1.0', source: { type: 'npm' } })).body.error, 'invalid_plugin_version', 'only exact versions are approved')
  assert.equal((await admin('POST', '/admin/api/market/plugins', { name: 'x', version: '1.0.0', source: { type: 'git', url: 'https://github.com/a/b', commit: 'main' } })).body.error, 'invalid_plugin_version', 'Git sources pin a commit')
  // Refreshing the source keeps the approved copy as it was reviewed.
  served = { ...publicIndex, plugins: publicIndex.plugins.map(plugin => plugin.name === 'dsh-weekly' ? { ...plugin, description: 'Changed upstream.' } : plugin) }
  await admin('POST', '/admin/api/market/sources/' + source.id + '/refresh')
  assert.equal((await admin('GET', '/admin/api/market')).body.plugins.find(item => item.name === 'dsh-weekly').description, 'Drafts a weekly report from your commits.')
  console.log('✓ one pinned version is approved from a source; internal plugins are entered by hand')

  // ---- the organisation index ----
  state = await session.fetchDesiredState()
  const indexUrl = state.plugins.indexes[0]
  assert.match(indexUrl, new RegExp('^' + base.replace(/[.]/g, '\\.') + '/v1/market/[^/]+/index\\.json$'), 'the organisation index comes first in the document')
  const bobUrl = (await bob.fetchDesiredState()).plugins.indexes[0]
  assert.notEqual(bobUrl, indexUrl, 'every person has their own index address')
  const index = await (await fetch(indexUrl)).json()
  const parsed = parseMarketIndex(index, indexUrl)
  assert.deepEqual(parsed.plugins.map(plugin => plugin.name), ['dsh-weekly', '@acme/crm'], 'recommended plugins come first')
  assert.deepEqual(parsed.plugins[0].versions.map(entry => entry.version), ['1.10.0'], 'only the approved version is listed')
  assert.deepEqual(parsed.plugins[0].metadata.labels, ['recommended'])
  assert.equal(parsed.plugins[1].versions[0].source.registry, 'https://npm.acme.example/')
  assert.equal(parsed.title.zh, 'Acme 精选插件')
  assert.equal((await fetch(indexUrl.replace(/\.[^./]+\/index\.json$/, '.forged/index.json'))).status, 404, 'a forged address is refused')
  console.log('✓ the organisation index passes the official format 1 validator, behind a per-person address')

  // ---- blocking ----
  await admin('POST', '/admin/api/market/blocked', { name: 'evil-plugin', note: 'Uploads files' })
  state = await session.fetchDesiredState()
  assert.deepEqual(state.plugins.blocked, ['evil-plugin'], 'blocked plugins reach every document')
  const profile = (await admin('POST', '/admin/api/profiles', { name: 'Team', spec: { plugins: { required: [{ name: 'evil-plugin', spec: 'evil-plugin@1.0.0' }], blocked: ['other'] } } })).body
  const binding = (await admin('POST', '/admin/api/bindings', { profileId: profile.id, targetType: 'tenant' })).body
  state = await session.fetchDesiredState()
  assert.deepEqual(state.plugins.blocked, ['evil-plugin', 'other'], 'a profile adds to the blocked list')
  assert.deepEqual(state.plugins.required, [], 'a blocked plugin is never required')
  await admin('DELETE', '/admin/api/bindings/' + binding.id)
  await admin('DELETE', '/admin/api/market/plugins/evil-plugin')
  console.log('✓ blocked plugins are added to every person\'s document and win over required ones')

  // ---- skills ----
  const skillFiles = { 'SKILL.md': '---\nname: weekly\ndescription: Weekly report format\n---\n\nUse headings.\n' }
  assert.equal((await admin('PUT', '/admin/api/skills/Bad%20Id', { title: 'x', distribution: 'everyone', files: skillFiles })).body.error, 'invalid_skill')
  assert.equal((await admin('PUT', '/admin/api/skills/weekly', { title: 'x', distribution: 'everyone', files: { 'README.md': 'x' } })).body.error, 'invalid_skill', 'a skill needs SKILL.md')
  await admin('PUT', '/admin/api/skills/weekly', { title: 'Weekly report', distribution: 'everyone', files: skillFiles })
  await admin('PUT', '/admin/api/skills/contract-review', { title: 'Contract review', description: 'What legal checks first', distribution: 'optional', files: { 'SKILL.md': '# Contract review\n', 'checklist.md': '- parties\n' } })
  state = await session.fetchDesiredState()
  assert.deepEqual(state.skills.map(skill => skill.name), ['weekly'], 'skills for everyone are delivered; optional ones wait for the person')
  let listed = await session.listSkills()
  assert.deepEqual(listed.map(skill => [skill.id, skill.distribution, skill.installed]), [['contract-review', 'optional', false], ['weekly', 'everyone', true]])
  const before = state.revision
  listed = await session.setSkill('contract-review', true)
  assert.equal(listed.find(skill => skill.id === 'contract-review').installed, true)
  state = await session.fetchDesiredState()
  assert.ok(state.revision > before, 'installing a skill raises the revision, so the client fetches again')
  assert.deepEqual(state.skills.map(skill => skill.name).sort(), ['contract-review', 'weekly'])
  assert.equal(state.skills.find(skill => skill.name === 'contract-review').files['checklist.md'], '- parties\n')
  assert.deepEqual((await bob.fetchDesiredState()).skills.map(skill => skill.name), ['weekly'], 'one person\'s choice does not reach another')
  await assert.rejects(session.setSkill('weekly', false), /HTTP 409/, 'a skill for everyone cannot be removed by one person')
  const detail = (await admin('GET', '/admin/api/skills/contract-review')).body
  assert.deepEqual([detail.subscribers, detail.subscriberIds], [1, [alice.id]])
  // Editing the files raises the version; editing only the title does not.
  await admin('PUT', '/admin/api/skills/weekly', { title: 'Weekly report v2', distribution: 'everyone', files: skillFiles })
  assert.equal((await admin('GET', '/admin/api/skills/weekly')).body.version, 1)
  await admin('PUT', '/admin/api/skills/weekly', { title: 'Weekly report', distribution: 'everyone', files: { 'SKILL.md': skillFiles['SKILL.md'] + 'Keep it short.\n' } })
  assert.equal((await admin('GET', '/admin/api/skills/weekly')).body.version, 2)
  // A profile's skill of the same name wins over the library's.
  const own = (await admin('POST', '/admin/api/profiles', { name: 'Own', spec: { skills: [{ name: 'weekly', files: { 'SKILL.md': '# Team version\n' } }] } })).body
  const ownBinding = (await admin('POST', '/admin/api/bindings', { profileId: own.id, targetType: 'user', targetId: alice.id })).body
  state = await session.fetchDesiredState()
  assert.equal(state.skills.find(skill => skill.name === 'weekly').files['SKILL.md'], '# Team version\n')
  await admin('DELETE', '/admin/api/bindings/' + ownBinding.id)
  await admin('DELETE', '/admin/api/skills/contract-review')
  assert.deepEqual((await session.listSkills()).map(skill => skill.id), ['weekly'])
  assert.deepEqual((await session.fetchDesiredState()).skills.map(skill => skill.name), ['weekly'], 'a deleted skill leaves every document')
  console.log('✓ the skill library delivers skills for everyone, and optional ones each person installs')

  // ---- people leaving, and the audit trail ----
  await admin('PATCH', '/admin/api/users/' + alice.id, { status: 'disabled' })
  assert.equal((await fetch(indexUrl)).status, 404, 'a disabled person\'s index address stops working')
  const actions = new Set((await admin('GET', '/admin/api/audit?limit=200')).body.map(event => event.action))
  for (const action of ['market.source.added', 'market.plugin.approved', 'market.plugin.blocked', 'market.plugin.unblocked', 'skill.created', 'skill.updated', 'skill.installed', 'skill.deleted']) {
    assert.ok(actions.has(action), action + ' is audited')
  }
  assert.equal((await admin('GET', '/admin/api/audit/verify')).body.ok, true)
  console.log('✓ a disabled person\'s index stops working; market and skill changes are audited')
} finally {
  await app.close()
  indexServer.close()
  rmSync(work, { recursive: true, force: true })
}
