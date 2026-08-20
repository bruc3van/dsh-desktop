; Assisted NSIS shows an InstFiles list under the progress bar. electron-builder
; leaves that list empty (`SetDetailsPrint none`). ShowInstDetails keeps it open;
; `scripts/patch-nsis-install-details.mjs` turns printing back on and asks 7-Zip
; to report extraction percent. Silent installs (`/S`) are unchanged.
!include LogicLib.nsh

; Whether customInit found a usable pre-rename installation in the selected
; install context. The assisted installer template consults this before adding
; APP_FILENAME to an unchanged directory; an explicit directory choice still
; keeps electron-builder's normal "selected parent\product name" behaviour.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL dshExistingInstallFound
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
; leave the user with a shortcut carrying the new name even if the legacy
; uninstaller removed (or had already lost) the old .lnk.
Var /GLOBAL dshRenamedUpgrade
!endif

; Refresh the selected old/original pair after the install-mode page may have
; called setInstallModePerUser or setInstallModePerAllUsers again.
!macro dshRefreshSelectedInstallContext
  StrCpy $dshExistingInstallFound "false"
  ${If} $installMode == "CurrentUser"
    StrCpy $dshRecoveredInstallDir $dshPerUserRecoveredInstallDir
    StrCpy $dshOriginalInstallDir $dshPerUserOriginalInstallDir
  ${Else}
    StrCpy $dshRecoveredInstallDir $dshPerMachineRecoveredInstallDir
    StrCpy $dshOriginalInstallDir $dshPerMachineOriginalInstallDir
  ${EndIf}
  ${If} $dshRecoveredInstallDir != ""
    StrCpy $dshExistingInstallFound "true"
  ${EndIf}
!macroend

; Restore only a target that still represents the selected installation's
; recovered path or the original registry value. Explicit /D= and a directory
; the user actually changed remain authoritative.
!macro dshRestoreUnchangedInstallTarget
  !insertmacro dshRefreshSelectedInstallContext
  ${If} $dshExistingInstallFound == "true"
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

  StrCpy $dshExistingInstallFound "false"
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
  ${If} $dshExistingInstallFound == "true"
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
  ${If} $dshExistingInstallFound == "true"
    ; The legacy uninstaller initializes itself from this key before removing
    ; files. Repair it so `_?=$installationDir` and the uninstaller agree on the
    ; same absolute directory.
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$dshRecoveredInstallDir"
  ${EndIf}
  ${If} $installMode == "all"
  ${AndIf} $dshPerUserRecoveredInstallDir != ""
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$dshPerUserRecoveredInstallDir"
  ${EndIf}
!macroend

; Runs after electron-builder's normal shortcut handling. Only a product-name
; migration gets this repair; ordinary reinstall/update shortcut preferences
; remain untouched.
!macro customInstall
  ${If} $dshRenamedUpgrade == "true"
  ${AndIfNot} ${isNoDesktopShortcut}
  ${AndIfNot} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend
