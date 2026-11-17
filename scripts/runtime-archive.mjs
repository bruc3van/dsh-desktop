/**
 * The bundled runtime ships as one ASAR archive, plus beside it the files an
 * archive cannot hold.
 *
 * Why an archive: the closure is ~18 000 files, almost all of them small, and
 * on Windows every one of them is paid for individually — by the installer
 * writing it, by the real-time scanner opening it, and by the next upgrade's
 * uninstall deleting it. Measured on one machine with Defender on, copying the
 * loose tree took 20.5 s and deleting it 7.4 s; the archive layout (one file
 * plus ~950 unpacked ones) took 1.2 s and 0.4 s, and `dsh web` reached
 * readiness sooner from it (1.4 s against 2.0 s).
 *
 * Electron's Node — which is what runs the runtime, through
 * ELECTRON_RUN_AS_NODE — reads any `*.asar` path as a read-only directory, so
 * imports, `require`, `fs.readFile` and worker threads inside it work
 * unchanged. Three things do not, and decide what stays outside:
 *
 * - the operating system cannot execute or load a file inside the archive, so
 *   every executable and native library is unpacked (Electron redirects a
 *   `.node` load to the unpacked copy, and the DLLs beside it are found there);
 * - a process other than Electron's Node cannot read the archive at all, so
 *   whole packages that another program reads by path are unpacked: the
 *   LibreOffice kit's engine, and pnpm, which upstream also keeps outside its
 *   archive and which runs node-gyp's Python sources;
 * - nothing can write into it — the runtime treats its installation as
 *   read-only already, as the official desktop app runs these same packages
 *   from `app.asar`.
 *
 * Upstream helpers already understand the layout and rewrite an in-archive
 * path to its unpacked copy before handing it to the operating system:
 * `dsh-util-ripgrep` and `dsh-office-kit` for any `*.asar/`, the macOS Computer
 * Use helper only for a segment named exactly `app.asar/`. That last one is
 * why the archive is `resources/dsh-runtime/app.asar` and not a name of our
 * own. Landlock's launcher had no such rewrite; this repository's patch of
 * `@deepseek-ai/dsh-sandbox-local` adds the same `app.asar` one.
 *
 * The rules below are by name and pattern, and they can miss something.
 * `verifyRuntimeArchive` is what makes a miss impossible to ship: it reads the
 * first bytes of every file and refuses an archive that holds a PE, ELF or
 * Mach-O binary anywhere but in the unpacked directory, and it proves both
 * halves are byte-identical to the prepared closure.
 * @module desktop/scripts/runtime-archive
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, lstat, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Where prepare:runtime writes the archive; electron-builder copies it from here. */
export const RUNTIME_ARCHIVE_DIR = join(APP_DIR, '.runtime-archive')
/** The archive's file name: see above for why it must be exactly this. */
export const RUNTIME_ARCHIVE_NAME = 'app.asar'
/** The directory under `resources` that holds the archive and its unpacked half. */
export const RUNTIME_RESOURCES_DIR = 'dsh-runtime'

/**
 * Basenames unpacked wherever they sit: native modules and libraries, Windows
 * executables, and the two extensionless executables the closure starts
 * (node-pty's macOS `spawn-helper`, ripgrep's POSIX `rg`).
 */
export const UNPACKED_FILES = '{*.node,*.dll,*.exe,*.so,*.so.*,*.dylib,spawn-helper,rg}'

/**
 * Directories unpacked whole, relative to the archive root:
 * - the LibreOffice kit's platform package, an application directory its
 *   engine opens by path;
 * - pnpm, so that package installs — the one runtime path that runs other
 *   programs against its own files — behave exactly as before;
 * - the system addon's platform packages, whose `bin/landlock-run` is the
 *   Linux file-sandbox launcher (extensionless, so no file rule catches it);
 * - the macOS Computer Use helper, which LaunchServices opens as an
 *   application bundle, as upstream also unpacks it.
 */
export const UNPACKED_PACKAGES = 'node_modules/{pnpm,@deepseek-ai/libreoffice-kit-*-*,'
  + '@deepseek-ai/node-addon-system-*-*,@deepseek-ai/dsh-experimental-cua-macos/native/bin}'

/**
 * Locations inside a packaged app's resources directory. Keep in step with
 * electron-builder.yml and src/main/runtime-environment.ts.
 * @param {string} resources
 */
export function packagedRuntimePaths(resources) {
  const archive = join(resources, RUNTIME_RESOURCES_DIR, RUNTIME_ARCHIVE_NAME)
  const unpacked = archive + '.unpacked'
  return {
    archive,
    unpacked,
    /** Readable only by Electron's Node. */
    dshEntry: join(archive, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    /** A real file: pnpm is unpacked whole. */
    pnpmEntry: join(unpacked, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  }
}

/** The @electron/asar copy electron-builder itself uses; not a direct dependency. */
function loadAsar() {
  const fromBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'))
  return createRequire(fromBuilder.resolve('app-builder-lib/package.json'))('@electron/asar')
}

/**
 * Pack `<runtimeRoot>/node_modules` into RUNTIME_ARCHIVE_DIR. Only the
 * node_modules tree goes in, so the archive holds what `resources/dsh-runtime`
 * used to: the deploy's own package.json and lockfile stay behind.
 * @param {string} runtimeRoot The pnpm deploy directory (`.runtime`).
 * @returns {Promise<string>} The archive path.
 */
export async function packRuntimeArchive(runtimeRoot, outDir = RUNTIME_ARCHIVE_DIR) {
  const asar = loadAsar()
  const archive = join(outDir, RUNTIME_ARCHIVE_NAME)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await asar.createPackageWithOptions(runtimeRoot, archive, {
    pattern: '/node_modules/**/*',
    unpack: UNPACKED_FILES,
    unpackDir: UNPACKED_PACKAGES,
  })
  return archive
}

/** A binary the operating system loads or runs, by its leading bytes. */
export function isNativeBinary(name, head) {
  if (head.length < 4) return false
  if (head[0] === 0x4d && head[1] === 0x5a) return true // PE: MZ
  const magic = head.readUInt32BE(0)
  if (magic === 0x7f454c46) return true // ELF
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true // Mach-O
  // Fat Mach-O shares its magic with Java class files.
  return (magic === 0xcafebabe || magic === 0xbebafeca) && !name.endsWith('.class')
}

/** Header entries keyed by `node_modules/...` with forward slashes. */
function flattenHeader(node, prefix, into) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : prefix + '/' + name
    if (child.files !== undefined) flattenHeader(child, path, into)
    else into.set(path, child)
  }
  return into
}

async function walk(directory, into = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, into)
    else into.push(path)
  }
  return into
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Prove that an archive and its unpacked directory hold exactly the prepared
 * closure, and that every native binary is in the unpacked half.
 *
 * Runs at prepare time against the fresh archive and again by smoke:package
 * against the one a packaged or installed app actually carries — which is what
 * catches an archive left over from an older prepare.
 *
 * A packaged macOS app is the one place an unpacked file may legitimately
 * differ: code signing embeds a signature into every Mach-O binary of the
 * bundle, the unpacked half included. With `signedNative`, an unpacked file
 * that is a native binary both before and after need only be present; every
 * other file, and everything inside the archive, is still compared byte for
 * byte. The signature itself is checked by codesign and by smoke:dmg.
 * @param {string} archive Path to the runtime's `app.asar`.
 * @param {string} sourceModules The prepared `.runtime/node_modules`.
 * @param {{ signedNative?: boolean }} [options]
 * @returns {Promise<{ files: number, unpacked: number, signed: number, bytes: number }>}
 */
export async function verifyRuntimeArchive(archive, sourceModules, { signedNative = false } = {}) {
  const asar = loadAsar()
  // An installed archive is read by path, so an earlier read in this process
  // (the prepare-time check) must not answer for a different file.
  asar.uncacheAll()
  const entries = flattenHeader(asar.getRawHeader(archive).header, '', new Map())
  const failures = []
  let unpacked = 0
  let signed = 0
  let bytes = 0
  const seen = new Set()
  for (const file of await walk(sourceModules)) {
    const key = ['node_modules', ...relative(sourceModules, file).split(sep)].join('/')
    seen.add(key)
    const entry = entries.get(key)
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) {
      if (entry?.link === undefined) failures.push('symlink not recorded as a link: ' + key)
      continue
    }
    if (entry === undefined || entry.link !== undefined) {
      failures.push('missing from the archive: ' + key)
      continue
    }
    const content = await readFile(file)
    bytes += content.length
    const hash = sha256(content)
    if (entry.integrity?.hash !== hash || Number(entry.size) !== content.length) {
      failures.push('differs from the prepared closure: ' + key)
      continue
    }
    if (entry.unpacked === true) {
      unpacked += 1
      let copy
      try {
        copy = await readFile(join(archive + '.unpacked', ...key.split('/')))
      } catch {
        failures.push('marked unpacked but absent beside the archive: ' + key)
        continue
      }
      if (sha256(copy) === hash) continue
      if (signedNative && isNativeBinary(key, content.subarray(0, 4)) && isNativeBinary(key, copy.subarray(0, 4))) {
        signed += 1
        continue
      }
      failures.push('unpacked copy differs from the prepared closure: ' + key)
    } else if (isNativeBinary(key, content.subarray(0, 4))) {
      failures.push('native binary packed inside the archive, where nothing can load or run it: ' + key
        + ' — extend UNPACKED_FILES or UNPACKED_PACKAGES in scripts/runtime-archive.mjs')
    }
  }
  for (const key of entries.keys()) {
    if (!seen.has(key)) failures.push('in the archive but not in the prepared closure: ' + key)
  }
  if (failures.length > 0) {
    const shown = failures.slice(0, 20).map(line => '  - ' + line).join('\n')
    throw new Error('runtime archive ' + archive + ' does not match ' + sourceModules + ' ('
      + failures.length + ' problem' + (failures.length === 1 ? '' : 's') + '):\n' + shown
      + (failures.length > 20 ? '\n  …' : ''))
  }
  return { files: seen.size, unpacked, signed, bytes }
}

/** Directory holding the packaged `resources`, for scripts given an executable. */
export function resourcesOfExecutable(executable) {
  return process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
}
