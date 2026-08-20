/**
 * Two invariants that keep a second harness off one DSH_HOME.
 *
 * A session store written by two harnesses at once gains duplicate seqs and
 * orphan inbox splices, and the affected sessions never resume again. Both
 * halves of the guard are checked here because both failed silently before:
 *
 * 1. The runtime record must survive the client that wrote it (that is the
 *    whole point — the survivor to adopt is the one this client no longer
 *    holds a handle to), must read back exactly, and must never report a
 *    runtime it cannot vouch for.
 * 2. The updater must stop the runtime immediately before the installer runs
 *    and NOT before the download: the download takes minutes and can fail, and
 *    stopping up front leaves a working app dead with no update to show for
 *    it. Ordering is asserted against a real install, not read off the source.
 * @module desktop/scripts/check-runtime-lock
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-lock-'))

const lockBundle = join(work, 'runtime-lock.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'runtime-lock.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: lockBundle,
  logLevel: 'silent',
})
const { clearRuntimeLock, isProcessAlive, readRuntimeLock, recordRuntimeLockUrl, runtimeLockFile, writeRuntimeLock } =
  await import(pathToFileURL(lockBundle).href)

const home = join(work, 'dsh-home')
mkdirSync(home, { recursive: true })

// No record is the only state that may answer "nothing is running", because
// that answer is the one that spawns a second writer.
if (readRuntimeLock(home) !== undefined) throw new Error('an empty DSH_HOME reported a runtime')

writeRuntimeLock(home, { childPid: 4242, desktopPid: 99, startedAt: 1_700_000_000_000, source: 'bundled' })
const written = readRuntimeLock(home)
if (written?.childPid !== 4242 || written.desktopPid !== 99 || written.startedAt !== 1_700_000_000_000) {
  throw new Error('runtime record did not read back: ' + JSON.stringify(written))
}
if (written.url !== undefined) throw new Error('a runtime that never reported readiness must carry no origin')
// The rung that spawned it decides whether the next start may adopt it, so it
// has to survive the record — including the read-modify-write below.
if (written.source !== 'bundled') throw new Error('the spawning source did not read back: ' + JSON.stringify(written))

recordRuntimeLockUrl(home, 'http://127.0.0.1:31104', 4242)
const adopted = readRuntimeLock(home)
if (adopted?.url !== 'http://127.0.0.1:31104' || adopted.childPid !== 4242 || adopted.source !== 'bundled') {
  throw new Error('recording an origin must preserve the pid and source: ' + JSON.stringify(adopted))
}

// Readiness belongs to one child. A record naming a different one is a
// different runtime, and pointing the next start at the wrong harness is how
// this guard would hand out an origin nobody is serving.
recordRuntimeLockUrl(home, 'http://127.0.0.1:9999', 5555)
if (readRuntimeLock(home)?.url !== 'http://127.0.0.1:31104') {
  throw new Error('an origin was recorded onto a record describing another child')
}
recordRuntimeLockUrl(home, 'http://127.0.0.1:9999', undefined)
if (readRuntimeLock(home)?.url !== 'http://127.0.0.1:31104') {
  throw new Error('an origin was recorded with no child to attribute it to')
}
console.log('✓ an origin is recorded only onto the record naming that same child')

// The write goes through a temporary file so a torn read cannot parse as
// "nothing is running"; nothing may be left behind in the store either way.
const strays = readdirSync(home).filter(name => name.includes('.tmp'))
if (strays.length > 0) throw new Error('atomic write left temporary files behind: ' + strays.join(', '))
console.log('✓ a runtime record round-trips, gains its origin, and leaves no temporary files')

// A record that cannot be trusted must read as absent rather than as a
// half-understood runtime: the caller then probes and checks the pid, and both
// answer safely for a file this process did not manage to write.
for (const corrupt of ['', '{', 'null', '[]', '{"childPid":0}', '{"childPid":"x"}', '{"desktopPid":7}']) {
  writeFileSync(runtimeLockFile(home), corrupt)
  if (readRuntimeLock(home) !== undefined) {
    throw new Error('a malformed record was trusted: ' + JSON.stringify(corrupt))
  }
}
console.log('✓ a malformed or truncated record reads as absent, never as a runtime')

// A source that is not a usable string reads as "no source to check", so the
// adoption gate falls open to adopting rather than to a second writer.
for (const junk of [12, '', null, ['bundled']]) {
  writeFileSync(runtimeLockFile(home), JSON.stringify({ childPid: 4242, desktopPid: 1, startedAt: 1, source: junk }))
  const read = readRuntimeLock(home)
  if (read?.childPid !== 4242) throw new Error('an unusable source discarded the whole record: ' + JSON.stringify(junk))
  if (read.source !== undefined) throw new Error('an unusable source was trusted: ' + JSON.stringify(junk))
}
console.log('✓ an unusable source reads as absent without discarding the runtime it names')

clearRuntimeLock(home)
if (existsSync(runtimeLockFile(home))) throw new Error('clearing the record left the file behind')
clearRuntimeLock(home)
console.log('✓ clearing the record is idempotent, so a second stop is not an error')

if (!isProcessAlive(process.pid)) throw new Error('this process reported itself dead')
// pid 0 and negatives address process groups on POSIX; neither names a child.
for (const dead of [0, -1, -process.pid, 2 ** 53]) {
  if (isProcessAlive(dead)) throw new Error('a pid that names no child reported alive: ' + String(dead))
}
console.log('✓ liveness answers for this process and rejects pids that name no child')

// --- probing a port the user pinned in the profile patch layer --------------

const discoveryBundle = join(work, 'web-discovery.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'web-discovery.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: discoveryBundle,
  logLevel: 'silent',
})
const { configuredWebPorts, webProbeOrigins } = await import(pathToFileURL(discoveryBundle).href)

// The shape the official bundle uses (`id: webserver` with a nested config),
// which is what a user copies when moving the port off the default.
const realPatch = [
  '- id: webserver',
  '  config:',
  '    port: 31104',
  '',
].join('\n')
if (JSON.stringify(configuredWebPorts(realPatch)) !== '[31104]') {
  throw new Error('the documented patch shape was not read: ' + JSON.stringify(configuredWebPorts(realPatch)))
}
// Quoted scalars are valid YAML for the same value, and a list entry may carry
// the key inline.
if (JSON.stringify(configuredWebPorts('    port: "8080"\n- port: 9090\n')) !== '[8080,9090]') {
  throw new Error('quoted and inline port forms were not read')
}
// Nonsense must not become a probe target: an out-of-range number, an `!!js`
// expression, and a key that merely ends in "port".
for (const source of ['    port: 70000\n', '    port: !!js process.env.PORT\n', '    exportPort: 3080\n']) {
  if (configuredWebPorts(source).length !== 0) {
    throw new Error('a value that names no port was read as one: ' + JSON.stringify(source))
  }
}
if (configuredWebPorts('').length !== 0) throw new Error('an empty patch layer produced ports')
console.log('✓ a port pinned in the profile patch layer is read, and non-ports are not')

const origins = webProbeOrigins('http://127.0.0.1:3080', realPatch)
if (JSON.stringify(origins) !== '["http://127.0.0.1:3080","http://127.0.0.1:31104"]') {
  throw new Error('probe order must put the default first: ' + JSON.stringify(origins))
}
// A patch that restates the default must not make the client probe it twice.
if (webProbeOrigins('http://127.0.0.1:3080', '    port: 3080\n').length !== 1) {
  throw new Error('the default origin was queued twice')
}
const withPinned = webProbeOrigins('http://127.0.0.1:3080', realPatch, [13080])
if (JSON.stringify(withPinned) !== '["http://127.0.0.1:3080","http://127.0.0.1:13080","http://127.0.0.1:31104"]') {
  throw new Error('a client-pinned port must sit after the default and before patch ports: ' + JSON.stringify(withPinned))
}
if (webProbeOrigins('http://127.0.0.1:3080', '', [3080, 0, 70000]).length !== 1) {
  throw new Error('a pinned official/default or invalid extra port was queued')
}
console.log('✓ the default origin is probed first and never queued twice')
console.log('✓ a client-pinned local port is probed with the patch-layer ports')

// --- the updater's stop-before-installer ordering ---------------------------

const events = []
const electronStub = join(work, 'electron-stub.mjs')
writeFileSync(electronStub, [
  'import { appendFileSync } from "node:fs"',
  'const log = ' + JSON.stringify(join(work, 'events.log')),
  'export const shell = { openPath: async () => { appendFileSync(log, "installer\\n"); return "" } }',
].join('\n') + '\n')

const updaterBundle = join(work, 'updater.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'updater.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: electronStub },
  outfile: updaterBundle,
  logLevel: 'silent',
})
const { DesktopUpdater } = await import(pathToFileURL(updaterBundle).href)

const payload = Buffer.from('fake-mac-installer-payload')
const digest = createHash('sha256').update(payload).digest('hex')
let served = { body: payload, sha256: digest }

const server = createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      version: '9.9.9',
      notes: 'fixture',
      platforms: {
        'mac-arm64': {
          url: origin + '/dsh-desktop-9.9.9-mac-arm64.dmg',
          fileName: 'dsh-desktop-9.9.9-mac-arm64.dmg',
          sha256: served.sha256,
          size: served.body.length,
        },
      },
    }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(served.body.length) })
  response.end(served.body)
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const origin = 'http://127.0.0.1:' + String(server.address().port)

function makeUpdater() {
  let persisted = {}
  return new DesktopUpdater({
    currentVersion: '0.0.1',
    feedUrl: origin + '/latest.json',
    platform: 'darwin',
    arch: 'arm64',
    packaged: true,
    downloadDir: join(work, 'downloads'),
    loadPersistence: () => persisted,
    savePersistence: next => { persisted = next },
    dryRun: false,
    onBeforeInstall: async () => {
      // Recorded here rather than in the stub so the assertion sees the hook's
      // position relative to the download that precedes it.
      events.push('stop-runtime')
      if (!existsSync(join(work, 'downloads', 'dsh-desktop-9.9.9-mac-arm64.dmg'))) {
        throw new Error('the runtime was stopped before the installer had been downloaded')
      }
    },
  })
}

const updater = makeUpdater()
const found = await updater.check()
if (!found.hasUpdate) throw new Error('fixture feed offered no update')
const result = await updater.install()
if (!result.started) throw new Error('fixture install failed: ' + String(result.error))

const installerRuns = readFileSync(join(work, 'events.log'), 'utf8').trim().split('\n').filter(Boolean)
if (events.length !== 1 || events[0] !== 'stop-runtime') {
  throw new Error('the runtime must be stopped exactly once per install, got ' + JSON.stringify(events))
}
if (installerRuns.length !== 1) throw new Error('expected exactly one installer launch, got ' + installerRuns.length)
console.log('✓ the runtime is stopped after the payload is downloaded and verified, then the installer runs')

// A download that never passes verification must leave the runtime alone: the
// user keeps a working app instead of losing both the update and the runtime.
events.length = 0
served = { body: Buffer.from('tampered-payload'), sha256: digest }
const tampered = makeUpdater()
const offered = await tampered.check()
if (!offered.hasUpdate) throw new Error('fixture feed offered no update for the tampered case')
const refused = await tampered.install()
if (refused.started) throw new Error('an install with a mismatched SHA-256 reported success')
if (events.length !== 0) {
  throw new Error('the runtime was stopped for an install that never reached the installer')
}
console.log('✓ a payload that fails verification never stops the runtime')

server.close()
await rm(work, { recursive: true, force: true })
