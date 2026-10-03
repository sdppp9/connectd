# Removes ConnectD installed by install-local.ps1: program folder, shortcuts and the
# "Installed apps" entry. Saved connections/history (%APPDATA%\ConnectD) are kept unless
# the user chooses to delete them. Backups in Documents\ConnectD Backups are never touched.
#
#   (no switches)  asks with dialogs — used by the Start Menu shortcut and Windows Settings
#   -Quiet         no dialogs; keeps data unless -RemoveData is given

param(
  [switch]$Quiet,
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'Programs\ConnectD'
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ConnectD'
$startMenu = [Environment]::GetFolderPath('Programs')
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ConnectD.lnk'),
  (Join-Path $startMenu 'ConnectD.lnk'),
  (Join-Path $startMenu 'Uninstall ConnectD.lnk')
)
# Current data folder plus the folder used before the app was renamed (it would be
# migrated back on a reinstall if left behind).
$dataDirs = @(
  (Join-Path $env:APPDATA 'ConnectD'),
  (Join-Path $env:APPDATA 'connectdee')
)

Add-Type -AssemblyName System.Windows.Forms
function Ask([string]$text, [string]$default = 'Button2') {
  $r = [System.Windows.Forms.MessageBox]::Show($text, 'Uninstall ConnectD', 'YesNo', 'Question', $default)
  return $r -eq 'Yes'
}
function Say([string]$text, [string]$icon = 'Information') {
  if ($Quiet) { Write-Output $text } else {
    [System.Windows.Forms.MessageBox]::Show($text, 'Uninstall ConnectD', 'OK', $icon) | Out-Null
  }
}

try {
  if (-not $Quiet) {
    if (-not (Ask "Uninstall ConnectD from this computer?" 'Button1')) { exit 0 }
    $RemoveData = Ask ("Also delete saved connections, query history and settings?`n`n" +
      "Choose No to keep them for a later reinstall.`n" +
      "Backups in Documents\ConnectD Backups are never deleted.")
  }

  while (Get-Process ConnectD -ErrorAction SilentlyContinue) {
    if ($Quiet) { throw 'ConnectD is running. Close it and run this again.' }
    $r = [System.Windows.Forms.MessageBox]::Show(
      "ConnectD is still open. Close it, then click Retry.",
      'Uninstall ConnectD', 'RetryCancel', 'Warning')
    if ($r -ne 'Retry') { exit 1 }
  }

  # The script may be running from inside the folder it removes.
  Set-Location $env:TEMP

  foreach ($s in $shortcuts) { if (Test-Path $s) { Remove-Item $s -Force } }
  if (Test-Path $regKey) { Remove-Item $regKey -Recurse -Force }
  if (Test-Path $dest) {
    if (-not (Test-Path (Join-Path $dest 'ConnectD.exe'))) {
      throw "$dest is not a ConnectD install; not touching it."
    }
    Remove-Item $dest -Recurse -Force
  }

  $removed = @()
  if ($RemoveData) {
    foreach ($d in $dataDirs) {
      if (Test-Path $d) { Remove-Item $d -Recurse -Force; $removed += $d }
    }
  }

  $msg = 'ConnectD was uninstalled.'
  if ($RemoveData) { $msg += "`nSaved connections and history were deleted." }
  elseif (Test-Path $dataDirs[0]) { $msg += "`nSaved connections and history were kept in $($dataDirs[0])." }
  Say $msg
} catch {
  Say "Uninstall failed: $($_.Exception.Message)" 'Error'
  exit 1
}
