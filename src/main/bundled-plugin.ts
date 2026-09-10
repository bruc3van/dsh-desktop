/**
 * Offline, client-owned market copy for the web profile. User dependencies
 * and profile-local installs remain owned by their package manager. Only a
 * managed launch may edit the profile; adopting a server is read-only.
 * The packaged market lives outside the DSH installation so its bundle patch
 * and Loader entry resolve from the same profile package.
 * @module dsh-desktop/bundled-plugin
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import satisfies from 'semver/functions/satisfies.js'

/** The plugin this client ships. */
export const BUNDLED_PLUGIN_NAME = 'dsh-desktop-safe-market'

/** The profile the web GUI boots. */
export const WEB_PROFILE = 'web'

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Evidence supplied by the managed launcher, never inferred from a live URL. */
export interface SeatRuntime {
  readonly version?: string
  readonly builtAgainst?: string
  readonly peerRanges?: readonly string[]
  readonly serving?: boolean
  /** Each actual peer package was verified by the managed launcher. */
  readonly peersVerified?: boolean
}

export function runtimeRefusal(runtime: SeatRuntime): string | undefined {
  if (runtime.serving === true) return 'an adopted runtime is read-only'
  if (runtime.peersVerified === true) return undefined
  if (runtime.version === undefined) return 'the version of the runtime about to serve is unknown'
  const version = runtime.version
  const ranges = runtime.peerRanges ?? (runtime.builtAgainst === undefined ? [] : ['^' + runtime.builtAgainst])
  if (ranges.length === 0) return 'the bundled plugin compatibility range is unknown'
  if (!ranges.every(range => satisfies(version, range))) {
    return 'the runtime ' + runtime.version + ' does not satisfy the bundled plugin peer ranges: ' + ranges.join(', ')
  }
  return undefined
}

export interface SeatResult {
  /** The plugin is offered to the profile (this call, or an earlier one). */
  seated: boolean
  /** This call added the bundle entry, so this boot is the first to load it. */
  added: boolean
  /** True only for the copy this client owns, never a user dependency. */
  owned?: boolean
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
 * Client-owned copies belong to web only. Legacy shared copies are migrated
 * without deleting a copy another profile still references.
 */
function seatPath(dshHome: string): string {
  return join(profileDir(dshHome), 'node_modules', BUNDLED_PLUGIN_NAME)
}

function legacySeatPath(dshHome: string): string {
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
  writeFileSync(tmp, JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
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

/** A declaration or a nearer installed package is never ours to replace. */
function userOwned(manifest: ProfileManifest, dshHome: string): boolean {
  try {
    if (lstatSync(seatPath(dshHome)).isSymbolicLink()) return true
  } catch { /* no local installation */ }
  return Object.hasOwn(manifest.dependencies ?? {}, BUNDLED_PLUGIN_NAME)
    || (existsSync(join(seatPath(dshHome), 'package.json')) && readSeatMarker(seatPath(dshHome)) === undefined)
}

/** Inspect an existing seat without changing a running server's profile. */
export function inspectBundledPlugin(dshHome: string): SeatResult {
  const manifest = readManifest(dshHome)
  const listed = manifest?.dsh?.profile?.bundles?.includes(BUNDLED_PLUGIN_NAME) === true
  const owned = manifest !== undefined && !userOwned(manifest, dshHome)
    && (readSeatMarker(seatPath(dshHome)) !== undefined || readSeatMarker(legacySeatPath(dshHome)) !== undefined)
  return { seated: listed, added: false, owned: listed && owned }
}

/**
 * Apply one mutation to the profile manifest, against a FRESH read.
 *
 * The profile is shared with the user's own `dsh` CLI — `dsh plugin add`
 * writes the same file — while this client's seat work reads the document,
 * spends real time (a whole-tree copy), and only then writes it back. A
 * concurrent add landing in that gap must survive: the write re-reads the
 * document and applies only this mutation to the fresh copy, so whatever the
 * CLI added in the meantime is preserved.
 * @returns whether the document changed.
 */
function commitProfileManifest(dshHome: string, mutate: (fresh: ProfileManifest) => boolean): boolean {
  const fresh = readManifest(dshHome) ?? {}
  if (!mutate(fresh)) return false
  writeManifest(dshHome, fresh)
  return true
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
    // Only a legacy link to this exact payload is demonstrably ours.
    if (existing.isSymbolicLink() && realpathSync(seat) !== realpathSync(pluginDir)) {
      throw new Error(seat + ' is a foreign link')
    }
    if (!existing.isSymbolicLink()) {
      const marker = readSeatMarker(seat)
      // A directory with no marker of ours belongs to something else. Leave
      // it — and do not report the seat as ready, or `loadProfile` will load
      // whatever that tree is under this plugin's name.
      if (marker === undefined) throw new Error(seat + ' exists and was not created by this client')
      // The version alone is not proof the copy is intact: a marker survives
      // a tree something else emptied. One stat is cheap next to a re-copy.
      if (marker.version === version && readPackageVersion(seat) === version) return
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
    if (!name.startsWith(prefix) || !/^\d+\.(tmp|old)$/.test(name.slice(prefix.length))) continue
    try {
      rmSync(join(parent, name), { recursive: true, force: true })
    } catch {
      // A tree something else is holding stays for the next sweep. Failing
      // the seat over someone else's file handle would be the wrong trade.
    }
  }
}

/** Remove the seat this client owns: its copy, or the link older ones left. */
function removeOwnedSeat(dshHome: string, seat = seatPath(dshHome)): void {
  try {
    if (lstatSync(seat).isSymbolicLink()) {
      // Without the payload anchor, a legacy link cannot be proved ours.
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

function isKnownLegacyLink(dshHome: string, pluginDir?: string): boolean {
  if (pluginDir === undefined) return false
  try {
    const legacy = legacySeatPath(dshHome)
    return lstatSync(legacy).isSymbolicLink() && realpathSync(legacy) === realpathSync(pluginDir)
  } catch { return false }
}

/** Legacy shared copies may be used by another profile; retain them in that case. */
function removeUnusedLegacySeat(dshHome: string, pluginDir?: string): void {
  const profiles = join(dshHome, 'profiles')
  if (!existsSync(profiles)) return
  let names: string[]
  try { names = readdirSync(profiles) } catch { return }
  for (const name of names) {
    if (name === WEB_PROFILE || name === 'node_modules') continue
    const manifest = join(profiles, name, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const other = JSON.parse(readFileSync(manifest, 'utf8')) as ProfileManifest
      if (other.dsh?.profile?.bundles?.includes(BUNDLED_PLUGIN_NAME)
        || Object.hasOwn(other.dependencies ?? {}, BUNDLED_PLUGIN_NAME)) return
    } catch { return }
  }
  const legacy = legacySeatPath(dshHome)
  try {
    if (lstatSync(legacy).isSymbolicLink()) {
      // A dead or foreign link is not ownership evidence. Unlink only a known payload.
      if (isKnownLegacyLink(dshHome, pluginDir)) rmSync(legacy)
      return
    }
  } catch { return }
  removeOwnedSeat(dshHome, legacy)
}

/** Only retire fallback when a complete independent user package takes its place. */
function removeLegacySeatAfterUserInstall(dshHome: string, pluginDir?: string): void {
  try {
    const local = realpathSync(seatPath(dshHome))
    let shared: string | undefined
    try { shared = realpathSync(legacySeatPath(dshHome)) } catch { /* absent */ }
    if (existsSync(join(local, 'package.json')) && local !== shared) removeUnusedLegacySeat(dshHome, pluginDir)
  } catch { /* incomplete user install: preserve fallback */ }
}

/**
 * Offer the bundled plugin to the profile.
 * @param pluginDir - the plugin's directory inside this client's runtime closure.
 * @param dshHome - the harness home whose `web` profile is being booted.
 * @returns whether the seat is in place, and whether this call created it.
 */
export function seatBundledPlugin(pluginDir: string, dshHome: string, runtime: SeatRuntime): SeatResult {
  if (runtime.serving === true) return inspectBundledPlugin(dshHome)
  const manifest = readManifest(dshHome)
  if (manifest === undefined) return { seated: false, added: false, error: 'the web profile does not exist yet' }
  if (userOwned(manifest, dshHome)) {
    removeLegacySeatAfterUserInstall(dshHome, pluginDir)
    return inspectBundledPlugin(dshHome)
  }
  const version = readPackageVersion(pluginDir)
  if (version === undefined) {
    abandonBundledPlugin(dshHome)
    return { seated: false, added: false, error: 'the runtime closure carries no readable bundled plugin' }
  }
  const refusal = runtimeRefusal(runtime)
  if (refusal !== undefined) {
    withdrawBundledPlugin(dshHome)
    return { seated: false, added: false, error: refusal }
  }
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) {
    return { seated: false, added: false, error: 'the web profile declares no bundle list' }
  }
  try {
    ensureSeatCopy(dshHome, pluginDir, version)
    const added = commitProfileManifest(dshHome, fresh => {
      // A package-manager install that arrived during the copy keeps ownership.
      if (userOwned(fresh, dshHome)) return false
      const list = fresh.dsh?.profile?.bundles
      if (!Array.isArray(list) || list.includes(BUNDLED_PLUGIN_NAME)) return false
      list.push(BUNDLED_PLUGIN_NAME)
      return true
    })
    const result = inspectBundledPlugin(dshHome)
    if (result.owned) removeUnusedLegacySeat(dshHome, pluginDir)
    return { ...result, added }
  } catch (error) {
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
export function withdrawBundledPlugin(dshHome: string, pluginDir?: string): boolean {
  const manifest = readManifest(dshHome)
  if (manifest === undefined || userOwned(manifest, dshHome)) return false
  if (readSeatMarker(seatPath(dshHome)) === undefined && readSeatMarker(legacySeatPath(dshHome)) === undefined && !isKnownLegacyLink(dshHome, pluginDir)) return false
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) return false
  try {
    return commitProfileManifest(dshHome, (fresh) => {
      // Re-checked on the fresh read: the user may have installed their own
      // copy between the two reads, and that copy is never withdrawn.
      if (userOwned(fresh, dshHome)) return false
      const bundles = fresh.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) return false
      const next = bundles.filter(entry => entry !== BUNDLED_PLUGIN_NAME)
      if (next.length === bundles.length) return false
      const profile = fresh.dsh?.profile
      if (profile === undefined) return false
      profile.bundles = next
      return true
    })
  } catch {
    return false
  }
}

/**
 * Drop the bundle entry and this client's fallback link. Used when the
 * closure no longer carries the plugin, so a leftover name cannot take
 * down every consumer of the shared profile.
 */
export function abandonBundledPlugin(dshHome: string, pluginDir?: string): boolean {
  const withdrawn = withdrawBundledPlugin(dshHome, pluginDir)
  const manifest = readManifest(dshHome)
  if (manifest !== undefined && userOwned(manifest, dshHome)) {
    removeLegacySeatAfterUserInstall(dshHome, pluginDir)
    return withdrawn
  }
  removeOwnedSeat(dshHome)
  removeUnusedLegacySeat(dshHome, pluginDir)
  return withdrawn
}
