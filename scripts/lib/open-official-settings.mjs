/**
 * Open the official Settings dialog.
 *
 * DSH 0.2.1 moved the entry from a sidebar button into the account menu
 * (aria-label 账号菜单 / Account menu). Cmd/Ctrl+, is claimed by this client
 * for its own Desktop settings window, so checks that need the official
 * dialog must go through that menu.
 */

const MASK = 'div[aria-hidden="true"][class*="_mask_"]'
const ACCOUNT_MENU = /账号菜单|Account menu/
/** How long the page must stay free of any modal mask to count as settled. */
const QUIET_MS = 3_000

/**
 * Close whatever modal is on top, choosing only buttons that cannot start
 * anything: the dialog's own close button, or its sole action when it has just
 * one (the preview notice's 继续 / Continue). Anything else gets Escape — never
 * 登录 / Sign in or 添加 API Key, which would leave the page for a sign-in flow
 * or another dialog instead of closing this one.
 */
async function dismissTopDialog(page) {
  const dialog = page.locator('[role="dialog"]').filter({ visible: true }).last()
  const close = dialog.getByRole('button', { name: /^(关闭|Close)$/ })
  const actions = dialog.locator('button:not([disabled])').filter({ visible: true })
  // A dialog that is already animating out may detach under the click; the
  // caller looks again either way, so a click that misses is not an error.
  if (await close.count() > 0) {
    await close.first().click({ timeout: 2_000 }).catch(() => {})
  } else if (await actions.count() === 1) {
    await actions.first().click({ timeout: 2_000 }).catch(() => {})
  } else {
    await page.keyboard.press('Escape')
  }
}

/**
 * Close the first-run dialogs of a fresh profile and wait until no more arrive.
 *
 * They come one after another, not together: the preview notice first, then —
 * a few hundred milliseconds after it closes, longer on a slow runner — the
 * signed-out "开始使用 / Get started" dialog, which also returns after the
 * Settings dialog closes. Any fixed wait races that queue. So the page counts as
 * settled only once it has gone QUIET_MS without any modal mask at all, and
 * every dialog that shows up in the meantime restarts the clock.
 */
export async function settleFirstRunDialogs(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    if (await page.locator(MASK).filter({ visible: true }).count() === 0) {
      if (Date.now() - quietSince >= QUIET_MS) return
      await page.waitForTimeout(200)
      continue
    }
    await dismissTopDialog(page)
    await page.waitForTimeout(300)
    quietSince = Date.now()
  }
  throw new Error('first-run dialogs did not settle within ' + timeoutMs + 'ms')
}

export async function openOfficialSettings(page) {
  const accountMenu = page.getByRole('button', { name: ACCOUNT_MENU })
  await accountMenu.waitFor({ state: 'visible', timeout: 60_000 })
  // A dialog can still arrive after the page settled. A click it intercepts
  // fails fast here rather than after Playwright's 30-second retry, and the
  // next attempt clears it first.
  for (let attempt = 1; ; attempt += 1) {
    await settleFirstRunDialogs(page)
    try {
      await accountMenu.click({ timeout: 5_000 })
      break
    } catch (error) {
      if (attempt >= 3) throw error
    }
  }
  const item = page.getByRole('menuitem', { name: /^(设置|Settings)$/ })
  if (await item.count() > 0) {
    await item.first().click()
    return
  }
  await page.getByText(/^(设置|Settings)$/, { exact: true }).last().click()
}
