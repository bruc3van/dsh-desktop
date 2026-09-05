import { spawn, spawnSync } from 'node:child_process'
import { isProcessAlive, type RuntimeLock } from './runtime-lock.ts'
import { parsePsElapsedSeconds, spawnAgeVerdict } from './runtime-resolution.ts'
import { killProcessTree } from './process-tree.ts'
const SPAWN_NO_WINDOW = { windowsHide: true } as const
/** A recycled pid can only be this far off the recorded age. */
const PROCESS_IDENTITY_TOLERANCE_MS = 60_000

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
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', ...SPAWN_NO_WINDOW }).on('error', () => { /* already gone */ })
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
 * Whether the pid in a runtime lock still names the child the lock recorded
 * (see spawnAgeVerdict). Liveness alone is not identity: the client may
 * crash, the child die, and the OS hand the pid to any later process —
 * signalling a recycled pid would terminate (on Windows, with its whole
 * tree) an innocent bystander. A record with no usable `startedAt` is
 * unverifiable and reported as such: the caller then refuses both
 * directions instead of guessing.
 */
export async function pidVerdictForLockedChild(lock: RuntimeLock): Promise<'recycled' | 'ours' | 'unknown'> {
  if (!Number.isSafeInteger(lock.startedAt) || lock.startedAt <= 0) return 'unknown'
  // One retry: a transient ps/powershell failure must not wedge the start
  // behind a refusal it could have resolved.
  let age = await readProcessAgeSeconds(lock.childPid)
  if (age === undefined) {
    await new Promise(resolve => setTimeout(resolve, 300))
    age = await readProcessAgeSeconds(lock.childPid)
  }
  if (age === undefined) return 'unknown'
  return spawnAgeVerdict(age, lock.startedAt, Date.now(), PROCESS_IDENTITY_TOLERANCE_MS)
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
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], ...SPAWN_NO_WINDOW })
    const timer = setTimeout(() => { killProcessTree(child); settle(new Error('timed out')) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_096) stdout = stdout.slice(0, 4_096)
    })
    child.once('error', () => { settle(new Error('command failed')) })
    child.once('exit', (code) => { settle(code === 0 ? undefined : new Error('exit ' + String(code))) })
  })
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
