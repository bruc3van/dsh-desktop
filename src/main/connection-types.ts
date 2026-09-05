/** One connection failure, in the terms the error surface needs to describe it. */
export type ConnectionFailure =
  /** Chromium never got a document: DNS, refused, timeout, TLS. */
  | { kind: 'load'; url: string; code: number; description: string }
  /** A document arrived, but it is the server's error page, not the Web UI. */
  | { kind: 'http'; url: string; status: number; statusText: string }
  /** The local runtime itself could not run. */
  | { kind: 'runtime'; headline: string; detail: string; recordPath?: string; hint?: string; url?: string }
