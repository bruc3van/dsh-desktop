import { findSettingsDialog, findNavList } from '../settings-adapter.ts'

/**
 * The cards' language, resolved from the official nav labels at the moment of
 * the call — the active tab is ours while they are showing, so the language
 * has to be read off the tab list itself. Chinese when the dialog is away.
 */
export function currentEnglish(): boolean {
  const dialog = findSettingsDialog()
  if (dialog === null) return false
  const navList = findNavList(dialog)
  if (navList === null) return false
  for (const child of navList.children) {
    const label = child.textContent?.trim() ?? ''
    if (label === '通用设置') return false
    if (label === 'General' || label === 'General Settings') return true
  }
  return false
}
