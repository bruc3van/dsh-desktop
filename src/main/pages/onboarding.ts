import { escapeHtml } from './html.ts'
import { hostTokensCss } from './tokens.ts'

const USER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="8" r="4"></circle><path d="M5 20a7 7 0 0 1 14 0"></path></svg>'

const ORG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 20V5.6A1.6 1.6 0 0 1 5.6 4h7.8A1.6 1.6 0 0 1 15 5.6V20M15 10h3.4A1.6 1.6 0 0 1 20 11.6V20M2 20h20M8 8h3M8 12h3M8 16h3"></path></svg>'

const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
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
    + hostTokensCss()
    + '*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}'
    + 'body{display:flex;flex-direction:column;min-height:100vh}'
    + 'main{flex:1;display:grid;place-items:center;padding:36px 24px 20px}'
    + '.shell{width:min(760px,100%)}'
    + '.head{text-align:center;margin-bottom:28px}'
    + '.mark{width:48px;height:48px;border-radius:var(--dsw-radius-lg);display:block;margin:0 auto 16px}'
    + 'h1{font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.lead{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}'
    + '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:stretch}'
    + '.card{display:flex;flex-direction:column;background:var(--dsw-alias-settings-card-fill);border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);padding:24px 24px 20px;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){.card:hover{border-color:var(--dsw-alias-border-selected)}}'
    + '.card-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}'
    + '.badge-icon{width:36px;height:36px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);display:grid;place-items:center;flex:none}'
    + '.badge-icon svg{width:18px;height:18px}'
    + '.card h2{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}'
    + 'ul{list-style:none;margin:16px 0 20px;display:grid;gap:8px;flex:1}'
    + 'li{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}'
    + 'li svg{width:16px;height:16px;flex:none;margin-top:2px;color:var(--dsw-alias-state-success-primary)}'
    + '.card-foot{margin-top:auto}'
    + 'button{font:inherit;display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:22px;cursor:pointer;border-radius:var(--dsw-radius-md);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out),opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + 'button:disabled{opacity:.4;cursor:not-allowed}'
    + '.primary{display:flex;width:100%;height:36px;padding:0 14px;border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}'
    + '@media(hover:hover){.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}'
    + '.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover);opacity:.9}'
    + '.secondary{display:flex;width:100%;height:36px;padding:0 14px;border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font-weight:500}'
    + '@media(hover:hover){.secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.secondary:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}'
    + '.join-form{display:flex;flex-direction:column;gap:8px}'
    + 'input{font:inherit;font-size:14px;line-height:22px;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + 'input:focus{border-color:var(--dsw-alias-state-business-primary)}'
    + 'input:focus-visible{outline:none}'
    + 'input::placeholder{color:var(--dsw-alias-label-tertiary)}'
    + '@media(pointer:coarse){input{font-size:16px}}'
    + '.status{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-height:18px;overflow-wrap:anywhere}'
    + '.status.error{color:var(--dsw-alias-state-error-primary)}'
    + '.status:empty{display:none}'
    + 'footer{display:flex;justify-content:center;gap:8px;padding:8px 20px 24px;flex-wrap:wrap}'
    + '.link{height:28px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}'
    + '@media(hover:hover){.link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.link:active{background:var(--dsw-alias-interactive-bg-active)}'
    + '@media(max-width:767px){main{padding:28px 20px 20px}.grid{grid-template-columns:1fr}}'
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
    + '<p class="desc">' + escapeHtml(h('输入 IT 提供的组织地址，用公司账号登录后自动完成配置。', 'Enter the address from IT and sign in with your company account.')) + '</p>'
    + '<ul>'
    + item('自动配置组织提供的模型，无需自填 API Key', 'Uses organisation models with no personal API key needed')
    + item('同步团队所需的插件、公司 Skill 与工具权限', 'Syncs team plugins, company skills and tool permissions')
    + item('组织数据与个人 ~/.dsh 分开存放，随时可离开', 'Kept separate from your personal ~/.dsh; leave any time')
    + '</ul>'
    + '<div class="card-foot"><div class="join-form">'
    + '<input id="onboarding-join-url" spellcheck="false" autocomplete="url" placeholder="' + escapeHtml(h('输入组织加入地址，如 https://dsh.example.com', 'Organisation URL, e.g. https://dsh.example.com')) + '" aria-label="' + escapeHtml(h('加入地址', 'Join address')) + '">'
    + '<button id="onboarding-join-go" class="secondary" type="button">' + escapeHtml(h('登录并加入', 'Sign in and join')) + '</button>'
    + '</div><p id="onboarding-join-status" class="status" role="status" aria-live="polite"></p></div>'
    + '</section>'
    + '</div></div></main><footer>'
    + '<button id="error-settings" class="link" type="button">' + escapeHtml(h('桌面设置', 'Desktop settings')) + '</button>'
    + '<button id="error-quit" class="link" type="button">' + escapeHtml(h('退出', 'Quit')) + '</button>'
    + '</footer></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
