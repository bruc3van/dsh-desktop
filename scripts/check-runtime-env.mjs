/**
 * Runtime-launcher contract: the packaged client boots the official CLI on
 * Electron's Node, and `ELECTRON_RUN_AS_NODE` must not travel from there into
 * the Agent's execution environment — while the two runtime paths that respawn
 * `process.execPath` (the native directory picker, the Windows ACL sandbox
 * runner) must still receive it. Runs the built launcher against a fixture
 * entry that reports what its own children see.
 *
 * With no argument the launcher runs on this Node, which covers the patching
 * contract itself. Passing a packaged client's executable runs the same
 * fixture on the Electron Node a release actually uses — the only place where
 * "spawn my own executable and get Node" is a real code path.
 * Usage: node scripts/check-runtime-env.mjs [node-or-packaged-executable]
 * @module desktop/scripts/check-runtime-env
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const LAUNCHER = join(APP_DIR, '.build', 'runtime-launcher.mjs')
const GATEWAY = join(APP_DIR, '.build', 'dsh-cli.mjs')
if (!existsSync(LAUNCHER)) throw new Error('run `pnpm run build` first: ' + LAUNCHER + ' is missing')
if (!existsSync(GATEWAY)) throw new Error('run `pnpm run build` first: ' + GATEWAY + ' is missing')

// `pnpm run <script> -- <path>` forwards the separator itself as an argument.
const requested = process.argv.slice(2).find(argument => argument !== '--')
const EXECUTABLE = requested === undefined ? process.execPath : resolve(requested)
if (!existsSync(EXECUTABLE)) throw new Error('executable does not exist: ' + EXECUTABLE)

const workDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-env-'))
// The fixture stands in for the official bin: it reports its own environment,
// what an ordinary child (an Agent shell) inherits, and what a child spawned on
// this executable (the picker worker) inherits.
const fixture = join(workDir, 'entry.mjs')
const pnpmFixture = join(workDir, 'pnpm.mjs')
await writeFile(pnpmFixture, `
process.stdout.write(JSON.stringify({
  marker: 'bundled-pnpm',
  ci: process.env.CI ?? null,
  argv: process.argv.slice(2),
  nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  cliEntry: process.argv[1],
  entryVariable: process.env.DSH_DESKTOP_RUNTIME_ENTRY ?? null,
  pnpmEntryVariable: process.env.DSH_DESKTOP_PNPM_ENTRY ?? null,
}))
`)
await writeFile(fixture, `
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (process.env.DSH_DESKTOP_FIXTURE_MARKER) writeFileSync(process.env.DSH_DESKTOP_FIXTURE_MARKER, 'imported')

const readVariable = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}
const plain = process.platform === 'win32'
  ? readVariable(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo %ELECTRON_RUN_AS_NODE%'])
  : readVariable('/bin/sh', ['-c', 'printf %s "$ELECTRON_RUN_AS_NODE"'])
const pnpm = spawnSync('pnpm', ['dsh-desktop-probe'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
})
let pnpmChild = null
try { pnpmChild = JSON.parse((pnpm.stdout ?? '').trim()) } catch { pnpmChild = { raw: (pnpm.stdout ?? '').trim(), status: pnpm.status } }

console.log('RESULT ' + JSON.stringify({
  argv: process.argv.slice(2),
  ambient: process.env.ELECTRON_RUN_AS_NODE ?? null,
  entryVariable: process.env.DSH_DESKTOP_RUNTIME_ENTRY ?? null,
  pnpmEntryVariable: process.env.DSH_DESKTOP_PNPM_ENTRY ?? null,
  // cmd.exe echoes the literal name when the variable is unset.
  plainChild: plain === '%ELECTRON_RUN_AS_NODE%' ? '' : plain,
  selfChild: readVariable(process.execPath, ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "")']),
  pnpmChild,
}))
`)

let fixtureRun = 0

/** Run a built entry (launcher or gateway) with the fixture as its CLI target. */
async function runEntry(entry, args, nodeMode) {
  fixtureRun += 1
  const marker = join(workDir, 'imported-' + String(fixtureRun) + '.marker')
  const env = {
    ...process.env,
    DSH_DESKTOP_RUNTIME_ENTRY: fixture,
    DSH_DESKTOP_PNPM_ENTRY: pnpmFixture,
    DSH_DESKTOP_FIXTURE_MARKER: marker,
  }
  if (nodeMode === undefined) Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  else env.ELECTRON_RUN_AS_NODE = nodeMode
  const child = spawn(EXECUTABLE, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  // A broken contract can mean the executable opened its GUI instead of
  // running the launcher, and a GUI never exits. Fail here with what happened
  // rather than hanging until the CI job's own timeout.
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('launcher run did not exit within 30s — the executable may have started its GUI instead'))
    }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', value => { clearTimeout(timer); resolve(value) })
  })
  const line = stdout.split('\n').find(entry => entry.startsWith('RESULT '))
  return {
    code,
    stdout,
    stderr,
    imported: existsSync(marker),
    result: line === undefined ? undefined : JSON.parse(line.slice('RESULT '.length)),
  }
}

/** Run the launcher with the fixture as its entry; resolve its reported facts. */
async function runLauncher(nodeMode) {
  const run = await runEntry(LAUNCHER, ['web', '--port', '0'], nodeMode)
  if (run.code !== 0 || run.result === undefined) {
    throw new Error('launcher run failed (code=' + String(run.code) + ')\n' + run.stdout + run.stderr)
  }
  return run.result
}

const checks = []
const check = (name, ok, detail) => { checks.push({ ok, name, detail }) }

/**
 * The launcher re-attaches the variable by patching `child_process`'s exported
 * `spawn`/`spawnSync`/`fork`. `execFile`/`exec` reach the real spawn through a
 * module-internal reference that no export patch can see — and the bundled
 * harness already uses `execFile` elsewhere — so a future runtime that
 * respawned `process.execPath` through one of them would quietly start a second
 * GUI instead of a Node child, breaking the native directory picker and the
 * Windows ACL sandbox runner. Pin the assumption to the bundled closure: every
 * `process.execPath` site must be an argument to a patched call, or a site
 * audited here.
 */
const EXEC_PATH_TOKEN = 'process.execPath'
const AUDITED_INDIRECT = new Map([
  ['@deepseek-ai/dsh-sandbox-local/lib/index.js', [
    {
      label: 'compiled Windows ACL runner argv',
      context: 'if (existsSync(builtEntry)) return [process.execPath, builtEntry];',
      expected: 1,
    },
    {
      label: 'source Windows ACL runner argv',
      context: 'return [\n\t\t\tprocess.execPath,\n\t\t\t"--import",',
      expected: 1,
    },
  ]],
  ['@deepseek-ai/dsh-tool-fs-search/lib/index.js', [
    {
      label: 'pkg ripgrep executable parsing',
      context: 'const executable = parse(process.execPath);',
      expected: 1,
    },
    {
      label: 'pkg ripgrep sidecar derivation',
      context: 'const executableSidecar = process.platform === "win32" ? join(executable.dir, `${executable.name}-rg.exe`) : `${process.execPath}-rg`;',
      expected: 1,
    },
  ]],
])
const PATCHED_CALL = /(?:^|[^.\w$])(?:spawn|spawnSync|fork)\s*\(\s*$/

/** Keep allow-list keys stable when this scan runs on Windows. */
function runtimeAuditPath(packageName, packageRelativePath) {
  return '@deepseek-ai/' + packageName + packageRelativePath.replaceAll('\\', '/')
}

const windowsAuditPath = runtimeAuditPath('dsh-sandbox-local', '\\lib\\index.js')
check('runtime audit paths are platform-neutral',
  windowsAuditPath === '@deepseek-ai/dsh-sandbox-local/lib/index.js', windowsAuditPath)

/** Audit every process.execPath occurrence in one bundled-runtime source file. */
function auditExecPathSource(relative, source) {
  const offenders = []
  const rules = AUDITED_INDIRECT.get(relative) ?? []
  const ruleHits = rules.map(() => 0)
  let sites = 0
  let index = source.indexOf(EXEC_PATH_TOKEN)
  while (index !== -1) {
    sites += 1
    let allowed = PATCHED_CALL.test(source.slice(Math.max(0, index - 60), index))
    if (!allowed) {
      for (const [ruleIndex, rule] of rules.entries()) {
        const tokenOffset = rule.context.indexOf(EXEC_PATH_TOKEN)
        const contextStart = index - tokenOffset
        if (tokenOffset >= 0 && contextStart >= 0
          && source.slice(contextStart, contextStart + rule.context.length) === rule.context) {
          ruleHits[ruleIndex] += 1
          allowed = true
          break
        }
      }
    }
    if (!allowed) {
      const line = source.slice(0, index).split('\n').length
      offenders.push(relative + ':' + String(line) + ' — '
        + source.slice(index - 40 < 0 ? 0 : index - 40, index + 40).replace(/\s+/g, ' ').trim())
    }
    index = source.indexOf(EXEC_PATH_TOKEN, index + 1)
  }
  for (const [ruleIndex, rule] of rules.entries()) {
    if (ruleHits[ruleIndex] !== rule.expected) {
      offenders.push(relative + ' — audited context "' + rule.label + '" matched '
        + String(ruleHits[ruleIndex]) + ' times, expected ' + String(rule.expected))
    }
  }
  return { offenders, sites }
}

const fsSearchAuditPath = '@deepseek-ai/dsh-tool-fs-search/lib/index.js'
const fsSearchExpectedContext = AUDITED_INDIRECT.get(fsSearchAuditPath)
  .map(rule => rule.context)
  .join('\n')
check('an audited indirect execPath context is accepted exactly once',
  auditExecPathSource(fsSearchAuditPath, fsSearchExpectedContext).offenders.length === 0)
check('a dangerous execPath call added to an audited file is still rejected',
  auditExecPathSource(fsSearchAuditPath,
    fsSearchExpectedContext + '\nexecFile(process.execPath, ["--version"]);').offenders.length === 1)
check('duplicating an audited execPath context is rejected',
  auditExecPathSource(fsSearchAuditPath,
    fsSearchExpectedContext + '\n' + fsSearchExpectedContext).offenders.length === 2)

async function scanRuntimeExecPathSites(runtimeModules) {
  const offenders = []
  let sites = 0
  const auditedFilesSeen = new Set()
  const scopeDir = join(runtimeModules, '@deepseek-ai')
  for (const packageName of await readdir(scopeDir)) {
    const libDir = join(scopeDir, packageName, 'lib')
    if (!existsSync(libDir)) continue
    const stack = [libDir]
    while (stack.length > 0) {
      const directory = stack.pop()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        // Nested dependency trees are third-party code the harness only
        // consumes; this contract is about the harness's own spawn sites.
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') stack.push(path)
          continue
        }
        if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
        const source = await readFile(path, 'utf8')
        const relative = runtimeAuditPath(packageName, path.slice(join(scopeDir, packageName).length))
        if (AUDITED_INDIRECT.has(relative)) auditedFilesSeen.add(relative)
        const audited = auditExecPathSource(relative, source)
        sites += audited.sites
        offenders.push(...audited.offenders)
      }
    }
  }
  for (const relative of AUDITED_INDIRECT.keys()) {
    if (!auditedFilesSeen.has(relative)) offenders.push(relative + ' — audited runtime file is missing')
  }
  return { offenders, sites }
}

try {
  const packagedLike = await runLauncher('1')
  check('harness argv unchanged', JSON.stringify(packagedLike.argv) === JSON.stringify(['web', '--port', '0']),
    JSON.stringify(packagedLike.argv))
  check('Node-mode variable removed from the runtime environment', packagedLike.ambient === null,
    String(packagedLike.ambient))
  check('launcher entry variable not leaked to the harness', packagedLike.entryVariable === null,
    String(packagedLike.entryVariable))
  check('pnpm entry variable not leaked to the harness', packagedLike.pnpmEntryVariable === null,
    String(packagedLike.pnpmEntryVariable))
  check('Agent children do not inherit the Node-mode variable', packagedLike.plainChild === '',
    JSON.stringify(packagedLike.plainChild))
  check('process.execPath children still receive it', packagedLike.selfChild === '1',
    JSON.stringify(packagedLike.selfChild))
  check('pnpm spawn is rewritten onto the packaged entry', packagedLike.pnpmChild?.marker === 'bundled-pnpm',
    JSON.stringify(packagedLike.pnpmChild))
  check('rewritten pnpm sees CI=true', packagedLike.pnpmChild?.ci === 'true',
    JSON.stringify(packagedLike.pnpmChild))
  check('rewritten pnpm keeps the original args',
    JSON.stringify(packagedLike.pnpmChild?.argv) === JSON.stringify(['dsh-desktop-probe']),
    JSON.stringify(packagedLike.pnpmChild?.argv))
  check('rewritten pnpm clears Node mode before lifecycle scripts', packagedLike.pnpmChild?.nodeMode === null,
    JSON.stringify(packagedLike.pnpmChild))
  check('pnpm sees its CLI path for npm_execpath', packagedLike.pnpmChild?.cliEntry === pnpmFixture,
    JSON.stringify(packagedLike.pnpmChild))
  check('rewritten pnpm does not inherit launcher coordinates',
    packagedLike.pnpmChild?.entryVariable === null && packagedLike.pnpmChild?.pnpmEntryVariable === null,
    JSON.stringify(packagedLike.pnpmChild))

  const blocked = await runEntry(GATEWAY, ['web'], '1')
  check('gateway refuses `web` with exit 2', blocked.code === 2, String(blocked.code))
  check('gateway does not import the runtime entry when refusing', blocked.imported === false,
    'imported=' + String(blocked.imported) + '\n' + blocked.stdout + blocked.stderr)
  check('gateway refusal names the desktop client', blocked.stderr.includes('already running'),
    blocked.stderr)

  const blockedAlias = await runEntry(GATEWAY, ['--profile', 'web'], '1')
  check('gateway refuses `--profile web` (alias cannot bypass)',
    blockedAlias.code === 2 && blockedAlias.imported === false,
    'code=' + String(blockedAlias.code) + ' imported=' + String(blockedAlias.imported))

  const blockedInner = await runEntry(GATEWAY, ['--profile', 'web', '--', '--dump-config'], '1')
  check('gateway refuses inner `--dump-config` after `--`',
    blockedInner.code === 2 && blockedInner.imported === false,
    'code=' + String(blockedInner.code) + ' imported=' + String(blockedInner.imported))

  const forwarded = await runEntry(GATEWAY, ['plugin', '--profile', 'web', 'add', 'x'], '1')
  check('gateway forwards `plugin` to the launcher', forwarded.code === 0 && forwarded.result !== undefined,
    'code=' + String(forwarded.code) + '\n' + forwarded.stdout + forwarded.stderr)
  check('forwarded plugin argv reaches the entry',
    JSON.stringify(forwarded.result?.argv) === JSON.stringify(['plugin', '--profile', 'web', 'add', 'x']),
    JSON.stringify(forwarded.result?.argv))
  check('forwarded plugin still strips ELECTRON_RUN_AS_NODE', forwarded.result?.ambient === null,
    String(forwarded.result?.ambient))
  check('forwarded plugin Agent children do not inherit it', forwarded.result?.plainChild === '',
    JSON.stringify(forwarded.result?.plainChild))
  check('forwarded plugin still reattaches it for process.execPath children', forwarded.result?.selfChild === '1',
    JSON.stringify(forwarded.result?.selfChild))

  const forwardedDump = await runEntry(GATEWAY, ['--profile', 'web', '--dump-config'], '1')
  check('gateway forwards `--dump-config`', forwardedDump.code === 0 && forwardedDump.imported === true,
    'code=' + String(forwardedDump.code) + ' imported=' + String(forwardedDump.imported))

  // Development and any real Node install: nothing to strip, nothing patched.
  // Only a real Node can run this arm — without the variable, a packaged
  // executable starts its GUI instead of the launcher.
  if (requested === undefined) {
    const plainNode = await runLauncher(undefined)
    check('unpatched pass-through on a real Node', plainNode.ambient === null && plainNode.selfChild === '',
      JSON.stringify(plainNode))
    check('unpatched pass-through does not rewrite pnpm onto the fixture',
      plainNode.pnpmChild?.marker !== 'bundled-pnpm',
      JSON.stringify(plainNode.pnpmChild))
  }

  // Only meaningful once the closure is deployed (`pnpm run prepare:runtime`).
  // Skipping it silently is how an unaudited upstream execPath call reaches
  // main: the legs that run this check without the closure still go green.
  // Every job that HAS run prepare:runtime therefore sets
  // DSH_DESKTOP_REQUIRE_RUNTIME_CLOSURE=1, which turns the skip into a failure
  // — so "the scan ran" stops being something you have to read the log to know.
  const runtimeModules = join(APP_DIR, '.runtime', 'node_modules')
  if (existsSync(join(runtimeModules, '@deepseek-ai'))) {
    const { offenders, sites } = await scanRuntimeExecPathSites(runtimeModules)
    check('bundled runtime respawns process.execPath only through patched APIs',
      offenders.length === 0, offenders.join(' | ') + ' (audit these sites, then extend AUDITED_INDIRECT)')
    if (offenders.length === 0) console.log('  (' + String(sites) + ' process.execPath sites scanned in the bundled closure)')
  } else if (process.env.DSH_DESKTOP_REQUIRE_RUNTIME_CLOSURE === '1') {
    check('bundled closure is present for the execPath scan', false,
      join(runtimeModules, '@deepseek-ai') + ' is missing; run `pnpm run prepare:runtime` before this check')
  } else {
    console.log('  (bundled closure absent — run `pnpm run prepare:runtime` to also check its spawn sites)')
  }
} finally {
  await rm(workDir, { recursive: true, force: true })
}

for (const entry of checks) {
  console.log((entry.ok ? '✓ ' : '✗ ') + entry.name + (entry.ok ? '' : ' — ' + entry.detail))
}
if (checks.some(entry => !entry.ok)) throw new Error('runtime environment contract violated')
