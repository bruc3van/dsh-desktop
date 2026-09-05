import { createConnection, createServer as createTcpServer } from 'node:net'

/**
 * Whether anything is accepting TCP on this loopback port. Used to refuse a
 * pinned bind that would fail with EADDRINUSE — including an unrelated
 * process that is not a dsh (probeWebUi would miss those).
 */
export function loopbackPortHeld(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (held: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(held)
    }
    socket.setTimeout(300)
    socket.once('connect', () => { finish(true) })
    socket.once('timeout', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

/** Check whether the managed child can bind this IPv4 loopback port. */
export function loopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer()
    let settled = false
    const finish = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners()
      if (server.listening) server.close(() => { resolve(available) })
      else resolve(available)
    }
    server.once('error', () => { finish(false) })
    server.once('listening', () => { finish(true) })
    server.listen({ host: '127.0.0.1', port })
  })
}
