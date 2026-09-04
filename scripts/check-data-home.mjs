import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  dshHomeForMode,
  hasIsolatedRuntimeSource,
  isLegacyClientHome,
  isPluginCompatibilityFailure,
  migrateLegacyClientHome,
  normalizeDshDataMode,
} from '../src/main/data-home.ts'

function check(name, condition) {
  if (!condition) throw new Error('check failed: ' + name)
  console.log('✓ ' + name)
}

check('unknown persisted modes fail closed to shared', normalizeDshDataMode('other') === 'shared')
check('shared mode uses the official home', dshHomeForMode('shared', 'user-home', 'client-home') === join('user-home', '.dsh'))
check('isolated mode stays inside the branded client home', dshHomeForMode('isolated', 'user-home', 'client-home') === join('client-home', 'dsh'))
check('probe alone cannot start an isolated environment', !hasIsolatedRuntimeSource(['probe']))
check('a spawnable runtime can start an isolated environment', hasIsolatedRuntimeSource(['probe', 'bundled']))

for (const diagnostic of [
  'Error: plugin(s) failed to load: example.entry',
  'Error: plugin(s) failed to activate: example.entry',
  'Bundle package "old-plugin" was not found',
  "Bundle package 'old-plugin' does not declare dsh.bundle",
]) {
  check('recognises plugin failure: ' + diagnostic, isPluginCompatibilityFailure(diagnostic))
}
for (const diagnostic of [
  'EADDRINUSE: address already in use 127.0.0.1:3080',
  'EACCES: permission denied',
  'Cannot find the bundled dsh runtime',
  'settings.yaml is invalid',
]) {
  check('does not isolate an unrelated failure: ' + diagnostic, !isPluginCompatibilityFailure(diagnostic))
}

const work = mkdtempSync(join(tmpdir(), 'dsh-desktop-data-home-'))
try {
  const legacy = join(work, '.dsh-desktop')
  const branded = join(work, '.bruc3van-dsh-desktop')
  writeFileSync(legacy, 'unrelated file')
  check('a colliding plain file is not treated as the legacy client home', !isLegacyClientHome(legacy))
  check('a colliding plain file is never migrated', migrateLegacyClientHome(legacy, branded) === 'not-needed')
  rmSync(legacy)
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'settings.json'), '{"unrelated":true}\n')
  check('an unrelated directory with settings is not claimed', !isLegacyClientHome(legacy))
  check('an unrelated directory is never migrated', migrateLegacyClientHome(legacy, branded) === 'not-needed')
  rmSync(legacy, { recursive: true })
  mkdirSync(join(legacy, 'bin'), { recursive: true })
  writeFileSync(join(legacy, 'settings.json'), '{"connectionMode":"smart"}\n')
  writeFileSync(join(legacy, 'bin', 'dsh.cmd'), 'legacy shim')
  check('recognises a legacy client settings document', isLegacyClientHome(legacy))
  check('first branded launch migrates the whole legacy client home', migrateLegacyClientHome(legacy, branded) === 'moved')
  check('legacy path is no longer active after the move', !existsSync(legacy))
  check('settings survive the namespace migration', readFileSync(join(branded, 'settings.json'), 'utf8').includes('smart'))
  check('generated tools survive the namespace migration', readFileSync(join(branded, 'bin', 'dsh.cmd'), 'utf8') === 'legacy shim')

  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'legacy-only'), 'keep')
  check('an existing branded home is never merged over', migrateLegacyClientHome(legacy, branded) === 'not-needed')
  check('legacy data remains when both namespaces exist', existsSync(join(legacy, 'legacy-only')))
} finally {
  const target = resolve(work)
  const root = resolve(tmpdir())
  if (target.startsWith(root + '\\') || target.startsWith(root + '/')) rmSync(target, { recursive: true, force: true })
}

console.log('data-home checks passed')
