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
  ; Check if nexus-coder CLI is installed with 5 second timeout
  nsExec::ExecToStack /TIMEOUT 5000 'nexus --version'
  Pop $0  ; Return code
  
  ${If} $0 != "0"
    ; nexus-coder not found, show language-appropriate prompt
    MessageBox MB_YESNO "$(nexusCliNotFound)" \
      IDYES install_nexus \
      IDNO skip_nexus
    
    install_nexus:
      ; Open CMD to install nexus-coder globally
      ExecShell "open" "cmd.exe" '/k "echo Installing Nexus CLI... && npm install -g nexus-coder && echo. && echo Installation complete! && pause"'
      Goto skip_nexus
    
    skip_nexus:
  ${EndIf}
!macroend
