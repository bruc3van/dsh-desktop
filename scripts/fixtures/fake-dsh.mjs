#!/usr/bin/env node
/**
 * A stand-in for a user-installed `dsh`, for check-installed-runtime.mjs.
 *
 * It answers the two things the desktop client asks of an installed runtime:
 * `--version`, which is the whole condition check, and `web --port 0`, which
 * must print the official readiness line and then serve `/api/host.describe`.
 * DSH_FIXTURE_FAIL=1 makes `web` exit immediately, standing in for an
 * installed runtime that is present but cannot start.
 * @module desktop/scripts/fixtures/fake-dsh
 */

import { createServer } from 'node:http'

const FIXTURE_VERSION = '0.9.9-fake'
const args = process.argv.slice(2)

if (args.includes('--version')) {
  process.stdout.write(FIXTURE_VERSION + '\n')
  process.exit(0)
}

if (args[0] !== 'web') {
  process.stderr.write('fake-dsh: unsupported command: ' + args.join(' ') + '\n')
  process.exit(2)
}

if (process.env.DSH_FIXTURE_FAIL === '1') {
  process.stderr.write('fake-dsh: refusing to start (DSH_FIXTURE_FAIL)\n')
  process.exit(1)
}

const server = createServer((req, res) => {
  if (req.url === '/api/host.describe' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>Installed Harness Fixture</title></head>'
    + '<body><p>installed fixture</p></body></html>')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  // The exact line shape `parseReadiness` matches in the official runtime.
  process.stdout.write('dsh web: http://127.0.0.1:' + String(address.port) + '\n')
})

// The client stops this child with SIGTERM before it quits; exit cleanly so a
// leaked process is a real failure rather than fixture noise.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => { process.exit(0) }) })
}
