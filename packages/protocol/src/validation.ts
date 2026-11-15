/**
 * Tiny structural validation helpers. The protocol package has no runtime
 * dependencies, so both the Electron main process and the server can load it
 * as-is; every validator reports the first violation with a JSON path.
 * @module @dsh-desktop-pro/protocol/validation
 */

export type Result<T> = { ok: true; value: T } | { ok: false; path: string; reason: string }

// No parameter properties: the server runs this file with Node's type stripping.
export class Invalid extends Error {
  readonly path: string
  readonly reason: string
  constructor(path: string, reason: string) {
    super(path + ': ' + reason)
    this.path = path
    this.reason = reason
  }
}

export function fail(path: string, reason: string): never {
  throw new Invalid(path, reason)
}

export function asResult<T>(run: () => T): Result<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, path: error.path, reason: error.reason }
    throw error
  }
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  return value as Record<string, unknown>
}

/** Reject keys a validator does not know, so a typo never silently means "unset". */
export function onlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path + '.' + key, 'is not a known field')
  }
}

export function string(value: unknown, path: string, options: { max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string')
  if (value.length > (options.max ?? 4096)) fail(path, 'is too long')
  if (options.pattern !== undefined && !options.pattern.test(value)) fail(path, 'has an invalid format')
  return value
}

export function optionalString(value: unknown, path: string, options: { max?: number; pattern?: RegExp } = {}): string | undefined {
  return value === undefined ? undefined : string(value, path, options)
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

export function optionalBoolean(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, path)
}

export function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, 'must be an integer from ' + String(min) + ' to ' + String(max))
  }
  return value
}

export function array(value: unknown, path: string, max = 1000): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > max) fail(path, 'has too many entries')
  return value
}

export function stringArray(value: unknown, path: string, options: { max?: number; pattern?: RegExp } = {}): string[] {
  const items = array(value, path).map((item, index) => string(item, path + '[' + String(index) + ']', options))
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item)) fail(path + '[' + String(index) + ']', 'is a duplicate')
    seen.add(item)
  })
  return items
}

/** An absolute http(s) URL without credentials or a fragment. */
export function httpUrl(value: unknown, path: string): string {
  const text = string(value, path, { max: 2048 })
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(path, 'must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use http or https')
  if (url.username !== '' || url.password !== '') fail(path, 'must not carry credentials')
  if (url.hash !== '') fail(path, 'must not carry a fragment')
  return text
}

export function isoTimestamp(value: unknown, path: string): string {
  const text = string(value, path, { max: 64 })
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    fail(path, 'must be an ISO-8601 UTC timestamp')
  }
  return text
}
