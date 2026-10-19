param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
    $shootingPort = 8780
    $shootingUrl = "http://127.0.0.1:$shootingPort"
    $shootingHealth = $null
    try { $shootingHealth = Invoke-RestMethod -Uri "$shootingUrl/research-health" -TimeoutSec 2 } catch {}
    if ($shootingHealth -and $shootingHealth.root -ne $PSScriptRoot) { throw 'Another project is using port 8780. Close its server before starting this project.' }
    if (!$shootingHealth -or $shootingHealth.service -ne 'eye-tracking-research' -or $shootingHealth.shooting_schema -ne 'gaze-shooting-1.0.0' -or $shootingHealth.root -ne $PSScriptRoot) {
        $shootingPython = Join-Path $PSScriptRoot '.aimlab-venv\Scripts\python.exe'
        if (!(Test-Path -LiteralPath $shootingPython)) { $shootingPython = (Get-Command python).Source }
        Start-Process -FilePath $shootingPython -ArgumentList @('server.py', '--port', "$shootingPort") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
        $shootingDeadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 300
            try { $shootingHealth = Invoke-RestMethod -Uri "$shootingUrl/research-health" -TimeoutSec 1 } catch {}
            if ($shootingHealth -and $shootingHealth.service -eq 'eye-tracking-research' -and $shootingHealth.shooting_schema -eq 'gaze-shooting-1.0.0' -and $shootingHealth.root -eq $PSScriptRoot) { break }
        } while ((Get-Date) -lt $shootingDeadline)
    }
    if (!$shootingHealth -or $shootingHealth.service -ne 'eye-tracking-research' -or $shootingHealth.shooting_schema -ne 'gaze-shooting-1.0.0' -or $shootingHealth.root -ne $PSScriptRoot) {
        throw 'The research server could not start. Check whether port 8780 is in use, then run python server.py --port 8780 in this project folder.'
    }
    if (!$NoBrowser) { Start-Process "$shootingUrl/index.html?study=shooting" }
}
catch {
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '3D Shooting Research', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Error) | Out-Null
    exit 1
}
