import { connection, update, type UpdateState } from './bridge.ts'
import { renderReleaseNotes } from '../release-notes.ts'
import { UPDATE_ID, RELEASES_PAGE_URL, EXTERNAL_LINK_SVG } from './constants.ts'
import { currentEnglish } from './language.ts'

function updateCopy(english: boolean): {
  title: string
  check: string
  checking: string
  install: string
  dismiss: string
  releases: string
  upToDate: string
  unsupported: string
  found: string
  preparing: string
  downloading: string
  installing: string
  restart: string
  failed: string
  failedNoReason: string
  cancelled: string
  unknown: string
  unavailable: string
  client: string
  bundled: string
  dshUnavailable: string
} {
  if (english) {
    return {
      title: 'App updates',
      check: 'Check for updates',
      checking: 'Checking…',
      install: 'Download and install',
      dismiss: 'Remind me later',
      releases: 'Open the releases page to download manually',
      upToDate: 'You are on the latest version',
      unsupported: 'A newer version exists, but this release ships no installer for this platform',
      found: 'New version available',
      preparing: 'Preparing the download…',
      downloading: 'Downloading',
      installing: 'Starting the installer…',
      restart: 'Install the new copy, then reopen the app',
      failed: 'Update failed: ',
      failedNoReason: 'Update failed — the reason is shown on the client itself',
      cancelled: 'Update cancelled',
      unknown: 'unknown error',
      unavailable: 'Update status unavailable',
      client: 'Desktop client v',
      bundled: 'bundled dsh',
      dshUnavailable: 'unavailable',
    }
  }
  return {
    title: '应用更新',
    check: '检查更新',
    checking: '检查中…',
    install: '下载并安装',
    dismiss: '稍后提醒',
    releases: '打开 GitHub 发布页手动下载',
    upToDate: '已是最新版本',
    unsupported: '已有更新版本，但该版本没有发布本平台的安装包',
    found: '发现新版本',
    preparing: '正在准备下载…',
    downloading: '下载中',
    installing: '正在启动安装程序…',
    restart: '请安装新版本后重新打开应用',
    failed: '更新失败：',
    failedNoReason: '更新失败，失败原因只在客户端本机显示',
    cancelled: '已取消更新',
    unknown: '未知错误',
    unavailable: '更新状态不可用',
    client: '桌面客户端 v',
    bundled: '内置 dsh',
    dshUnavailable: '不可用',
  }
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message === '' ? fallback : error.message
  const text = String(error)
  return text === '' ? fallback : text
}

/** MB, one decimal — the only unit an installer download ever needs. */
function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

/**
 * A message the card owns rather than the state: the refusals that never reach
 * a phase change (a denied bridge call, a rejected invoke) would otherwise
 * leave the button looking dead.
 */
function showUpdateMessage(text: string, isError: boolean): void {
  const statusEl = document.getElementById(UPDATE_ID)?.querySelector('#dsh-update-status') as HTMLElement | null
  if (statusEl === null || statusEl === undefined) return
  statusEl.hidden = false
  statusEl.textContent = text
  statusEl.classList.toggle('is-error', isError)
}

/** The notes source each notes box currently shows, keyed by the box itself. */
const paintedNotes = new WeakMap<HTMLElement, string>()

export function paintUpdateCard(state: UpdateState, english: boolean): void {
  const block = document.getElementById(UPDATE_ID)
  if (block === null) return
  const copy = updateCopy(english)
  const versionEl = block.querySelector('#dsh-update-version') as HTMLElement | null
  const statusEl = block.querySelector('#dsh-update-status') as HTMLElement | null
  const notesEl = block.querySelector('#dsh-update-notes') as HTMLElement | null
  const barEl = block.querySelector('#dsh-update-bar') as HTMLElement | null
  const barFillEl = block.querySelector('#dsh-update-bar span') as HTMLElement | null
  const checkEl = block.querySelector('#dsh-update-check') as HTMLButtonElement | null
  const installEl = block.querySelector('#dsh-update-install') as HTMLButtonElement | null
  const dismissEl = block.querySelector('#dsh-update-dismiss') as HTMLButtonElement | null
  if (versionEl === null || statusEl === null || notesEl === null || checkEl === null || installEl === null || dismissEl === null) return
  if (barEl === null || barFillEl === null) return

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  checkEl.disabled = busy
  checkEl.textContent = state.phase === 'checking' ? copy.checking : copy.check
  // A failed attempt keeps the offer on screen: the update is still there and
  // retrying is the obvious next move. Without this the state would say
  // "hide" while the click handler said "show", and they would fight.
  const showInstall = (state.phase === 'available' || state.phase === 'error') && state.info !== null && !busy
  installEl.hidden = !showInstall
  dismissEl.hidden = !showInstall || state.dismissed
  installEl.disabled = busy

  const dsh = block.dataset.dshVersion || copy.dshUnavailable
  versionEl.textContent = copy.client + state.currentVersion + ' · ' + copy.bundled + ' ' + dsh

  let line = ''
  if (state.phase === 'checking') line = copy.checking
  else if (state.phase === 'upToDate') line = copy.upToDate
  // Not an error and not up to date: the releases link beside this line is the
  // only way forward, so the line says why rather than reporting a failure.
  else if (state.phase === 'unsupportedPlatform') line = copy.unsupported
  else if (state.phase === 'available' && state.info !== null) line = copy.found + ' v' + state.info.availableVersion
  else if (state.phase === 'downloading') {
    // A download with no percentage still has to look alive, so the byte
    // counter carries it when the response arrives without a content-length.
    const progress = state.progress
    const percent = progress?.percent ?? 0
    const total = progress?.total ?? 0
    line = copy.downloading + (percent > 0 ? ' ' + String(percent) + '%' : '…')
    if (progress !== null && progress.downloaded > 0) {
      line += ' · ' + megabytes(progress.downloaded) + (total > 0 ? '/' + megabytes(total) : '') + ' MB'
    }
  } else if (state.phase === 'installing') line = copy.installing
  else if (state.phase === 'restartRequired') line = copy.restart
  // A refusal leaves the phase alone and publishes only a reason, so the
  // reason — not the phase — is what decides this line.
  const failed = state.phase === 'error' || state.error !== null
  // A remote page never receives the reason (it names local paths), so say
  // where the reason is rather than inventing one.
  if (failed) line = state.error === null ? copy.failedNoReason : copy.failed + state.error
  statusEl.textContent = line
  statusEl.hidden = line === ''
  statusEl.classList.toggle('is-error', failed)

  const downloading = state.phase === 'downloading'
  barEl.hidden = !downloading
  if (downloading) barFillEl.style.width = String(state.progress?.percent ?? 0) + '%'

  const notes = state.info?.notes ?? ''
  notesEl.hidden = notes === ''
  // Rebuilding the box resets its scroll position and drops any selection, and
  // a download repaints this card several times a second — so it is rebuilt
  // only when the source text actually moved.
  if (paintedNotes.get(notesEl) !== notes) {
    paintedNotes.set(notesEl, notes)
    notesEl.innerHTML = renderReleaseNotes(notes)
  }
}

/**
 * The labels the card owns rather than the state. The official language
 * setting can change while the card is on screen, and the card is only
 * rebuilt when its panel goes away — so these are retexted in place instead
 * of waiting for the next injection.
 */
function applyUpdateStaticCopy(block: HTMLElement, english: boolean): void {
  const copy = updateCopy(english)
  const setText = (selector: string, text: string): void => {
    const el = block.querySelector(selector)
    if (el !== null) el.textContent = text
  }
  setText('#dsh-update-title-text', copy.title)
  setText('#dsh-update-install', copy.install)
  setText('#dsh-update-dismiss', copy.dismiss)
  const link = block.querySelector('#dsh-update-releases')
  if (link !== null) {
    link.setAttribute('title', copy.releases)
    link.setAttribute('aria-label', copy.releases)
  }
  // The check button doubles as a progress label while a check runs, and that
  // wording belongs to paintUpdateCard — only the resting label is ours.
  const checkEl = block.querySelector('#dsh-update-check') as HTMLButtonElement | null
  if (checkEl !== null && !checkEl.disabled) checkEl.textContent = copy.check
}

/** Follow a mid-session language switch, without repainting on every probe. */
export function refreshUpdateLanguage(block: HTMLElement, english: boolean): void {
  const language = english ? 'en' : 'zh'
  if (block.dataset.dshLanguage === language) return
  block.dataset.dshLanguage = language
  applyUpdateStaticCopy(block, english)
  // The state-derived lines (version, status, notes) are painted from a state,
  // so the new language reaches them only by painting one now.
  void update.getStatus().then((state) => { paintUpdateCard(state, english) }).catch(() => {})
}

export function injectUpdate(panel: Element): void {
  if (panel.querySelector('#' + UPDATE_ID) !== null) return
  const english = currentEnglish()
  const copy = updateCopy(english)
  const block = document.createElement('div')
  block.id = UPDATE_ID
  block.dataset.dshLanguage = english ? 'en' : 'zh'
  block.innerHTML =
    '<div class="dsh-update-title"><span id="dsh-update-title-text">' + copy.title + '</span>'
    + '<div class="dsh-enhance-actions">'
    + '<a class="dsh-update-link" id="dsh-update-releases" href="' + RELEASES_PAGE_URL + '" target="_blank"'
    + ' rel="noreferrer" title="' + copy.releases + '" aria-label="' + copy.releases + '">' + EXTERNAL_LINK_SVG + '</a>'
    + '<button class="dsh-enhance-button dsh-enhance-switch" id="dsh-update-install" type="button" hidden>' + copy.install + '</button>'
    + '<button class="dsh-enhance-button" id="dsh-update-check" type="button">' + copy.check + '</button>'
    + '<button class="dsh-enhance-button" id="dsh-update-dismiss" type="button" hidden>' + copy.dismiss + '</button>'
    + '</div></div>'
    + '<p class="dsh-update-version" id="dsh-update-version"></p>'
    + '<p class="dsh-update-status" id="dsh-update-status" hidden></p>'
    + '<div class="dsh-update-bar" id="dsh-update-bar" hidden><span></span></div>'
    + '<div class="dsh-update-notes" id="dsh-update-notes" hidden></div>'
  // Every handler resolves the language when it runs, not when it was
  // attached: the card outlives a language switch made in this same dialog.
  block.querySelector('#dsh-update-check')?.addEventListener('click', () => {
    const live = updateCopy(currentEnglish())
    showUpdateMessage(live.checking, false)
    void update.check()
      .then(() => update.getStatus())
      .then((state) => { paintUpdateCard(state, currentEnglish()) })
      .catch((error: unknown) => { showUpdateMessage(live.failed + errorText(error, live.unknown), true) })
  })
  const installEl = block.querySelector('#dsh-update-install') as HTMLButtonElement | null
  installEl?.addEventListener('click', () => {
    // The install runs to completion inside one invoke, so the answer arrives
    // minutes later. Say something now, and treat every way it can come back
    // unstarted — a refusal in the result, a rejected call — as a message.
    // Visibility stays with the state; only the disabled flag is ours.
    installEl.disabled = true
    showUpdateMessage(updateCopy(currentEnglish()).preparing, false)
    void update.install()
      .then((result) => update.getStatus().then((state) => {
        const live = updateCopy(currentEnglish())
        paintUpdateCard(state, currentEnglish())
        if (result.started) return
        installEl.disabled = false
        // Declining the confirmation is an answer, not a failure.
        if (result.cancelled === true) showUpdateMessage(live.cancelled, false)
        else showUpdateMessage(live.failed + (result.error ?? live.unknown), true)
      }))
      .catch((error: unknown) => {
        const live = updateCopy(currentEnglish())
        installEl.disabled = false
        showUpdateMessage(live.failed + errorText(error, live.unknown), true)
      })
  })
  block.querySelector('#dsh-update-dismiss')?.addEventListener('click', () => {
    void update.dismiss().then(() => update.getStatus()).then((state) => { paintUpdateCard(state, currentEnglish()) }).catch(() => {})
  })
  panel.appendChild(block)
  void Promise.allSettled([update.getStatus(), connection.getStatus()]).then((results) => {
    const state = results[0].status === 'fulfilled' ? results[0].value : null
    const conn = results[1].status === 'fulfilled' ? results[1].value : null
    if (conn !== null) block.dataset.dshVersion = conn.dshVersion ?? ''
    if (state !== null) {
      paintUpdateCard(state, currentEnglish())
      return
    }
    const statusEl = block.querySelector('#dsh-update-status') as HTMLElement | null
    if (statusEl !== null) {
      statusEl.hidden = false
      statusEl.textContent = updateCopy(currentEnglish()).unavailable
    }
  })
}
