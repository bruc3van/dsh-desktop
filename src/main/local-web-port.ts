/**
 * The bind address of a `dsh web` child this client starts.
 *
 * Default is `--port 0` (the OS picks a free port) so a client-started
 * runtime never occupies the official 3080 and almost never sits on Smart
 * mode's probe list. A user may pin a specific port in connection settings;
 * that preference lives in the client's own settings.json and is passed as
 * `--port` on this spawn only — never written into the shared profile patch
 * layer, which would also retarget a `dsh web` the user starts themselves.
 *
 * `--no-open` is not a setting. rc.8 opens the system browser after a local
 * launch; this client already has a window, so the flag is attached whenever
 * the resolved runtime is new enough to accept it.
 * @module dsh-desktop/local-web-port
 */

/** OS-assigned free port. The spawn default, and the saved "random" choice. */
export const RANDOM_LOCAL_WEB_PORT = 0

/** The official Web UI's default listen port. Pinning it occupies that seat. */
export const OFFICIAL_WEB_PORT = 3080

/** First runtime that understands `--no-open` (and that opens a browser without it). */
export const NO_OPEN_SINCE = '0.1.0-rc.8'

/**
 * Canonicalize a stored or submitted value to a bind port.
 *
 * Missing, blank, or 0 become random. Out-of-range, non-integer, or a
 * privileged port this process cannot bind also become random — boot must
 * not fail closed on a hand-edited file, and must not walk the source
 * ladder against a bind that will always return EACCES.
 */
export function normalizeLocalWebPort(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): number {
  return parseLocalWebPort(value, platform) ?? RANDOM_LOCAL_WEB_PORT
}

/**
 * Parse a value the user is trying to persist.
 *
 * Returns `undefined` when the input is not a port this client will spawn
 * with (non-integer, out of range, a non-numeric string, or a privileged
 * port on POSIX). Callers must refuse that save rather than writing a
 * document next boot would silently widen back to random.
 *
 * Empty / missing / 0 is persistable: it means random.
 */
export function parseLocalWebPort(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (value === undefined || value === null || value === '') return RANDOM_LOCAL_WEB_PORT
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 65535) return undefined
    return canBindLocalWebPort(value, platform) ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return RANDOM_LOCAL_WEB_PORT
  if (!/^\d+$/.test(trimmed)) return undefined
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
  return canBindLocalWebPort(port, platform) ? port : undefined
}

/**
 * Ports 1–1023 need extra privilege on macOS/Linux. Windows does not.
 * Random (0) is always allowed.
 */
export function canBindLocalWebPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (port === 0) return true
  if (port < 1 || port > 65535) return false
  return platform === 'win32' || port >= 1024
}

/** Range shown in the save-failure copy for a pinned port. */
export function localWebPortRangeLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '1–65535' : '1024–65535'
}

/** True when the pinned port is the official default, which this client otherwise avoids. */
export function isOfficialWebPort(port: number): boolean {
  return port === OFFICIAL_WEB_PORT
}

/**
 * `dsh web` argv this client passes after the resolved command prefix.
 *
 * `port` 0 is the documented "any free port" form. `--no-open` is omitted
 * when the runtime is older than {@link NO_OPEN_SINCE}: unknown flags abort
 * commander, and those older builds never opened a browser anyway.
 */
export function webSpawnArgs(port: number, noOpen: boolean): string[] {
  const bind = port > 0 && port <= 65535 ? port : RANDOM_LOCAL_WEB_PORT
  const args = ['web', '--port', String(bind)]
  if (noOpen) args.push('--no-open')
  return args
}
