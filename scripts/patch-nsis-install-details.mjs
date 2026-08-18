/**
 * Make the Windows NSIS installer report what it is doing.
 *
 * electron-builder packs the app as a 7z and extracts it with Nsis7z. Its
 * templates then silence the InstFiles list (`SetDetailsPrint none`), which is
 * why the wizard sits on a green bar with a blank panel underneath. There is
 * no supported switch for this; the templates have to be edited before pack.
 *
 * This module is both the `beforePack` hook (patches the installed
 * app-builder-lib copies, breaking pnpm hardlinks first) and
 * `pnpm run check:nsis-details` (proves the hook, the include, and the live
 * templates still match). Silent installs keep `/S` behaviour: the print
 * change stays inside `${IfNot} ${Silent}`.
 *
 * Usage: node scripts/patch-nsis-install-details.mjs
 * @module desktop/scripts/patch-nsis-install-details
 */

import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const INSTALLER_NSH = join(APP_DIR, 'resources', 'installer.nsh')
const BUILDER_YML = join(APP_DIR, 'electron-builder.yml')

const BEFORE_PACK = 'scripts/patch-nsis-install-details.mjs'
const INCLUDE_PATH = 'resources/installer.nsh'

/** Shown once, before 7-Zip starts reporting percent. */
export const EXTRACTING_STAGE = '正在解压应用文件 / Extracting application files'
/** `Nsis7z::ExtractWithDetails` format; `%s` becomes e.g. `37% (120 / 320 MB)`. */
export const EXTRACT_PROGRESS = '正在解压 / Extracting %s...'
/** Shown before the silent copy from the 7z temp dir into $INSTDIR. */
export const COPYING_STAGE = '正在复制文件到安装目录 / Copying files to the installation folder'

const EXTRACT_COMMAND = 'Nsis7z::Extract "${FILE}"'
const EXTRACT_WITH_DETAILS = 'Nsis7z::ExtractWithDetails "${FILE}" "' + EXTRACT_PROGRESS + '"'
const COPY_FILES = 'CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR'
const SET_OUT_PATH_7Z = 'SetOutPath "$PLUGINSDIR\\7z-out"'

/**
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @returns {boolean}
 */
export function isNsisDetailsPatched(installSection, extractAppPackage) {
  return installSection.includes('SetDetailsPrint both')
    && !installSection.includes('SetDetailsPrint none')
    && extractAppPackage.includes(EXTRACT_WITH_DETAILS)
    && extractAppPackage.includes(COPYING_STAGE)
}

/**
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @returns {string[]}
 */
export function nsisDetailsPatchBlockers(installSection, extractAppPackage) {
  if (isNsisDetailsPatched(installSection, extractAppPackage)) return []
  const failures = []
  if (!installSection.includes('SetDetailsPrint none')) {
    failures.push('installSection.nsh no longer contains SetDetailsPrint none')
  }
  const extractCount = countOccurrences(extractAppPackage, EXTRACT_COMMAND)
  if (extractCount !== 2) {
    failures.push('extractAppPackage.nsh Nsis7z::Extract "${FILE}" count is ' + extractCount + ', expected 2')
  }
  if (!extractAppPackage.includes(SET_OUT_PATH_7Z)) {
    failures.push('extractAppPackage.nsh no longer contains ' + SET_OUT_PATH_7Z)
  }
  if (!extractAppPackage.includes(COPY_FILES)) {
    failures.push('extractAppPackage.nsh no longer contains CopyFiles /SILENT of 7z-out')
  }
  return failures
}

/**
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @returns {{ installSection: string, extractAppPackage: string, changed: boolean }}
 */
export function patchNsisDetailsTemplates(installSection, extractAppPackage) {
  if (isNsisDetailsPatched(installSection, extractAppPackage)) {
    return { installSection, extractAppPackage, changed: false }
  }
  const blockers = nsisDetailsPatchBlockers(installSection, extractAppPackage)
  if (blockers.length > 0) {
    throw new Error('electron-builder NSIS templates changed; cannot enable install details:\n- '
      + blockers.join('\n- '))
  }

  let nextInstall = installSection.replace('SetDetailsPrint none', 'SetDetailsPrint both')
  let nextExtract = replaceAllCounted(extractAppPackage, EXTRACT_COMMAND, EXTRACT_WITH_DETAILS, 2)
  nextExtract = insertLineAfter(nextExtract, SET_OUT_PATH_7Z, 'DetailPrint "' + EXTRACTING_STAGE + '"')
  nextExtract = insertLineBefore(nextExtract, COPY_FILES, 'DetailPrint "' + COPYING_STAGE + '"')
  return { installSection: nextInstall, extractAppPackage: nextExtract, changed: true }
}

/**
 * @param {string} appBuilderLibDir
 * @returns {{ installSection: string, extractAppPackage: string }}
 */
export function nsisTemplatePaths(appBuilderLibDir) {
  return {
    installSection: join(appBuilderLibDir, 'templates', 'nsis', 'installSection.nsh'),
    extractAppPackage: join(appBuilderLibDir, 'templates', 'nsis', 'include', 'extractAppPackage.nsh'),
  }
}

export function resolveAppBuilderLibDir() {
  const requireFromHere = createRequire(import.meta.url)
  try {
    return dirname(requireFromHere.resolve('app-builder-lib/package.json'))
  } catch {
    const electronBuilder = requireFromHere.resolve('electron-builder/package.json')
    return dirname(createRequire(electronBuilder).resolve('app-builder-lib/package.json'))
  }
}

export function patchInstalledNsisTemplates() {
  const paths = nsisTemplatePaths(resolveAppBuilderLibDir())
  const installSection = readFileSync(paths.installSection, 'utf8')
  const extractAppPackage = readFileSync(paths.extractAppPackage, 'utf8')
  const patched = patchNsisDetailsTemplates(installSection, extractAppPackage)
  if (!patched.changed) return { changed: false, paths }
  rewriteFile(paths.installSection, patched.installSection)
  rewriteFile(paths.extractAppPackage, patched.extractAppPackage)
  return { changed: true, paths }
}

/**
 * @returns {string[]}
 */
export function checkNsisInstallDetails() {
  const failures = []
  const describe = error => (error instanceof Error ? error.message : String(error))

  let installerNsh
  try {
    installerNsh = readFileSync(INSTALLER_NSH, 'utf8')
  } catch (error) {
    return ['resources/installer.nsh is unreadable: ' + describe(error)]
  }
  if (!installerNsh.includes('ShowInstDetails show')) {
    failures.push('resources/installer.nsh does not keep the InstFiles list open')
  }

  let builderYml
  try {
    builderYml = readFileSync(BUILDER_YML, 'utf8')
  } catch (error) {
    failures.push('electron-builder.yml is unreadable: ' + describe(error))
    return failures
  }
  if (!builderYml.includes('beforePack: ' + BEFORE_PACK)) {
    failures.push('electron-builder.yml does not hook ' + BEFORE_PACK)
  }
  if (!builderYml.includes('include: ' + INCLUDE_PATH)) {
    failures.push('electron-builder.yml does not include ' + INCLUDE_PATH)
  }

  const fixture = patchNsisDetailsTemplates(FIXTURE_INSTALL_SECTION, FIXTURE_EXTRACT_APP)
  if (!fixture.changed) failures.push('fixture templates were already patched')
  if (!fixture.installSection.includes('SetDetailsPrint both')) {
    failures.push('fixture installSection.nsh was not switched to SetDetailsPrint both')
  }
  if (countOccurrences(fixture.extractAppPackage, EXTRACT_WITH_DETAILS) !== 2) {
    failures.push('fixture extractAppPackage.nsh did not switch both 7-Zip extracts to ExtractWithDetails')
  }
  if (!fixture.extractAppPackage.includes(EXTRACTING_STAGE) || !fixture.extractAppPackage.includes(COPYING_STAGE)) {
    failures.push('fixture extractAppPackage.nsh is missing stage DetailPrint lines')
  }
  const again = patchNsisDetailsTemplates(fixture.installSection, fixture.extractAppPackage)
  if (again.changed) failures.push('patching already-patched templates was not a no-op')

  try {
    const live = nsisTemplatePaths(resolveAppBuilderLibDir())
    const installSection = readFileSync(live.installSection, 'utf8')
    const extractAppPackage = readFileSync(live.extractAppPackage, 'utf8')
    const blockers = nsisDetailsPatchBlockers(installSection, extractAppPackage)
    if (blockers.length > 0) failures.push(...blockers)
  } catch (error) {
    failures.push('app-builder-lib NSIS templates: ' + describe(error))
  }

  return failures
}

/** Minimal copies of the electron-builder 26.15.3 fragments this patch edits. */
export const FIXTURE_INSTALL_SECTION = `\
\${IfNot} \${Silent}
 SetDetailsPrint none
\${endif}
`

export const FIXTURE_EXTRACT_APP = `\
 SetOutPath "$PLUGINSDIR\\7z-out"
 Nsis7z::Extract "\${FILE}"
 Pop $R0
 CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR
 Nsis7z::Extract "\${FILE}"
`

function countOccurrences(source, search) {
  let count = 0
  let from = 0
  while (from <= source.length) {
    const index = source.indexOf(search, from)
    if (index === -1) return count
    count++
    from = index + search.length
  }
  return count
}

function replaceAllCounted(source, search, replacement, expectedCount) {
  const count = countOccurrences(source, search)
  if (count !== expectedCount) {
    throw new Error('expected ' + expectedCount + ' occurrence(s) of ' + JSON.stringify(search) + ', found ' + count)
  }
  return source.split(search).join(replacement)
}

function indentOfLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  return source.slice(lineStart, index)
}

function lineBreak(source) {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function insertLineAfter(source, search, line) {
  const index = source.indexOf(search)
  if (index === -1) throw new Error('cannot insert after missing ' + JSON.stringify(search))
  const nlIndex = source.indexOf('\n', index)
  const nl = lineBreak(source)
  const indent = indentOfLine(source, index)
  if (nlIndex === -1) return source + nl + indent + line
  return source.slice(0, nlIndex + 1) + indent + line + nl + source.slice(nlIndex + 1)
}

function insertLineBefore(source, search, line) {
  const index = source.indexOf(search)
  if (index === -1) throw new Error('cannot insert before missing ' + JSON.stringify(search))
  return source.slice(0, index) + line + lineBreak(source) + indentOfLine(source, index) + source.slice(index)
}

function rewriteFile(file, contents) {
  try {
    chmodSync(file, 0o666)
  } catch {
    // pnpm's store copies can already be writable; unlink is what breaks the hardlink.
  }
  unlinkSync(file)
  writeFileSync(file, contents, 'utf8')
}

/**
 * electron-builder's beforePack hook. Mutates app-builder-lib templates in
 * place so the NSIS compile that follows picks up details printing.
 * @returns {void}
 */
export default function beforePack() {
  const result = patchInstalledNsisTemplates()
  const verb = result.changed ? 'enabled' : 'already enabled'
  console.log('✓ NSIS install details ' + verb + ' in ' + result.paths.installSection)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkNsisInstallDetails()
  if (failures.length > 0) {
    for (const failure of failures) console.log('✗ ' + failure)
    console.log('NSIS install-details wiring disagrees with electron-builder templates or config; '
      + 'reconcile resources/installer.nsh, electron-builder.yml, and scripts/patch-nsis-install-details.mjs.')
    process.exit(1)
  }
  console.log('✓ NSIS installer include keeps the InstFiles list open')
  console.log('✓ electron-builder.yml hooks ' + BEFORE_PACK)
  console.log('✓ app-builder-lib NSIS templates still accept the details patch')
}
