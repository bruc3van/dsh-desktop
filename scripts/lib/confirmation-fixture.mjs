const responders = new WeakMap()

/** Wait for the real dialog to be ready before clicking its action. */
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
      await page.locator(`a[href="dsh-plugin-recovery:${state.response}"]`).click({ noWaitAfter: true }).catch(error => {
        if (!page.isClosed()) throw error
      })
      await closed
    })().catch(error => {
      console.error('confirmation fixture:', error)
      void app.evaluate(({ app }) => app.exit(1)).catch(() => {})
    })
  })
}
