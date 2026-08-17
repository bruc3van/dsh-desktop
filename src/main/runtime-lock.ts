/**
 * The record of this client's managed `dsh web` child, kept in DSH_HOME.
 *
 * Two harnesses appending to one session store corrupt it: each carries its
 * own in-memory sequence number, so the log gains duplicate seqs and orphan
 * inbox splices, and an affected session never resumes again. The client
 * cannot discover every harness on the machine to avoid that — the official
 * web app takes its port from a `--port` flag OR from the profile's patch
 * layer, and the latter leaves nothing on the command line to find — so
 * exclusion must not rest on discovery.
 *
 * What the client can do reliably is never run two of its OWN runtimes. This
 * record names the child it spawned and the origin that child serves, so the
 * next start adopts the survivor (one harness, sessions shared) instead of
 * spawning beside it. That survivor is not hypothetical: a Windows installer
 * that kills the app by name leaves the child running, and the updated app
 * then starts a second writer against the same DSH_HOME.
 *
 * The record is advisory and self-healing. A child that neither answers nor
 * exists is cleared rather than obeyed, so a crashed client cannot wedge the
 * next start. It is written through a temporary file and renamed, because a
 * torn read would parse as "no runtime" — the one wrong answer that costs
 * data rather than convenience.
 * @module dsh-desktop/runtime-lock
 */

import { renameSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One managed runtime, as the next start needs to reason about it. */
export interface RuntimeLock {
  /** The `dsh web` child this client spawned. */
  childPid: number
  /** The client that spawned it; informational, for diagnosing a survivor. */
  desktopPid: number
  /** Epoch ms of the spawn. */
  startedAt: number
  /** The origin the child serves, once it has reported readiness. */
  url?: string
  /**
   * Which resolved source spawned it (`bundled`, `installed`, `npx`, …), so
   * the next start can tell whether adopting this survivor still matches the
   * sources the user allows. Absent in records written before the field
   * existed, which read as "no source to check".
   */
  source?: string
}

/** The record lives beside the session store it protects. */
export function runtimeLockFile(home: string): string {
  return join(home, '.dsh-desktop-runtime.json')
}

/**
 * The recorded runtime, or undefined when there is none to reason about.
 * Unreadable and malformed records read as "none": the caller's next step is
 * to probe and to check the pid, and both answer safely for a record that
 * cannot be trusted anyway.
 */
export function readRuntimeLock(home: string): RuntimeLock | undefined {
  let raw: string
  try {
    raw = readFileSync(runtimeLockFile(home), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeLock>
    if (!Number.isSafeInteger(parsed.childPid) || Number(parsed.childPid) <= 0) return undefined
    return {
      childPid: Number(parsed.childPid),
      desktopPid: Number(parsed.desktopPid ?? 0),
      startedAt: Number(parsed.startedAt ?? 0),
      ...typeof parsed.url === 'string' && parsed.url !== '' && { url: parsed.url },
      ...typeof parsed.source === 'string' && parsed.source !== '' && { source: parsed.source },
    }
  } catch {
    return undefined
  }
}

/**
 * Record a freshly spawned child. Written before the child reports readiness,
 * so a client killed during boot still leaves the pid behind to be reaped.
 */
export function writeRuntimeLock(home: string, lock: RuntimeLock): void {
  const file = runtimeLockFile(home)
  const temporary = file + '.' + String(process.pid) + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    console.warn('[desktop] could not record the local runtime: ' + describe(error))
    try { unlinkSync(temporary) } catch { /* nothing to clean up */ }
  }
}

/**
 * Attach the served origin, so the next start can adopt this child.
 *
 * `childPid` is what the caller believes is running. A record naming anything
 * else belongs to a different child — this is a read-modify-write, and writing
 * an origin onto a record this readiness does not describe would point the next
 * start at the wrong harness.
 */
export function recordRuntimeLockUrl(home: string, url: string, childPid: number | undefined): void {
  const lock = readRuntimeLock(home)
  if (lock === undefined || lock.childPid !== childPid) return
  writeRuntimeLock(home, { ...lock, url })
}

/** Drop the record once the child is gone; absence means "nothing running". */
export function clearRuntimeLock(home: string): void {
  try {
    unlinkSync(runtimeLockFile(home))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[desktop] could not clear the runtime record: ' + describe(error))
  }
}

/**
 * Whether a pid names a live process. EPERM is a live process this user may
 * not signal, which for the caller's purpose — is something still there —
 * counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** An origin, or '' for anything that is not a parseable absolute URL. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** What identity checking concluded about the process holding a recorded pid. */
export type PidVerdict = 'ours' | 'recycled' | 'unknown'

/**
 * What a restart must do with the runtime the window is currently pointed at.
 * `verify` means the cheap clauses all passed and the identity check — which
 * costs a spawned command and up to seconds — is now worth paying for.
 */
export type RestartDisposition = 'leave' | 'verify' | 'stop'

export interface RestartDispositionInput {
  /** True when the target was adopted by the startup probe, not spawned here. */
  adopted: boolean
  /** The origin the window is actually pointed at. */
  targetOrigin: string
  /** The recorded runtime, if there is one. */
  lock: RuntimeLock | undefined
  /** The pid of the child this client owns, when it has one running. */
  ownedChildPid: number | undefined
  /** Whether the recorded pid names a live process. */
  pidAlive: boolean
  /** The identity verdict, once it has been paid for. */
  verdict?: PidVerdict
}

/**
 * Decide whether a restart may stop the runtime it is connected to.
 *
 * Stopping is the point of the gesture — a successor that adopts the same
 * instance restarts nothing the user asked for — but it is also the only step
 * that can reach a process this client does not own, so every clause below
 * exists to keep a stranger out of the kill:
 *
 * - a runtime this process spawned is stopped by the manager's own ladder,
 *   which waits on an exit event this path cannot see;
 * - only the recorded child qualifies, and only while the record names the
 *   origin the window is on, so a `dsh web` the user started in a terminal
 *   (which writes no record) keeps running;
 * - a dead pid is nothing to stop, and a live one still has to prove its age
 *   matches the recorded spawn, because a recycled pid names a stranger and
 *   the Windows kill takes a whole process tree.
 *
 * Every refusal degrades the same safe way: the runtime keeps running, the
 * successor adopts it again, and the user gets a restarted shell rather than
 * a stopped process that was never ours.
 */
export function restartDisposition(input: RestartDispositionInput): RestartDisposition {
  const lock = input.lock
  if (!input.adopted) return 'leave'
  // No record, or one whose child never reported readiness: nothing here can
  // be tied to the origin on screen.
  if (lock?.url === undefined) return 'leave'
  if (lock.childPid === input.ownedChildPid) return 'leave'
  if (input.targetOrigin === '' || originOf(lock.url) !== input.targetOrigin) return 'leave'
  if (!input.pidAlive) return 'leave'
  if (input.verdict === undefined) return 'verify'
  return input.verdict === 'ours' ? 'stop' : 'leave'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
