<#
.SYNOPSIS
  Install the freshly built NSIS package once and prove which extraction path
  ran and that nothing was lost on the way.

.DESCRIPTION
  scripts/patch-nsis-install-details.mjs splices a direct-extract fast path in
  front of electron-builder's staged copy. The fast path is roughly three times
  quicker, and it is only correct under two conditions: $INSTDIR must be empty,
  and $INSTDIR must be short enough that the deepest packed file still lands
  inside MAX_PATH. Both failure modes are silent — 7-Zip drops what it cannot
  write and sets no error flag, so a broken guard still produces exit code 0
  and an executable that starts.

  So neither "the installer exited 0" nor "a stray file survived" is evidence.
  This script asserts the two things that actually distinguish the paths:

    * which branch ran, observed directly — the staged copy materialises
      $PLUGINSDIR\7z-out under %TEMP%\ns*.tmp while it works, and the fast path
      never creates it;
    * that the installed tree has every file release/win-unpacked has, so a
      guard that wrongly allowed the fast path is caught by the files it drops
      rather than by nobody noticing.

  Scenarios:
    fast   empty target, short path            -> direct extract
    dirty  target seeded with a leftover file  -> staged copy
    deep   empty target, one character past the installer's MAX_PATH budget
                                               -> staged copy

  The product's HKCU registration and desktop shortcut are backed up, removed
  for the duration and restored afterwards, so an installation already on the
  machine is neither uninstalled nor repointed. The install this script makes
  is removed with its own uninstaller before the restore.

.EXAMPLE
  ./scripts/check-nsis-install.ps1 -Scenario fast -Smoke
#>
param(
  [ValidateSet('fast', 'dirty', 'deep')]
  [string]$Scenario = 'fast',
  [string]$Installer = '',
  [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'check-nsis-install.ps1 is Windows-only'
}

$appDir = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $appDir 'release'
$unpacked = Join-Path $releaseDir 'win-unpacked'
$budgetFile = Join-Path $appDir '.build\nsis-path-budget.json'
$productKey = 'HKCU:\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$productKeyReg = 'HKCU\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKeyReg = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'DSH Desktop.lnk'

function Write-Step([string]$Message) {
  Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message)
}

function Export-RegistryKey([string]$Key, [string]$Destination) {
  $output = @(& reg.exe export $Key $Destination /y 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    throw "failed to back up registry key $Key (reg.exe exit $exitCode): $($output -join ' ')"
  }
}

function Import-RegistryKey([string]$Key, [string]$Source) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "registry backup for $Key is missing: $Source"
  }
  $output = @(& reg.exe import $Source 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "failed to restore registry key $Key (reg.exe exit $exitCode): $($output -join ' ')"
  }
}

if ($Installer -eq '') {
  $candidates = @(Get-ChildItem -Path $releaseDir -File -Filter 'dsh-desktop-*-win-x64.exe' -ErrorAction SilentlyContinue)
  if ($candidates.Count -ne 1) {
    throw "Expected exactly one Windows NSIS installer under $releaseDir, found $($candidates.Count)"
  }
  $Installer = $candidates[0].FullName
}
$installerFile = Get-Item -LiteralPath $Installer
if (-not (Test-Path -LiteralPath $unpacked)) {
  throw "release/win-unpacked not found: $unpacked — the packed tree is what the installed tree is compared against"
}
if (-not (Test-Path -LiteralPath $budgetFile)) {
  throw "missing $budgetFile — the electron-builder beforePack hook did not run"
}
$budget = (Get-Content -LiteralPath $budgetFile -Raw | ConvertFrom-Json).budget

# What the installer should produce: everything in win-unpacked, plus the
# uninstaller it writes itself, plus anything this scenario seeded.
$packed = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File |
  ForEach-Object { $_.FullName.Substring($unpacked.Length + 1) })

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$seeded = @()
switch ($Scenario) {
  'deep' {
    # Exactly one character past the budget: over the line for the fast path,
    # but still inside what SHFileOperation reaches, so the staged copy must
    # succeed. Overshooting further would test Windows, not this guard.
    $target = $budget + 1
    $prefix = Join-Path $base 'dsh-deep-'
    if ($prefix.Length -ge $target) {
      throw "cannot build a $target-character install path under $base (already $($prefix.Length))"
    }
    $installDir = $prefix + ('d' * ($target - $prefix.Length))
    $expectStaged = $true
  }
  'dirty' {
    # Short suffixes on purpose: these two scenarios must fit inside the budget,
    # and a developer's %TEMP% is far longer than the runner's D:\a\_temp.
    $installDir = Join-Path $base ('dsh-d' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $seeded = @('leftover.dat')
    $expectStaged = $true
  }
  default {
    $installDir = Join-Path $base ('dsh-f' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $expectStaged = $false
  }
}
# NSIS /D= must be the final, unquoted argument.
if ($installDir.Contains(' ')) { throw "install path must not contain spaces: $installDir" }
if ($Scenario -ne 'deep' -and $installDir.Length -gt $budget) {
  throw "scenario '$Scenario' needs an install path within the $budget-character budget, got $($installDir.Length)"
}

Write-Step "scenario=$Scenario  installer=$($installerFile.Name)"
Write-Step "target=$installDir ($($installDir.Length) chars, budget $budget)"

$backup = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-nsis-install-backup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$hadProductKey = Test-Path -Path $productKey
$hadUninstallKey = Test-Path -Path $uninstallKey
$hadShortcut = Test-Path -LiteralPath $shortcut
$installerStateIsolated = $false
$uninstaller = Join-Path $installDir 'Uninstall DSH Desktop.exe'

try {
  # --- shield an installation that may already be on this machine ----------
  if ($hadProductKey) { Export-RegistryKey $productKeyReg (Join-Path $backup 'product.reg') }
  if ($hadUninstallKey) { Export-RegistryKey $uninstallKeyReg (Join-Path $backup 'uninstall.reg') }
  if ($hadShortcut) { Copy-Item -LiteralPath $shortcut -Destination (Join-Path $backup 'shortcut.lnk') -Force }
  # Do not let a failed backup enter cleanup that removes the live state. Once
  # this flips, every original artifact has a verified backup ready to restore.
  $installerStateIsolated = $true
  Remove-Item -Path $productKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue

  if ($seeded.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    foreach ($name in $seeded) {
      Set-Content -LiteralPath (Join-Path $installDir $name) -Value 'left behind by an uninstall that could not delete it'
    }
    Write-Step "seeded $($seeded -join ', ') into the target"
  }

  # --- install, watching which extraction path runs ------------------------
  $sawStaging = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $installerFile.FullName -ArgumentList @('/S', "/D=$installDir") -PassThru
  $deadline = (Get-Date).AddSeconds(900)
  while (-not $process.HasExited) {
    # The staged copy extracts into $PLUGINSDIR\7z-out; the fast path never
    # creates that directory. This is the only externally visible difference
    # between the two paths, and it is what makes this test more than a
    # restatement of "the installer exited 0".
    foreach ($plugins in @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue)) {
      if (Test-Path -LiteralPath (Join-Path $plugins.FullName '7z-out')) { $sawStaging = $true }
    }
    if ((Get-Date) -gt $deadline) { throw 'installer did not finish within 900 seconds' }
    Start-Sleep -Milliseconds 200
  }
  $process.WaitForExit()
  $clock.Stop()
  if ($process.ExitCode -ne 0) {
    throw "installer exited with code $($process.ExitCode) (scenario $Scenario)"
  }

  $branch = if ($sawStaging) { 'staged copy' } else { 'direct extract' }
  $wanted = if ($expectStaged) { 'staged copy' } else { 'direct extract' }
  Write-Step ("took {0:N1}s via the {1}" -f $clock.Elapsed.TotalSeconds, $branch)
  if ($sawStaging -ne $expectStaged) {
    throw "scenario '$Scenario' ran the $branch, expected the $wanted"
  }

  # --- and prove the tree is whole ----------------------------------------
  $installed = @(Get-ChildItem -LiteralPath $installDir -Recurse -File |
    ForEach-Object { $_.FullName.Substring($installDir.Length + 1) })
  $installedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$installed)
  $missing = @($packed | Where-Object { -not $installedSet.Contains($_) })
  if ($missing.Count -gt 0) {
    Write-Host "The installed tree is missing $($missing.Count) packed file(s):"
    foreach ($path in ($missing | Select-Object -First 20)) {
      Write-Host ("  [{0} chars] {1}" -f ($installDir.Length + 1 + $path.Length), $path)
    }
    throw "scenario '$Scenario' lost $($missing.Count) file(s) between release/win-unpacked and $installDir"
  }
  $executable = Join-Path $installDir 'DSH Desktop.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "installed executable not found: $executable"
  }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "installed uninstaller not found: $uninstaller"
  }
  $expected = $packed.Count + 1 + $seeded.Count   # + the uninstaller it writes
  Write-Step "installed $($installed.Count) files (packed $($packed.Count) + uninstaller + $($seeded.Count) seeded = $expected), none missing"

  if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value (
      '[install] {0}: {1:N1}s / {2} 个文件 / {3}（安装目录 {4} 字符，预算 {5}）' -f
        $Scenario, $clock.Elapsed.TotalSeconds, $installed.Count, $branch, $installDir.Length, $budget)
  }

  if ($Smoke) {
    Push-Location $appDir
    try {
      node scripts/smoke-package.mjs "$executable"
      if ($LASTEXITCODE -ne 0) { throw "installed runtime smoke failed with code $LASTEXITCODE" }
    } finally { Pop-Location }
    Write-Step 'installed runtime smoke passed'
  }
}
finally {
  # --- remove this run's install, then put the machine back ---------------
  if ($installerStateIsolated) {
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -PassThru
      [void]$remove.WaitForExit(300000)
      # An NSIS uninstaller copies itself into TEMP and relaunches, letting the
      # original exit immediately; waiting only on the process that was started
      # returns while files are still going away.
      $quiet = (Get-Date).AddSeconds(120)
      while ((Get-Date) -lt $quiet) {
        if (-not @(Get-Process -ErrorAction SilentlyContinue |
          Where-Object { @('Un_A', 'Un_B', 'Un_C') -contains $_.Name })) { break }
        Start-Sleep -Milliseconds 500
      }
      Write-Step 'test install uninstalled'
    }
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  $restoreFailures = [System.Collections.Generic.List[string]]::new()
  if ($installerStateIsolated) {
    Remove-Item -Path $productKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
    if ($hadProductKey) {
      try { Import-RegistryKey $productKeyReg (Join-Path $backup 'product.reg') }
      catch { $restoreFailures.Add($_.Exception.Message) }
    }
    if ($hadUninstallKey) {
      try { Import-RegistryKey $uninstallKeyReg (Join-Path $backup 'uninstall.reg') }
      catch { $restoreFailures.Add($_.Exception.Message) }
    }
    if ($hadShortcut) {
      try { Copy-Item -LiteralPath (Join-Path $backup 'shortcut.lnk') -Destination $shortcut -Force }
      catch { $restoreFailures.Add("failed to restore desktop shortcut: $($_.Exception.Message)") }
    }

    if ($hadProductKey -and -not (Test-Path -Path $productKey)) {
      $restoreFailures.Add('failed to restore the existing product registry key')
    }
    if ($hadUninstallKey -and -not (Test-Path -Path $uninstallKey)) {
      $restoreFailures.Add('failed to restore the existing uninstall registry key')
    }
    if ($hadShortcut -and -not (Test-Path -LiteralPath $shortcut)) {
      $restoreFailures.Add('failed to restore the existing desktop shortcut')
    }
  }

  if ($restoreFailures.Count -eq 0) {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    throw "failed to restore pre-existing installation state; backup retained at ${backup}: $($restoreFailures -join '; ')"
  }
  Write-Step 'pre-existing installation state restored'
}
