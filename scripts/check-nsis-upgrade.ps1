param(
  [string]$Installer = ''
)

$ErrorActionPreference = 'Stop'

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

function Invoke-Installer([string]$Path, [string[]]$Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer $Path exited with code $($process.ExitCode)"
  }
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
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Existing product cleanup exited with code $($process.ExitCode): $uninstaller"
  }
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
        $cleanup = Start-Process -FilePath $cleanupUninstaller -ArgumentList @('/S', '/currentuser') -Wait -PassThru
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
  if (Test-Path -LiteralPath $legacyInstaller -PathType Leaf) {
    $cachedSha256 = (Get-FileHash -LiteralPath $legacyInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedSha256 -ne $legacySha256) {
      Remove-Item -LiteralPath $legacyInstaller -Force
    }
  }
  if (-not (Test-Path -LiteralPath $legacyInstaller -PathType Leaf)) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Invoke-WebRequest -Uri $legacyUrl -OutFile $legacyInstaller -UseBasicParsing
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
