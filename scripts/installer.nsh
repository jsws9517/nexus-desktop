; Nexus Desktop - Custom NSIS Installer Script
; Detects nexus-coder CLI and prompts user to install if not found

; Define multi-language strings using LCID (Language Code Identifier)
; Chinese Simplified: 2052 (0x0804)
; English: 1033 (0x0409)

LangString nexusCliNotFound 2052 "检测到您尚未安装 Nexus CLI 工具。$\r$\n$\r$\n是否现在安装？（需要 npm）"
LangString nexusCliNotFound 1033 "Nexus CLI not found. $\r$\n$\r$\nInstall now? (requires npm)"

LangString nexusCliInstallBtn 2052 "安装 CLI"
LangString nexusCliInstallBtn 1033 "Install CLI"

LangString nexusCliSkipBtn 2052 "跳过"
LangString nexusCliSkipBtn 1033 "Skip"

!macro customInstall
  ; Check if nexus-coder is installed by detecting npm global directory
  ; This avoids running external commands that may hang
  IfFileExists "$APPDATA\nexus-coder\node_modules\nexus-coder\package.json" nexus_found nexus_not_found
  
  nexus_found:
    Goto nexus_check_done
  
  nexus_not_found:
    ; nexus-coder not found, show language-appropriate prompt
    MessageBox MB_YESNO "$(nexusCliNotFound)" \
      IDYES install_nexus \
      IDNO skip_nexus
    
    install_nexus:
      ; Open new CMD window to install nexus-coder globally
      ExecShell "open" "cmd.exe" '/K "npm install -g nexus-coder"'
      Goto skip_nexus
    
    skip_nexus:
  
  nexus_check_done:
!macroend
