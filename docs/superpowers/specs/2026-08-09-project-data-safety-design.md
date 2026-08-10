# Cross-Platform Project Data Safety Design

**Date:** 2026-08-09

**Status:** Proposed; design direction approved, awaiting specification review

## Summary

BiBCode stores its local project catalog and related persistent state in SQLite
under the resolved BiBCode data root. The desktop updater replaces application
files; it does not intentionally remove that database. Projects can nevertheless
appear to disappear when the application starts against a different data root,
silently changes execution environments, loses access to a configured
environment, or creates a new database after the expected database is missing.
The current web UI can then render the resulting unavailable or not-yet-loaded
state as `No projects yet`, which is indistinguishable from a genuine empty
catalog.

This design makes data identity explicit, prevents silent source changes,
introduces bounded verified backups at the two destructive lifecycle seams,
adds an explicit recovery flow, and validates real packaged upgrades on
Windows, macOS, and Linux. Windows Subsystem for Linux (WSL) is treated as a
separate storage environment even when it is selected as the primary backend.

The safety model is deliberately conservative:

- An unavailable catalog is never presented as an empty catalog.
- A logical environment cannot silently begin serving a different persistent
  store.
- A database that was known to exist cannot silently be recreated as empty.
- Migrations and in-app updates do not proceed unless the relevant live data is
  protected by a verified backup.
- Recovery and adoption of a different store require explicit user action.

This design does not scan for, migrate, merge, or otherwise interpret legacy
application data. Legacy filesystem leftovers are inert unless the current
configuration, a filesystem alias, or a remote connection explicitly points at
them.

## Context and Problem Statement

The stable desktop releases use the same application identifier and default
data root, and the updater replaces the application package rather than the
database. That makes an ordinary in-place update non-destructive by design, but
it is not a complete data-safety guarantee.

The current implementation has several failure modes that can resemble a fresh
installation:

1. `BIBCODE_HOME`, a CLI data-root argument, the current OS user, or filesystem
   aliasing can resolve the same application to a different state directory.
2. On Windows, a WSL-only launch failure can silently fall back to the Windows
   backend while retaining the same logical environment identifier.
3. A missing SQLite file is opened with `SQLITE_OPEN_CREATE`, so a known store
   can be replaced by a newly created empty store without a recovery decision.
4. Connection-catalog and synchronization failures can leave the client with no
   live snapshot, while the sidebar still renders the generic empty message.
5. Release validation covers fresh packaged launches but does not seed a
   project in one packaged version, update it, and prove that the next packaged
   version uses the same persistent store.

SQLite corruption is already rejected without replacing the corrupt file, and
migrations are transactional. Those protections remain and become inputs to a
more explicit startup and recovery state machine.

## Goals

1. Distinguish a genuinely new installation from a missing, corrupt,
   unavailable, or changed persistent store.
2. Give every store a durable identity that is independent of its logical
   environment name and absolute path.
3. Resolve and report the effective data root consistently in the server, CLI,
   desktop host, native Windows backend, macOS/Linux backend, and WSL backend.
4. Reject ambiguous relative data-root overrides and surface filesystem aliases
   such as symlinks and Windows junctions/reparse points.
5. Remove the silent WSL-only-to-Windows fallback.
6. Preserve the last accepted project snapshot while a connection is starting,
   reconnecting, degraded, or blocked by a storage-identity change.
7. Create verified, bounded SQLite backups before pending schema migrations and
   before an in-app desktop update installs new application files.
8. Provide explicit restore, retry, diagnostics, and store-adoption actions.
9. Exercise seeded packaged upgrades on the supported Windows, macOS, and Linux
   release targets.
10. Keep the normal RPC and rendering hot paths effectively unchanged.

## Non-Goals

- Migrating, merging, importing, or maintaining compatibility with legacy
  application data formats or paths.
- Automatically searching arbitrary disks, home directories, WSL distributions,
  or remote hosts for other BiBCode databases.
- Automatically merging two project catalogs or choosing which one is correct.
- Providing cloud backup or synchronizing backups between machines.
- Backing up project working-tree contents. This design protects BiBCode's
  application database, not repositories or user files referenced by it.
- Guaranteeing a pre-update backup for updates performed by an external Linux
  package manager or by manually replacing an application package. Startup and
  migration protections still apply to those paths.
- Replacing the remote connection trust model or migrating remote server roots.
- Treating a legacy application directory, process, or installation as current
  BiBCode data merely because it exists.

## Terminology and Invariants

### Logical environment identity

`environmentId` identifies a connection slot and routing destination, such as
`primary` or `wsl:<distribution>`. It is meaningful to connection supervision
and user intent, but it does not prove which persistent database is behind that
slot.

### Storage instance identity

`storageInstanceId` is a randomly generated UUID stored beside the database. It
identifies one persistent BiBCode store. It is never derived from a path,
hostname, WSL distribution name, user name, platform, or logical environment
identifier.

The following invariants apply:

1. A storage instance identifier is created once and is never silently
   rewritten.
2. A logical environment may reconnect to the same storage instance at a new
   network address or through a different filesystem alias.
3. A logical environment that reports a different non-null storage instance is
   blocked until the user explicitly adopts it or returns to the prior store.
4. A marker that proves a database previously existed prevents automatic
   creation of a replacement empty database.
5. The absence of both the database and marker is the only automatic first-run
   creation case.
6. Empty project UI is rendered only from an authoritative, successful, live
   catalog response.

### Requested and effective data roots

The requested data root is the path selected by the default, environment
override, or explicit CLI configuration. The effective data root is the
canonical filesystem location used after expansion, lexical normalization, and
alias resolution. Both are retained for local diagnostics. Only the effective
root owns the live database and backup directories.

## Package Ownership and Boundaries

### `apps/server`

The server owns:

- data-root resolution and validation;
- database/marker startup classification;
- storage-instance marker creation and reading;
- SQLite open, migration, backup, verification, retention, and restore;
- the quiescence gate for local backup and update preparation;
- environment descriptors exposed through typed RPC;
- redacted diagnostics describing the server's persistent store.

The CLI and desktop host consume the same server-owned resolver and persistence
APIs. They do not reimplement data-root rules.

### `apps/desktop`

The desktop host owns:

- converting application settings and OS launch context into server
  configuration;
- selecting Windows, macOS, Linux, and WSL backend launch plans;
- preventing implicit WSL-primary fallback;
- coordinating all running local backends before an in-app update;
- exposing privileged backup, restore, restart, path-opening, and diagnostic
  operations through `DesktopBridge` commands/events;
- displaying update progress and preserving the correct Windows updater exit
  behavior.

Privileged filesystem and process operations continue to cross the
`DesktopBridge` boundary. The renderer does not directly manipulate database or
backup files.

### `packages/contracts`

Contracts remain schema-only. They define the optional version-skew-compatible
storage identity and the typed connection/recovery states and payloads required
by HTTP/WebSocket RPC and `DesktopBridge`.

### `packages/client-runtime`

The client runtime owns:

- remembering the last accepted storage identity for each logical connection;
- comparing connection identity before publishing a new live snapshot;
- retaining cached snapshots through reconnects and blocked states;
- deriving explicit shell availability states rather than collapsing them to an
  empty catalog.

### `apps/web`

The web app owns presentation and user decisions. It renders per-environment
state, update protection progress, recovery choices, and diagnostics. It does
not invent storage identity or decide that a missing database is safe to
recreate.

## Data-Root Resolution

The server introduces one data-root resolver used by the native CLI and every
desktop backend launch plan.

The resolver accepts:

- source: `default`, `environment`, or `cli`;
- requested path, if explicitly provided;
- state kind: packaged `userdata` or development `dev`;
- platform-aware home-directory and path services.

Resolution proceeds as follows:

1. Select the default `<home>/.bibcode` root when no override exists.
2. Expand a leading `~` using the selected runtime's home directory. For WSL,
   this is the WSL user's home, not the Windows user's home.
3. Reject an empty explicit override.
4. Reject an explicit relative path after expansion. The error names the source
   and requires an absolute path. The application must not make it absolute by
   joining it to an installation or working directory.
5. Lexically normalize `.` and `..` components without allowing traversal to
   change the intended absolute root silently.
6. If the path exists, canonicalize it using the runtime platform so symlinks,
   macOS aliases visible as symlinks, and Windows junction/reparse-point paths
   resolve to their effective target.
7. If the final leaf does not yet exist, canonicalize the nearest existing
   ancestor and append the remaining normalized components.
8. Return the requested path, effective path, source, state kind, and an
   `isFilesystemAlias` diagnostic flag.

A valid absolute path through a symlink or Windows junction is not rejected.
It is reported as an alias because such paths can make an old directory relevant
to current code. The startup screen, settings diagnostics, and diagnostic bundle
show both requested and effective paths for local environments. Remote clients
receive storage identity but do not receive server filesystem paths.

The resolver revalidates the effective path immediately before restore or other
destructive recovery operations. Restore destinations are constructed from the
validated live root, never from a path embedded in backup metadata.

## Persistent Store Startup State Machine

The existing `environment-id` state file becomes the storage-instance marker.
The implementation may rename its internal API and on-disk file in a later
version only through an explicit migration; this design reuses the existing
path to avoid two sources of truth.

Startup classifies the effective state directory before opening SQLite with
`OPEN_CREATE`:

| Database | Marker | Classification | Behavior |
| --- | --- | --- | --- |
| Absent | Absent | First run | Create database, run initial migrations, then atomically create marker. |
| Present | Absent | Existing unmarked install | Open and validate the database, atomically create and persist a marker, then run protected migrations if needed. |
| Present | Present and valid | Existing store | Open, validate, back up if migration is pending, migrate, and serve using that identity. |
| Absent | Present and valid | Missing database | Do not create SQLite. Enter `recovery-required` with backups and diagnostics. |
| Present | Marker malformed | Identity corrupt | Preserve both files and enter `recovery-required`; do not replace the marker. |
| Absent | Marker malformed | Identity and database unavailable | Preserve the marker and enter `recovery-required`; do not create SQLite. |
| Present but invalid SQLite | Any | Corrupt database | Preserve the database and marker and enter `recovery-required`. |

Marker writes use a staged file in the same directory, flush, and an atomic
no-replace publish operation. Where the platform lacks a no-replace rename, the
implementation serializes publication and uses create-new semantics for the
final path. Races converge on the existing valid marker; they do not generate a
second identity. Directory creation and file permissions follow the current
database directory's private permissions.

For the existing unmarked-install case, a marker is created only after the
database has been successfully opened and validated, but before any pending
migration backup is named or the migration begins. This release cannot detect a
data-root switch that occurred before the first marker was adopted; that rollout
limitation is shown in release notes and tests.

The database-opening API separates `open_existing` and `create_first_run` so a
call site cannot accidentally recreate a known store by passing a generic
create flag.

## Environment Descriptor and Version Skew

The environment descriptor adds:

```text
storageInstanceId: UUID | null
```

New servers always provide a valid UUID after startup reaches a usable store.
The contracts decoder accepts `null` during the rollout so a new client can
connect to an older remote server. A missing identity disables store-switch
enforcement for that older remote connection only; it does not imply an empty
store and does not weaken local startup checks.

The storage identity is returned in the initial typed connection descriptor
before project snapshots can become authoritative. It is also included in local
backup manifests and redacted diagnostic output.

Filesystem paths are not added to the normal remote descriptor. Local path
details are obtained through the trusted desktop bridge for local diagnostics.

## Client Store-Identity Acceptance

The client persists the last accepted non-null `storageInstanceId` for each
logical connection target. The key includes the logical `environmentId` and the
stable connection target identity already used by the connection catalog, so
two explicitly configured remote servers that reuse an environment label do not
collide.

Connection supervision follows this sequence:

1. Establish transport and decode the environment descriptor.
2. Compare the reported storage identity with the last accepted identity.
3. If the accepted value is absent and the reported value is non-null, accept
   and persist it as the rollout/bootstrap case.
4. If both non-null values match, continue synchronization normally.
5. If both non-null values differ, enter `storage-changed` before accepting or
   publishing the new project's snapshot.
6. If the new server reports `null`, keep the prior accepted identity and mark
   identity validation unavailable. Do not erase or replace the accepted value.

In `storage-changed`, the last cached accepted snapshot remains visible and
read-only. The UI shows the prior and current storage identities in shortened
form, the logical environment, platform/label, and local requested/effective
paths when available. It offers:

- retry the prior environment;
- open environment settings;
- view diagnostics;
- explicitly use this data location.

The adoption action records the new identity only after a confirmation that
explains that catalogs will not be merged. It then restarts synchronization and
allows the new snapshot to become authoritative. Adoption never changes,
deletes, or copies either database.

Malformed connection-catalog storage remains a distinct configuration error.
It must not be rewritten to an empty catalog without surfacing recovery or a
reset decision to the user.

## WSL Behavior

WSL is a Windows-only backend with its own filesystem, home directory, data
root, database, marker, and backups.

When WSL-only mode is configured and WSL planning or startup fails, the desktop
host returns a structured `WslPrimaryUnavailable` state. It does not launch the
native Windows backend under `primary`. The UI offers:

- retry WSL;
- choose or repair the WSL distribution;
- view diagnostics;
- explicitly switch primary execution to Windows.

An explicit switch updates the setting and then performs a normal identity
comparison. If Windows exposes a different store, it is presented as a store
change and requires adoption. The same rule applies if a distribution is reset,
the WSL user changes, or its home/data-root mapping changes.

In Windows-primary plus WSL-secondary mode, a WSL failure marks the secondary
environment unavailable while retaining its cached projects. It does not block
the Windows primary from becoming live and it never converts the WSL cache to
an empty result.

## Availability and Empty-State Model

Project availability is represented per desired environment and then derived
for the global sidebar. The client runtime supports at least these states:

- `starting`: backend or transport initialization has not completed;
- `synchronizing`: identity is accepted and the authoritative snapshot is being
  loaded;
- `live`: an authoritative snapshot is available;
- `degraded`: a cached accepted snapshot is shown while reconnecting or after a
  recoverable transport/synchronization failure;
- `storage-changed`: a different store is connected but not accepted;
- `recovery-required`: the server reports missing/corrupt database or marker;
- `unavailable`: the desired environment cannot be started or reached and no
  authoritative live result exists;
- `configuration-error`: the connection catalog or data-root configuration is
  invalid.

`No projects yet` is shown only when the desired-environment catalog is loaded,
every desired environment is authoritative `live`, and the merged live project
catalog contains zero projects. If any desired environment is starting,
synchronizing, degraded, unavailable, blocked, or in recovery, the sidebar
shows the corresponding availability state and actions instead of claiming the
catalog is empty.

Cached projects remain visible through reconnects and degraded states, clearly
labelled as cached/read-only when mutations cannot be safely routed. An
authoritative live empty snapshot can replace a cached non-empty snapshot only
after storage identity has been accepted and synchronization succeeds.

## Verified Backup Design

Backups are stored outside the live `userdata` or `dev` state directory:

```text
<effective-base-root>/backups/<state-kind>/<storage-instance-id>/
```

Each backup consists of:

- a SQLite backup file;
- a small manifest containing storage instance ID, creation time, state kind,
  application version, schema version, database size, checksum, and trigger;
- no executable content and no restore destination path.

Backups inherit private database permissions. Manifests and remote diagnostics
do not expose credentials. Backup filenames use sortable timestamps plus a
collision-resistant suffix and are never constructed from untrusted labels.

### Backup creation

The server uses SQLite's online backup API from the live connection into a
staged file in the destination directory. It then:

1. completes and closes the staged backup;
2. runs `quick_check` on the staged database;
3. computes its checksum and writes a staged manifest;
4. flushes both files and their containing directory where supported;
5. atomically renames both files into their final names;
6. applies retention only after a verified final backup exists.

An incomplete staged backup is ignored and can be cleaned on the next startup.
The live database is never renamed or copied with ordinary filesystem reads
while WAL writes may be active.

The default retention is the latest three verified backups for each storage
instance and state kind. Retention is bounded and failures to delete an old
backup are warned but do not invalidate the newly verified backup.

### Backup triggers

Automatic backups run at two lifecycle seams:

1. **Before a pending schema migration.** The server inspects migration state
   without mutating it. If a migration is pending for an existing database, a
   verified backup is required before the migration transaction begins. Initial
   first-run schema creation does not require a backup.
2. **Before an in-app desktop update install.** The desktop host requests a
   verified backup from every running local backend, including a running WSL
   secondary, after entering the quiescence protocol and before handing bytes
   to the platform updater.

The primary backend's backup is mandatory. A backup failure blocks migration or
update installation and presents the error and recovery actions. A configured
secondary backend that is not running has no active writer and cannot be backed
up; the update dialog names that environment and requires an explicit
continue-without-secondary-backup confirmation. A running secondary whose
backup fails also requires that explicit confirmation. This exception never
applies to the selected primary.

External package-manager or manual updates cannot be intercepted reliably.
When the new binary starts, the marker/missing-database state machine and
pre-migration backup still protect the store.

## Quiescence and Update Coordination

Each server exposes a local privileged quiescence operation used by the desktop
host. It is single-flight and serialized with migration, backup, restore, and
shutdown.

Quiescence:

1. closes the gate for new mutating RPC and orchestration work;
2. lets already accepted mutations reach a terminal committed/failed state;
3. drains persistence queues and checkpoints WAL where supported;
4. creates and verifies the requested backup;
5. holds the mutation gate closed until the desktop host commits or cancels the
   update operation.

Read-only status and progress operations remain available. The client displays
`Protecting project data` before platform installation begins.

If download, verification, backup, or installation fails without process exit,
the desktop host releases quiescence and reconnects clients. On successful
macOS/Linux installation, the existing restart path runs after the verified
backup. On Windows, updater-controlled process exit occurs only after the same
pre-install protection succeeds.

Concurrent update requests share one in-flight preparation result. Shutdown and
restore cannot race an active update preparation. A crash before the updater
starts leaves the live database unchanged and may leave only ignorable staged
backup files.

## Recovery

Recovery is explicit and local. The recovery screen is reachable when startup
reports a missing database, invalid marker, corrupt database, or failed
migration. It shows:

- environment and platform;
- requested/effective data root for local environments;
- marker and database classification;
- last successful backup time;
- verified backups matching the storage instance when identity is available;
- diagnostic export and path-opening actions;
- retry after external repair;
- restore and explicit start-empty choices when safe.

### Restore

Restore runs through a privileged desktop command and the server persistence
library:

1. validate the selected backup manifest, checksum, SQLite `quick_check`, state
   kind, and storage identity;
2. revalidate the effective destination root;
3. stop or exclusively quiesce the affected backend;
4. move the current database, WAL, and SHM files to a timestamped preserved
   recovery directory when they exist;
5. copy the verified backup to a staged live database and atomically install it;
6. retain the existing valid storage marker or restore the matching marker
   identity when the database is missing;
7. restart the backend and require normal identity/synchronization validation.

The current files are never overwritten without being preserved. A failed
restore leaves either the original live store or the preserved recovery copy
available. The UI reports where preserved files were placed.

### Start empty

Starting empty is never automatic when a marker or damaged database exists. It
requires a destructive confirmation, moves existing database/marker/WAL/SHM
files into a timestamped preserved recovery directory, and then executes the
normal first-run path with a new storage identity. The client treats that new
identity as a store change and requires adoption.

If no backup exists, the recovery screen does not imply that data can be
restored. It offers diagnostics, file-location access, retry, and the explicit
preserve-and-start-empty operation.

## Security and Trust Boundaries

- Database backups may contain sensitive project metadata and receive the same
  access restrictions as the live database.
- Absolute local paths are available only to the local desktop window and local
  diagnostic bundle; normal remote descriptors expose no filesystem paths.
- Restore, start-empty, open-path, and updater coordination are privileged
  `DesktopBridge` operations and are not exposed as general remote RPC.
- Backup manifests are data, not authority. Restore ignores any destination path
  they contain and validates identity, checksum, and SQLite integrity.
- Effective roots are revalidated immediately before destructive operations to
  reduce symlink/junction substitution risk.
- Logs use stable error codes and storage-ID prefixes; they avoid dumping full
  manifests or connection secrets.

## Performance and Resource Behavior

Normal connection and project rendering add only one descriptor field and a
small identity comparison. No filesystem scans or database copies occur on a
hot request path.

Backups are intentionally limited to pending migrations and in-app updates.
They execute through SQLite's backup API on blocking persistence workers, emit
progress, and are single-flight per database. Bounded retention prevents
unbounded disk growth. The implementation must honor cancellation before final
installation but must not cancel in a way that exposes a partial file as a
verified backup.

Large databases may delay update installation. The update UI remains responsive
and reports backup progress; correctness takes priority over beginning the
installer quickly.

## Cross-Platform Behavior

The common server implementation owns marker, backup, restore, and descriptor
semantics on all platforms. Platform-specific code is limited to path services,
filesystem alias detection/flush behavior, updater lifecycle, and WSL launch
coordination.

### Windows

- Supported packaged target: x64 NSIS/updater.
- Default root resolves under the Windows user's home for the native backend.
- Junctions and reparse points are canonicalized and reported as aliases.
- WSL roots and backups remain inside the selected distribution unless an
  explicit absolute WSL path says otherwise.
- Updater-controlled exit happens only after required backup preparation.

### macOS

- Supported packaged targets: arm64 and x64 DMG/updater archive.
- Default root resolves under the macOS user's home.
- Symlinked roots are canonicalized and reported.
- Application-bundle replacement does not alter the external data root.

### Linux

- Supported packaged target: x64 AppImage/updater; release smoke coverage also
  exercises the documented Ubuntu/Debian support set where applicable.
- Default root resolves under the Linux user's home.
- Symlinked roots are canonicalized and reported.
- In-app AppImage updates receive full pre-update protection. External package
  replacement receives startup and pre-migration protection but cannot be
  guaranteed a pre-install hook.

## Failure Handling

| Failure | Required behavior |
| --- | --- |
| Relative explicit data root | Fail configuration with an actionable absolute-path error. |
| Filesystem alias detected | Continue with the canonical effective root and show a local warning. |
| Marker exists but database is missing | Do not create; enter recovery. |
| Database exists but is corrupt | Preserve it; enter recovery with verified backups. |
| Marker is malformed | Preserve it; enter recovery rather than rewriting identity. |
| Backup staging fails | Remove/ignore staged output; keep live database unchanged. |
| Backup integrity check fails | Do not publish manifest or begin migration/update. |
| Migration fails | Keep transactional behavior and offer the pre-migration backup. |
| WSL-only planning/start fails | Block with `WslPrimaryUnavailable`; never launch Windows implicitly. |
| Connection reports a different store | Keep accepted cache read-only; block new snapshot until adoption. |
| Connection catalog is malformed | Show configuration recovery; do not silently present an empty catalog. |
| Backend reconnects during update preparation | Quiescence ownership prevents mutation until commit/cancel. |
| Process crashes during restore | Preserve original/recovery files and reject incomplete staged live files. |

## Rollout and Compatibility

1. Existing valid databases without a marker are adopted in place and receive
   a new UUID after validation. No project data is rewritten for identity
   adoption.
2. New clients accept `storageInstanceId: null` from older remote servers, but
   do not erase a previously accepted identity.
3. The first protected client connection records the reported identity as its
   baseline. Store-switch detection becomes enforceable after that point.
4. The rollout does not inspect or migrate legacy-named directories. A legacy
   leftover matters only if the resolved effective root, a symlink/junction, or
   a configured remote endpoint points to it.
5. Backups are introduced without changing the live database path.
6. Recovery actions are additive and do not automatically run during upgrade.

## Testing Strategy

### Unit tests

- Data-root resolution for Windows, macOS, Linux, and WSL path services.
- Default, environment, and CLI sources; `~` expansion; relative rejection;
  lexical normalization; missing leaf; symlink and junction/reparse behavior
  where the CI platform supports it.
- Complete database/marker startup matrix, atomic marker races, malformed
  markers, missing database, corrupt SQLite, and genuine first run.
- Existing unmarked database adoption without catalog changes.
- Backup staging, online-copy integrity, manifest/checksum validation, retention,
  interrupted backup cleanup, and restore preservation.
- Pending-migration detection and backup-failure fail-closed behavior.
- WSL-only launch failure without a Windows fallback.
- Client identity bootstrap, match, mismatch, null version-skew case, explicit
  adoption, and cached snapshot retention.
- Sidebar derivation proving that loading, degraded, unavailable,
  configuration-error, storage-changed, and recovery states cannot render
  `No projects yet`.

### Integration tests

- Server starts with an existing database, assigns identity, restarts, and
  reports the same identity and project catalog.
- Marker-without-database startup never creates `state.sqlite`.
- Concurrent mutations drain before pre-update backup; new mutations are
  rejected or deferred until quiescence is released.
- Failed updater preparation releases quiescence and preserves service.
- Successful backup followed by migration failure leaves a restorable verified
  backup.
- Native Windows primary, WSL-only primary, and Windows-plus-WSL-secondary
  supervision follow the explicit fallback rules.
- Desktop recovery bridge validates backup and preserves current files before
  restore.

### Packaged upgrade tests

Release CI adds a seeded two-version upgrade scenario for each supported
updater target:

1. Install/launch the previous stable packaged artifact in an isolated OS user
   profile.
2. Add a uniquely named project through the public application/RPC path.
3. Record the storage identity, effective root classification, and project ID.
4. Serve the signed candidate update through the release test manifest.
5. Trigger the real in-app updater and observe `Protecting project data`.
6. Restart or reconnect according to platform updater behavior.
7. Assert the same storage identity and project are present and a verified
   pre-update backup exists.
8. Assert the application is not showing a first-run/empty state.

For the first release containing this protection, CI uses two rollout lanes.
The real previous-stable package proves that its seeded project survives the
upgrade and is adopted as a recognized BiBCode store; that executable cannot
retroactively emit a storage UUID, protection progress, or pre-update backup it
was never built to support. A second package built from the protected source
with only a lower test package version proves the new quiescence, identity, and
pre-update-backup protocol. Once a protected release becomes the real previous
stable, that lane must satisfy all eight assertions and the synthetic bootstrap
lane can be removed explicitly.

The matrix is:

- Windows x64 NSIS;
- macOS arm64 updater archive/DMG installation flow;
- macOS x64 updater archive/DMG installation flow;
- Linux x64 AppImage.

An additional Windows job covers WSL-primary unavailability and a WSL storage
identity change. Fresh-install smoke tests remain but do not substitute for the
seeded upgrade test.

## Documentation Changes During Implementation

Implementation updates these living documents in the same change:

- `docs/architecture/overview.md` for persistent-store identity and recovery
  ownership;
- `docs/architecture/connection-runtime.md` for identity acceptance and honest
  availability states;
- `docs/architecture/remote.md` for remote version skew and path privacy;
- `docs/operations/release.md` for pre-update protection and the seeded package
  matrix;
- a user-facing recovery guide covering data-root diagnostics, backup location,
  restore, explicit store adoption, WSL behavior, and external Linux updates.

## Alternatives Considered

### UI-only empty-state correction

This would prevent the most misleading symptom but would not stop a fresh
database from being created, detect a different store behind the same logical
environment, protect migrations, or provide recovery. It is necessary but not
sufficient.

### Derive storage identity from the absolute path

Paths can change through home-directory changes, mount points, drive letters,
WSL mappings, symlinks, junctions, and remote deployment without changing the
database. Conversely, a path can remain the same after the database is replaced.
A random durable marker represents the store itself and avoids both errors.

### Reject all symlinked or junction-backed roots

Aliases are valid deployment choices and are common for redirected home
directories and larger disks. Canonicalization plus visible diagnostics and
identity validation protects the store without imposing an unnecessary ban.

### Automatically scan for and merge other databases

Scanning is expensive, violates clear ownership boundaries, can expose unrelated
users' data, and cannot determine which catalog is authoritative. Merging has
unresolved conflict and security semantics. The design instead identifies the
active store and makes adoption/restore explicit.

### Keep automatic WSL fallback and compare only project counts

Project counts do not identify a store and can legitimately be zero. Silent
fallback violates user intent and hides availability failures. WSL-only mode
therefore fails visibly.

### Back up only before updater installation

External updates and first startup after an update can still execute schema
migrations. Backing up before pending migration protects that seam even when the
updater was bypassed.

## Completion Criteria

The implementation is complete when:

1. A known missing database cannot be recreated silently on any supported
   platform.
2. A different store behind the same logical environment is detected before its
   project snapshot is accepted.
3. WSL-only failures never result in an implicit native Windows primary.
4. Loading, unavailable, degraded, recovery, configuration, and identity-change
   states never render as a genuine empty catalog.
5. Verified backups are required before pending migrations and primary in-app
   update installation, with bounded retention and tested restore.
6. Windows x64, macOS arm64/x64, and Linux x64 packaged upgrade tests preserve a
   seeded project and storage identity.
7. Focused unit/integration tests, repository checks, type checking, applicable
   Rust formatting/tests/Clippy, final diff review, and living documentation all
   pass or have explicitly documented environment limitations.
