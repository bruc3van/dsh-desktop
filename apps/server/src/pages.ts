/**
 * The few pages the management server shows in a browser: choosing how to
 * sign in, and the short notices when a sign-in cannot go on. They share the
 * client's sign-in look — the DSH Desktop Pro mark joined to the
 * organisation's monogram — so people can tell where they are signing in.
 *
 * Served under `default-src 'none'`: styles are inline, images are inline SVG.
 * @module @dsh-desktop-pro/server/pages
 */

import { escapeHtml } from './http.ts'

export type PageLanguage = 'zh' | 'en'

/** Chinese when the browser prefers it, English otherwise. */
export function pageLanguage(acceptLanguage: string | string[] | undefined): PageLanguage {
  const first = String(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('zh') ? 'zh' : 'en'
}

const WHALE = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.204 28.0439 31.8022 28.1841 31.416 28.2002C30.8174 28.2241 30.1636 27.9761 29.8086 27.6802C29.2573 27.2119 28.8633 26.9497 28.6978 26.1338C28.6265 25.7856 28.6665 25.248 28.7295 24.9395C28.8711 24.272 28.7134 23.8481 28.249 23.4561C27.8701 23.1362 27.3906 23.0479 26.8638 23.0479C26.667 23.0479 26.4858 22.9599 26.3516 22.8877C26.1309 22.7759 25.9497 22.4961 26.123 22.1563C26.1782 22.0479 26.4463 21.7764 26.5093 21.728C27.2256 21.3159 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'

const MARK = '<span class="tile tile-app" aria-hidden="true"><svg viewBox="0 0 50 50"><path fill="#fff" d="' + WHALE + '"/></svg></span>'
const DOTS = '<span class="joint" aria-hidden="true"><svg viewBox="0 0 28 8"><circle cx="4" cy="4" r="1.6" fill="currentColor"/><circle cx="14" cy="4" r="1.6" fill="currentColor"/><circle cx="24" cy="4" r="1.6" fill="currentColor"/></svg></span>'
const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
const ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.2v.3M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** The first visible character of the organisation name, for its tile. */
function monogram(name: string): string {
  const first = [...name.trim().replace(/^[\s\p{P}]+/u, '')][0] ?? '?'
  return first.toLocaleUpperCase()
}

const STYLE = ':root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--faint:#98989d;--line:rgba(0,0,0,.08);--field:#fff;--field-line:rgba(0,0,0,.16);'
  + '--accent:#007aff;--btn:#1d1d1f;--btn-text:#fff;--soft:rgba(0,0,0,.05);--warn:#b25000}'
  + '@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--card:#2c2c2e;--text:#f5f5f7;--muted:#a1a1a6;--faint:#7c7c80;--line:rgba(255,255,255,.08);--field:#1c1c1e;--field-line:rgba(255,255,255,.16);'
  + '--accent:#0a84ff;--btn:#f5f5f7;--btn-text:#1d1d1f;--soft:rgba(255,255,255,.06);--warn:#ff9f0a}}'
  + '*{box-sizing:border-box;margin:0;padding:0}'
  + 'body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;-webkit-font-smoothing:antialiased}'
  + 'main{width:min(400px,100%);background:var(--card);border-radius:18px;box-shadow:0 0 0 .5px var(--line),0 18px 50px rgba(0,0,0,.08);padding:36px 32px 28px}'
  + '.identity{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px}'
  + '.tile{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;flex:none}'
  + '.tile-app{background:#1c1c1c;box-shadow:0 0 0 .5px var(--line)}.tile-app svg{width:30px;height:30px}'
  + '.tile-org{background:linear-gradient(#7d7aff,#5856d6);color:#fff;font-size:21px;font-weight:600}'
  + '.tile-alert{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}.tile-alert svg{width:26px;height:26px}'
  + '.joint{color:var(--faint);display:flex}.joint svg{width:28px;height:8px}'
  + 'h1{font-size:20px;font-weight:600;letter-spacing:-.01em;text-align:center;line-height:1.35;overflow-wrap:anywhere}'
  + '.lead{margin-top:8px;font-size:14px;line-height:1.55;color:var(--muted);text-align:center}'
  + '.methods{margin-top:26px;display:grid;gap:10px}'
  + '.button,button{display:flex;align-items:center;justify-content:center;width:100%;min-height:42px;padding:10px 16px;border-radius:10px;border:0;font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer;background:var(--btn);color:var(--btn-text)}'
  + '.button:hover,button:hover{opacity:.9}'
  + '.button:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:1px}'
  + 'button.secondary{background:var(--soft);color:var(--text);box-shadow:inset 0 0 0 .5px var(--line)}'
  + '.or{display:flex;align-items:center;gap:12px;margin:20px 0 14px;font-size:12px;color:var(--faint)}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}'
  + '.dev-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;font-weight:500}'
  + '.chip{font-size:11px;font-weight:500;padding:1px 7px;border-radius:999px;color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent)}'
  + 'form{display:grid;gap:10px}'
  + 'input{width:100%;min-height:42px;padding:0 12px;border-radius:10px;border:.5px solid var(--field-line);background:var(--field);color:var(--text);font:inherit;font-size:14px}'
  + 'input::placeholder{color:var(--faint)}'
  + '.help{font-size:12px;color:var(--muted);line-height:1.5}'
  + '.empty{margin-top:24px;padding:12px 14px;border-radius:10px;background:var(--soft);font-size:13px;color:var(--muted);text-align:center}'
  + 'footer{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:18px;font-size:12px;color:var(--faint);text-align:center}footer svg{width:13px;height:13px;flex:none}'

function page(lang: PageLanguage, title: string, body: string, host: string): string {
  return '<!doctype html><html lang="' + (lang === 'zh' ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(title) + '</title><style>' + STYLE + '</style></head><body>'
    + '<main>' + body + '</main>'
    + '<footer>' + LOCK + '<span>' + escapeHtml(host !== '' ? (lang === 'zh' ? '由 ' + host + ' 提供 · DSH Desktop Pro' : 'Served by ' + host + ' · DSH Desktop Pro') : 'DSH Desktop Pro') + '</span></footer>'
    + '</body></html>'
}

export interface SignInPageOptions {
  organization: string
  flowId: string
  methods: Array<{ id: string; label: string }>
  devLogin: boolean
  /** `client` for DSH Desktop Pro, `console` for the management console. */
  audience: 'client' | 'console'
  lang: PageLanguage
  host: string
}

/** Choosing how to sign in: the company SSO first, the evaluation login below it. */
export function signInPage(options: SignInPageOptions): string {
  const zh = options.lang === 'zh'
  const t = (chinese: string, english: string): string => zh ? chinese : english
  const sso = options.methods.filter(method => method.id !== 'dev')
  const buttons = sso.map(method => '<a class="button" href="/v1/auth/start/' + escapeHtml(method.id) + '?flow=' + encodeURIComponent(options.flowId) + '">'
    + escapeHtml(t('使用 ' + method.label + ' 登录', 'Continue with ' + method.label)) + '</a>').join('')
  const dev = options.devLogin
    ? (sso.length > 0 ? '<div class="or">' + t('或', 'or') + '</div>' : '<div style="height:24px"></div>')
      + '<div class="dev-head">' + t('评估登录', 'Evaluation sign-in') + '<span class="chip">' + t('仅限试用', 'Evaluation only') + '</span></div>'
      + '<form method="post" action="/v1/auth/dev"><input type="hidden" name="flow" value="' + escapeHtml(options.flowId) + '">'
      + '<input name="email" type="email" required placeholder="name@example.com" autocomplete="email" aria-label="' + t('邮箱', 'Email') + '" autofocus>'
      + '<button type="submit"' + (sso.length > 0 ? ' class="secondary"' : '') + '>' + t('继续', 'Continue') + '</button>'
      + '<p class="help">' + t('填写成员列表里的邮箱即可登录，不校验密码。正式使用前请接入公司 SSO 并关闭这个入口。', 'Any email on the member list signs in, without a password. Connect your company SSO and turn this off before real use.') + '</p></form>'
    : ''
  const none = sso.length === 0 && !options.devLogin
    ? '<p class="empty">' + t('服务端还没有配置登录方式，请联系 IT 管理员。', 'No sign-in method is configured yet. Contact your IT administrator.') + '</p>'
    : ''
  const forConsole = options.audience === 'console'
  const heading = forConsole
    ? t('登录管理控制台', 'Sign in to the console')
    : t('登录 ' + options.organization, 'Sign in to ' + options.organization)
  const lead = forConsole
    ? t(options.organization + ' 的 DSH Desktop Pro 管理控制台，仅管理员和审计员可以进入。', 'The DSH Desktop Pro console for ' + options.organization + '. Administrators and auditors only.')
    : t('使用公司账号登录 DSH Desktop Pro。登录后，公司配置好的模型、插件和 Skill 会自动就绪。', 'Use your company account for DSH Desktop Pro. Your organisation\'s models, plugins and skills are set up as soon as you sign in.')
  return page(options.lang, heading,
    '<div class="identity">' + MARK + DOTS + '<span class="tile tile-org" aria-hidden="true">' + escapeHtml(monogram(options.organization)) + '</span></div>'
    + '<h1>' + escapeHtml(heading) + '</h1><p class="lead">' + escapeHtml(lead) + '</p>'
    + (buttons !== '' ? '<div class="methods">' + buttons + '</div>' : '') + dev + none,
    options.host)
}

/** A short notice when a browser step cannot go on. */
export function messagePage(lang: PageLanguage, title: string, message: string, host = ''): string {
  return page(lang, title,
    '<div class="identity"><span class="tile tile-alert">' + ALERT + '</span></div>'
    + '<h1>' + escapeHtml(title) + '</h1><p class="lead">' + escapeHtml(message) + '</p>',
    host)
}
