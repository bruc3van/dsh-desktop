/** Install a verified release DMG without depending on Squirrel/Developer ID. */
import { execFile, spawn } from 'node:child_process'
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// All paths are positional arguments, never interpolated into shell source.
// Keep the backup after launch: open succeeding is not proof of a healthy app.
export const macUpdateScript = `#!/bin/sh
set -eu
root=$1
target=$2
owner=$3
exec >> "$root/install.log" 2>&1
backup="$root/previous.app"
next="$root/next.app"
: > "$root/ready"
i=0
while kill -0 "$owner" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then exit 1; fi
  sleep 1
done
moved=0
installed=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$moved" = 1 ]; then
    if [ "$installed" = 1 ]; then /bin/mv "$target" "$next"; fi
    /bin/mv "$backup" "$target"
  fi
  /usr/bin/open -n "$target" || true
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
/bin/mv "$target" "$backup"
moved=1
/bin/mv "$next" "$target"
installed=1
/usr/bin/open -n "$target"
moved=0
trap - EXIT HUP INT TERM
: > "$root/completed"
`

function macFilesystemError(error: unknown, chinese: boolean): unknown {
  if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
    return new Error(chinese
      ? '安装目录不可写，无法自动替换。请将应用安装到个人目录 ~/Applications 后重试，或从发布页下载 DMG 手动安装。'
      : 'The installation folder is not writable. Move the app to ~/Applications and retry, or download a DMG from the releases page and install it manually.')
  }
  return error
}

export async function preflightMacUpdate(executable: string, chinese = true): Promise<string> {
  const target = dirname(dirname(dirname(executable)))
  if (!target.endsWith('.app') || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) {
    throw new Error(chinese ? '请先将客户端安装到可写的应用程序目录，再使用自动更新' : 'Install the app in a writable Applications folder before updating automatically.')
  }
  if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) {
    throw new Error(chinese ? '自动更新不支持通过符号链接安装的应用' : 'Automatic updates do not support symlinked installations.')
  }
  try { await access(dirname(target), constants.W_OK) } catch (error) { throw macFilesystemError(error, chinese) }
  return target
}

/** Only reclaim completed transactions created by this updater for this app.
 * Keep the newest previous transaction as well as the current transaction.
 * Unmarked, active, failed and foreign directories are deliberately untouched.
 */
export async function pruneMacUpdateBackups(target: string): Promise<void> {
  try {
    const parent = dirname(target)
    const candidates: { path: string; time: number }[] = []
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.dsh-update-[a-zA-Z0-9]+$/.test(entry.name)) continue
      const path = join(parent, entry.name)
      try {
        const meta = JSON.parse(await readFile(join(path, 'transaction.json'), 'utf8'))
        if (meta.format !== 1 || meta.target !== target || !Number.isSafeInteger(meta.pid) || meta.pid <= 0) continue
        try { process.kill(meta.pid, 0); continue } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
        const completed = await lstat(join(path, 'completed'))
        if (!completed.isFile()) continue
        // A completed helper has already detached its image. Refuse any mount
        // directory residue rather than risk recursing into a live volume.
        try { await lstat(join(path, 'image')); continue } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        }
        candidates.push({ path, time: (await stat(join(path, 'completed'))).mtimeMs })
      } catch { /* Unknown/incomplete transactions are not ours to remove. */ }
    }
    candidates.sort((a, b) => b.time - a.time)
    for (const entry of candidates.slice(1)) await rm(entry.path, { recursive: true, force: true })
  } catch { /* Reclamation must never block an update. */ }
}

export async function prepareMacUpdate(image: string, executable: string, version: string, chinese = true): Promise<{
  start: () => Promise<void>
  dispose: () => Promise<void>
}> {
  const target = await preflightMacUpdate(executable, chinese)
  const root = await mkdtemp(join(dirname(target), '.dsh-update-')).catch(error => { throw macFilesystemError(error, chinese) })
  const mount = join(root, 'image')
  let mounted = false
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image], { timeout: 120_000 })
    mounted = true
    const entries = (await readdir(mount, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    if (entries.length !== 1 || entries[0] === undefined) throw new Error(chinese ? '更新镜像必须包含一个应用' : 'The update image must contain exactly one app.')
    const source = join(mount, entries[0].name)
    const plist = join(source, 'Contents', 'Info.plist')
    const field = async (path: string, key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path])).stdout.trim()
    const oldId = await field(join(target, 'Contents', 'Info.plist'), 'CFBundleIdentifier')
    if (await field(plist, 'CFBundleIdentifier') !== oldId || await field(plist, 'CFBundleShortVersionString') !== version) {
      throw new Error(chinese ? '更新应用的标识或版本与预期不符' : 'The update app identifier or version does not match the expected release.')
    }
    await run('/usr/bin/ditto', [source, join(root, 'next.app')], { timeout: 180_000 })
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'next.app')], { timeout: 120_000 })
    await run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 })
    mounted = false
    await writeFile(join(root, 'transaction.json'), JSON.stringify({ format: 1, target, pid: process.pid }))
    await pruneMacUpdateBackups(target)
    await writeFile(join(root, 'install.sh'), macUpdateScript, { mode: 0o700 })
    return {
      dispose: () => rm(root, { recursive: true, force: true }),
      start: async () => {
        const child = spawn('/bin/sh', [join(root, 'install.sh'), root, target, String(process.pid)], { detached: true, stdio: 'ignore' })
        let failed: Error | undefined
        child.on('error', error => { failed = error })
        child.on('exit', code => { failed = new Error((chinese ? '更新辅助程序提前退出：' : 'The update helper exited early: ') + String(code)) })
        for (let i = 0; i < 100; i++) {
          if (failed) throw failed
          try {
            await readFile(join(root, 'ready'))
            child.unref()
            return
          } catch { /* Wait for the helper to reach its parent-exit gate. */ }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        child.kill()
        throw new Error(chinese ? '更新辅助程序启动超时' : 'The update helper did not start in time.')
      },
    }
  } catch (error) {
    if (mounted) {
      try { await run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }) } catch {
        // Never recursively delete a directory containing a mounted image.
        throw error
      }
    }
    await rm(root, { recursive: true, force: true })
    throw macFilesystemError(error, chinese)
  }
}
