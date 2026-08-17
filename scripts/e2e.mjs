/**
 * End-to-end smoke: boot the client (official Web UI in the window), send a
 * real prompt through the official composer, and verify the streamed
 * assistant reply lands. The API key comes from the machine's existing
 * harness home (~/.dsh/.env) or the client's own credentials store and is
 * never printed. Usage: node scripts/e2e.mjs
 * @module desktop/scripts/e2e
 */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(APP_DIR, 'shots')
const electronEnv = { ...process.env }
Reflect.deleteProperty(electronEnv, 'ELECTRON_RUN_AS_NODE')
// The prompt goes through the user's real key, so it must never touch their
// real session store or connection settings: both homes are per-run
// temporaries, seeded with the key and nothing else.
const e2eHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-e2e-'))
process.on('exit', () => { rmSync(e2eHome, { recursive: true, force: true }) })
electronEnv.DSH_HOME = e2eHome
electronEnv.DSH_DESKTOP_HOME = join(e2eHome, 'desktop')
electronEnv.DSH_DESKTOP_SKIP_INSTALLED_DSH = '1'
const shot = async (page, name) => {
  const path = join(outDir, name + '.png')
  await page.screenshot({ path })
  console.log('saved ' + path)
}

// The client's own data home may already hold the key (credentials seam);
// otherwise fall back to the machine's existing harness home (never printed).
let apiKey = process.env.DEEPSEEK_API_KEY ?? ''
if (apiKey === '') {
  const homeEnv = join(homedir(), '.dsh', '.env')
  if (existsSync(homeEnv)) {
    const text = readFileSync(homeEnv, 'utf8')
    const match = /^DEEPSEEK_API_KEY=(.+)$/m.exec(text)
    if (match !== null) apiKey = match[1].trim()
  }
}
if (apiKey === '') {
  // A skip must not look green: this check verifies a LIVE round trip, and
  // without a key it verified nothing. Provide the key (export
  // DEEPSEEK_API_KEY=…, or add it once via 设置 → 凭据) to run it.
  console.log('e2e needs an API key: export DEEPSEEK_API_KEY=… (or add one in 设置 → 凭据)')
  process.exit(2)
}
mkdirSync(e2eHome, { recursive: true })
writeFileSync(join(e2eHome, '.env'), 'DEEPSEEK_API_KEY=' + apiKey + '\n', { mode: 0o600 })

const app = await electron.launch({ args: [join(APP_DIR, '.build', 'main.mjs')], env: electronEnv })
const window = await app.firstWindow()
window.on('console', msg => console.log('[renderer:' + msg.type() + '] ' + msg.text().slice(0, 300)))
window.on('pageerror', err => console.log('[pageerror] ' + err.message.slice(0, 500)))
await window.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 60000 })
// The isolated DSH_HOME is pristine, so the official first-run onboarding
// opens before the composer exists; advance through it (and any notice/model
// modal) the same way shot.mjs does.
for (let step = 0; step < 8; step += 1) {
  const onboarding = window.locator('[class*="onboardingOverlay"]').last()
  if (!await onboarding.isVisible().catch(() => false)) break
  const buttons = onboarding.getByRole('button')
  const count = await buttons.count()
  if (count === 0) break
  await buttons.nth(count - 1).click()
  await window.waitForTimeout(500)
}
await window.waitForFunction(() => document.querySelector('[class*="onboardingOverlay"]') === null, null, { timeout: 30000 })
for (let step = 0; step < 8; step += 1) {
  const mask = window.locator('div[aria-hidden="true"][class*="_mask_"]').last()
  if (!await mask.isVisible().catch(() => false)) break
  const modal = window.locator('[role="presentation"]').filter({ visible: true }).last()
  const buttons = modal.locator('button:not([disabled])').filter({ visible: true })
  const count = await buttons.count()
  if (count > 0) await buttons.nth(count - 1).click()
  else await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
}
await window.waitForTimeout(3000)
await shot(window, '10-booted')

// Use a per-run arithmetic result that is NOT present in the prompt. Checking
// for a word contained in the user's own message would make this test pass
// before the assistant produced anything.
const left = 10_000 + Math.floor(Math.random() * 40_000)
const right = 50_000 + Math.floor(Math.random() * 40_000)
const expected = String(left + right)
const prompt = `请计算 ${String(left)} 加 ${String(right)}，只回复十进制结果。`

// Type a prompt and send it through the official composer.
const composer = window.locator('textarea').first()
await composer.click()
await window.keyboard.type(prompt, { delay: 8 })
await window.waitForTimeout(300)
await shot(window, '11-ready-to-send')
await window.getByRole('button', { name: '发送消息' }).click()
await window.waitForTimeout(800)
await shot(window, '12-running')

// Wait for the per-run result to land. Neither operand nor the user message
// contains the expected sum, so the user bubble cannot satisfy this check.
let replied = false
for (let i = 0; i < 90; i += 1) {
  await window.waitForTimeout(1000)
  const has = await window.evaluate(result => document.body.innerText.includes(result), expected).catch(() => false)
  if (has) {
    replied = true
    break
  }
}
await shot(window, '13-reply')
const text = await window.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '')
console.log('assistant replied: ' + replied + ' — "' + text.replace(/\s+/g, ' ').slice(0, 120) + '"')

await app.close()
process.exit(replied ? 0 : 1)
