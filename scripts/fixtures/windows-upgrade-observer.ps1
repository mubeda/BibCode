param(
  [string]$ApplicationPath,
  [string]$CandidateVersion,
  [string]$StopPath,
  [int]$TimeoutSeconds = 1,
  [string]$FixturePath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Record([hashtable]$Record) {
  $Record | ConvertTo-Json -Compress -Depth 4
}

function Read-EventData([xml]$Document) {
  $values = @{}
  foreach ($item in $Document.Event.EventData.Data) {
    $values[$item.GetAttribute('Name')] = [string]$item.InnerText
  }
  return $values
}

function Get-CrashRecords($Documents, [string[]]$OwnedPaths) {
  $reports = @{}
  $count = 0
  foreach ($document in $Documents) {
    $provider = $document.Event.System.Provider.GetAttribute('Name')
    $eventId = [int]($document.Event.System.SelectSingleNode('*[local-name()="EventID"]').InnerText)
    if ($provider -ne 'Application Error' -or $eventId -ne 1000) { continue }
    $data = Read-EventData $document
    if (-not $data.AppPath -or -not ($OwnedPaths -icontains $data.AppPath)) { continue }
    $record = @{
      kind = 'application-error'
      at = [string]$document.Event.System.TimeCreated.SystemTime
      recordId = [long]$document.Event.System.EventRecordID
      path = [string]$data.AppPath
    }
    foreach ($pair in @(@('AppVersion', 'appVersion'), @('ModuleName', 'module'), @('ModuleVersion', 'moduleVersion'))) {
      if ($data[$pair[0]]) { $record[$pair[1]] = [IO.Path]::GetFileName([string]$data[$pair[0]]) }
    }
    foreach ($pair in @(@('ExceptionCode', 'exceptionCode'), @('FaultingOffset', 'faultOffset'))) {
      if ($data[$pair[0]] -match '^(?:0x)?[a-fA-F0-9]{1,16}$') { $record[$pair[1]] = [string]$data[$pair[0]] }
    }
    $report = [Guid]::Empty
    if ([Guid]::TryParse([string]$data.IntegratorReportId, [ref]$report) -and $report -ne [Guid]::Empty) {
      $record.reportId = $report.ToString()
      $reports[$record.reportId] = $true
    }
    Write-Record $record
    $count++
  }
  foreach ($document in $Documents) {
    $eventId = [int]($document.Event.System.SelectSingleNode('*[local-name()="EventID"]').InnerText)
    if ($document.Event.System.Provider.GetAttribute('Name') -ne 'Windows Error Reporting' -or $eventId -ne 1001) { continue }
    $data = Read-EventData $document
    $report = [Guid]::Empty
    if (-not [Guid]::TryParse([string]$data.ReportId, [ref]$report) -or $report -eq [Guid]::Empty -or -not $reports.ContainsKey($report.ToString())) { continue }
    $eventType = if ($data.EventName -in @('APPCRASH', 'BEX', 'BEX64', 'AppHangB1')) { [string]$data.EventName } else { 'unknown' }
    Write-Record @{
      kind = 'wer-report'; at = [string]$document.Event.System.TimeCreated.SystemTime
      recordId = [long]$document.Event.System.EventRecordID
      reportId = $report.ToString(); eventType = $eventType
    }
    $count++
  }
  if ($count -eq 0) {
    $kind = if (@($Documents).Count -eq 0) { 'eventlog-none' } else { 'eventlog-unattributed' }
    Write-Record @{ kind = $kind; reason = 'no-match' }
  }
}

# Pure fixture mode: no subscriptions, process queries, event-log access or app launch.
if ($FixturePath) {
  $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
  $documents = @($fixture.events | ForEach-Object { [xml]$_ })
  Get-CrashRecords $documents @([string]$fixture.applicationPath)
  exit 0
}

$started = [DateTime]::UtcNow
$deadline = $started.AddSeconds([Math]::Max(1, $TimeoutSeconds))
$ownedPath = [IO.Path]::GetFullPath($ApplicationPath)
$appName = [IO.Path]::GetFileName($ownedPath)
if ($appName -notin @('bibcode-desktop.exe', 'BiBCode.exe') -or $CandidateVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$') {
  Write-Record @{ kind = 'observer-unavailable'; reason = 'invalid-record' }
  exit 1
}
$installerSuffix = '-' + $CandidateVersion + '-installer.exe'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$known = @{}
$ownedPaths = [Collections.Generic.List[string]]::new()
$ownedPaths.Add($ownedPath)
$startSource = 'bibcode-upgrade-start-' + [Guid]::NewGuid().ToString()
$stopSource = 'bibcode-upgrade-stop-' + [Guid]::NewGuid().ToString()
$nameFilter = "ProcessName = '$appName' OR ProcessName LIKE '%$installerSuffix'"
$eventCount = 0

function Observe-Start($EventData, [DateTime]$At) {
  $eventPid = [uint32]$EventData.ProcessID
  if ($known.ContainsKey($eventPid)) {
    if ($At -lt $known[$eventPid].observedStart) { return }
    $known.Remove($eventPid)
  }
  $role = if ([string]$EventData.ProcessName -ieq $appName) { 'application' } else { 'installer' }
  $row = $null
  try {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $eventPid" -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate -OperationTimeoutSec 2
  } catch { }
  $path = if ($row) { [string]$row.ExecutablePath } else { '' }
  $verified = ($role -eq 'application' -and $path -ieq $ownedPath) -or (
    $role -eq 'installer' -and $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($path).EndsWith($installerSuffix, [StringComparison]::OrdinalIgnoreCase)
  )
  if (-not $verified) {
    if ($path) { return } # A resolved different path is outside this lane.
    Write-Record @{ kind = 'process-unverified'; at = $At.ToString('o'); pid = $eventPid; role = $role; verified = $false }
    return
  }
  $created = ([DateTime]$row.CreationDate).ToUniversalTime()
  if ($created -gt $At -or [uint32]$row.ParentProcessId -ne [uint32]$EventData.ParentProcessID) {
    Write-Record @{ kind = 'process-unverified'; at = $At.ToString('o'); pid = $eventPid; role = $role; verified = $false }
    return
  }
  $known[$eventPid] = @{ role = $role; path = $path; created = $created; observedStart = $At }
  if (-not $ownedPaths.Contains($path)) { $ownedPaths.Add($path) }
  Write-Record @{
    kind = 'process-start'; at = $At.ToString('o'); pid = $eventPid
    parentPid = [uint32]$EventData.ParentProcessID; role = $role; verified = $true
    path = $path; createdAt = $created.ToString('o')
  }
}

try {
  Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStartTrace WHERE $nameFilter" -SourceIdentifier $startSource | Out-Null
  Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStopTrace WHERE $nameFilter" -SourceIdentifier $stopSource | Out-Null
  # One initial snapshot closes the subscription race. Never query CommandLine or owner data.
  foreach ($row in @(Get-CimInstance Win32_Process -Filter "Name = '$appName'" -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate -OperationTimeoutSec 2)) {
    Observe-Start @{ ProcessID = $row.ProcessId; ParentProcessID = $row.ParentProcessId; ProcessName = $appName } ([DateTime]::UtcNow)
  }
  Write-Record @{ kind = 'observer-ready'; at = [DateTime]::UtcNow.ToString('o') }
  while (-not (Test-Path -LiteralPath $StopPath) -and [DateTime]::UtcNow -lt $deadline) {
    $null = Wait-Event -Timeout 1
    foreach ($event in @(Get-Event | Where-Object { $_.SourceIdentifier -eq $startSource -or $_.SourceIdentifier -eq $stopSource } | Sort-Object EventIdentifier)) {
      Remove-Event -EventIdentifier $event.EventIdentifier
      $eventCount++
      if ($eventCount -gt 256) { continue }
      $data = $event.SourceEventArgs.NewEvent
      $at = [DateTime]::FromFileTimeUtc([long]$data.TIME_CREATED)
      if ($event.SourceIdentifier -eq $startSource) { Observe-Start $data $at; continue }
      $eventPid = [uint32]$data.ProcessID
      if (-not $known.ContainsKey($eventPid)) {
        $role = if ([string]$data.ProcessName -ieq $appName) { 'application' } else { 'installer' }
        $status = [uint32]$data.ExitStatus
        Write-Record @{ kind = 'process-stop-unverified'; at = $at.ToString('o'); pid = $eventPid; role = $role; verified = $false; exitStatus = $status; exitHex = ('0x{0:x8}' -f $status) }
        continue
      }
      $identity = $known[$eventPid]
      if ($at -lt $identity.observedStart) { continue }
      $known.Remove($eventPid)
      $status = [uint32]$data.ExitStatus
      Write-Record @{
        kind = 'process-stop'; at = $at.ToString('o'); pid = $eventPid
        parentPid = [uint32]$data.ParentProcessID; role = $identity.role; verified = $true
        path = $identity.path; createdAt = $identity.created.ToString('o')
        exitStatus = $status; exitHex = ('0x{0:x8}' -f $status)
      }
    }
  }
  if ($eventCount -gt 256) { Write-Record @{ kind = 'observer-budget'; reason = 'cap-reached' } }
  if ([DateTime]::UtcNow -ge $deadline) { Write-Record @{ kind = 'observer-error'; reason = 'timeout' } }
} catch {
  Write-Record @{ kind = 'observer-unavailable'; reason = 'provider-unavailable' }
  # A missing process provider must not collect crash evidence before the app even launches.
  Write-Record @{ kind = 'observer-partial-ready'; reason = 'provider-unavailable' }
  while (-not (Test-Path -LiteralPath $StopPath) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
} finally {
  foreach ($source in @($startSource, $stopSource)) {
    Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | ForEach-Object { Remove-Event -EventIdentifier $_.EventIdentifier -ErrorAction SilentlyContinue }
  }
  try {
    $events = @(Get-WinEvent -FilterHashtable @{
      LogName = 'Application'; ProviderName = @('Application Error', 'Windows Error Reporting')
      Id = @(1000, 1001); StartTime = $started; EndTime = [DateTime]::UtcNow
    } -MaxEvents 32 -ErrorAction Stop)
    $documents = @($events | ForEach-Object { [xml]$_.ToXml() })
    Get-CrashRecords $documents ($ownedPaths.ToArray())
    if ($events.Count -eq 32) { Write-Record @{ kind = 'eventlog-truncated'; reason = 'cap-reached' } }
  } catch {
    $kind = if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'eventlog-none' } else { 'eventlog-unavailable' }
    Write-Record @{ kind = $kind; reason = 'provider-unavailable' }
  }
}
