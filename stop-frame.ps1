$frameServerPath = Join-Path $PSScriptRoot 'server.js'
$frameProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"' + $frameServerPath + '"') }
foreach ($frameProcess in $frameProcesses) { Stop-Process -Id $frameProcess.ProcessId -ErrorAction SilentlyContinue }
Write-Host 'Frame has stopped. Your videos and saved edits are still on this computer.'
