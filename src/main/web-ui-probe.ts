/** API verification and native browser admission; never decides to spawn. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { WEB_PROFILE } from './bundled-plugin.ts'
import { webProbeOrigins } from './web-discovery.ts'
import { createDshBrowserSessionCookie } from './dsh-browser-session.ts'
import { selectAutomaticLocalWebPort } from './local-web-port.ts'
import { loopbackPortAvailable, loopbackPortHeld } from './loopback-port.ts'
import { originIsLoopback } from './connection-policy.ts'
import { devOverride } from './development-options.ts'
export type WebUiProbeResult =
  | { kind: 'verified'; url: string }
  | { kind: 'authentication-required'; url: string }
  | { kind: 'uncertain'; url: string }
  | { kind: 'unavailable' }

export function createWebUiProbe(options: { childHome(): string; configuredLocalWebPort(): number }) {
  const { childHome, configuredLocalWebPort } = options
  /**
   * The official Web UI's default port. In smart mode (no explicit address) the
   * client first probes a locally running official instance on this port and
   * connects to it — the window and the browser then share ONE harness process,
   * so conversations (like the live one in the browser) sync in real time. Only
   * when nothing answers does the client launch its own local `dsh web`. The
   * same probe is also the occupancy gate when reuse is turned off: an answering
   * instance is not killed, and a local spawn is refused until it exits.
   */
  function defaultWebProbeUrl(): string {
    return devOverride('DSH_DESKTOP_PROBE_URL') ?? 'http://127.0.0.1:3080'
  }

  /** Default origin plus any port the user pinned in the web profile's patch layer
   *  or in this client's local-bind setting. */
  function smartProbeUrls(extraPorts: readonly number[] = []): string[] {
    const pinned = configuredLocalWebPort()
    const extras = pinned > 0 ? [...extraPorts, pinned] : [...extraPorts]
    const patch = join(childHome(), 'profiles', WEB_PROFILE, 'cordis.patch.yml')
    let source: string
    try {
      source = readFileSync(patch, 'utf8')
    } catch {
      return webProbeOrigins(defaultWebProbeUrl(), '', extras)
    }
    return webProbeOrigins(defaultWebProbeUrl(), source, extras)
  }

  /** The first verified Harness, or an authenticated origin that must block a spawn. */
  async function probeSmartTargets(extraPorts: readonly number[] = []): Promise<WebUiProbeResult> {
    const urls = smartProbeUrls(extraPorts)
    let authenticationRequired: WebUiProbeResult | undefined
    for (const url of urls) {
      const result = await inspectWebUi(url)
      if (result.kind === 'verified') return result
      if (result.kind === 'authentication-required') authenticationRequired ??= result
    }
    // A busy instance answers slowly (its event loop is mid-request, a GC
    // pause, a plugin reload). One unanswered probe must not declare "nothing
    // running" and spawn a second harness beside a live one, so the WHOLE list
    // gets one short second pass before the fallback — a busy instance on the
    // fifth patch port deserves the same patience as one on the default. The
    // list is bounded by MAX_CONFIGURED_PORTS, and a non-listening loopback
    // port refuses instantly rather than spending the probe timeout.
    await new Promise(resolve => setTimeout(resolve, 300))
    let uncertain: WebUiProbeResult | undefined
    for (const url of urls) {
      const result = await inspectWebUi(url, 1_000)
      if (result.kind === 'verified') return result
      if (result.kind === 'authentication-required') authenticationRequired ??= result
      if (result.kind === 'uncertain') uncertain ??= result
    }
    return authenticationRequired ?? uncertain ?? { kind: 'unavailable' }
  }

  /**
   * The probe's transport. A configured remote can sit behind a proxy this
   * machine only reaches through the system settings, or behind a certificate
   * only the OS trust store knows — exactly what Node's fetch cannot see (see
   * `updaterFetch`), and a probe that always fails there would keep the blank-
   * window recovery from ever reloading a Connect-mode window. Chromium's stack
   * knows both, so a remote origin goes through net.fetch, with Node's fetch as
   * the fallback for whatever net refuses outright.
   *
   * Loopback keeps Node's fetch: nothing about a proxy or a CA applies to it,
   * and the smart-mode probe's answer must not start depending on the browser
   * stack's own headers, which the harness's trust fence reads.
   */
  async function probeFetch(base: string, url: string, init: RequestInit): Promise<Response> {
    if (originIsLoopback(base) || !app.isReady()) return await fetch(url, init)
    try {
      // Configured remote origins are not eligible for native DSH_HOME
      // admission. Do not forward Electron session cookies to an arbitrary
      // configured host while asking whether it implements the expected API.
      return await net.fetch(url, { credentials: 'omit', ...init })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      return await fetch(url, init)
    }
  }

  /**
   * Probe one Web UI origin with the legacy public descriptor and, on loopback,
   * the authenticated descriptor introduced in DSH 0.1.2-alpha.1. The result
   * distinguishes a verified Harness, an origin whose DSH credential was
   * rejected, and an unavailable or unrelated service.
   */
  async function inspectWebUi(base: string, timeoutMs = 1_500): Promise<WebUiProbeResult> {
    let authenticationRequired = false
    try {
      const origin = new URL(base).origin
      const nativeCookie = originIsLoopback(origin)
        ? createDshBrowserSessionCookie(childHome(), origin)
        : undefined
      const headers = {
        'content-type': 'application/json',
        ...nativeCookie !== undefined && { cookie: nativeCookie.header },
      }
      const legacyResponse = await probeFetch(origin, new URL('/api/host.describe', origin).href, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-probe', method: 'host.describe', payload: {} }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      authenticationRequired = legacyResponse.status === 401
      if (legacyResponse.ok) {
        const body = await legacyResponse.json() as {
          result?: { ok?: boolean; value?: { version?: unknown; cwd?: unknown } }
        }
        const value = body.result?.value
        if (body.result?.ok === true && value !== null && typeof value === 'object'
          && typeof value.version === 'string' && value.version !== ''
          && typeof value.cwd === 'string' && value.cwd !== '') return { kind: 'verified', url: origin }
        // A removed endpoint normally returns 404, but a future/transitioning
        // host may retain the route and answer an error envelope with HTTP 200.
        // That is not a legacy match; still give the authenticated descriptor
        // its chance before concluding this is not DSH.
      }

      const settingsResponse = await probeFetch(origin, new URL('/api/settings/describe', origin).href, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'desktop-probe',
          method: 'settings/describe',
          payload: { args: {} },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!settingsResponse.ok) {
        return legacyResponse.status === 401 || settingsResponse.status === 401
          ? { kind: 'authentication-required', url: origin }
          : { kind: 'unavailable' }
      }
      const body = await settingsResponse.json() as {
        result?: {
          ok?: boolean
          value?: { writable?: unknown; hasDocument?: unknown; namespaces?: unknown }
        }
      }
      const value = body.result?.value
      if (body.result?.ok !== true || value === null || typeof value !== 'object'
        || typeof value.writable !== 'boolean'
        || typeof value.hasDocument !== 'boolean'
        || !Array.isArray(value.namespaces)) {
        console.warn('[desktop] settings.describe on ' + base + ' lacks the official settings descriptor; not adopting it')
        return { kind: 'unavailable' }
      }
      return { kind: 'verified', url: origin }
    } catch {
      // A timeout or broken response does not prove the writer stopped. Only
      // loopback is eligible for native spawn, and the TCP check uses the same
      // host/port as the failed HTTP request (including explicit IPv6 origins).
      try {
        const url = new URL(base)
        if (authenticationRequired) return { kind: 'authentication-required', url: url.origin }
        if (originIsLoopback(url.origin) && await loopbackPortHeld(
          Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url.hostname.replace(/^\[|\]$/g, ''),
        )) return { kind: 'uncertain', url: url.origin }
      } catch { /* an invalid origin is unavailable */ }
      return { kind: 'unavailable' }
    }
  }

  /** Compatibility wrapper for call sites that only act on a verified Harness. */
  async function probeWebUi(base: string, timeoutMs = 1_500): Promise<string | undefined> {
    const result = await inspectWebUi(base, timeoutMs)
    return result.kind === 'verified' ? result.url : undefined
  }

  /** Resolve the configured or automatic bind for the next managed-child spawn. */
  async function prepareLocalWebPort(): Promise<number> {
    const configured = configuredLocalWebPort()
    if (configured > 0) return configured
    const selected = await selectAutomaticLocalWebPort(loopbackPortAvailable)
    console.log('[desktop] automatic local web port: ' + (selected === 0
      ? 'OS-assigned (3080 and 13080 are occupied)'
      : String(selected)))
    return selected
  }

  /**
   * Allow binding and API initialization after the log line. The loading
   * surface tells the user a first launch can exceed 20 seconds (an antivirus
   * doing a full scan, a cold model cache), so the deadline matches that
   * promise rather than killing a child that is simply still booting.
   */
  async function waitForWebUiReady(base: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await probeWebUi(base, 300) !== undefined) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('dsh web reported readiness but did not accept API requests')
  }

  return { defaultWebProbeUrl, probeSmartTargets, inspectWebUi, probeWebUi, prepareLocalWebPort, waitForWebUiReady }
}
export type WebUiProbe = ReturnType<typeof createWebUiProbe>
