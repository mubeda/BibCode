# Phase 5: Orphan worktree warnings

- Goal: The profiler raises `worktree.orphan-dir` only for folders with worktree evidence, BiBCode records the worktrees it creates, and the profiler and catalog documents describe the rule, with tests (#344).
- Round: 4
- Depends on: 4
- Owns: `apps/server/src/persistence/migrations.rs`, `apps/server/src/persistence/repositories.rs`, `apps/server/src/diagnostics/profiler/worktree_audit.rs`, `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/production/git_vcs.rs`, `apps/server/tests/profiler_worktree_audit.rs`, `docs/architecture/worktree-catalog.md`, `docs/skills/bibcode-profiler/references/findings.md`
- Must not touch: `apps/server/src/git/repository.rs` (Phase 2 owns it; this phase calls it, and does not change `is_managed_orphaned_worktree_path`), `apps/server/src/git/status_owner.rs`, `apps/web/**`
- Skills: test-driven-development (the audit rule changes only behind failing fixture tests); bibcode-profiler (its finding reference must match the new rule)
- Read first: `spec.md` section B (R3 to R7, D4, D20 on record lifetime); `docs/architecture/worktree-catalog.md` lines 420-440 (the orphan paragraph and table row); `docs/skills/bibcode-profiler/references/findings.md` lines 507-519; `AGENTS.md` (Profiler coverage: worktree removal outcomes; Sensitive Data)
- Checkpoint: `cargo test -p bibcode-server --test profiler_worktree_audit -j 2` and `cargo test -p bibcode-server --lib -j 2 worktree_audit` exit 0. A plain folder inside a managed worktree directory no longer produces a finding.

Tests use an isolated home, isolated user data and disposable folders only.

## Tasks

### Task 5.1: Record the worktrees BiBCode creates

- Satisfies: R4 (record survives restart; failed creation; record ends with the worktree)
- Depends on: none
- Files: modify `apps/server/src/persistence/migrations.rs`; modify `apps/server/src/persistence/repositories.rs`; modify `apps/server/src/production/worktree_catalog_rpc.rs`; modify `apps/server/src/production/git_vcs.rs`
- Interfaces: consumes the `MIGRATIONS` array (migrations.rs line 590, latest `Migration::new(71, "McpNamedClientTakeOver", migration_071)` at 673), the table list at lines 40-70, `GitRepository::create_worktree` (repository.rs 3248) through its callers `vcs.createWorktree` (git_vcs.rs 939), `create_managed_worktree_locked` (worktree_catalog_rpc.rs 1281) and `create_managed_from_ref_locked` (585), and the removal callers at worktree_catalog_rpc.rs 299 and git_vcs.rs 990 and 1329; produces migration 72 `WorktreeCreationRecords` creating table `worktree_creation_records(project_cwd TEXT NOT NULL, worktree_path TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_cwd, worktree_path))`, and in `repositories.rs`: `pub async fn record_worktree_creation(&self, project_cwd: &str, worktree_path: &str) -> Result<()>`, `pub async fn delete_worktree_creation_record(&self, project_cwd: &str, worktree_path: &str) -> Result<()>` and `pub async fn list_worktree_creation_records(&self, project_cwd: &str) -> Result<Vec<String>>`, written like the async receipt functions at line 238.
- Skills: none
- Read first: `apps/server/src/persistence/migrations.rs` lines 2327-2345 (`migration_043`, the receipts table this mirrors) and the test `migration_43_adds_durable_worktree_removal_receipts` near line 4926; `apps/server/src/persistence/repositories.rs` lines 238-300 (the receipt functions)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 worktree_creation_record` and `cargo test -p bibcode-server --lib -j 2 a_creation_whose_record` exit 0 with 4 and 1 tests passing

Steps

1. [ ] In `migrations.rs` tests, add `migration_72_adds_worktree_creation_records`: after migrating, the table exists with the three columns and the composite primary key, and migrating an existing version-71 database keeps its rows.
2. [ ] In `repositories.rs` tests, add `worktree_creation_record_survives_reopen` (record, close and reopen the database, list returns the path), `worktree_creation_record_is_idempotent` (recording the same path twice leaves one row) and `worktree_creation_record_delete_removes_only_that_path`.
3. [ ] Run `cargo test -p bibcode-server --lib -j 2 worktree_creation_record` and `cargo test -p bibcode-server --lib -j 2 migration_72`. Expected: FAIL to compile, the functions are not defined.
4. [ ] Add `migration_072`, append `Migration::new(72, "WorktreeCreationRecords", migration_072)`, add the table to the list at lines 40-70, and implement the three repository functions (`INSERT OR IGNORE`, `DELETE`, `SELECT`).
5. [ ] Call `record_worktree_creation` in the three creation callers after `create_worktree` returns success and before the RPC replies, through the same async database access pattern the receipt functions use (repositories.rs line 238). The record is part of a successful creation: when the record cannot be written, roll the worktree back with `rollback_managed_worktree_creation` (repository.rs line 3705, called, not changed), log `tracing::error!`, and fail the creation with the storage error. When creation itself fails, no record is written. Call `delete_worktree_creation_record` in the three removal callers after removal succeeds and the folder is gone; a failed delete is logged with `tracing::warn!` and does not fail the removal, because Task 5.2's audit deletes a record whose folder is gone.
6. [ ] Add `worktree_creation_record_follows_create_and_remove` next to the existing creation tests of `worktree_catalog_rpc.rs`: create a managed worktree through the RPC, assert the record exists; make a creation fail, assert no record; remove the worktree, assert the record is gone. Add `a_creation_whose_record_cannot_be_written_fails_and_leaves_no_worktree`: with the records table made unwritable, the RPC returns an error, the folder does not exist and Git lists no such worktree.
7. [ ] Run `cargo test -p bibcode-server --lib -j 2 worktree_creation_record` and `cargo test -p bibcode-server --lib -j 2 migration_72`. Expected: PASS, 4 and 1 tests.
8. [ ] Prove the test can fail: skip the delete call in the catalog removal caller, run `cargo test -p bibcode-server --lib -j 2 worktree_creation_record_follows_create_and_remove`. Expected: FAIL. Restore and run again. Expected: PASS.
9. [ ] Run `vp run check:contracts`. Expected: exits 0 with no fixture diff (no RPC shape changed).
10. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.

### Task 5.2: Warn only for folders with worktree evidence

- Satisfies: R3 (same name under two parents), R5 (leftover without `.git`; pointer file only), R6 (container folder), R7 (one of two removed)
- Depends on: 5.1
- Files: modify `apps/server/src/diagnostics/profiler/worktree_audit.rs`; modify `apps/server/tests/profiler_worktree_audit.rs`; modify `docs/architecture/worktree-catalog.md`; modify `docs/skills/bibcode-profiler/references/findings.md`
- Interfaces: consumes `list_worktree_creation_records` and `delete_worktree_creation_record` (Task 5.1), the receipt state `prepared` in `worktree_removal_receipts`, the marker names `.bibcode-removal-identity` and `.bibcode-removal-tombstone` (repository.rs lines 74-76), `AuditFacts`, `gather` (worktree_audit.rs 332), `list_managed` (529), `resolve` (562) and the inline predicate in `audit` (801-838); produces `pub(crate) enum WorktreeEvidence { CreationRecord, IncompleteRemoval, GitPointerFile, RemovalMarker }`, a field `evidence: HashMap<PathBuf, WorktreeEvidence>` on `AuditFacts`, and an `evidence` JSON object on the finding with `name` (the folder name) and `reason` (the evidence kind in kebab case) beside today's `path`. The fingerprint fields at lines 823-836 are unchanged.
- Skills: none
- Read first: `apps/server/src/diagnostics/profiler/worktree_audit.rs` lines 302-600 and 768-840 and the unit tests `an_unowned_unregistered_directory_is_an_orphan` (991) and `summaries_redact_home_and_orphan_fingerprints_hash_relative_paths` (1472); `apps/server/tests/profiler_worktree_audit.rs` lines 49-100
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 worktree_audit` and `cargo test -p bibcode-server --test profiler_worktree_audit -j 2` exit 0 with the 6 new tests passing

Steps

1. [ ] In the unit tests of `worktree_audit.rs`, add `a_folder_without_worktree_evidence_is_not_an_orphan`: a visible, unowned, unregistered child named `container` with a subfolder holding files and no evidence raises nothing, and the audit lists no path below `container`.
2. [ ] Add `a_leftover_with_a_creation_record_is_an_orphan_without_git`, `a_leftover_with_only_a_git_pointer_file_is_an_orphan` (a root `.git` file whose first line starts with `gitdir:`), `a_leftover_with_a_removal_marker_is_an_orphan` and `a_leftover_with_an_incomplete_removal_receipt_is_an_orphan` (state `prepared`; a receipt in state `removed` is not evidence).
3. [ ] Add `orphan_ids_stay_per_parent_and_name_and_evidence_names_the_folder`: `feature-a` under two managed parents outside the home folder gives two different IDs, each ID equals the value today's fingerprint fields produce, a second audit gives the same IDs, and each finding's evidence `name` is `feature-a`.
4. [ ] Change the existing `an_unowned_unregistered_directory_is_an_orphan` to give its folder a creation record, and in `tests/profiler_worktree_audit.rs` give `fixture.managed.join("orphan")` a creation record. Then add to the integration test: a second leftover with evidence and a `container` folder without; after two audits both leftovers have count 2 and `container` has no finding; remove one leftover, audit, and assert only the other is raised and that the removed folder's creation record was deleted.
5. [ ] Run `cargo test -p bibcode-server --lib -j 2 worktree_audit`. Expected: FAIL, `a_folder_without_worktree_evidence_is_not_an_orphan` reports one finding.
6. [ ] Implement: `gather` loads the creation records and `prepared` receipts for the project; `resolve` checks, for each listed child only, the root `.git` pointer file and the two root markers (one `stat` or one small read each, no recursion); the predicate in `audit` additionally requires an entry in `evidence`. `gather` deletes a creation record whose folder no longer exists. Add `name` and `reason` to the finding evidence, redacted through the existing `redact`.
7. [ ] Run `cargo test -p bibcode-server --lib -j 2 worktree_audit` and `cargo test -p bibcode-server --test profiler_worktree_audit -j 2`. Expected: PASS.
8. [ ] Prove the test can fail: make the predicate ignore `evidence`, run `cargo test -p bibcode-server --lib -j 2 a_folder_without_worktree_evidence_is_not_an_orphan`. Expected: FAIL. Restore and run again. Expected: PASS.
9. [ ] Update `docs/architecture/worktree-catalog.md` (the paragraph at lines 425-428 and the table row at 434) and `docs/skills/bibcode-profiler/references/findings.md` (`### worktree.orphan-dir`): the four kinds of evidence, that a folder without evidence is not reported, that a leftover created before this change with no evidence stops being reported, and the new `name` and `reason` evidence fields.
10. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `vp run check:markdown-links`. Expected: no errors.
