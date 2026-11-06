$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/ffmpeg-static/ffmpeg.exe'))) {
    Write-Host 'Installing Frame. This first setup downloads the video engine and may take a few minutes.'
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Check your internet connection and try again.' }
}
$frameUrl = 'http://127.0.0.1:4317'
$frameRunning = $false
try { $frameResponse = Invoke-WebRequest -Uri $frameUrl -UseBasicParsing -TimeoutSec 2; $frameRunning = $frameResponse.Content -match 'Frame Studio|Your local video studio' } catch {}
if (-not $frameRunning) {
    $frameNode = (Get-Command node.exe).Source
    $frameScript = '"' + (Join-Path $PSScriptRoot 'server.js') + '"'
    Start-Process -FilePath $frameNode -ArgumentList $frameScript -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'frame-server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'frame-error.log')
    for ($frameAttempt = 0; $frameAttempt -lt 30; $frameAttempt++) {
        Start-Sleep -Milliseconds 300
        try { $frameResponse = Invoke-WebRequest -Uri $frameUrl -UseBasicParsing -TimeoutSec 1; if ($frameResponse.StatusCode -eq 200 -and $frameResponse.Content -match 'Frame Studio|Your local video studio') { $frameRunning = $true; break } } catch {}
    }
}
if (-not $frameRunning) { throw 'Frame did not start. Check frame-error.log in this folder.' }
Start-Process $frameUrl
Write-Host "Frame is ready at $frameUrl"
