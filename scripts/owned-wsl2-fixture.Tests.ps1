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
