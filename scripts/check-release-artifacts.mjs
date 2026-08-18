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
for (const name of ['SHA256SUMS.txt', 'latest.json', 'dsh-desktop-1.2.3-linux-x64.AppImage', 'dsh-desktop.exe']) {
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
