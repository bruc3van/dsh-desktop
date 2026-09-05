/**
 * The entry the client runs instead of the official `dsh` bin.
 *
 * A packaged build carries no system Node, so the bundled CLI runs on
 * Electron's own Node through `ELECTRON_RUN_AS_NODE=1`. That variable is
 * inherited by everything the harness starts afterwards — including the
 * Agent's own shell commands — and any Electron-based tool the Agent then runs
 * (`code`, `electron`, an Electron-packaged CLI) starts as a bare Node process
 * and fails on its first `import { app } from 'electron'`. The variable is an
 * implementation detail of how this client launches Node; it must not travel
 * into the Agent's execution environment.
 *
 * It cannot simply be dropped: two runtime paths spawn `process.execPath`
 * expecting Node semantics — the native directory-picker worker (the "add a
 * project folder" dialog on macOS and Windows) and the Windows ACL sandbox
 * runner. So the variable is removed from the ambient environment and
 * re-attached at the spawn boundary, for children that are the Electron binary
 * itself. Every other child — the Agent's shells and their descendants — sees
 * the environment a normally installed `dsh` would give them.
 *
 * The same boundary rewrites `pnpm` spawns onto the packaged `pnpm.mjs` (see
 * `runtime-spawn.ts`). That is scoped to the pnpm command; Agent shells do
 * not inherit `CI=true` from it.
 *
 * Outside a packaged build the CLI runs on a real Node, the variable is absent,
 * and this module only forwards to the official entry.
 * @module dsh-desktop/runtime-launcher
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PNPM_ENTRY_VARIABLE,
  RUNTIME_ENTRY_VARIABLE as ENTRY_VARIABLE,
  patchRuntimeSpawns,
  type SpawnHost,
} from './runtime-spawn.ts'

const NODE_MODE = 'ELECTRON_RUN_AS_NODE'

function resolvePnpmEntry(runtimeEntry: string): string | undefined {
  const fromEnv = process.env[PNPM_ENTRY_VARIABLE]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // The `pnpm` shim already points the launcher at packaged `pnpm.mjs`.
  if (/[/\\]pnpm\.mjs$/i.test(runtimeEntry)) return runtimeEntry
  return undefined
}

const entry = process.env[ENTRY_VARIABLE]
if (entry === undefined || entry === '') {
  throw new Error(ENTRY_VARIABLE + ' is required: the desktop client sets it to the bundled dsh entry')
}
const pnpmEntry = resolvePnpmEntry(entry)
// pnpm derives npm_execpath from argv[1]. Keep it pointing at the CLI rather
// than this launcher, which cannot run without its private entry variable.
if (entry === pnpmEntry) process.argv[1] = entry
// The launcher's own coordinates are not part of the harness's environment.
Reflect.deleteProperty(process.env, ENTRY_VARIABLE)
Reflect.deleteProperty(process.env, PNPM_ENTRY_VARIABLE)

const nodeMode = process.env[NODE_MODE]
if (nodeMode !== undefined && nodeMode !== '') {
  Reflect.deleteProperty(process.env, NODE_MODE)
  // require(), not an ESM import of the builtin: importing it here would build
  // its ESM facade from the unpatched exports, and the harness's own
  // `import { spawn } from 'node:child_process'` would bind to the originals.
  const childProcess = createRequire(import.meta.url)('node:child_process') as SpawnHost
  patchRuntimeSpawns(childProcess, nodeMode, process.execPath, process.platform, process.env, pnpmEntry, fileURLToPath(import.meta.url))
}

await import(pathToFileURL(entry).href)
