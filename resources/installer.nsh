; Project hooks for electron-builder's assisted NSIS installer.
;
; scripts/windows-directory-installer.mjs adapts electron-builder's templates so
; the app is extracted beside $INSTDIR and swapped in by rename; the macros that
; do it live in scripts/installer-directories.nsh, included below. This file
; keeps what is specific to this product: finding an existing installation
; again (including across the DSH Desktop -> DSH Desktop Pro rename), shortcut
; repair after that rename, and a silent-safe uninstall result check.
;
; Assisted NSIS shows an InstFiles list under the progress bar. electron-builder
; silences it (`SetDetailsPrint none`); the adapter turns printing back on and
; customHeader keeps the list open. Silent installs (`/S`) never show a dialog:
; every MessageBox here carries an /SD default.
!include LogicLib.nsh

; A nonempty recovered path identifies an existing installation in the selected
; install context. The assisted installer template checks it before adding
; APP_FILENAME to an unchanged directory; an explicit directory choice still
; keeps electron-builder's normal "selected parent\product name" behaviour.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL dshRecoveredInstallDir
Var /GLOBAL dshOriginalInstallDir
Var /GLOBAL dshExplicitInstallDir
; The mode page can switch registry context after customInit. Preserve both
; sides and select from them again immediately before normalization/uninstall.
Var /GLOBAL dshPerUserRecoveredInstallDir
Var /GLOBAL dshPerMachineRecoveredInstallDir
Var /GLOBAL dshPerUserOriginalInstallDir
Var /GLOBAL dshPerMachineOriginalInstallDir
; One-shot product-name migration. Unlike an ordinary reinstall, this must
; leave the user with a shortcut carrying the new name, and with no shortcut
; under the old name: a same-directory upgrade no longer runs the previous
; uninstaller, which is what used to delete it.
Var /GLOBAL dshRenamedUpgrade
!endif

!include "${__FILEDIR__}\..\scripts\installer-directories.nsh"

; Refresh the selected old/original pair after the install-mode page may have
; called setInstallModePerUser or setInstallModePerAllUsers again.
!macro dshRefreshSelectedInstallContext
  ${If} $installMode == "CurrentUser"
    StrCpy $dshRecoveredInstallDir $dshPerUserRecoveredInstallDir
    StrCpy $dshOriginalInstallDir $dshPerUserOriginalInstallDir
  ${Else}
    StrCpy $dshRecoveredInstallDir $dshPerMachineRecoveredInstallDir
    StrCpy $dshOriginalInstallDir $dshPerMachineOriginalInstallDir
  ${EndIf}
!macroend

; Restore only a target that still represents the selected installation's
; recovered path or the original registry value. Explicit /D= and a directory
; the user actually changed remain authoritative.
!macro dshRestoreUnchangedInstallTarget
  !insertmacro dshRefreshSelectedInstallContext
  ${If} $dshRecoveredInstallDir != ""
    ${If} $INSTDIR == $dshRecoveredInstallDir
    ${OrIf} $INSTDIR == $dshOriginalInstallDir
      ${If} $dshExplicitInstallDir != ""
        StrCpy $INSTDIR $dshExplicitInstallDir
      ${Else}
        StrCpy $INSTDIR $dshRecoveredInstallDir
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Accept a directory only when it is an existing absolute drive/UNC path.
; A value such as `D:ITdsh-desktop` is drive-relative, not absolute.
; Stack: candidate -> "true" | "false".
!ifndef BUILD_UNINSTALLER
Function dshIsUsableInstallDir
  Exch $R6
  Push $R7
  Push $R8
  StrCpy $R7 "false"

  StrCpy $R8 $R6 2
  StrCmp $R8 "\\" dsh_dir_absolute
  StrCpy $R8 $R6 1 1
  StrCmp $R8 ":" 0 dsh_dir_done
  StrCpy $R8 $R6 1 2
  StrCmp $R8 "\" 0 dsh_dir_done

  dsh_dir_absolute:
    ${If} ${FileExists} "$R6\*.*"
      StrCpy $R7 "true"
    ${EndIf}

  dsh_dir_done:
    StrCpy $R6 $R7
    Pop $R8
    Pop $R7
    Exch $R6
FunctionEnd
!endif

; Resolve one registry root without using the current $INSTDIR as evidence.
; Prefer the registered uninstaller's parent, then Add/Remove Programs'
; InstallLocation, then the primary electron-builder InstallLocation.
!macro dshRecoverInstallDir ROOT_KEY OUT_VAR
  StrCpy ${OUT_VAR} ""
  ReadRegStr $R6 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $R6 == ""
      ReadRegStr $R6 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${EndIf}
  !endif
  ${If} $R6 != ""
    Push $R6
    Call GetInQuotes
    Pop $R6
    ${If} ${FileExists} "$R6"
      Push $R6
      Call GetFileParent
      Pop ${OUT_VAR}
    ${EndIf}
  ${EndIf}

  ${If} ${OUT_VAR} == ""
    ReadRegStr $R6 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" InstallLocation
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $R6 == ""
        ReadRegStr $R6 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" InstallLocation
      ${EndIf}
    !endif
    Push $R6
    Call dshIsUsableInstallDir
    Pop $R7
    ${If} $R7 == "true"
      StrCpy ${OUT_VAR} $R6
    ${EndIf}
  ${EndIf}

  ${If} ${OUT_VAR} == ""
    ReadRegStr $R6 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
    Push $R6
    Call dshIsUsableInstallDir
    Pop $R7
    ${If} $R7 == "true"
      StrCpy ${OUT_VAR} $R6
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  Push $R0
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  StrCpy $dshRecoveredInstallDir ""
  StrCpy $dshOriginalInstallDir ""
  StrCpy $dshExplicitInstallDir ""
  StrCpy $dshPerUserRecoveredInstallDir ""
  StrCpy $dshPerMachineRecoveredInstallDir ""
  ReadRegStr $dshPerUserOriginalInstallDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $dshPerMachineOriginalInstallDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCpy $dshRenamedUpgrade "false"

  ReadRegStr $R6 HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${If} $R6 != ""
  ${AndIf} $R6 != "${SHORTCUT_NAME}"
    StrCpy $dshRenamedUpgrade "true"
  ${EndIf}
  ReadRegStr $R6 HKLM "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${If} $R6 != ""
  ${AndIf} $R6 != "${SHORTCUT_NAME}"
    StrCpy $dshRenamedUpgrade "true"
  ${EndIf}

  !insertmacro dshRecoverInstallDir HKCU $dshPerUserRecoveredInstallDir
  !insertmacro dshRecoverInstallDir HKLM $dshPerMachineRecoveredInstallDir
  ${If} $dshPerUserRecoveredInstallDir != ""
    StrCpy $perUserInstallationFolder $dshPerUserRecoveredInstallDir
  ${EndIf}
  ${If} $dshPerMachineRecoveredInstallDir != ""
    StrCpy $perMachineInstallationFolder $dshPerMachineRecoveredInstallDir
  ${EndIf}

  !insertmacro dshRefreshSelectedInstallContext
  ${If} $dshRecoveredInstallDir != ""
    ; initMultiUser has already applied /D=. Only replace its initial registry
    ; value when no explicit command-line target was supplied.
    !insertmacro GetDParameter $R0
    StrCpy $dshExplicitInstallDir $R0
    ${If} $R0 == ""
      StrCpy $INSTDIR $dshRecoveredInstallDir
    ${EndIf}
  ${EndIf}

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R0
!macroend

; electron-builder reports a failed legacy uninstall through a MessageBox that
; carries no /SD default (handleUninstallResult in include/installUtil.nsh), so a
; silent install shows a dialog nobody can answer and waits forever — a
; 45-minute job timeout on CI, a hung installer for any scripted upgrade. Keep
; the interactive wording, never block when silent, and report the exit code in
; the details list.
;
; Only an upgrade into a different directory or install scope still runs the
; previous uninstaller; a same-directory upgrade is a directory swap. The new
; tree is already staged by then, so failing here removes it and leaves the
; previous installation exactly as it was.
;
; Both variants are defined because handleUninstallResult is called once per
; registry root: SHELL_CONTEXT always, plus HKEY_CURRENT_USER when an all-users
; install cleans up a per-user one.
!macro dshUninstallResultCheck
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
  ${ElseIf} $R0 != 0
    DetailPrint "旧版本卸载失败（退出码 $R0）/ Previous version's uninstaller failed (exit code $R0)"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    Call dshCleanupDirectories
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro dshUninstallResultCheck
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro dshUninstallResultCheck
!macroend

; Remove this version's own files without the atomic-rename detour.
;
; This uninstaller runs on its own (Add/Remove Programs) and, with `--updated`,
; when a later version is installed into a different directory. electron-builder's
; `--updated` removal renames every entry into $PLUGINSDIR\old-install first and
; aborts the whole uninstall when any entry will not move; that rename step is
; what fails in https://github.com/bruc3van/dsh-desktop-pro/issues/11 although
; nothing in the directory is locked. Remove the directory directly in both
; cases. The `\\?\` prefix reaches runtime files deeper than MAX_PATH.
!macro customRemoveFiles
  DetailPrint "Removing $INSTDIR"
  ; Move out of $INSTDIR so it can be removed.
  SetOutPath $TEMP
  RMDir /r "\\?\$INSTDIR"
!macroend

; multiUserUi reloads InstallLocation when its mode page is left. Correct an
; unchanged broken value before the following directory page becomes visible.
!macro customInstallModeLeave
  !ifndef BUILD_UNINSTALLER
    !insertmacro dshRestoreUnchangedInstallTarget
  !endif
!macroend

; Called only when the install section starts (after the user clicks Install,
; and in silent installs). Do not repair persistent state merely by opening and
; then cancelling the wizard.
!macro customPrepareUpgrade
  ; Silent all-users upgrades can call setInstallModePerAllUsers again after
  ; customInit. Restore that unchanged registry value before $appExe/SetOutPath
  ; capture $INSTDIR, while preserving an explicit /D= target.
  !insertmacro dshRestoreUnchangedInstallTarget
  ${If} $dshRecoveredInstallDir != ""
    ; Both the same-directory check and, for a different directory, the legacy
    ; uninstaller read this key. Repair it so they agree on the same absolute
    ; directory as `_?=$installationDir`.
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$dshRecoveredInstallDir"
  ${EndIf}
  ${If} $installMode == "all"
  ${AndIf} $dshPerUserRecoveredInstallDir != ""
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$dshPerUserRecoveredInstallDir"
  ${EndIf}
!macroend

; Runs after registration and electron-builder's shortcut handling.
!macro customInstall
  ; The new tree is in place and registered; the backup can go.
  !insertmacro dshFinishDirectories
  ; Only a product-name migration gets this repair; ordinary reinstall/update
  ; shortcut preferences remain untouched.
  ${If} $dshRenamedUpgrade == "true"
    ; The old-name shortcuts point into the replaced directory at an executable
    ; that no longer exists. The previous uninstaller used to delete them.
    ${If} $oldDesktopLink != $newDesktopLink
    ${AndIf} ${FileExists} "$oldDesktopLink"
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}
    ${If} $oldStartMenuLink != $newStartMenuLink
    ${AndIf} ${FileExists} "$oldStartMenuLink"
      WinShell::UninstShortcut "$oldStartMenuLink"
      Delete "$oldStartMenuLink"
    ${EndIf}
    ${IfNot} ${isNoDesktopShortcut}
    ${AndIfNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
    ClearErrors
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customHeader
  ; Render at the system DPI instead of letting Windows bitmap-stretch the
  ; whole wizard (including its multi-resolution app icon) on scaled displays.
  ManifestDPIAware true
  ShowInstDetails show
  ShowUninstDetails show
!macroend
