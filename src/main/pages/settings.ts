import { choiceControlsCss } from '../choice-controls.ts'
import { releaseNotesCss } from '../release-notes.ts'
import { RELEASES_PAGE_URL } from '../updater.ts'

const EXTERNAL_LINK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'
  + '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>'

/** Linear glyphs for the sidebar navigation, matching the DSH host settings dialog. */
const GLYPH: Record<string, string> = {
  org: '<path d="M4 17V4.6A1.6 1.6 0 0 1 5.6 3h5.8A1.6 1.6 0 0 1 13 4.6V17M13 8h2.4A1.6 1.6 0 0 1 17 9.6V17M2.5 17h15M7 6.5h3M7 9.5h3M7 12.5h3"/>',
  connection: '<path d="M8.6 11.4l2.8-2.8M7.2 8.8l-1.9 1.9a2.7 2.7 0 0 0 3.8 3.8l1.9-1.9M12.8 11.2l1.9-1.9a2.7 2.7 0 0 0-3.8-3.8L9 7.4"/>',
  data: '<ellipse cx="10" cy="5.6" rx="5.4" ry="2.2"/><path d="M4.6 5.6v8.8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V5.6M4.6 10c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2"/>',
  skills: '<path d="M4 15.4V4.6A1.6 1.6 0 0 1 5.6 3H16v11.4H5.6A1.6 1.6 0 0 0 4 16a1.6 1.6 0 0 0 1.6 1.6H16M7.5 6.5h5M7.5 9.5h3.5"/>',
  updates: '<circle cx="10" cy="10" r="6.6"/><path d="M10 6.6v6.4M7.3 10.4 10 13.1l2.7-2.7"/>',
}

function glyph(name: string): string {
  return '<span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round">' + GLYPH[name] + '</svg></span>'
}

/**
 * The desktop settings window, styled to match the DSH host settings dialog:
 * a unified surface with a clean monochrome sidebar on the left and bordered
 * cards / hairline-separated controls on the right.
 */
export function renderSettingsPageHtml(chinese: boolean, icon: string): string {
  // Plain text, not escaped: every value below is a literal written here, and
  // none of them contains a character HTML or an attribute would read.
  const h = (zh: string, en: string): string => chinese ? zh : en
  const nav = (pane: string, label: string, hidden = false): string =>
    '<button type="button" class="nav-item" data-pane="' + pane + '" id="nav-' + pane + '"' + (hidden ? ' hidden' : '') + '>'
    + glyph(pane) + '<span>' + label + '</span></button>'
  const actionRow = (label: string, help: string, control: string): string =>
    '<div class="row action-row"><div class="row-text"><div class="row-label">' + label + '</div><div class="row-help">' + help + '</div></div>'
    + '<div class="row-end">' + control + '</div></div>'
  return '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<title>' + h('DSH Desktop Pro 设置', 'DSH Desktop Pro settings') + '</title>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark">'
    + '<style>'
    + ':root{color-scheme:light dark;--text:#0f1115;--nav-text:#262930;--muted:#6e7480;--faint:#9aa0a6;--accent:#0f1115;--accent-hover:#262930;--accent-fg:#fff;'
    + '--danger:#dc2626;--danger-line:rgba(220,38,38,.28);--danger-hover:rgba(220,38,38,.06);--ok:#16a34a;--warn:#b25000;'
    + '--bg:#fff;--sidebar:#fff;--sidebar-line:#f0f1f4;--card:#fff;--border:#e6e8ec;--sep:#f0f2f5;'
    + '--hover:#f5f6f8;--selected:#eef1f6;--surface:#f4f5f7;--btn:#fff;--btn-line:#dce0e6;--btn-hover:#f5f6f8;'
    + '--field:#fff;--field-line:#dce0e6;--switch-off:#d4d7dd;--switch-knob:#fff;--focus-ring:rgba(15,17,21,.1)}'
    + '@media(prefers-color-scheme:dark){:root{--text:#f2f3f5;--nav-text:#d5d8de;--muted:#9ba1ac;--faint:#6e7480;--accent:#f2f3f5;--accent-hover:#e2e4e8;--accent-fg:#141518;'
    + '--danger:#f87171;--danger-line:rgba(248,113,113,.32);--danger-hover:rgba(248,113,113,.1);--ok:#4ade80;--warn:#fbbf24;'
    + '--bg:#17181a;--sidebar:#17181a;--sidebar-line:rgba(255,255,255,.07);--card:#1d1f23;--border:rgba(255,255,255,.1);--sep:rgba(255,255,255,.07);'
    + '--hover:rgba(255,255,255,.05);--selected:rgba(255,255,255,.09);--surface:#222429;--btn:#222429;--btn-line:rgba(255,255,255,.13);--btn-hover:rgba(255,255,255,.08);'
    + '--field:#17181a;--field-line:rgba(255,255,255,.14);--switch-off:#3a3d45;--switch-knob:#17181a;--focus-ring:rgba(242,243,245,.16)}}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13.5px;line-height:1.5;'
    + 'background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}'
    + '::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}'
    + '::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}::-webkit-scrollbar-thumb:hover{background:var(--faint)}'
    + '[hidden]{display:none!important}'
    // Window: unified DSH-style two-column layout. On macOS, top padding clears the traffic lights.
    + '.window{display:grid;grid-template-columns:212px minmax(0,1fr);min-height:100vh}'
    + '.sidebar{background:var(--sidebar);border-right:1px solid var(--sidebar-line);position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 12px 18px;display:flex;flex-direction:column}'
    + 'body.mac .sidebar{padding-top:46px}'
    + '.drag{position:fixed;top:0;left:0;right:0;height:40px;-webkit-app-region:drag;z-index:0}'
    + 'body:not(.mac) .drag{display:none}'
    + 'button,input,a,.nav-item{-webkit-app-region:no-drag}'
    + '.identity{display:flex;align-items:center;gap:10px;padding:2px 10px 16px;margin-bottom:4px}'
    + '.identity .mark{width:26px;height:26px;border-radius:7px;flex:none}'
    + '.identity-name{font-size:14.5px;font-weight:600;line-height:1.3;letter-spacing:-.01em}'
    + '.identity-sub{font-size:11.5px;color:var(--muted);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:136px;margin-top:1px}'
    + '.nav{display:flex;flex-direction:column;gap:2px}'
    + '.nav-item{display:flex;align-items:center;gap:10px;width:100%;padding:0 12px;border:0;border-radius:10px;background:transparent;color:var(--nav-text);font-family:inherit;font-size:13.5px;font-weight:400;text-align:left;cursor:pointer;box-shadow:none;min-height:38px;line-height:1.3;transition:background .15s ease,color .15s ease}'
    + '.nav-item:hover{background:var(--hover);color:var(--text)}'
    + '.nav-item[aria-current="page"]{background:var(--selected);color:var(--text);font-weight:500}'
    + '.nav-item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}'
    + '.nav-item.attention::after{content:"";width:7px;height:7px;border-radius:50%;background:var(--warn);margin-left:auto}'
    + '.nav-icon{width:18px;height:18px;display:grid;place-items:center;flex:none;color:var(--muted);transition:color .15s ease}'
    + '.nav-item:hover .nav-icon,.nav-item[aria-current="page"] .nav-icon{color:var(--text)}'
    + '.nav-icon svg{width:17px;height:17px}'
    // Panes
    + '.panes{min-width:0;padding:0 36px 40px 32px;position:relative;z-index:1;background:var(--bg)}'
    + '.pane-head{position:sticky;top:0;z-index:2;background:var(--bg);padding:22px 0 12px;margin-bottom:2px}'
    + 'body.mac .pane-head{padding-top:18px;-webkit-app-region:drag}'
    + '.pane-title{font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--text)}'
    + '.pane{max-width:640px}'
    + '.group-title{font-size:13.5px;font-weight:500;color:var(--text);margin:22px 0 10px 2px}'
    + '.group{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}'
    + '.row{display:flex;align-items:center;gap:16px;min-height:50px;padding:12px 16px;background:var(--card)}'
    + '.row:not([hidden]):not(.action-row:has(>.row-end>button[hidden]))~.row{border-top:1px solid var(--sep)}'
    + '.row-text{flex:1;min-width:0}'
    + '.row-label{font-size:13.5px;font-weight:500;color:var(--text)}'
    + '.row-help{font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.45}'
    + '.row-value{flex:1;min-width:0;text-align:right;font-size:13px;color:var(--muted);overflow-wrap:anywhere}'
    + '.row-end{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}'
    + '.row.stack{display:block}'
    + '.row.stack .row-value{text-align:left;margin-top:4px}'
    + '.action-row:has(.row-end>button[hidden]){display:none}'
    + '.caption{font-size:12.5px;color:var(--muted);margin:8px 4px 0;line-height:1.55;overflow-wrap:anywhere}'
    + '.caption:empty{display:none}'
    + '.lead{font-size:13px;color:var(--muted);margin:0 0 16px;line-height:1.6}'
    + '.skill-row .row-help{overflow-wrap:anywhere}'
    + '.empty-row{justify-content:center;color:var(--muted);min-height:72px;font-size:13px}'
    + '.caption.error,.status-text.error{color:var(--danger)}'
    // Organisation identity
    + '.org-row{min-height:68px;gap:14px}'
    + '.monogram{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;flex:none;font-size:17px;font-weight:600;color:var(--accent-fg);background:var(--accent)}'
    + '.org-name{font-size:14.5px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}'
    + '.org-kind{font-size:12.5px;color:var(--muted);margin-top:2px}'
    + '.state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);white-space:nowrap}'
    + '.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}'
    + '.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.bad{color:var(--danger)}'
    // Controls: DSH host buttons, fields and segmented controls.
    + 'button{font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;color:var(--text);background:var(--btn);border:1px solid var(--btn-line);border-radius:8px;padding:7px 14px;min-height:32px;transition:background .15s ease,border-color .15s ease,opacity .15s ease}'
    + 'button:hover:not(:disabled){background:var(--btn-hover)}'
    + 'button:active:not(:disabled){opacity:.85}'
    + 'button:disabled{opacity:.48;cursor:default}'
    + 'button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + 'button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:500}'
    + 'button.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}'
    + 'button.danger{color:var(--danger);border-color:var(--danger-line);background:transparent}'
    + 'button.danger:hover:not(:disabled){background:var(--danger-hover)}'
    + 'input{font:inherit;font-size:13px;width:100%;background:var(--field);border:1px solid var(--field-line);border-radius:8px;padding:0 12px;min-height:36px;color:var(--text);outline:none;transition:border-color .15s ease,box-shadow .15s ease}'
    + 'input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--focus-ring)}'
    + 'input::placeholder{color:var(--faint)}'
    + '.field-row{display:flex;gap:10px;align-items:center;flex:1}'
    + '.field-row input{flex:1;min-width:0}'
    + '.field-row button{min-height:36px;padding:0 16px}'
    + '.icon-link{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:var(--muted);text-decoration:none;transition:background .15s ease,color .15s ease}'
    + '.icon-link:hover{background:var(--hover);color:var(--text)}'
    + '.managed-line{font-size:13px;color:var(--muted);background:var(--surface)}'
    + '.ok-text{color:var(--ok);font-size:12.5px}.warn-text{color:var(--warn)}'
    + '.path-text{overflow-wrap:anywhere;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}'
    + '.tag{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:5px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:11px;font-weight:400;vertical-align:1px}'
    // Runtime sources: horizontal checkboxes matching the DSH host desktop settings panel.
    + '.runtime-checks{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px}'
    + '#runtime-editor button[data-smart-runtime]::after{left:14px;border-color:var(--accent-fg)}'
    + '#runtime-editor button[data-smart-runtime].primary::before{background:var(--accent);border-color:var(--accent)}'
    + '.action-bar{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}'
    + '.section-divider{margin:18px 0 16px;border-top:1px solid var(--sep)}'
    + '.subhead{font-size:14px;font-weight:500;color:var(--text);margin:0 0 8px}'
    + '.conn-status{font-size:13px;color:var(--muted);margin:0 0 12px;overflow-wrap:anywhere}'
    + '.managed-banner{margin:0 0 12px;padding:9px 12px;border-radius:8px;font-size:13px;background:var(--surface);color:var(--text)}'
    + '.flat-row{display:flex;align-items:center;gap:16px;padding:4px 0}'
    + '.flat-field{margin-top:10px}'
    + '.status-text{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}'
    + '.progress{height:4px;border-radius:999px;background:var(--surface);overflow:hidden}'
    + '.progress span{display:block;height:100%;width:0;border-radius:999px;background:var(--accent);transition:width .2s ease}'
    + '.notes-box{margin-top:12px;padding:14px 16px;border-radius:12px;background:var(--card);border:1px solid var(--border)}'
    + '.app-row .mark{width:40px;height:40px;border-radius:10px;flex:none}'
    + '.row.stack:not(:has(>:not([hidden]))){display:none}'
    + releaseNotesCss('#update-notes', { text: '#6e7480', strong: '#0f1115', border: '#e6e8ec', surface: '#f4f5f7' })
    + '@media(prefers-color-scheme:dark){'
    + releaseNotesCss('#update-notes', { text: '#9ba1ac', strong: '#f2f3f5', border: 'rgba(255,255,255,.1)', surface: '#222429' })
    + '}'
    + '#update-notes.notes-box{margin:12px 0 0;max-height:none}'
    + 'body{--choice-text:#0f1115;--choice-muted:#6e7480;--choice-border:#e6e8ec;--choice-surface:#f4f5f7;--choice-inverse:#fff}'
    + '@media(prefers-color-scheme:dark){body{--choice-text:#f2f3f5;--choice-muted:#9ba1ac;--choice-border:rgba(255,255,255,.1);--choice-surface:#222429;--choice-inverse:#32353d}}'
    + choiceControlsCss('body', 'primary')
    // Switch matching the DSH host settings toggle (black active track).
    + '#market-toggle,#market-toggle:hover{position:relative;flex-shrink:0;width:38px;height:22px;min-height:22px;padding:0;border:0;border-radius:999px;background:var(--switch-off)}'
    + '#market-toggle[aria-checked="true"],#market-toggle[aria-checked="true"]:hover{background:var(--accent)}'
    + '#market-toggle::before{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--switch-knob);box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s ease;pointer-events:none}'
    + '#market-toggle[aria-checked="true"]::before{transform:translateX(16px)}'
    + '#market-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '@media(prefers-reduced-motion:reduce){#market-toggle::before{transition:none}}'
    // Segmented controls matching the DSH host desktop settings panel.
    + 'body [role="radiogroup"]{border-radius:10px;padding:3px}'
    + 'body [role="radiogroup"]>button,body [role="radiogroup"]>button:hover{min-height:28px;padding:4px 14px;border-radius:7px;font-size:13px}'
    // A narrow window keeps the panes, with the sidebar along the top.
    + '@media(max-width:620px){.window{grid-template-columns:1fr}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--sidebar-line);padding:12px 14px}'
    + '.nav{flex-direction:row;flex-wrap:wrap;gap:4px}.nav-item{width:auto;min-height:34px;padding:0 10px}.identity{display:none}.panes{padding:0 18px 32px}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
    + '</style></head><body' + (process.platform === 'darwin' ? ' class="mac"' : '') + '><div class="drag" aria-hidden="true"></div><div class="window">'
    // Sidebar
    + '<aside class="sidebar"><div class="identity">' + icon
    + '<div><div class="identity-name">' + h('桌面设置', 'Desktop settings') + '</div><div class="identity-sub" id="sidebar-mode">' + h('个人使用', 'Personal use') + '</div></div></div>'
    + '<nav class="nav" aria-label="' + h('设置分类', 'Settings sections') + '">'
    + nav('org', h('组织', 'Organisation'), true)
    + nav('skills', h('公司 Skill', 'Company skills'), true)
    + nav('connection', h('连接', 'Connection'))
    + nav('data', h('数据环境', 'Data environment'))
    + nav('updates', h('应用更新', 'App updates'))
    + '</nav></aside>'
    + '<main class="panes">'
    // Organisation pane: the enrolled organisation, or — on a computer nobody
    // manages — the way to join one.
    + '<section class="pane" data-pane="org" id="ent-section" hidden>'
    + '<div class="pane-head"><h1 class="pane-title">' + h('组织', 'Organisation') + '</h1></div>'
    + '<div id="ent-join" hidden>'
    + '<p class="lead">' + h('公司部署了 DSH Desktop Pro 管理服务端时，粘贴 IT 发给你的加入地址，在浏览器里用公司账号登录后即可加入。加入后使用组织配置的模型、插件和工具权限，组织的数据和你个人的 ~/.dsh 分开存放；随时可以离开。', 'If your company runs a DSH Desktop Pro management server, paste the join address IT sent you and sign in with your company account in the browser. You then use the models, plugins and tool permissions your organisation set up, with its data kept apart from your personal ~/.dsh. You can leave any time.') + '</p>'
    + '<div class="group"><div class="row"><div class="field-row">'
    + '<input id="join-url" placeholder="' + h('例如 https://dsh.example.com 或 http://10.0.0.8:8080/#key=…', 'e.g. https://dsh.example.com or http://10.0.0.8:8080/#key=…') + '" spellcheck="false" autocomplete="url" aria-label="' + h('加入地址', 'Join address') + '">'
    + '<button type="button" id="join-go" class="primary">' + h('登录并加入', 'Sign in and join') + '</button>'
    + '</div></div></div>'
    + '<p class="caption status-text" id="join-status" role="status" aria-live="polite"></p>'
    + '</div>'
    + '<div id="ent-body">'
    + '<div class="group"><div class="row org-row"><div class="monogram" id="ent-monogram" aria-hidden="true"></div>'
    + '<div class="row-text"><div class="org-name" id="ent-org"></div><div class="org-kind" id="ent-kind"></div></div>'
    + '<span class="state" id="ent-state" hidden></span></div></div>'
    + '<div class="group" id="ent-facts" style="margin-top:12px"></div>'
    + '<p class="caption status-text" id="ent-problems" hidden></p>'
    + '<h2 class="group-title">' + h('操作', 'Actions') + '</h2>'
    + '<div class="group">'
    + actionRow(h('企业账号', 'Organisation account'), h('登录后应用组织配置的模型、插件和工具权限。', 'Sign in to use the models, plugins and tool permissions your organisation set up.'),
      '<button type="button" id="ent-organisation" class="primary" hidden>' + h('使用企业账号登录', 'Sign in to organisation') + '</button>')
    + actionRow(h('同步配置', 'Sync configuration'), h('组织修改配置后会自动推送到这台电脑。', 'Changes from your organisation arrive on their own.'),
      '<button type="button" id="ent-sync" hidden>' + h('立即同步', 'Sync now') + '</button>')
    + actionRow(h('诊断信息', 'Diagnostics'), h('导出日志和配置状态，发给 IT 排查问题。', 'Export logs and configuration state for your IT team.'),
      '<button type="button" id="ent-diagnostics">' + h('导出诊断信息', 'Export diagnostics') + '</button>')
    + actionRow(h('个人模式', 'Personal mode'), h('改用自己的模型 Key 和个人数据，组织配置原样保留。', 'Use your own model key and personal data; the organisation configuration is kept.'),
      '<button type="button" id="ent-personal" hidden>' + h('改用个人模式', 'Use personal mode') + '</button>')
    + actionRow(h('退出登录', 'Sign out'), h('清除组织下发的配置，对话记录保留。', 'Removes what the organisation installed and keeps your conversations.'),
      '<button type="button" id="ent-sign-out" class="danger" hidden>' + h('退出企业账号', 'Sign out') + '</button>')
    + '</div>'
    + '<p class="caption" id="ent-locked"></p>'
    + '</div>'
    + '</section>'
    // Company skills: the organisation's skill library (server mode, signed in).
    + '<section class="pane" data-pane="skills" hidden>'
    + '<div class="pane-head"><h1 class="pane-title">' + h('公司 Skill', 'Company skills') + '</h1></div>'
    + '<p class="lead">' + h('公司整理好的做事方法。标着「全员」的已经装好；其他的按需安装，装好后在新对话里直接用。', 'Ways of working your organisation has written down. Those marked Everyone are already installed; install the others when you need them and use them in a new conversation.') + '</p>'
    + '<div class="group" id="skills-list"></div>'
    + '<p class="caption status-text" id="skills-status"></p>'
    + '</section>'
    // Connection pane: matches the DSH host desktop settings panel layout.
    + '<section class="pane" data-pane="connection">'
    + '<div class="pane-head"><h1 class="pane-title">' + h('连接', 'Connection') + '</h1></div>'
    + '<p class="conn-status" id="status">' + h('连接状态读取中…', 'Reading connection status…') + '</p>'
    + '<p class="managed-banner" id="managed-connection" hidden></p>'
    + '<div id="mode-row">'
    + '<div class="runtime-picks" id="mode-picks" role="radiogroup" aria-label="' + h('连接方式', 'Connection mode') + '">'
    + '<button type="button" id="mode-smart" class="primary">' + h('智能', 'Smart') + '</button>'
    + '<button type="button" id="mode-custom">' + h('自定义', 'Custom') + '</button>'
    + '</div></div>'
    + '<div id="smart-block">'
    + '<div id="runtime-editor">'
    + '<p class="caption" style="margin:12px 0 0">' + h('可多选，应用后生效，至少保留一种。勾选客户端内置时总是用它，其余来源只在关掉内置后按顺序尝试；勾选本机已运行时，如果共用数据且本机已有 dsh 在运行，会直接连上它。', 'Pick any; changes take effect when applied. Keep at least one. When Bundled is on it is always used; the others are tried in order only after you turn it off. With Already running on and shared data, a dsh already running on this machine is connected to directly.') + '</p>'
    + '<div class="runtime-checks runtime-picks">'
    + '<button type="button" data-smart-runtime="bundled" class="primary" data-tip="' + h('用安装包自带的官方运行时，不用另装 Node 或 dsh。', 'Use the official runtime shipped inside this client. No separate Node or dsh needed.') + '" aria-description="' + h('用安装包自带的官方运行时，不用另装 Node 或 dsh。', 'Use the official runtime shipped inside this client. No separate Node or dsh needed.') + '">' + h('客户端内置', 'Bundled') + '</button>'
    + '<button type="button" data-smart-runtime="probe" class="primary" data-tip="' + h('本机已有官方 Web UI 在跑时直接连上（默认 3080），不另起一份。', 'Connect to an official Web UI already running on this machine (3080 by default) instead of starting another.') + '" aria-description="' + h('本机已有官方 Web UI 在跑时直接连上（默认 3080），不另起一份。', 'Connect to an official Web UI already running on this machine (3080 by default) instead of starting another.') + '">' + h('本机已运行', 'Already running') + '</button>'
    + '<button type="button" data-smart-runtime="installed" class="primary" data-tip="' + h('用你 PATH 上自己安装的 dsh，由客户端在后台启动。', 'Start the dsh on your own PATH, in the background, from this client.') + '" aria-description="' + h('用你 PATH 上自己安装的 dsh，由客户端在后台启动。', 'Start the dsh on your own PATH, in the background, from this client.') + '">' + h('本机已安装', 'Installed') + '</button>'
    + '<button type="button" data-smart-runtime="npx" class="primary" data-tip="' + h('用你跑过 npx @deepseek-ai/dsh 留下的缓存包启动，不联网。', 'Start from the package that npx @deepseek-ai/dsh left in your cache. No network.') + '" aria-description="' + h('用你跑过 npx @deepseek-ai/dsh 留下的缓存包启动，不联网。', 'Start from the package that npx @deepseek-ai/dsh left in your cache. No network.') + '">' + h('npx 缓存', 'npx cache') + '</button>'
    + '</div>'
    + '<p class="caption" style="margin:8px 0 0" data-runtime-status role="status" aria-live="polite"></p>'
    + '<div class="action-bar"><button type="button" data-runtime-undo disabled>' + h('撤销更改', 'Undo changes') + '</button>'
    + '<button type="button" class="primary" data-runtime-apply disabled>' + h('应用并重新连接', 'Apply and reconnect') + '</button></div></div>'
    + '<div class="section-divider"></div>'
    + '<div class="subhead">' + h('本地服务端口', 'Local service port') + '</div>'
    + '<div class="runtime-picks" role="radiogroup" aria-label="' + h('本地服务端口', 'Local service port') + '">'
    + '<button type="button" id="port-random" class="primary">' + h('自动', 'Automatic') + '</button>'
    + '<button type="button" id="port-fixed">' + h('固定', 'Fixed') + '</button>'
    + '</div>'
    + '<div class="field-row flat-field" id="port-fixed-block" hidden>'
    + '<input id="port" inputmode="numeric" placeholder="' + h('例如 13080', 'e.g. 13080') + '" spellcheck="false">'
    + '<button id="port-save">' + h('保存', 'Save') + '</button>'
    + '</div>'
    + '<p class="caption" style="margin:10px 0 0" id="port-note">' + h('仅影响客户端自己启动的 dsh。自动依次尝试 3080、13080，均被占用时使用随机端口；固定端口不自动回退。', 'Only a dsh this client starts. Automatic mode tries 3080, then 13080, then an OS-assigned port. A pinned port does not fall back.') + '</p>'
    + '</div>'
    + '<div id="custom-block" hidden>'
    + '<div class="field-row flat-field">'
    + '<input id="url" placeholder="' + h('例如 http://127.0.0.1:3080', 'e.g. http://127.0.0.1:3080') + '" spellcheck="false">'
    + '<button id="save" class="primary">' + h('保存并连接', 'Save and connect') + '</button>'
    + '</div>'
    + '<p class="caption" style="margin:10px 0 0">' + h('直连该地址上的 Web UI。服务停掉后不会自动改用本地运行时。', 'Connects straight to the Web UI at that address. If it stops, this client does not fall back to a local runtime.') + '</p>'
    + '</div>'
    + '<p class="caption" style="margin:10px 0 0" id="note"></p>'
    + '</section>'
    // Data environment pane: matches the DSH host settings flow.
    + '<section class="pane" data-pane="data" hidden>'
    + '<div class="pane-head"><h1 class="pane-title">' + h('数据环境', 'Data environment') + '<span class="tag" id="data-badge">DSH_HOME</span></h1></div>'
    + '<div class="runtime-picks data-mode-picks" id="data-picks" role="radiogroup" aria-label="' + h('DSH 数据环境', 'DSH data environment') + '">'
    + '<button type="button" role="radio" aria-checked="true" id="data-shared" class="primary" disabled>' + h('共享环境', 'Shared') + '</button>'
    + '<button type="button" role="radio" aria-checked="false" id="data-isolated" disabled>' + h('桌面端独立环境', 'Desktop isolated') + '</button>'
    + '</div>'
    + '<p class="caption path-text" style="margin:10px 0 0" id="data-path"></p>'
    + '<p class="caption" style="margin:8px 0 0" id="data-note" aria-live="polite">' + h('正在读取数据环境…', 'Reading data environment…') + '</p>'
    // The bundled marketplace lives in the profile of this data environment.
    + '<div id="market-section">'
    + '<div class="section-divider"></div>'
    + '<div class="subhead">' + h('插件市场', 'Plugin marketplace') + '</div>'
    + '<div class="flat-row"><div class="row-text"><div class="row-label" id="market-label">' + h('启动时接入内置 DSH Market Pro', 'Load the bundled DSH Market Pro on startup') + '</div>'
    + '<div class="row-help status-text" id="market-status" aria-live="polite"></div></div>'
    + '<div class="row-end"><button id="market-restart" class="primary" type="button" hidden>' + h('立即重启', 'Restart now') + '</button>'
    + '<button id="market-toggle" type="button" role="switch" aria-checked="false" aria-labelledby="market-label" disabled></button></div></div>'
    + '<p class="caption" style="margin:8px 0 0" id="market-note" aria-live="polite"></p>'
    + '</div>'
    + '</section>'
    // App updates pane
    + '<section class="pane" data-pane="updates" hidden>'
    + '<div class="pane-head"><h1 class="pane-title">' + h('应用更新', 'App updates') + '</h1></div>'
    + '<div class="group">'
    + '<div class="row app-row">' + icon + '<div class="row-text"><div class="org-name">DSH Desktop Pro</div><div class="row-help" id="versions"></div></div>'
    + '<div class="row-end">'
    + '<a class="icon-link" id="update-page" href="' + RELEASES_PAGE_URL + '" target="_blank" rel="noreferrer"'
    + ' title="' + h('打开 GitHub 发布页手动下载', 'Open the GitHub releases page to download manually') + '" aria-label="' + h('打开 GitHub 发布页手动下载', 'Open the GitHub releases page to download manually') + '">' + EXTERNAL_LINK_SVG + '</a>'
    + '<button id="update-dismiss" hidden>' + h('稍后提醒', 'Remind me later') + '</button>'
    + '<button id="update-check">' + h('检查更新', 'Check for updates') + '</button>'
    + '<button id="update-install" class="primary" hidden>' + h('下载并安装', 'Download and install') + '</button>'
    + '</div></div>'
    + '<div class="row managed-line" id="managed-updates" hidden></div>'
    + '<div class="row stack" id="update-progress-row"><p class="status-text" id="update-status" hidden></p>'
    + '<div class="progress" id="update-bar" hidden style="margin-top:8px"><span></span></div></div>'
    + '</div>'
    + '<div class="notes-box" id="update-notes" hidden></div>'
    + '</section>'
    + '</main></div><script src="desktop/settings.js"></script></body></html>'
}
