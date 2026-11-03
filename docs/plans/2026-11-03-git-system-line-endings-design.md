# Git: Honouring the System Line-Ending Settings

Status: Approved by the maintainer 2026-11-03 (revision 2). Issue #282. Verified at `30622da46436` (`v015/batch`) on
Windows 11 with Git `2.56.0.windows.4`. Line references are to that commit. No product code
is written until this design is approved.

**Revision 1 (2026-11-03)** answers the first Codex review (REVISE: two P1 and five P2
findings). See [Review findings and resolutions](#review-findings-and-resolutions). It
changes these things:

- Checkpoints are left as they are; moving them is a follow-up.
- The probe is process-global, installed by the two binaries, and bounded to 2 s.
- The probe follows `include.path`, and boolean values are canonicalized.
- The policy is enabled only when every command resolves the probed Git.
- The other production Git spawns are listed.

**Revision 2 (2026-11-03)** answers the second Codex review. Findings 1 to 7 were accepted
as resolved or deferred, and one new P1 was raised. The generated file moves from the
shared temp directory to the server's own state directory. It is written atomically, and
the server refuses a path that is not a regular file it owns.

## Outcome

BiBCode's Git sees the same `core.autocrlf`, `core.eol` and `core.safecrlf` as the
person's own Git on that host. Repository and global values still win over system values,
as they do for the person's Git. For the commands built on `git_environment()`, nothing
else from the system configuration (credential helpers, hooks, filters) gets in. Other
production spawns keep today's configuration
([Other production Git spawns](#other-production-git-spawns)).

## Reproduction (verified on this machine)

Throwaway repositories under the session scratchpad (`…/scratchpad/282-repro/`). No host
configuration was changed. `B` is the environment of `git_environment()`
(`apps/server/src/git/repository.rs:7896-7910`):
`B="env GCM_INTERACTIVE=never GIT_ASKPASS= GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C LANG=C SSH_ASKPASS= SSH_ASKPASS_REQUIRE=never"`.

```text
$ git config --system --get core.autocrlf          -> true   (C:/Program Files/Git/etc/gitconfig)
$ git config --global --get core.autocrlf          -> (unset)
# origin: printf 'one\ntwo\nthree\n' > file.txt; git -c core.autocrlf=false add/commit
$ git cat-file -p HEAD:file.txt | od -c            -> o n e \n t w o \n t h r e e \n
$ git clone origin clone; od -c clone/file.txt      -> o n e \r \n t w o \r \n ...   (host checkout: CRLF)
$ git status --porcelain                           -> (clean, the person's Git)
$ $B git config core.autocrlf                      -> rc=1 (unset)
$ $B git status --porcelain                        ->  M file.txt   (already before any touch)
$ $B git diff --stat                               ->  file.txt | 6 +++--- (3 lines, CR only)
$ touch file.txt; $B git status --porcelain        ->  M file.txt
$ $B git add file.txt; git cat-file -p :file.txt | od -c   -> o n e \r \n ...  (CRLF staged)
$ $B git commit -m "via bibcode env"; git cat-file -p HEAD:file.txt | od -c -> o n e \r \n ...
$ git show --stat HEAD                             ->  file.txt | 6 +++---
$ git status --porcelain; touch file.txt; git status --porcelain -> (clean: the person's Git keeps CRLF blobs)
```

**Reproduced.** Every CRLF checkout looks wholly modified to BiBCode's status and diff, and
a BiBCode stage or commit writes CRLF into the blob. The person's own Git then reports
nothing, so the damage is silent. The stat cache did not hide it: status was dirty before
any touch.

Worktrees and restores (same `B`):

```text
$ $B git worktree add -b side ../wt; od -c ../wt/file.txt     -> o n e \n ...  (LF checkout)
$ (cd ../wt; git status --porcelain; touch file.txt; git status --porcelain) -> clean, clean
$ printf 'x\r\n' > file.txt; $B git checkout -- file.txt; od -c file.txt   -> LF; person's status clean
```

LF checkouts are only cosmetic: under `autocrlf=true` both Gits see them as clean.

**Checkpoints already read the system configuration.** `capture_checkpoint` and
`restore_checkpoint` (`production/orchestration_effects.rs:2247-2335`, `:2437-2500`) pass
`checkpoint_environment` (`:2598-2611`, 5 variables) or `&[]` to `crate::git::ProcessRunner::run`,
which inherits the server's environment (`git/process.rs:248`, `:441`). A checkpoint-style
`GIT_INDEX_FILE=… git add -A` on the clone above stores the LF blob `4cb29ea`. With
`GIT_CONFIG_NOSYSTEM=1` it stores CRLF. So today checkpoints and the Git manager disagree.

## Where `GIT_CONFIG_NOSYSTEM` is set (verified)

`rg GIT_CONFIG_NOSYSTEM` finds two production sites. Every other hit is a test fixture or
assertion (`git/manager/mod.rs:103`, `git/manager/tags.rs:364`, `git/broadcaster.rs:3244`,
`production/runtime.rs:2114…`, `apps/server/tests/*`).

1. `git_environment()` (`git/repository.rs:7900`), also used by `git_read_environment()`
   (`:7912`). It has about 20 production call sites: the Git manager, status, diff, worktrees, refs, the
   watcher, `pull_requests/host.rs:270`, `production/diff_tool.rs:784` and
   `production/runtime.rs:1408`.
2. The clone policy's isolated configuration (`git/clone_policy.rs:837-870`). This is a
   deliberate full isolation, documented at `docs/architecture/rpc-and-orchestration.md:4006-4011`.

**Why it was added.** `git log -S GIT_CONFIG_NOSYSTEM` starts at the initial import
`bfbecf595` (2026-07-31), where it sits beside the prompt guards (`GCM_INTERACTIVE`,
`GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`). No rationale is recorded. The living docs describe it
only for the clone (`rpc-and-orchestration.md:4007`). `docs/testing/windows-desktop.md:382-389`
documents the side effect for fixtures. This machine's system file shows what it keeps
out: `credential.helper=manager`, `filter.lfs.*`, `diff.astextplain.textconv`,
`core.fscache`, `core.symlinks=false`, `pull.rebase`, `init.defaultbranch`.

## Decision

| Option                                                                                                                                                                                                                                                                                       | For                                                                                                                                                                                                                                                                                                                                          | Against                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (1) Keep `NOSYSTEM=1` and pass the three keys through `GIT_CONFIG_COUNT/KEY/VALUE` (the issue's proposal)                                                                                                                                                                                    | One env change.                                                                                                                                                                                                                                                                                                                              | **Wrong precedence.** These are command-scope values, and they beat repository and global ones. Verified: with `.git/config` `core.autocrlf=false`, `GIT_CONFIG_COUNT=1 … core.autocrlf=true` gives `command line: true`. That overrides the common `git config --global core.autocrlf false` and every fixture pin. Needs Git 2.31. |
| (2) Drop `NOSYSTEM`                                                                                                                                                                                                                                                                          | Exactly the person's Git.                                                                                                                                                                                                                                                                                                                    | Brings back the system credential helper, LFS filter processes, textconv drivers, any system `core.hooksPath` and `include.path`. That reverses the isolation every call site relies on.                                                                                                                                             |
| (3) Leave it and document it                                                                                                                                                                                                                                                                 | No code.                                                                                                                                                                                                                                                                                                                                     | BiBCode silently commits CRLF blobs on a default Windows install. Unacceptable.                                                                                                                                                                                                                                                      |
| **(4) recommended:** a keys-only system file. Once per process, BiBCode reads the three keys from the real system configuration. If any is set, it writes them to a generated file and runs Git with `GIT_CONFIG_SYSTEM=<that file>` and **no** `NOSYSTEM`. Otherwise it keeps `NOSYSTEM=1`. | **System precedence is kept.** Verified: with a file `[core] autocrlf = true`, a repository `false` wins (`local file:.git/config false`), and with no local value the file applies (`system … true`). Status on the CRLF clone is clean, and `credential.helper` is unset. Linux, macOS, WSL and SSH hosts without such keys see no change. | A probe at startup and a generated file. `GIT_CONFIG_SYSTEM` needs Git 2.32. On older Git the variable is ignored, and the full system file would be read, so (4) applies only on 2.32 or later. `NOSYSTEM=1` overrides `GIT_CONFIG_SYSTEM` (verified: `rc=1`), so the two cannot be combined.                                       |

## Design (option 4)

- **New `git::system_line_endings` module, process-global.** A
  `static POLICY: OnceLock<Policy>` holds one of two values:
  - `Policy::NoSystem`, which is today's behaviour;
  - `Policy::KeysOnly(PathBuf)`.

  `git_environment()` emits `GIT_CONFIG_SYSTEM=<path>` for `KeysOnly`, and
  `GIT_CONFIG_NOSYSTEM=1` for `NoSystem` or an unset lock.

- **Installed by the two binaries only (P2 #3).** `install_once().await` is called by the
  server binary's `serve` path (`apps/server/src/main.rs`) and by the desktop backend before
  `ServerRuntime::start_with_*` (`backend.rs:2132-2140`). It is not called from
  `ServerRuntime::start`. The lifecycle tests that start servers (`lifecycle.rs:1373`)
  therefore never install it, and the exact-environment assertions keep `NOSYSTEM=1`.
  - **Why process-global and not per runtime:** `git_environment()` is a free function
    with about 20 production callers and no runtime handle. Per-runtime ownership would
    thread a handle through all of them for a value that changes only when Git is
    reinstalled.
  - **Restart rule:** the system line-ending settings are read once per BiBCode process. A
    desktop backend restart (`backend.rs:1459-1460`) does not re-read them; quitting and
    reopening the app does. This is documented.
- **Probe, bounded to 2 s in total (P2 #7).** It runs under one cancellation token with a
  2 s deadline (the SSH launcher allows 15 s, `ssh.rs:75`). On timeout or failure the
  children are killed, the policy is `NoSystem`, and one `tracing::warn!` is logged.
  1. **Executable rule (P2 #6).** Commands name bare `git` (`repository.rs:587`) and are
     resolved against the child's `PATH`, with relative entries taken against the child's
     directory (`process/executable.rs:275-295`).
     - The probe builds the same child environment, AppImage isolation included. If any
       `PATH` entry is relative, it stops at `NoSystem`, because two working directories
       could then resolve two different Gits.
     - Otherwise every bare `git` resolves to one executable. The probe runs that
       executable's `git --version` and requires 2.32 or later.
     - An older Git, or a Git replaced on disk while BiBCode runs, is the remaining case.
       An older Git at probe time gets `NoSystem`, which is today's behaviour. A downgrade
       during the run would read the full system file until restart; that is documented
       as a known limit.
  2. **Read (P2 #4).** From an empty temporary directory, so no repository is found, it
     runs `git config --system --includes -z --get-regexp
     '^core\.(autocrlf|eol|safecrlf)$'`.
     - Verified: `--system` ignores `include.path` unless `--includes` is given. A system
       file that only includes a file with `autocrlf = true` gives `rc=1` without the flag
       and `core.autocrlf true` with it.
     - `includeIf` conditions cannot be resolved without a repository. Verified: a
       `gitdir:` include gives nothing outside a repository. So conditional system
       includes are not applied, which is a documented limit. Unconditional includes are.
  3. **Canonicalize (P2 #5).** The last occurrence of each key wins, as in Git.
     - A bare key (`-z` output with no `\n`) is `true`.
     - Booleans are case-insensitive: `true|yes|on` and non-zero integers are `true`;
       `false|no|off|0` and the empty string are `false`.
     - `autocrlf` also takes `input`, `safecrlf` takes `warn`, and `eol` takes
       `lf|crlf|native`, all case-insensitive.
     - If the last value is invalid, that key is dropped and a warning logged. The
       person's own Git refuses such a value too.
  4. **Write (R2.1).** Only canonical tokens are written (`[core]` and up to three
     `key = value` lines), never text copied from the system file.
     - **Location.** The file goes under the server's own state directory, never the
       shared temp directory: `<state>/git/system-line-endings-<16 hex of
       SHA-256>.gitconfig`. `<state>` is `ServerConfig::state_dir()` (`config.rs:207-213`),
       inside the data root that the installing binary already owns. One file exists per
       distinct content.
     - **Directory check.** `<state>/git/` is created if missing (mode `0700` on Unix).
       `symlink_metadata` must show a real directory, not a symlink, and on Unix one owned
       by the effective uid. Otherwise the policy is `NoSystem`.
     - **Atomic write.** The file is written to a fresh `<name>.tmp-<pid>-<uuid>` with
       `create_new` (mode `0600` on Unix, as `mcp/endpoint.rs:170` does), flushed, then
       renamed over the final name. A planted temporary name is never reused. A rename
       replaces a planted symlink itself, never its target.
     - **Final check.** After the rename, `symlink_metadata` of the final path must show a
       regular file, owned by the effective uid on Unix, whose bytes equal what was
       written. Otherwise the policy is `NoSystem` and one warning is logged.
     - Shortcut: these files are never removed. They are a few bytes, one per distinct
       system configuration.
     - Verified: if the file goes missing, Git ignores `GIT_CONFIG_SYSTEM` silently, which
       falls back to today's behaviour.
     - **Per binary.** The data root is the one each binary is started with, so:
       - the desktop uses its per-user app data root, and keeps that path for the process
         (an in-process backend restart reuses it);
       - `bibcode serve` uses its configured data root;
       - WSL and SSH servers are `bibcode serve` on that host, with the remote user's
         Linux data root. That is a home directory, not `/tmp`, and those hosts usually
         have no system line-ending keys, so they stay at `NoSystem` and write nothing.
  5. With no key set, or on any failure, the policy is `NoSystem`.
- **Checkpoints are not moved (decision, P1 #1 and #2).** Capture and restore
  (`orchestration_effects.rs:2247-2337`, `:2437-2500`) already inherit the full system
  configuration. Once `git_environment()` honours the system `autocrlf`, both paths agree
  on line endings, which is all #282 needs.
  - Moving or isolating them changes more than line endings. Capture's `update-ref`
    (`:2333-2337`) can run a system `core.hooksPath` `reference-transaction` hook. Old
    checkpoints of a repository with LFS configured only at system scope hold pointers,
    which an isolated restore would write out as pointer text.
  - That goes to a follow-up issue: isolating checkpoints at the shared `run_git`
    boundary, together with an LFS compatibility decision for old checkpoints and
    recovery tests from old checkpoints.
- **Clone stays isolated** (`clone_policy.rs:837-870`). A clone's LF checkout is clean for
  both Gits under `autocrlf=true`, as the worktree reproduction shows.
- **Worktrees, revert and discard** need no code of their own, because they run through
  `git_environment()`.

## Other production Git spawns

These do not use `git_environment()` today, and each keeps its behaviour.

| Spawn                                                                                                                         | What it runs                                     | Config today                           | Decision                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap Git (`orchestration_effects.rs:441-466`, `env: Vec::new()`)                                                         | `fetch origin`, `rev-parse` (`:427-431`)         | Full, inherited                        | Exception: no working tree is touched, so line endings do not apply. The fetch may need the system credential helper. Its isolation belongs to the checkpoint follow-up. |
| Streamed review diff (`production/runtime.rs:1737-1790`, `review_git`)                                                        | `git -C <cwd> diff` with `CANONICAL_DIFF_CONFIG` | Full, inherited                        | Exception: it already reads the system `autocrlf`, so after the fix it agrees with status. Its short reads (`:1408`) already use `git_read_environment()`.               |
| Workspace search (`workspace/search.rs:759-790`)                                                                              | `git ls-files`                                   | Inherited, plus `GIT_OPTIONAL_LOCKS=0` | Exception: lists paths and never converts content.                                                                                                                       |
| Pull-request discovery default, including Bitbucket (`source_control/pull_request.rs:410-420`, `git_environment: Vec::new()`) | remote and config reads                          | Inherited                              | Exception: no content conversion. The default is kept, and its tests inject their own environment (`:465-470`).                                                          |
| External difftool (`production/diff_tool.rs:737-760`)                                                                         | `git difftool` launching the person's tool       | Inherited, deliberately                | Intentional exception: the tool definitions can live in the system configuration. Its probes (`:784`) use `git_read_environment()` and get the policy.                   |

## Failure, restart, concurrency and security

- **Before install**, the lock is unset and `NOSYSTEM=1` applies. The lock is set only
  after the rename, so no command sees a half-written file.
- **Restart.** Read once per process. See the restart rule above.
- **Stalled or failing probe.** The 2 s deadline, then `NoSystem`. Server readiness is
  delayed by at most 2 s.
- **Security.** The file lives in the server's own state directory and is checked to be a regular file the server owns, so another local user cannot plant or replace it (R2.1). It holds at most three canonical keys, so no helper, hook, filter,
  include or URL rule can enter. The probe follows unconditional includes only to read.
  `GIT_CONFIG_GLOBAL=/dev/null` sites (`repository.rs:8422`, `git_vcs.rs:7366`,
  `merge.rs:624`) are unchanged.
- **Remote environments.** WSL and SSH servers probe their own host. Distribution Git has
  no system `autocrlf`, so they stay at `NoSystem`.
- **Already-polluted repositories.** CRLF blobs that BiBCode committed before the fix stay
  CRLF. Under `autocrlf=true`, Git does not normalize a path whose index blob already has
  CRLF. `git add --renormalize .` is the person's choice, and the release notes say so.

## Mixed versions

The fix is server-local and changes no RPC, contract or persisted shape. An older server
ignores the generated file. A desktop connected to an older remote server sees that
server's behaviour.

## Profiler, crash and trace coverage

- **Child processes.** The probe commands run through `crate::git::ProcessRunner`
  (supervised, `git/process.rs:458-460`) with the shared cancellation token.
- **Logs.** One `tracing::warn!` on a timeout, a failure, an invalid value or a write
  failure. It names no repository path.
- **Not applicable.** RPC methods, worktree removal, binaries and re-exec, shutdown order,
  and the profiler reference docs.

## Effect on existing tests

- The fixture pins of `core.autocrlf=false` (`production_worktree_catalog_rpc.rs:2927`,
  `:4683`, `production_git_vcs_rpc.rs:828…`, `git_manager_commit.rs:443`,
  `repository.rs:10264`, `:13775`, `profiler_stacked_actions.rs:186`) keep working. They are
  repository-scope and beat the system file. Under option 1 they would have broken.
- The exact-environment assertions (`git/manager/mod.rs:103`, `tags.rs:364`,
  `broadcaster.rs:2883-2888`) keep passing: only the binaries install the policy, so the
  library and lifecycle tests run with `NOSYSTEM=1`. Update the comment at
  `production_worktree_catalog_rpc.rs:4681-4682`.

## Test plan

**Isolation.** The tests that install the process-global policy live in their own
integration binary, `apps/server/tests/git_system_line_endings.rs`. It installs once, from
one `#[test]` that runs its cases in order. The pure parts (canonicalizer, executable
rule, environment builder) are unit tests that never touch the lock. Each test runs on
every OS: the probe honours `GIT_CONFIG_SYSTEM` in the environment it is given, so a
fixture file stands in for Git for Windows' system configuration.

Fails before the change (integration binary):

- `a_crlf_checkout_under_a_system_autocrlf_is_clean_in_status_and_diff`. Today ` M`, after
  the change clean.
- `a_commit_through_the_git_manager_stores_lf_under_a_system_autocrlf`. Today the blob has
  `\r\n`.
- `a_worktree_created_under_a_system_autocrlf_checks_out_crlf`.
- `a_system_autocrlf_reached_only_through_include_path_applies`.

Guards:

- `a_repository_autocrlf_false_beats_the_system_value`.
- `a_system_credential_helper_hook_or_filter_never_reaches_production_git`. The fixture
  system file sets `credential.helper`, `core.hooksPath` and `filter.x.process`.
- Executable rule, run through execution:
  - `an_older_git_first_on_path_keeps_nosystem` puts a fake `git` reporting 2.31 first on
    the child `PATH`.
  - `a_relative_path_entry_keeps_nosystem`.
- `a_stalled_probe_falls_back_within_the_deadline`: a fake `git` that sleeps 30 s. Install
  returns within about 2 s with `NoSystem`, and the child is killed.
- Canonicalizer unit tests:
  - `YES`, `on`, `1`, a bare `autocrlf` key, `Input` and `LF` map to `true`, `true`,
    `true`, `true`, `input` and `lf`.
  - `autocrlf = true` followed by `autocrlf = off` gives `false` (the last value wins).
  - `eol = mac` and `autocrlf = maybe` are dropped.
  - A quoted `autocrlf = "true\n[credential]"` is dropped. It is not a canonical token, and
    nothing but canonical tokens is ever written.
- `no_line_ending_keys_keeps_nosystem`.
- `a_missing_generated_file_behaves_as_today`.
- `a_planted_or_foreign_generated_file_is_refused` (R2.1):
  - `<state>/git` is a symlink;
  - the final name is a directory;
  - on Unix, the final file is owned by another uid (skipped when the tests are not run as
    root);
  - a planted `*.tmp-*` exists.

  The first three give `NoSystem`, and a commit runs no planted `core.hooksPath` hook. The
  planted temporary file is never used.

- `the_generated_file_is_under_the_state_dir_with_private_modes` (Unix: `0700` directory,
  `0600` file).

Native Windows run: the reproduction above, through the app, covering status, diff,
commit and a new worktree, then a checkpoint restore to confirm both paths agree.

## Living docs to update

- `docs/architecture/rpc-and-orchestration.md`: a "Git environment" paragraph near the
  noninteractive Git settings (`:1729`). It covers the keys-only system file, its
  precedence, includes, the executable and 2.32 rule, the 2 s probe and the
  once-per-process restart rule. It also lists the spawns that keep their own
  configuration, and keeps the clone exception at `:4006-4011`.
- `docs/testing/windows-desktop.md:382-389`: production Git now reads the system line-ending
  keys. The fixture pin stays and is still required.
- `docs/user/workspace-ui.md:902` (Git Manager): one sentence on line endings and `--renormalize`.

## Not verified

- No server build or test was run (read-only task, and another agent is building). The
  reproduction used the Git CLI with BiBCode's environment, not the running app.
- `windows-desktop.md:382` says Git for Windows also sets `core.autocrlf` globally. On this
  machine the global value is unset.
- Whether the configurable `git_command` paths (`orchestration_effects.rs:2264`,
  `pull_request.rs:398`) are ever set in production to something other than bare `git`.
  The executable rule assumes they are not.
- Whether Git's `core.eol` and `core.safecrlf` parsing is case-insensitive. The
  canonicalizer follows `autocrlf`'s `input` rule, and Codex verified typed boolean lookup.
- Whether the data root's state directory is private already (its mode on Unix, its ACL
  on Windows). On Windows there is no owner check: the design relies on the per-user
  profile ACL of the desktop's app data root, plus the symlink and regular-file checks.
- Follow-up issues to file, outside this batch:
  - isolating checkpoints and bootstrap Git, with the LFS compatibility decision for old
    checkpoints;
  - other system defaults that `NOSYSTEM` drops (`filter.lfs.*`, `core.symlinks`,
    `core.fscache`, `credential.helper`). LFS smudge in BiBCode-made worktrees is the
    likeliest to matter.

## Review findings and resolutions

Codex review, round 1, of revision 0. Each finding was checked against the source at
`30622da46436`. Findings 4 and 5 were also checked on this machine's Git. Rulings from the
coordinator are marked.

| #     | Finding                                                                                                | Checked                                                                                                                           | Resolution                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 #1 | Capture's `update-ref` passes `&[]`, so a system `reference-transaction` hook still runs.              | Confirmed (`orchestration_effects.rs:2333-2337`).                                                                                 | **Out of scope (ruling).** Checkpoints are not moved. They already read the full system configuration, so after the fix they agree on line endings. Their isolation at `run_git` goes to a follow-up. The checkpoint change and its test are removed.                                                                            |
| P1 #2 | Isolating checkpoints changes LFS behaviour, and old checkpoints restore as pointer text.              | Confirmed. Capture `add -A` (`:2310`) and restore (`:2449`) inherit the system filters.                                           | **Out of scope (ruling).** Recorded as a decision in the Design section. The follow-up must take an LFS compatibility decision and add recovery tests from old checkpoints.                                                                                                                                                      |
| P2 #3 | A `OnceLock` outlives a desktop backend restart. Lifecycle tests call `ServerRuntime::start`.          | Confirmed (`backend.rs:1459-1460`, `lifecycle.rs:1373`).                                                                          | **Process-global, by choice.** Installed by the two binaries only, never by `ServerRuntime::start`. The restart rule is documented, and the tests that install it have their own binary. Per-runtime ownership would thread a handle through about 20 callers.                                                                   |
| P2 #4 | `--system` ignores `include.path`, and `includeIf` cannot be flattened.                                | Confirmed on Git 2.56: `rc=1` without `--includes`, `true` with it, and nothing for `gitdir:` outside a repository.               | **Fixed.** The probe uses `--includes` from an empty directory. Conditional includes are a documented limit, and only canonical tokens are written.                                                                                                                                                                              |
| P2 #5 | The allowlist drops `YES`, `on`, `1` and bare keys, and dropping a later value exposes an earlier one. | Confirmed: raw `-z` output gives `on`, `LF` and a bare `core.autocrlf`.                                                           | **Fixed.** Git's boolean canonicalization and last-value precedence are applied before validation. An invalid last value drops the key. The fixture example is replaced.                                                                                                                                                         |
| P2 #6 | The version gate is not bound to the executable each command runs.                                     | Confirmed: bare `git` (`repository.rs:587`), resolved against the child's `PATH` with relative entries (`executable.rs:275-295`). | **Fixed with the simplest sound rule.** The probe uses the same child environment. Any relative `PATH` entry gives `NoSystem`. Otherwise one executable is resolved, and it must be 2.32 or later. An older Git sees `NOSYSTEM=1`, today's behaviour. A downgrade while running is a documented limit. Tested through execution. |
| P2 #7 | The probe has no deadline, and the SSH launcher allows 15 s.                                           | Confirmed (`ssh.rs:75`).                                                                                                          | **Fixed.** 2 s in total, with cancellation and a `NoSystem` fallback. A stalled-probe test is added.                                                                                                                                                                                                                             |
| Note  | The isolation claim overlooks five production bypasses.                                                | Confirmed at each cited line.                                                                                                     | **Listed** in [Other production Git spawns](#other-production-git-spawns), each with a decision. The Outcome is scoped to `git_environment()`.                                                                                                                                                                                   |

Codex review, round 2, of revision 1: findings 1 to 7 were accepted as resolved or
deferred. One new finding was confirmed.

| #    | Finding                                                                                                                                                                              | Checked                                                             | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2.1 | P1: on a shared `/tmp`, another user can pre-create `bibcode-git` and replace the hash-named file with config that sets `core.hooksPath`, so a later BiBCode commit runs their hook. | Confirmed against revision 1's Write step (`<temp>/bibcode-git/…`). | **Fixed (ruling).** The file is written under `<state>/git/` in the server's own data root. The directory must be a real one, owned by the server on Unix, `0700`. The file is written with `create_new` to a unique temporary name, `0600`, and renamed. After the rename it must be a regular file the server owns with the expected bytes, or the policy is `NoSystem`. Applies the same way to the desktop, `bibcode serve`, WSL and SSH. Test: `a_planted_or_foreign_generated_file_is_refused`. |

## As built

Implemented in `apps/server/src/git/system_line_endings.rs`, with the integration tests in
`apps/server/tests/git_system_line_endings.rs`. It differs from the design in these ways:

- **Test isolation.** Each case that installs the policy runs in a process of its own,
  through `tests/support/reexec.rs`, instead of one `#[test]` that runs every case in
  order. The parent process sets the fixture `GIT_CONFIG_SYSTEM`, an isolated
  `GIT_CONFIG_GLOBAL` and a `PATH` without relative entries, and removes inherited `GIT_*`
  variables. Cases that need no installed policy call the public `probe(state_dir,
  environment)`, which installs nothing. `install_once` is that probe plus the lock.
- **Deadline.** One 2 s deadline is shared by both probe commands as their
  `ProcessRequest` timeouts, so the supervised runner kills a stalled child. There is no
  separate cancellation token.
- **An existing final name.** A regular file the server owns, holding exactly the
  expected bytes, is reused without a rewrite. Anything else at the final name is refused
  before any write, and the policy is `NoSystem`: a directory, a symlink, or a file owned by
  another user. Under the design's write-then-rename, a foreign-owned file would have been
  replaced, so the design's expected `NoSystem` for that test case would not have held.
- **Relative `PATH` entries.** On Windows, empty entries are skipped, as process creation
  skips them. Every other relative entry gives `NoSystem` on every OS. A shell that splits
  `C:\…` at the colon, as Git Bash did for one entry on this machine, leaves a relative `C`.
  That entry alone keeps the policy at `NoSystem`, so the tests build their own `PATH`.
- **Logging.** An older Git or a relative `PATH` entry logs at `debug`, because neither is
  a failure. Timeouts, failures, invalid values and write failures go through the module's
  one `tracing::warn!`. Its `reason` is fixed text with no path.
- **Probe directory.** The probe runs in a fresh `bibcode-git-probe-<uuid>` directory under
  the temp directory, with `GIT_CEILING_DIRECTORIES` set to the temp directory, and removes
  it afterwards.
- **Desktop tests.** The desktop backend's `install_once` call is `#[cfg(not(test))]`, so
  desktop unit tests keep `GIT_CONFIG_NOSYSTEM=1`, like the server's lifecycle tests.
- **Symlink case on Windows.** Creating a symlink needs a privilege that this machine
  lacks. The test then uses a directory junction, which `symlink_metadata` also reports as
  a link.
- **Booleans.** The canonicalizer uses `git_boolean` in `git/repository.rs`, the same
  parser behind the existing `git_boolean_is_true`.
- **Verified on this machine.** `git config --show-scope --get-all core.autocrlf` gives only
  `system` (`C:/Program Files/Git/etc/gitconfig`). The note in
  `docs/testing/windows-desktop.md` that Git for Windows also sets the key globally was
  corrected.
- **Not done.** The native Windows run through the packaged app (status, diff, commit, a
  new worktree and a checkpoint restore) was not run. The integration tests cover status,
  diff, commit and worktrees through `GitRepository`, with a fixture system file.
