# Git Manager — Master Plan

> **SUPERSEDED (2026-08-31).** This plan was never implemented—every phase in
> its tracker remains `pending`, and no shipped work was executed from it. The
> current code may contain overlapping Git Manager concepts and RPCs, but those
> were implemented from its replacement. This plan has been superseded in full
> by `docs/plans/git-manager/`, which specifies a GitHub-Desktop-shaped Git
> Manager including the working directory, staging,
> commit, stash, history rewriting and conflict resolution — all of which this
> plan explicitly excluded. Its verified technical findings (tip-pinned history
> paging, the status-broadcaster generation signal, reuse of the worktree
> catalog's repository lock, the server-authored guard module, and the RPC
> wire-fixture count gate) were carried forward. Retained as historical
> evidence only; do not execute it.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan phase-by-phase. Run `/decompose-plan docs/superpowers/plans/2026-08-18-git-manager` first to turn the Implementation Outline below into atomic phase files.

**Goal:** Give every BiBCode project a Fork-style Git Manager — a project-scoped center-panel view with a ref tree (branches, remote branches, tags, worktrees), a lane commit graph with commit detail and diffs, and fetch/pull/push/merge/branch/tag operations with server-enforced guards.

**Architecture:** The Rust server stays the single Git authority: it pages the commit DAG, computes ref metadata *and* every blocking condition, serializes mutating operations per repository, and streams operation progress. The React client renders — lane layout, virtualization, dialogs — and never re-derives Git policy. All traffic uses the existing typed WebSocket RPC; no `DesktopBridge` work, no new dependencies.

**Tech Stack:**

- **Rust / Axum / Tokio** — `apps/server`: git process execution, RPC handlers, broadcaster. Build `cargo build -p bibcode-server`; tests `cargo test -p bibcode-server`; lint `cargo clippy -p bibcode-server --all-targets -- -D warnings`; format `cargo fmt --all --check`. Conventions: `AGENTS.md` (repo root), existing modules under `apps/server/src/git/`.
- **TypeScript / Effect Schema** — `packages/contracts`: schema-only wire contracts. No runtime logic in this package.
- **React 19 / Vite+ / TanStack Router / zustand** — `apps/web`: UI. Checks `vp check`, `vp run typecheck`, `vp test <path>`. Existing libraries to reuse: `@base-ui/react` (dialogs, tooltips), `@legendapp/list` (virtualization), `@pierre/diffs` (diff rendering), `lucide-react` (icons), `zustand` (panel state).

**Spec:** [`issue.specs`](issue.specs) in this folder, including its appended `## Interview Notes`.

**Screenshots:** [`screenshots/`](screenshots/) in this folder — the Fork UI this feature is modelled on (see § Attachments).

---

## Global Constraints

- Privileged desktop operations cross `DesktopBridge`; **normal application traffic uses typed HTTP/WebSocket RPC in both browser and desktop modes**. Everything in this plan is RPC — nothing here is a bridge command.
- `packages/contracts` is **schema-only**. No runtime logic, no helpers with behavior.
- The server is authoritative for paths, repository identity, Git membership, availability, and destructive decisions (see `docs/architecture/worktree-catalog.md`). Clients address projects by scoped refs and receive display state; **React must not re-implement Git policy**.
- Every new live RPC method needs exactly one declared scope in `apps/server/src/auth/scope.rs` — a server test fails otherwise.
- **Log hygiene:** no internal context in log strings. Branch names, ref names, absolute paths, remote URLs, and Git stderr text must not be interpolated into log messages; log stable codes plus lengths/counts, mirroring `GitCommandError` (which carries `stdoutLength`/`stderrLength`, not the text). User-facing text is a payload field, not a log line.
- Git subprocesses must stay non-interactive. `git_environment()` (`apps/server/src/git/repository.rs:4258`) already sets `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GIT_CONFIG_NOSYSTEM=1`. Every new network operation must go through it — a credential prompt must fail fast, never hang a server task.
- All new Git process invocations run through the existing supervised process path (`apps/server/src/git/process.rs`) with a timeout, an output cap, and a cancellation token.
- Performance and reliability first: paged reads, bounded output, bounded memory, cancellable operations, predictable behavior on reconnect and restart.
- Living documentation changes ship in the same patch as the behavior change (`AGENTS.md` → Evidence and Documentation, Testing Runbook Maintenance).

---

## Context

BiBCode users manage worktrees and threads in the app, but every real Git inspection — "what landed on develop", "which branch has a worktree", "why can't I check this out" — happens in an external client. This plan adds an in-app Git Manager scoped to a single project so branch/tag/history work stays where the worktrees and threads already are.

Source of truth for scope: [`issue.specs`](issue.specs) (author's own words) plus the interview appended to it on 2026-08-18. The user-visible outcome: a new icon button on each project card in the left panel opens a Git Manager for that project in the center panel; it shows branches, remote branches, tags and worktrees, a commit graph with detail and diffs, and can fetch, pull, push, merge, create/checkout branches, and manage tags — with every blocked action explaining itself on hover.

---

## Pre-flight Checklist

**Always:**

- [ ] Read [`issue.specs`](issue.specs) in full, including `## Interview Notes`.
- [ ] Read `AGENTS.md` at the repository root.
- [ ] Read every doc under § Related Docs.
- [ ] Run `git status --short` and preserve unrelated working-tree changes.
- [ ] Look at [`screenshots/`](screenshots/) — they define the intended shape of the toolbar, ref tree, graph, commit detail tabs, and dialogs.

**Rust block:**

- [ ] Read `apps/server/src/git/mod.rs`, `model.rs`, `parser.rs`, `process.rs` before adding a new Git command; follow the existing request/parse/error shape.
- [ ] Read `apps/server/src/production/git_vcs.rs` around `GIT_VCS_STREAM_METHODS` (line ~192) and the `git.runStackedAction` handler (line ~988) — that is the streaming-operation precedent this plan follows.
- [ ] Confirm `rust-toolchain.toml` toolchain is installed.

**React block:**

- [ ] Read `apps/web/src/components/CreateWorktreeDialog.tsx` for the dialog + RPC-command pattern, and `apps/web/src/state/vcs.ts` for the VCS atom bindings — note that file is a thin wrapper over the atoms in `@bibcode/client-runtime/state/vcs`, so the Git Manager's read layer belongs in the same shape (client-runtime atoms wrapped locally), not in raw zustand. Zustand holds only panel/view state.
- [ ] `@pierre/trees` is already a dependency (`apps/web/package.json`). Evaluate it for the ref tree before hand-rolling one; if a bespoke component wins (the four sections have per-row actions and guard states), record why in the phase notes rather than leaving the choice unexplained.
- [ ] Read `apps/web/src/centerPanelStore.ts` — note it is **thread-keyed**; the Git Manager introduces the first *project-keyed* center surface and must not be forced into that store.
- [ ] Check `apps/web/package.json` before adding anything: `@legendapp/list`, `@pierre/diffs`, `@base-ui/react`, `zustand` are already present. **No new dependency is permitted by this plan.**

**Contracts block:**

- [ ] Read `packages/contracts/src/git.ts` and `rpc.ts`; every new method needs a `WS_METHODS` entry, an `Rpc.make(...)`, and membership in the exported RPC group.

---

## Why

Branch and history work currently forces users out of BiBCode into Fork/CLI, which also means BiBCode cannot warn them that a branch is already checked out in a worktree — the one failure this app is uniquely positioned to prevent. Keeping the Git surface inside the app makes worktree-aware guards possible and removes the context switch.

---

## Out of scope

- **Local changes, staging, commit, discard** — explicitly excluded by `issue.specs`; the existing thread-scoped source-control UI owns that.
- **Stash and submodules** — explicitly excluded by `issue.specs`.
- **Rebase (plain or interactive), cherry-pick, revert, reset, blame** — visible in the reference screenshots, never requested; excluded.
- **Any worktree mutation** (create/remove/move from this panel) — `issue.specs` says worktrees are listed read-only with their path; creation stays with the existing New-worktree flow.
- **Checking out a branch that already has a worktree** — permanently blocked in v1, colour-marked with a tooltip.
- **Remote branch deletion and remote tag deletion** — v1 deletes local refs only; a remote delete is a separate, riskier decision.
- **Conflict resolution UI** — no local-changes surface exists here, so conflicts are resolved by abort or by leaving the repository conflicted for an external tool (user's explicit choice).
- **Multiple Git Managers visible at once** — one project view at a time; state for the two most recent projects is cached.

---

## Technical Requirements

### Contracts (`packages/contracts`)

- A commit-graph page carries, per commit: `sha`, `shortSha`, `parents` (ordered), `refs` (decorations with kind), `subject`, `authorName`, `authorEmail`, `authoredAtMs`, `committedAtMs`. Today's `VcsCommit` has neither parents nor decorations and must not be changed in place — existing callers depend on it.
- A refs snapshot carries local branches (with `upstream`, `ahead`, `behind`, `tipSha`, `isCurrent`, `isDefault`, `worktreePath`), remote branches (with `hasLocalTracking`), tags (with `targetSha`, `isAnnotated`), worktrees (path, branch, primary flag, missing flag), plus repository-level `headRef`, `detachedHeadSha`, `isDirty`, `defaultBranch`, `remotes`, and the currently running operation if any.
- Every ref carries a list of **blocked reasons** — `{ operation, code, message }` — authored by the server. `message` is the tooltip text the UI renders verbatim.
- Both reads carry a monotonically increasing `generation` so the client can tell that the repository moved. A bump means "fetch what is new and splice it above the pinned snapshot" — not "throw away what is loaded"; see the paging rule under § Server.
- One streaming mutation RPC accepts a tagged union of operations (fetch, pull, push, merge, resolve-merge, create-branch, checkout, create-tag, delete-branch, rename-branch, delete-tag) and emits `started` / `output` / `conflict` / `finished` / `failed` events with a stable failure code.
- Commit diffs are served by a **read-scoped** `vcs.commitDiff` that reuses the review pipeline's diff production and truncation policy. It cannot go through `review.getDiffPreview`: that method is mapped to `SCOPE_REVIEW_WRITE` (`apps/server/src/auth/scope.rs:109`), and browsing history read-only must not require a write scope.

### Server (`apps/server`)

- Graph paging uses one `git log` invocation per page with an explicit record/field separator, bounded by `limit` (max 1000, default 500), and output goes through the supervised process path with a cap.
- **Pages are pinned to a tip snapshot, not to `--all`.** A raw `--skip N` cursor is unstable: one new commit at the top shifts every later page by one, and with a 3-second ref tick and agent threads committing continuously a deep-scrolled user would see constant duplication or gaps. The first request resolves the current ref tips for the requested scope and returns them; every subsequent page passes those tips back, so the server runs `git log <tip…> --skip N` against a fixed set of starting points and offsets stay valid however much the repository moves. When the generation bumps, the client **splices the new commits above the pinned snapshot** rather than discarding loaded pages, so scroll position and selection survive; a full reset happens only when the user explicitly refreshes or the pinned tips can no longer be resolved (for example after a forced update or a pruned branch). The tip list is capped (500 refs); a repository above the cap falls back to `--all` paging and accepts reload-on-bump, which the UI must state rather than silently degrade.
- Ref enumeration uses `git for-each-ref` plus the worktree inventory the catalog already owns; it must not shell out once per ref.
- Blocked reasons are computed in **one** pure module and returned with the refs snapshot. The client never derives them.
- Mutating operations serialize per repository through the **worktree catalog's existing repository lock** (`apps/server/src/worktree_catalog/service.rs:1505-1569`, which already takes a project lock and then an optional repository lock keyed by the canonicalized common directory). The Git Manager does **not** introduce a second, independent lock: a push or merge and a worktree add/remove on the same physical repository must never interleave, and one arbiter is the only way to guarantee that. Acquisition follows the catalog's existing ordering (project lock, then repository lock) so no new deadlock ordering is created. A second operation is rejected with the `operation-in-flight` code, never queued silently.
- Mutating operations run under the existing workspace availability admission (`guard_git_path`) and a child cancellation token, so client interrupt and server shutdown both stop the git process.
- Merge: if the working tree is dirty the operation is refused before starting. If the merge conflicts, the server emits `conflict` with the conflicted paths and **stops without deciding**; the client sends a follow-up `resolveMergeConflict` operation with `abort` or `keep`.
- A pending merge survives reconnects and restarts, so it must be observable from state, not only from the event stream: the refs snapshot reports `mergeInProgress` (derived from `MERGE_HEAD`) plus `conflictedPaths` (`git diff --name-only --diff-filter=U`). Whenever `mergeInProgress` is true the panel shows the resolve affordance — on a fresh load, after a reconnect, or after the user dismissed the dialog — and every other mutating operation is blocked with a reason naming the pending merge.
- `resolveMergeConflict` is **exempt from the dirty-working-tree guard** and is the only operation accepted while `mergeInProgress` is true; without that exemption the resolution path would block itself.
- Streaming `pull` and `push` must go through the same `GitRepository` methods that back `vcs.pull` and `push_current_branch` (`apps/server/src/git/repository.rs:2727-2760`) rather than re-implementing remote policy in `operations.rs`. Note the gap those methods leave: `push_current_branch` takes only `cwd` and a cancellation token, hardcodes `origin` in its set-upstream path, and has no `remote`, `force` or `pushTags` parameter. Supporting the plan's Push dialog therefore means **extending that method (or adding a sibling next to it) in `repository.rs`** — keeping remote policy in the module that owns it — not copying its body into the operations executor.
- Network failures are classified: an authentication/credential failure surfaces as `authentication` (with the "configure a credential helper or SSH agent" hint in the payload message), a rejected push as `non-fast-forward`, cancellation as `cancelled`.
- Change detection extends the existing `StatusBroadcaster` (`apps/server/src/git/broadcaster.rs`) with a cheap refs/HEAD/worktree signature per repository — **no additional poller task and no new watcher subsystem** — exposed as a stream that emits a new `generation` when the signature changes. Own mutations trigger the existing immediate-refresh request path on completion. Three facts about the existing implementation shape this work: `RepositoryState` (`broadcaster.rs:43-49`) today holds only `local`, `remote`, `subscribers`, `local_refresh_requests` and `poller_cancellation`, so the signature and generation are **new fields**; there are already **two** poller tasks per repository (`spawn_local_status_poller` and `spawn_remote_and_ref_poller`, spawned together at `broadcaster.rs:158-163`), so the signature check belongs on the existing ref tick rather than anywhere new; and both are started only when the first subscriber arrives, so `subscribeVcsGraph` must trigger that same subscribe-driven start even when no status subscriber exists. The ref tick is `REF_REFRESH_INTERVAL = 3s` (`apps/server/src/production/git_vcs.rs:40`), which is the worst-case staleness for an external change.
- Every new method is registered in exactly **six** places: `WS_METHODS` + `Rpc.make` + group (`packages/contracts/src/rpc.ts`), the **checked-in wire fixtures** (see below), dispatch (`apps/server/src/production/git_vcs.rs`), `ACTIVE_RPC_METHODS` (`apps/server/src/rpc/methods.rs`), `required_scope` (`apps/server/src/auth/scope.rs`), and — for read-only methods — the maintenance allowlist (`apps/server/src/maintenance.rs`). Streaming methods also join `GIT_VCS_STREAM_METHODS`.
- **The wire fixtures are a hard gate, not an afterthought.** `packages/contracts/src/rpcRustParity.test.ts:359` asserts `manifest.methods` equals the list derived from the live RPC group, and `packages/contracts/fixtures/rpc-wire/manifest.json` currently pins **95** methods. The regeneration script `packages/contracts/scripts/export-rust-rpc-fixtures.ts:707-731` additionally hard-throws unless the counts match its hardcoded expectations (95 methods, 16 streams, 224 typed-failure fixtures, 23 orchestration event shapes) and the stale-identifier list is exactly `["projects.add", "projects.list", "projects.remove"]`. Adding this feature's six methods (two of them streaming) therefore requires regenerating the fixtures **and** bumping those hardcoded numbers in the same change — 95 → 101 methods, 16 → 18 streams, plus whatever the typed-failure and stream-shape counts become. Without that step the contracts phase fails `vp test` on its own gate.

### Web — routing and visibility (`apps/web`)

- A new project-scoped route renders the Git Manager as the center surface: `/_chat/project/$environmentId/$projectId`.
- The new project-card button navigates to that route. Navigating to any thread route hides the view (route change, not a modal dismissal). Clicking a project card whose project view was previously opened navigates back to it **and** keeps today's expand/collapse behavior.
- A `gitManagerStore` (zustand) caches per-project view state — selected ref, selected commit, filter text, loaded pages, scroll anchor — for the **two** most recently used projects (LRU); a third eviction drops the oldest. On return the cached state paints immediately and revalidates in the background.
- The button appears for projects in every environment (local, desktop-local sandbox, remote). When the environment is disconnected the view shows an unavailable state instead of erroring.

### Web — components

- Ref tree sections: Branches, Remotes, Tags, Worktrees. A branch that owns a worktree is colour-marked and its checkout action disabled; hovering shows the server's reason text, which names the worktree path.
- The commit graph is virtualized (`@legendapp/list`) with an SVG lane layer. Lane assignment lives in a **pure, incremental** module so appending a page never relayouts earlier rows and can be unit-tested without React.
- The commit detail pane shows metadata, parents, refs, the changed-file list, and the diff of the selected file rendered with `@pierre/diffs` through the existing helpers in `apps/web/src/lib/diffRendering.ts`.
- An inline progress banner shows the running operation, a cancel button, and a collapsible full-output area streaming stdout/stderr. Failures stay pinned until dismissed.
- Destructive dialogs (force push, delete branch, delete tag, rename) require an explicit confirm step and state exactly what will happen.
- Accessibility: every icon-only control has an `aria-label`; disabled controls expose their reason via tooltip **and** `aria-describedby`; the graph list is keyboard-navigable.

---

## Implementation Outline

Seven phases. Each phase ends with a working, testable increment and its own tests. Phases 1–2 must land in order; 3, 4 and 5 can proceed in parallel once 2 lands; 6 depends on 5; 7 depends on 5.

### Phase 1 — Contracts and server reads

**Files**

- Modify: `packages/contracts/src/git.ts` (graph, refs, commit-detail schemas), `packages/contracts/src/rpc.ts` (`WS_METHODS`, `Rpc.make`, group), `packages/contracts/src/git.test.ts`.
- Create: `apps/server/src/git/graph.rs` (paging + `for-each-ref` parsing), `apps/server/src/git/guards.rs` (pure blocked-reason computation).
- Modify: `apps/server/src/git/mod.rs`, `apps/server/src/git/repository.rs` (thin methods delegating to `graph.rs`), `apps/server/src/production/git_vcs.rs`, `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `apps/server/src/maintenance.rs`.

**Interfaces produced**

```ts
// packages/contracts/src/git.ts
export const VcsGraphRefKind = Schema.Literals(["local-branch", "remote-branch", "tag", "head"]);
export const VcsGraphRefBadge = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: VcsGraphRefKind,
});
export const VcsGraphCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  shortSha: TrimmedNonEmptyString,
  parents: Schema.Array(TrimmedNonEmptyString),
  refs: Schema.Array(VcsGraphRefBadge),
  subject: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAtMs: NonNegativeInt,
  committedAtMs: NonNegativeInt,
});
export const VcsListCommitGraphInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: Schema.optional(Schema.Literals(["all-refs", "current-branch"])),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(1000))),
  cursor: Schema.optional(NonNegativeInt),
  // Tip snapshot from the first page. Omit on the first request; pass the
  // result's `tips` back on every later page so `--skip` offsets stay valid
  // while the repository moves underneath. Capped at 500.
  tips: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500))),
});
export const VcsListCommitGraphResult = Schema.Struct({
  commits: Schema.Array(VcsGraphCommit),
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  generation: NonNegativeInt,
  // The pinned tips this page was produced against; echo them back for the
  // next page. Empty when the repository exceeded the cap and the server fell
  // back to unpinned `--all` paging (the UI must surface that).
  tips: Schema.Array(TrimmedNonEmptyString),
  tipsPinned: Schema.Boolean,
});

// One kind per operation tag in GitRepositoryOperation (Phase 5), plus force-push,
// which is `push` with force = true. Used by blocked reasons and runningOperation.kind.
// The kinds stay kebab-case (matching VcsGraphBlockedCode) while the operation
// payload tags stay camelCase (matching the `_tag` convention elsewhere in the
// contracts). ONE place owns the translation: the operation executor in
// `apps/server/src/git/operations.rs` exposes `fn operation_kind(&GitRepositoryOperation)
// -> VcsGraphOperationKind`, which also maps `push { force: true }` to `force-push`.
// Guards and the running-operation summary both call it; nothing re-derives it.
export const VcsGraphOperationKind = Schema.Literals([
  "fetch", "pull", "push", "force-push", "merge", "resolve-merge-conflict",
  "checkout", "create-branch", "create-tag",
  "delete-branch", "rename-branch", "delete-tag",
]);
export const VcsGraphBlockedCode = Schema.Literals([
  "worktree-checked-out", "dirty-working-tree", "operation-in-flight", "merge-in-progress",
  "protected-branch", "current-branch", "no-upstream", "detached-head", "no-remote",
]);
export const VcsGraphBlockedReason = Schema.Struct({
  operation: VcsGraphOperationKind,
  code: VcsGraphBlockedCode,
  message: TrimmedNonEmptyString, // rendered verbatim as the tooltip
});
export const VcsGraphBranch = Schema.Struct({
  name: TrimmedNonEmptyString,
  tipSha: TrimmedNonEmptyString,
  upstream: TrimmedNonEmptyString.pipe(Schema.NullOr),
  ahead: NonNegativeInt.pipe(Schema.NullOr),
  behind: NonNegativeInt.pipe(Schema.NullOr),
  isCurrent: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyString.pipe(Schema.NullOr),
  blocked: Schema.Array(VcsGraphBlockedReason),
});
export const VcsGraphRemoteBranch = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,     // full name, e.g. origin/develop
  tipSha: TrimmedNonEmptyString,
  hasLocalTracking: Schema.Boolean,
  blocked: Schema.Array(VcsGraphBlockedReason),
});
export const VcsGraphTag = Schema.Struct({
  name: TrimmedNonEmptyString,
  targetSha: TrimmedNonEmptyString,
  isAnnotated: Schema.Boolean,
  blocked: Schema.Array(VcsGraphBlockedReason),
});
export const VcsGraphWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branchName: TrimmedNonEmptyString.pipe(Schema.NullOr),
  isPrimary: Schema.Boolean,
  isMissing: Schema.Boolean,
});
export const VcsGraphRunningOperation = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  kind: VcsGraphOperationKind,
  startedAtMs: NonNegativeInt,
});
export const VcsGraphRefsInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export const VcsGraphRefsResult = Schema.Struct({
  generation: NonNegativeInt,
  headRef: TrimmedNonEmptyString.pipe(Schema.NullOr),
  detachedHeadSha: TrimmedNonEmptyString.pipe(Schema.NullOr),
  defaultBranch: TrimmedNonEmptyString.pipe(Schema.NullOr),
  isDirty: Schema.Boolean,
  mergeInProgress: Schema.Boolean, // MERGE_HEAD exists — a conflicted/unfinished merge is pending
  conflictedPaths: Schema.Array(TrimmedNonEmptyString),
  remotes: Schema.Array(TrimmedNonEmptyString),
  branches: Schema.Array(VcsGraphBranch),
  remoteBranches: Schema.Array(VcsGraphRemoteBranch),
  tags: Schema.Array(VcsGraphTag),
  worktrees: Schema.Array(VcsGraphWorktree),
  runningOperation: VcsGraphRunningOperation.pipe(Schema.NullOr),
});

export const VcsCommitFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  previousPath: TrimmedNonEmptyString.pipe(Schema.NullOr),
  status: VcsWorkingTreeFileStatus,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  isBinary: Schema.Boolean,
});
export const VcsCommitDetailInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
});
export const VcsCommitDetailResult = Schema.Struct({
  sha: TrimmedNonEmptyString,
  shortSha: TrimmedNonEmptyString,
  subject: Schema.String,
  body: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAtMs: NonNegativeInt,
  committerName: Schema.String,
  committedAtMs: NonNegativeInt,
  parents: Schema.Array(TrimmedNonEmptyString),
  refs: Schema.Array(VcsGraphRefBadge),
  files: Schema.Array(VcsCommitFileChange),
  filesTruncated: Schema.Boolean,
});
```

New methods: `vcs.listCommitGraph`, `vcs.graphRefs`, `vcs.commitDetail` — all unary, all `SCOPE_ORCHESTRATION_READ`, all maintenance-allowlisted.

**Server notes**

- Graph page command (record separator `\x1e`, field separator `\x1f`, so subjects containing newlines survive). The first page resolves the tips (`git for-each-ref --format=%(objectname)` over the requested scope, or `HEAD` for `current-branch`) and pages against them; later pages reuse the tips the client echoes back:
  `git log <tip…|--all|HEAD> --date-order --pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s%x1e --skip <cursor> --max-count <limit>`
  Pass tips via `--stdin` when the list is long enough to risk the command-line limit. Above 500 tips, fall back to `--all` and set `tipsPinned: false`.
  Parse `%D` decorations into `VcsGraphRefBadge` (`HEAD ->` → `head` + `local-branch`, `tag: ` → `tag`, `<remote>/…` matched against the known remote list → `remote-branch`).
- Refs command: `git for-each-ref --format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD) refs/heads refs/remotes refs/tags`; parse `[ahead N, behind M]` from `upstream:track`. Dirty flag: `git status --porcelain=v2 --untracked-files=no` (empty output ⇒ clean). Default branch: reuse the existing default-branch resolution already backing `VcsRef.isDefault`. Worktrees: reuse the catalog inventory rather than a second `git worktree list`.
- `guards.rs` is pure: it takes the parsed refs, worktree inventory, dirty flag, default branch, and the running-operation state, and returns the blocked list per ref. Example message text: `Checkout is blocked: this branch is already checked out in the worktree at <path>.`

**Tests:** Rust unit tests for graph parsing (multi-parent, empty subject, subject with `\x1f`-adjacent text, decorations), `for-each-ref` parsing (no upstream, ahead/behind, detached HEAD), and guards (every code, and the "no reasons on a clean branch" case) using the existing fixture-repo helpers in `repository.rs`. Two repository shapes that must not be assumed away: an **empty repository with an unborn HEAD** (no commits, no branches — every read returns an empty result rather than erroring) and **two projects sharing one physical repository** through separate worktrees (both resolve to the same common directory, so the generation, the lock and the worktree list are shared, not duplicated). Contract schema tests mirroring `packages/contracts/src/git.test.ts`.

### Phase 2 — Project route, panel shell, ref tree (read-only end to end)

**Files**

- Create: `apps/web/src/routes/_chat.project.$environmentId.$projectId.tsx`, `apps/web/src/components/git-manager/GitManagerView.tsx`, `GitManagerToolbar.tsx`, `RefTree.tsx`, `GitManagerUnavailable.tsx`, `apps/web/src/gitManagerStore.ts`, `apps/web/src/state/gitManager.ts`, plus co-located tests.
- Modify: `apps/web/src/components/Sidebar.tsx` — add the button immediately **before** the `new-worktree-button` tooltip block (currently at `apps/web/src/components/Sidebar.tsx:3037-3069`), and extend the project-header click handler to restore an existing project view.

**Interfaces produced**

```ts
// apps/web/src/gitManagerStore.ts
export interface GitManagerProjectState {
  readonly selectedRef: string | null;
  readonly selectedCommitSha: string | null;
  readonly selectedFilePath: string | null;
  readonly filter: string;
  readonly loadedPages: number;
  readonly scrollIndex: number;
}
export const GIT_MANAGER_CACHE_LIMIT = 2;
export function useGitManagerStore(): GitManagerStoreState; // byProjectKey + lru: string[]
export function selectGitManagerProjectState(
  state: GitManagerStoreState, ref: ScopedProjectRef,
): GitManagerProjectState;
export function hasOpenGitManager(state: GitManagerStoreState, ref: ScopedProjectRef): boolean;
```

Sidebar button: `data-testid="git-manager-button"`, `aria-label={`Git manager for ${project.displayName}`}`, `GitBranchIcon` from `lucide-react`, same `SIDEBAR_ICON_ACTION_BUTTON_CLASS`, tooltip `Git manager`.

**Behavior:** button → `navigate({ to: "/project/$environmentId/$projectId" })`. Project-header click → toggle thread list as today, and if `hasOpenGitManager(...)` also navigate to that project view.

**Tests:** button renders per project card and navigates; project view unmounts on thread navigation and restores state on return; LRU evicts the third project; ref tree renders the four sections, colour-marks worktree-owned branches, disables their checkout and shows the server-supplied tooltip; disconnected environment renders the unavailable state.

### Phase 3 — Lane commit graph

**Files**

- Create: `apps/web/src/components/git-manager/commitGraphLayout.ts` (+ `.test.ts`), `CommitGraph.tsx`, `CommitGraphRow.tsx` (+ tests).

**Interfaces produced**

```ts
export interface GraphLaneState { readonly lanes: readonly (string | null)[]; }
export interface GraphRow {
  readonly sha: string;
  readonly lane: number;
  readonly colorIndex: number;
  readonly edges: readonly GraphEdge[]; // segments drawn in this row's band
  readonly isMerge: boolean;
}
export interface GraphEdge {
  readonly fromLane: number;
  readonly toLane: number;
  readonly kind: "straight" | "branch" | "merge";
  readonly colorIndex: number;
}
export const MAX_GRAPH_LANES = 24;
export function createLaneState(): GraphLaneState;
export function appendCommits(
  state: GraphLaneState, commits: readonly VcsGraphCommit[],
): { readonly state: GraphLaneState; readonly rows: readonly GraphRow[] };
```

Algorithm: keep an array of active lanes holding the SHA each lane expects next. For each commit in order, take the first lane expecting it (else allocate the lowest free lane); that is the row lane. Replace the lane's slot with the commit's **first** parent; give each additional parent its own lane (reusing a lane already expecting that parent when one exists — that is the merge edge). Clear lanes whose expectation was consumed. Colour is `laneIndex % palette.length`, stable because the lane state carries across pages. Lanes beyond `MAX_GRAPH_LANES` collapse into an overflow indicator column rather than growing the row width.

**Rendering:** `@legendapp/list` virtualizes rows; each row draws its own SVG band (fixed lane width), so no full-graph canvas and no relayout on append. Columns mirror the screenshots: graph + subject + ref badges | author | short sha | date.

**Tests (pure, no React):** linear history; a fork; a two-parent merge; an octopus merge; lane reuse after a branch ends; **page-boundary stability** — laying out 100 commits in one call and in four calls of 25 produces identical rows.

### Phase 4 — Commit detail and diff

**Files**

- Modify: `packages/contracts/src/git.ts` + `rpc.ts` (`vcs.commitDiff`), `apps/server/src/git/graph.rs` (diff production), `apps/server/src/production/git_vcs.rs`, `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs` (read scope), `apps/server/src/maintenance.rs`.
- Create: `apps/web/src/components/git-manager/CommitDetailPane.tsx`, `CommitFileList.tsx` (+ tests).

**Interfaces produced**

```ts
export const VcsCommitDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  filePath: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export const VcsCommitDiffResult = Schema.Struct({
  sha: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString.pipe(Schema.NullOr),
  baseRef: TrimmedNonEmptyString.pipe(Schema.NullOr), // first parent; null for a root commit
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
```

**Server:** `git show --format= --patch <sha> [-- <filePath>]` (root commits diff against the empty tree) through the supervised process path, reusing the review pipeline's truncation policy and `diffHash` computation so the client renders it with the same helpers. Read scope, maintenance-allowlisted — unlike `review.getDiffPreview`, which is write-scoped.

**Client:** metadata block (author, dates, sha, parents as clickable links that select that commit, ref badges), file list with status and ±counts, and the selected file's patch rendered through `getRenderablePatch` / `resolveDiffThemeName` from `apps/web/src/lib/diffRendering.ts`. Binary and truncated files show a clear placeholder instead of a broken diff.

**Tests:** server test for root-commit, rename, and binary-file cases; client tests for parent navigation, file selection, binary placeholder, and truncation notice.

### Phase 5 — Mutating operations, progress, serialization

**Files**

- Modify: `packages/contracts/src/git.ts` + `rpc.ts` (operation union and event union), `apps/server/src/production/git_vcs.rs` (dispatch + `GIT_VCS_STREAM_METHODS`), `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`.
- Create: `apps/server/src/git/operations.rs` (operation execution + per-repository lock + failure classification), `apps/web/src/components/git-manager/GitOperationProgress.tsx`, `PushDialog.tsx`, `MergeDialog.tsx`, `MergeConflictDialog.tsx` (+ tests).

**Interfaces produced**

```ts
export const GitRepositoryOperation = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("fetch"), remote: TrimmedNonEmptyString.pipe(Schema.NullOr), prune: Schema.Boolean, tags: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("pull"), ffOnly: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("push"), branch: TrimmedNonEmptyString, remote: TrimmedNonEmptyString, setUpstream: Schema.Boolean, force: Schema.Boolean, pushTags: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("merge"), sourceRef: TrimmedNonEmptyString, mode: Schema.Literals(["default", "no-ff", "squash", "no-commit"]) }),
  Schema.Struct({ _tag: Schema.Literal("resolveMergeConflict"), decision: Schema.Literals(["abort", "keep"]) }),
  Schema.Struct({ _tag: Schema.Literal("createBranch"), name: TrimmedNonEmptyString, baseRef: TrimmedNonEmptyString, checkout: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("checkout"), refName: TrimmedNonEmptyString, createLocalTracking: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("createTag"), name: TrimmedNonEmptyString, targetRef: TrimmedNonEmptyString, message: TrimmedNonEmptyString.pipe(Schema.NullOr), push: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("deleteBranch"), name: TrimmedNonEmptyString, force: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("renameBranch"), name: TrimmedNonEmptyString, newName: TrimmedNonEmptyString }),
  Schema.Struct({ _tag: Schema.Literal("deleteTag"), name: TrimmedNonEmptyString }),
]);
export const GitRunRepositoryOperationInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  operation: GitRepositoryOperation,
});
export const GitRepositoryOperationFailureCode = Schema.Literals([
  "authentication", "non-fast-forward", "conflict", "blocked", "cancelled", "git-error",
]);
export const GitRepositoryOperationEvent = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("started"), operationId: TrimmedNonEmptyString, label: TrimmedNonEmptyString, startedAtMs: NonNegativeInt }),
  Schema.Struct({ _tag: Schema.Literal("output"), operationId: TrimmedNonEmptyString, stream: GitActionProgressStream, chunk: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("conflict"), operationId: TrimmedNonEmptyString, conflictedPaths: Schema.Array(TrimmedNonEmptyString) }),
  Schema.Struct({ _tag: Schema.Literal("finished"), operationId: TrimmedNonEmptyString, summary: Schema.String, generation: NonNegativeInt }),
  Schema.Struct({ _tag: Schema.Literal("failed"), operationId: TrimmedNonEmptyString, code: GitRepositoryOperationFailureCode, detail: Schema.String }),
]);
```

Method: `git.runRepositoryOperation` — streaming, write scope (same scope group as `git.runStackedAction`), added to `GIT_VCS_STREAM_METHODS`.

**Server notes**

- Follow the `git.runStackedAction` handler shape (`apps/server/src/production/git_vcs.rs:988`): decode → `guard_git_path` admission → child cancellation token → stream events through the sender → release.
- The per-repository lock is acquired **after** admission and released on every exit path including cancellation. While held, `VcsGraphRefsResult.runningOperation` reports it, and guards mark every mutating action `operation-in-flight`.
- Re-validate guards server-side at execution time; a stale client must be rejected with `blocked`, never trusted.
- Classification: exit status plus stderr matching, not stdout scraping — credentials/permission → `authentication`; `non-fast-forward`/`fetch first`/`rejected` → `non-fast-forward`; merge conflict detection via exit code 1 plus `git diff --name-only --diff-filter=U`. Log the code and lengths only; the text travels in the payload.
- `resolveMergeConflict` is only accepted while the repository is in a conflicted merge state; `abort` runs `git merge --abort`, `keep` leaves the state and returns a summary.
- Every completed operation triggers the broadcaster's immediate refresh so all clients see the new generation.

**Client:** toolbar buttons open their dialog (Push mirrors the screenshot: branch, target remote, push-all-tags, force-push with confirm; Merge mirrors it: source, target, mode dropdown of Default/No-Fast-Forward/Squash/Don't-Commit). The progress banner streams `output` chunks into a collapsible pre-formatted area with a cap and a cancel button that interrupts the RPC. `conflict` opens the conflict dialog offering **Abort merge** (default focus) or **Keep conflicted state**, the latter explaining that resolution must happen outside this panel. The dialog is driven by `mergeInProgress` from the refs snapshot, not only by the stream event, so a reload, reconnect, or dismissed dialog still shows a persistent "merge pending — resolve" bar listing the conflicted paths.

**Tests:** Rust — happy path per operation against fixture repos, dirty-tree refusal, concurrent-operation rejection, cancellation mid-operation leaves no lock held, conflict path emits paths and abort restores the pre-merge head, a fresh refs snapshot on a conflicted repository reports `mergeInProgress` with the conflicted paths and blocks other mutations while accepting `resolveMergeConflict`, non-fast-forward and auth classification (auth simulated with an unreachable/deny remote and the existing non-interactive env). Client — banner renders streamed output and cancels, push dialog requires confirm for force, merge dialog passes the selected mode, conflict dialog dispatches the follow-up operation.

### Phase 6 — Branch and tag lifecycle, destructive confirms

**Files**

- Create: `apps/web/src/components/git-manager/CreateBranchDialog.tsx`, `CreateTagDialog.tsx`, `ConfirmRefActionDialog.tsx`, `RefContextMenu.tsx` (+ tests).
- Modify: `apps/server/src/git/guards.rs` (protected-branch and current-branch rules for delete/rename/force-push), `apps/web/src/components/git-manager/RefTree.tsx`.

Create Branch mirrors the screenshot: "Create branch at: `<ref>`", name field, "Check out after create" checkbox, inline validation (name already exists, invalid ref name via `git check-ref-format` rules mirrored in a pure client validator for immediate feedback, with the server as the authority). Create Tag mirrors it too: target ref, name, optional message, Push checkbox, and the inline `Tag '<name>' already exists` warning. Checkout of a remote branch offers "create local tracking branch" when no local branch exists. Delete/rename go through the confirm dialog and are blocked on the default branch and on the current branch.

**Tests:** validation states (duplicate name, empty, invalid characters), the disabled-with-reason paths for protected/current branches, and that a successful create+checkout refreshes refs.

### Phase 7 — Live change signal and documentation

**Files**

- Modify: `apps/server/src/git/broadcaster.rs` (signature + generation, new subscriber stream), `packages/contracts/src/git.ts` + `rpc.ts` (`subscribeVcsGraph`), `apps/server/src/production/git_vcs.rs`, `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `apps/web/src/state/gitManager.ts`, `apps/web/src/components/git-manager/GitManagerView.tsx`.
- Create: `docs/architecture/git-manager.md`.
- Modify: `docs/architecture/rpc-and-orchestration.md` (new methods), `docs/README.md` (index entry), `docs/user/workspace-ui.md` (the new project-card button and view), `docs/testing/` runbooks that enumerate packaged UI flows and validation evidence.

Signature per repository: hash of `git for-each-ref --format=%(objectname)%(refname) refs/heads refs/remotes refs/tags` + resolved HEAD + the worktree inventory generation, computed on the existing ref poll tick. When it changes, bump `generation` and notify subscribers; subscribers receive `{ generation, changedAtMs }`, revalidate the refs snapshot, and fetch the commits added above their pinned tip snapshot. Reuse the existing 3-second ref-refresh interval — **do not add a poller task beyond the two that already exist per repository**, and make sure a graph-only subscriber still triggers the existing subscribe-driven poller start.

**Tests:** broadcaster test that a fixture-repo commit bumps the generation exactly once per change and that a no-op poll emits nothing; client test that a generation bump revalidates and that a page from an older generation is discarded.

---

## Test Configuration

**Rust (`apps/server`)**

- Framework: built-in `#[tokio::test]` / `#[test]`; fixture repositories built with the existing helpers in `apps/server/src/git/repository.rs` (they already pin `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and `GIT_CONFIG_NOSYSTEM`).
- Location: unit tests co-located in the module under test (`graph.rs`, `guards.rs`, `operations.rs`, `broadcaster.rs`); RPC-level tests alongside the existing ones in `apps/server/src/production/git_vcs.rs`.
- Network operations are tested against local file-path remotes (`git init --bare` in a temp dir) — never a real host. The auth-failure test uses an unreachable remote plus the existing non-interactive env so it fails fast.

**TypeScript (`packages/contracts`, `apps/web`)**

- Runner: `vp test` (Vite+ built-in). Tests are co-located `*.test.ts` / `*.test.tsx`, following `CreateWorktreeDialog.test.tsx` and `packages/contracts/src/git.test.ts`.
- Pure logic (lane layout, store LRU, name validation) is tested without React.
- Component tests assert accessible names and the tooltip/`aria-describedby` reason text, not class names.

---

## Validation & Testing

Run from the repository root. Report the exact commands run, anything that could not run, and residual risk.

```bash
# Focused, during development
cargo test -p bibcode-server git::
vp test apps/web/src/components/git-manager
vp test packages/contracts/src/git.test.ts

# Full gate before declaring a phase complete
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server
vp check
vp run typecheck
vp test

# Review
git diff
git status --short
```

Manual validation on native Windows (per `docs/testing/`): open a project's Git Manager, confirm single-instance behavior, navigate to a thread and back, fetch/pull/push against a scratch remote, merge a conflicting branch and both resolve paths, create/checkout/delete a branch, create and push a tag, and confirm every disabled control explains itself on hover. Record evidence in a report created from the runbook template — not in the runbook itself.

---

## Acceptance Criteria

1. Each project card in the left panel shows a Git Manager button immediately before the New-worktree button; it opens that project's Git Manager in the center panel.
2. Only one Git Manager exists per project, and only one is visible at a time; clicking a thread hides it, and clicking the project card or the button brings it back with its previous selection and scroll intact for the two most recent projects.
3. The ref tree lists local branches, remote branches, tags, and worktrees. Worktrees show their path and expose no operations.
4. A branch that already has a worktree is colour-marked, cannot be checked out, and its tooltip names the blocking condition and the worktree path.
5. Every disabled action shows a hover hint naming the blocking condition — worktree-checked-out, dirty working tree, an operation already running, or a protected/current-branch rule.
6. The commit graph renders lanes and merge edges across paged loads, virtualized, without relayout artifacts at page boundaries.
7. Selecting a commit shows author, dates, full message, parents, refs, the changed-file list, and the selected file's diff.
8. Fetch, Pull, and Push (including force push and push-all-tags, each behind a confirm for the destructive variants) run with visible progress, cancellable, with the full git output available.
9. Merge supports Default / No-Fast-Forward / Squash / Don't-Commit; on conflict the user chooses Abort or Keep, and Abort restores the pre-merge state. A merge left pending is still shown as pending after a reload or reconnect, with its conflicted files, and can be aborted from there.
10. Branch create (with optional checkout), remote-branch checkout as a local tracking branch, branch delete/rename, tag create (with optional push) and tag delete all work and refresh the view.
11. An external commit, fetch, or branch change made outside BiBCode appears in the panel without a manual refresh.
12. Local changes, stash, and submodules appear nowhere in this UI.
13. The Git Manager is available for projects in every environment; a disconnected environment shows an unavailable state rather than an error.

## Success Criteria

- `vp check`, `vp run typecheck`, `vp test`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, and `cargo test -p bibcode-server` all pass.
- No new runtime dependency in `apps/web`, `apps/server`, or `packages/contracts`.
- A first commit-graph page renders in under ~1s on a repository with tens of thousands of commits; scrolling stays smooth because rows are virtualized and layout is incremental.
- No Git policy is duplicated in React: every blocked state the UI shows came from the server payload.
- No branch name, path, remote URL, or Git stderr text appears in a log string.
- `docs/architecture/git-manager.md` exists and matches the shipped behavior; `docs/architecture/rpc-and-orchestration.md`, `docs/README.md`, `docs/user/workspace-ui.md` and the affected `docs/testing/` runbooks are updated in the same change (or the final report states they were reviewed and remain accurate).

---

## Alternatives Considered

- **Modal dialog vs. native Tauri window vs. center-panel view.** A modal is single-instance for free but blocks the rest of the app; a native window per project needs `DesktopBridge` work and has no browser-mode equivalent. The center-panel project view was chosen: it works identically in browser and desktop, is naturally keyed per project by the route, and matches how chat/terminal/preview already occupy that area. Cost: only one project's manager is visible at a time.
- **Server-computed lane layout.** Rejected: layout would have to be recomputed and kept consistent across incremental pages on the server, and it would put a UI concern in the Git authority. The server ships the DAG (`parents`), the client lays it out incrementally.
- **Loading the whole DAG up front.** Rejected on performance: a 100k-commit repository would mean a multi-second first paint and a large payload.
- **A separate RPC per mutation (`git.push`, `git.merge`, …).** Rejected: each would need its own progress stream, cancellation, scope entry, and — now that registration spans six places including regenerated wire fixtures — its own six-place registration. One tagged streaming operation keeps serialization and progress in one place. The precedent is `git.runStackedAction`, though only partially: that method's payload is a flat action enum selecting canned phase sequences, not a heterogeneous tagged union, so this plan extends the pattern rather than repeating it. Cost: a wider payload union to validate, and one method whose authorization is coarser than per-operation scoping would allow.
- **A filesystem watcher for live updates.** Rejected for v1: `StatusBroadcaster` is already an interval poller per repository with a subscriber fan-out and an immediate-refresh channel. Extending it with a refs signature reuses that machinery; adding a watcher would mean a second change-detection system. Cost: external changes surface on the next poll tick rather than instantly.
- **Extending `review.getDiffPreview` with a `commit` source instead of a dedicated `vcs.commitDiff`.** This was the original design, and it was rejected on evidence: `review.getDiffPreview` maps to `SCOPE_REVIEW_WRITE` (`apps/server/src/auth/scope.rs:109`), so read-only history browsing would have demanded a write scope. `vcs.commitDiff` takes the read scope and reuses the same diff production and truncation code. Cost: one more method to register.

---

## Attachments

Reference screenshots of Fork (the UI model for this feature), in [`screenshots/`](screenshots/):

| File | What it shows |
| --- | --- |
| `SCR-20260817-pywo.jpeg` | Full window: toolbar, repo tabs, left ref tree, lane graph with author/sha/date columns, bottom Commit/Changes/File-Tree tabs with a file tree and syntax-highlighted diff. |
| `SCR-20260817-pytb.png` | Same layout with the Commit tab selected — author block, refs, sha, parents, message, changed-file list. |
| `SCR-20260817-pyzg.png` | Full-window variant of the graph and detail pane. |
| `SCR-20260817-pylr.png` | Toolbar row plus the "Fetching All" progress dialog with Cancel, "Show full output", and the literal git command — the model for the progress banner. |
| `SCR-20260817-pzbr.png` | Branch context menu (Checkout, Checkout as Worktree, Fast-Forward, Push, Merge, Rebase, New Branch, New Tag, Rename, Delete, Copy name) and the Branches/Remotes/Tags/Stashes/Submodules tree. |
| `SCR-20260817-pzho.png` | Create Tag dialog: target ref, name, message, Push checkbox, and the inline "Tag '2.8.3' already exists" warning. |
| `SCR-20260817-pzjt.png` | Push dialog: branch, target remote, "Push all tags", "Force push". |
| `SCR-20260817-pzmn.png` | Merge Branch dialog: source, target, merge-option dropdown (Default / No Fast-Forward / Squash / Don't Commit) and a "Merge will cause conflicts" warning. |
| `SCR-20260817-pzpc.png` | Create Branch dialog: base ref, name, "Check out after create". |

Not every element in these screenshots is in scope — Stashes, Submodules, Local Changes, and Rebase are excluded (see § Out of scope).

## Related Docs

- `AGENTS.md` — required pre-work, architectural decision standards, task completion requirements.
- `docs/architecture/overview.md` — package roles and runtime topology.
- `docs/architecture/rpc-and-orchestration.md` — RPC session, wire protocol, method inventory and scope mapping.
- `docs/architecture/worktree-catalog.md` — repository identity, physical-path identity, availability admission, mutation arbitration. The operation lock in Phase 5 must follow this.
- `docs/architecture/connection-runtime.md`, `docs/architecture/runtime-modes.md` — browser/desktop parity constraints.
- `docs/reference/workspace-layout.md`, `docs/reference/scripts.md` — package layout and the `vp` command set.
- `docs/testing/README.md` — runbooks to review and update in Phase 7.
- Existing code to imitate: `apps/server/src/production/git_vcs.rs` (dispatch + streaming), `apps/server/src/git/broadcaster.rs` (poller/subscribers), `apps/web/src/components/CreateWorktreeDialog.tsx` (dialog + command), `apps/web/src/lib/diffRendering.ts` (diff helpers).
- **Historical evidence only** (verify before reuse): `docs/superpowers/plans/2026-07-01-source-control/` — the shipped, archival plan set that built the thread-scoped source-control panel and `vcs.listCommits`. `03-staged-unstaged-index.md` carries an RPC registration checklist and `04-commits-history.md` the original history section. They are the closest prior art; their paths and commands predate this repository state and must be re-verified against source. Nothing there conflicts with this plan — that work is thread-scoped and change-oriented, this one is project-scoped and ref/history-oriented.

## Skill operator notes

- Written by `create-master-plan` adapted per the user's instruction: **no Jira**; the spec is the author's own `issue.specs`, kept beside this plan rather than under `docs/prps/`. `issue.specs` was left in the author's own words; only `## Interview Notes` was appended.
- `superpowers:brainstorming` classified the work as architectural; the design was approved in chat on 2026-08-18 before this file was written. `superpowers:writing-plans` shaped the structure.
- CodeGraph is not initialized in this worktree (no `.codegraph/`), so graph queries were unavailable; all findings above come from direct source inspection, manifests, and tests.
- Local documentation scan: a case-insensitive search of `docs/` for git-manager / commit-graph material returned only the archival `docs/superpowers/plans/2026-07-01-source-control/` set (three files), listed under § Related Docs. There is no prior or competing Git Manager design in this repository.
- Authored on 2026-08-18 in the gitignored `.plans/git-manager/` scratch folder, then moved here at the user's request. Unlike the rest of `docs/superpowers/plans/`, this plan is in flight, not history — the artifacts around it are archival.
- Next step: `/decompose-plan docs/superpowers/plans/2026-08-18-git-manager` to expand the seven phases into atomic phase files.
