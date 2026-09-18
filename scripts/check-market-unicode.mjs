/** Exercise Unicode copying on Windows Electron; keep other CI hosts headless. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (process.argv[2] === '--probe') {
  if (process.platform === 'win32') assert.ok(process.versions.electron, 'Windows regression must run on Electron Node')
  const { seatBundledPlugin, BUNDLED_PLUGIN_NAME: name } = await import(pathToFileURL(process.argv[3]))
  const work = process.argv[4]
  const runtime = { version: '0.1.5-rc.2', peerRanges: ['^0.1.5-rc.1'] }
  for (const [sourceName, homeName] of [
    ['安装目录', 'ascii-home'],
    ['ascii-install', '用户数据'],
    ['软件-é-😀', '工作区-é-😀'],
  ]) {
    const payload = join(work, sourceName)
    const home = join(work, homeName)
    const profile = join(home, 'profiles/web')
    const installed = join(profile, 'node_modules', name)
    const data = join(payload, '目录')
    mkdirSync(data, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    writeFileSync(join(payload, 'package.json'), JSON.stringify({ name, version: '0.5.2' }))
    writeFileSync(join(data, '文件.txt'), '中文内容-é-😀')
    // A pnpm-style directory link must become a real copy in the profile.
    const linked = join(work, sourceName + '-store')
    mkdirSync(linked)
    writeFileSync(join(linked, 'module.js'), 'export default 42')
    symlinkSync(linked, join(payload, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = seatBundledPlugin(payload, home, runtime)
    assert.equal(result.error, undefined)
    assert.equal(result.seated, true)
    assert.equal(readFileSync(join(installed, '目录/文件.txt'), 'utf8'), '中文内容-é-😀')
    assert.equal(lstatSync(join(installed, 'linked')).isSymbolicLink(), false)
    assert.equal(readFileSync(join(installed, 'linked/module.js'), 'utf8'), 'export default 42')
    // A failed upgrade must preserve the previous complete copy. Link cycles
    // must produce a recoverable error, not recurse forever or abort Electron.
    writeFileSync(join(payload, 'package.json'), JSON.stringify({ name, version: '0.5.3' }))
    symlinkSync(payload, join(payload, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.match(seatBundledPlugin(payload, home, runtime).error, /Circular bundled market directory/)
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, '0.5.2')
    rmSync(join(payload, 'cycle'))
    assert.equal(seatBundledPlugin(payload, home, runtime).seated, true)
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, '0.5.3')
    console.log('✓ Unicode market copy: ' + sourceName + ' -> ' + homeName + '; links, failed upgrade and retry')
  }
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const work = mkdtempSync(join(tmpdir(), 'dsh-market-unicode-'))
  try {
    const output = join(work, 'seat.mjs')
    await build({ entryPoints: [join(root, 'src/main/bundled-plugin.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' })
    const executable = process.env.DSH_DESKTOP_TEST_ELECTRON
      || (process.platform === 'win32' ? createRequire(import.meta.url)('electron') : process.execPath)
    const result = spawnSync(executable, [fileURLToPath(import.meta.url), '--probe', output, work], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    assert.equal(result.status, 0, JSON.stringify({ status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }))
    process.stdout.write(result.stdout)
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  }
}
