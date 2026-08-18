/**
 * Unit check for `src/main/runtime-spawn.ts`.
 *
 * Pins the launcher spawn contract without booting Electron: `pnpm` is
 * rewritten onto `execPath` + packaged `pnpm.mjs` with `CI=true` and
 * `windowsHide` on Windows; every other command is untouched except the
 * existing `ELECTRON_RUN_AS_NODE` reattach for this executable.
 * @module desktop/scripts/check-runtime-spawn
 */

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-spawn-'))
process.on('exit', () => { rmSync(outDir, { recursive: true, force: true }) })

const outfile = join(outDir, 'runtime-spawn.mjs')
await esbuild.build({
  entryPoints: [join(APP_DIR, 'src', 'main', 'runtime-spawn.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const {
  PNPM_ENTRY_VARIABLE,
  applyPnpmRewrite,
  isPnpmCommand,
  isSelfExecutable,
  patchRuntimeSpawns,
} = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failures.push(name)
}

check('PNPM_ENTRY_VARIABLE is the launcher/shim contract',
  PNPM_ENTRY_VARIABLE === 'DSH_DESKTOP_PNPM_ENTRY')

check('bare pnpm is a rewrite target', isPnpmCommand('pnpm') === true)
check('Windows pnpm.cmd is a rewrite target', isPnpmCommand('C:\\\\shim\\\\pnpm.cmd') === true)
check('pnpm.mjs is not rewritten as a PATH command', isPnpmCommand('/res/pnpm.mjs') === false)
check('unrelated commands are not pnpm', isPnpmCommand('node') === false && isPnpmCommand('dsh.cmd') === false)

const ambient = { PATH: '/usr/bin', FOO: 'bar' }
const pnpmCall = ['pnpm', ['add', 'x'], { cwd: '/tmp', shell: true, stdio: 'inherit' }]
check('rewrite requires a packaged pnpm entry',
  applyPnpmRewrite([...pnpmCall], '/electron', 'win32', ambient, undefined) === false)

const rewritten = ['pnpm', ['add', 'x'], { cwd: '/tmp', shell: true, stdio: 'inherit' }]
check('Windows pnpm spawn becomes execPath + pnpm.mjs',
  applyPnpmRewrite(rewritten, '/electron', 'win32', ambient, '/res/pnpm.mjs') === true
  && rewritten[0] === '/electron'
  && JSON.stringify(rewritten[1]) === JSON.stringify(['/res/pnpm.mjs', 'add', 'x'])
  && rewritten[2].shell === false
  && rewritten[2].windowsHide === true
  && rewritten[2].cwd === '/tmp'
  && rewritten[2].stdio === 'inherit'
  && rewritten[2].env.CI === 'true'
  && rewritten[2].env.FOO === 'bar')

const posix = ['pnpm.cmd', ['i'], { shell: true }]
applyPnpmRewrite(posix, '/usr/bin/node', 'darwin', ambient, '/res/pnpm.mjs')
check('POSIX rewrite still drops shell and does not set windowsHide',
  posix[0] === '/usr/bin/node'
  && posix[2].shell === false
  && posix[2].windowsHide === undefined
  && posix[2].env.CI === 'true')

const optionsOnly = ['PNPM', { shell: true }]
applyPnpmRewrite(optionsOnly, '/electron', 'win32', ambient, '/res/pnpm.mjs')
check('spawn(file, options) form still rewrites',
  optionsOnly[0] === '/electron'
  && JSON.stringify(optionsOnly[1]) === JSON.stringify(['/res/pnpm.mjs'])
  && optionsOnly[2].windowsHide === true)

const nodeCall = ['node', ['script.js'], { shell: false }]
check('a node spawn is not rewritten',
  applyPnpmRewrite(nodeCall, '/electron', 'win32', ambient, '/res/pnpm.mjs') === false
  && nodeCall[0] === 'node'
  && nodeCall[2].windowsHide === undefined
  && nodeCall[2].env === undefined)

check('self-executable match is case-insensitive on Windows',
  isSelfExecutable('C:\\\\App\\\\DSH.exe', 'c:\\\\app\\\\dsh.exe', 'win32') === true)
check('self-executable match is exact on POSIX',
  isSelfExecutable('/App/dsh', '/app/dsh', 'darwin') === false)

const calls = []
const host = {
  spawn(...callArguments) { calls.push(['spawn', ...callArguments]); return { pid: 1 } },
  spawnSync(...callArguments) { calls.push(['spawnSync', ...callArguments]); return { status: 0 } },
  fork(...callArguments) { calls.push(['fork', ...callArguments]); return { pid: 2 } },
}
patchRuntimeSpawns(host, '1', '/electron', 'win32', ambient, '/res/pnpm.mjs')

host.spawn('pnpm', ['install'], { cwd: '/proj', shell: true, stdio: 'inherit' })
const pnpmSpawn = calls.find(entry => entry[0] === 'spawn')
check('patched spawn rewrites pnpm and reattaches Node mode',
  pnpmSpawn !== undefined
  && pnpmSpawn[1] === '/electron'
  && JSON.stringify(pnpmSpawn[2]) === JSON.stringify(['/res/pnpm.mjs', 'install'])
  && pnpmSpawn[3].shell === false
  && pnpmSpawn[3].windowsHide === true
  && pnpmSpawn[3].env.CI === 'true'
  && pnpmSpawn[3].env.ELECTRON_RUN_AS_NODE === '1'
  && pnpmSpawn[3].env.FOO === 'bar'
  && pnpmSpawn[3].cwd === '/proj')

calls.length = 0
host.spawn('cmd.exe', ['/d', '/s', '/c', 'echo hi'])
const cmdSpawn = calls[0]
check('unrelated spawn is not given windowsHide or CI',
  cmdSpawn[1] === 'cmd.exe'
  && JSON.stringify(cmdSpawn[2]) === JSON.stringify(['/d', '/s', '/c', 'echo hi'])
  && cmdSpawn[3] === undefined)

calls.length = 0
host.spawn('/electron', ['-e', '0'])
const selfSpawn = calls[0]
check('self-executable still receives ELECTRON_RUN_AS_NODE without CI',
  selfSpawn[1] === '/electron'
  && selfSpawn[3].env.ELECTRON_RUN_AS_NODE === '1'
  && selfSpawn[3].env.CI === undefined
  && selfSpawn[3].windowsHide === undefined)

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')
