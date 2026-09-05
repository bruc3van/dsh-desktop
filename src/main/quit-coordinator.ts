/** Repeated quit gestures wait for the same bounded disposal attempt. */
export function createQuitCoordinator(options: {
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
    options.begin()
    stopping = (async () => {
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
    })()
  }
}
