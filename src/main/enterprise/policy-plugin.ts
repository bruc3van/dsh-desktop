/**
 * The organisation tool policy, as a DSH plugin.
 *
 * Shipped with the client (outside app.asar, like the runtime launcher) and
 * inserted into a managed profile's patch layer by the reconciler. It
 * registers a `ctx.tools.guard`: a monotonic deny that runs after the
 * extensible `tools/pre-execute` waterfall, so no later plugin, preset or
 * approval can turn a denied call back into an allowed one. The model sees
 * the configured message as the tool's failure reason.
 *
 * This is a soft control on the employee's own machine — it prevents
 * accidents, not a determined local user. Hard limits live in the model
 * gateway.
 *
 * Self-contained on purpose: it is loaded by DSH's loader from a file path
 * and must not import anything from the client bundle.
 * @module dsh-desktop-pro/enterprise/policy-plugin
 */

import { appendFileSync } from 'node:fs'

export const name = 'dsh-desktop-pro-policy'
export const inject = ['tools']

interface PolicyConfig {
  deny?: unknown
  message?: unknown
  /** JSON-lines file the client uploads to the organisation's audit log. */
  log?: unknown
}

interface ToolExecution {
  readonly name: string
}

interface PolicyAgent {
  ctx: { tools: { restrict(filter: { deny: string[] }): () => void } }
}

interface PolicyContext {
  tools: {
    guard(guard: (execution: Readonly<ToolExecution>) => string | undefined): () => void
    get(name: string, scope?: unknown): unknown
  }
  on?(event: 'agent/created' | 'agent/disposed', listener: (payload: { agent: PolicyAgent }) => undefined, options?: { global?: boolean }): unknown
}

export const DEFAULT_MESSAGE = 'This tool is disabled by your organization\'s policy. Do not retry it; tell the user it is unavailable here.'

/** DSH's code-mode transport cannot be masked from an agent; the guard still refuses it. */
const UNMASKABLE = new Set(['run_code'])

function denyList(config: PolicyConfig | undefined): string[] {
  return Array.isArray(config?.deny) ? config.deny.filter((item): item is string => typeof item === 'string') : []
}

/** The guard as a pure function, for tests. `record` sees each refused tool name. */
export function createGuard(config: PolicyConfig | undefined, record?: (tool: string) => void): (execution: Readonly<ToolExecution>) => string | undefined {
  const deny = new Set(denyList(config))
  const message = typeof config?.message === 'string' && config.message.trim() !== '' ? config.message : DEFAULT_MESSAGE
  return (execution) => {
    if (!deny.has(execution.name)) return undefined
    record?.(execution.name)
    return message
  }
}

/** Names to take out of an agent's tool list: denied, present, and maskable. */
export function maskableNames(config: PolicyConfig | undefined, present: (name: string) => boolean): string[] {
  return denyList(config).filter(item => !UNMASKABLE.has(item) && present(item))
}

export function apply(ctx: PolicyContext, config: PolicyConfig | undefined): void {
  const log = typeof config?.log === 'string' && config.log !== '' ? config.log : undefined
  const record = log === undefined
    ? undefined
    : (tool: string): void => {
        // Names and times only: never the call's arguments.
        try { appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), tool }) + '\n', { mode: 0o600 }) } catch { /* the guard still refuses */ }
      }
  // The registration is scoped to this plugin's context and is removed with it.
  // It refuses every denied call, including tools registered after an agent starts.
  ctx.tools.guard(createGuard(config, record))
  // So the model is not offered what it may not use, mask the denied tools out
  // of each agent's list as it is created. The guard above stays the backstop.
  ctx.on?.('agent/created', ({ agent }) => {
    const names = maskableNames(config, item => ctx.tools.get(item, agent) !== undefined)
    if (names.length > 0) {
      try { agent.ctx.tools.restrict({ deny: names }) } catch { /* a scope-local tool cannot be masked; the guard refuses it */ }
    }
    return undefined
  }, { global: true })
}
