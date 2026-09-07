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

$baselineUrl = 'https://github.com/bruc3van/dsh-desktop/releases/download/v0.3.0/dsh-desktop-0.3.0-win-x64.exe'
$baselineSha256 = 'd622a9f8a959f24ee5585638ea5f7a275d7b2fcd452521077af3d2e8b864fba7'
$productKey = 'HKCU:\Software\986c9051-a721-5678-bb71-26cd03957e6c'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\986c9051-a721-5678-bb71-26cd03957e6c'
$desktop = [Environment]::GetFolderPath('Desktop')
$currentShortcut = Join-Path $desktop 'DSH Desktop.lnk'
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'dsh-desktop-upgrade-fixtures'
$testRoot = Join-Path $env:RUNNER_TEMP ('dsh-desktop-upgrade-' + [guid]::NewGuid().ToString('N'))
$baselineInstaller = Join-Path $fixtureRoot 'dsh-desktop-0.3.0-win-x64.exe'

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

# An NSIS installer that stops making progress may never return, and
# `Start-Process -Wait` gives no way to notice. Wait with a deadline, then
# report which processes are still alive before failing — a headless runner
# cannot answer a UAC consent prompt or any dialog without an /SD default, and
# the process list is what tells those apart.
function Wait-ForProcess([System.Diagnostics.Process]$Process, [string]$What, [int]$TimeoutSeconds) {
  if ($Process.WaitForExit($TimeoutSeconds * 1000)) {
    return
  }
  Write-Host "##[error]$What did not exit within $TimeoutSeconds seconds"
  # $ErrorActionPreference is Stop for the script as a whole; anything read here
  # may fail on a process this account cannot open, and a diagnostic dump must
  # never become the failure being reported.
  #
  # Three questions decide where an NSIS installer is stuck, and nothing else in
  # the log answers them: does it own a window (a MessageBox with no /SD default
  # blocks forever in a silent install), did it spawn anything (the legacy
  # uninstaller and nsExec's shell both show up as children), and did it get as
  # far as writing files (an empty target means it never left .onInit).
  try {
    Write-Host 'The waited-on process:'
    $Process.Refresh()
    [PSCustomObject]@{
      Id           = $Process.Id
      Responding   = $Process.Responding
      WindowHandle = $Process.MainWindowHandle
      WindowTitle  = $Process.MainWindowTitle
      CPUSeconds   = $Process.TotalProcessorTime.TotalSeconds
      Threads      = $Process.Threads.Count
    } | Format-List | Out-String | Write-Host
  } catch {
    Write-Host "  (process detail unavailable: $_)"
  }
  # The window text is the whole answer when an installer sits idle with a
  # window open: a MessageBox that carries no /SD default is shown even in a
  # silent install, and then nothing ever answers it. Reading the dialog's own
  # text says which one it is; nothing else in the log can.
  try {
    Write-Host 'Windows owned by the waited-on process:'
    Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWindowDump {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  public static List<string> ForProcess(uint pid) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      found.Add(Describe(h, ""));
      EnumChildWindows(h, (c, l2) => { found.Add(Describe(c, "    ")); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string Describe(IntPtr h, string indent) {
    var cls = new StringBuilder(256);
    GetClassNameW(h, cls, cls.Capacity);
    var txt = new StringBuilder(2048);
    GetWindowTextW(h, txt, txt.Capacity);
    return indent + "[" + cls.ToString() + "] visible=" + IsWindowVisible(h) + " text=" + txt.ToString();
  }
}
'@
    foreach ($line in [DshWindowDump]::ForProcess([uint32]$Process.Id)) {
      Write-Host "  $line"
    }
  } catch {
    Write-Host "  (window dump unavailable: $_)"
  }
  try {
    Write-Host 'Descendants of the waited-on process:'
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Process.Id)" -ErrorAction SilentlyContinue |
      Select-Object ProcessId, Name, CommandLine |
      Format-List | Out-String | Write-Host
  } catch {
    Write-Host "  (child list unavailable: $_)"
  }
  try {
    Write-Host 'Processes started in the last 15 minutes:'
    $since = (Get-Date).AddMinutes(-15)
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -gt $since } |
      Sort-Object StartTime |
      Select-Object Id, Name, @{ n = 'Started'; e = { $_.StartTime.ToString('HH:mm:ss') } } |
      Format-Table -AutoSize | Out-String | Write-Host
  } catch {
    Write-Host "  (process list unavailable: $_)"
  }
  try { $Process.Kill($true) } catch { }
  throw "$What timed out after $TimeoutSeconds seconds"
}

# `Start-Process -Wait` waits for the process AND its descendants, and that is
# load-bearing here: an NSIS uninstaller copies itself into TEMP, relaunches the
# copy and lets the original exit immediately, so waiting only on the process
# that was started returns while the uninstall is still running. -Wait cannot be
# given a deadline though, so wait for the process explicitly and then for the
# relaunched copy to go quiet, both inside the same budget.
function Wait-ForInstallerFamilyQuiet([datetime]$Deadline) {
  $names = @('Un_A', 'Un_B', 'Un_C', 'old-uninstaller')
  while ((Get-Date) -lt $Deadline) {
    $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name })
    if ($alive.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'A relaunched NSIS uninstaller was still running past the deadline'
}

function Invoke-Installer([string]$Path, [string[]]$Arguments, [int]$TimeoutSeconds = 300, [string]$TargetDir = '', [string]$BaselineDir = '') {
  Write-Step "run: $(Split-Path -Leaf $Path) $($Arguments -join ' ')"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  # Every install and uninstall this script runs goes through here, so timing it
  # here is what makes an upgrade's real cost visible: the uninstall deletes one
  # full tree before the install writes the next, and both are paid per file.
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  try {
    Wait-ForProcess $process "Installer $Path" $TimeoutSeconds
    Wait-ForInstallerFamilyQuiet $deadline
  } catch {
    # How much of the install landed separates "never left .onInit" from "stuck
    # mid-extract", and the two point at completely different code.
    Write-Host 'What landed on disk:'
    # NSIS unpacks into $PLUGINSDIR ($env:TEMP\ns*.tmp) and extracts the app 7z
    # into a 7z-out folder under it, so these two answer "how far did it get"
    # from opposite ends. Recursing all of TEMP would be neither.
    $dirs = @()
    if ($TargetDir -ne '') { $dirs += $TargetDir }
    if ($BaselineDir -ne '') { $dirs += $BaselineDir }
    $dirs += @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName)
    foreach ($dir in $dirs) {
      if (-not (Test-Path -LiteralPath $dir)) {
        Write-Host "  $dir : absent"
        continue
      }
      try {
        $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue)
        $bytes = ($files | Measure-Object -Property Length -Sum).Sum
        Write-Host "  $dir : $($files.Count) files, $([math]::Round($bytes / 1MB, 1)) MB"
      } catch {
        Write-Host "  $dir : unreadable ($_)"
      }
    }
    try {
      Write-Host 'Registry at the time of the hang:'
      foreach ($key in @($productKey, $uninstallKey)) {
        $value = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($null -eq $value) {
          Write-Host "  $key : absent"
        } else {
          Write-Host "  $key : InstallLocation=$($value.InstallLocation) UninstallString=$($value.UninstallString)"
        }
      }
    } catch {
      Write-Host "  (registry unreadable: $_)"
    }
    throw
  }
  $clock.Stop()
  if ($process.ExitCode -ne 0) {
    throw "Installer $Path exited with code $($process.ExitCode)"
  }
  $landed = ''
  if ($TargetDir -ne '' -and (Test-Path -LiteralPath $TargetDir)) {
    $files = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File -ErrorAction SilentlyContinue)
    $landed = ", $($files.Count) files in $TargetDir"
  }
  Write-Step ("done: {0} ({1:N1}s{2})" -f (Split-Path -Leaf $Path), $clock.Elapsed.TotalSeconds, $landed)
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
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -PassThru
  Wait-ForProcess $process "Existing product uninstaller $uninstaller" 300
  Wait-ForInstallerFamilyQuiet (Get-Date).AddSeconds(300)
  if ($process.ExitCode -ne 0) {
    throw "Existing product cleanup exited with code $($process.ExitCode): $uninstaller"
  }
  Write-Step "done: $(Split-Path -Leaf $uninstaller)"

  Remove-Item -LiteralPath $currentShortcut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-UpgradeScenario(
  [string]$Name,
  [bool]$UseExplicitTarget
) {
  Write-Step "scenario: $Name"
  $scenarioRoot = Join-Path $testRoot $Name
  $baselineDir = Join-Path $scenarioRoot 'existing-custom-dir'
  $explicitDir = Join-Path $scenarioRoot 'new-explicit-dir'
  $targetDir = if ($UseExplicitTarget) { $explicitDir } else { $baselineDir }
  $cleanupFailure = $null

  try {
    Invoke-Installer $baselineInstaller @('/S', "/D=$baselineDir")
    $baselineExe = Join-Path $baselineDir 'DSH Desktop.exe'
    if (-not (Test-Path -LiteralPath $baselineExe -PathType Leaf)) {
      throw "Baseline executable was not installed at the custom directory: $baselineExe"
    }

    # Upgrade an intact v0.3.0 installation; pre-0.3 rename/path repair
    # scenarios are no longer part of the release validation baseline.

    $arguments = @('/S')
    if ($UseExplicitTarget) {
      $arguments += "/D=$explicitDir"
    }
    Invoke-Installer $currentInstaller $arguments -TargetDir $targetDir -BaselineDir $baselineDir

    $unpacked = Join-Path (Split-Path -Parent $PSScriptRoot) 'release\win-unpacked'
    $packed = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File |
      ForEach-Object { $_.FullName.Substring($unpacked.Length + 1) })
    $installed = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
      Get-ChildItem -LiteralPath $targetDir -Recurse -File |
        ForEach-Object { $_.FullName.Substring($targetDir.Length + 1) }))
    $missing = @($packed | Where-Object { -not $installed.Contains($_) })
    if ($missing.Count -gt 0) {
      throw "Upgrade lost $($missing.Count) packed files: $($missing -join ', ')"
    }
    Write-Step "all $($packed.Count) packed files survived the upgrade"

    $currentExe = Join-Path $targetDir 'DSH Desktop.exe'
    if (-not (Test-Path -LiteralPath $currentExe -PathType Leaf)) {
      throw "Current executable was not installed at the expected directory: $currentExe"
    }
    foreach ($nestedDir in @(
      (Join-Path $baselineDir 'DSH Desktop'),
      (Join-Path $targetDir 'DSH Desktop')
    )) {
      if (Test-Path -LiteralPath $nestedDir) {
        throw "Upgrade appended the product name to an installation directory: $nestedDir"
      }
    }
    $registeredLocation = (Get-ItemProperty -Path $productKey -Name InstallLocation).InstallLocation
    if ($registeredLocation -ne $targetDir) {
      throw "InstallLocation mismatch: expected $targetDir, got $registeredLocation"
    }
    if (-not (Test-Path -LiteralPath $currentShortcut -PathType Leaf)) {
      throw "Desktop shortcut is missing: $currentShortcut"
    }

    $expectedVersion = (Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') -Raw | ConvertFrom-Json).version
    $installedVersion = (Get-ItemProperty -Path $uninstallKey -Name DisplayVersion).DisplayVersion
    if ($installedVersion -ne $expectedVersion) {
      throw "Upgraded version mismatch: expected $expectedVersion, got $installedVersion"
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcutTarget = $shell.CreateShortcut($currentShortcut).TargetPath
    if ($shortcutTarget -ne $currentExe) {
      throw "Desktop shortcut target mismatch: expected $currentExe, got $shortcutTarget"
    }
    node (Join-Path $PSScriptRoot 'smoke-package.mjs') "$currentExe"
    if ($LASTEXITCODE -ne 0) { throw "upgraded runtime smoke failed with code $LASTEXITCODE" }
    Write-Host "✓ $Name upgraded v0.3.0 to $expectedVersion and passed runtime smoke"
  } finally {
    $currentUninstaller = Join-Path $targetDir 'Uninstall DSH Desktop.exe'
    $baselineUninstaller = Join-Path $baselineDir 'Uninstall DSH Desktop.exe'
    $cleanupUninstaller = if (Test-Path -LiteralPath $currentUninstaller -PathType Leaf) {
      $currentUninstaller
    } elseif (Test-Path -LiteralPath $baselineUninstaller -PathType Leaf) {
      $baselineUninstaller
    } else {
      $null
    }
    if ($null -ne $cleanupUninstaller) {
      try {
        Write-Step "cleanup: $(Split-Path -Leaf $cleanupUninstaller) /S /currentuser"
        $cleanup = Start-Process -FilePath $cleanupUninstaller -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -PassThru
        Wait-ForProcess $cleanup "Cleanup uninstaller $cleanupUninstaller" 300
        Wait-ForInstallerFamilyQuiet (Get-Date).AddSeconds(300)
        if ($cleanup.ExitCode -ne 0) {
          throw "Cleanup uninstaller exited with code $($cleanup.ExitCode): $cleanupUninstaller"
        }
      } catch {
        $cleanupFailure = $_
      }
    }

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
  Write-Step 'checking the cached v0.3.0 fixture'
  if (Test-Path -LiteralPath $baselineInstaller -PathType Leaf) {
    $cachedSha256 = (Get-FileHash -LiteralPath $baselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedSha256 -ne $baselineSha256) {
      Remove-Item -LiteralPath $baselineInstaller -Force
    }
  }
  if (-not (Test-Path -LiteralPath $baselineInstaller -PathType Leaf)) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Write-Step "download attempt $attempt : $baselineUrl"
        Invoke-WebRequest -Uri $baselineUrl -OutFile $baselineInstaller -UseBasicParsing -TimeoutSec 300
        Write-Step 'download complete'
        break
      } catch {
        Remove-Item -LiteralPath $baselineInstaller -Force -ErrorAction SilentlyContinue
        if ($attempt -eq 3) {
          throw
        }
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  }
  $actualSha256 = (Get-FileHash -LiteralPath $baselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $baselineSha256) {
    throw "Baseline installer SHA-256 mismatch: expected $baselineSha256, got $actualSha256"
  }
  Unblock-File -LiteralPath $baselineInstaller

  # Ensure no earlier smoke installation interferes with the baseline.
  Write-Step 'removing the freshly installed current build'
  Remove-InstalledProduct

  # Cover the normal updater path and an explicitly chosen new directory.
  Invoke-UpgradeScenario 'in-place' $false
  Invoke-UpgradeScenario 'explicit-target' $true

  Write-Host '✓ v0.3.0 upgrades preserve the selected directory, version and shortcut target'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
