/**
 * The bundled plugin seat: how the client's own runtime closure offers a
 * plugin to the profile it boots, the way the official in-box bundles do.
 *
 * `dsh.profile.bundles` entries are resolved from the dsh INSTALLATION first
 * and the profile second, and `dsh plugin` never touches a name that is not a
 * profile dependency ("in-box bundles from the profile template are not
 * dependencies and are never touched"). So a plugin shipped inside this
 * client's runtime closure needs no install, no lockfile, and no network — it
 * needs two things:
 *
 *  1. a link the profile's module resolution can see. Loader entries are
 *     imported from the profile directory, and the installation's own packages
 *     reach it through `<DSH_HOME>/profiles/node_modules`, which the harness
 *     heals on every boot by symlinking its dependency graph there. That
 *     healing only ever ADDS links, so one more link, owned by this client,
 *     survives alongside it.
 *  2. the package name in the profile's `dsh.profile.bundles`.
 *
 * Both are reversible in one step, which is what makes the seat safe to take
 * automatically: a plugin that throws while loading fails the WHOLE plugin
 * tree, so the client must be able to give the seat back (see `withdraw`).
 * A missing closure copy drops the entry (and the link) rather than leaving a
 * name official `loadProfile` will throw on. A user-installed overlay that
 * is older than the closure is lifted: the dependency and the nearer
 * profile install go away so the in-box seat is what loads; a newer or
 * equal overlay is left entirely alone.
 *
 * The seat is taken only for the client's OWN bundled runtime. The plugin's
 * live `@deepseek-ai/*` imports resolve upward from wherever it sits — inside
 * this closure — so loading it into a dsh the user installed themselves would
 * hand that runtime a second copy of the Service classes it is already using.
 * @module dsh-desktop/bundled-plugin
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** The plugin this client ships. */
export const BUNDLED_PLUGIN_NAME = 'dsh-desktop-safe-market'

/** The profile the web GUI boots. */
export const WEB_PROFILE = 'web'

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export interface SeatResult {
  /** The plugin is offered to the profile (this call, or an earlier one). */
  seated: boolean
  /** This call added the bundle entry, so this boot is the first to load it. */
  added: boolean
  /**
   * This call replaced a user-installed overlay that was older than the
   * closure copy. The dependency and the nearer profile install are gone;
   * the in-box seat is what loads.
   */
  lifted?: boolean
  /** Why the seat could not be taken, when it could not. */
  error?: string
}

function profileDir(dshHome: string): string {
  return join(dshHome, 'profiles', WEB_PROFILE)
}

function manifestPath(dshHome: string): string {
  return join(profileDir(dshHome), 'package.json')
}

function linkPath(dshHome: string): string {
  return join(dshHome, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
}

function readManifest(dshHome: string): ProfileManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(dshHome), 'utf8')) as ProfileManifest | null
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    // No profile yet (a first-ever run creates it during boot), or an
    // unreadable one. Either way this client has nothing to edit.
    return undefined
  }
}

/** Same 2-space + trailing newline shape the harness writes profiles back in. */
function writeManifest(dshHome: string, manifest: ProfileManifest): void {
  const dest = manifestPath(dshHome)
  // The profile is shared with the user's own `dsh` CLI. A same-directory
  // rename keeps a torn JSON off the next `loadProfile` if we crash mid-write.
  const tmp = dest + '.' + String(process.pid) + '.tmp'
  writeFileSync(tmp, JSON.stringify(manifest, undefined, 2) + '\n')
  try {
    renameSync(tmp, dest)
  } catch {
    try {
      rmSync(dest, { force: true })
      renameSync(tmp, dest)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  }
}

/**
 * Whether the user installed this plugin themselves. A copy that is newer
 * than or equal to the closure is theirs to upgrade or remove — the client
 * stays out. An older overlay is a stale floor and is lifted on seat.
 */
function userOwned(manifest: ProfileManifest): boolean {
  return Object.hasOwn(manifest.dependencies ?? {}, BUNDLED_PLUGIN_NAME)
}

function readPackageVersion(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown } | null
    return parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string'
      ? parsed.version
      : undefined
  } catch {
    return undefined
  }
}

/** Core `x.y.z` plus optional prerelease; build metadata is ignored. */
function parseVersion(raw: string): { core: [number, number, number]; pre: string } | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const plus = trimmed.indexOf('+')
  const withoutBuild = plus === -1 ? trimmed : trimmed.slice(0, plus)
  const dash = withoutBuild.indexOf('-')
  const corePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1)
  const bits = corePart.split('.')
  if (bits.length < 1 || bits.length > 3) return undefined
  const core: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i]
    if (bit === undefined || !/^\d+$/.test(bit)) return undefined
    core[i] = Number(bit)
  }
  return { core, pre }
}

/**
 * Semver-ish order: `undefined` when either side is not a version this seat
 * will compare (so the caller can treat an unreadable overlay as stale).
 */
function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (let i = 0; i < 3; i++) {
    const left = a.core[i]
    const right = b.core[i]
    if (left === undefined || right === undefined) return undefined
    if (left !== right) return left - right
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    const a = resolve(left)
    const b = resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
}

/** The user's installed copy, resolved the way the profile itself would. */
function overlayDir(dshHome: string): string | undefined {
  const anchor = manifestPath(dshHome)
  try {
    return dirname(createRequire(anchor).resolve(BUNDLED_PLUGIN_NAME + '/package.json'))
  } catch {
    const candidate = join(profileDir(dshHome), 'node_modules', BUNDLED_PLUGIN_NAME)
    return existsSync(join(candidate, 'package.json')) ? candidate : undefined
  }
}

function profileInstallPath(dshHome: string): string {
  return join(profileDir(dshHome), 'node_modules', BUNDLED_PLUGIN_NAME)
}

/**
 * An overlay yields to the closure when it is older, missing, or unreadable.
 * A newer or equal overlay, or an overlay that *is* the closure, keeps
 * ownership. The closure's own version must be readable or we do not lift.
 */
function overlayOlderThanClosure(dshHome: string, pluginDir: string): boolean {
  const bundled = readPackageVersion(pluginDir)
  if (bundled === undefined) return false
  const overlay = overlayDir(dshHome)
  if (overlay === undefined) return true
  if (sameDirectory(overlay, pluginDir)) return false
  const theirs = readPackageVersion(overlay)
  if (theirs === undefined) return true
  const order = compareVersions(theirs, bundled)
  return order === undefined || order < 0
}

/** Drop the stale overlay's dependency and its nearer profile install. */
function liftStaleOverlay(dshHome: string, manifest: ProfileManifest): void {
  if (manifest.dependencies !== undefined) {
    manifest.dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([name]) => name !== BUNDLED_PLUGIN_NAME),
    )
  }
  writeManifest(dshHome, manifest)
  rmSync(profileInstallPath(dshHome), { recursive: true, force: true })
}

/**
 * Whether an existing symlink already points at the closure directory.
 * Junctions and some volume mounts report a trailing separator or a
 * different drive-letter case than the path this process just joined;
 * treating those as a miss would unlink and recreate the seat every boot.
 */
function sameDirectoryLink(link: string, wanted: string): boolean {
  let current: string
  try {
    current = readlinkSync(link)
  } catch {
    return false
  }
  const a = resolve(dirname(link), current)
  const b = resolve(wanted)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Point the profile's module fallback at the closure copy, repairing a stale link. */
function ensureLink(dshHome: string, pluginDir: string): void {
  const link = linkPath(dshHome)
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    // A real directory here belongs to something else; leave it alone rather
    // than deleting a tree this client did not create — and do not pretend
    // the seat is ready, or `loadProfile` will load (or die on) that tree.
    if (!existing.isSymbolicLink()) throw new Error(link + ' exists and is not a symlink')
    if (sameDirectoryLink(link, pluginDir)) return
  }
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true })
  // Windows needs a junction for an unprivileged directory link.
  symlinkSync(pluginDir, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function removeOwnedLink(dshHome: string): void {
  const link = linkPath(dshHome)
  try {
    if (lstatSync(link).isSymbolicLink()) rmSync(link, { force: true })
  } catch {
    // Nothing to remove, or a real directory this client did not create.
  }
}

/**
 * Offer the bundled plugin to the profile.
 * @param pluginDir - the plugin's directory inside this client's runtime closure.
 * @param dshHome - the harness home whose `web` profile is being booted.
 * @returns whether the seat is in place, and whether this call created it.
 */
export function seatBundledPlugin(pluginDir: string, dshHome: string): SeatResult {
  if (!existsSync(join(pluginDir, 'package.json'))) {
    abandonBundledPlugin(dshHome)
    return { seated: false, added: false, error: 'the runtime closure carries no bundled plugin' }
  }
  const manifest = readManifest(dshHome)
  // A first-ever run has no profile until the harness creates one during
  // boot. Nothing is broken; the seat is taken on the next start.
  if (manifest === undefined) return { seated: false, added: false, error: 'the web profile does not exist yet' }
  if (userOwned(manifest) && !overlayOlderThanClosure(dshHome, pluginDir)) {
    return { seated: true, added: false }
  }

  try {
    // The fallback link must be in place before a stale overlay is taken
    // away: a foreign real directory at the link path cannot be replaced,
    // and the user's older copy is then still the one that loads.
    ensureLink(dshHome, pluginDir)
    let lifted = false
    if (userOwned(manifest)) {
      liftStaleOverlay(dshHome, manifest)
      lifted = true
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) {
      return { seated: false, added: false, lifted, error: 'the web profile declares no bundle list' }
    }
    if (bundles.includes(BUNDLED_PLUGIN_NAME)) return { seated: true, added: false, lifted }
    bundles.push(BUNDLED_PLUGIN_NAME)
    writeManifest(dshHome, manifest)
    return { seated: true, added: true, lifted }
  } catch (error) {
    // The name must not stay listed if this client cannot actually offer the
    // package — official `loadProfile` throws on an unresolvable bundle.
    withdrawBundledPlugin(dshHome)
    return { seated: false, added: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Give the seat back: drop the bundle entry so the profile stops loading the
 * plugin. The link is left in place — it costs nothing and re-seating is then
 * one array entry again.
 *
 * A copy the user installed themselves is never withdrawn.
 * @param dshHome - the harness home whose `web` profile is being booted.
 * @returns whether an entry was removed.
 */
export function withdrawBundledPlugin(dshHome: string): boolean {
  const manifest = readManifest(dshHome)
  if (manifest === undefined || userOwned(manifest)) return false
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return false
  const next = bundles.filter(entry => entry !== BUNDLED_PLUGIN_NAME)
  if (next.length === bundles.length) return false
  if (manifest.dsh?.profile !== undefined) manifest.dsh.profile.bundles = next
  try {
    writeManifest(dshHome, manifest)
    return true
  } catch {
    return false
  }
}

/**
 * Drop the bundle entry and this client's fallback link. Used when the
 * closure no longer carries the plugin, so a leftover name cannot take
 * down every consumer of the shared profile.
 */
export function abandonBundledPlugin(dshHome: string): boolean {
  const withdrawn = withdrawBundledPlugin(dshHome)
  removeOwnedLink(dshHome)
  return withdrawn
}
