import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type MessageBoxOptions } from 'electron'
import { hostTokensCss } from './pages/tokens.ts'

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] ?? char)

export function pluginRecoveryPage(options: MessageBoxOptions, plugins: string[], chinese: boolean, confirmation = false): string {
  const label = chinese ? `涉及插件（${plugins.length}）` : `Affected plugins (${plugins.length})`
  return '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}body{margin:0;font-size:13px;line-height:20px}'
    + 'main{height:100vh;padding:24px;display:flex;flex-direction:column;gap:16px;overflow:hidden}'
    + '.content{flex:0 1 auto;min-height:0;max-height:45%;overflow:auto;scrollbar-gutter:stable}h1{margin:0 0 12px;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + 'p{margin:0;white-space:pre-wrap;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}'
    + '.plugins{min-height:0;flex:1;display:flex;flex-direction:column}.label{flex-shrink:0;margin:0 0 8px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + 'ul{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;margin:0;padding:8px 12px 8px 28px;background:var(--dsw-alias-settings-card-fill);border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg)}'
    + 'li{padding:4px 0;overflow-wrap:anywhere}footer{flex-shrink:0;margin-top:auto;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}'
    + 'a{display:flex;align-items:center;justify-content:center;min-width:0;min-height:36px;overflow-wrap:anywhere;text-align:center;text-decoration:none;font:inherit;font-size:13px;line-height:20px;font-weight:400;padding:7px 14px;border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:transparent;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){a:hover{background:var(--dsw-alias-interactive-bg-hover)}}'
    + 'a:active{background:var(--dsw-alias-interactive-bg-active)}'
    + 'a.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);box-shadow:none;font-weight:500}'
    + '@media(hover:hover){a.primary:hover{background:var(--dsw-alias-button-primary-hover)}}'
    + 'a.primary:active{background:var(--dsw-alias-button-primary-hover);opacity:.9}'
    + (confirmation ? 'main{padding:24px;gap:20px}.content{max-height:none;flex:1}h1{font-size:16px;line-height:24px;font-weight:500;margin-bottom:8px}footer{display:flex;justify-content:flex-end}footer a{min-width:88px}.eyebrow{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}' : '')
    + '</style></head><body><main><div class="content">' + (confirmation ? '<div class="eyebrow">DSH Desktop Pro · ' + (chinese ? '操作确认' : 'Confirmation') + '</div>' : '') + '<h1>' + escapeHtml(options.message) + '</h1><p>' + escapeHtml(options.detail ?? '') + '</p></div>'
    + (plugins.length ? '<section class="plugins" aria-label="' + escapeHtml(label) + '"><div class="label">' + escapeHtml(label) + '</div><ul tabindex="0">' + plugins.map(name => '<li>' + escapeHtml(name) + '</li>').join('') + '</ul></section>' : '')
    + '<footer>' + (options.buttons ?? []).map((label, index) => '<a role="button" href="dsh-plugin-recovery:' + index + '"' + (index === (confirmation ? 1 : options.defaultId) ? ' class="primary"' : '') + (index === options.defaultId ? ' id="default-action"' : '') + '>' + escapeHtml(label) + '</a>').join('')
    + '</footer></main></body></html>'
}

/** A bounded modal keeps the complete plugin list separate from the actions. */
export function showPluginRecoveryDialog(owner: BrowserWindow | null, options: MessageBoxOptions, plugins: string[], chinese: boolean, appearance: Pick<BrowserWindowConstructorOptions, 'icon' | 'backgroundColor'> = {}): Promise<number> {
  return showClientDialog(owner, options, plugins, chinese, appearance, false)
}

/** Main-process-owned confirmation: no preload or requesting-page access. */
export function showConfirmationDialog(owner: BrowserWindow | null, options: MessageBoxOptions, chinese: boolean, appearance: Pick<BrowserWindowConstructorOptions, 'icon' | 'backgroundColor'> = {}): Promise<number> {
  return showClientDialog(owner, options, [], chinese, appearance, true)
}

function showClientDialog(owner: BrowserWindow | null, options: MessageBoxOptions, plugins: string[], chinese: boolean, appearance: Pick<BrowserWindowConstructorOptions, 'icon' | 'backgroundColor'>, confirmation: boolean): Promise<number> {
  return new Promise(resolve => {
    const parent = owner !== null && !owner.isDestroyed() ? owner : undefined
    const area = (parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()).workAreaSize
    const prompt = new BrowserWindow({
      ...appearance,
      width: Math.min(560, area.width),
      height: Math.min(confirmation ? 320 : 600, area.height),
      minWidth: Math.min(320, area.width), minHeight: Math.min(confirmation ? 280 : 420, area.height),
      title: options.title ?? 'DSH Desktop Pro',
      parent, modal: parent !== undefined, show: false,
      resizable: true, minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    prompt.setMenu(null)
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
    void prompt.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pluginRecoveryPage(options, plugins, chinese, confirmation)))
      .then(async () => {
        if (prompt.isDestroyed()) return
        await prompt.webContents.executeJavaScript('document.getElementById("default-action")?.focus()')
        if (!prompt.isDestroyed()) prompt.show()
      })
      .catch(() => { if (!prompt.isDestroyed()) prompt.close() })
  })
}
