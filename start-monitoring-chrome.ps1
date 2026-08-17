$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Profile = Join-Path $PSScriptRoot "chrome-profile"

if (-not (Test-Path $Chrome)) {
  throw "Google Chrome not found: $Chrome"
}

New-Item -ItemType Directory -Force -Path $Profile | Out-Null
Start-Process -FilePath $Chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$Profile",
  "--no-first-run",
  "--no-default-browser-check"
)

Write-Host "Monitoring Chrome started. Use this separate Chrome window for any required login or cookie consent."
