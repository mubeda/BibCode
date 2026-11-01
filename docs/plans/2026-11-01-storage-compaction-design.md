# Storage Compaction

Status: Proposed 2026-11-01, revision 2, awaiting approval. Design for issue
230, verified against `9c8799b80` (v0.14.0). Implementation must not start
before approval (AGENTS.md, Architectural Decision Standards): it changes a
persisted shape (`auto_vacuum` on new stores, a new manifest trigger, a
retention rule) and adds a CLI write path.

Revision 2 answers a review (see "Review findings and resolutions" at the end).
In short: compaction no longer reuses the inspection classifier; inspection
never opens SQLite when exactly one sidecar exists; the dry run never opens a
writable connection or creates a lock file; compaction keeps the existing 30 s
backup and restore budgets instead of extending them (large stores are a
follow-up); and cancellation is checked inside the SQLite worker.

## Problem

`state.sqlite` never gives space back. Activity retention
(`apps/server/src/activity/repository.rs`), MCP activity and reserved command
receipts (`apps/server/src/persistence/repositories.rs`) delete rows, but every
store is created with SQLite's default `auto_vacuum = NONE` and nothing runs
`VACUUM`. `bibcode storage inspect` shows no size information, and the recovery
guide forbids touching the database while BiBCode runs, so users have no
supported way to see or reclaim the space.

## Current behavior

- **Connection setup.** `open_connection`
  (`apps/server/src/persistence/database.rs:752`) sets `busy_timeout` 5 s,
  `foreign_keys`, `synchronous = FULL`, `journal_mode = WAL`,
  `wal_autocheckpoint` 1,000 pages and `journal_size_limit` 64 MiB. Read-only
  opens stop after `busy_timeout`. No `auto_vacuum`.
- **First run.** `prepare_first_run` (`store.rs:225`) calls
  `Database::create_new` (`database.rs:408`). That reserves a random
  same-directory staging file, opens it once through `open_connection`, closes
  it, refuses if a sidecar remains, hard-links it to `state.sqlite`, and reopens.
  `migrate` then creates the first table. The staging open is the only place
  where a connection sees a zero-page database.
- **Ownership.** Every server (`lifecycle.rs:236`), `bibcode mcp` relay
  (`mcp/relay.rs:720`) and pairing CLI (`lib.rs:298`) holds
  `.bibcode-runtime.lock` shared. `OfflineRecoveryGuard` (`backup.rs:351`)
  `try_lock`s it exclusively and fails with `RecoveryError::StoreRunning`. Its
  `open_private_lock_file` **creates** the lock file when missing.
  `StoreOperationGuard` (`backup.rs:376`) serializes storage operations on
  `.bibcode-storage.lock` with a timeout.
- **Inspection.** `inspect_store` (`backup.rs:607`) takes no lock. It classifies
  the store with `validate_existing_store_for_inspection` (`store.rs:339`).
  That opens `immutable=1` when no `-wal`/`-shm` exists and a plain read-only
  connection otherwise (`coherent_validation_snapshot`, `migrations.rs:384`:
  an online-backup copy into memory, retried on busy until
  `VALIDATION_TIMEOUT = 5 s`, `migrations.rs:17`). A read-only WAL open
  creates a missing `-shm` when it can
  ([SQLite WAL, read-only databases](https://www.sqlite.org/wal.html)), so a
  root with `-wal` but no `-shm` is mutated by inspection today. The
  immutable path's `quick_check` shares the same 5 s deadline. It also
  inventories backups. The CLI prints
  `classification`, `storageInstanceId`, `backups`, `backupIssues`,
  `requestedRoot`, `effectiveRoot`, `isFilesystemAlias`, `issue`
  (`lib.rs:205`). Storage commands always print JSON: pretty, or compact with
  `--json`. Errors go to stderr as `bibcode: <Display>`.
- **Backups.** `create_verified_backup` (`backup.rs:521`) copies the live
  connection page by page with the online-backup API
  (`backup_to_cancellable`, `database.rs:663`). It then verifies the copy
  (SHA-256, `quick_check`, ledger version) and publishes it atomically. After
  that, `apply_retention` (`backup.rs:2159`) keeps the newest
  `RETAINED_GENERATIONS = 3` verified generations, whatever their trigger.
  The whole operation is bounded by `BACKUP_TIMEOUT = 30 s`, and it includes
  the reload verification and the inventory that retention runs, which hash
  and `quick_check` every generation. `created_at` is taken before the copy
  (`backup.rs:533`), and verification rejects a manifest more than
  `MAX_PUBLICATION_TIME_SKEW = 60 s` from the generation directory's mtime
  (`backup.rs:2024`). Restore runs under `RECOVERY_TIMEOUT = 30 s`
  (`backup.rs:846`); it verifies only the selected generation, copies it,
  re-verifies the copy and moves the live files aside by rename, which is no
  more work than creating that generation was. The triggers are
  `PreMigration` (`store.rs:303`) and `PreUpdate` (`maintenance.rs:506`).
- **Older readers.** `verify_generation` (`backup.rs:1976`) decodes the
  manifest with serde before any other check. An unknown `trigger` value
  becomes a `ManifestDecode` inventory issue. Issues are never selected for
  retention deletion (`apply_retention` deletes only verified generations).
- **Trigger reaches the desktop UI.** `DesktopProjectDataBackup.trigger`
  (`apps/desktop/src-tauri/src/data_safety.rs:155`, WSL parse `:245`) is
  `BackupTrigger` and the contract is
  `Schema.Literals(["pre-migration", "pre-update"])`
  (`packages/contracts/src/ipc.ts:318`). The dialog prints it raw
  (`ProjectDataRecoveryDialog.tsx:107`).
- **No tracing subscriber in storage CLI commands.** Only the server runtime
  calls `logging::initialize_owned` (`lifecycle.rs:226`), and the profiler
  handle is installed only by the server runtime. So today `tracing::warn!` in
  backup code goes nowhere when it runs from `bibcode storage`.
- **Implicit rowids.** `VACUUM` may renumber rowids of tables without an
  `INTEGER PRIMARY KEY`, keeping their order. BiBCode uses implicit `rowid` only
  inside a single statement (`activity/repository.rs:1674`,
  `connect_mcp.rs:1445`, `pull_requests/snapshot_store.rs:174`) and as an
  ordering tie-breaker (`repositories.rs:3635`). Order is preserved, so no
  stored reference breaks.

## Goals and non-goals

Goals: the three changes in the issue. (1) `inspect` reports space and stays
non-mutating. (2) New stores use `auto_vacuum = INCREMENTAL`. (3) An offline,
backed-up `bibcode storage compact [--dry-run] [--json]` reclaims free pages.

Non-goals (from the issue): pruning `orchestration_events`; background
`incremental_vacuum`; a settings or diagnostics notice; changing
`synchronous`, WAL limits or `busy_timeout`; desktop UI for compaction.

Scoped down: compacting stores too large for the existing 30 s backup budget
(D5). Every acceptance criterion of the issue is met without it, and the
issue states that no real store sizes or `VACUUM` timings are measured yet
(#225). Such stores are refused before anything is written, with a message
that says why.

## Decisions

### D1. `inspect` space fields and the non-mutating read

Add a `database` object to the inspect output, present when `state.sqlite`
exists (otherwise `null`):

```json
"database": {
  "fileBytes": 7537000448,
  "walBytes": 0,
  "shmBytes": 0,
  "pageSize": 4096,
  "pageCount": 1840088,
  "freelistCount": 830000,
  "reclaimableBytes": 3399680000,
  "autoVacuum": "none",
  "databaseStatsUnavailable": null
}
```

- `fileBytes`, `walBytes`, `shmBytes` come from `symlink_metadata`. An absent
  sidecar is `0`. These are always reported.
- `pageSize`, `pageCount`, `freelistCount`, `autoVacuum` (`none` / `full` /
  `incremental`) and `reclaimableBytes = freelistCount × pageSize` come from
  `PRAGMA page_size`, `page_count`, `freelist_count` and `auto_vacuum`. Each is
  a header read, so the cost does not grow with database size. When any is
  unavailable, all five are `null` and `databaseStatsUnavailable` names why:
  - `"store-running"`: a process holds the runtime lock;
  - `"uncheckpointed-wal"`: offline, but a `-wal`/`-shm` exists (a crash, or
    another SQLite program has the file open), so a header read would show
    stale numbers;
  - `"unreadable"`: the immutable open or a pragma failed (not a SQLite file,
    or the lock file vanished mid-read).

  The stats do not depend on the classification. A healthy store whose
  `quick_check` exceeds the classifier's 5 s deadline still reports its
  sizes and free pages, which is exactly the store a user wants to measure.

The classifier also gets a sidecar rule (review finding 2). Today it opens a
plain read-only connection whenever either sidecar exists, and that open
creates a missing `-shm`. New rule in `validate_existing_store_for_inspection`:

- no sidecar: `immutable=1`, as today;
- both sidecars: the plain read-only path, as today. Nothing is created,
  because both files already exist;
- exactly one sidecar: SQLite is not opened. The classification is
  `unsafe-database-state` with the issue "A SQLite sidecar file
  (`state.sqlite-wal` or `-shm`) is missing its partner, so the database
  cannot be inspected without creating files. Start BiBCode once to recover
  it, or restore a backup." Startup's writable open rebuilds the WAL index
  from `-wal` and is unaffected.

How it reads without mutating:

| Option                                                                    | Trade-off                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Read-only WAL open even while a server runs                            | Live numbers. But a read-only WAL open can create `-shm`. It joins the live server's locking and contradicts the issue's "only when the offline guard can be taken".                                                                                                                                                                                                                                          |
| B. Take `OfflineRecoveryGuard` as is, then `immutable=1`                  | Simple, but `open_private_lock_file` creates `.bibcode-runtime.lock` in a root that never ran a server. That is a mutation the existing test would miss, because it lists only `state_dir`.                                                                                                                                                                                                                   |
| **C. Non-creating guard, then `immutable=1` only when no sidecar exists** | Opens the runtime lock **without create**. `NotFound` means no BiBCode process has ever owned the root, so there is no owner to wait for. `WouldBlock` gives `store-running`. Then it reads the four pragmas through the same `immutable=1` read-only URI that `validate_existing_bibcode_store_immutable` (`migrations.rs:94`) already uses. Immutable opens take no SQLite locks and never create sidecars. |

**Recommendation: C.** Add `OfflineRecoveryGuard::try_acquire_existing` to
`backup.rs`. It opens with `read + write`, without `create`. It holds the lock
only for the header read, which takes milliseconds. A server starting at that
moment already retries its shared lock for up to 30 s
(`StoreRuntimeGuard::acquire`), so it only waits briefly. Sidecars are checked
again after the guard is held; if any exists the result is
`"uncheckpointed-wal"` (or `"store-running"` when the guard was
`WouldBlock`). If the lock file is missing, a server could create it and
start during the read. The immutable read then returns slightly stale numbers
or fails, which gives `"unreadable"`.
Inspection is advisory, so this is acceptable. We document it rather than add a
lock file.

The desktop does not surface these fields (D10), and
`DesktopProjectDataEnvironmentStatus` is unchanged. The WSL path parses the
inspect document into a typed struct without `deny_unknown_fields`
(`data_safety.rs:230`), so the extra `database` key is ignored.

### D2. `auto_vacuum = INCREMENTAL` for new stores

`auto_vacuum` takes effect only on a database without tables, or through a full
`VACUUM`. Where to set it:

| Option                                                                                                 | Trade-off                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every `open_connection`                                                                                | Silently ignored on existing stores. But it sets the connection's next-`VACUUM` mode, so any future `VACUUM` would switch the mode without saying so. Hidden policy.                                   |
| In `migrate`, before the first migration                                                               | Too late: `create_new` has already run `journal_mode = WAL` on the staged file, and SQLite's guidance (and T3's `Sqlite.ts:25`) is to set it before WAL is enabled.                                    |
| **The staging open in `Database::create_new_inner`, as the first pragma, before `journal_mode = WAL`** | The only zero-page connection. One flag, one call site. Restore and start-empty are covered without extra code: start-empty's next startup is a first run, and restore installs the backup's own mode. |

**Recommendation:** add a create flag to `open_connection`, used only by the
staging open. With it set, `open_connection` runs
`pragma_update(None, "auto_vacuum", "INCREMENTAL")` right after `busy_timeout`
and before `journal_mode`. Existing stores keep `NONE` until compacted. Online
backups copy pages, so backups keep the source's mode. In-memory databases are
unaffected. The first-run test is the proof that the ordering works; if it
fails, the pragma moves earlier, not later.

**Does `incremental_vacuum` run?** No, not in this change. `INCREMENTAL` only
records the mode and maintains pointer-map pages, which cost about one page per
(usable page size ÷ 5) pages, roughly 0.1 % at 4 KiB. Free pages still
accumulate exactly as under `NONE` until `PRAGMA incremental_vacuum(N)` runs.
That is the issue's optional follow-up. The value now is that a future
background reclaim can return pages cheaply without a full `VACUUM`. `FULL`
mode was rejected: it truncates on every commit, which adds write
amplification and fragmentation on the hot write path (Core Priority 1).

### D3. `compact` flow

New module `apps/server/src/persistence/compaction.rs`, exported from
`persistence/mod.rs` as `compact_store(root, CompactOptions) ->
Result<CompactReport, RecoveryError>`. `CompactOptions` carries `dry_run` and
the caller's `CancellationToken` (the CLI cancels it on Ctrl-C). Steps for the
real run (the dry run is D8):

1. **Resolve and re-check the root**, as `restore_backup_inner` does
   (`RootChanged`).
2. **Ownership.** `OfflineRecoveryGuard::acquire` (the creating variant is fine
   here, because compaction is a write path). `WouldBlock` gives `StoreRunning`.
   Then `StoreOperationGuard::acquire(&base_dir, cancellation,
   RECOVERY_TIMEOUT)`. Both are held to the end.
3. **File-level classification, no SQLite.** The part of `inspect_store` that
   looks only at files (recovery journal or staging entry, marker, database
   presence) moves into a shared helper, `classify_store_files(&paths)`, used by
   both. Only "database present, marker valid" proceeds. A missing marker is
   refused because backups are keyed by storage ID: "Start BiBCode once so it
   can adopt this store, then retry". Every other state is refused with the
   inspection `issue` text. The SQLite classifier is **not** called: its 5 s
   busy-retry and in-memory copy would wait on a locked database and time out
   on a large one (review finding 1).
4. **Sidecars.** If `state.sqlite-wal` or `-shm` exists, refuse at once with
   `RecoveryError::DatabaseSidecarsPresent`: "The database has open SQLite
   files (`state.sqlite-wal` or `-shm`). Another program may have it open, or
   BiBCode did not shut down cleanly. Close any program that uses it; if none
   does, start BiBCode once and quit it normally, then retry." With the
   runtime lock held, sidecars mean another SQLite program has the file open
   (every WAL reader has a `-wal`) or a crash. Refusing here, rather than
   letting step 5 run WAL recovery, keeps the real run and the dry run (D8)
   symmetric, and means the backup starts from the state the user inspected.
   In practice this is how a database held by another program is refused.
5. **Open the maintenance connection.** A new `Database::open_for_maintenance`
   uses `open_connection` with `busy_timeout = 0`, then
   `locking_mode = EXCLUSIVE` *before first access*, so no `-shm` is created
   (SQLite keeps the WAL index in heap memory). It keeps the normal
   `foreign_keys`, `synchronous = FULL`, WAL and journal-limit pragmas, then
   runs `BEGIN EXCLUSIVE; COMMIT`. `SQLITE_BUSY` or `SQLITE_LOCKED` at any point
   gives `RecoveryError::DatabaseLocked` ("Another program has the database
   open. Close it, then retry.") at once, with no retry. This catches a
   program that opened the file after step 4. From here, every step uses this one
   connection, so the exclusive lock that keeps out other programs does not
   block our own backup.
6. **Schema check on that connection.** The ledger-prefix and core-table checks
   that both validators already run move into
   `validate_bibcode_schema(&Connection, …)` in `migrations.rs`, called by the
   immutable validator, the coherent validator and compaction. They read a few
   rows, so they do not grow with database size. A mismatch is
   `NotCompactable` with the validator's detail. Integrity is checked once, by
   the backup's `quick_check` in step 9, not here.
7. **Measure** `page_size`, `page_count`, `freelist_count` and `auto_vacuum`.
8. **Disk-space precheck** (D7). Refuse with the numbers.
9. **Verified pre-compact backup** with `BackupTrigger::PreCompact`, through the
   unchanged `create_verified_backup` and its 30 s budget (D5). Its built-in
   `quick_check` of the page-identical copy doubles as the pre-`VACUUM`
   integrity check, so the live store is not scanned twice. A
   `BackupError::QuickCheck` publishes nothing and refuses with "the store
   failed its integrity check; run `bibcode storage inspect`". A
   `DeadlineElapsed` refuses with the scope-down message (D5).
10. **`VACUUM` in the SQLite worker.** One `Database::call` closure, so the
    checks and the statement run on the same thread with nothing queued
    between them:
    - return `Cancelled` if the token is already cancelled. This closes the
      gap between the backup and `VACUUM`: `sqlite3_interrupt` called while
      no statement runs is a no-op and does not affect a later statement
      ([sqlite3_interrupt](https://www.sqlite.org/c3ref/interrupt.html)), so
      an interrupt-only design would lose a Ctrl-C pressed in that gap
      (review finding 6);
    - install `progress_handler(1_000, || token.is_cancelled())`, the pattern
      the validators and `quick_check_database` already use. VACUUM copies
      rows with ordinary statements on this connection, so the handler fires
      throughout that copy, and a non-zero return interrupts it
      ([progress handler](https://www.sqlite.org/c3ref/progress_handler.html)).
      The final page copy back into the main file runs outside the VM and is
      not interruptible; it is bounded by the compacted size;
    - `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;`, then remove the handler.
    No interrupt handle is needed.
11. **`PRAGMA wal_checkpoint(TRUNCATE)`.** With the exclusive lock it cannot
    be busy; if it is, report the step and keep going, because the data is
    committed and the close checkpoints it.
12. **`PRAGMA quick_check`**, then measure again. The `after` stats must show
    `freelistCount == 0` and `autoVacuum == "incremental"`; anything else is a
    `CompactFailed { phase: "verify" }` that carries the backup ID.
13. **Close** the connection, which deletes the WAL, and release the guards.

The token is also checked between steps. Steps 11 to 13 are not cancellable:
the compaction is committed, and they only finish it.

A recovery journal is not needed. There is no file move or rename. `VACUUM` is
a single SQLite transaction, and backup publication is already atomic. The
exclusive runtime lock prevents any startup from running during the operation.

### D4. Running server or background service: refuse, do not stop it

| Option                                        | Trade-off                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop and restart the service like `t3 doctor` | Convenient. But `bibcode service` has only `install` / `uninstall` / `status` (`config.rs:834`), so we would add per-OS stop/start (systemd, launchd, Windows) to a data-safety command. It also cannot stop the desktop app or WSL backends, and a restart failure would leave the user without a server they did not ask to stop. |
| **Refuse with an actionable message**         | No new process control. Matches `restore` and `start-empty`.                                                                                                                                                                                                                                                                        |

**Recommendation: refuse.** The CLI maps `StoreRunning` for every storage
command to: "BiBCode is using this data root. Quit the BiBCode app, stop
`bibcode serve` and any WSL backend, and stop the background service (`bibcode
service status` shows it), then retry." The persistence error and the desktop's
messages stay as they are. If a supervised service restarts while the
exclusive lock is held, its `StoreRuntimeGuard::acquire` times out after 30 s.
Data cannot be harmed by that. A `service stop/start` subcommand is a separate
follow-up.

### D5. The pre-compact backup

| Option                                                                            | Trade-off                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No backup (T3)                                                                    | Least disk use. The issue rejects it.                                                                                                                                                                            |
| `VACUUM INTO` the staging file                                                    | The backup is small. But it is itself a vacuumed artifact (rowids may be renumbered, pages rewritten), so a `VACUUM`-induced problem would be in the backup too. That defeats the point of a pre-compact backup. |
| VACUUM INTO, verify, then swap it in with the restore machinery                   | One rewrite instead of two. But restore preserves the live file forever, so disk use rises, and getting the space back would need a new code path that deletes user data.                                        |
| **Existing `create_verified_backup` (page copy) with a new `PreCompact` trigger** | A byte-faithful image of the pre-compact store, through code that is already verified and tested. Cost: the backup is as large as the uncompacted file, free pages included.                                     |

**Recommendation: the page copy.** Add `PreCompact` to `BackupTrigger`; it
serializes as `"pre-compact"`.

**Deadline: keep the existing 30 s budgets.** Revision 1 extended backup
creation to one hour. Review showed that this is not one change but four,
because every path that touches a backup of that size has its own 30 s
budget:

| Path                                  | What a 1 h creation budget would also need                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest verification                 | `created_at` is taken before the copy and must be within 60 s of the generation's mtime. A copy over a minute publishes a generation that fails its own reload verification (review finding 4). |
| Restore (`RECOVERY_TIMEOUT`)          | A backup that took minutes to create cannot be restored in 30 s (review finding 5).                                                                                                             |
| Inventory (`inspect`, desktop dialog) | Hashes and `quick_check`s every generation in 30 s. Large generations become "deadline elapsed" issues, which reads as a broken backup.                                                         |
| Inspection classifier                 | `quick_check` in 5 s. A large healthy store is classified unsafe.                                                                                                                               |

Keeping 30 s resolves findings 4 and 5 without code:

- the 60 s skew check cannot trip, because `created_at` is taken inside a 30 s
  budget. The implementation adds
  `const _: () = assert!(BACKUP_TIMEOUT.as_secs() < MAX_PUBLICATION_TIME_SKEW.as_secs());`
  next to the constants, so a future extension fails to compile until
  `created_at` moves to publication time;
- any pre-compact backup can be restored within restore's 30 s. Creation does
  strictly more work on the same bytes than restore does: the page copy,
  `quick_check`, hash, reload verification (hash and `quick_check`) and the
  retention inventory, which verifies that generation again with the others.
  Restore verifies the one generation, copies it, verifies the copy, and moves
  the live files aside by rename (`restore_backup_blocking`). This is the
  same guarantee pre-update backups already have.

The cost: a store whose backup takes more than 30 s cannot be compacted yet.
Such a store already cannot take a pre-update or pre-migration backup today,
so no user is worse off. `compact` refuses before `VACUUM` with
`CompactFailed { phase: "backup" }`: "The pre-compact backup did not finish
within 30 seconds, so the database was not changed. Compacting stores this
large is not supported yet." The dry run cannot predict this (throughput is
unknown) and says so in its plan (`"backupBudgetSeconds": 30`).

**Follow-up (large stores).** One change, once #225 measures real stores: a
size-scaled budget (for example 30 s plus bytes at a measured floor
throughput) applied together to creation, restore, inventory and the
classifier, with `created_at` taken immediately before the manifest write,
Ctrl-C on `restore`, and a slow-backup test. It is listed in Risks.

`VACUUM` itself has no deadline. Ctrl-C cancels it (D3 step 10). A store whose
backup fits in 30 s compacts in a comparable time.

The disk cost must be stated honestly. Right after a compaction, the store uses
`compacted + backup(≈ old fileBytes)` plus older backups, until retention ages
the pre-compact backup out. Older pre-update backups are also bloated copies
and shrink only as they are replaced. The dry run and the guide say this
plainly (D8, docs).

### D6. Retention

| Option                                                   | Trade-off                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared pool of 3, unchanged                              | No code. But two compactions in a row push out two older backups, possibly the last pre-update backup, which is the only path back across a version's migration.                             |
| A separate pool for pre-compact                          | Pre-update backups are never displaced. But this keeps 4 or more full copies, which is the wrong direction for a space command.                                                              |
| **Shared pool of 3, at most one pre-compact generation** | Publishing a pre-compact backup first expires older pre-compact generations, then applies newest-3. Repeated compaction displaces at most one other generation, and footprint stays bounded. |

**Recommendation: the last option.** In `apply_retention`, when the generation
just published is `PreCompact`, add the other verified `PreCompact` generations
to the removal set, then apply the existing newest-3 rule. Everything else
stays as it is: deleting only verified generations, revalidating, and ignoring
issues. Stores without pre-compact backups behave exactly as today.

### D7. Disk-space precheck

`VACUUM` builds the new database in a SQLite temp file. It then writes it back
through the WAL, and the checkpoint copies it into the main file, which never
grows. So peak extra space is:

- store volume: `backupBytes (= pageCount × pageSize)` +
  `compactedBytes` (WAL) + 64 MiB headroom;
- SQLite temp volume: `compactedBytes` + 64 MiB headroom;
- when both are one volume, the sum.

`compactedBytes = (pageCount − freelistCount) × pageSize × 1.01`. The 1 % covers
pointer-map pages and is an estimate. The temp directory follows SQLite's own
order: Windows `GetTempPathW` (equals `std::env::temp_dir()`); Unix
`SQLITE_TMPDIR`, `TMPDIR`, `/var/tmp`, `/usr/tmp`, `/tmp`. The same volume is
detected by the existing `FileIdentity.volume` helpers in `backup.rs`. Free
space comes from `GetDiskFreeSpaceExW` (caller-available bytes; already covered
by the server's `Win32_Storage_FileSystem` feature) and `statvfs`
(`f_bavail × f_frsize`, `libc` is already a Unix dependency). No new crate.

A failure gives `RecoveryError::InsufficientSpace { volume: "store" | "temp",
required, available }`, which reads: "Compaction needs 11.2 GB free on the
data-root volume and 3.8 GB on the temporary-files volume; 6.0 GB is free on
the data-root volume. Free up space or set `SQLITE_TMPDIR`/`TMPDIR` to a larger
volume, then retry." (The `TMPDIR` hint is Unix only.) The check runs before
the backup, so a refusal writes nothing. The test hook is
`compact_store_with_free_space_for_integration_test(root, options, probe:
impl Fn(&Path) -> u64)`, following the crate's `_for_integration_test`
convention.

### D8. `--dry-run`

Revision 1 opened the writable maintenance connection in the dry run. That is
not non-mutating: if a crash left committed frames in `-wal`, the open runs
WAL recovery, and the close of the last connection checkpoints into
`state.sqlite` and deletes the sidecars
([SQLite WAL](https://www.sqlite.org/wal.html)). The creating guards would also
leave `.bibcode-runtime.lock` and `.bibcode-storage.lock` behind (review
finding 3).

The dry run therefore uses the same non-mutating read as `inspect` (D1) and
never opens a writable connection:

1. resolve and re-check the root;
2. `OfflineRecoveryGuard::try_acquire_existing` (non-creating). `WouldBlock`
   gives `StoreRunning`; `NotFound` means no owner. `StoreOperationGuard` is
   not taken: it creates its lock file, and the dry run writes nothing that
   needs serializing. A concurrent `restore` or `compact` holds the runtime
   lock exclusively, so the dry run sees `StoreRunning`;
3. `classify_store_files` and the sidecar check, with the same refusals as the
   real run (D3 steps 3 and 4);
4. open `immutable=1`, run `validate_bibcode_schema` and read the four
   pragmas. No `quick_check`: the dry run makes no integrity claim, and the
   real run's backup checks integrity;
5. the disk-space precheck (D7), then return the plan.

What the dry run cannot prove is the SQLite lock held by another program. It
infers it: in WAL mode every connection that has read the database has a
`-wal` file, so "no sidecars" means no other connection is reading. A program
that opened the file but has not read it yet is caught only by the real run's
`busy_timeout = 0` probe, which refuses before the backup. The plan reports
this as `"sqliteLock": "inferred-from-sidecars"`.

A refusal (running, sidecars present, space) is the same error, with the same non-zero
exit, as the real command. That makes `--dry-run` a reliable preflight for
scripts, except for the two limits above (an opener racing the run, and the
30 s backup budget). The issue's "dry run wins" behavior falls out of this:
there is no `--fix` flag; the command compacts unless `--dry-run` is given.

### D9. Failure, cancellation and rollback

| Where                                    | State left                                                                                                                                                                                     | Reported                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steps 1–8 (refusal, cancel)              | Nothing written to the store. A real run may leave the two lock files (as `restore` does). A dry run leaves nothing (D8).                                                                      | The specific error. No backup ID.                                                                                                                   |
| Step 9 backup fails, times out or Ctrl-C | Live store untouched. Ctrl-C during the backup is honored when it returns (it is bounded by 30 s); the backup, if published, is kept. An unpublished `.staging` entry is ignored by inventory. | "Could not take the pre-compact backup: …; the database was not changed." Cancelled after publication: `Cancelled` with the backup ID.              |
| Step 10 cancelled before `VACUUM` starts | The worker returns before running the statement. The database is the pre-compact store.                                                                                                        | `Cancelled { backupId }`: "Compaction was cancelled. The database was not changed. The pre-compact backup `<id>` is kept."                          |
| Step 10 `VACUUM` fails, Ctrl-C, crash    | SQLite rolls back, or WAL recovery does on the next open. The database is the pre-compact store. Setting `auto_vacuum` alone persists nothing.                                                 | `CompactFailed { phase: "vacuum", backupId }` (or `Cancelled { backupId }`): "The database was not changed. The pre-compact backup `<id>` is kept." |
| Step 11 checkpoint busy                  | Compacted and committed in the WAL. The close checkpoints it.                                                                                                                                  | A warning in the report (`checkpoint: "deferred"`). Success.                                                                                        |
| Step 12 `quick_check` or stat mismatch   | The database as SQLite left it.                                                                                                                                                                | `CompactFailed { phase: "verify", backupId }`: "…restore it with `bibcode storage restore --backup-id <id>`." Exit non-zero.                        |

There is no automatic restore. Restore is the explicit, journaled offline path,
and putting a second mutating step inside a failure path would add risk
without adding safety. Because the backup ID is part of the error's `Display`,
it also reaches `--json` callers through stderr.

### D10. Older apps, the desktop and contracts

- **Older BiBCode with a `pre-compact` manifest.** It fails to decode the
  manifest, reports one inventory issue and keeps listing its other verified
  backups. Its retention never deletes the generation, because issues are never
  deleted. The cost is one extra copy until a current build expires it. This is
  accepted and documented. A test pins the behavior with a manifest whose
  `trigger` is unknown to the running build (Tests, item 9).
- **The desktop recovery dialog** receives `trigger: "pre-compact"`. Add it to
  `DesktopProjectDataBackup.trigger` and `DesktopProjectDataBackupSchema` in
  `packages/contracts/src/ipc.ts`, with an `ipc.test.ts` decode case, and run
  `vp run check:contracts`. The dialog already prints the raw trigger, so no
  web code changes. No space fields and no compact action are added to the
  desktop.
- **Version skew:** an older desktop driving a newer WSL `bibcode storage
  inspect` that lists a `pre-compact` backup. The older desktop's typed
  `WslBackupDocument` fails to decode, and it reports "WSL inspection output was
  invalid". That failure is closed and safe, and goes away when the desktop
  updates. It is recorded as residual risk rather than fixed with a lenient
  decoder.

### D11. CLI shape and messages

```
bibcode storage compact [--dry-run] [--json]
  about: "Back up, then compact an offline project-data store to reclaim free space."
  --dry-run  "Report what compaction would reclaim and need, without changing anything."
```

Stdout carries one JSON document: pretty by default, compact with `--json`, as
the sibling commands do.

```json
{
  "dryRun": false,
  "before": { "fileBytes": 0, "walBytes": 0, "pageSize": 0, "pageCount": 0, "freelistCount": 0, "autoVacuum": "none" },
  "plan": { "backupBytes": 0, "estimatedCompactedBytes": 0, "estimatedReclaimBytes": 0, "autoVacuumAfter": "incremental",
            "requiredFreeBytes": { "store": 0, "temp": 0, "sameVolume": true }, "availableFreeBytes": { "store": 0, "temp": 0 },
            "backupBudgetSeconds": 30, "sqliteLock": "probed | inferred-from-sidecars (dry run)" },
  "backupId": "uuid | null (dry run)",
  "after": { "...": "same shape as before; null for a dry run" },
  "reclaimedBytes": 0,
  "checkpoint": "complete | deferred"
}
```

Phase lines go to stderr, in both modes, because the operation can take
minutes (UI.md, Progress and Feedback). For example: "Backing up 7.0 GB to
backups/…", "Compacting…", "Checking integrity…", "Done: 7.0 GB → 3.8 GB.
The pre-compact backup (7.0 GB) is kept until newer backups replace it." Ctrl-C
is caught through the existing `termination_signal()` and cancels the token.

The UI.md review of copy happens in the implementation PR. Every refusal names
the cause, the numbers and the next action. The default writes nothing without
a verified backup, and errors after the backup always carry its ID.

### D12. Profiler, crash and trace coverage

- **Events.** The profiler runs only inside the server, and an offline store
  has no server. So the CLI cannot `profiler::emit`. Add
  `diagnostics::profiler::offline_writer(state_dir) -> Option<OfflineWriter>`.
  When the persisted `enableProfiler` setting is on (`persisted_enabled`), it
  starts a `ProfilerStore` with a fresh `sid` and source `"cli"` for the
  command's lifetime, and flushes within 2 s on drop. It writes no
  `session.json`, so crash and clean-shutdown detection are untouched. It is
  started only *after* the exclusive runtime lock is held, so it is never a
  second writer beside a live server. The dry run starts no writer, because
  it must leave the root unchanged (D8). One kind, `storage.compact`, has
  `phase: "start" | "end"`. The end event carries `outcome` (`compacted`,
  `refused`, `failed` or `cancelled`), `failedStep` (a closed enum),
  `stateKind`, `pageSize`, before and after `fileBytes`,
  `freelistCount` and `autoVacuum`, and `backupMs`, `vacuumMs` and
  `durationMs`. It has no paths, IDs, error strings or user data. `StoreRunning`
  refusals are not recorded, by construction. No findings. The event is
  documented in `docs/skills/bibcode-profiler/references/events.md` and the
  overview's Profiler section.
- **Tracing.** `tracing::info!`/`warn!` at the same boundaries. They are inert
  in the CLI today, which has no subscriber, and active if the code is ever
  called in-process.
- **Not applicable:** child processes, RPC methods and `is_long_running`
  (there is no RPC), worktree removal, and shutdown ordering. The crash hook is
  already attached first in `main` for every subcommand.

### D13. Recommend-to-compact threshold

None in this change. The dry run's numbers answer the question, and a UI
notice is out of scope. If a notice is added later, T3's 1 GiB is a starting
point, to be checked against #225's measurements.

### D14. Event-history pruning

Out of scope. When pruning lands it can run before step 8 under the same locks,
which is the order T3's doctor uses. That is its own design.

## Code changes (for the implementation PR)

- `persistence/database.rs`: a create flag on the staging open that sets
  `auto_vacuum`; `open_for_maintenance` (`busy_timeout = 0`,
  `locking_mode = EXCLUSIVE`, `BEGIN EXCLUSIVE` probe); a space-stats query;
  a cancellable `VACUUM` closure (pre-check plus progress handler).
- `persistence/migrations.rs`: `validate_bibcode_schema(&Connection, …)`
  extracted from the two validators, which now call it.
- `persistence/store.rs`: the exactly-one-sidecar rule in
  `validate_existing_store_for_inspection`.
- `persistence/backup.rs`: `BackupTrigger::PreCompact`; the pre-compact
  retention rule; `OfflineRecoveryGuard::try_acquire_existing`;
  `classify_store_files` extracted from `inspect_store`;
  `StoreInspection.database`; the `BACKUP_TIMEOUT < MAX_PUBLICATION_TIME_SKEW`
  compile-time assertion; new `RecoveryError` variants `DatabaseLocked`,
  `DatabaseSidecarsPresent`, `InsufficientSpace`, `NotCompactable`,
  `Cancelled` and `CompactFailed`. No backup or restore deadline changes.
- `persistence/compaction.rs` (new): the flow, the free-space probe and the
  test entry point `compact_store_for_integration_test(root, options,
  CompactTestHook)`, following the crate's `_for_integration_test` and fault
  enum conventions (`BackupFault`, `RecoveryFault`). `CompactTestHook` is
  `None`, `FreeSpace(u64)`, `CancelAfterBackup` (cancels the token when the
  backup returns) or `CancelDuringVacuum` (the progress handler cancels the
  token on its first call). `persistence/mod.rs`: exports.
- `config.rs`: `StorageSubcommand::Compact { dry_run, json }` and
  `StorageCommand::Compact`. `lib.rs`: output, stderr phases, Ctrl-C, the
  `StoreRunning` hint, and the inspect `database` field.
- `diagnostics/profiler`: `offline_writer`.
- `packages/contracts/src/ipc.ts` and `ipc.test.ts`: the `"pre-compact"`
  literal.

## Tests

Hermetic, in `apps/server/tests/project_data_safety.rs` (`TestSandbox`/temp
roots), unless noted. "Listings" means the recursive `base_dir` listing, which
covers `state_dir`, `backups/` and both lock files.

1. Extend `recovery_inspection_reports_verified_store_state_without_mutating_it`.
   The fixture inserts and then deletes rows. Check `database.fileBytes` equals
   the file length; `pageCount`, `freelistCount > 0` and `autoVacuum: "none"`
   match a direct `immutable=1` read; and the listings are unchanged (no
   `-wal`, `-shm` or `.bibcode-runtime.lock`).
2. `inspection_while_a_server_owns_the_store_reports_sizes_and_store_running`:
   `ServerRuntime::start`, then `fileBytes > 0`, stats `null`,
   `databaseStatsUnavailable: "store-running"`, and database, marker and
   listings unchanged.
3. `inspection_with_a_wal_but_no_shm_creates_nothing`: an offline fixture with
   a crash-left `-wal` holding committed frames and no `-shm` (made by
   copying `state.sqlite` and `-wal`, not `-shm`, from a store whose writer is
   still open with `wal_autocheckpoint = 0`, into the test root). Classification `unsafe-database-state` with the
   sidecar issue, `databaseStatsUnavailable: "uncheckpointed-wal"`, and the
   listings and database and `-wal` bytes unchanged. A unit test in
   `store.rs` covers the `-shm`-only case.
4. `first_run_store_reports_incremental_auto_vacuum_and_a_fixture_keeps_none`.
5. `compact_dry_run_reports_reclaim_and_changes_nothing`: the estimate is
   within 1 % of `freelistCount × pageSize`; database bytes, marker and
   listings are unchanged, including in a root that has never had a lock file.
6. `compact_dry_run_and_compact_refuse_a_crash_left_wal_without_touching_it`:
   the fixture of test 3, plus one with both sidecars. Both modes return
   `DatabaseSidecarsPresent`; database, `-wal` bytes and listings are unchanged; no
   backup is taken.
7. `compact_reclaims_space_behind_exactly_one_verified_pre_compact_backup`:
   one new generation with trigger `pre-compact` that inventories as verified;
   `fileBytes` shrinks; `freelistCount == 0`; `autoVacuum: "incremental"`;
   every project, thread and message reads back equal to before (snapshot of
   the projection tables); no sidecar remains.
8. `compact_refuses_while_a_server_owns_the_store`, modeled on `:1294`:
   `StoreRunning`, no backup directory entry, and the database and marker are
   unchanged.
9. `compact_refuses_a_database_another_connection_holds_without_waiting`:
   another connection opens `state.sqlite` and holds `BEGIN EXCLUSIVE` with a
   pending write. Both `compact` and `compact --dry-run` fail in under 1 s
   (less than the classifier's 5 s and `BUSY_TIMEOUT`) with
   `DatabaseSidecarsPresent`; no backup is taken; after the other connection
   rolls back and closes, the database bytes equal the original. Plus a unit
   test in `database.rs`,
   `open_for_maintenance_fails_at_once_on_a_locked_database`: the same held
   lock, `open_for_maintenance` called directly, `DatabaseLocked` in under
   1 s. Together they pin finding 1: nothing waits before the refusal.
10. `compact_refuses_insufficient_disk_space_before_the_backup`: through
    `CompactTestHook::FreeSpace`, `InsufficientSpace` with both numbers, no
    backup, and the database unchanged.
11. `compact_cancelled_after_the_backup_leaves_the_store_unchanged`:
    `CompactTestHook::CancelAfterBackup`. `Cancelled` with the backup ID; the
    database bytes equal the original; the backup inventories as verified.
    This pins finding 6 (cancel before `VACUUM` starts).
12. `compact_cancelled_during_vacuum_rolls_back_and_restarts_cleanly`:
    `CompactTestHook::CancelDuringVacuum`. `Cancelled` with the backup ID;
    then `prepare_store` on the root (a normal restart) succeeds, every
    projection row reads back equal, `freelistCount` and `autoVacuum: "none"`
    are as before, and the pre-compact backup is still verified.
13. `inventory_keeps_other_backups_beside_a_manifest_with_an_unknown_trigger`.
    This is the older-app model. Retention leaves the unknown generation in
    place.
14. `pre_compact_backup_restores_with_restore_backup_id`.
15. Unit (`backup.rs`): `pre_compact_retention_keeps_one_pre_compact_and_two_older_generations`.
16. Unit (`config.rs`): `storage compact`, `storage compact --dry-run --json`,
    and a rejected unknown flag.
17. Unit (`compaction.rs`): the required-space arithmetic for same-volume and
    split-volume cases.
18. Contracts: an `ipc.test.ts` case that decodes a `"pre-compact"` backup.
    `vp run check:contracts`.
19. Unchanged and must pass: all restore, start-empty, startup, migration,
    pre-update, retention and validator tests (the schema-check extraction
    touches both validators); `projectDataSafety.test.ts`;
    `ProjectDataRecoveryDialog.test.tsx`; `vp run test:ui:desktop`
    (`main-window.e2e.ts`, `platform-capabilities.e2e.ts`).

No slow-backup or large-restore test: the budgets do not change (D5). The
compile-time assertion replaces a timing test for finding 4.

Gates: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D
warnings`, `cargo test --workspace`, `vp check`, `vp run typecheck`,
`vp run check:contracts`, Release Smoke.

## Documentation

- `docs/guides/project-data-recovery.md`: a new "Reclaim database space"
  section. It covers the inspect `database` fields and what `store-running`
  means; `storage compact` and `--dry-run`; the precondition that every
  process be stopped; the pre-compact backup and its disk cost; how to restore
  it; and that existing stores stay `none` until compacted. Add
  `pre-compact` to the backup list ("created before a migration, a coordinated
  in-app update, or a compaction") and the one-pre-compact retention rule.
- `docs/architecture/overview.md`: new stores' `auto_vacuum = INCREMENTAL` in
  the first-run paragraph; `compact` in the offline-recovery paragraph (locks,
  no journal and why); the retention rule; and `storage.compact` in the
  Profiler section.
- `docs/skills/bibcode-profiler/references/events.md`: `storage.compact`, and
  `"cli"` as an event `source`.
- `docs/testing/`: no runbook covers storage CLI commands or a packaged flow
  this changes. The implementation PR reviews them and reports "reviewed and
  remain accurate" unless the implementation adds a native validation step.

## Risks and unmeasured

- `VACUUM` duration and real free-page ratios are unmeasured (the issue's "Not
  measured"; #225). The 1 % estimate is a placeholder.
- Stores whose verified backup takes more than 30 s cannot be compacted (D5).
  They already cannot take pre-update or pre-migration backups. The follow-up
  is one size-scaled budget across creation, restore, inventory and the
  classifier, `created_at` at publication time, Ctrl-C on `restore`, and a
  slow-backup test. The compile-time assertion stops a partial extension.
- That `auto_vacuum` before `journal_mode = WAL` takes effect on the staged
  file, that `VACUUM` switches modes in WAL mode, and that the progress handler
  interrupts `VACUUM` are SQLite behaviors (and T3's report), not yet observed
  here. Tests 4, 7 and 12 respectively are the proof. The first has a stated
  fallback; if the third fails, the closure also calls the connection's
  interrupt handle from the cancellation path, keeping the pre-check.
- The final page copy inside `VACUUM` is not interruptible, so Ctrl-C can take
  as long as writing the compacted size.
- The dry run infers the SQLite lock from sidecars (D8); the real run's probe
  covers the race.
- The pre-compact backup temporarily *raises* total disk use. The dry run and
  the guide say so.
- Older-desktop and newer-WSL skew fails closed (D10).

## Answers to the issue's open questions

| Question                                 | Answer                                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Stop and restart the background service? | No. Refuse with an actionable message (D4).                      |
| Does pre-compact count toward 3?         | Yes, and at most one pre-compact generation is kept (D6).        |
| Page stats while the server runs?        | No. Sizes always; stats only offline, else `store-running` (D1). |
| Recommend-to-compact threshold?          | None now (D13).                                                  |
| Run event pruning first, when it lands?  | Yes, as a step before the backup, under its own design (D14).    |

## Review findings and resolutions (revision 2)

| #   | Finding (verified against source and SQLite docs)                                                                                                      | Resolution                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reusing the inspection classifier before the lock probe waits up to 5 s on a locked store (`migrations.rs:384`) and times out on a large healthy one.  | Compaction no longer calls the SQLite classifier. File-level checks are shared (`classify_store_files`); sidecars refuse at once; the schema check runs on the maintenance connection after its lock (D3 3–6). Test 9.     |
| 2   | With either sidecar present the classifier opens plain read-only SQLite (`store.rs:339`), which creates a missing `-shm`.                              | Exactly one sidecar: inspection does not open SQLite and reports `unsafe-database-state` (D1). Both or none: unchanged, nothing is created. Test 3 and a `store.rs` unit test.                                             |
| 3   | The dry run's writable open can checkpoint crash-left WAL frames into `state.sqlite` and delete sidecars; the creating guards leave lock files.        | The dry run takes only the non-creating runtime guard, refuses sidecars, and reads through `immutable=1` (D8). Tests 5 and 6 (crash-left WAL, recursive listings).                                                         |
| 4   | `created_at` precedes the copy (`backup.rs:533`) but must be within 60 s of publication (`backup.rs:2024`), so a 1 h backup budget fails verification. | The budget is not extended (D5); 30 s cannot exceed the 60 s skew. A compile-time assertion pins `BACKUP_TIMEOUT < MAX_PUBLICATION_TIME_SKEW` for the large-store follow-up.                                               |
| 5   | Restore keeps `RECOVERY_TIMEOUT = 30 s` (`backup.rs:846`), so a backup created under 1 h may be unrestorable.                                          | The budget is not extended (D5). Creation does strictly more work on the same bytes than restore (it verifies the new generation twice plus the retention inventory), so any pre-compact backup restores in 30 s. Test 14. |
| 6   | `sqlite3_interrupt` with no running statement is a no-op, so Ctrl-C between the backup and `VACUUM` is lost.                                           | One worker closure checks the token, then runs `VACUUM` under a progress handler that returns the token state (D3 step 10). Tests 11, 12 (before, during, restart).                                                        |

Scope-down: compaction of stores whose backup exceeds the existing 30 s budget
(D5, Risks). The issue's acceptance criteria use small hermetic fixtures and
are all met.
