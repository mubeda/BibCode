[CmdletBinding()]
param(
  [ValidateSet('Prepare','Build','Verify','VerifyOwner','AppAttempted','AppJoined','Terminate','Unregister','Restored','Delete')][string]$Action,
  [string]$OwnerManifest,
  [string]$SourceSha,
  [string]$Checkout,
  [string]$ExpectedVersion,
  [scriptblock]$PrepareRefusalObserver
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RootfsName = 'ubuntu-24.04.5-wsl-amd64.wsl'
$RootfsHash = 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
$SigningFingerprint = '843938DF228D22F7B3742BC0D94AA3F0EFE21092'
$ReleaseBase = 'https://releases.ubuntu.com/noble/'
function Refuse-OwnedWsl { throw 'Owned WSL2 fixture refused.' }
function Assert-FixtureRuntime {
  if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:BIBCODE_NATIVE_WSL_FIXTURE_SELECTED -ne 'true' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64' -or -not [OperatingSystem]::IsWindows() -or -not [Environment]::Is64BitProcess -or $SourceSha -cnotmatch '^[a-f0-9]{40}$' -or $SourceSha -cne $env:GITHUB_SHA) { Refuse-OwnedWsl }
  if ([IO.Path]::GetFullPath($OwnerManifest) -cne (Join-Path $env:RUNNER_TEMP 'bibcode-owned-wsl2-owner/owner.secret.json')) { Refuse-OwnedWsl }
}
function Initialize-PhysicalReader {
  if ('OwnedWslPhysical' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OwnedWslPhysical {
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 public static string Read(string path,bool directory) {
  using(var h=CreateFile(path,0,7,IntPtr.Zero,3,directory?0x02000000u:0u,IntPtr.Zero)) {
   if(h.IsInvalid) { int error=Marshal.GetLastWin32Error();throw OwnedWslPrepareFailure.Native("CreateFile",error,null); }
   Info i;if(!GetFileInformationByHandle(h,out i)) { int error=Marshal.GetLastWin32Error();throw OwnedWslPrepareFailure.Native("GetFileInformationByHandle",error,null); }
   if(!directory&&i.Links!=1)throw OwnedWslPrepareFailure.Native("SingleLinkPolicy",null,i.Links);
   return i.Volume.ToString("X8")+":"+i.IndexHigh.ToString("X8")+i.IndexLow.ToString("X8");
  }
 }
}

public sealed class OwnedWslPrepareFailure {
 public readonly string InputPath, AncestorPath, NativeBranch;
 public readonly bool? IsDirectory;
 public readonly uint? LeafAttributes, AncestorAttributes, NativeLinkCount;
 public readonly int? NativeWin32Error;
 public OwnedWslPrepareFailure(string input,string ancestor,bool? directory,uint? leaf,uint? parent,string branch,int? error,uint? links) { InputPath=input;AncestorPath=ancestor;IsDirectory=directory;LeafAttributes=leaf;AncestorAttributes=parent;NativeBranch=branch;NativeWin32Error=error;NativeLinkCount=links; }
 public static bool Trusted(Exception error) {
  Type t=error.GetType();return t==typeof(Exception)||t==typeof(InvalidOperationException)||t==typeof(ArgumentException)||t==typeof(ArgumentNullException)||t==typeof(ArgumentOutOfRangeException)||t==typeof(System.IO.IOException)||t==typeof(System.IO.FileNotFoundException)||t==typeof(System.IO.DirectoryNotFoundException)||t==typeof(UnauthorizedAccessException)||t==typeof(System.ComponentModel.Win32Exception)||t==typeof(System.Management.Automation.RuntimeException)||t==typeof(System.Management.Automation.MethodInvocationException)||t==typeof(System.Management.Automation.ActionPreferenceStopException)||t==typeof(System.Management.Automation.ParameterBindingException);
 }
 static readonly Type StockData=typeof(Exception).Assembly.GetType("System.Collections.ListDictionaryInternal");
 const string Slot="BiBCode.OwnedPrepareFailure";
 public static OwnedWslPrepareFailure Context(Exception error) {
  if(!Trusted(error))return null;System.Collections.IDictionary data=error.Data;
  if(data==null||data.GetType()!=StockData)return null;
  object value=data[Slot];return value!=null&&value.GetType()==typeof(OwnedWslPrepareFailure)?(OwnedWslPrepareFailure)value:null;
 }
 public static void Attach(Exception error,string input,string ancestor,bool? directory,uint? leaf,uint? parent) {
  if(error==null||!Trusted(error))return;
  OwnedWslPrepareFailure original=null;Exception current=error;System.Collections.Generic.HashSet<Exception> seen=new System.Collections.Generic.HashSet<Exception>(System.Collections.Generic.ReferenceEqualityComparer.Instance);
  for(int i=0;i<4&&current!=null;i++){if(!Trusted(current)||!seen.Add(current))return;OwnedWslPrepareFailure part=Context(current);if(part!=null){original=part;break;}current=current.InnerException;}
  System.Collections.IDictionary data=error.Data;if(data==null||data.GetType()!=StockData)return;
  if(Context(error)!=null&&Context(error).InputPath!=null)return;
  data[Slot]=new OwnedWslPrepareFailure(input,ancestor,directory,leaf,parent,original==null?null:original.NativeBranch,original==null?null:original.NativeWin32Error,original==null?null:original.NativeLinkCount);
 }
 public static Exception Native(string branch,int? error,uint? links) {
  InvalidOperationException refusal=new InvalidOperationException("Owned physical identity refused.");
  refusal.Data[Slot]=new OwnedWslPrepareFailure(null,null,null,null,null,branch,error,links);return refusal;
 }
}
public sealed class OwnedWslPrepareExceptionEntry {
 public readonly string type,message,clrStack;public readonly int hResult;
 public OwnedWslPrepareExceptionEntry(Exception error) {type=error.GetType().FullName;message=error.Message;hResult=error.HResult;clrStack=error.StackTrace;}
}
public sealed class OwnedWslPreparePayload {
 public readonly int payloadVersion=1;
 public readonly OwnedWslPrepareExceptionEntry[] exceptionChain;
 public readonly string scriptStack,pinInputPath,pinAncestorPath,nativeBranch;
 public readonly int? scriptLineNumber,nativeWin32Error;
 public readonly bool? pinIsDirectory;
 public readonly uint? pinLeafAttributes,pinAncestorAttributes,nativeLinkCount;
 public OwnedWslPreparePayload(OwnedWslPrepareExceptionEntry[] chain,string stack,int? line,OwnedWslPrepareFailure pin) {exceptionChain=(OwnedWslPrepareExceptionEntry[])chain.Clone();scriptStack=stack;scriptLineNumber=line;pinInputPath=pin==null?null:pin.InputPath;pinAncestorPath=pin==null?null:pin.AncestorPath;pinIsDirectory=pin==null?null:pin.IsDirectory;pinLeafAttributes=pin==null?null:pin.LeafAttributes;pinAncestorAttributes=pin==null?null:pin.AncestorAttributes;nativeBranch=pin==null?null:pin.NativeBranch;nativeWin32Error=pin==null?null:pin.NativeWin32Error;nativeLinkCount=pin==null?null:pin.NativeLinkCount;}
}
public static class OwnedWslPrepareProjection {
 static readonly System.Text.UTF8Encoding Utf8=new System.Text.UTF8Encoding(false,true);
 static bool Bound(string text,int limit,ref int total){if(text==null)return true;if(text.Length>limit)return false;total+=Utf8.GetByteCount(text);return total<=262144;}
 public static string Serialize(object value) {
  try {
   if(value==null)return null;Type t=value.GetType();Type recordType=typeof(System.Management.Automation.ErrorRecord);Type generic=recordType.Assembly.GetType("System.Management.Automation.ErrorRecord`1");
   if(t!=recordType&&!(t.Assembly==recordType.Assembly&&t.IsGenericType&&generic!=null&&t.GetGenericTypeDefinition()==generic))return null;
   System.Management.Automation.ErrorRecord record=(System.Management.Automation.ErrorRecord)value;
   Exception error=record.Exception;if(error==null)return null;
   System.Collections.Generic.List<OwnedWslPrepareExceptionEntry> entries=new System.Collections.Generic.List<OwnedWslPrepareExceptionEntry>();
   System.Collections.Generic.HashSet<Exception> seen=new System.Collections.Generic.HashSet<Exception>(System.Collections.Generic.ReferenceEqualityComparer.Instance);
   OwnedWslPrepareFailure pin=null;int bytes=0;
   while(error!=null){if(entries.Count==4||!OwnedWslPrepareFailure.Trusted(error)||!seen.Add(error))return null;
    OwnedWslPrepareExceptionEntry entry=new OwnedWslPrepareExceptionEntry(error);
    if(entry.type==null||entry.message==null||!Bound(entry.type,512,ref bytes)||!Bound(entry.message,16384,ref bytes)||!Bound(entry.clrStack,65536,ref bytes))return null;
    entries.Add(entry);if(pin==null)pin=OwnedWslPrepareFailure.Context(error);error=error.InnerException;
   }
   System.Management.Automation.InvocationInfo invocation=record.InvocationInfo;
   if(invocation!=null&&invocation.GetType()!=typeof(System.Management.Automation.InvocationInfo))return null;
   string stack=record.ScriptStackTrace;int? line=invocation==null?(int?)null:invocation.ScriptLineNumber;
   if((line!=null&&line<0)||!Bound(stack,65536,ref bytes)||!Bound(pin==null?null:pin.InputPath,32768,ref bytes)||!Bound(pin==null?null:pin.AncestorPath,32768,ref bytes))return null;
   if(pin!=null&&pin.NativeBranch!=null&&pin.NativeBranch!="CreateFile"&&pin.NativeBranch!="GetFileInformationByHandle"&&pin.NativeBranch!="SingleLinkPolicy")return null;
   OwnedWslPreparePayload payload=new OwnedWslPreparePayload(entries.ToArray(),stack,line,pin);
   return System.Text.Json.JsonSerializer.Serialize(payload,new System.Text.Json.JsonSerializerOptions{IncludeFields=true,MaxDepth=4});
  } catch {return null;}
 }
}
'@ | Out-Null
}
function Get-PhysicalPin([string]$Path) {
  $leafAttributes=$null;$ancestorAttributes=$null;$ancestorPath=$null;$directory=$null
  try {
    $item = Get-Item -LiteralPath $Path -Force
    $leafAttributes=[uint32]$item.Attributes
    if (($leafAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse-OwnedWsl }
    $fullName=$item.FullName
    if ($fullName -ine [IO.Path]::GetFullPath($Path)) { Refuse-OwnedWsl }
    $directory=[bool]$item.PSIsContainer
    $parent = if ($directory) { $item.Parent } else { $item.Directory }
    $nextAncestorPath=[IO.Path]::GetDirectoryName($fullName)
    while ($null -ne $parent) {
      $attributes=[uint32]$parent.Attributes
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $ancestorAttributes=$attributes;$ancestorPath=$nextAncestorPath
        Refuse-OwnedWsl
      }
      $parent = $parent.Parent
      $nextAncestorPath=[IO.Path]::GetDirectoryName($nextAncestorPath)
    }
    Initialize-PhysicalReader
    return [ordered]@{path=$fullName;identity=[OwnedWslPhysical]::Read($fullName,$directory);directory=$directory}
  } catch {
    $pinFailure=$_
    try { if('OwnedWslPrepareFailure' -as [type]){[OwnedWslPrepareFailure]::Attach($pinFailure.Exception,$Path,$ancestorPath,$directory,$leafAttributes,$ancestorAttributes)} } catch { }
    throw
  }
}
function Assert-PhysicalPin($Pin) {
  $now = Get-PhysicalPin $Pin.path
  if ($now.identity -cne $Pin.identity -or $now.directory -ne $Pin.directory) { Refuse-OwnedWsl }
}
function Set-OwnerAcl([string]$Path) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) {
    $acl.RemoveAccessRuleAll($rule)
  }
  $inherit = if ((Get-Item -LiteralPath $Path).PSIsContainer) { 'ContainerInherit,ObjectInherit' } else { 'None' }
  foreach ($sid in @($me,$system)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-OwnerAcl([string]$Path) {
  $acl=Get-Acl -LiteralPath $Path; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $me -or @($acl.Access).Count -ne 2) { Refuse-OwnedWsl }
  $sids=@();foreach($rule in $acl.Access) { $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { Refuse-OwnedWsl };$sids+=$sid }
  if (@($sids | Sort-Object -Unique).Count -ne 2 -or $me -notin $sids -or 'S-1-5-18' -notin $sids) { Refuse-OwnedWsl }
}
# Git/usr/bin/gpg.exe uses MSYS POSIX absolute-home semantics.
# Convert only its CLI argument; filesystem ownership and pins stay native.
function Get-PinnedGitGpgHomeArgument([string]$NativeHome) {
  try {
    $native=$NativeHome.Replace('/','\')
    if ($native -cnotmatch '\A[A-Za-z]:\\' -or [IO.Path]::GetFullPath($native) -cne $native) { Refuse-OwnedWsl }
    return '/'+$native.Substring(0,1).ToLowerInvariant()+$native.Substring(2).Replace('\','/')
  } catch { Refuse-OwnedWsl }
}
function Invoke-FixtureCommand([string]$Exe,[string[]]$Arguments,[int]$Timeout=60000) {
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Exe;$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.CreateNoWindow=$true
  foreach($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  $child=[Diagnostics.Process]::new();$child.StartInfo=$info
  try {
    if(-not $child.Start()) { Refuse-OwnedWsl }
    $out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit($Timeout)) { $child.Kill($true);if(-not $child.WaitForExit(15000)) { Refuse-OwnedWsl };Refuse-OwnedWsl }
    $stdout=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult()
    if($Action -eq 'Prepare' -and $script:OwnedWslPrepareStage -ceq 'signed-metadata' -and $script:OwnedWslSignedMetadata.operation -cin @('gpg-import','fingerprint-admission','signature-admission')) { $code=$child.ExitCode;if($code -ge 0 -and $code -le 255){$script:OwnedWslSignedMetadata.commandExit=[int]$code} }
    if($stdout.Length -gt 2097152 -or $stderr.Length -gt 2097152) { Refuse-OwnedWsl }
    $log=Join-Path ([IO.Path]::GetDirectoryName($OwnerManifest)) ('command-'+[guid]::NewGuid().ToString('N')+'.private.json')
    [IO.File]::WriteAllText($log,(@{stdout=$stdout;stderr=$stderr;exitCode=$child.ExitCode}|ConvertTo-Json -Compress));Set-OwnerAcl $log
    if($child.ExitCode -ne 0) { Refuse-OwnedWsl }
    return $stdout.Replace([string][char]0,'').Trim()
  } finally { $child.Dispose() }
}
function Get-FixtureInventory {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if(-not (Test-Path -LiteralPath $key)) { return [ordered]@{defaultGuid=$null;distros=@()} }
  $properties=Get-ItemProperty -LiteralPath $key
  $default=$properties.PSObject.Properties['DefaultDistribution'];$value=if($null -eq $default -or -not $default.Value -or $default.Value -eq '{00000000-0000-0000-0000-000000000000}') {$null}else{[string]$default.Value}
  $distros=@(Get-ChildItem -LiteralPath $key | ForEach-Object {$entry=Get-ItemProperty -LiteralPath $_.PSPath;[ordered]@{guid=$_.PSChildName;name=[string]$entry.DistributionName;basePath=[string]$entry.BasePath;version=[int]$entry.Version}})
  return [ordered]@{defaultGuid=$value;distros=$distros}
}
function Save-FixtureManifest($Manifest) {
  $json=$Manifest|ConvertTo-Json -Depth 16 -Compress
  [IO.File]::WriteAllText($OwnerManifest,$json)
  Set-OwnerAcl $OwnerManifest
}
function Read-FixtureManifest {
  Assert-FixtureRuntime;Assert-OwnerAcl $OwnerManifest
  $m=Get-Content -LiteralPath $OwnerManifest -Raw|ConvertFrom-Json -AsHashtable
  if($m.schema -ne 1 -or $m.sourceSha -cne $SourceSha -or $m.name -cnotmatch '^BibCodeQA-[a-f0-9]{32}$' -or $m.imageSha256 -cne $RootfsHash -or $m.before.distros.Count -ne 0 -or $null -ne $m.before.defaultGuid -or $m.appState -notin @('none','attempted','joined')) { Refuse-OwnedWsl }
  Assert-PhysicalPin $m.root;Assert-OwnerAcl $m.root.path;Assert-PhysicalPin $m.manifestPin;Assert-PhysicalPin $m.wsl.pin;Assert-PhysicalPin $m.imagePin;Assert-PhysicalPin $m.gpg.pin;Assert-PhysicalPin $m.checkout
  if(Test-Path -LiteralPath $m.importRoot.path) {Assert-PhysicalPin $m.importRoot} elseif($m.phase -ne 'unregistered') {Refuse-OwnedWsl}
  if((Get-FileHash -LiteralPath $m.imagePin.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RootfsHash -or (Get-FileHash -LiteralPath $m.gpg.pin.path -Algorithm SHA256).Hash -cne $m.gpg.sha256) {Refuse-OwnedWsl}
  if((Get-FileHash -LiteralPath $m.wsl.pin.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.wsl.sha256) { Refuse-OwnedWsl }
  return $m
}
function Assert-OwnedRegistration($Manifest,[bool]$AllowAbsent=$false) {
  $inventory=Get-FixtureInventory
  if($inventory.distros.Count -eq 0 -and $null -eq $inventory.defaultGuid -and $AllowAbsent) {return $null}
  if($inventory.distros.Count -ne 1) { Refuse-OwnedWsl };$owned=$inventory.distros[0]
  if($owned.name -cne $Manifest.name -or $owned.version -ne 2 -or ($null -ne $Manifest.guid -and $owned.guid -cne $Manifest.guid) -or ($null -ne $inventory.defaultGuid -and $inventory.defaultGuid -cne $owned.guid)) { Refuse-OwnedWsl }
  $base=Get-PhysicalPin $owned.basePath
  if($base.identity -cne $Manifest.importRoot.identity) { Refuse-OwnedWsl }
  return $owned
}
function Prepare-Fixture {
  $script:OwnedWslPrepareStage='runtime-admission'
  Assert-FixtureRuntime
  $script:OwnedWslPrepareStage='private-root-acl'
  $root=[IO.Path]::GetDirectoryName($OwnerManifest)
  if(Test-Path -LiteralPath $root) { Refuse-OwnedWsl };[IO.Directory]::CreateDirectory($root)|Out-Null;Set-OwnerAcl $root
  $script:OwnedWslPrepareStage='launcher-admission'
  $wsl=Join-Path $env:SystemRoot 'System32/wsl.exe';$certificate=Get-AuthenticodeSignature -LiteralPath $wsl
  if($certificate.Status -ne 'Valid' -or $certificate.SignerCertificate.Subject -notmatch 'Microsoft') { Refuse-OwnedWsl }
  $script:OwnedWslPrepareStage='empty-inventory'
  $before=Get-FixtureInventory
  if($before.distros.Count -ne 0 -or $null -ne $before.defaultGuid) { Refuse-OwnedWsl }
  $script:OwnedWslPrepareStage='launcher-readiness'
  Invoke-FixtureCommand $wsl @('--status')|Out-Null;Invoke-FixtureCommand $wsl @('--list','--quiet')|Out-Null
  $script:OwnedWslPrepareStage='verifier-admission'
  $gpg=Join-Path $env:ProgramFiles 'Git/usr/bin/gpg.exe';$gpgPin=Get-PhysicalPin $gpg;$gpgHash=(Get-FileHash -LiteralPath $gpg -Algorithm SHA256).Hash
  $gnupg=Join-Path $root 'gnupg';[IO.Directory]::CreateDirectory($gnupg)|Out-Null;Set-OwnerAcl $gnupg
  $gpgHomeArgument=Get-PinnedGitGpgHomeArgument $gnupg
  $key=Join-Path $root 'canonical.key';$sums=Join-Path $root 'SHA256SUMS';$signature=Join-Path $root 'SHA256SUMS.gpg';$image=Join-Path $root $RootfsName
  $script:OwnedWslPrepareStage='signed-metadata'
  $script:OwnedWslSignedMetadata=[ordered]@{item=$null;operation=$null;httpStatus=$null;commandExit=$null;sizeMatched=$null;fingerprintCount=$null;fingerprintMatched=$null;signatureCount=$null;signerMatched=$null;checksumCount=$null;checksumMatched=$null}
  foreach($download in @(@(('https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x'+$SigningFingerprint),$key),@(($ReleaseBase+'SHA256SUMS'),$sums),@(($ReleaseBase+'SHA256SUMS.gpg'),$signature))) {
    $script:OwnedWslSignedMetadata.item=if($download[1] -ceq $key){'key'}elseif($download[1] -ceq $sums){'checksums'}else{'signature'}
    $script:OwnedWslSignedMetadata.operation='get';$script:OwnedWslSignedMetadata.httpStatus=$null
    $response=Invoke-WebRequest -Uri $download[0] -OutFile $download[1] -TimeoutSec 120 -MaximumRedirection 0 -PassThru
    $script:OwnedWslSignedMetadata.httpStatus=[int]$response.StatusCode
    $script:OwnedWslSignedMetadata.operation='file-acl';Set-OwnerAcl $download[1]
  }
  $script:OwnedWslSignedMetadata.item=$null;$script:OwnedWslSignedMetadata.operation='size-admission'
  $oversize=(Get-Item -LiteralPath $key).Length -gt 1048576 -or (Get-Item -LiteralPath $sums).Length -gt 2097152 -or (Get-Item -LiteralPath $signature).Length -gt 65536
  $script:OwnedWslSignedMetadata.sizeMatched=-not $oversize
  if($oversize) {Refuse-OwnedWsl}
  $script:OwnedWslSignedMetadata.item='key';$script:OwnedWslSignedMetadata.operation='gpg-import';$script:OwnedWslSignedMetadata.commandExit=$null
  Invoke-FixtureCommand $gpg @('--homedir',$gpgHomeArgument,'--batch','--no-autostart','--import',$key)|Out-Null
  $script:OwnedWslSignedMetadata.operation='fingerprint-admission';$script:OwnedWslSignedMetadata.commandExit=$null
  $fingerprints=Invoke-FixtureCommand $gpg @('--homedir',$gpgHomeArgument,'--batch','--no-autostart','--with-colons','--fingerprint',$SigningFingerprint)
  $fingerprintCount=@($fingerprints -split "`n"|Where-Object {$_ -match '^fpr:' -and ($_ -split ':')[9] -ceq $SigningFingerprint}).Count
  $script:OwnedWslSignedMetadata.fingerprintCount=[Math]::Min(2,$fingerprintCount);$script:OwnedWslSignedMetadata.fingerprintMatched=$fingerprintCount -eq 1
  if($fingerprintCount -ne 1) { Refuse-OwnedWsl }
  $script:OwnedWslSignedMetadata.item='signature';$script:OwnedWslSignedMetadata.operation='signature-admission';$script:OwnedWslSignedMetadata.commandExit=$null
  $verification=Invoke-FixtureCommand $gpg @('--homedir',$gpgHomeArgument,'--batch','--no-autostart','--status-fd','1','--verify',$signature,$sums)
  $valid=@($verification -split "`n"|Where-Object {$_ -match '^\[GNUPG:\] VALIDSIG '})
  $script:OwnedWslSignedMetadata.signatureCount=[Math]::Min(2,$valid.Count)
  $signerMatched=$valid.Count -eq 1 -and ($valid[0] -split ' ')[2] -ceq $SigningFingerprint
  $script:OwnedWslSignedMetadata.signerMatched=$signerMatched
  if(-not $signerMatched) { Refuse-OwnedWsl }
  $script:OwnedWslSignedMetadata.item='checksums';$script:OwnedWslSignedMetadata.operation='checksum-admission'
  $line=@(Get-Content -LiteralPath $sums|Where-Object {$_ -cmatch ('^[a-f0-9]{64} [ *]'+[regex]::Escape($RootfsName)+'$')})
  $script:OwnedWslSignedMetadata.checksumCount=[Math]::Min(2,$line.Count)
  $checksumMatched=$line.Count -eq 1 -and $line[0].Substring(0,64) -ceq $RootfsHash
  $script:OwnedWslSignedMetadata.checksumMatched=$checksumMatched
  if(-not $checksumMatched) { Refuse-OwnedWsl }
  $script:OwnedWslPrepareStage='image-admission'
  Invoke-WebRequest -Uri ($ReleaseBase+$RootfsName) -OutFile $image -TimeoutSec 300 -MaximumRedirection 0;Set-OwnerAcl $image
  if((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RootfsHash) { Refuse-OwnedWsl };Assert-PhysicalPin $gpgPin
  if((Get-FileHash -LiteralPath $gpg -Algorithm SHA256).Hash -cne $gpgHash) { Refuse-OwnedWsl }
  $script:OwnedWslPrepareStage='intent-write'
  $import=Join-Path $root 'distro'
  [IO.Directory]::CreateDirectory($import)|Out-Null
  Set-OwnerAcl $import
  $m=[ordered]@{
    schema=1;sourceSha=$SourceSha;name='BibCodeQA-'+[guid]::NewGuid().ToString('N')
    root=Get-PhysicalPin $root
    importRoot=Get-PhysicalPin $import
    wsl=@{
      pin=Get-PhysicalPin $wsl
      sha256=(Get-FileHash -LiteralPath $wsl -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    before=$before;imageSha256=$RootfsHash
    imagePin=Get-PhysicalPin $image
    gpg=@{pin=$gpgPin;sha256=$gpgHash}
    checkout=Get-PhysicalPin $env:GITHUB_WORKSPACE
    manifestPin=$null;mappedCheckout=$null;backend=$null;guid=$null;phase='intent';appState='none';kernelVerified=$false
  }
  Save-FixtureManifest $m
  $m.manifestPin=Get-PhysicalPin $OwnerManifest
  Save-FixtureManifest $m
  $script:OwnedWslPrepareStage='owned-import'
  $again=Get-FixtureInventory;if($again.distros.Count -ne 0 -or $null -ne $again.defaultGuid) {Refuse-OwnedWsl}
  $m.phase='import-attempted';Save-FixtureManifest $m
  Invoke-FixtureCommand $wsl @('--import',$m.name,$import,$image,'--version','2') 300000|Out-Null
  $owned=Assert-OwnedRegistration $m;$m.guid=$owned.guid;$m.phase='registered';Save-FixtureManifest $m
  $script:OwnedWslPrepareStage='kernel-admission'
  $kernel=Invoke-FixtureCommand $wsl @('--distribution',$m.name,'--exec','uname','-r')
  $architecture=Invoke-FixtureCommand $wsl @('--distribution',$m.name,'--exec','uname','-m')
  $os=Invoke-FixtureCommand $wsl @('--distribution',$m.name,'--exec','cat','/etc/os-release')
  if($kernel -cnotmatch '^[A-Za-z0-9.+-]*microsoft-standard-WSL2$' -or $architecture -cne 'x86_64' -or $os -notmatch '(?m)^ID=ubuntu\r?$' -or $os -notmatch '(?m)^VERSION_ID="24\.04"\r?$') { Refuse-OwnedWsl }
  $script:OwnedWslPrepareStage='mapping-admission'
  $mapped=Invoke-FixtureCommand $wsl @('--distribution',$m.name,'--exec','wslpath','-a',$m.checkout.path)
  $canonical=Invoke-FixtureCommand $wsl @('--distribution',$m.name,'--exec','readlink','-e',$mapped)
  if(-not $mapped.StartsWith('/') -or $mapped -cne $canonical) {Refuse-OwnedWsl}
  Assert-PhysicalPin $m.checkout
  $m.mappedCheckout=$mapped;$m.kernelVerified=$true;$m.phase='kernel-verified';Save-FixtureManifest $m
}
function Invoke-OwnedFixtureAction([string]$Action) {
    if($Action -eq 'Prepare') { Prepare-Fixture } else {
      $m=Read-FixtureManifest
      switch($Action) {
        'Build' {
          Assert-OwnedRegistration $m|Out-Null
          if(-not $m.kernelVerified -or $m.appState -ne 'none' -or $ExpectedVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or -not [IO.Path]::GetFullPath($Checkout).StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {Refuse-OwnedWsl}
          $checkoutPin=Get-PhysicalPin $Checkout
          $cargo=Get-Content -LiteralPath (Join-Path $Checkout 'apps/server/Cargo.toml') -Raw
          if($cargo -notmatch ('(?m)^version\s*=\s*"'+[regex]::Escape($ExpectedVersion)+'"\s*$')) {Refuse-OwnedWsl}
          $mapped=Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec','wslpath','-a',$Checkout)
          if($mapped -match "['`r`n]" -or $mapped -cne (Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec','readlink','-e',$mapped))) {Refuse-OwnedWsl}
          Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec','bash','-lc','set -euo pipefail; apt-get update; apt-get install -y build-essential clang cmake curl pkg-config libssl-dev') 600000|Out-Null
          Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec','bash','-lc','set -euo pipefail; if ! command -v cargo >/dev/null; then curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.0; fi') 600000|Out-Null
          $build="set -euo pipefail; cd '$mapped'; export PATH=`"`$HOME/.cargo/bin:`$PATH`"; CARGO_TARGET_DIR='$mapped/target/native-owned-wsl2' cargo +1.98.0 build --locked -p bibcode-server --bin bibcode --release"
          Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec','bash','-lc',$build) 3600000|Out-Null
          $binary=Join-Path $Checkout 'target/native-owned-wsl2/release/bibcode';$binaryPin=Get-PhysicalPin $binary
          $version=Invoke-FixtureCommand $m.wsl.pin.path @('--distribution',$m.name,'--exec',($mapped+'/target/native-owned-wsl2/release/bibcode'),'--version')
          if($version -notmatch ([regex]::Escape($ExpectedVersion)+'$')) {Refuse-OwnedWsl}
          Assert-PhysicalPin $checkoutPin
          $m.backend=@{pin=$binaryPin;sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();version=$ExpectedVersion};Save-FixtureManifest $m
        }
        'Verify' { Assert-OwnedRegistration $m|Out-Null;if($null -ne $m.backend) {Assert-PhysicalPin $m.backend.pin;if((Get-FileHash -LiteralPath $m.backend.pin.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.backend.sha256) {Refuse-OwnedWsl}};if(-not $m.kernelVerified -or $m.phase -ne 'kernel-verified') {Refuse-OwnedWsl} }
        'VerifyOwner' {if($m.appState -eq 'attempted') {Refuse-OwnedWsl};Assert-OwnedRegistration $m $true|Out-Null}
        'AppAttempted' { Assert-OwnedRegistration $m|Out-Null;if(-not $m.kernelVerified) {Refuse-OwnedWsl};$m.appState='attempted';Save-FixtureManifest $m }
        'AppJoined' { Assert-OwnedRegistration $m|Out-Null;if($m.appState -ne 'attempted') {Refuse-OwnedWsl};$m.appState='joined';Save-FixtureManifest $m }
        'Terminate' { if($m.appState -eq 'attempted') {Refuse-OwnedWsl};$owned=Assert-OwnedRegistration $m $true;if($null -ne $owned) {Invoke-FixtureCommand $m.wsl.pin.path @('--terminate',$m.name)|Out-Null} }
        'Unregister' { if($m.appState -eq 'attempted') {Refuse-OwnedWsl};$owned=Assert-OwnedRegistration $m $true;if($null -ne $owned) {Invoke-FixtureCommand $m.wsl.pin.path @('--unregister',$m.name)|Out-Null};$m.phase='unregistered';Save-FixtureManifest $m }
        'Restored' { $inventory=Get-FixtureInventory;if($inventory.distros.Count -ne 0 -or $null -ne $inventory.defaultGuid) {Refuse-OwnedWsl} }
        'Delete' { $inventory=Get-FixtureInventory;if($inventory.distros.Count -ne 0 -or $null -ne $inventory.defaultGuid -or $m.appState -eq 'attempted') {Refuse-OwnedWsl};Get-ChildItem -LiteralPath $m.root.path -Force -Recurse|ForEach-Object {if(($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {Refuse-OwnedWsl}};Assert-PhysicalPin $m.root;Remove-Item -LiteralPath $m.root.path -Recurse -Force }
      }
    }
}
if($MyInvocation.InvocationName -ne '.') {
  try { Invoke-OwnedFixtureAction $Action; Write-Output '{"completed":true}';exit 0 } catch {
    $originalFailure=$_
    if($Action -eq 'Prepare' -and $null -ne $PrepareRefusalObserver) {
      try { & $PrepareRefusalObserver $originalFailure *> $null } catch { }
    }
    if($Action -eq 'Prepare') {
      $receipt=[ordered]@{completed=$false;prepareStage=$script:OwnedWslPrepareStage}
      if($script:OwnedWslPrepareStage -ceq 'signed-metadata') {
        try { if($script:OwnedWslSignedMetadata.operation -ceq 'get' -and $null -ne $originalFailure.Exception.Response) { $code=[int]$originalFailure.Exception.Response.StatusCode;if($code -ge 100 -and $code -le 599){$script:OwnedWslSignedMetadata.httpStatus=$code} } } catch { }
        $receipt.signedMetadata=[ordered]@{};foreach($name in $script:OwnedWslSignedMetadata.Keys){$receipt.signedMetadata[$name]=$script:OwnedWslSignedMetadata[$name]}
      }
      $receipt|ConvertTo-Json -Depth 4 -Compress|Write-Output
    }
    else { Write-Output '{"completed":false}' }
    exit 1
  }
}
