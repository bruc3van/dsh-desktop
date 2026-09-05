export const ENHANCE_ID = 'dsh-desktop-enhance'
export const UPDATE_ID = 'dsh-desktop-update'
export const DESKTOP_TAB_ID = 'dsh-desktop-tab'
export const DESKTOP_PANEL_ID = 'dsh-desktop-panel'
export const RELEASES_PAGE_URL = 'https://github.com/bruc3van/dsh-desktop/releases'

/**
 * The "open the releases page" glyph, beside 检查更新. An in-app download can
 * fail on a machine that reaches GitHub only through a proxy this process does
 * not use, and the manual page is then the way out. Inline SVG so it follows
 * the official theme's text colour; the anchor leaves through the main
 * process's window-open handler, i.e. in the system browser.
 */
export const EXTERNAL_LINK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'
  + '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>'
