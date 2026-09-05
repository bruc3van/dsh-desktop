import { escapeHtml } from './html.ts'

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
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0f1115;padding:32px 24px}'
    + 'main{width:min(420px,100%);text-align:center}'
    + '.mark{width:64px;height:64px;border-radius:16px;box-shadow:0 12px 32px rgba(15,17,21,.14)}'
    + 'h1{margin:22px 0 0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}'
    + '.hint{margin:10px 0 0;color:#6e7480;font-size:14px;line-height:22px}'
    + '.facts{margin:22px 0 0;padding:12px 14px;text-align:left;border:1px solid #ebeef2;border-radius:12px;background:#fafbfc;max-height:min(42vh,360px);overflow:auto}'
    + '.fact{display:flex;gap:12px;font-size:13px;line-height:20px}.fact+.fact{margin-top:8px}'
    + 'dt{flex:0 0 auto;min-width:' + (chinese ? '32px' : '58px') + ';margin:0;color:#9aa0a6}'
    + 'dd{margin:0;min-width:0;color:#0f1115;word-break:break-word;white-space:pre-wrap}'
    + '.actions{margin:24px 0 0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}'
    + 'button{white-space:nowrap;font:inherit;font-size:13px;font-weight:400;background:transparent;'
    + 'border:1px solid #d8d8d4;border-radius:28px;padding:7px 18px;color:#0f1115;cursor:pointer;transition:background .15s ease,opacity .15s ease}'
    + 'button:hover{background:#f5f6f7}'
    + 'button.primary{background:#0f1115;border-color:#0f1115;color:#fff}button.primary:hover{opacity:.88;background:#0f1115}'
    + 'button.ghost{border-color:transparent;color:#6e7480}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}'
    + '.mark{box-shadow:0 12px 32px rgba(0,0,0,.34)}.hint{color:#aeb3bb}'
    + '.facts{border-color:#2c2e33;background:#1e1f22}dt{color:#818791}dd{color:#f4f5f6}'
    + 'button{border-color:#3a3d42;color:#f4f5f6}button:hover{background:#232529}'
    + 'button.primary{background:#f4f5f6;border-color:#f4f5f6;color:#17181a}button.primary:hover{opacity:.88;background:#f4f5f6}'
    + 'button.ghost{border-color:transparent;color:#aeb3bb}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
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
