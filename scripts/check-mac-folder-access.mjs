/**
 * Unit check for `src/main/mac-folder-access.ts`: the hint that points the
 * user at System Settings after macOS refused a workspace folder.
 *
 * What must hold: only workspaces inside privacy-protected locations are
 * probed; only EPERM counts as a refusal; each location is raised once per
 * run; "Don't remind me again" persists through client settings; nothing is
 * asked while the client does not manage the runtime or off macOS; and a
 * workspace store this client does not recognise yields no hint at all.
 * Platform-independent: the probe and the dialog are injected. Bundled
 * through esbuild so this check does not depend on the host Node's
 * TypeScript stripping.
 * @module desktop/scripts/check-mac-folder-access
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-mac-folder-access-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

async function bundle(name) {
  const outfile = join(outDir, name + '.mjs')
  await esbuild.build({
    entryPoints: [join(APP_DIR, 'src', 'main', name + '.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const {
  FILES_AND_FOLDERS_SETTINGS_URL,
  protectedFolderOf,
  readWorkspacePaths,
  probeFolderAccess,
  findDeniedFolders,
  folderAccessMessage,
  createMacFolderAccessController,
} = await bundle('mac-folder-access')
const { createClientSettingsStore } = await bundle('client-settings')

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}
const equal = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) + (JSON.stringify(actual) === JSON.stringify(expected) ? '' : ' ≠ ' + JSON.stringify(expected)))
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

const HOME = '/Users/someone'

console.log('\n# protected locations')
equal('Documents itself', protectedFolderOf(HOME + '/Documents', HOME), 'documents')
equal('a project in Documents', protectedFolderOf(HOME + '/Documents/code/app', HOME), 'documents')
equal('a lookalike sibling is not Documents', protectedFolderOf(HOME + '/Documents2/app', HOME), undefined)
equal('Desktop', protectedFolderOf(HOME + '/Desktop/app', HOME), 'desktop')
equal('Downloads', protectedFolderOf(HOME + '/Downloads/app', HOME), 'downloads')
equal('an external volume', protectedFolderOf('/Volumes/USB/app', HOME), 'volumes')
equal('a plain home project is not protected', protectedFolderOf(HOME + '/code/app', HOME), undefined)
check('the settings link opens Files & Folders',
  FILES_AND_FOLDERS_SETTINGS_URL === 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders')

console.log('\n# workspace store')
const dshHome = join(outDir, 'dsh-home')
mkdirSync(join(dshHome, 'storages'), { recursive: true })
const writeStore = (workspaces, unit = { name: 'workspace', version: 2 }) => writeFileSync(
  join(dshHome, 'storages', 'workspace.json'),
  JSON.stringify({
    unit,
    global: { initialized: true, workspaceIds: Object.keys(workspaces) },
    tables: { workspaces: Object.fromEntries(Object.entries(workspaces).map(([id, path]) => [id, { path, title: id, sessionIds: [] }])) },
  }),
)
equal('a missing store yields nothing', readWorkspacePaths(join(outDir, 'nowhere')), [])
writeStore({ a: HOME + '/Documents/app', b: 'relative/path' })
equal('paths are read and relative ones dropped', readWorkspacePaths(dshHome), [HOME + '/Documents/app'])
writeStore({ a: HOME + '/Documents/app' }, { name: 'workspace', version: 3 })
equal('an unknown store version yields nothing', readWorkspacePaths(dshHome), [])
writeFileSync(join(dshHome, 'storages', 'workspace.json'), '{not json')
equal('a torn store yields nothing', readWorkspacePaths(dshHome), [])

console.log('\n# probing')
const plain = join(outDir, 'readable')
mkdirSync(plain)
equal('a readable folder is allowed', await probeFolderAccess(plain), 'allowed')
equal('a missing folder is unknown, not denied', await probeFolderAccess(join(outDir, 'missing')), 'unknown')
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const locked = join(outDir, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o000)
  equal('POSIX EACCES is unknown, not a privacy refusal', await probeFolderAccess(locked), 'unknown')
  chmodSync(locked, 0o700)
}

const scripted = results => {
  const probed = []
  return { probed, probe: async path => { probed.push(path); return results[path] ?? 'unknown' } }
}
{
  const { probed, probe } = scripted({ [HOME + '/Documents/a']: 'allowed', [HOME + '/Desktop/b']: 'denied' })
  const denied = await findDeniedFolders(
    [HOME + '/code/x', HOME + '/Documents/a', HOME + '/Documents/c', HOME + '/Desktop/b', HOME + '/Desktop/d'],
    HOME, new Set(), probe)
  equal('only the refused location is reported', denied, [{ folder: 'desktop', workspace: HOME + '/Desktop/b' }])
  equal('unprotected workspaces are never probed and each location stops at its first answer',
    probed, [HOME + '/Documents/a', HOME + '/Desktop/b'])
}
{
  const { probed, probe } = scripted({ [HOME + '/Documents/b']: 'denied' })
  const denied = await findDeniedFolders([HOME + '/Documents/a', HOME + '/Documents/b'], HOME, new Set(), probe)
  equal('an inconclusive probe moves on to the next workspace', denied, [{ folder: 'documents', workspace: HOME + '/Documents/b' }])
  equal('both were probed', probed.length, 2)
}
{
  const { probed, probe } = scripted({ [HOME + '/Documents/a']: 'denied' })
  equal('a skipped location is not probed',
    await findDeniedFolders([HOME + '/Documents/a'], HOME, new Set(['documents']), probe), [])
  equal('nothing was probed', probed, [])
}

console.log('\n# message')
const zh = folderAccessMessage([{ folder: 'documents', workspace: HOME + '/Documents/app' }], true)
check('Chinese copy names the folder', zh.message === '系统阻止了 DSH Desktop 访问「文稿」', zh.message)
check('Chinese copy names the workspace and the settings path',
  zh.detail.includes('「app」') && zh.detail.includes('系统设置 → 隐私与安全性 → 文件和文件夹'))
equal('Chinese buttons', [zh.buttons, zh.checkboxLabel], [['打开系统设置', '稍后'], '不再提醒'])
const en = folderAccessMessage([
  { folder: 'documents', workspace: HOME + '/Documents/app' },
  { folder: 'volumes', workspace: '/Volumes/USB/site' },
], false)
check('English copy lists every location', en.message === 'macOS is blocking DSH Desktop from Documents, removable or network volumes', en.message)

console.log('\n# controller')
function harness(overrides = {}) {
  const asked = []
  const opened = []
  let dismissed = []
  let manages = true
  let answer = { response: 1, checkboxChecked: false }
  const controller = createMacFolderAccessController({
    platform: 'darwin',
    home: HOME,
    dshHome: () => dshHome,
    managesRuntime: () => manages,
    chinese: () => true,
    dismissed: () => dismissed,
    dismiss: folders => { dismissed = [...dismissed, ...folders] },
    ask: async copy => { asked.push(copy); return answer },
    openSettings: () => { opened.push(true) },
    debounceMs: 30,
    ...overrides,
  })
  return {
    controller, asked, opened,
    get dismissed() { return dismissed },
    setManages(value) { manages = value },
    setAnswer(value) { answer = value },
  }
}
const denyDocumentsAndDownloads = async path =>
  path.startsWith(HOME + '/Documents/') || path.startsWith(HOME + '/Downloads/') ? 'denied' : 'allowed'

writeStore({ a: HOME + '/Documents/app' })
{
  const h = harness({ probe: denyDocumentsAndDownloads })
  h.setAnswer({ response: 0, checkboxChecked: false })
  await h.controller.check()
  equal('a refusal is raised once', h.asked.length, 1)
  equal('Open System Settings opens it', h.opened.length, 1)
  await h.controller.check()
  equal('the same location is not raised twice in one run', h.asked.length, 1)
  equal('Later without the checkbox persists nothing', h.dismissed, [])
}
{
  const h = harness({ probe: denyDocumentsAndDownloads })
  h.setAnswer({ response: 1, checkboxChecked: true })
  await h.controller.check()
  equal('the checkbox dismisses the location durably', h.dismissed, ['documents'])
  equal('Later does not open System Settings', h.opened.length, 0)
}
{
  const h = harness({ probe: denyDocumentsAndDownloads })
  h.setManages(false)
  await h.controller.onWebUiLoaded()
  await h.controller.check()
  equal('nothing is asked for a runtime this client does not manage', h.asked.length, 0)
}
{
  const h = harness({ probe: denyDocumentsAndDownloads, platform: 'linux' })
  await h.controller.onWebUiLoaded()
  await h.controller.check()
  equal('nothing is asked off macOS', h.asked.length, 0)
}
{
  const h = harness({ probe: async () => 'allowed' })
  await h.controller.check()
  equal('granted folders raise nothing', h.asked.length, 0)
}
{
  let release
  const gate = new Promise(resolve => { release = resolve })
  let probes = 0
  const h = harness({ probe: async path => { probes++; await gate; return denyDocumentsAndDownloads(path) } })
  const first = h.controller.check()
  const second = h.controller.check()
  release()
  await Promise.all([first, second])
  equal('a check requested mid-probe reruns once instead of probing in parallel', [h.asked.length, probes], [1, 1])
}
{
  const h = harness({ probe: denyDocumentsAndDownloads })
  writeStore({ a: HOME + '/code/app' })
  await h.controller.onWebUiLoaded()
  equal('no protected workspace, no hint', h.asked.length, 0)
  writeStore({ a: HOME + '/code/app', b: HOME + '/Downloads/site' })
  await settle(400)
  equal('registering a workspace in a refused folder raises the hint', h.asked.length, 1)
  check('the hint names the new workspace', h.asked[0]?.detail.includes('「site」') === true, h.asked[0]?.detail)
  h.controller.dispose()
}

console.log('\n# client settings')
{
  const clientHome = join(outDir, 'client-home')
  const { loadSettings, patchSettings } = createClientSettingsStore(clientHome)
  patchSettings({ macFolderAccessHintDismissed: ['downloads', 'bogus', 'documents', 'downloads'] })
  equal('only known locations persist, deduplicated in canonical order', loadSettings().macFolderAccessHintDismissed, ['documents', 'downloads'])
  patchSettings({ serverUrl: 'http://127.0.0.1:3080' })
  equal('an unrelated save keeps the dismissal', loadSettings().macFolderAccessHintDismissed, ['documents', 'downloads'])
  patchSettings({ macFolderAccessHintDismissed: ['bogus'] })
  equal('nothing valid, nothing stored', loadSettings().macFolderAccessHintDismissed, undefined)
}

if (failures.length > 0) {
  console.log('\n' + failures.length + ' check(s) failed')
  process.exit(1)
}
console.log('\nmac folder access hint: all checks passed')
