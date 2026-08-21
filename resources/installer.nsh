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
; Set when this installer had to remove the previous installation itself
; because that version's uninstaller refused to. See dshRemovePreviousInstall.
Var /GLOBAL dshPreviousInstallRemoved
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
; electron-builder reports a failed legacy uninstall through a MessageBox that
; carries no /SD default (handleUninstallResult in include/installUtil.nsh). A
; silent install therefore puts up a dialog nobody can answer and waits forever
; — as a 45-minute job timeout on CI, and as a hung installer for anyone
; scripting an unattended upgrade. This is the hook electron-builder offers for
; exactly that spot: keep its interactive behaviour as it was, and let a silent
; run fail fast with the same error level instead of blocking.
;
; Both variants are defined because handleUninstallResult is called once per
; registry root: SHELL_CONTEXT always, plus HKEY_CURRENT_USER when an all-users
; install cleans up a per-user one.
; Finish the removal the previous version's uninstaller could not.
;
; Every in-place upgrade runs the already-installed uninstaller with
; `--updated`, which selects electron-builder's un.atomicRMDir: it renames the
; install directory's contents into $PLUGINSDIR before deleting them and aborts
; the whole uninstall if any entry will not move. Running that same uninstaller
; on that same directory with only `--updated` dropped removes all 13814 files
; and exits 0, so nothing there is locked or unmovable — the atomic-rename step
; is simply what does not survive. Reported from a real upgrade in
; https://github.com/bruc3van/dsh-desktop/issues/11, and reproduced by
; `pnpm run check:nsis-upgrade`.
;
; The uninstaller that fails already sits on the user's machine, so nothing
; shipped from here can repair it. What this installer can do is remove that
; directory itself and carry on, instead of leaving the upgrade dead in the
; water with files that were always removable.
;
; The bar for deleting a directory is deliberately high: the registry must name
; it as this product's install location AND the uninstaller that registry points
; at must still live directly inside it. Anything short of that leaves the
; directory alone and keeps the old abort, so an unexpected shape fails closed.
!macro dshRemovePreviousInstall ROOT_KEY
  Push $R5
  Push $R6
  Push $R7
  StrCpy $dshPreviousInstallRemoved "false"

  ReadRegStr $R5 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; Tolerate a trailing separator so the parent comparison below can be exact.
  StrCpy $R6 $R5 "" -1
  ${If} $R6 == "\"
    StrCpy $R5 $R5 -1
  ${EndIf}

  ; Never a bare drive root, whatever the registry says.
  StrLen $R6 $R5
  ${If} $R6 > 3
    Push $R5
    Call dshIsUsableInstallDir
    Pop $R6
    ${If} $R6 == "true"
      ReadRegStr $R7 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $R7 != ""
        Push $R7
        Call GetInQuotes
        Pop $R7
        ${If} ${FileExists} "$R7"
          Push $R7
          Call GetFileParent
          Pop $R6
          ${If} $R6 == $R5
            DetailPrint "Previous uninstaller failed; removing $R5 directly."
            ; User data lives outside the install directory, so this is the same
            ; scope /KEEP_APP_DATA gave the uninstaller.
            SetOutPath $TEMP
            RMDir /r "$R5"
            ; Believe it only when the registered uninstaller is actually gone.
            ${IfNot} ${FileExists} "$R7"
              StrCpy $dshPreviousInstallRemoved "true"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $R7
  Pop $R6
  Pop $R5
!macroend

; electron-builder reports a failed legacy uninstall through a MessageBox that
; carries no /SD default, so a silent install shows a dialog nobody can answer
; and waits forever — a 45-minute job timeout on CI, a hung installer for any
; scripted upgrade. Keep its interactive wording, but only after trying to
; finish the removal ourselves, and never block when silent.
!macro dshUninstallResultCheck ROOT_KEY
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
  ${ElseIf} $R0 != 0
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    !insertmacro dshRemovePreviousInstall ${ROOT_KEY}
    ${If} $dshPreviousInstallRemoved == "true"
      DetailPrint "Previous installation removed by this installer; continuing."
    ${Else}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro dshUninstallResultCheck SHELL_CONTEXT
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro dshUninstallResultCheck HKCU
!macroend

; Remove this version's own files without the atomic-rename detour.
;
; electron-builder's default removal takes two shapes: a plain uninstall moves
; out of the directory and deletes it, while an update (`--updated`, which every
; in-place upgrade passes) first renames every entry into $PLUGINSDIR\old-install
; so a locked file can be rolled back, and aborts the whole uninstall when any
; entry will not move. That rename step is what fails — see
; https://github.com/bruc3van/dsh-desktop/issues/11 and the single-variable
; control in `pnpm run check:nsis-upgrade`: the same uninstaller on the same
; directory exits 2 and removes nothing with `--updated`, and exits 0 removing
; all 13814 files without it. Nothing there is locked; the detour is.
;
; So take the shape that works, for both cases. dshRemovePreviousInstall already
; rescues upgrades from versions that shipped with the broken path — this is what
; keeps every version from 0.2.6 on from needing that rescue at all.
;
; The trade-off is deliberate: rollback-on-locked-file goes away, so a genuinely
; busy file now leaves its remains behind instead of restoring the old install
; and stopping. That case is already handled upstream — CHECK_APP_RUNNING closes
; the app before the uninstall section runs — and leftovers the installer writes
; over beat an upgrade that cannot proceed at all.
!macro customRemoveFiles
  DetailPrint "Removing $INSTDIR"
  ; Move out of $INSTDIR so it can be removed.
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend

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
