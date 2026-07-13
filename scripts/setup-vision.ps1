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

.PARAMETER VenvDir
  Virtual environment directory (default: .venv)

.EXAMPLE
  .\scripts\setup-vision.ps1
  .\scripts\setup-vision.ps1 -Mirror hf-mirror.com
#>

param(
  [string]$Mirror = "",
  [string]$VenvDir = ".venv"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."

# ── 1. Check Python ──
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" }
          elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
          else { throw "Python not found. Install Python 3.10+ from https://python.org" }

$ver = & $python --version
Write-Host "[✓] $ver" -ForegroundColor Green

# ── 2. Setup venv ──
$venvPath = Join-Path $ProjectRoot $VenvDir
if (-not (Test-Path "$venvPath\Scripts\python.exe")) {
  Write-Host "[...] Creating virtual environment at $VenvDir ..." -ForegroundColor Yellow
  & $python -m venv $venvPath
  if (-not $?) { throw "Failed to create venv" }
  Write-Host "[✓] Virtual environment created" -ForegroundColor Green
}
$pip = "$venvPath\Scripts\pip"

# ── 3. Install Python packages ──
Write-Host "[...] Installing torch, transformers, Pillow ..." -ForegroundColor Yellow
& $pip install torch transformers Pillow --quiet
if (-not $?) { throw "pip install failed" }
Write-Host "[✓] Python packages installed" -ForegroundColor Green

# ── 4. Pre-download Florence-2 model ──
$env:HF_HUB_ENABLE_HF_TRANSFER = "1"
if ($Mirror) {
  $oldEndpoint = $env:HF_ENDPOINT
  $env:HF_ENDPOINT = "https://$Mirror"
  Write-Host "[...] Using HF mirror: $Mirror" -ForegroundColor Cyan
}

Write-Host "[...] Downloading microsoft/Florence-2-base (this may take a while) ..." -ForegroundColor Yellow
& $venvPath\Scripts\python -c "
import os, sys
from transformers import AutoModelForCausalLM, AutoProcessor
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
print('Downloading model ...', flush=True)
AutoModelForCausalLM.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True)
AutoProcessor.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True)
print('Download complete', flush=True)
" 2>&1
if (-not $?) { throw "Model download failed" }

if ($Mirror) {
  if ($oldEndpoint) { $env:HF_ENDPOINT = $oldEndpoint } else { Remove-Item Env:HF_ENDPOINT -ErrorAction SilentlyContinue }
}

Write-Host "[✓] Model downloaded and cached" -ForegroundColor Green

# ── 5. Quick verification (with local_files_only=True to confirm cache) ──
Write-Host "[...] Verifying model loads correctly from cache ..." -ForegroundColor Yellow
& $venvPath\Scripts\python -c "
import sys
from transformers import AutoModelForCausalLM, AutoProcessor
m = AutoModelForCausalLM.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True, local_files_only=True)
p = AutoProcessor.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True, local_files_only=True)
print(f'Model: {m.__class__.__name__}')
print(f'Params: {sum(p.numel() for p in m.parameters())/1e6:.0f}M')
" 2>&1
if (-not $?) { throw "Verification failed" }
Write-Host "[✓] Florence-2 is ready!" -ForegroundColor Green

Write-Host ""
Write-Host "Next step:" -ForegroundColor Cyan
Write-Host "  Set this env var so the agent uses the venv Python:"
Write-Host "  `$env:LLMA_VISION_PYTHON = '$(Resolve-Path "$venvPath\Scripts\python.exe")'"
Write-Host "  (Add to your `$PROFILE for persistence)"
Write-Host ""
