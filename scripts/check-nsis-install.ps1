<#
.SYNOPSIS
  Install the freshly built NSIS package and prove it went through the
  directory swap and left exactly the packaged tree behind.

.DESCRIPTION
  The installer extracts into "<target>.new-<GUID>" beside the install
  directory and renames it into place (scripts/installer-directories.nsh).
  An exit code of 0 proves little on its own, so this script asserts what
  distinguishes that path from electron-builder's own:

    * the staging directory "<target>.new-*" appears while the installer runs,
      and electron-builder's "$PLUGINSDIR\7z-out" (TEMP\ns*.tmp) never does;
    * afterwards no "<target>.new-*" or "<target>.old-*" sibling is left;
    * the installed tree is exactly release/win-unpacked plus the uninstaller
      and the two 7-Zip licence files: nothing missing, nothing extra.

  Scenarios:
    fast     empty target, short path                 -> installed
    dirty    target holds a file that is not ours      -> refused (exit 2),
                                                          folder untouched
    deep     empty target deep enough that the longest packed path passes
             300 characters                           -> installed, nothing lost
    replace  install, plant stale files in the install, install again into
             the same directory                       -> stale files gone

  The product's HKCU registration and desktop shortcut are backed up, removed
  for the duration and restored afterwards, so an installation already on the
  machine is neither uninstalled nor repointed. The install this script makes
  is removed with its own uninstaller before the restore.

.EXAMPLE
  ./scripts/check-nsis-install.ps1 -Scenario fast -Smoke
#>
param(
  [ValidateSet('fast', 'dirty', 'deep', 'replace')]
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
$productKey = 'HKCU:\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$productKeyReg = 'HKCU\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKeyReg = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'DSH Desktop Pro.lnk'
$uninstallerName = 'Uninstall DSH Desktop Pro.exe'
# Written by the installer itself, not part of win-unpacked.
$installerWritten = @($uninstallerName, '7zip-installer-LICENSE.txt', '7zip-installer-COPYING.txt')

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

function Get-RelativeFiles([string]$Root) {
  @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($Root.Length + 1) })
}

function Get-SwapSiblings([string]$Target) {
  $parent = Split-Path -Parent $Target
  $leaf = Split-Path -Leaf $Target
  @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$leaf.new-*" -or $_.Name -like "$leaf.old-*" } |
    Select-Object -ExpandProperty FullName)
}

# Run the installer silently and watch which directories it creates.
function Invoke-WatchedInstall([string]$Target) {
  $parent = Split-Path -Parent $Target
  $leaf = Split-Path -Leaf $Target
  $result = [ordered]@{ ExitCode = $null; Seconds = 0.0; SawStaging = $false; SawTempCopy = $false }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $installerFile.FullName -ArgumentList @('/S', "/D=$Target") -PassThru
  $deadline = (Get-Date).AddSeconds(900)
  while (-not $process.HasExited) {
    if (@(Get-ChildItem -LiteralPath $parent -Directory -Filter "$leaf.new-*" -ErrorAction SilentlyContinue).Count -gt 0) {
      $result.SawStaging = $true
    }
    foreach ($plugins in @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue)) {
      if (Test-Path -LiteralPath (Join-Path $plugins.FullName '7z-out')) { $result.SawTempCopy = $true }
    }
    if ((Get-Date) -gt $deadline) { throw 'installer did not finish within 900 seconds' }
    Start-Sleep -Milliseconds 100
  }
  $process.WaitForExit()
  $clock.Stop()
  $result.ExitCode = $process.ExitCode
  $result.Seconds = $clock.Elapsed.TotalSeconds
  [PSCustomObject]$result
}

function Assert-NoSwapLeftovers([string]$Target) {
  $left = Get-SwapSiblings $Target
  if ($left.Count -gt 0) { throw "scenario '$Scenario' left swap directories behind: $($left -join ', ')" }
}

function Assert-SwappedInstall($Run, [string]$Target, [string]$What) {
  if ($Run.ExitCode -ne 0) { throw "$What exited with code $($Run.ExitCode) (scenario $Scenario)" }
  Write-Step ("{0} took {1:N1}s" -f $What, $Run.Seconds)
  if ($Run.SawTempCopy) { throw "$What extracted into `$PLUGINSDIR\7z-out: electron-builder's copy path ran" }
  if (-not $Run.SawStaging) { throw "$What never created $Target.new-*: the directory swap did not run" }
  Assert-NoSwapLeftovers $Target

  $installed = Get-RelativeFiles $Target
  $installedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$installed, [StringComparer]::OrdinalIgnoreCase)
  $missing = @($expectedFiles | Where-Object { -not $installedSet.Contains($_) })
  if ($missing.Count -gt 0) {
    Write-Host "The installed tree is missing $($missing.Count) file(s):"
    foreach ($path in ($missing | Select-Object -First 20)) {
      Write-Host ("  [{0} chars] {1}" -f ($Target.Length + 1 + $path.Length), $path)
    }
    throw "$What lost $($missing.Count) file(s) between release/win-unpacked and $Target"
  }
  $extra = @($installed | Where-Object { -not $expectedSet.Contains($_) })
  if ($extra.Count -gt 0) {
    throw "$What left $($extra.Count) file(s) that are not part of this version: $(($extra | Select-Object -First 20) -join ', ')"
  }
  Write-Step "$What installed exactly $($installed.Count) files (packed $($packed.Count) + $($installerWritten.Count) written by the installer)"
  $installed.Count
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

$packed = Get-RelativeFiles $unpacked
$expectedFiles = @($packed) + $installerWritten
$expectedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$expectedFiles, [StringComparer]::OrdinalIgnoreCase)
$longestPacked = ($packed | Measure-Object -Property Length -Maximum).Maximum

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
switch ($Scenario) {
  'deep' {
    # Deep enough that the longest packed file lands past 300 characters, well
    # beyond MAX_PATH, and its staging path deeper still.
    $target = 300 - 1 - $longestPacked
    $prefix = Join-Path $base 'dsh-deep-'
    if ($prefix.Length -ge $target) {
      throw "cannot build a $target-character install path under $base (already $($prefix.Length))"
    }
    $installDir = $prefix + ('d' * ($target - $prefix.Length))
  }
  'dirty' { $installDir = Join-Path $base ('dsh-d' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
  'replace' { $installDir = Join-Path $base ('dsh-r' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
  default { $installDir = Join-Path $base ('dsh-f' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
}
# NSIS /D= must be the final, unquoted argument.
if ($installDir.Contains(' ')) { throw "install path must not contain spaces: $installDir" }

Write-Step "scenario=$Scenario  installer=$($installerFile.Name)"
Write-Step "target=$installDir ($($installDir.Length) chars; longest packed path $longestPacked)"

$backup = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-nsis-install-backup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$hadProductKey = Test-Path -Path $productKey
$hadUninstallKey = Test-Path -Path $uninstallKey
$hadShortcut = Test-Path -LiteralPath $shortcut
$installerStateIsolated = $false
$uninstaller = Join-Path $installDir $uninstallerName
$summary = ''

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

  switch ($Scenario) {
    'dirty' {
      # Not ours: no registration, no product executable. Replacing it would
      # move the folder away and delete it, so the installer must refuse.
      New-Item -ItemType Directory -Force -Path $installDir | Out-Null
      $foreign = Join-Path $installDir 'leftover.dat'
      Set-Content -LiteralPath $foreign -Value 'a file this installer does not own'
      $before = (Get-FileHash -LiteralPath $foreign).Hash
      $run = Invoke-WatchedInstall $installDir
      Write-Step ("installer exited {0} after {1:N1}s" -f $run.ExitCode, $run.Seconds)
      if ($run.ExitCode -ne 2) { throw "a non-empty foreign folder was not refused (exit $($run.ExitCode), expected 2)" }
      Assert-NoSwapLeftovers $installDir
      $now = @(Get-RelativeFiles $installDir)
      if ($now.Count -ne 1 -or $now[0] -ne 'leftover.dat' -or (Get-FileHash -LiteralPath $foreign).Hash -ne $before) {
        throw "the refused folder was changed: $($now -join ', ')"
      }
      if (Test-Path -Path $productKey) { throw 'a refused install still wrote the product registration' }
      Write-Step 'non-empty foreign folder refused and left untouched'
      $summary = '[install] dirty: 拒绝非空的非本产品目录（退出码 2），目录原样保留'
    }
    'replace' {
      $first = Invoke-WatchedInstall $installDir
      [void](Assert-SwappedInstall $first $installDir 'first install')
      # What an older version would have left: a file at the root and one deep
      # in the runtime tree, neither shipped by this build.
      $stale = @('stale-from-old-version.dll', 'resources\dsh-runtime\app.asar.unpacked\stale-module.js')
      foreach ($name in $stale) {
        Set-Content -LiteralPath (Join-Path $installDir $name) -Value 'stale'
      }
      $second = Invoke-WatchedInstall $installDir
      $count = Assert-SwappedInstall $second $installDir 'reinstall into the same directory'
      $registered = (Get-ItemProperty -Path $productKey -Name InstallLocation).InstallLocation
      if ($registered -ne $installDir) { throw "InstallLocation mismatch: expected $installDir, got $registered" }
      Write-Step 'stale files of the replaced installation are gone'
      $summary = ('[install] replace: 首装 {0:N1}s，同目录覆盖 {1:N1}s / {2} 个文件（无残留）' -f $first.Seconds, $second.Seconds, $count)
    }
    default {
      $run = Invoke-WatchedInstall $installDir
      $count = Assert-SwappedInstall $run $installDir 'install'
      $summary = ('[install] {0}: {1:N1}s / {2} 个文件（安装目录 {3} 字符）' -f $Scenario, $run.Seconds, $count, $installDir.Length)
    }
  }

  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary }

  if ($Smoke -and $Scenario -ne 'dirty') {
    $executable = Join-Path $installDir 'DSH Desktop Pro.exe'
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
    foreach ($sibling in (Get-SwapSiblings $installDir)) {
      Remove-Item -LiteralPath $sibling -Recurse -Force -ErrorAction SilentlyContinue
    }
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
