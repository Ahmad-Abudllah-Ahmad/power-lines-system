# Runs a bash script on the pod via SSH proxy. Reads from -InputFile, returns text between BEGIN/END markers.
param(
    [Parameter(Mandatory=$true)][string]$InputFile,
    [int]$TimeoutSec = 120,
    [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$Host_ = "root@103.196.86.103"
)

$body = Get-Content $InputFile -Raw
$wrapped = "echo '___POD_BEGIN___'`n$body`necho '___POD_END___'`nexit 0`n"

$tmpIn  = [IO.Path]::GetTempFileName()
$tmpOut = [IO.Path]::GetTempFileName()
$tmpErr = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($tmpIn, $wrapped, [Text.UTF8Encoding]::new($false))

try {
    $p = Start-Process -FilePath "ssh" `
        -ArgumentList @("-tt","-i",$KeyPath,"-p","19056","-o","StrictHostKeyChecking=no","-o","IdentitiesOnly=yes","-o","ConnectTimeout=25",$Host_) `
        -RedirectStandardInput $tmpIn -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr `
        -NoNewWindow -PassThru
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; Write-Error "Timed out"; exit 1 }
    $out = Get-Content $tmpOut -Raw
    if ($out -match '(?s)___POD_BEGIN___\s*\r?\n(.*?)___POD_END___') {
        Write-Output ($matches[1].Trim())
    } else {
        Write-Host "[no markers found, raw output below]" -ForegroundColor DarkYellow
        Write-Output $out
    }
} finally {
    Remove-Item $tmpIn,$tmpOut,$tmpErr -ErrorAction SilentlyContinue
}
