import { linuxDownloadInstructions } from '../linux-update-copy.ts'
import { escapeHtml } from './html.ts'
import { hostTokensCss } from './tokens.ts'
import { releaseNotesCss, renderReleaseNotes } from '../release-notes.ts'
import type { UpdateInfo, UpdateState } from '../updater.ts'

// Runs only in the app-owned prompt. Keep state as JSON data and write textContent
// so download errors can never introduce markup or script into the page.
export function updatePromptStateScript(state: UpdateState, chinese: boolean): string {
  return `(${paintUpdatePrompt.toString()})(${JSON.stringify(state)},${JSON.stringify(chinese)},${JSON.stringify(process.platform === 'linux')},${JSON.stringify(linuxDownloadInstructions(state.info?.fileName, chinese))})`
}

function paintUpdatePrompt(state: UpdateState, chinese: boolean, linux: boolean, downloadedInstructions: string): void {
  const status = document.getElementById('update-status')
  const progress = document.getElementById('update-progress') as HTMLProgressElement | null
  const details = document.getElementById('update-progress-detail')
  const install = document.getElementById('update-install')
  const ignore = document.getElementById('update-ignore')
  const later = document.getElementById('update-later')
  if (status === null || progress === null || details === null || install === null || ignore === null || later === null) return
  const busy = ['downloading', 'installing', 'restartRequired'].includes(state.phase)
  const downloading = state.phase === 'downloading'
  const downloaded = state.phase === 'downloaded'
  const failed = state.error !== null
  document.querySelector('main')?.classList.toggle('updating', busy || failed)
  status.hidden = !busy && !failed && !downloaded
  status.textContent = failed ? (chinese ? '更新失败：' : 'Update failed: ') + state.error
    : downloaded ? downloadedInstructions
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
    : downloaded ? (chinese ? '打开下载位置' : 'Show downloaded file')
    : failed ? (chinese ? '重试下载' : 'Retry download')
    : linux ? (chinese ? '下载新版本' : 'Download update') : (chinese ? '下载并安装' : 'Download and install')
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
    : platform === 'linux' ? (info.fileName?.toLowerCase().endsWith('.deb')
      ? (chinese ? '下载并校验 DEB 后，请退出客户端，用 sudo apt install ./文件名.deb 安装新版，再重新打开。下载不会中断任务。' : 'After downloading and verifying the DEB, quit, install it with sudo apt install ./filename.deb, then reopen. Downloading leaves tasks active.')
      : (chinese ? '下载并校验 AppImage 后，请退出客户端，手动替换原文件，再重新打开。下载不会中断正在运行的任务。' : 'After downloading and verifying the AppImage, quit, replace the original file manually, then reopen it. Downloading leaves running tasks active.'))
    : chinese ? '下载完成后将打开安装程序。' : 'The installer will open when the download finishes.'
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.found) + '</title><style>'
    + hostTokensCss()
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;font-size:14px;line-height:22px}'
    + 'main{min-height:100vh;padding:24px 24px 20px;display:flex;flex-direction:column}.intro{display:flex;align-items:flex-start;gap:14px}'
    + '.mark{width:40px;height:40px;flex:0 0 auto;border-radius:10px;box-shadow:var(--dsw-elevation-panel)}'
    + '.heading{min-width:0}h1{margin:0;font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.hint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}'
    + '.version{display:flex;align-items:center;gap:8px;margin:20px 0 20px;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}'
    + '.version-label{margin-right:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.version-value{font-size:13px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums}'
    + '.version-arrow{color:var(--dsw-alias-label-caption)}.version-value.new{padding:1px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:18px}'
    + '.notes-label{margin:0 0 8px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}'
    + '.notes-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}'
    + releaseNotesCss('.notes', {
      text: 'var(--dsw-alias-label-secondary)',
      strong: 'var(--dsw-alias-label-primary)',
      border: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-module-platform)',
    })
    + '.notes{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-height:238px;margin:0;padding:0 10px 0 0;scrollbar-gutter:stable}'
    + 'main.updating{height:100vh}main.updating>*{flex-shrink:0}main.updating>.notes{flex-shrink:1;min-height:0}'
    + '.footer{margin-top:auto;padding-top:20px}.divider{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:0 -24px 16px}'
    + '.actions{display:flex;align-items:center;gap:8px}.spacer{flex:1}'
    + '.update-status{margin:0 0 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;max-height:80px;overflow:auto}'
    + '#update-progress{width:100%;height:6px;accent-color:var(--dsw-alias-brand-primary)}#update-progress-detail{margin:4px 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}'
    + '.button[aria-disabled="true"]{opacity:.4;pointer-events:none}'
    + '.button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;white-space:nowrap;text-decoration:none;font:inherit;font-size:14px;line-height:22px;font-weight:400;'
    + 'border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:transparent;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out)}'
    + '@media(hover:hover){.button:hover{background:var(--dsw-alias-interactive-bg-hover)}}'
    + '.button:active{background:var(--dsw-alias-interactive-bg-active)}'
    + '.button.ghost{box-shadow:none;color:var(--dsw-alias-label-secondary);padding:0 10px}'
    + '@media(hover:hover){.button.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}'
    + '.button.primary{background:var(--dsw-alias-button-primary-fill);box-shadow:none;color:var(--dsw-alias-label-primary-foreground);font-weight:500}'
    + '@media(hover:hover){.button.primary:hover{background:var(--dsw-alias-button-primary-hover)}}'
    + '.button.primary:active{background:var(--dsw-alias-button-primary-hover);opacity:.9}'
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
