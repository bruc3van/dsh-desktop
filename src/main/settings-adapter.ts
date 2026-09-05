/** Read-only adapter for the currently supported official settings DOM.
 * A missing dialog is normal. Only a recognizable dialog with an unsupported
 * structure is a compatibility failure; never broaden matching to guess a host.
 */
import type { SettingsIntegrationFailure } from './settings-integration.ts'

export function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export function findSettingsDialog(): Element | null {
  for (const el of document.querySelectorAll('[role="dialog"]')) {
    if (!visible(el)) continue
    const text = el.textContent ?? ''
    if (text.includes('设置') || text.includes('Settings')) return el
  }
  for (const el of document.querySelectorAll('[class*="modal" i], [class*="dialog" i], [class*="popover" i], [class*="drawer" i], [class*="sheet" i]')) {
    if (!visible(el) || el.tagName === 'BUTTON' || el.tagName === 'INPUT') continue
    const text = el.textContent ?? ''
    if (text.includes('设置') && text.length < 6000) return el
  }
  return null
}

export function findOptions(dialog: Element): Element | null {
  const content = [...dialog.children].find(c => String(c.className ?? '').includes('content'))
  if (content === undefined) return null
  return [...content.children].find(c => String(c.className ?? '').includes('options')) ?? null
}

export function findNavList(dialog: Element): Element | null {
  return dialog.querySelector('[class*="navList"]')
}

export function findGeneralNavItem(navList: Element): Element | null {
  for (const child of navList.children) {
    if (child.id === 'dsh-desktop-tab') continue
    const label = child.textContent?.trim() ?? ''
    if (label === '通用设置' || label === 'General' || label === 'General Settings') return child
  }
  return null
}

export type SettingsHost =
  | { state: 'absent' }
  | { state: 'unsupported'; reason: SettingsIntegrationFailure; dialog: Element }
  | { state: 'matched'; dialog: Element; navList: Element; options: Element }

export function inspectSettingsHost(): SettingsHost {
  const dialog = findSettingsDialog()
  if (dialog === null) return { state: 'absent' }
  const navList = findNavList(dialog)
  if (navList === null) return { state: 'unsupported', reason: 'missing-navigation', dialog }
  const options = findOptions(dialog)
  if (options === null) return { state: 'unsupported', reason: 'missing-content', dialog }
  if (findGeneralNavItem(navList) === null) return { state: 'unsupported', reason: 'missing-general-tab', dialog }
  return { state: 'matched', dialog, navList, options }
}
