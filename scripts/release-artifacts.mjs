/**
 * The one place that knows what a release ships and what each file is called.
 *
 * This convention used to be written four times — electron-builder.yml's
 * `artifactName`, the update feed's filename regex, the GitHub Release download
 * table, and check:updater's fixtures — with nothing tying them together. Only
 * a *total* rename was caught (the feed throws when it matches nothing); a
 * partial drift published a release whose download table named files that do
 * not exist and whose latest.json silently dropped a platform. A dropped
 * platform is invisible to the people it affects: the updater treats a missing
 * key as "up to date" rather than as an error, so those users simply stop being
 * offered updates.
 *
 * electron-builder remains the thing that actually names the files; this module
 * mirrors that template and `check:release-artifacts` asserts the two agree.
 *
 * @module desktop/scripts/release-artifacts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Mirrors electron-builder.yml `artifactName`; asserted equal by the check below. */
export const ARTIFACT_NAME_TEMPLATE = 'dsh-desktop-${version}-${os}-${arch}.${ext}'

/**
 * Every artifact the release matrix produces, in the order the download table
 * lists them. `key` is the updater's platform key in latest.json, so adding a
 * matrix leg here is what makes the feed require it.
 *
 * Linux is deliberately absent: the workflow builds no Linux artifact. The
 * source tree keeps its platform-generic paths, but a release that claims a
 * Linux download would be lying.
 */
export const RELEASE_TARGETS = [
  { key: 'mac-arm64', os: 'mac', arch: 'arm64', ext: 'dmg', device: 'Mac，芯片显示 Apple M 系列' },
  { key: 'mac-x64', os: 'mac', arch: 'x64', ext: 'dmg', device: 'Mac，处理器显示 Intel' },
  { key: 'win-x64', os: 'win', arch: 'x64', ext: 'exe', device: 'Windows 64 位，Intel 或 AMD 处理器' },
]

/** The file electron-builder produces for one target at one version. */
export function artifactName(version, target) {
  return 'dsh-desktop-' + version + '-' + target.os + '-' + target.arch + '.' + target.ext
}

/** Look up a target by its latest.json platform key. */
export function targetForKey(key) {
  return RELEASE_TARGETS.find(target => target.key === key)
}

/**
 * Matches any release artifact and reports its version and platform key.
 * Built from RELEASE_TARGETS so a new leg is understood here for free.
 */
export function parseArtifactName(name) {
  for (const target of RELEASE_TARGETS) {
    const suffix = '-' + target.os + '-' + target.arch + '.' + target.ext
    if (!name.startsWith('dsh-desktop-') || !name.endsWith(suffix)) continue
    const version = name.slice('dsh-desktop-'.length, name.length - suffix.length)
    if (version === '') continue
    return { version, target }
  }
  return undefined
}

/**
 * The keys latest.json must carry. A feed missing one of these is not a partial
 * success — it is an update blackout for that platform, with no error anywhere.
 */
export function requiredPlatformKeys() {
  return RELEASE_TARGETS.map(target => target.key)
}

/**
 * Assert electron-builder.yml still names files the way this module assumes.
 * @returns {string[]} failures, empty when the two agree
 */
export function checkArtifactNameTemplate() {
  const failures = []
  let builderYml
  try {
    builderYml = readFileSync(join(APP_DIR, 'electron-builder.yml'), 'utf8')
  } catch (error) {
    return ['electron-builder.yml is unreadable: ' + (error instanceof Error ? error.message : String(error))]
  }
  const declared = builderYml.match(/^artifactName:\s*['"]?([^'"#\n]+)/m)?.[1]?.trim()
  if (declared === undefined) {
    failures.push('electron-builder.yml declares no artifactName')
  } else if (declared !== ARTIFACT_NAME_TEMPLATE) {
    failures.push('electron-builder.yml artifactName is ' + JSON.stringify(declared)
      + ', but scripts/release-artifacts.mjs assumes ' + JSON.stringify(ARTIFACT_NAME_TEMPLATE))
  }
  return failures
}
