import { escapeHtml } from './html.ts'
import { hostTokensCss } from './tokens.ts'

export function renderClientNoticePageUrl(copy: {
  heading: string
  hint: string
  addressLabel: string
  address: string
  action: string
}, chinese: boolean, icon: string): string {
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.heading) + '</title><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;font-size:14px;line-height:22px}'
    + 'main{min-height:100vh;padding:24px 24px 20px;display:flex;flex-direction:column}'
    + '.intro{display:flex;align-items:flex-start;gap:14px}'
    + '.mark{width:40px;height:40px;flex:0 0 auto;border-radius:10px;box-shadow:var(--dsw-elevation-panel)}'
    + '.heading{min-width:0}h1{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.hint{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}'
    + '.facts{margin:16px 0 0;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}'
    + '.fact{display:flex;gap:12px;font-size:13px;line-height:20px}'
    + 'dt{flex:0 0 auto;min-width:' + (chinese ? '32px' : '58px') + ';margin:0;color:var(--dsw-alias-label-tertiary)}'
    + 'dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-all}'
    + '.footer{margin-top:auto;padding-top:20px}.divider{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:0 -24px 16px}'
    + '.actions{display:flex;justify-content:flex-end}'
    + '.button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;white-space:nowrap;text-decoration:none;font:inherit;font-size:14px;line-height:22px;font-weight:500;'
    + 'border:0;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){.button:hover{background:var(--dsw-alias-button-primary-hover)}}'
    + '.button:active{background:var(--dsw-alias-button-primary-hover);opacity:.9}'
    + '</style></head><body><main><div class="intro">' + icon
    + '<div class="heading"><h1>' + escapeHtml(copy.heading) + '</h1>'
    + '<p class="hint">' + escapeHtml(copy.hint) + '</p></div></div>'
    + '<dl class="facts"><div class="fact"><dt>' + escapeHtml(copy.addressLabel) + '</dt>'
    + '<dd>' + escapeHtml(copy.address) + '</dd></div></dl>'
    + '<div class="footer"><hr class="divider"><div class="actions">'
    + '<a id="notice-dismiss" class="button" href="dsh-notice-action:dismiss" target="_blank">' + escapeHtml(copy.action) + '</a>'
    + '</div></div></main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
