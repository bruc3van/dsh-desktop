import type { RuntimeEnvironment } from './runtime-environment.ts'
/** Discovers runtime commands and owns per-session detection/rejection caches. */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devFlag, devOverride } from './development-options.ts'
import { officialDshPackageVersion } from './official-dsh-bin.ts'
import { killProcessTree } from './process-tree.ts'
import { executableCandidates, isSameDirectory, normalizePathEntry, npxCacheRoot, parseVersionOutput, spawnTargetFor } from './runtime-resolution.ts'
import { BundledRuntimeMissingError, NoEnabledSmartRuntimeError, type DshCommand } from './runtime-types.ts'
import { smartRuntimeEnabled, type SmartRuntimeId } from './smart-runtimes.ts'
import { compareVersions } from './updater.ts'

const SPAWN_NO_WINDOW = { windowsHide: true } as const
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

interface RuntimeCatalogOptions {
  environment: RuntimeEnvironment
  clientHome(): string
  enabledSmartRuntimes(): SmartRuntimeId[]
  bundledDshVersion(): string | null
  localeChinese(): boolean
}

export function createRuntimeCatalog(options: RuntimeCatalogOptions) {
  const { clientHome, enabledSmartRuntimes, bundledDshVersion, localeChinese } = options
  const { nodeForChild, runtimeLauncher, resolveBundledDsh } = options.environment
  let pathInstalledDsh: InstalledDsh | undefined
  let npxInstalledDsh: InstalledDsh | undefined
  /**
   * Set when that source failed to reach readiness. The rest of the session
   * skips it: retrying a runtime this client does not control, against the
   * same failure, only spends the recovery budget. PATH and npx are tracked
   * separately so a dead PATH install does not also discard a working cache.
   */
  let pathInstalledDshRejected = false
  let npxInstalledDshRejected = false
  let installedDshDetection: Promise<void> | undefined
  /** The selected npx-cached dsh is older than the bundled runtime (note, not veto). */
  let npxCacheOutdated = false
  let overrideDshVersionCache: { key: string; version: string | undefined } | undefined

  /**
   * Locate an executable on the ambient PATH, the way a shell would. The client's
   * own shim directory is excluded: it publishes Electron's Node / the bundled
   * `dsh` / the bundled `pnpm` under those names, and a lookup that resolved to
   * any of them would report the client's own tools back as if the user had
   * installed them.
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

  /** The user-installed dsh Smart mode would spawn next, if any. */
  function selectedInstalledDsh(): InstalledDsh | undefined {
    const enabled = enabledSmartRuntimes()
    if (smartRuntimeEnabled(enabled, 'installed') && pathInstalledDsh !== undefined && !pathInstalledDshRejected) {
      return pathInstalledDsh
    }
    if (smartRuntimeEnabled(enabled, 'npx') && npxInstalledDsh !== undefined && !npxInstalledDshRejected) {
      return npxInstalledDsh
    }
    return undefined
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
          ...SPAWN_NO_WINDOW,
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
   * Sync `--version` for a spawn that is about to happen anyway. Used by the
   * DSH_DESKTOP_DSH override: resolveDshCommand is synchronous, and without a
   * version the `--no-open` gate treats rc.8+ as too old and the system
   * browser opens beside this window.
   */
  function readCommandVersionSync(
    command: string,
    args: readonly string[] = [],
    shell = false,
    timeoutMs = 5_000,
  ): string | undefined {
    try {
      const result = spawnSync(command, [...args, '--version'], {
        cwd: homedir(),
        env: process.env,
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell,
        ...SPAWN_NO_WINDOW,
      })
      if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
      return parseVersionOutput(result.stdout)
    } catch {
      return undefined
    }
  }

  function versionForOverride(key: string, read: () => string | undefined): string | undefined {
    if (overrideDshVersionCache?.key === key) return overrideDshVersionCache.version
    const version = read()
    overrideDshVersionCache = { key, version }
    return version
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
      // Both sources, independently: Smart-mode toggles pick between them later,
      // and a dead PATH install must not also hide a working npx cache.
      pathInstalledDsh = await detectDshOnPath()
      npxInstalledDsh = detectDshInNpxCache()
      if (pathInstalledDsh === undefined && npxInstalledDsh === undefined) {
        console.log('[desktop] no user-installed dsh found; using the bundled runtime')
        return
      }
      if (pathInstalledDsh !== undefined) {
        console.log('[desktop] user-installed dsh detected (installed): '
          + pathInstalledDsh.path + ' (v' + pathInstalledDsh.version + ')')
      }
      if (npxInstalledDsh !== undefined) {
        console.log('[desktop] user-installed dsh detected (npx): '
          + npxInstalledDsh.path + ' (v' + npxInstalledDsh.version + ')')
        // The cache never re-resolves `latest` on its own — it is whatever the
        // user's last `npx @deepseek-ai/dsh` run left behind — so after an in-app
        // update it can lag the runtime this client ships. It stays preferred
        // (the user's own runtime, on their own Node), but the connection surfaces
        // say so: a person who only opens the desktop client would otherwise never
        // learn that re-running npx gets them the newer copy they already carry.
        const bundled = bundledDshVersion()
        if (bundled !== null && compareVersions(bundled, npxInstalledDsh.version) > 0) {
          npxCacheOutdated = true
          console.log('[desktop] npx-cached dsh v' + npxInstalledDsh.version
            + ' is older than the bundled v' + bundled + '; keeping the cache — re-run npx to refresh it')
        }
      }
    })()
    return installedDshDetection
  }

  function resolveDshCommand(): DshCommand {
    const explicit = devOverride('DSH_DESKTOP_DSH')
    if (explicit !== undefined && explicit.trim() !== '') {
      // A `.mjs`/`.js` override is a script, not an image. Windows CreateProcess
      // rejects it with EFTYPE; POSIX only works because of the shebang. Run it
      // on the same Node the bundled runtime uses.
      if (/\.[cm]?js$/i.test(explicit)) {
        const command = nodeForChild()
        return {
          command,
          args: [explicit],
          label: explicit,
          source: 'override',
          version: versionForOverride(explicit, () =>
            readCommandVersionSync(command, [explicit]) ?? officialDshPackageVersion(explicit)),
        }
      }
      // Same spawn rules as a PATH install: a Windows `.cmd` override is a
      // batch script, not an image. Spawning it without the shell is EFTYPE.
      const target = spawnTargetFor(explicit, process.platform)
      return {
        command: target.command,
        args: [],
        ...target.shell && { shell: true },
        label: explicit,
        source: 'override',
        version: versionForOverride(explicit, () =>
          readCommandVersionSync(target.command, [], target.shell === true)
          ?? officialDshPackageVersion(explicit)),
      }
    }
    const enabled = enabledSmartRuntimes()
    const installed = selectedInstalledDsh()
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
    if (smartRuntimeEnabled(enabled, 'bundled')) {
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
          return {
            command: node,
            args: [runtimeLauncher()],
            entry: bin,
            binPath: bin,
            label: bin,
            source: 'checkout',
            version: officialDshPackageVersion(bin),
          }
        }
      }
      return { command: 'dsh', args: [], label: 'dsh', source: 'path' }
    }
    throw new NoEnabledSmartRuntimeError(localeChinese())
  }

  return {
    resolveDshCommand, selectedInstalledDsh, detectInstalledDsh,
    get detectionStarted() { return installedDshDetection !== undefined },
    get npxCacheOutdated() { return npxCacheOutdated },
    resetRejectedSources(): void {
      pathInstalledDshRejected = false
      npxInstalledDshRejected = false
    },
    rejectFailedSource(source: DshCommand['source'] | undefined): boolean {
      if (source === 'installed' && !pathInstalledDshRejected) { pathInstalledDshRejected = true; return true }
      if (source === 'npx' && !npxInstalledDshRejected) { npxInstalledDshRejected = true; return true }
      return false
    },
  }
}
export type RuntimeCatalog = ReturnType<typeof createRuntimeCatalog>
