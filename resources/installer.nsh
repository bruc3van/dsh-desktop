; Assisted NSIS shows an InstFiles list under the progress bar. electron-builder
; leaves that list empty (`SetDetailsPrint none`). ShowInstDetails keeps it open;
; `scripts/patch-nsis-install-details.mjs` turns printing back on and asks 7-Zip
; to report extraction percent. Silent installs (`/S`) are unchanged.
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend
