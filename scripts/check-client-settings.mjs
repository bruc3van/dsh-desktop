/** Settings read diagnostics must explain corruption without echoing file contents. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const home = mkdtempSync(join(tmpdir(), 'dsh-client-settings-'))
const originalWarn = console.warn
try {
  const outfile = join(home, 'store.mjs')
  await build({ entryPoints: ['src/main/client-settings.ts'], bundle: true, platform: 'node', format: 'esm', outfile })
  const { createClientSettingsStore } = await import(pathToFileURL(outfile).href)
  const store = createClientSettingsStore(home)
  const warnings = []
  console.warn = (...parts) => { warnings.push(parts.join(' ')) }
  assert.deepEqual(store.loadSettings(), {})
  assert.equal(warnings.length, 0, 'first launch is not an error')
  const file = join(home, 'settings.json')
  writeFileSync(file, '{"serverUrl":"DO_NOT_LOG_FIXTURE_CONTENT",')
  assert.deepEqual(store.loadSettings(), {})
  store.loadSettings()
  assert.equal(warnings.length, 1, 'polling does not flood diagnostics')
  assert.match(warnings[0], /invalid JSON/)
  assert.ok(!warnings[0].includes('DO_NOT_LOG_FIXTURE_CONTENT'))
  assert.ok(!warnings[0].includes(home))
  writeFileSync(file, '{"connectionMode":"connect","serverUrl":"http://localhost:1234"}')
  assert.equal(store.loadSettings().connectionMode, 'connect')
  store.patchSettings({ updateDismissedVersion: '1.2.3' })
  assert.equal(store.loadSettings().serverUrl, 'http://localhost:1234')
  rmSync(file)
  mkdirSync(file)
  assert.deepEqual(store.loadSettings(), {})
  assert.equal(warnings.length, 2, 'a later failure after recovery is reported')
  assert.match(warnings[1], /read failed/)
} finally {
  console.warn = originalWarn
  rmSync(home, { recursive: true, force: true })
}
console.log('client-settings: PASS (quiet first launch, bounded diagnostics, no content leakage, recovery)')
