/**
 * In-app updater: check a GitHub Release feed, download the matching
 * installer, verify SHA-256, then hand off to the platform installer.
 *
 * This is the Electron counterpart of agent-skills-guard's Tauri updater.
 * electron-updater is not used: packages are unsigned, and the release
 * workflow already assembles GitHub Releases itself (it must not let
 * electron-builder infer a publish provider).
 * @module dsh-desktop/updater
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { shell } from 'electron'

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restartRequired'
  | 'upToDate'
  // A release newer than this one exists, but it ships no installer for this
  // platform (today: any Linux build, which is source-only). Distinct from
  // upToDate on purpose — telling that user they are current is a lie the
  // client would repeat at every check.
  | 'unsupportedPlatform'
  | 'error'

/** What a finished manual check has to tell the person who asked for it. */
export type ManualCheckAnswer = 'available' | 'upToDate' | 'unsupportedPlatform' | 'failed'

/**
 * Three surfaces render an update state — the injected card, the native
 * settings page, and the tray/menu dialog — but only the dialog turns the
 * phase into a decision rather than a line of text, and it is the one that
 * quietly answered "you are on the latest version" to a machine the release
 * had no installer for.
 *
 * An exhaustive switch on purpose: a phase added later does not compile until
 * an answer is chosen for it here, which a chain of `===` comparisons could
 * never enforce. The busy phases cannot be seen by a caller that already
 * answered them before checking, and idle/checking cannot outlive the check —
 * they map to the harmless answer rather than pretending to be unreachable.
 */
export function manualCheckAnswer(phase: UpdaterPhase): ManualCheckAnswer {
  switch (phase) {
    case 'available': return 'available'
    case 'unsupportedPlatform': return 'unsupportedPlatform'
    case 'error': return 'failed'
    case 'idle':
    case 'checking':
    case 'upToDate':
    case 'downloading':
    case 'installing':
    case 'restartRequired':
      return 'upToDate'
  }
}

export interface UpdateInfo {
  currentVersion: string
  availableVersion: string
  notes?: string
  pubDate?: string
  downloadUrl: string
  sha256?: string
  fileName: string
}

export interface UpdateProgress {
  total: number
  downloaded: number
  percent: number
}

export interface UpdateState {
  phase: UpdaterPhase
  currentVersion: string
  info: UpdateInfo | null
  progress: UpdateProgress | null
  error: string | null
  dismissed: boolean
  isChecking: boolean
}

export type CheckUpdateResult =
  | { hasUpdate: false }
  | { hasUpdate: true; info: UpdateInfo }

export interface UpdateFeedPlatform {
  url: string
  sha256?: string
}

export interface UpdateFeed {
  version: string
  notes?: string
  pubDate?: string
  platforms: Record<string, UpdateFeedPlatform>
}

export interface UpdaterPersistence {
  dismissedVersion?: string
  lastCheckedAt?: number
}

export interface DesktopUpdaterOptions {
  currentVersion: string
  feedUrl: string
  githubApiUrl?: string
  platform: NodeJS.Platform
  arch: string
  packaged: boolean
  downloadDir: string
  loadPersistence: () => UpdaterPersistence
  savePersistence: (next: UpdaterPersistence) => void
  /** When true, download+verify but do not spawn the installer or quit. */
  dryRun: boolean
  /**
   * Awaited immediately before the installer is launched, and never earlier.
   *
   * The local runtime has to be gone before the installer touches the process
   * tree: a Windows installer that kills the app by name does not match a
   * `node.exe` runtime child, which then keeps writing DSH_HOME while the
   * updated app starts a second harness beside it. But it has to stay alive
   * through the download and the SHA-256 check above — those take minutes and
   * routinely fail, and stopping it up front would leave a working app dead
   * with no update to show for it.
   */
  onBeforeInstall?: () => Promise<void>
  /**
   * The same gate as the shell's `devOverride`: false in a packaged build, so
   * no DSH_* variable in the ambient environment reaches this module. Defaults
   * to false — an updater constructed without an opinion is the strict one.
   */
  allowEnvOverrides?: boolean
  now?: () => number
  fetchImpl?: typeof fetch
}

const CHECK_TIMEOUT_MS = 30_000
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000
const PROGRESS_EMIT_MIN_INTERVAL_MS = 100
const SPAWN_TIMEOUT_MS = 15_000
/** An installer larger than this is not a plausible release asset. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
export const AUTO_CHECK_DELAY_MS = 4_000
export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * Read at construction rather than at import, because whether the environment
 * may be read at all is the caller's answer (`allowEnvOverrides`), not this
 * module's — and in a packaged build the answer is no.
 */
function envMs(name: string, fallback: number, allow: boolean): number {
  if (!allow) return fallback
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const DEFAULT_FEED_URL = 'https://github.com/bruc3van/dsh-desktop/releases/latest/download/latest.json'
const DEFAULT_GITHUB_API = 'https://api.github.com/repos/bruc3van/dsh-desktop/releases/latest'

/** Where a person goes when the in-app download cannot reach the assets host. */
export const RELEASES_PAGE_URL = 'https://github.com/bruc3van/dsh-desktop/releases'

const GITHUB_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/**
 * `allowOverride` is false in a packaged build: the update feed decides which
 * executable this client downloads and runs, so it must not be redirectable by
 * an environment variable any other process on the machine can set.
 */
export function defaultUpdateFeedUrl(allowOverride = true): string {
  if (!allowOverride) return DEFAULT_FEED_URL
  return process.env.DSH_DESKTOP_UPDATE_FEED?.trim() || DEFAULT_FEED_URL
}

export function defaultGithubApiUrl(allowOverride = true): string | undefined {
  if (!allowOverride) return DEFAULT_GITHUB_API
  const override = process.env.DSH_DESKTOP_UPDATE_GITHUB_API
  if (override !== undefined) {
    const trimmed = override.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return DEFAULT_GITHUB_API
}

/** Semver-ish compare: core numbers first, then prerelease (none > any). */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const length = Math.max(a.core.length, b.core.length)
  for (let i = 0; i < length; i++) {
    const av = a.core[i] ?? 0
    const bv = b.core[i] ?? 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  const leftPre = a.prerelease
  const rightPre = b.prerelease
  if (leftPre === undefined && rightPre !== undefined) return 1
  if (leftPre !== undefined && rightPre === undefined) return -1
  if (leftPre === rightPre) return 0
  return comparePrerelease(leftPre ?? '', rightPre ?? '')
}

/**
 * Semver prerelease ordering: dot-separated identifiers, numeric ones compared
 * as numbers. Plain string comparison puts rc.10 before rc.9 and would report
 * a newer prerelease as "already current".
 */
function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i]
    const bv = b[i]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    const aNumeric = /^\d+$/.test(av)
    const bNumeric = /^\d+$/.test(bv)
    if (aNumeric && bNumeric) {
      if (Number(av) !== Number(bv)) return Number(av) < Number(bv) ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

function parseVersion(input: string): { core: number[]; prerelease?: string } {
  const cleaned = input.trim().replace(/^v/i, '')
  const plus = cleaned.indexOf('+')
  const withoutBuild = plus === -1 ? cleaned : cleaned.slice(0, plus)
  const dash = withoutBuild.indexOf('-')
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const prerelease = dash === -1 ? undefined : withoutBuild.slice(dash + 1)
  const core = coreText.split('.').map((part) => {
    const n = Number(part)
    return Number.isFinite(n) ? n : 0
  })
  while (core.length < 3) core.push(0)
  return prerelease === undefined ? { core } : { core, prerelease }
}

/** Platform key used in latest.json and matching release asset names. */
export function platformKey(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'arm64') return 'win-arm64'
  if (platform === 'win32') return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'darwin') return 'mac-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'linux') return 'linux-x64'
  return undefined
}

/**
 * A transport failure reaches this process as a bare "fetch failed" — undici
 * puts the reason (DNS, TLS, a reset connection, a refused proxy) on `cause`,
 * one or more levels down. Reporting only the top line left a Windows user
 * whose check succeeded and whose download did not with a message nothing
 * could be done about, so the chain is flattened into the reason itself.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code
    const text = current.message === '' ? current.name : current.message
    const withCode = typeof code === 'string' && code !== '' && !text.includes(code)
      ? text + '（' + code + '）'
      : text
    if (!parts.includes(withCode)) parts.push(withCode)
    current = (current as { cause?: unknown }).cause
  }
  if (parts.length === 0) {
    const text = String(error)
    return text === '' ? '未知错误' : text
  }
  return parts.join(' ← ')
}

export function parseSha256Sums(text: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
    if (match === null) continue
    const hash = match[1]
    const name = match[2]
    if (hash === undefined || name === undefined) continue
    hashes.set(name.trim().replace(/^\.\//, ''), hash.toLowerCase())
  }
  return hashes
}

export function isAllowedDownloadUrl(target: string, feedUrl: string): boolean {
  let url: URL
  let feed: URL
  try {
    url = new URL(target)
    feed = new URL(feedUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.origin === feed.origin) return true
  if (url.protocol !== 'https:') return false
  return GITHUB_DOWNLOAD_HOSTS.has(url.hostname) || url.hostname.endsWith('.githubusercontent.com')
}

export function pickFeedPlatform(feed: UpdateFeed, key: string): UpdateFeedPlatform | undefined {
  return feed.platforms[key]
}

interface GithubReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  body?: unknown
  published_at?: unknown
  assets?: unknown
}

interface FeedWithSums extends UpdateFeed {
  sumsUrl?: string
}

export function parseUpdateFeed(raw: unknown): UpdateFeed {
  if (raw === null || typeof raw !== 'object') throw new Error('更新清单格式无效')
  const body = raw as {
    version?: unknown
    notes?: unknown
    pubDate?: unknown
    platforms?: unknown
  }
  if (typeof body.version !== 'string' || body.version.trim() === '') {
    throw new Error('更新清单缺少版本号')
  }
  if (body.platforms === null || typeof body.platforms !== 'object' || Array.isArray(body.platforms)) {
    throw new Error('更新清单缺少平台列表')
  }
  // A null-prototype map: a platform named `__proto__` must land as an
  // ordinary entry, not overwrite the record's prototype through the
  // plain-object assignment path.
  const platforms: Record<string, UpdateFeedPlatform> = Object.create(null) as Record<string, UpdateFeedPlatform>
  for (const [name, value] of Object.entries(body.platforms as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const platform = value as { url?: unknown; sha256?: unknown }
    if (typeof platform.url !== 'string' || platform.url.trim() === '') continue
    platforms[name] = {
      url: platform.url,
      // A hash that is not 64 hex digits is not a hash; carrying it would
      // fail every install, so it is dropped rather than trusted.
      ...typeof platform.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(platform.sha256)
        && { sha256: platform.sha256.toLowerCase() },
    }
  }
  return {
    version: body.version.trim().replace(/^v/i, ''),
    ...typeof body.notes === 'string' && { notes: body.notes },
    ...typeof body.pubDate === 'string' && { pubDate: body.pubDate },
    platforms,
  }
}

export class DesktopUpdater {
  private phase: UpdaterPhase = 'idle'
  private installerExit: { promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; resolve: (outcome: { code: number | null; signal: NodeJS.Signals | null }) => void } | undefined
  private info: UpdateInfo | null = null
  private progress: UpdateProgress | null = null
  private error: string | null = null
  private dismissed = false
  private checking = false
  private checkInFlight: Promise<CheckUpdateResult> | undefined
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly allowEnvOverrides: boolean
  private readonly downloadIdleTimeoutMs: number
  private readonly downloadTimeoutMs: number

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.allowEnvOverrides = options.allowEnvOverrides === true
    this.downloadIdleTimeoutMs = envMs(
      'DSH_DESKTOP_UPDATE_DOWNLOAD_IDLE_MS', DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS, this.allowEnvOverrides)
    this.downloadTimeoutMs = envMs(
      'DSH_DESKTOP_UPDATE_DOWNLOAD_MS', DEFAULT_DOWNLOAD_TIMEOUT_MS, this.allowEnvOverrides)
    this.syncDismissedFromStore()
  }

  /**
   * Resolves when a launched installer exits while this process is still
   * alive. A Windows installer that starts and then dies immediately is the
   * one failure a "spawn succeeded" handoff would otherwise miss; the caller
   * races this against its quit timer and restores the runtime on a quick
   * non-zero exit.
   */
  installerOutcome(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined {
    return this.installerExit?.promise
  }

  getState(): UpdateState {
    return {
      phase: this.phase,
      currentVersion: this.options.currentVersion,
      info: this.info,
      progress: this.progress,
      error: this.error,
      dismissed: this.dismissed,
      isChecking: this.checking,
    }
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  shouldAutoCheck(): boolean {
    // Behind the same gate as every other DSH_* read: a variable planted in the
    // packaged client's launch environment must not be able to switch the
    // update check off and pin the user to an old build forever.
    if (this.allowEnvOverrides && process.env.DSH_DESKTOP_SKIP_UPDATE_CHECK === '1') return false
    // A development run checks only when it was pointed at a test feed — and
    // "was it pointed at one" is the same question as the feed URL itself, so
    // it is asked through the same gate rather than around it.
    if (!this.options.packaged
      && (!this.allowEnvOverrides || process.env.DSH_DESKTOP_UPDATE_FEED === undefined)) return false
    const persisted = this.options.loadPersistence()
    const last = persisted.lastCheckedAt
    if (last !== undefined && this.now() - last < AUTO_CHECK_INTERVAL_MS) return false
    return true
  }

  async check(): Promise<CheckUpdateResult> {
    if (this.checkInFlight !== undefined) return this.checkInFlight
    if (
      this.phase === 'downloading'
      || this.phase === 'installing'
      || this.phase === 'restartRequired'
    ) {
      return this.info === null ? { hasUpdate: false } : { hasUpdate: true, info: this.info }
    }

    const run = this.performCheck()
    this.checkInFlight = run
    try {
      return await run
    } finally {
      if (this.checkInFlight === run) this.checkInFlight = undefined
    }
  }

  private async performCheck(): Promise<CheckUpdateResult> {
    this.checking = true
    this.error = null
    this.setPhase('checking')
    try {
      const feed = await this.loadFeed()
      const key = platformKey(this.options.platform, this.options.arch)
      const platform = key === undefined ? undefined : pickFeedPlatform(feed, key)
      // Two different answers used to share this branch. "Nothing newer
      // exists" is up to date; "something newer exists, but not for this
      // machine" is not — the release matrix builds macOS and Windows, so a
      // Linux (or any unlisted) build would otherwise be told it was current
      // by a feed that never had anything to offer it.
      if (compareVersions(feed.version, this.options.currentVersion) <= 0) {
        this.info = null
        this.dismissed = false
        this.setPhase('upToDate')
        this.markChecked()
        return { hasUpdate: false }
      }
      if (key === undefined || platform === undefined) {
        this.info = null
        this.dismissed = false
        this.setPhase('unsupportedPlatform')
        this.markChecked()
        return { hasUpdate: false }
      }

      const fileName = fileNameFromUrl(platform.url) ?? `dsh-desktop-${feed.version}-${key}`
      const info: UpdateInfo = {
        currentVersion: this.options.currentVersion,
        availableVersion: feed.version,
        downloadUrl: platform.url,
        fileName,
        ...feed.notes !== undefined && { notes: feed.notes },
        ...feed.pubDate !== undefined && { pubDate: feed.pubDate },
        ...platform.sha256 !== undefined && { sha256: platform.sha256 },
      }
      this.info = info
      const persisted = this.options.loadPersistence()
      this.dismissed = persisted.dismissedVersion === info.availableVersion
      this.setPhase('available')
      this.markChecked()
      return { hasUpdate: true, info }
    } catch (err) {
      this.error = describeFetchError(err)
      this.setPhase('error')
      return { hasUpdate: false }
    } finally {
      this.checking = false
      this.emit()
    }
  }

  dismiss(): void {
    if (this.info === null) return
    this.dismissed = true
    this.options.savePersistence({
      ...this.options.loadPersistence(),
      dismissedVersion: this.info.availableVersion,
    })
    this.emit()
  }

  resetDismiss(): void {
    this.dismissed = false
    const persisted = this.options.loadPersistence()
    if (persisted.dismissedVersion === undefined) {
      this.emit()
      return
    }
    this.options.savePersistence({ ...persisted, dismissedVersion: undefined })
    this.emit()
  }

  async install(): Promise<{ started: boolean; error?: string }> {
    const info = this.info
    // A refusal used to return a reason and leave the state untouched, so a
    // surface that paints from the state alone showed nothing at all and the
    // button looked dead. Only a refusal that contradicts an offer on screen
    // belongs in the state: with no offer (no info) and with a run already
    // going, the state is already saying the right thing, and the caller
    // still gets the reason in the result.
    if (info === null) return { started: false, error: '没有可安装的更新' }
    if (this.phase === 'downloading' || this.phase === 'installing' || this.phase === 'restartRequired') {
      return { started: false, error: '更新正在进行中' }
    }
    if (info.sha256 === undefined) {
      return this.refuseInstall('安装包缺少 SHA-256，已拒绝安装')
    }

    this.error = null
    this.progress = { total: 0, downloaded: 0, percent: 0 }
    this.setPhase('downloading')

    try {
      const destination = joinDownloadPath(this.options.downloadDir, info.fileName)
      await this.downloadToFile(info, destination)
      const actual = await sha256File(destination)
      if (actual !== info.sha256.toLowerCase()) {
        try { unlinkSync(destination) } catch { /* keep going to report the hash error */ }
        throw new Error('安装包校验失败（SHA-256 不匹配）')
      }
      // The download never carries an executable bit, and an AppImage is the
      // program itself: give it one before the desktop tries to launch it.
      if (destination.toLowerCase().endsWith('.appimage')) {
        try {
          chmodSync(destination, 0o755)
        } catch (error) {
          console.warn('[desktop] could not make the AppImage executable: ' + describeFetchError(error))
        }
      }

      if (this.options.dryRun) {
        this.progress = null
        this.setPhase('available')
        return { started: true }
      }

      this.setPhase('installing')
      await this.options.onBeforeInstall?.()
      if (this.options.platform === 'win32') {
        let resolveOutcome: (outcome: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
        this.installerExit = {
          promise: new Promise((resolve) => { resolveOutcome = resolve }),
          resolve: resolveOutcome,
        }
      }
      await launchInstaller(destination, this.options.platform, (code, signal) => {
        this.installerExit?.resolve({ code, signal })
      })
      if (this.options.platform === 'darwin') {
        this.setPhase('restartRequired')
        return { started: true }
      }
      return { started: true }
    } catch (err) {
      this.progress = null
      this.error = describeFetchError(err)
      this.setPhase('error')
      return { started: false, error: this.error }
    }
  }

  /**
   * Refuse an install and leave the reason in the state, for every surface.
   * The phase stays where it was: nothing about the offer changed, and moving
   * it to `error` would drop the tray's "update to vX" entry and hide the
   * install button that each surface would then have to un-hide by hand.
   */
  private refuseInstall(reason: string): { started: false; error: string } {
    this.progress = null
    this.error = reason
    this.emit()
    return { started: false, error: reason }
  }

  private markChecked(): void {
    this.options.savePersistence({
      ...this.options.loadPersistence(),
      lastCheckedAt: this.now(),
    })
  }

  private syncDismissedFromStore(): void {
    const persisted = this.options.loadPersistence()
    this.dismissed = persisted.dismissedVersion !== undefined
      && this.info !== null
      && persisted.dismissedVersion === this.info.availableVersion
  }

  private async loadFeed(): Promise<UpdateFeed> {
    try {
      return await this.fetchJsonFeed(this.options.feedUrl)
    } catch (primary) {
      const api = this.options.githubApiUrl
      if (api === undefined) throw primary
      try {
        return await this.fetchGithubApiFeed(api)
      } catch {
        throw primary
      }
    }
  }

  private async fetchJsonFeed(url: string): Promise<UpdateFeed> {
    const response = await this.fetchImpl(url, {
      headers: requestHeaders(this.options.currentVersion),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('检查更新失败（HTTP ' + String(response.status) + '）')
    return parseUpdateFeed(await response.json())
  }

  private async fetchGithubApiFeed(url: string): Promise<UpdateFeed> {
    const response = await this.fetchImpl(url, {
      headers: {
        ...requestHeaders(this.options.currentVersion),
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('检查更新失败（HTTP ' + String(response.status) + '）')
    const release = await response.json() as GithubRelease
    const key = platformKey(this.options.platform, this.options.arch)
    if (key === undefined) throw new Error('当前平台暂不支持在线更新')
    const feed = githubReleaseToFeed(release, key)
    if (feed === undefined) throw new Error('最新版本没有当前平台的安装包')
    const platform = feed.platforms[key]
    if (feed.sumsUrl !== undefined && platform !== undefined && platform.sha256 === undefined) {
      const sha256 = await this.fetchAssetSha256(feed.sumsUrl, fileNameFromUrl(platform.url) ?? '')
      if (sha256 !== undefined) platform.sha256 = sha256
    }
    return feed
  }

  private async fetchAssetSha256(sumsUrl: string, fileName: string): Promise<string | undefined> {
    if (fileName === '' || !isAllowedDownloadUrl(sumsUrl, this.options.feedUrl)) return undefined
    try {
      const response = await fetchValidated(
        this.fetchImpl,
        sumsUrl,
        { headers: requestHeaders(this.options.currentVersion), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
        (target) => isAllowedDownloadUrl(target, this.options.feedUrl),
      )
      if (!response.ok) return undefined
      return parseSha256Sums(await response.text()).get(fileName)
    } catch {
      return undefined
    }
  }

  private async downloadToFile(info: UpdateInfo, destination: string): Promise<void> {
    if (!isAllowedDownloadUrl(info.downloadUrl, this.options.feedUrl)) {
      throw new Error('拒绝从不信任的地址下载更新')
    }
    // The directory holds nothing but verified installers; keep it private so
    // a lax umask cannot leave another user a file they could swap before the
    // hash check runs against it. The chmod also tightens a directory an
    // earlier release created under a laxer umask (Windows no-ops it).
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    try { chmodSync(dirname(destination), 0o700) } catch { /* best effort */ }
    const controller = new AbortController()
    const overallTimer = setTimeout(() => { controller.abort() }, this.downloadTimeoutMs)
    let idleTimer = setTimeout(() => { controller.abort() }, this.downloadIdleTimeoutMs)
    const bumpIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { controller.abort() }, this.downloadIdleTimeoutMs)
    }
    let sizeExceeded = false
    try {
      const response = await fetchValidated(
        this.fetchImpl,
        info.downloadUrl,
        {
          headers: requestHeaders(this.options.currentVersion),
          signal: controller.signal,
        },
        (target) => isAllowedDownloadUrl(target, this.options.feedUrl),
      )
      if (!response.ok || response.body === null) {
        throw new Error('下载更新失败（HTTP ' + String(response.status) + '）')
      }
      const totalHeader = response.headers.get('content-length')
      const total = totalHeader === null ? 0 : Number(totalHeader)
      let downloaded = 0
      let lastEmittedPercent = -1
      let lastEmitAt = 0
      this.progress = { total: Number.isFinite(total) ? total : 0, downloaded: 0, percent: 0 }
      this.emit()

      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        bumpIdle()
        downloaded += chunk.length
        // A slow trickle is still bounded by the timeouts, but a fast host
        // pushing a huge body must be bounded by size as well.
        if (downloaded > MAX_DOWNLOAD_BYTES) {
          sizeExceeded = true
          controller.abort()
          return
        }
        const boundedTotal = this.progress?.total ?? 0
        const percent = boundedTotal > 0 ? Math.min(100, Math.round((downloaded / boundedTotal) * 100)) : 0
        this.progress = { total: boundedTotal, downloaded, percent }
        const now = this.now()
        if (percent !== lastEmittedPercent || now - lastEmitAt >= PROGRESS_EMIT_MIN_INTERVAL_MS) {
          lastEmittedPercent = percent
          lastEmitAt = now
          this.emit()
        }
      })
      await pipeline(body, createWriteStream(destination))
      if (this.progress !== null) {
        this.progress = {
          total: this.progress.total,
          downloaded: this.progress.downloaded,
          percent: 100,
        }
        this.emit()
      }
    } catch (err) {
      // A failed download must not leave a partial file behind: the same
      // version retries into the same name, and a residue here is a file the
      // user never asked for.
      try { unlinkSync(destination) } catch { /* nothing was written */ }
      if (sizeExceeded) throw new Error('下载更新失败：安装包超过大小上限')
      if (controller.signal.aborted) throw new Error('下载更新超时')
      // Everything this block throws itself already says 下载更新失败; anything
      // else is the transport or the disk, and arrives as a bare "fetch failed"
      // that reads like a dead button. Name it, and point at the page that
      // still works when the release-assets host does not.
      const message = err instanceof Error ? err.message : ''
      if (message.startsWith('下载更新失败')) throw err
      throw new Error('下载更新失败：' + describeFetchError(err) + '（可前往 GitHub Releases 手动下载）')
    } finally {
      clearTimeout(overallTimer)
      clearTimeout(idleTimer)
    }
  }

  private setPhase(phase: UpdaterPhase): void {
    this.phase = phase
    this.emit()
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

function githubReleaseToFeed(release: GithubRelease, key: string): FeedWithSums | undefined {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = tag.replace(/^v/i, '')
  if (version === '') return undefined
  const assets = Array.isArray(release.assets) ? release.assets : []
  const expectedExt = key.startsWith('win') ? 'exe' : key.startsWith('linux') ? 'AppImage' : 'dmg'
  const expectedName = `dsh-desktop-${version}-${key}.${expectedExt}`
  let downloadUrl: string | undefined
  let sumsUrl: string | undefined
  for (const item of assets) {
    if (item === null || typeof item !== 'object') continue
    const asset = item as GithubReleaseAsset
    if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue
    if (asset.name === expectedName) downloadUrl = asset.browser_download_url
    if (asset.name === 'SHA256SUMS.txt') sumsUrl = asset.browser_download_url
  }
  if (downloadUrl === undefined) return undefined
  const notes = typeof release.body === 'string' ? release.body : undefined
  const pubDate = typeof release.published_at === 'string' ? release.published_at : undefined
  return {
    version,
    ...notes !== undefined && { notes },
    ...pubDate !== undefined && { pubDate },
    platforms: { [key]: { url: downloadUrl } },
    ...sumsUrl !== undefined && { sumsUrl },
  }
}

/**
 * One fetch with every hop re-validated. `fetch` follows redirects by
 * itself, so a whitelist checked on the first URL alone would let a feed
 * point at an allowed host that 302s anywhere. The stacks differ in what a
 * redirect exposes, so the rule both honour is: follow, then re-apply the
 * allow-list to the FINAL url — the hop that actually serves the bytes.
 *
 * `redirect: 'manual'` is NOT usable here: Chromium's net.fetch (the
 * preferred transport, for its system proxy and trust store) throws "Redirect
 * was cancelled" on it, which would push every GitHub download onto the Node
 * fallback and silently give up the proxy support the wrapper exists for.
 * Where the stack reports the final url (Node's fetch does), it is checked;
 * where it does not (net.fetch returns an empty one), the pinned SHA-256 from
 * the feed remains the whole verification, as it always was.
 */
async function fetchValidated(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  allowUrl: (target: string) => boolean,
): Promise<Response> {
  if (!allowUrl(url)) throw new Error('拒绝从不信任的地址下载更新')
  const response = await fetchImpl(url, { ...init, redirect: 'follow' })
  if (response.url !== '' && !allowUrl(response.url)) {
    throw new Error('拒绝从不信任的地址下载更新')
  }
  return response
}

function requestHeaders(version: string): Record<string, string> {
  return {
    'user-agent': 'dsh-desktop/' + version + ' (+https://github.com/bruc3van/dsh-desktop)',
    accept: 'application/json,application/octet-stream;q=0.9,*/*;q=0.8',
  }
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

/**
 * Reserved DOS device names: on Windows these name a device rather than a file
 * in EVERY directory, with or without an extension, so `NUL.exe` opens the null
 * device instead of creating a file.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * A feed-supplied installer name reduced to a plain file name inside the
 * download directory. The name arrives from the update feed, so it decides
 * where the downloaded executable lands and must not be able to name anything
 * but `downloadDir/<name>`.
 *
 * Applied on every platform, not only Windows: a feed is written once and read
 * everywhere, so a name that Windows would redirect is worth neutralizing
 * wherever it is seen rather than only where it bites.
 */
export function safeDownloadFileName(fileName: string): string {
  // `:` travels with the separators: on Windows it both opens a drive-relative
  // path (`C:evil`) and names an NTFS alternate data stream (`setup.exe:x`),
  // either of which would put the bytes somewhere other than downloadDir/name.
  // Windows then silently drops trailing dots and spaces, so `setup.exe .`
  // would be written — and later verified — under two different names.
  const trimmed = fileName.replace(/[\\/:]/g, '_').replace(/[. ]+$/, '')
  // Separators are neutralized above; a bare `.`/`..` still names a directory
  // rather than a file, so reject it instead of writing outside downloadDir.
  if (trimmed === '') throw new Error('更新清单中的安装包文件名无效')
  // A device name is disarmed by prefixing rather than rejected: the download
  // is still a real installer, and the local file name is nobody's contract.
  // Win32 ignores trailing spaces and dots on the stem too, so `CON .exe`
  // still names the console device and is disarmed the same way.
  const stem = (trimmed.split('.')[0] ?? '').toUpperCase().replace(/[. ]+$/, '')
  return WINDOWS_DEVICE_NAMES.has(stem) ? '_' + trimmed : trimmed
}

function joinDownloadPath(dir: string, fileName: string): string {
  return join(dir, safeDownloadFileName(fileName))
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function launchInstaller(
  filePath: string,
  platform: NodeJS.Platform,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
): Promise<void> {
  if (platform === 'win32') {
    await spawnWindowsInstaller(filePath, onExit)
    return
  }
  const opened = await shell.openPath(filePath)
  if (opened !== '') throw new Error(opened)
}

/**
 * CreateProcess — which is what spawn() uses — fails outright when the target
 * asks for elevation or a security product holds the file, and the failure
 * arrives as an 'error' event on a child nobody listens to: an unhandled error
 * in the main process, and a button that looks dead. Wait for the spawn to
 * actually happen, and fall back to ShellExecute (shell.openPath), which can
 * raise the UAC prompt instead of failing on it.
 */
function spawnWindowsInstaller(
  filePath: string,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 'error' can fire after a successful spawn as well (a failed kill, for
    // one), and the fallback below launches a real installer — so the handler
    // stays attached, to keep late errors from going unhandled, but acts once.
    let settled = false
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore' })
    // Node answers a spawn with one event or the other, so this only exists so
    // that "no answer at all" cannot park the updater in `installing` forever
    // — where it refuses every later check and install.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('启动安装程序超时'))
    }, SPAWN_TIMEOUT_MS)
    timer.unref()
    child.once('spawn', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Resolving on spawn is the handoff; an exit still observed while this
      // process lives is the only trace a quick failure leaves behind.
      child.once('exit', (code, signal) => { onExit?.(code, signal) })
      child.unref()
      resolve()
    })
    child.on('error', (spawnError: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      shell.openPath(filePath).then(
        (opened) => {
          if (opened === '') {
            // ShellExecute handoff: no process handle exists to watch, so the
            // early-exit watch has nothing to observe. Report a clean handoff
            // so the caller quits promptly (as it did before the watch
            // existed) instead of lingering on its timer while the UAC prompt
            // is on screen.
            onExit?.(0, null)
            resolve()
          } else {
            reject(new Error(opened + '（' + spawnError.message + '）'))
          }
        },
        () => { reject(spawnError) },
      )
    })
  })
}
