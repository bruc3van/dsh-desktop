import { escapeHtml } from './html.ts'

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
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#fff;color:#0f1115;font-size:14px;line-height:1.6}'
    + 'main{min-height:100vh;padding:28px 28px 22px;display:flex;flex-direction:column}'
    + '.intro{display:flex;align-items:flex-start;gap:14px}'
    + '.mark{width:40px;height:40px;flex:0 0 auto;border-radius:10px;box-shadow:0 8px 22px rgba(15,17,21,.12)}'
    + '.heading{min-width:0}h1{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-.01em}'
    + '.hint{margin:8px 0 0;color:#6e7480;font-size:13px;line-height:20px}'
    + '.facts{margin:18px 0 0;padding:12px 14px;border:1px solid #ebeef2;border-radius:12px;background:#fafbfc}'
    + '.fact{display:flex;gap:12px;font-size:13px;line-height:20px}'
    + 'dt{flex:0 0 auto;min-width:' + (chinese ? '32px' : '58px') + ';margin:0;color:#9aa0a6}'
    + 'dd{margin:0;min-width:0;color:#0f1115;word-break:break-all}'
    + '.footer{margin-top:auto;padding-top:22px}.divider{border:0;border-top:1px solid #ebeef2;margin:0 -28px 16px}'
    + '.actions{display:flex;justify-content:flex-end}'
    + '.button{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;text-decoration:none;font:inherit;font-size:13px;line-height:20px;'
    + 'border:1px solid #0f1115;border-radius:28px;padding:7px 18px;color:#fff;background:#0f1115;outline:none;transition:opacity .15s ease,box-shadow .15s ease}'
    + '.button:hover{opacity:.88}.button:focus-visible{box-shadow:0 0 0 3px rgba(15,17,21,.14)}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}.mark{box-shadow:0 8px 22px rgba(0,0,0,.32)}'
    + '.hint{color:#aeb3bb}.facts{border-color:#2c2e33;background:#1e1f22}dt{color:#818791}dd{color:#f4f5f6}'
    + '.divider{border-color:#2c2e33}.button{background:#f4f5f6;border-color:#f4f5f6;color:#17181a}'
    + '.button:focus-visible{box-shadow:0 0 0 3px rgba(244,245,246,.18)}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
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
