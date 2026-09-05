import { findSettingsDialog, findOptions, findNavList, findGeneralNavItem } from '../settings-adapter.ts'
import { DESKTOP_TAB_ID, DESKTOP_PANEL_ID, UPDATE_ID } from './constants.ts'
import { injectEnhance } from './connection-card.ts'
import { injectUpdate, refreshUpdateLanguage } from './update-card.ts'
import { currentEnglish } from './language.ts'

/** CSS-module "active" tokens ("active_ab12c", "navItem--active") — not "interactive". */
function isActiveToken(cls: string): boolean {
  return /(^|[-_])active/i.test(cls)
}

/** Monitor glyph for the injected nav item, in place of the cloned tab's icon. */
const DESKTOP_TAB_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path></svg>'

let desktopTabSelected = false
/** The official active class, learned from whichever tab was active when ours was selected. */
let officialActiveClass = ''
/** Exactly which elements lost that class to us, so deselecting restores them. */
let strippedActive: { el: Element; cls: string; label: string }[] = []
const hiddenOfficialPanels = new Set<HTMLElement>()
let hookedNavList: Element | null = null

function desktopTabLabel(english: boolean): string {
  return english ? 'Desktop' : '桌面设置'
}

/** Retext the cloned item's visible label without disturbing its icon. */
function setNavLabel(item: Element, label: string): void {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if ((node.textContent ?? '').trim() !== '') {
      if (node.textContent !== label) node.textContent = label
      return
    }
    node = walker.nextNode()
  }
  item.appendChild(document.createTextNode(label))
}

/** The label of the nav item (navList child) an active token sits on or inside. */
function navItemLabel(el: Element, navList: Element): string {
  let node: Element | null = el
  while (node !== null && node.parentElement !== navList) node = node.parentElement
  return (node ?? el).textContent?.trim() ?? ''
}


/**
 * Keep the 桌面设置 nav item seated below 通用设置. It is a deep clone of the
 * 通用设置 item so it inherits the official look; the clone is then scrubbed
 * of anything the official code might key on (active tokens, data-*, ARIA
 * state) and its clicks never reach the official handlers.
 */
function ensureDesktopTab(navList: Element): void {
  let item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && item.parentElement !== navList) {
    item.remove()
    item = null
  }
  if (item === null) {
    const general = findGeneralNavItem(navList)
    if (general === null) return
    const clone = general.cloneNode(true) as HTMLElement
    clone.id = DESKTOP_TAB_ID
    for (const el of [clone, ...clone.querySelectorAll('[class]')]) {
      for (const cls of [...el.classList]) if (isActiveToken(cls)) el.classList.remove(cls)
    }
    for (const name of clone.getAttributeNames()) {
      if (name.startsWith('data-') || name === 'aria-current' || name === 'aria-selected') clone.removeAttribute(name)
    }
    // Inline on* handlers never belong on this tab: its clicks are routed by
    // this preload alone, and a template change upstream must not smuggle a
    // live handler into the clone.
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('on')) el.removeAttribute(name)
      }
    }
    const icon = clone.querySelector('svg')
    if (icon !== null) {
      const template = document.createElement('template')
      template.innerHTML = DESKTOP_TAB_SVG
      const monitor = template.content.firstElementChild
      if (monitor !== null) {
        for (const name of ['class', 'width', 'height']) {
          const value = icon.getAttribute(name)
          if (value !== null) monitor.setAttribute(name, value)
        }
        icon.replaceWith(monitor)
      }
    }
    clone.addEventListener('click', (event) => {
      // The clone may carry official routing hooks (href, delegated handlers);
      // this tab exists only client-side, so the click must not leave it.
      event.preventDefault()
      event.stopPropagation()
      desktopTabSelected = true
      applyDesktopSelection()
    })
    navList.insertBefore(clone, general.nextElementSibling)
    item = clone
  }
  setNavLabel(item, desktopTabLabel(currentEnglish()))
  const list = navList as HTMLElement
  if (list.dataset.dshNavHooked === undefined) {
    list.dataset.dshNavHooked = '1'
    navList.addEventListener('click', onOfficialNavClick, true)
    hookedNavList = navList
  }
}

/** Capture-phase: an official tab was clicked while ours was selected — hand everything back. */
function onOfficialNavClick(event: Event): void {
  if (!desktopTabSelected) return
  const target = event.target
  if (!(target instanceof Element)) return
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && (target === item || item.contains(target))) return
  deselectDesktopTab()
}

/**
 * Revert every change selection made. On a direct click this runs BEFORE the
 * official handler: React bails out when the clicked tab is the one it still
 * believes active, and would then never repaint the class we removed. When
 * the official UI has already moved on by itself (restoreActive=false) the
 * class is NOT put back — React repainted the nav and re-adding it would
 * highlight two tabs at once.
 */
function deselectDesktopTab(restoreActive = true): void {
  desktopTabSelected = false
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item !== null && officialActiveClass !== '') item.classList.remove(officialActiveClass)
  document.getElementById(DESKTOP_PANEL_ID)?.remove()
  if (restoreActive) for (const entry of strippedActive) entry.el.classList.add(entry.cls)
  strippedActive = []
  for (const hidden of hiddenOfficialPanels) {
    hidden.style.display = hidden.dataset.dshHidden ?? ''
    delete hidden.dataset.dshHidden
  }
  hiddenOfficialPanels.clear()
}

/** Selection, resolved from the live dialog (the click handler's entry point). */
function applyDesktopSelection(): void {
  const dialog = findSettingsDialog()
  if (dialog === null) return
  const navList = findNavList(dialog)
  const options = findOptions(dialog)
  if (navList === null || options === null) return
  enforceDesktopSelection(navList, options)
}

/**
 * While our tab is selected: strip the official active token (remembering
 * where it was), wear it ourselves, hide the official panels, and keep our
 * panel — with the connection and app-update cards — seated in the options
 * column. Idempotent; the probe re-runs it so official re-renders (which
 * neither see nor preserve our changes) are re-overridden.
 */
function enforceDesktopSelection(navList: Element, options: Element): void {
  const item = document.getElementById(DESKTOP_TAB_ID)
  if (item === null) return
  const activeEls: Element[] = []
  for (const el of navList.querySelectorAll('[class*="active"]')) {
    if (el === item || item.contains(el)) continue
    if ([...el.classList].some(isActiveToken)) activeEls.push(el)
  }
  // An active token on a tab we never stripped means the official UI switched
  // tabs by a path other than a click (keyboard navigation, programmatic):
  // yield to the tab the user chose instead of suppressing it.
  if (strippedActive.length > 0) {
    for (const el of activeEls) {
      const label = navItemLabel(el, navList)
      if (!strippedActive.some(entry => entry.label === label)) {
        deselectDesktopTab(false)
        return
      }
    }
  }
  for (const el of activeEls) {
    const label = navItemLabel(el, navList)
    for (const cls of [...el.classList]) {
      if (!isActiveToken(cls)) continue
      officialActiveClass = cls
      el.classList.remove(cls)
      if (!strippedActive.some(entry => entry.el === el && entry.cls === cls)) strippedActive.push({ el, cls, label })
    }
  }
  if (officialActiveClass !== '') item.classList.add(officialActiveClass)
  for (const child of options.children) {
    if (child.id === DESKTOP_PANEL_ID) continue
    const el = child as HTMLElement
    if (el.dataset.dshHidden === undefined) {
      el.dataset.dshHidden = el.style.display
      el.style.display = 'none'
      hiddenOfficialPanels.add(el)
    }
  }
  let panel = document.getElementById(DESKTOP_PANEL_ID)
  if (panel !== null && panel.parentElement !== options) {
    panel.remove()
    panel = null
  }
  if (panel === null) {
    panel = document.createElement('div')
    panel.id = DESKTOP_PANEL_ID
    options.appendChild(panel)
  }
  injectEnhance(panel)
  injectUpdate(panel)
  const card = document.getElementById(UPDATE_ID)
  if (card !== null) refreshUpdateLanguage(card as HTMLElement, currentEnglish())
}

export function removeSettingsIntegration(): void {
  deselectDesktopTab()
  document.getElementById(DESKTOP_TAB_ID)?.remove()
  if (hookedNavList !== null) {
    hookedNavList.removeEventListener('click', onOfficialNavClick, true)
    delete (hookedNavList as HTMLElement).dataset.dshNavHooked
    hookedNavList = null
  }
  officialActiveClass = ''
}


export function reconcileSettingsNavigation(navList: Element, options: Element): boolean {
  if (hookedNavList !== null && hookedNavList !== navList) removeSettingsIntegration()
  ensureDesktopTab(navList)
  if (document.getElementById(DESKTOP_TAB_ID)?.parentElement !== navList) return false
  if (desktopTabSelected) enforceDesktopSelection(navList, options)
  return true
}
