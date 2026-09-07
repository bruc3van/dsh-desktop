import { escapeHtml } from './html.ts'
import { releaseNotesCss, renderReleaseNotes } from '../release-notes.ts'
import type { UpdateInfo, UpdateState } from '../updater.ts'

// Runs only in the app-owned prompt. Keep state as JSON data and write textContent
// so download errors can never introduce markup or script into the page.
export function updatePromptStateScript(state: UpdateState, chinese: boolean): string {
  return `(${paintUpdatePrompt.toString()})(${JSON.stringify(state)},${JSON.stringify(chinese)})`
}

function paintUpdatePrompt(state: UpdateState, chinese: boolean): void {
  const status = document.getElementById('update-status')
  const progress = document.getElementById('update-progress') as HTMLProgressElement | null
  const details = document.getElementById('update-progress-detail')
  const install = document.getElementById('update-install')
  const ignore = document.getElementById('update-ignore')
  const later = document.getElementById('update-later')
  if (status === null || progress === null || details === null || install === null || ignore === null || later === null) return
  const busy = ['downloading', 'installing', 'restartRequired'].includes(state.phase)
  const downloading = state.phase === 'downloading'
  const failed = state.error !== null
  document.querySelector('main')?.classList.toggle('updating', busy || failed)
  status.hidden = !busy && !failed
  status.textContent = failed ? (chinese ? '更新失败：' : 'Update failed: ') + state.error
    : downloading ? (chinese ? '正在下载新版本…' : 'Downloading the new version…')
      : state.phase === 'restartRequired' ? (chinese ? '即将退出并自动重启…' : 'The app will quit and restart…')
        : (chinese ? '正在验证并准备安装…' : 'Verifying and preparing the installer…')
  progress.hidden = !downloading
  details.hidden = !downloading
  if (downloading) {
    const p = state.progress
    const known = p !== null && p.total > 0
    if (known) progress.value = Math.max(0, Math.min(100, p.percent))
    else progress.removeAttribute('value')
    const bytes = (value: number) => (value / 1024 / 1024).toFixed(1) + ' MB'
    details.textContent = known
      ? Math.floor(progress.value) + '% · ' + bytes(p.downloaded) + ' / ' + bytes(p.total)
      : (chinese ? '已下载 ' : 'Downloaded ') + bytes(p?.downloaded ?? 0)
  }
  for (const button of [install, ignore]) {
    button.setAttribute('aria-disabled', String(busy))
    button.tabIndex = busy ? -1 : 0
    if (busy) button.removeAttribute('href')
    else button.setAttribute('href', button === install ? 'dsh-update-action:install' : 'dsh-update-action:ignore')
  }
  install.textContent = busy ? (chinese ? '更新中…' : 'Updating…')
    : failed ? (chinese ? '重试下载' : 'Retry download') : (chinese ? '下载并安装' : 'Download and install')
  later.textContent = busy
    ? (chinese ? '后台继续' : 'Continue in background') : (chinese ? '稍后' : 'Later')
}

export function renderUpdatePromptPageUrl(info: UpdateInfo, chinese: boolean, icon: string, copy: { found: string; later: string; ignore: string; install: string }, platform: NodeJS.Platform = process.platform): string {
  // The whole page travels as a data: URL, and Chromium caps how large such a
  // URL may be: an oversized changelog must not make the prompt fail to load
  // and close silently, with the user never learning an update exists. The
  // cap is far beyond any readable changelog.
  const notes = renderReleaseNotes((info.notes ?? '').slice(0, 32_000))
  const notesLabel = chinese ? '本次更新' : "What's new"
  const notesEmpty = chinese ? '此版本没有提供更新说明。' : 'No release notes were provided for this version.'
  const versionLabel = chinese ? '版本' : 'Version'
  const hint = platform === 'darwin'
    ? (chinese ? '下载验证完成后，应用将自动退出、替换并重新打开。这会中断本地正在运行的任务。' : 'After downloading and verification, the app will quit, update and reopen automatically. This interrupts running local tasks.')
    : chinese ? '下载完成后将打开安装程序。' : 'The installer will open when the download finishes.'
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.found) + '</title><style>'
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#fff;color:#0f1115;font-size:14px;line-height:1.6}'
    + 'main{min-height:100vh;padding:30px 32px 24px;display:flex;flex-direction:column}.intro{display:flex;align-items:flex-start;gap:14px}'
    + '.mark{width:40px;height:40px;flex:0 0 auto;border-radius:10px;box-shadow:0 8px 22px rgba(15,17,21,.12)}'
    + '.heading{min-width:0}h1{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}'
    + '.hint{margin:4px 0 0;color:#6e7480;font-size:13px;line-height:20px}'
    + '.version{display:flex;align-items:center;gap:9px;margin:24px 0 22px;padding:12px 14px;border:1px solid #ebeef2;border-radius:12px;background:#fafbfc}'
    + '.version-label{margin-right:auto;color:#6e7480;font-size:12px}.version-value{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}'
    + '.version-arrow{color:#9aa0a6}.version-value.new{padding:2px 8px;border-radius:999px;background:#ebeef2}'
    + '.notes-label{margin:0 0 8px;font-size:13px;font-weight:600}'
    + '.notes-empty{margin:0;color:#6e7480;font-size:13px}'
    + releaseNotesCss('.notes', { text: '#525862', strong: '#0f1115', border: '#d8d8d4', surface: '#ebeef2' })
    + '.notes{max-height:238px;margin:0;padding:0 10px 0 0;scrollbar-gutter:stable}'
    + 'main.updating{height:100vh}main.updating>*{flex-shrink:0}main.updating>.notes{flex-shrink:1;min-height:0}'
    + '.footer{margin-top:auto;padding-top:24px}.divider{border:0;border-top:1px solid #ebeef2;margin:0 -32px 18px}'
    + '.actions{display:flex;align-items:center;gap:8px}.spacer{flex:1}'
    + '.update-status{margin:0 0 8px;font-size:13px;overflow-wrap:anywhere;max-height:80px;overflow:auto}'
    + '#update-progress{width:100%;height:8px;accent-color:currentColor}#update-progress-detail{margin:4px 0 14px;font-size:12px;font-variant-numeric:tabular-nums}'
    + '.button[aria-disabled="true"]{opacity:.5;pointer-events:none}'
    + '.button{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;text-decoration:none;font:inherit;font-size:13px;line-height:20px;'
    + 'border:1px solid #d8d8d4;border-radius:28px;padding:7px 17px;color:#0f1115;background:transparent;outline:none;transition:background .15s ease,opacity .15s ease,box-shadow .15s ease}'
    + '.button:hover{background:#f5f6f7}.button:focus-visible{box-shadow:0 0 0 3px rgba(15,17,21,.14)}'
    + '.button.ghost{border-color:transparent;color:#6e7480;padding-left:10px;padding-right:10px}'
    + '.button.primary{background:#0f1115;border-color:#0f1115;color:#fff}.button.primary:hover{background:#0f1115;opacity:.88}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}.mark{box-shadow:0 8px 22px rgba(0,0,0,.32)}'
    + '.hint,.version-label,.notes-empty{color:#aeb3bb}.version{border-color:#2c2e33;background:#1e1f22}.version-arrow{color:#818791}.version-value.new{background:#2c2e33}'
    + releaseNotesCss('.notes', { text: '#aeb3bb', strong: '#f4f5f6', border: '#3a3d42', surface: '#232529' })
    + '.divider{border-color:#2c2e33}.button{border-color:#3a3d42;color:#f4f5f6}.button:hover{background:#232529}'
    + '.button:focus-visible{box-shadow:0 0 0 3px rgba(244,245,246,.18)}.button.ghost{border-color:transparent;color:#aeb3bb}'
    + '.button.primary{background:#f4f5f6;border-color:#f4f5f6;color:#17181a}.button.primary:hover{background:#f4f5f6}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
    + '</style></head><body><main><div class="intro">' + icon
    + '<div class="heading"><h1>' + escapeHtml(copy.found) + '</h1><p class="hint">' + escapeHtml(hint) + '</p></div></div>'
    + '<div class="version"><span class="version-label">' + escapeHtml(versionLabel) + '</span>'
    + '<span class="version-value">v' + escapeHtml(info.currentVersion) + '</span><span class="version-arrow" aria-hidden="true">→</span>'
    + '<span class="version-value new">v' + escapeHtml(info.availableVersion) + '</span></div>'
    + '<p class="notes-label">' + escapeHtml(notesLabel) + '</p>'
    + (notes === '' ? '<p class="notes-empty">' + escapeHtml(notesEmpty) + '</p>' : '<div class="notes">' + notes + '</div>')
    + '<div class="footer"><hr class="divider">'
    + '<p id="update-status" class="update-status" role="status" hidden></p>'
    + '<progress id="update-progress" max="100" aria-label="' + (chinese ? '下载进度' : 'Download progress') + '" hidden></progress>'
    + '<p id="update-progress-detail" hidden></p><div class="actions">'
    + '<a id="update-later" class="button ghost" href="dsh-update-action:later" target="_blank">' + escapeHtml(copy.later) + '</a><span class="spacer"></span>'
    + '<a id="update-ignore" class="button" href="dsh-update-action:ignore" target="_blank">' + escapeHtml(copy.ignore) + '</a>'
    + '<a id="update-install" class="button primary" href="dsh-update-action:install" target="_blank">' + escapeHtml(copy.install) + '</a>'
    + '</div></div></main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
