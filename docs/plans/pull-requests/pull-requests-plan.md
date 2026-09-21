# Pull Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository the implementer of every phase is Codex (`codex:rescue`) and the reviewer is the coordinating Claude session; see `execute-plan.md`.

**Goal:** Give every BiBCode project a Pull Requests module that lists, inspects, reviews, edits, merges, checks out and otherwise manages the hosted pull requests (GitHub) or merge requests (GitLab, including self-hosted) of its repository, gated by server-computed permissions, with zero telemetry.

**Architecture:** A sibling of the Git Manager: two project-scoped TanStack routes rendered in the centre view, a per-project zustand view-state cache, and a client-runtime atom family over a new `pullRequests.*` RPC group. On the server a new `pull_requests` module owns a normalised model, a `PullRequestHost` trait with GitHub (`gh`) and GitLab (`glab`) adapters that call the CLIs and the hosts' public APIs through `ProcessRunner`, a permissions calculator, and one RPC service registered next to the Git Manager's. Reads are one unary method per tab; mutations are one tagged-union `runAction` method plus a separate `checkout` method that reuses the Git Manager guards and the worktree catalog.

**Tech Stack:** Rust (Axum/Tokio, `serde_json`, existing `ProcessRunner`), effect `Schema` contracts, React 19 + zustand + `@effect/atom` query families, `react-markdown` + `remark-gfm`, `@pierre/diffs`, `lucide-react`, Vitest, cargo test, Playwright for visual verification.

**Spec:** `docs/plans/pull-requests/pull-requests-spec.md` (approved 2026-09-20). Research: `docs/plans/pull-requests/research/`.

## Global Constraints

Every phase's requirements implicitly include this section. Copied from the spec.

- **Server is the only authority on what the user may do.** Every action's availability is server-computed as `{ allowed, reason }`; the client renders reasons verbatim and derives no permission policy. Host refusals become structured errors, never raw stderr.
- **Single repository per view.** Every RPC is addressed by the `cwd` of one checkout of one project; nothing is resolved client-side.
- **Zero telemetry.** No analytics, crash reporting, usage counters, remote feature flags, avatars, badges, third-party image fetches, or timers/pollers. Outbound traffic is only user-initiated `gh`/`glab`/`git` traffic against the repository's own host and remotes. Enforced by tests (Phase 10).
- **Provider-agnostic core.** One model, one RPC surface, one `PullRequestHost` trait with two adapters; host-specific capabilities are declared by the adapter, never special-cased in the client.
- **No repository lifecycle.** Nothing adds, clones, publishes, or deletes a repository.
- **No new dependencies** in `apps/web/package.json`, `packages/*/package.json`, or `apps/server/Cargo.toml`. A phase that believes one is required stops and escalates.
- **Every process invocation goes through `apps/server/src/git/process.rs` `ProcessRunner`** with a timeout, an output cap, and a cancellation token. Git invocations additionally use the existing non-interactive git environment helper.
- **Log hygiene.** No branch names, PR titles, comment bodies, URLs, hosts, account names, or CLI stderr in log strings; stable codes plus lengths and counts only.
- **Only public, documented host APIs** (`gh`/`glab` commands, `gh api`, `glab api` REST and GraphQL). No internal web endpoints.
- **Bodies never in `argv`.** `gh` reads bodies via `--body-file -` / `gh api --input -`; `glab api` reads via `--input <file>` from a 0600 temporary file in the server state directory deleted after the call. Hosts via `GH_HOST` / `GITLAB_HOST` + `glab api --hostname`; repository via `--repo` on every CLI call.
- **Privileged desktop operations cross `DesktopBridge`; normal application traffic uses typed RPC.** Nothing in this plan is a bridge command.
- **`packages/contracts` is schema-only.**
- **Every new RPC method** is registered in `WS_METHODS`, `Rpc.make`, `WsRpcGroup` (`packages/contracts/src/rpc.ts`), the regenerated wire fixtures under `packages/contracts/fixtures/rpc-wire/`, `ACTIVE_RPC_METHODS` (`apps/server/src/rpc/methods.rs`), `required_scope` (`apps/server/src/auth/scope.rs`) with exactly one scope, and the handler registry; both hard-coded counts (`packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `apps/server/tests/rpc_wire.rs`) are re-read and bumped in the same change.
- **Living documentation ships with the behaviour** (Phase 10 plus per-phase notes), and affected runbooks under `docs/testing/` are updated or recorded as reviewed and unchanged.
- **Commit policy:** phases are commit-free. Only the coordinator commits, and only when the requester asks; every commit message carries a resume of the task.

> Line numbers in this plan drift. Re-verify every cited location before editing. Where the plan and the research documents disagree with the working tree, the working tree wins and the discrepancy is reported in `tasks.md`.

---

## Why this shape

BiBCode already resolves the current branch's PR, creates PRs, and reads GitHub checks through `PullRequestService` (`apps/server/src/source_control/`). What is missing is everything a host's PR page does: listing, reading, reviewing, editing, merging. The Git Manager proved the wiring pattern for a project-scoped centre module (research: `bibcode-integration-surface.md`), and its availability/`disabledReason` pattern is exactly what server-authored permissions need on the client (research: `settings-and-capabilities.md`).

Two things shape the design:

1. **The host is the authority.** Permissions cannot be derived locally; they come from `viewerCan*` / `user.can_merge` / access levels and change per PR. So the server computes a permissions object per PR and the client only renders it.
2. **Two very different hosts, one UI.** GitHub is per-PR merge-method choice, review dismissal, no MR delete; GitLab is project-level merge method, approvals with rules, request-changes only via GraphQL from 17.2. A host-capability set (vocabulary + feature flags + version gates) declared by each adapter keeps the client generic.

## Architecture

### Ownership

| Concern                                                                       | Owner                                                                                                                                                                         | Notes                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalised PR model, host trait, adapters, permissions, context, vocabularies | `apps/server/src/pull_requests/`                                                                                                                                              | New module. Depends on `source_control` (provider detection, `ProviderCommandSpec`, auth parsing), `git::process`, `git::manager::guards`, `worktree` catalog. |
| RPC handlers and registration                                                 | `apps/server/src/production/pull_requests_rpc.rs`                                                                                                                             | Mirrors `git_manager_rpc.rs`: `PullRequestsRpcServices`, `register_pull_requests_rpc`.                                                                         |
| Contracts                                                                     | `packages/contracts/src/pullRequests.ts`                                                                                                                                      | Schema only; exported from `index.ts`; RPCs in `rpc.ts`.                                                                                                       |
| Capability flags                                                              | `packages/contracts/src/environment.ts`, `apps/server/src/production/control.rs`, `packages/shared/src/testSupport.ts`                                                        | `pullRequestsReads`, `pullRequestsMutations`.                                                                                                                  |
| Client atoms                                                                  | `packages/client-runtime/src/state/pullRequests.ts` (+ `package.json` export `./state/pull-requests`)                                                                         | Query atom families + commands.                                                                                                                                |
| Web state                                                                     | `apps/web/src/state/pullRequests.ts`, `apps/web/src/pullRequestsStore.ts`                                                                                                     | Environment atoms instance; per-project view-state cache.                                                                                                      |
| Web UI                                                                        | `apps/web/src/components/pullRequests/**`, two route files, `Sidebar.tsx`, `SourceControlSettings.tsx`, `GitManagerPullRequestPanel.tsx` (link)                               |                                                                                                                                                                |
| Settings                                                                      | `packages/contracts/src/settings.ts` (`ClientSettingsSchema.pullRequestsEnabled`)                                                                                             | Client setting.                                                                                                                                                |
| Docs                                                                          | `docs/user/workspace-ui.md`, `docs/integrations/source-control-providers.md`, `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/overview.md`, `docs/testing/*` | Phase 10.                                                                                                                                                      |

### Server

```
apps/server/src/pull_requests/
  mod.rs          — pub use; PullRequestsService (holds host adapters, ProcessRunner, PullRequestService for create/resolve reuse)
  model.rs        — Rust structs mirroring every contract schema (serde, camelCase)
  host.rs         — trait PullRequestHost + HostCommandRunner (runs gh/glab through ProcessRunner; temp-file body helper)
  context.rs      — host identification (§ 5), availability (§ 6.3), host capabilities (§ 7.3), version parsing
  permissions.rs  — pure fn permissions(inputs) -> PullRequestsPermissions, per host
  github/mod.rs   — GitHub adapter (gh + gh api REST/GraphQL); github/graphql.rs holds the query/mutation strings; github/parse.rs
  gitlab/mod.rs   — GitLab adapter (glab + glab api REST/GraphQL); gitlab/parse.rs
  checkout.rs     — local checkout and new-worktree checkout (guards + worktree catalog)
  error.rs        — PullRequestsOperationError builder (codes) + mapping from ProcessError / host HTTP errors
apps/server/src/production/pull_requests_rpc.rs — RPC service + registration + registration tripwire test
apps/server/tests/pull_requests_*.rs — integration tests with TestSandbox executable_script stubs
```

**`PullRequestHost` trait** (async, object-safe via `async_trait` already used in the crate — verify; otherwise `Box<dyn Future>` per existing convention):

```rust
pub struct HostScope { pub cwd: PathBuf, pub host: String, pub repository: String /* owner/name or full path */ }

#[async_trait::async_trait]
pub trait PullRequestHost: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self, version: Option<&HostVersion>) -> HostCapabilities;
    async fn context(&self, scope: &HostScope, c: &CancellationToken) -> Result<HostContext, PullRequestsOperationError>;
    async fn vocabulary(&self, scope: &HostScope, kind: VocabularyKind, query: Option<&str>, c: &CancellationToken) -> Result<Vocabulary, PullRequestsOperationError>;
    async fn list(&self, scope: &HostScope, query: &ListQuery, c: &CancellationToken) -> Result<ListPage, PullRequestsOperationError>;
    async fn detail(&self, scope: &HostScope, number: u64, c: &CancellationToken) -> Result<DetailRaw, PullRequestsOperationError>;
    async fn timeline(&self, scope: &HostScope, number: u64, c: &CancellationToken) -> Result<Timeline, PullRequestsOperationError>;
    async fn commits(&self, scope: &HostScope, number: u64, c: &CancellationToken) -> Result<Commits, PullRequestsOperationError>;
    async fn checks(&self, scope: &HostScope, number: u64, c: &CancellationToken) -> Result<Checks, PullRequestsOperationError>;
    async fn files(&self, scope: &HostScope, number: u64, c: &CancellationToken) -> Result<Files, PullRequestsOperationError>;
    async fn run_action(&self, scope: &HostScope, action: &ActionRequest, c: &CancellationToken) -> Result<ActionResult, PullRequestsOperationError>;
    fn head_ref_spec(&self, number: u64) -> String; // "refs/pull/N/head" | "refs/merge-requests/N/head"
}
```

`DetailRaw` carries the host answers permissions need; `PullRequestsService::get` combines `DetailRaw` + `HostContext` through `permissions::compute` into the wire `PullRequestsDetail`.

**`HostCommandRunner`**: wraps `ProcessRunner` + a `ProviderCommandSpec` per CLI (`gh`, `glab`, `git`), sets `GH_HOST` / `GITLAB_HOST`, adds `--repo` / `--hostname`, applies the spec's timeouts (reads 30 s, list/diff 60 s, mutations 60 s) and output caps (1 MiB JSON, 8 MiB patch), and exposes `run_json`, `run_text`, `run_with_body(file_body)` (private 0600 temp file under the state dir, removed in a `Drop` guard). Tests inject stub scripts via `TestSandbox::executable_script`.

**Error mapping** (`error.rs`): `PullRequestsOperationError { operation, code, message, hostDetail: Option<String>, retryable: bool }` with codes `not_authenticated`, `not_found`, `forbidden`, `rate_limited`, `cli_missing`, `cli_too_old`, `host_version_too_old`, `timeout`, `host_unreachable`, `stale_head`, `unavailable`, `invalid_response`, `output_limit`, `blocked` (checkout guard), `host_rejected`. Detection: exit code + stderr substrings (`gh`: "not logged into", "Could not resolve to a PullRequest", "HTTP 403", "HTTP 404", "API rate limit exceeded", "head sha", "not mergeable"; `glab`: "401", "403", "404", "none of the git remotes", "429"), never surfacing the raw text as `message` — `hostDetail` carries the host's own sentence when it is safe (no tokens).

### Contracts

File `packages/contracts/src/pullRequests.ts`. All schemas use `Schema.Struct` with `TrimmedNonEmptyStringSchema` where the Git Manager does; nullable fields are `Schema.NullOr`. Symbol prefix `PullRequests`; RPC prefix `pullRequests.`; `WS_METHODS` keys `pullRequests*`. The wire names below are binding for every phase.

Common:

```ts
PullRequestsCwdInput { cwd }
PullRequestsNumberInput { cwd, number: Schema.Number }
PullRequestsProviderKind = Schema.Literals(["github", "gitlab"])
PullRequestsActor { login, name: NullOr(String), isBot: Boolean }           // never an avatar URL
PullRequestsLabel { name, color: NullOr(String), description: NullOr(String) }
PullRequestsMilestone { id: String, title, dueOn: NullOr(String) }
PullRequestsReviewer { actor: PullRequestsActor, state: Literals(["unreviewed","commented","approved","changes_requested","dismissed","review_started"]), canRerequest: Boolean }
PullRequestsState = Literals(["open","closed","merged"])
PullRequestsMergeMethod = Literals(["merge","squash","rebase"])
PullRequestsPermission { allowed: Boolean, reason: NullOr(String) }
PullRequestsPermissions { comment, editOwnComment, deleteOwnComment, minimizeComment, react, resolveThreads, review, approve, requestChanges, revokeApproval, removeOwnChangeRequest, dismissReview, rerequestReview, applySuggestion, editPullRequest, editReviewers, editAssignees, editLabels, editMilestone, lock, unlock, updateBranch: { allowed, reason, methods: Array(Literals(["merge","rebase"])) }, merge: { allowed, reason, methods: Array(PullRequestsMergeMethod), defaultMethod: NullOr(PullRequestsMergeMethod), deleteBranchDefault: Boolean }, mergeBypass, enableAutoMerge, disableAutoMerge, markReady, convertToDraft, close, reopen, delete, revert, checkout }   // every other field is PullRequestsPermission
PullRequestsHostCapabilities { vocabulary: { pullRequest, pullRequests, checks, filesChanged, reviewer, approve, requestChanges }, requestChanges: Boolean, revokeApproval: Boolean, removeOwnChangeRequest: Boolean, dismissReview: Boolean, applySuggestion: Boolean, minimizeComment: Boolean, deletePullRequest: Boolean, lockReasons: Array(String), updateBranchMethods: Array(Literals(["merge","rebase"])), mergeMethodsSource: Literals(["per_pull_request","project_setting"]), autoMergeLabel: String, reviewerStates: Boolean, closedTabIncludesMerged: Boolean }
PullRequestsOperationError (TaggedError "PullRequestsOperationError") { operation, code, message, hostDetail: NullOr(String), retryable: Boolean }
```

Context and vocabulary:

```ts
PullRequestsContext = Union(
  Struct({ status: Literal("available"), provider: PullRequestsProviderKind, host, hostVersion: NullOr(String), repository, defaultBranch, account: PullRequestsActor, repositoryPermission: Literals(["none","read","triage","write","maintain","admin"]), mergePolicy: { methods: Array(PullRequestsMergeMethod), defaultMethod: NullOr(PullRequestsMergeMethod), deleteBranchDefault: Boolean, autoMergeAllowed: Boolean, requiresPipelineSuccess: Boolean, requiresResolvedDiscussions: Boolean }, capabilities: PullRequestsHostCapabilities, webUrl }),
  Struct({ status: Literal("unavailable"), code: Literals(["no_remote","unsupported_provider","unknown_host","cli_missing","not_authenticated","repository_unreachable","cli_too_old"]), message, provider: NullOr(SourceControlProviderKind), host: NullOr(String), installHint: NullOr(String), authCommand: NullOr(String) }))
PullRequestsVocabularyInput { cwd, kind: Literals(["labels","milestones","users","branches"]), query: NullOr(String) }
PullRequestsVocabulary { kind, entries: Array({ id: String, label: String, color: NullOr(String), description: NullOr(String) }), truncated: Boolean }
```

List:

```ts
PullRequestsListInput { cwd, state: Literals(["open","closed","merged","all"]), search: NullOr(String), author: NullOr(String) /* "@me" or login */, assignee: NullOr(String), reviewer: NullOr(String), reviewStatus: NullOr(Literals(["review_required","approved","changes_requested","not_approved"])), draft: NullOr(Literals(["only","exclude"])), labels: Array(String), milestone: NullOr(String), targetBranch: NullOr(String), sort: Literals(["newest","oldest","recently_updated","most_commented"]), cursor: NullOr(String) /* GitHub endCursor or GitLab page number as string */ }
PullRequestsListRow { number, title, state, isDraft, author: PullRequestsActor, createdAt, updatedAt, mergedAt: NullOr(String), closedAt: NullOr(String), headBranch, baseBranch, labels: Array(PullRequestsLabel), reviewDecision: NullOr(Literals(["review_required","approved","changes_requested"])), checksSummary: NullOr(Literals(["pending","success","failure","neutral"])), commentCount: Number, approvals: NullOr({ approved: Number, required: Number }), unresolvedThreads: NullOr(Number), url }
PullRequestsListPage { rows: Array(PullRequestsListRow), nextCursor: NullOr(String), totalCount: NullOr(Number), counts: NullOr({ open: NullOr(Number), closed: NullOr(Number), merged: NullOr(Number) }) }
```

Detail:

```ts
PullRequestsMergeReadiness { status: Literals(["mergeable","checks_pending","checks_failing","review_required","changes_requested","conflicts","behind","blocked","draft","merged","closed","unknown"]), summary: String, details: Array(String) /* server-authored lines */, requiredApprovals: NullOr({ approved: Number, required: Number }), autoMerge: NullOr({ enabled: Boolean, method: NullOr(PullRequestsMergeMethod) }), headSha: String }
PullRequestsDetail { number, title, body, state, isDraft, locked: Boolean, lockReason: NullOr(String), author: PullRequestsActor, createdAt, updatedAt, mergedAt, closedAt, mergedBy: NullOr(PullRequestsActor), headBranch, baseBranch, headSha, baseSha, isCrossRepository: Boolean, headRepository: NullOr(String), maintainerCanModify: Boolean, commitCount: Number, changedFiles: Number, additions: Number, deletions: Number, labels, milestone: NullOr(PullRequestsMilestone), assignees: Array(PullRequestsActor), reviewers: Array(PullRequestsReviewer), approvalRules: Array({ name, approved: Number, required: Number, approvers: Array(PullRequestsActor) }), linkedIssues: Array({ reference: String, title: NullOr(String), url }), reactions: PullRequestsReactionSummary, readiness: PullRequestsMergeReadiness, permissions: PullRequestsPermissions, url, tabCounts: { conversation: NullOr(Number), commits: Number, checks: NullOr(Number), files: Number } }
PullRequestsReactionSummary = Array({ content: Literals(["+1","-1","laugh","confused","heart","hooray","rocket","eyes"]), count: Number, viewerReacted: Boolean })
```

Timeline:

```ts
PullRequestsTimelineItem = Union(
  { kind: "comment", id, author, body, createdAt, updatedAt, viewerIsAuthor: Boolean, minimized: Boolean, reactions },
  { kind: "review", id, author, state: Literals(["commented","approved","changes_requested","dismissed","pending"]), body, submittedAt, commitSha: NullOr(String), viewerIsAuthor, canDismiss: Boolean },
  { kind: "thread", id, path, line: NullOr(Number), startLine: NullOr(Number), side: Literals(["left","right"]), isResolved, isOutdated, canResolve: Boolean, diffHunk: NullOr(String), comments: Array({ id, author, body, createdAt, updatedAt, viewerIsAuthor, reactions, suggestion: NullOr({ id: NullOr(String), applicable: Boolean, fromLine, toLine, fromContent, toContent }) }) },
  { kind: "event", id, actor: NullOr(PullRequestsActor), event: String /* labeled, unlabeled, assigned, review_requested, closed, reopened, ready_for_review, converted_to_draft, merged, head_ref_force_pushed, milestoned, renamed */, detail: NullOr(String), createdAt })
PullRequestsTimeline { items: Array(PullRequestsTimelineItem), truncated: Boolean }
```

Commits, checks, files:

```ts
PullRequestsCommits { commits: Array({ sha, shortSha, subject, body: NullOr(String), author: PullRequestsActor, authoredAt, url }) }
PullRequestsChecks { groups: Array({ name /* workflow or stage */, checks: Array({ name, state: Literals(["pending","success","failure","cancelled","skipped","neutral"]), url: NullOr(String), startedAt, completedAt, durationSeconds: NullOr(Number) }) }), summary: Literals(["pending","success","failure","neutral","none"]), pipelineUrl: NullOr(String) }
PullRequestsFile { path, previousPath: NullOr(String), changeType: Literals(["added","modified","removed","renamed","copied","binary"]), additions, deletions, patch: NullOr(String) /* unified diff for this file, null when over the cap */, tooLarge: Boolean }
PullRequestsFiles { files: Array(PullRequestsFile), diffRefs: { baseSha, startSha, headSha }, truncated: Boolean }
```

Actions (single mutation method):

```ts
PullRequestsActionRequest = Union of Structs, each with { cwd, number, action: Literal(...) , ...fields }:
  comment { body }                                  editComment { commentId, body }             deleteComment { commentId }
  minimizeComment { commentId, minimized: Boolean } react { targetId: NullOr(String) /* null = the PR */, content, on: Boolean }
  replyThread { threadId, body }                    resolveThread { threadId, resolved: Boolean }
  submitReview { event: Literals(["comment","approve","request_changes"]), body: NullOr(String), headSha, comments: Array({ path, line, startLine: NullOr(Number), side, body }) }
  revokeApproval {}                                 removeOwnChangeRequest {}
  dismissReview { reviewId, message }               rerequestReview { login }
  applySuggestions { suggestionIds: Array(String), commitMessage: NullOr(String) }
  editPullRequest { title: NullOr(String), body: NullOr(String), baseBranch: NullOr(String) }
  setReviewers { add: Array(String), remove: Array(String) }   setAssignees { add, remove }   setLabels { add, remove }   setMilestone { milestoneId: NullOr(String) }
  lock { reason: NullOr(String) }                   unlock {}
  updateBranch { method: Literals(["merge","rebase"]), skipCi: Boolean }
  merge { method: PullRequestsMergeMethod, deleteBranch: Boolean, auto: Boolean, bypass: Boolean, headSha, subject: NullOr(String), body: NullOr(String) }
  disableAutoMerge {}
  setDraft { draft: Boolean }                       close {}   reopen {}   delete {}   revert {}
PullRequestsActionResult = Union(
  { kind: "done" },
  { kind: "reviewSubmitted", landed: Number, failed: Array({ path, line, message }) },
  { kind: "merged", mergedSha: NullOr(String), autoMergeEnabled: Boolean },
  { kind: "pullRequestCreated", number, url } /* revert */,
  { kind: "deleted" })
```

Checkout (separate mutation):

```ts
PullRequestsCheckoutInput { cwd, number, target: Union({ kind: "checkout", cwd }, { kind: "worktree", branchName: NullOr(String) }) }
PullRequestsCheckoutResult = Union({ kind: "checked_out", cwd, branch }, { kind: "worktree_created", cwd, branch, worktreeId: String }, { kind: "blocked", reason: GitManagerBlockedReason })
```

RPC registration (Phase 0):

| `WS_METHODS` key            | Wire name                    | Kind           | Scope                   | payload → success                                          |
| --------------------------- | ---------------------------- | -------------- | ----------------------- | ---------------------------------------------------------- |
| `pullRequestsGetContext`    | `pullRequests.getContext`    | read unary     | `orchestration:read`    | `PullRequestsCwdInput` → `PullRequestsContext`             |
| `pullRequestsGetVocabulary` | `pullRequests.getVocabulary` | read unary     | read                    | `PullRequestsVocabularyInput` → `PullRequestsVocabulary`   |
| `pullRequestsList`          | `pullRequests.list`          | read unary     | read                    | `PullRequestsListInput` → `PullRequestsListPage`           |
| `pullRequestsGet`           | `pullRequests.get`           | read unary     | read                    | `PullRequestsNumberInput` → `PullRequestsDetail`           |
| `pullRequestsGetTimeline`   | `pullRequests.getTimeline`   | read unary     | read                    | `PullRequestsNumberInput` → `PullRequestsTimeline`         |
| `pullRequestsGetCommits`    | `pullRequests.getCommits`    | read unary     | read                    | `PullRequestsNumberInput` → `PullRequestsCommits`          |
| `pullRequestsGetChecks`     | `pullRequests.getChecks`     | read unary     | read                    | `PullRequestsNumberInput` → `PullRequestsChecks`           |
| `pullRequestsGetFiles`      | `pullRequests.getFiles`      | read unary     | read                    | `PullRequestsNumberInput` → `PullRequestsFiles`            |
| `pullRequestsRunAction`     | `pullRequests.runAction`     | mutation unary | `orchestration:operate` | `PullRequestsActionRequest` → `PullRequestsActionResult`   |
| `pullRequestsCheckout`      | `pullRequests.checkout`      | mutation unary | operate                 | `PullRequestsCheckoutInput` → `PullRequestsCheckoutResult` |

All ten use `error: PullRequestsOperationError`. Counts after Phase 0: `ACTIVE_RPC_METHODS` 121 → 131; typed-failure fixtures 278 → the number the generator reports (union error schemas fan out, so it is not one per method; Phase 00 measures it); stream-shape fixtures unchanged at 70. Every phase after 0 that adds a schema variant regenerates fixtures (`vp run --filter @bibcode/contracts fixtures:export` or the script the repo documents — verify the script name in `packages/contracts/package.json`).

Capability flags: `pullRequestsReads`, `pullRequestsMutations` on `ExecutionEnvironmentCapabilities` (default false), advertised `true` in `apps/server/src/production/control.rs` (both the `environment_descriptor` literal and the `environment_descriptor_advertises_complete_worktree_catalog_surface` test list), added to `makeTestExecutionEnvironmentCapabilities`.

Client setting: `pullRequestsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))` in `ClientSettingsSchema` and `ClientSettingsPatch`.

### Client

- **Routes.** `apps/web/src/routes/_chat.project.$environmentId.$projectId.pull-requests.tsx` (list) and `_chat.project.$environmentId.$projectId.pull-requests.$number.tsx` (detail; `validateSearch` for `tab: "conversation" | "commits" | "checks" | "files"`), both copies of the Git Manager route file's shape (params → `scopeProjectRef`, `useProject`, shell-live redirect after 1 000 ms, `ChatRouteInset`).
- **Sidebar.** Fourth hover-strip button after Git Manager; `pullRequestsRouteProjectKey` memo computed from `pathname.includes("/pull-requests")`; the existing `gitManagerRouteProjectKey` memo changes from `endsWith("/git")` to a shared helper `projectModuleRouteProjectKey(pathname, …)` that returns the key when the path matches `/git` or `/pull-requests(/…)?`; the row's `isActive` / `aria-current` use either.
- **Atoms.** `packages/client-runtime/src/state/pullRequests.ts` exports `createPullRequestsEnvironmentAtoms(runtime)` with query families `getContext` (stale 60 s), `getVocabulary` (60 s), `list` (5 s), `get` (5 s), `getTimeline` (5 s), `getCommits` (30 s), `getChecks` (5 s), `getFiles` (30 s), and commands `runAction`, `checkout` sharing `vcsCommandScheduler` / `vcsCommandConcurrency`. `apps/web/src/state/pullRequests.ts` instantiates `pullRequestsEnvironment`.
- **Availability.** `apps/web/src/components/pullRequests/pullRequestsAvailability.ts`: `resolvePullRequestsAvailability(connectionState, serverConfig, clientSettings)` → `{kind:"ready"} | {kind:"disabled_in_settings"} | {kind:"pending",reason} | {kind:"disconnected",reason} | {kind:"unsupported",missingCapability}`; `mutationsDisabledReason(serverConfig)`.
- **Store.** `apps/web/src/pullRequestsStore.ts`: zustand + persist (`bibcode:pull-requests-state:v1`, version 1), `byProjectKey` limited to 2 entries: `{ checkoutCwd, listTab, filters, sort, scrollTop, lastNumber, viewedFiles: Record<number, string[]>, drafts: Record<number, { comment, pendingReview: PendingInlineComment[], mergeSubject, mergeBody, titleEdit, bodyEdit, commentEdits: Record<string,string> }> }`.
- **Components** (`apps/web/src/components/pullRequests/`): `PullRequestsPanel.tsx` (availability + context + list/detail switch), `list/PullRequestsListView.tsx`, `list/PullRequestsFilters.tsx`, `list/PullRequestsRow.tsx`, `detail/PullRequestsDetailView.tsx`, `detail/PullRequestsHeader.tsx`, `detail/PullRequestsSideColumn.tsx`, `detail/PullRequestsConversation.tsx`, `detail/PullRequestsCommits.tsx`, `detail/PullRequestsChecks.tsx`, `detail/PullRequestsFiles.tsx`, `detail/PullRequestsMergeBox.tsx`, `review/PullRequestsReviewPopover.tsx`, `review/PullRequestsInlineComment.tsx`, `review/PullRequestsSuggestion.tsx`, `shared/PullRequestsMarkdown.tsx` (react-markdown + remark-gfm + the existing sanitiser schema + `img` → link component), `shared/PullRequestsActor.tsx` (initials), `shared/PullRequestsReactions.tsx`, `shared/PullRequestsPermissionButton.tsx` (button with `disabledReason` → `title` + `aria-describedby` hidden span, same as `GitManagerPanel.tsx:844-866`), `PullRequestsCheckoutMenu.tsx`. Every component has a co-located `.test.tsx`; pure logic lives in `.logic.ts` with `.logic.test.ts`.
- **Diff rendering.** `PullRequestsFiles.tsx` reuses `FileDiff` from `@pierre/diffs/react` and `classifyDiffPayload` from `components/gitManager/history/diffLadder.ts`; the gutter click/drag handler is the module's own (`review/inlineCommentGutter.logic.ts`).
- **Settings.** `SourceControlSettings.tsx` gains a `SettingsRow` "Pull requests" (`Switch`, `updateSettings({ pullRequestsEnabled })`) above the providers section, and the GitHub/GitLab rows list every configured host.

## Phases and rounds

Execution is **sequential**: one Codex task at a time in this worktree, one phase per task, review between phases. Parallelism is not used because Codex tasks share the working tree and Phases 0/1/3/5/7 all edit the RPC registries.

| #   | Phase file                                       | Delivers                                                                                                                                                                                                                                                      | Depends on            |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 00  | `phases/PHASE-00-contracts.md`                   | Contract schemas, ten RPCs, capability flags, client setting, scopes, `ACTIVE_RPC_METHODS`, fixtures + counts, registration tripwire, client-runtime atoms + package export                                                                                   | —                     |
| 01  | `phases/PHASE-01-server-context-list.md`         | `pull_requests` module skeleton, `HostCommandRunner`, error mapping, context/availability/capabilities, vocabularies, list for GitHub (GraphQL cursors) and GitLab (pages); RPC service registering all ten methods (unimplemented ones return `unavailable`) | 00                    |
| 02  | `phases/PHASE-02-web-shell-list.md`              | Routes, sidebar button + highlight, store, availability, settings switch + host list, list view (tabs, filters, rows, load more, states), Git Manager pane link                                                                                               | 00 (01 for live data) |
| 03  | `phases/PHASE-03-server-detail-reads.md`         | detail + permissions, timeline, commits, checks/pipelines, files/diffs for both hosts                                                                                                                                                                         | 01                    |
| 04  | `phases/PHASE-04-web-detail-read.md`             | Detail route view: header, four tabs, side column, merge box states, markdown with image links, checks, files with `FileDiff` and viewed state                                                                                                                | 02, 03                |
| 05  | `phases/PHASE-05-server-review-mutations.md`     | `runAction` for comment/edit/delete/minimize/react/reply/resolve/submitReview/revoke/removeOwnChangeRequest/dismiss/rerequest/applySuggestions on both hosts                                                                                                  | 03                    |
| 06  | `phases/PHASE-06-web-review.md`                  | Comment box, comment edit/delete, reactions, thread replies/resolve, inline comments (single/multi-line), suggestion blocks + apply, review popover, partial-failure handling, drafts                                                                         | 04, 05                |
| 07  | `phases/PHASE-07-server-edit-merge-state.md`     | `runAction` for editPullRequest/setReviewers/setAssignees/setLabels/setMilestone/lock/unlock/updateBranch/merge/disableAutoMerge/setDraft/close/reopen/delete/revert                                                                                          | 05                    |
| 08  | `phases/PHASE-08-web-edit-merge-state.md`        | Editable title/body/base, side-column pickers with undo, merge box controls, auto-merge, bypass, overflow actions, confirmations                                                                                                                              | 06, 07                |
| 09  | `phases/PHASE-09-checkout.md`                    | `pullRequests.checkout` server (guards, `gh pr checkout` / `glab mr checkout`, fetch head ref + managed worktree) and the Checkout split button + "Open Git Manager there"                                                                                    | 07, 08                |
| 10  | `phases/PHASE-10-docs-telemetry-verification.md` | Living docs, telemetry tripwires (web + server), desktop e2e sibling, Playwright GitHub run, GitLab run recorded as pending, `handoff.md`                                                                                                                     | all                   |

### File-conflict matrix

Sequential execution makes conflicts impossible between phases; the matrix records the shared files each phase must re-read before editing because an earlier phase changed them: `packages/contracts/src/rpc.ts` (00), `packages/contracts/src/pullRequests.ts` (00, 03, 05, 07 add variants), `apps/server/src/rpc/methods.rs` (00), `apps/server/src/auth/scope.rs` (00), `apps/server/src/production/pull_requests_rpc.rs` (01, 03, 05, 07, 09), `apps/server/src/pull_requests/**` (01, 03, 05, 07, 09), `apps/web/src/components/Sidebar.tsx` (02), `apps/web/src/components/pullRequests/**` (02, 04, 06, 08, 09), `packages/contracts/fixtures/rpc-wire/**` (00, 03, 05, 07, 09).

## Risks

- **Host payload drift.** `gh --json` field sets and GitLab REST shapes vary by version. Mitigation: adapters parse defensively (`serde_json::Value` → model with explicit `Option`s), every parse has a fixture test from the live-verification addendum, unknown enum strings map to `unknown` variants rather than failing.
- **Rate limits.** GitHub search-qualifier listing and GraphQL cost. Mitigation: no polling, 30-row pages, one GraphQL query per read, `rate_limited` error with reset time.
- **GitLab request-changes is GraphQL-only and version-gated.** Mitigation: `glab api version` in context; capability `requestChanges` false below 17.2 with a reason.
- **Inline comment positions.** GitLab needs `base_sha/start_sha/head_sha` from `/versions`; GitHub needs `line/side` on the latest commit. Mitigation: `getFiles` returns `diffRefs`; `submitReview` carries `headSha` and fails with `stale_head` when it moved.
- **Large PRs.** 8 MiB patch cap → per-file `tooLarge` with host link; files list still renders.
- **Checkout guards.** Reuse `git::manager::guards` and the worktree catalog lock; never `--ignore-other-worktrees`.
- **Playwright coverage of mutations** on a real repository. Mitigation: a throwaway PR on `mubeda/BibCode` for comment/label/checkout; merge/close/delete verified against the permissions rendering and fixture tests, not against production repositories.

## Validation

Per phase (Codex runs, coordinator re-runs): focused tests; `vp check`; `vp run typecheck`; for Rust `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server <filter> -j 2`; for contracts `vp run --filter @bibcode/contracts test`; for web `vp run --filter @bibcode/web test -- <pattern>` plus `vercel-react-best-practices` and `UI.md` review; for scripts `vp run --filter @bibcode/scripts test` after any workflow edit. Web phases end with a Playwright script in the coordinator's scratchpad against `vp run dev` (browser mode) and screenshots reviewed by the coordinator.

Phase 10: `vp run test` (whole graph), `cargo test -p bibcode-server -j 2`, the telemetry tests, the desktop e2e spec in the packaged app where the runbook allows, and the GitHub end-to-end script.

## Documentation to update

- `docs/user/workspace-ui.md` — new "Pull Requests" section after "Git Manager"; sidebar highlight sentence.
- `docs/integrations/source-control-providers.md` — capability matrix rows for list/review/merge/edit/checkout per host; setup notes for self-hosted GitLab and GHE hosts; version gates.
- `docs/architecture/rpc-and-orchestration.md` — "Pull Requests flow" section with the ten methods, scopes, and the no-polling invariant.
- `docs/architecture/overview.md` — module ownership paragraph next to the Git Manager's.
- `docs/user/keybindings.md` — note that the module registers no keybinding commands.
- `docs/testing/*` — runbooks that enumerate packaged UI flows gain the Pull Requests sidebar button and list/detail smoke steps.
- `docs/plans/pull-requests/handoff.md` — filled by the coordinator at the end.
