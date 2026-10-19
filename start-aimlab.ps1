param([int]$Camera = 0)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$aimPython = Join-Path $PSScriptRoot '.aimlab-venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $aimPython)) {
    python -m venv .aimlab-venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Aim Lab Python environment.' }
}
$aimStamp = Join-Path $PSScriptRoot '.aimlab-venv\requirements.sha256'
$aimHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'aimlab-requirements.txt')).Hash
if (!(Test-Path -LiteralPath $aimStamp) -or (Get-Content -LiteralPath $aimStamp -Raw).Trim() -ne $aimHash) {
    & $aimPython -m pip install -r aimlab-requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies. Check the network and Python version (3.11-3.13).' }
    Set-Content -LiteralPath $aimStamp -Value $aimHash -Encoding ascii
}
& $aimPython aimlab.py --camera $Camera
if ($LASTEXITCODE -ne 0) { throw 'Aim Lab recorder failed. See the message above.' }
