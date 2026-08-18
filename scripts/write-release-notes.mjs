/**
 * Build the GitHub Release body from one CHANGELOG version section.
 *
 * Usage:
 *   node scripts/write-release-notes.mjs \
 *     --version 0.1.7 \
 *     --changelog CHANGELOG.md \
 *     --out release-notes.md \
 *     [--changes-out release-changes.md]
 *
 * @module desktop/scripts/write-release-notes
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { artifactName, RELEASE_TARGETS, targetForKey } from './release-artifacts.mjs'

const args = parseArgs(process.argv.slice(2))
const version = (args.version ?? '').replace(/^v/i, '')
const changelogPath = args.changelog ?? 'CHANGELOG.md'
const out = args.out
const changesOut = args['changes-out']

if (version === '' || out === undefined) {
  throw new Error('usage: write-release-notes.mjs --version <version> --out <file> [--changelog CHANGELOG.md] [--changes-out <file>]')
}

const changes = extractVersionSection(readFileSync(changelogPath, 'utf8'), version)
// Rows and filenames come from the same table the update feed reads, so a
// change to the release matrix cannot leave this page naming files that were
// never built (or omitting one that was).
const downloadRows = RELEASE_TARGETS
  .map(target => '| ' + target.device + ' | `' + artifactName(version, target) + '` |')
  .join('\n')
const windowsTarget = targetForKey('win-x64')
if (windowsTarget === undefined) throw new Error('release targets no longer include win-x64')
const windowsInstaller = artifactName(version, windowsTarget)
const body = `> **非官方项目 / Unofficial project：** 此桌面客户端由社区独立维护，并非 DeepSeek 官方产品，也不由 DeepSeek 背书或提供支持。

## 版本变更

${changes}

## 选择安装包

安装包已内置官方 \`dsh\` 运行时，不需要另装 Node.js、pnpm 或 dsh CLI。

| 你的设备 | 下载文件 |
|---|---|
${downloadRows}

不知道 Mac 属于哪一种时，打开「 → 关于本机」：显示“芯片 Apple M…”选择 \`arm64\`，显示“处理器 Intel”选择 \`x64\`。目前不提供 Linux 或 Windows ARM64 安装包。

## 安装

### macOS

1. 下载对应芯片的 \`.dmg\` 并打开。
2. 将 **DeepSeek Harness Desktop** 拖入「应用程序」。
3. 从「应用程序」打开。若系统阻止启动，前往「系统设置 → 隐私与安全性」，确认应用名称后点击「仍要打开」。

### Windows

1. 下载 \`${windowsInstaller}\`。
2. 双击安装程序并按提示完成安装。
3. 若 Microsoft Defender SmartScreen 拦截，请先确认文件来自本 Release；然后点击「更多信息 → 仍要运行」。

> 当前安装包尚未使用注册开发者证书签名。Release 同时提供 \`SHA256SUMS.txt\`，用于核对下载文件是否完整；校验值不一致时请勿安装。
`

writeFileSync(out, body)
if (changesOut !== undefined) writeFileSync(changesOut, changes + '\n')
console.log('wrote ' + out + ' from CHANGELOG ' + version)

function extractVersionSection(changelog, requestedVersion) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const escaped = requestedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp('^##\\s+\\[?' + escaped + '\\]?(?:\\s+-\\s+.*|\\s*（.*）)?\\s*$')
  const start = lines.findIndex(line => heading.test(line.trim()))
  if (start < 0) throw new Error('CHANGELOG has no section for version ' + requestedVersion)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  const section = lines.slice(start + 1, end).join('\n').trim()
  if (section === '') throw new Error('CHANGELOG section is empty for version ' + requestedVersion)
  return section
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = '1'
      continue
    }
    parsed[key] = value
    index += 1
  }
  return parsed
}
