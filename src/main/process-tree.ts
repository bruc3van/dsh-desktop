import { spawn, type ChildProcess } from 'node:child_process'

const SPAWN_NO_WINDOW = { windowsHide: true } as const

/** Never kill a Windows wrapper alone: its live PID is needed for the tree walk. */
export async function terminateWindowsTree(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stopped = await new Promise<boolean>((resolve) => {
      let settled = false
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', ...SPAWN_NO_WINDOW })
      const finish = (success: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(success)
      }
      const timer = setTimeout(() => { child.kill(); finish(false) }, 3000)
      child.once('error', () => { finish(false) })
      child.once('exit', code => { finish(code === 0) })
    })
    if (stopped) return true
  }
  return false
}

/** Force-stop a spawned process, optionally including its POSIX process group. */
export function killProcessTree(child: ChildProcess, detachedProcessGroup = false): Promise<boolean> {
  const pid = child.pid
  if (pid !== undefined && process.platform === 'win32') {
    return terminateWindowsTree(pid)
  }
  if (pid !== undefined && detachedProcessGroup) {
    try {
      process.kill(-pid, 'SIGKILL')
      return Promise.resolve(true)
    } catch {
      // The group may already be gone; still try the direct child below.
    }
  }
  return Promise.resolve(child.kill('SIGKILL'))
}
