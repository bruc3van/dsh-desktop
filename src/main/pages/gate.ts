import { escapeHtml } from './html.ts'
import { hostTokensCss } from './tokens.ts'

/**
 * The organisation gate: what an enrolled machine shows before the runtime
 * may start — the sign-in page, or a failure only IT can resolve.
 *
 * Its own page rather than the connection-failure surface: signing in is the
 * expected first step on a company laptop, not an error, and it should say
 * what signing in sets up and where it happens. Buttons are bound from the
 * main process (the page's CSP forbids inline script), by id.
 */
export interface GateCopy {
  kind: 'sign-in' | 'blocked'
  title: string
  lead: string
  /** What signing in sets up; sign-in only. */
  benefits?: string[]
  primary: string
  /** Under the primary button: where it happens. */
  primaryNote?: string
  /** A failed attempt or the blocking reason. */
  problem?: string
  problemLabel?: string
  /** Offered only when the enrollment allows it. */
  personal?: { title: string; text: string; action: string }
  diagnostics: string
  settings: string
  quit: string
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.2v.3M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const LINK = '<svg viewBox="0 0 28 8" aria-hidden="true"><circle cx="4" cy="4" r="1.6" fill="currentColor"/><circle cx="14" cy="4" r="1.6" fill="currentColor"/><circle cx="24" cy="4" r="1.6" fill="currentColor"/></svg>'

/** The first visible character of the organisation name, for its tile. */
function monogram(name: string): string {
  const first = [...name.trim().replace(/^[\s\p{P}]+/u, '')][0] ?? '?'
  return first.toLocaleUpperCase()
}

export function renderGatePageUrl(copy: GateCopy, organization: string, chinese: boolean, icon: string): string {
  const signIn = copy.kind === 'sign-in'
  const identity = signIn
    ? '<div class="identity">' + icon + '<span class="joint">' + LINK + '</span><span class="org" aria-hidden="true">' + escapeHtml(monogram(organization)) + '</span></div>'
    : '<div class="identity">' + icon + '<span class="joint">' + LINK + '</span><span class="org alert" aria-hidden="true">' + ALERT + '</span></div>'
  const benefits = (copy.benefits ?? []).map(item => '<li>' + CHECK + '<span>' + escapeHtml(item) + '</span></li>').join('')
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.title) + '</title><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}html,body{height:100%}'
    + 'body{margin:0;display:flex;flex-direction:column;min-height:100vh}'
    + 'main{flex:1;display:grid;place-items:center;padding:40px 24px 20px}'
    + '.card{width:min(440px,100%);background:var(--dsw-alias-settings-card-fill);border:0;border-radius:var(--dsw-radius-panel);padding:28px 24px 24px;box-shadow:var(--dsw-elevation-prominent)}'
    + '.identity{display:flex;align-items:center;gap:10px}'
    + '.mark,.org{width:40px;height:40px;border-radius:10px;flex:0 0 auto}'
    + '.org{display:grid;place-items:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:16px;line-height:24px;font-weight:500}'
    + '.org.alert{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent)}.org.alert svg{width:20px;height:20px}'
    + '.joint{color:var(--dsw-alias-label-caption);display:grid}.joint svg{width:28px;height:8px}'
    + 'h1{margin:20px 0 0;font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary);word-break:break-word}'
    + '.lead{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}'
    + 'ul{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:8px}'
    + 'li{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}'
    + 'li svg{width:16px;height:16px;flex:0 0 auto;margin-top:2px;color:var(--dsw-alias-state-success-primary)}'
    + '.problem{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);margin:20px 0 0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px;'
    + 'max-height:min(30vh,220px);overflow:auto;white-space:pre-wrap;word-break:break-word}'
    + '.problem b{font-weight:500;margin-right:6px}'
    + 'button{font:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out),opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + 'button:disabled{opacity:.4;cursor:not-allowed}'
    + '.primary{display:flex;width:100%;margin:20px 0 0;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:14px;line-height:22px;font-weight:500}'
    + '@media(hover:hover){.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}'
    + '.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover);opacity:.9}'
    + '.note{margin:10px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}'
    + '.personal{margin:20px 0 0;padding:16px 0 0;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;gap:12px;align-items:center;justify-content:space-between}'
    + '.personal strong{display:block;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}'
    + '.personal span{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px}'
    + '.secondary{flex:0 0 auto;height:28px;padding:0 10px;border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap}'
    + '@media(hover:hover){.secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.secondary:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}'
    + 'footer{display:flex;justify-content:center;gap:8px;padding:0 20px 24px;flex-wrap:wrap}'
    + '.link{height:28px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}'
    + '@media(hover:hover){.link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.link:active{background:var(--dsw-alias-interactive-bg-active)}'
    + '@media(max-width:767px){main{padding:24px 20px 16px}.card{padding:24px 20px}.personal{flex-direction:column;align-items:stretch}}'
    + '</style></head><body><main><div class="card">'
    + identity
    + '<h1>' + escapeHtml(copy.title) + '</h1>'
    + '<p class="lead">' + escapeHtml(copy.lead) + '</p>'
    + (benefits === '' ? '' : '<ul>' + benefits + '</ul>')
    + (copy.problem === undefined || copy.problem === ''
      ? ''
      : '<div class="problem" role="alert">' + (copy.problemLabel === undefined ? '' : '<b>' + escapeHtml(copy.problemLabel) + '</b>') + escapeHtml(copy.problem.slice(0, 2_000)) + '</div>')
    + '<button id="error-retry" class="primary" type="button">' + escapeHtml(copy.primary) + '</button>'
    + (copy.primaryNote === undefined ? '' : '<p class="note">' + escapeHtml(copy.primaryNote) + '</p>')
    + (copy.personal === undefined
      ? ''
      : '<div class="personal"><div><strong>' + escapeHtml(copy.personal.title) + '</strong><span>' + escapeHtml(copy.personal.text) + '</span></div>'
        + '<button id="gate-personal" class="secondary" type="button">' + escapeHtml(copy.personal.action) + '</button></div>')
    + '</div></main><footer>'
    + '<button id="gate-diagnostics" class="link" type="button">' + escapeHtml(copy.diagnostics) + '</button>'
    + '<button id="error-settings" class="link" type="button">' + escapeHtml(copy.settings) + '</button>'
    + '<button id="error-quit" class="link" type="button">' + escapeHtml(copy.quit) + '</button>'
    + '</footer></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
