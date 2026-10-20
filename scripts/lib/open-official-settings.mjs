/**
 * Open the official Settings dialog.
 *
 * DSH 0.2.1 moved the entry from a sidebar button into the account menu
 * (aria-label 账号菜单 / Account menu). Cmd/Ctrl+, is claimed by this client
 * for its own Desktop settings window, so checks that need the official
 * dialog must go through that menu.
 */
export async function openOfficialSettings(page) {
  const accountMenu = page.getByRole('button', { name: /账号菜单|Account menu/ })
  await accountMenu.waitFor({ state: 'visible', timeout: 60_000 })
  await accountMenu.click()
  const item = page.getByRole('menuitem', { name: /^(设置|Settings)$/ })
  if (await item.count() > 0) {
    await item.first().click()
    return
  }
  await page.getByText(/^(设置|Settings)$/, { exact: true }).last().click()
}
