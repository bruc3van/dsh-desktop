/**
 * One sanitized environment for every check that launches the built client.
 *
 * These checks assert what the client does when nobody has told it anything.
 * The knobs that tell it something are ordinary environment variables, and a
 * development machine — or a self-hosted runner that ran a previous check —
 * carries them into the next run: `DSH_DESKTOP_DSH` pins a runtime the check
 * never asked for, `DSH_DESKTOP_SKIP_*` turns off the very step under test,
 * `DSH_FIXTURE_*` makes a fixture fail or stall. The result is a run that
 * proves something other than what it says it proves, in either direction.
 *
 * Each check used to strip its own list, and the lists drifted: two scripts
 * filtered the whole set, three deleted only `ELECTRON_RUN_AS_NODE`. So the
 * rule here is a prefix rather than a roster — every `DSH_DESKTOP_*` and
 * `DSH_FIXTURE_*` variable goes, and a check that wants one sets it back
 * explicitly. A knob added upstream tomorrow is covered on the day it lands.
 *
 * Matching is case-insensitive, and the whole environment is rebuilt rather
 * than spread-and-deleted: Windows env vars are case-insensitive but a plain
 * object's keys are not, so `{ ...process.env, DSH_HOME: x }` can leave an
 * inherited `Dsh_Home` beside the new key and let libuv's own dedup pick
 * either one. Dropping every casing first makes the later assignment the only
 * spelling in the object.
 *
 * @module desktop/scripts/lib/electron-env
 */

/** Variables a check must never inherit, whatever this machine has set. */
function isDiagnosticKnob(upperKey) {
  if (upperKey === 'ELECTRON_RUN_AS_NODE') return true
  if (upperKey === 'DSH_HOME') return true
  return upperKey.startsWith('DSH_DESKTOP_') || upperKey.startsWith('DSH_FIXTURE_')
}

/**
 * `process.env` with the diagnostic knobs removed, then `overrides` applied.
 * Extra names in `drop` are removed on top (case-insensitively) — for checks
 * that also own PATH or the npm cache.
 *
 * @param {Record<string, string | undefined>} [overrides] Set after stripping.
 * @param {readonly string[]} [drop] Additional variable names to strip.
 * @returns {Record<string, string>} A fresh environment object.
 */
export function sanitizedElectronEnv(overrides = {}, drop = []) {
  const dropped = new Set(drop.map(name => name.toUpperCase()))
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (isDiagnosticKnob(upper) || dropped.has(upper)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * The values `sanitizedElectronEnv` stripped, for a check that needs to build
 * on one it did not set itself (PATH is the only such case today).
 *
 * @param {string} name Variable to read, in any casing.
 * @returns {string} The inherited value, or '' when this machine has none.
 */
export function inheritedValue(name) {
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value
  }
  return ''
}
