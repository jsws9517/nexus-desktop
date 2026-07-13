<#
.SYNOPSIS
  Setup local vision (Florence-2) — install Python deps & pre-download model.

.DESCRIPTION
  - Installs torch, transformers, Pillow into a .venv in the project root
  - Pre-downloads microsoft/Florence-2-base from HuggingFace
  - Supports HF mirror (hf-mirror.com) for users without VPN
  - Verifies the model loads correctly

.PARAMETER Mirror
  Use HuggingFace mirror for China users: -Mirror hf-mirror.com
  Default: direct HuggingFace

.PARAMETER PypiMirror
  PyPI mirror URL for pip (e.g., https://mirrors.aliyun.com/pypi/simple)
  Default: direct PyPI

.PARAMETER VenvDir
  Virtual environment directory (default: .venv)

.EXAMPLE
  .\scripts\setup-vision.ps1
  .\scripts\setup-vision.ps1 -Mirror hf-mirror.com
  .\scripts\setup-vision.ps1 -PypiMirror https://mirrors.aliyun.com/pypi/simple
  .\scripts\setup-vision.ps1 -Mirror hf-mirror.com -PypiMirror https://mirrors.aliyun.com/pypi/simple
#>

param(
  [string]$Mirror = "",
  [string]$PypiMirror = "",
  [string]$VenvDir = ".venv"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."

# ── 1. Check Python 3.10+ ──
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python" }
          elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
          else { throw "Python not found. Install Python 3.10+ from https://python.org" }

$verStr = & $python --version 2>&1
$verMatch = [regex]::Match($verStr, '(\d+)\.(\d+)')
if (-not $verMatch.Success) { throw "Cannot parse Python version" }
$major = [int]$verMatch.Groups[1].Value
$minor = [int]$verMatch.Groups[2].Value
if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
  throw "Python 3.10+ required, found $verStr"
}
Write-Host "[OK] $verStr" -ForegroundColor Green

# ── 2. Setup venv ──
$venvPath = Join-Path $ProjectRoot $VenvDir
$recreateVenv = $false
if (Test-Path "$venvPath\Scripts\python.exe") {
  $venvVer = & "$venvPath\Scripts\python" --version 2>&1
  if ($venvVer -ne $verStr) {
    Write-Host "[..] Venv Python ($venvVer) differs from system ($verStr), recreating ..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $venvPath -ErrorAction SilentlyContinue
    $recreateVenv = $true
  }
} else {
  $recreateVenv = $true
}
if ($recreateVenv) {
  Write-Host "[...] Creating virtual environment at $VenvDir ..." -ForegroundColor Yellow
  & $python -m venv $venvPath
  if (-not $?) { throw "Failed to create venv" }
  Write-Host "[OK] Virtual environment created" -ForegroundColor Green
}
$pip = "$venvPath\Scripts\pip"

# ── 3. Upgrade pip ──
Write-Host "[...] Upgrading pip ..." -ForegroundColor Yellow
& "$venvPath\Scripts\python" -m pip install --upgrade pip
if (-not $?) { Write-Host "[..] pip upgrade skipped" -ForegroundColor Yellow }

# ── 4. Install Python packages ──
$pipArgs = @("install", "torch", "transformers<5", "Pillow", "einops", "timm")
if ($PypiMirror) {
  $pipArgs += "-i"; $pipArgs += $PypiMirror
  Write-Host "[..] Using PyPI mirror: $PypiMirror" -ForegroundColor Cyan
}
Write-Host "[...] Installing torch (~800MB), transformers, Pillow ..." -ForegroundColor Yellow
& $pip @pipArgs
if (-not $?) { throw "pip install failed" }
Write-Host "[OK] Python packages installed" -ForegroundColor Green

# ── 5. Pre-download Florence-2 model ──
if ($Mirror) {
  $oldEndpoint = $env:HF_ENDPOINT
  $env:HF_ENDPOINT = "https://$Mirror"
  Write-Host "[...] Using HF mirror: $Mirror" -ForegroundColor Cyan
}

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
Write-Host "[...] Downloading microsoft/Florence-2-base ..." -ForegroundColor Yellow
& $venvPath\Scripts\hf download microsoft/Florence-2-base
if (-not $?) { throw "Model download failed" }

if ($Mirror) {
  if ($oldEndpoint) { $env:HF_ENDPOINT = $oldEndpoint } else { Remove-Item Env:HF_ENDPOINT -ErrorAction SilentlyContinue }
}

Write-Host "[OK] Model downloaded and cached" -ForegroundColor Green

# ── 6. Clear stale cached model code (compatibility guard) ──
$modelCacheModule = "$env:USERPROFILE\.cache\huggingface\modules\transformers_modules\microsoft"
if (Test-Path $modelCacheModule) {
  Remove-Item -Recurse -Force $modelCacheModule -ErrorAction SilentlyContinue
  Write-Host "[..] Cleared cached Florence-2 module code" -ForegroundColor Yellow
}

# ── 7. Quick verification (with local_files_only=True to confirm cache) ──
Write-Host "[...] Verifying model loads correctly from cache ..." -ForegroundColor Yellow
& $venvPath\Scripts\python -c "
import sys
from transformers import AutoModelForCausalLM, AutoProcessor
m = AutoModelForCausalLM.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True, local_files_only=True, attn_implementation='eager')
p = AutoProcessor.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True, local_files_only=True)
print(f'Model: {m.__class__.__name__}')
print(f'Params: {sum(p.numel() for p in m.parameters())/1e6:.0f}M')
"
if (-not $?) { throw "Verification failed" }
Write-Host "[OK] Florence-2 is ready!" -ForegroundColor Green

Write-Host ""
Write-Host "Next step:" -ForegroundColor Cyan
Write-Host "  Set this env var so the agent uses the venv Python:"
Write-Host "  `$env:LLMA_VISION_PYTHON = '$(Resolve-Path "$venvPath\Scripts\python.exe")'"
Write-Host "  (Add to your `$PROFILE for persistence)"
Write-Host ""
