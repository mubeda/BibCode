# WSL And SSH Discovery, Provisioning, And Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present every running WSL distribution as an environment, retain accepted stopped distributions without starting them, and provide consent-based Linux, macOS, and Windows OpenSSH enrollment that can securely install, pair, and tunnel BiBCode Server.

**Architecture:** The Tauri desktop remains the host authority. A generation-fenced WSL discovery service emits typed snapshots and reconciles platform bindings by proved server identity. WSL servers listen only on distro loopback and are reached through a desktop-owned loopback-to-`wsl.exe` byte forwarder. SSH enrollment is a staged state machine—trust, probe, consent, artifact transfer, atomic install, service start, tunnel, descriptor verification, pairing—implemented by constant OS-specific command adapters rather than client-authored scripts.

**Tech Stack:** Rust 2024, Tokio process/I/O supervision, Tauri 2 commands/events, Windows `wsl.exe`, OpenSSH client tools, PowerShell, POSIX utilities, TypeScript 7, Effect 4, Effect Schema, IndexedDB platform bindings, release artifact manifest from Plan 70.

**Spec:** [Connection, security, and lifecycle specification](./03-connection-security-and-lifecycle.spec.md) and [distribution specification](./05-distribution-docs-and-verification.spec.md)

## Global Constraints

- A WSL distro name or SSH target is a locator, never environment identity. Only a verified descriptor UUID binds it to a known environment.
- Every Running WSL distro is visible by default. Previously accepted Stopped distros remain visible; unaccepted stopped distros appear only in Add Environment.
- BiBCode never starts a stopped WSL distro automatically and never invokes `wsl --unregister`.
- WSL enumeration is triggered by startup/focus/manual refresh/lifecycle events plus low-frequency bounded reconciliation; the renderer does not poll every three seconds.
- WSL server HTTP/WS listens on WSL loopback. No WSL wildcard plaintext exception survives Plan 30.
- A missing WSL server produces `Setup required`; installation requires explicit consent and does not change the distro's default/user/system settings silently.
- SSH host-key changes block. Unknown keys follow native OpenSSH confirmation policy; BiBCode never inserts `StrictHostKeyChecking=no` or edits known_hosts behind the user.
- Descriptor, storage identity, protocol, and transport trust are verified before a one-time pairing credential is consumed.
- Provisioning never requires the remote host to access the internet; the desktop downloads and verifies bytes, then transfers them.
- No arbitrary client-provided remote script is executed. OS adapters own fixed commands and pass user data only as validated argv/stdin values.
- Every owned `wsl.exe`, `ssh`, `scp`/SFTP, and forwarding child has cancellation, output bounds, timeout, and terminate/reap ownership.
- Current worktree path routing, WSL folder picking, Git discovery, adoption, removal plans, and process cleanup remain intact.

---

## File Structure

- Modify: `packages/contracts/src/ipc.ts`, `ipc.test.ts` — WSL discovery, SSH probe/provision, progress, and cancellation contracts.
- Create: `packages/contracts/src/serverArtifact.ts`, `serverArtifact.test.ts` — installer manifest selection schema shared with Plan 70.
- Create: `apps/desktop/src-tauri/src/wsl.rs` — bounded discovery and structured WSL commands.
- Create: `apps/desktop/src-tauri/src/wsl_transport.rs` — Windows-loopback to WSL-loopback forwarding.
- Modify: `apps/desktop/src-tauri/src/backend.rs`, `bridge.rs`, `lib.rs` — multi-distro reconciliation and bridge ownership.
- Modify: `apps/desktop/src-tauri/src/ssh.rs` — staged SSH manager and owned process cleanup.
- Create: `apps/desktop/src-tauri/src/remote_host/mod.rs`, `model.rs`, `linux.rs`, `macos.rs`, `windows.rs` — structured probe/install/service adapters.
- Modify: `apps/desktop/src-tauri/permissions/desktop-bridge.toml` — exact new commands/events.
- Modify: `apps/web/src/tauriDesktopBridge.ts`, tests — bridge decoding and event subscription.
- Modify: `apps/web/src/connection/platform.ts`, tests — descriptor-first enrollment and route persistence.
- Modify: `apps/web/src/connection/useDesktopLocalBootstraps.ts` — event/focus refresh instead of constant polling.
- Modify: `apps/web/src/state/desktopWslState.ts`, tests — generation-fenced discovery state.
- Test: `apps/desktop/src-tauri/tests/bridge_public_contract.rs`, `ssh_public_contract.rs`.

### Task 1: Define complete WSL discovery and staged provisioning contracts

**Files:**

- Modify: `packages/contracts/src/ipc.ts`, `ipc.test.ts`
- Create: `packages/contracts/src/serverArtifact.ts`, `serverArtifact.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [x] **Step 1: Write failing schema fixtures**

Cover Running/Stopped, default marker, WSL1/WSL2, partial valid rows, discovery unavailable/timeout/permission error, stale generations, SSH Linux/macOS/Windows probes, install consent, progress, cancellation, and manifest mismatch.

- [x] **Step 2: Replace the incomplete WSL row**

```ts
export const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  state: Schema.Literals(["running", "stopped"]),
  version: Schema.Literals([1, 2]),
});

export const DesktopWslDiscoverySchema = Schema.Struct({
  generation: Schema.Number,
  observedAt: Schema.String,
  health: Schema.Literals(["available", "disabled", "missing", "timedOut", "failed"]),
  detail: Schema.NullOr(Schema.String),
  distros: Schema.Array(DesktopWslDistroSchema),
});
```

Keep the last good snapshot separate from current discovery health so a transient command failure cannot erase accepted rows.

- [x] **Step 3: Define a staged SSH/WSL setup model**

```ts
export const RemoteHostProbeSchema = Schema.Struct({
  os: Schema.Literals(["linux", "macos", "windows"]),
  architecture: Schema.Literals(["x86_64", "aarch64"]),
  installedVersion: Schema.NullOr(Schema.String),
  serviceMode: Schema.NullOr(Schema.Literals(["workstation", "headless"])),
  serviceState: Schema.Literals(["notInstalled", "stopped", "running", "failed"]),
  dataRoot: Schema.NullOr(Schema.String),
  controlAvailable: Schema.Boolean,
});
```

Add request IDs and stages `trust`, `probe`, `download`, `verify`, `transfer`, `install`, `start`, `tunnel`, `verifyIdentity`, `pair`; progress contains bounded counts, never credentials.

- [x] **Step 4: Define artifact selection without filename guessing**

```ts
export const ServerArtifactRecordSchema = Schema.Struct({
  product: Schema.Literal("bibcode-server"),
  version: Schema.String,
  os: Schema.Literals(["linux", "macos", "windows"]),
  architecture: Schema.Literals(["x86_64", "aarch64", "universal"]),
  format: Schema.Literals(["zip", "tar.gz", "msi", "pkg", "deb", "rpm"]),
  downloadName: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  signatureName: Schema.String,
});
```

Plan 40 consumes fixture/remote manifests. Plan 70 builds and publishes the authoritative manifest and runs end-to-end artifact resolution.

- [x] **Step 5: Run schema tests and commit**

```sh
vp test packages/contracts/src/ipc.test.ts packages/contracts/src/serverArtifact.test.ts
git add packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts packages/contracts/src/serverArtifact.ts packages/contracts/src/serverArtifact.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): model WSL discovery and remote provisioning"
```

Implementation note: the WSL row now carries explicit Running/Stopped state,
and discovery snapshots carry a monotonic generation, observation time, health,
bounded detail, and only validated distro rows. Remote setup contracts model
Linux/macOS/Windows probe results, the fixed trust-through-pair stage sequence,
request/generation-bound consent, secret-free byte progress, cancellation, and
partial cleanup state.

The new schema-only server artifact contract selects by signed-manifest
product/version/OS/architecture/format metadata rather than filenames. It
rejects unsafe file names, invalid SHA-256 values, zero-size records,
non-macOS universal artifacts, manifest/record drift, duplicate target records,
and target/record mismatches. Plan 70 remains the producer and authoritative
signature/download owner.

The initial tests failed on the absent schemas and overlong diagnostics. Green
validation passed 40 focused contract tests, 79 affected contract/web fixture tests, contracts
typecheck, `vp check` with only the recorded Plan 20 warning, and the complete
workspace typecheck graph with concurrency limited to one. Existing typed WSL
test fixtures now state Running or Stopped explicitly; no compatibility default
hides an incomplete native row.

### Task 2: Extract bounded asynchronous WSL discovery from the bridge

**Files:**

- Create: `apps/desktop/src-tauri/src/wsl.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`, `lib.rs`
- Test: `apps/desktop/src-tauri/src/wsl.rs`
- Test: `apps/desktop/src-tauri/tests/bridge_public_contract.rs`

- [x] **Step 1: Move current parser fixtures into failing state-aware tests**

```rust
assert_eq!(parse_wsl_verbose(utf16_fixture()).unwrap().distros, vec![
    WslDistro { name: "Ubuntu".into(), is_default: true, state: Running, version: 2 },
    WslDistro { name: "Debian".into(), is_default: false, state: Stopped, version: 2 },
]);
```

Add BOM/no-BOM UTF-16LE, UTF-8, localized whitespace, names with spaces, malformed row isolation, empty output, missing executable, disabled feature, nonzero exit, output cap, and timeout.

- [x] **Step 2: Implement an owned discovery service**

```rust
pub struct WslDiscoveryService {
    generation: AtomicU64,
    refresh_gate: Mutex<()>,
    last_good: RwLock<Option<WslDiscoverySnapshot>>,
    cancellation: CancellationToken,
}
```

Spawn `wsl.exe --list --verbose` with `CREATE_NO_WINDOW`, a 10-second deadline, a 1 MiB combined-output cap, and cancellation. A newer requested generation supersedes late output.

- [x] **Step 3: Emit one typed event**

Add `desktop:wsl-discovery-changed`; emit after startup discovery, application focus, explicit refresh, accepted-binding changes, and backend lifecycle changes. Coalesce concurrent refreshes.

- [x] **Step 4: Add low-frequency reconciliation**

While the desktop is active, reconcile no more frequently than once per minute, relax to five minutes after stable snapshots, and back off to fifteen minutes after repeated failures. Stop the timer when the app exits; this is a missed-event safety net, not UI polling.

- [x] **Step 5: Run native/parser tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop wsl:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop --test bridge_public_contract -- --nocapture
git add apps/desktop/src-tauri/src/wsl.rs apps/desktop/src-tauri/src/bridge.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/bridge_public_contract.rs
git commit -m "feat(desktop): discover all WSL distributions safely"
```

Implementation note: `WslDiscoveryService` is the native owner of monotonic
generations, coalesced refresh admission, current health, last-good rows, and
shutdown cancellation. Its `wsl.exe --list --verbose` child uses the existing
Windows `CREATE_NO_WINDOW` configuration, piped stdin/stdout/stderr, a
10-second deadline, a 1 MiB combined-output ceiling, kill-on-drop, and explicit
terminate/reap plus reader-task joins on timeout, cancellation, output overflow,
or wait failure. The state-aware parser accepts UTF-8 and UTF-16LE with or
without a BOM, Unicode whitespace and names containing spaces, while isolating
malformed rows.

The desktop emits only `desktop:wsl-discovery-changed`, with the schema-shaped
generation/health/detail/distro payload, after startup, focus, manual refresh,
accepted-distro changes, and backend lifecycle changes. Concurrent requests
publish only the latest generation. A cancelled reconciliation owner stops on
desktop exit; its missed-event schedule starts at one minute, relaxes to five
minutes after a stable available snapshot, and backs off to fifteen minutes
after repeated failures. A failed observation retains last-good distro rows
instead of erasing them.

The exact plan commands passed on macOS as parser/process compatibility tests:
9 focused WSL tests and 3 bridge public-contract tests. The complete desktop
suite passed 308 unit tests plus 7 public SSH/bridge integration tests, desktop
Clippy passed for all targets with warnings denied, and Rust formatting and
diff checks passed. Native Windows execution remains part of the Windows
runbook/CI evidence rather than being claimed from the macOS host.

### Task 3: Reconcile WSL platform bindings without locator identity

**Files:**

- Modify: `apps/desktop/src-tauri/src/backend.rs`, `bridge.rs`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/web/src/state/desktopWslState.ts`, tests
- Modify: `apps/web/src/connection/storage.ts`, tests
- Modify: `apps/web/src/wslPaths.ts`, `connection/desktopLocal.ts`, `connection/platform.ts`
- Modify: `apps/web/src/components/hostFolderPicker.ts`, Add Project and worktree-settings callers
- Modify: `apps/web/src/tauriDesktopBridge.ts`, provider-update locator helpers, and affected tests

- [x] **Step 1: Write failing reconciliation tables**

Cover new Running -> visible/setup required; new Stopped -> discovery only; accepted Stopped -> visible/stopped; Running with same descriptor after rename -> same environment; reused name with different UUID -> blocked identity conflict; missing snapshot -> retained unavailable; stale generation -> ignored; user Hide -> hidden but binding retained.

- [x] **Step 2: Persist a locator binding distinct from identity**

```ts
type WslPlatformBinding = {
  bindingId: string;
  distroName: string;
  acceptedEnvironmentId: EnvironmentId | null;
  acceptedStorageInstanceIds: readonly StorageInstanceId[];
  acceptedAt: string | null;
  lastDiscoveryGeneration: number;
};
```

The binding can exist before setup with `acceptedEnvironmentId = null`. A proved descriptor atomically attaches it to the catalog environment from Plan 20.

- [x] **Step 3: Replace one-selected-distro backend planning**

Plan one backend candidate per Running distro, not `wsl_backend_enabled + wsl_distro`. Keep legacy desktop settings only as a migration input that marks the prior distro accepted, then stop writing them.

- [x] **Step 4: Preserve worktree routing**

Replace `wsl:<name>` as public identity with a binding lookup. Folder picker, open-in-editor, terminal, Git, worktree discovery/adoption/removal, and process ownership resolve `environmentId -> binding -> distroName`. No Git/worktree record stores the mutable distro name as identity.

- [x] **Step 5: Run state/storage/backend tests and commit**

```sh
vp test apps/web/src/state/desktopWslState.test.ts apps/web/src/connection/storage.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop backend:: -- --nocapture
git add apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/bridge.rs packages/contracts/src/ipc.ts apps/web/src/state/desktopWslState.ts apps/web/src/state/desktopWslState.test.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(environments): reconcile WSL bindings by server identity"
```

Implementation note: the web now has one pure, generation-fenced WSL
reconciler covering every table above. Mutable distro locators live only in
`DesktopWslBinding`; a verified descriptor UUID plus an accepted storage UUID
can atomically prove a pre-setup binding into the Plan 20 catalog. IndexedDB
rejects proved-binding reassignment and stale WSL generations both for direct
binding writes and aggregate environment replacement.

Desktop startup awaits its first owned discovery snapshot before planning. It
plans one candidate for every Running distro, selects the Running default only
when WSL-only mode needs a primary, and uses random opaque runtime-slot IDs for
secondaries. Retired `wslBackendEnabled` and `wslDistro` fields remain read-only
migration inputs, are omitted from new settings writes, and are ignored by
backend planning. Their compatibility IPC setters now refresh state without
mutating selection. Folder and worktree pickers resolve a durable environment
to its current running-distro locator and pass that locator explicitly; the
native bridge validates it against authoritative Running discovery and never
starts a stopped distro. The old `wsl:<name>` parser is removed, and Git,
worktree, terminal, editor, and process records continue to be scoped by
durable environment identity rather than distro name. Task 9 remains the
planned owner of event-driven bridge subscription and feeding these bindings
into the live Plan 20 catalog; it does not change this identity boundary.

The exact focused commands passed on macOS: 80 state/storage tests, 93 backend
tests, 43 bridge tests, and a 322-test affected web/contracts batch. The full
desktop package passed 304 unit tests plus 7 bridge/SSH public-contract tests;
desktop Clippy passed for all targets with warnings denied, Rust formatting,
`vp check`, workspace typecheck, and diff checks passed. `vp check` retained one
pre-existing unused-test-fixture warning in `connection/storage.test.ts` and no
errors. Native Windows runtime behavior remains for the Windows runbook/CI
evidence rather than being claimed from this macOS host.

### Task 4: Replace WSL wildcard HTTP with a desktop-owned loopback forwarder

**Files:**

- Create: `apps/desktop/src-tauri/src/wsl_transport.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`, `lib.rs`
- Modify: `apps/server/src/config.rs`, `lib.rs`
- Test: `apps/desktop/src-tauri/src/wsl_transport.rs`
- Test: `apps/server/tests/cli_smoke.rs`, `network_admission.rs`

- [x] **Step 1: Add failing transport security/lifecycle tests**

Assert server argv uses `--host 127.0.0.1`, the Windows-facing listener binds only `127.0.0.1`/`::1`, byte streams preserve HTTP upgrade/WebSocket traffic, cancellation closes both halves, stalled copies time out only during setup, and all `wsl.exe` children are reaped.

- [x] **Step 2: Add a narrowly scoped internal forward command**

```text
bibcode transport stdio-forward --loopback-port <u16>
```

The command accepts no host, URL, path, or shell input. It connects only to `127.0.0.1:<port>`, copies stdin/stdout bidirectionally with bounded setup, and exits when either side closes.

- [x] **Step 3: Implement the Windows loopback proxy**

For each accepted Windows-loopback connection, spawn:

```text
wsl.exe --distribution <validated-name> --exec <verified-bibcode-path> transport stdio-forward --loopback-port <port>
```

Pipe the socket to child stdin/stdout, bound stderr, associate the process with the desktop job/reaper, and generation-fence publication of the proxy URL.

- [x] **Step 4: Remove insecure WSL admission exceptions**

Delete `WSL_BACKEND_BIND_HOST = "0.0.0.0"`, wildcard backend plans, and auth/service allowances keyed solely by `desktop_wsl_transport`. WSL ordinary traffic now arrives at the server on distro loopback and retains normal environment authentication.

- [x] **Step 5: Run transport/admission tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop wsl_transport -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test network_admission -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke transport -- --nocapture
git add apps/desktop/src-tauri/src/wsl_transport.rs apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/lib.rs apps/server/src/config.rs apps/server/src/lib.rs apps/server/tests/cli_smoke.rs apps/server/tests/network_admission.rs
git commit -m "fix(wsl): forward loopback traffic without wildcard HTTP"
```

Implementation note: every WSL backend now listens on its own distro-local
numeric loopback port, while a distinct desktop-owned numeric-loopback listener
is the only URL published to the Windows client. The listener is started before
the server, fenced by the backend generation, and retained through authenticated
soft shutdown. Cancellation stops admission, joins active forwards, and reaps
both the server and per-connection `wsl.exe` process trees under the existing
bounded restart policy.

The internal `bibcode transport stdio-forward --loopback-port <u16>` command
accepts no host, URL, path, or shell input, connects only to `127.0.0.1`, uses a
bounded setup deadline, and performs raw bidirectional copying without imposing
a timeout on an established stream. Desktop forwarding uses exact structured
`wsl.exe --distribution <name> --exec <binary> ...` arguments, a 64-connection
cap, bounded stderr, generation-fenced publication, and supervised child-tree
cleanup. Wildcard WSL binds and transport-name authentication exceptions were
removed; ordinary environment authentication remains mandatory.

Focused validation passed 5 desktop transport tests, 71 backend tests, 8 server
network-admission tests, and 2 CLI transport tests. The complete desktop package
passed 309 unit tests plus 7 bridge/SSH integration tests, and the complete
server library passed 1,655 tests with 2 ignored; all server integration targets
also passed. Desktop and server Clippy passed for all targets with warnings
denied, Rust formatting, `vp check`, workspace typecheck, and diff checks passed.
`vp check` retains one pre-existing unused-test-fixture warning. Native Windows
execution remains required by the Windows runbook; a macOS-hosted Windows cross
check could not compile because the Windows SDK headers are unavailable, so no
native Windows result is claimed here.

### Task 5: Add explicit WSL server setup and version reconciliation

**Files:**

- Create: `apps/desktop/src-tauri/src/server_artifacts.rs`, `wsl_setup.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`, `backend.rs`, `lib.rs`, `Cargo.toml`
- Modify: `apps/desktop/src-tauri/permissions/desktop-bridge.toml`
- Modify: `apps/server/src/lib.rs`
- Create: `packaging/server/server-release.pub`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: living remote/WSL architecture, user, and testing documentation
- Test: `apps/desktop/src-tauri/src/server_artifacts.rs`, `wsl_setup.rs`, `bridge.rs`, `backend.rs`

- [x] **Step 1: Write failing probe/install/cancel tests**

Cover absent binary, compatible binary, incompatible protocol, wrong architecture, checksum/signature failure, no `tar`, disk full, cancellation mid-transfer, failed atomic rename, previous version preservation, stopped distro, and concurrent setup requests.

- [x] **Step 2: Probe without starting stopped distros**

Only run commands for a distro in a fresh authoritative Running snapshot. Use structured `wsl.exe --distribution <name> --exec <program> <args...>` calls to read `uname -m`, locate the managed binary, and execute `bibcode storage inspect --json`/descriptor probe as available.

- [x] **Step 3: Present consent before mutation**

Return exact version, architecture, verified source, download size, install destination under the distro user's home, data location, process/service behavior, and required commands. The bridge executes setup only with the matching one-time consent/probe generation.

- [x] **Step 4: Transfer and install atomically**

Resolve the Linux portable artifact from the signed manifest, verify signature and SHA-256 on Windows, stream it with bounded memory to a distro temp file, verify SHA-256 again in WSL, extract into a versioned directory, then atomically switch the managed `current` link. Preserve the old version until descriptor verification succeeds.

- [x] **Step 5: Launch under current desktop ownership rules**

Start the server only for Running distros, on distro loopback, with the existing data-root/process-group/log/restart policies and the Plan 4 transport. A setup failure leaves the row visible with actionable recovery and never fabricates an online environment.

- [x] **Step 6: Run WSL setup tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop wsl_setup::tests:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop backend::tests::wsl -- --nocapture
git add Cargo.lock apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/permissions/desktop-bridge.toml apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/bridge.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/server_artifacts.rs apps/desktop/src-tauri/src/wsl_setup.rs apps/server/src/lib.rs packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts packaging/server/server-release.pub docs/architecture/overview.md docs/architecture/remote.md docs/architecture/runtime-process-model.md docs/reference/encyclopedia.md docs/testing/cross-platform-validation.md docs/testing/execution-report-template.md docs/testing/windows-desktop.md docs/user/remote-access.md docs/plans/2026-08-24-environment-project-management/40-wsl-ssh-provisioning.plan.md docs/plans/2026-08-24-environment-project-management/70-server-distribution-ci-docs.plan.md
git commit -m "feat(wsl): provision verified server runtimes with consent"
```

Implementation note: the native desktop now exposes audited prepare/install/
cancel bridge commands backed by one-use discovery/probe generations. Only an
authoritatively Running distro can be probed. Every WSL command is a structured
argument vector; setup never invokes a shell or starts a stopped distro.

The artifact owner verifies an exact signed-manifest tuple, dedicated checked-in
Minisign trust anchor (not the Tauri updater key), detached artifact signature, exact byte count, and
SHA-256 before bounded streaming. WSL verifies SHA-256 again, validates the
staged binary version, and atomically switches a per-user managed `current`
symlink while retaining the prior target. Backend planning prefers that managed
path and preserves `BIBCODE_WSL_SERVER_BINARY` plus cross-compiled development
fallbacks. Restart success requires a bounded numeric-loopback descriptor with
matching version, Linux architecture, protocol, environment UUID, and storage
UUID. An upgrade captures the current running descriptor before mutation and
requires those two identities to remain exact; a first install requires valid
new UUIDs. Failure or cancellation rolls back and reports mutation/cleanup state.
Shutdown cancels setup, and abnormal child exits abort and join every I/O task.

Validation passed 44 contract tests, 6 focused WSL setup tests, 4 artifact
trust tests, managed-path and development-fallback backend tests, the bounded
loopback descriptor test, 321 complete desktop unit tests, 3 bridge contract
tests, 4 SSH contract tests, desktop all-target Clippy with warnings denied,
Rust formatting, `vp check`, and the complete workspace typecheck graph.
`vp check` retains one pre-existing unused test-fixture warning. The initial
complete desktop rerun exhausted the host's 140 GiB target cache; a targeted
`cargo clean -p bibcode-desktop` removed 44.7 GiB of generated artifacts, and a
non-incremental clean rebuild then passed. Real WSL execution was not claimed on
this macOS host and remains required by the updated native Windows runbook.
The checked-in Plan 40 key is the dedicated pre-release fixture public key; its
private half was deleted. Plan 70 must provision the repository-environment
server signing secret and replace this public half before publishing any server
artifact.

### Task 6: Split SSH trust/probe/tunnel/descriptor/pairing stages

**Files:**

- Modify: `apps/desktop/src-tauri/src/ssh.rs`, `bridge.rs`
- Modify: `apps/web/src/connection/platform.ts`, tests
- Modify: `packages/contracts/src/ipc.ts`
- Test: `apps/desktop/src-tauri/tests/ssh_public_contract.rs`

- [x] **Step 1: Write a failing ordering test**

Record operations and require:

```text
sshTrust -> probe -> ensureServer -> openTunnel -> fetchDescriptor
-> verifyEnvironmentAndStorage -> createPairing -> redeemPairing -> persistRoute
```

Assert descriptor/storage/version/TLS failures never call pairing creation or redemption.

- [x] **Step 2: Replace `ensure_environment(issuePairingToken)` with staged methods**

```rust
pub async fn probe(&self, target: &SshEnvironmentTarget) -> Result<RemoteHostProbe, SshError>;
pub async fn ensure_tunnel(&self, target: &SshEnvironmentTarget, port: u16) -> Result<SshTunnel, SshError>;
pub async fn create_pairing(&self, target: &SshEnvironmentTarget) -> Result<SecretString, SshError>;
```

Remove `pairingToken` from `DesktopSshEnvironmentBootstrap`; a pairing credential is returned only from the explicit post-verification command and passed directly to secure redemption/storage.

- [x] **Step 3: Preserve native host-key policy**

Use the user's OpenSSH config and known_hosts resolution, never suppress host checking, surface changed/unknown-key results distinctly, and record only a non-secret host-key fingerprint after successful trust.

- [x] **Step 4: Update the client platform flow**

Delete the current `ensure -> pairing -> descriptor` ordering. Feed tunnel metadata into Plan 20 route verification, compare the descriptor to any accepted identities, then request/redeem pairing and immediately put resulting secret material in the OS secret provider.

- [x] **Step 5: Run SSH ordering and platform tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop --test ssh_public_contract -- --nocapture
vp test apps/web/src/connection/platform.test.ts
git add apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/src/bridge.rs apps/desktop/src-tauri/tests/ssh_public_contract.rs apps/web/src/connection/platform.ts apps/web/src/connection/platform.test.ts packages/contracts/src/ipc.ts
git commit -m "fix(ssh): verify remote identity before pairing"
```

Implementation note: SSH registration now has explicit trust, probe, managed
server launch, loopback tunnel, descriptor verification, pairing creation, and
credential redemption stages. OpenSSH host-key policy is enforced before any
password-capable work, saved routes re-pin the exact SHA-256 fingerprint, and
private BiBCode SSH variables cannot leak through the ambient environment or
`SendEnv`. Descriptor verification and one-time pairing redemption share one
non-reconnecting HTTP/1.1 connection through the original tunnel, followed by
an exact active-bootstrap check before credential creation. Disconnect also
validates the saved fingerprint before removing an active tunnel. Managed
remote launch currently supports Linux-like POSIX hosts and fails closed when
neither `ss` nor readable Linux procfs can prove a loopback port free; the
macOS and Windows adapters remain Task 7 work.

Validation passed 355 complete desktop unit tests, 5 SSH and 4 bridge public
contract tests, 172 focused TypeScript tests, the three server startup-pairing
and CLI checks, desktop all-target Clippy with warnings denied, Rust formatting,
`vp check`, and the complete workspace typecheck graph. `vp check` retains one
pre-existing unused test-fixture warning. Independent review found no remaining
Critical or Important issues and confirmed that no SSH pairing credential
crosses into JavaScript.

### Task 7: Add Linux, macOS, and Windows remote adapters and consent-based install

**Files:**

- Create: `apps/desktop/src-tauri/src/remote_host/mod.rs`, `model.rs`, `linux.rs`, `macos.rs`, `windows.rs`
- Modify: `apps/desktop/src-tauri/src/ssh.rs`, `lib.rs`, `bridge.rs`
- Modify: `packages/contracts/src/ipc.ts`
- Test: `apps/desktop/src-tauri/src/remote_host/*.rs`

- [x] **Step 1: Write command-generation and parser tests before adapters**

Use hostile but valid host aliases/usernames/paths to prove no shell interpolation. Cover Linux GNU and minimal POSIX, macOS, Windows OpenSSH PowerShell, x86_64/ARM64, missing utilities, noninteractive privilege denial, service modes, and bounded noisy output.

- [x] **Step 2: Define a constant-command adapter boundary**

```rust
pub trait RemoteHostAdapter {
    fn probe_commands(&self) -> Vec<RemoteCommand>;
    fn stage_commands(&self, input: &VerifiedArtifact) -> Vec<RemoteCommand>;
    fn install_commands(&self, input: &StagedArtifact) -> Vec<RemoteCommand>;
    fn service_commands(&self, mode: ServiceMode) -> Vec<RemoteCommand>;
}

pub struct RemoteCommand {
    pub program: String,
    pub arguments: Vec<String>,
    pub stdin: RemoteStdin,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}
```

No field contains an opaque shell script. The PowerShell adapter uses repository-owned constant encoded commands with values passed as separately encoded arguments.

- [x] **Step 3: Implement platform probing**

Probe OS/arch, installed binary/version, service status/mode, data root, local control availability, free space, and required install authority. Never read provider credentials, project lists, paths outside managed locations, or unrelated host inventory.

- [x] **Step 4: Implement verified transfer and atomic install**

The desktop downloads the exact manifest record, streams while hashing, verifies detached signature/checksum, transfers to a random remote staging path, verifies again remotely, then invokes platform-native MSI/PKG/DEB/RPM or portable install with explicit mode. Keep the previous binary/service definition until health and identity verification succeeds.

- [x] **Step 5: Surface explicit partial-state recovery**

Return a typed stage, mutation status, preserved version, cleanup outcome, and fixed recovery command. Never silently switch install target, mode, data root, or architecture.

- [x] **Step 6: Run adapter/provision tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop remote_host:: -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop ssh::tests::provision -- --nocapture
git add apps/desktop/src-tauri/src/remote_host apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/bridge.rs packages/contracts/src/ipc.ts
git commit -m "feat(ssh): provision Linux macOS and Windows servers"
```

Implementation note: SSH setup now probes Linux, macOS, and Windows x86-64/
ARM64 hosts through bounded platform adapters, requires matching one-use consent,
resolves the exact signed artifact tuple, verifies it before and after transfer,
and re-probes the exact promoted binary before descriptor verification. Dynamic
POSIX values are shell-quoted argv; Windows values cross as bounded JSON stdin
to repository-owned UTF-16LE encoded PowerShell. Workstation installs support
native or portable artifacts. Headless setup deliberately uses a portable
artifact and administrator-owned system staging, re-verifies hash and size
after the privileged copy, removes non-administrator write access, and promotes
atomically while retaining the previous version until health succeeds. Typed
failures report the stage, mutation and cleanup state, preserved version, and
an exact quoted recovery command. Pairing material and unexpected descriptor
fields never cross the renderer boundary.

Validation passed 12 adapter tests, 10 provisioning tests, all 377 desktop
library tests, and 82 affected contract/web tests. `cargo fmt --all --check`,
desktop all-target `cargo check`, desktop all-target Clippy with warnings denied,
`vp check`, and the complete workspace typecheck graph passed. `vp check`
retains one pre-existing unused test-fixture warning in
`apps/web/src/connection/storage.test.ts`. Independent review found no remaining
Critical or Important findings. Host-independent fixtures do not replace the
native Linux, macOS, and Windows OpenSSH runs required by the updated testing
runbooks; those native executions are not claimed here.

### Task 8: Fence cancellation, concurrency, and cleanup for remote operations

**Files:**

- Modify: `apps/desktop/src-tauri/src/ssh.rs`, `wsl.rs`, `wsl_transport.rs`, `bridge.rs`
- Modify: `packages/contracts/src/ipc.ts`
- Test: `apps/desktop/src-tauri/src/ssh.rs`, `wsl.rs`

- [x] **Step 1: Add race/failure tests**

Cover duplicate ensure, cancel during password prompt/download/transfer/install/tunnel readiness, desktop shutdown, late completion after Forget, local-port race, SSH exit before publish, stuck stderr, reaper saturation, and stale progress after a newer generation.

- [x] **Step 2: Give each operation one owner**

Use `operationId + environment/binding generation + CancellationToken`. Limit global provisioning, per-host mutation, active tunnels, WSL child forwards, and child reaper queues. Publish tunnel/binding changes only after readiness and generation checks.

- [x] **Step 3: Make Forget close admission first**

Plan 20's removal lifecycle marks the environment closing, then this layer cancels setup, password prompts, downloads, transfers, tunnels, proxies, and backend children; waits/reaps; clears host auth material; and only then acknowledges host cleanup. Force remove records unknown remote outcome without pretending a remote stop/uninstall occurred.

- [x] **Step 4: Run stress/lifecycle tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop ssh::tests::manager -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop wsl::tests::lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop wsl_transport::tests::shutdown -- --nocapture
git add apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/src/wsl.rs apps/desktop/src-tauri/src/wsl_transport.rs apps/desktop/src-tauri/src/bridge.rs packages/contracts/src/ipc.ts
git commit -m "fix(desktop): own and reap remote environment operations"
```

Implemented with an exact UUID plus environment/binding-generation coordinator,
atomic terminal completion claims, separate provisioning/tunnel capacities,
native cancellation through prompts/downloads/commands/readiness, and retained
process/reaper ownership. WSL terminal publication is generation-serialized and
desktop shutdown waits for rollback and staging cleanup. Forget now drains
native ownership before persistence deletion, performs local-only SSH cleanup
without contacting or stopping the remote service, revokes prepared consent,
and records `native-cleanup-failed` while retaining metadata on failure.
Successful cleanup requires a newer route generation; rejected pre-mutation
cleanup atomically restores the prior admission fence.

Validation passed all 392 desktop library tests, all 5 SSH public-contract
tests, and 179 affected contract/client/web tests. `cargo fmt --all --check`,
desktop `cargo check`, desktop all-target Clippy with warnings denied, `vp check`,
and the complete workspace typecheck graph passed. `vp check` retains one
pre-existing unused test-fixture warning in
`apps/web/src/connection/storage.test.ts`. Independent review found and drove
five lifecycle fixes plus one changed-pin admission regression; the final
read-only re-review found no remaining Critical or Important issue. Native
Linux, macOS, and Windows SSH/WSL runs remain required by the updated testing
runbooks and are not claimed here.

### Task 9: Replace renderer polling with bridge events and route-aware state

**Files:**

- Modify: `apps/web/src/tauriDesktopBridge.ts`, tests
- Modify: `apps/web/src/connection/useDesktopLocalBootstraps.ts`
- Modify: `apps/web/src/connection/desktopLocal.ts`, tests
- Modify: `apps/web/src/connection/platform.ts`, tests
- Modify: `apps/web/src/state/desktopWslState.ts`, tests

- [x] **Step 1: Write fake-clock/event tests**

Assert one initial read, coalesced focus/manual reads, event-driven updates, stale generation rejection, no three-second interval, low-frequency safety wakeup, cancellation at unmount, and no environment removal after discovery failure.

- [x] **Step 2: Subscribe through the typed bridge**

Expose `onWslDiscoveryChanged`, `refreshWslDiscovery`, setup/provision progress, and cancellation. Decode every payload with contracts before state mutation and unsubscribe on layer teardown.

- [x] **Step 3: Feed bindings into the Plan 20 catalog**

Create/update platform bindings and candidate routes, but let the environment supervisor perform identity verification and route activation. Discovery status can set `Stopped`/`Setup required`; it cannot overwrite a healthy verified environment with a stale locator result.

- [x] **Step 4: Run web bridge/platform tests and commit**

```sh
vp test apps/web/src/tauriDesktopBridge.test.ts apps/web/src/connection/desktopLocal.test.ts apps/web/src/connection/platform.test.ts apps/web/src/state/desktopWslState.test.ts
git add apps/web/src/tauriDesktopBridge.ts apps/web/src/tauriDesktopBridge.test.ts apps/web/src/connection/useDesktopLocalBootstraps.ts apps/web/src/connection/desktopLocal.ts apps/web/src/connection/desktopLocal.test.ts apps/web/src/connection/platform.ts apps/web/src/connection/platform.test.ts apps/web/src/state/desktopWslState.ts apps/web/src/state/desktopWslState.test.ts
git commit -m "feat(web): consume event-driven WSL and SSH state"
```

Implemented one ref-counted renderer topology controller with typed native WSL
and backend-ready events, one initial snapshot read, generation fencing,
single-flight manual refresh, a five-minute missed-event safety wakeup, and
teardown that ignores late completions. Native discovery remains the owner of
focus-triggered enumeration, so renderer focus only coalesces a cached topology
read and cannot launch a second `wsl.exe` probe. The platform source now
reconciles discovery into the Plan 20 catalog using deterministic binding and
route ids, preserves verified environments across failed or stale discovery,
and represents accepted stopped/setup-required or identity-conflicted distros
as unavailable without converting mutable distro locators into durable
environment identity or auto-adopting a replacement server UUID.
Initial WSL registrations are withheld until discovery state can attach stable
binding/route metadata; the registry rejects undecorated bearer fallbacks and
transactionally replaces any legacy volatile route. Non-authoritative topology
failures retain accepted environments after bearer expiry, while two-stage
renames compare-delete only the exact still-unproved locator row.

Validation passed 266 affected contract/client/web tests, all 392 desktop
library tests, and all 4 desktop bridge public-contract tests. `vp check`, the
complete workspace typecheck graph, `cargo fmt --all --check`, and desktop
all-target Clippy with warnings denied passed. `vp check` retains one
pre-existing unused test-fixture warning in
`apps/web/src/connection/storage.test.ts`. Native Windows WSL validation remains
required by the testing runbook and is not claimed from this macOS worktree.
Independent review found and drove three lifecycle fixes covering initial route
pollution, failed-read removal after credential expiry, and transient rename
ghosts; the read-only re-review found no remaining Critical or Important issue.

### Task 10: Update remote-environment and native testing documentation

**Files:**

- Modify: `docs/architecture/remote.md`, `connection-runtime.md`, `runtime-process-model.md`
- Modify: `docs/user/remote-access.md`, `server-administration.md`
- Modify: `docs/reference/workspace-layout.md`, `scripts.md`, `encyclopedia.md`
- Modify: `docs/testing/windows-desktop.md`, `cross-platform-validation.md`
- Create: `docs/testing/remote-environments.md`
- Modify: `docs/testing/process-lifecycle.md`, `worktree-process-lifecycle.md`
- Modify: `docs/testing/execution-report-template.md`

- [x] **Step 1: Document WSL visibility and safety exactly**

State that every Running distro appears, accepted Stopped distros remain, unaccepted stopped distros stay in Add Environment, setup requires consent, no automatic distro start occurs, unregister is never invoked, and traffic uses the loopback forwarder.

- [x] **Step 2: Document Linux/macOS/Windows SSH flows**

Include OpenSSH prerequisites, host-key handling, probe fields, consent screen, artifact verification/transfer, workstation/headless choices, pairing order, tunnel behavior, cancellation, partial-state recovery, and offline force removal consequences.

- [x] **Step 3: Add repeatable native evidence**

Require real Windows WSL UTF/state enumeration, stopped retention, rename/identity reconcile, no wildcard listener, Linux/macOS/Windows OpenSSH enrollment, host-key change blocking, no-remote-internet provisioning, cancellation/reaping, current worktree flows, and environment-specific folder picking.

- [x] **Step 4: Verify docs and commit**

```sh
git diff --check
rg -n "wsl --unregister|StrictHostKeyChecking=no|0\.0\.0\.0|Running|Stopped|Setup required|host key|PowerShell" docs/architecture docs/user docs/reference docs/testing apps/desktop/src-tauri/src
node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-desktop --all-targets -- -D warnings
git add docs/architecture/remote.md docs/architecture/connection-runtime.md docs/architecture/runtime-process-model.md docs/user/remote-access.md docs/user/server-administration.md docs/reference/workspace-layout.md docs/reference/scripts.md docs/reference/encyclopedia.md docs/testing
git commit -m "docs: describe safe WSL and SSH environment lifecycle"
```

**Implementation note (2026-08-25):** Updated the architecture, user, and
reference guides with event-driven WSL reconciliation, exact visibility and
identity-conflict rules, OpenSSH probe/provisioning/pairing order, local-only
Disconnect/Forget behavior, and the explicit future boundary between optional
remote uninstall and offline force removal. Added the focused remote
environment, process lifecycle, and worktree process lifecycle runbooks (the
last two plan-named paths did not previously exist), linked them from the
shared/native indexes, and expanded the execution report for native Windows
WSL plus Linux/macOS/Windows OpenSSH evidence. `vp check` passed with the one
pre-existing unused test-fixture warning, `vp run typecheck` passed, desktop
all-target Clippy with warnings denied passed through the MSVC wrapper, the
required safety-term audit found the documented guards and test evidence, and
`git diff --check` passed. Review caught a zero-test generic process filter; it
was replaced with current owners whose `--list` checks select 13 shell, 5 WSL
transport, 7 remote-operation, 9 WSL discovery, 85 SSH, 40 terminal-manager,
40 PTY, and 24 shared server-process tests. Native Windows/WSL and three-target
OpenSSH execution remain procedures to run on their named hosts; this macOS
documentation task does not claim those native results.
