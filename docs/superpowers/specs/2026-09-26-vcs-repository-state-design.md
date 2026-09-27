# VCS repository state: a plain folder versus a repository Git can't read

Status: Approved (yolo, lane manager) 2026-09-26, after a Codex read-only second opinion.

## Problem

`GitRepository::observe_status` (`apps/server/src/git/repository.rs`) runs
`git status --porcelain=2`. When that fails it asks `git rev-parse --is-inside-work-tree`
(`is_repository`), and whenever that does not print `true` it returns
`VcsStatusLocalResult::non_repository()`, so the status stream says `isRepo: false`.

Git itself cannot tell the cases apart. Its repository discovery validates `HEAD`, so a
plain folder and a repository with a damaged `.git/HEAD` print the same error (Git 2.55):

| Folder | `git rev-parse --is-inside-work-tree` |
|---|---|
| plain folder | exit 128, `fatal: not a git repository (or any parent up to mount point /)` |
| `.git/HEAD` = `not a ref`, or empty | exit 128, the same message |
| a subfolder of that repository | exit 128, the same message |
| malformed `.git/config` | exit 128, `fatal: bad config line 1 in file .git/config` |
| linked worktree whose admin dir is gone | exit 128, `fatal: not a git repository: (null)` |
| repository owned by another user | exit 128, `fatal: detected dubious ownership in repository at '<path>'` |
| bare repository, or a folder inside a `.git` dir | exit 0, prints `false` |

The web therefore hedges its Changes copy ("Git can't read this folder as a repository. Run
git init to create one, or check its .git folder if it already is one."), which gives wrong
advice in every case: `git init` inside a damaged repository, a `.git` folder to check that
does not exist, or neither for an ownership refusal.

`docs/architecture/overview.md` (the paragraph on status observations) also claims that
malformed metadata remains an error; in fact it becomes `isRepo: false`.

## Goals

- When `isRepo` is false, the status stream says why, whenever the server can tell: no
  repository, a repository Git can't read, or a repository Git refuses to trust.
- Wire-compatible both ways: servers before this change omit the field and clients keep
  today's hedged copy for them; clients before this change ignore the field.
- No cost on the healthy path.

## Non-goals

- Repairing repositories or adding repository lifecycle to the Git Manager (it performs none).
- The passive summary stream (`subscribeVcsStatusSummary`, the sidebar) and `vcs.listRefs`,
  which keep their own `isRepo`. A follow-up can reuse the classifier there.
- Faster detection of a repair when the manager opened on an already-unreadable repository:
  the watcher cannot attach to it, so the status safety read (60 to 300 s, depending on read
  duration) or Retry notices the repair.

## Alternatives

Classification:

- **A. Parse Git's error text only.** Rejected: a plain folder and a damaged `HEAD` print the
  same message. Git's text is used only for the ownership refusal, which names itself (the
  server forces `LC_ALL=C`).
- **B. Look for a `.git` entry when Git refuses the folder (chosen).** Walk from the folder
  towards the filesystem root. A `.git` gitfile (as linked worktrees and submodules use),
  or a `.git` directory containing at least one repository marker (`HEAD`, `config`,
  `objects` or `refs`), means the folder belongs to a repository Git can't read. Follow
  `.git` symlinks; a dangling symlink also counts as unreadable. An empty or marker-less
  `.git` directory is ignored and discovery continues with the parent, as Git does;
  no qualifying entry means there is no repository. This is evidence, not proof: a damaged
  bare repository reads as absent.
- **C. More Git probes** (`--git-dir`, forced `GIT_DIR`, `-c safe.directory=*`). Rejected: more
  processes and still ambiguous.

Wire shape:

- **1. Optional enum `repositoryUnavailableReason` on the local status, present only when
  `isRepo` is false and the server could tell (chosen).** The name follows the contracts
  package's `unavailableReason` for a qualifier that exists only in the unavailable case.
- **2. `repositoryState`, like `directoryState`.** Those are always-present states; this one is
  a false-only qualifier.
- **3. Optional boolean `repositoryUnreadable`.** Cannot say "absent" versus "untrusted".
- **4. Replace `isRepo` with a tri-state.** Breaks every older client and server. Rejected.

Clients reject unknown literals, so a reason added later would break clients built from this
version. This change therefore ships every reason the server can recognise today, including
the ownership refusal; a future reason needs the same care as any new literal.

## Design

### Server (`apps/server/src/git/**`)

- `model.rs`: `pub enum VcsRepositoryUnavailableReason { Absent, Unreadable, Untrusted }`,
  serialized as `"absent"`, `"unreadable"` and `"untrusted"`. `VcsStatusLocalResult` gains
  `#[serde(default, skip_serializing_if = "Option::is_none")] pub
  repository_unavailable_reason: Option<VcsRepositoryUnavailableReason>`.
  `non_repository()` keeps its signature and leaves the field `None`; a second constructor
  takes the reason.
- `repository.rs`: the repository probe keeps its three outcomes instead of a bool: a work
  tree; readable but not a work tree (exit 0 printing `false`); refused (non-zero exit, with
  its stderr). `is_repository` keeps its signature on top of it. On `observe_status`'s failure
  path, a classifier decides the reason:
  - readable but not a work tree (a bare repository, or inside a `.git` directory): `None`;
  - refused with stderr naming "dubious ownership": `Untrusted`;
  - refused otherwise: if the server's environment sets `GIT_DIR` or
    `GIT_CEILING_DIRECTORIES` (the server inherits them and Git honours them), `None`;
    otherwise canonicalize the folder (failure: `None`) and walk from it to the root:
    - a regular `.git` file found by `symlink_metadata` (a gitfile): `Unreadable`;
    - follow a `.git` symlink with `metadata`; a dangling symlink is `Unreadable`;
    - a `.git` directory is `Unreadable` only if metadata finds at least one repository
      marker: `HEAD`, `config`, `objects` or `refs`. `NotFound` or `NotADirectory` means
      no marker; an empty or marker-less directory is ignored, as Git does;
    - a missing `.git` entry (`NotFound` or `NotADirectory`), or an ignored directory:
      go on with the parent;
    - any other error, such as permission denied: `None`;
    - on Unix, before inspecting a parent on another filesystem than the folder, stop as
      `Absent`, since Git's discovery stops at a filesystem boundary unless
      `GIT_DISCOVERY_ACROSS_FILESYSTEM` is true (honour it when set to a Git true value);
    - Windows walks to the drive or share root (no device check);
    - reaching the root: `Absent`.
  - The classifier runs under the read's cancellation and a short timeout (2 s) and gives
    `None` when it expires, so a stalled network filesystem cannot hold the status read.
  - `git status` failing while the probe says work tree stays an error, as today.
- Cost: a few metadata calls on the failure path only.
- The broadcaster compares whole local results (derived equality), so a change of reason
  republishes and an unchanged result stays deduplicated.

### Contract (`packages/contracts/src/git.ts`)

- `VcsRepositoryUnavailableReason = Schema.Literals(["absent", "unreadable", "untrusted"])`,
  documented.
- `VcsStatusLocalShape` gains `repositoryUnavailableReason:
  Schema.optional(VcsRepositoryUnavailableReason)`, documented as present only when `isRepo`
  is false and the server could tell, absent from servers before this change. It reaches
  `VcsStatusLocalResult`, `VcsStatusResult` and the `snapshot`/`localUpdated` events.
  Regenerate the RPC fixtures with `vp run check:contracts`.

### Shared (`packages/shared/src/git.ts`)

`toLocalStatusPart` lists the local fields one by one, so a `remoteUpdated` event would drop
the new field. It carries the field when defined, and so does any other helper that rebuilds a
status part field by field; the field survives every event kind.

### Web (`apps/web/src/components/gitManager/**`)

The unreadable-repository presentation (Changes, History, Tags and the toolbar reason)
chooses its copy:

- `"absent"`: "This folder isn't a Git repository. Run `git init` to create one."
- `"unreadable"`: "Git can't read this repository. Check its .git folder, for example a
  damaged HEAD or config file."
- `"untrusted"`: "Git doesn't trust this repository because another user owns it. Run
  `git config --global --add safe.directory <folder>` to trust it.", with the checkout path as
  `<folder>`.
- no field (older server, or the server could not tell): today's hedged copy.

Commands render as inline code. Retry stays in every case, since it also picks up a fresh
`git init` or a trust change. The tab rule does not change: any `isRepo: false` status is
unreadable for the tab transition.

## Tests

- Server unit tests in `repository.rs` with real Git in temporary folders: plain folder →
  absent; damaged `HEAD`, empty `HEAD`, malformed config, a subfolder of a damaged repository
  and a linked worktree whose admin dir is gone → unreadable; a healthy repository →
  `isRepo: true` without the field; a bare repository → no field; `GIT_DIR` or
  `GIT_CEILING_DIRECTORIES` set → no field; the dubious-ownership text → untrusted (a unit test
  of the stderr rule, since changing file ownership needs another user); serialization omits
  `None` and writes the three strings.
- Broadcaster tests (`broadcaster.rs`): a reason change republishes; an unchanged unreadable
  result is not republished.
- Contracts: decode with and without the field; reject an unknown value.
- Shared: the field survives `snapshot`, `localUpdated` and `remoteUpdated`.
- Web: each copy, and the older-server fallback.

## Docs

- `docs/user/workspace-ui.md`, Git Manager section: the messages and the fallback.
- `docs/architecture/rpc-and-orchestration.md`: in the `subscribeVcsStatus` sentence, the
  local part carries the optional `repositoryUnavailableReason` when `isRepo` is false.
- `docs/architecture/overview.md`: correct the malformed-metadata claim in the status
  observation paragraph.
