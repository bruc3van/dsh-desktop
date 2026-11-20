import { escapeHtml } from './html.ts'

const USER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="8" r="4"></circle><path d="M5 20a7 7 0 0 1 14 0"></path></svg>'

const ORG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 20V5.6A1.6 1.6 0 0 1 5.6 4h7.8A1.6 1.6 0 0 1 15 5.6V20M15 10h3.4A1.6 1.6 0 0 1 20 11.6V20M2 20h20M8 8h3M8 12h3M8 16h3"></path></svg>'

const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3.5 8.5l3 3 6-7"></path></svg>'

/**
 * First-run mode chooser shown once on a clean personal installation before
 * booting the local runtime: personal use proceeds straight to the official
 * Web UI (letting its own sign-in/key guide run once), while joining an
 * organisation enrolls first and skips personal setup altogether.
 */
export function renderOnboardingPageUrl(chinese: boolean, icon: string): string {
  const h = (zh: string, en: string): string => chinese ? zh : en
  const item = (zh: string, en: string): string => '<li>' + CHECK_SVG + '<span>' + escapeHtml(h(zh, en)) + '</span></li>'
  const title = h('欢迎使用 DSH Desktop Pro', 'Welcome to DSH Desktop Pro')
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(title) + '</title><style>'
    + ':root{color-scheme:light dark;--bg:#fff;--card:#fff;--surface:#f4f5f7;--ink:#0f1115;--muted:#6e7480;--faint:#9aa0a6;--line:#e6e8ec;'
    + '--accent:#0f1115;--accent-hover:#262930;--accent-fg:#fff;--ok:#16a34a;--danger:#dc2626;--field:#fff;--field-line:#dce0e6;--focus-ring:rgba(15,17,21,.1);'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#17181a;--card:#1d1f23;--surface:#222429;--ink:#f2f3f5;--muted:#9ba1ac;--faint:#6e7480;--line:rgba(255,255,255,.1);'
    + '--accent:#f2f3f5;--accent-hover:#e2e4e8;--accent-fg:#141518;--ok:#4ade80;--danger:#f87171;--field:#17181a;--field-line:rgba(255,255,255,.14);--focus-ring:rgba(242,243,245,.16)}}'
    + '*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}'
    + 'body{background:var(--bg);color:var(--ink);display:flex;flex-direction:column;min-height:100vh;-webkit-font-smoothing:antialiased}'
    + 'main{flex:1;display:grid;place-items:center;padding:36px 24px 20px}'
    + '.shell{width:min(760px,100%)}'
    + '.head{text-align:center;margin-bottom:28px}'
    + '.mark{width:52px;height:52px;border-radius:13px;display:block;margin:0 auto 16px}'
    + 'h1{font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.015em}'
    + '.lead{margin:6px 0 0;color:var(--muted);font-size:13.5px;line-height:21px}'
    + '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:stretch}'
    + '.card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 22px 20px;transition:border-color .15s ease}'
    + '.card:hover{border-color:color-mix(in srgb,var(--ink) 26%,var(--line))}'
    + '.card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}'
    + '.badge-icon{width:34px;height:34px;border-radius:9px;background:var(--surface);color:var(--ink);display:grid;place-items:center;flex:none}'
    + '.badge-icon svg{width:18px;height:18px}'
    + '.card h2{font-size:15.5px;font-weight:600;line-height:1.35}'
    + '.desc{color:var(--muted);font-size:13px;line-height:1.55}'
    + 'ul{list-style:none;margin:14px 0 18px;display:grid;gap:8px;flex:1}'
    + 'li{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.5;color:var(--ink)}'
    + 'li svg{width:15px;height:15px;flex:none;margin-top:2.5px;color:var(--ok)}'
    + '.card-foot{margin-top:auto}'
    + 'button{font:inherit;font-size:13.5px;line-height:1;cursor:pointer;border-radius:8px;transition:background .15s ease,border-color .15s ease,opacity .15s ease}'
    + 'button:disabled{opacity:.48;cursor:default}'
    + 'button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '.primary{display:block;width:100%;height:38px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font-weight:500}'
    + '.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}'
    + '.secondary{display:block;width:100%;height:38px;border:1px solid var(--field-line);background:transparent;color:var(--ink);font-weight:500}'
    + '.secondary:hover:not(:disabled){background:var(--surface)}'
    + '.join-form{display:flex;flex-direction:column;gap:8px}'
    + 'input{font:inherit;font-size:13px;width:100%;height:36px;padding:0 11px;border:1px solid var(--field-line);border-radius:8px;background:var(--field);color:var(--ink);outline:none;transition:border-color .15s ease,box-shadow .15s ease}'
    + 'input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--focus-ring)}'
    + 'input::placeholder{color:var(--faint)}'
    + '.status{margin-top:8px;font-size:12px;line-height:1.45;color:var(--muted);min-height:17px;overflow-wrap:anywhere}'
    + '.status.error{color:var(--danger)}'
    + '.status:empty{display:none}'
    + 'footer{display:flex;justify-content:center;gap:6px;padding:8px 16px 22px;flex-wrap:wrap}'
    + '.link{border:0;background:transparent;color:var(--muted);font-size:12.5px;padding:6px 10px;border-radius:6px}'
    + '.link:hover{color:var(--ink);background:var(--surface)}'
    + '@media(max-width:660px){.grid{grid-template-columns:1fr}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
    + '</style></head><body><main><div class="shell">'
    + '<div class="head">' + icon
    + '<h1>' + escapeHtml(title) + '</h1>'
    + '<p class="lead">' + escapeHtml(h('选择你的使用方式，之后随时可在桌面设置中切换。', 'Choose how you want to use it. You can switch any time in Desktop settings.')) + '</p>'
    + '</div>'
    + '<div class="grid">'
    + '<section class="card">'
    + '<div class="card-head"><span class="badge-icon">' + USER_SVG + '</span><h2>' + escapeHtml(h('个人使用', 'Personal use')) + '</h2></div>'
    + '<p class="desc">' + escapeHtml(h('直接启动本地内置 DSH 运行时，用自己的 DeepSeek 账号或模型 API Key 开始使用。', 'Start the bundled local DSH runtime with your own DeepSeek account or model API keys.')) + '</p>'
    + '<ul>'
    + item('开箱即用，自动启动内置 DSH 运行时', 'Ready out of the box with the bundled DSH runtime')
    + item('使用个人数据目录，支持自定义模型与插件', 'Uses your personal data directory, models and plugins')
    + item('内置精选插件索引与 DSH Market Pro', 'Includes the curated plugin index and DSH Market Pro')
    + '</ul>'
    + '<div class="card-foot"><button id="onboarding-personal" class="primary" type="button">' + escapeHtml(h('开始个人使用', 'Continue for personal use')) + '</button></div>'
    + '</section>'
    + '<section class="card">'
    + '<div class="card-head"><span class="badge-icon">' + ORG_SVG + '</span><h2>' + escapeHtml(h('加入企业 / 组织', 'Join an organisation')) + '</h2></div>'
    + '<p class="desc">' + escapeHtml(h('公司部署了管理服务端时，粘贴 IT 发给你的加入地址，用公司账号登录后自动完成配置。', 'If your company runs a management server, paste the join address from IT and sign in with your company account.')) + '</p>'
    + '<ul>'
    + item('自动配置组织提供的模型，无需自填 API Key', 'Uses organisation models with no personal API key needed')
    + item('同步团队所需的插件、公司 Skill 与工具权限', 'Syncs team plugins, company skills and tool permissions')
    + item('组织数据与个人 ~/.dsh 分开存放，随时可离开', 'Kept separate from your personal ~/.dsh; leave any time')
    + '</ul>'
    + '<div class="card-foot"><div class="join-form">'
    + '<input id="onboarding-join-url" spellcheck="false" autocomplete="url" placeholder="' + escapeHtml(h('例如 https://dsh.example.com 或 http://10.0.0.8:8080/#key=…', 'e.g. https://dsh.example.com or http://10.0.0.8:8080/#key=…')) + '" aria-label="' + escapeHtml(h('加入地址', 'Join address')) + '">'
    + '<button id="onboarding-join-go" class="secondary" type="button">' + escapeHtml(h('登录并加入', 'Sign in and join')) + '</button>'
    + '</div><p id="onboarding-join-status" class="status" role="status" aria-live="polite"></p></div>'
    + '</section>'
    + '</div></div></main><footer>'
    + '<button id="error-settings" class="link" type="button">' + escapeHtml(h('桌面设置', 'Desktop settings')) + '</button>'
    + '<button id="error-quit" class="link" type="button">' + escapeHtml(h('退出', 'Quit')) + '</button>'
    + '</footer></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
