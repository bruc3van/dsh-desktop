import { escapeHtml } from './html.ts'

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

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.2v.3M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
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
    + ':root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#14161a;--muted:#5f6670;--faint:#8b919a;--line:#e3e6ea;'
    + '--accent:#1f4fd1;--accent-ink:#fff;--org:#1f4fd1;--warn-bg:#fdf4e7;--warn-line:#f1d9ad;--warn-ink:#7a4a06;--ok:#1d7a4d;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}'
    + '*{box-sizing:border-box}html,body{height:100%}'
    + 'body{margin:0;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;min-height:100vh}'
    + 'main{flex:1;display:grid;place-items:center;padding:40px 16px}'
    + '.card{width:min(440px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 32px 28px;box-shadow:0 1px 2px rgba(20,22,26,.04),0 12px 32px rgba(20,22,26,.06)}'
    + '.identity{display:flex;align-items:center;gap:10px}'
    + '.mark,.org{width:44px;height:44px;border-radius:11px;flex:0 0 auto}'
    + '.org{display:grid;place-items:center;background:var(--org);color:#fff;font-size:21px;font-weight:600;line-height:1}'
    + '.org.alert{background:var(--warn-bg);color:var(--warn-ink);border:1px solid var(--warn-line)}.org.alert svg{width:22px;height:22px}'
    + '.joint{color:var(--faint);display:grid}.joint svg{width:28px;height:8px}'
    + 'h1{margin:22px 0 0;font-size:21px;line-height:29px;font-weight:600;letter-spacing:-.01em;word-break:break-word}'
    + '.lead{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:22px}'
    + 'ul{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:9px}'
    + 'li{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:21px}'
    + 'li svg{width:16px;height:16px;flex:0 0 auto;margin-top:2.5px;color:var(--ok)}'
    + '.problem{margin:20px 0 0;padding:10px 12px;border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn-ink);border-radius:9px;font-size:13px;line-height:20px;'
    + 'max-height:min(30vh,220px);overflow:auto;white-space:pre-wrap;word-break:break-word}'
    + '.problem b{font-weight:600;margin-right:6px}'
    + 'button{font:inherit;cursor:pointer}'
    + '.primary{display:block;width:100%;margin:24px 0 0;height:42px;border:0;border-radius:9px;background:var(--accent);color:var(--accent-ink);font-size:14px;font-weight:600;transition:filter .15s ease}'
    + '.primary:hover{filter:brightness(1.08)}'
    + '.note{margin:10px 0 0;text-align:center;color:var(--faint);font-size:12px;line-height:18px;word-break:break-all}'
    + '.personal{margin:24px 0 0;padding:16px 0 0;border-top:1px solid var(--line);display:flex;gap:12px;align-items:center;justify-content:space-between}'
    + '.personal strong{display:block;font-size:13px;font-weight:600;line-height:20px}'
    + '.personal span{display:block;color:var(--muted);font-size:12px;line-height:18px;margin-top:2px}'
    + '.secondary{flex:0 0 auto;height:32px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font-size:13px;white-space:nowrap}'
    + '.secondary:hover{background:var(--bg)}'
    + 'footer{display:flex;justify-content:center;gap:4px;padding:0 16px 22px;flex-wrap:wrap}'
    + '.link{border:0;background:transparent;color:var(--muted);font-size:12px;padding:6px 10px;border-radius:6px}'
    + '.link:hover{color:var(--ink);background:rgba(127,127,127,.1)}'
    + 'button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#121316;--card:#1b1d21;--ink:#eef0f3;--muted:#a3a9b2;--faint:#7d838c;--line:#2c2f35;'
    + '--accent:#4d7cf0;--org:#3d6be0;--warn-bg:#2b2213;--warn-line:#5a4521;--warn-ink:#f0c983;--ok:#5cc58f}'
    + '.card{box-shadow:none}.mark{box-shadow:0 0 0 1px #3a3e46}}'
    + '@media(max-width:480px){.card{padding:24px 20px}.personal{flex-direction:column;align-items:stretch}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
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
