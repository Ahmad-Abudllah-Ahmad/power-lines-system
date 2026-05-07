# Helper: run a bash script on the RunPod pod via SSH proxy and capture output
# Usage:  .\scripts\pod_exec.ps1 -ScriptText "uname -a; nvidia-smi -L"
#         .\scripts\pod_exec.ps1 -ScriptFile path\to\script.sh
param(
    [string]$ScriptText = "",
    [string]$ScriptFile = "",
    [int]$TimeoutSec = 90,
    [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$Host_ = "root@103.196.86.103"
)

if ($ScriptFile) { $ScriptText = Get-Content $ScriptFile -Raw }
if (-not $ScriptText) { Write-Error "Provide -ScriptText or -ScriptFile"; exit 1 }

# Wrap script with markers and force exit so the interactive shell terminates.
$wrapped = @"
set -e
echo '___POD_BEGIN___'
$ScriptText
echo '___POD_END___'
exit 0

"@

$tmp = New-TemporaryFile
Set-Content -Path $tmp.FullName -Value $wrapped -NoNewline
try {
    $raw = Get-Content $tmp.FullName -Raw
    $proc = Start-Process -FilePath "ssh" `
        -ArgumentList @("-tt","-i",$KeyPath,"-p","19056","-o","StrictHostKeyChecking=no","-o","IdentitiesOnly=yes","-o","ConnectTimeout=20",$Host_) `
        -RedirectStandardInput $tmp.FullName `
        -RedirectStandardOutput "$tmp.out" `
        -RedirectStandardError "$tmp.err" `
        -NoNewWindow -PassThru
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch {}
        Write-Error "SSH timed out after $TimeoutSec s"
    }
    $stdout = Get-Content "$tmp.out" -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content "$tmp.err" -Raw -ErrorAction SilentlyContinue
    if ($stderr) { Write-Host "[stderr] $stderr" -ForegroundColor DarkYellow }
    # Strip the runpod banner & only print what's between markers
    $body = $stdout
    if ($body -match "___POD_BEGIN___([\s\S]*?)___POD_END___") {
        Write-Output $matches[1].Trim()
    } else {
        Write-Output $stdout
    }
} finally {
    Remove-Item $tmp.FullName,"$tmp.out","$tmp.err" -ErrorAction SilentlyContinue
}
