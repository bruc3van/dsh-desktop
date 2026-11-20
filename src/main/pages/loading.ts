import { hostTokensCss } from './tokens.ts'

export function renderLoadingPageUrl(chinese: boolean, icon: string): string {
  const title = chinese ? '正在启动 DSH Desktop Pro' : 'Starting DSH Desktop Pro'
  const hint = chinese ? '首次启动通常需要 10–20 秒' : 'The first launch usually takes 10–20 seconds'
  // The only connection seat reachable while the Web UI itself cannot load:
  // the official settings dialog (and its enhanced 连接 block) needs a page.
  const action = chinese ? 'Web UI 连接…' : 'Web UI connection…'
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + title + '</title><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center}'
    + 'main{width:min(360px,calc(100vw - 40px));text-align:center}.mark{width:56px;height:56px;border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel)}'
    + 'h1{margin:20px 0 8px;font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '#loading-status{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}.hint{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}'
    + '.activity{height:20px;margin:20px auto 0;display:flex;justify-content:center;align-items:center;gap:6px}'
    // An author rule beats the UA stylesheet, so [hidden] needs restating here.
    + '.activity[hidden],.hint[hidden],.action[hidden],#loading-status[hidden]{display:none}'
    + '.action{margin:20px auto 0;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;'
    + 'border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){.action:hover{background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.action:active{background:var(--dsw-alias-interactive-bg-active)}'
    + '.activity i{display:block;width:5px;height:5px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary);animation:pulse 1.2s ease-in-out infinite}'
    + '.activity i:nth-child(2){animation-delay:.16s}.activity i:nth-child(3){animation-delay:.32s}'
    + '@keyframes pulse{0%,70%,100%{opacity:.18;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)}}'
    + '@media(prefers-reduced-motion:reduce){.activity i:nth-child(2){opacity:.5}.activity i:nth-child(3){opacity:.8}}'
    + '</style></head><body><main>' + icon
    + '<h1>' + title + '</h1><p id="loading-status" hidden></p><p class="hint">' + hint + '</p>'
    + '<div class="activity" aria-hidden="true"><i></i><i></i><i></i></div>'
    + '<button class="action" id="loading-action" type="button" hidden>' + action + '</button>'
    + '</main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
