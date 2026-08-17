/**
 * Who the tray's "Restart" may stop, and — more importantly — who it may not.
 *
 * Restarting the client is only useful if the harness restarts with it: a
 * successor that adopts the same running instance loads the same plugins, and
 * the user who restarted for a plugin gets nothing. So the restart stops the
 * runtime it is connected to. That is also the one step in this client that
 * can reach a process it did not spawn, and on Windows the kill takes a whole
 * process tree — so the decision table is asserted here rather than trusted.
 *
 * The two failures worth catching are opposites, and both are silent:
 * stopping a `dsh web` the user started in their own terminal (their work,
 * killed by a menu item that promised to restart the client), and stopping a
 * pid that was recycled by an unrelated process (a stranger's tree, taken
 * down by name of a record that no longer describes it).
 * @module desktop/scripts/check-restart
 */

import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-restart-'))

const bundle = join(work, 'runtime-lock.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'runtime-lock.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent',
})
const { readRuntimeLock, recordRuntimeLockUrl, restartDisposition, writeRuntimeLock } =
  await import(pathToFileURL(bundle).href)

const home = join(work, 'dsh-home')
mkdirSync(home, { recursive: true })

const ORIGIN = 'http://127.0.0.1:3080'
const CHILD_PID = 4242

// The record is written the way the client writes it — spawn first, origin
// once the child reports readiness — so the decision is made against a real
// round-trip through the file rather than a hand-built object.
writeRuntimeLock(home, { childPid: CHILD_PID, desktopPid: 99, startedAt: Date.now() })
recordRuntimeLockUrl(home, ORIGIN, CHILD_PID)
const lock = readRuntimeLock(home)
if (lock?.url !== ORIGIN) throw new Error('fixture record did not read back: ' + JSON.stringify(lock))

/** The state of an adopted survivor of a previous run: the one stoppable case. */
const adoptedSurvivor = {
  adopted: true,
  targetOrigin: ORIGIN,
  lock,
  ownedChildPid: undefined,
  pidAlive: true,
}

const decide = (overrides = {}) => restartDisposition({ ...adoptedSurvivor, ...overrides })

// Every case that must NOT reach a kill. Each is a real state the client can
// be in, not a hypothetical: the names say which.
const mustLeave = [
  ['a runtime this client spawned (its own stop ladder owns it)',
    { adopted: false }],
  ['the pid of the child this process is still running',
    { ownedChildPid: CHILD_PID }],
  ['a `dsh web` the user started in a terminal (no record at all)',
    { lock: undefined }],
  ['a record whose child never reported an origin',
    { lock: { ...lock, url: undefined } }],
  ['a record naming an origin the window is not on',
    { lock: { ...lock, url: 'http://127.0.0.1:3099' } }],
  ['an origin the record reaches over http while the window is on https',
    { targetOrigin: 'https://127.0.0.1:3080' }],
  ['a target that is not a parseable absolute URL',
    { targetOrigin: '' }],
  ['a recorded pid that is no longer alive',
    { pidAlive: false }],
]

for (const [name, overrides] of mustLeave) {
  const verdict = decide(overrides)
  if (verdict !== 'leave') throw new Error('restart would touch ' + name + ': ' + verdict)
}
console.log('✓ a restart leaves alone every runtime it cannot prove is its own')

// The identity check costs a spawned command and up to seconds. It must be
// asked for only after the cheap clauses pass, and it must be asked for.
if (decide() !== 'verify') throw new Error('an adopted survivor skipped the identity check')
for (const [name, overrides] of mustLeave) {
  if (decide({ ...overrides, verdict: 'ours' }) !== 'leave') {
    throw new Error('an identity verdict overrode the refusal for ' + name)
  }
}
console.log('✓ the identity check is paid for only where it can change the answer, and never overrides a refusal')

// A pid the platform cannot age, or one that has been recycled by an
// unrelated process, is a stranger. Only a process whose age matches the
// recorded spawn is this client's own survivor.
if (decide({ verdict: 'recycled' }) !== 'leave') throw new Error('a recycled pid was treated as our runtime')
if (decide({ verdict: 'unknown' }) !== 'leave') throw new Error('an unverifiable pid was treated as our runtime')
if (decide({ verdict: 'ours' }) !== 'stop') throw new Error('a verified survivor was not stopped')
console.log('✓ only a live recorded child whose age matches the recorded spawn is stopped')

rmSync(work, { recursive: true, force: true })
