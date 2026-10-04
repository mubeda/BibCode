# CI-only, read-only observer. All private process identities stay in this process.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$subscriptions = @()
$sourceIds = @()
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$origin = [DateTime]::UtcNow
$apps = @{}
$installers = @{}
$startCount = 0
$stopCount = 0
$triggerLimit = 120

function Write-Fact($kind, $at, $parent, $location, $hash, $exitCode) {
  [ordered]@{
    kind = $kind
    elapsedMs = [Math]::Max(0, [Math]::Min(3600000, [long]$at))
    parentMatched = $parent
    locationMatched = $location
    hashMatched = $hash
    exitCode = $exitCode
    droppedCount = 0
  } | ConvertTo-Json -Compress | Write-Output
}

function Get-InstallerParentMatch($apps, $parentKey, $eventTime) {
  if (-not $apps.ContainsKey($parentKey)) { return $null }
  return $eventTime -ge $apps[$parentKey].created -and
    ($null -eq $apps[$parentKey].stopped -or $eventTime -le $apps[$parentKey].stopped)
}

try {
  $application = [IO.Path]::GetFullPath($env:BIBCODE_WITNESS_APPLICATION)
  $appName = [IO.Path]::GetFileName($application)
  $product = $env:BIBCODE_WITNESS_PRODUCT
  $version = $env:BIBCODE_WITNESS_VERSION
  $installerName = $product + '-' + $version + '-installer.exe'
  $installerPrefix = $product + '-' + $version + '-updater-'
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar
  $duration = [long]$env:BIBCODE_WITNESS_LIFETIME_MS
  if ($appName -notmatch '^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}$' -or
      $product -notmatch '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$' -or
      $version -notmatch '^[0-9A-Za-z.+-]{1,128}$' -or
      $env:BIBCODE_WITNESS_SHA256 -notmatch '^[a-fA-F0-9]{64}$' -or
      $duration -le 0 -or $duration -gt 3600000) { throw 'invalid-input' }

  # Provider-side exact-name filters and MaxTriggerCount bound each event queue.
  $filter = "ProcessName = '$appName' OR ProcessName = '$installerName'"
  foreach ($class in @('Win32_ProcessStartTrace', 'Win32_ProcessStopTrace')) {
    $sourceId = 'bibcode-witness-' + [Guid]::NewGuid().ToString('N')
    $sourceIds += $sourceId
    $subscriptions += Register-CimIndicationEvent -Namespace 'root/cimv2' `
      -Query ("SELECT * FROM " + $class + " WHERE " + $filter) `
      -SourceIdentifier $sourceId -MaxTriggerCount $triggerLimit -OperationTimeoutSec 2
  }
  Write-Fact 'ready' $clock.ElapsedMilliseconds $null $null $null $null
  while ($clock.ElapsedMilliseconds -lt $duration) {
    $stopping = Test-Path -LiteralPath $env:BIBCODE_WITNESS_STOP
    $events = @($sourceIds | ForEach-Object {
      Get-Event -SourceIdentifier $_ -ErrorAction SilentlyContinue
    }) | Sort-Object { $_.SourceEventArgs.NewEvent.TIME_CREATED }
    foreach ($queued in $events) {
      $event = $queued.SourceEventArgs.NewEvent
      $started = $queued.SourceIdentifier -eq $sourceIds[0]
      if ($started) { $startCount++ } else { $stopCount++ }
      $eventTime = [DateTime]::FromFileTimeUtc([long]$event.TIME_CREATED)
      $at = [long]($eventTime - $origin).TotalMilliseconds
      $processId = [uint32]$event.ProcessID
      $key = [string]$processId
      $exitStatus = $null
      if ($null -ne $event.ExitStatus) { $exitStatus = [long]$event.ExitStatus }
      if ($event.ProcessName -eq $appName) {
        if ($started) {
          # A reused PID with unavailable metadata cannot inherit a prior identity.
          $apps.Remove($key)
          try {
            $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $processId) `
              -Property ExecutablePath, CreationDate -OperationTimeoutSec 2
            $path = [IO.Path]::GetFullPath($process.ExecutablePath)
            $created = $process.CreationDate.ToUniversalTime()
            if ($path.Equals($application, [StringComparison]::OrdinalIgnoreCase) -and
                $created -le $eventTime -and ($eventTime - $created).TotalSeconds -le 2) {
              $apps[$key] = @{ created = $created; stopped = $null }
              Write-Fact 'application-start' $at $null $true $null $null
            }
          } catch { }
        } elseif ($apps.ContainsKey($key) -and $null -eq $apps[$key].stopped -and $eventTime -ge $apps[$key].created) {
          $apps[$key].stopped = $eventTime
          Write-Fact 'application-stop' $at $null $true $null $exitStatus
        }
      } elseif ($event.ProcessName -eq $installerName) {
        if ($started) {
          $parentKey = [string][uint32]$event.ParentProcessID
          $parentMatched = Get-InstallerParentMatch $apps $parentKey $eventTime
          $locationMatched = $null
          $hashMatched = $null
          try {
            $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $processId) `
              -Property ExecutablePath, CreationDate -OperationTimeoutSec 2
            $path = [IO.Path]::GetFullPath($process.ExecutablePath)
            $created = $process.CreationDate.ToUniversalTime()
            if ($created -le $eventTime -and ($eventTime - $created).TotalSeconds -le 2) {
              $directory = [IO.Path]::GetDirectoryName($path)
              $locationMatched = $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
                [IO.Path]::GetFileName($directory).StartsWith($installerPrefix, [StringComparison]::OrdinalIgnoreCase) -and
                [IO.Path]::GetFileName($path).Equals($installerName, [StringComparison]::OrdinalIgnoreCase)
              if ($locationMatched) {
                $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
                $hashMatched = $digest.Equals($env:BIBCODE_WITNESS_SHA256, [StringComparison]::OrdinalIgnoreCase)
              }
            }
          } catch { }
          $installers[$key] = @{ started = $eventTime; parent = $parentMatched; location = $locationMatched; hash = $hashMatched }
          Write-Fact 'installer-start' $at $parentMatched $locationMatched $hashMatched $null
        } elseif ($installers.ContainsKey($key) -and $eventTime -ge $installers[$key].started) {
          $identity = $installers[$key]
          Write-Fact 'installer-stop' $at $identity.parent $identity.location $identity.hash $exitStatus
          $installers.Remove($key)
        }
      }
      Remove-Event -EventIdentifier $queued.EventIdentifier -ErrorAction SilentlyContinue
    }
    if ($startCount -ge $triggerLimit -or $stopCount -ge $triggerLimit) {
      Write-Fact 'limit' $clock.ElapsedMilliseconds $null $null $null $null
      break
    }
    if ($stopping) { break }
    Start-Sleep -Milliseconds 25
  }
} catch {
  Write-Fact 'unavailable' $clock.ElapsedMilliseconds $null $null $null $null
} finally {
  foreach ($subscription in $subscriptions) {
    Unregister-Event -SubscriptionId $subscription.SubscriptionId -ErrorAction SilentlyContinue
  }
  foreach ($sourceId in $sourceIds) {
    Get-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue |
      Remove-Event -ErrorAction SilentlyContinue
  }
  Write-Fact 'stopped' $clock.ElapsedMilliseconds $null $null $null $null
}
