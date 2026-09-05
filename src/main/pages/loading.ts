
export function renderLoadingPageUrl(chinese: boolean, icon: string): string {
  const title = chinese ? '正在启动 DSH Desktop' : 'Starting DSH Desktop'
  const hint = chinese ? '首次启动通常需要 10–20 秒' : 'The first launch usually takes 10–20 seconds'
  // The only connection seat reachable while the Web UI itself cannot load:
  // the official settings dialog (and its enhanced 连接 block) needs a page.
  const action = chinese ? 'Web UI 连接…' : 'Web UI connection…'
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + title + '</title><style>'
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0f1115}'
    + 'main{width:min(360px,calc(100vw - 48px));text-align:center}.mark{width:64px;height:64px;border-radius:16px;box-shadow:0 12px 32px rgba(15,17,21,.14)}'
    + 'h1{margin:22px 0 8px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}'
    + '#loading-status{margin:0;color:#6e7480;font-size:14px;line-height:22px}.hint{margin:8px 0 0;color:#9aa0a6;font-size:12px;line-height:18px}'
    + '.activity{height:20px;margin:20px auto 0;display:flex;justify-content:center;align-items:center;gap:6px}'
    // An author rule beats the UA stylesheet, so [hidden] needs restating here.
    + '.activity[hidden],.hint[hidden],.action[hidden],#loading-status[hidden]{display:none}'
    + '.action{margin:20px auto 0;display:block;font:inherit;font-size:13px;color:#0f1115;background:transparent;'
    + 'border:1px solid #d8d8d4;border-radius:28px;padding:7px 18px;cursor:pointer}'
    + '.action:hover{background:#f5f6f7}'
    + '.activity i{display:block;width:5px;height:5px;border-radius:50%;background:#0f1115;animation:pulse 1.2s ease-in-out infinite}'
    + '.activity i:nth-child(2){animation-delay:.16s}.activity i:nth-child(3){animation-delay:.32s}'
    + '@keyframes pulse{0%,70%,100%{opacity:.18;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)}}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}.mark{box-shadow:0 12px 32px rgba(0,0,0,.34)}#loading-status{color:#aeb3bb}.hint{color:#818791}.activity i{background:#f4f5f6}'
    + '.action{color:#f4f5f6;border-color:#3a3d42}.action:hover{background:#232529}}'
    + '@media(prefers-reduced-motion:reduce){.activity i{animation:none}.activity i:nth-child(2){opacity:.5}.activity i:nth-child(3){opacity:.8}}'
    + '</style></head><body><main>' + icon
    + '<h1>' + title + '</h1><p id="loading-status" hidden></p><p class="hint">' + hint + '</p>'
    + '<div class="activity" aria-hidden="true"><i></i><i></i><i></i></div>'
    + '<button class="action" id="loading-action" type="button" hidden>' + action + '</button>'
    + '</main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
