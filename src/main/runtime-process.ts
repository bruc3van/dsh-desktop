import { spawn, spawnSync } from 'node:child_process'
import { isProcessAlive, type RuntimeLock } from './runtime-lock.ts'
import { parsePsElapsedSeconds, spawnAgeVerdict } from './runtime-resolution.ts'
import { readFileSync } from 'node:fs'
import { killProcessTree, terminateWindowsTree } from './process-tree.ts'
const SPAWN_NO_WINDOW = { windowsHide: true } as const
/** Allow rounding only when disproving ownership of a legacy age-only record. */
const PROCESS_IDENTITY_TOLERANCE_MS = 2_000

/**
 * Terminate a process this client owns but no longer holds a handle to.
 *
 * The manager's own stop() waits on its child's 'exit' event; a survivor of a
 * previous run has no such event to wait for, so liveness is polled instead.
 * Windows keeps the tree kill for the reason stop() documents: signals cannot
 * be caught there, and the real server is reachable only by walking down from
 * a parent that is still alive.
 */
export async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    if (!await terminateWindowsTree(pid)) return false
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { return !isProcessAlive(pid) }
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL') } catch { /* it left on its own */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !isProcessAlive(pid)
}

/**
 * Compare the OS creation identity captured while this client held the child.
 * An age-only legacy record can disprove ownership, but cannot authorize a kill.
 * Missing identity information stays unknown: adopt a reachable service or
 * refuse to start beside an unreachable process instead of guessing.
 */
export async function pidVerdictForLockedChild(lock: RuntimeLock): Promise<'recycled' | 'ours' | 'unknown'> {
  if (lock.processIdentity !== undefined) {
    const identity = await readProcessIdentity(lock.childPid)
    return identity === undefined ? 'unknown' : identity === lock.processIdentity ? 'ours' : 'recycled'
  }
  if (!Number.isSafeInteger(lock.startedAt) || lock.startedAt <= 0) return 'unknown'
  // One retry: a transient ps/powershell failure must not wedge the start
  // behind a refusal it could have resolved.
  let age = await readProcessAgeSeconds(lock.childPid)
  if (age === undefined) {
    await new Promise(resolve => setTimeout(resolve, 300))
    age = await readProcessAgeSeconds(lock.childPid)
  }
  if (age === undefined) return 'unknown'
  // Old records can disprove ownership, but an approximate age cannot authorize a kill.
  return spawnAgeVerdict(age, lock.startedAt, Date.now(), PROCESS_IDENTITY_TOLERANCE_MS) === 'recycled'
    ? 'recycled' : 'unknown'
}

/** Capture one short command's stdout, bounded, or reject. */
function runCommandCapture(command: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const settle = (error: Error | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(stdout)
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' }, ...SPAWN_NO_WINDOW })
    const timer = setTimeout(() => { killProcessTree(child); settle(new Error('timed out')) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_096) stdout = stdout.slice(0, 4_096)
    })
    child.once('error', () => { settle(new Error('command failed')) })
    child.once('exit', (code) => { settle(code === 0 ? undefined : new Error('exit ' + String(code))) })
  })
}

/** Stable OS creation identity; Windows preserves the full FILETIME precision. */
export async function readProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const value = (await runCommandCapture('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-Process -Id ' + String(pid) + ' -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()',
      ])).trim()
      return /^\d{15,}$/.test(value) ? 'win32:' + value : undefined
    }
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/' + String(pid) + '/stat', 'utf8')
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return ticks === undefined ? undefined : 'linux:' + boot + ':' + ticks
    }
    const value = (await runCommandCapture('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='])).trim()
    return value === '' ? undefined : process.platform + ':' + value
  } catch {
    return undefined
  }
}

/** The age of a process in seconds, or undefined when the platform cannot say. */
async function readProcessAgeSeconds(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const output = await runCommandCapture('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[math]::Round(((Get-Date) - (Get-Process -Id ' + String(pid) + ' -ErrorAction Stop).StartTime).TotalSeconds)',
      ])
      const parsed = Number(output.trim())
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    const output = await runCommandCapture('ps', ['-p', String(pid), '-o', 'etime='])
    return parsePsElapsedSeconds(output)
  } catch {
    return undefined
  }
}

/**
 * Last-resort disposal for an exit that never reaches `before-quit`: an
 * uncaught exception, or a signal. The graceful ladder cannot run here — an
 * exit handler is synchronous — but a SIGKILL still keeps the runtime from
 * outliving the client as an orphan holding the data home and a port.
 */
export function installEmergencyRuntimeDisposal(managedPid: () => number | undefined): void {
  // A closed stdout (a piped launch whose reader went away) otherwise turns
  // the next console.log into an uncaught EPIPE, which would take the client
  // down without disposing of the child at all.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  process.on('exit', () => {
    const pid = managedPid()
    if (pid === undefined) return
    try {
      // An exit handler cannot await, but it can still run a synchronous
      // command — and on Windows the tree walk is the only disposal that
      // reaches past a cmd.exe wrapper to the server actually holding a port.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', ...SPAWN_NO_WINDOW })
        return
      }
      process.kill(pid, 'SIGKILL')
    } catch { /* already gone, which is the outcome this wants */ }
  })
}
