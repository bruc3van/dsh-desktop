/** Entry point: `node src/main.ts` (Node 24 runs the TypeScript sources directly). */
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'

const config = loadConfig()
const app = await createApp({ config, db: await openDb(config.databaseUrl) })
const address = await app.listen()
console.log('[server] DSH Desktop Pro management server for "' + config.tenant.name + '" listening on ' + address + ' (public URL ' + config.publicUrl + ')')
if (config.devLogin) console.warn('[server] DSH_DEV_LOGIN is on: anyone who can reach this server can sign in as any imported e-mail address.')
if (config.bootstrapToken !== undefined) console.warn('[server] DSH_BOOTSTRAP_TOKEN is set: remove it once an administrator can sign in through SSO.')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close().finally(() => process.exit(0)) })
}
