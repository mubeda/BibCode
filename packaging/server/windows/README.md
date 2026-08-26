# Windows Server Package

`BiBCode.Server.wixproj` is a pinned WiX 7 SDK project for the host-native x64
or ARM64 MSI. The build script copies these templates to a temporary directory,
generates `ServerFiles.wxs` from the verified staged payload, and accepts exactly
one MSI output.

The MSI is per-user. It installs under
`%LOCALAPPDATA%\Programs\BiBCode Server`, owns one user `PATH` entry for `bin`,
and invokes the installed `bibcode.exe service` operations for the installing
SID. The Rust service adapter remains the only Task Scheduler definition owner.
Install, upgrade, rollback, and uninstall actions receive no pairing value,
token, project path, or other secret. Service uninstall preserves the server
data root.

Build only on the matching native Windows architecture:

```powershell
vp run dist:server:artifact -- --target x86_64-pc-windows-msvc --formats native,portable --output-dir release/server-local --unsigned-test
```

Use `aarch64-pc-windows-msvc` on a native Windows ARM64 runner. Inspect the MSI
with WiX tooling or `lessmsi` before execution and compare its paths and custom
actions with these templates. `unsigned-test` is local evidence only. Stable
release publication later requires verified Authenticode signatures on both
`bibcode.exe` and the MSI; this project contains no signing secret.
