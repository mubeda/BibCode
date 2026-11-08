# Checkpoints and Bootstrap: One Git Isolation Policy

Status: Approved 2026-11-07 (the maintainer pre-approval; reviewed by Codex and advisor).
Implemented 2026-11-07 in `apps/server/src/git/system_config.rs`, `git_environment_inheriting_unread()`
and the checkpoint and bootstrap spawns of `orchestration_effects.rs`, with the test plan in
`apps/server/tests/git_system_config.rs`; the Windows-only parts and the CI steps are not yet run.
Issue #283, a follow-up of #282
([`2026-11-03-git-system-line-endings-design.md`](./2026-11-03-git-system-line-endings-design.md),
"Checkpoints are not moved" and "Other production Git spawns"). Verified at `e222d340ff`
(`main` after v0.15.2), on macOS with Git 2.56.0. Line references are to that commit. No
product code is written until this design is approved. Companion: #279
([`2026-11-07-shared-checkout-restore-guard-design.md`](./2026-11-07-shared-checkout-restore-guard-design.md))
changes the same file and assumes this environment. One implementer builds #283 first.

**Revision 1 (2026-11-07)** records the maintainer's decisions and answers the first Codex review.
See [Review findings and resolutions](#review-findings-and-resolutions).

- The maintainer, decision A: the curated system set applies to every BiBCode Git call, not only
  checkpoints and bootstrap. This partly reverses #282, whose design now carries an
  amendment note.
- The maintainer, decision B: the background bootstrap fetch never opens a credential window. It
  fails with an authentication error instead.
- A system LFS group BiBCode does not recognize no longer drops silently. The whole
  policy is then `Unread`, so every caller keeps today's behaviour, and the legacy
  git-lfs strings are recognized.
- `http.sslBackend` and `http.sslCAInfo` are kept.
- The hook override uses the clone policy's null device (`NUL` on Windows).
- Under `Unread`, the bootstrap fetch runs with `GIT_CONFIG_NOSYSTEM=1`, not the
  inherited system file.
- The implementation scope includes running the integration tests on Windows and macOS
  CI.

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
| **(D) recommended:** extend the #282 keys-only file with canonical LFS, symlink, Windows performance and credential-helper keys, and route every spawn through it | One policy for all spawns, worktrees included. Captures and restores match the person's Git and old checkpoints. Only canonical tokens are written, so no hook, include or arbitrary command can enter. | `git_environment()` callers gain LFS, TLS keys and a credential helper, which #282 kept out. That is a behaviour change for the Git manager (see [Effect on other callers](#effect-on-other-callers)); the maintainer accepted it (decision A).                                              |

## Decision: option (D)

### 1. The kept keys

The probe regexp becomes
`^(core\.(autocrlf|eol|safecrlf|symlinks|fscache|longpaths)|filter\.lfs\.(clean|smudge|process|required)|credential\.helper|http\.(sslbackend|sslcainfo))$`,
still with `--system --includes -z --get-regexp` from an empty directory. Each key is
canonicalized as below; anything else is dropped with the module's one warning.

| Key                                                    | Kept when                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.autocrlf`, `core.eol`, `core.safecrlf`           | as in #282                                                                                                                                                                                                                                                                                                                                                                           | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `core.symlinks`                                        | a Git boolean, written `true` or `false`                                                                                                                                                                                                                                                                                                                                             | Unset means `true`; init and clone probe the file system and write `false` into the repository when needed ([git-config(1), `core.symlinks`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks)). A repository made by another Git (WSL, a copy) lacks that local value, and Git for Windows' system `false` is then what stops a restore from trying to create symlinks it cannot. Content conversion, so it belongs with line endings.                                    |
| `core.fscache`, `core.longpaths`                       | a Git boolean                                                                                                                                                                                                                                                                                                                                                                        | Git for Windows settings: speed, and paths over 260 characters. A restore of a deep path fails without `longpaths` where the person's Git succeeds. No effect elsewhere.                                                                                                                                                                                                                                                                                                                                |
| `filter.lfs.clean`, `.smudge`, `.process`, `.required` | **as a group**, only when every key present byte-equals a recognized git-lfs value, `clean` and `smudge` are both present, and `required` is a Git boolean. Recognized: today's values and the `--skip` variants (above), and the legacy `git-lfs clean %f` and `git-lfs smudge %f`. **Any other `filter.lfs.*` value makes the whole policy `Unread`** (section 2), with a warning. | Keeps old checkpoints and new captures in step with the person's Git. A half-kept group would convert one way and not the other, so it is all or nothing. The written lines are BiBCode's own constants, never text copied from the system file. A working configuration BiBCode does not recognize (an absolute `C:/…/git-lfs.exe` path, an option) must not be dropped silently, or old pointer checkpoints would restore as pointer text. `Unread` keeps today's behaviour for every caller instead. |
| `http.sslBackend`                                      | one of `openssl`, `schannel`, `gnutls`, `secure-transport`, case-insensitive                                                                                                                                                                                                                                                                                                         | The Git for Windows installer manages this key in the system file (it reads `http.sslbackend` back to preselect its wizard, [`installer/install.iss`](https://github.com/git-for-windows/build-extra/blob/main/installer/install.iss)). Dropping it changes which certificate store an HTTPS fetch trusts.                                                                                                                                                                                              |
| `http.sslCAInfo`                                       | an absolute path, without control characters or quotes, naming an existing regular file at probe time. Written as a quoted Git string.                                                                                                                                                                                                                                               | Git for Windows points it at its bundled CA file, and a company may point it at its own trust bundle. A CA file is data, not a program. Not verified on this machine: that the installer writes it (Codex's report).                                                                                                                                                                                                                                                                                    |
| `credential.helper`                                    | the multi-valued list, read in order with an empty value resetting it (Git's rule), when every remaining entry is one of the bare names `manager`, `manager-core`, `osxkeychain`, `wincred`, `cache`, `store`. Otherwise none is kept.                                                                                                                                               | The bootstrap fetch and LFS downloads during a worktree checkout need the person's helper. These names map to `git-credential-<name>` executables that Git itself resolves; a path, arguments or a `!` shell command never pass. The prompt guards (`GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`, empty askpass) keep every helper non-interactive.                                                                                                                                                 |

Dropped, with the reason that matters for checkpoints:

- `core.hooksPath`: a system hook directory would run `reference-transaction` on every
  capture and ref deletion.
- `include.path` and `includeIf`: followed only to read the kept keys, never written.
- Every other `filter.*`, `diff.*.textconv`, `diff.*`/`merge.*` drivers, `url.*.insteadOf`,
  the other `http.*` keys (proxies, extra headers, cookie files), `core.editor`, `pull.*`,
  `init.*`. None changes the bytes a checkpoint stores or restores, and each can run a
  program or send something to a network.
- URL-scoped `credential.<url>.*`: not flattened (Git for Windows' Azure DevOps
  `useHttpPath` among them).

### 2. One environment builder, three uses

`git_environment()` stays the single builder. Its system variable comes from the policy:

| Policy state                                                                                                                                                        | `git_environment()` (today's callers) and bootstrap | Checkpoints                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `KeysOnly(file)`                                                                                                                                                    | `GIT_CONFIG_SYSTEM=<file>`                          | `GIT_CONFIG_SYSTEM=<file>`                                   |
| `NoSystem`: the probe read the system file and found nothing to keep                                                                                                | `GIT_CONFIG_NOSYSTEM=1`                             | `GIT_CONFIG_NOSYSTEM=1`                                      |
| **new** `Unread`: not installed (library and lifecycle tests), probe failed or timed out, Git older than 2.32, relative `PATH` entry, unrecognized system LFS group | `GIT_CONFIG_NOSYSTEM=1` (today, for these callers)  | **no system variable**: inherit, as today, but with no hooks |

`Unread` splits today's `NoSystem` (`system_line_endings.rs:104-110`, `:133-145`). Each
state picks the behaviour whose failure can be recovered from:

- **Checkpoints inherit.** On a Git for Windows host whose probe timed out, `NOSYSTEM`
  would restore old LFS checkpoints as pointer text, the one data-loss case above. For an
  old Git, `GIT_CONFIG_SYSTEM` is ignored anyway, so inheriting is the only correct
  reading of the system file there. The checkpoint overrides (section 3) still turn every
  hook off, so a system `core.hooksPath` does not run even then.
- **Bootstrap and `git_environment()` callers drop the system file.** Their failure mode
  is recoverable: at worst a fetch fails with an authentication or TLS error and can be
  retried, or a worktree checks out LFS pointers as it does today. Inheriting would bring
  back the system hooks for a fetch, which updates refs and so runs `reference-transaction`.

The prompt guards apply in every state.

### Authentication and prompts (the maintainer, decision B)

Today every `git_environment()` call sets `GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS=` and `SSH_ASKPASS_REQUIRE=never` (`git/repository.rs:7911-7924`). The Git
manager has no credential mechanism of its own: it authenticates with a helper from global
configuration, or fails with "Authentication failed. Check the configured credentials and
try again." (`git/manager/operations.rs:2081-2084`). So no BiBCode Git call prompts
today, except the bootstrap fetch (`env: Vec::new()`, `orchestration_effects.rs:453`).

After this change:

- **The bootstrap fetch** gets the same guards. Git Credential Manager treats `never` as
  "fail when interaction is needed" instead of showing a window
  ([GCM environment variables, `GCM_INTERACTIVE`](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/environment.md)),
  and `GIT_TERMINAL_PROMPT=0` stops Git's own terminal prompt. The fetch then uses a stored
  credential through the kept helper, or fails, and `bootstrap_process_error`
  (`:468-478`) puts Git's redacted stderr in the work log.
- **User-initiated Git manager actions** (fetch, pull, push) keep today's guards: they use
  the kept helper's stored credentials for the first time, and never prompt. The maintainer allowed
  them to prompt. Letting them prompt is a separate change and not in this design: it
  would need `GCM_INTERACTIVE=auto` on those calls only, and only where the server runs on
  the person's own desktop, because a remote or WSL server has no window to show
  (question 1).

### 3. Checkpoint overrides

`run_git` (`orchestration_effects.rs:2569`) builds `git_environment_inheriting_unread()` (the
right column above) and then appends the call's own variables, so `GIT_INDEX_FILE` and the
identity (`:2598-2611`) still apply. It also prefixes every checkpoint command with:

- `-c core.hooksPath=<null device>`, the clone policy's `NULL_DEVICE` (`NUL` on Windows,
  `/dev/null` elsewhere, `git/clone_policy.rs:136-137`, used at `:616`), made `pub(crate)`
  and shared. On native Windows `/dev/null` is an ordinary path on the current drive, so a
  planted `\dev\null\reference-transaction` would run. No hook runs for BiBCode's own `refs/bibcode/*` writes:
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

`run_bootstrap_git` (`:441-466`) uses `git_environment()` itself, the left column of
section 2, with no overrides. Its fetch keeps repository and global hooks: it updates real
remote-tracking refs, as the person's fetch does. It gains the prompt guards, and the
system credential helper only when it is one of the kept names.

### 5. Module

`git/system_line_endings.rs` becomes `git/system_config.rs`, the generated file
`<state>/git/system-config-<16 hex>.gitconfig`. Every #282 rule stays: once per process,
2 s probe, 2.32 minimum, one executable, private state directory, atomic write, exact-bytes
check, group- and other-writable refusal. `file_contents` writes sections in a fixed order
(`[core]`, `[filter "lfs"]`, `[credential]`, `[http]`), and `credential.helper` lines in
list order.

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
- **Probe failure.** `Unread` (section 2): checkpoints inherit without hooks; everything
  else drops the system file.
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
- **Security.** The generated file keeps #282's ownership and mode checks. It holds
  BiBCode's own constants, credential-helper names (which select executables Git resolves
  on `PATH`), an SSL back-end name, and at most one CA file path. It never holds an
  argument or a shell command. A hostile system file can no longer run a hook, a textconv
  or an arbitrary filter through any BiBCode Git call. The bootstrap fetch can no longer
  open a credential window from a server process. A system `http.sslCAInfo` can change
  which servers an HTTPS fetch trusts. Only an administrator can write the system file,
  and the person's own Git trusts the same file, so keeping it grants nothing new.

## Profiler, crash and trace coverage

- **Child processes.** Unchanged: checkpoint and bootstrap Git and the probe run through
  `crate::git::ProcessRunner`, which is supervised.
- **Logs.** The module's single `tracing::warn!` gains fixed reasons, with no path, value
  or command output:
  - "an unrecognized system LFS filter kept the system configuration unread";
  - "a system credential helper that is not a well-known name was ignored";
  - "an unusable system http.sslCAInfo was ignored".
- **Not applicable.** RPC methods, worktree removal, binaries and re-exec modes, shutdown
  order, profiler events and findings.

## Test plan

All in the reexec integration binary (renamed `apps/server/tests/git_system_config.rs`).
No test needs a real `git-lfs`. A fake `git-lfs` script, written with
`tests/support/executable_fixture.rs` into a directory first on the child `PATH`,
implements `clean -- %f` and `smudge -- %f`. Its clean writes a pointer-shaped text with a
SHA-256 and stores the content under `.git/lfs/objects`; its smudge does the reverse and
passes non-pointers through. The fixture system file sets the canonical `clean`, `smudge`
and `required = true` and leaves out `process`, so Git runs the two one-shot commands.
Each case runs in its own process with a fixture `GIT_CONFIG_SYSTEM`, as today.

Fails before the change:

1. `an_old_pointer_checkpoint_restores_real_content_on_a_new_server`. Capture with today's
   environment (policy not installed: inherits the fixture system LFS), assert the ref's
   blob is pointer text, change the file, install the policy in a fresh process, restore.
   The file's bytes equal the original content, not the pointer.
2. `a_system_hooks_path_runs_no_hook_during_capture_restore_or_ref_deletion`. Fixture system
   `core.hooksPath` with a `reference-transaction` hook that writes a marker.
3. `a_repository_reference_transaction_hook_does_not_run_for_checkpoint_refs`.
   `.git/hooks/reference-transaction` writes a marker; capture and a reverted turn's ref
   deletion leave none. The same hook still runs for a Git manager branch update. On
   Windows the test also plants `\dev\null\reference-transaction` on the checkout's drive
   and asserts it does not run. Writing to the drive root needs rights a CI runner usually
   has; when the root is not writable, that part skips and prints why.
4. `the_bootstrap_fetch_carries_the_prompt_guards_and_the_policy`. A fake `git` first on
   `PATH` records its environment for `fetch origin`: `GCM_INTERACTIVE=never`,
   `GIT_TERMINAL_PROMPT=0` and the generated `GIT_CONFIG_SYSTEM`.
5. `a_system_textconv_or_other_filter_never_reaches_a_checkpoint`. Extends today's
   `hostile_system` with `diff.x.textconv` and a second filter on an attributed path.
6. `an_unrecognized_system_lfs_group_keeps_old_checkpoints_restoring`. The system file
   names the fake by absolute path (`clean = <dir>/git-lfs clean -- %f`). The policy is
   `Unread`. An old pointer checkpoint restores real content, and a new capture stores a
   pointer, both through the inherited system file. The checkpoint's system hook does not
   run.
7. `a_failed_probe_runs_no_system_hook_during_the_bootstrap_fetch`. Fake `git` reporting
   2.31 delegates to the real Git; the fixture system file sets `core.hooksPath` with a
   `reference-transaction` hook. A bootstrap fetch from a local bare remote updates
   `refs/remotes/origin/*` and leaves no marker.

Guards:

8. `a_new_capture_stores_an_lfs_pointer`.
9. `a_full_content_blob_restores_unchanged_with_lfs_configured`: a checkpoint captured with
   no filter, restored under the policy. The fake runs no `filter-process`, so this test
   proves the configuration reaches restore. It does not prove git-lfs's own pass-through,
   which rests on the source citations above and on the native Windows check.
10. `a_worktree_created_under_system_lfs_checks_out_real_content`.
11. `an_unread_policy_keeps_checkpoints_on_the_inherited_system_file`: fake `git` reporting
    2.31 first on `PATH`; capture still stores a pointer.
12. `a_failed_lfs_smudge_fails_the_restore_under_required` (fake smudge exits 1): the
    revert reports a failure, as today.
13. `the_system_tls_keys_reach_production_git`: fixture system file with
    `http.sslBackend = openssl` and `http.sslCAInfo = <fixture CA file>`.
    `git config --show-scope --get http.sslcainfo` under `git_environment()` gives the
    `system` scope and the path. With `sslBackend = schannel` the same holds for the
    back end. A relative path, a missing file and a value with a newline are each dropped.
    A fetch over HTTPS against `tests/support/tls_fixture.rs` is not attempted: the fixture
    serves no Git smart-HTTP protocol, and the native check below covers a real fetch.
14. Canonicalizer unit tests (`git/system_config.rs`):
    - the recognized LFS groups are kept: today's values with and without `process`, the
      `--skip` variants, and the legacy `git-lfs clean %f` and `git-lfs smudge %f`;
    - `clean = /opt/bin/git-lfs clean -- %f`, a group without `clean`, and
      `required = maybe` each make the policy `Unread`;
    - `credential.helper` lists, with the kept result: `manager` keeps `manager`;
      `""` then `osxkeychain` keeps `osxkeychain` alone; `manager` then `!evil` keeps
      none; `/usr/lib/git-core/git-credential-libsecret` keeps none;
      `cache --timeout=60` keeps none;
    - `core.symlinks`, `core.fscache` and `core.longpaths` booleans canonicalize like
      `autocrlf`'s boolean branch, and `http.sslBackend` takes only its four names;
    - the written file holds only BiBCode's constants, the kept helper names and the
      quoted CA path.
15. The #282 cases that change are listed in [Effect on the #282 tests](#effect-on-the-282-tests).

Native checks (Windows 11, Git for Windows with its default system LFS and Git Credential
Manager), recorded in the execution report:

- Revert a thread in a repository with an LFS-tracked file across turns that changed it;
  the file comes back with real content.
- Start a worktree thread from a private HTTPS repository's freshly fetched base branch
  with LFS files, once with the `schannel` back end and once with `openssl`. The bootstrap
  fetch authenticates with a stored credential without a window, and the worktree has real
  content. With the credential removed from Git Credential Manager, the fetch fails with an
  authentication error in the work log and no window opens.

### CI scope

Windows CI only compiles the server's test targets
(`.github/workflows/ci.yml:334-336`, `cargo check -p bibcode-server --all-targets`), so
without a change the Windows-specific cases above never run. The coordinator owns
`ci.yml`; the requested change is:

```yaml
- name: Run Git system configuration tests (Windows)
  if: matrix.platform == 'win'
  run: node scripts/run-msvc.mjs cargo test -p bibcode-server --test git_system_config -j 2
```

placed after "Check Windows server test targets compile" in the job at `ci.yml:221`, and a
step with `run: cargo test -p bibcode-server --test git_system_config -j 2` in the macOS job
at `ci.yml:361`, after its build step. Linux already runs the server's integration tests.

## Effect on the #282 tests

`Unread` replaces `NoSystem` as the result of every failure, so these assertions change
from `Policy::NoSystem` to `Policy::Unread` (`apps/server/tests/git_system_line_endings.rs`
at `e222d340ff`):

- `a_planted_or_foreign_generated_file_is_refused` (`:367`, `:397`, `:412`);
- `an_older_git_first_on_path_keeps_nosystem` (`:517`), renamed `…_keeps_the_policy_unread`;
- `a_relative_path_entry_keeps_nosystem_on_unix` (`:524`), renamed likewise;
- `a_relative_state_dir_keeps_nosystem` (`:548`), renamed likewise;
- `a_group_or_other_writable_state_is_refused` (`:590`, `:598`);
- `a_stalled_probe_falls_back_within_the_deadline` (`:611`).

These keep `NoSystem`, because the probe read the system file:
`no_line_ending_keys_keeps_nosystem` (`:467-478`), renamed `no_kept_keys_keeps_nosystem`.
`install_keys_only` (`:178-181`) still panics on anything but `KeysOnly`.

Unit tests in `git/system_line_endings.rs`:

- `only_a_keys_only_policy_replaces_nosystem` (`:457-470`) gains the `Unread` row: it
  gives `GIT_CONFIG_NOSYSTEM=1` for `git_environment()` and no variable for checkpoints;
- `the_generated_file_holds_only_canonical_core_keys` (`:449-455`) is extended to the new
  sections.

`a_system_credential_helper_hook_or_filter_never_reaches_production_git` (`:313-329`) keeps
passing unchanged: its helper is a `!` command and its filter is not `lfs`.

## Files to change

- `apps/server/src/git/system_line_endings.rs`, renamed `apps/server/src/git/system_config.rs`:
  keys, canonicalizer, `Policy::Unread`, the inheriting variant of the variable.
- `apps/server/src/git/mod.rs:11`, `apps/server/src/lib.rs:187`,
  `apps/server/src/lifecycle.rs:238`, `apps/desktop/src-tauri/src/backend.rs:2147`: the
  rename.
- `apps/server/src/git/repository.rs:7903-7930`: `git_environment_inheriting_unread()` beside
  `git_environment()`.
- `apps/server/src/git/clone_policy.rs:137`: `NULL_DEVICE` becomes `pub(crate)`.
- `apps/server/src/production/orchestration_effects.rs`: `run_git` (`:2569-2596`) and
  `run_bootstrap_git` (`:441-466`); the `-c` overrides.
- `apps/server/tests/git_system_line_endings.rs`, renamed `apps/server/tests/git_system_config.rs`.
- `.github/workflows/ci.yml` (coordinator): the two steps above.
- Living docs: `docs/architecture/rpc-and-orchestration.md` ("Git environment" paragraph
  and the checkpoint section), `docs/testing/windows-desktop.md` (system LFS, credentials
  and TLS keys now reach BiBCode's Git; `docs/testing/macos-desktop.md` has no Git
  configuration section, checked), `docs/user/workspace-ui.md` (LFS files restore and check
  out as in the person's Git; BiBCode never opens a credential window).
- [`2026-11-03-git-system-line-endings-design.md`](./2026-11-03-git-system-line-endings-design.md):
  the amendment note (done in this revision).

## Risks

- **Git manager behaviour change** (credential helper, TLS keys, LFS in status and
  worktrees). The maintainer accepted it (decision A).
- **Prune** (above): not verified.
- **A recognized LFS group whose `git-lfs` is missing**: restore fails as it does today.
- **`http.sslCAInfo` written by the installer**: reported by Codex, not verified here. The
  key is kept either way.

## Questions only the maintainer can answer

1. Should user-initiated Git manager fetch, pull and push be allowed to open a Git
   Credential Manager sign-in on a local desktop server? Today they never prompt, and this
   design keeps that. Allowing it is a separate change. Recommended: not now. A remote or
   WSL server cannot show the window, so the behaviour would differ by where the server
   runs; the authentication error already tells the person to sign in.

## Review findings and resolutions

Codex review, round 1, of revision 0. Each finding was checked against the source at
`e222d340ff`.

| #     | Finding                                                                                                                            | Checked                                                                                                                                    | Resolution                                                                                                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 #1 | A working LFS configuration BiBCode rejects (absolute path, legacy strings) is dropped silently, so old pointer checkpoints break. | Confirmed against revision 0's "dropped" rule.                                                                                             | **Fixed, differently from the proposal.** Codex asked to block capture and restore with an error. That would stop checkpoints for those hosts, a regression. Instead an unrecognized group makes the policy `Unread`: every caller keeps today's behaviour, with hooks still off for checkpoints. The legacy strings are recognized. Tests 6 and 14. |
| P2 #2 | Dropping `http.*` breaks fetches that need the system `sslCAInfo` or `sslBackend`.                                                 | `http.sslbackend` is a key the Git for Windows installer manages (`install.iss`). The installer writing `sslCAInfo` was not verified here. | **Fixed.** Both are kept with validation. Test 13 and the native check with both back ends.                                                                                                                                                                                                                                                          |
| P2 #3 | `/dev/null` is not special on native Windows.                                                                                      | Confirmed: the clone policy uses `NUL` on Windows (`clone_policy.rs:136-137`, `:616`).                                                     | **Fixed.** The shared `NULL_DEVICE`. Test 3 plants the descendant path.                                                                                                                                                                                                                                                                              |
| P2 #4 | `Unread` lets the bootstrap fetch inherit system hooks.                                                                            | Confirmed against revision 0, section 2.                                                                                                   | **Fixed.** Under `Unread` the bootstrap fetch drops the system file. A failure there is a recoverable authentication or TLS error. Test 7.                                                                                                                                                                                                           |
| P2 #5 | Windows CI only compiles the server tests.                                                                                         | Confirmed (`ci.yml:334-336`).                                                                                                              | **Fixed in scope.** The exact steps are in [CI scope](#ci-scope); the coordinator owns `ci.yml`.                                                                                                                                                                                                                                                     |
