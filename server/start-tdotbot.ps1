$ErrorActionPreference = 'Continue'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $PSScriptRoot 'logs'
$logFile = Join-Path $logDirectory 'tdotbot-server.log'

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location -LiteralPath $projectDirectory

while ($true) {
    "[$(Get-Date -Format o)] Starting Tdotbot server" | Add-Content -LiteralPath $logFile
    & node 'server/index.mjs' *>> $logFile
    "[$(Get-Date -Format o)] Server stopped; restarting in 5 seconds" | Add-Content -LiteralPath $logFile
    Start-Sleep -Seconds 5
}
