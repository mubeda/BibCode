BeforeAll { . "$PSScriptRoot/owned-wsl2-fixture.ps1" }
Describe 'Owned WSL2 command boundary' {
  BeforeEach {
    $script:record=@{name='BibCodeQA-0123456789abcdef0123456789abcdef';appState='joined';guid='inert-guid';importRoot=@{identity='inert-fileid'};wsl=@{pin=@{path='inert-wsl.exe'}};root=@{path='inert-owner'};phase='kernel-verified';kernelVerified=$true}
    Mock Read-FixtureManifest { $script:record }
    Mock Save-FixtureManifest {}
    Mock Get-PhysicalPin { @{identity='inert-fileid'} }
    Mock Get-FixtureInventory { @{defaultGuid='inert-guid';distros=@(@{name=$script:record.name;guid='inert-guid';basePath='inert-root';version=2})} }
    Mock Invoke-FixtureCommand { '' }
  }
  It 'uses the exact name for terminate without global shutdown' {
    Invoke-OwnedFixtureAction 'Terminate'
    Should -Invoke Invoke-FixtureCommand -Times 1 -Exactly -ParameterFilter {$Arguments.Count -eq 2 -and $Arguments[0] -eq '--terminate' -and $Arguments[1] -ceq $script:record.name}
  }
  It 'uses the exact name for unregister and records its successful transition' {
    Invoke-OwnedFixtureAction 'Unregister'
    Should -Invoke Invoke-FixtureCommand -Times 1 -Exactly -ParameterFilter {$Arguments.Count -eq 2 -and $Arguments[0] -eq '--unregister' -and $Arguments[1] -ceq $script:record.name}
    $script:record.phase | Should -Be 'unregistered'
  }
  It 'refuses cleanup if the app shutdown was not joined' {
    $script:record.appState='attempted'
    { Invoke-OwnedFixtureAction 'Terminate' } | Should -Throw
    { Invoke-OwnedFixtureAction 'Unregister' } | Should -Throw
    Should -Invoke Invoke-FixtureCommand -Times 0 -Exactly
  }
  It 'refuses a replaced registry GUID before any destructive command' {
    Mock Get-FixtureInventory { @{defaultGuid='foreign';distros=@(@{name=$script:record.name;guid='foreign';basePath='inert-root';version=2})} }
    { Invoke-OwnedFixtureAction 'Terminate' } | Should -Throw
    Should -Invoke Invoke-FixtureCommand -Times 0 -Exactly
  }
  It 'refuses a foreign physical import root before any destructive command' {
    Mock Get-PhysicalPin { @{identity='foreign-fileid'} }
    { Invoke-OwnedFixtureAction 'Unregister' } | Should -Throw
    Should -Invoke Invoke-FixtureCommand -Times 0 -Exactly
  }
  It 'admits an already absent owned registration for repeated cleanup' {
    Mock Get-FixtureInventory { @{defaultGuid=$null;distros=@()} }
    Invoke-OwnedFixtureAction 'Terminate';Invoke-OwnedFixtureAction 'Unregister';Invoke-OwnedFixtureAction 'Restored'
    Should -Invoke Invoke-FixtureCommand -Times 0 -Exactly
  }
}

Describe 'Owned WSL2 standalone exit status' {
  BeforeEach {
    $prior = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $script:hadExitVariable = $null -ne $prior
    $script:priorExitValue = if ($null -eq $prior) { $null } else { $prior.Value }
  }
  AfterEach {
    if (-not $script:hadExitVariable) {
      Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    } else {
      $global:LASTEXITCODE = $script:priorExitValue
    }
  }
  BeforeAll {
    $source = Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.ps1" -Raw
    $marker = 'if($MyInvocation.InvocationName -ne ''.'') {'
    $start = $source.LastIndexOf($marker, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw 'Owned entrypoint unavailable.' }
    $entry = Join-Path $TestDrive 'inert-entry.ps1'
    $prefix = @'
param([string]$Action)
function Invoke-OwnedFixtureAction([string]$Name) {
  if ($Name -eq 'Failure') { throw 'Inert action refusal.' }
}
'@
    Set-Content -LiteralPath $entry -Value ($prefix + "`n" + $source.Substring($start)) -Encoding utf8
  }
  It 'replaces null or stale success status' -TestCases @(
    @{ Previous = $null }, @{ Previous = 0 }, @{ Previous = 9 }
  ) {
    param($Previous)
    $global:LASTEXITCODE = $Previous
    $receipt = & $entry -Action Verify
    $LASTEXITCODE | Should -Be 0
    ($receipt | ConvertFrom-Json).completed | Should -BeTrue
  }
  It 'replaces stale success with failure without ending its caller' {
    $global:LASTEXITCODE = 0
    $receipt = & $entry -Action Failure
    $LASTEXITCODE | Should -Be 1
    ($receipt | ConvertFrom-Json).completed | Should -BeFalse
  }
}


Describe 'Owned WSL2 authenticated download arguments' {
  It 'uses the actual three two-element URI and output-path tuples' {
    $source = Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.ps1" -Raw
    $marker = 'foreach($download in '
    $start = $source.IndexOf($marker, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw 'Owned download expression unavailable.' }
    $start += $marker.Length
    $end = $source.IndexOf(') { Invoke-WebRequest', $start, [StringComparison]::Ordinal)
    if ($end -lt $start) { throw 'Owned download expression boundary unavailable.' }
    $expression = $source.Substring($start, $end - $start)
    $ReleaseBase = 'https://releases.ubuntu.com/noble/'
    $SigningFingerprint = '843938DF228D22F7B3742BC0D94AA3F0EFE21092'
    $key = 'inert key path'
    $sums = 'inert checksum path'
    $signature = 'inert signature path'
    $downloads = & ([scriptblock]::Create('return ,(' + $expression + ')'))
    $downloads.Count | Should -Be 3
    @($downloads[0]).Count | Should -Be 2
    @($downloads[1]).Count | Should -Be 2
    @($downloads[2]).Count | Should -Be 2
    $downloads[0][0] | Should -BeExactly 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x843938DF228D22F7B3742BC0D94AA3F0EFE21092'
    $downloads[0][1] | Should -BeExactly 'inert key path'
    $downloads[1][0] | Should -BeExactly 'https://releases.ubuntu.com/noble/SHA256SUMS'
    $downloads[1][1] | Should -BeExactly 'inert checksum path'
    $downloads[2][0] | Should -BeExactly 'https://releases.ubuntu.com/noble/SHA256SUMS.gpg'
    $downloads[2][1] | Should -BeExactly 'inert signature path'
  }
}



Describe 'Owned WSL2 actual Prepare workflow and recorder boundary' {
  BeforeAll {
    $ownerSource = Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.ps1" -Raw
    $workflowSource = Get-Content -LiteralPath "$PSScriptRoot/../.github/workflows/desktop-upgrade-smoke.yml" -Raw
    function Read-ActualRunBody([string]$Marker) {
      $start=$workflowSource.IndexOf($Marker,[StringComparison]::Ordinal)
      if($start -lt 0){throw 'Actual workflow step unavailable.'}
      $start=$workflowSource.IndexOf('run: |',$start,[StringComparison]::Ordinal)+7
      $end=$workflowSource.IndexOf("`n      - ",$start,[StringComparison]::Ordinal)
      if($start -lt 7 -or $end -lt $start){throw 'Actual workflow run boundary unavailable.'}
      return [regex]::Replace($workflowSource.Substring($start,$end-$start).Trim(), '(?m)^          ', '')
    }
    $prepareBody=Read-ActualRunBody '      - id: native_wsl'
    $recorderBody=Read-ActualRunBody '      - name: Record native WSL prerequisite unavailable'
    $ownerStart=$ownerSource.IndexOf('function Prepare-Fixture {',[StringComparison]::Ordinal)
    if($ownerStart -lt 0){throw 'Actual Prepare source unavailable.'}
    $ownerPrefix=@'
param([string]$Action,[string]$OwnerManifest,[string]$RequestedFailure=$env:BIBCODE_INERT_PREPARE_FAILURE)
$ErrorActionPreference='Stop'
$SourceSha='a'*40
$RootfsName='ubuntu-24.04.5-wsl-amd64.wsl'
$RootfsHash='bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
$SigningFingerprint='843938DF228D22F7B3742BC0D94AA3F0EFE21092'
$ReleaseBase='https://releases.ubuntu.com/noble/'
function Test-StageFault { if($script:OwnedWslPrepareStage -eq $RequestedFailure) { throw 'Inert selected Prepare refusal.' } }
function Assert-FixtureRuntime { Test-StageFault }
function Test-Path { $false }
function Set-OwnerAcl { Test-StageFault }
function Get-AuthenticodeSignature { Test-StageFault;@{Status='Valid';SignerCertificate=@{Subject='Microsoft'}} }
function Get-FixtureInventory { Test-StageFault;@{distros=@();defaultGuid=$null} }
function Get-PhysicalPin([string]$Path) { Test-StageFault;@{path=$Path;identity='inert-file-id';directory=$true} }
function Assert-PhysicalPin { Test-StageFault }
function Get-FileHash([string]$LiteralPath) { Test-StageFault;@{Hash=if($LiteralPath.EndsWith('gpg.exe')){'INERTGPG'}else{$RootfsHash.ToUpperInvariant()}} }
function Invoke-WebRequest { Test-StageFault }
function Get-Item { Test-StageFault;@{Length=1} }
function Get-Content { Test-StageFault;$RootfsHash+' *'+$RootfsName }
function Save-FixtureManifest { Test-StageFault }
function Assert-OwnedRegistration { Test-StageFault;@{guid='inert-guid'} }
function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments) {
 Test-StageFault
 if('--fingerprint' -in $Arguments){return 'fpr:::::::::'+$SigningFingerprint+':'}
 if('--verify' -in $Arguments){return '[GNUPG:] VALIDSIG '+$SigningFingerprint}
 if('uname' -in $Arguments){if('-r' -in $Arguments){return '6.6.87.2-microsoft-standard-WSL2'};return 'x86_64'}
 if('/etc/os-release' -in $Arguments){return "ID=ubuntu`nVERSION_ID=`"24.04`""}
 if('wslpath' -in $Arguments -or 'readlink' -in $Arguments){return '/inert-checkout'}
 return ''
}
'@
    $workflowPorts=@'
$ErrorActionPreference='Stop'
function Import-Module {}
function Invoke-Pester { [pscustomobject]@{FailedCount=0} }
function Get-Acl {
 $acl=[pscustomobject]@{Access=@()}
 foreach($name in @('SetOwner','SetAccessRuleProtection','RemoveAccessRuleAll','AddAccessRule')) { $acl|Add-Member -MemberType ScriptMethod -Name $name -Value {} }
 return $acl
}
function Set-Acl {}
'@
    function Resolve-WorkflowTokens([string]$Body,[hashtable]$Values) {
      foreach($name in $Values.Keys){$Body=$Body.Replace('${{ '+$name+' }}',[string]$Values[$name])}
      if($Body.Contains('${{')){throw 'Unresolved actual workflow expression.'}
      return $Body
    }
    function Invoke-ActualPrepareRecorder([string]$Stage,[string]$Malformed,[string]$Reason='wsl-no-distro',[switch]$RecorderOnly,[string]$RecordedStage='',[switch]$ExpectSuccess) {
      $caseRoot=Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
      $scripts=Join-Path $caseRoot 'scripts';New-Item -ItemType Directory -Path $scripts -Force|Out-Null
      $owner=Join-Path $scripts 'owned-wsl2-fixture.ps1'
      if($Malformed){Set-Content -LiteralPath $owner -Value ("param([string]`$Action,[string]`$OwnerManifest,[string]`$SourceSha)`nWrite-Output '"+$Malformed+"';exit 1") -Encoding utf8}
      else{Set-Content -LiteralPath $owner -Value ($ownerPrefix+"`n"+$ownerSource.Substring($ownerStart)) -Encoding utf8}
      $output=Join-Path $caseRoot 'github-output';$environment=Join-Path $caseRoot 'github-env';New-Item -ItemType File -Path $output,$environment|Out-Null
      $saved=@{};foreach($key in @('RUNNER_TEMP','GITHUB_OUTPUT','GITHUB_ENV','GITHUB_SHA','BIBCODE_INERT_PREPARE_FAILURE')){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
      $prior=Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue;$had=$null -ne $prior;$exitValue=if($had){$prior.Value}else{$null}
      $statusSucceeded=$Reason -ne 'wsl-status-failed';$listObserved=$statusSucceeded;$listSucceeded=($Reason -ne 'wsl-list-failed' -and $statusSucceeded)
      try {
        $env:RUNNER_TEMP=$caseRoot;$env:GITHUB_OUTPUT=$output;$env:GITHUB_ENV=$environment;$env:GITHUB_SHA='a'*40;$env:BIBCODE_INERT_PREPARE_FAILURE=$Stage
        $flags=@{'steps.wsl.outputs.reason_code'=$Reason;'steps.wsl.outputs.status_succeeded'=$statusSucceeded.ToString().ToLowerInvariant();'steps.wsl.outputs.list_observed'=$listObserved.ToString().ToLowerInvariant();'steps.wsl.outputs.list_succeeded'=$listSucceeded.ToString().ToLowerInvariant()}
        $prepareFile=Join-Path $caseRoot 'prepare.ps1';Set-Content -LiteralPath $prepareFile -Value ($workflowPorts+"`n"+(Resolve-WorkflowTokens $prepareBody $flags)) -Encoding utf8
        Push-Location $caseRoot
        try {
          if($Malformed){ { & $prepareFile } | Should -Throw; (Get-Content -LiteralPath $output -Raw) | Should -Not -Match 'prepare_stage='; return }
          $outputs=@{}
          if($RecorderOnly){$outputs['reason_code']=$Reason;$outputs['prepare_stage']=$RecordedStage}
          else{& $prepareFile;foreach($line in Get-Content -LiteralPath $output){$parts=$line.Split('=',2);$outputs[$parts[0]]=$parts[1]}}
          if($ExpectSuccess){$LASTEXITCODE|Should -Be 0;$outputs['available']|Should -BeExactly 'true';$outputs.ContainsKey('prepare_stage')|Should -BeFalse;return}
          $flags['steps.native_wsl.outputs.reason_code']=$outputs['reason_code'];$flags['steps.native_wsl.outputs.prepare_stage']=$outputs['prepare_stage']
          $recorderFile=Join-Path $caseRoot 'recorder.ps1';Set-Content -LiteralPath $recorderFile -Value ($workflowPorts+"`n"+(Resolve-WorkflowTokens $recorderBody $flags)) -Encoding utf8
          { & $recorderFile } | Should -Throw
          $file=Join-Path $caseRoot 'bibcode-native-followups-wsl/evidence/native-followups-workflow-status.json'
          if($RecordedStage){Test-Path -LiteralPath $file|Should -BeFalse;return}
          $status=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
          $status.sourceSha | Should -BeExactly ('a'*40)
          $status.status | Should -BeExactly 'unavailable'
          $status.originalCount | Should -Be 0;$status.previewOriginalCount | Should -Be 0;$status.completeGroup | Should -BeFalse
          $status.wslStatusSucceeded | Should -Be $statusSucceeded;$status.wslListObserved | Should -Be $listObserved
          if($statusSucceeded){$status.wslListSucceeded | Should -Be $listSucceeded}else{$status.wslListSucceeded | Should -BeNullOrEmpty}
          if($Stage){$status.reasonCode|Should -BeExactly 'wsl-fixture-owner-refused';$status.prepareStage|Should -BeExactly $Stage;@($status.PSObject.Properties.Name).Count|Should -Be 15}
          else{$status.reasonCode|Should -BeExactly $Reason;@($status.PSObject.Properties.Name)|Should -Not -Contain 'prepareStage'}
        } finally { Pop-Location }
      } finally {
        foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')}
        if($had){$global:LASTEXITCODE=$exitValue}else{Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue}
      }
    }
  }
  It 'runs actual Prepare catch, workflow receipt admission and recorder for <Stage>' -TestCases @(
    @{Stage='runtime-admission'},@{Stage='private-root-acl'},@{Stage='launcher-admission'},@{Stage='empty-inventory'},@{Stage='launcher-readiness'},@{Stage='verifier-admission'},@{Stage='signed-metadata'},@{Stage='image-admission'},@{Stage='intent-write'},@{Stage='owned-import'},@{Stage='kernel-admission'},@{Stage='mapping-admission'}
  ) { param($Stage) Invoke-ActualPrepareRecorder $Stage '' }
  It 'keeps the original actual Prepare success receipt and availability' { Invoke-ActualPrepareRecorder '' '' -ExpectSuccess }
  It 'rejects malformed failed receipt before stage publication: <Receipt>' -TestCases @(
    @{Receipt='{"completed":0,"prepareStage":"runtime-admission"}'},@{Receipt='{"completed":"False","prepareStage":"runtime-admission"}'},@{Receipt='{"completed":[false],"prepareStage":"runtime-admission"}'},@{Receipt='{"completed":false,"prepareStage":["runtime-admission"]}'},@{Receipt='{"completed":false,"prepareStage":"RUNTIME-ADMISSION"}'},@{Receipt='{"completed":false,"prepareStage":"inert private detail"}'},@{Receipt='{"completed":false,"prepareStage":"runtime-admission","path":"inert-private"}'},@{Receipt='{"completed":false}'},@{Receipt='{"prepareStage":"runtime-admission"}'}
  ) { param($Receipt) Invoke-ActualPrepareRecorder '' $Receipt }
  It 'rejects noncanonical recorder stage <Stage>' -TestCases @(@{Stage='RUNTIME-ADMISSION'},@{Stage='inert-private-detail'}) {param($Stage) Invoke-ActualPrepareRecorder '' '' 'wsl-fixture-owner-refused' -RecorderOnly -RecordedStage $Stage}
  It 'omits stage for existing prerequisite reason <Reason>' -TestCases @(@{Reason='wsl-status-failed'},@{Reason='wsl-list-failed'},@{Reason='wsl-no-distro'}) {
    param($Reason)
    Invoke-ActualPrepareRecorder '' '' $Reason -RecorderOnly
  }
}
