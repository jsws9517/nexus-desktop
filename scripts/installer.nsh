; Nexus Desktop - Custom NSIS Installer Script
; Detects a global nexus-coder CLI (nexus / agent) and prompts the user to
; install one if not found.
;
; NOTE: electron-builder compiles this with makensis `-WX` (warnings-as-errors
; unless `nsis.warningsAsErrors=false`), so everything must stay inline inside
; the macro — a top-level `Function` that the final script does not reference
; becomes fatal warning 6010. No top-level Functions here.

; Define multi-language strings using LCID (Language Code Identifier)
; Chinese Simplified: 2052 (0x0804)
; English: 1033 (0x0409)

LangString nexusCliNotFound 2052 "检测到全局尚未安装 Nexus CLI 工具（nexus / agent 命令）。$\r$\n$\r$\n是否现在安装？（需要 npm）"
LangString nexusCliNotFound 1033 "Global Nexus CLI (nexus / agent) not found. $\r$\n$\r$\nInstall now? (requires npm)"

!macro customInstall
  ; --- Detection -------------------------------------------------------
  ; Detect *global* CLI availability by inspecting real npm global dirs.
  ; We deliberately do NOT run `nexus --version` here: the elevated installer
  ; process often cannot resolve the user-level PATH, so the command would
  ; hang / be unreadable inside NSIS.

  ; npm's default global prefix on Windows: %APPDATA%\npm
  IfFileExists "$APPDATA\npm\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$APPDATA\npm\nexus.cmd" cli_found

  ; system-wide Node installs
  IfFileExists "$PROGRAMFILES64\nodejs\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$PROGRAMFILES32\nodejs\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$PROGRAMFILES\nodejs\node_modules\nexus-coder\package.json" cli_found

  ; Custom global prefixes (nvm / fnm / volta ...): probe `npm prefix -g`
  ; when resolvable. Timeout guards against hangs.
  nsExec::ExecToStack /TIMEOUT 6000 'npm prefix -g'
  Pop $R1                   ; exit code
  Pop $R2                   ; stdout: "<prefix>\r\n"
  StrLen $R3 $R2
  IntCmp $R3 2 cli_missing cli_probe cli_missing
cli_probe:
  StrCpy $R2 $R2 -2         ; strip the trailing CRLF
  IfFileExists "$R2\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$R2\nexus.cmd" cli_found

cli_missing:
  ; Global CLI missing: show language-appropriate prompt
  MessageBox MB_YESNO "$(nexusCliNotFound)" \
    IDYES install_nexus \
    IDNO cli_skip

install_nexus:
  ; Open new CMD window to install nexus-coder globally
  ExecShell "open" "cmd.exe" '/K "npm install -g nexus-coder"'
  Goto cli_skip

cli_skip:
cli_found:
  ; end of customInstall
!macroend