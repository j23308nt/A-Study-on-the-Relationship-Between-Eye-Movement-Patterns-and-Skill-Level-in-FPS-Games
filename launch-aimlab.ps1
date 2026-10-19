# Desktop launcher: keep the terminal hidden and show startup failures in a dialog.
$ErrorActionPreference = 'Stop'
try {
    & (Join-Path $PSScriptRoot 'start-aimlab.ps1')
}
catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "Aim Lab recorder could not start.`n`n$($_.Exception.Message)`n`nClose any other recorder window and try again. For details, run start-aimlab.ps1 in PowerShell.",
        'Aim Lab recorder',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
    exit 1
}
