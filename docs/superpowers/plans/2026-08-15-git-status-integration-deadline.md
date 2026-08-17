# Git Status Integration Deadline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public project-write Git-status integration test deterministic under the parallel workspace graph while proving real event-driven publication before the unchanged 30-second fallback.

**Architecture:** The public integration test begins one absolute 15-second Tokio deadline before sending `subscribeVcsStatus`; subscription setup, both initial status events, the successful write response, and the positive dirty-status event consume the same operation window. The existing deterministic `StatusBroadcaster` owner test remains the concurrency/cancellation contract, and production Git behavior is unchanged.

**Tech Stack:** Rust 2024, Tokio `Instant`/`timeout_at`, Axum/WebSocket RPC integration tests, real Git fixtures.

## Global Constraints

- Do not change production Git scheduling, polling, process execution, cancellation, publication, queues, or timeouts.
- Keep `LOCAL_STATUS_REFRESH_INTERVAL` exactly 30 seconds.
- Use one absolute 15-second test-only deadline beginning before `subscribeVcsStatus` can create the broadcaster owner; the initial clean snapshot, initial `remoteUpdated`, `projects.writeFile` response, and dirty `localUpdated` event must all consume it without a restart.
- Preserve the exact `localUpdated`, request ID `703`, dirty working-tree, and `tracked.txt` assertions.
- Retain the deterministic owner test proving local invalidation starts and publishes while remote refresh is blocked and final subscriber drop cancels the remote owner.
- Do not serialize package tests or Rust harness threads.
- Do not add sleeps, yields, retries, global locks, mocked publication, dependencies, or lockfile changes.
- Stop broad verification on the first distinct failure and diagnose that exact failure before any rerun or repair.

---

### Task 1: Share one absolute public Git-status integration deadline

**Files:**

- Modify: `apps/server/tests/production_git_vcs_rpc.rs:1-20,568-615`
- Test: `apps/server/tests/production_git_vcs_rpc.rs`
- Test: `apps/server/src/git/broadcaster.rs:702-772`

**Interfaces:**

- Consumes: `projects.writeFile`, `subscribeVcsStatus`, production `StatusBroadcaster::notify_local_change`, and the unchanged 30-second `LOCAL_STATUS_REFRESH_INTERVAL`.
- Produces: a single `GIT_STATUS_INTEGRATION_DEADLINE: Duration` and one public operation window beginning before subscription owner creation and ending in the real dirty `localUpdated` event.

- [ ] **Step 1: Preserve the observed RED evidence**

Record the existing fresh graph failure:

```text
vp run test
production_git_vcs_rpc::project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller
a successful project file save should publish Git status within two seconds: Elapsed(())
28 passed; 1 failed
```

The exact pre-fix rerun passed 1/1, classifying the RED as load-sensitive. Do
not rerun the pre-fix full graph merely to reproduce an already preserved
329-second failure.

- [ ] **Step 2: Import the absolute-deadline primitives and define the test budget**

Change the Tokio time import to:

```rust
use tokio::time::{Instant, timeout, timeout_at};
```

After `ISOLATED_GIT_TEST_LOCK`, add:

```rust
const GIT_STATUS_INTEGRATION_DEADLINE: Duration = Duration::from_secs(15);
```

This constant is integration-test-only and remains below the production
30-second fallback.

- [ ] **Step 3: Start the deadline before the public subscription request**

Immediately before `request(&mut status_socket, "703", ...)`, start the fixed
operation window through a test-only helper:

```rust
let (publication_started, publication_deadline) = start_git_status_integration_deadline();
```

Keep request IDs `703` and `704`, payloads, ACKs, and assertions unchanged.

- [ ] **Step 4: Consume the fixed budget through every public milestone**

Wrap subscription, the initial clean snapshot and ACK, the initial
`remoteUpdated` event and ACK, the write request and response, and the dirty
event loop in one `timeout_at(publication_deadline, async { ... })`. Return the
dirty event values from that future. Per-stage receive diagnostics may remain,
but no stage may own or restart the operation budget.

The dirty event loop remains:

```rust
loop {
    let message = next_server_message_for(
        &mut status_socket,
        "event-driven dirty local VCS status after project file save",
    )
    .await;
    if let ServerMessage::Chunk { request_id, values } = message
        && request_id.as_str() == "703"
        && values[0]["_tag"] == "localUpdated"
        && values[0]["local"]["hasWorkingTreeChanges"] == true
    {
        break values;
    }
    send_json(
        &mut status_socket,
        json!({ "_tag": "Ack", "requestId": "703" }),
    )
    .await;
}
```

Retain the existing `tracked.txt` assertion and all WebSocket/server cleanup.

- [ ] **Step 5: Run the exact public integration test**

Run:

```bash
cargo test -p bibcode-server --test production_git_vcs_rpc \
  project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller \
  -- --exact --nocapture
```

Expected: 1 passed; output includes the elapsed publication diagnostic.

- [ ] **Step 6: Run the deterministic owner-level concurrency test**

Run:

```bash
cargo test -p bibcode-server --lib \
  git::broadcaster::tests::local_invalidation_starts_while_remote_refresh_is_blocked \
  -- --exact --nocapture
```

Expected: 1 passed, preserving positive local scan/publication, blocked remote
work, cancellation, and final owner removal assertions.

- [ ] **Step 7: Run the complete affected integration binary at all widths**

Run sequentially:

```bash
cargo test -p bibcode-server --test production_git_vcs_rpc
cargo test -p bibcode-server --test production_git_vcs_rpc -- --test-threads=8
cargo test -p bibcode-server --test production_git_vcs_rpc -- --test-threads=12
```

Expected: every test passes at default, 8, and 12 harness threads.

- [ ] **Step 8: Run focused formatting and Clippy**

Run:

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --test production_git_vcs_rpc -- -D warnings
```

Expected: both exit zero.

- [ ] **Step 9: Commit the test-only repair**

```bash
git add apps/server/tests/production_git_vcs_rpc.rs
git commit -m "test(server): share Git status integration deadline"
```

---

### Task 2: Resume complete branch verification

**Files:**

- Review: `apps/server/tests/production_git_vcs_rpc.rs`
- Review: `apps/server/src/git/broadcaster.rs`
- Review: `apps/desktop/e2e/support/test-project.test.ts`
- Review: `scripts/ci-platform-contract.test.ts`
- Review: `.github/workflows/ci.yml`
- Review: `docs/superpowers/specs/2026-08-15-git-status-integration-deadline-design.md`
- Review: `docs/superpowers/plans/2026-08-15-git-status-integration-deadline.md`

**Interfaces:**

- Consumes: Task 1's absolute test-only deadline and the previously reviewed Windows E2E host-gating repair.
- Produces: fresh package, Rust workspace, static, and final Git evidence for merged HEAD plus both repairs.

- [ ] **Step 1: Run the workspace package graph**

Run as the sole broad owner:

```bash
vp run test
```

Expected: all nine package tasks pass with the Git-status and Windows E2E
contracts included. On a non-Windows host, the `.cmd` execution test is one
expected skip.

- [ ] **Step 2: Run the complete Rust workspace**

After the graph exits, run:

```bash
cargo test --workspace -j 2
```

Expected: all Rust library, integration, binary, and doc tests pass.

- [ ] **Step 3: Run every static gate sequentially**

Run:

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: every command exits zero. Report existing nonfatal diagnostics
separately from command failures.

- [ ] **Step 4: Audit final scope and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -15
```

Confirm no production deadline, fallback interval, concurrency setting,
dependency, lockfile, generated file, or debug output changed.

- [ ] **Step 5: Report platform evidence accurately**

Report macOS-hosted package/workspace/static evidence as native macOS evidence.
Report the simulated Windows environment/filesystem tests and parsed workflow
contract as compatibility evidence. Do not claim the `.cmd` execution passed
until the explicit Windows CI step or a native Windows host runs it.
