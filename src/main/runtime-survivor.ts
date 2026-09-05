/** Adopts or reaps only a runtime whose persisted ownership can be verified. */
import { clearRuntimeLock, readRuntimeLock, isProcessAlive, restartDisposition, writeRuntimeLock, type RuntimeLock, type PidVerdict } from './runtime-lock.ts'
import { adoptableUnderSmartRuntimes, type SmartRuntimeId } from './smart-runtimes.ts'
import { appOrigin } from './connection-policy.ts'
import { terminateProcessTree, pidVerdictForLockedChild } from './runtime-process.ts'
/**
 * Settle with the runtime this client left behind, before starting another.
 *
 * `adopt` names an origin to connect to when the survivor still serves — one
 * harness, sessions shared, which is what the user wanted anyway. `spawn`
 * means the way is clear. `blocked` means a survivor is still alive and could
 * not be stopped, and the caller must NOT start a second writer.
 *
 * The served origin is what decides, not the pid: a harness that answers is
 * unambiguously writing DSH_HOME, while a pid that answers nothing is either
 * gone or wedged past use. Killing a wedged one risks a torn write tail, which
 * the harness repairs on its next load; spawning beside a live one risks
 * duplicate seqs and orphan inbox splices, which nothing repairs.
 *
 * The user's source preference rides on top of that order, never against it:
 * a survivor from a rung since turned off is stopped when this client can
 * stop it, and adopted when it cannot.
 */
export type SurvivingRuntime =
  | { kind: 'spawn' }
  | { kind: 'adopt'; url: string }
  | { kind: 'blocked'; pid: number; uncertain?: boolean }
interface SurvivorOptions {
  childHome(): string
  managedPid(): number | undefined
  enabledSmartRuntimes(): SmartRuntimeId[]
  probeWebUi(url: string): Promise<string | undefined>
  connection(): { adopted: boolean; target: string | undefined }
}
export function createRuntimeSurvivor(options: SurvivorOptions) {
  const { childHome, managedPid, enabledSmartRuntimes, probeWebUi, connection } = options
  async function stopRecordedRuntime(lock: RuntimeLock): Promise<boolean> {
    writeRuntimeLock(childHome(), { ...lock, launchPending: true })
    return await terminateProcessTree(lock.childPid)
  }
  async function adoptOrClearSurvivingRuntime(): Promise<SurvivingRuntime> {
    const home = childHome()
    const lock = readRuntimeLock(home)
    if (lock === undefined) return { kind: 'spawn' }
    // A crash between reservation and recording the child leaves its PID unknown.
    // Never reinterpret that uncertainty as an empty data home.
    if (lock.launchPending === true) return { kind: 'blocked', pid: lock.childPid, uncertain: true }
    // The record describes the child this manager is already running: there is
    // no survivor here, only ourselves, and adopting it would stop it.
    if (managedPid() === lock.childPid) return { kind: 'spawn' }
    const serving = lock.url === undefined ? undefined : await probeWebUi(lock.url)
    // A survivor whose rung the user has since unticked is stopped instead of
    // adopted, so this start resolves the sources they now allow. It is only
    // ever a preference: `adopt` remains the answer whenever the survivor
    // cannot be stopped safely, because a second writer on one DSH_HOME costs
    // sessions and a runtime from the wrong rung costs nothing.
    const wanted = adoptableUnderSmartRuntimes(enabledSmartRuntimes(), lock.source)
    if (serving !== undefined && wanted) {
      console.warn('[desktop] adopting the runtime left by a previous run (PID ' + String(lock.childPid) + '): ' + serving)
      return { kind: 'adopt', url: serving }
    }
    const adoptAnyway = (why: string): SurvivingRuntime | undefined => {
      if (serving === undefined) return undefined
      console.warn('[desktop] the surviving runtime (PID ' + String(lock.childPid) + ') came from a source that is '
        + 'no longer enabled, but ' + why + '; adopting it rather than writing ' + home + ' beside it')
      return { kind: 'adopt', url: serving }
    }
    if (isProcessAlive(lock.childPid)) {
      const verdict = await pidVerdictForLockedChild(lock)
      if (verdict === 'unknown') {
        // A live pid we cannot identify is signalled by nobody. Refuse both
        // directions — killing it may hit an unrelated process, spawning beside
        // it may be a second writer.
        const adopted = adoptAnyway('the process holding that pid cannot be verified')
        if (adopted !== undefined) return adopted
        console.warn('[desktop] cannot verify the process holding PID ' + String(lock.childPid)
          + '; refusing to signal it or to write ' + home + ' beside it')
        return { kind: 'blocked', pid: lock.childPid }
      }
      if (verdict === 'ours') {
        console.warn('[desktop] a runtime from a previous run (PID ' + String(lock.childPid) + ') is '
          + (serving === undefined ? 'alive but not serving' : 'serving from a source that is no longer enabled')
          + '; stopping it rather than writing ' + home + ' beside it')
        if (await stopRecordedRuntime(lock)) {
          clearRuntimeLock(home)
          return { kind: 'spawn' }
        }
        // The record stays on a failed kill. Clearing it would let the next start
        // spawn beside a writer this one already knows it could not stop.
        return { kind: 'blocked', pid: lock.childPid, uncertain: true }
      }
      // The recorded child is gone and its pid has been recycled by an
      // unrelated process: the record is stale, and that process must not be
      // signalled (Windows would take its whole tree down).
      console.warn('[desktop] the recorded runtime (PID ' + String(lock.childPid)
        + ') is gone and its pid now names an unrelated process; leaving it alone')
    }
    // The recorded pid is no longer this client's child to stop, yet the origin
    // it left behind still answers: whatever serves it is writing this DSH_HOME,
    // and the disabled source is not worth a second writer beside it.
    const surviving = adoptAnyway('the harness answering it is no longer this client\'s child to stop')
    if (surviving !== undefined) return surviving
    clearRuntimeLock(home)
    return { kind: 'spawn' }
  }

  /**
   * Stop a runtime this client adopted rather than spawned, so that a restart
   * really does restart the harness. Without this the successor's startup probe
   * finds the same instance still serving, adopts it again, and the plugin the
   * user restarted for is still not loaded.
   *
   * Which runtimes qualify is decided by `restartDisposition`, where the rules
   * and their reasons live; this reads the state it needs, pays for the identity
   * check only once the cheap clauses have passed, and carries out the verdict.
   */
  async function stopAdoptedRuntimeForRestart(): Promise<void> {
    const home = childHome()
    const lock = readRuntimeLock(home)
    const state = {
      adopted: connection().adopted,
      targetOrigin: appOrigin(connection().target ?? ''),
      lock,
      ownedChildPid: managedPid(),
      pidAlive: lock !== undefined && isProcessAlive(lock.childPid),
    }
    if (lock === undefined || restartDisposition(state) !== 'verify') return
    const verdict: PidVerdict = await pidVerdictForLockedChild(lock)
    if (restartDisposition({ ...state, verdict }) !== 'stop') {
      console.warn('[desktop] restart: cannot verify the adopted runtime (PID ' + String(lock.childPid)
        + '); leaving it running — the new instance will adopt it again')
      return
    }
    console.warn('[desktop] restart: stopping the adopted runtime (PID ' + String(lock.childPid) + ')')
    // The record stays on a failed kill, for the reason the adoption path
    // documents: the next start must not spawn beside a writer nobody stopped.
    if (await stopRecordedRuntime(lock)) clearRuntimeLock(home)
  }

  return { adoptOrClearSurvivingRuntime, stopAdoptedRuntimeForRestart }
}
export type RuntimeSurvivor = ReturnType<typeof createRuntimeSurvivor>
