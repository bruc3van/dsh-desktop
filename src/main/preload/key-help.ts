import { visible } from '../settings-adapter.ts'

// ---------------------------------------------------------------------------
// "Where do I get a key?" line under the OFFICIAL DeepSeek credential field.
//
// The official first-run modal ("添加一个 API Key 开始使用") and the Models
// provider editor both ask for a key without saying where to create one, which
// strands a user who has never visited the platform. One appended line, same
// append-only rule as the card above: DeepSeek surfaces only, silently absent
// when the heuristic misses. The anchor opens through the main process's
// window-open handler, i.e. in the system browser.
// ---------------------------------------------------------------------------

const KEY_HELP_CLASS = 'dsh-desktop-key-help'
const DEEPSEEK_KEY_URL = 'https://platform.deepseek.com/api_keys'

/**
 * The container to append the hint to: the credential field's own row, but
 * only when its nearest provider card is the official DeepSeek card, or the
 * field belongs to the dedicated first-run DeepSeek dialog. Never climb to
 * the whole Models section: that section also contains custom-provider forms.
 */
function keyHelpHost(input: HTMLInputElement): Element | null {
  const row = input.parentElement
  if (row === null) return null

  const providerCard = input.closest('li')
  if (providerCard !== null) {
    return /deepseek-official/i.test(providerCard.textContent ?? '') ? row : null
  }

  const dialog = input.closest('[role="dialog"]')
  const dialogText = dialog?.textContent ?? ''
  if (/official DeepSeek provider|DeepSeek 官方模型/i.test(dialogText)) return row
  return null
}

/** Append the platform link under every visible DeepSeek key field. */
export function injectKeyHelp(): void {
  const inputs = document.querySelectorAll('input[type="password"]')
  if (inputs.length === 0) return

  if (document.getElementById(KEY_HELP_CLASS + '-style') === null) {
    const style = document.createElement('style')
    style.id = KEY_HELP_CLASS + '-style'
    // Official secondary-text language, via the official theme variables so
    // the line follows the appearance setting (light/dark/system).
    style.textContent = '.' + KEY_HELP_CLASS + '{margin:8px 0 0;font-size:13px;line-height:20px;'
      + 'color:var(--dsw-alias-label-secondary,#6E7480)}'
      + '.' + KEY_HELP_CLASS + ' a{color:var(--dsw-alias-label-primary,#0F1115);text-decoration:underline;cursor:pointer}'
    document.head.appendChild(style)
  }

  for (const element of inputs) {
    const input = element as HTMLInputElement
    if (!visible(input)) continue
    const host = keyHelpHost(input)
    if (host === null || host.querySelector('.' + KEY_HELP_CLASS) !== null) continue
    // The official copy follows the language setting; match it off the field's
    // own placeholder rather than a document-level guess.
    const english = /^Enter (your |an )?API key/i.test(input.placeholder)
    const help = document.createElement('p')
    help.className = KEY_HELP_CLASS
    const anchor = document.createElement('a')
    anchor.href = DEEPSEEK_KEY_URL
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    anchor.textContent = english ? 'Create one on the DeepSeek platform' : '前往 DeepSeek 开放平台创建'
    help.append(english ? 'No API key yet? ' : '还没有 API Key？', anchor)
    host.appendChild(help)
  }
}
