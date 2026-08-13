# Task 9I Test Temporary-Root Ownership Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the script and desktop SSH tests leave zero newly surviving
temporary roots after success, assertion failure, command failure, or future
cancellation without serializing the parallel test graph.

**Architecture:** Bind every temporary root to the narrow owner that consumes
it. Script repository fixtures execute inside synchronous `try/finally`
callbacks, and the seeded-upgrade alias fixture removes its child root in an
async `finally`. Desktop SSH replaces its PID-global unowned helper directory
with a unique cloneable askpass lease: transient SSH commands retain the lease
until their child completes or is dropped, while a live tunnel retains the
same lease until awaited disconnect or manager drop. Lease teardown removes
only the exact helper files and empty directories it created.

**Tech Stack:** TypeScript, Vite+, Node.js 24 filesystem APIs, Rust 2024,
Tokio, Tauri 2, Cargo tests.

## Global Constraints

- Start from clean tracked commit `36ee0035`; preserve all pre-existing
  temporary roots, ignored Task 9 evidence, user files, and the pre-existing
  August 11 OpenCode processes.
- Create and commit this tracked plan before editing tests or implementation.
- Keep all package and Rust harness tests parallel. Add no sleep, polling loop,
  process-wide lock, global mutable fixture registry, or serialized test flag.
- Strict TDD applies: capture the current per-suite root delta, then add an
  injected-base regression and observe the expected RED before implementing
  cleanup.
- The default behavior is cleanup on success and failure. No artifact is
  retained unless a separate documented caller explicitly opts in; none of
  the affected tests has such an opt-in.
- Cleanup may remove only an exact root created by the current fixture owner.
  It must not recursively delete a shared temporary directory, a PID-global
  directory, a pre-existing root, or an unexpected foreign entry.
- SSH passwords remain child-environment values only. Askpass scripts and
  temporary files must never contain authentication secrets.
- Run focused suites at default, 8, and 12 Rust harness threads where
  applicable, then one canonical isolated `vp run test` graph with reliable
  before/after process and temporary-root snapshots. Stop on a different test
  failure or scoped process survivor.

---

## Diagnosis and ownership trace

The green Task 9H graph at `36ee0035` left exactly thirteen new roots in the
host temporary directory:

- ten `bibcode-dependency-ledger-*` roots correspond one-for-one with the ten
  calls to `createRepositoryFixture` in
  `scripts/check-dependency-upgrade-ledger.test.ts`. The helper returns a raw
  path and no caller removes it;
- one empty `bibcode-upgrade-canonical-*` root is created by the symlink
  canonicalization test in `scripts/seeded-desktop-upgrade-smoke.test.ts`; that
  test has no `finally`;
- two `bibcode-ssh-runtime-{pid}` roots come from the desktop library and
  `ssh_public_contract` integration binaries. `ensure_ssh_askpass_launcher`
  creates a process-ID path, but `SshEnvironmentManager` and
  `ManagedSshTunnel` retain only its `PathBuf`, so neither success nor failure
  has cleanup authority.

CodeGraph confirms that `ensure_ssh_askpass_launcher` is called only by
`SshEnvironmentManager::ensure_environment` and
`SshEnvironmentManager::disconnect_environment`; public callers cross the
desktop bridge through those methods. The askpass file contains static code
and reads `BIBCODE_SSH_AUTH_SECRET` from a child environment, so the directory
is ephemeral runtime support rather than a diagnostic artifact.

## Ownership invariants

1. A repository fixture callback owns one freshly created root and removes it
   in `finally`, including when fixture population or an assertion throws.
2. The seeded canonicalization test owns a child root beneath an injected
   private base and removes that child in `finally`; the test asserts the base
   is empty before releasing the base itself.
3. One `SshAskpassLauncher` lease owns one unpredictable root. The manager
   caches only a `Weak` reference so a failed or cancelled transient operation
   releases immediately, while `ManagedSshTunnel` holds a strong lease for a
   live tunnel.
4. Concurrent manager operations may converge on one live lease, but no
   process-ID or static path is shared across managers or test binaries.
5. SSH command futures retain a strong lease for at least the lifetime of the
   corresponding kill-on-drop child. Successful disconnect awaits child
   termination before releasing the tunnel lease.
6. Lease teardown attempts the exact platform launcher files, then the exact
   askpass directory, then the exact unique root. Unexpected files make the
   non-recursive directory removal fail closed rather than deleting foreign
   data.

---

### Task 1: Clean every dependency-ledger repository fixture

**Files:**

- Modify/Test: `scripts/check-dependency-upgrade-ledger.test.ts`

**Interfaces:**

- Produces:

```ts
function withRepositoryFixture<T>(
  run: (root: string) => T,
  temporaryBase?: string,
): T;
```

- The helper creates and populates one fixture, invokes `run`, and removes the
  exact root recursively in `finally`. The optional base exists only to give
  cleanup regressions private observable state.

- [ ] **Step 1: Capture the current RED root delta**

Snapshot only `bibcode-dependency-ledger-*` roots, run the exact test file, and
diff the snapshots:

```bash
vp test run scripts/check-dependency-upgrade-ledger.test.ts
```

Expected on `36ee0035`: the test assertions pass and ten new roots remain.

- [ ] **Step 2: Write and run a forced-failure cleanup regression**

Add a test that creates a private temporary base, invokes
`withRepositoryFixture`, throws a literal marker inside the callback, catches
that marker, and asserts the private base has no entries before its own
`finally` removes the base. Run the exact test and observe RED because the new
helper is absent or leaves its child root.

The production mutation caught is returning or throwing from the callback
without executing exact-root cleanup.

- [ ] **Step 3: Implement the callback owner and migrate all ten callers**

Create the root inside a `try/finally` owner, populate it with the existing
fixtures, return only through the callback, and call `rmSync(root, {
recursive: true, force: true })` in `finally`. Convert all ten raw callers to
execute their assertions inside the callback. Do not add a module-level root
set or an `afterAll` hook.

- [ ] **Step 4: Run GREEN and verify zero suite delta**

Run the exact file and then the scripts package test command. The injected-base
regression must pass, and a new before/after snapshot must contain zero new
`bibcode-dependency-ledger-*` roots.

---

### Task 2: Clean the seeded-upgrade canonicalization fixture

**Files:**

- Modify/Test: `scripts/seeded-desktop-upgrade-smoke.test.ts`

**Interfaces:**

- No production interface changes. The canonicalization test uses an injected
  private base and one owned child root.

- [ ] **Step 1: Capture the current exact-test RED root delta**

Snapshot `bibcode-upgrade-canonical-*`, run only the canonicalization test, and
diff the snapshots. Expected on `36ee0035`: the assertion passes and one empty
root remains.

- [ ] **Step 2: Make cleanup observable and run RED**

Create a private base for the test, create the canonicalization root beneath
it, perform the real symlink and `realpath` assertion, and assert that the base
is empty after the operation but before the outer base is removed. Run before
adding child cleanup. Expected: FAIL because the child root remains.

- [ ] **Step 3: Add async `finally` ownership and run GREEN**

Wrap the child root's setup/assertion in `try/finally` and call
`NodeFS.promises.rm(root, { recursive: true, force: true })`. Keep a separate
outer `finally` for the private base so a failing assertion also cleans both
levels. Run the exact test, the complete seeded-upgrade test file, and a global
prefix snapshot; all must show zero new roots.

---

### Task 3: Give desktop SSH askpass roots exact leases

**Files:**

- Modify/Test: `apps/desktop/src-tauri/src/ssh.rs`
- Test: `apps/desktop/src-tauri/tests/ssh_public_contract.rs`
- Modify: `docs/architecture/remote.md`

**Interfaces:**

- Produces private types and methods shaped as:

```rust
#[derive(Clone)]
struct SshAskpassLauncher {
    inner: Arc<SshAskpassLauncherInner>,
}

impl SshAskpassLauncher {
    fn create_in(temporary_base: &Path) -> Result<Self, String>;
    fn path(&self) -> &Path;
}

impl SshEnvironmentManager {
    fn askpass_launcher(&self) -> Result<SshAskpassLauncher, String>;
}
```

- `SshEnvironmentManager` stores an immutable temporary base and a
  `Mutex<Weak<SshAskpassLauncherInner>>`. `ManagedSshTunnel` stores a strong
  launcher lease beside its child.

- [ ] **Step 1: Write exact RED lease regressions**

Under a `tempfile::TempDir` base, add tests proving:

- the last launcher lease removes its exact root and leaves the private base
  empty;
- a future retaining the last lease removes the root when aborted and joined;
- an unreachable `ensure_environment` and `disconnect_environment` leave the
  injected base empty after their awaited errors;
- launcher files contain static helper code but not a supplied test password.

Run each by fully qualified exact name and observe RED because the current API
returns an unowned `PathBuf` and uses the process-global temp directory.

- [ ] **Step 2: Implement unique cloneable ownership**

Create one unpredictable `bibcode-ssh-runtime-{pid}-{uuid}` root beneath the
manager's base and then its `bibcode-ssh-askpass` child. Retain the existing
platform scripts and executable mode. On final lease drop, remove only the
known launcher/script files and the now-empty two directories in child-to-root
order. A partial constructor failure uses the same exact cleanup guard.

Resolve concurrent manager requests with a short weak-cache mutex and no
await. If two creators race, retain one live lease and let the losing unique
lease clean itself; never share a root by PID or mutate process environment.

- [ ] **Step 3: Retain leases through process completion and cancellation**

Pass `launcher.path()` to child environment construction while the enclosing
future retains the strong launcher value. Store a clone in
`ManagedSshTunnel`. On disconnect, remove the tunnel from the map, await
`terminate_child`, retain/reuse its launcher through the awaited remote-stop
command, and then release it. Failure, early return, and future abort drop the
stack lease; `kill_on_drop` children lose ownership before or with the helper.

Update the remote architecture document with the exact ephemeral-helper
lifetime and secret boundary.

- [ ] **Step 4: Run focused GREEN at parallel widths**

Run the new exact regressions, the SSH unit module, and
`ssh_public_contract` at default, 8, and 12 threads. Take a before/after prefix
snapshot for each complete desktop package run. Expected: all tests pass and
zero new `bibcode-ssh-runtime-*` roots or SSH child processes survive.

---

### Task 4: Full graph, static gates, report, and independent review

**Files:**

- Update ignored evidence:
  `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Review all tracked Task 9I changes from plan commit through final HEAD.

**Interfaces:**

- Produces zero-root/survivor evidence and a Ready verdict for Task 9I.

- [ ] **Step 1: Run focused package and static validation**

Run:

```bash
vp test run scripts/check-dependency-upgrade-ledger.test.ts
vp test run scripts/seeded-desktop-upgrade-smoke.test.ts
cargo test -p bibcode-desktop -j 2
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
```

Expected: all pass with no new affected-prefix roots or scoped processes.

- [ ] **Step 2: Run one canonical isolated workspace graph**

Create a fresh explicit target beneath the native canonical temporary path and
run one `vp run test` with reliable before/after snapshots of PID, process start
time, full command, and the three affected root prefixes. Do not delete the
thirteen pre-existing roots from the Task 9H run or any unrelated root.

Expected: all nine package tasks pass; the new-root delta for
`bibcode-dependency-ledger-*`, `bibcode-upgrade-canonical-*`, and
`bibcode-ssh-runtime-*` is zero; no scoped process survives. Stop on a
different failure.

- [ ] **Step 3: Request independent read-only review**

Give the reviewer the Task 9H graph evidence, this amendment, base
`36ee0035`, final HEAD, exact RED/GREEN logs, and explicit questions about:

- cleanup after callback error, assertion failure, command error, and future
  cancellation;
- concurrent-manager lease convergence and lock scope;
- helper lifetime relative to SSH child completion/abort and tunnel reuse;
- exact non-recursive cleanup and foreign-file preservation;
- secret persistence, permissions, symlink/collision behavior, and Windows;
- accidental serialization, timeout, public API, manifest, or production
  behavior drift.

Address every Critical or Important finding before Task 9 resumes.

- [ ] **Step 4: Record evidence and review final scope**

Append exact commands, pass counts, duration, root/process deltas, review
verdict, and residual risk to the ignored Task 9 report. Review:

```bash
git diff --stat 36ee0035..HEAD
git diff --check 36ee0035..HEAD
git status --short
```

Expected: only the tracked plan, the two script tests, desktop SSH
implementation/tests, and remote living documentation changed; no generated,
`.codegraph/`, `.repos/`, lockfile, dependency, debug, or unrelated file is
included.
