# MCP Status Actor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex MCP status discovery and lifecycle updates publish only complete, ordered snapshots scoped to the active provider root.

**Architecture:** Replace the shared `Mutex<McpStatusState>` with one Tokio actor that owns root identity, epoch/generation, committed servers, staged notifications, and refresh waiters. Provider list I/O runs in spawned loader tasks; a single FIFO effect worker publishes snapshot/warning events and completes refresh waiters in order.

**Tech Stack:** Rust, Tokio `mpsc`/`oneshot`, serde_json, existing Codex JSON-RPC connection, existing provider runtime event stream, BTreeMap

## Global Constraints

- Keep the existing exact five MCP states: `connected`, `starting`, `needs-auth`, `disconnected`, and `error`.
- Every `mcp.status.updated` payload is a complete sorted `servers` array.
- While discovery is active, notifications stage in an overlay and do not emit partial snapshots.
- A changed provider root cannot retain or re-emit old-root servers.
- Public refresh during opening joins the active generation and preserves buffered observations.
- Concurrent same-root refreshes coalesce into one bounded list sequence.
- Retain the existing eight-page cap, page size 50, exact `toolsAndAuthOnly` detail, cursor validation, five-second page timeout, and pending-request cancellation cleanup.
- Retain the count-bounded pre-root notification queue maximum of 64.
- Do not add a dependency or a generic actor framework.
- Do not change the web MCP popover or wire contract unless a failing integration test proves a contract defect.
- Do not edit `.repos/`.
- Do not bypass repository Git safety hooks. If commit is blocked, record it and continue with verified unstaged changes.
- Before completion, `vp test`, `vp check`, `vp run typecheck`, and `git diff --check` must pass.

## File Structure

### New file

- `apps/server/src/provider/codex/mcp_status.rs` — actor state machine, mailbox handle/commands, effects, official snapshot loader, normalization, and pure concurrency tests.

### Existing files with focused changes

- `apps/server/src/provider/codex/mod.rs` — declare the internal MCP status module.
- `apps/server/src/provider/codex/runtime.rs` — replace lock helpers with actor messages, run the FIFO effect worker, and retain a small end-to-end integration suite.
- `apps/server/src/provider/codex/protocol.rs` — only if the actor integration test exposes missing request cancellation cleanup; preserve the current scoped waiter behavior.
- `apps/server/src/production/provider_runtime.rs` — projection integration assertions only; production behavior should remain unchanged.
- `apps/server/tests/production_provider_runtime.rs` — one real-runtime complete-snapshot ordering regression.

---

### Task 1: Build the Single-Owner MCP State Machine

**Files:**
- Create: `apps/server/src/provider/codex/mcp_status.rs`
- Modify: `apps/server/src/provider/codex/mod.rs`
- Test: unit tests in `mcp_status.rs`

**Interfaces:**
- Produces: `McpStatusHandle` used by `CodexSessionRuntime`.
- Produces: `run_actor(receiver, effects_tx)` and `McpStatusEffect` consumed by Task 2.
- Produces: `McpServerStatus`, `McpLoadResult`, and normalized snapshot helpers moved from `runtime.rs`.

- [ ] **Step 1: Write a failing actor test for notification staging**

Construct the mailbox/effect channels and exercise the precise boundary:

```rust
let (handle, receiver) = McpStatusHandle::channel(64);
let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
let actor = tokio::spawn(run_actor(receiver, effects_tx));

let opening = handle.begin_open().await.unwrap();
handle.notification(Some("root-1".into()), server("before", Connected)).await.unwrap();
handle.bind_root("root-1".into()).await.unwrap();

let McpStatusEffect::Load { epoch, generation, root } = effects_rx.recv().await.unwrap() else {
    panic!("expected list load");
};
assert_eq!(root, "root-1");

handle.notification(Some("root-1".into()), server("during", Starting)).await.unwrap();
assert!(effects_rx.try_recv().is_err());

handle.load_finished(epoch, generation, Ok(map([server("seed", Connected)]))).await.unwrap();
let McpStatusEffect::Snapshot(snapshot) = effects_rx.recv().await.unwrap() else {
    panic!("expected complete snapshot");
};
assert_eq!(names(&snapshot), vec!["before", "during", "seed"]);
drop(opening);
handle.shutdown().await.unwrap();
actor.await.unwrap();
```

- [ ] **Step 2: Run the actor test and verify the module is absent**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::codex::mcp_status -- --nocapture`

Expected: FAIL because `mcp_status` does not exist.

- [ ] **Step 3: Define the exact mailbox and effect interfaces**

Implement:

```rust
#[derive(Clone)]
pub(crate) struct McpStatusHandle {
    sender: mpsc::Sender<McpStatusCommand>,
}

pub(crate) enum McpStatusEffect {
    Load { epoch: u64, generation: u64, root: String },
    Snapshot(Vec<McpServerStatus>),
    Warning(String),
    Complete(Vec<oneshot::Sender<Result<(), String>>>),
}

enum McpStatusCommand {
    BeginOpen { done: oneshot::Sender<Result<(), String>> },
    BindRoot { root: String },
    Refresh { done: oneshot::Sender<Result<(), String>> },
    Notification { root: Option<String>, server: McpServerStatus },
    LoadFinished { epoch: u64, generation: u64, result: McpLoadResult },
    Shutdown { done: oneshot::Sender<()> },
}
```

`begin_open` and `refresh` return completion receivers rather than waiting inside the actor call, allowing runtime startup to bind the root after the provider response.

- [ ] **Step 4: Implement actor-owned state without a mutex**

The state contains:

```rust
struct McpStatusState {
    root: Option<String>,
    epoch: u64,
    generation: u64,
    in_flight: Option<InFlightRefresh>,
    servers: BTreeMap<String, McpServerStatus>,
    pre_root: VecDeque<(Option<String>, McpServerStatus)>,
}

struct InFlightRefresh {
    epoch: u64,
    generation: u64,
    opening: bool,
    root_changed: bool,
    overlay: BTreeMap<String, McpServerStatus>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}
```

Only `run_actor` mutates this value.

- [ ] **Step 5: Implement opening, root binding, and refresh coalescing**

- `BeginOpen`: create or join one opening generation; do not clear a current overlay for a duplicate caller.
- `BindRoot`: if changed, increment epoch and clear committed old-root servers; filter the pre-root queue to matching/app-scoped notifications; emit one `Load` effect.
- `Refresh` during any in-flight generation: append its waiter and emit no load.
- `Refresh` while idle: start one same-root generation and emit one load.

- [ ] **Step 6: Implement overlay-only in-flight notifications**

Before root binding, retain only the newest 64 observations. During a load, apply matching observations only to `in_flight.overlay`. After completion, apply matching notifications to the committed `servers` map and emit a complete sorted snapshot.

- [ ] **Step 7: Implement tagged load completion and failure effects**

Ignore a load result unless both epoch and generation match the active refresh. On success, replace baseline, overlay staged observations, then send `Snapshot` and `Complete` effects. On failure:

- same root: retain baseline and apply overlay;
- changed/new root: use overlay only;
- emit `Snapshot` only when the visible complete map changed or old-root entries must be cleared;
- emit `Warning`, then `Complete`.

- [ ] **Step 8: Add changed-root and overlap tests**

Use distinct names:

```rust
assert_eq!(names(&new_root_failure_snapshot), vec!["new-only"]);
assert!(!names(&new_root_failure_snapshot).contains(&"old-only"));
assert_eq!(load_effect_count, 1);
```

Also assert an old epoch's late success produces no effect.

- [ ] **Step 9: Run actor unit tests**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::codex::mcp_status -- --nocapture`

Expected: PASS.

- [ ] **Step 10: Commit the pure MCP state owner**

```powershell
git add apps/server/src/provider/codex/mcp_status.rs apps/server/src/provider/codex/mod.rs
git commit -m "refactor: add single-owner MCP status actor"
```

If blocked, do not bypass the safety hook.

---

### Task 2: Wire Codex Runtime I/O Through Ordered Effects

**Files:**
- Modify: `apps/server/src/provider/codex/runtime.rs:43-46,146-186,301-369,400-732,1519-1526,1824-1845,2050-2135,2295-3605`
- Modify: `apps/server/src/provider/codex/mcp_status.rs`
- Test: runtime integration tests in both files

**Interfaces:**
- Consumes: Task 1 handle, commands, and effects.
- Produces: `run_mcp_status_effects(runtime, connection, effects_rx)`.
- Preserves: existing JSON-RPC list request/pagination/timeout behavior.

- [ ] **Step 1: Add a failing runtime test for exact effect order**

Drive thread open, a matching pre-response notification, a list failure, and readiness. Assert:

```rust
assert_eq!(event_types, vec![
    "session.connecting",
    "mcp.status.updated",
    "runtime.warning",
    "session.ready",
]);
assert_eq!(snapshot_names, vec!["new-root-server"]);
```

Use a different old-root server to prove it is absent.

- [ ] **Step 2: Run the focused runtime test and verify current lock behavior fails**

Run: `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server provider::codex::runtime::tests::mcp_status_actor -- --nocapture`

Expected: FAIL until runtime routes through the actor.

- [ ] **Step 3: Replace `RuntimeInner.mcp_status` with the actor handle**

Remove `Mutex<McpStatusState>` and all direct helpers that mutate it. During construction:

1. create `McpStatusHandle::channel(MCP_STATUS_PRE_ROOT_BUFFER_LIMIT)`;
2. create the unbounded effect channel;
3. spawn `run_actor`;
4. spawn one `run_mcp_status_effects` task;
5. store cancellation/task handles so runtime shutdown joins them.

Use the runtime's existing cancellation token. Shutdown cancels the effect worker, closes the actor mailbox, and awaits both tasks; do not leave a detached task or a strong-reference cycle through a cloned runtime.

- [ ] **Step 4: Implement the FIFO effect worker**

Process effects one at a time:

```rust
match effect {
    McpStatusEffect::Load { epoch, generation, root } => {
        let handle = handle.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            let result = refresh_mcp_status_snapshot(&connection, &root).await;
            let _ = handle.load_finished(epoch, generation, result).await;
        });
    }
    McpStatusEffect::Snapshot(servers) => {
        runtime.emit("mcp.status.updated", None, None, json!({"servers": servers})).await;
    }
    McpStatusEffect::Warning(detail) => {
        runtime.emit("runtime.warning", None, None, json!({"message": detail})).await;
    }
    McpStatusEffect::Complete(waiters) => {
        for waiter in waiters { let _ = waiter.send(Ok(())); }
    }
}
```

The load effect only spawns; it never blocks later notification commands. Snapshot/warning effects await publication in FIFO order.

- [ ] **Step 5: Route start/reconnect/manual refresh through the handle**

For thread open/reconnect, call `begin_open`, issue `thread/start` or `thread/resume`, bind the returned root, await the completion receiver, then emit `session.ready`. Public `refresh_mcp_status` creates/joins a refresh and awaits its completion receiver.

- [ ] **Step 6: Route lifecycle notifications through the handle**

Keep official notification parsing and normalization, but replace every direct state mutation with:

```rust
self.inner
    .mcp_status
    .notification(notification.thread_id, normalized)
    .await?;
```

Foreign roots remain filtered by actor state. App-scoped missing/null roots remain valid on the per-runtime connection.

- [ ] **Step 7: Move snapshot loading and official mapping to `mcp_status.rs`**

Move the one canonical list implementation and its mapping helpers. Preserve exactly:

- `threadId` and `limit: 50`;
- `detail: "toolsAndAuthOnly"`;
- opaque cursor echo;
- eight-page terminal/nonterminal distinction;
- repeated/blank cursor rejection;
- exact `oAuth` spelling;
- five-second timeout per page with pending waiter cleanup.

- [ ] **Step 8: Remove obsolete lock/generation helpers and adjust tests**

Delete `begin_mcp_status_refresh`, `bind_mcp_status_refresh_to_root`, `buffer_mcp_status_before_root`, `replace_mcp_servers`, `finish_mcp_status_refresh_failure`, and direct `update_mcp_status`. Retain official-shape pagination tests against the moved loader and end-to-end event tests against runtime.

- [ ] **Step 9: Run Codex MCP runtime/protocol tests**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::codex::mcp_status -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::codex::runtime -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::codex::protocol -- --nocapture
```

Expected: PASS.

- [ ] **Step 10: Commit runtime actor wiring**

```powershell
git add apps/server/src/provider/codex/mcp_status.rs apps/server/src/provider/codex/runtime.rs apps/server/src/provider/codex/protocol.rs
git commit -m "fix: serialize MCP snapshots through one actor"
```

---

### Task 3: Prove Multi-thread Ordering and Production Projection

**Files:**
- Modify: `apps/server/src/provider/codex/mcp_status.rs`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/production/provider_runtime.rs:1697-1744,6100-6150`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Verify only: `packages/contracts/src/providerRuntime.ts`
- Verify only: `packages/contracts/src/providerRuntime.test.ts`
- Verify only: `apps/web/src/components/chat/McpStatusPopover.tsx`
- Verify only: `apps/web/src/components/chat/McpStatusPopover.test.tsx`

**Interfaces:**
- Consumes: Tasks 1-2 actor/runtime integration.
- Produces: deterministic multi-thread race coverage and real provider-instance projection proof.

- [ ] **Step 1: Add a deterministic multi-thread publication test**

Use `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Add a test-only barrier in the effect worker before publishing snapshot A. While blocked, send a notification/load completion that commits snapshot B. Release the barrier and assert emitted order is A then B and the final emitted snapshot equals actor state B.

- [ ] **Step 2: Add open-versus-refresh request-count coverage**

Begin opening, call public refresh twice, bind root, and complete discovery. Assert the duplex fixture received exactly one first-page request and every caller completion resolved after the same snapshot.

- [ ] **Step 3: Add changed-root failure coverage with distinct inventories**

Seed `old-only`, reopen on a new root, stage `new-only`, fail list discovery, and assert exact order:

```rust
assert_eq!(snapshot_names, vec!["new-only"]);
assert_eq!(event_types, vec!["mcp.status.updated", "runtime.warning", "session.ready"]);
```

- [ ] **Step 4: Add production projection integration assertion**

Send two complete actor snapshots through the real provider runtime projection with the selected provider instance ID. Assert the stored/UI-facing activity order remains old then new and the latest snapshot is the second full map. Confirm no non-MCP activity has `providerInstanceId` overwritten.

- [ ] **Step 5: Re-run contract and popover tests without changing their API**

Run:

```powershell
vp test run packages/contracts/src/providerRuntime.test.ts packages/contracts/src/server.test.ts apps/web/src/components/chat/McpStatusPopover.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: PASS with no contract or component change. If a failure exposes malformed server payload, fix the server actor output rather than widening the wire schema.

- [ ] **Step 6: Run all focused Rust MCP suites**

Run:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::codex::mcp_status -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider::codex::runtime -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::provider_runtime -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_provider_runtime mcp -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Run repository-wide required gates**

Run:

```powershell
vp test
vp check
vp run typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 8: Commit final MCP race coverage**

```powershell
git add apps/server/src/provider/codex/mcp_status.rs apps/server/src/provider/codex/runtime.rs apps/server/src/production/provider_runtime.rs apps/server/tests/production_provider_runtime.rs
git commit -m "test: prove complete ordered MCP snapshots"
```

If the safety hook blocks the commit, leave the passing worktree intact and report it.
