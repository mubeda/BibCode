# Storage Compaction

Status: Approved 2026-11-01 (Codex review, 7 rounds). Design for issue 230,
verified against `9c8799b80` (v0.14.0), revision 7. It changes a persisted
shape (`auto_vacuum` on new stores, a new manifest trigger, a retention rule)
and adds a CLI write path.

Revision 3 replanned after two review rounds; revision 4 narrowed the
inspection lock scope and fixed the space check (round 3); revisions 5 to 7 keep
refusals free of writes and leave no stray sidecars (rounds 4 to 6) (see "Review findings and
resolutions" at the end). The rule: decide what to open from a lock held for
the whole operation, never from an earlier file check. Inspection holds the
non-creating runtime guard for classification and stats, releases it before
the backup inventory, and does not open SQLite while BiBCode owns the root. Compaction takes its locks, then one writable connection with
`busy_timeout = 0` and `BEGIN EXCLUSIVE`. That refuses a locked database at
once and replays a crash-left WAL legitimately. It checks the schema on that
connection and runs a cancellable `VACUUM`. The dry run never opens a writable
connection and states that it does not check SQLite locks. Restore verifies
only the selected generation. The existing 30 s backup and restore budgets are
kept, and large stores are a follow-up.

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
  (`backup.rs:846`). To find the selected generation,
  `find_verified_backup_for_recovery` (`backup.rs:1150`) runs the full
  `inventory_blocking` of every storage identity it visits until it finds
  it, so it hashes and `quick_check`s unrelated generations too. It then
  copies the selected one, re-verifies the copy and moves the live files
  aside by rename. The triggers are
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

How it reads without mutating:

| Option                                                                    | Trade-off                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Read-only WAL open even while a server runs                            | Live numbers. But a read-only WAL open can create `-shm`. It joins the live server's locking and contradicts the issue's "only when the offline guard can be taken".                                                                                                                                                                                                                                          |
| B. Take `OfflineRecoveryGuard` as is, then `immutable=1`                  | Simple, but `open_private_lock_file` creates `.bibcode-runtime.lock` in a root that never ran a server. That is a mutation the existing test would miss, because it lists only `state_dir`.                                                                                                                                                                                                                   |
| **C. Non-creating guard, then `immutable=1` only when no sidecar exists** | Opens the runtime lock **without create**. `NotFound` means no BiBCode process has ever owned the root, so there is no owner to wait for. `WouldBlock` gives `store-running`. Then it reads the four pragmas through the same `immutable=1` read-only URI that `validate_existing_bibcode_store_immutable` (`migrations.rs:94`) already uses. Immutable opens take no SQLite locks and never create sidecars. |

**Recommendation: C**, with the lock held for the classification and the
stats read, not only the stats read, and released before the backup
inventory. `try_acquire_existing` is added to `backup.rs`.

**One lock scope for the whole inspection (review findings 2 and r2-3).** A
sidecar check followed by a later SQLite open is a race: a server can close
its last connection and delete `-wal`/`-shm` between the two, and the plain
read-only open then recreates them
([SQLite WAL](https://www.sqlite.org/wal.html)). No file-existence check can
close that window, so `inspect_store` decides whether to open SQLite at all
from the runtime lock, and holds that lock for the classification and the
stats read. It drops the guard before `inventory_verified_backups` runs
(`backup.rs:686`). The inventory reads only `backups/`, never `state.sqlite`
or its sidecars, so it needs no ownership lock, and its own 30 s budget must
not stack on a starting server's 30 s lock retry (review finding r3-1). It calls `OfflineRecoveryGuard::try_acquire_existing`, which opens
`.bibcode-runtime.lock` with `read + write` and **without create**, and takes
an exclusive `try_lock`:

| Guard result                     | Who can touch the sidecars during inspection                          | Classification                                                                                                                                                                                                                                                                             | Stats                                                               |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `WouldBlock` (a BiBCode process) | The owner, at any moment                                              | **SQLite is not opened.** File-level classification only (`classify_store_files`, D3 step 3): database and valid marker give `existing` (unmarked gives `existing-unmarked`), with no issue. The owning server validated the store when it started; inspection does not join its live WAL. | `null`, `"store-running"`                                           |
| Acquired                         | No BiBCode process (a starting server waits on its 30 s shared retry) | No sidecar: `immutable=1`, as today. Both sidecars: the plain read-only path, as today; it creates nothing because both files exist and no BiBCode process can delete them while the lock is held. Exactly one: SQLite is not opened; `unsafe-database-state` with the issue below.        | Immutable read when no sidecar, else `null`, `"uncheckpointed-wal"` |
| `NotFound` (no lock file)        | No BiBCode process has ever owned this root                           | No sidecar: `immutable=1`. Any sidecar: SQLite is not opened; `unsafe-database-state` with the issue below. Without a lock file nothing excludes a server that starts now, so only the immutable open, which never creates files, is allowed.                                              | Immutable read when no sidecar, else `null`, `"uncheckpointed-wal"` |

The issue text for the unopened cases: "The database has SQLite sidecar files
(`state.sqlite-wal` or `-shm`) that cannot be inspected without creating
files. Start BiBCode once and quit it, or run `bibcode storage compact`,
which recovers them under its own lock."

What this changes for existing callers: the desktop's status list inspects the
native root while its own in-process server runs. It now gets `existing` from
files instead of a read-only open of the live database, so it no longer
touches the live WAL. Both map to `healthy` (`data_safety.rs:182`). A store
owned only by a `bibcode mcp` relay or the pairing CLI is also reported from
files; neither changes the database. Inspection holds the exclusive lock for at
most the classifier's 5 s deadline plus the millisecond header read, which a
starting server absorbs in its 30 s retry. The backup inventory runs after the
guard is dropped.

The remaining window is a third-party SQLite program that closes the database
between the check and the open while BiBCode is offline. The recovery guide
already forbids opening `state.sqlite` with other programs; this is documented
as residual risk.

The stats do not depend on the classification. A healthy store whose
`quick_check` exceeds the classifier's 5 s deadline still reports its sizes
and free pages, which is exactly the store a user wants to measure.

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
| In `migrate`, before the first migration                                                               | Too late: `create_new` has already run `journal_mode = WAL` on the staged file, and SQLite's guidance (and the reference implementation's `Sqlite.ts:25`) is to set it before WAL is enabled.          |
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
   inspection (D1), the dry run (D8) and compaction. Only "database present,
   marker valid" proceeds. A missing marker is refused because backups are
   keyed by storage ID: "Start BiBCode once so it can adopt this store, then
   retry". Every other state is refused with the inspection `issue` text. The
   SQLite classifier is **not** called: its 5 s busy-retry and in-memory copy
   would wait on a locked database and time out on a large one (review
   finding 1).

   Two more file checks run here, before any SQLite open (review finding
   r6-2). First, the database header is read with plain file I/O: the file
   must be at least 100 bytes, start with `SQLite format 3\0`, and have a
   valid page size and a length of at least one page. Otherwise it is
   refused with `NotCompactable` ("`state.sqlite` is empty or is not a SQLite
   database"). Without this check, step 4's `BEGIN EXCLUSIVE` on a
   zero-length file would initialize and commit page 1 before step 5 could
   reject the schema. Second, a `state.sqlite-journal` is refused the same
   way ("another program left an interrupted write"), because the first
   access would roll that hot journal back into the file. BiBCode itself
   never writes in rollback mode.

4. **Open one writable maintenance connection and lock it.** A new
   `Database::open_for_maintenance` opens `state.sqlite` and sets, in this
   order, before anything reads the database:
   `set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)`
   (rusqlite 0.40.2, `src/config.rs:28,125`) **when a `-wal` existed before
   the open**, so closing this connection never checkpoints a crash-left
   WAL into `state.sqlite` and never deletes it (review finding r4-1;
   exclusive locking does not stop the checkpoint on close). When no `-wal`
   existed, the flag is left off (review finding r5-1): the first access
   creates an empty `-wal` even in exclusive locking mode, and with the flag
   set the close would leave it behind without a `-shm`, which inspection
   then reports as `unsafe-database-state` for a healthy store. Without the
   flag that WAL can only hold this connection's frames, and before the
   backup it holds none that are committed, so SQLite's normal close
   checkpoints nothing and deletes the file itself. The sidecar presence is
   recorded under the runtime lock, which no BiBCode process can contend.
   The alternative, deleting a still-empty `-wal` ourselves after the close,
   adds a file deletion to BiBCode for the same result. Then
   `busy_timeout = 0`; `locking_mode = EXCLUSIVE`, so
   SQLite keeps the WAL index in heap memory and never uses `-shm`; then the
   normal `open_connection` pragmas **except `journal_mode = WAL`**
   (`foreign_keys`, `synchronous = FULL`, autocheckpoint and journal limit);
   then `BEGIN EXCLUSIVE; COMMIT`. In exclusive locking mode the lock
   is kept after the commit until the connection closes. `SQLITE_BUSY` or
   `SQLITE_LOCKED` at any point gives `RecoveryError::DatabaseLocked`
   ("Another program has the database open. Close it, then retry.") at once,
   with no retry and nothing written. This is a real lock check, not an
   inference: any connection in a transaction holds a database-file lock,
   and a WAL-mode connection keeps a shared lock for as long as it is open
   (that is how SQLite detects the last connection). An idle rollback-mode
   connection holds none; it is simply refused by our lock if it tries to
   read during compaction.
   - **Crash-left sidecars are recovered here, legitimately (review finding
     r2-2).** If a crash left committed frames in `-wal`, this first access
     replays them under our exclusive lock, exactly as a server start would,
     but without startup's 5 s whole-store validation, which a large healthy
     store may never pass. The user does not need a separate "start and
     quit" step. A crash-left `-shm` is not used and stays as it was;
     the next normal open reinitializes it.
   - **A restored store is in `journal_mode = DELETE`** (backups are switched
     to it, `database.rs:715`, and restore installs the file unchanged). Its
     conversion to WAL is a header write, so it is deferred to step 9, after
     the backup. The backup copies the store in whatever mode it is.
   - **Nothing is written before the backup.** WAL replay builds only the
     in-memory index, the empty `BEGIN EXCLUSIVE; COMMIT` writes no frames,
     a pre-existing WAL is not checkpointed on close, and a WAL created by
     this open is empty and removed by the close. So every refusal in steps
     4 to 8 leaves `state.sqlite`, `-wal` and `-shm` byte for byte as they
     were, and a sidecar that was absent stays absent.
     From here, every step uses this one connection, so the exclusive lock does
     not block our own backup.
5. **Schema check on that connection.** The ledger-prefix and core-table checks
   that both validators already run move into
   `validate_bibcode_schema(&Connection, …)` in `migrations.rs`, called by the
   immutable validator, the coherent validator and compaction. They read a few
   rows, so they do not grow with database size. A mismatch is
   `NotCompactable` with the validator's detail. Integrity is checked once, by
   the backup's `quick_check` in step 8, not here.
6. **Measure** `page_size`, `page_count`, `freelist_count` and `auto_vacuum`
   on the recovered connection. These are logical numbers: they include
   committed frames still in a crash-left `-wal`, which step 4 replayed into
   the WAL index but did not checkpoint. So `pageCount × pageSize` can exceed
   the physical `fileBytes`.
7. **Disk-space precheck** (D7). Refuse with the numbers.
8. **Verified pre-compact backup** with `BackupTrigger::PreCompact`, through the
   unchanged `create_verified_backup` and its 30 s budget (D5). Its
   online-backup copy runs on this connection's worker. Its built-in
   `quick_check` of the page-identical copy doubles as the pre-`VACUUM`
   integrity check, so the live store is not scanned twice. A
   `BackupError::QuickCheck` publishes nothing and refuses with "the store
   failed its integrity check; run `bibcode storage inspect`". A
   `DeadlineElapsed` refuses with the scope-down message (D5).
9. **`VACUUM` in the SQLite worker.** One `Database::call` closure, so the
   checks and the statement run on the same thread with nothing queued
   between them:
   - return `Cancelled` if the token is already cancelled. This closes the
     gap between the backup and `VACUUM`: `sqlite3_interrupt` called while
     no statement runs is a no-op and does not affect a later statement
     ([sqlite3_interrupt](https://www.sqlite.org/c3ref/interrupt.html)), so
     an interrupt-only design would lose a Ctrl-C pressed in that gap
     (review finding 6);
   - `PRAGMA journal_mode = WAL`, which converts a restored `DELETE`-mode
     store, as a server start would, and is a no-op otherwise;
   - install `progress_handler(1_000, || token.is_cancelled())`, the pattern
     the validators and `quick_check_database` already use. VACUUM copies
     rows with ordinary statements on this connection, so the handler fires
     throughout that copy, and a non-zero return interrupts it
     ([progress handler](https://www.sqlite.org/c3ref/progress_handler.html)).
     The final page copy back into the main file runs outside the VM and is
     not interruptible; it is bounded by the compacted size;
   - `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;`, then remove the handler.
     No interrupt handle is needed.
10. **`PRAGMA wal_checkpoint(TRUNCATE)`**, the explicit checkpoint. With the
    exclusive lock it cannot be busy; if it is, report the step and keep
    going, because the data is committed and step 12's close checkpoints it.
11. **`PRAGMA quick_check`**, then measure again. The `after` stats must show
    `freelistCount == 0` and `autoVacuum == "incremental"`; anything else is a
    `CompactFailed { phase: "verify" }` that carries the backup ID.
12. **Close.** Only when step 11 passed, call
    `set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, false)` (a
    no-op when it was never set) so the close checkpoints anything left and
    deletes the WAL, as a normal shutdown does. On a failure or cancellation
    with a pre-existing WAL the flag stays set, and the WAL is left for the
    next open to replay. Without one, the close drops this connection's
    uncommitted frames and deletes the WAL, as SQLite always does.

    After a verified compaction, one more cleanup runs under the runtime
    lock (review finding r6-1). In exclusive locking mode SQLite never opens
    `-shm`, so its close deletes the WAL but not a crash-left `-shm`. That
    leaves `-shm` without `-wal`, which inspection reports as
    `unsafe-database-state`, and the desktop shows as recovery required
    (`data_safety.rs:182-191`). So if `-wal` is absent and `-shm` exists,
    compaction removes that `-shm`. It is an orphaned index of a WAL that no
    longer exists, and no BiBCode process can have it open while the lock is
    held. The step runs only on success. On a failure the pre-existing
    sidecars stay as they were. Then release the guards.

The token is also checked between steps. Steps 10 to 12 are not cancellable:
the compaction is committed, and they only finish it.

A recovery journal is not needed. There is no file move or rename. `VACUUM` is
a single SQLite transaction, and backup publication is already atomic. The
exclusive runtime lock prevents any startup from running during the operation.

### D4. Running server or background service: refuse, do not stop it

| Option                                                              | Trade-off                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop and restart the service like a reference tool's doctor command | Convenient. But `bibcode service` has only `install` / `uninstall` / `status` (`config.rs:834`), so we would add per-OS stop/start (systemd, launchd, Windows) to a data-safety command. It also cannot stop the desktop app or WSL backends, and a restart failure would leave the user without a server they did not ask to stop. |
| **Refuse with an actionable message**                               | No new process control. Matches `restore` and `start-empty`.                                                                                                                                                                                                                                                                        |

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
| No backup (reference tool)                                                        | Least disk use. The issue rejects it.                                                                                                                                                                            |
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

Keeping 30 s resolves findings 4 and 5, with one small restore change:

- the 60 s skew check cannot trip, because `created_at` is taken inside a 30 s
  budget. The implementation adds
  `const _: () = assert!(BACKUP_TIMEOUT.as_secs() < MAX_PUBLICATION_TIME_SKEW.as_secs());`
  next to the constants, so a future extension fails to compile until
  `created_at` moves to publication time;
- restore of a pre-compact backup must not depend on unrelated backups. Today
  it does: the lookup inventories, and so verifies, every generation of each
  identity it visits (review finding r2-1). The implementation changes
  `find_verified_backup_for_recovery` to verify only the selected
  generation: for each identity directory that contains
  `<backup-id>`, open that identity's `BackupStoreBoundary` and call
  `verify_generation` on that one directory. The result, error and
  `selected_entry_failed_verification` handling stay as they are. This
  benefits every restore, not only pre-compact ones. After it, restore does
  the work of one verification, one copy and one verification of that copy,
  plus renames. Creating the same generation did a page copy, a
  `quick_check`, a hash, a reload verification and a retention inventory
  that verified it again. So restore does less I/O than creation did, under
  the same 30 s. This is a work bound, not a timing guarantee: a cold disk
  cache at restore time is slower than the warm one at creation. That
  margin is listed in Risks.

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

`VACUUM` itself has no deadline. Ctrl-C cancels it (D3 step 9). A store whose
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
through the WAL, and the checkpoint copies it into the main file. The main
file normally does not grow, but after a crash it can: a crash-left `-wal`
may hold pages beyond the physical end of `state.sqlite` (review finding
r3-2). The precheck therefore uses the logical size from step 6, never the
file length, and counts that growth on the store volume. Peak extra space:

- store volume: `backupBytes (= pageCount × pageSize)` + `compactedBytes`
  (new WAL frames) + `mainGrowthBytes` + 64 MiB headroom, where
  `mainGrowthBytes = max(0, compactedBytes − fileBytes)` is what the final
  checkpoint adds to the main file;
- SQLite temp volume: `compactedBytes` + 64 MiB headroom;
- when both are one volume, the sum.

The rejected alternative was a `wal_checkpoint(TRUNCATE)` under the lock
before measuring. It is safe, but it writes the growth before the precheck can
refuse, so "a refusal writes nothing" would no longer hold. On a clean store
`mainGrowthBytes` is 0, so the formula is unchanged there.

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
the backup, so a refusal writes nothing (D3 step 4: the replay changes only
the in-memory WAL index, and the connection does not checkpoint on close). The test hook is `CompactTestHook::FreeSpace`
(see Code changes).

### D8. `--dry-run`

The dry run reports; it does not prove the SQLite lock. It never opens a
writable connection, because that is not non-mutating: if a crash left
committed frames in `-wal`, the open replays them, and the close of the last
connection checkpoints into `state.sqlite` and deletes the sidecars
([SQLite WAL](https://www.sqlite.org/wal.html)). The creating guards would also
leave `.bibcode-runtime.lock` and `.bibcode-storage.lock` behind (review
finding 3). A read-only probe cannot replace the lock check either: in WAL
mode it creates `-shm`, and an immutable open ignores locks entirely, so it
reports success against a restored `DELETE`-mode store that another program
holds with `BEGIN EXCLUSIVE` (review finding r2-4).

Steps:

1. resolve and re-check the root;
2. `OfflineRecoveryGuard::try_acquire_existing` (non-creating), held to the
   end. `WouldBlock` gives `StoreRunning`; `NotFound` means no owner.
   `StoreOperationGuard` is not taken: it creates its lock file, and the dry
   run writes nothing that needs serializing. A concurrent `restore` or
   `compact` holds the runtime lock exclusively, so the dry run sees
   `StoreRunning`;
3. `classify_store_files`, with the same refusals as the real run (D3 step 3);
4. without sidecars: open `immutable=1`, run `validate_bibcode_schema` and
   read the four pragmas. No `quick_check`: the dry run makes no integrity
   claim, and the real run's backup checks integrity. With sidecars: SQLite is
   not opened (D1). The plan reports `before` page stats as `null` with
   `"uncheckpointed-wal"`, sizes the backup and space needs from
   `fileBytes + walBytes` (an upper bound), leaves `estimatedReclaimBytes`
   `null`, and says "The real run first writes back the changes left in
   `state.sqlite-wal`";
5. the disk-space precheck (D7), then return the plan.

The plan always carries `"sqliteLock": "not-checked"`, and the stderr summary
says: "A dry run does not check whether another program has the database
open. The real run refuses at once if one does, before taking the backup."

A refusal the dry run can see (running, store state, schema, space) is the
same error, with the same non-zero exit, as the real command. It is a preflight
for those, not for SQLite locks or the 30 s backup budget, and the guide says
so. The issue's "dry run wins" behavior falls out of this: there is no `--fix`
flag; the command compacts unless `--dry-run` is given.

### D9. Failure, cancellation and rollback

| Where                                    | State left                                                                                                                                                                                                                                    | Reported                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steps 1–7 (refusal, cancel)              | Nothing written: `state.sqlite`, `-wal` and `-shm` are byte for byte as found (no checkpoint on close, no journal-mode change before the backup). A real run may leave the two lock files (as `restore` does). A dry run leaves nothing (D8). | The specific error. No backup ID.                                                                                                                   |
| Step 8 backup fails, times out or Ctrl-C | Live store untouched. Ctrl-C during the backup is honored when it returns (it is bounded by 30 s); the backup, if published, is kept. An unpublished `.staging` entry is ignored by inventory.                                                | "Could not take the pre-compact backup: …; the database was not changed." Cancelled after publication: `Cancelled` with the backup ID.              |
| Step 9 cancelled before `VACUUM` starts  | The worker returns before running the statement. The database is the pre-compact store.                                                                                                                                                       | `Cancelled { backupId }`: "Compaction was cancelled. The database was not changed. The pre-compact backup `<id>` is kept."                          |
| Step 9 `VACUUM` fails, Ctrl-C, crash     | SQLite rolls back, or WAL recovery does on the next open. The database is the pre-compact store. Setting `auto_vacuum` alone persists nothing.                                                                                                | `CompactFailed { phase: "vacuum", backupId }` (or `Cancelled { backupId }`): "The database was not changed. The pre-compact backup `<id>` is kept." |
| Step 10 checkpoint busy                  | Compacted and committed in the WAL. The close checkpoints it.                                                                                                                                                                                 | A warning in the report (`checkpoint: "deferred"`). Success.                                                                                        |
| Step 11 `quick_check` or stat mismatch   | The database as SQLite left it.                                                                                                                                                                                                               | `CompactFailed { phase: "verify", backupId }`: "…restore it with `bibcode storage restore --backup-id <id>`." Exit non-zero.                        |

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
  `trigger` is unknown to the running build (Tests, item 17).
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
  "before": {
    "fileBytes": 0,
    "walBytes": 0,
    "pageSize": 0,
    "pageCount": 0,
    "freelistCount": 0,
    "autoVacuum": "none"
  },
  "plan": {
    "backupBytes": 0,
    "estimatedCompactedBytes": 0,
    "estimatedReclaimBytes": 0,
    "autoVacuumAfter": "incremental",
    "requiredFreeBytes": { "store": 0, "temp": 0, "sameVolume": true },
    "availableFreeBytes": { "store": 0, "temp": 0 },
    "backupBudgetSeconds": 30,
    "sqliteLock": "locked | not-checked (dry run)"
  },
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
  started only _after_ the exclusive runtime lock is held, so it is never a
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
notice is out of scope. If a notice is added later, the reference tool's 1 GiB is a starting
point, to be checked against #225's measurements.

### D14. Event-history pruning

Out of scope. When pruning lands it can run before step 8 under the same locks,
which is the order a reference tool's doctor uses. That is its own design.

## Code changes (for the implementation PR)

- `persistence/database.rs`: a create flag on the staging open that sets
  `auto_vacuum`; `open_for_maintenance` (`NO_CKPT_ON_CLOSE`
  when a `-wal` already exists, `busy_timeout = 0`, `locking_mode = EXCLUSIVE`, no `journal_mode` change,
  `BEGIN EXCLUSIVE` probe); a space-stats query;
  a cancellable `VACUUM` closure (pre-check plus progress handler).
- `persistence/migrations.rs`: `validate_bibcode_schema(&Connection, …)`
  extracted from the two validators, which now call it.
- `persistence/backup.rs` also gains
  `inspect_store_for_integration_test(root, before_inventory: impl FnOnce())`,
  the complete `inspect_store` with a callback at the point where the guard
  has been dropped and the inventory is about to start.
- `persistence/store.rs`: `validate_existing_store_for_inspection` takes the
  guard result (D1) and opens SQLite only in the cases D1's table allows.
- `persistence/backup.rs`: `BackupTrigger::PreCompact`; the pre-compact
  retention rule; `OfflineRecoveryGuard::try_acquire_existing`, held by
  `inspect_store` for classification and stats;
  `classify_store_files` extracted from `inspect_store`;
  `find_verified_backup_for_recovery` verifies only the selected generation
  (D5);
  `StoreInspection.database`; the `BACKUP_TIMEOUT < MAX_PUBLICATION_TIME_SKEW`
  compile-time assertion; new `RecoveryError` variants `DatabaseLocked`,
  `InsufficientSpace`, `NotCompactable`, `Cancelled` and `CompactFailed`. No
  backup or restore deadline changes.
- `persistence/compaction.rs` (new): the flow, the free-space probe and the
  test entry point `compact_store_for_integration_test(root, options,
  CompactTestHook)`, following the crate's `_for_integration_test` and fault
  enum conventions (`BackupFault`, `RecoveryFault`). `CompactTestHook` is
  `None`, `FreeSpace { store, temp, same_volume }`, `CancelAfterBackup`
  (cancels the token when the
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
covers `state_dir`, `backups/` and both lock files. "Crash-left WAL fixture"
means `state.sqlite` and `-wal`, with committed frames, copied from a store
whose writer is still open with `wal_autocheckpoint = 0`; "with `-shm`" adds
that file too.

Inspection:

1. Extend `recovery_inspection_reports_verified_store_state_without_mutating_it`.
   The fixture inserts and then deletes rows. Check `database.fileBytes` equals
   the file length; `pageCount`, `freelistCount > 0` and `autoVacuum: "none"`
   match a direct `immutable=1` read; and the listings are unchanged (no
   `-wal`, `-shm` or `.bibcode-runtime.lock`).
2. `inspection_while_a_server_owns_the_store_reports_sizes_and_store_running`:
   `ServerRuntime::start`, then `fileBytes > 0`, stats `null`,
   `databaseStatsUnavailable: "store-running"`, classification `existing`, and
   database, marker and listings unchanged.
3. `inspection_of_an_owned_store_never_opens_sqlite` (finding r2-3): the test
   holds `.bibcode-runtime.lock` shared, as a server does, over the
   crash-left WAL fixture without `-shm`. That is the state the shutdown race
   produces. Classification `existing`, `"store-running"`, and no `-shm`
   appears. The current code creates one, so this fails before the change.
4. `inspection_of_an_offline_store_with_one_sidecar_creates_nothing`: the
   crash-left WAL fixture without `-shm`, in a root with a lock file and in a
   root without one. Classification `unsafe-database-state` with the sidecar
   issue, `"uncheckpointed-wal"`, and listings, database and `-wal` bytes
   unchanged. A `store.rs` unit test covers the `-shm`-only case and the
   no-lock-file-with-both-sidecars case.
5. `inspection_releases_the_runtime_lock_before_the_backup_inventory`
   (finding r3-1): a store with backups, inspected through
   `inspect_store_for_integration_test`. In `before_inventory` the test
   asserts that `try_lock_shared` on `.bibcode-runtime.lock`, the first step
   of a server's lock acquisition, succeeds, and spawns
   `ServerRuntime::start` on the root. Both the inspection and the server
   start complete. Before the change the shared lock fails, because the
   guard is still held.
6. `first_run_store_reports_incremental_auto_vacuum_and_a_fixture_keeps_none`.

Dry run:

7. `compact_dry_run_reports_reclaim_and_changes_nothing`: the estimate is
   within 1 % of `freelistCount × pageSize`; `sqliteLock: "not-checked"`;
   database bytes, marker and listings are unchanged, including in a root that
   has never had a lock file.
8. `compact_dry_run_on_a_crash_left_wal_reports_upper_bounds_and_changes_nothing`:
   the crash-left WAL fixture with `-shm`. Page stats and reclaim are `null`,
   the backup estimate is `fileBytes + walBytes`; database, `-wal` and `-shm`
   bytes and listings are unchanged.

Compaction:

9. `compact_reclaims_space_behind_exactly_one_verified_pre_compact_backup`:
   one new generation with trigger `pre-compact` that inventories as verified;
   `fileBytes` shrinks; `freelistCount == 0`; `autoVacuum: "incremental"`;
   every project, thread and message reads back equal to before (snapshot of
   the projection tables); no `-wal` remains.
10. `compact_recovers_a_crash_left_wal_under_its_lock` (finding r2-2): the
    crash-left WAL fixture with `-shm`, and once without it. Compaction
    succeeds without a server start; the rows that existed only in `-wal` are
    present in both the pre-compact backup and the compacted store; neither
    `-wal` nor `-shm` remains (finding r6-1); and a following `inspect`
    reports `existing`.
11. `compact_refuses_while_a_server_owns_the_store`, modeled on `:1294`:
    `StoreRunning`, no backup directory entry, and the database and marker
    are unchanged. Plus
    `compact_refuses_an_empty_or_headerless_database_before_any_write`
    (finding r6-2): a valid marker with a zero-length `state.sqlite`, then
    with a 4 KiB non-SQLite file, then with a valid store beside a
    `state.sqlite-journal`. Each case gives `NotCompactable`, no backup, no
    new sidecar, and `state.sqlite` and the journal byte for byte unchanged.
12. `compact_refuses_a_locked_database_without_waiting` (findings 1 and r2-4):
    a normal WAL store whose other connection holds `BEGIN EXCLUSIVE` with a
    pending write, and a store just restored from a backup
    (`journal_mode = DELETE`, no sidecars) whose other connection holds
    `BEGIN EXCLUSIVE` with no write. Each `compact` fails with
    `DatabaseLocked` in under 1 s (less than the classifier's 5 s and
    `BUSY_TIMEOUT`), and no backup is taken. In the restored case
    `compact --dry-run` succeeds with `sqliteLock: "not-checked"` and changes
    nothing, which pins the documented limit. Then the restored store's other
    connection makes a pending write: in rollback mode SQLite creates
    `state.sqlite-journal` immediately, so the step-3 file check refuses with
    `NotCompactable`, also in under 1 s and with no backup (implementation
    finding, accepted). After the other connection rolls back, the database,
    `-wal` and `-shm` bytes equal the original in every case, and the restored
    store stays in `DELETE` mode.
13. `compact_refuses_insufficient_disk_space_before_the_backup`: through
    `CompactTestHook::FreeSpace`, `InsufficientSpace` with both numbers and
    no backup. Run on three stores: clean WAL-mode with no sidecars, the
    crash-left WAL fixture with `-shm`, and a restored `DELETE`-mode store.
    In each, `state.sqlite` is byte for byte unchanged after the command
    returns; a pre-existing `-wal` or `-shm` is byte-identical (finding r4-1:
    no checkpoint on close); a sidecar that was absent is still absent
    (finding r5-1: no stray empty `-wal`); and the restored store is still in
    `DELETE` mode. A follow-up `inspect` of the clean store reports
    `existing`.
14. `compact_counts_main_file_growth_held_in_a_crash_left_wal` (finding
    r3-2): a crash-left WAL fixture whose `-wal` holds many pages beyond the
    physical main file, split volumes (`same_volume: false`), and store-volume
    free space exactly one byte below the new requirement, which is above the
    revision-3 formula. `InsufficientSpace { volume: "store" }`, no backup,
    and `state.sqlite`, `-wal` and `-shm` byte for byte unchanged, so the
    main file did not grow. With one more byte it compacts, and no `-wal`
    remains.
15. `compact_cancelled_after_the_backup_leaves_the_store_unchanged`
    (finding 6): `CompactTestHook::CancelAfterBackup`. `Cancelled` with the
    backup ID; the backup inventories as verified. Run on the clean store
    with no sidecars and on the crash-left WAL fixture: `state.sqlite` is
    unchanged, absent sidecars are still absent, and a pre-existing `-wal`
    is byte-identical.
16. `compact_cancelled_during_vacuum_rolls_back_and_restarts_cleanly`
    (finding 6): `CompactTestHook::CancelDuringVacuum`. `Cancelled` with the
    backup ID; then `prepare_store` on the root (a normal restart) succeeds,
    every projection row reads back equal, `freelistCount` and
    `autoVacuum: "none"` are as before, and the pre-compact backup is still
    verified.

Backups and restore:

17. `inventory_keeps_other_backups_beside_a_manifest_with_an_unknown_trigger`.
    This is the older-app model. Retention leaves the unknown generation in
    place.
18. `pre_compact_backup_restores_with_restore_backup_id`, with an older
    pre-update generation of the same identity and a generation of another
    identity present.
19. Unit (`backup.rs`), Unix only:
    `recovery_lookup_verifies_only_the_selected_generation` (finding r2-1).
    Beside the small selected generation, an older generation of the same
    identity has a sparse 8 GiB `backup.sqlite` with a manifest of that
    size. `find_verified_backup_for_recovery` with a 2 s deadline returns the
    selected backup. The current code hashes the large file and fails with
    `DeadlineElapsed` at 2 s, so the red run is quick. Sparse files are
    guaranteed on the Linux and macOS CI filesystems; Windows shares the code
    path.
20. Unit (`backup.rs`): `pre_compact_retention_keeps_one_pre_compact_and_two_older_generations`.
21. Unit (`database.rs`): `open_for_maintenance_fails_at_once_on_a_locked_database`.
22. Unit (`config.rs`): `storage compact`, `storage compact --dry-run --json`,
    and a rejected unknown flag.
23. Unit (`compaction.rs`): the required-space arithmetic for same-volume and
    split-volume cases, including `pageCount × pageSize > fileBytes`, where
    `mainGrowthBytes` lands on the store volume only.
24. Contracts: an `ipc.test.ts` case that decodes a `"pre-compact"` backup.
    `vp run check:contracts`.
25. Unchanged and must pass: all restore, start-empty, startup, migration,
    pre-update, retention and validator tests (the schema-check extraction
    touches both validators); `projectDataSafety.test.ts`;
    `ProjectDataRecoveryDialog.test.tsx`; the desktop `data_safety.rs` tests;
    `vp run test:ui:desktop` (`main-window.e2e.ts`,
    `platform-capabilities.e2e.ts`).

No slow-backup test: the budgets do not change (D5). The compile-time
assertion replaces a timing test for finding 4.

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

## Verification by implementation

The design relies on these SQLite behaviors. They come from SQLite's
documentation and source, and from the reference tool's report. None has been observed in
this repository yet. Each is proven by a real-SQLite test in the
implementation PR, and a failing test reopens the design rather than being
weakened.

| Behavior relied on                                                                                                                                                                                                              | Proven by        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `auto_vacuum = INCREMENTAL` set on the zero-page staging connection before `journal_mode = WAL` takes effect                                                                                                                    | Test 6           |
| `VACUUM` in WAL mode switches an existing store to `incremental` and leaves `freelist_count = 0`                                                                                                                                | Test 9           |
| `immutable=1` opens create no files; a plain read-only open creates nothing when both sidecars exist                                                                                                                            | Tests 1, 3, 4    |
| `locking_mode = EXCLUSIVE` before first access creates no `-shm`, and replays a crash-left WAL with or without `-shm`                                                                                                           | Tests 9, 10      |
| `busy_timeout = 0` plus `BEGIN EXCLUSIVE` fails at once against a held lock, in WAL and `DELETE` modes (`DatabaseLocked`); a pending `DELETE`-mode write creates `-journal` at once, which step 3 refuses with `NotCompactable` | Tests 12, 21     |
| The online-backup copy works from the connection that holds the exclusive lock                                                                                                                                                  | Test 9           |
| `NO_CKPT_ON_CLOSE` leaves a pre-existing WAL and the main file untouched on close                                                                                                                                               | Tests 13, 14, 15 |
| Without the flag, closing a connection whose WAL has no committed frames writes nothing to the main file and deletes the WAL                                                                                                    | Tests 13, 15     |
| A heap-index close deletes the WAL but leaves a crash-left `-shm`, which compaction then removes                                                                                                                                | Test 10          |
| The pre-check plus a progress handler stops `VACUUM` before and during execution, and a cancelled `VACUUM` rolls back cleanly                                                                                                   | Tests 15, 16     |
| A zero-length database is initialized by the first write transaction, so it must be refused before one                                                                                                                          | Test 11          |

## Risks and unmeasured

- `VACUUM` duration and real free-page ratios are unmeasured (the issue's "Not
  measured"; #225). The 1 % estimate is a placeholder.
- Stores whose verified backup takes more than 30 s cannot be compacted (D5).
  They already cannot take pre-update or pre-migration backups. The follow-up
  is one size-scaled budget across creation, restore, inventory and the
  classifier, `created_at` at publication time, Ctrl-C on `restore`, and a
  slow-backup test. The compile-time assertion stops a partial extension.
- Restore of a pre-compact backup does less I/O than its creation did, but on a
  cold disk cache it may still approach the 30 s limit for a backup that took
  close to 30 s to create. The fix is the same follow-up.
- The SQLite behaviors listed under "Verification by implementation" are not
  yet observed here. If the progress handler does not interrupt `VACUUM`, the
  closure also calls the connection's interrupt handle from the cancellation
  path and keeps the pre-check. If `auto_vacuum` does not take effect on the
  staged file, the pragma moves earlier (D2).
- Removing an orphan `-shm` after compaction (D3 step 12) races only a
  third-party SQLite program that opens the database at that moment, which
  the recovery guide forbids.
- The final page copy inside `VACUUM` is not interruptible, so Ctrl-C can take
  as long as writing the compacted size.
- The dry run does not check SQLite locks (D8). The real run refuses at once,
  before the backup.
- Inspection of an offline store with both sidecars can still race a
  third-party SQLite program that closes the database at that moment (D1).
  The recovery guide forbids such programs while BiBCode data is in use.
- The pre-compact backup temporarily _raises_ total disk use. The dry run and
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

## Review findings and resolutions

Round 2 disproved revision 2's premise that compaction could reuse the
classifier, the sidecar check and the restore lookup as they are. Revision 3
replans around one rule: decide what to open from a lock held for the whole
operation, never from a file-existence check made earlier.

| #    | Finding (verified against source and SQLite docs)                                                                                                     | Resolution (revision 3)                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Reusing the inspection classifier before the lock probe waits up to 5 s on a locked store (`migrations.rs:384`) and times out on a large healthy one. | Compaction never calls the SQLite classifier. It takes its locks, then one writable connection with `busy_timeout = 0` and `BEGIN EXCLUSIVE`, then checks the schema on it (D3 steps 3–5). Tests 12, 21.                       |
| 2    | With either sidecar present the classifier opens plain read-only SQLite (`store.rs:339`), which creates a missing `-shm`.                             | Superseded by r2-3: SQLite is opened only as D1's lock table allows. Tests 3, 4.                                                                                                                                               |
| 3    | The dry run's writable open can checkpoint crash-left WAL frames and delete sidecars; the creating guards leave lock files.                           | The dry run takes only the non-creating runtime guard and reads through `immutable=1`, or not at all when sidecars exist (D8). Tests 7, 8.                                                                                     |
| 4    | `created_at` precedes the copy (`backup.rs:533`) but must be within 60 s of publication (`backup.rs:2024`).                                           | Budgets are not extended (D5); 30 s cannot exceed the 60 s skew. A compile-time assertion pins `BACKUP_TIMEOUT < MAX_PUBLICATION_TIME_SKEW`.                                                                                   |
| 5    | Restore keeps `RECOVERY_TIMEOUT = 30 s` (`backup.rs:846`).                                                                                            | Budgets are not extended, and restore verifies only the selected generation (r2-1), so it does less I/O than creation did. Tests 18, 19.                                                                                       |
| 6    | `sqlite3_interrupt` with no running statement is a no-op, so Ctrl-C between the backup and `VACUUM` is lost.                                          | One worker closure checks the token, then runs `VACUUM` under a progress handler that returns the token state (D3 step 9). Tests 15, 16.                                                                                       |
| r2-1 | Restore's lookup inventories every generation of each identity it visits (`backup.rs:1169–1205`), so unrelated backups spend its 30 s.                | `find_verified_backup_for_recovery` verifies only `<identity>/<backup-id>` (D5). The work-bound claim is restated with its cold-cache limit (Risks). Tests 18, 19.                                                             |
| r2-2 | Refusing crash-left sidecars can strand a store whose startup validation exceeds 5 s (`store.rs:262`, `migrations.rs:17`).                            | No refusal: compaction's locked writable connection replays the WAL itself, as a server start would, without startup's validation (D3 step 4). Test 10.                                                                        |
| r2-3 | Unlocked inspection can see both sidecars, lose them to a server shutdown, and recreate them on open.                                                 | Inspection holds the non-creating runtime guard for classification and stats. While a BiBCode process owns the root, SQLite is not opened at all; offline, no BiBCode process can remove sidecars mid-inspection (D1). Test 3. |
| r2-4 | The immutable dry-run read misses a `BEGIN EXCLUSIVE` held on a restored `DELETE`-mode store (`database.rs:715`).                                     | The dry run no longer claims a lock check: `sqliteLock: "not-checked"` and a stderr line say so; the real run's probe refuses at once (D8). Test 12 covers both modes.                                                         |

Round 3:

- **r3-1**, inspection could stall a starting server: the exclusive guard
  covered the backup inventory too, with its own 30 s budget. The guard is now
  dropped after classification and stats (D1). Test 5.
- **r3-2**, the space check missed main-file growth held in a crash-left WAL:
  the precheck uses the logical size from the recovered connection and adds
  `mainGrowthBytes` on the store volume (D3 step 6, D7). Tests 14, 23.

Round 4:

- **r4-1**, a refusal before the backup could still grow the main file,
  because closing the maintenance connection checkpoints a crash-left WAL.
  The connection sets `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` before its first
  read and clears it only after a verified compaction; the journal-mode
  conversion moves after the backup (D3 steps 4, 9, 12). Tests 12, 13, 14
  and 15 assert `state.sqlite`, `-wal` and `-shm` unchanged.

Round 5:

- **r5-1**, a refusal on a clean store left an empty `-wal` without `-shm`,
  which inspection reports as unsafe: the open creates the WAL, and
  `NO_CKPT_ON_CLOSE` stops the close from deleting it. The flag is now set
  only when a `-wal` existed before the open; otherwise SQLite's normal close
  deletes the empty WAL (D3 steps 4 and 12). Tests 13 and 15.

Round 6:

- **r6-1**, a successful compaction could leave an orphan `-shm`, which
  inspection reports as unsafe: after a verified compaction, a `-shm`
  without `-wal` is removed under the runtime lock (D3 step 12). Test 10.
- **r6-2**, the lock probe could initialize a zero-length database before
  the schema check: the header is checked with plain file I/O, and a hot
  `-journal` is refused, before any SQLite open (D3 step 3). Test 11.
- The SQLite behaviors the design relies on, and the test that proves each,
  are listed under "Verification by implementation".

Scope-down: compaction of stores whose backup exceeds the existing 30 s budget
(D5, Risks). The issue's acceptance criteria use small hermetic fixtures and
are all met. Rejected alternative for the backup: a separate `VACUUM INTO`
writer. It would duplicate backup publication and verification, and its copy
is already a vacuumed artifact (D5).
