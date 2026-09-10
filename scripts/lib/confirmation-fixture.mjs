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
      const nativeWindow = await app.browserWindow(page)
      const deadline = Date.now() + 10_000
      while (!await nativeWindow.evaluate(window => window.isVisible())) {
        if (Date.now() >= deadline) throw new Error('Confirmation window never became visible')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      console.log('confirmation fixture:', await page.locator('h1').innerText(), await nativeWindow.evaluate(window => {
        window.on('close', event => console.log('confirmation native close:', window.id, event.defaultPrevented))
        window.on('closed', () => console.log('confirmation native closed'))
        window.webContents.on('will-navigate', (_event, url) => console.log('confirmation navigation:', url))
        return { id: window.id, modal: window.isModal(), visible: window.isVisible(), parent: window.getParentWindow()?.id }
      }))
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
      console.log('confirmation action dispatched')
      await closed
    })().catch(error => {
      console.error('confirmation fixture:', error)
      void app.evaluate(({ app }) => app.exit(1)).catch(() => {})
    })
  })
}
