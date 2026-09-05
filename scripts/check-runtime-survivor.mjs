/** Verify survivor ownership against a real, isolated process and loopback server. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-runtime-survivor-'))
let child
try {
  const outfile = join(home, 'survivor.mjs')
  await build({ stdin: {
    contents: "export * from './src/main/runtime-survivor.ts'; export * from './src/main/runtime-lock.ts'; export * from './src/main/runtime-process.ts';",
    resolveDir: root, loader: 'ts',
  }, bundle: true, platform: 'node', format: 'esm', outfile })
  const { createRuntimeSurvivor, writeRuntimeLock, readRuntimeLock, isProcessAlive, readProcessIdentity } = await import(pathToFileURL(outfile).href)
  const fixture = join(home, 'server.mjs')
  writeFileSync(fixture, `import { createServer } from 'node:http'
const server = createServer((_req, res) => { res.end('survivor-fixture') })
server.listen(0, '127.0.0.1', () => process.send({ url: 'http://127.0.0.1:' + server.address().port }))
`)
  const startedAt = Date.now()
  child = spawn(process.execPath, [fixture], { env: { ...process.env, DSH_HOME: home }, windowsHide: true,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  const [{ url }] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) })
  const survivor = createRuntimeSurvivor({
    childHome: () => home, managedPid: () => undefined, enabledSmartRuntimes: () => ['bundled'],
    connection: () => ({ adopted: true, target: url }),
    probeWebUi: async target => {
      try { return await (await fetch(target, { signal: AbortSignal.timeout(1000) })).text() === 'survivor-fixture' ? target : undefined }
      catch { return undefined }
    },
  })
  await survivor.stopAdoptedRuntimeForRestart()
  assert.equal(isProcessAlive(child.pid), true, 'a serving process with no ownership record must be left alone')

  writeRuntimeLock(home, { childPid: child.pid, desktopPid: process.pid, startedAt: startedAt - 3_600_000, source: 'bundled' })
  assert.equal((await survivor.adoptOrClearSurvivingRuntime()).kind, 'spawn')
  assert.equal(isProcessAlive(child.pid), true, 'a recycled PID must not be killed')
  assert.equal(readRuntimeLock(home), undefined)

  writeRuntimeLock(home, { childPid: child.pid, desktopPid: process.pid, startedAt, processIdentity: await readProcessIdentity(child.pid), source: 'bundled', url })
  assert.deepEqual(await survivor.adoptOrClearSurvivingRuntime(), { kind: 'adopt', url })
  assert.equal(isProcessAlive(child.pid), true)
  await survivor.stopAdoptedRuntimeForRestart()
  await exited
  assert.equal(isProcessAlive(child.pid), false, 'restart must stop the verified adopted child')
  assert.equal(readRuntimeLock(home), undefined)
  console.log('✓ unowned and recycled processes survive; verified leftover is adopted and stopped on restart — ' + url)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  rmSync(home, { recursive: true, force: true })
}
