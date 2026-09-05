/** Owns one managed child, readiness, output and the serialized stop ladder. */
import { parseReadiness, appendRuntimeOutputTail, sanitizeRuntimeOutput, runtimeStartupDiagnostic, runtimeDiagnosticSummary } from './runtime-output.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { clearRuntimeLock, writeRuntimeLock } from './runtime-lock.ts'
import { killProcessTree } from './process-tree.ts'
import { NoEnabledSmartRuntimeError, type DshCommand } from './runtime-types.ts'

const SPAWN_NO_WINDOW = { windowsHide: true } as const
export interface RuntimeExit {
  wasReady: boolean
  code: number | null
  signal: NodeJS.Signals | null
  retryable: boolean
}
export interface WebUiManagerOptions {
  home(): string
  resolveCommand(): DshCommand
  prepareCommand(command: DshCommand): { args: string[]; env: NodeJS.ProcessEnv }
  waitForReady(url: string): Promise<void>
  onLog(line: string): void
  onExit(info: RuntimeExit): void
}

/** One `dsh web` child generation: process + its own lifecycle listeners. */
interface WebUiGeneration {
  child: ChildProcess
  /** Settles with the Web UI URL when THIS generation reports readiness. */
  ready: Promise<string>
  /** Whether THIS generation reached readiness before it exited. */
  readyReported: boolean
  /**
   * Set the moment `stop()` decides to end this generation. Its exit is then
   * an outcome the client asked for, not a crash — see `reportExit`.
   */
  stopped: boolean
}

/**
 * The local `dsh web` runtime manager: spawn generations on demand, resolve
 * the served URL once, report every exit through one callback so the window
 * owner can decide relaunch vs. fatal.
 */
export class WebUiManager {
  private generation: WebUiGeneration | undefined
  /** A stop in flight must finish before another generation can be spawned. */
  private stopping: Promise<void> | undefined
  /**
   * A failure no relaunch can repair (a damaged installation). It is reported
   * through onExit exactly once; later readiness requests reject with it
   * instead of spawning again, so the user never collects a stack of identical
   * error dialogs by reopening the window.
   */
  private fatalError: Error | undefined
  lastError: string | null = null
  /** Sanitized stdout/stderr tail from the most recent failed startup. */
  lastDiagnostic: string | null = null
  /** Which runtime the current generation was spawned from (status + fallback). */
  lastSource: DshCommand['source'] | undefined
  /** The resolved command of the last spawn, for the post-readiness seat. */
  lastCommand: DshCommand | undefined

  constructor(private readonly options: WebUiManagerOptions) {}

  /**
   * A source-toggle can make a previously fatal "nothing to spawn" recoverable.
   * Clearing here lets the next `ready()` try again under the new set.
   */
  clearFatalError(): void {
    this.fatalError = undefined
  }

  /** The current generation's readiness, or a fresh spawn when none exists. */
  async ready(): Promise<string> {
    await this.stopping
    if (this.fatalError !== undefined) throw this.fatalError
    const gen = this.generation
    if (gen !== undefined) return gen.ready
    this.spawn()
    const spawned = this.generation
    if (spawned === undefined) return Promise.reject(new Error('dsh web spawn failed'))
    return spawned.ready
  }

  /** The current child's pid, when one is running. */
  pid(): number | undefined {
    const gen = this.generation
    return gen?.child.pid
  }

  spawn(): void {
    // A generation already owns the manager. Respawns race through here from
    // both the exit ladder and `ready()` — the ladder's timer and a waiter
    // released by `stopping` both believe they are the one to respawn — and
    // spawning over a live child is a second writer on one DSH_HOME, which is
    // the one thing this manager exists to prevent. Whoever lost the race
    // finds the winner through `ready()` instead.
    if (this.fatalError !== undefined || this.generation !== undefined) return
    try {
      mkdirSync(this.options.home(), { recursive: true })
    } catch (error) {
      // The spawn callers above are timers and callbacks: a synchronous throw
      // here would be an uncaught exception in the main process. Route it
      // through the same fatal-error surface as a damaged installation.
      this.fatalError = error instanceof Error ? error : new Error(String(error))
      this.lastError = this.fatalError.message
      this.lastDiagnostic = this.fatalError.stack ?? this.fatalError.message
      this.lastSource = undefined
      this.lastCommand = undefined
      queueMicrotask(() => {
        this.options.onExit({ wasReady: false, code: null, signal: null, retryable: false })
      })
      return
    }
    let dsh: DshCommand
    try {
      dsh = this.options.resolveCommand()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.lastError = failure.message
      this.lastDiagnostic = failure.stack ?? failure.message
      // This generation never started: do not let onExit attribute the miss
      // to the previous source (which would reject PATH/npx and respawn).
      this.lastSource = undefined
      this.lastCommand = undefined
      // "Nothing enabled" is a settings choice, not a damaged install: the
      // user can tick a source and retry. A missing bundled runtime cannot.
      if (!(failure instanceof NoEnabledSmartRuntimeError)) this.fatalError = failure
      queueMicrotask(() => {
        this.options.onExit({ wasReady: false, code: null, signal: null, retryable: false })
      })
      return
    }
    console.log('[desktop] dsh runtime: ' + dsh.source + ' (' + dsh.label + ')')
    this.lastError = null
    this.lastDiagnostic = null
    this.lastSource = dsh.source
    this.lastCommand = dsh
    const prepared = this.options.prepareCommand(dsh)
    const child = spawn(dsh.command, [...dsh.args, ...prepared.args], {
      cwd: this.options.home(),
      env: prepared.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...SPAWN_NO_WINDOW,
      ...dsh.shell === true && { shell: true },
    })
    let resolveReady: (url: string) => void = () => {}
    let rejectReady: (error: Error) => void = () => {}
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const gen: WebUiGeneration = { child, ready, readyReported: false, stopped: false }
    let exitReported = false
    let readinessProbeStarted = false
    let stdoutTail = ''
    let stderrTail = ''

    // Recorded before readiness, not after: a client killed during the child's
    // boot still has to leave the pid behind for the next start to reap.
    if (child.pid !== undefined) {
      writeRuntimeLock(this.options.home(), {
        childPid: child.pid,
        desktopPid: process.pid,
        startedAt: Date.now(),
        source: dsh.source,
      })
    }

    const reportExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitReported) return
      exitReported = true
      const current = this.generation === gen
      if (current) {
        this.generation = undefined
        // Every way this child ends passes through here, so the record never
        // outlives it — except the one case it exists for, where this process
        // is gone and nothing runs at all. The clear is generation-guarded: a
        // late exit from a superseded child (a Windows stop that resolves
        // before the exit event) must not erase the lock its successor has
        // already written.
        clearRuntimeLock(this.options.home())
      }
      // The same two cases the clear above guards against must not reach the
      // recovery ladder either. A child that outlives its grace window makes
      // `stop()` resolve on the timeout instead of on the exit event, so its
      // real exit arrives AFTER whoever ordered the stop has already moved on
      // and cleared the flags (`replacingLocalRuntime`, `quitting`) that tell
      // `onExit` this was deliberate. Reported as a crash it would spend a
      // relaunch, paint "本地服务意外退出", and — if the replaced child had not
      // reached readiness — reject its own source for the rest of the session.
      // Whoever called `stop()` owns what happens next; nothing here does.
      if (gen.stopped || !current) return
      this.options.onExit({ wasReady: gen.readyReported, code, signal, retryable: true })
    }

    // Line framing across chunk boundaries: a readiness line split by the
    // pipe must not be lost (or misparsed).
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutTail = appendRuntimeOutputTail(stdoutTail, chunk)
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        // A \r\n child stdout would otherwise carry the \r into every log
        // line; readiness parsing is unaffected (it trims), this is cosmetic.
        const line = raw.replace(/\r$/, '')
        if (line.trim() === '') continue
        const url = parseReadiness(line)
        // DSH 0.1.2 readiness carries a process launch token. Parse the raw
        // value for navigation, but never copy that credential into desktop
        // diagnostics or a terminal log.
        this.options.onLog(sanitizeRuntimeOutput(line))
        if (url !== undefined && !readinessProbeStarted) {
          readinessProbeStarted = true
          void this.options.waitForReady(url).then(() => {
            if (exitReported) return
            gen.readyReported = true
            this.lastError = null
            resolveReady(url)
          }, (error: unknown) => {
            if (exitReported) return
            this.lastError = error instanceof Error ? error.message : String(error)
            this.lastDiagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
            rejectReady(error instanceof Error ? error : new Error(String(error)))
            // Tree-kill, not child.kill(): on Windows the direct child may be
            // the cmd.exe wrapper around a .cmd shim, and killing it alone
            // would leave the real server booting (and writing DSH_HOME)
            // while the retry budget spawns a second one beside it.
            killProcessTree(child)
          })
        }
      }
    })
    child.on('close', () => {
      if (stdoutBuffer.trim() !== '') this.options.onLog(sanitizeRuntimeOutput(stdoutBuffer))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendRuntimeOutputTail(stderrTail, chunk)
      process.stderr.write('[dsh web] ' + chunk.toString())
    })
    child.on('error', (error) => {
      this.lastError = error.message
      this.lastDiagnostic = error.stack ?? error.message
      rejectReady(error)
      // An 'error' after a successful spawn (a failed kill, say) leaves the
      // child running; only a process that never existed or already left
      // counts as an exit. A real exit always fires 'exit' below.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        reportExit(null, null)
      }
    })
    child.on('exit', (code, signal) => {
      if (!gen.readyReported) {
        const diagnostic = runtimeStartupDiagnostic(stderrTail, stdoutTail)
        if (diagnostic !== undefined) {
          this.lastDiagnostic = diagnostic
          this.lastError = runtimeDiagnosticSummary(diagnostic)
        } else if (this.lastError === null) {
          this.lastError = 'dsh web exited before ready (code=' + String(code) + ', signal=' + String(signal) + ')'
        }
      }
      rejectReady(new Error('dsh web exited before ready (code=' + String(code) + ')'))
      reportExit(code, signal)
    })
    this.generation = gen
  }

  /**
   * Stop the current generation. On POSIX the SIGTERM → SIGKILL ladder gives
   * the harness its graceful disposal window; on Windows signals cannot be
   * caught, so the whole process tree is terminated (taskkill /T /F).
   */
  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const gen = this.generation
    if (gen === undefined || gen.child.exitCode !== null) return
    // Before the first kill, not after the ladder: both rungs below can resolve
    // on their 3s timeout with the child still alive, and the exit that finally
    // arrives has to find this already set.
    gen.stopped = true
    const stopping = (async (): Promise<void> => {
      if (process.platform === 'win32') {
        const pid = gen.child.pid
        if (pid === undefined) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // taskkill never reported the tree gone; take the direct child at
            // least, so a wedged runtime cannot hold the client open.
            gen.child.kill()
            resolve()
          }, 3000)
          gen.child.once('exit', () => { clearTimeout(timer); resolve() })
          // Kill the tree BEFORE the direct child, never after. Signals cannot
          // be caught on Windows, and every descendant — the harness's shell
          // children, and the cmd.exe wrapper a user-installed `.cmd` shim is
          // spawned through — is reachable only by walking down from a parent
          // that is still alive. Terminating the parent first orphans the real
          // server, which then keeps its port with nothing left to find it by.
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', ...SPAWN_NO_WINDOW })
            .on('error', () => { gen.child.kill() })
        })
        return
      }
      gen.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { gen.child.kill('SIGKILL'); resolve() }, 3000)
        gen.child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    })()
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = undefined
    }
  }
}
