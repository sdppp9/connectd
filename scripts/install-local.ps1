# Installs the freshly built app for the current user: Desktop + Start Menu shortcuts and an
# uninstaller (Start Menu "Uninstall ConnectD" and Settings > Apps > Installed apps).
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
Copy-Item (Join-Path $PSScriptRoot 'uninstall-local.ps1') (Join-Path $dest 'uninstall.ps1')

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

# Uninstall: Start Menu shortcut + entry in Settings > Apps > Installed apps (per user).
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$uninstallArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $dest 'uninstall.ps1')`""
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Uninstall ConnectD.lnk'))
$lnk.TargetPath = $ps
$lnk.Arguments = $uninstallArgs
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'Uninstall ConnectD'
$lnk.Save()

$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ConnectD'
New-Item -Path $regKey -Force | Out-Null
$sizeKb = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
$values = @{
  DisplayName          = 'ConnectD'
  DisplayVersion       = ($version -replace '\.0$', '')
  Publisher            = 'sdppp9'
  DisplayIcon          = "$exe,0"
  InstallLocation      = $dest
  UninstallString      = "`"$ps`" $uninstallArgs"
  QuietUninstallString = "`"$ps`" $uninstallArgs -Quiet"
  URLInfoAbout         = 'https://github.com/sdppp9/connectd'
}
foreach ($k in $values.Keys) {
  New-ItemProperty -Path $regKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null
}
foreach ($k in 'NoModify', 'NoRepair') {
  New-ItemProperty -Path $regKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null
}
New-ItemProperty -Path $regKey -Name EstimatedSize -Value $sizeKb -PropertyType DWord -Force | Out-Null

Write-Output "Installed ConnectD $version to $dest"
Write-Output "Shortcuts: $($places -join ', ')"
