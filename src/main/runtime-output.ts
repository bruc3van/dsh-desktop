import { StringDecoder } from 'node:string_decoder'

const RUNTIME_OUTPUT_TAIL_LIMIT = 8_192

/** Frame both streams before redaction. Oversized lines are omitted in full. */
export function createRuntimeLineReader(onLine: (line: string) => void, limit = 65_536) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let dropping = false
  function accept(text: string): void {
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] ?? ''
      if (!dropping) {
        if (pending.length + part.length > limit) {
          pending = ''
          dropping = true
          onLine('[runtime output line omitted: exceeds limit]')
        } else pending += part
      }
      if (index < parts.length - 1) {
        if (!dropping) onLine(pending.replace(/\r$/, ''))
        pending = ''
        dropping = false
      }
    }
  }
  return {
    write(chunk: Buffer): void { accept(decoder.write(chunk)) },
    end(): void {
      accept(decoder.end())
      if (!dropping && pending !== '') onLine(pending)
      pending = ''
    },
  }
}
const ANSI_CSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g')

/**
 * Parse the readiness line the official Web app prints once the server binds.
 * The line comes from a child's stdout, so the value is only accepted as a
 * navigation target after it parses as an http(s) URL — the window must never
 * be pointed at a `file:`/`javascript:` string a damaged or substituted
 * runtime happened to print. rc.8 also prints
 * `dsh web: opening the default browser; pass --no-open to disable`; requiring
 * an http(s) URL keeps that diagnostic from being mistaken for readiness.
 */
export function parseReadiness(line: string): string | undefined {
  const match = /^dsh web:\s+(https?:\/\/\S+)/i.exec(line)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Keep only the tail: startup failures end with the actionable exception. */
export function appendRuntimeOutputTail(current: string, chunk: Buffer): string {
  return (current + chunk.toString()).slice(-RUNTIME_OUTPUT_TAIL_LIMIT)
}

/**
 * Runtime output is shown locally, but it can still echo credentials from a
 * damaged config. Remove terminal decoration and common secret assignments
 * before it reaches the error page or the status bridge.
 */
export function sanitizeRuntimeOutput(value: string): string {
  const printable = [...value.replace(/\r\n?/g, '\n').replace(ANSI_CSI_PATTERN, '')]
    .filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32)
    .join('')
  return printable
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[redacted]')
    .trim()
}

/** Prefer stderr; fall back to stdout for CLIs that report failures there. */
export function runtimeStartupDiagnostic(stderr: string, stdout: string): string | undefined {
  const errorOutput = sanitizeRuntimeOutput(stderr)
  if (errorOutput !== '') return errorOutput
  const normalOutput = sanitizeRuntimeOutput(stdout)
  return normalOutput === '' ? undefined : normalOutput
}

/** One bounded status-line summary; the failure page retains the full tail. */
export function runtimeDiagnosticSummary(detail: string): string {
  const lines = detail.split('\n').map(line => line.trim()).filter(line => line !== '')
  const useful = lines.find(line => /error|failed|cannot|missing|enoent|exception/i.test(line))
    ?? lines.at(-1)
    ?? detail
  return useful.slice(0, 300)
}
