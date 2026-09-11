/** Shared by the injected card and the standalone settings document. */
export function installRestartAction(options: {
  button: HTMLButtonElement
  setBusy: (busy: boolean) => void
  showError: (message: string) => void
  request: () => Promise<{ started: boolean; error?: string }>
  chinese: boolean
}): void {
  const { button, setBusy, showError, request, chinese } = options
  button.addEventListener('click', () => {
    if (button.disabled) return
    button.disabled = true
    setBusy(true)
    button.textContent = chinese ? '正在重启…' : 'Restarting…'
    let finished = false
    const fail = (message: string): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      button.disabled = false
      setBusy(false)
      button.textContent = chinese ? '重试重启' : 'Retry restart'
      showError((chinese ? '重启未完成：' : 'Restart failed: ') + message)
    }
    const timer = setTimeout(() => {
      fail(chinese ? '尚未确认客户端退出，请稍后重试。' : 'Client exit has not been confirmed. Try again later.')
    }, 15_000)
    void Promise.resolve().then(request).then(result => {
      if (!result.started) fail(result.error || (chinese ? '重启失败' : 'Restart failed'))
      // An acknowledgement is not proof of exit. Keep the watchdog until this document closes.
    }, (error: unknown) => { fail(error instanceof Error ? error.message : String(error)) })
  })
}
