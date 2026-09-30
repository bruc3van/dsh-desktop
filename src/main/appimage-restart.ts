import { spawn } from 'node:child_process'
import { basename } from 'node:path'

// A helper loaded from a FUSE mount can lose its executable when the old
// image unmounts. Use the host shell, then reopen the persistent image only
// after the old desktop (and extract-and-run cleanup parent) has exited.
const restartScript = `
pid="$1"
shift
remaining=300
while [ "$remaining" -gt 0 ]; do
  stat=$(/bin/cat "/proc/$pid/stat" 2>/dev/null) || break
  state=\${stat##*) }
  case "$state" in Z*|X*) break ;; esac
  /bin/sleep 0.1
  remaining=$((remaining - 1))
done
[ "$remaining" -gt 0 ] || exit 1
exec "$@"
`

export async function scheduleAppImageRestart(image: string, cwd: string): Promise<void> {
  const extracted = basename(process.env.APPDIR ?? '').startsWith('appimage_extracted_')
  const env = { ...process.env }
  if (extracted) env.APPIMAGE_EXTRACT_AND_RUN = '1'
  const helper = spawn('/bin/sh', ['-c', restartScript, 'dsh-desktop-restart',
    String(extracted ? process.ppid : process.pid), image, ...process.argv.slice(1)], {
    cwd, env, detached: true, stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => {
    helper.once('error', reject)
    helper.once('spawn', resolve)
  })
  helper.unref()
}
