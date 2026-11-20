import { choiceControlsCss } from '../choice-controls.ts'
import { installRestartAction } from '../restart-action.ts'
import { installRuntimeSelection } from '../runtime-selection.ts'
import { connection, type CompanySkillItem, type ConnectionStatus } from './bridge.ts'
import { releaseNotesCss } from '../release-notes.ts'
import { ENHANCE_ID, UPDATE_ID, DESKTOP_PANEL_ID } from './constants.ts'

/** Append the connection block to the 桌面设置 panel, matching the official rows. */
export function injectEnhance(panel: Element): void {
  if (panel.querySelector('#' + ENHANCE_ID) !== null) return

  if (document.getElementById(ENHANCE_ID + '-style') === null) {
    const style = document.createElement('style')
    style.id = ENHANCE_ID + '-style'
    // Official form language: block flow under the options column (padding
    // 0 24px 24px), rows are flex columns, labels #0F1115 14px, secondary
    // text #6E7480 13px, inputs 13px/8px radius/#D8D8D4, ghost buttons 28px.
    style.textContent = [
      // Our own panel replicates the official options-column flow (padding
      // 0 24px 24px), with a hairline between the two cards.
      '#' + DESKTOP_PANEL_ID + '{padding:0 24px 24px}',
      '#' + ENHANCE_ID + '{margin:0;padding:16px 0}',
      '#' + ENHANCE_ID + ' .dsh-enhance-title{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-status{margin:0 0 12px;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-row{display:flex;gap:8px;align-items:center}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input{flex:1;min-width:0;min-height:32px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);outline:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input:focus{border-color:var(--dsw-alias-brand-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input::placeholder{color:var(--dsw-alias-label-tertiary,#8A9099)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-actions{display:flex;gap:8px;align-items:center;margin-left:auto}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:8px;padding:6px 14px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:disabled{cursor:default;opacity:.55}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch{background:var(--dsw-alias-label-primary,#0F1115);border-color:var(--dsw-alias-label-primary,#0F1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch:hover{opacity:.88;background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-danger{color:var(--dsw-alias-status-error,#D93F3F);border-color:color-mix(in srgb,var(--dsw-alias-status-error,#D93F3F) 30%,transparent)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-danger:hover{background:color-mix(in srgb,var(--dsw-alias-status-error,#D93F3F) 8%,transparent)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-note{margin:10px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-note.is-error{color:var(--dsw-alias-status-error,#D93F3F)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-note:empty{display:none}',
      '#' + ENHANCE_ID + ' [hidden]{display:none!important}',
      '#' + ENHANCE_ID + ' .dsh-enhance-entBlock{margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-entHead{gap:8px;flex-wrap:wrap}',
      '#' + ENHANCE_ID + ' .dsh-enhance-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#F5F6F7);color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-state{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#6E7480);white-space:nowrap}',
      '#' + ENHANCE_ID + ' .dsh-enhance-state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}',
      '#' + ENHANCE_ID + ' .dsh-enhance-state.ok{color:#16A34A}',
      '#' + ENHANCE_ID + ' .dsh-enhance-state.warn{color:#B25000}',
      '#' + ENHANCE_ID + ' .dsh-enhance-state.bad{color:var(--dsw-alias-status-error,#D93F3F)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-card{margin-top:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:10px 0 0;font-size:13px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-facts dt{color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-facts dd{margin:0;color:var(--dsw-alias-label-primary,#0F1115);overflow-wrap:anywhere}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillsBlock{margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillsList{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillItem{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillText{flex:1;min-width:0}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillName{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillDesc{font-size:12px;color:var(--dsw-alias-label-secondary,#6E7480);margin-top:2px;overflow-wrap:anywhere}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillEnd{display:flex;align-items:center;gap:8px;flex:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillOk{font-size:12px;color:#16A34A}',
      '#' + ENHANCE_ID + ' .dsh-enhance-skillEmpty{padding:14px;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:12px;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480);text-align:center}',
      '#' + ENHANCE_ID + ' .dsh-enhance-managed{margin:6px 0 4px;padding:9px 12px;border-radius:8px;font-size:13px;background:var(--dsw-alias-interactive-bg-hover,#F5F6F7);color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataBlock{margin:16px 0 0;padding:16px 0 0;'
        + 'border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataModes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataPath{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099);overflow-wrap:anywhere;word-break:break-word}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketBlock{margin:16px 0 0;padding:16px 0 0;border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketRow{display:flex;align-items:center;gap:14px;margin-top:6px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketText{flex:1;min-width:0}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketLabel{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketStatus{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#6E7480);overflow-wrap:anywhere}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketEnd{display:flex;align-items:center;gap:10px;flex:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle{position:relative;flex-shrink:0;width:38px;height:22px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2,#D4D7DD);cursor:pointer;transition:background .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"]{background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle::before{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease;pointer-events:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"]::before{transform:translateX(16px)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle:disabled{opacity:.5;cursor:default}',
      '#' + ENHANCE_ID + ' .dsh-enhance-modes{flex-wrap:wrap;margin:0 0 4px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-smart[hidden],#' + ENHANCE_ID + ' .dsh-enhance-custom[hidden],'
        + '#' + ENHANCE_ID + ' #dsh-enhance-port-block[hidden]{display:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtimes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtime{padding:5px 12px}',
      '#' + ENHANCE_ID + '{--choice-text:var(--dsw-alias-label-primary,#0f1115);--choice-muted:var(--dsw-alias-label-secondary,#6e7480);--choice-border:var(--dsw-alias-border-l2,#d8d8d4);--choice-surface:var(--dsw-alias-bg-module-platform,#f5f6f7);--choice-inverse:var(--dsw-alias-bg-layer-1,#fff)}',
      choiceControlsCss('#' + ENHANCE_ID, 'dsh-enhance-switch'),
      '#' + UPDATE_ID + '{margin:0;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + UPDATE_ID + ' .dsh-update-title{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + UPDATE_ID + ' .dsh-update-version{margin:0 0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099)}',
      '#' + UPDATE_ID + ' .dsh-update-managed{margin:6px 0 8px;padding:8px 12px;border-radius:8px;font-size:12.5px;background:var(--dsw-alias-interactive-bg-hover,#F5F6F7);color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + UPDATE_ID + ' .dsh-update-status{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + UPDATE_ID + ' .dsh-update-status.is-error{color:var(--dsw-alias-status-error,#D93F3F)}',
      // The notes are release Markdown; the stylesheet for what it renders
      // into is shared with the client's own settings page.
      releaseNotesCss('#' + UPDATE_ID + ' .dsh-update-notes', {
        text: 'var(--dsw-alias-label-secondary,#6E7480)',
        strong: 'var(--dsw-alias-label-primary,#0F1115)',
        border: 'var(--dsw-alias-border-l2,#D8D8D4)',
        surface: 'var(--dsw-alias-bg-module-platform,#EBEEF2)',
      }),
      '#' + UPDATE_ID + ' .dsh-update-bar{height:4px;margin:0 0 10px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#EBEEF2);overflow:hidden}',
      '#' + UPDATE_ID + ' .dsh-update-bar span{display:block;height:100%;width:0;border-radius:999px;background:var(--dsw-alias-label-primary,#0F1115);transition:width .2s ease}',
      '#' + UPDATE_ID + ' .dsh-enhance-actions{display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap}',
      '#' + UPDATE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:8px;padding:6px 14px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
      '#' + UPDATE_ID + ' .dsh-enhance-button:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7)}',
      '#' + UPDATE_ID + ' .dsh-enhance-button:disabled{cursor:default;opacity:.55}',
      '#' + UPDATE_ID + ' .dsh-enhance-switch{background:var(--dsw-alias-label-primary,#0F1115);border-color:var(--dsw-alias-label-primary,#0F1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + UPDATE_ID + ' .dsh-enhance-switch:hover{opacity:.88;background:var(--dsw-alias-label-primary,#0F1115)}',
      // A glyph rather than a fourth button: the row keeps one primary action,
      // and this stays a way out rather than a competing choice.
      '#' + UPDATE_ID + ' .dsh-update-link{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;'
        + 'border-radius:999px;text-decoration:none;color:var(--dsw-alias-label-secondary,#6E7480);'
        + 'transition:background .15s ease,color .15s ease}',
      '#' + UPDATE_ID + ' .dsh-update-link:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7);color:var(--dsw-alias-label-primary,#0F1115)}',
    ].join('')
    document.head.appendChild(style)
  }

  const runtimePick = (id: string, label: string, tip: string): string =>
    '<button class="dsh-enhance-button dsh-enhance-runtime dsh-enhance-switch" type="button" data-smart-runtime="' + id
    + '" data-tip="' + tip + '" aria-description="' + tip + '">' + label + '</button>'

  const block = document.createElement('div')
  block.id = ENHANCE_ID
  block.innerHTML =
    '<div class="dsh-enhance-entBlock" id="dsh-enhance-ent" hidden>'
    + '<div id="dsh-enhance-entJoin" hidden>'
    + '<div class="dsh-enhance-title">组织</div>'
    + '<p class="dsh-enhance-note" style="margin-top:4px">公司部署了 DSH Desktop Pro 管理服务端时，粘贴 IT 发给你的加入地址，在浏览器里用公司账号登录后即可加入。加入后使用组织配置的模型、插件和工具权限，组织的数据和你个人的 ~/.dsh 分开存放；随时可以离开。</p>'
    + '<div class="dsh-enhance-row" style="margin-top:10px">'
    + '<input class="dsh-enhance-input" id="dsh-enhance-joinUrl" spellcheck="false" autocomplete="url" placeholder="例如 https://dsh.example.com 或 http://10.0.0.8:8080/#key=…" aria-label="加入地址">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-joinGo" type="button">登录并加入</button>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-joinStatus" role="status" aria-live="polite"></p>'
    + '</div>'
    + '<div id="dsh-enhance-entBody" hidden>'
    + '<div class="dsh-enhance-row dsh-enhance-entHead"><div class="dsh-enhance-title" id="dsh-enhance-entTitle">组织</div><span class="dsh-enhance-badge" id="dsh-enhance-entKind"></span><span class="dsh-enhance-state" id="dsh-enhance-entState" hidden></span></div>'
    + '<dl class="dsh-enhance-facts" id="dsh-enhance-entFacts"></dl>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-entNote"></p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-entOrganisation" type="button" hidden>使用企业账号登录</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-entSync" type="button" hidden>立即同步</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-entDiagnostics" type="button">导出诊断信息</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-entPersonal" type="button" hidden>改用个人模式</button>'
    + '<button class="dsh-enhance-button dsh-enhance-danger" id="dsh-enhance-entSignOut" type="button" hidden>退出企业账号</button>'
    + '</div></div></div>'
    + '<div class="dsh-enhance-skillsBlock" id="dsh-enhance-skillsBlock" hidden>'
    + '<div class="dsh-enhance-title">公司 Skill</div>'
    + '<p class="dsh-enhance-note" style="margin-top:4px">公司整理好的做事方法。标着「全员」的已经装好；其他的按需安装，装好后在新对话里直接用。</p>'
    + '<div class="dsh-enhance-skillsList" id="dsh-enhance-skillsList"></div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-skillsStatus" role="status" aria-live="polite"></p>'
    + '</div>'
    + '<div class="dsh-enhance-title">连接</div>'
    + '<p class="dsh-enhance-status" id="dsh-enhance-status">连接状态读取中…</p>'
    + '<p class="dsh-enhance-managed" id="dsh-enhance-managed" hidden></p>'
    + '<div class="dsh-enhance-row dsh-enhance-modes" id="dsh-enhance-modes" role="radiogroup" aria-label="连接方式">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-mode-smart" type="button" role="radio" aria-checked="true">智能</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-mode-custom" type="button" role="radio" aria-checked="false">自定义</button>'
    + '</div>'
    + '<div class="dsh-enhance-smart" id="dsh-enhance-smart">'
    + '<div id="dsh-enhance-runtime-editor">'
    + '<p class="dsh-enhance-note">可多选，应用后生效，至少保留一种。勾选客户端内置时总是用它，其余来源只在关掉内置后按顺序尝试；勾选本机已运行时，如果共用数据且本机已有 dsh 在运行，会直接连上它。</p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes" id="dsh-enhance-runtimes">'
    + runtimePick('bundled', '客户端内置', '用安装包自带的官方运行时，不用另装 Node 或 dsh。')
    + runtimePick('probe', '本机已运行', '本机已有官方 Web UI 在跑时直接连上（默认 3080），不另起一份。')
    + runtimePick('installed', '本机已安装', '用你 PATH 上自己安装的 dsh，由客户端在后台启动。')
    + runtimePick('npx', 'npx 缓存', '用你跑过 npx @deepseek-ai/dsh 留下的缓存包启动，不联网。')
    + '</div>'
    + '<p class="dsh-enhance-note" data-runtime-status role="status" aria-live="polite"></p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes">'
    + '<button class="dsh-enhance-button" type="button" data-runtime-undo disabled>撤销更改</button>'
    + '<button class="dsh-enhance-button dsh-enhance-switch" type="button" data-runtime-apply disabled>应用并重新连接</button></div></div>'
    + '<div style="margin:16px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)"></div>'
    + '<div class="dsh-enhance-title">本地服务端口</div>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes" role="radiogroup" aria-label="本地服务端口">'
    + '<button class="dsh-enhance-button dsh-enhance-runtime dsh-enhance-switch" id="dsh-enhance-port-random" type="button">自动</button>'
    + '<button class="dsh-enhance-button dsh-enhance-runtime" id="dsh-enhance-port-fixed" type="button">固定</button>'
    + '</div>'
    + '<div id="dsh-enhance-port-block" hidden>'
    + '<div class="dsh-enhance-row" style="margin-top:8px">'
    + '<input class="dsh-enhance-input" id="dsh-enhance-port" spellcheck="false" inputmode="numeric" placeholder="例如 13080">'
    + '<button class="dsh-enhance-button" id="dsh-enhance-port-save" type="button">保存</button>'
    + '</div>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-portNote">仅影响客户端自己启动的 dsh。自动依次尝试 3080、13080，均被占用时使用随机端口；固定端口不自动回退。</p>'
    + '</div>'
    + '<div class="dsh-enhance-custom" id="dsh-enhance-custom" hidden>'
    + '<div class="dsh-enhance-row" style="margin-top:10px">'
    + '<input class="dsh-enhance-input" id="dsh-enhance-url" spellcheck="false" placeholder="例如 http://127.0.0.1:3080">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-save" type="button">保存并连接</button>'
    + '</div>'
    + '<p class="dsh-enhance-note">直连该地址上的 Web UI。服务停掉后不会自动改用本地运行时。</p>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-note"></p>'
    + '<div class="dsh-enhance-dataBlock">'
    + '<div class="dsh-enhance-title">数据环境<span class="dsh-enhance-badge" id="dsh-enhance-dataBadge">DSH_HOME</span></div>'
    + '<div class="dsh-enhance-row dsh-enhance-dataModes" id="dsh-enhance-dataModes" role="radiogroup" aria-label="DSH 数据环境">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-data-shared" type="button" role="radio" aria-checked="true">共享环境</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-data-isolated" type="button" role="radio" aria-checked="false">桌面端独立环境</button>'
    + '</div>'
    + '<p class="dsh-enhance-dataPath" id="dsh-enhance-dataPath"></p>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-dataNote" aria-live="polite">正在读取数据环境…</p>'
    + '<div class="dsh-enhance-marketBlock" id="dsh-enhance-marketBlock">'
    + '<div class="dsh-enhance-title">插件市场</div>'
    + '<div class="dsh-enhance-marketRow">'
    + '<div class="dsh-enhance-marketText">'
    + '<div class="dsh-enhance-marketLabel" id="dsh-enhance-marketLabel">启动时接入内置 DSH Market Pro</div>'
    + '<p class="dsh-enhance-marketStatus" id="dsh-enhance-marketStatus" aria-live="polite"></p>'
    + '</div>'
    + '<div class="dsh-enhance-marketEnd">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-marketRestart" type="button" hidden>立即重启</button>'
    + '<button class="dsh-enhance-toggle" id="dsh-enhance-marketToggle" type="button" role="switch" aria-checked="false" aria-labelledby="dsh-enhance-marketLabel" disabled></button>'
    + '</div></div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-marketNote" aria-live="polite"></p>'
    + '</div>'
    + '</div>'
  const statusEl = block.querySelector('#dsh-enhance-status') as HTMLElement
  const urlEl = block.querySelector('#dsh-enhance-url') as HTMLInputElement
  const noteEl = block.querySelector('#dsh-enhance-note') as HTMLElement
  const modeSmartEl = block.querySelector('#dsh-enhance-mode-smart') as HTMLButtonElement
  const modeCustomEl = block.querySelector('#dsh-enhance-mode-custom') as HTMLButtonElement
  const smartBlockEl = block.querySelector('#dsh-enhance-smart') as HTMLElement
  const customBlockEl = block.querySelector('#dsh-enhance-custom') as HTMLElement
  const portRandomEl = block.querySelector('#dsh-enhance-port-random') as HTMLButtonElement
  const portFixedEl = block.querySelector('#dsh-enhance-port-fixed') as HTMLButtonElement
  const portBlockEl = block.querySelector('#dsh-enhance-port-block') as HTMLElement
  const portEl = block.querySelector('#dsh-enhance-port') as HTMLInputElement
  const portNoteEl = block.querySelector('#dsh-enhance-portNote') as HTMLElement
  const dataSharedEl = block.querySelector('#dsh-enhance-data-shared') as HTMLButtonElement
  const dataIsolatedEl = block.querySelector('#dsh-enhance-data-isolated') as HTMLButtonElement
  const dataPathEl = block.querySelector('#dsh-enhance-dataPath') as HTMLElement
  const dataNoteEl = block.querySelector('#dsh-enhance-dataNote') as HTMLElement
  let dataMode: 'shared' | 'isolated' = 'shared'
  const paintDataMode = (status: ConnectionStatus): void => {
    dataMode = status.dshDataMode === 'isolated' ? 'isolated' : 'shared'
    dataSharedEl.classList.toggle('dsh-enhance-switch', dataMode === 'shared')
    dataIsolatedEl.classList.toggle('dsh-enhance-switch', dataMode === 'isolated')
    dataSharedEl.setAttribute('aria-checked', dataMode === 'shared' ? 'true' : 'false')
    dataIsolatedEl.setAttribute('aria-checked', dataMode === 'isolated' ? 'true' : 'false')
    dataSharedEl.disabled = status.dshDataModeSelectable === false
    dataIsolatedEl.disabled = status.dshDataModeSelectable === false
    const probe = block.querySelector('[data-smart-runtime="probe"]') as HTMLButtonElement | null
    if (probe !== null) probe.disabled = dataMode === 'isolated'
    dataPathEl.textContent = status.dshDataHome ?? ''
    dataNoteEl.textContent = status.dshDataModeSelectable === false
      ? '当前由 DSH_HOME 开发环境变量控制。'
      : status.dshDataFallbackReason === 'plugin-compatibility'
        ? '因共享环境中的插件与当前 DSH 不兼容，当前使用独立环境。解决后可切回共享环境。'
          + (status.dshDataFallbackPlugins === undefined || status.dshDataFallbackPlugins.length === 0
            ? (status.dshDataFallbackPlugin === undefined ? '' : ` 问题插件：${status.dshDataFallbackPlugin}`)
            : ` 问题插件：${status.dshDataFallbackPlugins.join('、')}`)
        : dataMode === 'shared'
          ? '与命令行和浏览器版 DSH 共用对话、凭据、模型配置与插件。'
          : '使用桌面端独立的数据、凭据与插件。切换会重启客户端。'
  }
  const saveDataMode = (mode: 'shared' | 'isolated'): void => {
    if (mode === dataMode) return
    dataSharedEl.disabled = true
    dataIsolatedEl.disabled = true
    dataNoteEl.textContent = '正在保存并重启客户端…'
    void connection.setDshDataMode(mode).then((result) => {
      if (!result.saved) {
        dataSharedEl.disabled = false
        dataIsolatedEl.disabled = false
        dataNoteEl.textContent = '切换失败：' + (result.error ?? '未知错误')
        return
      }
      dataMode = result.dshDataMode
      if (result.applied === true) {
        dataNoteEl.textContent = '已保存，正在重启客户端…'
        return
      }
      void connection.getStatus().then((status) => {
        paintDataMode(status)
        dataNoteEl.textContent = '当前已经是这个环境'
      }, () => {
        dataSharedEl.disabled = false
        dataIsolatedEl.disabled = false
        dataNoteEl.textContent = '当前已经是这个环境'
      })
    }, (error: unknown) => {
      dataSharedEl.disabled = false
      dataIsolatedEl.disabled = false
      dataNoteEl.textContent = '切换失败：' + (error instanceof Error ? error.message : String(error))
    })
  }
  dataSharedEl.addEventListener('click', () => { saveDataMode('shared') })
  dataIsolatedEl.addEventListener('click', () => { saveDataMode('isolated') })
  const paintPort = (port: number | undefined): void => {
    const n = port !== undefined && port > 0 ? port : 0
    const fixed = n > 0
    portRandomEl.classList.toggle('dsh-enhance-switch', !fixed)
    portFixedEl.classList.toggle('dsh-enhance-switch', fixed)
    portBlockEl.hidden = !fixed
    if (fixed) portEl.value = String(n)
  }
  const savePort = (value: number | string): void => {
    void connection.setLocalWebPort(value).then((result) => {
      paintPort(result.localWebPort)
      portNoteEl.textContent = result.saved
        ? (result.applied === true
          ? (result.localWebPort > 0 ? '已固定端口，正在重新启动本地服务…' : '已改回自动端口，正在重新启动本地服务…')
          : '已保存')
        : ('保存失败：' + (result.error ?? '未知错误'))
    }, (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      portNoteEl.textContent = '保存失败：' + (text.includes('sender is not the active Web UI')
        ? '正在重新启动本地服务，请稍后再试' : text)
    })
  }
  portRandomEl.addEventListener('click', () => { paintPort(0); savePort(0) })
  portFixedEl.addEventListener('click', () => {
    portRandomEl.classList.remove('dsh-enhance-switch')
    portFixedEl.classList.add('dsh-enhance-switch')
    portBlockEl.hidden = false
    portEl.focus()
  })
  block.querySelector('#dsh-enhance-port-save')?.addEventListener('click', () => {
    const value = portEl.value.trim()
    if (value === '') {
      portNoteEl.textContent = '请输入端口'
      return
    }
    savePort(value)
  })
  const paintMode = (mode: 'smart' | 'connect'): void => {
    const custom = mode === 'connect'
    modeSmartEl.setAttribute('aria-checked', custom ? 'false' : 'true')
    modeCustomEl.setAttribute('aria-checked', custom ? 'true' : 'false')
    modeSmartEl.classList.toggle('dsh-enhance-switch', !custom)
    modeCustomEl.classList.toggle('dsh-enhance-switch', custom)
    smartBlockEl.hidden = custom
    customBlockEl.hidden = !custom
  }
  modeSmartEl.addEventListener('click', async () => {
    paintMode('smart')
    try {
      const status = await connection.getStatus()
      if (status.selectedMode !== 'connect') return
      const result = await connection.switchMode()
      if (!result.switched) {
        paintMode('connect')
        noteEl.textContent = '切换失败：' + (result.error ?? '未知错误')
        return
      }
      noteEl.textContent = '正在切换到智能模式…'
    } catch (error) {
      paintMode('connect')
      noteEl.textContent = '切换失败：' + (error instanceof Error ? error.message : String(error))
    }
  })
  modeCustomEl.addEventListener('click', () => {
    paintMode('connect')
    if (urlEl.value !== '') return
    void connection.probeLocal().then((probe) => {
      if (probe.url === null || urlEl.value !== '') return
      urlEl.value = probe.url
      noteEl.textContent = '检测到本机已有 Web UI，可直接保存并连接。'
    }).catch(() => { /* offering a live instance is optional */ })
  })
  block.querySelector('#dsh-enhance-save')?.addEventListener('click', async () => {
    try {
      if (urlEl.value.trim() === '') {
        noteEl.textContent = '请先填写地址'
        return
      }
      const result = await connection.saveServerUrl(urlEl.value.trim())
      noteEl.textContent = result.saved
        ? (result.mode === 'smart' ? '正在连接（智能模式：该实例停止时自动回落）' : '已保存，正在连接…')
        : ('保存失败：' + (result.error ?? '未知错误'))
    } catch (error) {
      noteEl.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error))
    }
  })
  const runtimeEditor = installRuntimeSelection({
    root: block.querySelector('#dsh-enhance-runtime-editor') as HTMLElement,
    selectedClass: 'dsh-enhance-switch',
    chinese: true,
    save: ids => connection.setSmartRuntimes(ids),
  })
  for (const button of block.querySelectorAll<HTMLButtonElement>('[data-smart-runtime]')) {
    const tip = button.getAttribute('data-tip') ?? ''
    button.title = tip
  }
  // Enterprise mode: who manages this client, what they fixed, what stays the person's.
  const entEl = block.querySelector('#dsh-enhance-ent') as HTMLElement
  const entJoinEl = block.querySelector('#dsh-enhance-entJoin') as HTMLElement
  const entBodyEl = block.querySelector('#dsh-enhance-entBody') as HTMLElement
  const entTitleEl = block.querySelector('#dsh-enhance-entTitle') as HTMLElement
  const entKindEl = block.querySelector('#dsh-enhance-entKind') as HTMLElement
  const entStateEl = block.querySelector('#dsh-enhance-entState') as HTMLElement
  const entFactsEl = block.querySelector('#dsh-enhance-entFacts') as HTMLElement
  const entNoteEl = block.querySelector('#dsh-enhance-entNote') as HTMLElement
  const entSyncEl = block.querySelector('#dsh-enhance-entSync') as HTMLButtonElement
  const entSignOutEl = block.querySelector('#dsh-enhance-entSignOut') as HTMLButtonElement
  const entPersonalEl = block.querySelector('#dsh-enhance-entPersonal') as HTMLButtonElement
  const entOrganisationEl = block.querySelector('#dsh-enhance-entOrganisation') as HTMLButtonElement
  const entDiagnosticsEl = block.querySelector('#dsh-enhance-entDiagnostics') as HTMLButtonElement
  const joinUrlEl = block.querySelector('#dsh-enhance-joinUrl') as HTMLInputElement
  const joinGoEl = block.querySelector('#dsh-enhance-joinGo') as HTMLButtonElement
  const joinStatusEl = block.querySelector('#dsh-enhance-joinStatus') as HTMLElement
  const skillsBlockEl = block.querySelector('#dsh-enhance-skillsBlock') as HTMLElement
  const skillsListEl = block.querySelector('#dsh-enhance-skillsList') as HTMLElement
  const skillsStatusEl = block.querySelector('#dsh-enhance-skillsStatus') as HTMLElement
  const dataBadgeEl = block.querySelector('#dsh-enhance-dataBadge') as HTMLElement
  const marketBlockEl = block.querySelector('#dsh-enhance-marketBlock') as HTMLElement
  const marketToggleEl = block.querySelector('#dsh-enhance-marketToggle') as HTMLButtonElement
  const marketStatusEl = block.querySelector('#dsh-enhance-marketStatus') as HTMLElement
  const marketNoteEl = block.querySelector('#dsh-enhance-marketNote') as HTMLElement
  const marketRestartEl = block.querySelector('#dsh-enhance-marketRestart') as HTMLButtonElement

  let marketSaving = false
  let marketReading = false
  let marketEpoch = 0
  let marketChanged = false
  let marketError = false
  const paintMarket = (enabled: boolean): void => {
    marketToggleEl.disabled = false
    marketToggleEl.setAttribute('aria-checked', String(enabled))
  }
  const paintMarketInstallation = (status: ConnectionStatus): void => {
    const m = status.bundledMarketInstallation
    let line = ''
    marketRestartEl.hidden = !marketChanged || status.marketRestartAvailable !== true
    if (marketChanged && !marketError) {
      marketNoteEl.classList.remove('is-error')
      marketNoteEl.textContent = '已保存。下次由客户端启动本地服务时生效。'
        + (status.marketRestartAvailable === true ? '可立即重启，尝试应用更改。' : '')
    }
    if (m === undefined || m.state === 'unknown') line = '无法确认本地安装状态。'
    else if (m.state === 'missing') line = '本地未安装。'
    else if (m.state === 'incomplete') line = '本地安装不完整。'
    else line = '本地已安装' + (m.version !== undefined ? ' v' + m.version : '') + (m.state === 'unregistered'
      ? '，未登记加载。' : '，已登记加载（不代表当前会话已生效）。')
    if (status.mode !== 'local' && status.marketRestartAvailable !== true) {
      line += ' 当前连接已有服务，此开关不会修改该服务；下次由客户端启动本地服务时生效。'
    } else if (status.bundledMarketEnabled !== true) {
      line += (m !== undefined && m.state === 'registered' && !m.owned)
        ? ' 自动接入已关闭；当前用户安装不受此开关管理。'
        : ' 自动接入已关闭，下次由客户端启动本地服务时会移除客户端管理的市场副本；开启后再重启可尝试恢复。'
    } else if (m !== undefined && ((m.state === 'incomplete' && !m.owned) || (m.state === 'unregistered' && !m.owned))) {
      line += ' 用户安装或残留阻止自动接入；请先通过插件管理完成卸载，再重启客户端。'
    } else if (m !== undefined && m.state !== 'registered' && m.state !== 'unknown') {
      line += ' 下次由客户端启动本地服务时尝试恢复内置副本；当前会话可能仍保留旧界面。'
    }
    marketStatusEl.textContent = line
  }
  const refreshMarket = async (): Promise<void> => {
    if (marketSaving || marketReading || !block.isConnected || marketBlockEl.hidden) return
    marketReading = true
    const epoch = marketEpoch
    try {
      const status = await connection.getStatus()
      if (!marketSaving && epoch === marketEpoch && block.isConnected) {
        paintMarket(status.bundledMarketEnabled !== false)
        paintMarketInstallation(status)
      }
    } catch {
      if (!marketSaving && epoch === marketEpoch && block.isConnected) {
        marketStatusEl.textContent = '安装状态暂时无法确认。'
      }
    } finally {
      marketReading = false
    }
  }
  marketToggleEl.addEventListener('click', () => {
    const wanted = marketToggleEl.getAttribute('aria-checked') !== 'true'
    marketSaving = true
    marketError = false
    marketEpoch++
    marketToggleEl.disabled = true
    marketRestartEl.disabled = true
    void connection.setBundledMarketEnabled(wanted).then((result) => {
      paintMarket(result.enabled)
      marketNoteEl.classList.remove('is-error')
      marketNoteEl.textContent = '已保存。下次由客户端启动本地服务时生效。'
      marketChanged = true
      marketRestartEl.hidden = true
      marketRestartEl.textContent = '立即重启'
    }, (error: unknown) => {
      marketError = true
      marketNoteEl.classList.add('is-error')
      marketNoteEl.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error))
    }).finally(() => {
      marketSaving = false
      marketToggleEl.disabled = false
      marketRestartEl.disabled = false
      void refreshMarket()
    })
  })
  installRestartAction({
    button: marketRestartEl,
    chinese: true,
    setBusy: (busy) => { marketSaving = busy; marketEpoch++; marketToggleEl.disabled = busy },
    showError: (message) => {
      marketError = true
      marketNoteEl.classList.add('is-error')
      marketNoteEl.textContent = message
    },
    request: () => connection.restart(),
  })

  const setSkillsStatus = (text: string, isError = false): void => {
    skillsStatusEl.classList.toggle('is-error', isError)
    skillsStatusEl.textContent = text
  }
  const paintSkills = (list: CompanySkillItem[]): void => {
    skillsListEl.replaceChildren()
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'dsh-enhance-skillEmpty'
      empty.textContent = '公司还没有发布 Skill。'
      skillsListEl.append(empty)
      return
    }
    for (const skill of list) {
      const item = document.createElement('div')
      item.className = 'dsh-enhance-skillItem'
      const text = document.createElement('div')
      text.className = 'dsh-enhance-skillText'
      const name = document.createElement('div')
      name.className = 'dsh-enhance-skillName'
      name.textContent = skill.title
      const desc = document.createElement('div')
      desc.className = 'dsh-enhance-skillDesc'
      desc.textContent = (skill.description !== undefined && skill.description !== '' ? skill.description + ' · ' : '') + 'v' + String(skill.version)
      text.append(name, desc)
      const end = document.createElement('div')
      end.className = 'dsh-enhance-skillEnd'
      if (skill.distribution === 'everyone') {
        const tag = document.createElement('span')
        tag.className = 'dsh-enhance-badge'
        tag.textContent = '全员 · 已安装'
        end.append(tag)
      } else {
        if (skill.installed) {
          const ok = document.createElement('span')
          ok.className = 'dsh-enhance-skillOk'
          ok.textContent = '已安装'
          end.append(ok)
        }
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = skill.installed ? 'dsh-enhance-button dsh-enhance-danger' : 'dsh-enhance-button dsh-enhance-switch'
        btn.textContent = skill.installed ? '移除' : '安装'
        btn.addEventListener('click', () => { void toggleSkill(skill, !skill.installed) })
        end.append(btn)
      }
      item.append(text, end)
      skillsListEl.append(item)
    }
  }
  let skillsLoaded = false
  const loadSkills = async (): Promise<void> => {
    setSkillsStatus('正在读取…')
    try {
      const result = await connection.enterpriseSkills()
      if (!result.ok) throw new Error(result.error ?? '读取失败')
      paintSkills(result.skills ?? [])
      setSkillsStatus('')
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error), true)
    }
  }
  const toggleSkill = async (skill: CompanySkillItem, installed: boolean): Promise<void> => {
    for (const btn of skillsListEl.querySelectorAll<HTMLButtonElement>('button')) btn.disabled = true
    setSkillsStatus(installed ? '正在安装…' : '正在移除…')
    try {
      const result = await connection.setEnterpriseSkill({ id: skill.id, installed })
      if (!result.saved) throw new Error(result.error ?? '操作失败')
      paintSkills(result.skills ?? [])
      setSkillsStatus(installed ? '已安装「' + skill.title + '」，新对话里就能用。' : '已移除「' + skill.title + '」。')
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error), true)
      for (const btn of skillsListEl.querySelectorAll<HTMLButtonElement>('button')) btn.disabled = false
    }
  }

  const lockedNote = '连接方式、运行时来源和数据环境由组织统一设置，不能在这里修改；本地服务端口和应用更新仍可以自己调整。'
  const paintEnterprise = (status: ConnectionStatus): void => {
    const ent = status.enterprise
    const managed = ent !== undefined && ent.mode !== 'personal'
    const offer = ent !== undefined && !managed && ent.available !== undefined
    const joinable = ent !== undefined && !managed && !offer && ent.joinable === true
    const show = (selector: string, visible: boolean): void => { (block.querySelector(selector) as HTMLElement).hidden = !visible }
    entEl.hidden = !managed && !offer && !joinable
    entJoinEl.hidden = !joinable
    entBodyEl.hidden = joinable
    entSignOutEl.textContent = ent?.joined === true ? '离开组织' : '退出企业账号'
    const showSkills = managed && ent.mode === 'server' && ent.user !== undefined
    skillsBlockEl.hidden = !showSkills
    if (showSkills && !skillsLoaded) {
      skillsLoaded = true
      void loadSkills()
    }
    entOrganisationEl.hidden = !offer
    entPersonalEl.hidden = !(managed && ent.personalAllowed === true)
    entDiagnosticsEl.hidden = !managed
    marketBlockEl.hidden = managed
    dataBadgeEl.textContent = managed ? '组织数据' : 'DSH_HOME'
    if (offer) {
      entTitleEl.textContent = ent.available ?? '组织'
      entKindEl.textContent = '个人模式'
      entStateEl.hidden = true
      entSyncEl.hidden = true
      entSignOutEl.hidden = ent.joined !== true
      entFactsEl.replaceChildren()
      entNoteEl.classList.remove('is-error')
      entNoteEl.textContent = ent.joined === true
        ? '你已加入 ' + (ent.available ?? '') + '，现在用的是个人模式：自己的模型 Key 和个人数据目录，不应用组织配置。组织的会话和配置原样保留，随时可以切回企业账号。'
        : '这台电脑登记在 ' + (ent.available ?? '') + '。你现在用的是个人模式：自己的模型 Key 和个人数据目录，不应用组织配置。组织的会话和配置原样保留，随时可以切回企业账号。'
    }
    show('#dsh-enhance-modes', !managed)
    show('#dsh-enhance-runtime-editor', !managed)
    show('#dsh-enhance-dataModes', !managed)
    show('#dsh-enhance-managed', managed)
    if (!managed) return
    show('#dsh-enhance-smart', true)
    show('#dsh-enhance-custom', false)
    entTitleEl.textContent = ent.organization ?? '组织'
    entKindEl.textContent = ent.mode === 'server' && ent.joined === true
      ? '你自己加入的组织，由企业服务端统一配置'
      : ent.mode === 'server' ? '由企业服务端统一管理' : ent.mode === 'file' ? '由配置文件统一管理' : '配置无效'
    entStateEl.hidden = false
    entStateEl.className = 'dsh-enhance-state ' + (ent.mode === 'invalid' ? 'bad' : ent.offline === true ? 'warn' : 'ok')
    entStateEl.textContent = ent.mode === 'invalid' ? '配置无效' : ent.offline === true ? '离线' : '已连接'
    entSyncEl.hidden = ent.mode !== 'server'
    entSignOutEl.hidden = ent.mode !== 'server'
    const facts: Array<[string, string]> = []
    if (ent.user !== undefined) facts.push(['账号', ent.user])
    if (ent.revision !== undefined) facts.push(['配置版本', 'r' + String(ent.revision)])
    if (ent.mode === 'server') {
      const minutes = ent.lastCheckedAt === undefined ? undefined : Math.round((Date.now() - ent.lastCheckedAt) / 60000)
      facts.push(['上次同步', minutes === undefined ? '等待首次同步' : minutes < 1 ? '刚刚' : minutes < 60 ? String(minutes) + ' 分钟前' : String(Math.round(minutes / 60)) + ' 小时前'])
    }
    if (ent.mode === 'file' && ent.managedFile !== undefined) {
      facts.push(['配置文件', ent.managedFile + (ent.signed === true ? '（已签名）' : '')])
    }
    if (ent.mode === 'invalid') facts.push(['状态', '配置无效，客户端不会启动运行时'])
    else if (ent.offline === true) facts.push(['状态', '连不上企业服务，正在用上次的配置'])
    entFactsEl.replaceChildren(...facts.flatMap(([label, value]) => {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = value
      return [term, detail]
    }))
    entNoteEl.classList.toggle('is-error', ent.problems.length > 0)
    entNoteEl.textContent = ent.problems.length > 0 ? ent.problems.join('；') : lockedNote
    ;(block.querySelector('#dsh-enhance-managed') as HTMLElement).textContent = '由组织固定：智能模式，使用客户端内置的 DSH ' + (status.dshVersion ?? '') + '；不连接本机其他 dsh，也不能填自定义地址。'
    dataNoteEl.textContent = '组织的对话、凭据和插件单独存放在这里，不会和你个人的 ~/.dsh 混在一起。退出企业账号时，组织下发的配置会被清除，对话记录保留。'
  }
  const joinOrganisation = async (): Promise<void> => {
    const server = joinUrlEl.value.trim()
    if (server === '') {
      joinStatusEl.classList.add('is-error')
      joinStatusEl.textContent = '请先粘贴加入地址'
      return
    }
    joinGoEl.disabled = true
    joinUrlEl.disabled = true
    joinStatusEl.classList.remove('is-error')
    joinStatusEl.textContent = '正在连接企业服务端…确认后请在浏览器里完成登录。'
    try {
      const result = await connection.joinOrganisation(server)
      if (result.saved) {
        joinStatusEl.textContent = '已加入，客户端正在重启…'
        return
      }
      joinStatusEl.classList.toggle('is-error', result.error !== undefined && result.error !== '')
      joinStatusEl.textContent = result.error ?? ''
    } catch (error) {
      joinStatusEl.classList.add('is-error')
      joinStatusEl.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      joinGoEl.disabled = false
      joinUrlEl.disabled = false
    }
  }
  joinGoEl.addEventListener('click', () => { void joinOrganisation() })
  joinUrlEl.addEventListener('keydown', (event) => { if (event.key === 'Enter') void joinOrganisation() })
  const runEnterpriseAction = async (action: 'sync' | 'diagnostics' | 'sign-out' | 'use-personal' | 'use-organisation', button: HTMLButtonElement): Promise<void> => {
    button.disabled = true
    entNoteEl.classList.remove('is-error')
    if (action === 'sync') entNoteEl.textContent = '正在同步…'
    try {
      const result = await connection.enterpriseAction(action)
      if (!result.ok) {
        entNoteEl.classList.add('is-error')
        entNoteEl.textContent = result.error ?? '操作失败'
        return
      }
      if (action === 'sync') {
        paintEnterprise(await connection.getStatus())
        entNoteEl.classList.remove('is-error')
        entNoteEl.textContent = '已同步到最新配置。'
      }
    } catch (error) {
      entNoteEl.classList.add('is-error')
      entNoteEl.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      button.disabled = false
    }
  }
  entSyncEl.addEventListener('click', () => { void runEnterpriseAction('sync', entSyncEl) })
  entPersonalEl.addEventListener('click', () => { void runEnterpriseAction('use-personal', entPersonalEl) })
  entOrganisationEl.addEventListener('click', () => { void runEnterpriseAction('use-organisation', entOrganisationEl) })
  entDiagnosticsEl.addEventListener('click', () => { void runEnterpriseAction('diagnostics', entDiagnosticsEl) })
  entSignOutEl.addEventListener('click', () => { void runEnterpriseAction('sign-out', entSignOutEl) })
  const initialMarketEpoch = marketEpoch
  void connection.getStatus().then((status) => {
    // Named by WHO started the runtime, then which dsh it is — "本地"/"内置"
    // used to overlap, and a reused instance the user started got neither.
    const version = status.installedDshVersion === undefined ? '' : ' v' + status.installedDshVersion
    const startedByClient = status.runtimeSource === 'installed'
      ? '客户端启动·本机已安装' + version
      : status.runtimeSource === 'npx'
        ? '客户端启动·npx 缓存' + version
        : status.runtimeSource === 'bundled' ? '客户端启动·客户端内置' : '客户端启动'
    const modeLabel = status.mode === 'probe'
      ? '本机已运行'
      : status.mode === 'connect' ? '自定义地址' : startedByClient
    statusEl.textContent = modeLabel + ' → ' + (status.targetUrl === '' || status.targetUrl === undefined ? '（未就绪）' : status.targetUrl.replace(/[?#].*$/, ''))
      + (status.childPid !== undefined ? ' · PID ' + String(status.childPid) : '')
      + (status.lastError !== undefined ? ' · ' + status.lastError : '')
      // Non-blocking: the cache stays in use; re-running npx is how it updates.
      + (status.mode === 'local' && status.npxCacheOutdated === true
        ? ' · npx 缓存低于内置' + (status.dshVersion === null ? '' : ' v' + status.dshVersion) + '，重新运行 npx 可更新'
        : '')
    urlEl.value = status.savedServerUrl
    paintMode(status.selectedMode)
    runtimeEditor.load(status.smartRuntimes, status.dshDataMode === 'isolated')
    paintPort(status.localWebPort)
    paintDataMode(status)
    paintEnterprise(status)
    if (!marketSaving && initialMarketEpoch === marketEpoch) {
      paintMarket(status.bundledMarketEnabled !== false)
      paintMarketInstallation(status)
    }
  }).catch(() => { statusEl.textContent = '连接状态不可用' })
  const onFocus = (): void => {
    if (!block.isConnected) {
      cleanupMarketWatch()
      return
    }
    void refreshMarket()
  }
  const marketTimer = window.setInterval(() => {
    if (!block.isConnected) {
      cleanupMarketWatch()
      return
    }
    if (!document.hidden) void refreshMarket()
  }, 2000)
  const cleanupMarketWatch = (): void => {
    window.clearInterval(marketTimer)
    window.removeEventListener('focus', onFocus)
  }
  window.addEventListener('focus', onFocus)
  panel.appendChild(block)
}
