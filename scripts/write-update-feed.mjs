/**
 * Build latest.json for the in-app updater from packaged artifacts and
 * SHA256SUMS.txt. Used by the release workflow after every platform upload.
 *
 * Usage:
 *   node scripts/write-update-feed.mjs --dir assets --version 0.1.7 --out assets/latest.json
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArtifactName, requiredPlatformKeys } from './release-artifacts.mjs'

const args = parseArgs(process.argv.slice(2))
const dir = args.dir
const version = (args.version ?? '').replace(/^v/i, '')
const out = args.out
const repo = args.repo ?? 'bruc3van/dsh-desktop'
const notes = args['notes-file'] !== undefined
  ? readFileSync(args['notes-file'], 'utf8')
  : (args.notes ?? '')
if (dir === undefined || version === '' || out === undefined) {
  throw new Error('usage: write-update-feed.mjs --dir <dir> --version <ver> --out <file> [--repo owner/name] [--notes text | --notes-file path]')
}

const sumsPath = join(dir, 'SHA256SUMS.txt')
const sums = parseSha256Sums(existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : '')
const platforms = {}

for (const name of readdirSync(dir)) {
  const parsed = parseArtifactName(name)
  if (parsed === undefined || parsed.version !== version) continue
  const filePath = join(dir, name)
  const sha256 = sums.get(name) ?? sha256File(filePath)
  platforms[parsed.target.key] = {
    url: 'https://github.com/' + repo + '/releases/download/v' + version + '/' + name,
    sha256,
  }
}

// Every platform, or none of them. A feed that is merely *non-empty* passes
// this file's old check while leaving one platform's users with no updates at
// all — and silently, because the updater reads a missing key as "up to date"
// rather than as an error. The build matrix is what normally guarantees all
// three are present; this is the last place that can still see whether they
// actually are, so it refuses to write a feed that would strand anyone.
const missing = requiredPlatformKeys().filter(key => platforms[key] === undefined)
if (missing.length > 0) {
  throw new Error('refusing to write an incomplete update feed: ' + dir + ' has no artifact for '
    + missing.join(', ') + ' (found ' + (Object.keys(platforms).join(', ') || 'nothing') + ')')
}

const feed = {
  version,
  pubDate: new Date().toISOString(),
  platforms,
  ...notes !== '' && { notes },
}
writeFileSync(out, JSON.stringify(feed, null, 2) + '\n')
console.log('wrote ' + out + ' (' + Object.keys(platforms).join(', ') + ')')

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = '1'
      continue
    }
    parsed[key] = value
    i++
  }
  return parsed
}

function parseSha256Sums(text) {
  const hashes = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(rawLine.trim())
    if (match === null || match[1] === undefined || match[2] === undefined) continue
    hashes.set(match[2].trim().replace(/^\.\//, ''), match[1].toLowerCase())
  }
  return hashes
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
