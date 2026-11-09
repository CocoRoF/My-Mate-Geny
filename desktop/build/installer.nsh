; electron-builder's NSIS include (it reads build/installer.nsh by itself). An update started from the app — Download &
; install, src/updater.js: `--updated`, not silent — shows only its progress and then the app again, so nobody sits
; in front of nothing for a minute wondering whether to open the app (which would hold the files being replaced).
; A first install from the downloaded setup is as before: who it is for, the folder, and the finish page.

; who it is for: the installation that is there already (per user, or for everyone — that one asks for elevation)
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${elseif} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${endif}
  ${endif}
!macroend

; electron-builder's own finish page (Run My Mate Geny), and on an update none: the app starts once it is in place
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function finishPageIfNotUpdated
    ${if} ${isUpdated}
      Call StartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE finishPageIfNotUpdated
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
