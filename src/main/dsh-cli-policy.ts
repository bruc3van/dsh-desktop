/**
 * Whether an Agent-invoked `dsh` may reach the bundled CLI.
 *
 * The desktop client is already running this profile in its own window. A
 * second `dsh web` / `dsh --profile …` on the same DSH_HOME would share the
 * session store with a writer the client already owns. The gateway therefore
 * classifies invocations against the pinned upstream CLI. Unknown non-profile
 * commands currently reach upstream help/errors; every runtime upgrade must
 * rerun check:dsh-cli against the real CLI. The plugin subcommand deliberately
 * forwards package-manager arguments, including run/exec/dlx; this is not an
 * arbitrary-code execution sandbox.
 *
 * Pure decision, no I/O, parameterized only by argv — the same shape as
 * `runtime-resolution.ts`, so both platforms are assertable from one machine
 * (`scripts/check-dsh-cli.mjs`).
 * @module dsh-desktop/dsh-cli-policy
 */

export type DshInvocationDecision =
  | { allow: true }
  | { allow: false; reason: string }

/**
 * Written to stderr on a blocked invocation. English, and prefixed `dsh:`,
 * matching the official CLI so an Agent reading the failure can quote it.
 */
export const DSH_CLI_BLOCKED_MESSAGE = [
  'dsh: this `dsh` comes from DSH Desktop, which is already running',
  'this profile in its own window — booting a second instance would share the',
  'same DSH_HOME. Use the app window instead.',
  'Available here: dsh plugin --profile <name> ..., dsh --profile <name>',
  '--dump-config, dsh --version.',
].join('\n')

/**
 * Classify one `dsh` argv (without the executable) as forward or refuse.
 *
 * Mirrors commander on the official CLI: `plugin` is a subcommand with
 * `rejectParentOptions` (always argv[0]); `web` is a profile alias; dump-config
 * flags live on the root command and skip cordis boot; `--version` / `-V` never
 * boot. `--` ends the option scan but the following positional is still the
 * `web` alias (`dsh -- web` boots). Any other unknown token ends the launcher
 * prefix — `passThroughOptions` plus `enablePositionalOptions` — so an inner
 * `--dump-config` after `--` cannot masquerade as a dump.
 */
export function classifyDshInvocation(args: string[]): DshInvocationDecision {
  if (args[0] === 'plugin') return { allow: true }

  const prefix = scanLauncherPrefix(args)
  if (prefix.dumpConfig || prefix.version) return { allow: true }
  // No profile and not the `web` alias: the official CLI itself errors
  // (`--profile is required`) or prints help. Let that real error through.
  if (!prefix.profile && !prefix.webCommand) return { allow: true }
  return { allow: false, reason: DSH_CLI_BLOCKED_MESSAGE }
}

interface LauncherPrefix {
  dumpConfig: boolean
  version: boolean
  profile: boolean
  webCommand: boolean
}

/**
 * Consume known root-command tokens from the front of argv, stopping at the
 * first token that is not a launcher option (or the `web` alias occupying the
 * first positional). `--` ends options and then still recognizes `web`.
 * `--profile` / `--patch` take the following token as their value, including
 * when that token looks like a flag — commander does the same.
 */
function scanLauncherPrefix(args: string[]): LauncherPrefix {
  const prefix: LauncherPrefix = { dumpConfig: false, version: false, profile: false, webCommand: false }
  let index = 0
  let seenPositional = false
  while (index < args.length) {
    const token = args[index]
    if (token === undefined) break
    if (token === '--profile' || token === '--patch') {
      if (token === '--profile') prefix.profile = true
      index += 1
      if (index < args.length) index += 1
      continue
    }
    if (token.startsWith('--profile=')) {
      prefix.profile = true
      index += 1
      continue
    }
    if (token.startsWith('--patch=')) {
      index += 1
      continue
    }
    if (token === '--dump-config' || token === '--dump-default-config') {
      prefix.dumpConfig = true
      index += 1
      continue
    }
    if (token === '-V' || token === '--version') {
      prefix.version = true
      index += 1
      continue
    }
    if (token === '--') {
      // End of options. Commander still treats the next positional as a
      // command, and `web` is a profile alias — `dsh -- web` boots. `--`
      // itself is not a known flag, so without this the scan would stop and
      // the alias would look like "the CLI will just error".
      index += 1
      if (args[index] === 'web' && !seenPositional) prefix.webCommand = true
      break
    }
    if (token === 'web' && !seenPositional) {
      prefix.webCommand = true
      seenPositional = true
      index += 1
      continue
    }
    break
  }
  return prefix
}
