param(
  [string]$Installer = ''
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest renders a progress bar even on a redirected host, where it
# only slows the transfer down and prints nothing useful.
$ProgressPreference = 'SilentlyContinue'

if ($env:CI -ne 'true') {
  throw 'check-nsis-upgrade.ps1 is destructive to the test product registry keys and may run only with CI=true'
}
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'check-nsis-upgrade.ps1 is Windows-only'
}

$legacyUrl = 'https://github.com/bruc3van/dsh-desktop/releases/download/v0.2.2/dsh-desktop-0.2.2-win-x64.exe'
$legacySha256 = '8fb63ddbf1806d0171faea66ed1eeb41564a6206757785003265ef3bef2a5915'
$productKey = 'HKCU:\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$desktop = [Environment]::GetFolderPath('Desktop')
$legacyShortcut = Join-Path $desktop 'DeepSeek Harness Desktop.lnk'
$currentShortcut = Join-Path $desktop 'DSH Desktop.lnk'
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'dsh-desktop-upgrade-fixtures'
$testRoot = Join-Path $env:RUNNER_TEMP ('dsh-desktop-upgrade-' + [guid]::NewGuid().ToString('N'))
$legacyInstaller = Join-Path $fixtureRoot 'dsh-desktop-0.2.2-win-x64.exe'

if ($Installer -eq '') {
  $releaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'release'
  $candidates = @(Get-ChildItem -Path $releaseDir -File -Filter 'dsh-desktop-*-win-x64.exe')
  if ($candidates.Count -ne 1) {
    throw "Expected exactly one Windows NSIS installer under $releaseDir, found $($candidates.Count)"
  }
  $Installer = $candidates[0].FullName
}
$currentInstaller = (Resolve-Path -LiteralPath $Installer).Path

# NSIS /D= must be the final, unquoted argument. GitHub's RUNNER_TEMP currently
# has no spaces (for example D:\a\_temp); fail clearly if that precondition moves.
if ($testRoot.Contains(' ')) {
  throw "NSIS upgrade fixture root must not contain spaces: $testRoot"
}

# Every installer this script runs is silent, so nothing it does reaches the
# log on its own. Without these markers a hang is indistinguishable from a slow
# download: the step simply prints nothing until the job hits its 45-minute
# timeout. Print what is about to run, and bound how long it may take.
function Write-Step([string]$Message) {
  Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message)
}

# An NSIS installer that stops making progress never returns. That happened on
# a GitHub runner (a silent upgrade over v0.2.2 sat until the job timed out),
# and `Start-Process -Wait` gives no way to notice. Wait with a deadline, then
# report which processes are still alive before failing — a headless runner
# cannot answer a UAC consent prompt or any dialog without an /SD default, and
# the process list is what tells those apart.
function Wait-ForProcess([System.Diagnostics.Process]$Process, [string]$What, [int]$TimeoutSeconds) {
  if ($Process.WaitForExit($TimeoutSeconds * 1000)) {
    return
  }
  Write-Host "##[error]$What did not exit within $TimeoutSeconds seconds"
  Write-Host 'Processes still running:'
  # $ErrorActionPreference is Stop for the script as a whole; reading StartTime
  # or Path on a process this account cannot open would otherwise turn the
  # diagnostic dump itself into the failure being reported.
  try {
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'dsh-desktop|DSH Desktop|DeepSeek|Uninstall|Un_|consent|msiexec' } |
      Select-Object Id, Name, @{ n = 'Started'; e = { $_.StartTime } }, @{ n = 'Exe'; e = { $_.Path } } -ErrorAction SilentlyContinue |
      Format-Table -AutoSize |
      Out-String |
      Write-Host
  } catch {
    Write-Host "  (process list unavailable: $_)"
  }
  try { $Process.Kill($true) } catch { }
  throw "$What timed out after $TimeoutSeconds seconds"
}

function Invoke-Installer([string]$Path, [string[]]$Arguments, [int]$TimeoutSeconds = 300) {
  Write-Step "run: $(Split-Path -Leaf $Path) $($Arguments -join ' ')"
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  Wait-ForProcess $process "Installer $Path" $TimeoutSeconds
  if ($process.ExitCode -ne 0) {
    throw "Installer $Path exited with code $($process.ExitCode)"
  }
  Write-Step "done: $(Split-Path -Leaf $Path)"
}

function Remove-InstalledProduct {
  $registered = Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue
  if ($null -eq $registered) {
    return
  }
  $uninstallString = [string]$registered.UninstallString
  if ($uninstallString -notmatch '^"([^"]+)"') {
    throw "Cannot safely parse the existing product UninstallString: $uninstallString"
  }
  $uninstaller = $Matches[1]
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Existing product uninstaller was not found: $uninstaller"
  }
  Write-Step "run: $(Split-Path -Leaf $uninstaller) /S /currentuser"
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -PassThru
  Wait-ForProcess $process "Existing product uninstaller $uninstaller" 300
  if ($process.ExitCode -ne 0) {
    throw "Existing product cleanup exited with code $($process.ExitCode): $uninstaller"
  }
  Write-Step "done: $(Split-Path -Leaf $uninstaller)"
  Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $currentShortcut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-UpgradeScenario(
  [string]$Name,
  [bool]$RemoveUninstallString,
  [bool]$UseExplicitTarget
) {
  Write-Step "scenario: $Name"
  $scenarioRoot = Join-Path $testRoot $Name
  $legacyDir = Join-Path $scenarioRoot 'existing-custom-dir'
  $explicitDir = Join-Path $scenarioRoot 'new-explicit-dir'
  $targetDir = if ($UseExplicitTarget) { $explicitDir } else { $legacyDir }
  $cleanupFailure = $null

  try {
    Invoke-Installer $legacyInstaller @('/S', "/D=$legacyDir")
    $legacyExe = Join-Path $legacyDir 'DeepSeek Harness Desktop.exe'
    if (-not (Test-Path -LiteralPath $legacyExe -PathType Leaf)) {
      throw "Legacy executable was not installed at the custom directory: $legacyExe"
    }

    # Reproduce #11, then select which recovery source this scenario exercises.
    $brokenLocation = $legacyDir.Replace('\', '')
    if ($RemoveUninstallString) {
      # Source 2 is drive-relative and must be rejected; source 3 is the first
      # usable absolute path. With no uninstall string, this scenario checks
      # directory recovery only—the legacy uninstaller is intentionally skipped.
      Set-ItemProperty -Path $productKey -Name InstallLocation -Value $legacyDir
      Set-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $brokenLocation
      Remove-ItemProperty -Path $uninstallKey -Name UninstallString
    } else {
      Set-ItemProperty -Path $productKey -Name InstallLocation -Value $brokenLocation
      Set-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $legacyDir
    }
    Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $currentShortcut -Force -ErrorAction SilentlyContinue

    $arguments = @('/S')
    if ($UseExplicitTarget) {
      $arguments += "/D=$explicitDir"
    }
    Invoke-Installer $currentInstaller $arguments

    $currentExe = Join-Path $targetDir 'DSH Desktop.exe'
    if (-not (Test-Path -LiteralPath $currentExe -PathType Leaf)) {
      throw "Renamed executable was not installed at the expected directory: $currentExe"
    }
    foreach ($nestedDir in @(
      (Join-Path $legacyDir 'DSH Desktop'),
      (Join-Path $targetDir 'DSH Desktop')
    )) {
      if (Test-Path -LiteralPath $nestedDir) {
        throw "Upgrade appended the new product name to an installation directory: $nestedDir"
      }
    }
    $registeredLocation = (Get-ItemProperty -Path $productKey -Name InstallLocation).InstallLocation
    if ($registeredLocation -ne $targetDir) {
      throw "InstallLocation mismatch: expected $targetDir, got $registeredLocation"
    }
    if (-not (Test-Path -LiteralPath $currentShortcut -PathType Leaf)) {
      throw "Renamed desktop shortcut was not recreated: $currentShortcut"
    }

    Write-Host "✓ $Name repaired the damaged path and avoided a nested product directory"
  } finally {
    $currentUninstaller = Join-Path $targetDir 'Uninstall DSH Desktop.exe'
    $legacyUninstaller = Join-Path $legacyDir 'Uninstall DeepSeek Harness Desktop.exe'
    $cleanupUninstaller = if (Test-Path -LiteralPath $currentUninstaller -PathType Leaf) {
      $currentUninstaller
    } elseif (Test-Path -LiteralPath $legacyUninstaller -PathType Leaf) {
      $legacyUninstaller
    } else {
      $null
    }
    if ($null -ne $cleanupUninstaller) {
      try {
        Write-Step "cleanup: $(Split-Path -Leaf $cleanupUninstaller) /S /currentuser"
        $cleanup = Start-Process -FilePath $cleanupUninstaller -ArgumentList @('/S', '/currentuser') -PassThru
        Wait-ForProcess $cleanup "Cleanup uninstaller $cleanupUninstaller" 300
        if ($cleanup.ExitCode -ne 0) {
          throw "Cleanup uninstaller exited with code $($cleanup.ExitCode): $cleanupUninstaller"
        }
      } catch {
        $cleanupFailure = $_
      }
    }
    Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $currentShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scenarioRoot -Recurse -Force -ErrorAction SilentlyContinue
    if ($null -ne $cleanupFailure) {
      throw $cleanupFailure
    }
  }
}

New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  Write-Step 'checking the cached v0.2.2 fixture'
  if (Test-Path -LiteralPath $legacyInstaller -PathType Leaf) {
    $cachedSha256 = (Get-FileHash -LiteralPath $legacyInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedSha256 -ne $legacySha256) {
      Remove-Item -LiteralPath $legacyInstaller -Force
    }
  }
  if (-not (Test-Path -LiteralPath $legacyInstaller -PathType Leaf)) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Write-Step "download attempt $attempt : $legacyUrl"
        Invoke-WebRequest -Uri $legacyUrl -OutFile $legacyInstaller -UseBasicParsing -TimeoutSec 300
        Write-Step 'download complete'
        break
      } catch {
        Remove-Item -LiteralPath $legacyInstaller -Force -ErrorAction SilentlyContinue
        if ($attempt -eq 3) {
          throw
        }
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  }
  $actualSha256 = (Get-FileHash -LiteralPath $legacyInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $legacySha256) {
    throw "Legacy installer SHA-256 mismatch: expected $legacySha256, got $actualSha256"
  }
  Unblock-File -LiteralPath $legacyInstaller

  # The preceding fresh-install smoke intentionally leaves the current build
  # installed. Remove it before asking v0.2.2 to create the legacy fixture.
  Write-Step 'removing the freshly installed current build'
  Remove-InstalledProduct

  # Covers UninstallString-parent recovery and proves /D= remains authoritative.
  Invoke-UpgradeScenario 'uninstaller-parent-explicit-target' $false $true
  # Closest to the reported upgrade: keep UninstallString, omit /D=, and run the
  # real legacy uninstaller while preserving its exact custom directory.
  Invoke-UpgradeScenario 'uninstaller-parent-in-place' $false $false
  # Rejects a drive-relative source 2 and forces primary-key source 3. It does
  # not cover legacy uninstall execution because UninstallString is absent.
  Invoke-UpgradeScenario 'primary-location-fallback-no-uninstall' $true $false

  Write-Host '✓ renamed desktop shortcut is present when the legacy link was missing'
  Write-Host '✓ explicit /D= and unchanged upgrade targets both preserve their intended directories'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
