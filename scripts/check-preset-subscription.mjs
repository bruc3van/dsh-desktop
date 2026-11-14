/**
 * The preset subscription is a one-time offer that never fights the user.
 *
 * Fixture cases cover every profile shape the offer may meet. With
 * `--runtime`, the offer also runs against the prepared runtime closure: the
 * real `initProfile()` creates a first-ever profile, and the real loader must
 * resolve the market row with the preset index (`--dump-config`).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  offerPresetSubscription,
  patchWithMarketRow,
  PLUGIN_MARKET_BUNDLE,
  PRESET_INDEX_URL,
  PRESET_RECORD_FILE,
} from '../src/main/preset-subscription.ts'
import { preparePresetSubscription } from '../src/main/preset-subscription-boot.ts'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
  + '# a top-level YAML array of loader patch entries (id-targeted config\n'
  + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
  + '[]\n'
const work = mkdtempSync(join(tmpdir(), 'dsh-desktop-preset-'))
let homes = 0

function profile({ bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patch, extra = {} } = {}) {
  const home = join(work, 'home-' + String(++homes))
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, ...extra, dsh: { profile: { bundles } } }, null, 2) + '\n')
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  return {
    home,
    bundles: () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh.profile.bundles,
    manifest: () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    patch: () => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'),
    recorded: () => existsSync(join(home, PRESET_RECORD_FILE)),
  }
}

function indexesIn(patch) {
  return /- id: plugin-market\r?\n\s+name: "@deepseek-ai\/dsh-plugin-market"\r?\n\s+config:\r?\n\s+indexes:\r?\n\s+- (\S+)/.exec(patch)?.[1]
}

try {
  {
    const p = profile({ patch: TEMPLATE, extra: { dependencies: { 'dsh-user-plugin': '1.0.0' } } })
    assert.equal(offerPresetSubscription(p.home, true), 'offered')
    assert.deepEqual(p.bundles(), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_MARKET_BUNDLE])
    assert.deepEqual(p.manifest().dependencies, { 'dsh-user-plugin': '1.0.0' }, 'user dependencies survive')
    assert.equal(indexesIn(p.patch()), PRESET_INDEX_URL)
    assert.ok(p.patch().startsWith(TEMPLATE.slice(0, TEMPLATE.lastIndexOf('[]'))), 'template comments are kept')
    assert.doesNotMatch(p.patch(), /^\[\]$/m, 'the empty-array line is replaced, not left beside a block entry')
    assert.ok(p.recorded())
    // The user removes the source and turns the market off: it stays that way.
    writeFileSync(join(p.home, 'profiles/web/cordis.patch.yml'), TEMPLATE)
    writeFileSync(join(p.home, 'profiles/web/package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    assert.equal(offerPresetSubscription(p.home, true), 'already-offered')
    assert.equal(p.patch(), TEMPLATE)
    assert.deepEqual(p.bundles(), [])
    console.log('✓ a fresh profile gets the market and the preset index once; removal is respected')
  }
  {
    const userPatch = '# --- dsh-skin managed (auto-generated; do not edit) ---\n'
      + '- id: ui-skin-orca-link\n  disabled: true\n'
      + '# --- end dsh-skin managed ---\n'
      + '- id: webserver\n  config:\n    port: !!js "Number(process.env.PORT ?? 3080)"\n'
      + '- insert:\n    # magpie\n    - id: magpie-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n'
    const p = profile({ patch: userPatch })
    assert.equal(offerPresetSubscription(p.home, true), 'offered')
    assert.ok(p.patch().startsWith(userPatch), 'every existing byte, comment and !!js expression is kept')
    assert.equal(indexesIn(p.patch()), PRESET_INDEX_URL)
    console.log('✓ a user block sequence is appended to, never re-serialised')
  }
  {
    const crlf = TEMPLATE.replace(/\n/g, '\r\n')
    const p = profile({ patch: crlf })
    assert.equal(offerPresetSubscription(p.home, true), 'offered')
    assert.doesNotMatch(p.patch().replace(/\r\n/g, ''), /\n/, 'CRLF line endings are kept')
    assert.equal(indexesIn(p.patch()), PRESET_INDEX_URL)
    console.log('✓ a CRLF patch layer keeps its line endings')
  }
  for (const [label, patch] of [
    ['an existing market row', '- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n  config:\n    indexes: []\n'],
    ['a market row inside an insert list', '- insert:\n    - id: plugin-market\n      name: "@deepseek-ai/dsh-plugin-market"\n'],
  ]) {
    const p = profile({ patch, bundles: ['@deepseek-ai/dsh-base'] })
    assert.equal(offerPresetSubscription(p.home, true), 'user-configured', label)
    assert.equal(p.patch(), patch, label + ' is left exactly as written')
    assert.deepEqual(p.bundles(), ['@deepseek-ai/dsh-base'], label + ': the bundle choice is the user\'s')
    assert.ok(p.recorded(), label + ' is recorded so it is never re-examined')
  }
  console.log('✓ a profile that already configures the market is left alone')
  {
    const p = profile({ patch: TEMPLATE, bundles: ['@deepseek-ai/dsh-base', PLUGIN_MARKET_BUNDLE] })
    assert.equal(offerPresetSubscription(p.home, true), 'offered')
    assert.deepEqual(p.bundles(), ['@deepseek-ai/dsh-base', PLUGIN_MARKET_BUNDLE], 'no duplicate bundle entry')
    console.log('✓ an enabled market without sources only gains the preset index')
  }
  {
    const p = profile({})
    assert.equal(offerPresetSubscription(p.home, true), 'offered', 'a missing patch layer is created')
    assert.equal(indexesIn(p.patch()), PRESET_INDEX_URL)
  }
  for (const [label, patch] of [
    ['a non-empty flow sequence', '[{ id: webserver, config: { port: 3090 } }]\n'],
    ['a mapping', 'id: webserver\n'],
    ['invalid YAML', '- id: [unterminated\n'],
  ]) {
    const p = profile({ patch })
    assert.equal(offerPresetSubscription(p.home, true), 'unsupported-profile', label)
    assert.equal(p.patch(), patch, label + ' is not touched')
    assert.equal(p.bundles().includes(PLUGIN_MARKET_BUNDLE), false, label + ': no half edit')
  }
  console.log('✓ patch layers in shapes the client does not edit are left untouched')
  {
    const p = profile({ patch: TEMPLATE })
    assert.equal(offerPresetSubscription(p.home, false), 'unsupported-profile')
    assert.equal(p.patch(), TEMPLATE)
    assert.equal(p.recorded(), false, 'a later runtime that ships the bundle may still offer it')
    const empty = join(work, 'no-profile')
    mkdirSync(empty)
    assert.equal(offerPresetSubscription(empty, true), 'no-profile')
    assert.equal(existsSync(join(empty, PRESET_RECORD_FILE)), false)
    console.log('✓ a runtime without the market bundle, or a home without a profile, gets no edit and no record')
  }
  assert.equal(patchWithMarketRow('  - id: indented\n', PRESET_INDEX_URL), undefined, 'an indented sequence is not guessed at')

  if (process.argv.includes('--runtime')) {
    const entry = join(APP_DIR, '.runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(entry)) throw new Error('prepared runtime missing; run pnpm run prepare:runtime first: ' + entry)
    const home = join(work, 'runtime-home')
    await preparePresetSubscription(entry, { home })
    const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.equal(indexesIn(patch), PRESET_INDEX_URL, 'the real initProfile template was edited')
    const dump = spawnSync(process.execPath, [entry, '--profile', 'web', '--dump-config'], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 120_000,
    })
    assert.equal(dump.status, 0, dump.stderr)
    const row = /^- id: plugin-market\n(?:\s+.*\n)*?\s+indexes:\n\s+- (\S+)/m.exec(dump.stdout)
    assert.equal(row?.[1], PRESET_INDEX_URL, 'the real loader resolves the market row with the preset index')
    console.log('✓ the prepared runtime boots a first-ever profile with the market and the preset index')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
