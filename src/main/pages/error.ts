import { escapeHtml } from './html.ts'
import { hostTokensCss } from './tokens.ts'

export function renderErrorPageUrl(copy: {
  title: string
  hint: string
  addressLabel: string
  address: string
  reasonLabel: string
  reason: string
  reasonLimit?: number
  retry: string
  settings: string
  quit: string
  /** Offered only when a pinned address failed: leave it for Smart mode. */
  useSmart?: string
  /** Lock / record path. Shown in full — a long DSH_HOME must not be sliced off. */
  recordLabel?: string
  recordPath?: string
}, chinese: boolean, icon: string): string {
  const fact = (label: string, value: string, limit?: number): string => {
    if (value === '') return ''
    const shown = limit === undefined ? value : value.slice(0, limit)
    return '<div class="fact"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(shown) + '</dd></div>'
  }
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.title) + '</title><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 24px}'
    + 'main{width:min(680px,100%);text-align:center}'
    + '.mark{width:56px;height:56px;border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel)}'
    + 'h1{margin:20px 0 0;font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.hint{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}'
    + '.facts{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);margin:24px 0 0;padding:16px 20px;text-align:left;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);max-height:min(42vh,360px);overflow:auto}'
    + '.fact{display:flex;gap:12px;font-size:13px;line-height:20px}.fact+.fact{margin-top:8px}'
    + 'dt{flex:0 0 auto;min-width:' + (chinese ? '32px' : '58px') + ';margin:0;color:var(--dsw-alias-label-tertiary)}'
    + 'dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap}'
    + '.actions{margin:24px 0 0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}'
    + 'button{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;font:inherit;font-size:14px;line-height:22px;font-weight:400;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:transparent;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}'
    + 'button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}'
    + 'button:disabled{opacity:.4;cursor:not-allowed}'
    + 'button.primary{background:var(--dsw-alias-button-primary-fill);box-shadow:none;color:var(--dsw-alias-label-primary-foreground);font-weight:500}'
    + '@media(hover:hover){button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}'
    + 'button.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover);opacity:.9}'
    + 'button.ghost{box-shadow:none;color:var(--dsw-alias-label-secondary)}'
    + '@media(hover:hover){button.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}'
    + '@media(max-width:767px){body{padding:24px 20px}}'
    + '</style></head><body><main>' + icon
    + '<h1>' + escapeHtml(copy.title) + '</h1>'
    + '<p class="hint">' + escapeHtml(copy.hint) + '</p>'
    + '<dl class="facts">'
    + fact(copy.addressLabel, copy.address, 300)
    + fact(copy.reasonLabel, copy.reason, copy.reasonLimit ?? 300)
    + fact(copy.recordLabel ?? '', copy.recordPath ?? '')
    + '</dl>'
    + '<div class="actions">'
    + '<button id="error-retry" class="primary" type="button">' + escapeHtml(copy.retry) + '</button>'
    + (copy.useSmart === undefined
      ? ''
      : '<button id="error-use-smart" type="button">' + escapeHtml(copy.useSmart) + '</button>')
    + '<button id="error-settings" type="button">' + escapeHtml(copy.settings) + '</button>'
    + '<button id="error-quit" class="ghost" type="button">' + escapeHtml(copy.quit) + '</button>'
    + '</div></main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
