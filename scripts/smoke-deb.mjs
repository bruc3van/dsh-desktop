/** Install the actual DEB on an ephemeral Ubuntu runner, then upgrade/remove it. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This deliberately changes the system package database. Never run on a user's
// workstation just because it happens to be Linux.
assert.equal(process.platform, 'linux', 'smoke:deb requires Linux')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'smoke:deb requires an ephemeral GitHub Actions runner')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'smoke:deb must not modify a self-hosted runner')
assert.notEqual(process.getuid(), 0, 'Launch the app as the unprivileged runner user')
const root = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const deb = resolve(process.argv[2] ?? join(root, 'release', `dsh-desktop-${version}-linux-amd64.deb`))
const work = await mkdtemp(join(tmpdir(), 'dsh-deb-'))
const executable = '/opt/DSH Desktop/dsh-desktop'
const marker = '/opt/DSH Desktop/resources/package-type'
const profile = '/etc/apparmor.d/dsh-desktop-deb'
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024, ...options,
})
const sudo = (...args) => run('sudo', ['-n', ...args])
const installed = () => {
  try { return run('dpkg-query', ['-W', '-f=${Status}', 'dsh-desktop']).includes('install ok installed') } catch { return false }
}
assert.equal(installed(), false, 'Refuse to replace an existing installation')
const sentinels = []
let ownsInstallation = false
async function verifyInstalled() {
  assert.equal(installed(), true)
  assert.equal(await realpath('/usr/bin/dsh-desktop'), executable)
  assert.equal((await readFile(marker, 'utf8')).trim(), 'deb')
  const files = run('dpkg-query', ['-L', 'dsh-desktop']).trim().split('\n')
  assert.ok(files.includes(marker), 'Package marker must be owned by dpkg')
  const desktop = files.find(file => file.startsWith('/usr/share/applications/') && file.endsWith('.desktop'))
  assert.ok(desktop, 'Installed desktop entry is missing')
  const entry = await readFile(desktop, 'utf8')
  assert.match(entry, /^Exec=.*dsh-desktop/m)
  assert.match(entry, /^Icon=dsh-desktop$/m)
  assert.doesNotMatch(entry, /--no-sandbox/)
  assert.ok(files.some(file => /\/icons\/.*\/dsh-desktop\.png$/.test(file)))
  for (const sentinel of sentinels) assert.equal(await readFile(sentinel, 'utf8'), 'keep-user-data\n')
  // The CI helper profiles must not authorize this path: this must be the
  // installed package's own profile, loaded by its maintainer script.
  if (existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    && (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim() === '1') {
    await access(profile)
    assert.match(sudo('cat', '/sys/kernel/security/apparmor/profiles'), /^dsh-desktop-deb /m)
  }
  for (const script of ['check-pnpm-runtime.mjs', 'check-linux.mjs', 'smoke-package.mjs']) {
    process.stdout.write(run(process.execPath, [join(root, 'scripts', script), executable, ...script === 'check-linux.mjs' ? ['deb'] : []], { cwd: root }))
  }
}
try {
  assert.equal(run('dpkg-deb', ['-f', deb, 'Package']).trim(), 'dsh-desktop')
  assert.equal(run('dpkg-deb', ['-f', deb, 'Architecture']).trim(), 'amd64')
  const packageVersion = run('dpkg-deb', ['-f', deb, 'Version']).trim()
  // A synthetic older version exercises dpkg's real upgrade path without
  // depending on a previously published DEB (there is none for the first release).
  const older = join(work, 'older')
  run('dpkg-deb', ['-R', deb, older])
  const controlPath = join(older, 'DEBIAN/control')
  const control = await readFile(controlPath, 'utf8')
  await writeFile(controlPath, control.replace(/^Version: .+$/m, 'Version: 0.0.0'))
  const oldDeb = join(work, 'older.deb')
  run('dpkg-deb', ['--root-owner-group', '-b', older, oldDeb])
  run('dpkg', ['--compare-versions', packageVersion, 'gt', '0.0.0'])
  for (const dir of ['.bruc3van-dsh-desktop', '.dsh']) {
    const dataDir = join(homedir(), dir)
    await mkdir(dataDir, { recursive: true })
    const sentinel = join(dataDir, 'deb-smoke-preserve-' + process.pid)
    await writeFile(sentinel, 'keep-user-data\n', { flag: 'wx' })
    sentinels.push(sentinel)
  }
  ownsInstallation = true
  process.stdout.write(sudo('apt-get', 'install', '-y', oldDeb))
  await verifyInstalled()
  console.log('✓ DEB installs desktop integration, AppArmor and a working bundled runtime')
  process.stdout.write(sudo('apt-get', 'install', '-y', deb))
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'dsh-desktop']).trim(), packageVersion)
  await verifyInstalled()
  console.log('✓ DEB upgrades in place and retains user data and package integration')
  process.stdout.write(sudo('apt-get', 'remove', '-y', 'dsh-desktop'))
  assert.equal(existsSync(executable), false)
  assert.equal(existsSync('/usr/bin/dsh-desktop'), false)
  assert.equal(existsSync(profile), false)
  if (existsSync('/sys/kernel/security/apparmor/profiles')) {
    assert.doesNotMatch(sudo('cat', '/sys/kernel/security/apparmor/profiles'), /^dsh-desktop-deb /m)
  }
  for (const sentinel of sentinels) assert.equal(await readFile(sentinel, 'utf8'), 'keep-user-data\n')
  console.log('✓ DEB removal removes the executable and policy while retaining user data')
} finally {
  if (ownsInstallation) sudo('apt-get', 'purge', '-y', 'dsh-desktop')
  for (const sentinel of sentinels) await rm(sentinel, { force: true })
  await rm(work, { recursive: true, force: true })
}
