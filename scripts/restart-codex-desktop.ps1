param(
  [switch]$CheckOnly,
  [string]$OperationId,
  [string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Get-CodexDesktopTarget {
  # Get-AppxPackage without -AllUsers selects the connector's current user.
  $packages = @(Get-AppxPackage -Name 'OpenAI.Codex')
  if ($packages.Count -ne 1) { throw 'unsupported_package' }
  $package = $packages[0]
  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
  $applications = @($manifest.Package.Applications.Application | Where-Object { $_.Id -ceq 'App' })
  if ($applications.Count -ne 1) { throw 'unsupported_application' }

  $installRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\', '/')
  $relativeExecutable = [string]$applications[0].Executable
  if ([string]::IsNullOrWhiteSpace($relativeExecutable) -or [IO.Path]::IsPathRooted($relativeExecutable)) {
    throw 'unsupported_executable'
  }
  $executable = [IO.Path]::GetFullPath((Join-Path $installRoot $relativeExecutable))
  if (-not $executable.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'unsupported_executable'
  }

  # The installed manifest names app/ChatGPT.exe. Match its complete path, never a process name.
  $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate |
    Where-Object { [string]::Equals([string]$_.ExecutablePath, $executable, [StringComparison]::OrdinalIgnoreCase) })
  $processIds = @($processes | ForEach-Object { [uint32]$_.ProcessId })
  $roots = @($processes | Where-Object { $processIds -notcontains [uint32]$_.ParentProcessId })
  if ($roots.Count -ne 1) { throw 'unsupported_process_tree' }
  $root = $roots[0]
  if ($null -eq $root.CreationDate) { throw 'unsupported_process_identity' }

  $members = @($root)
  $parents = @([uint32]$root.ProcessId)
  while ($parents.Count -gt 0) {
    $children = @($processes | Where-Object { $parents -contains [uint32]$_.ParentProcessId })
    $members += $children
    $parents = @($children | ForEach-Object { [uint32]$_.ProcessId })
  }
  $familyName = [string]$package.PackageFamilyName
  if ($familyName -notmatch '^OpenAI\.Codex_[A-Za-z0-9]+$') { throw 'unsupported_identity' }
  return [pscustomobject]@{
    Executable = $executable
    Root = $root
    Members = $members
    Aumid = $familyName + '!App'
  }
}

function Test-ProcessIdentity($Expected, [string]$Executable) {
  $current = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [uint32]$Expected.ProcessId) `
    -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate
  return $null -ne $current -and
    [string]::Equals([string]$current.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase) -and
    [uint32]$current.ParentProcessId -eq [uint32]$Expected.ParentProcessId -and
    $current.CreationDate -eq $Expected.CreationDate
}

function Get-RestartJob {
  $parsedId = [guid]::Empty
  if (-not [guid]::TryParseExact($OperationId, 'D', [ref]$parsedId) -or
      $parsedId.ToString('D') -cne $OperationId -or
      -not [IO.Path]::IsPathRooted($ResultPath)) { throw 'invalid_job' }
  $path = [IO.Path]::GetFullPath($ResultPath)
  if ($path -notmatch '^[A-Za-z]:\\' -or
      [IO.Path]::GetFileName($path) -cne ($OperationId + '.json')) { throw 'invalid_job' }
  $directory = [IO.Path]::GetDirectoryName($path)
  if ([IO.Path]::GetFileName($directory) -cne 'desktop-restarts') { throw 'invalid_job' }
  $file = Get-Item -LiteralPath $path
  $parent = Get-Item -LiteralPath $directory
  if ($file.PSIsContainer -or -not $parent.PSIsContainer -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid_job' }
  $snapshot = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($snapshot.id -cne $OperationId -or $snapshot.status -cne 'pending' -or
      ($snapshot.startedAt -isnot [long] -and $snapshot.startedAt -isnot [int]) -or
      $snapshot.startedAt -le 0) { throw 'invalid_job' }
  return [pscustomobject]@{ Path = $path; Directory = $directory; StartedAt = [long]$snapshot.startedAt }
}

function Write-RestartStatus($Job, [string]$Status, [string]$ErrorCode = '') {
  $snapshot = [ordered]@{ id = $OperationId; status = $Status; startedAt = $Job.StartedAt }
  if ($Status -eq 'completed' -or $Status -eq 'failed') {
    $snapshot.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  if ($ErrorCode) { $snapshot.error = $ErrorCode }
  $temporary = Join-Path $Job.Directory ($OperationId + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $json = $snapshot | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    # Windows PowerShell binds $null to an empty string for this .NET overload.
    [IO.File]::Replace($temporary, $Job.Path, [NullString]::Value)
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

if ($CheckOnly) {
  try {
    $null = Get-CodexDesktopTarget
    [Console]::Out.WriteLine('{"supported":true}')
  } catch {
    [Console]::Out.WriteLine('{"supported":false}')
  }
  exit 0
}

try { $job = Get-RestartJob } catch {
  [Console]::Error.WriteLine('desktop_restart_invalid_job')
  exit 1
}

try {
  $stage = 'desktop_restart_state_write_failed'
  Write-RestartStatus $job 'restarting'
  $stage = 'desktop_restart_target_unavailable'
  $target = Get-CodexDesktopTarget
  # Let the connector deliver its response before the Desktop process exits.
  Start-Sleep -Seconds 2
  $stage = 'desktop_restart_identity_changed'
  if (-not (Test-ProcessIdentity $target.Root $target.Executable)) { throw 'identity_changed' }
  $stage = 'desktop_restart_stop_failed'
  # Only the captured exact-executable tree is eligible; Codex CLI children are excluded.
  foreach ($member in $target.Members) {
    if (Test-ProcessIdentity $member $target.Executable) {
      try { Stop-Process -Id ([int]$member.ProcessId) -Force -ErrorAction Stop } catch {
        # Exiting between the identity check and Stop-Process is harmless.
        if (Test-ProcessIdentity $member $target.Executable) { throw }
      }
    }
  }
  $stage = 'desktop_restart_stop_timeout'
  try { Wait-Process -Id ([int]$target.Root.ProcessId) -Timeout 8 -ErrorAction Stop } catch {
    if (Test-ProcessIdentity $target.Root $target.Executable) { throw }
  }
  if (Test-ProcessIdentity $target.Root $target.Executable) { throw 'desktop_did_not_exit' }
  $stage = 'desktop_restart_activation_failed'
  Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') `
    -ArgumentList ('shell:AppsFolder\' + $target.Aumid) -WindowStyle Hidden -ErrorAction Stop | Out-Null
  $stage = 'desktop_restart_activation_timeout'
  $activationTimer = [Diagnostics.Stopwatch]::StartNew()
  for ($attempt = 0; $attempt -lt 40 -and $activationTimer.Elapsed.TotalSeconds -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $replacement = Get-CodexDesktopTarget } catch { continue }
    $sameExecutable = [string]::Equals($replacement.Executable, $target.Executable, [StringComparison]::OrdinalIgnoreCase)
    $newIdentity = $replacement.Root.ProcessId -ne $target.Root.ProcessId -or
      $replacement.Root.CreationDate -ne $target.Root.CreationDate
    if ($sameExecutable -and $newIdentity -and -not (Test-ProcessIdentity $target.Root $target.Executable)) {
      $stage = 'desktop_restart_state_write_failed'
      Write-RestartStatus $job 'completed'
      exit 0
    }
  }
  throw 'desktop_activation_timeout'
} catch {
  try { Write-RestartStatus $job 'failed' $stage } catch {
    [Console]::Error.WriteLine('desktop_restart_state_write_failed')
  }
  [Console]::Error.WriteLine('desktop_restart_failed')
  exit 1
}
