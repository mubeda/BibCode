# Large-Store Compaction

Status: Proposed 2026-11-02. Design for issue 262, verified against PR #248
(`origin/v015/230-storage-compact` at `4923e9be2`) merged onto `main` at
`fd98b4330`. It builds on the approved
[storage compaction design](2026-11-01-storage-compaction-design.md) (called
"the #230 design" below) and lifts its D5 scope-down. It changes what a backup
inventory verifies, when a manifest's `created_at` is taken, the backup and
restore deadlines, and the restore failure cleanup. No persisted shape
changes.

## Problem

`bibcode storage compact` takes its pre-compact backup through
`create_verified_backup` under `BACKUP_TIMEOUT = 30 s`
(`apps/server/src/persistence/backup.rs:32`). A store whose backup takes
longer is refused with `CompactFailed { phase: "backup" }` ("Compacting stores
this large is not supported yet", `compaction.rs:664`). The issue asks that such
a store can be compacted behind a verified, restorable backup, that restore
works for it, and that tests cover a large store.

## Why the #230 design kept 30 s

The #230 design (D5) found that a longer creation budget is not one change,
because every path that touches a backup of that size has its own 30 s budget:

1. **Manifest skew.** `created_at` is taken before the copy (`backup.rs:665`)
   and `verify_generation` rejects a manifest more than
   `MAX_PUBLICATION_TIME_SKEW = 60 s` from the generation directory's mtime
   (`backup.rs:2349`). The directory's mtime moves at the end of the copy (the
   staged connection's switch to `journal_mode = DELETE` creates and removes a
   `-journal` entry) and again when `manifest.json` is written. A copy longer
   than about a minute publishes a generation that fails its own reload
   verification. A compile-time assertion (`backup.rs:41`) pins
   `BACKUP_TIMEOUT < MAX_PUBLICATION_TIME_SKEW`.
2. **Restore.** `RECOVERY_TIMEOUT = 30 s` (`backup.rs:38`) covers the
   selected generation's verification, its copy and the copy's verification.
3. **Inventory.** `inventory_blocking` (`backup.rs:2227`) hashes and
   `quick_check`s every generation under one 30 s deadline.
4. **Classifier.** Inspection's and startup's `quick_check` has 5 s
   (`migrations.rs:17`).

Path 3 is wider than the #230 design recorded. The same inventory runs inside
**every** backup creation, through `apply_retention` (`backup.rs:2490`), and
`delete_verified_generation_inner` verifies an expiring generation twice more
(`backup.rs:2568`, `:2580`). So a single large generation in `backups/` would:

- make `bibcode storage inspect` and the desktop's status list fail or report
  it as an issue (the loop's `ensure_optional_active` at `backup.rs:2245`
  fails the whole inventory once the deadline passes);
- make every later pre-update and pre-migration backup fail in retention,
  after it has already published, so in-app updates and migrations stop. The
  large generation could then never age out, because only a successful
  creation runs retention.

Any design that admits a large pre-compact backup must fix path 3 first.

## Facts this design uses

- **Store sizes.** #225's measurements
  (`docs/architecture/measurements/remote-load-3g-20261101.md` on
  `origin/v015b/225-load-budget`) record transfer bytes only: a 6.3 MB decoded
  thread snapshot and a 246 KB shell snapshot from the load fixture. They do
  not record the fixture's on-disk `state.sqlite` size. The other data points
  are the ignored benchmark `shell_snapshot_timing_on_a_large_store` (50
  threads, about 300 MB, cited in #225's issue) and a reference
  implementation's report of a 7.02 GiB store that `VACUUM` took to 3.83 GiB in
  183 s (cited in #230). Neither is a BiBCode measurement. The implementation
  PR measures (see "Measurement").
- **Work per byte.** For a store of `N` bytes with the newest three generations
  of similar size, creation today reads about 17 `N` and writes `N`: the copy,
  `quick_check`, hash, reload hash and `quick_check` (5 `N`), the retention
  inventory of four generations (8 `N`), and two re-verifications of the
  expiring one (4 `N`). Restore reads about 5 `N` (verify, copy, verify the
  copy) and writes `N`.
- **Startup limit.** Startup validates an existing store with `quick_check`
  under the 5 s `VALIDATION_TIMEOUT`, and a deadline is
  `UnsafeDatabaseState` (`store.rs:417`, `migrations.rs:504`). A store whose
  `quick_check` takes longer than 5 s cannot start today. Compaction never
  calls that classifier (#230 D3 step 3), so it can still shrink such a store,
  and restore puts back a store of the size that existed before. That limit is
  out of scope here and is listed under Follow-ups.
- **Desktop.** WSL storage commands run under `WSL_COMMAND_TIMEOUT = 30 s`
  with `kill_on_drop(true)` (`apps/desktop/src-tauri/src/data_safety.rs:16`,
  `:315`). Each listed backup carries `sizeBytes` (`data_safety.rs:155`).
- **Failure cleanup.** Neither creation nor restore removes its staging
  directory on failure. A backup's `.<id>.staging` is skipped by inventory but
  keeps its partial copy on disk. A restore's `.<op>.recovery-staging` makes
  every later startup fail with `RecoveryIncomplete` (`store.rs:139`) and every
  later restore fail with `RecoveryInProgress` (`backup.rs:1424`), even though
  the live store was never touched: the journal is written only after the
  staged copy is verified (`backup.rs:1232-1252`). Today a restore that hits its
  30 s deadline mid-copy leaves the store in that state.

## Goals and non-goals

Goals: the issue's three acceptance criteria; no regression for pre-update,
pre-migration, inspection or the desktop when a large backup exists; every
failure, cancellation, disk-full and crash path leaves the live store intact
and the data root usable.

Non-goals: changing the pre-update and pre-migration creation budgets (they stay
30 s); the 5 s startup and inspection classifier; a desktop compact action;
background `incremental_vacuum`; a restore profiler event.

## Options

### O1. A streamed backup with its own budget

A second writer that streams `state.sqlite` to the staging file and hashes it
in the same pass.

- A raw file stream misses committed frames in a crash-left `-wal`, which #230
  D3 step 4 deliberately does not checkpoint before the backup. The online
  backup API is the only reader that sees them without writing.
- It saves one pass of `N` at most; `quick_check` still has to run.
- It duplicates publication and verification, which #230 rejected for its
  `VACUUM INTO` alternative.

**Rejected.** The "own budget" part is kept: the pre-compact backup gets a
size-scaled deadline through the existing writer (O5).

### O2. `created_at` at publication instead of at the start

Take the timestamp in `finish_and_publish_backup` immediately before
`write_manifest` (`backup.rs:2155`), instead of in `create_verified_backup`
before the copy. The manifest write is the last change to the generation
directory before the rename, so the skew between `created_at` and the
directory's mtime becomes milliseconds, whatever the copy took.

- `created_at` then means "when the generation was published", which matches
  what the online backup API produces: a snapshot of the source as it was when
  the copy finished, not when it started.
- Ordering does not change: retention and listing already sort by the
  directory's mtime (`backup.rs:2291`).
- The 60 s skew check keeps rejecting forged and backdated manifests
  (`persistence_backup.rs:585`).

The alternative, a skew scaled by the budget, weakens that check for every
backup. **Adopted.** The compile-time assertion at `backup.rs:41` is removed,
because its premise (timestamp before the copy) no longer holds; test 2
replaces it.

### O3. Per-generation verification: content at publication and at use, structure when listed

Split `verify_generation` into two levels:

| Level        | Checks                                                                                                                                                                                                                                                                                                        | Used by                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Structural` | Everything that does not grow with the file: boundary and identity, exact entries, single links, manifest decode, ID and location, canonical UTC `created_at` and its skew, checksum syntax, `database_size_bytes` equal to the file's metadata length, and the manifest's ledger version (a few pages read). | Inventory (`inspect`, the desktop's list, retention) and the two re-checks before deleting a generation.     |
| `Content`    | `Structural`, plus the SHA-256 of the file and `quick_check`.                                                                                                                                                                                                                                                 | The reload verification right after publication, and restore's lookup of the selected generation (as today). |

Restore keeps verifying the content of the generation it installs twice: the
selected generation before the copy, and the staged copy against the manifest
(`copy_verified_database`, `backup.rs:1567-1579`). A generation that changed
after publication is therefore still never installed. What changes:

- A generation whose bytes rot after publication, at the same length, is
  listed until it is selected. Its restore then fails before any live file is
  touched (`recovery_restore_rejects_a_tampered_manifest_without_mutating_the_live_store`
  pins this), and the user picks an older one. Retention may count it among
  the newest three. Tampering through the filesystem is still caught by the
  identity, link and location checks, and replacement by the size, mtime and
  ledger checks.
- Inventory cost no longer grows with backup size, so the 30 s inventory
  deadline stays and the desktop's WSL inspection keeps its 30 s timeout.
- Creation reads about 5 `N` instead of 17 `N`. The pre-update and
  pre-migration budgets do not change, but stores up to about three times
  larger now fit in them.
- Deleting an expired generation no longer reads it. The identity checks that
  make deletion safe are unchanged.

Alternatives:

| Option                                                                       | Trade-off                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep full verification and scale the inventory deadline by total backup size | Correct listings, but a pre-update backup beside a 7 GiB pre-compact generation reads 14 GiB inside the update's drain deadline (`maintenance.rs:501`), so updates fail until the generation ages out, which it cannot. The WSL inspection's 30 s timeout breaks too. |
| Full verification for generations under a size threshold, `Structural` above | Today's listings are unchanged for small stores. But "verified" gets two meanings, the threshold needs tuning per disk, and both paths need tests.                                                                                                                    |
| **`Structural` listing, `Content` at publication and restore**               | One rule for every store, cheaper everywhere. Cost: rot after publication is found at restore time, not listing time, and fails closed.                                                                                                                               |

**Adopted: the last option.** The desktop's "Verified backups" heading stays
true: each was verified when it was published, and is verified again before it
is installed. The recovery guide says so.

### O4. A restore budget scaled by size

Restore's deadline becomes `start + budget(len)`, where `len` is the selected
generation's `state.sqlite` length, read with `symlink_metadata` before any
content is read. The lookup's directory scan and the lock wait keep
`RECOVERY_TIMEOUT`. Restore reads about 5 `len` and writes `len`, the same
work as a `Content`-verified creation (copy, `quick_check`, hash, reload hash
and `quick_check`), so one budget function serves both (O5).

A restore that fails before its journal is written now removes what it
created. It removes the staged `state.sqlite` and `environment-id` by name,
after the same identity checks it used to create them, then the staging
directory and its still-empty preserved directory, with `remove_dir` (never
recursive). That covers a deadline, Ctrl-C, disk full and any I/O error. A
crash or kill in the same window leaves the staging entry behind, so the next
`restore` or `start-empty`, under both locks, clears a
`.<uuid>.recovery-staging` entry when no recovery journal exists and the entry
holds nothing but those two plain files. Any other content, or a journal, keeps
today's `RecoveryInProgress` refusal. This is safe because the journal is
written and synced before the first live file moves, and the staging entry is
removed before the journal, so "staging without journal" always means the live
store was never touched.

The CLI gets Ctrl-C: `restore_backup` takes the caller's
`CancellationToken`. The CLI cancels it from `termination_signal()`; the
desktop passes a fresh token. Cancellation is honored until the journal is
written (`backup.rs:1230`). After that, restore only renames and finishes.

For WSL, the desktop's restore timeout becomes
`budget(sizeBytes) + RECOVERY_TIMEOUT + 30 s`, using the selected backup's
`sizeBytes` from the validation inspection, so the server's own deadline and
cleanup always run before the desktop kills the process. Inspection and
start-empty keep 30 s.

**Adopted.**

### O5. The budget function

```rust
pub struct StoreIoBudget { pub base: Duration, pub per_gib: Duration }
impl StoreIoBudget {
    /// 30 s, then 4 minutes per GiB.
    pub const LARGE_STORE: Self = Self { base: 30 s, per_gib: 240 s };
    /// Today's pre-update and pre-migration budget.
    pub const FIXED: Self = Self { base: 30 s, per_gib: 0 };
    /// `base + bytes × per_gib / GiB`, rounded up to a millisecond and
    /// capped at 24 h.
    pub fn for_bytes(self, bytes: u64) -> Duration;
}
```

240 s per GiB covers six passes at 25.6 MiB/s each, well below a spinning
disk's sequential rate, so it is a guard against a stuck disk or network
mount, not a performance target. A 7 GiB store gets 28.5 minutes. The user can
stop it at any time with Ctrl-C, and the CLI says how long it may take (O6).
The constant is provisional until "Measurement" below confirms it; it is
only ever raised, never lowered, by that measurement.

Uses:

| Path                               | Budget                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-compact creation               | `LARGE_STORE.for_bytes(pageCount × pageSize)`, from #230 D3 step 6, through the caller's cancellation token.                         |
| Pre-update, pre-migration creation | `FIXED`, unchanged.                                                                                                                  |
| Restore                            | `LARGE_STORE.for_bytes(len)` (O4).                                                                                                   |
| Inventory                          | 30 s, unchanged, now `Structural`.                                                                                                   |
| `VACUUM`                           | None, unchanged (#230 D5). Ctrl-C cancels it.                                                                                        |
| Desktop WSL restore                | `LARGE_STORE.for_bytes(sizeBytes) + RECOVERY_TIMEOUT + 30 s`; the desktop calls the same exported function, so the two cannot drift. |

`create_verified_backup` keeps its signature and `FIXED`. A new
`create_verified_backup_with(database, prepared, trigger, app_version,
cancellation, deadline)` takes the caller's token and deadline; compaction
passes its own token, so Ctrl-C during a long backup stops it within one
128-page step, instead of when it returns (#230 D9).

A creation that fails or is cancelled before publication removes its staging
directory the same way restore does: the two named files after identity
checks, then `remove_dir`. Unexpected content is left in place and logged.

### O6. Progress reporting

| Option                                                                        | Trade-off                                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Percent done from `Backup::progress()` and the hash loop                      | Most informative. But a callback has to cross three blocking workers and both verification passes, for one CLI. |
| **Phase lines that state the limit, plus a CLI-only elapsed line every 30 s** | No persistence change. The user knows the bound, sees that work continues, and knows that Ctrl-C is safe.       |

**Adopted: the second.** The CLI already prints a line per phase through
`CompactOptions::on_progress` (`lib.rs:297`). It records the current phase and
runs a 30 s interval beside the command's future. Lines go to stderr; stdout is
unchanged.

```text
Backing up 7.0 GB before compacting. This can take up to 29 minutes; press Ctrl-C to stop without changing the database.
Still backing up (2 min elapsed)…
Compacting…
Checking integrity…
Done: 7.0 GB → 3.8 GB. The pre-compact backup (7.0 GB) is kept until newer backups replace it.
```

`bibcode storage restore` prints "Restoring backup `<id>`. Press Ctrl-C to
stop before the current database is replaced." and the same elapsed line. It
does not print the size or limit up front, because only the restore's own
lookup knows the selected generation; its deadline message names both.

A deadline gives: "The pre-compact backup did not finish within 29 minutes,
the limit for a 7.0 GB store, so the database was not changed. Check that the
disk is not busy or failing, then retry." Restore's equivalent ends "…so the
current database was not changed."

## Data safety on every path

Compaction steps 1 to 7 and 9 to 12 are unchanged from #230 D9.

| Path                                                 | State left                                                                                                                                                       | Reported                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pre-compact backup fails or hits its deadline        | Live store as found (the copy only reads). Staging removed. No generation.                                                                                       | `CompactFailed { phase: "backup", backupId: null }` with the cause.                         |
| Ctrl-C during the backup                             | Same. The token stops the copy, hash or `quick_check` within one step.                                                                                           | `Cancelled { backupId: null }`: "the database was not changed".                             |
| Disk full during the backup                          | The online backup or a write fails; same as a failure. The free-space precheck (#230 D7) makes this rare.                                                        | The `SQLITE_FULL` or I/O error in the message.                                              |
| Crash or kill during the backup                      | Live store intact: the maintenance connection has written nothing before the backup (#230 D3 step 4). A `.<id>.staging` entry stays and is ignored by inventory. | Next run works. The orphan is disk space only (Follow-ups).                                 |
| Failure after publication (reload, retention)        | Unchanged from #230: the published generation is kept.                                                                                                           | As today.                                                                                   |
| Restore fails, deadline or Ctrl-C before the journal | Live store untouched. Staging and empty preserved directory removed. The store starts as before.                                                                 | The cause, or `Cancelled`.                                                                  |
| Disk full during the restore copy                    | Same as a failure before the journal. After the journal, restore only renames on one volume, so it needs no space.                                               | As above.                                                                                   |
| Crash or kill before the restore journal             | Staging entry left. The next `restore` or `start-empty` clears it (O4).                                                                                          | Startup reports `RecoveryIncomplete` until then, which opens the desktop's recovery dialog. |
| Crash or kill after the restore journal              | Unchanged: the journal blocks startup and the live files are preserved in `recovery/`.                                                                           | As today.                                                                                   |
| Desktop kills a WSL restore                          | Prevented by the scaled timeout. An older desktop driving a newer WSL binary still kills at 30 s; that is the pre-journal crash row.                             | "WSL recovery timed out."                                                                   |
| A listed backup rotted after publication             | Restore refuses it before touching the live store (O3).                                                                                                          | "The selected backup exists but failed verification."                                       |

## Tests

"Sparse large generation" means a generation created normally whose
`state.sqlite` is then extended with `set_len` to 256 GiB and whose manifest's
`databaseSizeBytes` is rewritten to match (its SHA-256 is left stale), as
`recovery_lookup_verifies_only_the_selected_generation` (`backup.rs:3121`)
does. Those tests are `#[cfg(unix)]`: Linux and macOS CI filesystems
allocate sparse files, while NTFS may allocate the whole length. Windows
shares the code path. Every test below fails before the change, unless marked
"new API".

Unit, `persistence/backup.rs`:

1. `store_io_budget_scales_with_bytes_and_saturates`: `LARGE_STORE` gives 30 s
   for 0 bytes, 30.001 s for 1 byte (rounded up), 270 s for 1 GiB and 24 h for
   `u64::MAX`; `FIXED` gives 30 s for any size. New API.
2. `created_at_is_taken_when_the_manifest_is_written`: through
   `create_verified_backup_with` and a test-only `BackupFault::PauseAfterCopy(1.5 s)`,
   the manifest's `created_at` is at least the call's start plus 1.5 s, and the
   generation inventories as verified. Before the change it equals the start.
3. `a_backup_past_the_fixed_budget_publishes_under_its_deadline`: the same
   pause with a 3 s deadline publishes; with a 1 s deadline it fails with
   `DeadlineElapsed`, and the store directory holds no `.staging` entry and no
   new generation.
4. `every_pre_publication_failure_removes_its_staging_directory`: the existing
   `every_post_backup_failure_seam_preserves_source_bytes_and_schema` drops its
   manual `remove_dir_all` (`backup.rs:3339`) and asserts that, for
   `BeforeQuickCheck` to `BeforePublish`, no `.staging` entry remains, and for
   `BeforeParentSync` and `BeforeReloadVerification` the published generation
   remains. Source bytes and schema stay unchanged.
5. `cancelling_a_backup_mid_copy_removes_its_staging`: a test-only
   `BackupFault::CancelAfterFirstStep` cancels the caller's token after the
   first 128-page step of a multi-step fixture; `Cancelled`, no staging, no
   generation.
6. `listing_and_retention_read_only_metadata_of_a_large_generation`
   (**Unix only**): beside one sparse large generation,
   `inventory_blocking` with a 2 s deadline lists it as verified; then three
   `create_verified_backup_with(PreUpdate)` calls with 5 s deadlines publish,
   and the third expires and deletes the large generation. Before the change
   the inventory hashes 256 GiB and fails with `DeadlineElapsed` at 2 s.
7. `restore_deadline_is_scaled_by_the_selected_backup`: through
   `restore_backup_with_fault`, a test-only `RecoveryFault::PauseAfterLookup(1.5 s)`
   and a test budget of `StoreIoBudget { base: 1 s, per_gib: 48 h }`, restore
   succeeds and the rows read back; with `per_gib: 0` it fails with
   `DeadlineElapsed`. Only the size term differs between the two runs, so the
   pass proves the deadline grows with the selected generation's length (the
   fixture's few KiB at 48 h per GiB give several seconds). New API, plus
   test 8's cleanup assertions on the failing case.
8. `restore_failure_before_the_journal_removes_its_staging_and_stays_startable`:
   a new `RecoveryFault::BeforeJournal`. Error; no `.recovery-staging` entry, no
   journal, no new `recovery/` directory; live database, marker and state
   directory listing unchanged; `prepare_store` succeeds. Before the change it
   fails with `RecoveryIncomplete`.
9. `restore_clears_an_abandoned_staging_entry_without_a_journal`: three roots.
   A `.<uuid>.recovery-staging` with only `state.sqlite` and `environment-id`:
   restore succeeds and the entry is gone. The same with an extra file:
   `RecoveryInProgress` and the entry untouched. A staging entry with a recovery
   journal: `RecoveryInProgress`, unchanged from today.
10. `restore_cancelled_before_the_journal_changes_nothing`: the token is
    cancelled during `PauseAfterLookup`. `Cancelled`, and the assertions of
    test 8.

Integration, `apps/server/tests/project_data_safety.rs`:

11. `compact_reports_a_size_scaled_backup_budget`: for the dry run and the real
    run, `plan.backupBudgetSeconds` equals
    `StoreIoBudget::LARGE_STORE.for_bytes(pageCount × pageSize)` rounded up
    to seconds; the profiler `storage.compact` end event's `backupBudgetMs`
    agrees (extending the existing compaction profiler test).
12. `compact_cancelled_during_the_backup_publishes_nothing`:
    `CompactTestHook::CancelDuringBackup` (the token is cancelled after the
    first copy step). `Cancelled { backupId: null }`; no generation and no
    staging entry; `state.sqlite`, `-wal` and `-shm` byte-identical, on the
    clean store and on the crash-left WAL fixture; a following `inspect`
    reports `existing`. Before the change the backup completes and publishes.
13. `a_pre_compact_backup_longer_than_its_base_budget_compacts_and_restores`:
    the acceptance test. `CompactTestHook::LongBackup { pause: 1.5 s, budget:
    StoreIoBudget { base: 1 s, per_gib: 48 h } }` compacts; the pre-compact
    generation inventories as verified and its `created_at` is within 1 s of
    its publication time. `restore_backup` of that ID then brings every
    projection row back to the pre-compact snapshot and restores
    `autoVacuum: "none"`. A second run with `per_gib: 0` refuses with
    `CompactFailed { phase: "backup" }` and the budget message, leaving the
    database byte-identical and no staging entry.
14. `compact_beside_a_large_pre_compact_generation_expires_it_unread`
    (**Unix only**): an earlier pre-compact generation made sparse and large.
    Compaction succeeds under the normal budget, retention deletes the large
    generation, and the new one is verified. Before the change retention fails
    with `DeadlineElapsed`, so compaction fails at `phase: "backup"`.
15. `inspection_and_a_pre_update_backup_succeed_beside_a_large_backup`
    (**Unix only**): `inspect_store` lists the sparse large generation with no
    issue, and `create_verified_backup(PreUpdate)` with the unchanged 30 s
    budget publishes. Before the change inspection fails at 30 s.

Desktop, `apps/desktop/src-tauri/src/data_safety.rs`:

16. `wsl_restore_timeout_covers_the_server_restore_budget`: restore of a
    0-byte and an 8 GiB backup gets `LARGE_STORE.for_bytes(size) +
    RECOVERY_TIMEOUT + 30 s`; inspect and start-empty keep 30 s.

CLI, `apps/server/src/lib.rs`:

17. `long_operation_lines_name_the_size_and_limit`: the backup and elapsed
    lines and the compact and restore deadline messages, for 0 bytes, 7 GiB
    and a limit under one minute ("30 seconds").

Unchanged and must pass: every test the #230 design lists under item 25;
`recovery_lookup_verifies_only_the_selected_generation`;
`recovery_restore_rejects_a_tampered_manifest_without_mutating_the_live_store`
and `..._checksum_valid_non_sqlite_backup_...` (restore still verifies
content); `forged_schema_future_and_backdated_manifests_are_untrusted_and_untouched`,
`generations_with_extra_nested_symlink_or_hardlinked_content_are_never_deleted`
and the inventory trust tests in `persistence_backup.rs` (all structural, so
still issues). The callers of `restore_backup` in tests and the desktop add the
token argument; nothing else in them changes.

Not tested: real `SIGINT` delivery (the token paths are tested by 5, 10 and 12) and a real full disk (a write error takes the same path as the injected
faults in 4 and 8).

Gates: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo test --workspace`, `vp check`, `vp run typecheck`.

## Measurement

Before merge, the implementation PR records a dated capture under
`docs/architecture/measurements/` with:

- the on-disk `fileBytes`, `pageCount` and `freelistCount` of the #225 load
  fixture store (`apps/server/examples/write_load_fixture.rs` on
  `origin/v015b/225-load-budget`) and of the 300 MB benchmark store;
- `backupMs`, `vacuumMs` and restore time for a synthetic store of at least
  4 GiB on the Windows development machine and one Linux CI runner.

`LARGE_STORE.per_gib` is kept at 240 s unless the slowest measured time per GiB
for creation or restore, times three, exceeds it; then it is raised to that.

## Profiler, crash and trace coverage

- **Events.** `storage.compact`'s end event gains `backupBudgetMs`. An outcome
  of `cancelled` or `failed` with `failedStep: "backup"` now always means no
  backup was published. `docs/skills/bibcode-profiler/references/events.md`
  and the overview's Profiler section say both. Restore has no profiler event
  today and gets none here.
- **Tracing.** `tracing::warn!` when staging cleanup leaves content behind;
  `tracing::info!` when restore clears an abandoned staging entry. Both name
  no path beyond the entry name, as `apply_retention` already logs.
- **Not applicable:** child processes, RPC methods and `is_long_running`,
  worktree removal, binaries and re-exec modes, shutdown ordering.

## CLI output

- `compact` stdout: unchanged shape; `plan.backupBudgetSeconds` becomes the
  scaled value for both the dry run and the real run, so the dry run now
  predicts the limit.
- `compact` and `restore` stderr: the lines in O6.
- `restore` stdout: unchanged.

## Code changes (for the implementation PR)

- `persistence/backup.rs`: `StoreIoBudget`; `created_at` in
  `finish_and_publish_backup`; remove the skew assertion; a verification level
  on `verify_generation` (`Structural` in `inventory_blocking` and
  `delete_verified_generation_inner`; `Content` for reload and restore lookup);
  `create_verified_backup_with`; staging cleanup on failure in creation and
  restore; the abandoned-staging rule in `ensure_no_recovery_in_progress`
  callers for restore and start-empty; restore's size-scaled deadline and
  `CancellationToken` parameter; the test seams named in Tests.
- `persistence/compaction.rs`: `create_verified_backup_with` with the
  caller's token and `LARGE_STORE`; the new hooks; the deadline message;
  `backupBudgetMs`.
- `lib.rs`: the phase and elapsed lines; Ctrl-C for `restore`.
- `apps/desktop/src-tauri/src/data_safety.rs`: the WSL restore timeout; the
  native restore passes a token.
- No contract, schema or web change.

## Documentation

- `docs/guides/project-data-recovery.md`: drop "not supported yet"; state the
  time limit, the progress lines and Ctrl-C for compact and restore; say that
  inspection checks each backup's location, manifest, size and migration
  history, and that restore also checks its checksum and integrity before it
  touches the current database.
- `docs/architecture/overview.md`: the backup paragraph (`created_at` at
  publication, `Structural` listing and deletion, the size-scaled budgets,
  staging cleanup) and the offline recovery paragraph (restore deadline,
  Ctrl-C, abandoned staging).
- `docs/skills/bibcode-profiler/references/events.md`: `backupBudgetMs`.
- `docs/testing/`: reviewed. No runbook covers storage CLI commands; they
  remain accurate unless the implementation adds a native validation step.

## Recommendation

Implement O2, O3, O4, O5 and the phase-line form of O6 together, as one
change. O3 is the precondition: without it a large pre-compact generation
breaks inspection, the desktop's list and every later pre-update and
pre-migration backup. O2 removes the skew conflict without weakening the skew
check. O4 and O5 give creation and restore one size-scaled deadline, with
Ctrl-C and cleanup on every failure before the point of no return. Reject O1
and percentage progress.

This meets the three acceptance criteria (tests 13, 14 and 15 with 6). It adds
one struct, one verification level, one creation entry point and two cleanup
rules, and changes no persisted shape, contract or server-path budget.

## Risks

- `per_gib` is a placeholder until the measurement. Too small refuses a slow
  disk (safely); too large only delays reporting a stuck one, which Ctrl-C
  ends.
- Rot after publication is found at restore time and may take one of the
  three retention slots (O3).
- A cold disk cache at restore time is slower than creation's warm one; the
  shared budget has six passes of margin at 25.6 MiB/s.
- A crash during a pre-compact backup leaves a `.staging` copy that only
  costs disk space.
- An older desktop driving a newer WSL binary kills a long restore at 30 s;
  the next restore clears the abandoned staging.
- The 5 s startup validation still refuses stores whose `quick_check` exceeds
  it, before and after compaction or restore.

## Follow-ups

- Startup and inspection validation of stores whose `quick_check` exceeds 5 s.
- Compaction clearing orphaned `.staging` entries of its own identity under
  its locks.
- A `storage.restore` profiler event.
- Percentage progress, if the elapsed line proves insufficient.
