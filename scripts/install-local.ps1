# Installs the freshly built app for the current user and adds Desktop + Start Menu shortcuts.
# Run after `npm run dist:win` (or use `npm run install:local`). Re-running updates the install.
# Saved connections and history live in %APPDATA%\ConnectD and are not touched.

param(
  [string]$Source = (Join-Path $PSScriptRoot '..\release\win-unpacked')
)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'Programs\ConnectD'
$Source = (Resolve-Path $Source).Path

if (-not (Test-Path (Join-Path $Source 'ConnectD.exe'))) {
  throw "No build found in $Source. Run: npm run dist:win"
}
if (Get-Process ConnectD -ErrorAction SilentlyContinue) {
  throw 'ConnectD is running. Close it and run this again.'
}

# Replace the previous install, but only if that folder really is a ConnectD install.
if (Test-Path $dest) {
  if (-not (Test-Path (Join-Path $dest 'ConnectD.exe'))) {
    throw "$dest exists but is not a ConnectD install; not touching it."
  }
  Remove-Item $dest -Recurse -Force
}
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Copy-Item $Source $dest -Recurse

$exe = Join-Path $dest 'ConnectD.exe'
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'ConnectD.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'ConnectD - database client for MySQL and PostgreSQL'
  $lnk.Save()
}

$version = (Get-Item $exe).VersionInfo.ProductVersion
Write-Output "Installed ConnectD $version to $dest"
Write-Output "Shortcuts: $($places -join ', ')"
