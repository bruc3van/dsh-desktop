/**
 * A deliberately small HTTP layer on `node:http`: a path router, bounded JSON
 * and form bodies, cookies, and security headers on every response.
 * @module @dsh-desktop-pro/server/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

export interface Context {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  method: string
}

export type Handler = (ctx: Context) => Promise<void> | void

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export function createRouter() {
  const routes: Route[] = []
  function add(method: string, path: string, handler: Handler): void {
    const keys: string[] = []
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_match, key: string) => { keys.push(key); return '([^/]+)' }) + '$')
    routes.push({ method, pattern, keys, handler })
  }
  function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | undefined {
    let pathMatched = false
    for (const route of routes) {
      const found = route.pattern.exec(pathname)
      if (found === null) continue
      pathMatched = true
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1] ?? '') })
      return { handler: route.handler, params }
    }
    return pathMatched ? 'method' : undefined
  }
  return {
    get: (path: string, handler: Handler) => { add('GET', path, handler) },
    post: (path: string, handler: Handler) => { add('POST', path, handler) },
    put: (path: string, handler: Handler) => { add('PUT', path, handler) },
    patch: (path: string, handler: Handler) => { add('PATCH', path, handler) },
    delete: (path: string, handler: Handler) => { add('DELETE', path, handler) },
    match,
  }
}

export type Router = ReturnType<typeof createRouter>

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('cache-control', 'no-store')
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; base-uri 'none'",
  })
  res.end(html)
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'body_too_large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const text = await readBody(req, limit)
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

export async function readForm(req: IncomingMessage, limit = 64_000): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req, limit))
}

export async function readText(req: IncomingMessage, limit = 5_000_000): Promise<string> {
  return readBody(req, limit)
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function setCookie(res: ServerResponse, name: string, value: string, options: { maxAge?: number; secure: boolean; path?: string }): void {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=' + (options.path ?? '/'), 'HttpOnly', 'SameSite=Lax']
  if (options.secure) parts.push('Secure')
  if (options.maxAge !== undefined) parts.push('Max-Age=' + String(options.maxAge))
  res.appendHeader('set-cookie', parts.join('; '))
}

export function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') === true ? header.slice(7).trim() : undefined
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}
