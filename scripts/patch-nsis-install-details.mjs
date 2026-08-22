/**
 * Patch and verify the Windows NSIS install/upgrade experience.
 *
 * electron-builder packs the app as a 7z and extracts it with Nsis7z. Its
 * templates then silence the InstFiles list (`SetDetailsPrint none`), which is
 * why the wizard sits on a green bar with a blank panel underneath. There is
 * no supported switch for this; the templates have to be edited before pack.
 *
 * The same templates also stage the whole app through `$PLUGINSDIR\7z-out` and
 * copy it into `$INSTDIR` afterwards, which writes every packaged file twice.
 * `FAST_EXTRACT_PROLOGUE` below adds a direct-extract path in front of that
 * staging without removing it: the fast path runs only into an empty $INSTDIR,
 * and anything else falls through to electron-builder's own body, retries and
 * all. See its comment for the reasoning and PRISTINE_EXTRACT_MACRO_SHA256 for
 * how an upstream change to that body is caught.
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

import { createHash } from 'node:crypto'
import { chmodSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const INSTALLER_NSH = join(APP_DIR, 'resources', 'installer.nsh')
const BUILDER_YML = join(APP_DIR, 'electron-builder.yml')
const RUNTIME_MODULES = join(APP_DIR, '.runtime', 'node_modules')
/**
 * Where extraResources puts `.runtime/node_modules` inside the packaged tree.
 * Kept in step with electron-builder.yml; smoke-package.mjs is what proves the
 * two still agree, by re-deriving the longest path from the packed output.
 */
export const RUNTIME_PACKED_PREFIX = 'resources\\dsh-runtime\\node_modules\\'
/** Records the budget beforePack computed, for smoke-package.mjs to check. */
export const PATH_BUDGET_FILE = join(APP_DIR, '.build', 'nsis-path-budget.json')

const BEFORE_PACK = 'scripts/patch-nsis-install-details.mjs'
const INCLUDE_PATH = 'resources/installer.nsh'

/** Shown once, before 7-Zip starts reporting percent. */
export const EXTRACTING_STAGE = '正在解压应用文件 / Extracting application files'
/** `Nsis7z::ExtractWithDetails` format; `%s` becomes e.g. `37% (120 / 320 MB)`. */
export const EXTRACT_PROGRESS = '正在解压 / Extracting %s...'
/** Shown before the silent copy from the 7z temp dir into $INSTDIR. */
export const COPYING_STAGE = '正在复制文件到安装目录 / Copying files to the installation folder'
/** The fast path declined: $INSTDIR still holds files the uninstall could not remove. */
export const DIRTY_OUTDIR_STAGE = '安装目录仍有残留文件，改用可重试的暂存复制'
  + ' / Install folder still has leftovers; using the retrying staged copy'
/** The fast path was taken and reported an error partway through. */
export const DIRECT_FAILED_STAGE = '直接解压未完成，改用可重试的暂存复制'
  + ' / Direct extraction did not finish; using the retrying staged copy'
/** The fast path declined: $INSTDIR is deep enough that the longest packed path would exceed MAX_PATH. */
export const LONG_INSTDIR_STAGE = '安装路径较深，改用支持长路径的暂存复制'
  + ' / Install path is deep; using the staged copy, which reaches past MAX_PATH'

const EXTRACT_COMMAND = 'Nsis7z::Extract "${FILE}"'
const EXTRACT_WITH_DETAILS = 'Nsis7z::ExtractWithDetails "${FILE}" "' + EXTRACT_PROGRESS + '"'
const COPY_FILES = 'CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR'
const SET_OUT_PATH_7Z = 'SetOutPath "$PLUGINSDIR\\7z-out"'
const EXTRACT_MACRO_OPEN = '!macro extractUsing7za FILE'
const MACRO_END = '!macroend'

/**
 * SHA-256 of electron-builder 26.15.3's pristine `extractUsing7za` body, from
 * `!macro` through `!macroend`, with line endings normalized to LF.
 *
 * The fast path below runs *instead of* that body whenever $INSTDIR is empty,
 * so anything upstream adds to it — a new integrity check, a new cleanup step —
 * would be skipped on the overwhelmingly common install. Anchoring on a couple
 * of landmark lines cannot notice that: a body with an extra step still has its
 * `SetOutPath` and its `CopyFiles`. Pinning the whole body does notice, and
 * turns "upstream changed this macro" into a red release job that makes someone
 * re-read it and decide, instead of a silent behaviour change.
 *
 * Re-derive with `pnpm run check:nsis-details` after bumping electron-builder:
 * the failure prints the hash actually found.
 */
export const PRISTINE_EXTRACT_MACRO_SHA256 =
  'f4f4d581a1de189c21c7026a828612f7f2ebb7750e88bf7b4aff797d6fc1df4e'

/**
 * A direct-extract fast path spliced in *ahead of* electron-builder's body,
 * which is left exactly as upstream wrote it.
 *
 * Why the fast path: upstream extracts the app 7z into `$PLUGINSDIR\7z-out`
 * and then `CopyFiles`-es the tree into `$OUTDIR`, so every packaged file is
 * written twice. This product ships ~11500 of them and the installer pays per
 * file, not per byte — locally 283 MB in 20 files copies in 0.3 s while 124 MB
 * in 12508 files takes 11.6 s — so the staging copy is most of the install. A
 * measured A/B on one machine: 105.7 s and 498.8 MB of peak TEMP before,
 * 36.7 s and 94.5 MB after.
 *
 * Why it is guarded rather than unconditional: the staging copy exists so a
 * target file that will not budge can be retried, and `customRemoveFiles` in
 * resources/installer.nsh deliberately does not guarantee an empty $INSTDIR —
 * it runs `RMDir /r`, which skips whatever is locked and reports nothing. An
 * upgrade that leaves a locked file behind would make a bare direct extract
 * fail with the old version already uninstalled, i.e. an unbootable half
 * install. So the fast path is taken only when $OUTDIR is genuinely empty, and
 * a mid-extract error falls through as well: both land on upstream's retry
 * loop, its Retry/Cancel prompt and its last-resort re-extract, unchanged.
 *
 * $OUTDIR is $INSTDIR here — installSection.nsh sets it immediately before
 * `installApplicationFiles` — and Nsis7z extracts into $OUTDIR, so the fast
 * path needs no path of its own and the `Goto` skips upstream's `Push $OUTDIR`
 * and its matching `Pop` together, leaving the stack balanced.
 *
 * `Var /GLOBAL` inside a macro is what upstream already does for `$packageArch`
 * one macro above. The scan uses $R2/$R3 behind a Push/Pop pair so it cannot
 * disturb the $R0/$R1 upstream's body uses.
 *
 * If a future config defines UNINSTALLER_ICON, installSection.nsh writes
 * uninstallerIcon.ico into $INSTDIR before this runs and the fast path stops
 * firing — correct, just slow. The install timing printed by the Windows smoke
 * step in ci.yml/release.yml is what surfaces that.
 */
// Matched as prefixes, and deliberately carrying no version-specific text: a
// tree patched by an older revision of this file has to be recognisable so its
// prologue can be lifted out and replaced. Recognising only the current text
// would leave the old one in place, which is how a stale guard survives a
// rebuild — the prologue's shape changes more often than these two markers.
const FAST_PATH_MARK_BEGIN = '# >>> dsh direct extract'
const FAST_PATH_MARK_END = '# <<< dsh direct extract'
const FAST_PATH_BEGIN = FAST_PATH_MARK_BEGIN + ' — ' + BEFORE_PACK
const FAST_PATH_END = FAST_PATH_MARK_END + " — electron-builder's body follows, unchanged"
const FAST_EXTRACT_DONE_LABEL = '  dshExtractDone:'
/** Longest usable Windows path without the `\\?\` prefix: MAX_PATH minus the NUL. */
export const MAX_PATH_USABLE = 259
/**
 * `$OUTDIR` length budget, spliced into the template by beforePack once the
 * packed tree's longest relative path is known.
 * @param {number} longestRelativePath
 * @returns {number}
 */
export function fastPathInstDirBudget(longestRelativePath) {
  return MAX_PATH_USABLE - 1 - longestRelativePath
}

/**
 * The second thing the staging copy was doing, which cost a full day to find:
 * it keeps every write inside MAX_PATH. `$PLUGINSDIR\7z-out\` is ~50 characters,
 * so 7-Zip never approaches the limit, and the `CopyFiles` that follows goes
 * through SHFileOperation, which reaches targets past 260 that 7-Zip cannot.
 *
 * Extract straight into a deep `$INSTDIR` and the longest paths simply do not
 * arrive — and Nsis7z does not set the error flag when that happens, so the
 * installer exits 0 with a tree that is quietly missing files. Measured on this
 * product: every packed path landing at 259 characters or less was written,
 * every one at 260 or more was dropped, and `smoke:package` stayed green
 * because the four casualties were platform variants Windows never loads.
 *
 * So the fast path needs both guards. `$OUTDIR` must be empty *and* short
 * enough that the deepest packed file still fits; anything else goes to the
 * staged copy, which handles both. DSH_FAST_PATH_INSTDIR_BUDGET is written in
 * by beforePack from the tree about to be packed, so it tracks the dependency
 * closure instead of being a constant that silently rots — and
 * scripts/smoke-package.mjs re-derives the real number from the packed output
 * and fails the build if the budget was computed against anything shorter.
 *
 * For scale: the default per-user target
 * `C:\\Users\\<name>\\AppData\\Local\\Programs\\DSH Desktop` is 49 characters
 * for a 5-character user name, against a 188-character deepest path — 238
 * total, comfortably inside. A pre-rename install directory, or a user name
 * past ~26 characters, is what tips over into the staged copy.
 */
const BUDGET_TOKEN = '__DSH_FAST_PATH_INSTDIR_BUDGET__'
const FAST_EXTRACT_PROLOGUE = `\
  ${FAST_PATH_BEGIN}
  # Two conditions, both required. $OUTDIR must be empty, because a direct
  # extract has no retry for a file it cannot overwrite; and $OUTDIR must be
  # short enough that the deepest packed path still fits inside MAX_PATH,
  # because 7-Zip drops what does not fit and reports no error at all.
  Var /GLOBAL dshOutDirState
  Push $R2
  Push $R3
  StrCpy $dshOutDirState "empty"
  FindFirst $R2 $R3 "$OUTDIR\\*.*"
  dshScanEntry:
    StrCmp $R3 "" dshScanDone
    StrCmp $R3 "." dshScanNext
    StrCmp $R3 ".." dshScanNext
    StrCpy $dshOutDirState "dirty"
    Goto dshScanDone
  dshScanNext:
    FindNext $R2 $R3
    Goto dshScanEntry
  dshScanDone:
  FindClose $R2
  StrLen $R2 $OUTDIR
  \${If} $R2 > ${BUDGET_TOKEN}
    StrCpy $dshOutDirState "toolong"
  \${EndIf}
  Pop $R3
  Pop $R2

  \${If} $dshOutDirState == "empty"
    ClearErrors
    DetailPrint "${EXTRACTING_STAGE}"
    ${EXTRACT_WITH_DETAILS}
    \${IfNot} \${Errors}
      Goto dshExtractDone
    \${EndIf}
    DetailPrint "${DIRECT_FAILED_STAGE}"
  \${ElseIf} $dshOutDirState == "toolong"
    DetailPrint "${LONG_INSTDIR_STAGE}"
  \${Else}
    DetailPrint "${DIRTY_OUTDIR_STAGE}"
  \${EndIf}
  ${FAST_PATH_END}`.replaceAll('\r\n', '\n')
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
 * Locate the `extractUsing7za` macro, which is the last one in the template.
 * Returns null when the template no longer has exactly one such macro, or when
 * the macro is not closed — both are shapes the caller must refuse to patch.
 *
 * @param {string} extractAppPackage
 * @returns {{ start: number, end: number, body: string } | null}
 */
function findExtractMacro(extractAppPackage) {
  if (countOccurrences(extractAppPackage, EXTRACT_MACRO_OPEN) !== 1) return null
  const start = extractAppPackage.indexOf(EXTRACT_MACRO_OPEN)
  const endIndex = extractAppPackage.indexOf(MACRO_END, start + EXTRACT_MACRO_OPEN.length)
  if (endIndex === -1) return null
  const end = endIndex + MACRO_END.length
  return { start, end, body: extractAppPackage.slice(start, end) }
}

/**
 * Longest relative path under `directory`, in characters, using backslashes so
 * the count matches what Windows will write.
 *
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {number}
 */
export function longestRelativePath(directory, prefix = '') {
  let longest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Symlinks are not followed: extraResources copies them as they are, and
    // descending would measure the target's depth instead of the packed one.
    if (entry.isSymbolicLink()) continue
    const next = prefix + entry.name
    if (entry.isDirectory()) {
      longest = Math.max(longest, longestRelativePath(join(directory, entry.name), next + '\\'))
    } else if (entry.isFile()) {
      longest = Math.max(longest, next.length)
    }
  }
  return longest
}

/**
 * The `$OUTDIR` budget the fast path is allowed to use, derived from the tree
 * that is about to be packed rather than pinned to a number that would rot as
 * the dependency closure moves.
 *
 * Only the bundled runtime is measured: everything else in the packed tree —
 * Electron's own files, app.asar, the locale packs — sits far shallower, and
 * smoke-package.mjs re-derives the real maximum from the packed output so a
 * future layout that breaks that assumption fails the build instead of
 * quietly handing the fast path a budget that is too generous.
 *
 * @returns {{ longestPackedPath: number, budget: number }}
 */
export function computePathBudget() {
  const longest = longestRelativePath(RUNTIME_MODULES, RUNTIME_PACKED_PREFIX)
  if (longest === 0) {
    throw new Error('no files under ' + RUNTIME_MODULES + ' — run `pnpm run prepare:runtime` before packaging')
  }
  return { longestPackedPath: longest, budget: fastPathInstDirBudget(longest) }
}

/** @param {string} body @returns {string} */
export function macroBodyHash(body) {
  return createHash('sha256').update(body.replaceAll('\r\n', '\n'), 'utf8').digest('hex')
}

/**
 * Undo the details edits so a tree that already ran a build on this repository
 * still hashes to the pristine upstream body. All three edits are exactly
 * reversible: two literal command substitutions and two inserted whole lines.
 *
 * @param {string} body
 * @returns {string}
 */
function withoutDetailsEdits(body) {
  return body
    .replaceAll(EXTRACT_WITH_DETAILS, EXTRACT_COMMAND)
    .split('\n')
    .filter(line => !line.includes(EXTRACTING_STAGE) && !line.includes(COPYING_STAGE))
    .join('\n')
}

/**
 * @param {string} extractAppPackage
 * @returns {boolean}
 */
export function hasFastExtractMark(extractAppPackage) {
  return extractAppPackage.includes(FAST_PATH_MARK_BEGIN)
}

/** The prologue this revision expects, for a given `$OUTDIR` budget. */
function expectedPrologue(budget) {
  return FAST_EXTRACT_PROLOGUE.replace(BUDGET_TOKEN, String(budget))
}

/**
 * True only when the prologue present is byte-identical to the one this
 * revision emits for `budget`. The marker alone is not enough: a template left
 * by an older revision carries the marker with a different body, and treating
 * that as "already patched" is exactly how a guard that no longer matches the
 * shipped closure survives a rebuild.
 *
 * @param {string} extractAppPackage
 * @param {number} budget
 * @returns {boolean}
 */
export function isFastExtractPatched(extractAppPackage, budget) {
  return extractAppPackage.replaceAll('\r\n', '\n').includes(expectedPrologue(budget))
}

/**
 * Lift a previously spliced prologue back out, leaving electron-builder's body
 * as it was. What proves the removal was clean is the hash pin that runs next:
 * a body that does not hash to pristine after this refuses to be patched.
 *
 * @param {string} extractAppPackage
 * @returns {string}
 */
function stripFastExtract(extractAppPackage) {
  const eol = lineBreak(extractAppPackage)
  const beginMark = extractAppPackage.indexOf(FAST_PATH_MARK_BEGIN)
  if (beginMark === -1) return extractAppPackage
  const endMark = extractAppPackage.indexOf(FAST_PATH_MARK_END, beginMark)
  if (endMark === -1) {
    throw new Error('extractAppPackage.nsh has a ' + FAST_PATH_MARK_BEGIN + ' with no matching '
      + FAST_PATH_MARK_END + '; remove the file and reinstall app-builder-lib')
  }
  // Whole lines, including the newline that ends the closing marker's line.
  const from = extractAppPackage.lastIndexOf('\n', beginMark) + 1
  const endOfLine = extractAppPackage.indexOf('\n', endMark)
  const to = endOfLine === -1 ? extractAppPackage.length : endOfLine + 1
  let stripped = extractAppPackage.slice(0, from) + extractAppPackage.slice(to)
  const label = FAST_EXTRACT_DONE_LABEL + eol
  if (stripped.includes(label)) stripped = stripped.replace(label, '')
  return stripped
}

/**
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @returns {boolean}
 */
export function isNsisDetailsPatched(installSection, extractAppPackage, budget) {
  return installSection.includes('SetDetailsPrint both')
    && !installSection.includes('SetDetailsPrint none')
    && isFastExtractPatched(extractAppPackage, budget)
    && extractAppPackage.includes(COPYING_STAGE)
}

/**
 * The fast path runs *instead of* upstream's body, so landmark lines are not a
 * strong enough gate: a body with an extra safety step still has its
 * `SetOutPath` and its `CopyFiles`, and splicing in front of it would quietly
 * skip that step on every clean install. Pin the whole body instead.
 *
 * @param {string} extractAppPackage
 * @returns {string[]}
 */
function fastExtractBlockers(extractAppPackage) {
  const macro = findExtractMacro(extractAppPackage)
  if (macro === null) {
    return ['extractAppPackage.nsh no longer has exactly one closed ' + EXTRACT_MACRO_OPEN]
  }
  const hash = macroBodyHash(withoutDetailsEdits(macro.body))
  if (hash !== PRISTINE_EXTRACT_MACRO_SHA256) {
    return ['extractAppPackage.nsh extractUsing7za is not the pinned electron-builder body'
      + ' (sha256 ' + hash + ', expected ' + PRISTINE_EXTRACT_MACRO_SHA256 + ').'
      + ' Re-read the macro: anything it gained now gets skipped whenever $INSTDIR is empty.'
      + ' Once that is still acceptable, update PRISTINE_EXTRACT_MACRO_SHA256 and'
      + ' FIXTURE_EXTRACT_APP together.']
  }
  return []
}

/**
 * Each half is judged on its own so a developer tree that carries only one of
 * them (an earlier revision of this patch, or a partially reinstalled
 * app-builder-lib) still migrates to the current pair.
 *
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @returns {string[]}
 */
export function nsisDetailsPatchBlockers(installSection, extractAppPackage) {
  const failures = []
  if (!installSection.includes('SetDetailsPrint none')
    && !installSection.includes('SetDetailsPrint both')) {
    failures.push('installSection.nsh no longer contains SetDetailsPrint none')
  }
  // Always judge electron-builder's body, never our own prologue on top of it:
  // a template already carrying a prologue is checked by what is left once that
  // prologue is lifted out, which is also what proves the lift was clean.
  failures.push(...fastExtractBlockers(stripFastExtract(extractAppPackage)))
  return failures
}

/**
 * Splice the fast path in front of upstream's body and add the label it jumps
 * to, leaving every line electron-builder wrote exactly where it was.
 *
 * @param {string} extractAppPackage
 * @returns {string}
 */
function spliceFastExtract(extractAppPackage, budget) {
  const macro = findExtractMacro(extractAppPackage)
  if (macro === null) throw new Error('extractAppPackage.nsh extractUsing7za disappeared mid-patch')
  const eol = lineBreak(extractAppPackage)
  const afterOpen = macro.start + EXTRACT_MACRO_OPEN.length
  const beforeMacroEnd = macro.end - MACRO_END.length
  const prologue = FAST_EXTRACT_PROLOGUE.replace(BUDGET_TOKEN, String(budget))
  if (prologue.includes(BUDGET_TOKEN)) {
    throw new Error('fast path prologue still carries ' + BUDGET_TOKEN)
  }
  return extractAppPackage.slice(0, afterOpen)
    + eol + withLineBreak(prologue, eol)
    + extractAppPackage.slice(afterOpen, beforeMacroEnd)
    + FAST_EXTRACT_DONE_LABEL + eol
    + extractAppPackage.slice(beforeMacroEnd)
}

/**
 * @param {string} installSection
 * @param {string} extractAppPackage
 * @param {number} budget `$OUTDIR` length the fast path may still use.
 * @returns {{ installSection: string, extractAppPackage: string, changed: boolean }}
 */
export function patchNsisDetailsTemplates(installSection, extractAppPackage, budget) {
  if (!Number.isInteger(budget)) {
    throw new Error('patchNsisDetailsTemplates needs an integer $OUTDIR budget, got ' + String(budget))
  }
  if (isNsisDetailsPatched(installSection, extractAppPackage, budget)) {
    return { installSection, extractAppPackage, changed: false }
  }
  const blockers = nsisDetailsPatchBlockers(installSection, extractAppPackage)
  if (blockers.length > 0) {
    throw new Error('electron-builder NSIS templates changed; cannot enable install details:\n- '
      + blockers.join('\n- '))
  }

  const nextInstall = installSection.includes('SetDetailsPrint none')
    ? installSection.replace('SetDetailsPrint none', 'SetDetailsPrint both')
    : installSection
  // Any prologue already present is replaced wholesale rather than edited in
  // place. It may have come from an older revision with a different guard, or
  // from a build whose dependency closure was shallower and so allowed a longer
  // $INSTDIR; either way, only re-splicing guarantees the guard that ships is
  // the one this file describes.
  let nextExtract = stripFastExtract(extractAppPackage)
  nextExtract = spliceFastExtract(nextExtract, budget)
  // Upstream's body keeps its own progress lines: the staged copy is a real
  // fallback, not a formality, and the wizard has to say what it is doing there
  // too. The fast path's own `Nsis7z::ExtractWithDetails` is not matched by
  // EXTRACT_COMMAND, so the count below stays at upstream's two.
  if (!nextExtract.includes(COPYING_STAGE)) {
    nextExtract = replaceAllCounted(nextExtract, EXTRACT_COMMAND, EXTRACT_WITH_DETAILS, 2)
    nextExtract = insertLineAfter(nextExtract, SET_OUT_PATH_7Z, 'DetailPrint "' + EXTRACTING_STAGE + '"')
    nextExtract = insertLineBefore(nextExtract, COPY_FILES, 'DetailPrint "' + COPYING_STAGE + '"')
  }
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
  const { longestPackedPath, budget } = computePathBudget()
  const installSection = readFileSync(paths.installSection, 'utf8')
  const extractAppPackage = readFileSync(paths.extractAppPackage, 'utf8')
  const assistedInstaller = readFileSync(paths.assistedInstaller, 'utf8')
  const installUtil = readFileSync(paths.installUtil, 'utf8')
  const multiUserUi = readFileSync(paths.multiUserUi, 'utf8')
  const details = patchNsisDetailsTemplates(installSection, extractAppPackage, budget)
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
  // What the budget was computed against, so smoke-package.mjs can re-derive
  // the real longest path from the packed output and refuse a budget that was
  // measured against a shallower tree than the one actually shipped.
  writeFileSync(PATH_BUDGET_FILE, JSON.stringify({
    longestPackedPath,
    budget,
    maxPathUsable: MAX_PATH_USABLE,
    measuredFrom: RUNTIME_PACKED_PREFIX,
  }, null, 2) + '\n', 'utf8')
  return { changed: details.changed || upgrade.changed || upgradeSection.changed, paths, longestPackedPath, budget }
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

  const FIXTURE_BUDGET = 70
  const fixture = patchNsisDetailsTemplates(FIXTURE_INSTALL_SECTION, FIXTURE_EXTRACT_APP, FIXTURE_BUDGET)
  if (!fixture.changed) failures.push('fixture templates were already patched')
  if (!fixture.installSection.includes('SetDetailsPrint both')) {
    failures.push('fixture installSection.nsh was not switched to SetDetailsPrint both')
  }
  // Three extracts now: the fast path's, plus upstream's two, all with details.
  if (countOccurrences(fixture.extractAppPackage, EXTRACT_WITH_DETAILS) !== 3) {
    failures.push('fixture extractAppPackage.nsh did not switch every 7-Zip extract to ExtractWithDetails')
  }
  if (!fixture.extractAppPackage.includes(EXTRACTING_STAGE) || !fixture.extractAppPackage.includes(COPYING_STAGE)) {
    failures.push('fixture extractAppPackage.nsh is missing stage DetailPrint lines')
  }
  // The fast path is spliced in front of upstream's body, never over it: a
  // wholesale replacement would silently drop anything electron-builder adds
  // there. Both landmarks must survive, and so must the retry loop they sit in.
  for (const survivor of [SET_OUT_PATH_7Z, COPY_FILES, 'LoopExtract7za:', 'AbortExtract7za:', 'Sleep 1000']) {
    if (!fixture.extractAppPackage.includes(survivor)) {
      failures.push('fixture extractAppPackage.nsh lost upstream line: ' + survivor)
    }
  }
  if (!fixture.extractAppPackage.includes(FAST_EXTRACT_DONE_LABEL)) {
    failures.push('fixture extractAppPackage.nsh has no label for the fast path to jump to')
  }
  // The fast path must be guarded: an unconditional direct extract into a
  // directory the uninstall could not empty is what leaves a half install.
  if (!fixture.extractAppPackage.includes('$dshOutDirState == "empty"')) {
    failures.push('fixture extractAppPackage.nsh takes the fast path without checking $OUTDIR is empty')
  }
  // And the second guard: 7-Zip silently drops packed paths that would land
  // past MAX_PATH, so a deep $OUTDIR has to reach the staged copy too.
  if (!fixture.extractAppPackage.includes('${If} $R2 > ' + FIXTURE_BUDGET)) {
    failures.push('fixture extractAppPackage.nsh does not compare $OUTDIR against the computed budget')
  }
  if (!fixture.extractAppPackage.includes('$dshOutDirState == "toolong"')) {
    failures.push('fixture extractAppPackage.nsh has no branch for an over-budget $OUTDIR')
  }
  for (const stage of [DIRTY_OUTDIR_STAGE, DIRECT_FAILED_STAGE, LONG_INSTDIR_STAGE]) {
    if (!fixture.extractAppPackage.includes(stage)) {
      failures.push('fixture extractAppPackage.nsh does not report why it fell back: ' + stage)
    }
  }
  const again = patchNsisDetailsTemplates(fixture.installSection, fixture.extractAppPackage, FIXTURE_BUDGET)
  if (again.changed) failures.push('patching already-patched templates was not a no-op')

  // Lifting the prologue back out has to restore electron-builder's body
  // exactly, because that is what every re-patch starts from.
  if (macroBodyHash(withoutDetailsEdits(
    /** @type {{ body: string }} */ (findExtractMacro(stripFastExtract(fixture.extractAppPackage))).body,
  )) !== PRISTINE_EXTRACT_MACRO_SHA256) {
    failures.push('removing the fast path did not restore the pristine upstream body')
  }

  // A template left by an earlier build must be re-stamped, not waved through.
  // Two ways that happens, and both were live bugs: the closure got deeper so
  // the budget shrank, and the prologue's own shape changed. Recognising only
  // the marker meant the old guard shipped unchanged.
  const restamped = patchNsisDetailsTemplates(fixture.installSection, fixture.extractAppPackage, FIXTURE_BUDGET - 5)
  if (!restamped.changed || !isFastExtractPatched(restamped.extractAppPackage, FIXTURE_BUDGET - 5)) {
    failures.push('a template carrying a stale $OUTDIR budget was not re-stamped')
  }
  const olderShape = fixture.extractAppPackage
    .replace('  StrLen $R2 $OUTDIR\n', '')
    .replace('${If} $R2 > ' + FIXTURE_BUDGET, '${If} $R2 > 999')
  const reshaped = patchNsisDetailsTemplates(fixture.installSection, olderShape, FIXTURE_BUDGET)
  if (!reshaped.changed || !isFastExtractPatched(reshaped.extractAppPackage, FIXTURE_BUDGET)) {
    failures.push('a template carrying an older-shaped fast path was not replaced')
  }
  if (reshaped.extractAppPackage.includes('$R2 > 999')) {
    failures.push('replacing an older-shaped fast path left the previous guard behind')
  }
  if (countOccurrences(reshaped.extractAppPackage, FAST_PATH_MARK_BEGIN) !== 1) {
    failures.push('replacing an older-shaped fast path did not leave exactly one prologue')
  }

  // The budget arithmetic itself: the deepest packed file must still fit.
  if (fastPathInstDirBudget(188) + 1 + 188 !== MAX_PATH_USABLE) {
    failures.push('fastPathInstDirBudget does not leave the longest packed path inside MAX_PATH')
  }

  // The pin and the fixture are two copies of one fact; assert they agree.
  if (macroBodyHash(FIXTURE_EXTRACT_APP) !== PRISTINE_EXTRACT_MACRO_SHA256) {
    failures.push('FIXTURE_EXTRACT_APP hashes to ' + macroBodyHash(FIXTURE_EXTRACT_APP)
      + ', but PRISTINE_EXTRACT_MACRO_SHA256 is ' + PRISTINE_EXTRACT_MACRO_SHA256)
  }
  // An upstream body that gained a step must be refused, not silently skipped.
  const tampered = FIXTURE_EXTRACT_APP.replace('  Push $OUTDIR\n',
    '  Push $OUTDIR\n  Call someNewUpstreamSafetyStep\n')
  if (nsisDetailsPatchBlockers(FIXTURE_INSTALL_SECTION, tampered).length === 0) {
    failures.push('an extractUsing7za body with an extra upstream step was accepted for patching')
  }
  // And a tree carrying only the older details patch must still migrate.
  const migrated = patchNsisDetailsTemplates(
    FIXTURE_INSTALL_SECTION, FIXTURE_DETAILS_ONLY_EXTRACT_APP, FIXTURE_BUDGET)
  if (!migrated.changed || !isFastExtractPatched(migrated.extractAppPackage, FIXTURE_BUDGET)) {
    failures.push('an extractAppPackage.nsh carrying only the details patch did not migrate')
  }

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

/**
 * electron-builder 26.15.3's `extractUsing7za`, byte for byte — this is the
 * body PRISTINE_EXTRACT_MACRO_SHA256 pins, and checkNsisInstallDetails asserts
 * the two agree, so neither can drift without the other being noticed.
 */
export const FIXTURE_EXTRACT_APP = `\
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\\7z-out"
  Nsis7z::Extract "\${FILE}"
  Pop $R0
  SetOutPath $R0

  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint \`Can't modify "\${PRODUCT_NAME}"'s files.\`
    \${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    \${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    \${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with \`Nsis7z::Extract\`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    RMDir /r "$PLUGINSDIR\\7z-out"

    Nsis7z::Extract "\${FILE}"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend`

/**
 * What a developer tree carries after building this repository before the fast
 * path existed: upstream's body with only the details edits applied. CI always
 * starts from a pristine app-builder-lib, so only a fixture proves this shape
 * still hashes back to pristine and migrates instead of demanding a reinstall.
 */
export const FIXTURE_DETAILS_ONLY_EXTRACT_APP = (() => {
  let text = replaceAllCounted(FIXTURE_EXTRACT_APP, EXTRACT_COMMAND, EXTRACT_WITH_DETAILS, 2)
  text = insertLineAfter(text, SET_OUT_PATH_7Z, 'DetailPrint "' + EXTRACTING_STAGE + '"')
  return insertLineBefore(text, COPY_FILES, 'DetailPrint "' + COPYING_STAGE + '"')
})()

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

/** Re-emit LF-normalized replacement text in the template's own EOL style. */
function withLineBreak(text, eol) {
  return eol === '\n' ? text : text.replaceAll('\n', eol)
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
  console.log('✓ direct-extract fast path allowed up to a ' + result.budget
    + '-character install directory (longest packed path ' + result.longestPackedPath
    + ' + 1 must stay within ' + MAX_PATH_USABLE + ')')
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
