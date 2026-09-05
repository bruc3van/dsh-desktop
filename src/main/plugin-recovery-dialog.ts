import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type MessageBoxOptions } from 'electron'

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] ?? char)

export function pluginRecoveryPage(options: MessageBoxOptions, plugins: string[], chinese: boolean): string {
  const label = chinese ? `涉及插件（${plugins.length}）` : `Affected plugins (${plugins.length})`
  return '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><style>'
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;background:#fff;color:#0f1115;font-size:13px;line-height:1.6}'
    + 'main{height:100vh;padding:24px;display:flex;flex-direction:column;gap:16px;overflow:hidden}'
    + '.content{flex:0 1 auto;min-height:0;max-height:45%;overflow:auto;scrollbar-gutter:stable}h1{margin:0 0 14px;font-size:18px;line-height:1.5}'
    + 'p{margin:0;white-space:pre-wrap;color:#6e7480;overflow-wrap:anywhere}'
    + '.plugins{min-height:0;flex:1;display:flex;flex-direction:column}.label{flex-shrink:0;margin:0 0 6px;font-size:12px;font-weight:600}'
    + 'ul{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;margin:0;padding:8px 12px 8px 28px;border:1px solid #d8d8d4;border-radius:10px}'
    + 'li{padding:4px 0;overflow-wrap:anywhere}footer{flex-shrink:0;margin-top:auto;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}'
    + 'a{display:flex;align-items:center;justify-content:center;min-width:0;overflow-wrap:anywhere;text-align:center;text-decoration:none;font:inherit;padding:7px 12px;border:1px solid #d8d8d4;border-radius:24px;color:inherit}'
    + 'a:hover{background:#ebeef2}a.primary{background:#0f1115;color:#fff;border-color:#0f1115}'
    + ':focus-visible{outline:2px solid #528bff;outline-offset:2px}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}p{color:#aeb3bb}ul,a{border-color:#3a3d42}a:hover{background:#232529}a.primary{background:#f4f5f6;color:#17181a}}'
    + '</style></head><body><main><div class="content"><h1>' + escapeHtml(options.message) + '</h1><p>' + escapeHtml(options.detail ?? '') + '</p></div>'
    + (plugins.length ? '<section class="plugins" aria-label="' + escapeHtml(label) + '"><div class="label">' + escapeHtml(label) + '</div><ul tabindex="0">' + plugins.map(name => '<li>' + escapeHtml(name) + '</li>').join('') + '</ul></section>' : '')
    + '<footer>' + (options.buttons ?? []).map((label, index) => '<a href="dsh-plugin-recovery:' + index + '"' + (index === options.defaultId ? ' class="primary" id="default-action"' : '') + '>' + escapeHtml(label) + '</a>').join('')
    + '</footer></main></body></html>'
}

/** A bounded modal keeps the complete plugin list separate from the actions. */
export function showPluginRecoveryDialog(owner: BrowserWindow | null, options: MessageBoxOptions, plugins: string[], chinese: boolean, appearance: Pick<BrowserWindowConstructorOptions, 'icon' | 'backgroundColor'> = {}): Promise<number> {
  return new Promise(resolve => {
    const parent = owner !== null && !owner.isDestroyed() ? owner : undefined
    const area = (parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()).workAreaSize
    const prompt = new BrowserWindow({
      ...appearance,
      width: Math.min(560, area.width),
      height: Math.min(600, area.height),
      minWidth: Math.min(320, area.width), minHeight: Math.min(420, area.height),
      title: options.title ?? 'DSH Desktop',
      parent, modal: parent !== undefined, show: false,
      resizable: true, minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    let response = options.cancelId ?? (options.buttons?.length ?? 1) - 1
    const act = (url: string): void => {
      const match = /^dsh-plugin-recovery:(\d+)$/.exec(url)
      if (!match) return
      const index = Number(match[1])
      if (index >= (options.buttons?.length ?? 0)) return
      response = index
      prompt.close()
    }
    prompt.on('closed', () => { resolve(response) })
    prompt.webContents.setWindowOpenHandler(({ url }) => { act(url); return { action: 'deny' } })
    prompt.webContents.on('will-navigate', (event, url) => { event.preventDefault(); act(url) })
    prompt.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); prompt.close() }
    })
    void prompt.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pluginRecoveryPage(options, plugins, chinese)))
      .then(async () => {
        if (prompt.isDestroyed()) return
        await prompt.webContents.executeJavaScript('document.getElementById("default-action")?.focus()')
        if (!prompt.isDestroyed()) prompt.show()
      })
      .catch(() => { if (!prompt.isDestroyed()) prompt.close() })
  })
}
