# Windows Server Package

`BiBCode.Server.wixproj` is a pinned WiX 7 SDK project for the host-native x64
or ARM64 MSI. The build script copies these templates to a temporary directory,
generates `ServerFiles.wxs` from the verified staged payload, and accepts exactly
one MSI output.

The MSI is per-user. It installs under
`%LOCALAPPDATA%\Programs\BiBCode Server`, owns one user `PATH` entry for `bin`,
and invokes the installed `bibcode.exe` package/service operations for the
installing SID. The Rust service adapter remains the only Task Scheduler
definition owner. A major upgrade prepares through the old binary before MSI
replaces files, activates through the new binary, and uses MSI byte rollback
plus the receipt-bound old-binary rollback action on failure. Install, upgrade,
rollback, and uninstall actions receive no pairing value, token, project path,
or other secret. Service uninstall preserves the server data root; the MSI has
no purge action.

Safe upgrade requires the installed package to expose the package lifecycle
CLI. An older MSI without it fails before `RemoveExistingProducts`; use a
preserve-data uninstall followed by a clean install and verify the adopted
environment/storage identities.

Build only on the matching native Windows architecture:

```powershell
vp run dist:server:artifact -- --target x86_64-pc-windows-msvc --formats native,portable --output-dir release/server-local --unsigned-test
```

Use `aarch64-pc-windows-msvc` on a native Windows ARM64 runner. Inspect the MSI
with WiX tooling or `lessmsi` before execution and compare its paths and custom
actions with these templates. Verify prepare precedes removal, activation
follows file commit, rollback is sequenced in reverse, and uninstall runs only
for actual removal—not major upgrade. `unsigned-test` is local evidence only. Stable
release publication later requires verified Authenticode signatures on both
`bibcode.exe` and the MSI; this project contains no signing secret.

If MSI restores old bytes after the new binary advanced the schema, the old
rollback command refuses startup and removes the workstation registration.
Recovery must first reinstall the same MSI (and therefore the same bound
transaction nonce) before any newer upgrade; the data root and verified backup
remain untouched.
