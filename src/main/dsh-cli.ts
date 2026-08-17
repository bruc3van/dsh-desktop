/**
 * Gateway in front of the bundled dsh CLI, reached only through the `dsh`
 * shim on the Agent's PATH.
 *
 * The main process still spawns `runtime-launcher.mjs` directly; this module
 * is not on that path. Allowed invocations forward into the launcher via a
 * computed specifier so esbuild cannot statically inline it — the launcher's
 * top-level work (env, `child_process` patches, the official entry) must not
 * run before the classifier has decided.
 * @module dsh-desktop/dsh-cli
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyDshInvocation } from './dsh-cli-policy.ts'

const decision = classifyDshInvocation(process.argv.slice(2))
if (!decision.allow) {
  process.stderr.write(decision.reason + '\n')
  process.exit(2)
}

await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'runtime-launcher.mjs')).href)
