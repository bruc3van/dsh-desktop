; Install by extracting next to $INSTDIR and swapping directories by rename.
;
; scripts/windows-directory-installer.mjs rewires electron-builder's install
; section around these macros:
;
;   dshStageApplication   right after setLinkVars, before the running-app check
;                         and before any old version is touched: extract the
;                         complete new tree into "$INSTDIR.new-<GUID>".
;   dshExtractPayload     replaces extractUsing7za: the bundled 7za.exe writes
;                         straight into that directory (long paths included).
;   dshPromoteDirectories replaces installApplicationFiles: rename the current
;                         directory to "$INSTDIR.old-<GUID>", rename the new one
;                         into place, roll back if either rename fails.
;   dshFinishDirectories  from customInstall, once registration is written:
;                         delete the backup.
;
; Nothing is merged into an existing tree, so an in-place upgrade leaves exactly
; the new version's files behind, and a failure before the swap leaves the old
; installation untouched. Every Quit electron-builder can reach after staging
; calls dshCleanupDirectories first (silent installs have no .onGUIEnd), which
; removes what this installer created and restores a moved backup.
;
; Installer-only: the uninstaller build includes resources/installer.nsh too.
!ifndef BUILD_UNINSTALLER
!include "LogicLib.nsh"

Var dshFinalDirectory
Var dshNewDirectory
Var dshOldDirectory
Var dshOldMoved
Var dshNewMoved
Var dshDirectoryError
Var dshDirectorySource
Var dshDirectoryDestination
Var dshRestoreError
Var dshRecoveryStopped

; MoveFileExW (no flags) never replaces an existing destination and reports the
; Windows error before rollback can change it. An empty DESTINATION removes the
; empty directory SOURCE instead; a missing one counts as removed. A file open
; inside the directory, or an antivirus scan of it, makes the rename fail with
; 5 (access denied), 32 or 33 (sharing/lock violation): those are retried ten
; times, waiting 250 ms longer each time (11.25 s in total). Anything else stops.
!macro dshDirectoryOperation SOURCE DESTINATION RESULT PHASE
  Push $0
  Push $1
  StrCpy $0 0
  ${Do}
    ${If} "${DESTINATION}" == ""
      System::Call 'kernel32::RemoveDirectoryW(w "${SOURCE}") i.r1 ?e'
    ${Else}
      System::Call 'kernel32::MoveFileExW(w "${SOURCE}", w "${DESTINATION}", i 0) i.r1 ?e'
    ${EndIf}
    Pop ${RESULT}
    ${If} "${DESTINATION}" == ""
      ${If} ${RESULT} == 2
      ${OrIf} ${RESULT} == 3
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    ${If} $1 != 0
      StrCpy ${RESULT} 0
      ${ExitDo}
    ${EndIf}
    DetailPrint "${PHASE}: Windows error ${RESULT}"
    ${If} ${RESULT} != 5
    ${AndIf} ${RESULT} != 32
    ${AndIf} ${RESULT} != 33
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
    ${If} $0 >= 10
      ${ExitDo}
    ${EndIf}
    IntOp $1 $0 * 250
    Sleep $1
  ${Loop}
  Pop $1
  Pop $0
!macroend

!macro dshReportDirectoryFailure
  ${If} $dshRestoreError != 0
    ; The backup is now the only complete copy; exit cleanup must leave it alone.
    StrCpy $dshRecoveryStopped "1"
    DetailPrint "旧版本备份保留在 / The previous version is kept at: $dshOldDirectory"
  ${EndIf}
  DetailPrint "替换安装目录失败 / Could not replace the installation folder (Windows error $dshDirectoryError): $dshDirectorySource -> $dshDirectoryDestination"
  MessageBox MB_OK|MB_ICONEXCLAMATION "替换安装目录失败（Windows 错误 $dshDirectoryError）。请关闭正在使用该目录的程序后重试。$\r$\nCould not replace the installation folder (Windows error $dshDirectoryError). Close any program using it and try again.$\r$\n$\r$\n$dshFinalDirectory" /SD IDOK
!macroend

!macro dshExtractPayload FILE
  DetailPrint "正在解压应用文件 / Extracting application files"
  ; The trailing "\." keeps a path ending in a backslash from escaping the quote.
  nsExec::ExecToStack '"$PLUGINSDIR\dsh-7za.exe" x -y -bd -bb0 -bso0 -bsp0 -bse1 "-o$INSTDIR\." "${FILE}"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "7-Zip ($R0): $R1"
    Call dshRollbackDirectories
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\r$\n7-Zip: $R0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  DetailPrint "应用文件已解压 / Application files extracted"
!macroend

; Leftovers of an installer that was killed or lost power: a staging directory
; is never the only copy of anything, a backup is only when the installation
; itself is missing.
!macro dshRemoveStaleDirectories PATTERN REQUIRE_INSTALL
  Push $0
  Push $1
  Push $2
  Push $INSTDIR
  Call GetFileParent
  Pop $2
  FindFirst $0 $1 "$INSTDIR${PATTERN}"
  ${DoWhile} $1 != ""
    ${If} "${REQUIRE_INSTALL}" == ""
    ${OrIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "删除上次未完成安装的残留 / Removing leftovers of an interrupted install: $2\$1"
      RMDir /r "\\?\$2\$1"
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  Pop $2
  Pop $1
  Pop $0
!macroend

; A new installation needs an empty (or missing) directory; replacing one is
; only allowed when it is this product's: registered as its install location,
; or holding its executable. Anything else is refused untouched, because the
; swap would otherwise move the folder's contents away and delete them.
!macro dshRequireReplaceableTarget
  Push $0
  Push $1
  Push $2
  StrCpy $2 "empty"
  FindFirst $0 $1 "$INSTDIR\*.*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      StrCpy $2 "occupied"
      ${ExitDo}
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  ${If} $2 == "occupied"
    ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $1 == $INSTDIR
    ${OrIf} $dshRecoveredInstallDir == $INSTDIR
    ${OrIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $2 "ours"
    ${EndIf}
  ${EndIf}
  ${If} $2 == "occupied"
    DetailPrint "安装目录非空且不是本产品的安装 / The installation folder is not empty and is not a ${PRODUCT_NAME} installation: $INSTDIR"
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装目录不是空文件夹，也不是现有的 ${PRODUCT_NAME} 安装。请选择一个空文件夹。$\r$\nThe installation folder is not empty and is not an existing ${PRODUCT_NAME} installation. Choose an empty folder.$\r$\n$\r$\n$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro dshStageApplication
  ; Release any handle NSIS holds on a directory this section is about to move.
  SetOutPath $PLUGINSDIR
  !insertmacro dshRequireReplaceableTarget
  !insertmacro dshRemoveStaleDirectories ".new-*" ""
  !insertmacro dshRemoveStaleDirectories ".old-*" "install"
  StrCpy $dshFinalDirectory $INSTDIR
  Push $0
  Push $1
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $dshNewDirectory "$INSTDIR.new-$0"
  StrCpy $dshOldDirectory "$INSTDIR.old-$0"
  Pop $1
  Pop $0
  StrCpy $dshOldMoved ""
  StrCpy $dshNewMoved ""
  StrCpy $dshDirectoryError 0
  StrCpy $dshRestoreError 0
  StrCpy $dshRecoveryStopped ""
  ClearErrors
  CreateDirectory $dshNewDirectory
  ${If} ${Errors}
    DetailPrint "无法创建暂存目录 / Could not create the staging folder: $dshNewDirectory"
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法创建暂存目录 / Could not create the staging folder:$\r$\n$dshNewDirectory" /SD IDOK
    StrCpy $dshNewDirectory ""
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\dsh-7za.exe "${DSH_SEVENZIP_PATH}"
  StrCpy $INSTDIR $dshNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  ; 7za.exe ships inside this installer; its licence travels with the app.
  File /oname=7zip-installer-LICENSE.txt "${DSH_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
  File /oname=7zip-installer-COPYING.txt "${DSH_SEVENZIP_LICENSE_DIR}\COPYING"
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $dshFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend

Function .onGUIEnd
  Call dshCleanupDirectories
FunctionEnd

Function dshCleanupDirectories
  ${If} $dshRecoveryStopped == "1"
    Return
  ${EndIf}
  ${If} $dshFinalDirectory != ""
    Call dshRollbackDirectories
  ${EndIf}
FunctionEnd

; Only directories this installer created or renamed are removed.
Function dshRollbackDirectories
  SetOutPath $PLUGINSDIR
  ${If} $dshNewMoved == "1"
    RMDir /r "\\?\$dshFinalDirectory"
    StrCpy $dshNewMoved ""
  ${EndIf}
  ${If} $dshOldMoved == "1"
    !insertmacro dshDirectoryOperation "$dshOldDirectory" "$dshFinalDirectory" $dshRestoreError "restore"
    ${If} $dshRestoreError != 0
      ; Another process holds the final path: keep the complete backup.
      DetailPrint "旧版本备份保留在 / The previous version is kept at: $dshOldDirectory"
      RMDir /r "\\?\$dshNewDirectory"
      Return
    ${EndIf}
    StrCpy $dshOldMoved ""
  ${EndIf}
  ${If} $dshNewDirectory != ""
    RMDir /r "\\?\$dshNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $dshFinalDirectory
FunctionEnd

Function dshPromoteDirectories
  DetailPrint "正在替换安装目录 / Replacing the installation folder"
  ; SetOutPath keeps the directory open; release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ${If} ${FileExists} "$dshFinalDirectory\*.*"
    StrCpy $dshDirectorySource $dshFinalDirectory
    StrCpy $dshDirectoryDestination $dshOldDirectory
    !insertmacro dshDirectoryOperation "$dshDirectorySource" "$dshDirectoryDestination" $dshDirectoryError "backup"
    ${If} $dshDirectoryError != 0
      Call dshRollbackDirectories
      !insertmacro dshReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshOldMoved "1"
  ${Else}
    ; The install section's SetOutPath may already have created it, empty.
    StrCpy $dshDirectorySource $dshFinalDirectory
    StrCpy $dshDirectoryDestination ""
    !insertmacro dshDirectoryOperation "$dshDirectorySource" "" $dshDirectoryError "remove-empty"
    ${If} $dshDirectoryError != 0
      Call dshRollbackDirectories
      !insertmacro dshReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $dshDirectorySource $dshNewDirectory
  StrCpy $dshDirectoryDestination $dshFinalDirectory
  !insertmacro dshDirectoryOperation "$dshDirectorySource" "$dshDirectoryDestination" $dshDirectoryError "promote"
  ${If} $dshDirectoryError != 0
    Call dshRollbackDirectories
    !insertmacro dshReportDirectoryFailure
    SetErrors
    Return
  ${EndIf}
  StrCpy $dshNewMoved "1"
  SetOutPath $dshFinalDirectory
  ClearErrors
FunctionEnd

!macro dshFinishDirectories
  StrCpy $dshNewMoved ""
  StrCpy $dshNewDirectory ""
  ${If} $dshOldMoved == "1"
    DetailPrint "正在删除旧版本 / Removing the previous version"
    RMDir /r "\\?\$dshOldDirectory"
    StrCpy $dshOldMoved ""
  ${EndIf}
!macroend
!endif
