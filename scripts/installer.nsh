; Nexus Desktop - Custom NSIS Installer Script
; Detects a global nexus-coder CLI (nexus / agent) and prompts the user to
; install one if not found.
;
; Robustness notes (verified empirically on Win11 x64):
; - Builtin `IfFileExists` / `ExecWait` work; the `nsExec` plugin returns
;   `error` for every command at runtime on this setup, so it is NOT used.
; - `FileRead` already strips the trailing CRLF from redirect output, so any
;   manual `StrCpy -1/-2` trim would corrupt the path. We instead test the
;   npm prefix with 0, 1 and 2 trailing-char variants below.
; - electron-builder compiles this with makensis `-WX` (warnings-as-errors),
;   so everything must stay inline inside the macro - no top-level Functions.

; Define multi-language strings using LCID (Language Code Identifier)
; Chinese Simplified: 2052 (0x0804)
; English: 1033 (0x0409)

LangString nexusCliNotFound 2052 "检测到全局尚未安装 Nexus CLI 工具（nexus / agent 命令）。$\r$\n$\r$\n是否现在安装？（需要 npm）"
LangString nexusCliNotFound 1033 "Global Nexus CLI (nexus / agent) not found. $\r$\n$\r$\nInstall now? (requires npm)"

!macro customInstall
  ; --- Static detection ------------------------------------------------
  ; npm's default global prefix on Windows: %APPDATA%\npm
  IfFileExists "$APPDATA\npm\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$APPDATA\npm\nexus.cmd" cli_found

  ; system-wide Node installs
  IfFileExists "$PROGRAMFILES64\nodejs\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$PROGRAMFILES32\nodejs\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$PROGRAMFILES\nodejs\node_modules\nexus-coder\package.json" cli_found

  ; --- Dynamic detection -----------------------------------------------
  ; Custom global prefixes (nvm / fnm / volta ...): resolve via
  ; `npm prefix -g`, redirecting to a temp file, then check the path.
  ; ExecWait returns 0 when npm resolved; path handling is newline-safe.
  ExecWait 'cmd.exe /c npm prefix -g > "$TEMP\nx_npm_prefix.txt" 2>nul' $R9
  IfFileExists "$TEMP\nx_npm_prefix.txt" 0 cli_missing
  FileOpen $R8 "$TEMP\nx_npm_prefix.txt" r
  FileRead $R8 $R2
  FileClose $R8
  Delete "$TEMP\nx_npm_prefix.txt"

  ; $R2 may carry 0, 1 or 2 trailing whitespace bytes depending on how the
  ; redirect was captured; try all variants without assuming either.
  IfFileExists "$R2\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$R2\nexus.cmd" cli_found

  StrCpy $R3 $R2 -1
  IfFileExists "$R3\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$R3\nexus.cmd" cli_found

  StrCpy $R4 $R2 -2
  IfFileExists "$R4\node_modules\nexus-coder\package.json" cli_found
  IfFileExists "$R4\nexus.cmd" cli_found

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