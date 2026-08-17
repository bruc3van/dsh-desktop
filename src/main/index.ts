/**
 * Electron main process for the DeepSeek Harness desktop client.
 *
 * The client consumes ONLY the public interface of the official dsh Web UI:
 * it manages a local `dsh web` child (or connects to a configured Web UI
 * origin) and loads the **official Web UI** itself in the client window — the
 * interface, session titles/renaming, and every button interaction are the
 * official product's, by construction. The client's own surface is limited to
 * the "连接" block appended to the official settings dialog, plus the small
 * native connection window it (and the loading surface) opens, served by a
 * minimal loopback server. Nothing here imports a harness package.
 *
 * Path expressions resolve at runtime from the BUILT bundle
 * (.build/main.mjs), so relative URLs are written against that layout, not
 * the source tree.
 * @module dsh-desktop/main
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, screen, session, shell, Tray } from 'electron'
import {
  AUTO_CHECK_DELAY_MS,
  DesktopUpdater,
  RELEASES_PAGE_URL,
  compareVersions,
  defaultGithubApiUrl,
  defaultUpdateFeedUrl,
  describeFetchError,
  type UpdateInfo,
  type UpdateState,
} from './updater.ts'
import { abandonBundledPlugin, BUNDLED_PLUGIN_NAME, seatBundledPlugin, WEB_PROFILE, withdrawBundledPlugin } from './bundled-plugin.ts'
import { releaseNotesCss, renderReleaseNotes } from './release-notes.ts'
import { clearRuntimeLock, isProcessAlive, originOf, readRuntimeLock, recordRuntimeLockUrl, restartDisposition, runtimeLockFile, writeRuntimeLock, type PidVerdict, type RuntimeLock } from './runtime-lock.ts'
import { webProbeOrigins } from './web-discovery.ts'
import {
  executableCandidates,
  isSameDirectory,
  normalizePathEntry,
  npxCacheRoot,
  parsePsElapsedSeconds,
  parseVersionOutput,
  spawnAgeVerdict,
  spawnTargetFor,
} from './runtime-resolution.ts'

/** The built bundle sits at <project>/.build/main.mjs. */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

/** The client's own data home (connection settings only). */
function clientHome(): string {
  return devOverride('DSH_DESKTOP_HOME') ?? join(homedir(), '.dsh-desktop')
}

/**
 * The local child's data home: the OFFICIAL dsh home, shared with the dsh
 * CLI and the browser Web UI — existing conversations, titles, credentials,
 * and model configuration are the same everywhere. DSH_HOME overrides.
 */
function childHome(): string {
  return devOverride('DSH_HOME') ?? join(homedir(), '.dsh')
}

/** The client's own settings document (connection configuration). */
const SETTINGS_FILE = join(clientHome(), 'settings.json')

interface ClientSettings {
  /** A reusable fixed Web UI origin. Empty/absent means Smart mode only. */
  serverUrl?: string
  /** Missing preserves the legacy behavior: a saved serverUrl is active. */
  connectionMode?: 'smart' | 'connect'
  /** Last in-app update the user chose to ignore. */
  updateDismissedVersion?: string
  /** Epoch ms of the last completed update check (auto-check throttle). */
  updateLastCheckedAt?: number
  /**
   * The user asked this client to stop seating the bundled marketplace.
   *
   * Durable, and kept HERE rather than in the profile: opting out is a
   * statement about this client, and the profile is the user's own file. It
   * has to be durable at all because the seat is re-offered on every start —
   * without a record, removing the market would simply undo itself the next
   * time the app opened, which reads as "it will not go away".
   */
  bundledMarketDisabled?: boolean
}

function loadSettings(): ClientSettings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as ClientSettings
  } catch {
    return {}
  }
}

function saveSettings(settings: ClientSettings): void {
  // The document holds no credential, but it does hold the address every
  // session connects to. On a shared POSIX machine the default umask would
  // leave that world-readable (and, worse, group-writable under a lax umask).
  mkdirSync(clientHome(), { recursive: true, mode: 0o700 })
  // Written through a temporary file and renamed, for the same reason the
  // runtime lock is: a torn read parses as "no settings", silently dropping
  // the connection mode, the pinned address, and the ignored-update record.
  const temporary = SETTINGS_FILE + '.' + String(process.pid) + '.tmp'
  const backup = SETTINGS_FILE + '.' + String(process.pid) + '.bak'
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  try {
    renameSync(temporary, SETTINGS_FILE)
  } catch {
    // Windows: a rename onto a live file can fail transiently (a scanner
    // holding it open). Move the current document ASIDE first, put the new
    // one in place, then drop the backup — so a failed swap can never leave
    // NEITHER version in place, and the user's configured address cannot be
    // lost to a transient lock.
    try { rmSync(backup, { force: true }) } catch { /* nothing to clean up */ }
    try {
      try { renameSync(SETTINGS_FILE, backup) } catch { /* nothing there yet */ }
      renameSync(temporary, SETTINGS_FILE)
    } catch (error) {
      if (!existsSync(SETTINGS_FILE)) {
        try { renameSync(backup, SETTINGS_FILE) } catch { /* best effort */ }
      }
      try { rmSync(temporary, { force: true }) } catch { /* nothing to clean up */ }
      throw error
    }
    try { rmSync(backup, { force: true }) } catch { /* litter, not failure */ }
  }
  // The mode above applies only when the file is created, so an install that
  // predates it would keep its old permissions forever. chmod every save
  // instead; on Windows it is a no-op, and a read-only path is not worth
  // failing a settings write over.
  if (process.platform !== 'win32') {
    try {
      chmodSync(clientHome(), 0o700)
      chmodSync(SETTINGS_FILE, 0o600)
    } catch { /* best effort: the write itself already succeeded */ }
  }
}

/** Merge settings and persist. `unset` drops keys so a later save cannot leak them. */
function patchSettings(patch: Partial<ClientSettings> = {}, unset: readonly (keyof ClientSettings)[] = []): void {
  const merged: ClientSettings = { ...loadSettings(), ...patch }
  const skip = new Set(unset)
  const next: ClientSettings = {}
  if (!skip.has('serverUrl') && merged.serverUrl !== undefined) next.serverUrl = merged.serverUrl
  if (!skip.has('connectionMode') && merged.connectionMode !== undefined) next.connectionMode = merged.connectionMode
  if (!skip.has('bundledMarketDisabled') && merged.bundledMarketDisabled !== undefined) {
    next.bundledMarketDisabled = merged.bundledMarketDisabled
  }
  if (!skip.has('updateDismissedVersion') && merged.updateDismissedVersion !== undefined) {
    next.updateDismissedVersion = merged.updateDismissedVersion
  }
  if (!skip.has('updateLastCheckedAt') && merged.updateLastCheckedAt !== undefined) {
    next.updateLastCheckedAt = merged.updateLastCheckedAt
  }
  saveSettings(next)
}

/** Normalize a user-supplied Web UI address to an origin, or undefined when blank/invalid. */
function normalizeServerUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let candidate = value.trim()
  // Case-insensitive: `HTTPS://host` is a scheme, not a hostname, and a
  // case-sensitive test would misread it as `http://https//host` — an origin
  // that can never connect, followed by a misleading plaintext warning.
  if (!/^https?:\/\//i.test(candidate)) candidate = 'http://' + candidate
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Loopback origins are the client's own surfaces; anything else is a
 * user-configured remote.
 */
function originIsLoopback(value: string): boolean {
  try {
    const host = new URL(value).hostname
    // WHATWG `URL.hostname` is `::1`. `[::1]` is only seen when a caller
    // passes a still-bracketed host.
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * Whether a navigation is the same server telling us to use TLS. A bare
 * hostname normalizes to `http://`, so a Web UI that redirects plaintext to
 * its own HTTPS origin is the ordinary case, not a detour: same host, same
 * port, scheme strictly better. Anything else is a real origin change.
 */
function isSecureUpgrade(from: string, to: string): boolean {
  try {
    const before = new URL(from)
    const after = new URL(to)
    return before.protocol === 'http:' && after.protocol === 'https:'
      && before.hostname === after.hostname && before.port === after.port
  } catch {
    return false
  }
}

/**
 * Environment overrides are development seats. A packaged client must not be
 * steerable by ambient environment: a variable left by an installer, a login
 * script, or another application would otherwise redirect the spawned runtime,
 * the Smart-mode probe, the data homes, or the update feed without the user
 * ever seeing it — a planted DSH_DESKTOP_HOME is a planted settings.json, and
 * that names the server the client connects to on every future launch.
 * DSH_DESKTOP_ALLOW_UNSAFE=1 keeps the escape hatch for deliberate debugging.
 *
 * Every DSH_* variable this file reads goes through here or `devFlag`, with
 * one deliberate exception: DSH_DESKTOP_NODE is read on a branch a packaged
 * build cannot reach (it throws on a missing bundled runtime first).
 */
function devOverride(name: string): string | undefined {
  if (app.isPackaged && process.env.DSH_DESKTOP_ALLOW_UNSAFE !== '1') return undefined
  return process.env[name]
}

/** The `=1` test knobs, under the same packaging gate as `devOverride`. */
function devFlag(name: string): boolean {
  return devOverride(name) === '1'
}

/** Whether persisted settings currently select the reusable remote origin. */
function usesConfiguredServer(settings: ClientSettings): boolean {
  return normalizeServerUrl(settings.serverUrl) !== undefined && settings.connectionMode !== 'smart'
}

/**
 * The Node that runs the dsh child. Inside a packaged app the child runs on
 * Electron's own bundled Node (ELECTRON_RUN_AS_NODE), so the end user needs
 * neither a system Node nor any npm command; in development the system Node
 * (or DSH_DESKTOP_NODE) is used.
 */
function nodeForChild(): string {
  if (app.isPackaged) return process.execPath
  return process.env.DSH_DESKTOP_NODE ?? 'node'
}

/**
 * The small module the runtime child boots instead of the official bin: it
 * keeps `ELECTRON_RUN_AS_NODE` out of the Agent's execution environment while
 * the runtime's own `process.execPath` children keep it (see
 * `src/main/runtime-launcher.ts`). It ships beside the runtime closure rather
 * than inside app.asar, because the child reads it as an ordinary file.
 */
function runtimeLauncher(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'runtime-launcher.mjs')
    : join(APP_DIR, '.build', 'runtime-launcher.mjs')
}

/**
 * A packaged client bundles a complete dsh runtime but no `node` command, so a
 * user who never installed Node gets an Agent that cannot run `node script.js`
 * or any MCP server started that way. Publish Electron's own Node under the
 * name `node` in the client's data home and append that directory to the
 * runtime's PATH: appended, never prepended, so a real Node the user installed
 * keeps priority and a developer's toolchain is unaffected.
 *
 * The shim is written once per launch — the executable path moves with each
 * installed version, so it is rewritten rather than reused across versions —
 * and only exists in packaged builds, where the developer Node that runs the
 * child would otherwise already be on PATH. The result is memoized because the
 * runtime is respawned on every bounded restart, and neither the file nor its
 * log line should be repeated per attempt.
 * Returns the directory to append, or undefined when there is nothing to add.
 */
let nodeShimDir: string | undefined
let nodeShimResolved = false
function ensureNodeShim(): string | undefined {
  if (nodeShimResolved) return nodeShimDir
  nodeShimResolved = true
  if (!app.isPackaged) return undefined
  try {
    const binDir = join(clientHome(), 'bin')
    mkdirSync(binDir, { recursive: true })
    if (process.platform === 'win32') {
      const shim = join(binDir, 'node.cmd')
      writeFileSync(shim, [
        '@echo off',
        'rem Generated by DeepSeek Harness Desktop. Electron\'s bundled Node, named `node`.',
        'setlocal',
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"' + process.execPath + '" %*',
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'))
      nodeShimDir = binDir
      console.log('[desktop] node shim ready: ' + binDir)
      return binDir
    }
    const shim = join(binDir, 'node')
    writeFileSync(shim, [
      '#!/bin/sh',
      '# Generated by DeepSeek Harness Desktop. Electron\'s bundled Node, named `node`.',
      'ELECTRON_RUN_AS_NODE=1 exec "' + process.execPath + '" "$@"',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
    nodeShimDir = binDir
    console.log('[desktop] node shim ready: ' + binDir)
    return binDir
  } catch (error) {
    // A missing shim costs the Agent one convenience, never the session.
    console.warn('[desktop] node shim unavailable: ' + (error instanceof Error ? error.message : String(error)))
    return undefined
  }
}

/** The PATH the runtime child (and every Agent command under it) inherits. */
function childPath(): string {
  const current = process.env.PATH ?? ''
  const shimDir = ensureNodeShim()
  if (shimDir === undefined) return current
  // Same directory comparison as findOnPath's exclusion: an entry already on
  // PATH under another spelling is already the shim directory.
  if (current.split(delimiter)
    .some(entry => isSameDirectory(normalizePathEntry(entry), shimDir, process.platform))) return current
  return current === '' ? shimDir : current + delimiter + shimDir
}

/**
 * Locate an executable on the ambient PATH, the way a shell would. The client's
 * own shim directory is excluded: it publishes Electron's Node under the name
 * `node`, and a lookup that resolved to it would report the client's own
 * runtime back as if the user had installed one.
 */
function findOnPath(name: string): string | undefined {
  // The exclusion is matched the way the platform matches directories, not
  // byte for byte: a PATH entry the user wrote in another case, with forward
  // slashes, or with a trailing separator is the same directory, and letting
  // any of those through would hand the client's own shim back as a
  // "user-installed" Node — the one thing detectDshInNpxCache() relies on this
  // to prevent.
  const shimDir = join(clientHome(), 'bin')
  const candidates = executableCandidates(name, process.platform)
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const dir = normalizePathEntry(entry)
    if (dir === '' || !isAbsolute(dir)) continue
    if (isSameDirectory(dir, shimDir, process.platform)) continue
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * A dsh the user installed themselves (npm/pnpm global, a version manager, a
 * source checkout on PATH). Preferred over the bundled runtime when present:
 * it runs on a real system Node instead of Electron's Node mode, so none of
 * the launcher's spawn rewriting or `--expose-internals` scaffolding applies,
 * and the user's own `dsh` upgrades reach the desktop client without waiting
 * for a client release. The bundled runtime stays the fallback.
 */
interface InstalledDsh {
  /** Spawn shape, already resolved for this platform. */
  command: string
  args: string[]
  shell: boolean
  /** What identifies this runtime in logs and the status line. */
  path: string
  version: string
  /** `installed` = a `dsh` on PATH; `npx` = a package npx already cached. */
  source: 'installed' | 'npx'
}

let installedDsh: InstalledDsh | undefined
/**
 * Set when an installed runtime failed to reach readiness. The rest of the
 * session uses the bundled runtime: retrying a runtime this client does not
 * control, against the same failure, only spends the recovery budget.
 */
let installedDshRejected = false
let installedDshDetection: Promise<void> | undefined
/** The selected npx-cached dsh is older than the bundled runtime (note, not veto). */
let npxCacheOutdated = false

/**
 * Force-kill a child, without waiting. On Windows the direct child may be the
 * cmd.exe wrapper around a `.cmd` shim, so the whole tree is terminated —
 * killing the wrapper alone would leave the real process running. On POSIX
 * this reaches the direct child only, which is all its callers spawn.
 * SIGKILL rather than SIGTERM: this is the deadline path, and a shim that
 * ignores SIGTERM would otherwise linger.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid !== undefined && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', () => { child.kill('SIGKILL') })
    return
  }
  child.kill('SIGKILL')
}

/**
 * Read a `--version` line out of a candidate command. Success is the whole
 * condition check: a `dsh` that prints its version has a working Node behind
 * its shebang and a bootable CLI, which is strictly more than a separate
 * `node --version` comparison would establish. Nothing is ever installed or
 * downloaded here.
 */
async function readCommandVersion(command: string, shell: boolean, timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let settled = false
    let stdout = ''
    const finish = (value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ChildProcess
    try {
      child = spawn(command, ['--version'], {
        cwd: homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell,
      })
    } catch {
      resolve(undefined)
      return
    }
    const timer = setTimeout(() => { killProcessTree(child); finish() }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_096) stdout = stdout.slice(0, 4_096)
    })
    child.once('error', () => { finish() })
    child.once('exit', (code) => {
      finish(code === 0 ? parseVersionOutput(stdout) : undefined)
    })
  })
}

/**
 * Detect a user-installed dsh, once per session. Runs only on the path that is
 * about to start a local runtime, so a client reusing an already-running
 * instance never pays for it.
 */
/** A `dsh` the user installed onto PATH (npm/pnpm global, a version manager). */
async function detectDshOnPath(): Promise<InstalledDsh | undefined> {
  const found = findOnPath('dsh')
  if (found === undefined) return undefined
  const target = spawnTargetFor(found, process.platform)
  const version = await readCommandVersion(target.command, target.shell)
  if (version === undefined) {
    console.warn('[desktop] a dsh on PATH did not report a version; ignoring it: ' + found)
    return undefined
  }
  return { command: target.command, args: [], shell: target.shell, path: found, version, source: 'installed' }
}

/**
 * A `@deepseek-ai/dsh` npx has already cached. This is the runtime the OFFICIAL
 * instruction produces — `npx @deepseek-ai/dsh web` installs nothing onto PATH,
 * so a PATH-only search misses every user who followed the documentation.
 *
 * Reading the cache directly (rather than re-invoking `npx`) keeps this
 * offline and instant, reports the package's real version, and spawns the
 * entry on the user's own Node with no wrapper process in between — which on
 * Windows also avoids the cmd.exe layer a `.cmd` shim would add.
 *
 * Nothing is downloaded: an absent cache simply yields undefined.
 */
function detectDshInNpxCache(): InstalledDsh | undefined {
  // `npm_config_cache` is read by every npm tool on the machine, so it is
  // NOT a DSH_* variable the devOverride gate covers — but it redirects this
  // lookup the same way: a planted cache directory could answer with a
  // fake `@deepseek-ai/dsh` that then runs as the local runtime. A packaged
  // client therefore ignores the override (the user's own npm still honours
  // it; the desktop client simply looks in the default location) unless the
  // documented debugging escape hatch is on.
  const env = app.isPackaged && process.env.DSH_DESKTOP_ALLOW_UNSAFE !== '1'
    ? { ...process.env, npm_config_cache: undefined, NPM_CONFIG_CACHE: undefined }
    : process.env
  const root = npxCacheRoot(process.platform, env, homedir())
  if (root === undefined || !existsSync(root)) return undefined
  // The cached package is plain JavaScript, so it needs a real Node. The
  // client's own shim is excluded by findOnPath: running this on Electron's
  // Node would reintroduce the very Node-mode plumbing this path avoids.
  const node = findOnPath('node')
  if (node === undefined) return undefined
  let best: { bin: string; version: string; mtimeMs: number } | undefined
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const packageDir = join(root, entry, 'node_modules', '@deepseek-ai', 'dsh')
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
        bin?: unknown
      }
      // Identity is checked, not assumed: this walks a cache keyed by an
      // arbitrary spec, and only the real package may be launched from it.
      if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') continue
      const declared = typeof manifest.bin === 'string'
        ? manifest.bin
        : typeof manifest.bin === 'object' && manifest.bin !== null
          ? (manifest.bin as Record<string, unknown>).dsh
          : undefined
      const bin = join(packageDir, typeof declared === 'string' ? declared : 'lib/bin.js')
      if (!existsSync(bin)) continue
      const mtimeMs = statSync(packageDir).mtimeMs
      // Most recently touched wins. A repeated `npx @deepseek-ai/dsh` reuses
      // one cache entry, so extra entries mean deliberately pinned specs — and
      // the one the user ran last is the one they mean.
      if (best === undefined || mtimeMs > best.mtimeMs) best = { bin, version: manifest.version, mtimeMs }
    } catch {
      continue
    }
  }
  if (best === undefined) return undefined
  return { command: node, args: [best.bin], shell: false, path: best.bin, version: best.version, source: 'npx' }
}

function detectInstalledDsh(): Promise<void> {
  installedDshDetection ??= (async () => {
    if (devFlag('DSH_DESKTOP_SKIP_INSTALLED_DSH')) return
    // PATH first: an explicit installation outranks a cache entry npx may have
    // written for a one-off pinned spec.
    installedDsh = await detectDshOnPath() ?? detectDshInNpxCache()
    if (installedDsh === undefined) {
      console.log('[desktop] no user-installed dsh found; using the bundled runtime')
      return
    }
    console.log('[desktop] user-installed dsh detected (' + installedDsh.source + '): '
      + installedDsh.path + ' (v' + installedDsh.version + ')')
    // The cache never re-resolves `latest` on its own — it is whatever the
    // user's last `npx @deepseek-ai/dsh` run left behind — so after an in-app
    // update it can lag the runtime this client ships. It stays preferred
    // (the user's own runtime, on their own Node), but the connection surfaces
    // say so: a person who only opens the desktop client would otherwise never
    // learn that re-running npx gets them the newer copy they already carry.
    if (installedDsh.source === 'npx') {
      const bundled = bundledDshVersion()
      if (bundled !== null && compareVersions(bundled, installedDsh.version) > 0) {
        npxCacheOutdated = true
        console.log('[desktop] npx-cached dsh v' + installedDsh.version
          + ' is older than the bundled v' + bundled + '; keeping the cache — re-run npx to refresh it')
      }
    }
  })()
  return installedDshDetection
}

/**
 * macOS GUI applications inherit launchd's small PATH instead of the user's
 * login-shell PATH. The official runtime later derives Agent command
 * environments from this process, so Homebrew and version-manager tools would
 * otherwise disappear only in the packaged app. Read one PATH value through
 * the user's absolute login shell, with a short deadline and no interactive
 * startup, then merge only absolute path entries into the existing value.
 */
/**
 * Read one PATH value out of the user's shell. NUL framing survives the
 * banners, colour codes, and version-manager chatter an interactive startup
 * file prints; only the last framed pair is read back.
 */
async function readShellPath(shellPath: string, shellArgs: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let settled = false
    let stdout = ''
    const finish = (value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const child = spawn(shellPath, [...shellArgs, 'printf \'\\0%s\\0\' "$PATH"'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const timeout = setTimeout(() => {
      child.kill()
      finish()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 65_536) stdout = stdout.slice(-65_536)
    })
    child.once('error', () => { finish() })
    child.once('exit', (code) => {
      const end = stdout.lastIndexOf('\0')
      const start = end > 0 ? stdout.lastIndexOf('\0', end - 1) : -1
      finish(code === 0 && start >= 0 && end > start ? stdout.slice(start + 1, end) : undefined)
    })
  })
}

async function restoreMacGuiPath(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged || devFlag('DSH_DESKTOP_SKIP_LOGIN_PATH')) return

  const configuredShell = userInfo().shell
  const shellPath = typeof configuredShell === 'string' && isAbsolute(configuredShell) && existsSync(configuredShell)
    ? configuredShell
    : '/bin/zsh'
  // Interactive first: a login shell alone reads .zprofile but never .zshrc,
  // where most people's tool directories (~/.local/bin, language-manager shims)
  // actually live — those tools exist in the user's terminal and would
  // otherwise be missing only inside the desktop client. An interactive
  // startup can be slow or, with an unusual rc file, not terminate at all, so
  // it runs against a deadline and falls back to the plain login shell.
  const loginPath = await readShellPath(shellPath, ['-l', '-i', '-c'], 3_000)
    ?? await readShellPath(shellPath, ['-l', '-c'], 2_000)

  // Shells that model PATH as a list (fish) join it with spaces rather than the
  // path delimiter, which yields one long pseudo-absolute entry. Requiring the
  // directory to exist drops that value instead of prepending a bogus entry.
  const fromLogin = (loginPath ?? '').split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry !== '' && isAbsolute(entry) && existsSync(entry))
  const fromLaunch = (process.env.PATH ?? '').split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry !== '' && isAbsolute(entry))
  const merged = [...new Set([...fromLogin, ...fromLaunch])].join(delimiter)
  if (merged === '') {
    console.warn('[desktop] login-shell PATH unavailable; keeping the launch environment')
    return
  }
  process.env.PATH = merged
  console.log('[desktop] restored PATH from the macOS login shell')
}

/**
 * The bundled dsh CLI. Release builds use pnpm deploy to materialize the
 * complete production closure outside app.asar; development resolves the same
 * pinned package from the dsh-runtime workspace. An end user needs neither a
 * system Node nor a separately installed dsh command.
 */
function resolveBundledDsh(): DshCommand | undefined {
  try {
    const bin = app.isPackaged
      ? join(process.resourcesPath, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : createRequire(join(APP_DIR, 'dsh-runtime', 'package.json')).resolve('@deepseek-ai/dsh/lib/bin.js')
    if (!existsSync(bin)) return undefined
    return {
      command: nodeForChild(),
      // System Node can use node-addon-require-builtin, but Electron's Node
      // mode does not expose the loader required by cordis-plugin-hmr through
      // that addon and exits with "--expose-internals is required". Keep the
      // unstable flag scoped to the packaged child; source audit and package
      // smoke intentionally cover both execution paths.
      args: [...app.isPackaged ? ['--expose-internals'] : [], runtimeLauncher()],
      entry: bin,
      binPath: bin,
      label: bin,
      source: 'bundled',
    }
  } catch {
    return undefined
  }
}

/**
 * Whether the client-owned seat is on the profile this boot (added now, or
 * already present). A runtime that then never reaches readiness has the
 * entry taken back before the retry — a plugin that throws while loading
 * fails the whole plugin tree, not just itself, including after upgrades
 * where the name is no longer a first write.
 */
let bundledPluginSeatInUse = false
/**
 * Session-scoped: this process already withdrew a seat after a failed boot.
 * Retries must not put the name back, or a deterministic bad plugin burns
 * the whole launch budget without ever trying the one config that can work
 * (the bundled runtime with no plugin).
 */
let bundledPluginSuppressed = false

/**
 * The bundled plugin's directory inside the client's runtime closure.
 *
 * Resolved the same way `resolveBundledDsh` resolves the runtime itself, and
 * deliberately NOT by walking up from the runtime's bin path: a packaged
 * closure is hoisted (the plugin sits beside `@deepseek-ai`), while a source
 * checkout keeps pnpm's symlinked layout (the same arithmetic lands inside
 * `.pnpm/@deepseek-ai+dsh@…/node_modules`, where the plugin is not). Asking
 * the resolver instead makes the seat work in both.
 * @returns the plugin directory, or undefined when this build carries none.
 */
function bundledPluginDir(): string | undefined {
  try {
    if (app.isPackaged) {
      const dir = join(process.resourcesPath, 'dsh-runtime', 'node_modules', BUNDLED_PLUGIN_NAME)
      return existsSync(join(dir, 'package.json')) ? dir : undefined
    }
    const anchor = join(APP_DIR, 'dsh-runtime', 'package.json')
    return dirname(createRequire(anchor).resolve(BUNDLED_PLUGIN_NAME + '/package.json'))
  } catch {
    return undefined
  }
}

/**
 * Offer — or stop offering — the bundled plugin to the profile about to boot.
 *
 * Every runtime this client STARTS is a candidate, not just its own. The
 * plugin is copied into `profiles/node_modules` rather than linked into the
 * closure, so its `@deepseek-ai/*` imports resolve through the graph the
 * harness heals there for whichever installation is serving — the same way a
 * plugin installed with `dsh plugin add` resolves. What used to make the seat
 * unsafe elsewhere (a second copy of the Service classes, reached through the
 * link's realpath) is therefore gone.
 *
 * What replaces it is a version gate: the plugin is built against the runtime
 * this client ships, so an older one is refused rather than risked. See
 * `runtimeRefusal`.
 *
 * A pinned address still releases the seat: it may not even be this machine,
 * and the client cannot know when a change to a profile it is not booting
 * would take effect. A LOCAL instance the client adopts (probe, survivor) is
 * different — it serves this very profile, and releasing the seat under it
 * left the market unable to see itself in the profile it manages; that path
 * re-seats instead (see `reseatForAdoptedRuntime`).
 * @param dsh - the resolved command this spawn is about to run.
 */
function applyBundledPluginSeat(dsh: DshCommand): void {
  if (loadSettings().bundledMarketDisabled === true) {
    // The user's own answer, and it outranks every other reason to seat. The
    // copy goes too: withdrawing the entry alone would leave a plugin tree in
    // their profile that nothing loads and nothing ever cleans up.
    if (abandonBundledPlugin(childHome())) {
      console.log('[desktop] bundled plugin removed: turned off in connection settings')
    }
    bundledPluginSeatInUse = false
    return
  }
  if (bundledPluginSuppressed) {
    releaseBundledPluginSeat('suppressed after a failed boot this session')
    return
  }
  offerBundledPluginSeat(dsh)
}

function releaseBundledPluginSeat(reason: string): void {
  if (withdrawBundledPlugin(childHome())) {
    console.log('[desktop] bundled plugin seat withdrawn: ' + reason)
  }
  bundledPluginSeatInUse = false
}

/**
 * Put the seat back when adopting a runtime that is already serving this
 * profile (a probed instance the user started, a surviving child).
 * `resolveRuntime` released the seat before it knew who would serve; leaving
 * it released here strands the running market outside the manifest its
 * installed panel reads — it cannot see, disable, or uninstall itself. The
 * version gate does not run against an adopted instance — host.describe
 * carries a version, but this adoption path keeps only the origin — so the
 * seat rides on `serving`: the instance demonstrably boots this profile,
 * and the client's own spawns re-gate with the real version.
 */
function reseatForAdoptedRuntime(): void {
  if (loadSettings().bundledMarketDisabled === true || bundledPluginSuppressed) return
  const pluginDir = bundledPluginDir()
  if (pluginDir === undefined) return
  const result = seatBundledPlugin(pluginDir, childHome(), {
    serving: true,
    builtAgainst: bundledDshVersion() ?? undefined,
  })
  bundledPluginSeatInUse = result.seated
  if (result.added) console.log('[desktop] bundled plugin re-seated under the adopted runtime: ' + BUNDLED_PLUGIN_NAME)
  else if (!result.seated && result.error !== undefined) {
    console.log('[desktop] bundled plugin not seated: ' + result.error)
  }
}

function offerBundledPluginSeat(dsh: DshCommand): void {
  const home = childHome()
  const pluginDir = bundledPluginDir()
  if (pluginDir === undefined) {
    if (abandonBundledPlugin(home)) {
      console.log('[desktop] bundled plugin seat withdrawn: the runtime closure carries no bundled plugin')
    }
    bundledPluginSeatInUse = false
    return
  }
  const result = seatBundledPlugin(pluginDir, home, {
    version: dsh.source === 'bundled' ? (bundledDshVersion() ?? undefined) : dsh.version,
    builtAgainst: bundledDshVersion() ?? undefined,
  })
  bundledPluginSeatInUse = result.seated
  if (result.lifted) {
    console.log('[desktop] bundled plugin overlay was older than the closure; using ' + BUNDLED_PLUGIN_NAME
      + ' from the runtime closure')
  }
  if (result.added) console.log('[desktop] bundled plugin seated: ' + BUNDLED_PLUGIN_NAME)
  else if (!result.seated && result.error !== undefined) {
    console.log('[desktop] bundled plugin not seated: ' + result.error)
  }
}

/**
 * Resolve the `dsh` command the client spawns for local mode. Order: the
 * explicit DSH_DESKTOP_DSH override, a verified user-installed dsh, the
 * app-bundled npm package, conventional sibling checkouts (dev convenience),
 * and finally `dsh` on PATH.
 */
interface DshCommand {
  command: string
  args: string[]
  /** The official CLI entry `runtimeLauncher()` imports, when args boot it. */
  entry?: string
  binPath?: string
  /** Spawn through the platform shell (a Windows `.cmd`/`.bat` wrapper). */
  shell?: boolean
  label: string
  source: 'override' | 'installed' | 'npx' | 'bundled' | 'checkout' | 'path'
  /**
   * The runtime's own dsh version, when this client could read one. It gates
   * the bundled-plugin seat: the plugin is built against the runtime we ship,
   * and an older one may not export what it imports.
   */
  version?: string
}

class BundledRuntimeMissingError extends Error {
  constructor() {
    super('安装包中缺少内置 dsh 运行时。请重新从项目的 GitHub Releases 下载并安装完整客户端。')
    this.name = 'BundledRuntimeMissingError'
  }
}

function resolveDshCommand(): DshCommand {
  const explicit = devOverride('DSH_DESKTOP_DSH')
  if (explicit !== undefined && explicit.trim() !== '') {
    return { command: explicit, args: [], label: explicit, source: 'override' }
  }
  const installed = installedDshRejected ? undefined : installedDsh
  if (installed !== undefined) {
    return {
      command: installed.command,
      args: [...installed.args],
      shell: installed.shell,
      label: installed.path + ' (v' + installed.version + ')',
      source: installed.source,
      version: installed.version,
    }
  }
  const bundled = resolveBundledDsh()
  if (bundled !== undefined) return bundled
  // A release artifact is self-contained by contract. Falling through to a
  // PATH lookup hides packaging damage behind several guaranteed ENOENT
  // retries on an ordinary user's machine.
  if (app.isPackaged) throw new BundledRuntimeMissingError()
  // Dev convenience: probe sibling checkouts (read-only; never a package dependency).
  const siblings = fileURLToPath(new URL('../..', import.meta.url))
  for (const name of ['test-bruc3van', 'deepseek-harness']) {
    const bin = join(siblings, name, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(bin)) {
      const node = process.env.DSH_DESKTOP_NODE ?? 'node'
      return { command: node, args: [runtimeLauncher()], entry: bin, binPath: bin, label: bin, source: 'checkout' }
    }
  }
  return { command: 'dsh', args: [], label: 'dsh', source: 'path' }
}

/**
 * Parse the readiness line the official Web app prints once the server binds.
 * The line comes from a child's stdout, so the value is only accepted as a
 * navigation target after it parses as an http(s) URL — the window must never
 * be pointed at a `file:`/`javascript:` string a damaged or substituted
 * runtime happened to print.
 */
function parseReadiness(line: string): string | undefined {
  const match = /^dsh web:\s+(\S+)/.exec(line)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : undefined
  } catch {
    return undefined
  }
}

/** One `dsh web` child generation: process + its own lifecycle listeners. */
interface WebUiGeneration {
  child: ChildProcess
  /** Settles with the Web UI URL when THIS generation reports readiness. */
  ready: Promise<string>
  /** Whether THIS generation reached readiness before it exited. */
  readyReported: boolean
}

/**
 * The local `dsh web` runtime manager: spawn generations on demand, resolve
 * the served URL once, report every exit through one callback so the window
 * owner can decide relaunch vs. fatal.
 */
class WebUiManager {
  private generation: WebUiGeneration | undefined
  /** A stop in flight must finish before another generation can be spawned. */
  private stopping: Promise<void> | undefined
  /**
   * A failure no relaunch can repair (a damaged installation). It is reported
   * through onExit exactly once; later readiness requests reject with it
   * instead of spawning again, so the user never collects a stack of identical
   * error dialogs by reopening the window.
   */
  private fatalError: Error | undefined
  lastError: string | null = null
  /** Which runtime the current generation was spawned from (status + fallback). */
  lastSource: DshCommand['source'] | undefined
  /** The resolved command of the last spawn, for the post-readiness seat. */
  lastCommand: DshCommand | undefined

  constructor(
    private readonly onLog: (line: string) => void,
    private readonly onExit: (info: { wasReady: boolean; code: number | null; signal: NodeJS.Signals | null; retryable: boolean }) => void,
  ) {}

  /** The current generation's readiness, or a fresh spawn when none exists. */
  async ready(): Promise<string> {
    await this.stopping
    if (this.fatalError !== undefined) throw this.fatalError
    const gen = this.generation
    if (gen !== undefined) return gen.ready
    this.spawn()
    const spawned = this.generation
    if (spawned === undefined) return Promise.reject(new Error('dsh web spawn failed'))
    return spawned.ready
  }

  /** The current child's pid, when one is running. */
  pid(): number | undefined {
    const gen = this.generation
    return gen?.child.pid
  }

  spawn(): void {
    // A generation already owns the manager. Respawns race through here from
    // both the exit ladder and `ready()` — the ladder's timer and a waiter
    // released by `stopping` both believe they are the one to respawn — and
    // spawning over a live child is a second writer on one DSH_HOME, which is
    // the one thing this manager exists to prevent. Whoever lost the race
    // finds the winner through `ready()` instead.
    if (this.fatalError !== undefined || this.generation !== undefined) return
    try {
      mkdirSync(childHome(), { recursive: true })
    } catch (error) {
      // The spawn callers above are timers and callbacks: a synchronous throw
      // here would be an uncaught exception in the main process. Route it
      // through the same fatal-error surface as a damaged installation.
      this.fatalError = error instanceof Error ? error : new Error(String(error))
      this.lastError = this.fatalError.message
      queueMicrotask(() => {
        this.onExit({ wasReady: false, code: null, signal: null, retryable: false })
      })
      return
    }
    let dsh: DshCommand
    try {
      dsh = resolveDshCommand()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fatalError = failure
      this.lastError = failure.message
      queueMicrotask(() => {
        this.onExit({ wasReady: false, code: null, signal: null, retryable: false })
      })
      return
    }
    console.log('[desktop] dsh runtime: ' + dsh.source + ' (' + dsh.label + ')')
    this.lastSource = dsh.source
    this.lastCommand = dsh
    applyBundledPluginSeat(dsh)
    const child = spawn(dsh.command, [...dsh.args, 'web', '--port', '0'], {
      cwd: childHome(),
      env: {
        ...process.env,
        DSH_HOME: childHome(),
        PATH: childPath(),
        // The launcher imports this entry, then keeps the Node-mode variable
        // below out of everything the harness spawns afterwards.
        ...dsh.entry !== undefined && { DSH_DESKTOP_RUNTIME_ENTRY: dsh.entry },
        // Node mode belongs only to a child that IS the Electron binary. A
        // user-installed dsh runs on a real system Node, where the variable
        // would mean nothing to this process and everything to any Electron
        // tool the Agent later starts underneath it.
        ...app.isPackaged && dsh.command === process.execPath && { ELECTRON_RUN_AS_NODE: '1' },
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...dsh.shell === true && { shell: true },
    })
    let resolveReady: (url: string) => void = () => {}
    let rejectReady: (error: Error) => void = () => {}
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const gen: WebUiGeneration = { child, ready, readyReported: false }
    let exitReported = false
    let readinessProbeStarted = false

    // Recorded before readiness, not after: a client killed during the child's
    // boot still has to leave the pid behind for the next start to reap.
    if (child.pid !== undefined) {
      writeRuntimeLock(childHome(), { childPid: child.pid, desktopPid: process.pid, startedAt: Date.now() })
    }

    const reportExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitReported) return
      exitReported = true
      if (this.generation === gen) {
        this.generation = undefined
        // Every way this child ends passes through here, so the record never
        // outlives it — except the one case it exists for, where this process
        // is gone and nothing runs at all. The clear is generation-guarded: a
        // late exit from a superseded child (a Windows stop that resolves
        // before the exit event) must not erase the lock its successor has
        // already written.
        clearRuntimeLock(childHome())
      }
      this.onExit({ wasReady: gen.readyReported, code, signal, retryable: true })
    }

    // Line framing across chunk boundaries: a readiness line split by the
    // pipe must not be lost (or misparsed).
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        // A \r\n child stdout would otherwise carry the \r into every log
        // line; readiness parsing is unaffected (it trims), this is cosmetic.
        const line = raw.replace(/\r$/, '')
        if (line.trim() === '') continue
        this.onLog(line)
        const url = parseReadiness(line)
        if (url !== undefined && !readinessProbeStarted) {
          readinessProbeStarted = true
          void waitForWebUiReady(url).then(() => {
            if (exitReported) return
            gen.readyReported = true
            this.lastError = null
            resolveReady(url)
          }, (error: unknown) => {
            if (exitReported) return
            this.lastError = error instanceof Error ? error.message : String(error)
            rejectReady(error instanceof Error ? error : new Error(String(error)))
            // Tree-kill, not child.kill(): on Windows the direct child may be
            // the cmd.exe wrapper around a .cmd shim, and killing it alone
            // would leave the real server booting (and writing DSH_HOME)
            // while the retry budget spawns a second one beside it.
            killProcessTree(child)
          })
        }
      }
    })
    child.on('close', () => {
      if (stdoutBuffer.trim() !== '') this.onLog(stdoutBuffer)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write('[dsh web] ' + chunk.toString())
    })
    child.on('error', (error) => {
      this.lastError = error.message
      rejectReady(error)
      // An 'error' after a successful spawn (a failed kill, say) leaves the
      // child running; only a process that never existed or already left
      // counts as an exit. A real exit always fires 'exit' below.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        reportExit(null, null)
      }
    })
    child.on('exit', (code, signal) => {
      rejectReady(new Error('dsh web exited before ready (code=' + String(code) + ')'))
      reportExit(code, signal)
    })
    this.generation = gen
  }

  /**
   * Stop the current generation. On POSIX the SIGTERM → SIGKILL ladder gives
   * the harness its graceful disposal window; on Windows signals cannot be
   * caught, so the whole process tree is terminated (taskkill /T /F).
   */
  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const gen = this.generation
    if (gen === undefined || gen.child.exitCode !== null) return
    const stopping = (async (): Promise<void> => {
      if (process.platform === 'win32') {
        const pid = gen.child.pid
        if (pid === undefined) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // taskkill never reported the tree gone; take the direct child at
            // least, so a wedged runtime cannot hold the client open.
            gen.child.kill()
            resolve()
          }, 3000)
          gen.child.once('exit', () => { clearTimeout(timer); resolve() })
          // Kill the tree BEFORE the direct child, never after. Signals cannot
          // be caught on Windows, and every descendant — the harness's shell
          // children, and the cmd.exe wrapper a user-installed `.cmd` shim is
          // spawned through — is reachable only by walking down from a parent
          // that is still alive. Terminating the parent first orphans the real
          // server, which then keeps its port with nothing left to find it by.
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
            .on('error', () => { gen.child.kill() })
        })
        return
      }
      gen.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { gen.child.kill('SIGKILL'); resolve() }, 3000)
        gen.child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    })()
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = undefined
    }
  }
}

let mainWindow: BrowserWindow | null = null
/** Whether a caller is waiting for the main window, as opposed to tray-only recovery. */
let mainWindowRequested = false
/** Whether the main window still shows the local loading document. */
let loadingDocumentActive = false
/** Invalidates delayed loading hints from an older startup/reconnect surface. */
let loadingHintGeneration = 0
/** Whether the main window shows the local connection-failure document. */
let errorDocumentActive = false
let settingsWindow: BrowserWindow | null = null
let settingsServerPort = 0
/** Bearer-like unguessable path: loopback binding alone is not authorization. */
const settingsServerPath = '/' + randomBytes(24).toString('hex') + '/'
let tray: Tray | null = null
let desktopUpdater: DesktopUpdater | undefined
let webUi: WebUiManager | undefined
const MAX_LAUNCH_RETRIES = 3
const INITIAL_RELAUNCH_DELAY_MS = 250
const STABLE_RUNTIME_RESET_MS = 60_000
let launchBudget = MAX_LAUNCH_RETRIES
let launchBudgetResetTimer: NodeJS.Timeout | undefined
let quitting = false
/**
 * Set when this quit is a restart, so the stop ladder also disposes of a
 * runtime the client adopted rather than spawned. Read only inside the
 * shutdown path: by then `quitting` already suppresses every recovery route,
 * so stopping the harness the window is pointed at cannot be mistaken for an
 * outage and answered with a second writer.
 */
let restarting = false
/**
 * Set from the moment a Windows installer is about to be handed this process
 * tree until the client exits. The relaunch ladder must not fire in that
 * window: the runtime was stopped on purpose, and a child respawned 250ms
 * later is precisely the orphan the stop exists to prevent — the installer
 * kills this app by name, which does not match a `node.exe` runtime child.
 * Cleared only when the installer turns out not to have started at all.
 */
let installerHandoff = false
/** Monotonic connection intent; stale probes/readiness callbacks cannot win. */
let connectionGeneration = 0
/** Avoid concurrent health probes and reload loops after sleep/wake churn. */
let windowRecoveryInFlight = false
let lastAutomaticReloadAt = 0
let windowHealthTimer: NodeJS.Timeout | undefined
const AUTOMATIC_RELOAD_COOLDOWN_MS = 30_000
const WINDOW_HEALTH_INTERVAL_MS = 60_000

/** Exponential delay derived from the number of retries already consumed. */
function relaunchDelayMs(remainingRetries: number): number {
  const attemptsConsumed = MAX_LAUNCH_RETRIES - remainingRetries
  return INITIAL_RELAUNCH_DELAY_MS * 2 ** Math.max(0, attemptsConsumed - 1)
}

/**
 * The official Web UI's default port. In smart mode (no explicit address) the
 * client first probes a locally running official instance on this port and
 * connects to it — the window and the browser then share ONE harness process,
 * so conversations (like the live one in the browser) sync in real time. Only
 * when nothing answers does the client launch its own local `dsh web`.
 */
function defaultWebProbeUrl(): string {
  return devOverride('DSH_DESKTOP_PROBE_URL') ?? 'http://127.0.0.1:3080'
}

/** Default origin plus any port the user pinned in the web profile's patch layer. */
function smartProbeUrls(): string[] {
  const patch = join(childHome(), 'profiles', WEB_PROFILE, 'cordis.patch.yml')
  let source: string
  try {
    source = readFileSync(patch, 'utf8')
  } catch {
    return [defaultWebProbeUrl()]
  }
  return webProbeOrigins(defaultWebProbeUrl(), source)
}

/** The first origin a real harness answers on, or undefined when none does. */
async function probeSmartTargets(): Promise<string | undefined> {
  const urls = smartProbeUrls()
  for (const url of urls) {
    const answered = await probeWebUi(url)
    if (answered !== undefined) return answered
  }
  // A busy instance answers slowly (its event loop is mid-request, a GC
  // pause, a plugin reload). One unanswered probe must not declare "nothing
  // running" and spawn a second harness beside a live one, so the WHOLE list
  // gets one short second pass before the fallback — a busy instance on the
  // fifth patch port deserves the same patience as one on the default. The
  // list is bounded by MAX_CONFIGURED_PORTS, and a non-listening loopback
  // port refuses instantly rather than spending the probe timeout.
  await new Promise(resolve => setTimeout(resolve, 300))
  for (const url of urls) {
    const answered = await probeWebUi(url, 1_000)
    if (answered !== undefined) return answered
  }
  return undefined
}

/** The current Web UI origin: the probed/configured address, or the local child's URL. */
let configuredTarget: string | undefined
/** True when configuredTarget came from the startup probe (not the settings). */
let probeConnected = false
let childTarget: string | undefined

function currentTarget(): string | undefined {
  return configuredTarget ?? childTarget
}

/**
 * The probe's transport. A configured remote can sit behind a proxy this
 * machine only reaches through the system settings, or behind a certificate
 * only the OS trust store knows — exactly what Node's fetch cannot see (see
 * `updaterFetch`), and a probe that always fails there would keep the blank-
 * window recovery from ever reloading a Connect-mode window. Chromium's stack
 * knows both, so a remote origin goes through net.fetch, with Node's fetch as
 * the fallback for whatever net refuses outright.
 *
 * Loopback keeps Node's fetch: nothing about a proxy or a CA applies to it,
 * and the smart-mode probe's answer must not start depending on the browser
 * stack's own headers, which the harness's trust fence reads.
 */
async function probeFetch(base: string, url: string, init: RequestInit): Promise<Response> {
  if (originIsLoopback(base) || !app.isReady()) return await fetch(url, init)
  try {
    // The probe asks a public question and needs no identity; the session's
    // cookies for that origin are not part of the question.
    return await net.fetch(url, { credentials: 'omit', ...init })
  } catch (error) {
    if (init.signal?.aborted === true) throw error
    return await fetch(url, init)
  }
}

/**
 * Probe one Web UI origin: a plain non-browser /api call (no browser markers,
 * so the trust fence passes over loopback). Returns the origin when a real
 * harness answers host.describe, undefined otherwise.
 */
async function probeWebUi(base: string, timeoutMs = 1_500): Promise<string | undefined> {
  try {
    const response = await probeFetch(base, base + '/api/host.describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-probe', method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      result?: {
        ok?: boolean
        value?: { version?: unknown; cwd?: unknown }
      }
    }
    if (body.result?.ok !== true) return undefined
    // `ok` alone is what ANY local HTTP server could say; the official
    // harness also describes itself. Requiring the describe core — the
    // version and working directory every describe implementation has
    // carried — keeps an unrelated process squatting on the port from being
    // adopted as the official instance (and handed loopback trust, with
    // every local detail and no confirmation dialogs) just by answering one
    // request. The check stays to these two fields on purpose: extra fields
    // have come and gone across upstream releases, and a shape drift must
    // degrade loudly (below), never silently stop adopting the user's own
    // running instance — which would start a second writer beside it.
    const value = body.result.value
    if (value === null || typeof value !== 'object') {
      console.warn('[desktop] host.describe answered ok without a describe value on ' + base + '; not adopting it')
      return undefined
    }
    if (typeof value.version !== 'string' || value.version === '' || typeof value.cwd !== 'string' || value.cwd === '') {
      console.warn('[desktop] host.describe on ' + base + ' lacks version/cwd; not adopting it as the official harness')
      return undefined
    }
    return new URL(base).origin
  } catch {
    return undefined
  }
}

/**
 * Allow binding and API initialization after the log line. The loading
 * surface tells the user a first launch can exceed 20 seconds (an antivirus
 * doing a full scan, a cold model cache), so the deadline matches that
 * promise rather than killing a child that is simply still booting.
 */
async function waitForWebUiReady(base: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await probeWebUi(base, 300) !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('dsh web reported readiness but did not accept API requests')
}

/**
 * Open external links in the system browser; never in a client window.
 * Parsed rather than prefix-matched: the scheme is what decides, and a prefix
 * test both misses `HTTPS://` and would accept a lookalike like
 * `http://x@evil` only by accident of spelling.
 */
function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(url)
}

/** The official Web UI origin (the window must stay inside it). */
function appOrigin(url: string): string {
  return originOf(url)
}

/** The official UI always renders visible text; an empty body after settling is a blank renderer. */
async function hasVisiblePageContent(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return true
  try {
    return await window.webContents.executeJavaScript(`(() => {
      const body = document.body
      if (document.readyState !== 'complete' || body === null) return true
      const rect = body.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (body.innerText || '').trim().length > 0
    })()`, true) as boolean
  } catch {
    return false
  }
}

/** Re-probe attempts before a probed instance is declared gone. */
const PROBED_FALLBACK_GRACE_ATTEMPTS = 3
const PROBED_FALLBACK_GRACE_INTERVAL_MS = 1_000
/** One recovery task at a time: overlapping grace windows double the probes. */
let probedFallbackInFlight = false
/** Automatic reloads against a probed instance, to cap a reload→fail loop. */
let probedRecoveryReloads = 0
const PROBED_RECOVERY_RELOAD_CAP = 2

/**
 * Whether a probed origin answers at least once across a short grace window.
 * "One probe that goes unanswered" is how a wrong port is dismissed; a live
 * instance is owed more patience than that.
 */
async function probeWithGrace(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < PROBED_FALLBACK_GRACE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, PROBED_FALLBACK_GRACE_INTERVAL_MS))
    if (await probeWebUi(base) !== undefined) return true
  }
  return false
}

/**
 * A probed instance misbehaved: a load failed, a health probe came back
 * empty. "Not answering" is not "not running" — the harness can be briefly
 * busy (a GC pause, a heavy request, a plugin reload) while fully alive, and
 * spawning a second writer beside a live one is exactly the corruption the
 * runtime lock exists to prevent. Re-probe across the grace window first;
 * only an origin that keeps failing gets the local-runtime fallback. When it
 * does answer, the window is rebuilt instead — bounded, so a server that
 * answers the API but cannot serve the page ends at the failure surface
 * rather than in a reload loop.
 */
async function handleProbedInstanceFailure(reason: string): Promise<void> {
  if (!probeConnected || quitting || probedFallbackInFlight) return
  probedFallbackInFlight = true
  try {
    const failedTarget = configuredTarget
    if (failedTarget === undefined) return
    const generation = connectionGeneration
    if (await probeWithGrace(failedTarget)) {
      if (generation !== connectionGeneration || !probeConnected || currentTarget() !== failedTarget) return
      if (probedRecoveryReloads >= PROBED_RECOVERY_RELOAD_CAP) {
        probedRecoveryReloads = 0
        console.warn('[desktop] probed Web UI keeps failing after recovery reloads (' + reason + ')')
        showConnectionError({ kind: 'load', url: failedTarget, code: 0, description: reason })
        return
      }
      probedRecoveryReloads += 1
      console.warn('[desktop] probed Web UI recovered (' + reason + '); reloading it')
      loadMainWindow(failedTarget, true)
      return
    }
    // The grace window is seconds long; the user may have switched to another
    // instance in the meantime. A stale failure must not tear down a target it
    // does not describe — the same generation guard the recovery path above
    // already carries.
    if (generation !== connectionGeneration || !probeConnected || currentTarget() !== failedTarget) return
    fallbackFromProbedInstance(reason)
  } finally {
    probedFallbackInFlight = false
  }
}

/**
 * Recover a renderer that went blank after a long idle or system resume.
 * Two DOM samples avoid reloading a page during a normal React transition;
 * the runtime probe prevents turning a temporary server outage into a loop.
 */
async function recoverBlankWindow(reason: string, force = false): Promise<void> {
  const window = mainWindow
  const target = currentTarget()
  if (window === null || target === undefined || window.isDestroyed() || quitting || windowRecoveryInFlight) return
  if (Date.now() - lastAutomaticReloadAt < AUTOMATIC_RELOAD_COOLDOWN_MS) return
  if (!force && (window.isMinimized() || !window.isVisible())) return

  windowRecoveryInFlight = true
  try {
    // A reused local instance is an optimization, not a durable dependency.
    // Probe it even while the renderer still contains stale visible content,
    // but with a grace window: a busy instance must not be replaced by a
    // second writer (see handleProbedInstanceFailure).
    if (probeConnected) {
      const generation = connectionGeneration
      if (!await probeWithGrace(target)) {
        if (generation === connectionGeneration && probeConnected && currentTarget() === target) {
          fallbackFromProbedInstance(reason)
        }
        return
      }
      // The instance is alive. A renderer that died or went blank is rebuilt
      // against the surviving origin — the same recovery the local branch
      // gets, so a probed instance is not stuck with a dead window.
      if (!force && await hasVisiblePageContent(window)) return
      if (!force) {
        await new Promise(resolve => setTimeout(resolve, 2_000))
        if (window !== mainWindow || await hasVisiblePageContent(window)) return
      }
      if (window !== mainWindow || window.isDestroyed()) return
      lastAutomaticReloadAt = Date.now()
      console.warn('[desktop] reloading blank Web UI (' + reason + ')')
      window.webContents.reload()
      return
    }
    if (!force && await hasVisiblePageContent(window)) return
    if (!force) {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      if (window !== mainWindow || await hasVisiblePageContent(window)) return
    }
    if (await probeWebUi(target) === undefined || window !== mainWindow || window.isDestroyed()) return

    lastAutomaticReloadAt = Date.now()
    console.warn('[desktop] reloading blank Web UI (' + reason + ')')
    window.webContents.reload()
  } finally {
    windowRecoveryInFlight = false
  }
}

/** Check only a visible window; hidden tray sessions must not be refreshed in the background. */
function scheduleWindowHealthCheck(reason: string, delayMs = 1_000): void {
  setTimeout(() => { void recoverBlankWindow(reason) }, delayMs).unref()
}

/** The official DeepSeek Harness logo: rounded-corner dark tile with the white glyph. */
const ICON_PNG = join(APP_DIR, 'resources', 'icon-app.png')
/** Windows taskbar variant: same tile with a larger glyph for small icon sizes. */
const WINDOW_ICON_PNG = process.platform === 'win32'
  ? join(APP_DIR, 'resources', 'icon-win.png')
  : ICON_PNG

/**
 * The logo as an inline data URI, or an empty tag when the resource cannot be
 * read: the first window is now on the startup path, so a missing icon must
 * degrade to a plain loading page rather than abort the launch.
 */
function loadingIconTag(): string {
  try {
    return '<img class="mark" alt="" src="data:image/png;base64,' + readFileSync(ICON_PNG).toString('base64') + '">'
  } catch (error) {
    console.warn('[desktop] loading icon unavailable:', error instanceof Error ? error.message : String(error))
    return ''
  }
}

/** The small first-paint surface shown while Smart mode resolves the Web UI. */
function loadingPageUrl(): string {
  const chinese = localeChinese()
  const title = chinese ? '正在启动 DeepSeek Harness' : 'Starting DeepSeek Harness'
  const detail = chinese ? '正在准备本地服务…' : 'Preparing the local service…'
  const hint = chinese ? '首次启动通常需要 10–20 秒' : 'The first launch usually takes 10–20 seconds'
  // The only connection seat reachable while the Web UI itself cannot load:
  // the official settings dialog (and its enhanced 连接 block) needs a page.
  const action = chinese ? 'Web UI 连接…' : 'Web UI connection…'
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + title + '</title><style>'
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0f1115}'
    + 'main{width:min(360px,calc(100vw - 48px));text-align:center}.mark{width:64px;height:64px;border-radius:16px;box-shadow:0 12px 32px rgba(15,17,21,.14)}'
    + 'h1{margin:22px 0 8px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}'
    + '#loading-status{margin:0;color:#6e7480;font-size:14px;line-height:22px}.hint{margin:8px 0 0;color:#9aa0a6;font-size:12px;line-height:18px}'
    + '.activity{height:20px;margin:20px auto 0;display:flex;justify-content:center;align-items:center;gap:6px}'
    // An author rule beats the UA stylesheet, so [hidden] needs restating here.
    + '.activity[hidden],.hint[hidden],.action[hidden]{display:none}'
    + '.action{margin:20px auto 0;display:block;font:inherit;font-size:13px;color:#0f1115;background:transparent;'
    + 'border:1px solid #d8d8d4;border-radius:28px;padding:7px 18px;cursor:pointer}'
    + '.action:hover{background:#f5f6f7}'
    + '.activity i{display:block;width:5px;height:5px;border-radius:50%;background:#0f1115;animation:pulse 1.2s ease-in-out infinite}'
    + '.activity i:nth-child(2){animation-delay:.16s}.activity i:nth-child(3){animation-delay:.32s}'
    + '@keyframes pulse{0%,70%,100%{opacity:.18;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)}}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}.mark{box-shadow:0 12px 32px rgba(0,0,0,.34)}#loading-status{color:#aeb3bb}.hint{color:#818791}.activity i{background:#f4f5f6}'
    + '.action{color:#f4f5f6;border-color:#3a3d42}.action:hover{background:#232529}}'
    + '@media(prefers-reduced-motion:reduce){.activity i{animation:none}.activity i:nth-child(2){opacity:.5}.activity i:nth-child(3){opacity:.8}}'
    + '</style></head><body><main>' + loadingIconTag()
    + '<h1>' + title + '</h1><p id="loading-status">' + detail + '</p><p class="hint">' + hint + '</p>'
    + '<div class="activity" aria-hidden="true"><i></i><i></i><i></i></div>'
    + '<button class="action" id="loading-action" type="button" hidden>' + action + '</button>'
    + '</main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** Reassure the user as a first launch moves beyond its usual 10–20 seconds. */
function scheduleLoadingHints(): void {
  const generation = ++loadingHintGeneration
  const chinese = localeChinese()
  const steps = chinese
    ? [
        [10_000, '正在初始化运行时，通常还需要几秒钟…'],
        [20_000, '仍在准备中，首次启动有时会超过 20 秒…'],
        [35_000, '正在等待本地服务就绪，请继续稍候…'],
      ] as const
    : [
        [10_000, 'Initializing the runtime — usually just a few more seconds…'],
        [20_000, 'Still preparing — the first launch can sometimes take over 20 seconds…'],
        [35_000, 'Waiting for the local service to become ready…'],
      ] as const
  for (const [delay, message] of steps) {
    setTimeout(() => {
      const window = mainWindow
      if (generation !== loadingHintGeneration || !loadingDocumentActive
        || window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
      void window.webContents.executeJavaScript(
        `document.querySelector('.hint')?.replaceChildren(${JSON.stringify(message)});`,
        true,
      ).catch(() => {})
    }, delay).unref()
  }
}

/**
 * Update the loading document's status line. The 'failed' state also withdraws
 * the activity indicator and the estimated-time hint: a launch that
 * cannot proceed must not keep animating, nor keep promising progress. It
 * reveals the connection button instead — with no page, the official settings
 * dialog (which now owns the connection form) cannot be reached.
 */
function updateLoadingStatus(chinese: string, english: string, state: 'busy' | 'failed' = 'busy'): void {
  const window = mainWindow
  // Not webContents.getURL(): it stays empty until the data document commits,
  // which is exactly when the first status update is issued. Electron holds
  // the script until the page stops loading, so an early call still lands.
  if (!loadingDocumentActive || window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
  const message = localeChinese() ? chinese : english
  const failed = String(state === 'failed')
  void window.webContents.executeJavaScript(
    `document.getElementById('loading-status')?.replaceChildren(${JSON.stringify(message)});`
    + `document.querySelector('.activity')?.toggleAttribute('hidden', ${failed});`
    + `document.querySelector('.hint')?.toggleAttribute('hidden', ${failed});`
    // The page's own CSP forbids inline script, so the click seat is bound
    // from here. onclick (not addEventListener) keeps repeat calls idempotent.
    + `(() => { const b = document.getElementById('loading-action'); if (b === null) return;`
    + ` b.hidden = !${failed};`
    + ` b.onclick = () => { window.desktop?.openConnectionSettings?.() } })();`,
    true,
  ).catch(() => {})
}

/** Escape untrusted text (an address, a server's status text) for the client's own documents. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => (
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;'
  ))
}

/** One connection failure, in the terms the error surface needs to describe it. */
type ConnectionFailure =
  /** Chromium never got a document: DNS, refused, timeout, TLS. */
  | { kind: 'load'; url: string; code: number; description: string }
  /** A document arrived, but it is the server's error page, not the Web UI. */
  | { kind: 'http'; url: string; status: number; statusText: string }
  /** The local runtime itself could not run. */
  | { kind: 'runtime'; headline: string; detail: string; recordPath?: string }

/**
 * Plain-language cause for a Chromium net error. The numbers are stable
 * (net_error_list.h) and the user cannot be expected to know any of them; what
 * they need is the one thing to change — scheme, port, certificate, network.
 */
function loadFailureHint(code: number, url: string, chinese: boolean): string {
  const secure = url.startsWith('https://')
  switch (code) {
    // CERT_COMMON_NAME_INVALID / DATE_INVALID / AUTHORITY_INVALID / REVOKED /
    // INVALID / WEAK_SIGNATURE_ALGORITHM / CERT_AUTHORITY_INVALID variants.
    case -200: case -201: case -202: case -203: case -204: case -206: case -207: case -208: case -501:
      return chinese
        ? '服务器的 TLS 证书不被信任，自签名证书最常见。请为该地址配置受信任的证书，或改用已签发证书的地址。'
        : 'The server’s TLS certificate is not trusted — a self-signed certificate is the usual cause. Install a trusted certificate for that address, or use one that already has one.'
    case -105:
      return chinese
        ? '域名无法解析。请检查地址拼写，以及本机的 DNS 或 VPN。'
        : 'The host name could not be resolved. Check the spelling, and this machine’s DNS or VPN.'
    case -102:
      return chinese
        ? '目标端口没有服务在监听。请确认服务端已启动，端口正确且防火墙已放行。'
        : 'Nothing is listening on that port. Check that the server is running, the port is right, and the firewall allows it.'
    case -7: case -21: case -118:
      return chinese
        ? '连接超时。请检查网络、代理设置，以及服务端是否仍在运行。'
        : 'The connection timed out. Check the network, any proxy, and whether the server is still running.'
    case -100: case -101: case -107:
      return secure
        ? (chinese
            ? '连接被中断。该端口可能并不提供 HTTPS，可尝试把地址改成 http://。'
            : 'The connection was closed. That port may not speak HTTPS — try http:// instead.')
        : (chinese
            ? '连接被中断。该端口可能只接受 HTTPS，可尝试把地址改成 https://。'
            : 'The connection was closed. That port may require HTTPS — try https:// instead.')
    case -106:
      return chinese ? '本机当前没有网络连接。' : 'This machine is offline.'
    default:
      return chinese
        ? '请确认地址、端口与网络可达后重试，或在连接设置中换一个地址。'
        : 'Check the address, the port, and network reachability, then retry — or set a different address in the connection settings.'
  }
}

/**
 * Plain-language cause for an HTTP status. The body behind such a status is
 * the SERVER's error page (nginx's, typically), which is exactly what must not
 * be handed to the user as if it were the app.
 */
function httpFailureHint(status: number, url: string, chinese: boolean): string {
  if (!url.startsWith('https://') && (status === 400 || status === 426 || status === 497)) {
    return chinese
      ? '服务器按明文 HTTP 拒绝了这次请求，该端口很可能只接受 HTTPS。请把地址改成 https:// 后重试。'
      : 'The server rejected the request as plaintext HTTP; that port most likely requires HTTPS. Change the address to https:// and retry.'
  }
  if (status === 401 || status === 403) {
    return chinese
      ? '服务器拒绝了这次访问。该地址可能需要登录，或不允许来自本机的请求。'
      : 'The server refused the request. That address may require a sign-in, or may not allow requests from this machine.'
  }
  if (status === 404) {
    return chinese
      ? '该地址上没有 Web UI。请确认端口与路径是否正确。'
      : 'There is no Web UI at that address. Check the port and the path.'
  }
  if (status >= 500) {
    return chinese
      ? '服务端返回了错误。请稍后重试，或检查服务端进程与反向代理的日志。'
      : 'The server returned an error. Retry later, or check the server process and reverse-proxy logs.'
  }
  return chinese
    ? '服务器返回的不是 Web UI 页面。请确认地址指向 dsh web 服务。'
    : 'The server did not return the Web UI. Check that the address points at a dsh web service.'
}

/**
 * The in-app connection-failure surface: the same visual language as the
 * loading page and the connection window. It replaces a native message box on
 * purpose — a modal dialog over an empty frame is the one thing a user cannot
 * work with, and a server's own 4xx/5xx page is not an interface either.
 */
function errorPageUrl(copy: {
  title: string
  hint: string
  addressLabel: string
  address: string
  reasonLabel: string
  reason: string
  retry: string
  settings: string
  quit: string
  /** Offered only when a pinned address failed: leave it for Smart mode. */
  useSmart?: string
  /** Lock / record path. Shown in full — a long DSH_HOME must not be sliced off. */
  recordLabel?: string
  recordPath?: string
}): string {
  const chinese = localeChinese()
  const fact = (label: string, value: string, limit?: number): string => {
    if (value === '') return ''
    const shown = limit === undefined ? value : value.slice(0, limit)
    return '<div class="fact"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(shown) + '</dd></div>'
  }
  const html = '<!doctype html><html lang="' + (chinese ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark"><title>' + escapeHtml(copy.title) + '</title><style>'
    + ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0f1115;padding:32px 24px}'
    + 'main{width:min(420px,100%);text-align:center}'
    + '.mark{width:64px;height:64px;border-radius:16px;box-shadow:0 12px 32px rgba(15,17,21,.14)}'
    + 'h1{margin:22px 0 0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}'
    + '.hint{margin:10px 0 0;color:#6e7480;font-size:14px;line-height:22px}'
    + '.facts{margin:22px 0 0;padding:12px 14px;text-align:left;border:1px solid #ebeef2;border-radius:12px;background:#fafbfc}'
    + '.fact{display:flex;gap:12px;font-size:13px;line-height:20px}.fact+.fact{margin-top:8px}'
    + 'dt{flex:0 0 auto;min-width:' + (chinese ? '32px' : '58px') + ';margin:0;color:#9aa0a6}'
    + 'dd{margin:0;min-width:0;color:#0f1115;word-break:break-all}'
    + '.actions{margin:24px 0 0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}'
    + 'button{white-space:nowrap;font:inherit;font-size:13px;font-weight:400;background:transparent;'
    + 'border:1px solid #d8d8d4;border-radius:28px;padding:7px 18px;color:#0f1115;cursor:pointer;transition:background .15s ease,opacity .15s ease}'
    + 'button:hover{background:#f5f6f7}'
    + 'button.primary{background:#0f1115;border-color:#0f1115;color:#fff}button.primary:hover{opacity:.88;background:#0f1115}'
    + 'button.ghost{border-color:transparent;color:#6e7480}'
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}'
    + '.mark{box-shadow:0 12px 32px rgba(0,0,0,.34)}.hint{color:#aeb3bb}'
    + '.facts{border-color:#2c2e33;background:#1e1f22}dt{color:#818791}dd{color:#f4f5f6}'
    + 'button{border-color:#3a3d42;color:#f4f5f6}button:hover{background:#232529}'
    + 'button.primary{background:#f4f5f6;border-color:#f4f5f6;color:#17181a}button.primary:hover{opacity:.88;background:#f4f5f6}'
    + 'button.ghost{border-color:transparent;color:#aeb3bb}}'
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
    + '</style></head><body><main>' + loadingIconTag()
    + '<h1>' + escapeHtml(copy.title) + '</h1>'
    + '<p class="hint">' + escapeHtml(copy.hint) + '</p>'
    + '<dl class="facts">'
    + fact(copy.addressLabel, copy.address, 300)
    + fact(copy.reasonLabel, copy.reason, 300)
    + fact(copy.recordLabel ?? '', copy.recordPath ?? '')
    + '</dl>'
    + '<div class="actions">'
    + '<button id="error-retry" class="primary" type="button">' + escapeHtml(copy.retry) + '</button>'
    + (copy.useSmart === undefined
      ? ''
      : '<button id="error-use-smart" type="button">' + escapeHtml(copy.useSmart) + '</button>')
    + '<button id="error-settings" type="button">' + escapeHtml(copy.settings) + '</button>'
    + '<button id="error-quit" class="ghost" type="button">' + escapeHtml(copy.quit) + '</button>'
    + '</div></main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/**
 * A failure raised while no window was open. This client is tray-resident, so
 * closing the window during a slow startup leaves the app running with nothing
 * to render into — and the runtime can fail after that. The failure waits here
 * and takes over the next window instead of being lost.
 */
let pendingConnectionFailure: { failure: ConnectionFailure; generation: number } | undefined

/**
 * Show the failure surface in the main window. One at a time: a single
 * navigation can raise both a load failure and a status, and the first
 * description is the one that explains it. Retry clears the flag.
 */
function showConnectionError(failure: ConnectionFailure): void {
  if (quitting) return
  const window = mainWindow
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) {
    reportConnectionFailureWithoutWindow(failure)
    return
  }
  if (errorDocumentActive) return
  const chinese = localeChinese()
  let title: string
  let hint: string
  let address = ''
  let reason: string
  if (failure.kind === 'runtime') {
    title = failure.headline
    reason = failure.detail
    hint = chinese
      ? '可以重试启动本地服务，或在连接设置中填写另一个可用的 Web UI 地址。'
      : 'Retry the local service, or set a different Web UI address in the connection settings.'
  } else if (failure.kind === 'http') {
    title = chinese ? '无法打开 Web UI' : 'The Web UI did not load'
    address = failure.url
    reason = 'HTTP ' + String(failure.status) + (failure.statusText === '' ? '' : ' ' + failure.statusText)
    hint = httpFailureHint(failure.status, failure.url, chinese)
  } else {
    title = chinese ? '无法连接 Web UI' : 'Could not reach the Web UI'
    address = failure.url
    reason = failure.description + ' (' + String(failure.code) + ')'
    hint = loadFailureHint(failure.code, failure.url, chinese)
  }

  errorDocumentActive = true
  loadingDocumentActive = false
  pagePrefersDark = undefined
  pageAppearanceMode = undefined
  void window.loadURL(errorPageUrl({
    title,
    hint,
    addressLabel: chinese ? '地址' : 'Address',
    address,
    reasonLabel: chinese ? '原因' : 'Reason',
    reason,
    retry: chinese ? '重试' : 'Retry',
    settings: chinese ? '连接设置…' : 'Connection settings…',
    quit: chinese ? '退出' : 'Quit',
    // Only a pinned address has a Smart mode to fall back to; a local runtime
    // that failed is already what Smart would have chosen.
    ...usesConfiguredServer(loadSettings()) && {
      useSmart: chinese ? '切换到智能模式' : 'Switch to Smart mode',
    },
    ...failure.kind === 'runtime' && failure.recordPath !== undefined && {
      recordLabel: chinese ? '记录文件' : 'Record',
      recordPath: failure.recordPath,
    },
  })).then(() => {
    if (window !== mainWindow || window.isDestroyed() || window.webContents.isDestroyed()) return
    // The page's own CSP forbids inline script, so the seats are bound from
    // here. onclick (not addEventListener) keeps repeat calls idempotent.
    void window.webContents.executeJavaScript(
      '(() => { const bind = (id, run) => { const b = document.getElementById(id); if (b !== null) b.onclick = run };'
      + ' bind("error-retry", () => { window.desktop?.local?.retry?.() });'
      + ' bind("error-use-smart", () => { window.desktop?.local?.useSmart?.() });'
      + ' bind("error-settings", () => { window.desktop?.openConnectionSettings?.() });'
      + ' bind("error-quit", () => { window.desktop?.local?.quit?.() }) })();',
      true,
    ).catch(() => {})
  }, () => {})
}

/**
 * The same failure, with no window to draw it in. An ownerless native dialog
 * is the only surface left — this is what the pre-error-page code did for
 * exactly this case, and dropping it made a tray-resident startup failure
 * silent. Opening the window renders the real error surface, because the
 * failure is held for it.
 */
function reportConnectionFailureWithoutWindow(failure: ConnectionFailure): void {
  if (pendingConnectionFailure !== undefined) return
  // Tagged with the attempt it describes. Any deliberate reconnection bumps
  // the generation, which retires this failure rather than letting it take
  // over the window the new attempt is opening.
  pendingConnectionFailure = { failure, generation: connectionGeneration }
  const chinese = localeChinese()
  const detail = failure.kind === 'runtime'
    ? failure.detail + (failure.recordPath === undefined
      ? ''
      : '\n\n' + (chinese ? '记录文件：' : 'Record: ') + failure.recordPath)
    : failure.url + '\n' + (failure.kind === 'http'
      ? 'HTTP ' + String(failure.status) + (failure.statusText === '' ? '' : ' ' + failure.statusText)
      : failure.description + ' (' + String(failure.code) + ')')
  void dialog.showMessageBox({
    type: 'error',
    title: 'Harness',
    message: failure.kind === 'runtime'
      ? failure.headline
      : (chinese ? '无法连接 Web UI' : 'Could not reach the Web UI'),
    detail,
    buttons: [
      chinese ? '显示主窗口' : 'Show Window',
      chinese ? '连接设置…' : 'Connection settings…',
      chinese ? '退出' : 'Quit',
    ],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    if (response === 0) showMainWindow()
    else if (response === 1) openSettingsWindow()
    else app.quit()
  }, () => {})
}

/** The failure surface's 重试: re-resolve the connection from the saved settings. */
function retryConnection(): void {
  if (quitting) return
  errorDocumentActive = false
  showLoadingDocument()
  updateLoadingStatus('正在重新连接…', 'Reconnecting…')
  resetRuntimeRecoveryBudget()
  applyConnectionSettings(loadSettings(), true)
}

const WINDOW_BG_DARK = '#17181a'
const WINDOW_BG_LIGHT = '#FFFFFF'

type AppearanceMode = 'system' | 'fixed'

/** Last OS app-theme reading taken while themeSource was still following the system. */
let osPrefersDark = nativeTheme.shouldUseDarkColors
/** Official page paint, once the renderer has reported it. */
let pagePrefersDark: boolean | undefined
/** Official appearance control: pin only for an explicit light/dark choice. */
let pageAppearanceMode: AppearanceMode | undefined
/** themeSource writes emit 'updated'; ignore that echo so we do not loop. */
let applyingThemeSource = false

function effectiveWindowDark(): boolean {
  if (pageAppearanceMode === 'fixed') return pagePrefersDark ?? osPrefersDark
  return osPrefersDark
}

function windowBackgroundColor(): string {
  return effectiveWindowDark() ? WINDOW_BG_DARK : WINDOW_BG_LIGHT
}

function applyWindowBackground(window: BrowserWindow | null, dark: boolean): void {
  if (window === null || window.isDestroyed()) return
  window.setBackgroundColor(dark ? WINDOW_BG_DARK : WINDOW_BG_LIGHT)
}

function paintWindowBackgrounds(): void {
  const dark = effectiveWindowDark()
  applyWindowBackground(mainWindow, dark)
  applyWindowBackground(settingsWindow, dark)
}

function refreshOsPrefersDark(): void {
  if (nativeTheme.themeSource === 'system') osPrefersDark = nativeTheme.shouldUseDarkColors
}

/**
 * Windows title bar follows Chromium's NativeTheme, not setBackgroundColor.
 * Pin themeSource only when the official control is an explicit light/dark
 * choice. "Follow system" must stay on 'system' so matchMedia still sees
 * the real OS — comparing painted color to OS is how the previous pin
 * wedged that mode.
 */
function syncThemeSource(): void {
  const want: typeof nativeTheme.themeSource = pageAppearanceMode === 'fixed'
    ? ((pagePrefersDark ?? osPrefersDark) ? 'dark' : 'light')
    : 'system'
  if (nativeTheme.themeSource === want) return
  applyingThemeSource = true
  nativeTheme.themeSource = want
  setImmediate(() => {
    applyingThemeSource = false
    refreshOsPrefersDark()
    paintWindowBackgrounds()
    if (want !== 'system' || mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('desktop:theme:refresh')
  })
}

function syncWindowBackgrounds(): void {
  if (applyingThemeSource) return
  refreshOsPrefersDark()
  paintWindowBackgrounds()
  syncThemeSource()
}

function onRendererTheme(event: Electron.IpcMainEvent, payload: unknown): void {
  if (!bridgeCaller(event).trusted) return
  if (typeof payload !== 'object' || payload === null) return
  const body = payload as { dark?: unknown; mode?: unknown }
  if (typeof body.dark !== 'boolean') return
  const mode: AppearanceMode = body.mode === 'fixed' ? 'fixed' : 'system'
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window === mainWindow) {
    pagePrefersDark = body.dark
    pageAppearanceMode = mode
    syncThemeSource()
  }
  applyWindowBackground(window, effectiveWindowDark())
}

/** Native right-click menu for page content: copy selection, edit fields, links, images. */
function installPageContextMenu(contents: Electron.WebContents): void {
  contents.on('context-menu', (_event, params) => {
    if (contents.isDestroyed()) return
    const chinese = localeChinese()
    const template: Electron.MenuItemConstructorOptions[] = []
    const addSeparator = (): void => {
      if (template.length > 0 && template[template.length - 1]?.type !== 'separator') {
        template.push({ type: 'separator' })
      }
    }
    if (params.isEditable) {
      template.push(
        { label: chinese ? '撤销' : 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: params.editFlags.canUndo, click: () => { contents.undo() } },
        { label: chinese ? '重做' : 'Redo', accelerator: process.platform === 'darwin' ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y', enabled: params.editFlags.canRedo, click: () => { contents.redo() } },
        { type: 'separator' },
        { label: chinese ? '剪切' : 'Cut', accelerator: 'CmdOrCtrl+X', enabled: params.editFlags.canCut, click: () => { contents.cut() } },
        { label: chinese ? '复制' : 'Copy', accelerator: 'CmdOrCtrl+C', enabled: params.editFlags.canCopy, click: () => { contents.copy() } },
        { label: chinese ? '粘贴' : 'Paste', accelerator: 'CmdOrCtrl+V', enabled: params.editFlags.canPaste, click: () => { contents.paste() } },
        { label: chinese ? '全选' : 'Select All', accelerator: 'CmdOrCtrl+A', enabled: params.editFlags.canSelectAll, click: () => { contents.selectAll() } },
      )
    } else {
      template.push(
        { label: chinese ? '复制' : 'Copy', accelerator: 'CmdOrCtrl+C', enabled: params.editFlags.canCopy, click: () => { contents.copy() } },
        { label: chinese ? '全选' : 'Select All', accelerator: 'CmdOrCtrl+A', enabled: params.editFlags.canSelectAll, click: () => { contents.selectAll() } },
      )
    }
    if (params.linkURL !== '') {
      addSeparator()
      template.push(
        { label: chinese ? '打开链接' : 'Open Link', click: () => { openExternal(params.linkURL) } },
        { label: chinese ? '复制链接' : 'Copy Link', click: () => { clipboard.writeText(params.linkURL) } },
      )
    }
    if (params.mediaType === 'image') {
      addSeparator()
      template.push({
        label: chinese ? '复制图片' : 'Copy Image',
        click: () => { contents.copyImageAt(params.x, params.y) },
      })
    }
    const window = BrowserWindow.fromWebContents(contents)
    if (window === null || window.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window, x: params.x, y: params.y })
  })
}

/** Create the client window immediately; the official Web UI replaces its loading surface when ready. */
function createWindow(): void {
  let targetNavigationSucceeded = false
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'Harness',
    backgroundColor: windowBackgroundColor(),
    // The official Web UI carries its own header; a hiddenInset title bar
    // would overlap it. The standard title bar keeps the traffic lights away
    // from the page on macOS and renders the official icon on Windows/Linux.
    titleBarStyle: 'default',
    icon: WINDOW_ICON_PNG,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  installPageContextMenu(mainWindow.webContents)
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })
  mainWindow.on('show', () => { scheduleWindowHealthCheck('window shown') })
  mainWindow.on('focus', () => { scheduleWindowHealthCheck('window focused') })
  mainWindow.on('closed', () => {
    mainWindow = null
    mainWindowRequested = false
    loadingDocumentActive = false
    errorDocumentActive = false
  })
  // The official Web UI is loaded; anything it tries to open elsewhere goes
  // to the system browser, and no new windows exist.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // The window must stay inside the active Web UI origin. Both events matter:
  // will-navigate covers a navigation the page starts, will-redirect covers the
  // server-side 30x that follows one — an open redirect on the target origin
  // would otherwise land a third-party document in the window that carries the
  // desktop preload. Unknown target = deny: during startup and reconnection
  // there is no origin to be inside of.
  const guardNavigation = (event: Electron.Event, targetUrl: string): void => {
    // The client's own loading and failure surfaces are data: documents, and
    // they arrive through loadURL, which emits no navigation event at all.
    // Chromium already refuses a page-initiated top-level data: navigation, so
    // this branch is a second lock on a door the engine keeps shut: allow only
    // while one of those surfaces is the one on screen, and never hand a data:
    // URL to the system browser.
    if (targetUrl.startsWith('data:')) {
      if (loadingDocumentActive || errorDocumentActive) return
      event.preventDefault()
      return
    }
    const allowedTarget = currentTarget()
    if (allowedTarget !== undefined && appOrigin(targetUrl) === appOrigin(allowedTarget)) return
    // Follow the configured server's own HTTPS upgrade rather than bouncing
    // the user to a browser: the target moves with it, so the bridge's origin
    // check keeps matching the document actually on screen.
    if (allowedTarget !== undefined && configuredTarget === allowedTarget && isSecureUpgrade(allowedTarget, targetUrl)) {
      configuredTarget = appOrigin(targetUrl)
      console.log('[desktop] target upgraded to HTTPS: ' + configuredTarget)
      return
    }
    event.preventDefault()
    openExternal(targetUrl)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  // will-navigate is main-frame only, but will-redirect fires for every frame.
  // Guarding sub-frames would cancel an ordinary cross-origin 302 inside an
  // iframe — an OAuth callback, an embedded preview — and pop the system
  // browser for it. Only the top frame carries the preload, so only the top
  // frame is what this guard is protecting.
  mainWindow.webContents.on('will-redirect', (event, targetUrl, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    guardNavigation(event, targetUrl)
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) targetNavigationSucceeded = false
  })
  // An unreachable Web UI (connect mode) must not strand the user: offer
  // retry or the connection-settings window.
  mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || quitting || code === -3 || failedUrl.startsWith('data:')) return // -3 = ERR_ABORTED
    if (probeConnected && appOrigin(failedUrl) === appOrigin(currentTarget() ?? '')) {
      // Re-probe before falling back: a live-but-briefly-busy instance must
      // not get a second writer spawned beside it.
      void handleProbedInstanceFailure('load failed: ' + description)
      return
    }
    // A mode change can leave one late failure event from the old origin.
    if (appOrigin(failedUrl) !== appOrigin(currentTarget() ?? '')) return
    showConnectionError({ kind: 'load', url: failedUrl, code, description })
  })
  // A 4xx/5xx navigation is NOT a load failure to Chromium: the response has a
  // body, so the window would otherwise display the server's own error page
  // (an nginx "400 The plain HTTP request was sent to HTTPS port", say) as if
  // it were the app, with no way back. The status is the failure.
  mainWindow.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    const target = currentTarget()
    if (!quitting && !url.startsWith('data:') && httpResponseCode < 400
      && target !== undefined && appOrigin(url) === appOrigin(target)) {
      targetNavigationSucceeded = true
      probedRecoveryReloads = 0
    }
    if (quitting || url.startsWith('data:') || httpResponseCode < 400) return
    if (target === undefined || appOrigin(url) !== appOrigin(target)) return
    if (probeConnected) {
      // A 4xx/5xx response PROVES the instance is alive: it just answered.
      // Falling back would spawn a second writer beside a live harness, so
      // the failure surface with a retry is the honest surface instead; the
      // health probe still falls back when the instance actually dies.
      showConnectionError({ kind: 'http', url, status: httpResponseCode, statusText: httpStatusText })
      return
    }
    showConnectionError({ kind: 'http', url, status: httpResponseCode, statusText: httpStatusText })
  })
  // Updating is background work, not part of getting the runtime onto the
  // screen. Wait until the official Web UI has actually loaded: local mode
  // reaches this only after dsh readiness, and Connect mode only after its
  // configured page responds. Reloads and reconnects are deduplicated by the
  // scheduler below.
  mainWindow.webContents.on('did-finish-load', () => {
    if (!targetNavigationSucceeded) return
    const target = currentTarget()
    if (target === undefined) return
    const loaded = mainWindow?.webContents.getURL() ?? ''
    if (appOrigin(loaded) === appOrigin(target)) {
      webUiEverLoaded = true
      scheduleAutoUpdateCheck()
    }
  })
  // Chromium may lose its renderer after sleep or resource pressure without a
  // did-fail-load event. Reloading the surviving Web UI origin recreates it.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[desktop] renderer process gone:', details.reason, details.exitCode)
    void recoverBlankWindow('renderer ' + details.reason, true)
  })
  let rendererUnresponsive = false
  mainWindow.on('unresponsive', () => {
    rendererUnresponsive = true
    setTimeout(() => {
      if (rendererUnresponsive) void recoverBlankWindow('renderer unresponsive', true)
    }, 30_000).unref()
  })
  mainWindow.on('responsive', () => { rendererUnresponsive = false })
  loadingDocumentActive = true
  errorDocumentActive = false
  pagePrefersDark = undefined
  pageAppearanceMode = undefined
  void mainWindow.loadURL(loadingPageUrl()).catch(() => {})
  scheduleLoadingHints()
}

/**
 * Navigate the existing loading/client window to one official Web UI origin.
 * `force` marks a reconnect the user explicitly asked for: startup resolves to
 * the origin already on screen all the time and must not reload it, but
 * "保存并连接" resolving to the same origin has to rebuild the session anyway —
 * doing nothing leaves the card's "正在重连…" note true forever.
 */
function loadMainWindow(url: string, force = false): void {
  if (mainWindow === null) createWindow()
  if (mainWindow === null) return
  if (appOrigin(mainWindow.webContents.getURL()) === appOrigin(url)) {
    if (!force) return
    mainWindow.webContents.reload()
    return
  }
  loadingDocumentActive = false
  errorDocumentActive = false
  void mainWindow.loadURL(url).catch(() => { /* did-fail-load owns user recovery */ })
}

/** The small connection-settings window (menu → "Web UI 连接…"). */
function openSettingsWindow(): void {
  if (settingsWindow !== null) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 660,
    title: '连接设置',
    // Without this the window keeps Electron's own default icon in its title
    // bar and taskbar entry — the one place the client still looked like a
    // generic Electron app.
    icon: WINDOW_ICON_PNG,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  installPageContextMenu(settingsWindow.webContents)
  settingsWindow.on('closed', () => { settingsWindow = null })
  // The page carries links now — the ones inside rendered release notes — and
  // they must leave for the system browser rather than do nothing at all. The
  // window itself still never navigates anywhere (see will-navigate below).
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  settingsWindow.webContents.on('will-navigate', (event, targetUrl) => {
    // Compare parsed origin + path prefix rather than the raw string: a prefix
    // test on the whole URL is decided by spelling (`...token/x` vs a
    // credential-prefixed lookalike), not by where the request actually goes.
    const allowed = new URL('http://127.0.0.1:' + String(settingsServerPort) + settingsServerPath)
    try {
      const target = new URL(targetUrl)
      if (target.origin === allowed.origin && target.pathname.startsWith(allowed.pathname)) return
    } catch { /* unparseable: deny below */ }
    event.preventDefault()
  })
  void settingsWindow.loadURL('http://127.0.0.1:' + String(settingsServerPort) + settingsServerPath)
}

/**
 * The tray (menu-bar) seat: closing the window keeps the client running.
 * macOS and Windows agree on the gesture — left-click reopens the window,
 * right-click shows the menu. Only the way the menu is attached differs, and
 * Linux (AppIndicator) delivers no click event at all, so there the menu is
 * the whole interaction.
 */
function createTray(): void {
  // macOS recolours a Template image to match the menu bar automatically.
  // Windows renders the source pixels as-is. Always use the white glyph there:
  // nativeTheme follows the app colour mode, which can be light while the
  // Windows taskbar is dark, and would otherwise select an unreadable black
  // icon for that supported mixed-theme configuration.
  const icon = trayImage()
  if (icon.isEmpty()) return
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  // Windows emits this too, and used to have nobody listening: a left-click on
  // the notification-area icon did nothing at all, and the window could only be
  // reached through the right-click menu. A double-click emits two clicks plus
  // this event, and showMainWindow is idempotent, so both gestures are safe.
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  if (process.platform === 'darwin') {
    tray.on('right-click', () => { tray?.popUpContextMenu(Menu.buildFromTemplate(trayMenuTemplate())) })
  }
  // Moving the window to a display with different scaling, or changing the
  // scaling itself, changes the notification-area slot size. Without this the
  // icon rendered for the old slot stays and gets stretched by the shell.
  if (process.platform === 'win32') {
    screen.on('display-metrics-changed', () => {
      if (tray === null || tray.isDestroyed()) return
      const next = trayImage()
      if (!next.isEmpty()) tray.setImage(next)
    })
  }
  refreshTrayMenu()
}

/**
 * Windows notification-area icon sizes, in device pixels: the slot is
 * SM_CXSMICON, which is 16 at 100% scaling and grows with it (20 at 125%,
 * 24 at 150%, 32 at 200%). One rendered file per slot, so the shell has an
 * exact-size icon to draw instead of a stretched 16px one — Windows takes the
 * 1x representation of a NativeImage and scales it up, which is what made the
 * tray icon look soft on every display above 100%.
 *
 * Rendered from resources/icon.svg by scripts/make-tray-icons.cjs; that list
 * and this one have to stay in step.
 */
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48] as const

/** The rendered size for the current display scale, snapped up to a real file. */
function trayIconSize(): number {
  let scale = 1
  try {
    scale = screen.getPrimaryDisplay().scaleFactor
  } catch {
    // Called before the screen module is usable: 16px is the 100% slot.
  }
  const wanted = Math.round(16 * (Number.isFinite(scale) && scale > 0 ? scale : 1))
  // Above the largest rendered size (400% scaling and beyond), the biggest file
  // is still the closest fit the shell can be given.
  return TRAY_ICON_SIZES.find(size => size >= wanted) ?? 48
}

function trayImage(): Electron.NativeImage {
  if (process.platform !== 'win32') {
    // macOS recolours a Template image to match the menu bar, and reads the @2x
    // companion beside it for Retina; nothing to choose per display here.
    return nativeImage.createFromPath(join(APP_DIR, 'resources', 'iconMenuTemplate.png'))
  }
  const size = trayIconSize()
  const exact = nativeImage.createFromPath(join(APP_DIR, 'resources', 'iconTray-' + String(size) + '.png'))
  if (!exact.isEmpty()) return exact
  // A resource set older than this code: the 16px glyph still shows an icon.
  return nativeImage.createFromPath(join(APP_DIR, 'resources', 'iconTrayWhite.png'))
}

function trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const state = desktopUpdater?.getState()
  const updateLabel = state?.phase === 'available' && state.info !== null && !state.dismissed
    ? (localeChinese() ? '更新到 v' : 'Update to v') + state.info.availableVersion
    : (localeChinese() ? '检查更新…' : 'Check for Updates…')
  return [
    { label: localeChinese() ? '显示主窗口' : 'Show Window', click: showMainWindow },
    { label: updateLabel, click: () => { void handleManualUpdateCheck(true) } },
    { type: 'separator' },
    { label: localeChinese() ? '重启客户端' : 'Restart', click: restartApp },
    { label: localeChinese() ? '退出' : 'Quit', click: () => { app.quit() } },
  ]
}

/**
 * Restart the whole client. A plugin that only takes effect on a fresh runtime
 * needs the harness replaced, not the page reloaded, and this is the one
 * gesture that does both without the user hunting for the app again.
 *
 * `relaunch` hands the successor to Electron's relauncher helper, which waits
 * for this process to exit before spawning — so `before-quit` still runs the
 * stop ladder, and the single-instance lock is free by the time the new
 * instance asks for it.
 *
 * Refused during the Windows installer handoff: `installerHandoff` is set
 * seconds before that quit lands, and a successor started into a half-written
 * installation is exactly the damage no relaunch can repair.
 */
function restartApp(): void {
  if (quitting || installerHandoff) return
  restarting = true
  app.relaunch()
  app.quit()
}

/**
 * Stop a runtime this client adopted rather than spawned, so that a restart
 * really does restart the harness. Without this the successor's startup probe
 * finds the same instance still serving, adopts it again, and the plugin the
 * user restarted for is still not loaded.
 *
 * Which runtimes qualify is decided by `restartDisposition`, where the rules
 * and their reasons live; this reads the state it needs, pays for the identity
 * check only once the cheap clauses have passed, and carries out the verdict.
 */
async function stopAdoptedRuntimeForRestart(): Promise<void> {
  const home = childHome()
  const lock = readRuntimeLock(home)
  const state = {
    adopted: probeConnected,
    targetOrigin: appOrigin(currentTarget() ?? ''),
    lock,
    ownedChildPid: webUi?.pid(),
    pidAlive: lock !== undefined && isProcessAlive(lock.childPid),
  }
  if (lock === undefined || restartDisposition(state) !== 'verify') return
  const verdict: PidVerdict = await pidVerdictForLockedChild(lock)
  if (restartDisposition({ ...state, verdict }) !== 'stop') {
    console.warn('[desktop] restart: cannot verify the adopted runtime (PID ' + String(lock.childPid)
      + '); leaving it running — the new instance will adopt it again')
    return
  }
  console.warn('[desktop] restart: stopping the adopted runtime (PID ' + String(lock.childPid) + ')')
  // The record stays on a failed kill, for the reason the adoption path
  // documents: the next start must not spawn beside a writer nobody stopped.
  if (await terminateProcessTree(lock.childPid)) clearRuntimeLock(home)
}

function refreshTrayMenu(): void {
  if (tray === null) return
  const state = desktopUpdater?.getState()
  const tip = state?.phase === 'available' && state.info !== null && !state.dismissed
    ? 'DeepSeek Harness · v' + state.info.availableVersion
    : 'DeepSeek Harness'
  tray.setToolTip(tip)
  const menu = Menu.buildFromTemplate(trayMenuTemplate())
  if (process.platform === 'darwin') return
  tray.setContextMenu(menu)
}

/**
 * The connection facts shared by the settings server and the IPC bridge.
 * `includeLocalDetail` is false for a remote page: the child's pid and the
 * runtime's last error (which carries local paths) describe this machine, and
 * a configured remote origin has no business reading them.
 */
function getStatusJson(includeLocalDetail = true): Record<string, unknown> {
  const settings = loadSettings()
  const savedServerUrl = normalizeServerUrl(settings.serverUrl)
  return {
    mode: probeConnected ? 'probe' : configuredTarget !== undefined ? 'connect' : 'local',
    targetUrl: currentTarget() ?? '',
    desktopVersion: desktopClientVersion(),
    dshVersion: bundledDshVersion(),
    // NOT gated by includeLocalDetail: in Connect mode the saved address IS
    // the caller's own origin (targetUrl is not redacted either), so hiding
    // it yields no privacy — while the connection card treats this field as
    // the editable address and probes to fill it when empty, so an empty
    // value breaks the card and can be overwritten by a probe offer.
    savedServerUrl: savedServerUrl ?? '',
    selectedMode: usesConfiguredServer(settings) ? 'connect' : 'smart',
    canSwitch: savedServerUrl !== undefined,
    ...includeLocalDetail && webUi?.pid() !== undefined && { childPid: webUi.pid() },
    ...includeLocalDetail && webUi?.lastError !== null && webUi?.lastError !== undefined && { lastError: webUi.lastError },
    // Which dsh the local child came from. Names a path on this machine, so it
    // travels under the same rule as the pid and the runtime error.
    ...includeLocalDetail && webUi?.lastSource !== undefined && { runtimeSource: webUi.lastSource },
    ...includeLocalDetail && installedDsh !== undefined && !installedDshRejected
      && { installedDshVersion: installedDsh.version },
    // A cache lagging the bundled runtime is a note, not a veto: the cache
    // stays selected, and re-running npx is how the user updates it.
    ...includeLocalDetail && installedDsh !== undefined && !installedDshRejected && npxCacheOutdated
      && { npxCacheOutdated: true },
  }
}

/**
 * Whether an official Web UI is answering on the default port right now. The
 * connection surfaces offer the result as a ready-made address, so switching
 * to an instance the user just started is one click instead of typing it.
 */
async function probeDefaultWebUi(): Promise<{ url: string | null }> {
  return { url: await probeWebUi(defaultWebProbeUrl()) ?? null }
}

/** Who is calling the desktop bridge, from the main process's point of view. */
interface BridgeCaller {
  /** The main window's top frame, showing an origin this client itself selected. */
  trusted: boolean
  /** That origin is a configured remote, not one of the client's own loopback surfaces. */
  remote: boolean
}

const UNTRUSTED_CALLER: BridgeCaller = { trusted: false, remote: true }

/**
 * Resolve an IPC sender to a trust decision. The preload rides on whatever the
 * window loads, and in Connect mode that is an address the user typed — a page
 * served there must not be able to silently repoint the client or start an
 * installer. Only the main window's TOP frame, showing the origin the client
 * currently targets (or the client's own loading document), may drive the
 * bridge; a remote origin that does is additionally treated as remote, which
 * costs it the local details and adds a native confirmation to state changes.
 */
function bridgeCaller(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BridgeCaller {
  if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return UNTRUSTED_CALLER
  let frameUrl: string
  try {
    const frame = event.senderFrame
    // Sub-frames do not receive this preload today; deny explicitly so that
    // stays true if nodeIntegrationInSubFrames is ever turned on.
    if (frame === null || frame.parent !== null) return UNTRUSTED_CALLER
    frameUrl = frame.url
  } catch {
    // The frame was destroyed between send and dispatch.
    return UNTRUSTED_CALLER
  }
  if (frameUrl.startsWith('data:')) return { trusted: loadingDocumentActive || errorDocumentActive, remote: false }
  const target = currentTarget()
  const origin = appOrigin(frameUrl)
  if (target === undefined || origin === '' || origin !== appOrigin(target)) return UNTRUSTED_CALLER
  return { trusted: true, remote: !originIsLoopback(origin) }
}

function bridgeDenied(): Error {
  return new Error('desktop bridge: sender is not the active Web UI')
}

/**
 * Whether the sender is one of the client's OWN local documents — the data:
 * loading and connection-failure surfaces in the main window. Reconnecting and
 * quitting are reachable only from there: the same preload rides on a remote
 * page in Connect mode, and that page has no business restarting the client's
 * connection or ending the application.
 */
function localDocumentCaller(event: Electron.IpcMainEvent): boolean {
  if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  if (!loadingDocumentActive && !errorDocumentActive) return false
  try {
    const frame = event.senderFrame
    if (frame === null || frame.parent !== null) return false
    return frame.url.startsWith('data:')
  } catch {
    // The frame was destroyed between send and dispatch.
    return false
  }
}

/** Replace the current page with the local startup surface before recovery. */
function showLoadingDocument(): void {
  const window = mainWindow
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
  loadingDocumentActive = true
  errorDocumentActive = false
  pagePrefersDark = undefined
  pageAppearanceMode = undefined
  void window.loadURL(loadingPageUrl()).catch(() => {})
  scheduleLoadingHints()
}

let cachedDesktopVersion: string | undefined

/** The desktop shell version is independent from Electron and dsh versions. */
function desktopClientVersion(): string {
  if (cachedDesktopVersion !== undefined) return cachedDesktopVersion
  try {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { version?: unknown }
    cachedDesktopVersion = typeof manifest.version === 'string' ? manifest.version : app.getVersion()
  } catch {
    cachedDesktopVersion = app.getVersion()
  }
  return cachedDesktopVersion
}

let cachedBundledDshVersion: string | null | undefined

/** Version of the official runtime shipped with this desktop release. */
function bundledDshVersion(): string | null {
  if (cachedBundledDshVersion !== undefined) return cachedBundledDshVersion
  const bin = resolveBundledDsh()?.binPath
  if (bin === undefined) return (cachedBundledDshVersion = null)
  try {
    const manifest = JSON.parse(readFileSync(join(bin, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    cachedBundledDshVersion = typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    cachedBundledDshVersion = null
  }
  return cachedBundledDshVersion
}

function loadUpdatePersistence(): { dismissedVersion?: string; lastCheckedAt?: number } {
  const settings = loadSettings()
  return {
    ...settings.updateDismissedVersion !== undefined && { dismissedVersion: settings.updateDismissedVersion },
    ...settings.updateLastCheckedAt !== undefined && { lastCheckedAt: settings.updateLastCheckedAt },
  }
}

function saveUpdatePersistence(next: { dismissedVersion?: string; lastCheckedAt?: number }): void {
  const unset: (keyof ClientSettings)[] = []
  if (next.dismissedVersion === undefined) unset.push('updateDismissedVersion')
  patchSettings({
    ...next.dismissedVersion !== undefined && { updateDismissedVersion: next.dismissedVersion },
    ...next.lastCheckedAt !== undefined && { updateLastCheckedAt: next.lastCheckedAt },
  }, unset)
}

/**
 * The updater's transport. Node's own fetch talks to the network directly: it
 * ignores the system proxy (and any PAC script) and trusts only its built-in CA
 * list. That is how a Windows machine could read the update feed — the API host
 * it happens to reach — and then fail the installer download with a bare "fetch
 * failed", since the release assets live on a different host that only the
 * configured proxy or the OS trust store can reach.
 *
 * Chromium's stack knows all of that, so net.fetch goes first. Node's fetch
 * stays as the fallback for whatever net refuses outright, and the fallback is
 * skipped once the caller has aborted — a timeout must not start a second
 * request behind it.
 */
const updaterFetch: typeof fetch = async (input, init) => {
  const target = input instanceof URL ? input.href : input
  try {
    // Chromium's stack owns a cookie jar; Node's fetch does not. An update feed
    // and an installer download need no identity, so the transport swap must
    // not start sending the session's cookies to GitHub.
    return await net.fetch(target as string | Request, { credentials: 'omit', ...init })
  } catch (error) {
    if (init?.signal?.aborted === true) throw error
    console.log('[desktop] update transport fell back to node fetch: ' + describeFetchError(error))
    return await fetch(input, init)
  }
}

function createDesktopUpdater(): DesktopUpdater {
  // Same gate as devOverride(): the packaged client keeps its own feed, its own
  // timeouts, and its own answer to "should I check at all".
  const allowEnvOverrides = !app.isPackaged || process.env.DSH_DESKTOP_ALLOW_UNSAFE === '1'
  return new DesktopUpdater({
    fetchImpl: updaterFetch,
    currentVersion: desktopClientVersion(),
    feedUrl: defaultUpdateFeedUrl(allowEnvOverrides),
    githubApiUrl: defaultGithubApiUrl(allowEnvOverrides),
    allowEnvOverrides,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    downloadDir: join(clientHome(), 'updates'),
    loadPersistence: loadUpdatePersistence,
    savePersistence: saveUpdatePersistence,
    dryRun: devFlag('DSH_DESKTOP_UPDATE_DRY_RUN'),
    // The runtime must not outlive this app into the installer's process
    // sweep, and must not die before the download that may never succeed.
    // Both constraints meet at exactly this point in the install.
    //
    // Only Windows has that sweep. macOS and Linux open the image and let the
    // person replace the app themselves, and the ordinary quit path already
    // stops the runtime — stopping here would leave them with a dead runtime
    // every time they answer "Later" to the replace prompt.
    onBeforeInstall: async () => {
      if (process.platform !== 'win32') return
      installerHandoff = true
      await webUi?.stop()
    },
  })
}

let lastTrayUpdateSignature = ''

/**
 * The update state as a remote page may see it. `error` is whatever the
 * download, the SHA-256 check, or the installer threw, and those routinely
 * name absolute paths on this machine; `phase` already tells the page that
 * something failed, and the card falls back to its own wording when the
 * reason is absent. Same rule as `getStatusJson`'s `includeLocalDetail`.
 */
function updateStateForCaller(state: UpdateState, remote: boolean): UpdateState {
  if (!remote || state.error === null) return state
  return { ...state, error: null }
}

/**
 * Whether the document in the main window is a remote origin. The push channel
 * has no sender to inspect, so it reads the URL actually loaded rather than the
 * target the client is aiming at: during a mode switch the window still shows
 * the old remote page after `currentTarget()` has already moved, and that page
 * is the one about to receive the broadcast. The client's own data: surfaces
 * carry no origin and are not remote.
 */
function mainWindowShowsRemote(): boolean {
  if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false
  const url = mainWindow.webContents.getURL()
  // A data: document serializes its opaque origin as the string "null", not
  // an empty one — spell that out rather than letting it fall through as an
  // origin that merely fails the loopback test.
  if (url === '' || url.startsWith('data:')) return false
  const origin = appOrigin(url)
  return origin !== '' && origin !== 'null' && !originIsLoopback(origin)
}

/** Whether `contents` is the main window showing the client's current target. */
function permissionTrustedSurface(contents: Electron.WebContents | null): boolean {
  if (contents === null || mainWindow === null || mainWindow.isDestroyed() || contents !== mainWindow.webContents) return false
  const url = contents.getURL()
  // The client's own data: surfaces (loading, failure) are trusted by
  // definition; everything else must be the origin the client currently
  // targets — the same test the bridge applies to IPC callers.
  if (url === '' || url.startsWith('data:')) return loadingDocumentActive || errorDocumentActive
  const target = currentTarget()
  return target !== undefined && appOrigin(url) === appOrigin(target)
}

/**
 * Permission decisions follow the bridge's trust model. Clipboard writes are
 * granted on the active target whether it is loopback or not — in Connect
 * mode the page is still the official UI the user chose, and its copy button
 * must keep working. Fullscreen is loopback-only: the only thing a remote
 * page gains from it is a screen the client's own chrome no longer frames.
 */
function permissionGranted(contents: Electron.WebContents | null, permission: string): boolean {
  if (permission !== 'clipboard-sanitized-write' && permission !== 'fullscreen') return false
  if (contents === null || !permissionTrustedSurface(contents)) return false
  if (permission === 'fullscreen') return originIsLoopback(appOrigin(contents.getURL()))
  return true
}

function broadcastUpdateState(state: UpdateState): void {
  if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('desktop:update:changed', updateStateForCaller(state, mainWindowShowsRemote()))
  }
  const signature = [
    state.phase,
    state.info?.availableVersion ?? '',
    state.dismissed ? '1' : '0',
    state.error ?? '',
  ].join('\0')
  if (signature === lastTrayUpdateSignature) return
  lastTrayUpdateSignature = signature
  refreshTrayMenu()
}

function showMainWindow(): void {
  if (mainWindow === null) {
    launchWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * The Web UI's own language setting, as the official client persists it in
 * `$DSH_HOME/settings.yaml`:
 *
 * ```yaml
 * locale:
 *   preference: zh
 * ```
 *
 * Read with a two-line scan rather than a YAML dependency: one scalar under
 * one top-level key is not worth a parser, and an unreadable or unexpected
 * document must degrade to "unknown" (the system locale then decides) instead
 * of throwing inside a menu build. Only the local child's home is consulted —
 * in Connect mode the page's language lives on the remote machine, where this
 * process cannot see it.
 */
function dshLocalePreference(): string | undefined {
  let text: string
  try {
    text = readFileSync(join(childHome(), 'settings.yaml'), 'utf8')
  } catch {
    return undefined
  }
  let inLocaleBlock = false
  for (const line of text.split(/\r?\n/)) {
    // A non-indented line starts a new top-level key: the locale block ends
    // there, and only a `locale:` line reopens it.
    if (/^\S/.test(line)) {
      inLocaleBlock = /^locale:\s*(?:#.*)?$/.test(line)
      continue
    }
    if (!inLocaleBlock) continue
    const match = /^\s+preference:\s*["']?([A-Za-z][\w-]*)["']?\s*(?:#.*)?$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

// Cached: localeChinese runs per rendered string. Kept fresh by
// watchLocalePreference rather than by a TTL in the hot path.
let cachedLocalePreference: string | undefined
let localePreferenceLoaded = false

/**
 * The language every native surface follows. The Web UI's setting wins: the
 * menu bar, tray, and dialogs sit around a page the user has already told
 * which language to speak, and a native frame in the other language is the
 * mixed-language menu bar this replaced. The system locale is the fallback
 * for before that setting exists (or when a remote page owns it).
 */
function localeChinese(): boolean {
  if (!localePreferenceLoaded) {
    cachedLocalePreference = dshLocalePreference()
    localePreferenceLoaded = true
  }
  const preference = cachedLocalePreference
  if (preference !== undefined) return preference.toLowerCase().startsWith('zh')
  return app.getLocale().toLowerCase().startsWith('zh')
}

/**
 * Follow the Web UI's language switch while the client is running. The
 * official client rewrites settings.yaml atomically (write + rename), which a
 * watch on the file itself would stop seeing after the first switch, so the
 * home directory is watched instead and filtered by name. The interval is the
 * backstop for filesystems where directory watching reports nothing at all
 * (network mounts, some container layers), and it is also what re-attaches the
 * watcher: on a first launch the home does not exist yet — the child spawn
 * creates it, later than this runs — so the first attach fails and only a
 * retry ever gets a watcher at all.
 */
function watchLocalePreference(): void {
  const apply = (): void => {
    const next = dshLocalePreference()
    localePreferenceLoaded = true
    if (next === cachedLocalePreference) return
    cachedLocalePreference = next
    // Both menus bake their labels in at build time, so a language change is
    // only visible once they are rebuilt.
    installMenu()
    refreshTrayMenu()
  }
  let watcher: FSWatcher | undefined
  const attach = (): void => {
    if (watcher !== undefined) return
    let opened: FSWatcher
    try {
      opened = watch(childHome(), (_event, filename) => {
        if (filename === null || filename === 'settings.yaml') apply()
      })
    } catch {
      return // No home yet, or an unwatchable path: the poll retries and covers it.
    }
    // An FSWatcher is an EventEmitter, so an 'error' with no listener of its
    // own is an uncaught exception — the home's volume going away would take
    // the main process down over a menu label. Dropping the watcher instead
    // lets the poll rebuild it if the path becomes watchable again.
    opened.on('error', () => {
      try { opened.close() } catch { /* already torn down by the error */ }
      if (watcher === opened) watcher = undefined
    })
    opened.unref()
    watcher = opened
  }
  attach()
  const timer = setInterval(() => { attach(); apply() }, 5_000)
  timer.unref()
  apply()
}

function updateDialogCopy(): {
  found: string
  latest: string
  later: string
  ignore: string
  install: string
  failed: string
  checking: string
  downloading: string
  installing: string
  restart: string
} {
  if (localeChinese()) {
    return {
      found: '发现新版本',
      latest: '已是最新版本',
      later: '稍后',
      ignore: '忽略此版本',
      install: '下载并安装',
      failed: '检查更新失败',
      checking: '正在检查更新…',
      downloading: '正在下载新版本…',
      installing: '正在启动安装程序…',
      restart: '请安装新版本后重新打开应用',
    }
  }
  return {
    found: 'A new version is available',
    latest: 'You are on the latest version',
    later: 'Later',
    ignore: 'Skip this version',
    install: 'Download and install',
    failed: 'Could not check for updates',
    checking: 'Checking for updates…',
    downloading: 'Downloading the new version…',
    installing: 'Starting the installer…',
    restart: 'Install the new copy, then reopen the app',
  }
}

/**
 * A native confirmation for an action a page asked for. Native on purpose: the
 * requesting document can neither draw this over its own UI, nor dismiss it,
 * nor pre-click it.
 */
async function confirmSensitiveAction(message: string, detail: string): Promise<boolean> {
  const chinese = localeChinese()
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'DeepSeek Harness Desktop',
    message,
    detail,
    buttons: [chinese ? '取消' : 'Cancel', chinese ? '继续' : 'Continue'],
    defaultId: 0,
    cancelId: 0,
  }
  const owner = mainWindow
  const { response } = owner === null || owner.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(owner, options)
  return response === 1
}

let updatePromptWindow: BrowserWindow | null = null

/**
 * The update prompt is one of the client's own surfaces, so it uses the same
 * restrained type, spacing, buttons, and dark-mode palette as connection
 * settings. Keeping release notes in a bounded reading pane prevents a long
 * changelog from turning a decision into a full-screen wall of text.
 */
function updatePromptPageUrl(info: UpdateInfo): string {
  const chinese = localeChinese()
  const copy = updateDialogCopy()
  // The whole page travels as a data: URL, and Chromium caps how large such a
  // URL may be: an oversized changelog must not make the prompt fail to load
  // and close silently, with the user never learning an update exists. The
  // cap is far beyond any readable changelog.
  const notes = renderReleaseNotes((info.notes ?? '').slice(0, 32_000))
  const notesLabel = chinese ? '本次更新' : "What's new"
  const notesEmpty = chinese ? '此版本没有提供更新说明。' : 'No release notes were provided for this version.'
  const versionLabel = chinese ? '版本' : 'Version'
  const hint = chinese ? '下载完成后将打开安装程序。' : 'The installer will open when the download finishes.'
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
    + '.footer{margin-top:auto;padding-top:24px}.divider{border:0;border-top:1px solid #ebeef2;margin:0 -32px 18px}'
    + '.actions{display:flex;align-items:center;gap:8px}.spacer{flex:1}'
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
    + '</style></head><body><main><div class="intro">' + loadingIconTag()
    + '<div class="heading"><h1>' + escapeHtml(copy.found) + '</h1><p class="hint">' + escapeHtml(hint) + '</p></div></div>'
    + '<div class="version"><span class="version-label">' + escapeHtml(versionLabel) + '</span>'
    + '<span class="version-value">v' + escapeHtml(info.currentVersion) + '</span><span class="version-arrow" aria-hidden="true">→</span>'
    + '<span class="version-value new">v' + escapeHtml(info.availableVersion) + '</span></div>'
    + '<p class="notes-label">' + escapeHtml(notesLabel) + '</p>'
    + (notes === '' ? '<p class="notes-empty">' + escapeHtml(notesEmpty) + '</p>' : '<div class="notes">' + notes + '</div>')
    + '<div class="footer"><hr class="divider"><div class="actions">'
    + '<a id="update-later" class="button ghost" href="dsh-update-action:later" target="_blank">' + escapeHtml(copy.later) + '</a><span class="spacer"></span>'
    + '<a id="update-ignore" class="button" href="dsh-update-action:ignore" target="_blank">' + escapeHtml(copy.ignore) + '</a>'
    + '<a id="update-install" class="button primary" href="dsh-update-action:install" target="_blank">' + escapeHtml(copy.install) + '</a>'
    + '</div></div></main></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function showUpdateAvailableDialog(info: UpdateInfo): void {
  if (devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
  if (updatePromptWindow !== null && !updatePromptWindow.isDestroyed()) {
    updatePromptWindow.focus()
    return
  }
  const owner = mainWindow
  const prompt = new BrowserWindow({
    width: 580,
    height: 590,
    minWidth: 520,
    minHeight: 460,
    maxWidth: 720,
    title: localeChinese() ? '应用更新' : 'App update',
    icon: WINDOW_ICON_PNG,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: windowBackgroundColor(),
    show: false,
    ...(owner !== null && !owner.isDestroyed() ? { parent: owner, modal: true } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  updatePromptWindow = prompt
  // Start with enough room for the longest supported notes, then shrink the
  // hidden window to its natural content height. The footer remains at the
  // bottom and a short changelog does not leave a blank half-window below it.
  prompt.webContents.once('did-finish-load', () => {
    const measure = '(() => {'
      + 'const main=document.querySelector("main");if(!(main instanceof HTMLElement))return 560;'
      + 'document.body.style.minHeight="0";main.style.minHeight="0";'
      + 'const height=Math.ceil(main.getBoundingClientRect().height);'
      + 'document.body.style.removeProperty("min-height");main.style.removeProperty("min-height");return height})()'
    void prompt.webContents.executeJavaScript(measure, true)
      .then((height: unknown) => {
        if (prompt.isDestroyed() || typeof height !== 'number') return
        const width = prompt.getContentSize()[0] ?? 580
        prompt.setContentSize(width, Math.max(430, Math.min(560, height)))
      })
      .catch(() => {})
      .finally(() => { if (!prompt.isDestroyed()) prompt.show() })
  })
  prompt.on('closed', () => { if (updatePromptWindow === prompt) updatePromptWindow = null })
  prompt.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') prompt.close()
  })
  const handleAction = (targetUrl: string): boolean => {
    if (!targetUrl.startsWith('dsh-update-action:')) return false
    const action = targetUrl.slice('dsh-update-action:'.length)
    prompt.close()
    if (action === 'ignore') {
      desktopUpdater?.dismiss()
      return true
    }
    if (action === 'install') void installDesktopUpdate().then((installed) => {
      if (installed.started) scheduleQuitAfterWindowsInstall()
    })
    return true
  }
  prompt.webContents.setWindowOpenHandler(({ url }) => {
    handleAction(url)
    if (/^https?:\/\//i.test(url)) openExternal(url)
    return { action: 'deny' }
  })
  prompt.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault()
    if (!handleAction(targetUrl) && /^https?:\/\//i.test(targetUrl)) openExternal(targetUrl)
  })
  void prompt.loadURL(updatePromptPageUrl(info)).catch(() => { prompt.close() })
}

async function handleManualUpdateCheck(prompt: boolean): Promise<void> {
  if (desktopUpdater === undefined) return
  const busyPhase = desktopUpdater.getState().phase
  if (busyPhase === 'downloading' || busyPhase === 'installing' || busyPhase === 'restartRequired') {
    if (!prompt || devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
    const copy = updateDialogCopy()
    // Say what is actually running: this branch is reached only while a
    // download, an install, or a finished install is holding the updater, and
    // "checking for updates" would describe none of them.
    const busyMessage = busyPhase === 'downloading'
      ? copy.downloading
      : busyPhase === 'installing' ? copy.installing : copy.restart
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'DeepSeek Harness Desktop',
      message: busyMessage,
      buttons: ['OK'],
    }
    const owner = mainWindow
    if (owner === null || owner.isDestroyed()) void dialog.showMessageBox(options)
    else void dialog.showMessageBox(owner, options)
    return
  }
  desktopUpdater.resetDismiss()
  const result = await desktopUpdater.check()
  if (!prompt || devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) return
  const copy = updateDialogCopy()
  if (result.hasUpdate) {
    showUpdateAvailableDialog(result.info)
    return
  }
  const state = desktopUpdater.getState()
  const options: Electron.MessageBoxOptions = {
    type: state.phase === 'error' ? 'error' : 'info',
    title: 'DeepSeek Harness Desktop',
    message: state.phase === 'error' ? copy.failed : copy.latest,
    ...state.error !== null && { detail: state.error },
    buttons: ['OK'],
  }
  const owner = mainWindow
  if (owner === null || owner.isDestroyed()) {
    void dialog.showMessageBox(options)
    return
  }
  void dialog.showMessageBox(owner, options)
}

/**
 * Hand this process tree over to the Windows installer. Quitting waits
 * briefly on one thing first: an installer that starts and then dies
 * immediately (a SmartScreen refusal, another installer holding its mutex)
 * leaves the runtime stopped and, without this watch, an app that has
 * already quit — no error, no way back. A quick non-zero exit is caught and
 * recovered; an installer still running past the watch owns the machine from
 * here, and the client quits as before. The ShellExecute fallback (a spawn
 * that needed elevation) has no handle to watch: it reports a clean handoff
 * and this quits immediately.
 */
function scheduleQuitAfterWindowsInstall(): void {
  if (process.platform !== 'win32' || devFlag('DSH_DESKTOP_UPDATE_DRY_RUN')) return
  const timer = setTimeout(() => { app.quit() }, 5_000)
  timer.unref()
  const outcome = desktopUpdater?.installerOutcome()
  if (outcome === undefined) return
  void outcome.then(({ code }) => {
    clearTimeout(timer)
    if (code !== null && code !== 0) {
      console.warn('[desktop] the Windows installer exited early with code ' + String(code) + '; restoring the local runtime')
      installerHandoff = false
      launchWindow()
      return
    }
    // The installer finished (or left cleanly) on its own; quit regardless.
    app.quit()
  })
}

async function installDesktopUpdate(): Promise<{ started: boolean; error?: string }> {
  if (desktopUpdater === undefined) return { started: false, error: 'updater not ready' }
  const result = await desktopUpdater.install()
  // The installer never ran (a failed spawn, a declined elevation), so nothing
  // is going to sweep this process tree and nothing is going to quit. Lift the
  // suppression and give the client its runtime back rather than leaving a
  // working app with no service behind it.
  if (!result.started && installerHandoff) {
    installerHandoff = false
    console.warn('[desktop] the installer did not start; restoring the local runtime')
    launchWindow()
  }
  if (result.started && process.platform === 'darwin' && !devFlag('DSH_DESKTOP_SKIP_UPDATE_PROMPT')) {
    promptMacReplace()
  }
  return result
}

/**
 * macOS has no installer to hand off to: the image opens in Finder and the
 * person drags the app over the old copy. Finder refuses that drag while the
 * old copy is running ("项目正在使用中"), which left the update with no way to
 * finish — so offer to quit right here, with the image already open.
 */
function promptMacReplace(): void {
  const chinese = localeChinese()
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'DeepSeek Harness Desktop',
    message: chinese ? '已打开新版本安装镜像' : 'The new installer image is open',
    detail: chinese
      ? '替换「应用程序」中的旧版本需要先退出本应用，否则 Finder 会提示「正在使用中」。\n退出后请把镜像里的应用拖到「应用程序」文件夹，然后重新打开。'
      : 'Quit first — Finder cannot replace a copy that is running.\nThen drag the app from the image into Applications and reopen it.',
    buttons: chinese ? ['退出并替换', '稍后'] : ['Quit and replace', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }
  const owner = mainWindow
  const shown = owner === null || owner.isDestroyed()
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(owner, options)
  void shown.then((answer) => {
    // Quit for real: a tray-resident client that only hides its window would
    // still hold the bundle open, which is the problem being solved here.
    if (answer.response === 0) app.quit()
  })
}

let autoUpdateCheckScheduled = false
/** Whether the official Web UI has loaded at least once (re-arms the auto check). */
let webUiEverLoaded = false

/**
 * Queue the one automatic check only after the official Web UI is usable.
 * A tray-resident session can run for days without a single reload, and the
 * 12-hour throttle would then never be asked again — the hourly re-ask below
 * gives the throttle the chance to say yes without checking on its own.
 */
function scheduleAutoUpdateCheck(): void {
  if (autoUpdateCheckScheduled || desktopUpdater === undefined || !desktopUpdater.shouldAutoCheck()) return
  autoUpdateCheckScheduled = true
  setTimeout(() => {
    autoUpdateCheckScheduled = false
    const updater = desktopUpdater
    if (quitting || updater === undefined) return
    void updater.check().then((result) => {
      if (!result.hasUpdate || updater.getState().dismissed) return
      showUpdateAvailableDialog(result.info)
    })
  }, AUTO_CHECK_DELAY_MS).unref()
}

/** The throttle (persisted last-checked time) decides; this interval re-asks. */
function schedulePeriodicAutoUpdateChecks(): void {
  const timer = setInterval(() => {
    if (webUiEverLoaded) scheduleAutoUpdateCheck()
  }, 60 * 60 * 1000)
  timer.unref()
}

/**
 * The update state as the client's own settings page consumes it. Release
 * notes are Markdown; the page has no renderer, so the HTML is produced here
 * (escaped, closed subset) and travels beside the source text.
 */
function updateStateForPage(state: UpdateState): UpdateState & { notesHtml: string } {
  return { ...state, notesHtml: renderedNotesHtml(state.info?.notes ?? '') }
}

let notesHtmlCache: { source: string; html: string } = { source: '', html: '' }

/** The page polls several times a second during a download; render once. */
function renderedNotesHtml(source: string): string {
  if (notesHtmlCache.source !== source) {
    notesHtmlCache = { source, html: renderReleaseNotes(source) }
  }
  return notesHtmlCache.html
}

function pageUpdateState(): (UpdateState & { notesHtml: string }) | undefined {
  const state = desktopUpdater?.getState()
  return state === undefined ? undefined : updateStateForPage(state)
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }
}

function writeJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, jsonHeaders())
  res.end(JSON.stringify(body))
}

/** Behavior for the loopback connection-settings page, served under the same origin. */
const SETTINGS_PAGE_SCRIPT = 'const $ = id => document.getElementById(id);'
  + 'let shownNotes="";'
  + 'function renderUpdate(u){if(!u)return;'
  + 'const busy=u.phase==="checking"||u.phase==="downloading"||u.phase==="installing";'
  + '$("update-check").disabled=busy;$("update-install").disabled=busy;'
  // A refused install keeps the offer (and the button) on screen, so the
  // error phase counts as an offer too — same rule as the injected card.
  + 'const has=(u.phase==="available"||u.phase==="error")&&u.info;$("update-install").hidden=!has||busy;'
  + '$("update-dismiss").hidden=!has||u.dismissed||busy;'
  + 'let line="";'
  + 'if(u.phase==="checking")line="正在检查…";'
  + 'else if(u.phase==="upToDate")line="已是最新版本";'
  + 'else if(u.phase==="available"&&u.info)line="发现 v"+u.info.availableVersion;'
  + 'else if(u.phase==="downloading")line="下载中 "+((u.progress&&u.progress.percent)||0)+"%"'
  + '+(u.progress&&u.progress.downloaded?" · "+(u.progress.downloaded/1048576).toFixed(1)'
  + '+(u.progress.total?"/"+(u.progress.total/1048576).toFixed(1):"")+" MB":"");'
  + 'else if(u.phase==="installing")line="正在启动安装程序";'
  + 'else if(u.phase==="restartRequired")line="请安装后重新打开";'
  // The reason, not the phase, decides: a refusal publishes only a reason.
  + 'const failed=u.phase==="error"||u.error;'
  + 'if(failed)line="更新失败："+(u.error||"未知错误");'
  + '$("update-status").textContent=line;$("update-status").hidden=!line;'
  + '$("update-status").classList.toggle("error",!!failed);'
  + 'const bar=$("update-bar");bar.hidden=u.phase!=="downloading";'
  + 'if(!bar.hidden)bar.firstElementChild.style.width=((u.progress&&u.progress.percent)||0)+"%";'
  // notesHtml is rendered in the main process from the release Markdown.
  // Rebuilding it would reset the box's scroll position and drop any
  // selection, and this runs several times a second while downloading.
  + 'const notes=u.notesHtml||"";$("update-notes").hidden=!notes;'
  + 'if(notes!==shownNotes){shownNotes=notes;$("update-notes").innerHTML=notes}}'
  // Named by WHO started the runtime, then which dsh it is. "本地"/"内置" used
  // to overlap: a client-spawned child was labelled 本地 even when it ran the
  // 内置 copy, and a reused instance the user started themselves got neither.
  + 'function sourceLabel(s){'
  + 'if(s.mode==="probe")return "复用你已启动的 dsh";'
  + 'if(s.mode==="connect")return "固定地址";'
  + 'const v=s.installedDshVersion?" v"+s.installedDshVersion:"";'
  + 'return s.runtimeSource==="installed"?"客户端启动·本机安装的 dsh"+v'
  + ':s.runtimeSource==="npx"?"客户端启动·npx 缓存的 dsh"+v'
  + ':s.runtimeSource==="bundled"?"客户端启动·内置运行时":"客户端启动";}'
  + 'async function refresh(){try{const s=await(await fetch("desktop/status")).json();'
  + 'const modeLabel=sourceLabel(s);'
  + '$("status").textContent=modeLabel+(s.childPid?" (PID "+s.childPid+")":"")+" → "+(s.targetUrl||"（未就绪）")+(s.lastError?" · "+s.lastError:"")'
  // Non-blocking: the cache stays in use; re-running npx is how it updates.
  + '+(s.mode==="local"&&s.npxCacheOutdated?" · npx 缓存低于内置"+(s.dshVersion?" v"+s.dshVersion:"")+"，重新运行 npx 可更新":"");'
  + '$("versions").textContent="桌面客户端 v"+s.desktopVersion+" · 内置 dsh "+(s.dshVersion??"不可用")'
  + '+(s.installedDshVersion?" · 本机 dsh "+s.installedDshVersion:"");'
  + 'const c=await(await fetch("desktop/settings")).json();$("url").value=c.serverUrl??"";'
  // Saving both records and applies the address. The secondary action exists
  // only while an address is pinned, where it has one unambiguous meaning.
  + '$("switch").hidden=s.selectedMode!=="connect";$("switch").textContent="切换到智能模式";'
  // A live official instance we are NOT already on: offer its address instead
  // of making the user type it. Never overwrite a saved or typed value.
  + 'if(!$("url").value){try{const p=await(await fetch("desktop/probe")).json();'
  + 'if(p.url&&p.url!==s.targetUrl&&!$("url").value){$("url").value=p.url;'
  + '$("note").textContent="检测到你已启动的 dsh。点击「保存并连接」即可使用；它停止时客户端会自动回落。"}}catch(e){}}'
  + 'renderUpdate(await(await fetch("desktop/update")).json());'
  + '}catch(e){$("status").textContent="状态不可用"}}'
  + '$("save").onclick=async()=>{try{const r=await fetch("desktop/settings",{method:"POST",headers:{"content-type":"application/json"},'
  + 'body:JSON.stringify({serverUrl:$("url").value.trim()})});const j=await r.json();'
  + '$("note").textContent=j.saved?(j.mode==="smart"?"正在连接（智能模式：该实例停止时自动回落）":"已保存，正在连接…")'
  + ':("保存失败："+(j.error||"未知错误"));'
  + 'if(j.saved)setTimeout(()=>window.close(),900)}catch(e){$("note").textContent="保存失败："+e.message}};'
  + '$("switch").onclick=async()=>{try{$("switch").disabled=true;const r=await fetch("desktop/switch",{method:"POST"});const j=await r.json();'
  + '$("note").textContent=j.switched?"正在切换…":("切换失败："+(j.error||"未知错误"));if(!j.switched)$("switch").disabled=false;'
  + 'if(j.switched)setTimeout(()=>window.close(),500);'
  + '}catch(e){$("note").textContent="切换失败："+e.message;$("switch").disabled=false}};'
  // Any answer must put the button back; a fetch that throws would otherwise
  // leave it grey until the page is reopened.
  + '$("update-check").onclick=async()=>{try{$("update-check").disabled=true;const r=await fetch("desktop/update/check",{method:"POST"});renderUpdate((await r.json()).state)}'
  + 'catch(e){$("update-check").disabled=false;$("update-status").hidden=false;$("update-status").classList.add("error");$("update-status").textContent="检查失败："+e.message}};'
  // The install answers only when the download is done, so the page says what
  // it is doing now, and puts the button back for any answer that never began.
  + '$("update-install").onclick=async()=>{const fail=t=>{$("update-install").disabled=false;'
  + '$("update-status").hidden=false;$("update-status").classList.add("error");$("update-status").textContent="安装失败："+t};'
  + 'try{$("update-install").disabled=true;$("update-status").hidden=false;$("update-status").textContent="正在准备下载…";'
  + 'const r=await fetch("desktop/update/install",{method:"POST"});const j=await r.json();if(j.state)renderUpdate(j.state);'
  + 'if(!j.started)fail(j.error||"未知错误")}catch(e){fail(e.message)}};'
  + '$("update-dismiss").onclick=async()=>{await fetch("desktop/update/dismiss",{method:"POST"});renderUpdate(await(await fetch("desktop/update")).json())};'
  + 'refresh();'
  + 'setInterval(async()=>{try{const u=await(await fetch("desktop/update")).json();if(u.phase==="downloading"||u.phase==="installing")renderUpdate(u)}catch(e){}},400);'

/**
 * The "open the releases page" glyph. An in-app download can fail on a machine
 * that reaches GitHub only through a proxy the browser has and this process
 * does not, and the page that still works is one click away — as long as the
 * client says where it is. Inline SVG: the settings page's CSP allows no
 * external image, and a data: URI would not follow the text colour.
 */
const EXTERNAL_LINK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'
  + '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>'

/** The connection-settings page, styled to match the loading page aesthetic. */
function settingsPageHtml(): string {
  const icon = loadingIconTag()
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>连接设置</title>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="color-scheme" content="light dark">'
    + '<style>:root{color-scheme:light dark}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:14px;line-height:1.6;background:#fff;color:#0f1115;min-height:100vh;display:flex;justify-content:center;padding:48px 24px 40px}'
    + '.container{width:100%;max-width:400px}'
    // Header: centered logo + title, matching loading page
    + '.header{text-align:center;margin-bottom:36px}'
    + '.mark{width:56px;height:56px;border-radius:14px;box-shadow:0 12px 32px rgba(15,17,21,.14)}'
    + '.page-title{margin:18px 0 0;font-size:18px;font-weight:600;letter-spacing:-.01em}'
    // Section titles with badge
    + '.section{margin-bottom:24px}'
    + '.section-title{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:14px;font-weight:500}'
    + '.section-title .actions{margin-left:auto;margin-top:0}'
    + '.badge{font-size:11px;font-weight:400;background:#EBEEF2;border-radius:999px;padding:2px 8px;color:#6e7480}'
    // Text hierarchy
    + '.status-text{margin:0 0 12px;font-size:13px;color:#6e7480}'
    + '.version-text{margin:0 0 4px;font-size:12px;color:#9aa0a6}'
    // Input
    + 'input{width:100%;background:#fff;border:1px solid #d8d8d4;border-radius:8px;padding:7px 11px;font-size:13px;font-family:inherit;color:#0f1115;outline:none;transition:border-color .15s ease}'
    + 'input:focus{border-color:#0f1115}'
    + 'input::placeholder{color:#9aa0a6}'
    // Action buttons
    + '.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}'
    + 'button{white-space:nowrap;font-weight:400;background:transparent;border:1px solid #d8d8d4;border-radius:28px;padding:6px 18px;font-size:13px;font-family:inherit;color:#0f1115;cursor:pointer;transition:background .15s ease,opacity .15s ease}'
    + 'button:hover{background:#f5f6f7}'
    + 'button:disabled{cursor:default;opacity:.5}'
    + 'button.primary{background:#0f1115;border-color:#0f1115;color:#fff}'
    + 'button.primary:hover{opacity:.88;background:#0f1115}'
    // The manual-download seat: a glyph rather than a fourth button, so the
    // row keeps one primary action and this stays a way out, not a choice.
    + '.icon-link{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;'
    + 'border-radius:999px;color:#6e7480;text-decoration:none;transition:background .15s ease,color .15s ease}'
    + '.icon-link:hover{background:#f5f6f7;color:#0f1115}'
    + '[hidden]{display:none}'
    + '.note{margin:8px 0 0;font-size:13px;color:#6e7480}'
    // Divider
    + '.divider{border:none;border-top:1px solid #ebeef2;margin:28px 0}'
    // Download progress
    + '.progress{height:4px;margin:0 0 10px;border-radius:999px;background:#ebeef2;overflow:hidden}'
    + '.progress span{display:block;height:100%;width:0;border-radius:999px;background:#0f1115;transition:width .2s ease}'
    + '.status-text.error{color:#d93f3f}'
    // Update notes: release Markdown, rendered in the main process. The
    // stylesheet is shared with the card injected into the Web UI settings.
    + releaseNotesCss('#update-notes', { text: '#6e7480', strong: '#0f1115', border: '#d8d8d4', surface: '#ebeef2' })
    // Dark mode
    + '@media(prefers-color-scheme:dark){body{background:#17181a;color:#f4f5f6}'
    + '.mark{box-shadow:0 12px 32px rgba(0,0,0,.34)}'
    + '.badge{background:#2c2e33;color:#818791}'
    + '.status-text{color:#aeb3bb}.version-text{color:#818791}'
    + 'input{background:#1e1f22;border-color:#3a3d42;color:#f4f5f6}'
    + 'input:focus{border-color:#f4f5f6}input::placeholder{color:#5a5e66}'
    + 'button{border-color:#3a3d42;color:#f4f5f6}button:hover{background:#232529}'
    + 'button.primary{background:#f4f5f6;border-color:#f4f5f6;color:#17181a}'
    + 'button.primary:hover{opacity:.88;background:#f4f5f6}'
    + '.icon-link{color:#aeb3bb}.icon-link:hover{background:#232529;color:#f4f5f6}'
    + '.note{color:#aeb3bb}.divider{border-color:#2c2e33}'
    + '.progress{background:#2c2e33}.progress span{background:#f4f5f6}'
    + '.status-text.error{color:#ff6b6b}'
    + releaseNotesCss('#update-notes', { text: '#aeb3bb', strong: '#f4f5f6', border: '#3a3d42', surface: '#232529' })
    + '}'
    // Reduced motion
    + '@media(prefers-reduced-motion:reduce){*{transition:none!important}}'
    + '</style></head><body><div class="container">'
    // Header with logo
    + '<div class="header">' + icon + '<h1 class="page-title">连接设置</h1></div>'
    // Connection section
    + '<div class="section">'
    + '<div class="section-title">连接<span class="badge">增强功能</span>'
    + '<div class="actions">'
    + '<button id="switch" class="primary" hidden>切换连接</button>'
    + '<button id="save">保存并连接</button>'
    + '</div></div>'
    + '<p class="status-text" id="status">连接状态读取中…</p>'
    + '<input id="url" placeholder="Web UI 地址，留空 = 智能（本机官方实例优先，否则本地启动）" spellcheck="false">'
    + '<p class="note" id="note"></p>'
    + '</div>'
    // Divider
    + '<hr class="divider">'
    // Update section
    + '<div class="section">'
    + '<div class="section-title">应用更新<span class="badge">增强功能</span>'
    + '<div class="actions">'
    + '<a class="icon-link" id="update-page" href="' + RELEASES_PAGE_URL + '" target="_blank" rel="noreferrer"'
    + ' title="打开 GitHub 发布页手动下载" aria-label="打开 GitHub 发布页手动下载">' + EXTERNAL_LINK_SVG + '</a>'
    + '<button id="update-install" class="primary" hidden>下载并安装</button>'
    + '<button id="update-check">检查更新</button>'
    + '<button id="update-dismiss" hidden>稍后提醒</button>'
    + '</div></div>'
    + '<p class="version-text" id="versions"></p>'
    + '<p class="status-text" id="update-status" hidden></p>'
    + '<div class="progress" id="update-bar" hidden><span></span></div>'
    + '<div id="update-notes" hidden></div>'
    + '</div>'
    + '</div><script src="desktop/settings.js"></script></body></html>'
}

/** Connect to a fixed Web UI origin: stop any local child, point the window at it. */
function connectTo(url: string, force = false): void {
  const generation = ++connectionGeneration
  if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
  configuredTarget = url
  probeConnected = false
  childTarget = undefined
  // This process will not spawn its bundled runtime; a leftover entry would
  // hand the next `dsh web` (or a later local spawn) a second Service copy.
  releaseBundledPluginSeat('connecting to a pinned address')
  if (webUi !== undefined) void webUi.stop()
  launchWindow(generation, force)
}

/** Use the local `dsh web` child (spawned on demand, awaited via readiness). */
async function startLocalRuntime(generation: number, force = false): Promise<void> {
  if (generation !== connectionGeneration || quitting) return
  // Never two harnesses on one DSH_HOME. A survivor that still serves is
  // adopted like any other running instance — including the fallback path, so
  // this connection is not pinned to it if it later goes away.
  const survivor = await adoptOrClearSurvivingRuntime()
  if (generation !== connectionGeneration || quitting) return
  if (survivor.kind === 'adopt') {
    configuredTarget = survivor.url
    probeConnected = true
    childTarget = undefined
    reseatForAdoptedRuntime()
    launchWindow(generation, force)
    return
  }
  if (survivor.kind === 'blocked') {
    const chinese = localeChinese()
    const pid = String(survivor.pid)
    showConnectionError({
      kind: 'runtime',
      headline: chinese ? '已有 dsh 运行时占用会话数据' : 'A dsh runtime is already using this session data',
      detail: chinese
        ? '上一次运行留下的 dsh 运行时（PID ' + pid + '）仍在运行，且既无法连接也无法结束。两个运行时同时写入同一份会话数据会造成永久损坏，因此这次没有启动新的运行时。确认该进程结束后可删除记录文件并重试。'
        : 'A leftover dsh runtime (PID ' + pid + ') is still running and could not be reached or stopped. Starting another writer on the same session data would corrupt it, so this launch was refused. After that process exits, delete the record file and retry.',
      recordPath: runtimeLockFile(childHome()),
    })
    return
  }
  configuredTarget = undefined
  probeConnected = false
  launchWindow(generation, force)
}

/**
 * Terminate a process this client owns but no longer holds a handle to.
 *
 * The manager's own stop() waits on its child's 'exit' event; a survivor of a
 * previous run has no such event to wait for, so liveness is polled instead.
 * Windows keeps the tree kill for the reason stop() documents: signals cannot
 * be caught there, and the real server is reachable only by walking down from
 * a parent that is still alive.
 */
async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { /* already gone */ })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { return !isProcessAlive(pid) }
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL') } catch { /* it left on its own */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !isProcessAlive(pid)
}

/** A recycled pid can only be this far off the recorded age. */
const PROCESS_IDENTITY_TOLERANCE_MS = 60_000

/**
 * Whether the pid in a runtime lock still names the child the lock recorded
 * (see spawnAgeVerdict). Liveness alone is not identity: the client may
 * crash, the child die, and the OS hand the pid to any later process —
 * signalling a recycled pid would terminate (on Windows, with its whole
 * tree) an innocent bystander. A record with no usable `startedAt` is
 * unverifiable and reported as such: the caller then refuses both
 * directions instead of guessing.
 */
async function pidVerdictForLockedChild(lock: RuntimeLock): Promise<'recycled' | 'ours' | 'unknown'> {
  if (!Number.isSafeInteger(lock.startedAt) || lock.startedAt <= 0) return 'unknown'
  // One retry: a transient ps/powershell failure must not wedge the start
  // behind a refusal it could have resolved.
  let age = await readProcessAgeSeconds(lock.childPid)
  if (age === undefined) {
    await new Promise(resolve => setTimeout(resolve, 300))
    age = await readProcessAgeSeconds(lock.childPid)
  }
  if (age === undefined) return 'unknown'
  return spawnAgeVerdict(age, lock.startedAt, Date.now(), PROCESS_IDENTITY_TOLERANCE_MS)
}

/** Capture one short command's stdout, bounded, or reject. */
function runCommandCapture(command: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const settle = (error: Error | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(stdout)
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { killProcessTree(child); settle(new Error('timed out')) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_096) stdout = stdout.slice(0, 4_096)
    })
    child.once('error', () => { settle(new Error('command failed')) })
    child.once('exit', (code) => { settle(code === 0 ? undefined : new Error('exit ' + String(code))) })
  })
}

/** The age of a process in seconds, or undefined when the platform cannot say. */
async function readProcessAgeSeconds(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const output = await runCommandCapture('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[math]::Round(((Get-Date) - (Get-Process -Id ' + String(pid) + ' -ErrorAction Stop).StartTime).TotalSeconds)',
      ])
      const parsed = Number(output.trim())
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    const output = await runCommandCapture('ps', ['-p', String(pid), '-o', 'etime='])
    return parsePsElapsedSeconds(output)
  } catch {
    return undefined
  }
}

/**
 * Settle with the runtime this client left behind, before starting another.
 *
 * `adopt` names an origin to connect to when the survivor still serves — one
 * harness, sessions shared, which is what the user wanted anyway. `spawn`
 * means the way is clear. `blocked` means a survivor is still alive and could
 * not be stopped, and the caller must NOT start a second writer.
 *
 * The served origin is what decides, not the pid: a harness that answers is
 * unambiguously writing DSH_HOME, while a pid that answers nothing is either
 * gone or wedged past use. Killing a wedged one risks a torn write tail, which
 * the harness repairs on its next load; spawning beside a live one risks
 * duplicate seqs and orphan inbox splices, which nothing repairs.
 */
type SurvivingRuntime =
  | { kind: 'spawn' }
  | { kind: 'adopt'; url: string }
  | { kind: 'blocked'; pid: number }

async function adoptOrClearSurvivingRuntime(): Promise<SurvivingRuntime> {
  const home = childHome()
  const lock = readRuntimeLock(home)
  if (lock === undefined) return { kind: 'spawn' }
  // The record describes the child this manager is already running: there is
  // no survivor here, only ourselves, and adopting it would stop it.
  if (webUi?.pid() === lock.childPid) return { kind: 'spawn' }
  if (lock.url !== undefined) {
    const answered = await probeWebUi(lock.url)
    if (answered !== undefined) {
      console.warn('[desktop] adopting the runtime left by a previous run (PID ' + String(lock.childPid) + '): ' + answered)
      return { kind: 'adopt', url: answered }
    }
  }
  if (isProcessAlive(lock.childPid)) {
    const verdict = await pidVerdictForLockedChild(lock)
    if (verdict === 'unknown') {
      // A live pid we cannot identify is signalled by nobody. Refuse both
      // directions — killing it may hit an unrelated process, spawning beside
      // it may be a second writer.
      console.warn('[desktop] cannot verify the process holding PID ' + String(lock.childPid)
        + '; refusing to signal it or to write ' + home + ' beside it')
      return { kind: 'blocked', pid: lock.childPid }
    }
    if (verdict === 'ours') {
      console.warn('[desktop] a runtime from a previous run (PID ' + String(lock.childPid)
        + ') is alive but not serving; stopping it rather than writing ' + home + ' beside it')
      // The record stays on a failed kill. Clearing it would let the next start
      // spawn beside a writer this one already knows it could not stop.
      if (!await terminateProcessTree(lock.childPid)) return { kind: 'blocked', pid: lock.childPid }
    } else {
      // The recorded child is gone and its pid has been recycled by an
      // unrelated process: the record is stale, and that process must not be
      // signalled (Windows would take its whole tree down).
      console.warn('[desktop] the recorded runtime (PID ' + String(lock.childPid)
        + ') is gone and its pid now names an unrelated process; leaving it alone')
    }
  }
  clearRuntimeLock(home)
  return { kind: 'spawn' }
}

/** Start a fresh bounded recovery window for an intentional local selection. */
function resetRuntimeRecoveryBudget(): void {
  launchBudget = MAX_LAUNCH_RETRIES
  if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
  launchBudgetResetTimer = undefined
}

/** Restore the retry budget only after one local generation proves stable. */
function markLocalRuntimeReady(url: string): void {
  childTarget = url
  // With an origin attached, a survivor of this client can be adopted by the
  // next start rather than merely detected and killed.
  recordRuntimeLockUrl(childHome(), url, webUi?.pid())
  // A first-ever DSH_HOME has no web profile until the child creates it
  // during boot, so the pre-spawn offer is a no-op. Take the seat now so
  // the next start actually loads the plugin (this process will not).
  const spawned = webUi?.lastCommand
  if (spawned !== undefined && !bundledPluginSeatInUse && !bundledPluginSuppressed) {
    offerBundledPluginSeat(spawned)
  }
  if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
  launchBudgetResetTimer = setTimeout(() => {
    if (configuredTarget === undefined && childTarget === url) launchBudget = MAX_LAUNCH_RETRIES
    launchBudgetResetTimer = undefined
  }, STABLE_RUNTIME_RESET_MS)
  launchBudgetResetTimer.unref()
}

/** A Smart-mode probed instance disappeared; fall back to the managed child. */
function fallbackFromProbedInstance(reason: string): boolean {
  if (!probeConnected || quitting) return false
  const failedTarget = configuredTarget
  const generation = ++connectionGeneration
  configuredTarget = undefined
  probeConnected = false
  childTarget = undefined
  probedRecoveryReloads = 0
  resetRuntimeRecoveryBudget()
  console.warn('[desktop] probed Web UI unavailable; starting local runtime (' + reason + '): ' + (failedTarget ?? 'unknown'))
  showLoadingDocument()
  // Detection can spend its full deadline on an unresponsive `dsh --version`,
  // so this path names what it is waiting for rather than leaving the surface
  // on the previous message.
  if (installedDshDetection === undefined) {
    updateLoadingStatus('正在检查本机 dsh 运行时…', 'Looking for a dsh runtime on this machine…')
  }
  void detectInstalledDsh().then(async () => {
    if (quitting || generation !== connectionGeneration) return
    await startLocalRuntime(generation)
  })
  return true
}

/**
 * Smart mode, in order: an official instance already running on this machine,
 * then a dsh the user installed themselves, then the bundled runtime. The
 * detection step runs only here — on the branch that is actually about to
 * start something — so reusing a running instance stays as fast as it was.
 */
function resolveRuntime(force = false): void {
  const generation = ++connectionGeneration
  resetRuntimeRecoveryBudget()
  // Drop the seat until this process knows who will serve. A spawn re-seats
  // behind the version gate; adopting a running local instance re-seats on
  // the strength of it already serving this profile (`reseatForAdoptedRuntime`);
  // only a pinned address leaves the seat released.
  releaseBundledPluginSeat('resolving which runtime will serve')
  const startLocal = async (): Promise<void> => {
    if (installedDshDetection === undefined) {
      updateLoadingStatus('正在检查本机 dsh 运行时…', 'Looking for a dsh runtime on this machine…')
    }
    await detectInstalledDsh()
    if (quitting || generation !== connectionGeneration) return
    await startLocalRuntime(generation, force)
  }
  if (devFlag('DSH_DESKTOP_SKIP_PROBE')) {
    void startLocal()
    return
  }
  void probeSmartTargets().then(async (probed) => {
    if (quitting || generation !== connectionGeneration) return
    if (probed !== undefined) {
      configuredTarget = probed
      probeConnected = true
      childTarget = undefined
      probedRecoveryReloads = 0
      reseatForAdoptedRuntime()
      if (webUi !== undefined) void webUi.stop()
      launchWindow(generation, force)
      return
    }
    await startLocal()
  })
}

/**
 * Apply one persisted connection choice without changing its saved address.
 * `force` is set by the seats the user drives (save, switch, retry); startup
 * leaves it off so the first paint is never a redundant reload.
 */
function applyConnectionSettings(settings: ClientSettings, force = false): void {
  const explicit = normalizeServerUrl(settings.serverUrl)
  if (explicit !== undefined && usesConfiguredServer(settings)) connectTo(explicit, force)
  else resolveRuntime(force)
}

/**
 * Whether an origin is the address Smart mode itself would probe: the default
 * probe port on any loopback spelling (`localhost` included). Pinning that
 * one origin is strictly worse than Smart — identical while it is up, and on
 * the wrong side of the only difference that matters: when the instance goes
 * away, Connect mode holds the dead address and stops at the failure surface,
 * while Smart falls through to a local runtime. The address is still
 * recorded, so the switch button can pin it as a deliberate act.
 */
function isSmartProbeEquivalent(origin: string): boolean {
  const probe = normalizeServerUrl(defaultWebProbeUrl())
  if (probe === undefined) return false
  if (!originIsLoopback(origin)) return origin === probe
  try {
    return new URL(origin).port === new URL(probe).port
  } catch {
    return false
  }
}

/**
 * Save an address edit. A non-empty valid address becomes the active target —
 * except the default probe address, which Smart mode already prefers.
 *
 * Pinning that one origin is strictly worse than Smart: identical while it is
 * up, and on the wrong side of the only difference that matters — when the
 * instance goes away, Connect mode holds the dead address and stops at the
 * failure surface, while Smart falls through to a local runtime. The address
 * is still recorded, so the switch button can pin it as a deliberate act.
 */
function saveServerUrlAndReconnect(serverUrl: unknown): { saved: boolean; mode?: 'smart' | 'connect'; error?: string } {
  try {
    const raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
    if (raw === '') {
      patchSettings({ connectionMode: 'smart' }, ['serverUrl'])
      applyConnectionSettings(loadSettings(), true)
      return { saved: true, mode: 'smart' }
    }
    const explicit = normalizeServerUrl(raw)
    if (explicit === undefined) return { saved: false, error: '请输入有效的 HTTP 或 HTTPS 地址' }
    const mode = isSmartProbeEquivalent(explicit) ? 'smart' : 'connect'
    patchSettings({ serverUrl: explicit, connectionMode: mode })
    applyConnectionSettings(loadSettings(), true)
    return { saved: true, mode }
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The guarded entry point for an address change. Two native confirmations,
 * each for a different reason: one when a remote page is the one asking to
 * repoint the client (a persistent redirect is the whole prize for a hostile
 * or compromised Web UI), one when the address itself is plaintext HTTP off
 * this machine — the official UI carries the API key and every message, and
 * http:// puts both on the wire in clear.
 */
async function requestServerUrlSave(serverUrl: unknown, remoteCaller: boolean): Promise<{ saved: boolean; mode?: 'smart' | 'connect'; error?: string }> {
  const chinese = localeChinese()
  const raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
  const explicit = raw === '' ? undefined : normalizeServerUrl(raw)
  if (raw !== '' && explicit === undefined) {
    return { saved: false, error: chinese ? '请输入有效的 HTTP 或 HTTPS 地址' : 'Enter a valid HTTP or HTTPS address' }
  }
  const cancelled = { saved: false, error: chinese ? '已取消' : 'Cancelled' }

  if (remoteCaller) {
    const confirmed = await confirmSensitiveAction(
      chinese ? '当前页面请求更改 Web UI 连接地址' : 'The current page asked to change the Web UI address',
      (chinese
        ? '这会让客户端在以后每次启动时都连接到新地址。请求来自：'
        : 'This repoints the client on every future launch. Requested by: ')
      + (currentTarget() ?? '') + '\n'
      + (chinese ? '新地址：' : 'New address: ') + (explicit ?? (chinese ? '（智能模式）' : '(Smart mode)')),
    )
    if (!confirmed) return cancelled
  }
  if (explicit !== undefined && explicit.startsWith('http://') && !originIsLoopback(explicit)) {
    const confirmed = await confirmSensitiveAction(
      chinese ? '该地址使用明文 HTTP' : 'That address uses plaintext HTTP',
      (chinese
        ? 'API Key、全部会话内容都会以未加密方式在网络上传输，同网络中的任何人都可以读取或篡改。可用的话请改用 https://。\n\n地址：'
        : 'The API key and every message travel unencrypted; anyone on the path can read or alter them. Prefer https:// when the server offers it.\n\nAddress: ')
      + explicit,
    )
    if (!confirmed) return cancelled
  }
  return saveServerUrlAndReconnect(serverUrl)
}

/** Toggle between Smart local selection and the saved fixed origin. */
function switchConnectionMode(): { switched: boolean; mode?: 'smart' | 'connect'; error?: string } {
  try {
    const current = loadSettings()
    const explicit = normalizeServerUrl(current.serverUrl)
    if (explicit === undefined) return { switched: false, error: '请先保存 Web UI 地址' }
    const mode = usesConfiguredServer(current) ? 'smart' : 'connect'
    patchSettings({ serverUrl: explicit, connectionMode: mode })
    applyConnectionSettings(loadSettings(), true)
    return { switched: true, mode }
  } catch (error) {
    return { switched: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Open the window at the CURRENT target, waiting for local readiness if needed. */
function launchWindow(generation = connectionGeneration, force = false): void {
  if (generation !== connectionGeneration || quitting) return
  mainWindowRequested = true
  if (mainWindow === null) createWindow()
  // A failure that arrived while the window was closed owns this window: it is
  // the real explanation, and its seats (retry, settings, quit) are live. A
  // failure from a superseded attempt is stale — drop it and connect.
  const held = pendingConnectionFailure
  pendingConnectionFailure = undefined
  if (held !== undefined && held.generation === generation) {
    showConnectionError(held.failure)
    return
  }
  if (configuredTarget !== undefined) {
    updateLoadingStatus('正在连接 Web UI…', 'Connecting to the Web UI…')
    loadMainWindow(configuredTarget, force)
    return
  }
  updateLoadingStatus('正在启动本地 dsh 服务…', 'Starting the local dsh service…')
  void webUi?.ready().then((url) => {
    if (generation !== connectionGeneration || quitting) return
    console.log('[desktop] dsh runtime ready: ' + url)
    markLocalRuntimeReady(url)
    if (!mainWindowRequested) return
    if (configuredTarget === undefined) loadMainWindow(url, force)
  }, () => {
    // The first failure already took over this window through onExit — either
    // as the error surface, or held and rendered above. A repeat request (dock
    // activate, second instance) rejects without one, so the loading surface
    // must carry the state instead of spinning forever.
    if (generation !== connectionGeneration || quitting) return
    updateLoadingStatus('本地服务启动失败。可在下方设置 Web UI 连接。',
      'The local service failed to start. Set the Web UI connection below.', 'failed')
  })
}

/**
 * The application menu. Connection settings live in the official settings
 * dialog's enhanced "连接" block now, so the menu carries standard roles only.
 * macOS keeps it: the system draws that menu bar outside the window, and its
 * roles carry the standard edit accelerators. Windows/Linux would paint the
 * bar inside the frame above the Web UI's own chrome, so the menu is dropped
 * there entirely — Chromium keeps the editing accelerators on its own.
 *
 * Every item states its own label. A `role` alone takes Electron's built-in
 * label, and those are English literals that no locale changes — which is
 * what produced a bar reading "About … / 检查更新… / Hide …". The roles are
 * still what gives each item its behaviour and standard accelerator; only the
 * text is ours, in the language `localeChinese` reports, using the wording
 * macOS itself uses for these items. Rebuilt on a language switch by
 * `watchLocalePreference`.
 */
function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const chinese = localeChinese()
  const name = app.name
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: (chinese ? '关于 ' : 'About ') + name },
        {
          label: chinese ? '检查更新…' : 'Check for Updates…',
          click: () => { void handleManualUpdateCheck(true) },
        },
        { type: 'separator' },
        { role: 'services', label: chinese ? '服务' : 'Services' },
        { type: 'separator' },
        { role: 'hide', label: (chinese ? '隐藏 ' : 'Hide ') + name },
        { role: 'hideOthers', label: chinese ? '隐藏其他' : 'Hide Others' },
        { role: 'unhide', label: chinese ? '全部显示' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: (chinese ? '退出 ' : 'Quit ') + name },
      ],
    },
    {
      label: chinese ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: chinese ? '撤销' : 'Undo' },
        { role: 'redo', label: chinese ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: chinese ? '剪切' : 'Cut' },
        { role: 'copy', label: chinese ? '拷贝' : 'Copy' },
        { role: 'paste', label: chinese ? '粘贴' : 'Paste' },
        { role: 'pasteAndMatchStyle', label: chinese ? '粘贴并匹配样式' : 'Paste and Match Style' },
        { role: 'delete', label: chinese ? '删除' : 'Delete' },
        { role: 'selectAll', label: chinese ? '全选' : 'Select All' },
        { type: 'separator' },
        {
          label: chinese ? '语音' : 'Speech',
          submenu: [
            { role: 'startSpeaking', label: chinese ? '开始朗读' : 'Start Speaking' },
            { role: 'stopSpeaking', label: chinese ? '停止朗读' : 'Stop Speaking' },
          ],
        },
      ],
    },
    {
      label: chinese ? '显示' : 'View',
      submenu: [
        { role: 'reload', label: chinese ? '重新载入' : 'Reload' },
        { role: 'forceReload', label: chinese ? '强制重新载入' : 'Force Reload' },
        // The shipped app keeps Reload (a Web UI client still benefits from
        // rebuilding its renderer) but not DevTools: a packaged install has
        // no debugging surface to expose, and the window may be showing a
        // remote page whose runtime internals are none of the user's concern.
        ...(!app.isPackaged
          ? [{ role: 'toggleDevTools' as const, label: chinese ? '切换开发者工具' : 'Toggle Developer Tools' }]
          : []),
        { type: 'separator' },
        { role: 'resetZoom', label: chinese ? '实际大小' : 'Actual Size' },
        { role: 'zoomIn', label: chinese ? '放大' : 'Zoom In' },
        { role: 'zoomOut', label: chinese ? '缩小' : 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: chinese ? '进入全屏幕' : 'Toggle Full Screen' },
      ],
    },
    {
      label: chinese ? '窗口' : 'Window',
      submenu: [
        { role: 'minimize', label: chinese ? '最小化' : 'Minimize' },
        { role: 'zoom', label: chinese ? '缩放' : 'Zoom' },
        { type: 'separator' },
        { role: 'front', label: chinese ? '前置全部窗口' : 'Bring All to Front' },
        { type: 'separator' },
        { role: 'close', label: chinese ? '关闭窗口' : 'Close Window' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Start the private-path loopback settings server and resolve only once bound. */
function startSettingsServer(): Promise<number> {
  const server = createServer((req, res) => {
    // Defence in depth behind the unguessable path: these headers cost nothing
    // and the Host check closes DNS rebinding, where a name that resolves to
    // 127.0.0.1 would otherwise reach this server under an attacker's origin.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('referrer-policy', 'no-referrer')
    const port = String(settingsServerPort)
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port && host !== '[::1]:' + port) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (!url.pathname.startsWith(settingsServerPath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const pathname = '/' + url.pathname.slice(settingsServerPath.length)
    if (pathname === '/desktop/status') {
      writeJson(res, 200, getStatusJson())
      return
    }
    if (pathname === '/desktop/probe') {
      void probeDefaultWebUi().then((result) => { writeJson(res, 200, result) })
      return
    }
    if (pathname === '/desktop/update') {
      const state = desktopUpdater?.getState()
      writeJson(res, 200, state === undefined
        ? { phase: 'idle', currentVersion: desktopClientVersion(), info: null, progress: null, error: 'updater not ready', dismissed: false, isChecking: false }
        : updateStateForPage(state))
      return
    }
    if (pathname === '/desktop/update/check' && req.method === 'POST') {
      if (desktopUpdater === undefined) {
        writeJson(res, 503, { hasUpdate: false, error: 'updater not ready' })
        return
      }
      desktopUpdater.resetDismiss()
      void desktopUpdater.check().then((result) => {
        writeJson(res, 200, { ...result, state: pageUpdateState() })
      })
      return
    }
    if (pathname === '/desktop/update/install' && req.method === 'POST') {
      void installDesktopUpdate().then((result) => {
        writeJson(res, result.started ? 200 : 400, { ...result, state: pageUpdateState() })
        if (result.started) scheduleQuitAfterWindowsInstall()
      })
      return
    }
    if (pathname === '/desktop/update/dismiss' && req.method === 'POST') {
      desktopUpdater?.dismiss()
      writeJson(res, 200, pageUpdateState() ?? { dismissed: true })
      return
    }
    if (pathname === '/desktop/settings.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(SETTINGS_PAGE_SCRIPT)
      return
    }
    if (pathname === '/desktop/settings') {
      if (req.method === 'POST') {
        let body = ''
        let bodyTooLarge = false
        req.on('data', (chunk: Buffer) => {
          if (bodyTooLarge) return
          body += chunk.toString()
          if (body.length > 16_384) {
            bodyTooLarge = true
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ saved: false, error: 'request body too large' }))
          }
        })
        req.on('end', () => {
          if (bodyTooLarge) return
          try {
            const parsed = JSON.parse(body) as { serverUrl?: unknown }
            // This page is the client's own; the plaintext-HTTP warning inside
            // still applies to what the user typed into it.
            // The confirmation dialog inside can reject if its owner window
            // goes away while it is open. Without this catch the response
            // would never be written and the page would hang on the fetch.
            void requestServerUrlSave(parsed.serverUrl, false).then((result) => {
              res.writeHead(result.saved ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(result))
            }, (error: unknown) => {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) }))
            })
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(JSON.stringify(loadSettings()))
      return
    }
    if (pathname === '/desktop/switch' && req.method === 'POST') {
      const result = switchConnectionMode()
      res.writeHead(result.switched ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
      return
    }
    if (pathname === '/' || pathname === '/desktop/settings.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(settingsPageHtml())
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      settingsServerPort = typeof address === 'object' && address !== null ? address.port : 0
      resolve(settingsServerPort)
    })
  })
}

function showLocalRuntimeStartupFailure(code: number | null, signal: NodeJS.Signals | null): void {
  const reason = webUi?.lastError
  const chinese = localeChinese()
  showConnectionError({
    kind: 'runtime',
    headline: chinese ? '本地服务无法启动' : 'The local service could not start',
    detail: (reason !== null && reason !== undefined ? reason + ' · ' : '') + String(code) + ' / ' + String(signal),
  })
}

/**
 * Last-resort disposal for an exit that never reaches `before-quit`: an
 * uncaught exception, or a signal. The graceful ladder cannot run here — an
 * exit handler is synchronous — but a SIGKILL still keeps the runtime from
 * outliving the client as an orphan holding the data home and a port.
 */
function installEmergencyRuntimeDisposal(): void {
  // A closed stdout (a piped launch whose reader went away) otherwise turns
  // the next console.log into an uncaught EPIPE, which would take the client
  // down without disposing of the child at all.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  process.on('exit', () => {
    const pid = webUi?.pid()
    if (pid === undefined) return
    try {
      // An exit handler cannot await, but it can still run a synchronous
      // command — and on Windows the tree walk is the only disposal that
      // reaches past a cmd.exe wrapper to the server actually holding a port.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        return
      }
      process.kill(pid, 'SIGKILL')
    } catch { /* already gone, which is the outcome this wants */ }
  })
}

function boot(): void {
  const settings = loadSettings()
  installEmergencyRuntimeDisposal()
  webUi = new WebUiManager(
    (line) => { console.log('[dsh web] ' + line) },
    ({ wasReady, code, signal, retryable }) => {
      if (quitting || installerHandoff) return
      if (configuredTarget !== undefined) {
        // Connect/probe mode: a child exit is irrelevant (there should be none).
        return
      }
      childTarget = undefined
      if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
      launchBudgetResetTimer = undefined
      // A runtime that never came up while this client's seat was on the
      // profile is the one failure the client can undo by itself: a plugin
      // that throws while loading fails the WHOLE plugin tree. The seat goes
      // back before the retry, and this session will not reseat — otherwise
      // spawn() puts the name back and a bad plugin (especially one shipped
      // by a client upgrade, when the entry is already present) burns the
      // launch budget without ever trying the runtime alone.
      if (!wasReady && bundledPluginSeatInUse) {
        bundledPluginSeatInUse = false
        if (withdrawBundledPlugin(childHome())) {
          bundledPluginSuppressed = true
          console.warn('[desktop] dsh web did not start with ' + BUNDLED_PLUGIN_NAME
            + ' seated; the seat was withdrawn and will not be offered again this session')
        }
      }
      // A user-installed runtime that never reached readiness is not a base
      // this session can build on, and the client does not control it. Drop to
      // the bundled runtime immediately rather than spending the shared retry
      // budget on identical failures — the budget still covers the fallback.
      if (!wasReady && (webUi?.lastSource === 'installed' || webUi?.lastSource === 'npx') && !installedDshRejected) {
        installedDshRejected = true
        console.warn('[desktop] user-installed dsh failed to start ('
          + String(code) + '/' + String(signal) + '); falling back to the bundled runtime')
        const generation = connectionGeneration
        if (mainWindowRequested) {
          showLoadingDocument()
          updateLoadingStatus('本机 dsh 启动失败，正在改用内置运行时…',
            'The installed dsh did not start; switching to the bundled runtime…')
        }
        webUi?.spawn()
        if (mainWindowRequested) {
          launchWindow(generation)
          return
        }
        void webUi?.ready().then((url) => {
          if (quitting || configuredTarget !== undefined || generation !== connectionGeneration) return
          markLocalRuntimeReady(url)
        }, () => {})
        return
      }
      if (retryable && launchBudget > 0) {
        launchBudget -= 1
        const delayMs = relaunchDelayMs(launchBudget)
        const generation = connectionGeneration
        console.error('[desktop] dsh web ' + (wasReady ? 'exited' : 'failed to start') + ' (' + String(code) + '/' + String(signal)
          + '); relaunching in ' + String(delayMs) + 'ms (' + String(launchBudget) + ' left)')
        if (mainWindowRequested) {
          showLoadingDocument()
          updateLoadingStatus(
            wasReady ? '本地服务意外退出，正在重启…' : '本地服务启动失败，正在重试…',
            wasReady ? 'The local service exited; restarting…' : 'The local service did not start; retrying…',
          )
        }
        setTimeout(() => {
          if (quitting || configuredTarget !== undefined || generation !== connectionGeneration) return
          webUi?.spawn()
          if (mainWindowRequested) {
            launchWindow(generation)
            return
          }
          // Tray mode stays quiet, but still observes readiness/rejection so a
          // failed recovery consumes the shared retry budget without an
          // unhandled promise rejection.
          void webUi?.ready().then((url) => {
            if (quitting || configuredTarget !== undefined || generation !== connectionGeneration) return
            markLocalRuntimeReady(url)
          }, () => {})
        }, delayMs)
        return
      }
      if (!wasReady) {
        console.error('[desktop] dsh web failed to start (' + String(code) + '/' + String(signal) + '); no relaunches left')
        showLocalRuntimeStartupFailure(code, signal)
        return
      }
      // A live window lost its runtime, and the retry budget is spent. The
      // surface stays interactive rather than quitting under the user: a
      // deliberate retry (or another address) is still a way out.
      console.error('[desktop] dsh web exited (' + String(code) + '/' + String(signal) + ')')
      const chinese = localeChinese()
      showConnectionError({
        kind: 'runtime',
        headline: chinese ? '本地服务意外退出' : 'The local service exited unexpectedly',
        detail: (chinese ? '代码 ' : 'code ') + String(code) + (chinese ? ' / 信号 ' : ' / signal ') + String(signal),
      })
    },
  )

  applyConnectionSettings(settings)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) {
      launchWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // Every webContents, including any the runtime or a dependency creates
  // later, inherits the same rule: nothing opens a second window, http(s)
  // links leave for the system browser, everything else is dropped.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
  })

  void app.whenReady().then(async () => {
    app.setName('DeepSeek Harness Desktop')
    // Electron grants most permission requests when an app installs no
    // handler. The official Web UI asks for none of them (its only clipboard
    // use is writeText), and in Connect mode the page doing the asking is a
    // remote origin — so: deny by default, grant only to the client's current
    // target, and keep fullscreen loopback-only so a remote page cannot
    // redraw the whole screen as a surface the client did not paint.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permissionGranted(contents, permission))
    })
    session.defaultSession.setPermissionCheckHandler((contents, permission) => permissionGranted(contents, permission))
    session.defaultSession.setDevicePermissionHandler(() => false)
    // Downloads otherwise land in ~/Downloads silently. Only the client's own
    // active target may trigger one; anything else — a stray frame, an
    // adopted impostor — is denied rather than allowed to fill the disk or
    // drop files for the user to click.
    session.defaultSession.on('will-download', (event, item, webContents) => {
      if (permissionTrustedSurface(webContents)) return
      event.preventDefault()
      void item.cancel()
    })
    // Packaged macOS builds use the bundle icon. Do not replace it at runtime
    // with the pre-masked PNG: macOS 26 adds its own enclosure around that
    // image and produces a visible double border. An unpackaged run has no
    // bundle icon at all, so there the PNG is still better than Electron's
    // default dock tile.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const dockIcon = nativeImage.createFromPath(ICON_PNG)
      if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon)
    }
    // Paint immediately. Runtime probing/boot continues behind this one window
    // and replaces the loading document with the official Web UI when ready.
    nativeTheme.on('updated', syncWindowBackgrounds)
    ipcMain.on('desktop:theme', onRendererTheme)
    mainWindowRequested = true
    createWindow()
    const guiPathReady = restoreMacGuiPath()
    desktopUpdater = createDesktopUpdater()
    desktopUpdater.onChange(broadcastUpdateState)
    await startSettingsServer()
    installMenu()
    createTray()
    // After both exist: the watcher's first pass rebuilds them if the Web UI's
    // language setting disagrees with the system locale they were built from.
    watchLocalePreference()
    powerMonitor.on('resume', () => { scheduleWindowHealthCheck('system resume', 3_000) })
    windowHealthTimer = setInterval(() => { void recoverBlankWindow('periodic health check') }, WINDOW_HEALTH_INTERVAL_MS)
    windowHealthTimer.unref()
    schedulePeriodicAutoUpdateChecks()
    // The official page's enhanced-features card bridges through these. Every
    // handler resolves its sender first (see bridgeCaller): the preload rides
    // on whatever the window loads, so "the renderer asked" is not by itself
    // evidence that the client's own UI asked.
    ipcMain.handle('desktop:connection:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return getStatusJson(!caller.remote)
    })
    // The marketplace opt-out. Read and write only: taking the seat back is
    // the client's own job on the next spawn, and doing it here would fight
    // whatever the running child already loaded.
    ipcMain.handle('desktop:market:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return { enabled: loadSettings().bundledMarketDisabled !== true }
    })
    ipcMain.handle('desktop:market:set', async (event, enabled: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      if (typeof enabled !== 'boolean') return { enabled: loadSettings().bundledMarketDisabled !== true }
      // A state change asked for by a REMOTE origin gets the same native
      // confirmation an address change does. Turning the seat off deletes a
      // directory inside the user's own `~/.dsh`; a page served from
      // somewhere else must not be able to do that quietly just because the
      // window happens to be pointed at it.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          enabled ? '接入内置插件市场？' : '移除内置插件市场？',
          enabled
            ? '当前页面来自远端来源，它请求让本客户端在下次启动时接入内置插件市场。'
            : '当前页面来自远端来源，它请求移除内置插件市场：本机 profile 中的插件条目与复制的插件目录都会被删除。',
        )
        if (!confirmed) return { enabled: loadSettings().bundledMarketDisabled !== true }
      }
      patchSettings({ bundledMarketDisabled: !enabled })
      if (!enabled) {
        // Do it now rather than at the next spawn: the user just asked for it
        // to be gone, and a profile that still lists it until the next start
        // is the same "it will not go away" the durable flag exists to avoid.
        if (abandonBundledPlugin(childHome())) {
          console.log('[desktop] bundled plugin removed: turned off in connection settings')
        }
        bundledPluginSeatInUse = false
      }
      return { enabled }
    })
    ipcMain.handle('desktop:connection:probe', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // What answers on this machine's loopback is local detail: a configured
      // remote page may render the connection card, not survey the port.
      if (caller.remote) return { url: null }
      return probeDefaultWebUi()
    })
    ipcMain.handle('desktop:connection:save', async (event, serverUrl: unknown) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      return requestServerUrlSave(serverUrl, caller.remote)
    })
    ipcMain.handle('desktop:connection:switch', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // A persistent mode flip asked for by a REMOTE origin gets the same
      // native confirmation every other state change does: the window may be
      // pointed at a page that must not repoint the client silently.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求切换连接模式' : 'The current page asked to switch the connection mode',
          (localeChinese()
            ? '这会让客户端在智能模式与固定地址之间切换。请求来自：'
            : 'This flips the client between Smart mode and the pinned address. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) return { switched: false, error: localeChinese() ? '已取消' : 'Cancelled' }
      }
      return switchConnectionMode()
    })
    ipcMain.on('desktop:open-connection-settings', (event) => {
      if (!bridgeCaller(event).trusted) return
      openSettingsWindow()
    })
    ipcMain.on('desktop:local:retry', (event) => {
      if (!localDocumentCaller(event)) return
      retryConnection()
    })
    ipcMain.on('desktop:local:quit', (event) => {
      if (!localDocumentCaller(event)) return
      app.quit()
    })
    // The way out of a pinned address that stopped answering. The address is
    // kept, so switching back is one click once it is up again.
    ipcMain.on('desktop:local:use-smart', (event) => {
      if (!localDocumentCaller(event)) return
      patchSettings({ connectionMode: 'smart' })
      errorDocumentActive = false
      showLoadingDocument()
      applyConnectionSettings(loadSettings(), true)
    })
    ipcMain.handle('desktop:update:status', (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      const state = desktopUpdater?.getState()
      return state === undefined ? undefined : updateStateForCaller(state, caller.remote)
    })
    ipcMain.handle('desktop:update:check', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      // A check also clears "ignore this version" and spends this machine's
      // requests against the update host; a remote page may not do either
      // without the person at the keyboard.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          localeChinese() ? '当前页面请求检查更新' : 'The current page asked to check for updates',
          (localeChinese() ? '这会清除「忽略此版本」记录并访问更新服务器。请求来自：' : 'This clears the "skip this version" record and contacts the update server. Requested by: ')
          + (currentTarget() ?? ''),
        )
        if (!confirmed) return { hasUpdate: false }
      }
      desktopUpdater?.resetDismiss()
      return desktopUpdater?.check() ?? { hasUpdate: false }
    })
    ipcMain.handle('desktop:update:install', async (event) => {
      const caller = bridgeCaller(event)
      if (!caller.trusted) throw bridgeDenied()
      const chinese = localeChinese()
      // Installing runs an executable this machine downloaded. A remote page
      // may ask; only the person at the keyboard may answer.
      if (caller.remote) {
        const confirmed = await confirmSensitiveAction(
          chinese ? '当前页面请求下载并安装更新' : 'The current page asked to download and install an update',
          (chinese ? '安装程序会在本机运行。请求来自：' : 'The installer will run on this machine. Requested by: ')
          + (currentTarget() ?? ''),
        )
        // Declining is an answer, not a failure: the card says so, and says
        // it without the "update failed" prefix.
        if (!confirmed) return { started: false, cancelled: true }
      }
      const result = await installDesktopUpdate()
      if (result.started) scheduleQuitAfterWindowsInstall()
      // The failure reason names local paths for the same reasons the status
      // does; a remote caller learns that it failed, not where.
      if (!result.started && caller.remote && result.error !== undefined) {
        return { started: false, error: chinese ? '更新失败' : 'Update failed' }
      }
      return result
    })
    ipcMain.handle('desktop:update:dismiss', (event) => {
      if (!bridgeCaller(event).trusted) return
      desktopUpdater?.dismiss()
    })
    await guiPathReady
    boot()
    app.on('activate', () => {
      if (mainWindow === null) launchWindow()
    })
  }).catch((error: unknown) => {
    dialog.showErrorBox('Harness', '桌面客户端启动失败。\n' + (error instanceof Error ? error.message : String(error)))
    app.quit()
  })

  app.on('window-all-closed', () => {
    // Tray-resident client: closing the last window keeps the app running.
    // Quit happens through the tray menu, the app menu, or Cmd+Q.
  })

  // Quit owns the local child: the stop ladder runs before the process exits,
  // so the runtime never outlives the client as an orphan holding the data
  // home and a port.
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (windowHealthTimer !== undefined) clearInterval(windowHealthTimer)
    if (launchBudgetResetTimer !== undefined) clearTimeout(launchBudgetResetTimer)
    void (async () => {
      // A restart carries one extra step: the owned child is stopped below
      // either way, but an adopted one would otherwise outlive this process
      // and be adopted right back by the successor.
      try {
        if (restarting) await stopAdoptedRuntimeForRestart()
        await webUi?.stop()
      } catch (error) {
        // Never strand the app in a half-quit state over a failed stop: the
        // ladder is best-effort, the quit is not.
        console.error('[desktop] shutdown ladder failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      app.quit()
    })()
  })
}
