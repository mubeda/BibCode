# Diff Compare View and Open With

Status: Proposed 2026-10-24; awaiting approval. Issue #140.

## Problem

The Diff surface shows every changed file in one stacked scroll of hunks. A
reviewer who wants one file's previous and current versions side by side, the
way Beyond Compare shows them, has no file list, no full-file view, no choice of
context lines and no way to hand the file to a diff app. The panel also forgets
Stacked/Split on every mount.

## Current behavior (verified at 4e023ac5ff)

- **Panel.** `DiffPanel` is mounted for the `diff` surface at
  `apps/web/src/components/ChatView.tsx:6804-6812`. Stacked/Split is
  `useState("stacked")` (`apps/web/src/components/DiffPanel.tsx:200`, toggle
  `:703-721`). Wrap and whitespace are seeded from `ClientSettings` (`:201-202`)
  but the toggles never write back. All files render in one
  `AnnotatableCodeView` (`:836-887`; pierre `CodeView` at
  `apps/web/src/components/diffs/AnnotatableCodeView.tsx:252`), sorted at
  `:432-442`, with no `loadDiffFiles` or `expandUnchanged` option (`:877-886`).
  An empty patch reads "No net changes in this selection." (`:817`); a query
  error shows in the panel's error line (`selectedPatchError`).
- **Git patches.** `review.getDiffPreview` builds the working-tree source from
  `git diff HEAD` plus synthesized new-file patches for untracked files, and
  the branch source from `git diff <base>...HEAD`
  (`apps/server/src/production/runtime.rs:1084-1172`). Each source is capped at
  4,375,000 bytes (`MAX_REASONABLE_DIFF_SIZE`, `:1045`) and cut at a file
  boundary. The arguments (`:1181`) have no `--full-index` and no `-U<N>`, so
  `index` lines carry abbreviated object IDs and the context is Git's default.
  The client's `baseRef` is formatted straight into `"{base_ref}...HEAD"`
  (`:1131`), so a value starting with `-` reaches Git as an option. Git is
  started with a plain spawn and `kill_on_drop` (`:1222`); its exit is never
  passed to `report_exit`. The runner kills Git when the output passes the cap
  or the capture fails (`:1237`), and it turns any other non-zero exit into an
  empty string (`:1245`).
- **Turn patches are empty.** `orchestration.getTurnDiff` and
  `getFullThreadDiff` return a stored row from `checkpoint_diff_blobs` matched
  on the exact turn range (`apps/server/src/production/orchestration_rpc.rs:892-919`);
  `TurnDiffInput` drops `ignoreWhitespace` (`:2003`). The only writer of that
  table is the `thread.checkpoint.saved` projector
  (`apps/server/src/orchestration/engine.rs:6391`). No code emits that event,
  and `upsert_checkpoint_diff_blob`
  (`apps/server/src/persistence/repositories.rs:286`) has no callers. Checkpoint
  capture dispatches `ThreadTurnDiffComplete` with numstat summaries only
  (`apps/server/src/production/orchestration_effects.rs:1113`). A turn captured
  by this server therefore gets `diff: ""`, and the panel says "No net changes
  in this selection." This is verified in source only; it must be confirmed in
  the app before step 1 of the rollout. Checkpoints are commits at
  `refs/bibcode/checkpoints/<thread>/turn/<n>` (`orchestration_effects.rs:1469`),
  so their blobs are in the repository's object store. The turn queries are
  registered with the engine alone (`orchestration_rpc.rs:236`) and take no
  workspace admission, unlike `review.getDiffPreview`
  (`apps/server/src/workspace/rpc.rs:620`).
- **No full-file source.** `projects.readFile` reads the working tree only, up
  to 1 MiB (`apps/server/src/workspace/service.rs:15`, `:91`).
  `git show <commitish>:<path>` exists only for Git Manager images
  (`apps/server/src/git/manager/refs.rs:125-174`), through `ProcessRunner`, with
  a 30 s timeout, an output cap and cancellation. Patch-parsed diffs are
  partial. In `@pierre/diffs` 1.3.6, `loadDiffFiles` runs only when the user
  expands a hunk (`dist/components/FileDiff.js:428-443`), and
  `hydratePartialDiff` is exported (`dist/index.d.ts`). Pierre renders the
  context lines the patch has; it has no option that narrows them.
- **Client queries.** Environment query families keep a released query for
  five minutes unless they set `idleTtlMs`
  (`packages/client-runtime/src/state/runtime.ts:745`). Git Manager's queries
  set `idleTtlMs: 0` (`packages/client-runtime/src/state/gitManager.ts:28`).
- **Open in.** `shell.openInEditor` (`apps/server/src/production/git_vcs.rs:1958-2017`)
  launches through `launch_editor` (`:2060-2079`), which spawns and drops the
  child: no exit report, no attribution. The header picker shows only for the
  primary environment (`apps/web/src/components/chat/ChatHeaderActions.tsx:63-73`).
  Nothing launches a diff tool.
- **Shutdown kills server children.** `quiesce_for_update` freezes process
  ownership (`runtime.rs:824`) from every registration in the attribution
  registry (`apps/server/src/diagnostics/registry.rs:144`) and later kills
  those roots and their captured descendants. A standalone server then also
  kills every remaining descendant of its own PID
  (`apps/server/src/production/server_terminal.rs:453`,
  `apps/server/src/diagnostics/native.rs:133`). A new process group does not
  change a child's parent, so neither path spares it. The desktop's Windows
  update restart already breaks a child out of a kill-on-close job, with a
  fallback when the job forbids it
  (`apps/desktop/src-tauri/src/windows_update_restart.rs:341`).
- **Persistence.** `ClientSettings` (`packages/contracts/src/settings.ts:119`)
  persist through the local API (`apps/web/src/hooks/useSettings.ts:135`), so
  they survive reload and restart. Per-thread scope and base ref persist in the
  `bibcode:diff-panel-state:v1` store (`apps/web/src/diffPanelStore.ts:134`).
  `DiffPanel.test.tsx` mocks client settings (`:161`), so it cannot prove a
  value survives a restart.
- **Prior art.** The pull request Files tab already pairs a file tree with
  diffs (`apps/web/src/components/pullRequests/detail/PullRequestsFiles.tsx`).
  Git Manager has binary, large and image interstitials
  (`packages/contracts/src/gitManager.ts:132-145`) and validates client object
  IDs as 40 or 64 hex digits (`apps/server/src/production/git_manager_rpc.rs:1613`).
  `WindowedList` virtualizes fixed-height rows
  (`apps/web/src/components/WindowedList.tsx:69`).
- **`git difftool --tool-help`.** It took 1.7 s locally (macOS, Git 2.54). Its
  headings are translated, it lists terminal tools such as `vimdiff`, and it
  marks GUI tools "(requires a graphical session)". The profiler's `rpc.slow`
  threshold is 1 s (`apps/server/src/diagnostics/profiler/latency.rs:41`).
- **`git difftool` exit codes.** Measured with Git 2.54 and a custom tool that
  runs `exit 3`: `git difftool` exits 0 by default, in both per-file and
  `--dir-diff` modes. With `--trust-exit-code` it exits 128 ("external diff
  died") per file, and 3 with `--dir-diff`. An unknown tool exits 128 either
  way.

## Goals

- A **Changes | Compare** toolbar. Changes is the default and stays as it is
  today, except that Stacked/Split is remembered.
- In Compare, a virtualized file list on the left. The selected file's previous
  and current versions sit side by side on the right, aligned and scrolling
  together, for the working tree, branch and turn scopes.
- An explained state for added, deleted, renamed, binary, submodule, oversized,
  truncated and unavailable files.
- **All lines** and **Changes only (±N)** line filters, where N is a context
  count that defaults to 3; status and name filters; and an "N of M files"
  count.
- The mode, Stacked/Split, the line filter and N survive reload and app
  restart.
- **Open with**, which opens the file, or all files, in a diff app through
  `git difftool`, with disabled states that give their reason, and which
  leaves the app open when BiBCode quits.
- A bounded, cancellable, tested read RPC.

## Non-goals

- Launching a diff app for a remote environment. That needs a `DesktopBridge`
  command that downloads both versions, and its own design.
- Show Same, over-under layout, newer/older, grammar rules and name masks.
- Editing in Compare.
- Hunk expansion in Changes. The same RPC enables it later.
- A context count in Changes. The issue scopes N to the second view.
- A resizable file list. It can follow #153.
- Image compare. Git Manager already has it.
- Changing `review.getDiffPreview`'s empty result after a Git failure. It is
  existing behavior; see Risks.

## Alternatives

### Full-file data

**A. Full contents in `getDiffPreview`.** Rejected: it multiplies the payload
by every file, and a source can hold thousands of files.

**B. `review.readFileAtRevision { cwd, rev | worktree, path }`, as the issue
proposes.** The client must name revisions it does not have: the merge-base
and checkpoint object IDs are not in any result. `HEAD` can move between the
patch and the read, a rename needs both paths, and revision strings from the
client need option-injection guards. A stale read hydrates the wrong text into
Git's hunks without any error.

**C. Content-addressed reads (recommended).** Review and turn patches carry
full blob IDs (`--full-index`). The client asks for `blob <oid>`. Only the
working tree's current side is read from disk, and the patch's object ID
checks that it is fresh (`git hash-object --stdin --path`). Reads are
immutable, need no revision resolution and no rename logic. The cost is 66
more bytes per file for SHA-1 (114 for SHA-256): about 264 KB for 4,000 files,
against a 4.4 MB cap.

**D. Abbreviated IDs without `--full-index`.** The patch stays unchanged, but
a short ID can become ambiguous, and the existing 40/64-digit validation no
longer applies. Rejected.

### Rendering the selected file

**E. Hydrate Git's hunks with both full files (recommended).** Use
`hydratePartialDiff("clone", fileDiff, files)`; **All lines** is
`expandUnchanged: true`. Hunks, comment line numbers and the whitespace mode
come from Git, and the work is O(lines).

**F. Re-diff in the browser** (`parseDiffFromFile` with `context: N`). It
supports any N, but it runs an unbounded line diff on the main thread: jsdiff
9's non-abortable options have no timeout
(`diff@9.0.0/libesm/patch/create.d.ts:90`). Its hunks can also disagree with
Git's `--minimal` and `--ignore-all-space` output and with the list's counts.
Rejected.

**G. A new per-file `git diff -U<N>` RPC.** It gives an exact N, but it adds
another method. Rejected in favour of H.

**H. An optional `contextLines` on the existing diff requests (recommended
for Changes only).** `review.getDiffPreview`, `orchestration.getTurnDiff` and
`getFullThreadDiff` accept `contextLines` and pass `-U<N>` to Git. N is exact,
the hunks stay Git's, and there is no new method. **All lines** keeps using
the default patch that Changes already loaded, so only **Changes only** pays
for a second patch, once per value of N. Hydration (E) still fills the gaps
between the hunks.

Trimming or growing the context in the client was also considered. Growing
works only when both full files loaded, and trimming rewrites pierre's hunk
metadata. Rejected.

### External launch

**I. `git difftool` on the server (recommended).** Git owns each tool's
arguments, the temporary pre-image files, `difftool.<tool>.cmd`/`.path` and
`diff.guitool` ([git-difftool](https://git-scm.com/docs/git-difftool)). The
repository's Git config lives where the server runs.

**J. A BiBCode tool catalog, like `EDITORS`.** It needs per-OS argv, cleanup
of our own temporary files, and a multi-argument launch on Windows that today's
single-target launch cannot do. It gives more control for much more
maintenance.

**K. A `DesktopBridge` command that launches locally.** This is needed only for
remote environments. For the primary environment in the desktop app, the
server runs in-process, on the same computer. Out of scope.

**L. Open in editor alone.** Rejected: it shows no previous version.

## Decision

C + E + H + I, after one prerequisite: compute turn patches live from
checkpoint refs, under workspace admission, which also gives them full IDs,
whitespace handling and the context count. Harden `baseRef` in the same
change, because Compare and Open with reuse it.

What this trades away:

- A context count other than the default asks Git for the whole source again.
  The request is debounced and runs once per value of N.
- Full files are capped at about 4.4 MB per side.
- The external app sees current refs, not the exact patch the panel loaded.
- A diff app BiBCode opened is not stopped at shutdown, so it can outlive the
  session that started it.

## Open questions answered

1. **Open with on Changes file headers?** Not now. Compare is one click away,
   and controls on every row of a 4,000-file stacked list add noise.
2. **"Review" or "Compare"?** **Compare.** "Review" already names review
   comments, the `review.*` RPCs and pull request reviews. "Compare" names what
   the user does.
3. **Does browser mode against a server on the same computer count as local?**
   Yes. The primary environment counts as local, which is the gate the header's
   **Open in** picker already uses. The server cannot know where a browser runs:
   an SSH tunnel makes a remote server look like `localhost`. A misfire is
   harmless. The app opens on the server's computer, or Git's error comes back.
   In browser mode the menu says "Opens on the computer running the server."
4. **Semicolon and `-` name masks?** Later. The substring filter covers the
   common case.
5. **Leave a running diff app open at shutdown, or end it?** Leave it open.
   Killing it would discard unsaved edits in the tool, because the working-tree
   side is the real file. In `--dir-diff`, it would also discard Git's copy-back
   of an edited temporary file, which Git does only when the working file did
   not change too
   ([difftool design note](https://code.googlesource.com/git/+/v2.6.6/git-difftool.perl)).
   Git deletes its temporary files when the tool exits. Leaving it open takes
   an explicit exclusion from both shutdown cleanups (see **Surviving
   shutdown**); a separate process group alone does not.

## Protocol, schema, and persistence

### `review.readFileVersion` (new, `read_unary`)

```ts
GitObjectId = String matching /^([0-9a-f]{40}|[0-9a-f]{64})$/
Input = { cwd, version:
  | { _tag: "blob", oid: GitObjectId }
  | { _tag: "worktree", path: TrimmedNonEmptyString, expectedOid: GitObjectId } }
Result =
  | { _tag: "text", contents: string, byteLength: number }
  | { _tag: "unavailable",
      reason: "missing" | "binary" | "too-large" | "not-a-file" | "changed",
      byteLength: number | null }
```

The method is dispatched in `WorkspaceRpc` beside `review.getDiffPreview`,
behind the same `acquire_path` admission. It needs the same `review:write`
scope.

- **`blob`:** one `git cat-file --batch` through `ProcessRunner`, with the read
  environment plus `GIT_NO_LAZY_FETCH=1` so a partial clone never fetches from
  the network ([git(1)](https://git-scm.com/docs/git)). It has a 30 s timeout
  and the request's cancellation. A `missing` header returns `missing`, and a
  type other than `blob` returns `not-a-file`. Output past
  `MAX_REASONABLE_DIFF_SIZE` plus the header returns `too-large`. A NUL byte
  returns `binary`. Otherwise the result is lossy UTF-8, matching how the patch
  is decoded. `cat-file` applies no filters or textconv
  ([git-cat-file](https://git-scm.com/docs/git-cat-file)). Deleted files,
  a rename's old side and branch or turn files absent from the checkout are all
  read this way, so none of them touches the working tree.
- **`worktree`:** `resolve_relative` and `canonical_existing_within`
  (`workspace/paths.rs`), as in `read_file`, because this side reads a real
  file. A path that does not exist (`realpath-target` NotFound) returns
  `missing`. A symlink, directory or submodule returns `not-a-file`, and a size
  over the cap returns `too-large`. The bytes are read once, then hashed by
  `git hash-object --stdin --path=<path>`, which applies that path's clean
  filters and end-of-line rules, as `git diff` did when it printed the ID
  ([git-hash-object](https://git-scm.com/docs/git-hash-object)). A different
  ID returns `changed`.
- Reads share the workspace operation permits (32).

### `review.listDiffTools` (new, `read_unary`, long-running)

`{ cwd }` returns `{ tools: { id, label, kind: "builtin" | "custom" }[],
defaultToolId: string | null, defaultSource: "diff.guitool" | "merge.guitool" |
"diff.tool" | "merge.tool" | null }`.

- The server runs `git difftool --tool-help` with `LC_ALL=C` and an empty
  `LANGUAGE`, so the headings are stable, and a 30 s timeout.
- It parses only the first, available section. It keeps the built-ins marked
  "(requires a graphical session)" and the `user-defined:` entries
  (`<name>.cmd …`), without duplicates.
- The default is the first of `diff.guitool`, `merge.guitool`, `diff.tool` and
  `merge.tool` whose value is in the list, which is Git's own `--gui` order.
- There is no server cache. The client query is cached for 10 minutes per
  environment and `cwd`, and it is prefetched when the pointer enters the
  button. It holds a few hundred bytes, so the retention is harmless.

### `review.openDiffTool` (new, `mutation_unary`, long-running)

```ts
{ cwd, toolId, target: { _tag: "file", path, previousPath? } | { _tag: "all" },
  scope: { _tag: "working-tree" } | { _tag: "branch", baseRef: string | null }
       | { _tag: "turn", threadId, fromTurnCount, toTurnCount } }
→ { _tag: "opened" }
| error { _tag: "ReviewDiffToolError",
          reason: "launch-failed" | "too-many-open" | "shutting-down"
                | "invalid-request",
          message, command: string[] }
```

- **Arguments.** The server builds them:
  `git -C <cwd> difftool -y --trust-exit-code [--dir-diff] --tool=<id> [-M] <revs> -- [paths]`.
  - `--trust-exit-code` makes Git return the tool's failure; without it Git
    exits 0 (measured above).
  - Working tree: `HEAD`.
  - Branch: the base, resolved by
    `rev-parse --verify --quiet --end-of-options <base>^{commit}`, then
    `<base-oid>...HEAD`.
  - Turn: `checkpoint_ref(threadId, n)^{commit}` for both counts.
  - A rename passes both paths with `-M`.
  - Paths are checked lexically by `resolve_relative` (no absolute path, no
    `..`, not empty) and never against the filesystem: a deleted file, a
    rename's old path and a file that exists only in a branch base or a
    checkpoint are valid pathspecs. They follow `--`, and the environment adds
    `GIT_LITERAL_PATHSPECS=1`, so pathspec magic does not apply. Git matches
    them against its own trees and index.
  - The environment also adds `GIT_TERMINAL_PROMPT=0`, and the AppImage
    environment is isolated.
- **Spawn.** Stdin and stdout are null, and stderr goes to a temporary file.
  The child gets no `KillOnDrop` and no kill-on-close job. It starts in its own
  process group (`process_group(0)` on Unix), so a terminal's Ctrl+C to a
  standalone server does not reach it. On Windows it uses
  `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`,
  and retries without breakaway when the job forbids it, as
  `windows_update_restart.rs:341` does.
- **Launch window.** The server waits up to 1 s:
  - exit 0 returns `opened` (some launchers return at once);
  - a non-zero exit returns `launch-failed` with the exit code and the last
    2 KiB of stderr;
  - a process still running returns `opened`.
- **Reaper.** A task then waits for the exit, reports it, logs a late non-zero
  exit with `tracing::warn!` (tool ID and exit code only), deletes the log and
  drops the registration.
- **Cap.** At most 16 running launches per server; one more returns
  `too-many-open`. A launch after shutdown began returns `shutting-down`.

### Surviving shutdown

The launcher registers each `git difftool` child with `register_identity`
(`External`/`Helper`, label `diff app`) and marks the registration to survive
shutdown. Every other registration keeps today's behavior.

- **Registry.** `ProcessRegistrationMetadata` gains `survives_shutdown: bool`,
  `false` at every existing registration site (provider, terminal, desktop UI,
  helper). `freeze_and_snapshot_identities` leaves surviving registrations out
  of the roots and returns them separately, and `RuntimeProcessOwnership`
  carries them as `survivors`.
- **Ownership cleanup** kills only the roots and their captured descendants,
  as today. A survivor is never a root, and nothing BiBCode owns is its parent.
- **Standalone descendant cleanup.** `cleanup_descendants(root_pid, survivors)`
  removes each survivor and its own descendants (the GUI app under `git
  difftool`) from the kill list. It uses the same start-time rule as
  `runtime_owned_process_identities`, so a reused PID is not spared.
- **Ordering.** In `quiesce_for_update`, the launcher's `shutdown()` runs
  before `freeze_process_ownership`, next to `device_manager.shutdown()`. It
  stops accepting launches and cancels the reapers without signalling their
  children. It keeps its registrations until the runtime is dropped, so the
  survivors are still in the registry when ownership is frozen. A tool that
  exits in between leaves a dead identity, which matches nothing.
- **Embedded host.** The desktop does not kill server descendants
  (`ProcessTreeCleanup::EmbeddedHost`), so excluding survivors from the roots
  is enough there.

### Changes to existing methods

- **Review diff arguments.** `review_diff_args` adds `--full-index`. A
  `baseRef` that starts with `-` is refused with an invalid-request error;
  `git check-ref-format --branch` already forbids that form for branch names.
- **Context count.** `ReviewDiffPreviewInput`, the turn-diff input and the
  full-thread input gain `contextLines`: an optional integer from 0 to 99. When
  it is present the server adds `-U<N>`, built from the integer. Omitted, Git's
  own context applies (3, or `diff.context`), as today. Each result echoes the
  `contextLines` it applied: `ReviewSource.contextLines` and
  `ThreadTurnDiff.contextLines`, both `optionalKey`.
- **Exit reports.** `run_review_diff` passes its child's exit to
  `report_exit(Watch::Signals, …, requested)`. `requested` is `true` when the
  runner itself called `start_kill`, at the patch cap or after a capture
  failure; `classify_exit` then returns `Requested` and no `subprocess.crash`
  is recorded. A request dropped by cancellation kills Git through
  `kill_on_drop` and reports nothing, which is also correct.
- **Runner result.** `run_review_diff` also returns whether Git succeeded.
  `getDiffPreview` keeps today's empty source on failure. Turn patches use the
  status to report an error instead of `""`.
- **Live turn patches.** `orchestration.getTurnDiff` and `getFullThreadDiff`
  now work in this order:
  1. Acquire the thread's workspace admission with
     `WorkspaceAdmissionController::acquire_thread_with_origin`
     (`apps/server/src/production/workspace_availability.rs:59`), which also
     resolves the thread's worktree or project root. The lease is held until
     Git finishes. A workspace that is being removed, or is gone, returns
     `WorkspaceUnavailableError`.
  2. Resolve both checkpoint refs with `rev-parse --verify --quiet`.
  3. When both resolve, run
     `git diff --no-ext-diff --patch --minimal --full-index [--ignore-all-space]
     [-U<N>] <from-ref>^{commit} <to-ref>^{commit}` through `run_review_diff`,
     with the same cap and with the lease's loss cancellation joined to the
     request's. Workspace loss mid-read stops Git and returns
     `WorkspaceUnavailableError`.
  4. When either ref is missing, serve a stored `checkpoint_diff_blobs` row for
     the exact range, if there is one. Nothing at this commit writes such rows,
     so they can come only from older data; the fallback stays until a row
     count on real databases shows there are none to serve. A legacy row has
     short IDs and ignores the whitespace and context options, and the client
     says so.
  5. Otherwise return `OrchestrationGetTurnDiffError` (or
     `OrchestrationGetFullThreadDiffError`) with "The checkpoint for turn
     <n> is no longer in the repository."
  6. A non-zero Git exit that the runner did not cause returns the same error
     type with "Git couldn't compare these checkpoints (exit <code>).", never
     an empty patch.

  The two methods are registered with the admission controller as well as the
  engine (`orchestration_rpc.rs:236`).

- **Schema.** `ThreadTurnDiff` gains `truncated` and `contextLines`, both
  `optionalKey`; an older server omits them, which means `false` and Git's
  default. The turn and full-thread error unions in `rpc.ts` (`:1716`, `:1724`)
  gain `WorkspaceUnavailableError`.

### Persistence

- **`ClientSettingsSchema` and `ClientSettingsPatch`.** Each new key has
  `catchDecoding` and a decoding default:
  - `diffViewMode: "changes" | "compare"` (default `"changes"`);
  - `diffRenderMode: "stacked" | "split"` (default `"stacked"`);
  - `diffCompareLines: "all" | "changes"` (default `"all"`);
  - `diffCompareContextLines`: an integer from 0 to 99 (default 3);
  - `diffToolLastChoice: string | null` (default `null`).

  Wrap and whitespace keep their Settings-backed defaults.

- **`diffPanelStore`.**
  - `compareFileByThreadKey` is persisted.
  - `compareFiltersByThreadKey` (status, query) is memory-only, so a reload
    never opens Compare with files hidden.
  - `openCommentDraftBySection` is memory-only: the unsent comment and its
    text, lifted out of `AnnotatableCodeView` and `LocalCommentAnnotation`.
- **Default tool order:** the Git config default, then `diffToolLastChoice`,
  then the first tool listed. A choice the user makes in the menu is saved as
  the last choice.

### Client queries

- **Version reads** (`readFileVersion`) use a query family with
  `idleTtlMs: 0`, as Git Manager's do. Releasing the query interrupts a read
  in flight, and its result is dropped at once. Returning to a file reads it
  again.
- **Context patches.** A patch with `contextLines` (review or turn) uses its
  own query family, also with `idleTtlMs: 0` and the default family's 5 s
  `staleTimeMs`, so stepping N does not keep a multi-megabyte patch per value.
  The default patch keeps today's family and its retention, so Changes and
  **All lines** share it.

## Trust boundaries

| Input from the client     | Guard                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                     | `acquire_path` admission, as for `getDiffPreview`.                                                                                                                   |
| Turn reads                | Thread admission held through Git's exit; workspace loss cancels Git.                                                                                                |
| Object IDs                | Lowercase hex, 40 or 64 digits. An ID can be neither an option nor a path. It reads only that repository's object store, which grants no more than `getDiffPreview`. |
| Working-tree read path    | `resolve_relative` and `canonical_existing_within`. No absolute paths, no `..`, no symlink escape; a symlink returns `not-a-file`.                                   |
| `baseRef`                 | Leading `-` refused; resolved to a commit ID with `--end-of-options` before `difftool` runs.                                                                         |
| `contextLines`            | An integer from 0 to 99, checked on the server; the argument is formatted from the integer.                                                                          |
| `toolId`                  | `[A-Za-z0-9][A-Za-z0-9._-]*`, passed only as the value of `--tool=`. Git rejects unknown tools.                                                                      |
| Paths given to `difftool` | `resolve_relative` only (lexical, no filesystem check), after `--`, with literal pathspecs, so `:(top)` style magic does not apply.                                  |
| Turn revisions            | Built on the server from `threadId` and the turn counts; the client sends no ref names.                                                                              |

- **Scopes.** `readFileVersion` and `listDiffTools` need `review:write`, like
  `getDiffPreview`. `openDiffTool` needs `orchestration:operate`, like
  `shell.openInEditor`, because it starts a program on the server's computer.
- **Locality.** The local gate is client presentation. The server accepts
  `openDiffTool` from any authorized client, as it does `shell.openInEditor`.
- **Custom tools.** A `difftool.<tool>.cmd` runs shell from the user's own Git
  config, exactly as `git difftool` does in a terminal. Cloning does not
  transfer config.
- **Logs.** Profiler records carry the label `git-difftool` and no paths or
  command lines. The error's `command` goes only to the requesting client, for
  **Copy command**.

## Failure, cancellation, reconnect, concurrency

- **Switching file, scope, mode or N.** The previous query is released. With
  `idleTtlMs: 0` its fiber is interrupted at once and sends `Interrupt`
  (`docs/architecture/connection-runtime.md`); the server's token stops Git.
  Queries are keyed by environment, `cwd` and version (or context), so a late
  answer cannot land on another file.
- **Patch refresh while comparing.** The list is rebuilt. The selected path
  stays selected if it is still present; otherwise the first visible file is
  selected. New object IDs make new query keys.
- **`changed`.** The client revalidates the patch once, through the existing
  refresh request, and reads again. A second `changed` shows "This file is
  changing." with **Refresh**. An agent that keeps writing never causes a loop.
- **Hydration mismatch.** After hydration, the client checks every added and
  deleted line of every hunk against the loaded files, ignoring a trailing
  `\r`. This catches textconv drivers, since review diffs do not pass
  `--no-textconv`, and filters such as Git LFS. On a mismatch it keeps the
  hunk-only diff and says why.
- **Unavailable turn data.** A missing checkpoint without a legacy row, or a
  Git failure, shows its message in the panel's error line, never "No net
  changes".
- **Reconnect.** Queries re-run on a new connection generation.
  `openDiffTool` is a mutation and is never retried; a transport loss during
  the launch shows "Couldn't confirm that <tool> opened." with **Copy command**.
- **Server exit while a tool is open.** The tool keeps running in both embedded
  and standalone modes. Its log file stays in the OS temporary directory. If a
  Windows job forbids breakaway, the tool ends with BiBCode.
- **Workspace removed.** The panel shows the existing unavailable state. A
  turn read in flight is cancelled. On Windows, an open diff app whose working
  directory is the worktree makes removal fail with the existing in-use error.
- **Concurrency.**
  - Reads use the workspace permits.
  - At most 16 launches run at once.
  - Identical `listDiffTools` queries share one request.
  - The menu item is disabled while its own launch runs.
  - The N field commits after 300 ms without input.

## Performance

- **Rows.** File rows (path, status, +/− from hunk counts) are derived once per
  parsed patch. Filtering is O(M); the name filter uses `useDeferredValue`, and
  `WindowedList` draws fixed 28 px rows.
- **No re-parse.** Mode and filter changes never re-parse the patch
  (`renderablePatch` is memoized on the patch text and theme). A new N is a new
  patch and is parsed once.
- **One file in Compare.** Compare and Changes do not stay mounted together,
  so Compare holds one file's DOM and highlight.
- **Selected file.** At most two reads of up to 4.4 MB each are alive.
  Hydration runs once per file and version pair, and the hunk-only diff renders
  immediately while the full file loads. Pierre virtualizes the rows and
  highlights in the existing worker pool. `idleTtlMs: 0` frees the previous
  file when the selection moves.
- **Context.** **All lines** reuses the patch Changes loaded. **Changes only**
  with a context count costs one source diff per committed N, bounded by the
  same cap.
- **Server.** `getDiffPreview` gains only `--full-index` and an optional
  `-U<N>`. A blob read is one `cat-file`. A working-tree read is a bounded read
  plus one `hash-object`. `--tool-help` runs only when the menu is first
  opened.
- **Measure.** About 4,000 changed files and one 50k-line file: list scroll,
  file switch, a change of N, time to the first hunk and to the full file, on
  macOS, Linux and Windows, as in #119. Record the results in an execution
  report.

## Profiler coverage

- **Child processes.**
  - `cat-file`, `hash-object` and `--tool-help` run through `ProcessRunner`,
    which reports exits with `Watch::Signals`.
  - `run_review_diff` gains `report_exit(Watch::Signals, …, requested)`, with
    `requested` set when the runner killed Git itself. This covers review and
    turn patches and closes an existing gap.
  - `git difftool` is spawned by the new launcher, whose reaper calls
    `report_exit(Watch::Signals, Exited { kind: "command", label: "git-difftool", exe: "git", … }, …, false)`.
    The launcher registers it with `register_identity` as `External`/`Helper`
    with the label `diff app` and `survives_shutdown`, so the GUI app below it
    is not counted as BiBCode's memory and is not killed at shutdown.
- **RPC methods.** All three register through the workspace registry and the
  `rpc/session.rs` wrappers. `review.listDiffTools` (it probes about 30 tools;
  1.7 s measured) and `review.openDiffTool` (it waits up to 1 s on an external
  program) go into `is_long_running`. `readFileVersion` is local and is not.
  The turn methods keep their registration and gain only the admission
  controller.
- **Shutdown.** The launcher stops before ownership is frozen and long before
  the profiler's teardown. It cancels its reapers without signalling their
  children and keeps their registrations as survivors. `report_exit` records
  nothing once BiBCode is terminating.
- **Events and findings.** None are new. The `subprocess.crash` reference
  (`docs/skills/bibcode-profiler/references/findings.md`) and the
  [Profiler](../architecture/overview.md#profiler) section list the
  `git-difftool` label, which counts signals only, and say that a runner's own
  kill of a review diff is a requested stop.
- **Not affected:** worktree removal, binaries and re-exec modes.

## UI (against UI.md)

### Toolbar

- **Order:** scope, then base ref, then the **Changes | Compare** segmented
  control (text labels, with a visible selected state), then Stacked/Split
  (Changes only), wrap, whitespace and **Open with**.
- **Compare-only controls.** They live inside Compare, so the toolbar stays
  short in a narrow panel.
- **Preserved on a mode switch:** scope, base ref, selected file, filters and
  unsent comments.

### Compare layout

- **List column (240 px).**
  - Header: a name filter ("Filter files"; **Esc** clears it) and a status
    control: **All · Added · Modified · Deleted · Renamed**, one choice at a
    time.
  - Rows: the status letter with its word as the accessible name, the path
    with the file name emphasized, and +N −N in `text-xs` tabular figures.
  - The list is a `listbox`: Up and Down, Home and End, Page Up and Page Down
    move the selection.
  - With a filter on, the list says "N of M files". An empty result says "No
    files match these filters." with **Clear filters**.
- **Diff pane.**
  - Header: the path (`old → new` for a rename), **All lines | Changes only**,
    **Previous change** and **Next change**, and **Open with** for this file.
  - With **Changes only** selected, a labelled number field follows it:
    "Context lines", 0 to 99, default 3. It is hidden for **All lines**, where
    it has no effect. Against a server that does not echo `contextLines`, it
    is disabled with "Update the server to change context lines."
  - **Next change** is F7 and **Previous change** is Shift+F7: new
    `diff.nextChange` and `diff.previousChange` keybindings, active when the
    Diff panel has focus (`when: "diffFocus"`). At the ends, the buttons are
    disabled with "No more changes."
  - The view uses pierre's split style, so old and new stay aligned in one
    scroller, and it scrolls by line target (`CodeViewLineScrollTarget`).
- **Narrow panel.** Below 640 px (a container query), the list becomes a
  searchable file picker above the diff, with previous-file and next-file
  buttons, instead of squeezing three columns.
- **Surface rules.**
  - The divider is the `border` token.
  - Scroll wrappers carry `data-text-surface`.
  - No text is smaller than `text-xs`.
  - Light and dark come from tokens.

### File states

| State                            | Shown                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Changed, both versions loaded    | Full file, aligned.                                                                 |
| Loading                          | Changed lines at once, with "Loading full file…" in the pane header.                |
| Added or untracked               | The new file on the right, empty left (from the patch).                             |
| Deleted                          | The old file on the left, "Deleted" on the right (from the patch).                  |
| Pure rename                      | "Renamed from `<old>`. Contents unchanged."                                         |
| Mode change only                 | "File mode changed from 100644 to 100755."                                          |
| Binary                           | "Binary file. Use Open with to compare it in a diff app."                           |
| Submodule                        | "Submodule. Open it as its own project to compare."                                 |
| Over 4.4 MB                      | Changed lines, with "Too large to show in full (12.3 MB). Showing changed lines."   |
| Version gone (pruned checkpoint) | Changed lines, with "The full previous version is no longer in the repository."     |
| Checkpoint gone, no stored patch | The panel's error line: "The checkpoint for turn 4 is no longer in the repository." |
| Git failed on a turn             | The panel's error line: "Git couldn't compare these checkpoints (exit 128)."        |
| Legacy stored turn patch         | Changed lines, with "Saved before full files were kept. Showing changed lines."     |
| Filter or textconv mismatch      | Changed lines, with "Showing changed lines. Git transforms this file's diff."       |
| Still changing                   | "This file is changing." with **Refresh**.                                          |
| Patch truncated                  | The existing truncation banner; files past the cap are not listed.                  |
| Server without full IDs          | Changed lines, with "Full files need a newer server."                               |

### Open with

- **Header.** The menu header names the target: "Open `foo.ts` in" (Compare)
  or "Open all 42 files in" (Changes).
- **Items.** The detected apps follow, with the default marked **Default**. In
  Compare, **All files in `<default>`** follows a separator.
- **All files** is hidden for `vscode`, whose `--diff` takes only two files
  ([VS Code CLI](https://code.visualstudio.com/docs/configure/command-line)).
- **Launch.** The item shows a spinner for up to 1 s. Success shows nothing
  more.
- **Failure.** An inline alert under the toolbar: "Couldn't open `<tool>`."
  with Git's message and the exit code, **Copy command** and **Dismiss**.
- **Disabled reasons**, all visible:
  - Remote environment: "Available for threads on this computer. This thread
    runs on `<environment>`."
  - No tool found: "No diff app found. Install one, or set `git config
    diff.tool`."
  - Untracked file: "Untracked file. Stage it to compare it in a diff app."
  - Older server: "Update the server to use Open with."
  - While the list loads, the item reads "Finding diff apps…".

## Files to change

- **Contracts.**
  - `packages/contracts/src/review.ts`: the three methods and their errors,
    and `contextLines` on the preview input and `ReviewSource`.
  - `rpc.ts`: method names and groups, and `WorkspaceUnavailableError` in the
    two turn-diff error unions.
  - `settings.ts`: five keys.
  - `orchestration.ts`: `contextLines` on both turn-diff inputs, and
    `ThreadTurnDiff.truncated` and `.contextLines`.
  - `keybindings.ts`: two commands.
  - `packages/shared/src/keybindings.defaults.json`: their defaults.
- **Client runtime.**
  - `packages/client-runtime/src/state/review.ts`: the version query and the
    context-patch query (both `idleTtlMs: 0`), the tools query and the launch
    command.
  - `state/orchestration.ts`: the turn context-patch query (`idleTtlMs: 0`).
- **Web.**
  - `apps/web/src/components/DiffPanel.tsx`: the toolbar, the mode switch and
    persistence.
  - New `components/diffs/DiffCompareView.tsx`, `DiffFileList.tsx` and
    `DiffOpenWithMenu.tsx`.
  - New `lib/diffCompareModel.ts`: rows, filters, version requests per file,
    hydration and the consistency check.
  - `diffs/AnnotatableCodeView.tsx` and `files/LocalCommentAnnotation.tsx`:
    the lifted draft.
  - `diffPanelStore.ts`, `state/review.ts` and `keybindings.ts`.
- **Server.**
  - `apps/server/src/review/mod.rs`: trait methods and types, and
    `contextLines` on `ReviewDiffPreviewInput`.
  - `production/runtime.rs`: the arguments, the runner's status and exit
    report, the read and list backends, and the launcher's place in
    `quiesce_for_update`.
  - New `production/diff_tool.rs`: the launcher, the reaper, the cap and the
    shutdown hook.
  - `diagnostics/registry.rs`: `survives_shutdown` and the split snapshot;
    every existing `ProcessRegistrationMetadata` site sets it to `false`.
  - `diagnostics/native.rs`: `RuntimeProcessOwnership.survivors` and the
    pruned `cleanup_descendants`.
  - `production/server_terminal.rs`: passing survivors to standalone cleanup.
  - `workspace/rpc.rs`: dispatch and the method list at `:46`.
  - `production/workspace_preview.rs`: the method list at `:43`.
  - `rpc/methods.rs`, `auth/scope.rs` and `diagnostics/profiler/latency.rs`.
  - `production/orchestration_rpc.rs`: live turn patches, the inputs, and the
    admission controller in the turn methods' registration.
- **Docs.**
  - `docs/user/workspace-ui.md`: the Diff surface and Current limitations.
  - `docs/user/keybindings.md`.
  - `docs/architecture/rpc-and-orchestration.md`: a new "Diff Compare and Open
    with" section, and turn patches computed live under admission.
  - `docs/architecture/overview.md`: the Profiler section and the shutdown
    survivors rule.
  - The profiler `findings.md` reference.
  - `docs/testing/cross-platform-validation.md` and the macOS, Linux and
    Windows desktop runbooks.

## Test plan (each fails before its change)

**Server**, with temporary repositories.

1. Live turn patches:
   - `getTurnDiff` returns the patch between two checkpoint refs with full IDs,
     honours `ignoreWhitespace` and `contextLines` (`-U0` and `-U7` give
     different hunks), echoes `contextLines`, and reports `truncated` at the
     cap. It returns `""` today.
   - A missing `from` ref with a stored row for the range returns the row; with
     no row it returns `OrchestrationGetTurnDiffError` with the checkpoint
     message.
   - A Git failure (a checkpoint ref that points at a blob) returns an error,
     not `""`.
   - Removal race: a read whose Git is paused when worktree removal begins is
     cancelled and returns `WorkspaceUnavailableError`, and no Git process
     remains; a read after removal is refused before Git starts.
2. Review diffs carry full IDs and honour `contextLines`; 100 and −1 are
   refused. A `baseRef` of `--output=<tmp>` is refused, and no file is written.
3. Review-diff exit reports, with the profiler's capture: a kill at the cap and
   a capture failure record no `subprocess.crash`; Git killed from outside with
   SIGKILL still records one.
4. `readFileVersion` with `blob`:
   - the old blob ID of a modified file, of a deleted file and of a renamed
     one, and a blob only a checkpoint holds, return their text;
   - an unknown ID returns `missing`;
   - a tree or commit ID returns `not-a-file`;
   - a file over the cap returns `too-large`, and one with a NUL returns
     `binary`;
   - a malformed ID (short, uppercase, `--x`) returns `invalid-request`;
   - a cancelled token interrupts and leaves no child behind.
5. `readFileVersion` with `worktree`:
   - a matching ID returns `text`;
   - an edit after the patch returns `changed`;
   - under `core.autocrlf=true`, a CRLF file still matches;
   - `../x`, an absolute path and a symlink to outside the root are refused;
   - a symlink returns `not-a-file`, and a deleted file returns `missing`.
6. The `--tool-help` parser, against C-locale fixtures:
   - it keeps GUI built-ins and custom tools, and drops `vimdiff` and the
     unavailable section;
   - it resolves the default in Git's order.
7. `difftool_args` for each scope and target: `--trust-exit-code`, dir-diff,
   renames and literal pathspecs; `..` and absolute paths are refused.
8. Launches through the real `git difftool`, with fake `difftool.<id>.cmd`
   tools that write their arguments and both files' contents to a log:
   - `sleep 5` returns `opened`;
   - `exit 3` returns `launch-failed` with stderr: exit 128 for a file and 3
     with `--dir-diff`;
   - a working-tree deletion, a rename whose old path is gone, and a branch or
     turn file absent from the checkout each reach the tool with the right
     contents;
   - the 17th launch returns `too-many-open`;
   - the reaper reports signals.
9. Shutdown, through the full `ProductionRuntime` quiesce in both
   `ProcessTreeCleanup` modes: a fake tool running `sleep 30` and its child are
   still alive afterwards, an ordinary registered helper started beside it is
   killed, and a launch after shutdown began returns `shutting-down`.
10. Registration: the scope tests, the `is_long_running` test and
    `rpcRustParity.test.ts` list the new methods.

**Web and client runtime**, in Vitest.

1. Persistence across a restart: next to the hydration tests in
   `hooks/useSettings.test.ts`, write the mode, render mode, line filter and N
   through `useUpdateClientSettings` and the real browser persistence used by
   `clientPersistenceStorage.test.ts`, reset the module's snapshot, hydrate a
   fresh client and read the same values back. `DiffPanel.test.tsx` also
   checks that a remount keeps them. Today Stacked/Split resets.
2. `diffCompareModel`:
   - rows and counts from a parsed patch, the status and case-insensitive name
     filters, and "N of M";
   - version requests per scope (working tree: a blob plus the working file;
     branch and turn: two blobs);
   - no request for added, untracked, deleted, pure-rename, submodule, binary
     and mode-only files, each with its reason;
   - abbreviated IDs give the hunk-only fallback.
3. The consistency check: matching files hydrate; a textconv fixture falls
   back; CRLF is tolerated.
4. Query lifetime, through the real query runtime in `client-runtime`:
   selecting file B while A's read is in flight sends `Interrupt` for A, and
   once A is released no result for A stays in the registry. The same holds
   for the context patch when N changes.
5. Compare: selecting a file requests its versions; `changed` revalidates
   once, then shows the interstitial; **Changes only** requests the patch with
   the stored N, **All lines** reuses the default patch; a turn error shows its
   message, not "No net changes"; an unsent comment survives a mode switch
   (today it is lost); Up and Down select; F7 scrolls to the next hunk.
6. Open with:
   - each disabled reason;
   - the default order;
   - a failure shows Git's message and **Copy command**;
   - a success shows no dialog.
7. Real pierre in happy-dom, next to
   `files/pierreEditProvider.integration.test.tsx`: `hydratePartialDiff` on a
   real patch renders every line with **All lines**, and collapsed gaps with
   **Changes only**, for a `-U0` and a `-U7` patch.
8. Contracts: settings decode defaults and recover from bad values, including
   N out of range; the inputs and results round-trip `contextLines`; and
   `check:contracts` regenerates the fixtures.

## Verification

- **Gates:** focused Rust and web tests, `cargo fmt --all --check`, Clippy on
  the server with warnings denied, `vp check` and `vp run typecheck`.
- **Reviews:** `UI.md`, and `vercel-react-best-practices` (virtualization, no
  re-parse on filter, derived state, deferred filter input).
- **Manual:**
  - Beyond Compare and FileMerge on macOS, Meld and KDiff3 on Linux, WinMerge
    on Windows;
  - Compare in an SSH environment works, and its Open with is disabled with
    the reason;
  - in the packaged app, choose Compare, Split, **Changes only** and 7 context
    lines, quit and relaunch: all four are restored;
  - quitting the desktop app, and stopping a standalone server, leave an open
    diff app running;
  - a turn diff in a thread captured by this server shows its changes.
- **Performance:** the measurements above.

## Rollout

Three steps, each with its tests.

1. Live turn patches under admission, with their error cases, `--full-index`,
   `contextLines`, the `baseRef` guard and the review-diff exit report. These
   fix today's empty turn diffs on their own.
2. `readFileVersion` and Compare, with the context field.
3. Open with, with the shutdown survivors.

Version skew:

- A client talking to an older server sees abbreviated IDs and shows Compare
  hunk-only, with its reason.
- An older server ignores `contextLines` and does not echo it, so the context
  field is disabled with its reason.
- An older server serves only stored turn patches and never returns
  `WorkspaceUnavailableError` for them.
- An unsupported `listDiffTools` disables Open with, with its reason.
- An older client ignores the new fields.

## Risks

- **Turn patches change source.** They move from stored rows to live Git under
  admission. Legacy rows are still served when the refs are gone.
- **`--full-index`** changes every `diffHash` once, so caches miss once.
- **Context patches** re-diff the whole source once per committed N, and again
  after a mode switch, because their queries are not retained. A slow relay
  pays that cost each time.
- **`--tool-help` format.** Its output is not a documented interface. The
  parser is tolerant, and if Git succeeds but nothing parses, the configured
  `diff.tool` is still offered.
- **Launchers that return at once.** A tool that returns at once lets Git
  delete the pre-image before the tool reads it. Git's built-ins wait
  (`code --wait`); custom commands may not. A terminal-only custom tool seems
  to do nothing.
- **Exit codes.** With `--trust-exit-code`, a tool that exits non-zero within
  the first second to mean "differences found" is reported as `launch-failed`,
  with its exit code. Later exits are only logged.
- **Survivors.** A diff app outlives BiBCode by design. A Windows job that
  forbids breakaway still ends it with BiBCode.
- **Review sources on Git failure.** `getDiffPreview` still returns an empty
  source when Git fails (for example, a base ref that does not exist), and the
  panel then says "No net changes". This change does not alter it; it should
  get its own issue.
- **Comments outside the patch.** A comment on a context line outside the
  patch's hunks is shown only in Compare, because Changes cannot place it.
- **Size cap.** The 4.4 MB cap per side sends some files to the hunk-only view,
  and 4.4 MB per side is slow on a remote relay. That cost comes only on
  selection, the hunk view comes first, and returning to a file reads it again.
- **Windows worktree removal** fails while a diff app holds the worktree as its
  working directory.

## Review

Codex's critique of the first draft, checked against the source:

1. **Configurable ±N dropped (blocking). Accepted.** Issue #140's acceptance
   criteria require **Changes only (±N)** and a remembered context count.
   Pierre cannot narrow context, so N now reaches Git as `-U<N>` through an
   optional `contextLines` on the existing diff requests (H). N is the fifth
   `ClientSettings` key and is covered by restart tests.
2. **Detaching does not survive shutdown (blocking). Accepted.** Freezing
   takes every registration as a root (`registry.rs:144`), and a standalone
   server kills every descendant (`server_terminal.rs:453`). Added
   `survives_shutdown`, survivors pruned from standalone cleanup, launcher
   shutdown before the freeze, Windows breakaway, and a full-runtime test in
   both modes.
3. **Existence check blocks historical paths (major). Accepted.**
   `canonical_existing_within` canonicalizes the target (`paths.rs:63`).
   Difftool paths are now lexical only; the working-tree read keeps the check
   and maps NotFound to `missing`. Added launch tests for deletions, renames
   and historical-only files.
4. **No `--trust-exit-code` (major). Accepted.** Measured with Git 2.54: an
   `exit 3` tool gives exit 0 by default. The flag is added, and test 8 runs
   the real `git difftool`.
5. **Released queries are kept for five minutes (major). Accepted.** The
   default is five minutes (`runtime.ts:745`). Version reads and context
   patches use `idleTtlMs: 0`, with a lifetime test through the real query
   runtime.
6. **Unavailable comparisons shown as clean (major). Accepted.** The runner
   turns non-zero exits into `""` (`runtime.rs:1245`). Turn reads now follow a
   stated precedence and return typed errors for a missing checkpoint and for
   Git failures. `getDiffPreview`'s same behavior is left as a stated
   limitation, because changing it is outside this issue.
7. **Turn reads skip workspace admission (major). Accepted.** Turn queries
   are registered with the engine alone (`orchestration_rpc.rs:236`). They now
   hold thread admission through Git's exit, cancel on workspace loss and
   return `WorkspaceUnavailableError`, with a removal-race test.
8. **The runner's own kill reads as an OOM death (minor). Accepted.**
   `classify_exit` marks SIGKILL as likely OOM unless `requested`
   (`exits.rs:211`). `requested` is now set when the runner kills Git, with
   tests for both cases.
9. **Persistence not proven across restart (minor). Accepted.**
   `DiffPanel.test.tsx` mocks settings (`:161`). Added a hydration test
   through the real persistence path and a packaged restart scenario.

**Simpler alternative. Mostly adopted.** The design already reuses `DiffPanel`
and `AnnotatableCodeView`, renders one file in Compare and lifts unsent drafts
into the panel's store. It now carries N on the existing diff requests, with
no new diff RPC and no re-diff in the browser, and keeps Git-owned launching
with the lifecycle and exit-code fixes above.
