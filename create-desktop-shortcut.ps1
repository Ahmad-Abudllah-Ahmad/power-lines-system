# ─────────────────────────────────────────────────────────────────────
#  AzerEnerji Dashboard - Desktop Shortcut Creator
#  Run once: powershell -ExecutionPolicy Bypass -File create-desktop-shortcut.ps1
# ─────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$ProjectRoot  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$VenvPython   = Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe"
$LogoPng      = Join-Path $ProjectRoot "frontend\public\AZER-logo-chrometab-removebg-preview.png"
$IconPath     = Join-Path $ProjectRoot "app-icon.ico"
$LauncherBat  = Join-Path $ProjectRoot "launcher.bat"
$ConvertScript = Join-Path $ProjectRoot "tools\convert_icon.py"
$DesktopPath  = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "AzerEnerji Dashboard.lnk"

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  AzerEnerji Dashboard - Desktop Shortcut Setup" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Generate .ico from logo PNG using Pillow ──────────────────
if (-not (Test-Path $IconPath)) {
    Write-Host "[1/2] Generating application icon..." -ForegroundColor Yellow

    if (-not (Test-Path $VenvPython)) {
        Write-Host "[ERROR] Python venv not found at: $VenvPython" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $LogoPng)) {
        Write-Host "[ERROR] Logo PNG not found at: $LogoPng" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $ConvertScript)) {
        Write-Host "[ERROR] Icon converter not found at: $ConvertScript" -ForegroundColor Red
        exit 1
    }

    & $VenvPython $ConvertScript $LogoPng $IconPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to generate icon." -ForegroundColor Red
        exit 1
    }
    Write-Host "       Icon generated successfully." -ForegroundColor Green
} else {
    Write-Host "[1/2] Icon already exists, skipping generation." -ForegroundColor Green
}

# ── Step 2: Create desktop shortcut ───────────────────────────────────
Write-Host "[2/2] Creating desktop shortcut..." -ForegroundColor Yellow

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $LauncherBat
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.IconLocation = "$IconPath, 0"
$Shortcut.Description = "Launch AzerEnerji Energy Dashboard (Backend + Frontend)"
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host "  Desktop shortcut created successfully!" -ForegroundColor Green
Write-Host "  Location: $ShortcutPath" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Double-click 'AzerEnerji Dashboard' on your desktop to launch." -ForegroundColor White
Write-Host ""
