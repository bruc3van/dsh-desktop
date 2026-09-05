import { randomBytes } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { DesktopUpdater, UpdateState } from './updater.ts'
import type { ClientSettings } from './client-settings.ts'

type SaveResult = { saved: boolean; error?: string }

export interface SettingsServerOptions {
  updater: () => Pick<DesktopUpdater, 'getState' | 'check' | 'resetDismiss' | 'dismiss'> | undefined
  getStatusJson: () => unknown
  setBundledMarketEnabled: (enabled: unknown, remoteCaller: boolean) => Promise<{ enabled: boolean }>
  probeDefaultWebUi: () => Promise<unknown>
  desktopClientVersion: () => string
  updateStateForPage: (state: UpdateState) => unknown
  pageUpdateState: () => unknown
  installDesktopUpdate: () => Promise<{ started: boolean; error?: string }>
  scheduleQuitAfterWindowsInstall: () => void
  settingsPageScript: () => string
  settingsPageHtml: () => string
  loadSettings: () => ClientSettings
  configuredLocalWebPort: () => number
  requestServerUrlSave: (value: unknown, remoteCaller: boolean) => Promise<SaveResult>
  requestSmartRuntimesSave: (value: unknown) => Promise<SaveResult>
  requestLocalWebPortSave: (value: unknown, remoteCaller: boolean) => Promise<SaveResult>
  requestDshDataModeSave: (value: unknown) => SaveResult
  switchConnectionMode: () => Promise<{ switched: boolean; error?: string }>
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }
}

function writeJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, jsonHeaders())
  res.end(JSON.stringify(body))
}

/** Read one bounded UTF-8 JSON body; an incomplete request never invokes a save. */
function readSettingsBody(
  req: IncomingMessage, res: ServerResponse, key: string,
  save: (value: unknown) => SaveResult | Promise<SaveResult>, rejectionStatus = 400,
): void {
  let chunks: Buffer[] = []
  let bytes = 0
  let settled = false
  const abandon = (): void => { settled = true; chunks = [] }
  req.on('aborted', abandon)
  req.on('error', () => {
    abandon()
    writeJson(res, 400, { saved: false, error: 'request body could not be read' })
  })
  req.on('data', (chunk: Buffer) => {
    if (settled) return
    bytes += chunk.length
    if (bytes > 16_384) {
      abandon()
      writeJson(res, 413, { saved: false, error: 'request body too large' })
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    const body = Buffer.concat(chunks).toString('utf8')
    chunks = []
    try {
      const value = (JSON.parse(body) as Record<string, unknown>)[key]
      void Promise.resolve(save(value)).then(
        result => { writeJson(res, result.saved ? 200 : 400, result) },
        (error: unknown) => { writeJson(res, rejectionStatus, { saved: false, error: error instanceof Error ? error.message : String(error) }) },
      )
    } catch (error) {
      writeJson(res, 400, { saved: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** Owns the private loopback transport; callers own validation and side effects. */
export function createSettingsServer(options: SettingsServerOptions) {
  const {
    getStatusJson,
    setBundledMarketEnabled,
    probeDefaultWebUi,
    desktopClientVersion,
    updateStateForPage,
    pageUpdateState,
    installDesktopUpdate,
    scheduleQuitAfterWindowsInstall,
    settingsPageScript,
    requestServerUrlSave,
    loadSettings,
    configuredLocalWebPort,
    requestSmartRuntimesSave,
    requestLocalWebPortSave,
    requestDshDataModeSave,
    switchConnectionMode,
    settingsPageHtml,
  } = options
  let settingsServerPort = 0
  const settingsServerPath = '/' + randomBytes(24).toString('hex') + '/'
  let server: Server | undefined
  /** Start the private-path loopback settings server and resolve only once bound. */
  function start(): Promise<number> {
    const listeningServer = createServer((req, res) => {
      const desktopUpdater = options.updater()
      // Defence in depth behind the unguessable path: these headers cost nothing
      // and the Host check closes DNS rebinding, where a name that resolves to
      // 127.0.0.1 would otherwise reach this server under an attacker's origin.
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-frame-options', 'DENY')
      res.setHeader('referrer-policy', 'no-referrer')
      const port = String(settingsServerPort)
      const host = (req.headers.host ?? '').toLowerCase()
      if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port && host !== '[::1]:' + port) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(settingsServerPath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const pathname = '/' + url.pathname.slice(settingsServerPath.length)
      if (pathname === '/desktop/status') {
        writeJson(res, 200, getStatusJson())
        return
      }
      if ((pathname === '/desktop/market/enable' || pathname === '/desktop/market/disable') && req.method === 'POST') {
        void setBundledMarketEnabled(pathname.endsWith('/enable'), false).then(
          result => { writeJson(res, 200, result) },
          (error: unknown) => { writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) }) },
        )
        return
      }
      if (pathname === '/desktop/probe') {
        void probeDefaultWebUi().then((result) => { writeJson(res, 200, result) })
        return
      }
      if (pathname === '/desktop/update') {
        const state = desktopUpdater?.getState()
        writeJson(res, 200, state === undefined
          ? { phase: 'idle', currentVersion: desktopClientVersion(), info: null, progress: null, error: 'updater not ready', dismissed: false, isChecking: false }
          : updateStateForPage(state))
        return
      }
      if (pathname === '/desktop/update/check' && req.method === 'POST') {
        if (desktopUpdater === undefined) {
          writeJson(res, 503, { hasUpdate: false, error: 'updater not ready' })
          return
        }
        desktopUpdater.resetDismiss()
        void desktopUpdater.check().then((result) => {
          writeJson(res, 200, { ...result, state: pageUpdateState() })
        })
        return
      }
      if (pathname === '/desktop/update/install' && req.method === 'POST') {
        void installDesktopUpdate().then((result) => {
          writeJson(res, result.started ? 200 : 400, { ...result, state: pageUpdateState() })
          if (result.started) scheduleQuitAfterWindowsInstall()
        })
        return
      }
      if (pathname === '/desktop/update/dismiss' && req.method === 'POST') {
        desktopUpdater?.dismiss()
        writeJson(res, 200, pageUpdateState() ?? { dismissed: true })
        return
      }
      if (pathname === '/desktop/settings.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(settingsPageScript())
        return
      }
      if (pathname === '/desktop/settings') {
        if (req.method === 'POST') {
          readSettingsBody(req, res, 'serverUrl', value => requestServerUrlSave(value, false), 500)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(JSON.stringify({ ...loadSettings(), localWebPort: configuredLocalWebPort() }))
        return
      }
      if (pathname === '/desktop/smart-runtimes' && req.method === 'POST') {
        readSettingsBody(req, res, 'smartRuntimes', requestSmartRuntimesSave)
        return
      }
      if (pathname === '/desktop/local-web-port' && req.method === 'POST') {
        readSettingsBody(req, res, 'localWebPort', value => requestLocalWebPortSave(value, false))
        return
      }
      if (pathname === '/desktop/dsh-data-mode' && req.method === 'POST') {
        readSettingsBody(req, res, 'dshDataMode', requestDshDataModeSave)
        return
      }
      if (pathname === '/desktop/switch' && req.method === 'POST') {
        void switchConnectionMode().then((result) => {
          res.writeHead(result.switched ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
        }, (error: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ switched: false, error: error instanceof Error ? error.message : String(error) }))
        })
        return
      }
      if (pathname === '/' || pathname === '/desktop/settings.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(settingsPageHtml())
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    server = listeningServer
    return new Promise<number>((resolve, reject) => {
      listeningServer.once('error', reject)
      listeningServer.listen(0, '127.0.0.1', () => {
        listeningServer.off('error', reject)
        const address = listeningServer.address()
        settingsServerPort = typeof address === 'object' && address !== null ? address.port : 0
        resolve(settingsServerPort)
      })
    })
  }

  return {
    start,
    get port() { return settingsServerPort },
    get url() { return 'http://127.0.0.1:' + String(settingsServerPort) + settingsServerPath },
    close: () => new Promise<void>((resolve, reject) => {
      if (server === undefined || !server.listening) { resolve(); return }
      server.close(error => { if (error) reject(error); else { settingsServerPort = 0; resolve() } })
    }),
  }
}
