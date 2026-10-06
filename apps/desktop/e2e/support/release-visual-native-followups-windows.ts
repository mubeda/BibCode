// @effect-diagnostics nodeBuiltinImport:off - Real private ACL admission for the disposable Windows seeded fixture only.
import * as NodePath from "node:path";
import type { NativeFollowupCommandOwner } from "./release-visual-native-followups-process.ts";
export function nativeFollowupWindowsAclScript(root: string) {
  if (
    !NodePath.win32.isAbsolute(root) ||
    !/^[A-Za-z]:\\/.test(root) ||
    root.startsWith("\\\\") ||
    root.includes("\0") ||
    /^[A-Za-z]:\\$/.test(root) ||
    /\\(?:Windows|Program Files|Program Files \(x86\))(?:\\|$)/i.test(root)
  )
    throw new Error("Native follow-up Windows ACL root refused.");
  const path = root.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $system=New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'; $pending=New-Object System.Collections.Generic.Queue[string]; $pending.Enqueue('${path}'); $count=0; while($pending.Count -gt 0){ $p=$pending.Dequeue(); $item=Get-Item -LiteralPath $p -Force; if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Private ACL alias refused'}; $count++; if($count -gt 4096){throw 'Private ACL inventory bound'}; $acl=Get-Acl -LiteralPath $p; $oldOwner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if(@($me.Value,'S-1-5-18','S-1-5-32-544') -notcontains $oldOwner){throw 'Private ACL owner refused'}; $acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleAll($r)}; $inherit=if($item.PSIsContainer){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None}; foreach($sid in @($me,$system)){ $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl; $check=Get-Acl -LiteralPath $p; if(-not $check.AreAccessRulesProtected -or $check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me.Value){throw 'Private ACL protection refused'}; foreach($r in @($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){if($r.AccessControlType -ne 'Allow' -or @($me.Value,$system.Value) -notcontains $r.IdentityReference.Value){throw 'Private ACL boundary refused'}}; if($item.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $p -Force)){$pending.Enqueue($child.FullName)}} }; @{privateBoundary=$true; entryCount=$count}|ConvertTo-Json -Compress`;
}
export async function secureNativeFollowupWindowsRoot(
  owner: NativeFollowupCommandOwner,
  powershell: string,
  root: string,
) {
  const value: unknown = JSON.parse(
    (
      await owner.command(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        nativeFollowupWindowsAclScript(root),
      ])
    ).toString("utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "entryCount,privateBoundary" ||
    !("privateBoundary" in value) ||
    value.privateBoundary !== true ||
    !("entryCount" in value) ||
    !Number.isInteger(value.entryCount) ||
    Number(value.entryCount) < 1 ||
    Number(value.entryCount) > 4096
  )
    throw new Error("Native follow-up Windows ACL evidence refused.");
  return { privateBoundary: true, entryCount: Number(value.entryCount) };
}
