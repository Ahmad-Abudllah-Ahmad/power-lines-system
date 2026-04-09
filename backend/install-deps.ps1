param(
    [switch]$ForceCpu,
    [switch]$ForceGpu
)

$ErrorActionPreference = "Stop"

function Write-Info($msg) {
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Write-WarnMsg($msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Fail($msg) {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Info "Using Python from active environment"
try {
    $pythonCmd = (Get-Command python -ErrorAction Stop).Source
    Write-Info "Python: $pythonCmd"
} catch {
    Fail "Python is not available. Activate your virtual environment first."
}

try {
    python -m pip --version | Out-Host
} catch {
    Fail "pip is not available in the active environment."
}

Write-Info "Upgrading pip, setuptools, wheel"
python -m pip install --upgrade pip setuptools wheel

$targetFile = $null

if ($ForceCpu -and $ForceGpu) {
    Fail "Use only one of -ForceCpu or -ForceGpu."
}

if ($ForceCpu) {
    $targetFile = "requirements-cpu.txt"
    Write-Info "Forced CPU install selected"
}
elseif ($ForceGpu) {
    $targetFile = "requirements-gpu.txt"
    Write-Info "Forced GPU install selected"
}
else {
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($null -eq $nvidiaSmi) {
        Write-WarnMsg "nvidia-smi not found. Falling back to CPU requirements."
        $targetFile = "requirements-cpu.txt"
    }
    else {
        try {
            $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1).Trim()
            if ([string]::IsNullOrWhiteSpace($gpuName)) {
                Write-WarnMsg "NVIDIA GPU query returned no name. Falling back to CPU requirements."
                $targetFile = "requirements-cpu.txt"
            }
            else {
                Write-Info "Detected NVIDIA GPU: $gpuName"
                $targetFile = "requirements-gpu.txt"
            }
        } catch {
            Write-WarnMsg "Failed to query NVIDIA GPU. Falling back to CPU requirements."
            $targetFile = "requirements-cpu.txt"
        }
    }
}

if (-not (Test-Path $targetFile)) {
    Fail "$targetFile not found in $scriptDir"
}

Write-Info "Installing dependencies from $targetFile"
python -m pip install -r $targetFile

Write-Info "Verifying torch installation"
python -c "import torch; print('torch:', torch.__version__); print('torch.version.cuda:', torch.version.cuda); print('cuda_available:', torch.cuda.is_available()); print('device_count:', torch.cuda.device_count())"

Write-Info "Installation completed successfully"
