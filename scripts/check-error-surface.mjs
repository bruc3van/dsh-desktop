/**
 * Connection-failure surface check. A configured server that answers 400 with
 * its OWN error page (the nginx "plain HTTP request was sent to HTTPS port"
 * case) must never be shown as if it were the app: the window has to carry the
 * client's failure surface, with a cause line and a way out.
 * Usage: node scripts/check-error-surface.mjs
 * @module desktop/scripts/check-error-surface
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { sanitizedElectronEnv } from './lib/electron-env.mjs'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const checkHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-error-surface-'))
const desktopHome = join(checkHome, 'desktop')
mkdirSync(desktopHome, { recursive: true })

const badServer = createServer((req, res) => {
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<html><head><title>400 The plain HTTP request was sent to HTTPS port</title></head>'
    + '<body><center><h1>400 Bad Request</h1></center>'
    + '<center>The plain HTTP request was sent to HTTPS port</center>'
    + '<hr><center>nginx/1.24.0 (Ubuntu)</center></body></html>')
})
await new Promise((resolve, reject) => {
  badServer.once('error', reject)
  badServer.listen(0, '127.0.0.1', resolve)
})
const address = badServer.address()
if (typeof address !== 'object' || address === null) throw new Error('fixture did not bind')
const origin = 'http://127.0.0.1:' + String(address.port)
writeFileSync(join(desktopHome, 'settings.json'),
  JSON.stringify({ serverUrl: origin, connectionMode: 'connect' }, null, 2) + '\n')

const electronEnv = sanitizedElectronEnv()
electronEnv.DSH_HOME = join(checkHome, 'dsh')
electronEnv.DSH_DESKTOP_HOME = desktopHome
electronEnv.DSH_DESKTOP_SKIP_PROBE = '1'
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
electronEnv.DSH_DESKTOP_SKIP_UPDATE_PROMPT = '1'

let failed = false
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : ' — ' + detail))
  if (!ok) failed = true
}

let app
try {
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'chromium')],
    env: electronEnv,
  })
  const window = await app.firstWindow()
  await window.waitForSelector('#error-retry', { timeout: 20_000 })

  const title = await window.title()
  check('the server error page never reaches the window', !/400/.test(title), title)
  check('the failure is named', (await window.locator('h1').innerText()).length > 0)
  const hint = await window.locator('.hint').innerText()
  check('the cause line points at HTTPS', /https:\/\//.test(hint), hint)
  const facts = await window.locator('.fact').allInnerTexts()
  check('address and reason are shown', facts.length === 2, JSON.stringify(facts))
  const buttons = await window.locator('.actions button').allInnerTexts()
  // Four seats here because this failure is a PINNED address: alongside retry,
  // settings and quit, such a failure also offers the escape to Smart mode. A
  // failure with nothing pinned has no Smart mode to fall back to and offers three.
  check('retry / smart / settings / quit are offered', buttons.length === 4, JSON.stringify(buttons))
  // The buttons are in the document as soon as it parses, but their handlers
  // are assigned from the main process after loadURL settles. Asserting on
  // sight races that round trip — and an unbound button also makes the click
  // below do nothing. Wait for the binding rather than assume it has landed.
  const seats = () => [
    typeof document.getElementById('error-retry')?.onclick,
    typeof document.getElementById('error-use-smart')?.onclick,
    typeof document.getElementById('error-settings')?.onclick,
    typeof document.getElementById('error-quit')?.onclick,
  ].join(',')
  const bound = await window.waitForFunction(
    () => [
      document.getElementById('error-retry')?.onclick,
      document.getElementById('error-use-smart')?.onclick,
      document.getElementById('error-settings')?.onclick,
      document.getElementById('error-quit')?.onclick,
    ].every(handler => typeof handler === 'function'),
    { timeout: 10_000 },
  ).then(() => 'function,function,function,function', () => window.evaluate(seats))
  check('every seat is bound', bound === 'function,function,function,function', bound)

  // The settings seat is the only way back when there is no page to carry the
  // official dialog's enhanced 连接 block.
  await window.locator('#error-settings').click()
  const settings = await app.waitForEvent('window', { timeout: 10_000 }).catch(() => null)
  // Either spelling of the title: the settings page follows the client
  // locale, and the runner's locale is not this check's business.
  const settingsTitle = settings === null ? null : await settings.locator('.page-title').innerText()
  check('the settings seat opens the desktop settings window',
    settingsTitle === 'DSH Desktop 设置' || settingsTitle === 'DSH Desktop settings', String(settingsTitle))
  check('the data environment choices are present', settings !== null
    && await settings.locator('#data-shared').count() === 1
    && await settings.locator('#data-isolated').count() === 1)
  const dataChoicesLocked = settings === null ? false : await settings.waitForFunction(
    () => document.getElementById('data-shared')?.disabled === true
      && document.getElementById('data-isolated')?.disabled === true,
    { timeout: 10_000 },
  ).then(() => true, () => false)
  check('an explicit DSH_HOME fixture locks the data environment choices', dataChoicesLocked)
  // A download that cannot reach the release assets host leaves the manual page
  // as the only way forward, so the update section carries a link to it.
  const releasesHref = settings === null
    ? null
    : await settings.locator('#update-page').getAttribute('href').catch(() => null)
  check('the update section links to the releases page',
    releasesHref === 'https://github.com/bruc3van/dsh-desktop/releases', String(releasesHref))
  await settings?.close().catch(() => {})

  // Retry must re-run the connection rather than stall on the loading
  // document — and a server that is now gone entirely is the other failure
  // family (no document at all), which the same surface has to carry.
  await new Promise(resolve => badServer.close(resolve))
  await window.locator('#error-retry').click()
  // Match the reason cell, not the whole block: the address cell carries a
  // randomly bound port, and a port that happens to contain the error number
  // would satisfy a whole-block test before the retry has produced anything —
  // passing the check by masking the failure it exists to catch. The named
  // constant rather than the number, for the same reason.
  const refused = await window.waitForFunction(
    () => (document.querySelectorAll('.fact')[1]?.textContent ?? '').includes('ERR_CONNECTION_REFUSED'),
    { timeout: 30_000 },
  ).then(() => true, () => false)
  check('retry reports the next failure (connection refused)', refused,
    (await window.locator('.facts').innerText()).replace(/\n/g, ' | '))

  // A GUI build has no visible stderr console. Preserve the failed runtime's
  // output in the local error surface, but strip terminal decoration and
  // credentials before showing it.
  await app.close()
  app = undefined
  const failingRuntime = join(checkHome, 'failing-dsh.mjs')
  writeFileSync(failingRuntime,
    "process.stderr.write('\\u001b[31mError: missing VCRUNTIME140.dll\\u001b[0m\\n')\n"
    + "process.stderr.write('DEEPSEEK_API_KEY=not-for-the-screen\\n')\n"
    + "process.stderr.write('{\\\"token\\\":\\\"json-secret\\\"}\\n')\n"
    + 'process.exit(1)\n')
  writeFileSync(join(desktopHome, 'settings.json'),
    JSON.stringify({ connectionMode: 'smart', smartRuntimes: ['bundled'] }, null, 2) + '\n')
  app = await electron.launch({
    args: [join(APP_DIR, '.build', 'main.mjs'), '--user-data-dir=' + join(checkHome, 'runtime-chromium')],
    env: {
      ...electronEnv,
      DSH_DESKTOP_DSH: failingRuntime,
    },
  })
  const runtimeWindow = await app.firstWindow()
  await runtimeWindow.waitForSelector('#error-retry', { timeout: 35_000 })
  const runtimeFacts = await runtimeWindow.locator('.facts').innerText()
  check('runtime exit code and diagnostic are shown',
    /(?:code|\u4ee3\u7801) 1/.test(runtimeFacts) && runtimeFacts.includes('missing VCRUNTIME140.dll'),
    runtimeFacts.replace(/\n/g, ' | '))
  check('runtime source and launch target are shown',
    runtimeFacts.includes('override') && runtimeFacts.includes(failingRuntime),
    runtimeFacts.replace(/\n/g, ' | '))
  check('runtime diagnostic strips terminal decoration',
    !runtimeFacts.includes('[31m') && !runtimeFacts.includes('[0m'), runtimeFacts.replace(/\n/g, ' | '))
  check('runtime diagnostic redacts credentials',
    runtimeFacts.includes('[redacted]')
      && !runtimeFacts.includes('not-for-the-screen')
      && !runtimeFacts.includes('json-secret'),
    runtimeFacts.replace(/\n/g, ' | '))
} catch (error) {
  check('run', false, error instanceof Error ? error.message : String(error))
} finally {
  await app?.close().catch(() => {})
  if (badServer.listening) await new Promise(resolve => badServer.close(resolve))
  rmSync(checkHome, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
