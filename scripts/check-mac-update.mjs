import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, access, chmod, realpath, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
const run = promisify(execFile)
const work = await realpath(await mkdtemp(join(tmpdir(), "dsh mac update ' fixture-")))
try {
  await build({ entryPoints: ['src/main/mac-update.ts'], outfile: join(work, 'module.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { macUpdateScript, prepareMacUpdate, preflightMacUpdate, pruneMacUpdateBackups } = await import(join(work, 'module.mjs'))
  for (const mode of ['success', 'move-failure', 'launch-failure', 'timeout']) {
    const root = join(work, mode)
    const target = join(root, 'Installed app.app')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'version'), 'old')
    if (mode !== 'move-failure') {
      await mkdir(join(root, 'next.app'))
      await writeFile(join(root, 'next.app/version'), 'new')
    }
    // Replace only LaunchServices for this filesystem transaction fixture.
    const opener = join(root, 'open')
    await writeFile(opener, '#!/bin/sh\ntouch "' + join(root, 'opened') + '"\n' + (mode === 'launch-failure' ? 'exit 1\n' : 'exit 0\n'), { mode: 0o700 })
    const script = join(root, 'install.sh')
    await writeFile(script, (mode === 'timeout' ? macUpdateScript.replace('-ge 120', '-ge 1') : macUpdateScript).replaceAll('/usr/bin/open', '"' + opener + '"'))
    const owner = spawn('/bin/sleep', ['30'])
    const child = spawn('/bin/sh', [script, root, target, String(owner.pid)])
    const ended = new Promise(resolve => child.on('exit', resolve))
    let ready = false
    for (let i = 0; i < 100; i++) {
      try { await access(join(root, 'ready')); ready = true; break } catch {}
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(ready, true, 'helper must acknowledge startup')
    assert.equal(await readFile(join(target, 'version'), 'utf8'), 'old', 'must wait for owner exit')
    if (mode !== 'timeout') owner.kill()
    const code = await ended
    if (mode === 'timeout') {
      process.kill(owner.pid, 0)
      owner.kill()
      await assert.rejects(access(join(root, 'opened')), { code: 'ENOENT' })
    }
    assert.equal(code === 0, mode === 'success')
    assert.equal(await readFile(join(target, 'version'), 'utf8'), mode === 'success' ? 'new' : 'old')
    if (mode === 'success') assert.equal(await readFile(join(root, 'previous.app/version'), 'utf8'), 'old')
  }
  console.log('✓ wait for exit, rollback, and timeout while owner is alive never reopens the app')
  const parent = join(work, 'permissions')
  const target = join(parent, 'Installed.app')
  await mkdir(target, { recursive: true })
  await chmod(parent, 0o555)
  try {
    await assert.rejects(preflightMacUpdate(join(target, 'Contents/MacOS/app'), true), /安装目录不可写.*~\/Applications/)
    await assert.rejects(preflightMacUpdate(join(target, 'Contents/MacOS/app'), false), /not writable.*~\/Applications/)
  } finally { await chmod(parent, 0o755) }
  const dead = spawn('/bin/sh', ['-c', 'exit 0'])
  await new Promise(resolve => dead.on('exit', resolve))
  const protectedNames = ['active', 'failed', 'foreign', 'mounted', 'unmarked']
  for (const [i, name] of ['old', 'recent', ...protectedNames].entries()) {
    const dir = join(parent, '.dsh-update-' + name)
    await mkdir(join(dir, 'previous.app'), { recursive: true })
    if (name !== 'unmarked') await writeFile(join(dir, 'transaction.json'), JSON.stringify({ format: 1, target: name === 'foreign' ? '/other.app' : target, pid: name === 'active' ? process.pid : dead.pid }))
    if (name !== 'failed') {
      await writeFile(join(dir, 'completed'), '')
      await utimes(join(dir, 'completed'), new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
    }
    if (name === 'mounted') await mkdir(join(dir, 'image'))
  }
  await pruneMacUpdateBackups(target)
  await assert.rejects(access(join(parent, '.dsh-update-old')), { code: 'ENOENT' })
  for (const name of ['recent', ...protectedNames]) await access(join(parent, '.dsh-update-' + name))
  console.log('✓ bilingual permission failures; reclaim old completed backups while preserving active/failed/foreign/unmarked/mount residues')
  if (process.platform === 'darwin') {
    const source = join(work, 'source')
    const bundle = join(source, 'Fixture.app')
    const installed = join(work, 'Fixture.app')
    for (const [path, version] of [[bundle, '2.0.0'], [installed, '1.0.0']]) {
      await mkdir(join(path, 'Contents/MacOS'), { recursive: true })
      await writeFile(join(path, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.dsh.updater</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
      const c = join(work, 'fixture.c')
      await writeFile(c, '#include <stdio.h>\nint main(void) { FILE *f = fopen(' + JSON.stringify(join(work, 'launched')) + ', "w"); if (!f) return 1; fputs("' + version + '", f); fclose(f); return 0; }')
      await run('/usr/bin/clang', [c, '-o', join(path, 'Contents/MacOS/fixture')])
      await run('/usr/bin/codesign', ['--force', '--sign', '-', path])
    }
    const image = join(work, 'fixture.dmg')
    await run('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-format', 'UDZO', image])
    const prepared = await prepareMacUpdate(image, join(installed, 'Contents/MacOS/fixture'), '2.0.0')
    await prepared.dispose()
    await assert.rejects(prepareMacUpdate(image, join(installed, 'Contents/MacOS/fixture'), '3.0.0'), /版本/)
    await access(installed)
    console.log('✓ real ad-hoc signed DMG mount, stage, verify, detach, version mismatch rejection')
    const runner = join(work, 'runner.mjs')
    await writeFile(runner, 'import { prepareMacUpdate } from "./module.mjs"; const p = await prepareMacUpdate(' + JSON.stringify(image) + ', ' + JSON.stringify(join(installed, 'Contents/MacOS/fixture')) + ', "2.0.0"); await p.start();')
    await run(process.execPath, [runner])
    let launched = ''
    for (let i = 0; i < 100; i++) {
      try { launched = await readFile(join(work, 'launched'), 'utf8') } catch {}
      if (launched === '2.0.0') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(launched, '2.0.0', 'native helper must launch the replaced bundle through LaunchServices')
    const transactions = (await readdir(work)).filter(name => name.startsWith('.dsh-update-'))
    assert.equal(transactions.length, 1)
    await access(join(work, transactions[0], 'completed'))
    await assert.rejects(access(join(work, transactions[0], 'image')), { code: 'ENOENT' })
    console.log('✓ detached helper launches new native app and records a reclaimable completed transaction')
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
