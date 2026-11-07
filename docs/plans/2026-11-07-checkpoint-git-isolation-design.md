# Checkpoints and Bootstrap: One Git Isolation Policy

Status: Proposed, awaiting Codex and advisor review. Issue #283, a follow-up of #282
([`2026-11-03-git-system-line-endings-design.md`](./2026-11-03-git-system-line-endings-design.md),
"Checkpoints are not moved" and "Other production Git spawns"). Verified at `e222d340ff`
(`main` after v0.15.2), on macOS with Git 2.56.0. Line references are to that commit. No
product code is written until this design is approved. Companion: #279
([`2026-11-07-shared-checkout-restore-guard-design.md`](./2026-11-07-shared-checkout-restore-guard-design.md))
changes the same file and assumes this environment. One implementer builds #283 first.

## Outcome

Every Git command BiBCode runs gets its environment from one place, `git_environment()`,
and so from one system-configuration policy. Checkpoint capture and restore and the
bootstrap fetch stop inheriting the whole system configuration. Checkpoints add their own
overrides on top: a temporary index, a fixed identity, no hooks and no fsmonitor.

The policy keeps what makes BiBCode's Git produce the same files as the person's Git
(line endings, Git LFS, symlinks) and what lets a fetch authenticate as the person's
fetch does (a well-known credential helper). It drops everything else in the system
file: hooks, other filters, diff and merge drivers, URL rewrites and includes.

Old checkpoints keep restoring as they do today. A checkpoint captured with LFS active
holds pointers, and the new policy restores it with the same LFS filter, so the files come
back with their real content.

## What the code does today (verified)

| Spawn                                                                                                                                                                           | Environment                                                                                 | System configuration     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| `git_environment()` (`git/repository.rs:7903-7907`), about 20 production callers                                                                                                | prompt guards (`:7911-7924`) plus `system_line_endings::system_config_variable()` (`:7905`) | keys-only file or none   |
| Checkpoint `run_git` (`production/orchestration_effects.rs:2569-2596`)                                                                                                          | `env: env.to_vec()` (`:2584`), added to the inherited one by `ProcessRunner`                | **all of it, inherited** |
| Capture (`:2262-2347`): `rev-parse`, `read-tree`, `add -A` (`:2310-2318`), `write-tree`, `commit-tree`                                                                          | `checkpoint_environment` (`:2598-2611`): `GIT_INDEX_FILE` and the BiBCode identity          | all of it                |
| Capture's `update-ref` (`:2333-2341`)                                                                                                                                           | `&[]` (`:2337`)                                                                             | all of it                |
| Restore (`:2437-2498`): `restore --source … --worktree --staged` (`:2449-2465`), `clean -fd` (`:2466-2474`), `reset` (`:2487-2495`)                                             | `&[]`                                                                                       | all of it                |
| Reads: `is_git_repository` (`:2349`), `has_ref` (`:2366`), `ref_exists` (`:2393`), `checkpoint_revision` (`:2412`), `diff --numstat --no-ext-diff --no-textconv` (`:2525-2567`) | `&[]`                                                                                       | all of it                |
| `delete_ref`, `update-ref -d` (`:2500-2523`)                                                                                                                                    | `&[]`                                                                                       | all of it                |
| Bootstrap `fetch origin` and `rev-parse` (`:422-466`)                                                                                                                           | `env: Vec::new()` (`:453`): no prompt guards either                                         | all of it                |

Every checkpoint command names bare `git` (`:2254`, `Path::new("git")` throughout), as
`git_environment()` callers do, so the #282 executable rule holds for them too.

`system_line_endings` (`git/system_line_endings.rs`) is the #282 policy as built:

- `Policy` is `NoSystem` or `KeysOnly(PathBuf)` (`:38-45`), set once per process by the two
  binaries (`install_once`, `:56-66`).
- The probe reads `^core\.(autocrlf|eol|safecrlf)$` with `--system --includes` (`:147-160`).
- Only canonical tokens are written (`canonical_value` `:284-303`, `file_contents`
  `:306-313`), to a private file under the state directory (`write_keys_file`, `:318`).
- Every failure, an old Git and a relative `PATH` entry also end as `NoSystem` (`:104-110`,
  `:133-145`). So today `NoSystem` means both "nothing to keep" and "could not tell".

On this Mac the system file holds `credential.helper=osxkeychain`. #282 recorded Git for
Windows' system file: `credential.helper=manager`, `filter.lfs.*`,
`diff.astextplain.textconv`, `core.fscache`, `core.symlinks=false`, `pull.rebase`,
`init.defaultbranch` (#282 design, "Why it was added").

## The LFS question, narrowed

Facts, each checked at its source:

- `git lfs install` writes the `lfs` filter to the **global** configuration by default
  ([git-lfs-install(1)](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-install.adoc)).
  `GIT_CONFIG_NOSYSTEM` never drops a global filter. The only hosts where isolation drops
  LFS are those with LFS in the **system** file: Git for Windows, whose installer puts it
  there, and anyone who ran `git lfs install --system`.
- The values it writes are exactly `git-lfs clean -- %f`, `git-lfs smudge -- %f`,
  `git-lfs filter-process` and `required = true`; with `--skip`, `git-lfs smudge --skip --
  %f` and `git-lfs filter-process --skip`
  ([`lfs/attribute.go`, `filterAttribute`](https://github.com/git-lfs/git-lfs/blob/main/lfs/attribute.go)).
- A smudge given content that is not a pointer writes it out unchanged
  ([`commands/command_smudge.go`](https://github.com/git-lfs/git-lfs/blob/main/commands/command_smudge.go)).
  Under `filter-process` that case is reported as success, with a stderr warning, so even
  `required = true` does not fail it
  ([`commands/command_filter_process.go`](https://github.com/git-lfs/git-lfs/blob/main/commands/command_filter_process.go)).
- A missing filter definition makes the filter a pass-through; `required = true` turns a
  failing filter into a Git error
  ([gitattributes(5), "filter"](https://github.com/git/git/blob/master/Documentation/gitattributes.adoc)).

So for a path with `filter=lfs`:

| Checkpoint blob holds | Restore with the LFS filter | Restore without it        |
| --------------------- | --------------------------- | ------------------------- |
| a pointer             | real content                | **pointer text** (broken) |
| real content          | real content (pass-through) | real content              |

Only one cell is wrong, and it is wrong only when restore lacks a filter that capture had.
The decision is therefore how restore sees the host's LFS filter, not whether to store
expanded content.

## Alternatives

| Option                                                                                                                                                            | For                                                                                                                                                                                                     | Against                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A) Status quo: checkpoints and bootstrap inherit the whole system file                                                                                           | No change; LFS works.                                                                                                                                                                                   | A system `core.hooksPath` runs a `reference-transaction` hook on every capture; system textconv, filters and includes reach checkpoints; the bootstrap fetch has no prompt guards, so Git Credential Manager can open a window from a server process. Two policies remain.          |
| (B) Checkpoints and bootstrap use today's `git_environment()` unchanged                                                                                           | One policy, one line per spawn.                                                                                                                                                                         | On Git for Windows an old pointer checkpoint restores as pointer text, and new captures store whole LFS files in the object database. The bootstrap fetch loses the system credential helper, so an HTTPS fetch of a private repository fails for most Windows and Apple Git users. |
| (C) Checkpoints write pointers themselves (`GIT_LFS_SKIP_SMUDGE`, or an LFS-aware capture)                                                                        | Independent of the host.                                                                                                                                                                                | Restore still needs the smudge to give real files. Reimplements LFS.                                                                                                                                                                                                                |
| **(D) recommended:** extend the #282 keys-only file with canonical LFS, symlink, Windows performance and credential-helper keys, and route every spawn through it | One policy for all spawns, worktrees included. Captures and restores match the person's Git and old checkpoints. Only canonical tokens are written, so no hook, include or arbitrary command can enter. | `git_environment()` callers gain LFS and a credential helper, which #282 kept out. That is a behaviour change for the Git manager (see [Effect on other callers](#effect-on-other-callers)).                                                                                        |

## Decision: option (D)

### 1. The kept keys

The probe regexp becomes
`^(core\.(autocrlf|eol|safecrlf|symlinks|fscache|longpaths)|filter\.lfs\.(clean|smudge|process|required)|credential\.helper)$`,
still with `--system --includes -z --get-regexp` from an empty directory. Each key is
canonicalized as below; anything else is dropped with the module's one warning.

| Key                                                    | Kept when                                                                                                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.autocrlf`, `core.eol`, `core.safecrlf`           | as in #282                                                                                                                                                                                                                             | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `core.symlinks`                                        | a Git boolean, written `true` or `false`                                                                                                                                                                                               | Unset means `true`; init and clone probe the file system and write `false` into the repository when needed ([git-config(1), `core.symlinks`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks)). A repository made by another Git (WSL, a copy) lacks that local value, and Git for Windows' system `false` is then what stops a restore from trying to create symlinks it cannot. Content conversion, so it belongs with line endings. |
| `core.fscache`, `core.longpaths`                       | a Git boolean                                                                                                                                                                                                                          | Git for Windows settings: speed, and paths over 260 characters. A restore of a deep path fails without `longpaths` where the person's Git succeeds. No effect elsewhere.                                                                                                                                                                                                                                                                                             |
| `filter.lfs.clean`, `.smudge`, `.process`, `.required` | **as a group**, only when every key present byte-equals a git-lfs canonical value (above, `--skip` variants included), `clean` and `smudge` are both present, and `required` is a Git boolean. Otherwise the whole group is dropped.   | Keeps old checkpoints and new captures in step with the person's Git. A half-kept group (a `process` without `required`, a non-canonical `smudge` beside a canonical `clean`) would convert one way and not the other, so it is all or nothing. The written lines are BiBCode's own constants, never text copied from the system file.                                                                                                                               |
| `credential.helper`                                    | the multi-valued list, read in order with an empty value resetting it (Git's rule), when every remaining entry is one of the bare names `manager`, `manager-core`, `osxkeychain`, `wincred`, `cache`, `store`. Otherwise none is kept. | The bootstrap fetch and LFS downloads during a worktree checkout need the person's helper. These names map to `git-credential-<name>` executables that Git itself resolves; a path, arguments or a `!` shell command never pass. The prompt guards (`GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`, empty askpass) keep every helper non-interactive.                                                                                                              |

Dropped, with the reason that matters for checkpoints:

- `core.hooksPath`: a system hook directory would run `reference-transaction` on every
  capture and ref deletion.
- `include.path` and `includeIf`: followed only to read the kept keys, never written.
- Every other `filter.*`, `diff.*.textconv`, `diff.*`/`merge.*` drivers, `url.*.insteadOf`,
  `http.*`, `core.editor`, `pull.*`, `init.*`: none changes the bytes a checkpoint stores
  or restores, and each can run a program or reach a network.
- URL-scoped `credential.<url>.*`: not flattened (Git for Windows' Azure DevOps
  `useHttpPath` among them).

### 2. One environment builder, three uses

`git_environment()` stays the single builder. Its system variable comes from the policy:

| Policy state                                                                                                                         | `git_environment()` (today's callers) | Checkpoints and bootstrap                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------- |
| `KeysOnly(file)`                                                                                                                     | `GIT_CONFIG_SYSTEM=<file>`            | `GIT_CONFIG_SYSTEM=<file>`                |
| `NoSystem`: the probe read the system file and found nothing to keep                                                                 | `GIT_CONFIG_NOSYSTEM=1`               | `GIT_CONFIG_NOSYSTEM=1`                   |
| **new** `Unread`: not installed (library and lifecycle tests), probe failed or timed out, Git older than 2.32, relative `PATH` entry | `GIT_CONFIG_NOSYSTEM=1` (today)       | **no system variable**: inherit, as today |

`Unread` splits today's `NoSystem` (`system_line_endings.rs:104-110`, `:133-145`). Each
caller falls back to its own current behaviour when the policy could not be read. For
checkpoints that matters: on a Git for Windows host whose probe timed out, falling back to
`NOSYSTEM` would restore old LFS checkpoints as pointer text, the one data-loss case above.
For an old Git, `GIT_CONFIG_SYSTEM` is ignored anyway, so inheriting is the only correct
reading of the system file there.

The prompt guards apply in every state. Checkpoint commands never prompt today in
practice; the bootstrap fetch could, and now cannot.

### 3. Checkpoint overrides

`run_git` (`orchestration_effects.rs:2569`) builds `git_environment_inheriting_unread()` (the
right column above) and then appends the call's own variables, so `GIT_INDEX_FILE` and the
identity (`:2598-2611`) still apply. It also prefixes every checkpoint command with:

- `-c core.hooksPath=/dev/null`. No hook runs for BiBCode's own `refs/bibcode/*` writes:
  not the system one (dropped by the policy anyway), not a global or repository one such
  as `.git/hooks/reference-transaction`. Only `update-ref` and `update-ref -d` run a hook
  among these commands; the override covers every command so a later one cannot miss it.
  This follows the clone policy's precedent (`git/clone_policy.rs`, documented at
  `docs/architecture/rpc-and-orchestration.md:4131-4132`). A `-c` value is command scope
  and beats the repository's own `core.hooksPath` (husky and similar set one).
- `-c core.fsmonitor=false`. Capture's `add -A` uses a temporary index that no monitor
  knows. An fsmonitor hook or daemon from global or repository configuration would be
  started for nothing.

`-c` works on every Git version, so the overrides do not depend on the policy state.
Filters from global and repository configuration (LFS installed globally, git-crypt) stay
on: they are the repository's truth, and today's checkpoints use them.

### 4. Bootstrap

`run_bootstrap_git` (`:441-466`) uses the same builder with no overrides. Its fetch keeps
repository and global hooks: it updates real remote-tracking refs, as the person's fetch
does. It gains the prompt guards, and the system credential helper only when it is one of
the kept names. `bootstrap_process_error` (`:468-478`) already passes Git's stderr through
redaction, so "Authentication failed" reaches the work log.

### 5. Module

`git/system_line_endings.rs` becomes `git/system_config.rs`, the generated file
`<state>/git/system-config-<16 hex>.gitconfig`. Every #282 rule stays: once per process,
2 s probe, 2.32 minimum, one executable, private state directory, atomic write, exact-bytes
check, group- and other-writable refusal. `file_contents` writes sections in a fixed order
(`[core]`, `[filter "lfs"]`, `[credential]`), and `credential.helper` lines in list order.

## Old checkpoints on a new server

| Captured by                                          | Blob of an LFS path                               | Restored by the new server, host has LFS (any scope) | Host has no LFS anywhere                |
| ---------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| An old server, LFS in system or global configuration | pointer                                           | real content (smudge)                                | pointer text, as the person's Git gives |
| An old server, no LFS configured                     | real content                                      | real content (pass-through)                          | real content                            |
| The new server                                       | same as an old server with the same configuration | same                                                 | same                                    |
| The new server with `Unread` policy                  | inherited: same as an old server                  | same                                                 | same                                    |

No migration, no persisted shape and no RPC change. The checkpoint refs are unchanged.

The "no LFS anywhere" cell is not new: the person's own checkout writes pointers there too,
and the working files are pointers already unless the repository moved hosts. BiBCode does
not detect it.

## Effect on other callers

- **Worktrees** created by the Git manager now smudge LFS files on Git for Windows instead
  of checking out pointer text, the case #282 named as most likely to matter. A worktree of
  a freshly fetched branch can need LFS downloads; the kept credential helper serves them.
  If a download fails, `required = true` (as Git for Windows sets it) fails the checkout,
  exactly as the person's `git worktree add` would. Today such a worktree is created with
  pointers.
- **Status and diff** run the LFS clean filter on stat-dirty LFS files, as the person's Git
  does.
- **Fetch, pull and push** through the Git manager use the system credential helper for
  the first time. Today, under `NOSYSTEM`, they have no helper unless one is set globally;
  the Git manager has no credential mechanism of its own (`rg credential` in
  `apps/server/src/git` finds only the generic failure text at
  `git/manager/operations.rs:2083`).
- **The clone policy** (`clone_policy.rs:836-870`, `environment`) keeps its own full isolation, untouched.
- **The exact-environment assertions** (`git/manager/mod.rs:101-103`, `tags.rs:362-364`)
  keep passing: library tests never install, so the state is `Unread` and
  `git_environment()` emits `NOSYSTEM=1`.

## Failure, restart, concurrency and security

- **Restart.** The policy is read once per process (#282 rule). A desktop backend restart
  does not re-read it.
- **Probe failure.** `Unread`: today's behaviour per caller (table above).
- **LFS configured but `git-lfs` missing.** With `required = true` a restore of an LFS path
  fails, and today's inherited restore fails the same way. Git for Windows ships `git-lfs`
  with the configuration, so this needs a broken install.
- **LFS object pruned.** If `git lfs prune` deleted an object that only a checkpoint
  references, restore's smudge tries to download it; with `required = true` the restore
  fails part way, leaving some paths restored. Whether prune keeps objects reachable only
  from `refs/bibcode/*` is **not verified**; prune's documented retention covers recent
  refs, unpushed commits and stashes. Today's restore has the same exposure.
- **Concurrency.** None new. Checkpoint commands still run on the effects worker one at a
  time (#279 adds admission control, not Git changes).
- **Security.** The generated file keeps #282's ownership and mode checks. It now holds
  credential-helper names, which select executables Git resolves on `PATH`; it never holds
  a path, an argument or a shell command. A hostile system file can no longer run a hook,
  a textconv or an arbitrary filter through a checkpoint. The bootstrap fetch can no
  longer open a credential window from a server process.

## Profiler, crash and trace coverage

- **Child processes.** Unchanged: checkpoint and bootstrap Git and the probe run through
  `crate::git::ProcessRunner`, which is supervised.
- **Logs.** The module's single `tracing::warn!` gains fixed reasons: "a non-canonical
  system LFS filter was ignored", "a system credential helper that is not a well-known
  name was ignored". No path, value or command output.
- **Not applicable.** RPC methods, worktree removal, binaries and re-exec modes, shutdown
  order, profiler events and findings.

## Test plan

All in the reexec integration binary (renamed `apps/server/tests/git_system_config.rs`),
which runs on Linux, macOS and Windows CI. No test needs a real `git-lfs`: a fake
`git-lfs` script, written with `tests/support/executable_fixture.rs` into a directory first
on the child `PATH`, implements `clean -- %f` (writes a pointer-shaped text with a SHA-256
and stores the content under `.git/lfs/objects`) and `smudge -- %f` (the reverse, and
pass-through for non-pointers). The fixture system file sets the canonical `clean`,
`smudge` and `required = true` and leaves out `process`, so Git runs the two one-shot
commands. Each case runs in its own process with a fixture `GIT_CONFIG_SYSTEM`, as today.

Fails before the change:

1. `an_old_pointer_checkpoint_restores_real_content_on_a_new_server`. Capture with today's
   environment (policy not installed: inherits the fixture system LFS), assert the ref's
   blob is pointer text, change the file, install the policy in a fresh process, restore:
   the file's bytes equal the original content, not the pointer.
2. `a_system_hooks_path_runs_no_hook_during_capture_restore_or_ref_deletion`. Fixture system
   `core.hooksPath` with a `reference-transaction` hook that writes a marker.
3. `a_repository_reference_transaction_hook_does_not_run_for_checkpoint_refs`.
   `.git/hooks/reference-transaction` writes a marker; capture and a reverted turn's ref
   deletion leave none. The same hook still runs for a Git manager branch update.
4. `the_bootstrap_fetch_carries_the_prompt_guards_and_the_policy`. A fake `git` first on
   `PATH` records its environment for `fetch origin`.
5. `a_system_textconv_or_other_filter_never_reaches_a_checkpoint`. Extends today's
   `hostile_system` with `diff.x.textconv` and a second filter on an attributed path.

Guards:

6. `a_new_capture_stores_an_lfs_pointer`.
7. `a_full_content_blob_restores_unchanged_with_lfs_configured`: a checkpoint captured with
   no filter, restored under the policy.
8. `a_worktree_created_under_system_lfs_checks_out_real_content`.
9. `an_unread_policy_keeps_checkpoints_on_the_inherited_system_file`: fake `git` reporting
   2.31 first on `PATH`; capture still stores a pointer.
10. `a_failed_lfs_smudge_fails_the_restore_under_required` (fake smudge exits 1): the
    revert reports a failure, as today.
11. Canonicalizer unit tests (`git/system_config.rs`):
    - the canonical LFS group, with and without `process`, and the `--skip` variants, are
      kept;
    - `smudge = git-lfs smudge %f`, `clean = /opt/bin/git-lfs clean -- %f`, a group without
      `clean`, and `required = maybe` each drop the whole group;
    - `credential.helper` lists `manager`; `""` then `osxkeychain`; `manager` then
      `!evil`; `/usr/lib/git-core/git-credential-libsecret`; `cache --timeout=60`. Kept,
      kept as `osxkeychain` alone, all dropped, dropped, dropped;
    - `core.symlinks`, `core.fscache`, `core.longpaths` booleans canonicalize like
      `autocrlf`'s boolean branch;
    - the written file holds only BiBCode's constants and the kept helper names.
12. Every existing case keeps passing. `a_system_credential_helper_hook_or_filter_never_reaches_production_git`
    still holds: its helper is a `!` command, which is not a kept name.

Native checks (Windows 11, Git for Windows with its default system LFS and Git Credential
Manager), recorded in the execution report:

- Revert a thread in a repository with an LFS-tracked file across turns that changed it;
  the file comes back with real content.
- Start a worktree thread from a private HTTPS repository's freshly fetched base branch
  with LFS files; the bootstrap fetch authenticates without a window, and the worktree has
  real content.

## Files to change

- `apps/server/src/git/system_line_endings.rs` → `apps/server/src/git/system_config.rs`:
  keys, canonicalizer, `Policy::Unread`, the inheriting variant of the variable.
- `apps/server/src/git/mod.rs:11`, `apps/server/src/lib.rs:187`,
  `apps/server/src/lifecycle.rs:238`, `apps/desktop/src-tauri/src/backend.rs:2147`: the
  rename.
- `apps/server/src/git/repository.rs:7903-7930`: `git_environment_inheriting_unread()` beside
  `git_environment()`.
- `apps/server/src/production/orchestration_effects.rs`: `run_git` (`:2569-2596`) and
  `run_bootstrap_git` (`:441-466`); the `-c` overrides.
- `apps/server/tests/git_system_line_endings.rs` → `apps/server/tests/git_system_config.rs`.
- Living docs: `docs/architecture/rpc-and-orchestration.md` ("Git environment" paragraph
  and the checkpoint section), `docs/testing/windows-desktop.md` (system LFS and
  credentials now reach BiBCode's Git), `docs/user/workspace-ui.md` (one sentence: LFS files
  restore and check out as in the person's Git).

## Risks

- **Git manager behaviour change** (credential helper, LFS in status and worktrees). It is
  the person's Git behaviour, but it reverses #282's statement that no credential helper
  or filter reaches `git_environment()` callers. The maintainer must confirm (question 1).
- **`/dev/null` as the hook directory on Windows.** Git for Windows maps `/dev/null`;
  test 3 runs on Windows CI and proves it.
- **Network back ends.** Git for Windows' system `http.sslBackend` and `http.sslCAInfo` are
  dropped, as they already are for the Git manager. Their effect on an HTTPS fetch is not
  verified; the native bootstrap check covers it. If it fails, `http.sslBackend` (canonical
  `schannel` or `openssl`) joins the kept keys.
- **Prune** (above): not verified.

## Questions only the maintainer can answer

1. Should `git_environment()` callers (the Git manager, worktrees, status) also get the
   system LFS filter and well-known credential helper, as this design does, or should
   those stay checkpoint- and bootstrap-only? The split would mean two policies again, and
   Git manager worktrees on Git for Windows would keep checking out pointer text.
2. Is losing the Git Credential Manager window during the bootstrap fetch acceptable? A
   person with no stored credential then sees an authentication failure and signs in
   outside BiBCode once.
