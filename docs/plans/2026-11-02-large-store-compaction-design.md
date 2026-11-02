# Large-Store Compaction

Status: Approved 2026-11-02 (user decision + Codex review, 3 rounds; see
"Review findings and resolutions" at the end). Design for issue 262, verified against
PR #248 (`origin/v015/230-storage-compact` at `4923e9be2`) merged onto `main`
at `fd98b4330`. It builds on the approved
[storage compaction design](2026-11-01-storage-compaction-design.md) (called
"the #230 design" below) and lifts its D5 scope-down. It changes what a backup
inventory verifies and what retention must verify before it deletes, when a
manifest's `created_at` is taken, the backup and restore deadlines, the
restore failure cleanup, how the recovery journal is published, and how an
interrupted journaled restore is completed. The only persisted shape that
changes is the transient recovery journal (O7).

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

| Level        | Checks                                                                                                                                                                                                                                                                                                        | Used by                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Structural` | Everything that does not grow with the file: boundary and identity, exact entries, single links, manifest decode, ID and location, canonical UTC `created_at` and its skew, checksum syntax, `database_size_bytes` equal to the file's metadata length, and the manifest's ledger version (a few pages read). | Inventory (`inspect`, the desktop's list, the candidate list retention starts from) and the two identity re-checks immediately before a file is removed. |
| `Content`    | `Structural`, plus the SHA-256 of the file and `quick_check`.                                                                                                                                                                                                                                                 | The reload verification right after publication, retention's replacements (below), and restore's lookup of the selected generation (as today).           |

Restore keeps verifying the content of the generation it installs twice: the
selected generation before the copy, and the staged copy against the manifest
(`copy_verified_database`, `backup.rs:1567-1579`). A generation that changed
after publication is therefore still never installed. What changes:

- A generation whose bytes rot after publication, at the same length, is
  listed until it is selected. Its restore then fails before any live file is
  touched (`recovery_restore_rejects_a_tampered_manifest_without_mutating_the_live_store`
  pins this), and the user picks an older one. Retention never counts it as a
  replacement (below). Tampering through the filesystem is still caught by
  the identity, link and location checks, and replacement by the size, mtime
  and ledger checks.
- Inventory cost no longer grows with backup size, so the 30 s inventory
  deadline stays and the desktop's WSL inspection keeps its 30 s timeout.
- Creation reads about 5 `N`, plus at most two more generations' content when
  retention has something to delete, instead of 17 `N`. The pre-update and
  pre-migration budgets do not change, but larger stores now fit in them.
- An expired generation is not read before it is deleted: what justifies the
  deletion is its replacements' content, not its own. The identity checks that
  make the removal itself safe are unchanged.

**Retention deletes only behind content-verified replacements.** A
structurally listed generation is a deletion candidate, never a justification.
`apply_retention` walks the structural list newest first (by publication
time, as today) and `Content`-verifies each generation until it has
`RETAINED_GENERATIONS` that pass. The generation just published counts without
a second read: its reload verification in the same call was `Content`, and the
walk re-checks its identity. A generation that fails `Content` verification is
skipped, kept and logged as today's issues are. Only the generations older than
the third passing one are deleted. #230 D6's rule is unchanged: a new
`pre-compact` generation, `Content`-verified at its publication, replaces the
older `pre-compact` ones.

The walk runs under the creation's remaining deadline and token. If either
ends before three replacements pass, retention deletes nothing in this call,
logs `tracing::warn!`, and the creation still succeeds, because the new
generation is already published and verified. So a pre-update backup with its
`FIXED` 30 s beside a large pre-compact generation in the newest three keeps
an extra generation instead of failing. That lasts until three newer
generations exist; then the large one is no longer needed as a replacement,
and is deleted without being read. Today's behavior is the same where it
matters: content failures never justify a deletion, and the issue's example (a
good A, then B and C corrupted at the same length, then D from an empty but
valid store, the review's example) keeps A (test 18).

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

A restore that fails before its journal is published (O7) now removes what it
created. It removes the staged `state.sqlite` and `environment-id` by name,
after the same identity checks it used to create them, an owned temporary
journal (O7), then the staging directory and its still-empty preserved
directory, with `remove_dir` (never recursive). That covers a deadline,
Ctrl-C, disk full and any I/O error. A crash or kill in the same window leaves
the staging entry behind, so the next `restore` or `start-empty`, under both
locks, clears a `.<uuid>.recovery-staging` entry and its temporary journal
when no published recovery journal exists and the entry holds nothing but
those two plain files. Any other content keeps today's `RecoveryInProgress`
refusal; a published journal is finished by `--resume` (O7). This is safe because the
journal is published (renamed into place and synced) before the first live
file moves, and the staging entry is removed before the journal, so "staging
without a published journal" always means the live store was never touched.

The CLI gets Ctrl-C: `restore_backup` takes the caller's
`CancellationToken`. The CLI cancels it from `termination_signal()`; the
desktop passes a fresh token. Cancellation is honored until the journal is
published. After that, the commit (renames and directory syncs) is neither
cancellable nor bounded by the deadline, because stopping it half-way is
worse than finishing it.

For WSL, the desktop's restore timeout becomes
`budget(sizeBytes) + RECOVERY_TIMEOUT + 30 s`, using the selected backup's
`sizeBytes` from the validation inspection. That makes the server's own
deadline and cleanup fire first in the normal case, but it is a watchdog, not
a guarantee: the commit's syncs are unbounded, so the desktop can still kill
the process after the journal is published, and the server binary inside WSL
may outlive `wsl.exe` or not. If the restore is still running, the next start
waits on its locks and then finds no journal; if it was killed, the next start
refuses and names `bibcode storage restore --resume` (O7). The desktop reports
"WSL recovery timed out" and then shows the status the next inspection finds.
Inspection and start-empty keep 30 s.

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

### O7. Atomic journal publication, and completing an interrupted commit

**Publication.** Restore and start-empty create the journal at its final path,
then write and sync it (`backup.rs:1243-1250`, `:1380`). Disk full or an I/O
error in either step leaves a partial journal at that path. Startup then
refuses with `RecoveryIncomplete`, restore and start-empty refuse with
`RecoveryInProgress`, and O4 cannot clear it, because a journal means the
commit may have started. The journal is instead published atomically:

1. create `<journal>.<operation-id>.tmp` beside it with `private_create_new`;
2. write it and `sync_all` it;
3. confirm the journal path is absent (both locks are held, so nothing else
   writes it) and `rename` the temporary file onto it;
4. sync the data-root directory.

An error before the rename succeeds (steps 1 to 3) removes the owned
temporary file (after an identity check) and runs O4's cleanup; the live store
has not been touched. A crash in the same window leaves at most a temporary
file beside a staging entry, which O4's rule clears. Startup never reads a
temporary journal.

**The rename is the commit point.** Once it succeeds, no failure path removes
the journal, the staging entry or a staged file: an error in the directory
sync, a rename or a sync after it returns the error and leaves the operation
for `--resume` (below). So no journal is ever left whose files were cleaned
away.

**Completion is explicit (user decision).** After publication the commit
renames the live files into the preserved directory, syncs it, renames the
staged files into place, syncs the state directory, removes the staging entry
and then the journal. A kill, crash or error anywhere in it, including the
desktop's WSL watchdog, leaves the published journal. Startup keeps refusing
with `RecoveryIncomplete`, as today, and moves no file. Its message now names
the one command that finishes the operation:

> An interrupted project-data recovery must be finished before BiBCode can
> open this store. Quit BiBCode, then run `bibcode storage restore --resume`.

The desktop shows that message as the store's issue. `restore --backup-id`
and `start-empty` keep refusing with `RecoveryInProgress`, whose message names
the same command.

- The journal gains `version: 2` and, for a restore, the file identities
  (volume and file ID) of the staged `state.sqlite` and `environment-id`. The
  preserved and staging directories are already named from its `operationId`.
- `bibcode storage restore --resume` (instead of `--backup-id`) takes the
  exclusive runtime lock and the storage-operation lock, as restore does, and
  runs `resume_interrupted_recovery`. It preserves every live `state.sqlite`,
  `-wal`, `-shm` and `environment-id` whose identity is not a staged one into
  the preserved directory (refusing if that name is already taken there),
  syncs the preserved directory, moves any staged file still in staging into
  place, syncs the state directory, removes the empty staging directory,
  removes the journal and syncs the data root. Each step is a rename decided
  from the files, so an interrupted `--resume` is finished by the next one. A
  start-empty journal only finishes preserving. With no journal it clears an
  operation abandoned before its journal was published (O4's rule), or
  reports that there is nothing to resume and changes nothing.
- It refuses, leaving every file as it is, when the journal is not version 2,
  does not parse, names another state kind, or the files match none of the
  states above: an unexpected entry in staging, or a staged file whose
  identity differs.

Roll-forward rather than rollback: the staged copy was `Content`-verified and
synced before the journal was published, so finishing is always possible, and
it is what the user chose. A rollback would run the same renames in reverse
and leave a long restore to be redone.

**The preserved directory is synced** after the last live file is moved into
it and before any staged file moves or the journal is removed, in the restore
commit, the start-empty commit and `--resume`, as `backup.rs:1264` does today.
A failed sync is an error after the commit point, so the journal stays.

**Every writable opener checks the recovery state.** Startup refuses while a
journal or recovery-staging entry exists (`store.rs:138-145`), but the pairing
CLI's `open_existing_data_root` (`lib.rs:376`) and the MCP relay's `open_store`
(`mcp/relay.rs:711`) open the database writable under only the shared runtime
lock and never look. During an interrupted restore they would write into
whatever `state.sqlite` the commit left. The startup check moves into one
`persistence::ensure_no_interrupted_recovery(&paths)`, called by all three
after the shared runtime lock is held (a restore or `--resume` holds it
exclusively, so the state cannot change under the opener), with the same
`RecoveryIncomplete` error and message.

The existing
`restore_failure_after_preservation_keeps_the_journal_and_recoverable_live_files`
keeps every assertion, including that startup refuses; a new assertion checks
that the message names `bibcode storage restore --resume`, and `--resume` then
finishes the restore (test 21).

**Adopted.**

## Data safety on every path

Compaction steps 1 to 7 and 9 to 12 are unchanged from #230 D9.

| Path                                                                       | State left                                                                                                                                                                                                                     | Reported                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Pre-compact backup fails or hits its deadline                              | Live store as found (the copy only reads). Staging removed. No generation.                                                                                                                                                     | `CompactFailed { phase: "backup", backupId: null }` with the cause.                           |
| Ctrl-C during the backup                                                   | Same. The token stops the copy, hash or `quick_check` within one step.                                                                                                                                                         | `Cancelled { backupId: null }`: "the database was not changed".                               |
| Disk full during the backup                                                | The online backup or a write fails; same as a failure. The free-space precheck (#230 D7) makes this rare.                                                                                                                      | The `SQLITE_FULL` or I/O error in the message.                                                |
| Crash or kill during the backup                                            | Live store intact: the maintenance connection has written nothing before the backup (#230 D3 step 4). A `.<id>.staging` entry stays and is ignored by inventory.                                                               | Next run works. The orphan is disk space only (Follow-ups).                                   |
| Failure after publication (reload)                                         | Unchanged from #230: the published generation is kept.                                                                                                                                                                         | As today.                                                                                     |
| Retention runs out of time, is cancelled, or finds corrupt replacements    | Nothing is deleted in this call; the new generation stays published. A corrupt generation is never a replacement (O3).                                                                                                         | A `tracing::warn!`; the creation succeeds.                                                    |
| Restore fails, deadline or Ctrl-C before the journal is published          | Live store untouched. Staging, temporary journal and empty preserved directory removed. The store starts as before.                                                                                                            | The cause, or `Cancelled`.                                                                    |
| Disk full during the restore copy, or while writing or syncing the journal | Same as the row above (O7: the journal is published by rename only after its sync). After publication, restore only renames on one volume, so it needs no space.                                                               | As above.                                                                                     |
| Crash or kill before the journal is published                              | Staging entry, and at most a temporary journal, left. The next `restore` or `start-empty` clears them (O4).                                                                                                                    | Startup reports `RecoveryIncomplete` until then, which opens the desktop's recovery dialog.   |
| Crash or kill during the commit, or an error in it                         | The journal, staging entry and staged files stay (the rename is the commit point). Startup and every writable opener refuse; `bibcode storage restore --resume` finishes it (O7), and every old live file ends in `recovery/`. | `RecoveryIncomplete` naming `--resume`; `--resume` refuses if the files match no known state. |
| Desktop's WSL watchdog fires                                               | Usually the server's own deadline fires first. If the kill lands during the commit, it is the row above. If the process survives `wsl.exe`, it finishes and the next start waits on its locks.                                 | "WSL recovery timed out", then the status the next inspection finds.                          |
| A listed backup rotted after publication                                   | Restore refuses it before touching the live store (O3).                                                                                                                                                                        | "The selected backup exists but failed verification."                                         |

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
   restore succeeds and the entry is gone. The same plus a temporary journal
   (O7): both are cleared and restore succeeds. The same with an extra file:
   `RecoveryInProgress` and the entry untouched. (A staging entry beside a
   published journal is completed instead; tests 21 and 22.)
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
    RECOVERY_TIMEOUT + 30 s`; inspect and start-empty keep 30 s. This only
    pins the arithmetic; what happens when the watchdog kills a restore is
    tested by 21 and 24.

CLI, `apps/server/src/lib.rs`:

17. `long_operation_lines_name_the_size_and_limit`: the backup and elapsed
    lines and the compact and restore deadline messages, for 0 bytes, 7 GiB
    and a limit under one minute ("30 seconds").

Retention (round 2, P1), `persistence_backup.rs` unless noted:

18. `retention_keeps_the_last_good_generation_behind_corrupt_replacements`:
    the review's scenario. A is a pre-update generation of a store with
    projects. B and C are later generations of the same store, then corrupted
    at the same length: B by overwriting bytes inside a table b-tree page with
    its manifest left stale (hash mismatch), C the same with its manifest's
    `sha256` refreshed (hash passes, `quick_check` fails). The live store's
    projects are then deleted, and D is published from that empty but valid
    store. After D: A, B, C and D all remain; `restore_backup` of A brings the
    projects back. Control: with B and C healthy, D's publication deletes A,
    as today. This passes today and fails under round 1's structural
    retention; it guards O3.
19. `retention_defers_instead_of_failing_beside_a_large_replacement`
    (**Unix only**, `backup.rs`): three small generations, then a sparse large
    pre-compact generation, then a pre-update backup with the `FIXED` budget.
    The backup publishes and is returned, nothing is deleted, and a warning is
    logged. After three more small backups the large generation and the older
    small ones are deleted, and the large one's content is never read
    (`set_len` leaves its stale hash, so a read would fail verification and
    keep it). Before the change the creation fails with `DeadlineElapsed`.

Journal publication and commit completion (round 2, P2s), `backup.rs` unless
noted:

20. `a_journal_write_or_sync_failure_leaves_no_journal_and_a_startable_store`:
    `RecoveryFault::JournalWrite` and `RecoveryFault::JournalSync`, each
    returning `io::ErrorKind::StorageFull` (ENOSPC) from inside the step, for
    restore and for start-empty. Error; no journal, no temporary journal, no
    staging entry; live database, marker and listing unchanged;
    `prepare_store` succeeds. Before the change a partial journal stays and
    startup fails with `RecoveryIncomplete`.
21. `resume_finishes_a_restore_interrupted_at_every_commit_step`: the live
    store has `-wal` and `-shm` and different rows from the backup.
    `RecoveryFault::CrashAt(step)` returns at once without any cleanup, as a
    kill would, at each of: after publishing the journal, after preserving the
    database, `-wal`, `-shm` and the marker in turn, after syncing the
    preserved directory, after moving the staged database, after moving the
    staged marker, and after removing the staging directory. Then
    `prepare_store` fails with `RecoveryIncomplete` whose message names
    `bibcode storage restore --resume`, and no file moved. `resume_recovery`
    then succeeds; the database's SHA-256 equals the manifest's; the marker
    holds the backup's storage ID; no old `-wal` or `-shm` sits beside it; the
    preserved directory holds every original live file byte-identical; no
    journal or staging entry remains; `prepare_store` succeeds and the rows
    equal the backup's. A second crash injected during `--resume` itself is
    finished by the next `--resume`. The existing
    `restore_failure_after_preservation_keeps_the_journal_and_recoverable_live_files`
    keeps its assertion that startup refuses, adds the message assertion, and
    ends with `--resume` finishing it.
22. `resume_refuses_a_journal_it_cannot_finish`: a version-1 journal (as
    written today), a journal for the other state kind, an extra entry in
    staging, and a staged database whose identity differs from the journal's.
    Each gives an error, and every file stays byte-identical and in place.
    With no journal, `--resume` reports nothing to resume and changes nothing.
23. `resume_finishes_an_interrupted_start_empty`: a crash after preserving
    the database only. Startup refuses naming `--resume`; `--resume` finishes
    preserving the WAL, `-shm` and marker and removes the journal; the next
    `prepare_store` starts a first-run store.
24. `a_killed_restore_process_is_finished_by_restore_resume`
    (**Unix only**, `apps/server/tests/cli_smoke.rs`): spawns the debug
    `bibcode storage restore` with `BIBCODE_TEST_PAUSE_RECOVERY=<step>` and
    `BIBCODE_TEST_PAUSE_RECOVERY_MARKER=<file>`, a hook compiled only under
    `debug_assertions` that writes the marker and blocks at that commit step;
    sends `SIGKILL` once the marker exists; then `bibcode storage inspect`
    reports `recovery-incomplete` with the `--resume` message,
    `bibcode storage restore --resume` succeeds, and the store opens with test
    21's assertions. Run for the journal-published and database-moved steps.
    This is the watchdog kill with a real process instead of a returned error.

Round 3:

25. `writable_openers_refuse_during_an_interrupted_restore`: with a published
    journal left by `CrashAt(AfterPreserveDatabase)`, the pairing CLI's
    `open_existing_data_root` (`lib.rs` unit test) and the MCP relay's
    `open_store` (`mcp/relay.rs` unit test) fail with the `RecoveryIncomplete`
    message naming `--resume`, and create no file; the same with only an
    abandoned recovery-staging entry. Before the change both open the
    database.
26. `a_preserved_directory_sync_failure_keeps_the_journal_for_resume`:
    `RecoveryFault::PreservedSync` fails the sync of the preserved directory,
    in restore and in start-empty. Error; journal, staging and staged files
    stay; no staged file was moved; `--resume` then finishes. A source check
    confirms the sync precedes the first staged move.
27. `a_failure_after_the_journal_rename_keeps_the_operation_for_resume`:
    `RecoveryFault::JournalDirectorySync` fails the data-root sync right after
    the rename. Error; the journal, staging entry and staged files remain (no
    stranded journal); startup refuses naming `--resume`; `--resume`
    finishes.

Unchanged and must pass: every test the #230 design lists under item 25;
`recovery_lookup_verifies_only_the_selected_generation`;
`recovery_restore_rejects_a_tampered_manifest_without_mutating_the_live_store`
and `..._checksum_valid_non_sqlite_backup_...` (restore still verifies
content); `forged_schema_future_and_backdated_manifests_are_untrusted_and_untouched`,
`generations_with_extra_nested_symlink_or_hardlinked_content_are_never_deleted`
and the inventory trust tests in `persistence_backup.rs` (all structural, so
still issues). The callers of `restore_backup` in tests and the desktop add the
token argument; nothing else in them changes.

Not tested: real `SIGINT` delivery (the token paths are tested by 5, 10 and
12), a real full disk (an injected `StorageFull` error takes the same path, 4,
8 and 20), power loss between a rename and its directory sync, and a real
WSL watchdog kill on Windows (24 kills a real process on Unix).

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
- **Tracing.** `tracing::warn!` when staging cleanup leaves content behind,
  when retention defers, and when `--resume` refuses a journal it cannot
  finish; `tracing::info!` when restore clears an abandoned staging entry and
  when `--resume` finishes an interrupted restore or start-empty. They name no
  path beyond the entry or operation ID, as `apply_retention` already logs.
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
  `delete_verified_generation_inner`; `Content` for reload, retention's
  replacements and restore lookup); the newest-first replacement walk and
  deferral in `apply_retention`; `create_verified_backup_with`; staging
  cleanup on failure in creation and restore; the abandoned-staging rule in
  `ensure_no_recovery_in_progress` callers for restore and start-empty;
  restore's size-scaled deadline and `CancellationToken` parameter; atomic
  journal publication for restore and start-empty; the preserved-directory
  sync before staged moves; the version-2 journal and `resume_recovery`; the
  test seams named in Tests.
- `persistence/store.rs`: `ensure_no_interrupted_recovery`, used by startup;
  its message names `--resume`.
- `lib.rs` (`open_existing_data_root`) and `mcp/relay.rs` (`open_store`): call
  `ensure_no_interrupted_recovery` after the shared runtime lock.
- `config.rs`: `storage restore --resume`, exclusive with `--backup-id`.
- `main.rs` or `lib.rs`: the `debug_assertions`-only
  `BIBCODE_TEST_PAUSE_RECOVERY` hook for test 24.
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
  staging cleanup, retention behind content-verified replacements) and the
  offline recovery paragraph (restore deadline, Ctrl-C, abandoned staging,
  atomic journal, `restore --resume`, the opener gate).
- `docs/guides/project-data-recovery.md` also says that an interrupted restore
  is finished with `bibcode storage restore --resume`, and what to do when it
  refuses.
- `docs/skills/bibcode-profiler/references/events.md`: `backupBudgetMs`.
- `docs/testing/`: reviewed. No runbook covers storage CLI commands; they
  remain accurate unless the implementation adds a native validation step.

## Recommendation

Implement O2, O3, O4, O5, O7 and the phase-line form of O6 together, as one
change. O3 is the precondition: without it a large pre-compact generation
breaks inspection, the desktop's list and every later pre-update and
pre-migration backup, and its retention rule keeps today's guarantee that
only content-verified generations justify a deletion. O2 removes the skew
conflict without weakening the skew check. O4 and O5 give creation and restore
one size-scaled deadline, with Ctrl-C and cleanup on every failure before the
journal. O7 makes the journal's publication atomic and its commit completable,
which a long restore under a watchdog needs. Reject O1 and percentage
progress.

This meets the three acceptance criteria (tests 13, 14 and 15 with 6). It adds
one struct, one verification level, one creation entry point, two cleanup
rules and journal completion. It changes only the transient journal's shape,
no contract and no server-path budget.

## Risks

- `per_gib` is a placeholder until the measurement. Too small refuses a slow
  disk (safely); too large only delays reporting a stuck one, which Ctrl-C
  ends.
- Rot after publication is found at restore time. It never justifies a
  deletion, but it can keep an extra generation on disk (O3).
- Retention beside a large replacement defers deletion, so up to two extra
  generations can stay until three newer ones exist (O3, test 19).
- An interrupted restore needs a person to run `--resume` (user decision);
  until then the store does not open. The message names the command.
- An older binary that finds a version-2 journal refuses, as it does for any
  journal today; a newer binary refuses a version-1 journal (test 22).
- A cold disk cache at restore time is slower than creation's warm one; the
  shared budget has six passes of margin at 25.6 MiB/s.
- A crash during a pre-compact backup leaves a `.staging` copy that only
  costs disk space.
- An older desktop driving a newer WSL binary kills a long restore at 30 s;
  the next restore clears the abandoned staging, or `--resume` finishes the
  commit.
- The 5 s startup validation still refuses stores whose `quick_check` exceeds
  it, before and after compaction or restore.

## Follow-ups

- Startup and inspection validation of stores whose `quick_check` exceeds 5 s.
- Compaction clearing orphaned `.staging` entries of its own identity under
  its locks.
- A `storage.restore` profiler event.
- Percentage progress, if the elapsed line proves insufficient.

## Review findings and resolutions

Round 2 (Codex, on `8a416944e`):

| #     | Finding                                                                                                                                                                                                                                                 | Resolution                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r2-P1 | Retention driven by a structural-only listing can delete the last usable generation: with A good, B and C corrupted at the same length and D from an empty valid store, it keeps B, C and D and deletes A. Today's retention excludes content failures. | Listing stays structural, but retention deletes only behind `RETAINED_GENERATIONS` replacements that pass `Content` verification now, walked newest first under the creation's deadline; otherwise it defers (O3). Tests 18, 19.         |
| r2-P2 | The journal is created at its final path before it is written and synced, so ENOSPC leaves a partial journal that O4 then refuses to clear, blocking startup and recovery.                                                                              | Atomic publication: temporary file, write, `sync_all`, rename, directory sync; an owned temporary journal is removed on failure and cleared after a crash (O7, O4). Test 20, and 9 for the crash case.                                   |
| r2-P2 | The WSL watchdog can kill a restore during its journaled commit, whose syncs ignore the deadline; round 1 claimed the server's deadline always fires first, and only tested the arithmetic.                                                             | The claim is withdrawn (O4). A version-2 journal records the staged identities, and startup, `restore` and `start-empty` roll the commit forward from the files, or refuse as today when they match no known state (O7). Tests 21 to 24. |

Round 3 (user decision, and Codex on `193527d7e`):

| #        | Finding                                                                                                                                                              | Resolution                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| decision | An interrupted restore is finished by an explicit command, not at startup.                                                                                           | Startup refuses as today and names `bibcode storage restore --resume`, which finishes it under both locks (O7). Tests 21 to 24. |
| r3-P1    | The pairing CLI's `open_existing_data_root` and the MCP relay's `open_store` open writable SQLite without checking for a recovery journal, under a shared lock only. | `ensure_no_interrupted_recovery` gates all three writable openers after the shared runtime lock (O7). Test 25.                  |
| r3-P1    | The preserved directory must be synced after files move into it and before the journal is removed.                                                                   | The sync runs before any staged move, in restore, start-empty and `--resume`; a failure keeps the journal (O7). Test 26.        |
| r3-P2    | A failure after the journal rename must not strand a journal whose files were cleaned up.                                                                            | The rename is the commit point: after it, failures keep the journal, staging and staged files for `--resume` (O7). Test 27.     |
