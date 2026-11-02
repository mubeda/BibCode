# Project data safety and recovery

BiBCode stores its project catalog in a Rust/SQLite server store, separately
from the installed application files. A normal in-place application update
replaces the application and should retain the selected store. If projects are
missing, do not assume that the old database was deleted: a different account,
home, explicit root, state kind, symlink/junction target, WSL distribution, or
remote endpoint can select another store and produce the same symptom.

Do not copy, rename, delete, or open `state.sqlite`, its WAL/SHM files, or the
`environment-id` marker while any BiBCode process is running. Close BiBCode and
its local/WSL backends first, then use the desktop recovery dialog or the
offline `bibcode storage inspect` command.

## What identifies a store

The base root defaults to the current user's `~/.bibcode`. For the server, an
explicit `--base-dir` wins over `BIBCODE_HOME`; desktop bootstrap configuration
can also supply the root. Installed desktop builds use the `userdata` state
kind and development builds use `dev`. They normally share the base root but
do not share the state directory.

The recovery dialog shows:

- **Requested root:** the configured path before filesystem aliases are
  resolved.
- **Effective root:** the canonical location after symlinks, junctions, and
  existing ancestors are resolved.
- **Storage ID:** the persistent `storageInstanceId` stored in the
  `environment-id` marker.
- **Verified backups:** the newest three verified generations for that storage
  identity and state kind. Backups are created before a migration, a
  coordinated in-app update, or a compaction. At most one of the three is a
  `pre-compact` backup: a new compaction replaces the previous pre-compact
  backup instead of pushing out an older pre-update or pre-migration one.

An alias warning means that the requested and effective roots differ. It is not
itself corruption, but changing the target of an alias selects different data.
Normal server descriptors publish the storage UUID and never publish either
root or alias diagnostics.

## Expected outcomes by platform

| Platform and scenario                                                                                                     | Observable outcome                                                                                                                     | Safe action                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows native: `BIBCODE_HOME`, CLI `--base-dir`, Windows account/profile/home, drive, or junction/reparse target changed | A different effective root or store is selected; projects may look empty or a storage mismatch is blocked.                             | Open **Project data recovery**, compare requested/effective roots and Storage ID, then restore the original configuration or select a verified backup. Do not repoint aliases while BiBCode is running. |
| Windows native: permissions, endpoint protection, Controlled Folder Access, or another security tool blocks files         | Inspection/startup reports unavailable or recovery required; startup must not replace the store.                                       | Close BiBCode, restore access or allow-list the data root, retry inspection, and export redacted diagnostics if it still fails.                                                                         |
| Windows native: database or marker is missing, malformed, unrelated, or corrupt                                           | Classification fails closed. A marker-without-database state is never treated as first run.                                            | Inspect offline, restore a verified backup if available, or explicitly **Start empty** after accepting preservation of the current files.                                                               |
| Windows WSL: distro, Linux user/home, `BIBCODE_HOME`, or selected root changed                                            | The desktop reaches a different Linux root or cannot resolve the configured plan; storage mismatch or unavailable state is shown.      | Re-select the intended distro/root and retry. Recovery uses the exact root recorded in the launch plan and never guesses another WSL home.                                                              |
| Windows WSL-only distro unavailable                                                                                       | A tagged WSL-primary error is shown; native Windows is not launched automatically.                                                     | Restore the distro, select another distro, or explicitly **Switch to Windows**. Switching is a deliberate topology change, not recovery of the WSL store.                                               |
| Windows native plus optional WSL secondary unavailable                                                                    | Native primary stays live; the stable WSL environment remains desired/unavailable and cached rows remain visible.                      | Retry WSL, choose a distro, or explicitly turn off/replace that secondary.                                                                                                                              |
| macOS: account/home, `BIBCODE_HOME`, or symlink target changed                                                            | Another effective root is selected and may appear empty or trigger a storage mismatch.                                                 | Compare requested/effective roots and Storage ID; restore the original account/root/target or use verified recovery.                                                                                    |
| macOS: permissions, quarantine, endpoint security, backup/cleanup software, or another security tool interferes           | The store or application may be unavailable; classification/recovery fails closed instead of silently creating over existing evidence. | Close BiBCode, resolve OS access/quarantine policy, retry inspection, and preserve/export diagnostics before changing files.                                                                            |
| macOS: database or marker missing/corrupt                                                                                 | Recovery-required state; no implicit replacement of an existing artifact.                                                              | Restore a verified backup or explicitly start empty after preservation.                                                                                                                                 |
| Linux: account/home, `BIBCODE_HOME`, symlink, mount, or mount target changed                                              | A different or unavailable effective root is selected. Moving the AppImage alone should not move the default root.                     | Restore the original root/mount/alias target and inspect; do not infer the store location from the AppImage location.                                                                                   |
| Linux: AppImage replaced manually or updated by an external package manager                                               | The in-app update coordinator did not run. Project data should remain separate, but no automatic `pre-update` backup was requested.    | Close all BiBCode processes before replacement. Afterward compare root and Storage ID; use recovery if classification fails.                                                                            |
| Linux: permissions or database/marker corruption                                                                          | Startup is unavailable or recovery required and fails closed.                                                                          | Fix ownership/permissions without deleting files, then inspect; restore a verified backup or explicitly start empty.                                                                                    |
| Any platform: a saved bearer, relay, or SSH endpoint now reaches a different store                                        | The same logical environment reports a different non-null storage UUID and is blocked before session synchronization.                  | Verify the endpoint, then reconnect to the intended server or explicitly adopt the new Storage ID. Adoption does not merge databases or clear the old server.                                           |
| Any platform: the client connection catalog is corrupt                                                                    | Catalog health becomes `recovery-required`; mutations and an authoritative empty-project result are blocked.                           | Preserve diagnostics and use the separate explicit catalog-reset support action. It does not delete server project databases, and corrupt bytes are never silently rewritten as empty.                  |
| Any platform: migration or coordinated update backup cannot be verified                                                   | Migration/update stops before it modifies or installs against the unprotected store.                                                   | Resolve the reported path, space, permission, or filesystem problem, then retry. Never bypass the primary-store protection dialog.                                                                      |
| Any platform: explicit **Start empty**                                                                                    | Existing database, WAL/SHM, and marker files are first preserved in a private recovery generation; the next store gets a new UUID.     | Confirm separately, restart, review the new Storage ID, and explicitly adopt it only if the empty store is intended.                                                                                    |

## Recovery workflow

1. Close every BiBCode window and verify that no native or WSL BiBCode process
   owns the selected root. Do not stop a process by deleting its files.
2. Open **Project data recovery** from the affected local environment. The
   dialog is available only for desktop-owned native and WSL backends; remote
   bearer/relay/SSH stores must be recovered on their owning machine. When a
   desktop backend cannot start because Rust classifies its store as
   recovery-required, the host retains the stopped launch target and the
   dialog opens automatically even if the failure happened before the WebView
   mounted. The renderer re-inspects the host status; it does not infer this
   state from a generic connection error.
3. Compare requested root, effective root, and Storage ID with the environment
   you intended to open, and confirm whether you launched an installed
   (`userdata`) or development (`dev`) build. Use **Open data folder** only
   after the target is stopped. **Export diagnostics** produces bounded
   redacted evidence rather than database contents or credentials.
4. Prefer **Restore selected backup** when a verified generation contains the
   intended store. Restore verifies identity, location, checksum, SQLite
   integrity, and migration history, preserves the current live files, then
   installs the selected generation under the storage-operation lock.
5. Use **Start empty** only when you deliberately want a new store. The current
   database, sidecars, and marker are preserved first; they are not deleted.
   The new UUID still requires explicit client adoption before normal retry.
   **Use this data location** is a separate adoption action and always presents
   the desktop-native confirmation that the two locations are not merged.
   Cancelling that confirmation leaves the accepted identity unchanged.

The project list is intentionally conservative during this process. Cached
projects remain visible through reconnect, degradation, unavailability,
storage mismatch, and recovery. **No projects yet** is valid only after the
environment catalog has loaded, at least one environment is desired, and every
desired environment has supplied a successful live authoritative snapshot that
is genuinely empty.

## Reclaim database space

SQLite keeps the pages that deleted rows free inside `state.sqlite`, so the
file does not shrink on its own. Check how much space a store could give back
with:

```sh
bibcode storage inspect
```

Its `database` object reports:

- `fileBytes`, `walBytes` and `shmBytes`: the sizes of `state.sqlite` and its
  sidecars, always.
- `pageSize`, `pageCount`, `freelistCount`, `reclaimableBytes`
  (`freelistCount × pageSize`) and `autoVacuum` (`none`, `full` or
  `incremental`): read from the database header only when it can be done
  without creating or changing any file. Otherwise they are `null` and
  `databaseStatsUnavailable` says why: `store-running` (a BiBCode app, server,
  MCP relay or pairing command owns the data root), `uncheckpointed-wal` (a
  `state.sqlite-wal` or `-shm` file is present, so the header would be out of
  date) or `unreadable`.

Inspection never opens SQLite while a BiBCode process owns the data root, and
it reports the store from its files instead. If an offline store has exactly
one sidecar, or has sidecars but has never been owned by a server, inspection
reports `unsafe-database-state` rather than create a file. Start BiBCode once
and quit it, or run `bibcode storage compact`, which recovers the sidecars under
its own lock.

To reclaim the space, quit the BiBCode app, stop `bibcode serve` and any WSL
backend, and stop the background service (`bibcode service status` shows it).
Then preview the compaction:

```sh
bibcode storage compact --dry-run
```

The dry run changes nothing and creates no files. It reports the expected
reclaim, the size of the backup the real run takes, and the free space it
needs on the data-root volume and on the volume that holds SQLite's temporary
files. It refuses, with the same error and exit status as the real run, when a
BiBCode process owns the store, the store is not in a compactable state, the
schema is not recognized, or there is not enough free space. It does not check
whether another program has the database open. `plan.backupBudgetSeconds` is
the time the backup may take: 30 seconds plus 4 minutes per GiB of the store.

Then compact:

```sh
bibcode storage compact
```

The command:

1. takes the store's exclusive runtime lock and storage-operation lock, and
   refuses if any BiBCode process owns the data root;
2. opens the database exclusively and refuses at once if another program has
   it open; changes left in `state.sqlite-wal` by a crash are written back
   under this lock, as a server start would;
3. checks the free space and refuses with the numbers if there is not enough;
4. takes a verified `pre-compact` backup of the whole store, within 30 seconds
   plus 4 minutes per GiB; it says how long that can take, and prints a
   "still backing up" line every 30 seconds;
5. runs `VACUUM`, which also switches the store to `auto_vacuum = incremental`,
   then checks its integrity.

Compaction refuses a store whose state directory or `state.sqlite` is a
symbolic link or junction, because SQLite keeps its recovery files beside the
link target. It also refuses when `state.sqlite` or one
of its sidecars has another name (a hard link): the other name may hold
changes that are not written into the file yet. Open that store with BiBCode
under its original name and quit it normally so its changes are written, then
remove the extra name and retry. If a cancelled or failed `VACUUM` had already switched an
`auto_vacuum = full` store to `incremental`, it switches it back. Every refusal
before the backup leaves `state.sqlite` and its sidecars exactly as they were. Progress goes to stderr; stdout carries one JSON report with
`before`, `plan`, `backupId`, `after` and `reclaimedBytes`. Press Ctrl-C to
cancel: during the backup nothing is published and the database is left as it
was; before or during `VACUUM` the database is left as it was, and the
pre-compact backup is kept. If the backup does not finish within its limit, the
command stops, removes the unfinished copy and leaves the database unchanged;
check that the disk is not busy or failing, then retry.

Compaction temporarily uses more disk, not less: right after it, the store
uses its compacted size plus the pre-compact backup, which is as large as the
store was. Older backups are also full-size copies. They shrink only as newer
backups replace them.

If verification fails after `VACUUM`, the error names the pre-compact backup.
Restore it with:

```sh
bibcode storage restore --backup-id <backup-id>
```

Stores created by this release start with `auto_vacuum = incremental`.
Existing stores report `none` until they are compacted. BiBCode does not yet
return free pages in the background.

## Restore time limits and interrupted restores

`bibcode storage restore --backup-id <backup-id>` checks the selected backup's
checksum and SQLite integrity, copies it, and checks the copy again before it
touches the current database. It may take 30 seconds plus 4 minutes per GiB of
the backup, and prints a "still restoring" line every 30 seconds. Press Ctrl-C
to stop it before the current database is replaced; a stopped or failed restore
removes its unfinished copy and leaves the current database as it was.

The backup list in `inspect` and in the desktop checks each backup's location,
manifest, size and migration history, which takes the same time however large
the backup is. A backup that was damaged after it was made is still listed;
restoring it fails before anything changes, so choose an older one. Retention
never deletes a backup because of a damaged newer one.

Once a restore or **Start empty** starts replacing the current files, it is
recorded in a recovery journal, `.bibcode-recovery-userdata.json` (or
`-dev.json`) in the data root. If it is interrupted then, by a crash, a closed
terminal, a full disk or the desktop's WSL time limit, BiBCode and its pairing
and MCP commands refuse to open the store and say:

> An interrupted project-data recovery must be finished before BiBCode can open
> this store. Quit BiBCode, then run `bibcode storage restore --resume`.

Run that command (inside the WSL distribution for a WSL store, with the same
`--base-dir` if you use one). It finishes the interrupted operation: the
previous files end up in `recovery/`, and the restored backup is installed. If
the journal or the files are not what it expects, it refuses and changes
nothing; keep every file in the data root and export diagnostics before you
change anything by hand. With no journal, `--resume` clears a restore that was
stopped before it changed anything, or reports that there is nothing to
resume.

## Limits and unrelated leftovers

The first release that creates and checks storage UUIDs cannot detect a switch
that happened earlier between two otherwise valid unmarked BiBCode databases.
Protection begins when a database receives an `environment-id` UUID and the
client records it. Preserve any older roots until the intended store has been
identified and backed up.

BiBCode has no T4Code compatibility, migration, scanning, or automatic
adoption. T4Code leftovers are inert unless `BIBCODE_HOME`, `--base-dir`, a
desktop launch plan, or a remote endpoint explicitly points current BiBCode at
them. If they overlap the selected current root, the current marker/database
classifier applies and fails closed; BiBCode does not reinterpret them as a
legacy store.
