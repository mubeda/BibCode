# Server installer validation

Use this runbook for server-only ZIP, tar, MSI, PKG, DEB, and RPM artifacts.
Installing packages, creating services/accounts, and purging data are host
mutations: use only a disposable native runner with explicit authority.

## Evidence classes

- **Native** means the artifact executed on the same OS and architecture named
  by its manifest tuple.
- **Compatibility** means static format, contract, or cross-target inspection.
  It cannot establish install, service, ACL, rollback, or process behavior.
- **Unavailable** means the required native runner/capability did not exist.
  Do not convert it into a pass or silently cross-build it.

Use a fresh absolute work root and record results in
[the execution report template](./execution-report-template.md). Do not put
machine paths, credentials, package logs, or run-specific screenshots into
this living runbook.

## Required release matrix

| Runner              | Architecture | Formats executed      |
| ------------------- | ------------ | --------------------- |
| Windows             | x64          | MSI, ZIP              |
| Windows             | ARM64        | MSI, ZIP              |
| macOS Intel         | x64          | tar.gz                |
| macOS Apple Silicon | ARM64        | tar.gz, universal PKG |
| Linux               | x64          | DEB, RPM, tar.gz      |
| Linux               | ARM64        | DEB, RPM, tar.gz      |

The reusable `.github/workflows/server-native-smoke.yml` owns this matrix. Its
evidence artifacts are named with the source SHA and target triple. Stable
publication is gated by the complete manifest/signature/SBOM aggregation; a
partial matrix is never described as a complete release.

## Local contract preflight

```sh
vp test run \
  scripts/server-install-smoke.test.ts \
  scripts/create-server-install-smoke-set.test.ts \
  scripts/server-packaging-contract.test.ts \
  scripts/ci-platform-contract.test.ts \
  scripts/privacy-contract.test.ts \
  scripts/legacy-cloud-removal-contract.test.ts
cargo test -p bibcode-server --test package_lifecycle -- --nocapture
cargo test -p bibcode-server --test service_lifecycle -- --nocapture
cargo test -p bibcode-server --test no_unexpected_outbound -- --nocapture
cargo test -p bibcode-server --test packaged_server_smoke -- --nocapture
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

These commands prove shared behavior and the host-compatible packaged runtime.
They do not replace the native matrix.

## Build and verify the release set

Build only on a matching native host and into a directory that does not exist:

```sh
node scripts/build-server-artifact.ts \
  --target <native-rust-target> \
  --formats native,portable \
  --output-dir <fresh-absolute-output> \
  --unsigned-test
```

For signed release evidence, use the release workflow. It finalizes artifact
bytes first, creates a CycloneDX 1.7 SBOM for each artifact, signs every
artifact/SBOM/checksum inventory/manifest with the dedicated server Minisign
key, verifies native signing policy, and emits `artifacts.json`. The smoke
workflow creates an ephemeral unsigned manifest from the same candidate bytes
for pre-publication execution; this does not weaken the signed release set.

Before execution inspect package structure:

- Windows: use pinned `lessmsi` 2.12.9, list the `File`, `Directory`, and
  `CustomAction` tables, extract to a fresh directory, and require exactly one
  `bibcode.exe` and `server-layout.json` in the allowlisted layout.
- macOS: use `pkgutil --expand-full`, require exactly one universal executable,
  inspect both slices with `lipo -archs`, and run
  `codesign --verify --strict --verbose=4`.
- Linux: run `dpkg-deb --contents`, extract its control scripts with
  `dpkg-deb --control`, and run `rpm -qpl --scripts`.
- Portable: reject links, devices, extra executables, source maps, development
  paths, databases, logs, secrets, and runtime dependencies outside the exact
  server layout.

## Run the bounded harness

After manifest/signature/hash verification and before any mutation, invoke:

```sh
node scripts/server-install-smoke.ts \
  --manifest <absolute-artifact-root>/artifacts.json \
  --artifact-root <absolute-artifact-root> \
  --os <windows|macos|linux> \
  --architecture <x86_64|aarch64|universal> \
  --format <zip|tar.gz|msi|pkg|deb|rpm> \
  --work-root <fresh-absolute-empty-root> \
  --stage-timeout-ms 1800000 \
  --command-timeout-ms 180000 \
  --allow-system-mutation
```

Use `--allow-unsigned-test` only for an ephemeral `unsigned-test` manifest. A
stage timeout aborts the active child command, waits for bounded settlement,
and starts cleanup under a fresh cancellation scope. The harness rejects a
relative, symlinked, nonempty, equivalent, or nested work/artifact root and
refuses a pre-existing package binary, service definition, data root, or
headless account that it could mistake for test-owned state.

## Required scenarios

Every evidence file has exactly these twelve results:

1. clean workstation installation;
2. one idempotent service definition and numeric-loopback listener;
3. five-minute, single-use DPoP pairing and authenticated RPC/WebSocket;
4. same-origin browser UI with Node absent from runtime `PATH`;
5. restart preserves environment and storage identities;
6. update creates a verified backup and preserves identity/data;
7. failed update rolls back safely or refuses unsafe old-byte restart;
8. uninstall removes package-owned bytes/registration and preserves data;
9. reinstall adopts the preserved identities;
10. typed purge removes only the verified root and preserves a sibling canary;
11. headless mode uses the exact dedicated identity, owner, and ACL; and
12. all test-owned processes, service registrations, accounts, and temporary
    children are stopped or reaped.

Portable formats classify headless-account/ACL evidence as unavailable because
headless setup begins only after a host-authorized service install. The other
portable lifecycle results remain compatibility evidence where they do not
exercise a native package manager.

## Privacy and failure evidence

Run service startup, UI load, pairing, RPC, restart, diagnostics, package
failure, uninstall, and purge with a deny-by-default proxy/network observer.
Only an explicitly initiated update/download endpoint may be allowlisted.
Expected unexpected-internet-request count is zero. BiBCode emits no telemetry
or crash upload.

Seed token, user, email, and path canaries. They must not appear in public
errors, `evidence.json`, package metadata, SBOMs, process arguments, or server
logs. Evidence stores only stable result codes, public hashes, tuple metadata,
native-signing/notarization state, and native/compatibility/unavailable class.

On any failure, run cleanup and re-inventory the exact package, service/task,
dedicated account, loopback listeners, processes, work root, data root, and
sibling canary. Preserve recovery artifacts and logs only in the private
execution report. Never delete a broad path or pre-existing account to make a
runner appear clean.

Platform-specific package inspection remains in
[Windows](./windows-desktop.md), [macOS](./macos-desktop.md), and
[Linux](./linux-desktop.md). Connection-after-install validation is in
[Remote environment validation](./remote-environments.md).
