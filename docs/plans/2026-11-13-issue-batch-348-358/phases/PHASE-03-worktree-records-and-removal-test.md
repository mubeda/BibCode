# Phase 3: Worktree creation records and the removal drain test

- Goal: the creation-record fixes (R31 to R34) and the deterministic drain test (R13) land with failing-first tests, an audit event for both creation-rollback arms, and the recorded limits as comments.
- Round: 1
- Depends on: none
- Owns: `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/diagnostics/profiler/worktree_audit.rs`, `apps/server/src/persistence/repositories.rs`, `apps/server/tests/repositories.rs`, `apps/server/src/production/orchestration_effects.rs` (only the caller of `record_worktree_creation`), `apps/server/tests/profiler_worktree_audit.rs`, `apps/server/src/mcp/tools/worktrees.rs` (header comment only)
- Must not touch: `docs/skills/bibcode-profiler/references/events.md` (Phase 9 documents `create-rollback`), `apps/server/src/git/**`, `apps/server/src/source_control/**`, `apps/server/src/runtime.rs`
- Skills: `tdd` (every behavior task is red-green), `mstack-diagnose` (the flaky test task needs a proven cause), `bibcode-profiler` (the audit event and the Profiler coverage line)
- Read first: `AGENTS.md` (completion rules, profiler coverage, sensitive data), `docs/architecture/overview.md` section "Profiler" (events and findings rules), `spec.md` in this plan folder (D9, D10, R13, R31 to R34)
- Checkpoint: `cargo test -p bibcode-server --lib -- worktree_audit removal_ creation_record create_rollback` and `cargo test -p bibcode-server --test repositories` and `cargo test -p bibcode-server --test profiler_worktree_audit` exit 0; `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings` exit 0

Writers set `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_BUILD_JOBS=3` and put the pinned 1.98.1 toolchain first on PATH. All tasks edit `worktree_catalog_rpc.rs`, so one writer runs them in order. The 50 loaded runs and the 12 Windows VM suite runs for R13 belong to Phase 8.

## Tasks

### Task 3.1: Make the drain test wait on the condition

- Satisfies: R13. Scenario: the test passes when the removal is delayed 2.5 seconds before its drain, and the old test fails there with `bounded admission drain: Elapsed`.
- Depends on: none
- Files: modify `apps/server/src/production/worktree_catalog_rpc.rs` (test `removal_refuses_when_an_admission_does_not_drain_before_the_deadline`; one temporary line in `remove_worktree_owned`)
- Interfaces: consumes `WorktreeCatalogRpcServices.removal_admission_timeout: Duration` and `removal_drain_entered: Option<Arc<Semaphore>>` (both `#[cfg(test)]` hooks, set on `fixture.handler.services`), `RemovalFixture::{new, set_live_sessions, payload, assert_refused}`, `remove_worktree(&services, request("worktree.remove", payload), CancellationToken)`; produces nothing for other tasks.
- Skills: `mstack-diagnose` (prove the cause before changing the bound), `tdd` (red-green with an injected delay)
- Read first: `apps/server/src/production/worktree_catalog_rpc.rs` tests `removal_waits_for_admitted_work_before_checking_the_session` (the pattern to copy: entered semaphore, spawned removal, 30 s guards)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib removal_refuses_when_an_admission_does_not_drain_before_the_deadline` exits 0 and the temporary delay is gone (`rg -n "2500" apps/server/src/production/worktree_catalog_rpc.rs` finds nothing).

Cause, already confirmed: the 2 s bound is the test's own `tokio::time::timeout(Duration::from_secs(2), fixture.remove(payload))`. Production's drain timeout is already injected as 20 ms. The 2 s wraps the whole removal (plan, Git, SQLite) before the drain, so a loaded machine exceeds it. No existing hook delays the removal, and Tokio paused time does not fit because the fixture uses real SQLite and Git subprocesses. The delay is therefore a temporary edit, as in step 1.

Steps

1. [ ] Add the temporary delay. In `remove_worktree_owned`, inside the `#[cfg(test)]` block just before `if let Some(entered) = &services.removal_drain_entered`, add the line `#[cfg(test)] tokio::time::sleep(Duration::from_millis(2500)).await;` (use the full path if `Duration` is not imported there). Do not commit it.
2. [ ] Run `cargo test -p bibcode-server --lib removal_refuses_when_an_admission_does_not_drain_before_the_deadline`. Expected: FAIL with `bounded admission drain: Elapsed(())`. This is the red proof for the OLD test.
3. [ ] Rewrite the test body, keeping the 20 ms `removal_admission_timeout`. Create `entered = Arc::new(Semaphore::new(0))` and set `fixture.handler.services.removal_drain_entered = Some(Arc::clone(&entered))`. Hold the admission as before. Spawn `remove_worktree` on a cloned `services` (as the sibling test does). Wait with `tokio::time::timeout(Duration::from_secs(30), entered.acquire())` and `.forget()` the permit. Then await the join handle inside `tokio::time::timeout(Duration::from_secs(30), ...)`, message "removal ends after the drain deadline". Pass the result to `fixture.assert_refused`. The 30 s guards are reached only by a real hang.
4. [ ] Run the same command with the delay still in place. Expected: PASS (it takes about 2.5 s). This is the green proof for the NEW test.
5. [ ] Remove the temporary delay line. Run `rg -n "2500" apps/server/src/production/worktree_catalog_rpc.rs`. Expected: no output.
6. [ ] Run the test 20 times alone: `for i in $(seq 20); do cargo test -p bibcode-server --lib removal_refuses_when_an_admission_does_not_drain_before_the_deadline || break; done`. Expected: 20 passes. Log the run count in the final report. The 50 runs under CPU load and the 12 Windows suite runs are Phase 8.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 3.2: Delete creation records by id

- Satisfies: R31. Scenario: a worktree recreated at the same path between resolve and delete keeps its new record.
- Depends on: none (run after 3.1: same file)
- Files: modify `apps/server/src/persistence/repositories.rs`, `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/tests/repositories.rs`, `apps/server/src/production/orchestration_effects.rs` (caller only, if it needs any change); test the same files
- Interfaces: consumes `Repositories::reap_worktree_creation_record(&self, record_id: i64) -> Result<()>`, `Repositories::list_worktree_creation_records`. Produces: `Repositories::record_worktree_creation(&self, project_cwd: &str, worktree_path: &str) -> Result<i64>` (the new row's id, from `last_insert_rowid()` read in the same `database.call` closure as the `INSERT OR REPLACE`); `Repositories::worktree_creation_record_id(&self, worktree_path: &str) -> Result<Option<i64>>`; the struct field `ResolvedRemovalThread.creation_record_id: Option<i64>` replaces `creation_record: String`. `delete_worktree_creation_record` is removed, with its repository test `worktree_creation_record_delete_removes_only_that_path` and its name in the method list in `apps/server/tests/repositories.rs`; `worktree_creation_record_id` is added to that list.
- Every caller and writer, searched with `rg`:
  - `delete_worktree_creation_record`: `create_managed_worktree_locked` (dispatch-failure arm), `remove_worktree_owned` (after `persist_detach`), the repository test above, and the list in `tests/repositories.rs`. All four are covered by this task.
  - `record_worktree_creation`: `create_managed_worktree_locked`, `orchestration_effects.rs` (bootstrap worktree; it ignores the success value, so it compiles unchanged), the repository tests, the `worktree_audit.rs` tests, the `worktree_catalog_rpc.rs` test that records `{main}/`, and `Fixture::record_creation` in `tests/profiler_worktree_audit.rs` (it ignores the value). No other writer exists. Run `rg -n "record_worktree_creation|delete_worktree_creation_record|creation_record\b" apps/server` before and after.
  - `ResolvedRemovalThread.creation_record`: set in `resolve_removal_thread`, read in `remove_worktree_owned`.
- Skills: `tdd` (failing test before the signature change)
- Read first: `apps/server/src/persistence/repositories.rs` tests `worktree_creation_record_delete_removes_only_that_path` and the reap-by-id test just above it (the model for the id test); `RemovalFixture` and the sibling test `removal_waits_for_admitted_work_before_checking_the_session` in `worktree_catalog_rpc.rs` (the held-admission pattern)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -- worktree_creation_record_id_names_the_current_record removal_keeps_a_record_created_while_it_drains` and `cargo test -p bibcode-server --test repositories` exit 0, and `rg -n "delete_worktree_creation_record" apps/server` finds nothing.

Steps

1. [ ] Write the failing repository test `worktree_creation_record_id_names_the_current_record` in `repositories.rs`. Record `/worktrees/feature-a`; assert `worktree_creation_record_id` returns `Some(id)` equal to the value `record_worktree_creation` returned. Record the same path again; assert the new id differs. Reap the old id; assert the later record remains.
2. [ ] Write the failing handler test `removal_keeps_a_record_created_while_it_drains` next to `worktree_creation_record_follows_create_and_remove`. It uses the real handler and real SQLite (no stubs); time is real, no paused clock. Use `RemovalFixture` with no live session and `removal_drain_entered` set as in task 3.1. Call `record_worktree_creation` for the fixture's main checkout and `fixture.linked` path first. Hold an admission with `registry.acquire_admission("removed-thread", [fixture.linked.as_path()])`, spawn the removal, wait on `entered` (30 s guard), then call `record_worktree_creation` for the same path again and remember the new id. Drop the admission, join the removal (30 s guard, so the old removal has settled before asserting), and assert it succeeded and `list_worktree_creation_records` holds exactly one record whose `record_id` is the new id. This is the deterministic gap.
3. [ ] Run `cargo test -p bibcode-server --lib -- worktree_creation_record_id_names_the_current_record removal_keeps_a_record_created_while_it_drains` and `cargo test -p bibcode-server --test repositories`. Expected: FAIL to compile on the new signature (the handler test also proves the old by-path delete is wrong once compiled).
4. [ ] Implement the repository changes above. In `resolve_removal_thread`, call `worktree_creation_record_id(&persisted_path.to_string_lossy())` and store the result in `creation_record_id`. In `remove_worktree_owned`, replace the delete with `reap_worktree_creation_record(id)` when `Some(id)`, keeping the `tracing::warn!` text.
5. [ ] In `create_managed_worktree_locked`, keep the id that `record_worktree_creation` now returns. In the dispatch-failure arm, replace `delete_worktree_creation_record(&created.worktree.path)` with `reap_worktree_creation_record(record_id)`. Confirm `orchestration_effects.rs` still compiles; change it only if the compiler requires.
6. [ ] Run the commands from step 3. Expected: PASS.
7. [ ] Prove the test can fail. The SQL cannot be the mutation: `INSERT OR REPLACE` has already removed the old row, so a by-path rewrite of the reap SQL would delete nothing. Instead, by hand, revert the removal caller in `remove_worktree_owned` to deleting by the path it captured (add a private `delete_worktree_creation_record` back, or a path-keyed `DELETE` through `database().call`, and call it with `resolved.path`'s stored spelling). Run `cargo test -p bibcode-server --lib -- removal_keeps_a_record_created_while_it_drains`. Expected: FAIL, the replacement record is gone. Restore the id-based call and run it again. Expected: PASS.
8. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

The dispatch-failure arm is by id for the same reason. Its end state (no record left) is asserted by the test in task 3.3; a recreation race inside that arm is not reproducible without a hook and is covered by the id lookup test in step 1.

### Task 3.3: Audit both creation-rollback arms

- Satisfies: R32. Scenario: a creation whose record write fails, and one whose dispatch fails, each emit exactly one `worktree.removal` event with mode `create-rollback`, and removing either production call alone fails a test.
- Depends on: 3.2 (same function and arms)
- Files: modify `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/mcp/tools/worktrees.rs` (header comment); test `apps/server/src/production/worktree_catalog_rpc.rs` and the existing test `the_audit_and_removal_outcomes_reach_the_profiler` in `apps/server/tests/profiler_worktree_audit.rs`
- Interfaces: consumes `worktree_audit::record_removal_outcome(mode: &str, outcome: Result<(), &str>, duration: Duration, timed_out_drain: bool, cancelled: bool)`, `GitRepository::rollback_managed_worktree_creation` (its `Err` carries `.detail`; its only callers are the two arms below). Produces: the mode string `create-rollback` and exactly two outcomes. A rollback that succeeded records `Ok(())` (event with `ok: true`, `reason: null`, no finding). A rollback that failed records `Err("internal")` (event with `ok: false`, `reason: "internal"`, plus an Error `worktree.removal-failed` finding). Never pass the rollback detail or a path. Phase 13 documents these exact strings in `events.md`. Entry points: `create_managed_worktree_locked` is reached by the `worktree.createManaged` RPC and by the MCP tool `create_worktree` in `mcp/tools/worktrees.rs`, which calls the same handler; `create_worktree_panel` creates no worktree and has no rollback. The two arms are the only audit sites.
- Skills: `tdd` (events asserted before the calls exist), `bibcode-profiler` (event shape and coverage rules)
- Read first: `apps/server/src/diagnostics/profiler/worktree_audit.rs` functions `record_removal_outcome` and `removal_failure` (which reasons raise findings); `apps/server/tests/profiler_worktree_audit.rs` (the one test, its `Fixture`, and the final `removals` assertions)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -- create_rollback` and `cargo test -p bibcode-server --test profiler_worktree_audit` exit 0.

Settled before writing:
- No existing test forces the dispatch-failure arm. The record-write arm is forced by `a_creation_whose_record_cannot_be_written_fails_and_leaves_no_worktree` (it drops the `worktree_creation_records` table).
- The profiler is process-global, so `tests/profiler_worktree_audit.rs` keeps all scenarios in the one test `the_audit_and_removal_outcomes_reach_the_profiler`. Do not add a second test there. Extend it.
- The harness is real, not stubbed: `Fixture::new` builds `WorktreeCatalogRpcServices::new(catalog, engine)`, which takes its creation Git from `catalog.git_repository()` (a real `GitRepository::default()`), and `register_worktree_catalog_rpc` registers `worktree.createManaged`. So the test can send that RPC over the existing socket.
- The existing assertion `removals.len() == 4` counts every `worktree.removal` event. It becomes 6 in this task, and its message names the two rollbacks.

Steps

1. [ ] In `worktree_catalog_rpc.rs` write the failing lib test `create_rollback_outcome_uses_fixed_tokens` for a new `fn create_rollback_outcome(rolled_back: bool) -> Result<(), &'static str>`: `true` gives `Ok(())`, `false` gives `Err("internal")`. This pins the failed-rollback token; the integration test cannot reach a failing rollback.
2. [ ] In the same module write the failing handler test `create_rollback_after_a_dispatch_failure_leaves_no_worktree_or_record`. Injection: `git branch feature/dup` (use the module's `git(&fixture.main, ...)`), dispatch a `ThreadCreate` for thread id `dup-thread` through `fixture.engine` (copy the command from `create_thread` in `RemovalFixture`), then call `create_managed(&fixture, "dup", "feature/dup")`. `managed_create_payload` builds the thread id `dup-thread`, so the engine refuses with "Thread 'dup-thread' already exists" and the dispatch arm runs. Assert the call returns an error, the managed folder is gone, `creation_records(&fixture)` is empty, and Git lists only the primary checkout (copy the last assertions of the record-write failure test).
3. [ ] Extend `the_audit_and_removal_outcomes_reach_the_profiler`, after its last `scan_once` and before `shutdown_and_read_events`, with both arms, dispatch arm first: Expected: the change is in place, and the next command step checks it.
   - Dispatch arm: run `git branch feature/dup-a` with the file's `git(&fixture.git_config, &fixture.main, ...)`; dispatch a `thread.create` through `fixture.engine` using `serde_json::from_value(json!({"type":"thread.create","commandId":"dup-a-create","threadId":"dup-a-thread","projectId":"project-1","title":"Existing","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","createdAt":"2026-10-09T00:00:01Z"}))` (the shape `engine.rs` tests use); then `request(fixture.socket(), "800", "worktree.createManaged", ...)` with `commandId` `dup-a`, `threadId` `dup-a-thread`, `refName` `feature/dup-a`, `newRefName` and `baseRefName` null and the same `threadDefaults` as `adopt`. Await `failure_reason(fixture.socket(), "800")` and assert it is `orchestration-failed`. Assert `fixture.creation_records().await` has not gained a path (compare with the list taken just before).
   - Record-write arm, last, because it breaks later scans: `git branch feature/dup-b`; run `fixture.repositories.database().call(|connection| { connection.execute_batch("DROP TABLE worktree_creation_records")?; Ok(()) }).await`; send `worktree.createManaged` as request `801` with command `dup-b`, thread `dup-b-thread`, ref `feature/dup-b`; assert `failure_reason` is `internal`.
   - After the events are read, extend the final assertions: `removals.len()` is 6; the filtered list for `mode == "create-rollback"` has exactly 2 entries, both `(ok true, reason None, drainTimedOut false, cancelled false)`. This one count fails if either production call is removed alone (it drops to 1), so each call has a test that fails without it. Also assert no `worktree.removal-failed` event cites a `create-rollback` event, since both rollbacks succeed.
4. [ ] Run `cargo test -p bibcode-server --lib -- create_rollback` and `cargo test -p bibcode-server --test profiler_worktree_audit`. Expected: FAIL (helper missing; the integration count is 4, not 6).
5. [ ] Implement the helper. In both rollback arms of `create_managed_worktree_locked`, after `rollback_managed_worktree_creation` returns and before the error is built, call `record_removal_outcome("create-rollback", create_rollback_outcome(rollback.is_ok()), started.elapsed(), false, cancellation.is_cancelled())` with `started = Instant::now()` taken before the rollback. Update the header comment of `mcp/tools/worktrees.rs` to say a failed creation's rollback records a `create-rollback` outcome too.
6. [ ] Run the commands from step 4. Expected: PASS.
7. [ ] Prove the test can fail, once per call. Revert this task's change by hand in the dispatch arm only (delete its `record_removal_outcome` call) and run `cargo test -p bibcode-server --test profiler_worktree_audit`. Expected: FAIL (2 create-rollback events expected, 1 found). Restore it, then delete the call in the record-write arm only and run again. Expected: FAIL for the same reason. Restore it and run again. Expected: PASS.
8. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 3.4: Reap a record only when its parent directory exists

- Satisfies: R33 and D9. Scenario: a record whose folder is missing under a missing parent directory (an unmounted volume) is kept; one whose parent exists is reaped.
- Depends on: none
- Files: modify `apps/server/src/diagnostics/profiler/worktree_audit.rs`; test the same file (module `tests`, next to `gone_after_read`)
- Interfaces: consumes `resolve(owned, complete, listings, registrations, evidence: Evidence, cancel) -> Comparison` and `reap_gone_records(&Repositories, Vec<WorktreeCreationRecord>)`. Produces: `fn record_folder_is_gone(worktree_path: &str) -> bool`, true only when `std::fs::symlink_metadata(worktree_path)` fails with `NotFound` AND the path's parent exists as a directory (`Path::parent()` is `Some` and `std::fs::metadata(parent)` succeeds with `is_dir()`). A path with no parent returns false. Both places that judge a record gone call it: the `Err(NotFound)` arm in `resolve`, and the re-check at the top of `reap_gone_records` (which runs it on `tokio::task::spawn_blocking`; a join error reads as not gone). The gate is not `git worktree list`, which succeeds from a readable repository when only the worktree's volume is unmounted (D9). Cost to record in the doc comment: records under a managed directory deleted as a whole are never reaped.
- Skills: `tdd` (failing cases before the gate)
- Read first: `apps/server/src/diagnostics/profiler/worktree_audit.rs` `resolve`, `reap_gone_records`, and the tests `gone_after_read` and `recorded_paths` (the seam and the helpers to copy)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -- a_record_under_a_missing_parent_is_kept a_record_whose_folder_is_missing_under_an_existing_parent_is_reaped a_record_is_kept_when_its_parent_vanishes_before_the_reap` exits 0.

Steps

1. [ ] Write the failing test `a_record_under_a_missing_parent_is_kept`: record `<managed>/gone/wt` where `<managed>/gone` does not exist, call `gone_after_read`, assert it is empty. In the same test call `reap_gone_records` with that record and assert `recorded_paths` still lists it.
2. [ ] Write the failing test `a_record_whose_folder_is_missing_under_an_existing_parent_is_reaped`: record `<managed>/wt` with `<managed>` present and `wt` absent; assert `gone_after_read` holds it and `reap_gone_records` deletes it.
3. [ ] Write the failing test `a_record_is_kept_when_its_parent_vanishes_before_the_reap`: take the gone list for a record with an existing parent, remove the parent directory, then call `reap_gone_records`; assert the record remains (the re-check).
4. [ ] Run `cargo test -p bibcode-server --lib -- a_record_under_a_missing_parent_is_kept a_record_whose_folder_is_missing_under_an_existing_parent_is_reaped a_record_is_kept_when_its_parent_vanishes_before_the_reap`. Expected: FAIL on tests 1 and 3 (the old code reaps on `NotFound` alone); test 2 passes.
5. [ ] Implement `record_folder_is_gone` and call it from both places.
6. [ ] Run the command from step 4. Expected: PASS.
7. [ ] Prove the tests can fail: revert this task's change by hand (make `record_folder_is_gone` return true on `NotFound` alone, the old rule) and rerun the step 4 command. Expected: the tests `a_record_under_a_missing_parent_is_kept` and `a_record_is_kept_when_its_parent_vanishes_before_the_reap` FAIL. Restore it and rerun. Expected: PASS.
8. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 3.5: Record the limits in comments

- Satisfies: R34 and D10. Scenario: the four limits are written where the code has them.
- Depends on: 3.4 (same file)
- Files: modify `apps/server/src/diagnostics/profiler/worktree_audit.rs`
- Interfaces: consumes `worktree_evidence` and `opens_as_git_pointer_file`; produces comments only.
- Skills: none
- Read first: `apps/server/src/diagnostics/profiler/worktree_audit.rs` `worktree_evidence`, `opens_as_git_pointer_file`
- Tier: cheap
- TDD: exempt (comment only, no behavior)
- Done when: `rg -n "shortcut:" apps/server/src/diagnostics/profiler/worktree_audit.rs` finds the three comments below, and `cargo fmt --all --check` exits 0.

Steps

1. [ ] On `worktree_evidence`, add a comment starting `shortcut:` saying a creation record has no folder identity, so it can outlive its worktree when another folder takes the same path, and that folder is then reported with `CreationRecord` evidence; upgrade only if that warning proves noisy, by storing an identity at creation (a schema change, D10).
2. [ ] On `worktree_evidence`, add a comment starting `shortcut:` saying a worktree whose record write never happened (a crash between Git's success and the write) is still recognized by its `.git` pointer file (`GitPointerFile`).
3. [ ] On `opens_as_git_pointer_file`, add a comment starting `shortcut:` saying the file is opened first and checked through the opened handle (no check-then-open gap), and that `O_NOFOLLOW` or `FILE_FLAG_OPEN_REPARSE_POINT` protect only the last path component, so a swapped parent directory is not contained; upgrade by reading through `workspace/beneath.rs` `Dir` if the audit ever stops being advisory (D10).
4. [ ] Run `rg -n "shortcut:" apps/server/src/diagnostics/profiler/worktree_audit.rs`. Expected: the three comments. Run `cargo fmt --all --check`. Expected: no errors.

## Profiler coverage line for the final report

Touches: RPC methods (no new method; `worktree.createManaged` gains `worktree.removal` events with mode `create-rollback`), worktree removal outcomes (`record_removal_outcome` now covers both creation-rollback arms), and the audit's record reap (no new event). Does not touch child processes, binaries or re-exec modes, shutdown, or logs beyond the existing `tracing::warn!` texts. The `create-rollback` mode and the reason tokens `internal` (failed rollback) and none (successful rollback) are documented by Phase 9 in `events.md`.
