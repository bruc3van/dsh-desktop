import { connection, type ConnectionStatus } from './bridge.ts'
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
      '#' + ENHANCE_ID + ' .dsh-enhance-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);outline:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input:focus{border-color:var(--dsw-alias-brand-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-input::placeholder{color:var(--dsw-alias-label-dimmed,#9AA0A6)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-actions{display:flex;gap:8px;align-items:center;margin-left:auto}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:28px;padding:6px 16px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:hover{background:var(--dsw-alias-interactive-bg-hover,#F5F6F7)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-button:disabled{cursor:default;opacity:.55}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch{background:var(--dsw-alias-label-primary,#0F1115);border-color:var(--dsw-alias-label-primary,#0F1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-switch:hover{opacity:.88;background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-note{margin:10px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#6E7480)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketBlock{margin:16px 0 0;padding:16px 0 0;'
        + 'border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketRow{justify-content:space-between;gap:12px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-marketLabel{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataBlock{margin:16px 0 0;padding:16px 0 0;'
        + 'border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataModes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataModes .dsh-enhance-button{min-height:44px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-dataPath{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099);overflow-wrap:anywhere;word-break:break-word}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle{position:relative;flex-shrink:0;width:40px;height:22px;padding:0;'
        + 'border:none;border-radius:999px;background:var(--dsw-alias-border-l2,#D8D8D4);cursor:pointer;'
        + 'transition:background .15s ease,opacity .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"]{background:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle:disabled{cursor:default;opacity:.55}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;'
        + 'border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);pointer-events:none;'
        + 'transition:transform .15s ease}',
      '#' + ENHANCE_ID + ' .dsh-enhance-toggle[aria-checked="true"] .dsh-enhance-toggle-thumb{transform:translateX(18px)}',
      '#' + ENHANCE_ID + ' .dsh-enhance-modes{flex-wrap:wrap;margin:0 0 4px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-smart[hidden],#' + ENHANCE_ID + ' .dsh-enhance-custom[hidden],'
        + '#' + ENHANCE_ID + ' #dsh-enhance-port-block[hidden]{display:none}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtimes{flex-wrap:wrap;margin-top:8px}',
      '#' + ENHANCE_ID + ' .dsh-enhance-runtime{padding:5px 12px}',
      '#' + UPDATE_ID + '{margin:0;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2,#D8D8D4)}',
      '#' + UPDATE_ID + ' .dsh-update-title{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0F1115)}',
      '#' + UPDATE_ID + ' .dsh-update-version{margin:0 0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8A9099)}',
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
      '#' + UPDATE_ID + ' .dsh-enhance-button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid var(--dsw-alias-border-l2,#D8D8D4);border-radius:28px;padding:6px 16px;font-size:13px;color:var(--dsw-alias-label-primary,#0F1115);cursor:pointer;transition:background .15s ease,opacity .15s ease}',
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
    '<div class="dsh-enhance-title">连接</div>'
    + '<p class="dsh-enhance-status" id="dsh-enhance-status">连接状态读取中…</p>'
    + '<div class="dsh-enhance-row dsh-enhance-modes" role="radiogroup" aria-label="连接方式">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-mode-smart" type="button" role="radio" aria-checked="true">智能</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-mode-custom" type="button" role="radio" aria-checked="false">自定义</button>'
    + '</div>'
    + '<div class="dsh-enhance-smart" id="dsh-enhance-smart">'
    + '<p class="dsh-enhance-note">可多选，按优先级依次尝试</p>'
    + '<div class="dsh-enhance-row dsh-enhance-runtimes" id="dsh-enhance-runtimes">'
    + runtimePick('probe', '本机已运行', '本机已有官方 Web UI 在跑时直接连上（默认 3080），不另起一份。')
    + runtimePick('installed', '本机已安装', '用你 PATH 上自己安装的 dsh，由客户端在后台启动。')
    + runtimePick('npx', 'npx 缓存', '用你跑过 npx @deepseek-ai/dsh 留下的缓存包启动，不联网。')
    + runtimePick('bundled', '客户端内置', '用安装包自带的官方运行时，不用另装 Node 或 dsh。')
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-runtimeNote">关掉的来源会跳过。至少保留一种。</p>'
    + '<p class="dsh-enhance-note" style="margin-top:14px">本地服务端口</p>'
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
    + '<button class="dsh-enhance-button" id="dsh-enhance-save" type="button">保存并连接</button>'
    + '</div>'
    + '<p class="dsh-enhance-note">直连该地址上的 Web UI。服务停掉后不会自动改用本地运行时。</p>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-note"></p>'
    + '<div class="dsh-enhance-marketBlock">'
    + '<div class="dsh-enhance-row dsh-enhance-marketRow">'
    + '<span class="dsh-enhance-marketLabel" id="dsh-enhance-marketLabel">安全市场</span>'
    + '<button class="dsh-enhance-toggle" id="dsh-enhance-market" type="button" role="switch" aria-checked="false" aria-labelledby="dsh-enhance-marketLabel">'
    + '<span class="dsh-enhance-toggle-thumb"></span></button>'
    + '</div>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-marketNote"></p>'
    + '</div>'
    + '<div class="dsh-enhance-dataBlock">'
    + '<div class="dsh-enhance-title">数据环境</div>'
    + '<div class="dsh-enhance-row dsh-enhance-dataModes" role="radiogroup" aria-label="DSH 数据环境">'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-enhance-data-shared" type="button" role="radio" aria-checked="true">共享环境</button>'
    + '<button class="dsh-enhance-button" id="dsh-enhance-data-isolated" type="button" role="radio" aria-checked="false">桌面端独立环境</button>'
    + '</div>'
    + '<p class="dsh-enhance-dataPath" id="dsh-enhance-dataPath"></p>'
    + '<p class="dsh-enhance-note" id="dsh-enhance-dataNote" aria-live="polite">正在读取数据环境…</p>'
    + '</div>'
  const statusEl = block.querySelector('#dsh-enhance-status') as HTMLElement
  const urlEl = block.querySelector('#dsh-enhance-url') as HTMLInputElement
  const noteEl = block.querySelector('#dsh-enhance-note') as HTMLElement
  const modeSmartEl = block.querySelector('#dsh-enhance-mode-smart') as HTMLButtonElement
  const modeCustomEl = block.querySelector('#dsh-enhance-mode-custom') as HTMLButtonElement
  const smartBlockEl = block.querySelector('#dsh-enhance-smart') as HTMLElement
  const customBlockEl = block.querySelector('#dsh-enhance-custom') as HTMLElement
  const runtimeNoteEl = block.querySelector('#dsh-enhance-runtimeNote') as HTMLElement
  const portRandomEl = block.querySelector('#dsh-enhance-port-random') as HTMLButtonElement
  const portFixedEl = block.querySelector('#dsh-enhance-port-fixed') as HTMLButtonElement
  const portBlockEl = block.querySelector('#dsh-enhance-port-block') as HTMLElement
  const portEl = block.querySelector('#dsh-enhance-port') as HTMLInputElement
  const portNoteEl = block.querySelector('#dsh-enhance-portNote') as HTMLElement
  const runtimeDefaultNote = '关掉的来源会跳过。至少保留一种。'
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
  const marketEl = block.querySelector('#dsh-enhance-market') as HTMLButtonElement
  const marketNoteEl = block.querySelector('#dsh-enhance-marketNote') as HTMLElement
  const paintMarket = (enabled: boolean): void => {
    marketEl.setAttribute('aria-checked', enabled ? 'true' : 'false')
  }
  void connection.getMarket().then((state) => { paintMarket(state.enabled) }, () => {
    // The row is an enhancement; a bridge that will not answer just leaves it
    // out rather than putting a switch nobody can trust in front of anyone.
    ;(block.querySelector('.dsh-enhance-marketBlock') as HTMLElement | null)?.remove()
  })
  marketEl.addEventListener('click', async () => {
    const wanted = marketEl.getAttribute('aria-checked') !== 'true'
    marketEl.disabled = true
    try {
      const result = await connection.setMarket(wanted)
      paintMarket(result.enabled)
      marketNoteEl.textContent = result.enabled
        ? '已开启。重启客户端后，安全市场会接入当前运行时。'
        : '已关闭并从 profile 中移除。当前会话里它仍然加载着，重启后消失。'
    } catch (error) {
      paintMarket(!wanted)
      marketNoteEl.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error))
    } finally {
      marketEl.disabled = false
    }
  })
  const runtimeButtons = [...block.querySelectorAll('[data-smart-runtime]')] as HTMLButtonElement[]
  const allRuntimes: Array<'probe' | 'installed' | 'npx' | 'bundled'> = ['probe', 'installed', 'npx', 'bundled']
  const paintRuntimes = (ids: Array<'probe' | 'installed' | 'npx' | 'bundled'> | undefined): void => {
    const on = new Set(ids !== undefined && ids.length > 0 ? ids : allRuntimes)
    for (const button of runtimeButtons) {
      const id = button.getAttribute('data-smart-runtime')
      button.classList.toggle('dsh-enhance-switch', id !== null && on.has(id as typeof allRuntimes[number]))
    }
  }
  type SmartRuntimePick = 'probe' | 'installed' | 'npx' | 'bundled'
  let runtimeSaveBusy = false
  let runtimeSaveQueued: SmartRuntimePick[] | undefined
  const selectedRuntimes = (): SmartRuntimePick[] => runtimeButtons
    .filter((entry) => entry.classList.contains('dsh-enhance-switch'))
    .map((entry) => entry.getAttribute('data-smart-runtime'))
    .filter((entry): entry is SmartRuntimePick => entry !== null)
  const bridgeFailure = (error: unknown): string => {
    const text = error instanceof Error ? error.message : String(error)
    if (text.includes('sender is not the active Web UI') || text.includes('Render frame was disposed')) {
      return '正在重新启动本地服务，请稍后再试'
    }
    return text
  }
  const commitRuntimes = (ids: SmartRuntimePick[]): void => {
    paintRuntimes(ids)
    runtimeNoteEl.textContent = '正在更新智能连接来源…'
    if (runtimeSaveBusy) {
      runtimeSaveQueued = ids
      return
    }
    runtimeSaveBusy = true
    void connection.setSmartRuntimes(ids).then((result) => {
      runtimeSaveBusy = false
      if (runtimeSaveQueued !== undefined) {
        const queued = runtimeSaveQueued
        runtimeSaveQueued = undefined
        commitRuntimes(queued)
        return
      }
      paintRuntimes(result.smartRuntimes)
      runtimeNoteEl.textContent = result.saved
        ? '已更新智能连接来源'
        : ('保存失败：' + (result.error ?? '至少保留一种来源'))
    }, (error: unknown) => {
      runtimeSaveBusy = false
      if (runtimeSaveQueued !== undefined) {
        const queued = runtimeSaveQueued
        runtimeSaveQueued = undefined
        commitRuntimes(queued)
        return
      }
      runtimeNoteEl.textContent = '保存失败：' + bridgeFailure(error)
      void connection.getStatus().then((status) => { paintRuntimes(status.smartRuntimes) }, () => {})
    })
  }
  for (const button of runtimeButtons) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-smart-runtime')
      if (id === null) return
      const current = selectedRuntimes()
      const next = current.includes(id as SmartRuntimePick)
        ? current.filter((entry) => entry !== id)
        : [...current, id as SmartRuntimePick]
      if (next.length === 0) {
        runtimeNoteEl.textContent = '至少保留一种来源'
        return
      }
      commitRuntimes(next)
    })
    const tip = button.getAttribute('data-tip') ?? ''
    button.addEventListener('mouseenter', () => { runtimeNoteEl.textContent = tip })
    button.addEventListener('focus', () => { runtimeNoteEl.textContent = tip })
    button.addEventListener('mouseleave', () => {
      if (runtimeNoteEl.textContent === tip) runtimeNoteEl.textContent = runtimeDefaultNote
    })
    button.addEventListener('blur', () => {
      if (runtimeNoteEl.textContent === tip) runtimeNoteEl.textContent = runtimeDefaultNote
    })
  }
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
    statusEl.textContent = modeLabel + ' → ' + (status.targetUrl || '（未就绪）')
      + (status.childPid !== undefined ? ' · PID ' + String(status.childPid) : '')
      + (status.lastError !== undefined ? ' · ' + status.lastError : '')
      // Non-blocking: the cache stays in use; re-running npx is how it updates.
      + (status.mode === 'local' && status.npxCacheOutdated === true
        ? ' · npx 缓存低于内置' + (status.dshVersion === null ? '' : ' v' + status.dshVersion) + '，重新运行 npx 可更新'
        : '')
    urlEl.value = status.savedServerUrl
    paintMode(status.selectedMode)
    paintRuntimes(status.smartRuntimes)
    paintPort(status.localWebPort)
    paintDataMode(status)
  }).catch(() => { statusEl.textContent = '连接状态不可用' })
  panel.appendChild(block)
}
