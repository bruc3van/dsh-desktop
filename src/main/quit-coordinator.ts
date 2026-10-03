import type { BrowserWindow } from 'electron'

/** Let Electron run the real beforeunload handler before touching the runtime. */
export function confirmWindowClose(window: BrowserWindow | null): Promise<boolean> {
  if (window === null || window.isDestroyed()) return Promise.resolve(true)
  const contents = window.webContents
  return new Promise(resolve => {
    const finish = (closed: boolean): void => {
      window.removeListener('closed', onClosed)
      contents.removeListener('will-prevent-unload', onPrevent)
      resolve(closed)
    }
    const onClosed = (): void => { finish(true) }
    const onPrevent = (event: Electron.Event): void => {
      // The window's normal discard dialog decides whether to override unload.
      queueMicrotask(() => { if (!event.defaultPrevented) finish(false) })
    }
    window.once('closed', onClosed)
    contents.on('will-prevent-unload', onPrevent)
    window.close()
  })
}

/** Repeated quit gestures wait for the same bounded disposal attempt. */
export function createQuitCoordinator(options: {
  confirm(): Promise<boolean>
  prepare?(): Promise<void>
  cancelled(): void
  begin(): void
  stop(): Promise<void>
  quit(): void
  failed(error: unknown): void
  timeoutMs?: number
}) {
  let completed = false
  let stopping: Promise<void> | undefined
  return (event: { preventDefault(): void }): void => {
    if (completed) return
    event.preventDefault()
    if (stopping !== undefined) return
    stopping = (async () => {
      try {
        // Leave Electron's before-quit dispatch before requesting a window close.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        if (!await options.confirm()) {
          options.cancelled()
          return
        }
        await options.prepare?.()
      } catch (error) {
        options.cancelled()
        options.failed(error)
        return
      }
      options.begin()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          options.stop(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { reject(new Error('runtime shutdown timed out')) }, options.timeoutMs ?? 15_000)
          }),
        ])
      } catch (error) {
        options.failed(error)
      } finally {
        clearTimeout(timer)
        completed = true
        options.quit()
      }
    })().finally(() => { stopping = undefined })
  }
}
