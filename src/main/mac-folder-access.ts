/**
 * Point the user at System Settings when macOS refuses this client a folder
 * one of their workspaces lives in.
 *
 * macOS asks once per protected location (Documents, Desktop, Downloads,
 * removable and network volumes) and remembers the answer. A "Don't Allow"
 * is never asked again: from then on every file the Agent touches there
 * fails with EPERM, the Agent can only relay "operation not permitted", and
 * nothing tells the user that the fix is a switch in Privacy & Security.
 *
 * The Agent's file access happens inside the runtime child, out of the main
 * process's sight, and no public API reports a privacy decision without
 * possibly asking for one. So this probes what it can attribute exactly: the
 * workspaces the user registered, read from the runtime's versioned workspace
 * store. A child this client spawned is attributed to this app, so the main
 * process gets the same answer the Agent gets. A reused instance started from
 * a terminal is attributed to the terminal instead, which is why callers only
 * check while they manage the runtime.
 *
 * Only EPERM counts. EACCES is ordinary POSIX permissions, and a missing
 * folder is the workspace's own problem; neither is fixed in System Settings.
 * @module dsh-desktop/mac-folder-access
 */

import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join, posix } from 'node:path'

export type ProtectedFolder = 'documents' | 'desktop' | 'downloads' | 'volumes'

export const PROTECTED_FOLDERS: readonly ProtectedFolder[] = ['documents', 'desktop', 'downloads', 'volumes']

/** System Settings → Privacy & Security → Files & Folders. */
export const FILES_AND_FOLDERS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

export type FolderProbeResult = 'allowed' | 'denied' | 'unknown'

/** Which privacy-protected location holds an absolute path, if any. */
export function protectedFolderOf(path: string, home: string): ProtectedFolder | undefined {
  // macOS paths, whatever platform runs the contract check.
  const roots: [ProtectedFolder, string][] = [
    ['documents', posix.join(home, 'Documents')],
    ['desktop', posix.join(home, 'Desktop')],
    ['downloads', posix.join(home, 'Downloads')],
  ]
  for (const [folder, root] of roots) {
    if (path === root || path.startsWith(root + '/')) return folder
  }
  return /^\/Volumes\/[^/]+(?:\/|$)/.test(path) ? 'volumes' : undefined
}

/**
 * Workspace paths from `<DSH_HOME>/storages/workspace.json`. The file carries
 * its own domain header; anything but the version this was written against
 * yields nothing, so a format change silences the hint instead of misreading.
 */
export function readWorkspacePaths(dshHome: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8')) as {
      unit?: { name?: unknown; version?: unknown }
      tables?: { workspaces?: unknown }
    }
    if (parsed?.unit?.name !== 'workspace' || parsed.unit.version !== 2) return []
    const table = parsed.tables?.workspaces
    if (table === null || typeof table !== 'object') return []
    return Object.values(table as Record<string, { path?: unknown } | null>)
      .map(record => record?.path)
      .filter((path): path is string => typeof path === 'string' && path.startsWith('/'))
  } catch {
    return []
  }
}

/**
 * Open the folder and read one entry: a privacy denial surfaces on open.
 * Asynchronous on purpose — while macOS is still asking, the call blocks
 * until the user answers, and that must not be the main thread.
 */
export async function probeFolderAccess(path: string): Promise<FolderProbeResult> {
  try {
    const dir = await opendir(path)
    try { await dir.read() } finally { await dir.close() }
    return 'allowed'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'denied' : 'unknown'
  }
}

export interface DeniedFolder {
  folder: ProtectedFolder
  /** One affected workspace, named in the message. */
  workspace: string
}

/**
 * The protected locations, among those holding a workspace, that macOS
 * refuses. One answer covers a whole location, so each stops at its first
 * conclusive probe — except volumes, where every volume is asked about anew.
 */
export async function findDeniedFolders(
  workspaces: readonly string[],
  home: string,
  skip: ReadonlySet<ProtectedFolder>,
  probe: (path: string) => Promise<FolderProbeResult> = probeFolderAccess,
): Promise<DeniedFolder[]> {
  const byFolder = new Map<ProtectedFolder, string[]>()
  for (const workspace of workspaces) {
    const folder = protectedFolderOf(workspace, home)
    if (folder === undefined || skip.has(folder)) continue
    byFolder.set(folder, [...byFolder.get(folder) ?? [], workspace])
  }
  const denied: DeniedFolder[] = []
  for (const folder of PROTECTED_FOLDERS) {
    for (const workspace of byFolder.get(folder) ?? []) {
      const result = await probe(workspace)
      if (result === 'denied') {
        denied.push({ folder, workspace })
        break
      }
      if (result === 'allowed' && folder !== 'volumes') break
    }
  }
  return denied
}

const FOLDER_LABELS: Record<ProtectedFolder, { zh: string; en: string }> = {
  documents: { zh: '「文稿」', en: 'Documents' },
  desktop: { zh: '「桌面」', en: 'Desktop' },
  downloads: { zh: '「下载」', en: 'Downloads' },
  volumes: { zh: '外接或网络磁盘', en: 'removable or network volumes' },
}

export interface FolderAccessMessage {
  message: string
  detail: string
  buttons: [string, string]
  checkboxLabel: string
}

export function folderAccessMessage(denied: readonly DeniedFolder[], chinese: boolean): FolderAccessMessage {
  const workspaces = denied.map(entry => posix.basename(entry.workspace))
  if (chinese) {
    const labels = denied.map(entry => FOLDER_LABELS[entry.folder].zh).join('、')
    return {
      message: '系统阻止了 DSH Desktop 访问' + labels,
      detail: '工作区「' + workspaces.join('」「') + '」位于' + labels + '中，Agent 目前无法读取其中的文件。\n\n'
        + '打开「系统设置 → 隐私与安全性 → 文件和文件夹」，在 DSH Desktop 下打开对应开关即可恢复。',
      buttons: ['打开系统设置', '稍后'],
      checkboxLabel: '不再提醒',
    }
  }
  const labels = denied.map(entry => FOLDER_LABELS[entry.folder].en).join(', ')
  return {
    message: 'macOS is blocking DSH Desktop from ' + labels,
    detail: 'The workspace ' + workspaces.map(name => '“' + name + '”').join(', ') + ' is in ' + labels
      + ', so the Agent cannot read its files.\n\n'
      + 'Open System Settings → Privacy & Security → Files & Folders and turn on the matching switch under DSH Desktop.',
    buttons: ['Open System Settings', 'Later'],
    checkboxLabel: 'Don’t remind me again',
  }
}

export interface MacFolderAccessOptions {
  platform?: NodeJS.Platform
  home: string
  dshHome: () => string
  /** True only while this client spawned the runtime the window is showing. */
  managesRuntime: () => boolean
  chinese: () => boolean
  dismissed: () => readonly ProtectedFolder[]
  dismiss: (folders: readonly ProtectedFolder[]) => void
  ask: (message: FolderAccessMessage) => Promise<{ response: number; checkboxChecked: boolean }>
  openSettings: () => void
  probe?: (path: string) => Promise<FolderProbeResult>
  /** Wait after a workspace-store change before probing; tests shorten it. */
  debounceMs?: number
}

export function createMacFolderAccessController(options: MacFolderAccessOptions) {
  const platform = options.platform ?? process.platform
  // Each location is raised at most once per run, answered or not. A user
  // who said Later is not asked again until the next launch.
  const raised = new Set<ProtectedFolder>()
  let running: Promise<void> | undefined
  let rerun = false
  let watcher: FSWatcher | undefined
  let watchedHome: string | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  async function checkOnce(): Promise<void> {
    if (!options.managesRuntime()) return
    const skip = new Set([...options.dismissed(), ...raised])
    const denied = await findDeniedFolders(readWorkspacePaths(options.dshHome()), options.home, skip, options.probe)
    // The runtime may have been replaced while probing.
    if (denied.length === 0 || !options.managesRuntime()) return
    for (const entry of denied) raised.add(entry.folder)
    const answer = await options.ask(folderAccessMessage(denied, options.chinese()))
    if (answer.checkboxChecked) options.dismiss(denied.map(entry => entry.folder))
    if (answer.response === 0) options.openSettings()
  }

  /** Probe now; a request made mid-check runs once more afterwards. */
  function check(): Promise<void> {
    if (platform !== 'darwin') return Promise.resolve()
    if (running !== undefined) {
      rerun = true
      return running
    }
    running = (async () => {
      try {
        do {
          rerun = false
          await checkOnce()
        } while (rerun)
      } catch (error) {
        console.warn('[desktop] folder access check failed: ' + (error instanceof Error ? error.message : String(error)))
      } finally {
        running = undefined
      }
    })()
    return running
  }

  /**
   * Re-check when the user registers a workspace. The store is replaced by
   * rename, so the directory is watched, not the file.
   */
  function watchWorkspaces(): void {
    const home = options.dshHome()
    if (watchedHome === home) return
    watcher?.close()
    watcher = undefined
    watchedHome = home
    try {
      watcher = watch(join(home, 'storages'), (_event, name) => {
        if (name !== null && name !== 'workspace.json') return
        if (debounce !== undefined) clearTimeout(debounce)
        debounce = setTimeout(() => { void check() }, options.debounceMs ?? 1_500)
        debounce.unref()
      })
      watcher.unref()
      watcher.on('error', () => { watcher?.close(); watcher = undefined; watchedHome = undefined })
    } catch { /* No store yet: the next Web UI load retries. */ watchedHome = undefined }
  }

  /** Called whenever the Web UI finishes loading. */
  function onWebUiLoaded(): Promise<void> {
    if (platform !== 'darwin' || !options.managesRuntime()) return Promise.resolve()
    watchWorkspaces()
    return check()
  }

  function dispose(): void {
    if (debounce !== undefined) clearTimeout(debounce)
    watcher?.close()
    watcher = undefined
    watchedHome = undefined
  }

  return { check, onWebUiLoaded, dispose }
}
