/**
 * Windows NSIS installer: extract next to the install directory, then swap
 * directories by rename (scripts/installer-directories.nsh).
 *
 * electron-builder's assisted installer extracts the app 7z into
 * `$PLUGINSDIR\7z-out`, copies the tree into `$INSTDIR` file by file, and on an
 * upgrade first runs the previous version's uninstaller. That writes every file
 * twice, merges into whatever the uninstaller left behind (0.6.1 upgraded in
 * place kept 88 files the new version does not ship), and depends on an
 * uninstaller already on the user's machine (issue #11).
 *
 * This module replaces that with: stage the complete new tree in
 * `$INSTDIR.new-<GUID>` using the bundled 7za.exe, rename the current directory
 * to `$INSTDIR.old-<GUID>`, rename the new one into place, delete the backup.
 * A same-directory upgrade (registered InstallLocation == $INSTDIR) no longer
 * runs the old uninstaller at all; moving to another directory or install scope
 * still does, through electron-builder's own path.
 *
 * electron-builder's templates are not a public API, so nothing is patched in
 * node_modules. When NsisTarget assembles a script, the templates this product
 * changes are read fresh, adapted, and written under the target's out dir, and
 * the script includes those copies instead. Every edit goes through
 * `replaceOnce`, which requires its anchor exactly once: an electron-builder
 * upgrade that moves any of them fails the build instead of shipping an
 * installer that silently skips a step.
 *
 * This file is both the electron-builder `beforePack` hook (installs the
 * adapter) and `pnpm run check:nsis-installer` (applies every adaptation to
 * the installed templates and checks the include and config wiring).
 *
 * @module desktop/scripts/windows-directory-installer
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const BEFORE_PACK = 'scripts/windows-directory-installer.mjs'
const INCLUDE_PATH = 'resources/installer.nsh'
const patched = Symbol.for('dsh-desktop-pro/windows-directory-installer')

/** electron-builder's own require, so the adapter patches the instance it runs. */
function builderRequire() {
  const require = createRequire(import.meta.url)
  return createRequire(require.resolve('electron-builder/package.json'))
}

export function appBuilderLibDir() {
  return dirname(builderRequire().resolve('app-builder-lib/package.json'))
}

/**
 * @param {string} source
 * @param {string} before
 * @param {string} after
 */
export function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) {
    throw new Error('electron-builder NSIS template changed: expected exactly one ' + JSON.stringify(before)
      + ', found ' + count + '. Re-read the template before adapting it again'
      + ' (a tree patched by the old beforePack hook needs `pnpm install --force`).')
  }
  return source.replace(before, () => after)
}

/**
 * Keep electron-builder's registration, shortcuts and uninstall UI; replace how
 * the payload lands.
 * @param {string} source pristine installSection.nsh
 */
export function directoryInstallSection(source) {
  let result = source.replaceAll('\r\n', '\n')
  // The InstFiles list stays visible (resources/installer.nsh keeps it open).
  result = replaceOnce(result, '  SetDetailsPrint none\n', '  SetDetailsPrint both\n')
  // Settle $INSTDIR (recovered/explicit directory) before $appExe captures it.
  result = replaceOnce(result, 'StrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    '!insertmacro customPrepareUpgrade\n\nStrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
  result = replaceOnce(result, '!include installer.nsh\n', `!include installer.nsh
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro dshExtractPayload "\${FILE}"
!macroend
; A same-directory upgrade is replaced by rename; only a different directory or
; install scope still needs the previous version's uninstaller.
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro readReg $R4 "\${ROOT_KEY}" "\${INSTALL_REGISTRY_KEY}" InstallLocation
  \${If} $R4 == $INSTDIR
    StrCpy $R0 0
    ClearErrors
  \${Else}
    Push "\${ROOT_KEY}"
    Call uninstallOldVersion
  \${EndIf}
!macroend
`)
  result = replaceOnce(result, '!insertmacro setLinkVars\n', '!insertmacro setLinkVars\n!insertmacro dshStageApplication\n')
  result = replaceOnce(result, '!insertmacro installApplicationFiles\n',
    'Call dshPromoteDirectories\n${If} ${Errors}\n  SetErrorLevel 2\n  Quit\n${EndIf}\n')
  // Staging writes the icon into the new directory instead.
  result = replaceOnce(result, '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif\n', '')
  return result
}

/**
 * Every Quit electron-builder can take after staging must clean up first: a
 * silent install never reaches .onGUIEnd.
 * @param {string} source
 */
export function directoryInstallerExits(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const quit = /^(\s*)Quit\s*$/gm
  if (!quit.test(normalized)) throw new Error('electron-builder NSIS template changed: no Quit left to guard')
  return normalized.replaceAll(quit, '$1!ifndef BUILD_UNINSTALLER\n$1Call dshCleanupDirectories\n$1!endif\n$1Quit')
}

/**
 * Keep an unchanged recovered directory as it is instead of appending the
 * product name to it, so a renamed product upgrades where it was installed.
 * @param {string} source pristine assistedInstaller.nsh
 * @param {string} multiUserUi absolute path of the adapted multiUserUi.nsh
 */
export function directoryAssistedInstaller(source, multiUserUi) {
  let result = source.replaceAll('\r\n', '\n')
  result = replaceOnce(result, '  !include multiUserUi.nsh\n', `  !include "${multiUserUi}"\n`)
  return replaceOnce(result, `\
    Function instFilesPre
      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR
      \${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"
      \${endIf}
    FunctionEnd`, `\
    Function instFilesPre
      !insertmacro dshRestoreUnchangedInstallTarget
      \${If} $dshRecoveredInstallDir != ""
      \${AndIf} $INSTDIR == $dshRecoveredInstallDir
        Return
      \${EndIf}
      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR
      \${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"
      \${EndIf}
    FunctionEnd`)
}

/**
 * The install-mode page reloads InstallLocation when left; repair an unchanged
 * broken value before the directory page shows it.
 * @param {string} source pristine multiUserUi.nsh
 */
export function directoryMultiUserUi(source) {
  return replaceOnce(source.replaceAll('\r\n', '\n'), '\t\t!insertmacro MUI_PAGE_FUNCTION_CUSTOM LEAVE\n',
    '\t\t!insertmacro customInstallModeLeave\n\n\t\t!insertmacro MUI_PAGE_FUNCTION_CUSTOM LEAVE\n')
}

/**
 * Adapt every template for one script and point the script at the copies.
 * @param {string} script installer.nsi as NsisTarget passes it
 * @param {string} directory where the adapted copies go
 * @param {{ templates?: string, write?: (path: string, text: string) => Promise<void> }} [options]
 */
export async function adaptInstallerScript(script, directory, options = {}) {
  const templates = options.templates ?? join(appBuilderLibDir(), 'templates', 'nsis')
  const write = options.write ?? ((path, text) => writeFile(path, text, 'utf8'))
  const read = path => readFile(path, 'utf8')
  let adapted = script.replaceAll('\r\n', '\n')

  const section = join(directory, 'installSection.nsh')
  await write(section, directoryInstallSection(await read(join(templates, 'installSection.nsh'))))
  adapted = replaceOnce(adapted, '!include "installSection.nsh"', `!include "${section}"`)

  for (const helper of ['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh']) {
    const path = join(directory, helper)
    await write(path, directoryInstallerExits(await read(join(templates, 'include', helper))))
    adapted = replaceOnce(adapted, `!include "${helper}"`, `!include "${path}"`)
  }

  const multiUserUi = join(directory, 'multiUserUi.nsh')
  await write(multiUserUi, directoryMultiUserUi(await read(join(templates, 'multiUserUi.nsh'))))
  const assisted = join(directory, 'assistedInstaller.nsh')
  await write(assisted, directoryAssistedInstaller(await read(join(templates, 'assistedInstaller.nsh')), multiUserUi))
  adapted = replaceOnce(adapted, '!include "assistedInstaller.nsh"', `!include "${assisted}"`)
  return adapted
}

/** Install the adapter on electron-builder's NsisTarget for this process. */
export function installWindowsDirectoryInstaller() {
  const require = builderRequire()
  // The package entry initialises the platform classes before their leaves.
  require('app-builder-lib')
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js')
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
  const prototype = NsisTarget.prototype
  if (prototype[patched]) return
  prototype[patched] = true
  const compute = prototype.computeFinalScript
  prototype.computeFinalScript = async function (source, ...args) {
    if (this.isPortable) return compute.call(this, source, ...args)
    const directory = join(this.outDir, '.nsis-directory-installer')
    await mkdir(directory, { recursive: true })
    const sourceTool = await getPath7za()
    const tool = join(directory, '7za.exe')
    await copyFile(sourceTool, tool)
    await this.packager.signIf(tool)
    const adapted = await adaptInstallerScript(source, directory)
    // The 7-Zip toolset keeps LICENSE.txt and COPYING beside bin/7za.exe.
    return '!define DSH_SEVENZIP_PATH "' + tool + '"\n'
      + '!define DSH_SEVENZIP_LICENSE_DIR "' + dirname(dirname(sourceTool)) + '"\n'
      + await compute.call(this, adapted, ...args)
  }
}

/** @returns {Promise<string[]>} */
export async function checkWindowsDirectoryInstaller() {
  const failures = []
  const describe = error => (error instanceof Error ? error.message : String(error))

  const builderYml = readFileSync(join(APP_DIR, 'electron-builder.yml'), 'utf8')
  if (!builderYml.includes('beforePack: ' + BEFORE_PACK)) failures.push('electron-builder.yml does not hook ' + BEFORE_PACK)
  if (!builderYml.includes('include: ' + INCLUDE_PATH)) failures.push('electron-builder.yml does not include ' + INCLUDE_PATH)

  const installerNsh = readFileSync(join(APP_DIR, INCLUDE_PATH), 'utf8')
  for (const requirement of [
    'ShowInstDetails show',
    'installer-directories.nsh',
    '!macro customPrepareUpgrade',
    '!macro customInstallModeLeave',
    '!macro dshRestoreUnchangedInstallTarget',
    '!insertmacro dshFinishDirectories',
    // Without these a failed legacy uninstall reaches electron-builder's own
    // MessageBox, which has no /SD default and hangs every silent install.
    '!macro customUnInstallCheck',
    '!macro customUnInstallCheckCurrentUser',
    // A different-directory upgrade still runs this version's uninstaller
    // with --updated; skip the atomic-rename detour issue #11 dies on.
    '!macro customRemoveFiles',
    'CreateShortCut "$newDesktopLink"',
  ]) {
    if (!installerNsh.includes(requirement)) failures.push('resources/installer.nsh is missing: ' + requirement)
  }

  // Every adaptation against the templates electron-builder will really use.
  const templates = join(appBuilderLibDir(), 'templates', 'nsis')
  /** @type {Map<string, string>} */
  const written = new Map()
  try {
    const script = await readFile(join(templates, 'installer.nsi'), 'utf8')
    const adapted = await adaptInstallerScript(script, 'X:\\adapted', {
      templates,
      write: async (path, text) => { written.set(path, text) },
    })
    for (const name of ['installSection.nsh', 'allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh', 'assistedInstaller.nsh']) {
      if (!adapted.includes(`!include "X:\\adapted\\${name}"`) && !adapted.includes(`!include "X:\\adapted/${name}"`)) {
        failures.push('installer.nsi does not include the adapted ' + name)
      }
    }
    const section = [...written].find(([path]) => path.endsWith('installSection.nsh'))?.[1] ?? ''
    for (const marker of ['SetDetailsPrint both', '!insertmacro dshStageApplication', 'Call dshPromoteDirectories',
      '!insertmacro dshExtractPayload', '!insertmacro customPrepareUpgrade']) {
      if (!section.includes(marker)) failures.push('adapted installSection.nsh lacks ' + marker)
    }
    if (section.includes('!insertmacro installApplicationFiles')) {
      failures.push('adapted installSection.nsh still merges files into $INSTDIR')
    }
    // Staging must run before the running-app check and the old uninstaller.
    if (section.indexOf('dshStageApplication') > section.indexOf('CHECK_APP_RUNNING')
      || section.indexOf('dshStageApplication') > section.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT')) {
      failures.push('adapted installSection.nsh stages after the app check or the old uninstaller')
    }
    for (const [path, text] of written) {
      if (!/(allowOnlyOneInstallerInstance|installUtil)\.nsh$/.test(path)) continue
      const bare = text.split('\n').filter((line, index, lines) => /^\s*Quit\s*$/.test(line)
        && !/^\s*!endif\s*$/.test(lines[index - 1] ?? ''))
      if (bare.length > 0) failures.push(path + ' keeps a Quit that skips directory cleanup')
    }
  } catch (error) {
    failures.push(describe(error))
  }

  // The lock itself: an anchor that moved, or now appears twice, is refused.
  for (const [what, source] of [['missing', 'nothing here\n'], ['duplicated', '!include installer.nsh\n!include installer.nsh\n']]) {
    try {
      directoryInstallSection(source)
      failures.push('a template with a ' + what + ' anchor was adapted anyway')
    } catch (error) {
      if (!describe(error).includes('template changed')) throw error
    }
  }
  return failures
}

/**
 * electron-builder's beforePack hook; runs in electron-builder's process.
 * @param {{ electronPlatformName: string }} context
 */
export default function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return
  installWindowsDirectoryInstaller()
  console.log('✓ NSIS installer extracts beside the install directory and swaps it by rename')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await checkWindowsDirectoryInstaller()
  if (failures.length > 0) {
    for (const failure of failures) console.log('✗ ' + failure)
    console.log('Reconcile resources/installer.nsh, scripts/installer-directories.nsh, electron-builder.yml'
      + ' and scripts/windows-directory-installer.mjs with the installed electron-builder templates.')
    process.exit(1)
  }
  console.log('✓ electron-builder NSIS templates accept every directory-installer adaptation exactly once')
  console.log('✓ electron-builder.yml hooks ' + BEFORE_PACK + ' and includes ' + INCLUDE_PATH)
}
