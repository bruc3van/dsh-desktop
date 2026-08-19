/**
 * In-app updater check: the feed writer emits latest.json, and the packaged
 * shell can check / download / verify / dismiss against a local fixture feed.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'
import { artifactName, RELEASE_TARGETS, requiredPlatformKeys } from './release-artifacts.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const desktopVersion = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version
const work = await mkdtemp(join(tmpdir(), 'dsh-desktop-updater-'))
const artifacts = join(work, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const changelogFixture = join(work, 'CHANGELOG.md')
const releaseNotesFile = join(work, 'release-notes.md')
const releaseChangesFile = join(work, 'release-changes.md')
writeFileSync(changelogFixture, [
  '# Changes',
  '',
  '## [9.9.9]',
  '',
  '### 新增',
  '- fixture release change',
  '',
  '## [9.9.8]',
  '- old change that must not leak',
  '',
].join('\n'))
execFileSync(process.execPath, [
  join(APP_DIR, 'scripts', 'write-release-notes.mjs'),
  '--version', '9.9.9',
  '--changelog', changelogFixture,
  '--out', releaseNotesFile,
  '--changes-out', releaseChangesFile,
], { stdio: 'pipe' })
const releaseNotes = readFileSync(releaseNotesFile, 'utf8')
const releaseChanges = readFileSync(releaseChangesFile, 'utf8')
if (!releaseNotes.includes('fixture release change')
  || releaseNotes.includes('old change that must not leak')
  || !releaseNotes.includes('dsh-desktop-9.9.9-mac-arm64.dmg')
  || !releaseNotes.includes('dsh-desktop-9.9.9-mac-x64.dmg')
  || !releaseNotes.includes('dsh-desktop-9.9.9-win-x64.exe')) {
  throw new Error('generated GitHub Release notes are incomplete')
}
if (releaseChanges !== '### 新增\n- fixture release change\n') {
  throw new Error('in-app changes must contain only the selected CHANGELOG section: ' + JSON.stringify(releaseChanges))
}
console.log('✓ write-release-notes.mjs selects one version and explains every installer')

// One fixture artifact per release target, built from the same table the feed
// requires, so adding a matrix leg updates this fixture instead of silently
// leaving it behind. Bytes differ per target so a swapped hash is visible.
const fixtureBytes = new Map(RELEASE_TARGETS.map(target =>
  [target.key, Buffer.from('fake-installer-' + target.key)]))
const fixtureName = target => artifactName('9.9.9', target)
for (const target of RELEASE_TARGETS) {
  writeFileSync(join(artifacts, fixtureName(target)), fixtureBytes.get(target.key))
}
writeFileSync(
  join(artifacts, 'SHA256SUMS.txt'),
  RELEASE_TARGETS
    .map(target => createHash('sha256').update(fixtureBytes.get(target.key)).digest('hex')
      + '  ' + fixtureName(target) + '\n')
    .join(''),
)

const feedPath = join(artifacts, 'latest.json')
const notesFile = join(work, 'notes.md')
writeFileSync(notesFile, 'release body notes\n')
execFileSync(process.execPath, [
  join(APP_DIR, 'scripts', 'write-update-feed.mjs'),
  '--dir', artifacts,
  '--version', '9.9.9',
  '--repo', 'bruc3van/dsh-desktop',
  '--notes-file', notesFile,
  '--out', feedPath,
], { stdio: 'pipe' })

const written = JSON.parse(readFileSync(feedPath, 'utf8'))
if (written.version !== '9.9.9') throw new Error('feed version: ' + written.version)
if (written.notes !== 'release body notes\n') throw new Error('notes-file not copied: ' + JSON.stringify(written.notes))
for (const target of RELEASE_TARGETS) {
  const entry = written.platforms[target.key]
  const expectedHash = createHash('sha256').update(fixtureBytes.get(target.key)).digest('hex')
  if (entry?.sha256 !== expectedHash) {
    throw new Error(target.key + ' sha256 mismatch in generated feed: ' + JSON.stringify(entry?.sha256))
  }
  const expectedUrl = 'https://github.com/bruc3van/dsh-desktop/releases/download/v9.9.9/' + fixtureName(target)
  if (entry?.url !== expectedUrl) throw new Error(target.key + ' url: ' + JSON.stringify(entry?.url))
}
console.log('✓ write-update-feed.mjs emits latest.json for ' + requiredPlatformKeys().join(', '))

// The failure this guards is silent by construction: the updater reads a
// missing platform key as "up to date", so an incomplete feed strands one
// platform's users with no error anywhere. Drop each artifact in turn and
// require the generator to refuse rather than publish a partial feed.
for (const target of RELEASE_TARGETS) {
  const partial = join(work, 'partial-' + target.key)
  mkdirSync(partial, { recursive: true })
  for (const other of RELEASE_TARGETS) {
    if (other.key === target.key) continue
    writeFileSync(join(partial, fixtureName(other)), fixtureBytes.get(other.key))
  }
  let refused = false
  try {
    execFileSync(process.execPath, [
      join(APP_DIR, 'scripts', 'write-update-feed.mjs'),
      '--dir', partial,
      '--version', '9.9.9',
      '--out', join(partial, 'latest.json'),
    ], { stdio: 'pipe' })
  } catch (error) {
    refused = String(error.stderr ?? '').includes(target.key)
  }
  if (!refused) throw new Error('a feed missing ' + target.key + ' was written instead of refused')
}
console.log('✓ write-update-feed.mjs refuses a feed that would strand a platform')
console.log('✓ write-update-feed.mjs copies release notes from --notes-file')

// Version ordering decides whether an offered build counts as newer, and the
// app-level checks below can only exercise it against this package's own
// release version. Bundle the module against an electron stub so the ordering
// rules themselves — including prerelease ranks — are asserted directly.
const electronStub = join(work, 'electron-stub.mjs')
writeFileSync(electronStub, 'export const shell = { openPath: async () => "" }\n')
const updaterBundle = join(work, 'updater.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'updater.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: electronStub },
  outfile: updaterBundle,
  logLevel: 'silent',
})
const { compareVersions, describeFetchError, manualCheckAnswer, safeDownloadFileName, DesktopUpdater } =
  await import(pathToFileURL(updaterBundle).href)
const orderings = [
  // Numeric prerelease identifiers rank by value: the string comparison this
  // replaced put rc.10 BELOW rc.9 and reported a newer build as current.
  ['0.1.5-rc.10', '0.1.5-rc.9', 1],
  ['0.1.5-rc.9', '0.1.5-rc.10', -1],
  ['0.1.5-rc.2', '0.1.5-rc.2', 0],
  // A release outranks any prerelease of the same core version.
  ['0.1.5', '0.1.5-rc.10', 1],
  ['0.1.5-rc.10', '0.1.5', -1],
  // Numeric identifiers rank below alphanumeric ones; a shorter prefix loses.
  ['1.0.0-alpha.beta', '1.0.0-alpha.1', 1],
  ['1.0.0-alpha', '1.0.0-alpha.1', -1],
  // Core numbers still win over everything else.
  ['0.2.0', '0.1.9', 1],
  ['0.1.5', '0.1.5', 0],
]
for (const [left, right, expected] of orderings) {
  const actual = compareVersions(left, right)
  if (Math.sign(actual) !== expected) {
    throw new Error('compareVersions(' + left + ', ' + right + ') = ' + actual + ', expected ' + expected)
  }
}
console.log('✓ compareVersions orders core, release-over-prerelease, and numeric prerelease ranks')

// The release matrix builds macOS and Windows. `platformKey` still answers for
// Linux, so a source-built Linux client asks a feed that has nothing for it —
// and used to be told it was up to date, which is the one answer that is both
// wrong and unactionable. The three cases below are the whole rule: a platform
// the feed does not carry, the same feed on a platform it does, and a feed
// that is simply not newer (up to date whatever the platform).
const matrixFeed = {
  version: '99.0.0',
  platforms: {
    'mac-arm64': { url: 'https://example.invalid/dsh-desktop-99.0.0-mac-arm64.dmg' },
    'win-x64': { url: 'https://example.invalid/dsh-desktop-99.0.0-win-x64.exe' },
  },
}
const feedOnlyUpdater = (platform, arch, feed = matrixFeed, currentVersion = '0.0.1') => new DesktopUpdater({
  fetchImpl: () => Promise.resolve(new Response(JSON.stringify(feed), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })),
  currentVersion,
  feedUrl: 'https://example.invalid/latest.json',
  platform,
  arch,
  packaged: true,
  downloadDir: work,
  loadPersistence: () => ({}),
  savePersistence: () => {},
  dryRun: true,
})
const unbuiltPlatform = feedOnlyUpdater('linux', 'x64')
const unbuiltResult = await unbuiltPlatform.check()
if (unbuiltResult.hasUpdate || unbuiltPlatform.getState().phase !== 'unsupportedPlatform') {
  throw new Error('a platform the feed does not carry must not read as up to date: '
    + JSON.stringify({ unbuiltResult, phase: unbuiltPlatform.getState().phase }))
}
const builtPlatform = feedOnlyUpdater('darwin', 'arm64')
const builtResult = await builtPlatform.check()
if (!builtResult.hasUpdate || builtPlatform.getState().phase !== 'available') {
  throw new Error('the same feed must still offer the update where it is built: '
    + JSON.stringify({ builtResult, phase: builtPlatform.getState().phase }))
}
const notNewer = feedOnlyUpdater('linux', 'x64', matrixFeed, '99.0.0')
const notNewerResult = await notNewer.check()
if (notNewerResult.hasUpdate || notNewer.getState().phase !== 'upToDate') {
  throw new Error('a feed that is not newer is up to date on any platform: '
    + JSON.stringify({ notNewerResult, phase: notNewer.getState().phase }))
}
console.log('✓ a platform with no installer in the feed is reported as such, not as up to date')

// The dialog behind "Check for Updates…" is the only surface that turns a
// phase into a decision, and it is where `unsupportedPlatform` first went
// wrong: every phase that was not an error read as "you are on the latest
// version". The compiler now refuses a phase this function does not answer,
// and the table below pins WHICH answer, so the next phase cannot be waved
// through by folding it into the harmless one.
const dialogAnswers = {
  available: 'available',
  unsupportedPlatform: 'unsupportedPlatform',
  error: 'failed',
  upToDate: 'upToDate',
  idle: 'upToDate',
  checking: 'upToDate',
  downloading: 'upToDate',
  installing: 'upToDate',
  restartRequired: 'upToDate',
}
for (const [phase, expected] of Object.entries(dialogAnswers)) {
  const actual = manualCheckAnswer(phase)
  if (actual !== expected) {
    throw new Error('manualCheckAnswer(' + phase + ') = ' + String(actual) + ', expected ' + expected)
  }
}
// A phase nobody listed above would be tested by nothing, so the union itself
// decides what this table has to cover.
const updaterSource = readFileSync(join(APP_DIR, 'src', 'main', 'updater.ts'), 'utf8')
const unionBody = updaterSource.slice(
  updaterSource.indexOf('export type UpdaterPhase'),
  updaterSource.indexOf('export type ManualCheckAnswer'),
)
const declaredPhases = [...unionBody.matchAll(/^\s*\|\s*'([A-Za-z]+)'/gm)].map(match => match[1])
if (declaredPhases.length < 8) throw new Error('could not read UpdaterPhase: ' + JSON.stringify(declaredPhases))
const untested = declaredPhases.filter(phase => !(phase in dialogAnswers))
const stale = Object.keys(dialogAnswers).filter(phase => !declaredPhases.includes(phase))
if (untested.length > 0 || stale.length > 0) {
  throw new Error('the manual-check answer table and UpdaterPhase disagree: '
    + JSON.stringify({ untested, stale }))
}
console.log('✓ the manual-check dialog answers every updater phase, and names them apart')

// A transport failure arrives as a bare "fetch failed"; the reason a person can
// act on sits on `cause`, which is what a Windows download failure reported.
const dnsFailure = new TypeError('fetch failed')
dnsFailure.cause = Object.assign(new Error('getaddrinfo ENOTFOUND objects.githubusercontent.com'), { code: 'ENOTFOUND' })
const described = describeFetchError(dnsFailure)
if (!described.includes('fetch failed') || !described.includes('ENOTFOUND objects.githubusercontent.com')) {
  throw new Error('describeFetchError dropped the cause: ' + JSON.stringify(described))
}
if (describeFetchError(new Error('下载更新超时')) !== '下载更新超时') {
  throw new Error('describeFetchError rewrote a plain message')
}
console.log('✓ a failed fetch reports the cause behind "fetch failed"')

// The installer's file name comes from the feed, so it decides where the
// downloaded executable lands. Every spelling below is a way a name could name
// something other than one plain file inside the download directory.
const fileNames = [
  ['dsh-desktop-1.2.3-win-x64.exe', 'dsh-desktop-1.2.3-win-x64.exe'],
  ['../../evil.exe', '.._.._evil.exe'],
  ['sub\\dir\\evil.exe', 'sub_dir_evil.exe'],
  // A drive-relative path and an NTFS alternate data stream: both write
  // somewhere other than downloadDir/<name> once win32.join is done with them.
  ['C:evil.exe', 'C_evil.exe'],
  ['setup.exe:stream', 'setup.exe_stream'],
  // Windows drops trailing dots and spaces when opening a file, so the name
  // written and the name verified would otherwise differ.
  ['setup.exe.', 'setup.exe'],
  ['setup.exe ', 'setup.exe'],
  // A device name opens a device from any directory, extension or not.
  ['NUL.exe', '_NUL.exe'],
  ['com1', '_com1'],
  // Not a device: only the exact reserved stems are.
  ['console.exe', 'console.exe'],
  // A name that is nothing but a separator still becomes a plain file name.
  ['/', '_'],
]
for (const [input, expected] of fileNames) {
  const actual = safeDownloadFileName(input)
  if (actual !== expected) {
    throw new Error('safeDownloadFileName(' + JSON.stringify(input) + ') = '
      + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  }
}
for (const rejected of ['', '.', '..', '...', '   ']) {
  let threw = false
  try { safeDownloadFileName(rejected) } catch { threw = true }
  if (!threw) throw new Error('safeDownloadFileName accepted ' + JSON.stringify(rejected))
}
console.log('✓ a feed-supplied installer name cannot name anything but a file in the download directory')

// Release notes reach three surfaces: two HTML cards and one native dialog.
const notesBundle = join(work, 'release-notes.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'release-notes.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: notesBundle,
  logLevel: 'silent',
})
const { renderReleaseNotes, renderReleaseNotesText } = await import(pathToFileURL(notesBundle).href)
const notesSource = [
  '### 改进',
  '- 第一条 `code`',
  '- [文档](https://example.com/a_(b)) 与 **重点**',
  '',
  '**粗体里也可能有 *斜体* 夹着**',
  '',
  '| 设备 | 文件 |',
  '|---|---|',
  '| Mac | a.dmg |',
  '| 竖线 \\| 转义 | b.exe |',
  '',
  '紧随其后的段落里也可能出现 a|b 这种竖线',
  '',
  '<img src=x onerror=alert(1)>',
].join('\n')
const notesHtml = renderReleaseNotes(notesSource)
const htmlExpectations = [
  ['<h5>改进</h5>', true],
  ['<code>code</code>', true],
  ['<a href="https://example.com/a_(b)" target="_blank" rel="noreferrer noopener">文档</a>', true],
  ['<strong>重点</strong>', true],
  // The table ends at the blank line; the prose after it is its own paragraph.
  ['<tr><td>Mac</td><td>a.dmg</td></tr>', true],
  // An escaped pipe belongs to the cell, not to the column boundary.
  ['<tr><td>竖线 | 转义</td><td>b.exe</td></tr>', true],
  // Bold keeps the single markers inside it instead of losing the pair.
  ['<strong>粗体里也可能有 <em>斜体</em> 夹着</strong>', true],
  ['<p>紧随其后的段落里也可能出现 a|b 这种竖线</p>', true],
  // Nothing from the feed may reach the DOM as markup.
  ['<img', false],
  ['&lt;img src=x onerror=alert(1)&gt;', true],
]
for (const [fragment, expected] of htmlExpectations) {
  if (notesHtml.includes(fragment) !== expected) {
    throw new Error('release notes HTML: expected ' + (expected ? '' : 'no ') + fragment + ' in ' + notesHtml)
  }
}
const notesText = renderReleaseNotesText(notesSource)
if (!notesText.includes('• 第一条 code') || notesText.includes('###') || notesText.includes('**')
  || !notesText.includes('文档 与 重点')) {
  throw new Error('release notes text kept its markers: ' + JSON.stringify(notesText))
}
console.log('✓ release notes render to escaped HTML for the cards and to plain text for the dialog')

const payload = Buffer.from('desktop-update-payload')
const payloadHash = createHash('sha256').update(payload).digest('hex')
const currentKey = process.platform === 'win32'
  ? (process.arch === 'arm64' ? 'win-arm64' : 'win-x64')
  : process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
    : process.platform === 'linux'
      ? (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64')
      : undefined
if (currentKey === undefined) {
  throw new Error('check:updater does not cover ' + process.platform + '/' + process.arch)
}

// Every server this check binds is registered here and closed at the end.
// A listening handle keeps Node's event loop alive on its own, so a server
// that is merely dropped out of scope does not fail anything — it leaves the
// process running after the last assertion has passed. In CI that reads as a
// step that never finishes (the release job sat until its 45-minute timeout);
// locally it leaves a stray node holding ports for as long as the shell lives.
const servers = []
const listenOn = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('fixture server did not bind')
  return address
}

// A redirected download is re-checked against the host allow-list on the
// transport that reports the final url (Node's fetch does; Chromium's
// net.fetch does not, and there the pinned SHA-256 is the whole check).
// Same-origin hops pass; a hop that lands off the allow-list is refused.
const redirectAllowlistHome = join(work, 'redirect-allowlist')
const redirectTarget = await (async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(payload)
  })
  const address = await listenOn(server)
  return 'http://127.0.0.1:' + String(address.port) + '/payload'
})()
const redirectAllowlistUpdater = async (startPath, targetUrl) => {
  const server = createServer((req, res) => {
    if (req.url === '/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      const feed = { version: '99.0.5', platforms: { [currentKey]: { url: '', sha256: payloadHash } } }
      feed.platforms[currentKey].url = startPath.startsWith('http') ? startPath : baseOriginFor(startPath)
      res.end(JSON.stringify(feed))
      return
    }
    if (req.url === startPath) {
      res.writeHead(302, { location: targetUrl })
      res.end()
      return
    }
    if (req.url === '/payload') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
      return
    }
    res.writeHead(404)
    res.end()
  })
  const address = await listenOn(server)
  const base = 'http://127.0.0.1:' + String(address.port)
  const baseOriginFor = (path) => base + path
  const updater = new DesktopUpdater({
    fetchImpl: (input, init) => fetch(input, init),
    currentVersion: desktopVersion,
    feedUrl: base + '/feed.json',
    platform: process.platform,
    arch: process.arch,
    packaged: true,
    downloadDir: redirectAllowlistHome,
    loadPersistence: () => ({}),
    savePersistence: () => {},
    dryRun: true,
  })
  const checked = await updater.check()
  if (!checked.hasUpdate) throw new Error('redirect allow-list feed should offer an update: ' + JSON.stringify(checked))
  return updater
}

const sameOriginUpdater = await redirectAllowlistUpdater('/start', '/payload')
const sameOriginInstall = await sameOriginUpdater.install()
if (!sameOriginInstall.started) {
  throw new Error('same-origin redirected install should succeed: ' + JSON.stringify(sameOriginInstall))
}
const offListUpdater = await redirectAllowlistUpdater('/start-off', redirectTarget)
const offListInstall = await offListUpdater.install()
if (offListInstall.started || !String(offListInstall.error ?? '').includes('拒绝')) {
  throw new Error('a redirect off the allow-list must be refused: ' + JSON.stringify(offListInstall))
}
console.log('✓ a same-origin redirect downloads, and a redirect off the allow-list is refused')

const availableFeed = {
  version: '99.0.0',
  // Release notes are Markdown; the card must render them, not print them.
  notes: '### fixture changelog\n- 第一条\n- 第二条\n\n`dsh` 已内置。',
  pubDate: '2026-08-14T00:00:00.000Z',
  platforms: {
    [currentKey]: { url: '', sha256: payloadHash },
  },
}
const currentFeed = {
  version: desktopVersion,
  platforms: {
    [currentKey]: { url: '', sha256: payloadHash },
  },
}
const badFeed = {
  version: '99.0.1',
  platforms: {
    [currentKey]: { url: '', sha256: '0'.repeat(64) },
  },
}
const noHashFeed = {
  version: '99.0.2',
  platforms: {
    [currentKey]: { url: '' },
  },
}
const hangFeed = {
  version: '99.0.3',
  platforms: {
    [currentKey]: { url: '', sha256: payloadHash },
  },
}
const redirectFeed = {
  version: '99.0.4',
  platforms: {
    [currentKey]: { url: '', sha256: payloadHash },
  },
}

let feedMode = 'available'
let pageDelayMs = 0
const fixture = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/latest.json') {
    const feed = feedMode === 'current'
    ? currentFeed
    : feedMode === 'bad'
      ? badFeed
      : feedMode === 'nohash'
        ? noHashFeed
        : feedMode === 'hang' ? hangFeed
        : feedMode === 'redirect' ? redirectFeed : availableFeed
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(feed))
    return
  }
  if (url.pathname === '/payload') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
    res.end(payload)
    return
  }
  // A real GitHub release asset is served behind a 302; the download must
  // follow it on the Chromium transport without falling back to Node fetch.
  if (url.pathname === '/redirect-payload') {
    res.writeHead(302, { location: '/payload' })
    res.end()
    return
  }
  if (url.pathname === '/hang') {
    return
  }
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    return
  }
  const sendPage = () => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Updater Fixture</title>'
      + '<meta name="color-scheme" content="light dark"><style>'
      + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;'
      + '--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#6e7480;--dsw-alias-label-tertiary:#8a9099;'
      + '--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-module-platform:#ebeef2;--dsw-alias-border-l2:#d8d8d4;--dsw-alias-interactive-bg-hover:#f5f6f7}'
      + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:#f3f4f6;color:#0f1115;font-size:14px}'
      + '.fixtureDialog{width:min(780px,calc(100vw - 64px));height:min(620px,calc(100vh - 64px));min-height:520px;display:flex;flex-direction:column;'
      + 'overflow:hidden;border:1px solid #e4e5e7;border-radius:16px;background:#fff;box-shadow:0 24px 64px rgba(15,17,21,.16)}'
      + '.fixtureHeader{height:58px;flex:0 0 auto;display:flex;align-items:center;padding:0 22px;border-bottom:1px solid #ebeef2}'
      + '.fixtureHeader h1{margin:0;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.01em}'
      + '.fixtureHeader span{margin-left:auto;color:#9aa0a6;font-size:12px}.content{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:0;flex:1}'
      + '.navList{display:flex;flex-direction:column;gap:4px;padding:16px 12px;border-right:1px solid #ebeef2;background:#fafbfc}'
      + '.navList button{width:100%;height:38px;display:flex;align-items:center;gap:10px;padding:0 12px;border:0;border-radius:8px;background:transparent;'
      + 'font:inherit;font-size:13px;color:#6e7480;text-align:left;cursor:pointer}.navList button:hover{background:#f1f2f4;color:#0f1115}'
      + '.navList button.active{background:#ebeef2;color:#0f1115;font-weight:500}.navList svg{width:17px;height:17px;flex:0 0 auto}'
      + '.options{min-width:0;overflow:auto;background:#fff}.officialPanel{padding:24px}.officialPanel h2{margin:0 0 6px;font-size:14px;font-weight:500}'
      + '.officialPanel p{margin:0;color:#6e7480;font-size:13px;line-height:20px}'
      + '@media(prefers-color-scheme:dark){:root{--dsw-alias-label-primary:#f4f5f6;--dsw-alias-label-secondary:#aeb3bb;'
      + '--dsw-alias-label-tertiary:#818791;--dsw-alias-bg-layer-1:#17181a;--dsw-alias-bg-module-platform:#2c2e33;'
      + '--dsw-alias-border-l2:#3a3d42;--dsw-alias-interactive-bg-hover:#232529}'
      + 'body{background:#101113;color:#f4f5f6}.fixtureDialog,.options{background:#17181a;border-color:#2c2e33}'
      + '.fixtureHeader{border-color:#2c2e33}.navList{background:#1b1c1f;border-color:#2c2e33}.navList button{color:#aeb3bb}'
      + '.navList button:hover{background:#232529;color:#f4f5f6}.navList button.active{background:#2c2e33;color:#f4f5f6}.officialPanel p{color:#aeb3bb}}'
      + '</style></head><body><div class="fixtureDialog" role="dialog" aria-label="设置">'
      + '<div class="fixtureHeader"><h1>设置</h1><span>DeepSeek Harness Desktop</span></div>'
      + '<div class="content"><div class="navList">'
      + '<button class="active" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.14.38.36.72.66 1 .3.28.68.42 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"></path></svg>'
      + '<span>通用设置</span></button></div><div class="options">'
      + '<div class="officialPanel"><h2>通用设置</h2><p>测试环境中的官方设置占位内容。</p></div>'
      + '</div></div></div></body></html>')
  }
  if (pageDelayMs > 0) setTimeout(sendPage, pageDelayMs)
  else sendPage()
})
const address = await listenOn(fixture)
const origin = 'http://127.0.0.1:' + String(address.port)
availableFeed.platforms[currentKey].url = origin + '/payload'
currentFeed.platforms[currentKey].url = origin + '/payload'
badFeed.platforms[currentKey].url = origin + '/payload'
noHashFeed.platforms[currentKey].url = origin + '/payload'
hangFeed.platforms[currentKey].url = origin + '/hang'
redirectFeed.platforms[currentKey].url = origin + '/redirect-payload'

const launchApp = async (home, extraEnv = {}, options = {}) => {
  // `extraEnv` is applied after the strip, so a caller's knob still lands —
  // but an ambient one does not. That matters most for the prompt run below,
  // which deliberately leaves DSH_DESKTOP_SKIP_UPDATE_PROMPT unset: inherited
  // from the shell it would have failed the check for the wrong reason.
  const electronEnv = sanitizedElectronEnv(extraEnv)
  electronEnv.DSH_HOME = join(home, 'dsh')
  electronEnv.DSH_DESKTOP_HOME = join(home, 'desktop')
  electronEnv.DSH_DESKTOP_SKIP_PROBE = '1'
  electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
  electronEnv.DSH_DESKTOP_UPDATE_FEED = origin + '/latest.json'
  electronEnv.DSH_DESKTOP_UPDATE_GITHUB_API = ''
  if (!options.showUpdatePrompt) {
    electronEnv.DSH_DESKTOP_SKIP_UPDATE_CHECK = '1'
    electronEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'
  }
  electronEnv.DSH_DESKTOP_UPDATE_DRY_RUN = '1'
  mkdirSync(join(home, 'desktop'), { recursive: true })
  writeFileSync(join(home, 'desktop', 'settings.json'), JSON.stringify({ serverUrl: origin }, null, 2) + '\n')
  const launched = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(home, 'chromium')],
    env: electronEnv,
  })
  const window = await launched.firstWindow()
  await window.waitForFunction(() => document.title === 'Updater Fixture', null, { timeout: 15_000 })
  return { app: launched, window }
}

const openDesktopSettings = async (window) => {
  const tab = window.locator('#dsh-desktop-tab')
  await tab.waitFor({ state: 'visible', timeout: 3_000 })
  await tab.click()
  await window.locator('#dsh-desktop-panel').waitFor({ state: 'visible', timeout: 3_000 })
}

try {
  const availableHome = join(work, 'available')
  const available = await launchApp(availableHome)
  await openDesktopSettings(available.window)
  await available.window.locator('#dsh-desktop-update').waitFor({ state: 'visible', timeout: 3_000 })
  if (process.env.DSH_DESKTOP_FIXTURE_SCREENSHOT !== undefined) {
    await available.window.screenshot({ path: process.env.DSH_DESKTOP_FIXTURE_SCREENSHOT })
  }
  const before = await available.window.evaluate(() => window.desktop.update.getStatus())
  if (before.currentVersion !== desktopVersion) {
    throw new Error('status currentVersion: ' + JSON.stringify(before))
  }
  const checked = await available.window.evaluate(() => window.desktop.update.check())
  if (!checked.hasUpdate || checked.info.availableVersion !== '99.0.0' || !checked.info.notes.includes('第一条')) {
    throw new Error('check did not report fixture update: ' + JSON.stringify(checked))
  }
  // The card repaints from the push channel, so the notes appear without any
  // further call — as rendered Markdown, not as its source.
  await available.window.locator('#dsh-update-notes h5').waitFor({ state: 'visible', timeout: 3_000 })
  const notes = await available.window.evaluate(() => {
    const el = document.getElementById('dsh-update-notes')
    return { items: el.querySelectorAll('li').length, code: el.querySelectorAll('code').length, text: el.textContent }
  })
  if (notes.items !== 2 || notes.code !== 1 || notes.text.includes('###')) {
    throw new Error('release notes were not rendered as Markdown: ' + JSON.stringify(notes))
  }
  // The way out when the in-app download cannot reach the assets host: the
  // link must be on the card itself, and must leave for the system browser.
  const releasesLink = await available.window.evaluate(() => {
    const el = document.getElementById('dsh-update-releases')
    return el === null ? null : { href: el.getAttribute('href'), target: el.getAttribute('target') }
  })
  if (releasesLink?.href !== 'https://github.com/bruc3van/dsh-desktop/releases' || releasesLink.target !== '_blank') {
    throw new Error('manual-download link missing from the update card: ' + JSON.stringify(releasesLink))
  }
  const installed = await available.window.evaluate(() => window.desktop.update.install())
  if (!installed.started) throw new Error('dry-run install failed: ' + JSON.stringify(installed))
  await available.window.evaluate(() => window.desktop.update.dismiss())
  const dismissed = JSON.parse(readFileSync(join(availableHome, 'desktop', 'settings.json'), 'utf8'))
  if (dismissed.updateDismissedVersion !== '99.0.0') {
    throw new Error('dismiss was not persisted: ' + JSON.stringify(dismissed))
  }
  await available.app.close()
  console.log('✓ official settings card exposes the updater')
  console.log('✓ check reports an available version from latest.json')
  console.log('✓ dry-run download verifies SHA-256')
  console.log('✓ dismissed version is persisted')

  // GitHub release assets sit behind a 302. The download must follow it on the
  // Chromium transport (net.fetch) itself — a manual-redirect request throws
  // there and would silently push every real download onto the Node fallback,
  // losing the proxy/trust-store support the wrapper exists for.
  feedMode = 'redirect'
  const redirectHome = join(work, 'redirect')
  const redirected = await launchApp(redirectHome)
  const redirectLog = []
  redirected.app.process().stdout?.on('data', (chunk) => { redirectLog.push(chunk.toString()) })
  const redirectCheck = await redirected.window.evaluate(() => window.desktop.update.check())
  if (!redirectCheck.hasUpdate || redirectCheck.info?.availableVersion !== '99.0.4') {
    throw new Error('redirect feed should offer an update: ' + JSON.stringify(redirectCheck))
  }
  const redirectInstalled = await redirected.window.evaluate(() => window.desktop.update.install())
  if (!redirectInstalled.started) throw new Error('redirected dry-run install failed: ' + JSON.stringify(redirectInstalled))
  await redirected.app.close()
  if (redirectLog.join('').includes('update transport fell back to node fetch')) {
    throw new Error('the redirected download fell back to Node fetch: net.fetch must follow the redirect itself')
  }
  console.log('✓ a 302 download completes on the Chromium transport without the Node-fetch fallback')
  feedMode = 'available'

  // The post-page-load prompt is a bounded app surface, not a native message box
  // that expands a long changelog into an unreadable wall of text. Hold the
  // Web UI response past AUTO_CHECK_DELAY_MS: a process-start timer would fire
  // too early and this test would miss its already-open window.
  const promptHome = join(work, 'prompt')
  pageDelayMs = 6_000
  const prompted = await launchApp(promptHome, {}, { showUpdatePrompt: true })
  const prompt = await prompted.app.waitForEvent('window', { timeout: 8_000 })
  pageDelayMs = 0
  await prompt.locator('#update-install').waitFor({ state: 'visible', timeout: 3_000 })
  const promptLayout = await prompt.evaluate(() => {
    const notes = document.querySelector('.notes')
    const install = document.getElementById('update-install')
    return {
      title: document.title,
      notesMaxHeight: notes === null ? null : getComputedStyle(notes).maxHeight,
      installText: install?.textContent,
      version: document.querySelector('.version')?.textContent,
      windowHeight: innerHeight,
      actionBottomGap: Math.round(innerHeight - (document.querySelector('.actions')?.getBoundingClientRect().bottom ?? 0)),
    }
  })
  if (promptLayout.notesMaxHeight !== '238px'
    || !promptLayout.installText?.trim()
    || !promptLayout.version?.includes(desktopVersion)
    || !promptLayout.version.includes('99.0.0')
    || promptLayout.windowHeight >= 540
    || promptLayout.actionBottomGap < 20
    || promptLayout.actionBottomGap > 32) {
    throw new Error('update prompt layout/copy mismatch: ' + JSON.stringify(promptLayout))
  }
  const promptClosed = prompt.waitForEvent('close', { timeout: 3_000 })
  // The click deliberately destroys its own page; Playwright can observe the
  // teardown before its click promise settles, so closure is the assertion.
  await prompt.locator('#update-later').click({ noWaitAfter: true }).catch(() => {})
  await promptClosed
  await prompted.app.close()
  console.log('✓ update check waits for the Web UI, then shows a bounded prompt with clear actions')

  feedMode = 'current'
  const currentHome = join(work, 'current')
  const current = await launchApp(currentHome)
  const upToDate = await current.window.evaluate(() => window.desktop.update.check())
  if (upToDate.hasUpdate) throw new Error('same version should be up to date: ' + JSON.stringify(upToDate))
  const currentState = await current.window.evaluate(() => window.desktop.update.getStatus())
  if (currentState.phase !== 'upToDate') throw new Error('expected upToDate, got ' + JSON.stringify(currentState))
  await current.app.close()
  console.log('✓ same-version feed is treated as up to date')

  feedMode = 'bad'
  const badHome = join(work, 'bad')
  const bad = await launchApp(badHome)
  const badCheck = await bad.window.evaluate(() => window.desktop.update.check())
  if (!badCheck.hasUpdate) throw new Error('bad-hash feed should still be available: ' + JSON.stringify(badCheck))
  const badInstall = await bad.window.evaluate(() => window.desktop.update.install())
  if (badInstall.started || !String(badInstall.error ?? '').includes('SHA-256')) {
    throw new Error('expected SHA-256 failure: ' + JSON.stringify(badInstall))
  }
  await bad.app.close()
  console.log('✓ install refuses a payload whose SHA-256 does not match')

  feedMode = 'nohash'
  const noHashHome = join(work, 'nohash')
  const noHash = await launchApp(noHashHome)
  await openDesktopSettings(noHash.window)
  const noHashCheck = await noHash.window.evaluate(() => window.desktop.update.check())
  if (!noHashCheck.hasUpdate) throw new Error('no-hash feed should still be available: ' + JSON.stringify(noHashCheck))
  // A refusal that never reaches the person is the same as a dead button:
  // clicking must leave the reason on the card.
  await noHash.window.locator('#dsh-update-install').waitFor({ state: 'visible', timeout: 3_000 })
  await noHash.window.locator('#dsh-update-install').click()
  await noHash.window.waitForFunction(() => {
    const el = document.getElementById('dsh-update-status')
    return el !== null && !el.hidden && el.textContent.includes('SHA-256')
  }, null, { timeout: 5_000 })
  const noHashInstall = await noHash.window.evaluate(() => window.desktop.update.install())
  if (noHashInstall.started || !String(noHashInstall.error ?? '').includes('SHA-256')) {
    throw new Error('expected missing SHA-256 refusal: ' + JSON.stringify(noHashInstall))
  }
  // A refusal must not retract the offer: the tray reads this same phase, and
  // the button has to stay clickable for a retry.
  const afterRefusal = await noHash.window.evaluate(() => window.desktop.update.getStatus())
  const buttonShown = await noHash.window.locator('#dsh-update-install').isVisible()
  if (afterRefusal.phase !== 'available' || !buttonShown) {
    throw new Error('refusal changed the offer: ' + JSON.stringify({ phase: afterRefusal.phase, buttonShown }))
  }
  await noHash.app.close()
  console.log('✓ install refuses a payload that has no SHA-256, and says so on the card')

  feedMode = 'hang'
  const hangHome = join(work, 'hang')
  const hang = await launchApp(hangHome, { DSH_DESKTOP_UPDATE_DOWNLOAD_IDLE_MS: '400' })
  const hangCheck = await hang.window.evaluate(() => window.desktop.update.check())
  if (!hangCheck.hasUpdate) throw new Error('hang feed should still be available: ' + JSON.stringify(hangCheck))
  const hangInstall = await hang.window.evaluate(() => window.desktop.update.install())
  if (hangInstall.started || !String(hangInstall.error ?? '').includes('超时')) {
    throw new Error('expected download timeout: ' + JSON.stringify(hangInstall))
  }
  await hang.app.close()
  console.log('✓ a stalled download times out and unlocks the updater')
} finally {
  // closeAllConnections() before close(): the `/hang` route answers nothing by
  // design, so close() alone would wait on a connection that never completes.
  // rmSync retries because Chromium can release its profile files a moment
  // after the last app.close() returns.
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  })))
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
