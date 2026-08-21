/**
 * Patch and verify the Windows NSIS install/upgrade experience.
 *
 * electron-builder packs the app as a 7z and extracts it with Nsis7z. Its
 * templates then silence the InstFiles list (`SetDetailsPrint none`), which is
 * why the wizard sits on a green bar with a blank panel underneath. There is
 * no supported switch for this; the templates have to be edited before pack.
 *
 * This module is both the `beforePack` hook (patches the installed
 * app-builder-lib copies, breaking pnpm hardlinks first) and
 * `pnpm run check:nsis-details` (proves the hook, migration include, and live
 * templates still match). Silent installs keep `/S` behaviour: the print
 * change stays inside `${IfNot} ${Silent}` and upgrade recovery has an
 * install-section hook of its own.
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
// electron-builder's own template closes this block with the lowercase-`e`
// `${endIf}` alias. Match it verbatim: a pristine app-builder-lib is what CI
// and a clean release checkout patch, and a near-miss here fails there while
// an already-patched developer tree keeps passing.
const DIRECTORY_NORMALIZATION = `\
    Function instFilesPre
      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR
      \${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"
      \${endIf}
    FunctionEnd`
const UPGRADE_SAFE_DIRECTORY_NORMALIZATION = `\
    Function instFilesPre
      !ifmacrodef dshRestoreUnchangedInstallTarget
        !insertmacro dshRestoreUnchangedInstallTarget
      !endif
      \${If} $dshExistingInstallFound == "true"
      \${AndIf} $INSTDIR == $dshRecoveredInstallDir
        Return
      \${EndIf}
      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR
      \${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"
      \${EndIf}
    FunctionEnd`
const INSTALL_MODE_LEAVE = '\t\t!insertmacro MUI_PAGE_FUNCTION_CUSTOM LEAVE'
const UPGRADE_SAFE_INSTALL_MODE_LEAVE = `\
\t\t!ifmacrodef customInstallModeLeave
\t\t\t!insertmacro customInstallModeLeave
\t\t!endif

${INSTALL_MODE_LEAVE}`
const GENERIC_UNINSTALL_FAILURE = 'MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt'
const UNUSED_UNINSTALL_RETRY_LABEL = '  OneMoreAttempt:'
// electron-builder asks the user to retry or cancel once the legacy uninstall
// has failed five times. That dialog made sense while a failure ended the
// upgrade; now `customUnInstallCheck` removes the old directory itself right
// after, so the only thing the dialog changes is that the recovery waits for a
// click — and it reads as a hard failure moments before the install succeeds.
// Report the same detail (the exit code and directory issue #11 asked for) into
// the details list instead and fall through to the Return the Cancel branch
// already took, so the recovery runs on its own.
const PRECISE_UNINSTALL_FAILURE = 'DetailPrint "旧版本卸载失败（退出码 $R0），安装目录：$installationDir；改由安装程序清理后继续 / Old version uninstall failed (exit code $R0). Install directory: $installationDir. Continuing; this installer will remove it."'
const INSTALL_SECTION_APP_EXE = 'StrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"'
const PREPARE_UPGRADE_HOOK = `\
!ifmacrodef customPrepareUpgrade
  !insertmacro customPrepareUpgrade
!endif

${INSTALL_SECTION_APP_EXE}`

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
 * Patch the two electron-builder upgrade behaviours that are unsafe across a
 * product rename: directory-name appending and the generic "cannot close"
 * wrapper around every legacy-uninstaller failure.
 *
 * @param {string} assistedInstaller
 * @param {string} installUtil
 * @param {string} multiUserUi
 * @returns {{ assistedInstaller: string, installUtil: string, multiUserUi: string, assistedChanged: boolean, installUtilChanged: boolean, multiUserUiChanged: boolean, changed: boolean }}
 */
export function patchNsisUpgradeTemplates(assistedInstaller, installUtil, multiUserUi) {
  const directoryPatched = assistedInstaller.includes(UPGRADE_SAFE_DIRECTORY_NORMALIZATION)
  // Replacing the only `IDRETRY OneMoreAttempt` branch also makes its label
  // dead. makensis warning 6012 is fatal under electron-builder, so a template
  // is complete only after both halves have been patched. Treat the residual
  // label as migratable: a developer tree may already carry the older partial
  // patch even though a clean CI checkout always starts from the generic line.
  const retryLabelPresent = installUtil.includes(UNUSED_UNINSTALL_RETRY_LABEL)
  const failurePatched = installUtil.includes(PRECISE_UNINSTALL_FAILURE) && !retryLabelPresent
  const modeLeavePatched = multiUserUi.includes(UPGRADE_SAFE_INSTALL_MODE_LEAVE)
  if (directoryPatched && failurePatched && modeLeavePatched) {
    return {
      assistedInstaller,
      installUtil,
      multiUserUi,
      assistedChanged: false,
      installUtilChanged: false,
      multiUserUiChanged: false,
      changed: false,
    }
  }
  if (!directoryPatched && !assistedInstaller.includes(DIRECTORY_NORMALIZATION)) {
    throw new Error('electron-builder NSIS assistedInstaller.nsh directory normalization changed, '
      + 'or this repository changed its replacement text; reinstall app-builder-lib and retry')
  }
  if (!failurePatched
    && !installUtil.includes(GENERIC_UNINSTALL_FAILURE)
    && !installUtil.includes(PRECISE_UNINSTALL_FAILURE)) {
    // Also what a developer tree hits after this repository edits its own
    // replacement text: the installed template still carries the previous
    // patch, so neither string matches. Reinstalling restores the pristine one.
    throw new Error('electron-builder NSIS installUtil.nsh uninstall failure handling changed, '
      + 'or this repository changed its replacement text; reinstall app-builder-lib and retry')
  }
  if (!modeLeavePatched && !multiUserUi.includes(INSTALL_MODE_LEAVE)) {
    throw new Error('electron-builder NSIS multiUserUi.nsh install-mode Leave hook changed')
  }
  let nextInstallUtil = installUtil.includes(PRECISE_UNINSTALL_FAILURE)
    ? installUtil
    : installUtil.replace(GENERIC_UNINSTALL_FAILURE, PRECISE_UNINSTALL_FAILURE)
  if (retryLabelPresent) {
    nextInstallUtil = removeStandaloneLine(nextInstallUtil, UNUSED_UNINSTALL_RETRY_LABEL)
  }
  return {
    assistedInstaller: directoryPatched
      ? assistedInstaller
      : assistedInstaller.replace(DIRECTORY_NORMALIZATION, UPGRADE_SAFE_DIRECTORY_NORMALIZATION),
    installUtil: nextInstallUtil,
    multiUserUi: modeLeavePatched
      ? multiUserUi
      : multiUserUi.replace(INSTALL_MODE_LEAVE, UPGRADE_SAFE_INSTALL_MODE_LEAVE),
    assistedChanged: !directoryPatched,
    installUtilChanged: !failurePatched,
    multiUserUiChanged: !modeLeavePatched,
    changed: true,
  }
}

/**
 * Add the project hook immediately before electron-builder captures $INSTDIR
 * in $appExe and invokes the legacy uninstaller.
 *
 * @param {string} installSection
 * @returns {{ installSection: string, changed: boolean }}
 */
export function patchNsisUpgradeInstallSection(installSection) {
  if (installSection.includes(PREPARE_UPGRADE_HOOK)) {
    return { installSection, changed: false }
  }
  if (!installSection.includes(INSTALL_SECTION_APP_EXE)) {
    throw new Error('electron-builder NSIS installSection.nsh app executable initialization changed')
  }
  return {
    installSection: installSection.replace(INSTALL_SECTION_APP_EXE, PREPARE_UPGRADE_HOOK),
    changed: true,
  }
}

/**
 * @param {string} appBuilderLibDir
 * @returns {{ installSection: string, extractAppPackage: string, assistedInstaller: string, installUtil: string, multiUserUi: string }}
 */
export function nsisTemplatePaths(appBuilderLibDir) {
  return {
    installSection: join(appBuilderLibDir, 'templates', 'nsis', 'installSection.nsh'),
    extractAppPackage: join(appBuilderLibDir, 'templates', 'nsis', 'include', 'extractAppPackage.nsh'),
    assistedInstaller: join(appBuilderLibDir, 'templates', 'nsis', 'assistedInstaller.nsh'),
    installUtil: join(appBuilderLibDir, 'templates', 'nsis', 'include', 'installUtil.nsh'),
    multiUserUi: join(appBuilderLibDir, 'templates', 'nsis', 'multiUserUi.nsh'),
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
  const assistedInstaller = readFileSync(paths.assistedInstaller, 'utf8')
  const installUtil = readFileSync(paths.installUtil, 'utf8')
  const multiUserUi = readFileSync(paths.multiUserUi, 'utf8')
  const details = patchNsisDetailsTemplates(installSection, extractAppPackage)
  const upgrade = patchNsisUpgradeTemplates(assistedInstaller, installUtil, multiUserUi)
  const upgradeSection = patchNsisUpgradeInstallSection(details.installSection)
  if (details.changed || upgradeSection.changed) {
    rewriteFile(paths.installSection, upgradeSection.installSection)
  }
  if (details.changed) {
    rewriteFile(paths.extractAppPackage, details.extractAppPackage)
  }
  if (upgrade.assistedChanged) {
    rewriteFile(paths.assistedInstaller, upgrade.assistedInstaller)
  }
  if (upgrade.installUtilChanged) {
    rewriteFile(paths.installUtil, upgrade.installUtil)
  }
  if (upgrade.multiUserUiChanged) {
    rewriteFile(paths.multiUserUi, upgrade.multiUserUi)
  }
  return { changed: details.changed || upgrade.changed || upgradeSection.changed, paths }
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
  for (const requirement of [
    'dshRecoveredInstallDir',
    'dshExplicitInstallDir',
    '!insertmacro GetDParameter $R0',
    '!macro dshRestoreUnchangedInstallTarget',
    '!macro customInstallModeLeave',
    '"${UNINSTALL_REGISTRY_KEY}" InstallLocation',
    '!macro customPrepareUpgrade',
    'WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '!macro customInstall',
    'CreateShortCut "$newDesktopLink"',
    // Without this hook a failed legacy uninstall reaches electron-builder's
    // own MessageBox, which has no /SD default and hangs every silent install.
    '!macro customUnInstallCheck',
    '!macro customUnInstallCheckCurrentUser',
    // And the hook is only worth having because it finishes the removal the
    // previous version's uninstaller refused to do (issue #11).
    '!macro dshRemovePreviousInstall',
    'RMDir /r "$R5"',
    // And this keeps every version from 0.2.6 on from needing that rescue:
    // the uninstaller skips the atomic-rename detour that issue #11 dies on.
    '!macro customRemoveFiles',
  ]) {
    if (!installerNsh.includes(requirement)) {
      failures.push('resources/installer.nsh is missing upgrade recovery: ' + requirement)
    }
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
    const upgrade = patchNsisUpgradeTemplates(FIXTURE_ASSISTED_INSTALLER, FIXTURE_INSTALL_UTIL, FIXTURE_MULTI_USER_UI)
    if (!upgrade.changed) failures.push('upgrade fixture templates were already patched')
    if (!upgrade.assistedInstaller.includes('$dshExistingInstallFound == "true"')
      || !upgrade.assistedInstaller.includes('$INSTDIR == $dshRecoveredInstallDir')) {
      failures.push('fixture assistedInstaller.nsh does not preserve an existing install directory')
    }
    if (!upgrade.multiUserUi.includes('customInstallModeLeave')) {
      failures.push('fixture multiUserUi.nsh does not repair the directory before showing the directory page')
    }
    if (!upgrade.installUtil.includes('Old version uninstall failed (exit code $R0)')) {
      failures.push('fixture installUtil.nsh does not report the legacy uninstaller exit code')
    }
    if (upgrade.installUtil.includes('OneMoreAttempt:')) {
      failures.push('fixture installUtil.nsh leaves the unused OneMoreAttempt label behind')
    }
    const upgradeAgain = patchNsisUpgradeTemplates(upgrade.assistedInstaller, upgrade.installUtil, upgrade.multiUserUi)
    if (upgradeAgain.changed) failures.push('patching already-patched upgrade templates was not a no-op')
    const upgradeSection = patchNsisUpgradeInstallSection(FIXTURE_UPGRADE_INSTALL_SECTION)
    if (!upgradeSection.changed || !upgradeSection.installSection.includes('customPrepareUpgrade')) {
      failures.push('fixture installSection.nsh does not prepare the recovered directory before uninstall')
    }
    if (patchNsisUpgradeInstallSection(upgradeSection.installSection).changed) {
      failures.push('patching an already-patched upgrade install section was not a no-op')
    }
  } catch (error) {
    failures.push('upgrade template fixture: ' + describe(error))
  }

  try {
    const live = nsisTemplatePaths(resolveAppBuilderLibDir())
    const installSection = readFileSync(live.installSection, 'utf8')
    const extractAppPackage = readFileSync(live.extractAppPackage, 'utf8')
    const assistedInstaller = readFileSync(live.assistedInstaller, 'utf8')
    const installUtil = readFileSync(live.installUtil, 'utf8')
    const multiUserUi = readFileSync(live.multiUserUi, 'utf8')
    const blockers = nsisDetailsPatchBlockers(installSection, extractAppPackage)
    if (blockers.length > 0) failures.push(...blockers)
    patchNsisUpgradeTemplates(assistedInstaller, installUtil, multiUserUi)
    patchNsisUpgradeInstallSection(installSection)
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

export const FIXTURE_ASSISTED_INSTALLER = DIRECTORY_NORMALIZATION
export const FIXTURE_INSTALL_UTIL = `${GENERIC_UNINSTALL_FAILURE}
${UNUSED_UNINSTALL_RETRY_LABEL}
    ExecWait 'legacy uninstaller'
`
export const FIXTURE_MULTI_USER_UI = INSTALL_MODE_LEAVE
export const FIXTURE_UPGRADE_INSTALL_SECTION = INSTALL_SECTION_APP_EXE

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

/** Remove one complete template line while preserving its existing EOL style. */
function removeStandaloneLine(source, line) {
  for (const ending of ['\r\n', '\n']) {
    const complete = line + ending
    if (source.includes(complete)) return source.replace(complete, '')
  }
  if (source.endsWith(line)) return source.slice(0, -line.length)
  throw new Error('electron-builder NSIS installUtil.nsh retry label shape changed')
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
 * place so the NSIS compile that follows picks up details and upgrade safety.
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
  console.log('✓ NSIS installer include keeps details visible and repairs renamed upgrades')
  console.log('✓ electron-builder.yml hooks ' + BEFORE_PACK)
  console.log('✓ app-builder-lib NSIS templates still accept the details and upgrade patches')
}
