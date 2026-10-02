import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'

/**
 * Assert the release's naming convention still has one meaning.
 *
 * electron-builder names the files; `scripts/release-artifacts.mjs` is what the
 * update feed, the GitHub Release download table and check:updater's fixtures
 * all read. If those two drift apart, the failure is quiet: the download table
 * names files nobody built, and latest.json loses a platform whose users then
 * see "up to date" forever. Two file reads, so it runs in the validate job
 * before anything is built.
 *
 * Usage: node scripts/check-release-artifacts.mjs
 * @module desktop/scripts/check-release-artifacts
 */

import {
  ARTIFACT_NAME_TEMPLATE,
  RELEASE_TARGETS,
  artifactName,
  checkArtifactNameTemplate,
  parseArtifactName,
  requiredPlatformKeys,
} from './release-artifacts.mjs'

const failures = [...checkArtifactNameTemplate()]

// The template is only useful if this module can also read back what it writes:
// the feed identifies a platform by parsing the filename, so a target whose
// name does not round-trip would be dropped from latest.json without comment.
for (const target of RELEASE_TARGETS) {
  const name = artifactName('1.2.3', target)
  const parsed = parseArtifactName(name)
  if (parsed === undefined) {
    failures.push(name + ' is not recognised by parseArtifactName')
    continue
  }
  if (parsed.version !== '1.2.3' || parsed.target.key !== target.key) {
    failures.push(name + ' parsed as ' + JSON.stringify({ version: parsed.version, key: parsed.target.key }))
  }
}

// Prerelease tags carry their own hyphens; the version must not be truncated
// at the first one or every rc build would be filed under the wrong version.
const prerelease = artifactName('1.2.3-rc.4', RELEASE_TARGETS[0])
if (parseArtifactName(prerelease)?.version !== '1.2.3-rc.4') {
  failures.push('a prerelease version does not round-trip: ' + prerelease)
}

// A file that is not one of ours must not be mistaken for one, or the feed
// would publish a checksum row pointing at the wrong download.
for (const name of ['SHA256SUMS.txt', 'latest.json', 'dsh-desktop-1.2.3-linux-arm64.AppImage', 'dsh-desktop.exe']) {
  if (parseArtifactName(name) !== undefined) failures.push(name + ' was parsed as a release artifact')
}

const keys = requiredPlatformKeys()
if (new Set(keys).size !== keys.length) failures.push('duplicate platform keys: ' + keys.join(', '))

if (failures.length > 0) {
  for (const failure of failures) console.log('✗ ' + failure)
  console.log('The release naming convention disagrees with itself; reconcile electron-builder.yml '
    + 'and scripts/release-artifacts.mjs before releasing.')
  process.exit(1)
}

console.log('✓ electron-builder.yml artifactName matches ' + JSON.stringify(ARTIFACT_NAME_TEMPLATE))
console.log('✓ every release target round-trips through parseArtifactName: ' + keys.join(', '))

// Compare the shared naming table with the pinned builder's actual architecture
// expansion. DEB uses amd64 while AppImage uses x86_64 for the same x64 CPU.
const requireBuilder = createRequire(import.meta.resolve('electron-builder'))
const { Arch, getArtifactArchName } = requireBuilder('builder-util')
for (const target of RELEASE_TARGETS.filter(target => target.os === 'linux')) {
  assert.equal(target.arch, getArtifactArchName(Arch.x64, target.ext))
}
const config = load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
assert.ok(config.linux.target.some(target => target.target === 'deb' && target.arch.includes('x64')))
assert.ok(config.deb.maintainer)
assert.ok(config.deb.depends.includes('apparmor'))
assert.ok(config.deb.fpm.includes('resources/linux-package-type=/opt/' + config.productName + '/resources/package-type'))
assert.equal(readFileSync(new URL('../resources/linux-package-type', import.meta.url), 'utf8').trim(), 'deb')
for (const hook of [config.deb.afterInstall, config.deb.afterRemove, config.deb.appArmorProfile]) {
  assert.ok(readFileSync(new URL('../' + hook, import.meta.url), 'utf8').includes('dsh-desktop-deb'))
}
console.log('✓ DEB configuration agrees with builder architecture naming and package-owned format marker')
