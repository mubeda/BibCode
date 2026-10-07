BeforeAll {
  function Get-PinnedGpgErrorCategory([string]$Stderr) {
    if($Stderr -match '(?im)^gpg: (?:keybox .+|error (?:opening|creating) .+|can''t create directory .+|Fatal: can''t (?:open|create) .+): (?:Permission denied|Access is denied|Access denied)\s*$'){return 'storage-permission'}
    if($Stderr -match '(?im)^gpg: (?:keybox ''[^''\r\n]+'': |error (?:opening|creating) (?:keyring|keybox|trustdb).+:|can''t create directory .+|Fatal: can''t (?:open|create) .+)'){return 'storage-open-create'}
    if($Stderr -match '(?im)^gpg: (?:no valid OpenPGP data found\.|invalid armor header:|invalid radix64 character|invalid packet)'){return 'invalid-key-data'}
    if($Stderr -match '(?im)^gpg: (?:can''t open .+:|error reading .+:)'){return 'input-open-read'}
    if($Stderr -match '(?im)^gpg: (?:error running .+:|failed to start agent|can''t connect to the agent:)'){return 'runtime-agent'}
    return 'other'
  }


  $script:GpgPrivateEvidenceRealContext=$false
  $script:GpgPrivateEvidenceAttempted=$false
  function Initialize-GpgPrivateEvidenceSdk {
    if('OwnedGpgEvidenceV1' -as [type]){return}
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
public static class OwnedGpgEvidenceV1 {
  public static byte[][] Seal(string publicSpki, string fingerprint, string stderr, byte[] context) {
    byte[] plaintext = null;
    byte[] key = null;
    try {
      if (publicSpki == null || publicSpki.Length == 0 || publicSpki.Length > 2048 || publicSpki.Length % 4 != 0 ||
          !Regex.IsMatch(publicSpki, @"\A[A-Za-z0-9+/]+={0,2}\z") ||
          fingerprint == null || !Regex.IsMatch(fingerprint, @"\A[a-f0-9]{64}\z")) throw new InvalidOperationException("Evidence omitted.");
      int padding = publicSpki.EndsWith("==", StringComparison.Ordinal) ? 2 : publicSpki.EndsWith("=", StringComparison.Ordinal) ? 1 : 0;
      int decodedLength = publicSpki.Length / 4 * 3 - padding;
      if (decodedLength < 1 || decodedLength > 1024 || context == null || context.Length == 0 || context.Length > 4096) throw new InvalidOperationException("Evidence omitted.");
      UTF8Encoding utf8 = new UTF8Encoding(false, true);
      int length = utf8.GetByteCount(stderr);
      if (length < 1 || length > 1048576) throw new InvalidOperationException("Evidence omitted.");
      byte[] der = Convert.FromBase64String(publicSpki);
      if (Convert.ToBase64String(der) != publicSpki || der.Length != decodedLength ||
          Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant() != fingerprint) throw new InvalidOperationException("Evidence omitted.");
      using (RSA rsa = RSA.Create()) {
        int consumed;
        rsa.ImportSubjectPublicKeyInfo(der, out consumed);
        RSAParameters parameters = rsa.ExportParameters(false);
        if (consumed != der.Length || rsa.KeySize != 3072 || parameters.Modulus == null || parameters.Modulus.Length != 384 ||
            parameters.Exponent == null || parameters.Exponent.Length != 3 || parameters.Exponent[0] != 1 || parameters.Exponent[1] != 0 || parameters.Exponent[2] != 1) throw new InvalidOperationException("Evidence omitted.");
        plaintext = utf8.GetBytes(stderr);
        key = RandomNumberGenerator.GetBytes(32);
        byte[] nonce = RandomNumberGenerator.GetBytes(12);
        byte[] ciphertext = new byte[length];
        byte[] tag = new byte[16];
        using (AesGcm aes = new AesGcm(key, 16)) { aes.Encrypt(nonce, plaintext, ciphertext, tag, context); }
        byte[] wrapped = rsa.Encrypt(key, RSAEncryptionPadding.OaepSHA256);
        if (wrapped.Length != 384) throw new InvalidOperationException("Evidence omitted.");
        return new byte[][] { context, ciphertext, wrapped, nonce, tag };
      }
    } finally {
      if (plaintext != null) CryptographicOperations.ZeroMemory(plaintext);
      if (key != null) CryptographicOperations.ZeroMemory(key);
    }
  }
  public static void Publish(string root, byte[][] parts) {
    if (parts == null || parts.Length != 5 || parts[0].Length < 1 || parts[0].Length > 4096 || parts[1].Length < 1 || parts[1].Length > 1048576 || parts[2].Length != 384 || parts[3].Length != 12 || parts[4].Length != 16) throw new InvalidOperationException("Evidence omitted.");
    DirectoryInfo directory = new DirectoryInfo(root);
    for (DirectoryInfo current = directory; current != null; current = current.Parent) {
      if (!current.Exists || (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Evidence omitted.");
    }
    if (directory.GetFileSystemInfos().Length != 0) throw new InvalidOperationException("Evidence omitted.");
    string pending = Path.Combine(root, "pending");
    string ready = Path.Combine(root, "ready");
    if (Directory.Exists(pending) || File.Exists(pending) || Directory.Exists(ready) || File.Exists(ready)) throw new InvalidOperationException("Evidence omitted.");
    Directory.CreateDirectory(pending);
    string[] names = { "context.json", "stderr.aesgcm.bin", "key.rsa-oaep-sha256.bin", "nonce.bin", "tag.bin" };
    for (int index = 0; index < names.Length; index++) {
      using (FileStream file = new FileStream(Path.Combine(pending, names[index]), FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        file.Write(parts[index], 0, parts[index].Length);
        file.Flush(true);
      }
    }
    if ((new DirectoryInfo(root).Attributes & FileAttributes.ReparsePoint) != 0 || (new DirectoryInfo(pending).Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Evidence omitted.");
    Directory.Move(pending, ready);
  }
  public static string OpenInert(RSA testKey, byte[][] parts) {
    byte[] key = null;
    byte[] plaintext = null;
    try {
      key = testKey.Decrypt(parts[2], RSAEncryptionPadding.OaepSHA256);
      if (key.Length != 32 || parts[3].Length != 12 || parts[4].Length != 16) throw new InvalidOperationException("Inert evidence refused.");
      plaintext = new byte[parts[1].Length];
      using (AesGcm aes = new AesGcm(key, 16)) { aes.Decrypt(parts[3], parts[1], parts[4], plaintext, parts[0]); }
      return new UTF8Encoding(false, true).GetString(plaintext);
    } finally {
      if (key != null) CryptographicOperations.ZeroMemory(key);
      if (plaintext != null) CryptographicOperations.ZeroMemory(plaintext);
    }
  }
}
'@ | Out-Null
  }
  function Get-GpgPrivateEvidenceAdmission([hashtable]$Environment,[bool]$Windows) {
    if(-not $Windows -or $Environment.CI -cne 'true' -or $Environment.GITHUB_ACTIONS -cne 'true' -or $Environment.GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $Environment.GITHUB_JOB -cne 'windows_wsl_upgrade_smoke' -or $Environment.BIBCODE_GPG_EVIDENCE_SELECTED -cne 'true' -or $Environment.BIBCODE_GPG_EVIDENCE_ROOT_READY -cne 'true'){return $null}
    $public=$Environment.BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI;$fingerprint=$Environment.BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256
    if($public -isnot [string] -or $public.Length -lt 1 -or $public.Length -gt 2048 -or $public.Length % 4 -ne 0 -or $public -cnotmatch '\A[A-Za-z0-9+/]+={0,2}\z' -or $fingerprint -cnotmatch '\A[a-f0-9]{64}\z' -or $Environment.GITHUB_SHA -cnotmatch '\A[a-f0-9]{40}\z'){return $null}
    $run=0L;$attempt=0L
    if(-not [long]::TryParse($Environment.GITHUB_RUN_ID,[ref]$run) -or $run -lt 1 -or $run -gt 9007199254740991 -or -not [long]::TryParse($Environment.GITHUB_RUN_ATTEMPT,[ref]$attempt) -or $attempt -lt 1 -or $attempt -gt 9007199254740991){return $null}
    return [pscustomobject]@{publicSpki=$public;context=[ordered]@{version=1;scope='wsl-real-gpg-import';alg='RSA-OAEP-SHA256';enc='AES-256-GCM';source=$Environment.GITHUB_SHA;run=$run;attempt=$attempt;jobRole='windows-native';fingerprint=$fingerprint}}
  }
  function New-GpgPrivateSealedParts($Admission,[string]$Stderr) {
    Initialize-GpgPrivateEvidenceSdk
    $context=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Admission.context|ConvertTo-Json -Compress))
    return ,([OwnedGpgEvidenceV1]::Seal($Admission.publicSpki,$Admission.context.fingerprint,$Stderr,$context))
  }
  function Publish-GpgPrivateSealedParts([string]$Root,[byte[][]]$Parts) { [OwnedGpgEvidenceV1]::Publish($Root,$Parts) }
  function Save-GpgPrivateEvidence([string]$Stderr) {
    try {
      if($script:GpgPrivateEvidenceRealContext -ne $true -or $script:GpgPrivateEvidenceAttempted -eq $true){return 'omitted'}
      $script:GpgPrivateEvidenceAttempted=$true
      $facts=@{};foreach($name in @('CI','GITHUB_ACTIONS','GITHUB_EVENT_NAME','GITHUB_JOB','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','BIBCODE_GPG_EVIDENCE_SELECTED','BIBCODE_GPG_EVIDENCE_ROOT_READY','BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI','BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256')){$facts[$name]=[Environment]::GetEnvironmentVariable($name)}
      $admission=Get-GpgPrivateEvidenceAdmission $facts ([OperatingSystem]::IsWindows())
      if($null -eq $admission){return 'omitted'}
      $root=Join-Path $env:RUNNER_TEMP 'bibcode-gpg-private-evidence'
      $pin=Get-PhysicalPin $root;Assert-OwnerAcl $root
      $parts=New-GpgPrivateSealedParts $admission $Stderr
      Assert-PhysicalPin $pin;Assert-OwnerAcl $root
      Publish-GpgPrivateSealedParts $root $parts
      return 'completed'
    } catch { return 'omitted' }
  }

  function Get-PinnedGpgInputError([string]$Stderr,[string]$ExpectedInput) {
    $result=[pscustomobject]@{errno='other';expectedInputMatched=$false}
    $lines=[regex]::Matches($Stderr,'(?m)^gpg: (?:can''t open|error reading) ''([^\r\n]+)'': ([^\r\n]+)\r?$')
    if($lines.Count -ne 1){return $result}
    switch -CaseSensitive ($lines[0].Groups[2].Value) {
      'No such file or directory' {$result.errno='missing-input';break}
      'Permission denied' {$result.errno='permission-denied';break}
      'Invalid argument' {$result.errno='invalid-argument';break}
      'Input/output error' {$result.errno='io-error';break}
    }
    try {
      $operand=$lines[0].Groups[1].Value.Replace('/','\')
      $expected=$ExpectedInput.Replace('/','\')
      if([IO.Path]::IsPathFullyQualified($operand) -and [IO.Path]::IsPathFullyQualified($expected)) {
        $result.expectedInputMatched=[string]::Equals([IO.Path]::GetFullPath($operand),[IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase)
      }
    } catch { }
    return $result
  }
. "$PSScriptRoot/owned-wsl2-fixture.ps1" }
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
    $end = $source.IndexOf(') {', $start, [StringComparison]::Ordinal)
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
function Set-OwnerAcl { Test-StageFault;if($env:BIBCODE_INERT_SIGNED_FAILURE -ceq 'acl' -and $script:OwnedWslPrepareStage -ceq 'signed-metadata'){throw 'Inert metadata ACL refusal.'} }
function Get-AuthenticodeSignature { Test-StageFault;@{Status='Valid';SignerCertificate=@{Subject='Microsoft'}} }
function Get-FixtureInventory { Test-StageFault;@{distros=@();defaultGuid=$null} }
function Get-PhysicalPin([string]$Path) { Test-StageFault;@{path=$Path;identity='inert-file-id';directory=$true} }
function Assert-PhysicalPin { Test-StageFault }
function Get-FileHash([string]$LiteralPath) { Test-StageFault;@{Hash=if($LiteralPath.EndsWith('gpg.exe')){'INERTGPG'}else{$RootfsHash.ToUpperInvariant()}} }
function Invoke-WebRequest([switch]$PassThru) { Test-StageFault;if($PassThru){@{StatusCode=200}} }
function Get-Item { Test-StageFault;@{Length=if($env:BIBCODE_INERT_SIGNED_FAILURE -ceq 'oversize'){3000000}else{1}} }
function Get-Content { Test-StageFault;$RootfsHash+' *'+$RootfsName }
function Save-FixtureManifest { Test-StageFault }
function Assert-OwnedRegistration { Test-StageFault;@{guid='inert-guid'} }
function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments) {
 Test-StageFault
 if($script:OwnedWslPrepareStage -ceq 'signed-metadata'){$script:OwnedWslSignedMetadata.commandExit=0;if($env:BIBCODE_INERT_SIGNED_FAILURE -ceq 'gpg-exit'){$script:OwnedWslSignedMetadata.commandExit=2;throw 'Inert GPG refusal.'}}
 if($env:BIBCODE_INERT_SIGNED_FAILURE -ceq 'fingerprint' -and '--fingerprint' -in $Arguments){return 'fpr:::::::::INERT-WRONG:'}
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
    function Invoke-ActualPrepareRecorder([string]$Stage,[string]$Malformed,[string]$Reason='wsl-no-distro',[switch]$RecorderOnly,[string]$RecordedStage='',[switch]$ExpectSuccess,[string]$SignedCase='') {
      $caseRoot=Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
      $scripts=Join-Path $caseRoot 'scripts';New-Item -ItemType Directory -Path $scripts -Force|Out-Null
      $owner=Join-Path $scripts 'owned-wsl2-fixture.ps1'
      if($Malformed){Set-Content -LiteralPath $owner -Value ("param([string]`$Action,[string]`$OwnerManifest,[string]`$SourceSha)`nWrite-Output '"+$Malformed+"';exit 1") -Encoding utf8}
      else{Set-Content -LiteralPath $owner -Value ($ownerPrefix+"`n"+$ownerSource.Substring($ownerStart)) -Encoding utf8}
      $output=Join-Path $caseRoot 'github-output';$environment=Join-Path $caseRoot 'github-env';New-Item -ItemType File -Path $output,$environment|Out-Null
      $saved=@{};foreach($key in @('RUNNER_TEMP','GITHUB_OUTPUT','GITHUB_ENV','GITHUB_SHA','BIBCODE_INERT_PREPARE_FAILURE','BIBCODE_INERT_SIGNED_FAILURE')){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
      $prior=Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue;$had=$null -ne $prior;$exitValue=if($had){$prior.Value}else{$null}
      $statusSucceeded=$Reason -ne 'wsl-status-failed';$listObserved=$statusSucceeded;$listSucceeded=($Reason -ne 'wsl-list-failed' -and $statusSucceeded)
      try {
        $env:RUNNER_TEMP=$caseRoot;$env:GITHUB_OUTPUT=$output;$env:GITHUB_ENV=$environment;$env:GITHUB_SHA='a'*40;$env:BIBCODE_INERT_PREPARE_FAILURE=$Stage;$env:BIBCODE_INERT_SIGNED_FAILURE=$SignedCase
        $flags=@{'steps.wsl.outputs.reason_code'=$Reason;'steps.wsl.outputs.status_succeeded'=$statusSucceeded.ToString().ToLowerInvariant();'steps.wsl.outputs.list_observed'=$listObserved.ToString().ToLowerInvariant();'steps.wsl.outputs.list_succeeded'=$listSucceeded.ToString().ToLowerInvariant()}
        $prepareFile=Join-Path $caseRoot 'prepare.ps1';Set-Content -LiteralPath $prepareFile -Value ($workflowPorts+"`n"+(Resolve-WorkflowTokens $prepareBody $flags)) -Encoding utf8
        Push-Location $caseRoot
        try {
          if($Malformed){ { & $prepareFile } | Should -Throw; (Get-Content -LiteralPath $output -Raw) | Should -Not -Match 'prepare_stage='; return }
          $outputs=@{}
          if($RecorderOnly){$outputs['reason_code']=$Reason;$outputs['prepare_stage']=$RecordedStage}
          else{& $prepareFile;foreach($line in Get-Content -LiteralPath $output){$parts=$line.Split('=',2);$outputs[$parts[0]]=$parts[1]}}
          if($ExpectSuccess){$LASTEXITCODE|Should -Be 0;$outputs['available']|Should -BeExactly 'true';$outputs.ContainsKey('prepare_stage')|Should -BeFalse;return}
          $flags['steps.native_wsl.outputs.reason_code']=$outputs['reason_code'];$flags['steps.native_wsl.outputs.prepare_stage']=$outputs['prepare_stage'];$flags['steps.native_wsl.outputs.signed_metadata']=$outputs['signed_metadata']
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
          if($Stage -or $SignedCase){$expectedStage=if($SignedCase){'signed-metadata'}else{$Stage};$status.reasonCode|Should -BeExactly 'wsl-fixture-owner-refused';$status.prepareStage|Should -BeExactly $expectedStage;if($expectedStage -ceq 'signed-metadata'){if(-not $SignedCase){$status.signedMetadata.operation|Should -BeExactly 'get';$status.signedMetadata.item|Should -BeExactly 'key';$status.signedMetadata.httpStatus|Should -BeNullOrEmpty};if($SignedCase -ceq 'acl'){$status.signedMetadata.operation|Should -BeExactly 'file-acl';$status.signedMetadata.httpStatus|Should -Be 200};if($SignedCase -ceq 'oversize'){$status.signedMetadata.sizeMatched|Should -BeFalse};if($SignedCase -ceq 'gpg-exit'){$status.signedMetadata.commandExit|Should -Be 2};if($SignedCase -ceq 'fingerprint'){$status.signedMetadata.fingerprintCount|Should -Be 0;$status.signedMetadata.fingerprintMatched|Should -BeFalse};@($status.PSObject.Properties.Name).Count|Should -Be 16}else{@($status.PSObject.Properties.Name).Count|Should -Be 15}}
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
  It 'retains already-computed signed failure outcome <Case>' -TestCases @(@{Case='acl'},@{Case='oversize'},@{Case='gpg-exit'},@{Case='fingerprint'}) {param($Case) Invoke-ActualPrepareRecorder '' '' -SignedCase $Case}
  It 'keeps the original actual Prepare success receipt and availability' { Invoke-ActualPrepareRecorder '' '' -ExpectSuccess }
  It 'rejects malformed failed receipt before stage publication: <Receipt>' -TestCases @(
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":["key"],"operation":null,"httpStatus":null,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":"KEY","operation":null,"httpStatus":null,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":"unknown","httpStatus":null,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":200.5,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":600,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":null,"commandExit":"1","sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":null,"commandExit":null,"sizeMatched":null,"fingerprintCount":3,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":null,"commandExit":null,"sizeMatched":"true","fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null}}'},
    @{Receipt='{"completed":false,"prepareStage":"signed-metadata","signedMetadata":{"item":null,"operation":null,"httpStatus":null,"commandExit":null,"sizeMatched":null,"fingerprintCount":null,"fingerprintMatched":null,"signatureCount":null,"signerMatched":null,"checksumCount":null,"checksumMatched":null,"path":"inert-private"}}'},
    @{Receipt='{"completed":0,"prepareStage":"runtime-admission"}'},@{Receipt='{"completed":"False","prepareStage":"runtime-admission"}'},@{Receipt='{"completed":[false],"prepareStage":"runtime-admission"}'},@{Receipt='{"completed":false,"prepareStage":["runtime-admission"]}'},@{Receipt='{"completed":false,"prepareStage":"RUNTIME-ADMISSION"}'},@{Receipt='{"completed":false,"prepareStage":"inert private detail"}'},@{Receipt='{"completed":false,"prepareStage":"runtime-admission","path":"inert-private"}'},@{Receipt='{"completed":false}'},@{Receipt='{"prepareStage":"runtime-admission"}'}
  ) { param($Receipt) Invoke-ActualPrepareRecorder '' $Receipt }
  It 'rejects noncanonical recorder stage <Stage>' -TestCases @(@{Stage='RUNTIME-ADMISSION'},@{Stage='inert-private-detail'}) {param($Stage) Invoke-ActualPrepareRecorder '' '' 'wsl-fixture-owner-refused' -RecorderOnly -RecordedStage $Stage}
  It 'omits stage for existing prerequisite reason <Reason>' -TestCases @(@{Reason='wsl-status-failed'},@{Reason='wsl-list-failed'},@{Reason='wsl-no-distro'}) {
    param($Reason)
    Invoke-ActualPrepareRecorder '' '' $Reason -RecorderOnly
  }
}


Describe 'Owned WSL2 real authenticated metadata verifier (CI only)' {
  It 'runs the existing bounded GPG caller against pinned metadata in an owned homedir' {
    if(-not [OperatingSystem]::IsWindows() -or $env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true'){throw 'Windows CI verifier required.'}
    $root=Join-Path $TestDrive 'real-crypto';New-Item -ItemType Directory -Path $root|Out-Null
    Set-OwnerAcl $root
    $taskGpgHome=Join-Path $root 'gnupg';New-Item -ItemType Directory -Path $taskGpgHome|Out-Null;Set-OwnerAcl $taskGpgHome
    $savedManifest=$OwnerManifest
    $savedContext=@{}
    foreach($contextName in @('Action','OwnedWslPrepareStage','OwnedWslSignedMetadata','GpgPrivateEvidenceRealContext','GpgPrivateEvidenceAttempted')) {
      $previous=Get-Variable -Name $contextName -Scope Script -ErrorAction SilentlyContinue
      $savedContext[$contextName]=@{exists=$null -ne $previous;value=if($null -ne $previous){$previous.Value}else{$null}}
    }
    try {
      $Action='Prepare'
      $script:Action='Prepare';$script:OwnedWslPrepareStage='signed-metadata'
      $script:GpgPrivateEvidenceRealContext=$true;$script:GpgPrivateEvidenceAttempted=$false
      $script:OwnedWslSignedMetadata=[ordered]@{operation='gpg-import';commandExit=$null}
      $OwnerManifest=Join-Path $root 'owner.secret.json'
      $gpg=Join-Path $env:ProgramFiles 'Git/usr/bin/gpg.exe';$gpgPin=Get-PhysicalPin $gpg
      $fixtures=Join-Path $PSScriptRoot 'fixtures/owned-wsl2'
      $hashes=@{
        'ubuntu-image-signing-key.asc'='337fa0013bb263aebcef98fa7b7af18e186d89565a5019f7295beb42ebee5290'
        'noble-SHA256SUMS'='728064ecf411f4ab702d9c3ca0a938ce672771424c028a1b52b2449f7eb5a068'
        'noble-SHA256SUMS.gpg'='f9be4b4a527b63f14dde0387edcb7a02ba3ac43d537b1674a5aeae19c6f23827'
      }
      foreach($name in $hashes.Keys){$file=Join-Path $fixtures $name;(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()|Should -BeExactly $hashes[$name];Copy-Item -LiteralPath $file -Destination (Join-Path $root $name);Set-OwnerAcl (Join-Path $root $name)}
      $key=Join-Path $root 'ubuntu-image-signing-key.asc';$sums=Join-Path $root 'noble-SHA256SUMS';$signature=Join-Path $root 'noble-SHA256SUMS.gpg'
      function Invoke-PinnedMetadataCommand([string]$Operation,[string[]]$Arguments,[string]$ExpectedInput) {
        $beforeCommands=@(Get-ChildItem -LiteralPath $root -File -Filter 'command-*.private.json'|ForEach-Object {$_.Name})
        try { Invoke-FixtureCommand $gpg $Arguments } catch {
          $originalFailure=$_
          $newCommands=@(Get-ChildItem -LiteralPath $root -File -Filter 'command-*.private.json'|Where-Object {$_.Name -cnotin $beforeCommands})
          if($newCommands.Count -ne 1){throw ('Pinned GPG '+$Operation+' refused; commandReceiptPresent=false; commandExit='+$script:OwnedWslSignedMetadata.commandExit)}
          $command=Get-Content -LiteralPath $newCommands[0].FullName -Raw|ConvertFrom-Json
          @($command.PSObject.Properties.Name|Sort-Object)|Should -Be @('exitCode','stderr','stdout')
          ($command.exitCode -is [int] -or $command.exitCode -is [long])|Should -BeTrue
          ($command.exitCode -ge 0 -and $command.exitCode -le 255)|Should -BeTrue
          ($command.stdout -is [string])|Should -BeTrue;($command.stderr -is [string])|Should -BeTrue
          $command.exitCode|Should -Be $script:OwnedWslSignedMetadata.commandExit
          if($command.exitCode -ne 0){
            $failureMessage='Pinned GPG '+$Operation+' refused; commandReceiptPresent=true; commandExit='+$command.exitCode+'; stdoutPresent='+($command.stdout.Length -gt 0)+'; stderrPresent='+($command.stderr.Length -gt 0)+'; category='+(Get-PinnedGpgErrorCategory $command.stderr)
            if($Operation -ceq 'gpg-import') {
              $inputError=Get-PinnedGpgInputError $command.stderr $ExpectedInput
              $failureMessage+='; errno='+$inputError.errno+'; expectedInputMatched='+$inputError.expectedInputMatched
            }
            if($Operation -ceq 'gpg-import' -and $script:GpgPrivateEvidenceRealContext -eq $true){try {[void](Save-GpgPrivateEvidence $command.stderr)}catch { }}
            throw $failureMessage
          }
          throw $originalFailure
        }
      }
      Invoke-PinnedMetadataCommand 'gpg-import' @('--homedir',$taskGpgHome,'--batch','--import',$key) $key|Out-Null
      $script:OwnedWslSignedMetadata.commandExit|Should -Be 0
      $script:OwnedWslSignedMetadata.operation='fingerprint-admission';$script:OwnedWslSignedMetadata.commandExit=$null
      $fingerprints=Invoke-PinnedMetadataCommand 'fingerprint-admission' @('--homedir',$taskGpgHome,'--batch','--with-colons','--fingerprint','843938DF228D22F7B3742BC0D94AA3F0EFE21092')
      $script:OwnedWslSignedMetadata.commandExit|Should -Be 0
      @($fingerprints -split "`n"|Where-Object {$_ -match '^fpr:' -and ($_ -split ':')[9] -ceq '843938DF228D22F7B3742BC0D94AA3F0EFE21092'}).Count|Should -Be 1
      $script:OwnedWslSignedMetadata.operation='signature-admission';$script:OwnedWslSignedMetadata.commandExit=$null
      $verification=Invoke-PinnedMetadataCommand 'signature-admission' @('--homedir',$taskGpgHome,'--batch','--status-fd','1','--verify',$signature,$sums)
      $script:OwnedWslSignedMetadata.commandExit|Should -Be 0
      $valid=@($verification -split "`n"|Where-Object {$_ -match '^\[GNUPG:\] VALIDSIG '});$valid.Count|Should -Be 1
      ($valid[0] -split ' ')[2]|Should -BeExactly '843938DF228D22F7B3742BC0D94AA3F0EFE21092'
      $line=@(Get-Content -LiteralPath $sums|Where-Object {$_ -cmatch '^[a-f0-9]{64} [ *]ubuntu-24\.04\.5-wsl-amd64\.wsl$'});$line.Count|Should -Be 1
      $line[0].Substring(0,64)|Should -BeExactly 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
      $corrupt=Join-Path $root 'corrupt-SHA256SUMS';[IO.File]::WriteAllText($corrupt,([IO.File]::ReadAllText($sums)+'inert-corruption'));Set-OwnerAcl $corrupt
      $script:OwnedWslSignedMetadata.commandExit=$null
      {Invoke-FixtureCommand $gpg @('--homedir',$taskGpgHome,'--batch','--status-fd','1','--verify',$signature,$corrupt)}|Should -Throw
      $script:OwnedWslSignedMetadata.commandExit|Should -BeGreaterThan 0
      ($script:OwnedWslSignedMetadata.commandExit -le 255)|Should -BeTrue
      Assert-PhysicalPin $gpgPin
    } finally {
      $OwnerManifest=$savedManifest
      foreach($contextName in $savedContext.Keys) {
        if($savedContext[$contextName].exists){Set-Variable -Name $contextName -Scope Script -Value $savedContext[$contextName].value}
        else{Remove-Variable -Name $contextName -Scope Script -ErrorAction SilentlyContinue}
      }
    }
  }
}


Describe 'Owned WSL2 pinned GPG closed error category (inert)' {
  It 'projects <Category> from already-read error text' -TestCases @(
    @{Stderr="gpg: can't open 'inert-key': No such file or directory";Category='input-open-read'},
    @{Stderr="gpg: error reading 'inert-key': Input/output error";Category='input-open-read'},
    @{Stderr='gpg: no valid OpenPGP data found.';Category='invalid-key-data'},
    @{Stderr='gpg: invalid armor header: inert-private';Category='invalid-key-data'},
    @{Stderr="gpg: keybox 'inert-home/pubring.kbx': Permission denied";Category='storage-permission'},
    @{Stderr="gpg: error creating 'inert-home/pubring.kbx': Permission denied";Category='storage-permission'},
    @{Stderr="gpg: can't create directory 'inert-home': Permission denied";Category='storage-permission'},
    @{Stderr="gpg: error opening keyring 'inert-home/pubring.kbx': No such file or directory";Category='storage-open-create'},
    @{Stderr="gpg: can't create directory 'inert-home': No such file or directory";Category='storage-open-create'},
    @{Stderr="gpg: error running 'inert-agent': exit status 2";Category='runtime-agent'},
    @{Stderr="gpg: can't connect to the agent: IPC connect call failed";Category='runtime-agent'},
    @{Stderr="gpg: WARNING: unsafe permissions on homedir 'inert-home'";Category='other'},
    @{Stderr="gpg: keybox 'inert-home/pubring.kbx' created";Category='other'},
    @{Stderr="gpg: keybox 'C:/inert-home/pubring.kbx' created";Category='other'},
    @{Stderr="gpg: keybox 'C:/inert-home/pubring.kbx' created`ngpg: can't open 'C:/inert-key': No such file or directory";Category='input-open-read'},
    @{Stderr="gpg: keybox 'C:/inert-home/pubring.kbx': No such file or directory";Category='storage-open-create'},
    @{Stderr="gpg: keybox 'C:/inert-home/pubring.kbx': Permission denied";Category='storage-permission'},
    @{Stderr="gpg: keybox 'inert-home/pubring.kbx' created`ngpg: can't open 'inert-key': No such file or directory";Category='input-open-read'},
    @{Stderr='inert-private-path-and-credential';Category='other'},
    @{Stderr='';Category='other'}
  ) {
    param($Stderr,$Category)
    $actual=Get-PinnedGpgErrorCategory $Stderr
    $actual|Should -BeExactly $Category
    ($actual -cin @('input-open-read','invalid-key-data','storage-permission','storage-open-create','runtime-agent','other'))|Should -BeTrue
  }
}


Describe 'Owned WSL2 complete GPG input error projection (inert)' {
  It 'returns only <Errno> and expected-operand <ExpectedMatch>' -TestCases @(
    @{Stderr="gpg: can't open 'C:\inert-home\key.asc': No such file or directory";Expected='C:\inert-home\key.asc';Errno='missing-input';ExpectedMatch=$true},
    @{Stderr="gpg: can't open 'C:/inert home/key.asc': No such file or directory";Expected='C:\inert home\key.asc';Errno='missing-input';ExpectedMatch=$true},
    @{Stderr="gpg: can't open 'c:/INERT-HOME/key.asc': Permission denied";Expected='C:\inert-home\key.asc';Errno='permission-denied';ExpectedMatch=$true},
    @{Stderr="gpg: can't open 'C:/foreign/key.asc': No such file or directory";Expected='C:\inert-home\key.asc';Errno='missing-input';ExpectedMatch=$false},
    @{Stderr="gpg: keybox 'C:/inert-home/pubring.kbx' created`r`ngpg: can't open 'C:/inert-home/key.asc': Permission denied`r`n";Expected='C:\inert-home\key.asc';Errno='permission-denied';ExpectedMatch=$true},
    @{Stderr="gpg: can't open 'C:/inert-home/key.asc': Invalid argument";Expected='C:\inert-home\key.asc';Errno='invalid-argument';ExpectedMatch=$true},
    @{Stderr="gpg: error reading 'C:/inert-home/key.asc': Input/output error";Expected='C:\inert-home\key.asc';Errno='io-error';ExpectedMatch=$true},
    @{Stderr="gpg: Zugriff auf 'C:/inert-home/key.asc' verweigert";Expected='C:\inert-home\key.asc';Errno='other';ExpectedMatch=$false},
    @{Stderr="gpg: can't open 'C:/inert-home/key.asc': Unbekannter Fehler";Expected='C:\inert-home\key.asc';Errno='other';ExpectedMatch=$true},
    @{Stderr="prefix gpg: can't open 'C:/inert-home/key.asc': No such file or directory";Expected='C:\inert-home\key.asc';Errno='other';ExpectedMatch=$false},
    @{Stderr="gpg: can't open 'C:/inert-home/key.asc': No such file or directory`ngpg: can't open 'C:/foreign/key.asc': Permission denied";Expected='C:\inert-home\key.asc';Errno='other';ExpectedMatch=$false},
    @{Stderr="gpg: can't open 'key.asc': No such file or directory";Expected='C:\inert-home\key.asc';Errno='missing-input';ExpectedMatch=$false},
    @{Stderr="gpg: can't open 'C:/inert-home/sub/../key.asc': No such file or directory";Expected='C:\inert-home\key.asc';Errno='missing-input';ExpectedMatch=$true},
    @{Stderr='';Expected='C:\inert-home\key.asc';Errno='other';ExpectedMatch=$false}
  ) {
    param($Stderr,$Expected,$Errno,$ExpectedMatch)
    $projection=Get-PinnedGpgInputError $Stderr $Expected
    @($projection.PSObject.Properties.Name|Sort-Object)|Should -Be @('errno','expectedInputMatched')
    $projection.errno|Should -BeExactly $Errno
    ($projection.expectedInputMatched -is [bool])|Should -BeTrue
    $projection.expectedInputMatched|Should -Be $ExpectedMatch
  }
  It 'executes the actual failed-command wrapper and preserves fixed failure output' {
    $testsSource=Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.Tests.ps1" -Raw
    $start=$testsSource.IndexOf('function Invoke-PinnedMetadataCommand(',[StringComparison]::Ordinal)
    $end=$testsSource.IndexOf("`n      Invoke-PinnedMetadataCommand 'gpg-import'",$start,[StringComparison]::Ordinal)
    if($start -lt 0 -or $end -le $start){throw 'Actual pinned command wrapper unavailable.'}
    $root=Join-Path $TestDrive 'inert-input-error';New-Item -ItemType Directory -Path $root|Out-Null
    $gpg='inert-gpg';$expectedInput=Join-Path $root 'key.asc'
    $previousMetadata=Get-Variable -Name OwnedWslSignedMetadata -Scope Script -ErrorAction SilentlyContinue
    $previousMetadataValue=if($null -ne $previousMetadata){$previousMetadata.Value}else{$null}
    try {
    $script:OwnedWslSignedMetadata=[ordered]@{commandExit=2}
    function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments) {
      $record=[ordered]@{stdout='';stderr="gpg: can't open '"+$expectedInput+"': Permission denied";exitCode=2}
      [IO.File]::WriteAllText((Join-Path $root 'command-inert.private.json'),($record|ConvertTo-Json -Compress))
      throw 'Inert existing command refusal.'
    }
    $call="`nInvoke-PinnedMetadataCommand 'gpg-import' @('--import',`$expectedInput) `$expectedInput"
    $caught=$null
    try {& ([scriptblock]::Create($testsSource.Substring($start,$end-$start)+$call))}catch{$caught=$_}
    $caught|Should -Not -BeNullOrEmpty
    $caught.Exception.Message|Should -BeExactly 'Pinned GPG gpg-import refused; commandReceiptPresent=true; commandExit=2; stdoutPresent=False; stderrPresent=True; category=input-open-read; errno=permission-denied; expectedInputMatched=True'
    } finally {
      if($null -ne $previousMetadata){$script:OwnedWslSignedMetadata=$previousMetadataValue}
      else{Remove-Variable -Name OwnedWslSignedMetadata -Scope Script -ErrorAction SilentlyContinue}
    }
  }
}


Describe 'Owned WSL2 optional private GPG evidence (inert)' {
  BeforeAll {
    $script:InertGpgEnvironment=@{CI='true';GITHUB_ACTIONS='true';GITHUB_EVENT_NAME='workflow_dispatch';GITHUB_JOB='windows_wsl_upgrade_smoke';GITHUB_SHA=('1'*40);GITHUB_RUN_ID='1';GITHUB_RUN_ATTEMPT='1';BIBCODE_GPG_EVIDENCE_SELECTED='true';BIBCODE_GPG_EVIDENCE_ROOT_READY='true';BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI='AAAA';BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256=('0'*64)}
  }
  It 'omits evidence for inadmissible <Field>' -TestCases @(
    @{Field='GITHUB_EVENT_NAME';Value='workflow_call'},@{Field='GITHUB_EVENT_NAME';Value='pull_request'},@{Field='GITHUB_JOB';Value='other'},@{Field='BIBCODE_GPG_EVIDENCE_SELECTED';Value='false'},@{Field='BIBCODE_GPG_EVIDENCE_ROOT_READY';Value='false'},@{Field='CI';Value='false'},@{Field='GITHUB_ACTIONS';Value='false'},@{Field='GITHUB_SHA';Value='invalid'},@{Field='GITHUB_RUN_ID';Value='0'},@{Field='GITHUB_RUN_ATTEMPT';Value='-1'},@{Field='BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI';Value=''},@{Field='BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI';Value=('A'*2052)},@{Field='BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256';Value=''},@{Field='BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256';Value=('A'*64)}
  ) {
    param($Field,$Value)
    $facts=$script:InertGpgEnvironment.Clone();$facts[$Field]=$Value
    Get-GpgPrivateEvidenceAdmission $facts $true|Should -BeNullOrEmpty
  }
  It 'omits evidence outside Windows and returns exact public context on admission' {
    Get-GpgPrivateEvidenceAdmission $script:InertGpgEnvironment $false|Should -BeNullOrEmpty
    $admission=Get-GpgPrivateEvidenceAdmission $script:InertGpgEnvironment $true
    @($admission.context.Keys|Sort-Object)|Should -Be @('alg','attempt','enc','fingerprint','jobRole','run','scope','source','version')
    $admission.context.run|Should -Be 1;$admission.context.attempt|Should -Be 1
    $admission.context.scope|Should -BeExactly 'wsl-real-gpg-import';$admission.context.jobRole|Should -BeExactly 'windows-native'
  }
  It 'roundtrips SDK dummy bytes and rejects modified <Part>' -TestCases @(@{Part=-1},@{Part=0},@{Part=1},@{Part=2},@{Part=3},@{Part=4}) {
    param($Part)
    Initialize-GpgPrivateEvidenceSdk
    $testKey=[Security.Cryptography.RSA]::Create(3072)
    try {
      $der=$testKey.ExportSubjectPublicKeyInfo();$public=[Convert]::ToBase64String($der);$fingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($der)).ToLowerInvariant()
      $context=[Text.Encoding]::UTF8.GetBytes('{"version":1,"scope":"inert"}')
      $parts=[OwnedGpgEvidenceV1]::Seal($public,$fingerprint,'inert-error',$context)
      [OwnedGpgEvidenceV1]::OpenInert($testKey,$parts)|Should -BeExactly 'inert-error'
      if($Part -ge 0){$parts[$Part][0]=$parts[$Part][0] -bxor 1;{[OwnedGpgEvidenceV1]::OpenInert($testKey,$parts)}|Should -Throw}
      else {
        $otherKey=[Security.Cryptography.RSA]::Create(3072)
        try {{[OwnedGpgEvidenceV1]::OpenInert($otherKey,$parts)}|Should -Throw}finally{$otherKey.Dispose()}
      }
    } finally {$testKey.Dispose()}
  }
  It 'rejects empty/oversize/mismatched input and wrong RSA size' {
    Initialize-GpgPrivateEvidenceSdk
    $testKey=[Security.Cryptography.RSA]::Create(3072);$smallKey=[Security.Cryptography.RSA]::Create(2048)
    try {
      $der=$testKey.ExportSubjectPublicKeyInfo();$public=[Convert]::ToBase64String($der);$fingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($der)).ToLowerInvariant();$aad=[Text.Encoding]::UTF8.GetBytes('{}')
      {[OwnedGpgEvidenceV1]::Seal($public,$fingerprint,'',$aad)}|Should -Throw
      {[OwnedGpgEvidenceV1]::Seal($public,$fingerprint,('x'*1048577),$aad)}|Should -Throw
      {[OwnedGpgEvidenceV1]::Seal($public,('0'*64),'inert',$aad)}|Should -Throw
      $smallDer=$smallKey.ExportSubjectPublicKeyInfo();$smallPublic=[Convert]::ToBase64String($smallDer);$smallFingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($smallDer)).ToLowerInvariant()
      {[OwnedGpgEvidenceV1]::Seal($smallPublic,$smallFingerprint,'inert',$aad)}|Should -Throw
      $trailing=[byte[]]::new($der.Length+1);[Array]::Copy($der,$trailing,$der.Length);$trailingPublic=[Convert]::ToBase64String($trailing);$trailingFingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($trailing)).ToLowerInvariant()
      {[OwnedGpgEvidenceV1]::Seal($trailingPublic,$trailingFingerprint,'inert',$aad)}|Should -Throw
    } finally {$testKey.Dispose();$smallKey.Dispose()}
  }
  It 'publishes only a complete five-file set and refuses collisions' {
    Initialize-GpgPrivateEvidenceSdk
    $root=Join-Path $TestDrive 'inert-seal';New-Item -ItemType Directory -Path $root|Out-Null
    $parts=[byte[][]]@([byte[]]@(1),[byte[]]@(2),[byte[]]::new(384),[byte[]]::new(12),[byte[]]::new(16))
    [OwnedGpgEvidenceV1]::Publish($root,$parts)
    @(Get-ChildItem -LiteralPath (Join-Path $root 'ready') -File|ForEach-Object {$_.Name}|Sort-Object)|Should -Be @('context.json','key.rsa-oaep-sha256.bin','nonce.bin','stderr.aesgcm.bin','tag.bin')
    Test-Path -LiteralPath (Join-Path $root 'pending')|Should -BeFalse
    {[OwnedGpgEvidenceV1]::Publish($root,$parts)}|Should -Throw
    $bad=Join-Path $TestDrive 'inert-incomplete';New-Item -ItemType Directory -Path $bad|Out-Null
    {[OwnedGpgEvidenceV1]::Publish($bad,([byte[][]]@([byte[]]@(1))))}|Should -Throw
    Test-Path -LiteralPath (Join-Path $bad 'ready')|Should -BeFalse
  }
  It 'runs the actual failing wrapper while optional sink <Fault> preserves the original fixed failure' -TestCases @(@{Fault='encrypt'},@{Fault='wrap'},@{Fault='write'}) {
    param($Fault)
    $testsSource=Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.Tests.ps1" -Raw
    $start=$testsSource.IndexOf('function Invoke-PinnedMetadataCommand(',[StringComparison]::Ordinal)
    $end=$testsSource.IndexOf("`n      Invoke-PinnedMetadataCommand 'gpg-import'",$start,[StringComparison]::Ordinal)
    if($start -lt 0 -or $end -le $start){throw 'Actual private-evidence caller unavailable.'}
    $root=Join-Path $TestDrive ('inert-wrapper-'+$Fault);New-Item -ItemType Directory -Path $root|Out-Null
    $gpg='inert-gpg';$expectedInput=Join-Path $root 'key.asc'
    $savedMetadata=$script:OwnedWslSignedMetadata;$savedReal=$script:GpgPrivateEvidenceRealContext
    try {
      $script:GpgPrivateEvidenceRealContext=$true;$script:OwnedWslSignedMetadata=[ordered]@{commandExit=2}
      function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments) {
        [IO.File]::WriteAllText((Join-Path $root 'command-inert.private.json'),([ordered]@{stdout='';stderr="gpg: can't open '"+$expectedInput+"': Permission denied";exitCode=2}|ConvertTo-Json -Compress));throw 'Inert existing refusal.'
      }
      function Save-GpgPrivateEvidence([string]$Stderr) {throw ('Inert '+$Fault+' refusal.')}
      $caught=$null
      try {& ([scriptblock]::Create($testsSource.Substring($start,$end-$start)+"`nInvoke-PinnedMetadataCommand 'gpg-import' @('--import',`$expectedInput) `$expectedInput"))}catch{$caught=$_}
      $caught.Exception.Message|Should -BeExactly 'Pinned GPG gpg-import refused; commandReceiptPresent=true; commandExit=2; stdoutPresent=False; stderrPresent=True; category=input-open-read; errno=permission-denied; expectedInputMatched=True'
      @(Get-ChildItem -LiteralPath $root -File).Count|Should -Be 1
    } finally {$script:OwnedWslSignedMetadata=$savedMetadata;$script:GpgPrivateEvidenceRealContext=$savedReal}
  }
  It 'keeps inert/success calls outside the operational sink and latches omission' {
    $savedReal=$script:GpgPrivateEvidenceRealContext;$savedAttempted=$script:GpgPrivateEvidenceAttempted
    try {
      $script:GpgPrivateEvidenceRealContext=$false;$script:GpgPrivateEvidenceAttempted=$false
      Save-GpgPrivateEvidence 'inert'|Should -BeExactly 'omitted'
      $script:GpgPrivateEvidenceAttempted|Should -BeFalse
      $script:GpgPrivateEvidenceRealContext=$true;$script:GpgPrivateEvidenceAttempted=$true
      Save-GpgPrivateEvidence 'inert'|Should -BeExactly 'omitted'
    } finally {$script:GpgPrivateEvidenceRealContext=$savedReal;$script:GpgPrivateEvidenceAttempted=$savedAttempted}
  }
}


Describe 'Owned WSL2 complete private evidence sink (inert)' {
  It 'executes actual environment admission, SDK seal and owned atomic publish' {
    Initialize-GpgPrivateEvidenceSdk
    $testKey=[Security.Cryptography.RSA]::Create(3072)
    $names=@('RUNNER_TEMP','CI','GITHUB_ACTIONS','GITHUB_EVENT_NAME','GITHUB_JOB','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','BIBCODE_GPG_EVIDENCE_SELECTED','BIBCODE_GPG_EVIDENCE_ROOT_READY','BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI','BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256')
    $saved=@{};foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name)}
    $savedReal=$script:GpgPrivateEvidenceRealContext;$savedAttempted=$script:GpgPrivateEvidenceAttempted
    try {
      $temp=Join-Path $TestDrive 'inert-actual-sink';New-Item -ItemType Directory -Path $temp|Out-Null
      $root=Join-Path $temp 'bibcode-gpg-private-evidence';New-Item -ItemType Directory -Path $root|Out-Null;Set-OwnerAcl $root
      $der=$testKey.ExportSubjectPublicKeyInfo()
      $facts=@{RUNNER_TEMP=$temp;CI='true';GITHUB_ACTIONS='true';GITHUB_EVENT_NAME='workflow_dispatch';GITHUB_JOB='windows_wsl_upgrade_smoke';GITHUB_SHA=('1'*40);GITHUB_RUN_ID='1';GITHUB_RUN_ATTEMPT='1';BIBCODE_GPG_EVIDENCE_SELECTED='true';BIBCODE_GPG_EVIDENCE_ROOT_READY='true';BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI=[Convert]::ToBase64String($der);BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($der)).ToLowerInvariant()}
      foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$facts[$name])}
      $script:GpgPrivateEvidenceRealContext=$true;$script:GpgPrivateEvidenceAttempted=$false
      Save-GpgPrivateEvidence 'inert-error'|Should -BeExactly 'completed'
      $ready=Join-Path $root 'ready';$parts=[byte[][]]::new(5);$filenames=@('context.json','stderr.aesgcm.bin','key.rsa-oaep-sha256.bin','nonce.bin','tag.bin')
      for($index=0;$index -lt 5;$index++){$parts[$index]=[IO.File]::ReadAllBytes((Join-Path $ready $filenames[$index]))}
      [OwnedGpgEvidenceV1]::OpenInert($testKey,$parts)|Should -BeExactly 'inert-error'
      $context=[Text.Encoding]::UTF8.GetString($parts[0])|ConvertFrom-Json
      @($context.PSObject.Properties.Name|Sort-Object)|Should -Be @('alg','attempt','enc','fingerprint','jobRole','run','scope','source','version')
      $context.source|Should -BeExactly ('1'*40);$context.run|Should -Be 1;$context.attempt|Should -Be 1;$context.jobRole|Should -BeExactly 'windows-native'
      Save-GpgPrivateEvidence 'inert-retry'|Should -BeExactly 'omitted'
      @(Get-ChildItem -LiteralPath $ready -File).Count|Should -Be 5
      Assert-OwnerAcl $root
    } finally {
      foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$saved[$name])}
      $script:GpgPrivateEvidenceRealContext=$savedReal;$script:GpgPrivateEvidenceAttempted=$savedAttempted;$testKey.Dispose()
    }
  }
  It 'omits an actual SDK refusal without output or a publishable set' {
    $savedReal=$script:GpgPrivateEvidenceRealContext;$savedAttempted=$script:GpgPrivateEvidenceAttempted
    $admission=[pscustomobject]@{publicSpki='AAAA';context=[ordered]@{fingerprint=('0'*64)}}
    Mock Get-GpgPrivateEvidenceAdmission {$admission}
    Mock Get-PhysicalPin {@{identity='inert';path='inert'}}
    Mock Assert-OwnerAcl {}
    Mock Assert-PhysicalPin {}
    try {
      $script:GpgPrivateEvidenceRealContext=$true;$script:GpgPrivateEvidenceAttempted=$false
      $output=@(Save-GpgPrivateEvidence 'inert-private-error')
      $output|Should -Be @('omitted')
      $script:GpgPrivateEvidenceAttempted|Should -BeTrue
    } finally {$script:GpgPrivateEvidenceRealContext=$savedReal;$script:GpgPrivateEvidenceAttempted=$savedAttempted}
  }
  It 'runs the actual workflow reservation body before Pester with inert temp ownership' {
    $source=(Get-Content -LiteralPath "$PSScriptRoot/../.github/workflows/desktop-upgrade-smoke.yml" -Raw).Replace("`r`n","`n")
    $begin=$source.IndexOf('      - id: gpg_private_root',[StringComparison]::Ordinal)
    $finish=$source.IndexOf('      - id: native_wsl',$begin,[StringComparison]::Ordinal)
    if($begin -lt 0 -or $finish -le $begin){throw 'Actual private reservation unavailable.'}
    $block=$source.Substring($begin,$finish-$begin);$run=$block.IndexOf("        run: |`n",[StringComparison]::Ordinal)
    if($run -lt 0){throw 'Actual private reservation body unavailable.'}
    $body=($block.Substring($run+15) -split "`n"|ForEach-Object {if($_.StartsWith('          ')){ $_.Substring(10) }elseif($_.Trim().Length -gt 0){throw 'Reservation source indentation refused.'}}) -join "`n"
    $savedTemp=$env:RUNNER_TEMP;$savedOutput=$env:GITHUB_OUTPUT
    try {
      $temp=Join-Path $TestDrive 'inert-reservation';New-Item -ItemType Directory -Path $temp|Out-Null
      $output=Join-Path $TestDrive 'inert-reservation-output';[IO.File]::WriteAllText($output,'')
      $env:RUNNER_TEMP=$temp;$env:GITHUB_OUTPUT=$output
      & ([scriptblock]::Create($body))
      [IO.File]::ReadAllText($output).Trim()|Should -BeExactly 'ready=true'
      $root=Join-Path $temp 'bibcode-gpg-private-evidence';Assert-OwnerAcl $root
      [IO.File]::WriteAllText($output,'');& ([scriptblock]::Create($body))
      [IO.File]::ReadAllText($output).Trim()|Should -BeExactly 'ready=false'
      @(Get-ChildItem -LiteralPath $root -Force).Count|Should -Be 0
    } finally {$env:RUNNER_TEMP=$savedTemp;$env:GITHUB_OUTPUT=$savedOutput}
  }
}


Describe 'Owned WSL2 inactive operational evidence capability (inert)' {
  It 'preserves the actual failed wrapper with valid-looking public-key environment and inactive capability' {
    $testsSource=Get-Content -LiteralPath "$PSScriptRoot/owned-wsl2-fixture.Tests.ps1" -Raw
    $start=$testsSource.IndexOf('function Invoke-PinnedMetadataCommand(',[StringComparison]::Ordinal)
    $end=$testsSource.IndexOf("`n      Invoke-PinnedMetadataCommand 'gpg-import'",$start,[StringComparison]::Ordinal)
    if($start -lt 0 -or $end -le $start){throw 'Actual inactive-capability caller unavailable.'}
    $testKey=[Security.Cryptography.RSA]::Create(3072)
    $names=@('RUNNER_TEMP','CI','GITHUB_ACTIONS','GITHUB_EVENT_NAME','GITHUB_JOB','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','BIBCODE_GPG_EVIDENCE_SELECTED','BIBCODE_GPG_EVIDENCE_ROOT_READY','BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI','BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256')
    $saved=@{};foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name)}
    $savedReal=$script:GpgPrivateEvidenceRealContext;$savedAttempted=$script:GpgPrivateEvidenceAttempted;$savedMetadata=$script:OwnedWslSignedMetadata
    try {
      $root=Join-Path $TestDrive 'inert-inactive-wrapper';New-Item -ItemType Directory -Path $root|Out-Null
      $gpg='inert-gpg';$expectedInput=Join-Path $root 'key.asc';$der=$testKey.ExportSubjectPublicKeyInfo()
      $facts=@{RUNNER_TEMP=$root;CI='true';GITHUB_ACTIONS='true';GITHUB_EVENT_NAME='workflow_dispatch';GITHUB_JOB='windows_wsl_upgrade_smoke';GITHUB_SHA=('1'*40);GITHUB_RUN_ID='1';GITHUB_RUN_ATTEMPT='1';BIBCODE_GPG_EVIDENCE_SELECTED='true';BIBCODE_GPG_EVIDENCE_ROOT_READY='true';BIBCODE_GPG_EVIDENCE_PUBLIC_SPKI=[Convert]::ToBase64String($der);BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($der)).ToLowerInvariant()}
      foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$facts[$name])}
      $script:GpgPrivateEvidenceRealContext=$false;$script:GpgPrivateEvidenceAttempted=$false;$script:OwnedWslSignedMetadata=[ordered]@{commandExit=2}
      (Get-GpgPrivateEvidenceAdmission $facts $true).context.fingerprint|Should -BeExactly $facts.BIBCODE_GPG_EVIDENCE_PUBLIC_SHA256
      function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments) {
        [IO.File]::WriteAllText((Join-Path $root 'command-inert.private.json'),([ordered]@{stdout='';stderr="gpg: can't open '"+$expectedInput+"': Permission denied";exitCode=2}|ConvertTo-Json -Compress));throw 'Inert existing refusal.'
      }
      $caught=$null
      try {& ([scriptblock]::Create($testsSource.Substring($start,$end-$start)+"`nInvoke-PinnedMetadataCommand 'gpg-import' @('--import',`$expectedInput) `$expectedInput"))}catch{$caught=$_}
      $caught.Exception.Message|Should -BeExactly 'Pinned GPG gpg-import refused; commandReceiptPresent=true; commandExit=2; stdoutPresent=False; stderrPresent=True; category=input-open-read; errno=permission-denied; expectedInputMatched=True'
      $script:GpgPrivateEvidenceAttempted|Should -BeFalse
      Test-Path -LiteralPath (Join-Path $root 'bibcode-gpg-private-evidence')|Should -BeFalse
      @(Get-ChildItem -LiteralPath $root -File).Count|Should -Be 1
    } finally {
      foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$saved[$name])}
      $script:GpgPrivateEvidenceRealContext=$savedReal;$script:GpgPrivateEvidenceAttempted=$savedAttempted;$script:OwnedWslSignedMetadata=$savedMetadata;$testKey.Dispose()
    }
  }
}
