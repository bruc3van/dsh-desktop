const responders = new WeakMap()

/** Respond through the dialog's window action handler after it is ready. */
export async function respondToConfirmations(app, response = 1) {
  await app.evaluate(() => { globalThis.confirmationCalls = 0 })
  const existing = responders.get(app)
  if (existing) { existing.response = response; return }
  const state = { response }
  responders.set(app, state)
  app.on('window', page => {
    void (async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 })
      if (!page.url().startsWith('data:text/html')) return
      if (!await page.locator('.eyebrow').count()) return
      await page.waitForFunction(() => document.activeElement?.id === 'default-action', null, { timeout: 10_000 })
      await app.evaluate(() => { globalThis.confirmationCalls++ })
      const closed = page.waitForEvent('close', { timeout: 10_000 })
      // Modal sheets can consume synthetic mouse clicks on macOS. Dialog UI
      // checks cover actual clicks/keys; these integration checks exercise the
      // same action through the window-open handler without depending on focus.
      await page.evaluate(response => {
        const action = document.querySelector(`a[href="dsh-plugin-recovery:${response}"]`)
        if (!action) throw new Error('Confirmation action is missing')
        window.open(action.href)
      }, state.response).catch(error => {
        if (!page.isClosed()) throw error
      })
      await closed
    })().catch(error => {
      console.error('confirmation fixture:', error)
      void app.evaluate(({ app }) => app.exit(1)).catch(() => {})
    })
  })
}
