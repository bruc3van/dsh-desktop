/**
 * Enterprise mode, as one object the main process consults.
 *
 * Personal mode is the absence of a managed source, and in that case every
 * method here is inert: the client behaves exactly as before. With a source:
 *
 * - the runtime always runs from the bundled DSH (the version IT tested) in a
 *   separate data home under the client's own directory, so organisation
 *   data never mixes with a personal `~/.dsh` and signing out can remove it;
 * - connection, runtime-source and data-environment settings are fixed;
 * - before each launch the accepted desired state is cached and the launcher
 *   applies it to the profile; after the runtime is up, plugin packages are
 *   synchronised and (server mode) the result is reported;
 * - in server mode the document is re-fetched every few minutes and applied
 *   live; a cached document keeps working offline within its grace period.
 * @module dsh-desktop-pro/enterprise/controller
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { usableOffline, validateDesiredState, type AuditEventInput, type CompanySkill, type DesiredState, type StatusReport } from '@dsh-desktop-pro/protocol'
import type { ClientSettings } from '../client-settings.ts'
import { MANAGED_STATE_VARIABLE, type ManagedBootRequest } from './managed-boot.ts'
import { loadManagedSource, type ManagedSource } from './managed-source.ts'
import { planPluginSync, runPluginSync, type PluginCommandRunner } from './plugin-sync.ts'
import { WEB_PROFILE } from '../web-profile.ts'
import { applyDesiredState, DENIAL_LOG_FILE, removeManagedConfiguration } from './reconcile.ts'
import { ServerSession, SessionError, type SecretCodec } from './server-session.ts'

export { MANAGED_STATE_VARIABLE }

/** How often server mode asks for a newer document. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000

export type Readiness =
  | { kind: 'ready' }
  | { kind: 'sign-in'; organization: string; server: string; personalAllowed: boolean; reason?: string }
  | { kind: 'blocked'; title: string; reason: string; personalAllowed?: boolean }

interface CachedState { receivedAt: number; source: 'file' | 'server'; state: DesiredState }

export interface EnterpriseOptions {
  clientHome: string
  managedDir: string
  clientVersion: string
  chinese(): boolean
  /** Absolute path of the shipped policy plugin, when this build has one. */
  policyPluginPath(): string | undefined
  secrets(): SecretCodec
  openBrowser(url: string): Promise<void>
  /** Bring the client back in front once the browser sign-in has finished. */
  focusApp?(): void
  /** Run `dsh <args>` with the runtime that is serving, for plugin installation. */
  runPluginCommand: PluginCommandRunner
  /** The bundled runtime version, for status reports. */
  dshVersion(): string | undefined
  log(line: string): void
}

export interface EnterpriseStatus {
  mode: 'personal' | 'file' | 'server' | 'invalid'
  organization?: string
  user?: string
  revision?: number
  receivedAt?: number
  offline?: boolean
  signed?: boolean
  problems: string[]
  credentialProtection?: 'os' | 'file-permissions'
  /** Last time the server answered with a document (server mode). */
  lastCheckedAt?: number
  /** Where the managed configuration file sits (file mode). */
  managedFile?: string
  /** The organisation's update settings, so the UI can say who decides. */
  updates?: { feedManaged: boolean; autoCheck?: boolean }
  /** Personal mode chosen on an enrolled machine: the organisation it can return to. */
  available?: string
  /** The organisation lets this person switch to personal mode. */
  personalAllowed?: boolean
}

export function createEnterpriseController(options: EnterpriseOptions) {
  const source: ManagedSource = loadManagedSource(options.managedDir)
  const root = join(options.clientHome, 'enterprise')
  const statePath = join(root, 'state.json')
  /** Present when the person chose personal mode on an enrolled machine that allows it. */
  const personalChoicePath = join(root, 'personal-mode.json')
  // Server mode: the enrollment says so before anyone signs in. File mode: the managed file.
  const personalAllowed = (source.kind === 'server' && source.enrollment.allowPersonal === true)
    || (source.kind === 'file' && source.state.allowPersonal === true)
  // Read once: switching either way restarts the client.
  const personalChosen = personalAllowed && existsSync(personalChoicePath)
  let session: ServerSession | undefined
  let problems: string[] = []
  /**
   * Why the organisation server could not be reached on the last attempt, or
   * undefined while it answers. One value on purpose: "offline" without a
   * reason cannot be represented, so the status and the report always say why.
   */
  let offlineReason: string | undefined
  function wentOffline(error: unknown): void {
    offlineReason = zh('暂时连不上企业服务，正在使用上次的配置。', 'The organisation server is unreachable; using the last configuration.')
      + ' (' + (error instanceof Error ? error.message : String(error)) + ')'
  }
  function backOnline(): void { offlineReason = undefined }
  /** The problems to show and report, led by the outage when there is one. */
  function knownProblems(): string[] {
    return offlineReason === undefined ? problems : [offlineReason, ...problems]
  }
  let lastCheckedAt: number | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let pollTick: (() => Promise<void>) | undefined
  let stopped = false

  const zh = (chinese: string, english: string): string => (options.chinese() ? chinese : english)

  function active(): boolean { return source.kind !== 'personal' && !personalChosen }
  function dshHome(): string { return join(root, 'dsh') }

  function serverSession(): ServerSession | undefined {
    if (source.kind !== 'server') return undefined
    session ??= new ServerSession({
      enrollment: source.enrollment,
      home: root,
      secrets: options.secrets(),
      openBrowser: options.openBrowser,
      clientVersion: options.clientVersion,
      callbackPage: {
        done: zh('登录成功', 'Signed in'),
        doneDetail: zh('DSH Desktop Pro 已回到前台，可以关闭这个页面了。', 'DSH Desktop Pro is back in front. You can close this tab.'),
        failed: zh('登录没有完成', 'Sign-in did not complete'),
        failedDetail: zh('请回到 DSH Desktop Pro 重新登录。', 'Return to DSH Desktop Pro and sign in again.'),
        lang: zh('zh-CN', 'en'),
      },
    })
    return session
  }

  function readCache(): CachedState | undefined {
    try {
      const cached = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<CachedState>
      const state = validateDesiredState(cached.state)
      if (!state.ok || typeof cached.receivedAt !== 'number' || (cached.source !== 'file' && cached.source !== 'server')) return undefined
      return { receivedAt: cached.receivedAt, source: cached.source, state: state.value }
    } catch {
      return undefined
    }
  }

  function writeCache(state: DesiredState, from: 'file' | 'server'): void {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const temporary = statePath + '.' + String(process.pid) + '.tmp'
    // The document can carry credentials; the cache is private to this user.
    writeFileSync(temporary, JSON.stringify({ receivedAt: Date.now(), source: from, state } satisfies CachedState) + '\n', { mode: 0o600 })
    renameSync(temporary, statePath)
  }

  /** Accept a fetched document unless it is older than what is already applied. */
  function accept(state: DesiredState, from: 'file' | 'server'): boolean {
    const cached = readCache()
    if (cached !== undefined && cached.source === from && cached.state.organization.id === state.organization.id
      && state.revision < cached.state.revision) {
      options.log('[enterprise] ignored revision ' + String(state.revision) + ' older than ' + String(cached.state.revision))
      return false
    }
    const changed = cached === undefined || JSON.stringify(cached.state) !== JSON.stringify(state)
    writeCache(state, from)
    return changed
  }

  /** Remove everything this organisation put on the machine. */
  async function wipe(reason: string): Promise<void> {
    options.log('[enterprise] removing managed configuration: ' + reason)
    removeManagedConfiguration({ dshHome: dshHome() })
    rmSync(statePath, { force: true })
    const current = serverSession()
    if (current !== undefined) {
      await current.signOut()
      current.forgetDevice()
    }
  }

  /** Decide whether the runtime may start, signing in first when asked to. */
  async function prepare(interactive: boolean): Promise<Readiness> {
    problems = []
    backOnline()
    if (source.kind === 'personal' || !active()) return { kind: 'ready' }
    if (source.kind === 'invalid') {
      return {
        kind: 'blocked',
        title: zh('企业配置无效', 'The organisation configuration is invalid'),
        reason: source.file + ' ' + source.reason + zh('。请联系 IT 管理员。', '. Contact your IT administrator.'),
      }
    }
    if (source.kind === 'file') {
      if (source.state.wipe === true) {
        await wipe('the managed file asks for removal')
        return { kind: 'blocked', title: zh('此设备已停用', 'This device was retired'), reason: zh('IT 管理员已移除这台设备的企业配置。', 'Your IT administrator removed the organisation configuration from this device.') }
      }
      accept(source.state, 'file')
      return { kind: 'ready' }
    }
    const current = serverSession()
    if (current === undefined) return { kind: 'ready' }
    const organization = source.enrollment.organization.name
    const gate = { organization, server: source.enrollment.server, personalAllowed }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!current.isSignedIn()) {
        if (!interactive) return { kind: 'sign-in', ...gate }
        try {
          await current.signIn()
          options.focusApp?.()
        } catch (error) {
          return { kind: 'sign-in', ...gate, reason: error instanceof Error ? error.message : String(error) }
        }
      }
      try {
        const state = await current.fetchDesiredState()
        lastCheckedAt = Date.now()
        if (state.wipe === true) {
          await wipe('the server retired this device')
          return { kind: 'blocked', title: zh('此设备已停用', 'This device was retired'), reason: zh('IT 管理员已停用这台设备或你的账号。', 'Your IT administrator retired this device or your account.') }
        }
        accept(state, 'server')
        return { kind: 'ready' }
      } catch (error) {
        if (!(error instanceof SessionError)) throw error
        if (error.kind === 'sign-in-required') continue
        if (error.kind === 'device-revoked') {
          await wipe('the server revoked this device')
          return { kind: 'blocked', title: zh('此设备已停用', 'This device was retired'), reason: zh('IT 管理员已停用这台设备或你的账号。', 'Your IT administrator retired this device or your account.') }
        }
        const cached = readCache()
        if (cached !== undefined && cached.source === 'server' && usableOffline(cached.state, cached.receivedAt, Date.now())) {
          wentOffline(error)
          return { kind: 'ready' }
        }
        return {
          kind: 'blocked',
          title: zh('无法连接企业服务', 'Cannot reach the organisation server'),
          reason: error.message + zh('。请检查网络后重试，或联系 IT 管理员。', '. Check the network and retry, or contact your IT administrator.'),
          personalAllowed,
        }
      }
    }
    return { kind: 'sign-in', ...gate }
  }

  /** The launcher request for a managed spawn, or undefined in personal mode. */
  function launchRequest(): string | undefined {
    if (!active() || (source.kind !== 'file' && source.kind !== 'server')) return undefined
    if (readCache() === undefined) return undefined
    const policyPluginPath = options.policyPluginPath()
    const request: ManagedBootRequest = { home: dshHome(), statePath, ...policyPluginPath !== undefined && { policyPluginPath } }
    return JSON.stringify(request)
  }

  async function report(state: DesiredState, result: 'applied' | 'partial' | 'failed'): Promise<void> {
    const current = serverSession()
    if (current === undefined) return
    const statusReport: StatusReport = {
      revision: state.revision,
      result,
      problems: knownProblems().slice(0, 20),
      clientVersion: options.clientVersion,
      appliedAt: new Date().toISOString(),
      ...options.dshVersion() !== undefined && { dshVersion: options.dshVersion() },
    }
    await current.reportStatus(statusReport).catch((error: unknown) => {
      options.log('[enterprise] status report failed: ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  /** Apply a document to the serving runtime's files, then its plugin packages. */
  async function applyLive(state: DesiredState): Promise<void> {
    const policyPluginPath = options.policyPluginPath()
    const result = applyDesiredState(state, { dshHome: dshHome(), ...policyPluginPath !== undefined && { policyPluginPath } })
    const pluginProblems = await runPluginSync(planPluginSync(state, dshHome()), options.runPluginCommand)
    problems = [...result.problems, ...pluginProblems]
    for (const problem of problems) options.log('[enterprise] ' + problem)
    await report(state, problems.length === 0 ? 'applied' : 'partial')
    await uploadDenials()
  }

  /**
   * Hand the policy plugin's refused calls to the organisation's audit log.
   * The file is moved aside first, so calls refused during the upload are kept
   * for the next one; a failed upload puts the batch back. File mode has no
   * server: only the newest records are kept, for the diagnostics bundle.
   */
  async function uploadDenials(): Promise<void> {
    const file = join(dshHome(), DENIAL_LOG_FILE)
    if (!existsSync(file)) return
    const current = serverSession()
    if (current === undefined) {
      try {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        if (lines.length > 500) writeFileSync(file, lines.slice(-200).join('\n') + '\n', { mode: 0o600 })
      } catch { /* diagnostics only */ }
      return
    }
    if (!current.isSignedIn()) return
    const sending = file + '.sending'
    try { renameSync(file, sending) } catch { return }
    const lines = readFileSync(sending, 'utf8').split('\n').filter(Boolean)
    const events: AuditEventInput[] = []
    for (const line of lines.slice(-500)) {
      try {
        const record = JSON.parse(line) as { at?: unknown; tool?: unknown }
        if (typeof record.tool === 'string') events.push({ at: typeof record.at === 'string' ? record.at : new Date().toISOString(), action: 'tool.denied', target: record.tool.slice(0, 120), detail: { tool: record.tool.slice(0, 120) } })
      } catch { /* a torn line */ }
    }
    try {
      for (let index = 0; index < events.length; index += 100) await current.sendAudit(events.slice(index, index + 100))
      rmSync(sending, { force: true })
    } catch (error) {
      options.log('[enterprise] denial upload failed: ' + (error instanceof Error ? error.message : String(error)))
      try { appendFileSync(file, readFileSync(sending, 'utf8'), { mode: 0o600 }); rmSync(sending, { force: true }) } catch { /* next time */ }
    }
  }

  /**
   * Before the runtime starts: install required plugins (and remove blocked
   * ones) with the bundled CLI, so they are there when the window opens. Only
   * when the profile already exists — on the very first start the runtime
   * creates it, and the same sync then runs once it is serving.
   */
  async function beforeLaunch(onProgress: (message: string) => void): Promise<void> {
    if (!active()) return
    const cached = readCache()
    if (cached === undefined || !existsSync(join(dshHome(), 'profiles', WEB_PROFILE, 'package.json'))) return
    const plan = planPluginSync(cached.state, dshHome())
    if (plan.install.length === 0 && plan.remove.length === 0) return
    onProgress(zh('正在安装组织要求的插件…', 'Installing plugins your organisation requires…'))
    const pluginProblems = await runPluginSync(plan, options.runPluginCommand)
    for (const problem of pluginProblems) options.log('[enterprise] ' + problem)
  }

  /** The runtime is serving: finish what the launcher cannot do, and report. */
  async function afterRuntimeReady(): Promise<void> {
    if (!active()) return
    const cached = readCache()
    if (cached === undefined) return
    await applyLive(cached.state)
  }

  /** Server mode: look for a newer document now and then. */
  function startPolling(onRetired: (readiness: Readiness) => void): void {
    if (source.kind !== 'server' || !active() || pollTimer !== undefined) return
    const tick = async (): Promise<void> => {
      const current = serverSession()
      if (current === undefined || !current.isSignedIn()) return
      try {
        const state = await current.fetchDesiredState()
        backOnline()
        lastCheckedAt = Date.now()
        if (state.wipe === true) {
          await wipe('the server retired this device')
          onRetired({ kind: 'blocked', title: zh('此设备已停用', 'This device was retired'), reason: zh('IT 管理员已停用这台设备或你的账号。', 'Your IT administrator retired this device or your account.') })
          return
        }
        if (accept(state, 'server')) await applyLive(state)
      } catch (error) {
        if (error instanceof SessionError && error.kind === 'device-revoked') {
          await wipe('the server revoked this device')
          onRetired({ kind: 'blocked', title: zh('此设备已停用', 'This device was retired'), reason: error.message })
        } else if (error instanceof SessionError && error.kind === 'sign-in-required') {
          onRetired({ kind: 'sign-in', organization: source.enrollment.organization.name, server: source.enrollment.server, personalAllowed, reason: error.message })
        } else {
          wentOffline(error)
          options.log('[enterprise] refresh failed: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
    pollTick = tick
    pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
    pollTimer.unref()
    void watchLoop(tick)
  }

  /**
   * Server push, as a long poll: the server answers as soon as the
   * organisation's configuration changes (or this device or person is
   * retired), and the client fetches at once. The five-minute timer above
   * stays as the fallback when the long poll cannot get through.
   */
  async function watchLoop(tick: () => Promise<void>): Promise<void> {
    let failures = 0
    while (!stopped) {
      const current = serverSession()
      const revision = readCache()?.state.revision
      if (current === undefined || !current.isSignedIn() || revision === undefined) {
        await new Promise(resolve => setTimeout(resolve, 30_000).unref())
        continue
      }
      try {
        const answer = await current.watch(revision)
        failures = 0
        // Either answer means the server was reached and the document is current.
        backOnline()
        lastCheckedAt = Date.now()
        if (answer.changed) await tick()
        else await uploadDenials()
      } catch (error) {
        failures += 1
        if (error instanceof SessionError && (error.kind === 'device-revoked' || error.kind === 'sign-in-required')) {
          await tick()
          return
        }
        // Older servers have no watch endpoint; back off and rely on the timer.
        await new Promise(resolve => setTimeout(resolve, Math.min(300_000, 15_000 * 2 ** Math.min(failures, 4))).unref())
      }
    }
  }

  /** Resume from sleep (and tests): run the poll now rather than within 5 minutes. */
  function checkNow(): Promise<void> {
    return pollTick?.() ?? Promise.resolve()
  }

  /** Enterprise mode fixes how the runtime is chosen and where its data lives. */
  function overlaySettings(settings: ClientSettings): ClientSettings {
    if (!active()) return settings
    const fixed: ClientSettings = { ...settings, connectionMode: 'smart', smartRuntimes: ['bundled'], dshDataMode: 'isolated' }
    Reflect.deleteProperty(fixed, 'serverUrl')
    return fixed
  }

  function status(): EnterpriseStatus {
    if (personalChosen) return { mode: 'personal', problems: [], ...personalOption() !== undefined && { available: personalOption() } }
    const cached = readCache()
    const organization = source.kind === 'server' ? source.enrollment.organization.name
      : source.kind === 'file' ? source.state.organization.name : undefined
    return {
      mode: source.kind,
      ...organization !== undefined && { organization },
      ...source.kind === 'file' && { signed: source.signed },
      ...session?.user()?.name !== undefined && { user: session.user()?.name },
      ...cached !== undefined && { revision: cached.state.revision, receivedAt: cached.receivedAt },
      offline: offlineReason !== undefined,
      problems: source.kind === 'invalid' ? [source.reason] : knownProblems(),
      ...source.kind === 'server' && { credentialProtection: options.secrets().encrypted ? 'os' : 'file-permissions' },
      ...lastCheckedAt !== undefined && { lastCheckedAt },
      ...source.kind === 'file' && { managedFile: join(source.dir, 'managed.json') },
      ...personalAllowed && { personalAllowed: true },
      ...cached?.state.updates !== undefined && { updates: {
        feedManaged: cached.state.updates.feedUrl !== undefined,
        ...cached.state.updates.autoCheck !== undefined && { autoCheck: cached.state.updates.autoCheck },
      } },
    }
  }

  /** Summary safe to hand to IT: names of things, never their values. */
  function diagnostics(): Record<string, unknown> {
    const cached = readCache()
    const state = cached?.state
    return {
      ...status(),
      managedDir: options.managedDir,
      dshHome: active() ? dshHome() : undefined,
      server: source.kind === 'server' ? source.enrollment.server : undefined,
      deviceId: session?.deviceId(),
      document: state === undefined ? undefined : {
        revision: state.revision,
        issuedAt: state.issuedAt,
        source: state.source,
        modelRoutes: Object.keys(state.models?.providers ?? {}),
        credentialNames: Object.keys(state.credentials ?? {}),
        pluginIndexes: state.plugins?.indexes,
        requiredPlugins: state.plugins?.required?.map(plugin => plugin.spec),
        blockedPlugins: state.plugins?.blocked,
        skills: state.skills?.map(skill => skill.name),
        deniedTools: state.tools?.deny,
      },
    }
  }

  /** The organisation's skill library as this person sees it (server mode, signed in). */
  async function companySkills(): Promise<CompanySkill[]> {
    const current = serverSession()
    if (!active() || current?.isSignedIn() !== true) throw new Error(zh('登录企业账号后才能查看公司 Skill', 'Sign in to your organisation to see company skills'))
    return current.listSkills()
  }

  /** Install or remove one optional skill, then apply the new document right away. */
  async function setCompanySkill(id: string, installed: boolean): Promise<CompanySkill[]> {
    const current = serverSession()
    if (!active() || current?.isSignedIn() !== true) throw new Error(zh('登录企业账号后才能安装公司 Skill', 'Sign in to your organisation to install company skills'))
    const skills = await current.setSkill(id, installed)
    await checkNow()
    return skills
  }

  async function signOut(): Promise<void> {
    if (source.kind !== 'server') return
    await wipe('the person signed out')
    session = undefined
  }

  function managedUpdates(): DesiredState['updates'] | undefined {
    return active() ? readCache()?.state.updates : undefined
  }

  /** The organisation's name when this machine lets the person opt out to personal mode. */
  function personalOption(): string | undefined {
    if (!personalAllowed) return undefined
    return source.kind === 'server' ? source.enrollment.organization.name : source.kind === 'file' ? source.state.organization.name : undefined
  }

  /**
   * Switch modes on an enrolled machine that allows it. The caller restarts:
   * which runtime, data home and policy apply is decided once at start-up.
   * The organisation's data home is left as it is, so coming back is quick.
   */
  async function choosePersonal(personal: boolean): Promise<boolean> {
    if (!personalAllowed) return false
    if (personal) {
      // Tell the console, so the device does not just look abandoned. Best effort.
      const current = serverSession()
      if (current?.isSignedIn() === true) {
        await Promise.race([
          current.sendAudit([{ at: new Date().toISOString(), action: 'mode.personal' }]).catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ])
      }
      mkdirSync(root, { recursive: true, mode: 0o700 })
      writeFileSync(personalChoicePath, JSON.stringify({ chosenAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    } else {
      rmSync(personalChoicePath, { force: true })
    }
    return true
  }

  return {
    source, active, dshHome, prepare, launchRequest, afterRuntimeReady, startPolling, checkNow,
    overlaySettings, status, diagnostics, signOut, companySkills, setCompanySkill, managedUpdates, personalOption, choosePersonal, beforeLaunch,
    stop: () => { stopped = true; if (pollTimer !== undefined) clearInterval(pollTimer) },
  }
}

export type EnterpriseController = ReturnType<typeof createEnterpriseController>
