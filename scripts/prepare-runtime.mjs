/**
 * Materialize the official dsh production closure for electron-builder.
 * pnpm's deployed node_modules preserves auto-installed peer packages that
 * electron-builder's dependency walker otherwise omits.
 * @module desktop/scripts/prepare-runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoTsEntryPoints } from './ts-entry-guard.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const destination = join(APP_DIR, '.runtime')
await rm(destination, { recursive: true, force: true })

const pnpmArgs = [
  '--filter',
  'dsh-desktop-runtime',
  'deploy',
  '--prod',
  '--frozen-lockfile',
  // A hoisted closure is what survives packaging. pnpm's default layout puts
  // auto-installed peers under .pnpm/node_modules and reaches them by walking
  // up from a symlink's realpath; the Windows NSIS installer materializes those
  // symlinks as real directories, which strands the peers and left the
  // installed build unable to import @deepseek-ai/dsh-app-boot. Hoisting also
  // flattens .pnpm's long store paths, keeping the installed tree inside the
  // 260-character Windows MAX_PATH that the default layout overshot.
  '--node-linker=hoisted',
  '.runtime',
]

// Node 24 no longer launches Windows batch files directly with spawn(). Run
// pnpm through cmd.exe there; every argument is a fixed project-owned value.
const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', ['pnpm', ...pnpmArgs].join(' ')]
  : pnpmArgs
const child = spawn(command, args, { cwd: APP_DIR, stdio: 'inherit' })

const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})
if (code !== 0) throw new Error('dsh runtime deployment failed (code=' + String(code) + ')')

/**
 * Build artefacts that no runtime code path can execute: source maps,
 * TypeScript declarations and sources, and Windows debug symbols (the .pdb
 * files node-pty ships inside its win32 prebuilds are the largest single
 * chunk). Removing them cuts the file count the packager compresses and the
 * installer writes back out, which is the dominant cost of the Windows
 * release job.
 *
 * Matching is by extension only. Pruning conventional directory names is not
 * safe here: `yaml` ships its runtime composer under `dist/doc/`, so a rule
 * that dropped `doc/` silently removed executable code and the packaged app
 * failed to boot.
 *
 * `.md` is deliberately NOT pruned: some packages carry their only licence
 * text in a README (data-uri-to-buffer's README ends with the full MIT text
 * and the package has no LICENSE file; @img/sharp-libvips-* ships the licence
 * table of every bundled third-party library in its README). The closure is
 * redistributed inside the installer, so those files must survive — the ~6 MB
 * they cost is the price of keeping the redistribution lawful.
 */
const PRUNED_EXTENSIONS = ['.map', '.d.ts', '.d.cts', '.d.mts', '.pdb', '.ts']
const isPrunedFile = name => PRUNED_EXTENSIONS.some(extension => name.endsWith(extension))

let prunedFiles = 0
let prunedBytes = 0
async function prune(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    // Symlinks are followed by neither branch: the hoisted closure keeps a few,
    // and descending through them would leave the real target half-pruned.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await prune(path)
      continue
    }
    if (!entry.isFile() || !isPrunedFile(entry.name)) continue
    prunedBytes += (await stat(path)).size
    prunedFiles += 1
    await rm(path, { force: true })
  }
}

const runtimeModules = join(destination, 'node_modules')
await prune(runtimeModules)
console.log('[runtime] pruned ' + prunedFiles + ' development entries ('
  + (prunedBytes / 1e6).toFixed(1) + ' MB) from ' + relative(APP_DIR, runtimeModules))

/** Every file under `directory`, recursively. */
async function collectFiles(directory, into = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, into)
    else if (entry.isFile()) into.push(path)
  }
  return into
}

/**
 * Directories this closure ships and no runtime code path executes, each named
 * by its exact relative location. Pruning by directory *name* anywhere would be
 * the same class of bug as pruning `doc/` (see prune() above: `yaml` keeps
 * runtime code under `dist/doc/`), so every entry here is a full path checked
 * against the owning package's manifest.
 *
 * Windows install time is paid per file, not per byte — the NSIS installer
 * creates each packaged file individually, and locally 283 MB in 20 files
 * copies in 0.3 s while 124 MB in 12508 files takes 11.6 s — so what an entry
 * is worth is the file count it removes, not the megabytes.
 *
 * - `@mixmark-io/domino/test`: mocha fixtures. The manifest resolves `main` to
 *   `./lib` and mentions test/ only from its `mocha` devDependency script, so
 *   nothing the client runs can reach it. 959 of the package's 1022 files sit
 *   here — around 8% of the entire closure, and the single largest block of
 *   dead files left in it.
 * - `pnpm/artifacts`: a standalone Node executable (~18 MB) this client never
 *   launches — the Agent runs `pnpm.mjs` on Electron's own Node.
 */
const PRUNED_DIRECTORIES = [
  ['@mixmark-io', 'domino', 'test'],
  ['pnpm', 'artifacts'],
]

for (const segments of PRUNED_DIRECTORIES) {
  const label = segments.join('/')
  const directory = join(runtimeModules, ...segments)
  if (!existsSync(directory)) {
    // Not fatal: upstream may legitimately stop shipping one of these, and a
    // release should not fail over a directory that is already gone. Say it
    // out loud so a rename surfaces in the build log rather than silently
    // putting the files back into the installer.
    console.log('[runtime] nothing to prune at ' + label + ' — upstream layout may have changed')
    continue
  }
  const files = await collectFiles(directory)
  let bytes = 0
  for (const file of files) bytes += (await stat(file)).size
  await rm(directory, { recursive: true, force: true })
  console.log('[runtime] pruned ' + label + ' (' + files.length + ' files, '
    + (bytes / 1e6).toFixed(1) + ' MB)')
}

const pnpmBin = join(runtimeModules, 'pnpm', 'bin', 'pnpm.mjs')
if (!existsSync(pnpmBin)) {
  throw new Error('pnpm bin missing after deploy: ' + pnpmBin + ' — add pnpm to dsh-runtime/package.json')
}

// The .ts prune is only safe while no manifest resolves to a .ts file at
// runtime; this invariant fails the release job with the offending package
// name if a future dependency starts shipping one. See ts-entry-guard.mjs.
await assertNoTsEntryPoints(runtimeModules)
console.log('[runtime] no manifest resolves to a pruned .ts entry point')

/**
 * node-pty is the one package whose npm tarball ships prebuilds for every
 * platform in a single archive, so pnpm's own os/cpu filtering cannot trim it
 * (each platform's directory lands in the closure no matter where the build
 * runs). The release CI knows its target — a native runner — and passes it as
 * DSH_RUNTIME_TARGET, e.g. `win32-x64`; every other prebuild directory is dead
 * weight and is removed here.
 *
 * The default (unset) keeps them all: a local cross-build (macOS → the
 * win-unpacked smoke target) must not lose the win32 binaries the artifact
 * needs to boot.
 */
const RUNTIME_TARGET = process.env.DSH_RUNTIME_TARGET
if (RUNTIME_TARGET !== undefined) {
  // Shape only. What the target must actually be is decided below against the
  // directories node-pty really ships — a list that no regex here can stay in
  // sync with. `linux` is absent because no linux artifact is released — the
  // matrix is macOS arm64/x64 and Windows x64 — not because node-pty lacks the
  // prebuild: it has shipped linux-x64 and linux-arm64 since 1.2.0-beta.15.
  // Re-enabling a linux release means widening this shape too.
  if (!/^(darwin|win32)-(arm64|x64)$/.test(RUNTIME_TARGET)) {
    throw new Error('invalid DSH_RUNTIME_TARGET: ' + RUNTIME_TARGET + ' (expected e.g. win32-x64)')
  }
  const prebuilds = join(runtimeModules, 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) {
    // node-pty is a transitive dependency of dsh-subprocess-local that the
    // hoisted layout hoists to the top level. Fail loud rather than silently
    // shipping every platform's binaries: a renamed package or a layout change
    // must be visible in the release job, not baked into the installer.
    throw new Error('node-pty prebuilds directory not found at ' + prebuilds + ' — the hoisted layout changed; update this prune')
  }
  const available = (await readdir(prebuilds, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  // Deleting "everything that is not the target" is only a prune while the
  // target is one of the things there. If node-pty renames its directories, or
  // stops publishing a platform, that same loop is a delete-all that leaves an
  // installer with no pty.node — and the package smoke would not catch it,
  // because the client loads node-pty lazily and `host.describe` never opens a
  // terminal. Decide it here, where the failure is a red release job.
  if (!available.includes(RUNTIME_TARGET)) {
    throw new Error('node-pty ships no ' + RUNTIME_TARGET + ' prebuild (available: '
      + (available.join(', ') || 'none') + ') — the prebuild layout changed; update this prune')
  }
  let removedFiles = 0
  let removedBytes = 0
  for (const name of available) {
    if (name === RUNTIME_TARGET) continue
    const directory = join(prebuilds, name)
    const files = await collectFiles(directory)
    for (const file of files) removedBytes += (await stat(file)).size
    removedFiles += files.length
    await rm(directory, { recursive: true, force: true })
  }
  // The kept directory is what the client will dlopen at runtime; an empty one
  // means the .pdb/.map prune above matched more than it should have.
  const keptFiles = await collectFiles(join(prebuilds, RUNTIME_TARGET))
  if (keptFiles.length === 0) {
    throw new Error('node-pty ' + RUNTIME_TARGET + ' prebuild directory is empty after pruning')
  }
  if (removedFiles > 0) {
    console.log('[runtime] node-pty prebuilds kept ' + RUNTIME_TARGET + ' (' + keptFiles.length
      + ' files), removed ' + removedFiles + ' other-platform files ('
      + (removedBytes / 1e6).toFixed(1) + ' MB)')
  }

  /**
   * node-pty also vendors ConPTY under `third_party/conpty/<version>/win10-*`,
   * which the prebuilds prune above does not reach. Same reasoning: a win32-x64
   * artifact has no use for the arm64 pair, and a darwin one has no use for
   * either.
   *
   * There is a second reason to remove them rather than leave them as dead
   * weight. Those two files are in `release/win-unpacked` and in no installed
   * tree — not the one this repository builds, and not the shipped 0.3.1 —
   * so electron-builder's 7z step drops them somewhere between the packed
   * directory and the archive. That has never been root-caused. Taking them
   * out at the source removes the instance; scripts/check-nsis-install.ps1
   * compares the installed tree against win-unpacked file by file, which is
   * what would catch it happening to anything else.
   */
  const conptyVendor = join(runtimeModules, 'node-pty', 'third_party', 'conpty')
  if (existsSync(conptyVendor)) {
    const wanted = RUNTIME_TARGET === 'win32-x64' ? 'win10-x64'
      : RUNTIME_TARGET === 'win32-arm64' ? 'win10-arm64'
      : undefined
    let removedConptyFiles = 0
    let removedConptyBytes = 0
    let keptConpty = 0
    for (const version of await readdir(conptyVendor, { withFileTypes: true })) {
      if (!version.isDirectory()) continue
      const versionDir = join(conptyVendor, version.name)
      const platforms = (await readdir(versionDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      // Same bar as the prebuilds prune: "delete everything that is not the
      // target" is only a prune while the target is one of the things there.
      if (wanted !== undefined && !platforms.includes(wanted)) {
        throw new Error('node-pty vendors no ' + wanted + ' ConPTY under ' + versionDir
          + ' (available: ' + (platforms.join(', ') || 'none') + ') — the layout changed; update this prune')
      }
      for (const platform of platforms) {
        if (platform === wanted) {
          keptConpty += (await collectFiles(join(versionDir, platform))).length
          continue
        }
        const directory = join(versionDir, platform)
        for (const file of await collectFiles(directory)) {
          removedConptyBytes += (await stat(file)).size
          removedConptyFiles += 1
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
    if (removedConptyFiles > 0) {
      console.log('[runtime] node-pty vendored ConPTY kept ' + (wanted ?? 'nothing') + ' (' + keptConpty
        + ' files), removed ' + removedConptyFiles + ' other-platform files ('
        + (removedConptyBytes / 1e6).toFixed(1) + ' MB)')
    }
  }
}
