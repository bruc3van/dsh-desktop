/** Respond through the client dialog's real action link, scoped to this test app. */
export async function respondToConfirmations(app, response = 1) {
  await app.evaluate(({ app }, response) => {
    globalThis.confirmationResponse = response
    globalThis.confirmationCalls = 0
    if (globalThis.confirmationFixtureInstalled) return
    globalThis.confirmationFixtureInstalled = true
    app.on('browser-window-created', (_event, window) => {
      window.webContents.on('did-finish-load', () => {
        if (!window.webContents.getURL().startsWith('data:text/html')) return
        void window.webContents.executeJavaScript("document.querySelector('.eyebrow')?.textContent.startsWith('DSH Desktop')").then(async confirmation => {
          if (!confirmation) return
          globalThis.confirmationCalls++
          await window.webContents.executeJavaScript(`(() => {
            const action = document.querySelector('a[href="dsh-plugin-recovery:${globalThis.confirmationResponse}"]');
            if (!action) throw new Error('Confirmation action is missing');
            action.click();
          })()`)
        }).catch(error => {
          console.error('confirmation fixture:', error)
          app.exit(1)
        })
      })
    })
  }, response)
}
