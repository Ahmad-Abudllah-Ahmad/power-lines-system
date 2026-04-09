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

function Run-Step($command, $errorMessage) {
    Write-Host $command
    Invoke-Expression $command
    if ($LASTEXITCODE -ne 0) {
        Fail $errorMessage
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Info "Checking active Python environment"
try {
    $pythonCmd = (Get-Command python -ErrorAction Stop).Source
    Write-Info "Python: $pythonCmd"
} catch {
    Fail "Python is not available. Activate your virtual environment first."
}

try {
    python -m pip --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail "pip is not available in the active environment."
    }
} catch {
    Fail "pip is not available in the active environment."
}

if (-not $env:VIRTUAL_ENV) {
    Fail "No active virtual environment detected. Activate your venv first."
}

$pyver = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0) {
    Fail "Unable to detect Python version."
}

Write-Info "Detected Python $pyver"
if ($pyver -notmatch '^(3\.10|3\.11|3\.12)$') {
    Write-WarnMsg "PyTorch wheels are safest on Python 3.10, 3.11, or 3.12. Current: $pyver"
}

Write-Info "Upgrading pip, setuptools, wheel"
Run-Step "python -m pip install --upgrade pip setuptools wheel" "Failed while upgrading pip/setuptools/wheel."

Write-Info "Removing any existing torch packages"
python -m pip uninstall -y torch torchvision torchaudio | Out-Host

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
                Write-WarnMsg "NVIDIA GPU detected but query returned no GPU name. Falling back to CPU requirements."
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
Run-Step "python -m pip install --no-cache-dir -r `"$targetFile`"" "Dependency installation failed."

Write-Info "Verifying torch installation"
python -c "import torch; print('torch:', torch.__version__); print('torch.version.cuda:', torch.version.cuda); print('cuda_available:', torch.cuda.is_available()); print('device_count:', torch.cuda.device_count()); print('gpu0:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
if ($LASTEXITCODE -ne 0) {
    Fail "Torch verification failed."
}

Write-Info "Dependency installation completed successfully"