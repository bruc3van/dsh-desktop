/**
 * Which sources Smart mode may try, as a durable client preference.
 *
 * Listed in the order the settings show them: the bundled runtime first, then
 * a running instance, PATH and the npx cache. The bundled runtime is the first
 * spawn rung; PATH and the npx cache only run when it is turned off. Reusing a
 * running instance is not a competing spawn: with the shared data home it is
 * still checked before any spawn, because two writers on one DSH_HOME corrupt
 * the session store. Each rung can be skipped. Missing settings mean all four.
 *
 * Pure decision, no I/O. The same shape as `runtime-resolution.ts` /
 * `dsh-cli-policy.ts`, so the table is assertable from one machine
 * (`scripts/check-smart-runtimes.mjs`).
 * @module dsh-desktop/smart-runtimes
 */

export const SMART_RUNTIME_IDS = ['bundled', 'probe', 'installed', 'npx'] as const
export type SmartRuntimeId = (typeof SMART_RUNTIME_IDS)[number]

/** Default: every rung is live; the bundled runtime wins whenever it is present. */
export const DEFAULT_SMART_RUNTIMES: readonly SmartRuntimeId[] = SMART_RUNTIME_IDS

const SMART_RUNTIME_ID_SET: ReadonlySet<string> = new Set(SMART_RUNTIME_IDS)

export function isSmartRuntimeId(value: unknown): value is SmartRuntimeId {
  return typeof value === 'string' && SMART_RUNTIME_ID_SET.has(value)
}

/**
 * Canonicalize a settings value for runtime decisions.
 *
 * Unknown ids are dropped, duplicates collapse, order is the ladder order.
 * Missing, empty, or wholly invalid input becomes the default — a hand-edited
 * empty array must not brick boot into "no runtime at all".
 */
export function normalizeSmartRuntimes(value: unknown): SmartRuntimeId[] {
  return canonicalize(value) ?? [...DEFAULT_SMART_RUNTIMES]
}

/**
 * Canonicalize a value the user is trying to persist.
 *
 * Returns `undefined` when the result would be empty (nothing enabled) or
 * not an array of known ids. Callers must refuse that save rather than
 * writing a document that next boot would silently widen back to the default.
 */
export function validateSmartRuntimes(value: unknown): SmartRuntimeId[] | undefined {
  return canonicalize(value)
}

export function smartRuntimeEnabled(
  ids: readonly SmartRuntimeId[],
  id: SmartRuntimeId,
): boolean {
  return ids.includes(id)
}

/**
 * The rung a spawned runtime came from, as the record in DSH_HOME spells it.
 *
 * The resolver's own labels are finer than the ladder: `path` and `checkout`
 * are the bundled rung's dev fallbacks, and an explicit DSH_DESKTOP_DSH
 * override answers to no rung at all. `undefined` means "no rung to check" —
 * an override, an unknown label, or a record written before the field
 * existed — and callers must read it as "not gated", never as "off".
 */
export function smartRuntimeForSource(source: unknown): SmartRuntimeId | undefined {
  switch (source) {
    case 'installed':
      return 'installed'
    case 'npx':
      return 'npx'
    case 'bundled':
    case 'checkout':
    case 'path':
      return 'bundled'
    default:
      return undefined
  }
}

/**
 * Whether a runtime spawned from `source` is still a source the user allows.
 *
 * A survivor of an earlier run may come from a rung that has since been
 * turned off in connection settings. Connecting to it regardless is how the
 * preference would look ignored: the client would keep answering from the
 * very runtime the user unticked, and never move to the one they picked.
 */
export function adoptableUnderSmartRuntimes(
  ids: readonly SmartRuntimeId[],
  source: unknown,
): boolean {
  const rung = smartRuntimeForSource(source)
  return rung === undefined || smartRuntimeEnabled(ids, rung)
}

function canonicalize(value: unknown): SmartRuntimeId[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<SmartRuntimeId>()
  for (const entry of value) {
    if (isSmartRuntimeId(entry)) seen.add(entry)
  }
  if (seen.size === 0) return undefined
  return SMART_RUNTIME_IDS.filter((id) => seen.has(id))
}
