/**
 * Where an official `dsh web` may be listening, as far as this client can tell.
 *
 * The bundled web app composes its port as `port: !!js ctx.webStartup.port ??
 * 3080`, so the default is only a fallback. A `--port` flag beats it, and so
 * does a `port:` written into the profile's own patch layer against the
 * `webserver` row. The flag leaves nothing behind to read; the patch layer is a
 * file, and a user who moved their instance there is exactly the user this
 * client would otherwise fail to see — and start a second harness beside, which
 * corrupts the session store they share.
 *
 * Parsing is deliberately loose. The patch layer is a free-form YAML array that
 * may carry `!!js` expressions, and no reading of it needs to be exact: what
 * confirms an origin is `host.describe` replying on it, not this file. A wrong
 * number costs one probe that goes unanswered.
 *
 * Deliberately loose, but never unbounded: every port listed becomes one
 * sequential startup probe, so a pathological patch file must not turn Smart
 * mode's "is anything running" into minutes of waiting. The list is therefore
 * capped, in document order.
 * @module dsh-desktop/web-discovery
 */

/** The most ports one patch layer may contribute to the probe list. */
export const MAX_CONFIGURED_PORTS = 16

/**
 * Ports named anywhere in a profile patch layer, in the order they appear.
 *
 * The shape accepted is a `port:` key with an integer value — quoted or
 * bare, with a trailing comment, one-digit ports included. A miss here means
 * an instance on that port is not discovered and a second harness could be
 * started beside it, so the pattern errs toward matching; a wrong number only
 * costs one unanswered probe (and the cap bounds even that).
 */
export function configuredWebPorts(patchSource: string): number[] {
  const ports: number[] = []
  for (const match of patchSource.matchAll(/^\s*(?:-\s*)?port\s*:\s*['"]?(\d{1,5})['"]?\s*(?:#.*)?$/gm)) {
    const port = Number(match[1])
    if (port <= 0 || port > 65535 || ports.includes(port)) continue
    ports.push(port)
    if (ports.length >= MAX_CONFIGURED_PORTS) break
  }
  return ports
}

/**
 * Every origin smart mode should try before concluding nothing is running: the
 * default first, so the common case is decided by the first probe. Extra ports
 * (a client-pinned local bind) come next — a leftover on that port is more
 * likely than a patch-layer one — then whatever the profile patch names.
 */
export function webProbeOrigins(
  defaultOrigin: string,
  patchSource: string,
  extraPorts: readonly number[] = [],
): string[] {
  const origins = [defaultOrigin]
  const add = (port: number): void => {
    if (port <= 0 || port > 65535) return
    const candidate = 'http://127.0.0.1:' + String(port)
    if (!origins.includes(candidate)) origins.push(candidate)
  }
  for (const port of extraPorts) add(port)
  for (const port of configuredWebPorts(patchSource)) add(port)
  return origins
}
