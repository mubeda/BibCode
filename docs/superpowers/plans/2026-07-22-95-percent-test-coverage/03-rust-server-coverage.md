# Rust Server Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the complete Rust workspace to at least 95% regions, functions, and lines by covering the server's production adapters, orchestration, authentication, persistence, Git, source control, terminal, workspace, diagnostics, and lifecycle behavior.

**Architecture:** Extend the server's existing in-module and integration harnesses so each domain exercises successful workflows, typed decoder failures, cancellation, cleanup, and stale concurrency outcomes. Use temporary repositories/directories, loopback HTTP servers, in-memory services, and controlled child fixtures; reserve production refactors for genuine dependency seams used by the live path.

**Tech Stack:** Rust 1.97.1, Cargo, Tokio, Axum, Rusqlite, Git CLI fixtures, portable PTY, loopback TCP/HTTP, `cargo-llvm-cov`.

## Global Constraints

- Repository-wide regions, functions, and lines must each be at least 95%; no per-module or per-crate gate is added.
- Workspace baseline is 89.92% regions, 88.78% functions, and 92.07% lines, requiring approximately 4,743 regions, 418 functions, and 1,977 lines at the current denominator.
- Preserve the complete Cargo workspace and all-targets inventory.
- Do not add coverage attributes, test-only production branches, generated invocations, or assertions that only prove a function was called.
- Temporary Git repositories must set their own identity. Tests may not depend on user Git configuration.
- Network tests bind loopback port `0`, use scripted peers, and apply bounded timeouts.
- Process and PTY tests use controlled fixture programs, explicitly cancel, and reap every child.
- Persistence tests use temporary directories/databases and verify transactional state after failures.
- Keep Rust thresholds at 90 until the final policy plan.
- Never commit `target/llvm-cov*` or profile artifacts.

---

## Server Hotspot Order

The initial largest files are `production/git_vcs.rs`, `production/provider_runtime.rs`, `orchestration/engine.rs`, `git/repository.rs`, `production/control.rs`, `production/provider_inventory.rs`, `production/orchestration_effects.rs`, `auth/service.rs`, `terminal/pty.rs`, `terminal/manager.rs`, `source_control/pull_request.rs`, `auth/secret_store.rs`, `lifecycle.rs`, `production/server_terminal.rs`, and `production/connect_mcp.rs`.

### Task 1: Complete Git Repository and RPC VCS Behavior

**Files:**

- Modify: `apps/server/src/production/git_vcs.rs`
- Modify: `apps/server/src/git/repository.rs`
- Modify: `apps/server/src/git/process.rs`
- Test in place: each file's existing `tests` module.

**Interfaces:**

- Consumes: `GitVcsRpcServices`, typed RPC decoders, temporary repositories, worktree reservation, editor launch planning, and Git process runner.
- Produces: covered unary RPC methods, repository lifecycle, worktree collision/cancellation cleanup, ref/remote edge cases, and bounded command failures.

- [ ] **Step 1: Add a shared temporary repository initializer inside each relevant test module**

Use the existing `git` helper and configure identity locally:

```rust
fn initialize_repository() -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("temporary repository");
    git(directory.path(), &["init", "--initial-branch=main"]);
    git(directory.path(), &["config", "user.name", "T4Code Test"]);
    git(directory.path(), &["config", "user.email", "test@t4code.invalid"]);
    std::fs::write(directory.path().join("README.md"), "initial\n").expect("seed file");
    git(directory.path(), &["add", "README.md"]);
    git(directory.path(), &["commit", "-m", "initial"]);
    directory
}
```

Reuse an equivalent existing helper if already present; do not create duplicate initialization logic in the same module.

- [ ] **Step 2: Cover all Git/VCS unary success variants**

Extend `native_git_vcs_service_covers_repository_lifecycle_and_validation_paths` or split it into independently named workflows for status, branches, remotes, fetch, pull, push, stage, unstage, discard, commit, create/switch/delete branch, worktree create/remove, diff, show, editor open, and pull-request worktree response. Assert typed response tags and repository state using Git commands.

- [ ] **Step 3: Complete typed decoder and operational failure rows**

For every unary tag, preserve the existing malformed-payload loop and add missing required field, wrong scalar type, blank path/ref, oversized string, repository absent, detached HEAD, merge conflict, dirty worktree, missing remote, non-fast-forward, destination collision, editor spawn failure, command timeout/cancellation, and invalid UTF-8 output where supported. Assert structured error tag, safe message, and unchanged repository state after transactional failures.

- [ ] **Step 4: Complete repository worktree reservation races**

Test configured and default base directories; sanitized branch collisions; existing empty/nonempty destination; two concurrent reservations; detached preparation failure; canceled preparation; canceled checkout; competing checkout; cleanup only for owned paths; and cleanup failure. Use a barrier or oneshot gate, not sleeps.

- [ ] **Step 5: Run and commit the Git cohort**

```bash
cargo test -p bibcode-server production::git_vcs::tests -- --nocapture
cargo test -p bibcode-server git::repository::tests -- --nocapture
cargo test -p bibcode-server git::process::tests -- --nocapture
git add apps/server/src/production/git_vcs.rs apps/server/src/git/repository.rs apps/server/src/git/process.rs
git commit -m "test: cover server Git and VCS behavior"
```

Expected: focused tests pass, temporary worktrees are removed, and no global Git settings are read or written.

### Task 2: Complete Provider Runtime, Inventory, and Control Behavior

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/production/provider_inventory.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/provider/cursor/runtime.rs`
- Modify: `apps/server/src/provider/grok/runtime.rs`
- Modify: `apps/server/src/provider/opencode/runtime.rs`

**Interfaces:**

- Consumes: native provider adapters, supervisor, executable resolver, inventory probes, settings/keybinding control services, scripted provider children, and cancellation tokens.
- Produces: covered command routing, provider lifecycle, inventory merge/default logic, settings transactions, probe generation ordering, and adapter failure behavior.

- [ ] **Step 1: Cover provider selection and command parsing tables**

Add rows for absent selection, canonical selection, legacy binary setting, explicit instance override, provider default, unknown provider, unknown model, plain text resembling a command, malformed command, every native command, and provider-specific capability fallback. Assert exact adapter, model, command, and residual prompt.

- [ ] **Step 2: Complete executable and child lifecycle cases**

Cover explicit absolute/relative files; bare command in supplied PATH; missing/inaccessible CWD; no PATH; platform shim precedence; non-executable file; launch error; child exits before ready; child exits after attribution; cancellation; supervisor shutdown; consuming child releases registration; concurrent sessions; unsupported action; and redacted provider error. Use temporary executable fixtures and existing scripted adapters.

- [ ] **Step 3: Complete inventory merge and probe outcomes**

For Codex, Claude, Cursor, Grok, and OpenCode, cover quick/rich probe success, empty, timeout, malformed output, partial/non-authoritative data, authenticated/required-auth states, saved defaults before live discovery, configured plus legacy instances, environment redaction, semantic version normalization, commands/skills/agents, hooks disabled, and authoritative clear. Assert stable provider JSON snapshots.

- [ ] **Step 4: Complete control service transactions and streams**

Cover settings read, full replace, partial patch, unknown-key preservation, fractional interval, malformed/schema-invalid input, write failure, two concurrent nonoverlapping patches, keybinding create/update/delete/reset, invalid chord, stream initial value/update/cancel, probe generation stale completion, failed capabilities retaining models, disabled replacement, and runtime trace diagnostics. Assert file bytes are unchanged on failed validation and no event is published for rejected transactions.

- [ ] **Step 5: Run and commit the provider cohort**

```bash
cargo test -p bibcode-server production::provider_runtime::tests -- --nocapture
cargo test -p bibcode-server production::provider_inventory::tests -- --nocapture
cargo test -p bibcode-server production::control::tests -- --nocapture
cargo test -p bibcode-server provider:: -- --nocapture
git add apps/server/src/production/provider_runtime.rs apps/server/src/production/provider_inventory.rs apps/server/src/production/control.rs apps/server/src/provider
git commit -m "test: cover provider runtime and control paths"
```

Expected: no installed provider CLI, global PATH mutation, or user settings are required.

### Task 3: Complete Orchestration, Authentication, Persistence, and Lifecycle

**Files:**

- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/orchestration_effects.rs`
- Modify: `apps/server/src/persistence/database.rs`
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/persistence/state_files.rs`
- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/auth/secret_store.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/logging.rs`

**Interfaces:**

- Consumes: orchestration projectors/effects, temporary state store, auth service, pairing/session/websocket credentials, atomic secret store, and server runtime observer/shutdown handles.
- Produces: covered event projection, bootstrapping, transaction rollback, auth race/expiry/revocation, secret cleanup, and lifecycle failure behavior.

- [ ] **Step 1: Complete orchestration projection variants**

Add event tables for every projector event type with valid payload, missing field, wrong type, unknown forward-compatible field, duplicate event, out-of-order event, missing predecessor, already-resolved approval, corrupt cached root, lexical root identity, and injected projector failure. Assert aggregate state, emitted effects, and structured `OrchestrationError`.

- [ ] **Step 2: Complete bootstrap/effect lifecycle cases**

Cover no bootstrap effects, setup success/failure/cancel, checkpoint create/restore/remove, existing/new worktree, cleanup thread resources, remove worktree success/failure, launch setup script, stale completion, and concurrent bootstrap. Assert cleanup is attempted once, worktree ownership is respected, and canceled operations do not publish ready state.

- [ ] **Step 3: Complete persistence transactions**

Use temporary databases/directories for create/read/update/delete, missing row, duplicate key, pagination boundaries, malformed persisted JSON, transaction rollback, concurrent writer, busy/locked database mapping, migration from every supported prior version, reopen after commit, and repository I/O error. Assert committed data and indexes after reopening the store.

- [ ] **Step 4: Complete authentication and secret-store boundaries**

Cover proof pairing, client access allow/revoke, current/stale session views, pairing single-use race, expired pairing, session parent rejection, scope parsing, missing/wrong scope, ticket expiry, ticket replay, revocation, credential pruning/cap, secret missing/create/reuse/replace/concurrent create, unsafe names, directory collision, corrupt/empty secret, temporary-write failure, rename failure, and restrictive Unix mode. Assert no secret value appears in error/debug output.

- [ ] **Step 5: Complete lifecycle and logging variants**

Test headless/default UI observer selection, production/fallback service build, startup failure before/after resource creation, access-state publication, shutdown success, shutdown with multiple cleanup failures, repeated shutdown, dropped guard, logging filter valid/invalid, file/stdout destinations, nonblocking writer flush, and tracing initialization idempotence.

- [ ] **Step 6: Run and commit the stateful cohort**

```bash
cargo test -p bibcode-server orchestration::engine::tests -- --nocapture
cargo test -p bibcode-server production::orchestration_effects::tests -- --nocapture
cargo test -p bibcode-server persistence:: -- --nocapture
cargo test -p bibcode-server auth:: -- --nocapture
cargo test -p bibcode-server lifecycle::tests -- --nocapture
cargo test -p bibcode-server logging::tests -- --nocapture
git add apps/server/src/orchestration apps/server/src/production/orchestration_effects.rs apps/server/src/persistence apps/server/src/auth apps/server/src/lifecycle.rs apps/server/src/logging.rs
git commit -m "test: cover orchestration auth and persistence"
```

Expected: all tests pass on a fresh temporary state root and leave no database lock or background task.

### Task 4: Complete Terminal and Server-Terminal Behavior

**Files:**

- Modify: `apps/server/src/terminal/pty.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `apps/server/src/terminal/history.rs`
- Modify: `apps/server/src/terminal/model.rs`
- Modify: `apps/server/src/terminal/osc.rs`
- Modify: `apps/server/src/production/server_terminal.rs`

**Interfaces:**

- Consumes: portable PTY backend, process ownership/cleanup, terminal manager generation state, history/metadata, RPC payload conversions, and wire adapters.
- Produces: covered executable resolution, stream/write/resize/exit, spawn/close races, bounded history, typed payload rejection, and cleanup reporting.

- [ ] **Step 1: Complete executable and launch-plan rows**

Cover absolute, relative, multi-component, and bare executable; empty/missing PATH; relative PATH anchored to terminal CWD; Windows PATHEXT/shim rows; `.cmd`/`.bat` quoting and control-character rejection; PowerShell/native direct launch; default/explicit TERM; exact args/CWD/environment; missing executable before PTY open; and inaccessible CWD.

- [ ] **Step 2: Complete PTY stream and failure behavior**

Use controlled fixture processes for input/output, resize, normal exit, nonzero exit, kill live process group, setup failure, waiter-spawn failure, child-killer clone failure, poisoned writer/resize/killer locks, writer closed, duplicate kill, and drop cleanup. Assert output order, exit state, and process disappearance with bounded waits.

- [ ] **Step 3: Complete manager generation and ownership races**

Cover missing-session attach, create-on-attach, duplicate open, restart-if-not-running, close during spawn, abort before registration, close during metadata inspection, exit during identity registration, stale output after close/reopen, structured command failure without shell fallback, history survive/clear/restart, metadata claim/release, shutdown attempts every owner, and multiple cleanup failures. Assert generation tokens prevent resurrection.

- [ ] **Step 4: Complete server-terminal payload and wire variants**

Cover command as string/object/array/null; blank/trimmed Unicode; UTF-16 boundary exact/over; argument not trimmed; dimensions required/optional; invalid rows/cols; attach/start/restart/close/write/resize; current/history every process variant; independent claimed roots; malformed/nonobject payload; bounded/redacted spawn error; cancellation; and callback stream shutdown.

- [ ] **Step 5: Run and commit the terminal cohort**

```bash
cargo test -p bibcode-server terminal:: -- --nocapture
cargo test -p bibcode-server production::server_terminal::tests -- --nocapture
git add apps/server/src/terminal apps/server/src/production/server_terminal.rs
git commit -m "test: cover terminal lifecycle and wire behavior"
```

Expected: every fixture process is reaped and no PTY or terminal owner remains registered.

### Task 5: Complete Source Control, Workspace, MCP, Preview, and Process Boundaries

**Files:**

- Modify: `apps/server/src/source_control/pull_request.rs`
- Modify: `apps/server/src/source_control/discovery.rs`
- Modify: `apps/server/src/workspace/service.rs`
- Modify: `apps/server/src/workspace/entries.rs`
- Modify: `apps/server/src/workspace/paths.rs`
- Modify: `apps/server/src/workspace/rpc.rs`
- Modify: `apps/server/src/workspace/search.rs`
- Modify: `apps/server/src/workspace/watcher.rs`
- Modify: `apps/server/src/production/connect_mcp.rs`
- Modify: `apps/server/src/production/connect_mcp/tests.rs`
- Modify: `apps/server/src/production/workspace_preview.rs`
- Modify: `apps/server/src/preview/mod.rs`
- Modify: `apps/server/src/process/background.rs`
- Modify: `apps/server/src/process/cleanup.rs`
- Modify: `apps/server/src/process/executable.rs`
- Modify: `apps/server/src/process/runner.rs`
- Modify: `apps/server/src/process/shell.rs`
- Modify: `apps/server/src/process/supervised.rs`
- Modify: `apps/server/src/diagnostics/registry.rs`
- Modify: `apps/server/src/diagnostics/trace.rs`

**Interfaces:**

- Consumes: loopback pull-request providers, workspace semaphore/filesystem, Connect MCP route service, preview runtime, supervised processes, and diagnostics registry.
- Produces: covered HTTP pagination/auth/error/cancel, workspace concurrency/FS failure, MCP link lifecycle, preview cleanup, process shutdown, and diagnostic aggregation.

- [ ] **Step 1: Complete pull-request provider HTTP matrices**

For GitHub, GitLab, Azure, and Bitbucket, cover resolve/current/create success; HTTPS/SSH remote parsing; explicit ref; current branch; numeric path segments; pagination; different-origin/downgrade/port rejection; bearer/basic auth; malformed next URL; 401/403/404/429/500; invalid JSON; missing fields; stalled response headers/body cancellation; CLI spawn/nonzero/malformed output; and unknown provider. Assert no credential crosses an origin boundary.

- [ ] **Step 2: Complete workspace service and watcher behavior**

Cover file/directory create/read/write/rename/delete; overwrite policy; missing path; root and traversal rejection; symlink escape; invalid UTF-8/binary; pagination/search boundaries; semaphore close; concurrency limit; permission and directory/file mismatch; watcher create/modify/remove/rename/overflow; cancellation; and cleanup. Assert all returned paths are workspace-relative and normalized.

- [ ] **Step 3: Complete Connect MCP route behavior**

In `production/connect_mcp/tests.rs`, cover route/method mismatch; bad JSON; unauthorized; conflict; internal error; relay config create/read/replace/clear; link state; unlink idempotence; health success/failure; credential mint success/expiry/invalid material; MCP GET/POST/DELETE; status/header/body forwarding; secret read/write failure; missing required link material; request cancellation; and redaction. Assert exact status, error tag, and safe response body.

- [ ] **Step 4: Complete preview, process, and diagnostics reserve**

Cover workspace preview create/reuse/stop/failure/stale completion; invalid root/URL; process spawn/output cap/timeout/cancel/kill-tree/cleanup failure; background supervisor restart and shutdown; executable and shell resolution; diagnostic contributor success/failure/timeout, deterministic ordering, redaction, archive bounds, and partial bundle behavior.

- [ ] **Step 5: Run and commit the boundary cohort**

```bash
cargo test -p bibcode-server source_control:: -- --nocapture
cargo test -p bibcode-server workspace:: -- --nocapture
cargo test -p bibcode-server production::connect_mcp::tests -- --nocapture
cargo test -p bibcode-server preview:: -- --nocapture
cargo test -p bibcode-server process:: -- --nocapture
cargo test -p bibcode-server diagnostics:: -- --nocapture
git add apps/server/src/source_control apps/server/src/workspace apps/server/src/production/connect_mcp.rs apps/server/src/production/connect_mcp apps/server/src/production/workspace_preview.rs apps/server/src/preview apps/server/src/process apps/server/src/diagnostics
git commit -m "test: cover server service boundaries"
```

Expected: no live provider API, MCP relay, fixed port, or workspace outside a temporary root is used.

### Task 6: Measure the Workspace, Exhaust the Reserve, and Prove 95%

**Files:**

- Modify tests for the ordered reserve only when the current report shows uncovered stable behavior.
- Generate locally: `target/llvm-cov-report.json`

**Interfaces:**

- Consumes: completed desktop and server cohorts plus fresh workspace instrumentation.
- Produces: a complete report with regions, functions, and lines each at least 95.20% before policy changes.

- [ ] **Step 1: Run a clean all-targets workspace report**

```bash
RUSTUP_TOOLCHAIN_NAME="$(rustup show active-toolchain | awk '{print $1}')"
RUSTUP_TOOLCHAIN_ROOT="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc --print sysroot)"
RUSTUP_TOOLCHAIN_HOST="$(rustup run "$RUSTUP_TOOLCHAIN_NAME" rustc -vV | sed -n 's/^host: //p')"
export LLVM_PROFDATA="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-profdata"
export LLVM_COV="$RUSTUP_TOOLCHAIN_ROOT/lib/rustlib/$RUSTUP_TOOLCHAIN_HOST/bin/llvm-cov"
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov clean --workspace
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov --workspace --all-targets --no-report --jobs 1
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --json --output-path target/llvm-cov-report.json
LLVM_PROFDATA="$LLVM_PROFDATA" LLVM_COV="$LLVM_COV" cargo llvm-cov report --summary-only
```

Expected: every instrumented test passes and JSON plus summary reports are produced.

- [ ] **Step 2: Consume the remaining server reserve in fixed domain order**

Rank by uncovered regions first, then functions, then lines. For stable behavior still uncovered, use this order:

1. `apps/server/src/production/runtime.rs`: service build success/failure, startup cancellation, shutdown aggregation.
2. `apps/server/src/production/relay.rs` or the current relay production module: link/reconnect/auth/cancel/error.
3. `apps/server/src/http.rs` and `apps/server/src/auth/http.rs`: routes, authentication, body bounds, WebSocket upgrade, cancellation.
4. `apps/server/src/diagnostics/`: registry concurrency, redaction, archive partial failure.
5. `apps/server/src/telemetry/`: enable/disable, exporter failure, flush/shutdown idempotence.
6. `apps/server/src/review/`: empty/populated diff, comment lifecycle, invalid location.
7. residual provider protocol modules, ordered Codex, Claude, Cursor, Grok, OpenCode.
8. residual persistence repositories, ordered by uncovered regions.

Each added test must assert a public result, persisted state, emitted event, typed error, or cleanup guarantee. Re-run full workspace coverage after each reserve file.

- [ ] **Step 3: Assert the implementation margin from the summary**

Read the `TOTAL` row from `cargo llvm-cov report --summary-only`. Continue reserve work until regions, functions, and lines are each at least 95.20%. Do not round a displayed 94.99% or an unrounded value below 95.20% upward.

- [ ] **Step 4: Run the complete Rust suite and commit**

```bash
cargo test --workspace --all-targets
git add apps/server/src apps/server/tests apps/desktop/src-tauri/src
git status --short
git commit -m "test: reach 95 percent Rust coverage"
```

Expected: all Rust targets pass, only intentional code/tests are staged, and coverage artifacts remain ignored.
