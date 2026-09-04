import { spawn, type ChildProcess } from 'node:child_process'

const SPAWN_NO_WINDOW = { windowsHide: true } as const

/** Force-stop a spawned process, optionally including its POSIX process group. */
export function killProcessTree(child: ChildProcess, detachedProcessGroup = false): void {
  const pid = child.pid
  if (pid !== undefined && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', ...SPAWN_NO_WINDOW })
      .on('error', () => { child.kill('SIGKILL') })
    return
  }
  if (pid !== undefined && detachedProcessGroup) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // The group may already be gone; still try the direct child below.
    }
  }
  child.kill('SIGKILL')
}
