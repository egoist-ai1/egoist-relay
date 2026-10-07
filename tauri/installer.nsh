; Stop only executable paths belonging to the selected installation.
!define RELAY_HOOK_DIRECTORY "${__FILEDIR__}"
!include WordFunc.nsh
; Checked against the frozen runtime manifest by release preflight. Reserve one
; separator/NUL and the classic CreateDirectory 8.3 filename margin (12 units).
!define RELAY_MAX_RUNTIME_RELATIVE_FILE_CHARS 50
!define RELAY_MAX_RUNTIME_RELATIVE_DIRECTORY_CHARS 21
!define RELAY_MAX_INSTALL_DIRECTORY_CHARS 208

; This hidden section is declared before Tauri's WebView2 installation section.
; Reject unsupported systems before any dependency or application is installed.
Section "-Relay requirements"
  Push $0
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Egoist Relay требует 64-разрядную Windows 10 версии 1903 или новее." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  SetRegView lastused
  ${If} $0 < 18362
    MessageBox MB_OK|MB_ICONSTOP "Egoist Relay требует Windows 10 версии 1903 (сборка 18362) или новее." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  Pop $0
  Call RelayCheckInstallationPath
  Call RelayCheckSelectedInstallVersion
SectionEnd

Function RelayCheckInstallationPath
  Push $0
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${RELAY_MAX_INSTALL_DIRECTORY_CHARS}
    MessageBox MB_OK|MB_ICONSTOP "Путь папки установки слишком длинный. Разрешено не более ${RELAY_MAX_INSTALL_DIRECTORY_CHARS} символов. Выберите более короткую папку." /SD IDOK
    SetErrorLevel 1
    Abort "RELAY_INSTALL_PATH_TOO_LONG: Choose a shorter installation directory."
  ${EndIf}
  Pop $0
FunctionEnd

; The hook is included before Tauri defines VERSION and UNINSTKEY. Read this
; installer's own version resource and match records to the selected directory.
; Unlike PageReinstall, this check also runs in /S mode before WebView2 setup.
Function RelayCheckSelectedInstallVersion
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  ClearErrors
  GetDLLVersion "$EXEPATH" $0 $1
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "RELAY_VERSION_UNAVAILABLE: Cannot verify the installer version."
  ${EndIf}
  IntOp $2 $0 >> 16
  IntOp $3 $0 & 0xFFFF
  IntOp $4 $1 >> 16
  StrCpy $8 "$2.$3.$4"
  StrCpy $0 0
  relay_version_next:
    EnumRegKey $1 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    ${If} $1 == ""
      Goto relay_version_done
    ${EndIf}
    IntOp $0 $0 + 1
    ReadRegStr $2 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
    ${If} $2 == "$INSTDIR"
    ${OrIf} $2 == '$\"$INSTDIR$\"'
      ReadRegStr $3 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayVersion"
      ${If} $3 != ""
        ${VersionCompare} "$8" "$3" $4
        ${If} $4 == 2
          MessageBox MB_OK|MB_ICONSTOP "В выбранной папке установлена более новая версия ($3). Обновление на версию $8 остановлено." /SD IDOK
          SetErrorLevel 1
          Abort "RELAY_DOWNGRADE_BLOCKED: Installed version is newer."
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Goto relay_version_next
  relay_version_done:
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro RELAY_STOP_INSTALLATION_PROCESSES
  !define RELAY_CHECK_ID ${__LINE__}
  relay_check_${RELAY_CHECK_ID}:
  InitPluginsDir
  File /oname=$PLUGINSDIR\relay-stop-processes.ps1 "${RELAY_HOOK_DIRECTORY}\installer-processes.ps1"
  ${If} ${RunningX64}
    nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\relay-stop-processes.ps1" -InstallDirectory "$INSTDIR"'
  ${Else}
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\relay-stop-processes.ps1" -InstallDirectory "$INSTDIR"'
  ${EndIf}
  Pop $0
  Pop $1
  ${If} $0 == 2
    IfSilent relay_abort_${RELAY_CHECK_ID} 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Закройте Egoist Relay через меню значка в трее, затем нажмите «Повторить». Активные аккаунты не будут принудительно закрыты." IDRETRY relay_check_${RELAY_CHECK_ID} IDCANCEL relay_abort_${RELAY_CHECK_ID}
    relay_abort_${RELAY_CHECK_ID}:
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
  !undef RELAY_CHECK_ID
!macroend

; Tauri's default macro stops every process with the same filename.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  !insertmacro RELAY_STOP_INSTALLATION_PROCESSES
!macroend

!macro NSIS_HOOK_PREINSTALL
  Call RelayCheckInstallationPath
  ; Check the product's exact namespace again after directory selection. Silent
  ; installs skip PageReinstall, so its $R0 comparison is not a release gate.
  Push $0
  Push $1
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $0 != ""
    nsis_tauri_utils::SemverCompare "${VERSION}" "$0"
    Pop $1
    ${If} $1 == -1
      MessageBox MB_OK|MB_ICONSTOP "Установлена более новая версия Egoist Relay ($0). Установка версии ${VERSION} остановлена." /SD IDOK
      SetErrorLevel 1
      Abort "RELAY_DOWNGRADE_BLOCKED: Installed product version is newer."
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  ; The scoped CheckIfAppIsRunning macro runs immediately after this hook.
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The scoped CheckIfAppIsRunning macro runs immediately after this hook.
!macroend

!macro NSIS_HOOK_POSTINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\relay-stop-processes.ps1 "${RELAY_HOOK_DIRECTORY}\installer-processes.ps1"
  File /oname=$PLUGINSDIR\relay-legacy-runtime.json "${RELAY_HOOK_DIRECTORY}\installer-legacy-runtime.json"
  ${If} ${RunningX64}
    nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\relay-stop-processes.ps1" -InstallDirectory "$INSTDIR" -RemoveLegacyNetworkRuntime -LegacyRuntimeManifestPath "$PLUGINSDIR\relay-legacy-runtime.json"'
  ${Else}
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\relay-stop-processes.ps1" -InstallDirectory "$INSTDIR" -RemoveLegacyNetworkRuntime -LegacyRuntimeManifestPath "$PLUGINSDIR\relay-legacy-runtime.json"'
  ${EndIf}
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    SetErrorLevel 1
    Abort "RELAY_LEGACY_RUNTIME_CHECK_FAILED: Obsolete runtime validation failed."
  ${EndIf}
!macroend
