# Linux WebKitGTK Resource Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every WebKitGTK helper process owned by the supported Linux BiBCode AppImage as an exact `core/ui` row without claiming unrelated or provider-owned WebKit processes.

**Architecture:** A Linux desktop observer will discover only immediate children of the combined Tauri host/server, then validate each hinted WebKitGTK role by reading one stable PID/PPID/start record before and after resolving `/proc/<pid>/exe`. Server diagnostics will expose the existing native process record without duplicating Linux stat parsing, and registered exact provider or terminal claims will take precedence over UI claims. The current sampler, attribution, RPC, history, and Resource Manager presentation paths remain unchanged.

**Tech Stack:** Rust 2024, Tauri 2, Tokio, Linux `/proc`, sysinfo-backed process snapshots, existing BiBCode diagnostics attribution, AppImage packaging, Vite+ repository checks.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-11-linux-webkitgtk-resource-attribution-design.md`.
- Attribute Linux WebKitGTK Web, Network, and GPU helper roots only with exact current-instance evidence.
- Cover helpers shared by the main WebView and helpers created for native Preview WebViews.
- Preserve PID-reuse safety by validating PID plus `/proc` start identity.
- Keep observation demand-driven and bounded by the existing 250-millisecond server observer deadline.
- Reuse the current immutable native process snapshot; do not add another machine-wide refresh or background polling loop.
- Exclude another application's WebKitGTK processes and WebKitGTK processes launched inside a registered provider or terminal subtree.
- Do not add elevated privileges, a production helper sidecar, a WebKit process extension, a private WebKitGTK ABI, persisted state, schemas, RPC methods, desktop bridge methods, or production dependencies.
- The only supported executable role basenames are `WebKitWebProcess`, `WebKitNetworkProcess`, and `WebKitGPUProcess`.
- A packaged AppImage probe must confirm those role names and immediate-parent topology before implementation proceeds. If it contradicts the design, stop and amend the approved specification instead of widening the heuristic.
- Registered exact non-UI claims win over a conflicting UI identity on every platform.
- Preserve Windows, macOS, web/headless, remote-host, process-signal, history, and Resource Manager behavior.
- Run focused tests, broader affected-package tests, `cargo fmt --all --check`, Clippy with warnings denied, `vp check`, and `vp run typecheck` before declaring implementation complete.
- At execution start, re-read the applicable `AGENTS.md`, run `git status --short`, and follow its one-attempt CodeGraph synchronization policy before editing; continue with direct source inspection when CodeGraph is unavailable.

---

## File Structure

- Create `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`: Linux role recognition, direct-parent candidate reduction, stable `/proc` validation, coverage messages, production observer, and focused unit tests.
- Modify `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`: compile and select the Linux observer while retaining current macOS, Windows, and unsupported-target behavior.
- Modify `apps/server/src/diagnostics/native.rs`: expose one read-only `NativeProcessRecord` built from the existing platform process parser.
- Modify `apps/server/src/diagnostics/mod.rs`: export `NativeProcessRecord` for the desktop crate.
- Modify `apps/server/src/diagnostics/resource_sampler.rs`: preserve existing exact claims when UI identities are appended and add focused regression coverage.
- Modify `docs/operations/observability.md`: replace the unsupported-Linux statement with the validated ownership and coverage contract.
- Create `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.json`: pre-change packaged runtime measurement produced by the existing measurement script.
- Create `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md`: generated measurement summary plus exact topology and post-change acceptance evidence.

---

### Task 1: Prove the packaged Linux WebKitGTK topology

**Files:**

- Create: `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.json`
- Create: `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md`
- Read: `scripts/measure-desktop-runtime.ts`
- Read: `docs/architecture/desktop-performance-baseline.md`

**Interfaces:**

- Consumes: the supported `vp run dist:desktop:linux` AppImage artifact and Linux `/proc`.
- Produces: recorded evidence that direct children of the combined host/server use exactly `WebKitWebProcess`, `WebKitNetworkProcess`, and `WebKitGPUProcess`; Tasks 4 and 5 rely on this gate.

- [ ] **Step 1: Verify the required Linux build and probe tools before changing code**

Run:

```bash
command -v cargo
command -v vp
command -v node
command -v ps
command -v readlink
command -v sed
command -v awk
```

Expected: every command prints an executable path. If `cargo` or `vp` is unavailable, stop execution and report the environment blocker; do not implement from an unverified topology.

- [ ] **Step 2: Build the supported x64 AppImage**

Run:

```bash
vp run dist:desktop:linux
find release/desktop/linux-x64 -maxdepth 1 -type f -name '*.AppImage' -print
```

Expected: the build exits zero and `find` prints exactly one AppImage under `release/desktop/linux-x64`.

- [ ] **Step 3: Capture the main-WebView baseline and keep the app running**

Run this from the repository root, replacing no values—the commands resolve the single artifact and create a task-specific temporary data root:

```bash
probe_appimage="$(find release/desktop/linux-x64 -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
probe_root="$(mktemp -d)"
vp run measure:desktop-runtime -- \
  --label linux-webkitgtk-resource-attribution \
  --command "$probe_appimage" \
  --idle-ms 30000 \
  --timeout-ms 120000 \
  --env "BIBCODE_HOME=$probe_root" \
  --keep-running \
  --json-out docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.json \
  --markdown-out docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md
probe_pid="$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.rootPid));' docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.json)"
ps -p "$probe_pid" --ppid "$probe_pid" -o pid=,ppid=,lstart=,comm=,args=
```

Expected: the root is the BiBCode AppImage process, and every current UI helper is an immediate child whose command basename is one of the three approved roles.

- [ ] **Step 4: Validate stable start identity and executable targets for every direct child**

Run:

```bash
for probe_child in $(ps --ppid "$probe_pid" -o pid=); do
  ps -p "$probe_child" -o pid=,ppid=,comm=,args=
  sed -E 's/^[0-9]+ \(.*\) //' "/proc/$probe_child/stat" | awk '{ print "ppid=" $2, "start_ticks=" $20 }'
  readlink "/proc/$probe_child/exe"
done
```

Expected: every WebKitGTK helper's stat parent equals `probe_pid`, start ticks are positive, and the resolved executable basename exactly matches its command role. Non-WebKit direct children are recorded but do not change the role allowlist.

- [ ] **Step 5: Open a native Preview and repeat the topology capture**

In the running BiBCode window, open a project, open the right-panel Preview, and navigate it to a page so its native WebView is live. Then run the `ps` and `/proc` commands from Steps 3 and 4 again.

Expected: any new or shared WebKit helpers remain immediate children of `probe_pid`, use only the three approved roles, and have stable identities. Close Preview and repeat once more; retained shared helpers may remain, but no helper may move under an unrelated parent.

- [ ] **Step 6: Record the topology gate in the measurement Markdown**

Use `apply_patch` to append a `## WebKitGTK ownership topology` section to `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md`. Record the exact packaged artifact name, host PID, each observed helper PID/PPID/start tick/executable basename, whether it appeared with the main or Preview WebView, and the Preview-close result. Do not record full home paths, environment values, credentials, or unrestricted commands.

Expected: the section explicitly states that the approved direct-parent design is either confirmed or contradicted. If contradicted, stop and return to design review without continuing to Task 2.

- [ ] **Step 7: Stop the probe and verify cleanup**

Close BiBCode normally, then run:

```bash
ps -p "$probe_pid" -o pid=,ppid=,comm=,args=
for probe_child in $(ps --ppid "$probe_pid" -o pid=); do ps -p "$probe_child" -o pid=,ppid=,comm=,args=; done
```

Expected: no row is printed for the host or its recorded helpers. Keep the temporary data root path in the local shell for the implementation session; do not add it to the measurement files.

- [ ] **Step 8: Commit the confirmed topology evidence**

```bash
git add docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.json docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md
git commit -m "test: record Linux WebKitGTK process topology"
```

---

### Task 2: Expose the existing stable native process record

**Files:**

- Modify: `apps/server/src/diagnostics/native.rs:16-60`
- Modify: `apps/server/src/diagnostics/native.rs:124-235`
- Modify: `apps/server/src/diagnostics/native.rs:844-879`
- Modify: `apps/server/src/diagnostics/mod.rs:19-27`
- Test: `apps/server/src/diagnostics/native.rs`

**Interfaces:**

- Consumes: existing private `PlatformProcessRecord { started_at, ppid }` and `platform_process_record(pid)`.
- Produces: `pub struct NativeProcessRecord { pub identity: ProcessIdentity, pub ppid: u32 }` and `NativeProcessSampler::process_record(pid: u32) -> Result<NativeProcessRecord, SamplingError>` for Task 4.

- [ ] **Step 1: Add a failing public-record test**

In `native.rs`'s existing test module, add:

```rust
#[cfg(target_os = "linux")]
#[test]
fn native_process_record_exposes_the_current_linux_identity_and_parent() {
    let record = NativeProcessSampler::process_record(std::process::id())
        .expect("current process record");
    let expected = platform_process_record(std::process::id())
        .expect("current platform record");

    assert_eq!(record.identity.pid, std::process::id());
    assert_eq!(record.identity.started_at, expected.started_at);
    assert_eq!(record.ppid, expected.ppid);
    assert_ne!(record.identity.started_at, 0);
}
```

- [ ] **Step 2: Run the test and confirm the red state**

Run:

```bash
cargo test -p bibcode-server native_process_record_exposes_the_current_linux_identity_and_parent -- --nocapture
```

Expected: compilation fails because `NativeProcessSampler::process_record` does not exist.

- [ ] **Step 3: Add the minimal public Rust boundary without changing wire contracts**

Add beside `NativeProcessSampler`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeProcessRecord {
    pub identity: ProcessIdentity,
    pub ppid: u32,
}
```

Add these methods:

```rust
impl NativeProcessSampler {
    pub fn process_record(pid: u32) -> Result<NativeProcessRecord, SamplingError> {
        let record = platform_process_record(pid)
            .map_err(|error| SamplingError::Failed(error.to_string()))?;
        Ok(NativeProcessRecord {
            identity: ProcessIdentity {
                pid,
                started_at: record.started_at,
            },
            ppid: record.ppid,
        })
    }

    pub(crate) fn process_identity(pid: u32) -> Result<ProcessIdentity, SamplingError> {
        Self::process_record(pid).map(|record| record.identity)
    }

    // Existing methods remain unchanged.
}
```

Export the type from `diagnostics/mod.rs`:

```rust
pub use native::{NativeProcessRecord, NativeProcessSampler, ProcessSignal, SignalError};
```

Do not make `PlatformProcessRecord`, the Linux stat parser, or filesystem paths public.

- [ ] **Step 4: Run the focused and native diagnostics tests**

Run:

```bash
cargo test -p bibcode-server native_process_record_exposes_the_current_linux_identity_and_parent -- --nocapture
cargo test -p bibcode-server diagnostics::native -- --nocapture
```

Expected: both commands pass, including the existing close-replacement start-tick tests.

- [ ] **Step 5: Commit the reusable native process record**

```bash
git add apps/server/src/diagnostics/native.rs apps/server/src/diagnostics/mod.rs
git commit -m "refactor: expose stable native process records"
```

---

### Task 3: Preserve registered external ownership over UI observations

**Files:**

- Modify: `apps/server/src/diagnostics/resource_sampler.rs:292-401`
- Test: `apps/server/src/diagnostics/resource_sampler.rs:540-790`

**Interfaces:**

- Consumes: registry `Vec<ProcessClaim>`, sampled identities, and observer identities.
- Produces: `append_ui_claims` that deduplicates identities and never overwrites an existing exact claim; Tasks 4 and 5 rely on this security invariant.

- [ ] **Step 1: Add the conflicting-claim regression test**

Add this test beside `exact_ui_identities_become_core_ui_and_are_bounded_to_sixty_four`:

```rust
#[tokio::test]
async fn exact_external_claim_wins_over_a_conflicting_ui_observation() {
    let server_pid = std::process::id();
    let candidate = identity(server_pid + 1, 200);
    let registry = ProcessAttributionRegistry::new();
    let _registration = registry
        .register_identity(
            candidate,
            ProcessRegistrationMetadata {
                scope: AttributionScope::External,
                kind: AttributionKind::Provider,
                label: "external/provider/codex".to_owned(),
                source: RegistrationSource::Provider,
            },
        )
        .expect("registration should fit");
    let (sampler, _) = sampler_with_registry(
        vec![row(server_pid, 1, 100), row(candidate.pid, server_pid, candidate.started_at)],
        FakeObservation::Return(DesktopUiObservation {
            identities: vec![candidate, candidate],
            coverage: UiCoverage {
                status: UiCoverageStatus::Available,
                message: None,
            },
        }),
        registry,
    );

    let snapshot = sampler.sample().await.expect("sample should succeed");
    let process = snapshot
        .processes
        .iter()
        .find(|process| process.identity == candidate)
        .expect("registered candidate");

    assert_eq!(process.scope, AttributionScope::External);
    assert_eq!(process.kind, AttributionKind::Provider);
    assert_eq!(process.label, "external/provider/codex");
    assert_eq!(process.confidence, AttributionConfidence::Exact);
}
```

- [ ] **Step 2: Run the test and confirm it fails for the current append order**

Run:

```bash
cargo test -p bibcode-server exact_external_claim_wins_over_a_conflicting_ui_observation -- --nocapture
```

Expected: FAIL because the appended UI claim currently replaces the registered claim when claims are indexed by identity.

- [ ] **Step 3: Deduplicate UI identities while retaining prior exact claims**

Replace `append_ui_claims` with the same signature and this filtering policy:

```rust
fn append_ui_claims(
    claims: &mut Vec<ProcessClaim>,
    rows: &[ProcessRow],
    identities: &[ProcessIdentity],
) {
    let sampled_identities = rows
        .iter()
        .map(|row| ProcessIdentity {
            pid: row.pid,
            started_at: row.started_at,
        })
        .collect::<HashSet<_>>();
    let mut claimed_identities = claims
        .iter()
        .map(|claim| claim.identity)
        .collect::<HashSet<_>>();

    claims.extend(
        identities
            .iter()
            .copied()
            .filter(|identity| sampled_identities.contains(identity))
            .filter(|identity| claimed_identities.insert(*identity))
            .map(|identity| ProcessClaim {
                identity,
                scope: AttributionScope::Core,
                kind: AttributionKind::Ui,
                label: "core/ui".to_owned(),
            }),
    );
}
```

Keep registry binding at the current point before `append_ui_claims`; no observer or registry API change is required.

- [ ] **Step 4: Run focused sampler and signal-eligibility coverage**

Run:

```bash
cargo test -p bibcode-server exact_external_claim_wins_over_a_conflicting_ui_observation -- --nocapture
cargo test -p bibcode-server exact_ui_identities_become_core_ui_and_are_bounded_to_sixty_four -- --nocapture
cargo test -p bibcode-server signal_external_descendant -- --nocapture
```

Expected: all tests pass; exact UI claims still work, duplicate observer identities count once, and registered External rows remain signal-eligible under existing revalidation.

- [ ] **Step 5: Commit claim precedence**

```bash
git add apps/server/src/diagnostics/resource_sampler.rs
git commit -m "fix: preserve exact external process ownership"
```

---

### Task 4: Implement fail-closed Linux candidate validation

**Files:**

- Create: `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`
- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs:1-14`
- Test: `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`

**Interfaces:**

- Consumes: `Arc<[ProcessRow]>`, exact `server_identity`, injected `FnMut(u32) -> Result<NativeProcessRecord, ()>`, and injected `FnMut(u32) -> Result<PathBuf, ()>`.
- Produces: pure `build_observation_with(...) -> DesktopUiObservation`, deterministic Linux coverage messages, and `LinuxDesktopUiProcessObserver::new()` for Task 5.

- [ ] **Step 1: Declare the Linux module and add the pure test fixtures**

In `ui_process_observer.rs`, add only the module declaration first:

```rust
#[cfg(target_os = "linux")]
mod linux;
```

Create `linux.rs` with imports, domain types, and a `#[cfg(test)]` module. Use these exact production shapes:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum WebKitGtkProcessRole {
    Web,
    Network,
    Gpu,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum LinuxObservationIssue {
    ServerSnapshot,
    ParentEdge,
    ProcessRecord,
    Executable,
    RoleMismatch,
    UnsupportedRole,
}

fn build_observation_with(
    rows: &[ProcessRow],
    server_identity: ProcessIdentity,
    mut record_for: impl FnMut(u32) -> Result<NativeProcessRecord, ()>,
    mut executable_for: impl FnMut(u32) -> Result<PathBuf, ()>,
) -> DesktopUiObservation;
```

Test fixtures must build rows with `ProcessRow::fixture`, then assign distinct nonzero `started_at` values. Use maps for stable records and executable paths; use `VecDeque<Result<NativeProcessRecord, ()>>` when a test needs different before/after records.

- [ ] **Step 2: Add the complete Linux validator test matrix**

Add tests whose names begin with `linux_ui_` and assert:

- `linux_ui_accepts_exact_web_network_and_gpu_children`: all three direct children validate, return sorted unique snapshot identities, and coverage is `Available`.
- `linux_ui_deduplicates_shared_helpers`: duplicate snapshot rows or repeated candidate hints cannot duplicate one stable identity.
- `linux_ui_ignores_same_name_processes_owned_by_another_parent`: an unrelated application's exact helper executable is never queried or claimed.
- `linux_ui_ignores_provider_and_terminal_webkit_descendants`: role processes below distinct provider and terminal roots are never queried or claimed.
- `linux_ui_requires_the_exact_server_identity`: a reused server PID with another start identity yields `Unavailable` before candidate inspection.
- `linux_ui_rejects_invalid_parent_start_order`: a child older than the current parent is rejected.
- `linux_ui_rejects_snapshot_and_procfs_identity_mismatch`: changed PPID or start ticks fail closed.
- `linux_ui_rejects_pid_reuse_around_executable_resolution`: differing before/after records fail closed.
- `linux_ui_rejects_executable_role_mismatch`: a command hint for Web whose resolved executable is `WebKitGPUProcess` is not claimed.
- `linux_ui_rejects_process_record_and_executable_failures`: table-driven process-exit, malformed-stat, permission-denial, and non-file-executable failures are bounded and yield `Unavailable` without exposing the injected error.
- `linux_ui_keeps_valid_rows_when_a_peer_fails`: one accepted identity plus one rejected hinted candidate yields `Partial`.
- `linux_ui_rejects_unknown_direct_webkit_roles`: `WebKitModelProcess` is unclaimed, yields `Partial` with a valid peer and `Unavailable` alone.
- `linux_ui_no_helpers_is_unavailable`: no validated identity never produces a healthy zero.
- `linux_ui_messages_are_bounded`: every Linux observer message is at most 160 Unicode scalar values before the server wrapper.

For the happy-path test, use commands and resolved paths like:

```rust
let rows = [
    row(SERVER_PID, 1, 100, "/app/bin/bibcode-desktop"),
    row(501, SERVER_PID, 200, "/usr/libexec/webkit2gtk-4.1/WebKitWebProcess --web-process"),
    row(502, SERVER_PID, 201, "/usr/libexec/webkit2gtk-4.1/WebKitNetworkProcess"),
    row(503, SERVER_PID, 202, "/usr/libexec/webkit2gtk-4.1/WebKitGPUProcess"),
];
```

- [ ] **Step 3: Run the Linux tests and confirm the red state**

Run:

```bash
cargo test -p bibcode-desktop linux_ui_ -- --nocapture
```

Expected: compilation fails because the role parser, reducer, and coverage functions are not implemented.

- [ ] **Step 4: Implement strict command-role hints**

Implement exact basename recognition without substring acceptance:

```rust
impl WebKitGtkProcessRole {
    fn from_executable_name(name: &str) -> Option<Self> {
        match name {
            "WebKitWebProcess" => Some(Self::Web),
            "WebKitNetworkProcess" => Some(Self::Network),
            "WebKitGPUProcess" => Some(Self::Gpu),
            _ => None,
        }
    }

    fn executable_name(self) -> &'static str {
        match self {
            Self::Web => "WebKitWebProcess",
            Self::Network => "WebKitNetworkProcess",
            Self::Gpu => "WebKitGPUProcess",
        }
    }
}

fn command_executable_name(command: &str) -> Option<&str> {
    Path::new(command.split_ascii_whitespace().next()?)
        .file_name()
        .and_then(OsStr::to_str)
}

fn is_webkit_like_process_name(name: &str) -> bool {
    name.starts_with("WebKit") && name.ends_with("Process")
}
```

A direct-child basename for which `is_webkit_like_process_name` returns true but `from_executable_name` returns `None` records `UnsupportedRole`; it is never passed to executable validation or returned as an identity.

- [ ] **Step 5: Implement direct-parent and stable-record validation**

`build_observation_with` must:

1. Find the server row by exact PID and start identity or return unavailable with `ServerSnapshot`.
2. Iterate only rows with `row.ppid == server_identity.pid`, in PID order.
3. Ignore ordinary direct children whose command basename is not WebKit-like.
4. Reject a hinted child when `server_identity.started_at > row.started_at`.
5. Read `NativeProcessRecord` before executable resolution and require exact snapshot identity plus `ppid == server_identity.pid`.
6. Resolve the executable and require its basename to equal `role.executable_name()`.
7. Read `NativeProcessRecord` again and require it to equal the first record.
8. Insert the snapshot identity into a `HashSet`, then return identities sorted by PID.
9. Record only deterministic `LinuxObservationIssue` values; never retain injected errors or resolved paths.

Use a helper for one candidate:

```rust
fn validate_candidate(
    row: &ProcessRow,
    server_identity: ProcessIdentity,
    role: WebKitGtkProcessRole,
    record_for: &mut impl FnMut(u32) -> Result<NativeProcessRecord, ()>,
    executable_for: &mut impl FnMut(u32) -> Result<PathBuf, ()>,
) -> Result<ProcessIdentity, LinuxObservationIssue> {
    if server_identity.started_at > row.started_at {
        return Err(LinuxObservationIssue::ParentEdge);
    }
    let expected = NativeProcessRecord {
        identity: ProcessIdentity {
            pid: row.pid,
            started_at: row.started_at,
        },
        ppid: server_identity.pid,
    };
    let before = record_for(row.pid).map_err(|()| LinuxObservationIssue::ProcessRecord)?;
    if before != expected {
        return Err(LinuxObservationIssue::ProcessRecord);
    }
    let executable = executable_for(row.pid).map_err(|()| LinuxObservationIssue::Executable)?;
    if executable.file_name().and_then(OsStr::to_str) != Some(role.executable_name()) {
        return Err(LinuxObservationIssue::RoleMismatch);
    }
    let after = record_for(row.pid).map_err(|()| LinuxObservationIssue::ProcessRecord)?;
    if after != before {
        return Err(LinuxObservationIssue::ProcessRecord);
    }
    Ok(expected.identity)
}
```

- [ ] **Step 6: Implement deterministic coverage reduction**

Use the approved semantics:

```rust
fn coverage_for(
    has_identities: bool,
    issues: &BTreeSet<LinuxObservationIssue>,
) -> UiCoverage {
    let status = if !has_identities {
        UiCoverageStatus::Unavailable
    } else if issues.is_empty() {
        UiCoverageStatus::Available
    } else {
        UiCoverageStatus::Partial
    };
    let message = (status != UiCoverageStatus::Available)
        .then(|| bounded_issue_message(status, issues));
    UiCoverage { status, message }
}
```

Implement the fixed, bounded message table explicitly:

```rust
const UI_UNAVAILABLE_MESSAGE: &str =
    "Native server usage is included, but local UI/WebView usage could not be associated reliably.";

fn bounded_issue_message(
    status: UiCoverageStatus,
    issues: &BTreeSet<LinuxObservationIssue>,
) -> String {
    let boundary = match issues.iter().next() {
        Some(LinuxObservationIssue::ServerSnapshot) => {
            "The native server process was absent from the process snapshot."
        }
        Some(LinuxObservationIssue::ParentEdge) => {
            "A WebKitGTK process parent edge could not be validated."
        }
        Some(LinuxObservationIssue::ProcessRecord) => {
            "A WebKitGTK process identity could not be validated."
        }
        Some(LinuxObservationIssue::Executable) => {
            "A WebKitGTK process executable could not be resolved."
        }
        Some(LinuxObservationIssue::RoleMismatch) => {
            "A WebKitGTK process executable did not match its reported role."
        }
        Some(LinuxObservationIssue::UnsupportedRole) => {
            "An unsupported WebKitGTK process role was observed."
        }
        None => "No supported WebKitGTK UI process identity was available.",
    };

    if status == UiCoverageStatus::Unavailable {
        format!("{boundary} {UI_UNAVAILABLE_MESSAGE}")
    } else {
        boundary.to_owned()
    }
}
```

Do not interpolate a PID, command, path, or operating-system error. Test the Linux observer's emitted messages directly against the 160-scalar limit; retain the server sampler's existing test that independently proves the wrapper truncates arbitrary observer messages.

- [ ] **Step 7: Run the pure Linux test matrix**

Run:

```bash
cargo test -p bibcode-desktop linux_ui_ -- --nocapture
```

Expected: every pure validation and coverage test passes without touching real `/proc` or performing a machine-wide refresh.

---

### Task 5: Wire production `/proc` inspection and the Linux factory

**Files:**

- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`
- Modify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`
- Test: `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`
- Test: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`

**Interfaces:**

- Consumes: Task 2's `NativeProcessSampler::process_record`, Task 4's pure reducer, and the existing `DesktopUiProcessObserver` trait.
- Produces: production `LinuxDesktopUiProcessObserver` and Linux factory selection passed through the already-tested `BackendSupervisor` restart lifecycle.

- [ ] **Step 1: Add failing production-boundary and factory tests**

In `linux.rs`, add:

```rust
#[cfg(target_os = "linux")]
#[test]
fn linux_ui_native_record_and_executable_reader_validate_the_current_process() {
    let record = NativeProcessSampler::process_record(std::process::id())
        .expect("current process record");
    let executable = read_process_executable(std::process::id())
        .expect("current executable");

    assert_eq!(record.identity.pid, std::process::id());
    assert_ne!(record.identity.started_at, 0);
    assert!(executable.is_absolute());
    assert!(executable.is_file());
}
```

In `ui_process_observer.rs`, add a Linux-only test using Tauri's existing mock support:

```rust
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use tauri::Manager as _;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn linux_ui_factory_installs_the_linux_observer() {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let observer = super::for_app(app.handle());

        assert_eq!(format!("{observer:?}"), "LinuxDesktopUiProcessObserver");
    }
}
```

- [ ] **Step 2: Run the tests and confirm the factory red state**

Run:

```bash
cargo test -p bibcode-desktop linux_ui_native_record_and_executable_reader -- --nocapture
cargo test -p bibcode-desktop linux_ui_factory_installs_the_linux_observer -- --nocapture
```

Expected: the native-read test compiles after Task 2, while the factory test fails until the production observer is selected.

- [ ] **Step 3: Implement the production observer**

Add the regular-file executable boundary, zero-state observer, and trait implementation in `linux.rs`:

```rust
fn read_process_executable(pid: u32) -> Result<PathBuf, ()> {
    let executable = std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| ())?;
    let metadata = std::fs::metadata(&executable).map_err(|_| ())?;
    metadata.is_file().then_some(executable).ok_or(())
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LinuxDesktopUiProcessObserver;

impl LinuxDesktopUiProcessObserver {
    pub(super) fn new() -> Self {
        Self
    }
}

impl DesktopUiProcessObserver for LinuxDesktopUiProcessObserver {
    fn observe(
        &self,
        rows: Arc<[ProcessRow]>,
        server_identity: ProcessIdentity,
    ) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>> {
        Box::pin(async move {
            build_observation_with(
                &rows,
                server_identity,
                |pid| NativeProcessSampler::process_record(pid).map_err(|_| ()),
                read_process_executable,
            )
        })
    }
}
```

The observer performs bounded per-candidate `/proc` reads inside the existing timed observer task. Do not add `spawn_blocking`, a second machine-wide process sample, caching, or retained claims.

- [ ] **Step 4: Select Linux without breaking Windows fallback**

Update `ui_process_observer.rs` imports and control flow:

```rust
#[cfg(target_os = "linux")]
use self::linux::LinuxDesktopUiProcessObserver;

pub(super) fn for_app<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn DesktopUiProcessObserver> {
    #[cfg(target_os = "macos")]
    return Arc::new(MacosDesktopUiProcessObserver::new(app.clone()));

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Arc::new(LinuxDesktopUiProcessObserver::new());
    }

    #[cfg(windows)]
    if let Some(executable_name) = std::env::current_exe().ok().and_then(|path| {
        path.file_name().map(|name| name.to_string_lossy().into_owned())
    }) {
        return Arc::new(WebView2DesktopUiProcessObserver::new(executable_name));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = app;

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Arc::new(UnavailableDesktopUiProcessObserver)
}
```

Change the unavailable-observer import to the same `not(any(macos, linux))` condition. Keep the Windows import and current-executable failure fallback intact.

- [ ] **Step 5: Run Linux observer, factory, and supervisor lifecycle coverage**

Run:

```bash
cargo test -p bibcode-desktop linux_ui_ -- --nocapture
cargo test -p bibcode-desktop configured_ui_observer_is_reused_for_restart_snapshots -- --nocapture
cargo test -p bibcode-desktop configured_ui_observer_reaches_initial_and_restarted_in_process_runtimes -- --nocapture
cargo check -p bibcode-desktop --all-targets
```

Expected: all tests pass; the desktop crate compiles without unused platform imports, and existing restart tests prove the selected observer survives restarts.

- [ ] **Step 6: Run affected server sampler tests after factory integration**

Run:

```bash
cargo test -p bibcode-server resource_sampler -- --nocapture
```

Expected: WebView2, generic observer, coverage, signal, claim-precedence, and UI-identity tests all pass.

- [ ] **Step 7: Commit the Linux observer**

```bash
git add apps/desktop/src-tauri/src/backend/ui_process_observer.rs apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs
git commit -m "feat: attribute Linux WebKitGTK UI processes"
```

---

### Task 6: Align living observability documentation and run repository checks

**Files:**

- Modify: `docs/operations/observability.md:119-170`
- Verify: `apps/server/src/diagnostics/native.rs`
- Verify: `apps/server/src/diagnostics/resource_sampler.rs`
- Verify: `apps/desktop/src-tauri/src/backend/ui_process_observer.rs`
- Verify: `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs`

**Interfaces:**

- Consumes: the implemented Linux ownership proof and coverage semantics.
- Produces: current living documentation and clean focused/broader validation evidence.

- [ ] **Step 1: Replace the unsupported-Linux documentation**

Replace the two-line statement that Linux reports unavailable with prose that states all of the following:

```markdown
On Linux, the desktop observer considers only immediate children of the current
combined Tauri host/server. A strict WebKitGTK Web, Network, or GPU role is
accepted only when `/proc` reports the same parent PID and start identity before
and after resolving an exact role-matched executable. Registered provider and
terminal ownership wins over a conflicting UI observation. Unknown roles,
changed identities, permission failures, and unsupported process topologies
remain unclaimed and produce bounded partial or unavailable coverage. The
observer never claims a generic WebKit process by machine-wide name matching.
```

Keep the Windows and macOS paragraphs unchanged.

- [ ] **Step 2: Run focused affected-package tests**

Run:

```bash
cargo test -p bibcode-server native_process_record -- --nocapture
cargo test -p bibcode-server resource_sampler -- --nocapture
cargo test -p bibcode-desktop linux_ui_ -- --nocapture
```

Expected: every command passes with zero failed tests.

- [ ] **Step 3: Run broader package tests**

Run:

```bash
cargo test -p bibcode-server -j 2 -- --test-threads=1
cargo test -p bibcode-desktop -j 2 -- --test-threads=1
```

Expected: both package suites pass with zero failed tests.

- [ ] **Step 4: Run Rust formatting and Clippy**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: formatting is unchanged and Clippy exits zero with no warnings.

- [ ] **Step 5: Run mandatory repository gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both repository gates exit zero.

- [ ] **Step 6: Review the complete implementation diff**

Run:

```bash
git diff --check
git diff --stat
git status --short
git diff -- apps/server/src/diagnostics/native.rs apps/server/src/diagnostics/mod.rs apps/server/src/diagnostics/resource_sampler.rs apps/desktop/src-tauri/src/backend/ui_process_observer.rs apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs docs/operations/observability.md
```

Expected: only the approved implementation and living documentation are modified; no generated dependencies, debug output, unrestricted process data, `.codegraph` data, or unrelated cleanup appears.

- [ ] **Step 7: Commit the living documentation and any verification-only formatting**

```bash
git add docs/operations/observability.md
git commit -m "docs: explain Linux WebKitGTK resource attribution"
```

---

### Task 7: Verify Resource Manager in the packaged AppImage

**Files:**

- Modify: `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md`
- Verify: packaged AppImage under `release/desktop/linux-x64`

**Interfaces:**

- Consumes: the completed Linux observer and Task 1's recorded baseline topology.
- Produces: live acceptance evidence for exact `core/ui` rows, exclusions, totals, lifecycle, and residual distro risk.

- [ ] **Step 1: Rebuild the AppImage from the verified implementation**

Run:

```bash
vp run dist:desktop:linux
find release/desktop/linux-x64 -maxdepth 1 -type f -name '*.AppImage' -print
```

Expected: one fresh AppImage is produced successfully.

- [ ] **Step 2: Launch the packaged app with an isolated data root**

Run:

```bash
acceptance_appimage="$(find release/desktop/linux-x64 -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
acceptance_root="$(mktemp -d)"
BIBCODE_HOME="$acceptance_root" "$acceptance_appimage" &
acceptance_pid=$!
ps -p "$acceptance_pid" -o pid=,ppid=,lstart=,comm=,args=
```

Expected: BiBCode starts from the packaged artifact with no production Node or helper sidecar.

- [ ] **Step 3: Verify the main WebView in Resource Manager**

Open Resource Manager and wait for two samples. Confirm visually and against the `ps`/`readlink` commands from Task 1:

- `core/server` is present;
- every validated WebKit Web, Network, and GPU helper is present as exact `core/ui`;
- UI coverage is `available` when every hinted child validates;
- Combined equals Core plus External for CPU, RSS, and process count; and
- no WebKit helper appears as `external/unknown/fallback`.

Expected: every check passes. Record the observed rows and reconciled totals in the bounded measurement Markdown in Step 8; do not add a screenshot or unrestricted Resource Manager export to source control.

- [ ] **Step 4: Verify Preview sharing and rotation**

Open a native Preview, navigate it, and wait for two more samples. Compare stable process identities before and after. Close Preview and wait for another sample.

Expected: new or shared helpers remain exact `core/ui`, identities are not duplicated, retained helpers remain attributable, and exited helpers disappear without a stale claim.

- [ ] **Step 5: Verify negative ownership cases**

Run one provider session and one terminal, then open another installed WebKitGTK application if available.

Expected: provider and terminal roots and descendants remain External; the other application's WebKit helpers are absent from BiBCode's rows and totals. If no second WebKitGTK application is installed, record that this one manual exclusion case could not run; do not substitute a generic process-name guess.

- [ ] **Step 6: Verify fail-closed coverage without shipping a permanent fault hook**

Compare live behavior with the pure tests for unknown role, changed identity, and permission failure. Do not rename system executables, alter `/proc`, inject a production environment switch, or add a fault-only application flag.

Expected: automated tests provide the failure-path evidence, while the packaged run remains on the real supported topology.

- [ ] **Step 7: Verify shutdown cleanup**

Close BiBCode normally, then run:

```bash
ps -p "$acceptance_pid" -o pid=,ppid=,comm=,args=
for acceptance_child in $(ps --ppid "$acceptance_pid" -o pid=); do ps -p "$acceptance_child" -o pid=,ppid=,comm=,args=; done
```

Expected: no host, WebKit helper, provider, or terminal process owned by the acceptance run remains.

- [ ] **Step 8: Append post-change acceptance evidence**

Use `apply_patch` to append `## Post-change Resource Manager acceptance` to `docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md`. Record the AppImage name, WebKitGTK version reported by the package manager when available, validated roles, main/Preview result, exclusion result, totals reconciliation, shutdown result, exact commands run, and any manual case that could not run. Do not include user paths, unrestricted commands, environment values, or credentials.

- [ ] **Step 9: Run final status review and commit acceptance evidence**

Run:

```bash
git diff --check
git status --short
git diff -- docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md
```

Expected: only the bounded acceptance addition remains uncommitted.

Commit:

```bash
git add docs/architecture/measurements/linux-webkitgtk-resource-attribution-20260811.md
git commit -m "test: verify Linux WebKitGTK resource attribution"
```

- [ ] **Step 10: Perform the final clean-tree and commit review**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: the worktree is clean and the recent commits correspond only to topology evidence, native process records, claim precedence, the Linux observer, living documentation, and packaged acceptance evidence.
