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
 *  1. a copy of the package where the profile's module resolution reaches it.
 *     Loader entries are imported from the profile directory, and the
 *     installation's own packages reach it through
 *     `<DSH_HOME>/profiles/node_modules`, which the harness heals on every
 *     boot by symlinking the SERVING installation's dependency graph there.
 *     That healing only ever ADDS entries, so one more, owned by this client,
 *     survives alongside them.
 *  2. the package name in the profile's `dsh.profile.bundles`.
 *
 * Both are reversible in one step, which is what makes the seat safe to take
 * automatically: a plugin that throws while loading fails the WHOLE plugin
 * tree, so the client must be able to give the seat back (see `withdraw`).
 * A missing closure copy drops the entry (and the copy) rather than leaving a
 * name official `loadProfile` will throw on. A user-installed overlay that
 * is older than the closure is lifted: the dependency and the nearer
 * profile install go away so the in-box seat is what loads; a newer or
 * equal overlay is left entirely alone.
 *
 * A COPY rather than a link, and that is what opens the seat to runtimes
 * other than this client's own. Node resolves a package's imports from its
 * realpath, so a link into the closure made the plugin's live
 * `@deepseek-ai/*` imports resolve INSIDE the closure — handing whichever
 * runtime was serving a second copy of the Service classes it already ran,
 * which is why the seat used to be refused to every runtime but the bundled
 * one. A real directory resolves upward instead, through the graph the
 * harness heals for the installation that is actually serving. Every runtime
 * this client STARTS is therefore a candidate, gated on version alone (see
 * `runtimeRefusal`); runtimes it did not start are released by the caller.
 * @module dsh-desktop/bundled-plugin
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** Which dsh is about to serve the profile, as far as the client knows it. */
export interface SeatRuntime {
  /**
   * The version of the runtime that will serve. `undefined` when this client
   * could not read one — an override command, say — which is refused rather
   * than guessed: the whole point of the gate is not to seat into a runtime
   * whose shape is unknown.
   */
  readonly version?: string
  /**
   * The dsh version this client ships, and therefore the one the bundled
   * plugin was built and tested against. `undefined` disables the gate, for
   * a build carrying no runtime of its own to compare with.
   */
  readonly builtAgainst?: string
}

/**
 * Why this runtime does not get the seat, or `undefined` when it does.
 *
 * The seat used to be refused to every runtime but this client's own, for a
 * real reason: a symlinked plugin resolved its imports inside the closure and
 * handed the serving runtime a second copy of the Service classes. A copied
 * plugin resolves them from the serving installation instead, so that reason
 * is gone and the market can run anywhere — which leaves a different question
 * to answer, this one.
 *
 * The plugin is built against the runtime this client ships. An OLDER runtime
 * may not export what it imports, and a module missing at import time fails
 * the whole plugin tree, not just the market. The plugin guards itself now
 * (its entry reaches the body through a guarded dynamic import), but this
 * client should not knowingly walk into it: the guard is for the case nobody
 * is watching, not a licence to stop looking.
 *
 * Newer runtimes are allowed. Refusing them would freeze the market out of
 * every future dsh, and "newer than what we tested" is the ordinary condition
 * of a plugin, not a fault.
 */
export function runtimeRefusal(runtime: SeatRuntime): string | undefined {
  if (runtime.builtAgainst === undefined) return undefined
  if (runtime.version === undefined) return 'the version of the runtime about to serve is unknown'
  const order = compareVersions(runtime.version, runtime.builtAgainst)
  if (order === undefined) {
    return 'the runtime version ' + runtime.version + ' cannot be compared with the bundled ' + runtime.builtAgainst
  }
  if (order < 0) {
    return 'the runtime is dsh ' + runtime.version + ', older than the bundled ' + runtime.builtAgainst
      + ' the plugin is built against'
  }
  return undefined
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

/**
 * Where the client puts its copy of the plugin: the module directory the
 * harness heals for every profile, one level above any single profile's own
 * `node_modules`. A user's own `dsh plugin add` install lands nearer and
 * therefore still wins.
 */
function seatPath(dshHome: string): string {
  return join(dshHome, 'profiles', 'node_modules', BUNDLED_PLUGIN_NAME)
}

/**
 * Marks a seat directory as this client's, and records what is in it.
 *
 * Ownership has to be written down now that the seat is a real directory: a
 * symlink was self-evidently ours to replace, a directory is not, and
 * deleting a tree this client did not create is the one thing the seat must
 * never do. The version is what makes an upgrade cheap — same version, no
 * copy.
 */
const SEAT_MARKER = '.dsh-desktop-seat.json'

interface SeatMarker {
  owner?: unknown
  version?: unknown
}

/** The marker's owner tag; anything else in that file is not ours. */
const SEAT_OWNER = 'dsh-desktop'

function readSeatMarker(dir: string): SeatMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SEAT_MARKER), 'utf8')) as SeatMarker | null
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed.owner === SEAT_OWNER ? parsed : undefined
  } catch {
    return undefined
  }
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
  return comparePrerelease(a.pre, b.pre)
}

/**
 * Order two prerelease tags by semver's rule, not by string order.
 *
 * The distinction is not academic here: dsh ships an `rc` sequence, and a
 * plain string comparison puts `rc.10` BEFORE `rc.6` — every release past
 * rc.9 would read as older than the one this client bundles. Two things then
 * go wrong at once. The version gate refuses every newer runtime, freezing
 * the market out of exactly the future versions the gate was written to
 * admit; and `overlayOlderThanClosure` calls the same comparison, so a copy
 * the user installed themselves at `rc.10` looks stale next to a bundled
 * `rc.6` — which does not merely skip the seat, it takes the user's NEWER
 * install away (`liftStaleOverlay` drops the dependency and deletes the tree).
 *
 * Semver §11: compare dot-separated identifiers; numeric ones numerically,
 * numeric sorts below alphanumeric, and when one list runs out first the
 * shorter one is the lower.
 */
function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
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
 * Put this client's copy of the plugin where the profile resolves modules,
 * replacing an out-of-date copy and the symlink older clients left.
 *
 * A COPY, not a link, and that is the whole mechanism that lets the market
 * run on runtimes other than this client's own. Node resolves a package's
 * imports from its realpath, so a link into the client's closure made the
 * plugin's `@deepseek-ai/*` imports resolve INSIDE that closure — handing
 * whichever runtime was serving a second copy of the Service classes it
 * already ran. A real directory here resolves upward through
 * `profiles/node_modules`, which the harness heals on every boot with the
 * dependency graph of the installation that is actually serving. That is
 * exactly how a plugin installed by `dsh plugin add` resolves, so the market
 * stops being a special case.
 *
 * The copy is staged beside its destination and renamed into place: a boot
 * that catches this client mid-write must never find a half-written package
 * behind a name the profile lists.
 */
function ensureSeatCopy(dshHome: string, pluginDir: string, version: string): void {
  const seat = seatPath(dshHome)
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(seat)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    // A link is either this client's own from a version that seated one, or
    // something pointing at the closure; both are ours to replace.
    if (!existing.isSymbolicLink()) {
      const marker = readSeatMarker(seat)
      // A directory with no marker of ours belongs to something else. Leave
      // it — and do not report the seat as ready, or `loadProfile` will load
      // whatever that tree is under this plugin's name.
      if (marker === undefined) throw new Error(seat + ' exists and was not created by this client')
      // The version alone is not proof the copy is intact: a marker survives
      // a tree something else emptied. One stat is cheap next to a re-copy.
      if (marker.version === version && existsSync(join(seat, 'package.json'))) return
    }
  }
  const staging = seat + '.' + String(process.pid) + '.tmp'
  mkdirSync(dirname(seat), { recursive: true })
  // A crash between the copy and the rename leaves a whole plugin tree
  // behind, under a pid that will never come back to collect it. Sweep them
  // first: this is the only code that writes these names.
  sweepStagingDirs(seat)
  // `dereference` because the closure is pnpm-shaped in a source checkout:
  // the copy must carry files, not links back into a store this profile has
  // no reason to know about.
  cpSync(pluginDir, staging, { recursive: true, dereference: true })
  writeFileSync(join(staging, SEAT_MARKER), JSON.stringify({ owner: SEAT_OWNER, version }, undefined, 2) + '\n')
  // Keep the window where the seat name is empty as small as it can be.
  // `dsh.profile.bundles` lists this package, and a boot landing while the
  // name resolves to nothing fails `loadProfile` for everyone sharing the
  // profile — so the old copy is renamed aside rather than deleted, and both
  // renames land on a free name.
  //
  // Not atomic, and POSIX gives no way to make it so: `rename` onto a
  // non-empty directory fails, so the swap cannot be one call. A crash landing
  // BETWEEN the two renames does leave the name empty; what bounds it is that
  // the gap is two adjacent synchronous calls, and that the next client start
  // copies the seat again from scratch (a missing seat reads as "no existing
  // copy"), with `sweepStagingDirs` clearing what was left behind.
  const retired = existing === undefined ? undefined : seat + '.' + String(process.pid) + '.old'
  try {
    if (retired !== undefined) {
      rmSync(retired, { recursive: true, force: true })
      renameSync(seat, retired)
    }
    renameSync(staging, seat)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    // Put the old seat back rather than leaving the name empty.
    if (retired !== undefined && existsSync(retired) && !existsSync(seat)) renameSync(retired, seat)
    throw error
  }
  // The new copy is already in place; failing to delete the retired one is
  // litter, not a failed seat. Throwing here would reach `seatBundledPlugin`'s
  // catch and withdraw an entry whose package is sitting right there.
  if (retired !== undefined) {
    try {
      rmSync(retired, { recursive: true, force: true })
    } catch {
      // Swept on the next copy; `sweepStagingDirs` knows this name.
    }
  }
}

/** Remove staging and retired seat trees any earlier run left behind. */
function sweepStagingDirs(seat: string): void {
  const parent = dirname(seat)
  const prefix = BUNDLED_PLUGIN_NAME + '.'
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    if (!name.endsWith('.tmp') && !name.endsWith('.old')) continue
    try {
      rmSync(join(parent, name), { recursive: true, force: true })
    } catch {
      // A tree something else is holding stays for the next sweep. Failing
      // the seat over someone else's file handle would be the wrong trade.
    }
  }
}

/** Remove the seat this client owns: its copy, or the link older ones left. */
function removeOwnedSeat(dshHome: string): void {
  const seat = seatPath(dshHome)
  try {
    if (lstatSync(seat).isSymbolicLink()) {
      rmSync(seat, { force: true })
      return
    }
  } catch {
    return
  }
  if (readSeatMarker(seat) === undefined) return
  // Best-effort, and that is a deliberate downgrade from "must succeed".
  // Removing a whole tree is a failure surface the symlink era did not have:
  // on Windows an antivirus scan, the indexer, or a child that just read the
  // package can hold a handle and make this throw EBUSY/EPERM (`force` only
  // swallows ENOENT). The safety goal is already met by the caller taking the
  // name out of `bundles` — nothing loads the tree once it is unlisted — so a
  // stuck directory is litter, and litter must not propagate into a spawn
  // path that has no catch above it.
  try {
    rmSync(seat, { recursive: true, force: true })
  } catch (error) {
    console.warn('[desktop] could not remove the bundled plugin copy at ' + seat + ':',
      error instanceof Error ? error.message : String(error))
  }
}

/**
 * Offer the bundled plugin to the profile.
 * @param pluginDir - the plugin's directory inside this client's runtime closure.
 * @param dshHome - the harness home whose `web` profile is being booted.
 * @returns whether the seat is in place, and whether this call created it.
 */
export function seatBundledPlugin(pluginDir: string, dshHome: string, runtime: SeatRuntime): SeatResult {
  if (!existsSync(join(pluginDir, 'package.json'))) {
    abandonBundledPlugin(dshHome)
    return { seated: false, added: false, error: 'the runtime closure carries no bundled plugin' }
  }
  const version = readPackageVersion(pluginDir)
  if (version === undefined) {
    abandonBundledPlugin(dshHome)
    return { seated: false, added: false, error: 'the bundled plugin declares no version' }
  }
  const manifest = readManifest(dshHome)
  // A first-ever run has no profile until the harness creates one during
  // boot. Nothing is broken; the seat is taken on the next start.
  if (manifest === undefined) return { seated: false, added: false, error: 'the web profile does not exist yet' }
  // Ahead of the version gate on purpose. When the user owns a copy this
  // client is not going to touch it either way, and the gate's answer would
  // be a statement about a seat nobody is taking — reported by the caller as
  // "not seated: the runtime is older than…", which reads as the market
  // being unavailable when it is in fact loading from the user's own install.
  if (userOwned(manifest) && !overlayOlderThanClosure(dshHome, pluginDir)) {
    return { seated: true, added: false }
  }
  const refusal = runtimeRefusal(runtime)
  if (refusal !== undefined) {
    // Not a failure and not an error: this runtime is simply outside what
    // this client vouches for. The entry goes, the copy stays — the next
    // boot on a runtime we do know re-seats without copying anything.
    withdrawBundledPlugin(dshHome)
    return { seated: false, added: false, error: refusal }
  }

  try {
    // The copy must be in place before a stale overlay is taken away: a
    // foreign directory at the seat path cannot be replaced, and the user's
    // older copy is then still the one that loads.
    ensureSeatCopy(dshHome, pluginDir, version)
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
 * plugin. The copy is left in place — re-seating is then one array entry
 * again, with nothing to copy.
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
  removeOwnedSeat(dshHome)
  return withdrawn
}
