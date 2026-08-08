; Nexus Desktop - Custom NSIS Installer Script
; Detects nexus-coder CLI and prompts user to install if not found

; Define multi-language strings
LangString nexusCliNotFound ${LANG_SIMPCHINESE} "检测到您尚未安装 Nexus CLI 工具。$\r$\n$\r$\n是否现在安装？（需要 npm）"
LangString nexusCliNotFound ${LANG_ENGLISH} "Nexus CLI not found. $\r$\n$\r$\nInstall now? (requires npm)"

LangString nexusCliInstallBtn ${LANG_SIMPCHINESE} "安装 CLI"
LangString nexusCliInstallBtn ${LANG_ENGLISH} "Install CLI"

LangString nexusCliSkipBtn ${LANG_SIMPCHINESE} "跳过"
LangString nexusCliSkipBtn ${LANG_ENGLISH} "Skip"

LangString nexusCliInstalling ${LANG_SIMPCHINESE} "正在安装 Nexus CLI..."
LangString nexusCliInstalling ${LANG_ENGLISH} "Installing Nexus CLI..."

!macro customInstall
  ; Check if nexus-coder CLI is installed
  nsExec::ExecToStack 'nexus --version'
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
