# Pipelines Module

Status: Approved 2026-10-25 with every recommended answer.

Scope: a project-level Pipelines module beside Git Manager and Pull Requests.
It lists a project's CI pipelines (GitLab pipelines, GitHub Actions workflow
runs), shows one pipeline's stages and jobs, and shows one job's log. It builds
on the Pull Requests module and on
[the GitLab live pipeline design](2026-10-24-gitlab-live-pipeline-design.md)
(issue #156). It reuses that design's host-wide 429 ladder, logout fences and
snapshot table, and does not change its merge request poller's behavior.

Revised twice: after a Codex review (see Review at the end), and after the
product owner's requirement that Pipelines be as fast as the Pull Requests
module and be built the way it is. That second revision adopts the Pull
Requests module's stored-context first paint, `readSnapshot` paint on open,
cooperative `subscribe` poller, request-driven caches and client query
policy; [Performance parity with Pull Requests](#performance-parity-with-pull-requests)
lists every remaining departure and its reason.

## Problem

BiBCode shows a pipeline only inside a merge request: the merge box summary and
the Pipelines tab of one merge request. A user who wants to know why `main` is
red, whether last night's scheduled pipeline passed, or what a failing job
printed, has to leave BiBCode for GitLab or GitHub. Even inside a merge
request, a job row is only a link out: BiBCode cannot show its log.

The product owner asked for:

- A **Pipelines** button next to Git Manager and Pull Requests on each project
  row, and, in the Repositories view, on the repository row next to the Pull
  Requests button.
- The same behavior as Pull Requests: one route per environment and project,
  a list like GitLab's Pipelines page (status with duration and age, number,
  title, ref or merge request, sha, creator, badges such as latest, merge
  request, scheduled, branch, a stage strip, and retry, cancel and artifacts
  actions).
- A pipeline page: header (status, created and finished, commit, ref, job
  count, duration) and stages with their jobs.
- A job page: the log with ANSI colors, line numbers, timestamps, collapsible
  sections, search, scroll to top and bottom, and a side panel (duration,
  finished, queued, timeout, runner, source, tags, artifacts, commit, pipeline,
  related jobs).

## Current behavior (verified at d189f09de3)

- **Sidebar, project header.** The action strip is always visible. Its
  buttons are Project actions, New worktree, Git Manager (`GitBranchIcon`,
  `data-testid="git-manager-button"`, `apps/web/src/components/Sidebar.tsx:3496`)
  and Pull Requests (`GitPullRequestIcon`, `pull-requests-button`, `:3506-3522`).
  Pull Requests shows only when `pullRequestsEnabled && !environmentCard`
  (`:3361`), with the comment "In the Repositories view the repository row
  owns Pull Requests". The title stops short of the strip through
  `PROJECT_HEADER_ACTION_PADDING` `{3: pr-21/pr-27, 4: pr-27/pr-33}` (`:640-643`)
  and `actionCount: 3 | 4` (`:649`, set at `:3387`).
- **Sidebar, Repositories view.** `SidebarRepositoryPullRequestsButton`
  (`Sidebar.tsx:3701-3745`) collects `group.cards.flatMap(c => c.memberProjects)`,
  asks `chooseProjectMember` (`:574`, a native context menu when several
  environments hold the repository) and navigates to
  `/project/$environmentId/$projectId/pull-requests`. It is the only child of
  `SidebarRepositoryGroup`'s `actions` prop (`Sidebar.tsx:4404`), which renders
  in `data-testid="repository-group-actions-strip"`
  (`sidebar/SidebarRepositoryGroup.tsx:54-59`).
- **Active module highlight.** `projectModuleRouteProjectKey` matches only
  `/(?:git|pull-requests(?:\/\d+)?)/`
  (`components/pullRequests/shared/projectModuleRoute.logic.ts:10`). A new route
  outside the pattern would not highlight its project row.
- **Routes.** `_chat.project.$environmentId.$projectId.{git,pull-requests,pull-requests.$number}.tsx`
  exist. The `$number` route validates its parameter and redirects to the list
  in `beforeLoad`.
- **Module shell.** `PullRequestsPanel` (`components/pullRequests/PullRequestsPanel.tsx:186-387`)
  resolves availability (`resolvePullRequestsAvailability`,
  `pullRequestsAvailability.ts:27`), the project, the checkout `cwd` and its
  worktree `Select`, the provider context (`usePullRequestsContextQuery`), and
  the unavailable, loading and recovery states. None of that is reusable
  outside the panel today; it is one function.
- **Pipeline reads exist only per merge request.** GitLab: GraphQL
  `mergeRequest.headPipeline` (`gitlab/graphql.rs:13` stages only, `:24` with
  up to 100 jobs per stage) and the REST fallback in `checks`
  (`gitlab/mod.rs:771`). GitHub: `gh pr view --json statusCheckRollup`
  (`github/mod.rs:398-416`). There is no project pipeline list, no job detail,
  no job log read (`jobs/:id/trace`, `actions/jobs/:id/logs`) and no pipeline
  or job mutation anywhere in `apps/server`.
- **The wire model has no job identity.** A `PullRequestsChecks` check carries
  `name`, `state`, `url`, `startedAt`, `completedAt` and `durationSeconds`
  (`packages/contracts/src/pullRequests.ts:343-372`). `PIPELINE_QUERY` does not
  select a job `id`. A job page cannot be reached from the merge request tab
  without one.
- **Shared status visuals.** `PullRequestsPipelineStatusIcon`
  (`detail/PullRequestsPipelineSummary.tsx:55-72`) maps each
  `PullRequestsPipelineStatus` (`pullRequests.ts:376`) to a lucide icon whose
  shape carries the status, spins `running` under `motion-safe`, and shows a
  warning triangle for success with warnings. The Pipelines tab's job rows use
  a second, older map (`detail/PullRequestsChecks.tsx:11-18`) and format
  durations as `4m 12s` (`:19-22`).
- **Process path.** Every `gh` and `glab` call goes through
  `HostCommandRunner` (`pull_requests/host.rs:157`, `:172`; GraphQL through
  `glab_api_with_body`, `:260`) to `run_supervised`, with `NO_COLOR=1`
  (`host.rs:318`) and `OutputPolicy::Error` (`:251`, `:342`). `Budget::Read`
  is 30 s and 1 MiB; `Budget::Large` 60 s and 8 MiB (`host.rs:63-82`).
  `OutputPolicy` has only `Truncate` (keeps the head) and `Error`
  (`git/process.rs:16-19`).
- **Errors and backoff.** `from_process_error` (`pull_requests/error.rs:70`)
  classifies `429` and "rate limit" as `rate_limited` (`:113`); retryable codes
  are `timeout`, `rate_limited` and `host_unreachable` (`:65`). The host-wide
  429 ladder lives in `gitlab::poll::Registry` (`gitlab/poll.rs:123`,
  `backoff_until` `:173`, `back_off` `:178`, `recovered` `:196`,
  `BACKOFF_STEPS` `:74`), and only the merge request poller consults it; unary
  reads are not held back. `invalidate_failed_context` (`pull_requests/mod.rs:970`)
  clears every context on `not_authenticated`, `forbidden`, `not_found`,
  `cli_missing` or `cli_too_old`, and also deletes the host's snapshot rows on
  `not_authenticated` or `forbidden`. Rescan calls `invalidate_contexts`
  (`:961`) instead, which leaves snapshots in place. `classify_stderr`
  (`error.rs`) maps any stderr containing "403", "forbidden" or "permission" to
  `forbidden`, whatever resource refused.
- **Account identity.** A resolved context carries the signed-in `account`
  (`context.rs:706`). A sign-in change on the CLI followed by a rescan goes
  through `invalidate_contexts`, not `invalidate_failed_context`.
- **GitLab link helpers.** `parse::pipeline_status` (`gitlab/parse.rs:55`) and
  `parse::web_origin` (`:96`) are `pub(super)`; `parse::host_link` (`:107`) is
  private to `parse.rs`.
- **Tripwires.** `pull_requests` bans host content in `tracing` through
  `LOG_CONTENT_FIELDS` (`mod.rs:2821-2833`: host, repository, branch, title,
  body, login, url, stderr, sha, ref, stage) and requires every module file in
  `SOURCES` (`mod.rs:2874`). `tokio::spawn` is allowed only in
  `production/pull_requests_rpc.rs` (`:336`).
- **Registration points.** Capability flags `pullRequestsReads` and
  `pullRequestsMutations` (`packages/contracts/src/environment.ts:62-63`),
  advertised at `production/control.rs:2602-2603` and asserted at `:6701-6702`.
  Methods in `rpc/methods.rs:135-147`; reads under `orchestration:read`
  (`auth/scope.rs:35-44`), mutations under `orchestration:operate` (`:100-101`).
  `PULL_REQUESTS_UNARY_METHODS` count asserted as 12
  (`production/pull_requests_rpc.rs:485`). WS group in
  `packages/contracts/src/rpc.ts:2019-2028`. Profiler: `is_long_running`
  (`diagnostics/profiler/latency.rs:106`) lists every host-bound
  `pullRequests.*` method; `is_background` (`:171`) has the `pullRequests.`
  prefix only.
- **Settings.** `pullRequestsEnabled` defaults to `true`
  (`packages/contracts/src/settings.ts:157`, patch `:726`); its switch is in
  Settings > Source Control (`components/settings/SourceControlSettings.tsx:463-513`).
- **Pull Requests performance architecture.** What makes the module fast,
  layer by layer:
  - _Context._ `pullRequests.getContext` first answers from the stored
    `context` row with `stale: true` and no host call
    (`context_allowing_stale`, `mod.rs:143`; client `createStoredContextFirst`,
    `client-runtime/src/state/pullRequests.ts:77`), then reads live. Live
    probes and host contexts sit in a request-driven `ContextCache`: 30 s TTL,
    32 entries, one in-flight load per key, errors never cached, and a cleared
    or evicted slot that an in-flight load cannot repopulate (`cache.rs:12-13`,
    `get_or_load` `:84`). The client keeps the context for 60 s
    (`pullRequests.ts:118`).
  - _Snapshot rows._ `pull_request_snapshots` (`snapshot_store.rs`) holds the
    last good payload per (host, project, kind, key): `list` (first pages
    only, `mod.rs:570`), `detail`, `timeline`, `commits`, `checks`, `files`
    (capped at 1 MiB, `FILES_PAYLOAD_CAP`), the poller's `probe` and
    `pipeline`, and `context`. Every unary read of either provider stores its
    row through `store_read` (`mod.rs:532`) with a generation taken before the
    host read, so a slower older read never replaces a newer row; writes check
    the host's `HostFences` so a read that started before a logout writes
    nothing; the table is capped at 32 MiB (`BYTE_CAP`), oldest first.
    `not_authenticated` and `forbidden` delete the host's rows; rescan leaves
    them (`mod.rs:967-985`).
  - _Paint on open._ `pullRequests.readSnapshot` (`mod.rs:418`) resolves the
    host without authenticating and returns the stored rows with zero `gh` or
    `glab` calls. The views pick between the live answer and the stored copy
    with `shownCopy` (by `observedAt`) and `keepNewestCopy` (by `revision`)
    (`detail/snapshotDisplay.logic.ts`), so the screen never moves back.
  - _Cooperative poller (GitLab)._ `pullRequests.subscribe` runs one poller per
    (host, project, list key) inside the stream's spawned RPC call
    (`production/pull_requests_rpc.rs:336`, `gitlab/poll.rs:1266`). One
    subscriber drives host reads under `driver_lock`; the rest wait and take
    over if it leaves. Every tick is broadcast (`EVENT_CAPACITY` 16); each
    subscriber's `Delivery` tracks the per-name revisions it was sent
    (`poll.rs:595-628`), re-sends what a full stream refused, and catches up
    after a lag because revisions are cumulative. Cadence: the list every 20 s,
    an active number every 10 s, quiet after 30 min, at most 3 active numbers
    per key (`poll.rs:61-70`). The poller stores the `pipeline` row itself and
    otherwise only names what changed; the client answers names with
    `readSnapshot` or the unary reads. A 429 backs off every poller of the host
    (`back_off`, `:178`); `classify` (`:635`) ends the poller on
    `not_authenticated` and on `forbidden`.
  - _Client._ The first stream event, even an all-false one, pauses the
    view's 20 s visible timer (`useVisiblePullRequestRefresh`, `paused`;
    `PullRequestsListView.tsx:326-359`). The timer runs only for GitLab
    (`enabled: isGitlab`): GitHub routes paint the stored copy, read once and
    never refresh (`docs/integrations/source-control-providers.md:286`). The
    list's default first page is read alongside the context
    (`PullRequestsPanel.tsx:226-250`, `freshOnOpen`), a hovered row prefetches
    its detail after 150 ms with at most 2 in flight
    (`hoverPrefetch.logic.ts:5-6`), and query atoms are fresh for 5 s (list,
    detail) or 30 s (commits, files) and kept 5 min after the last subscriber
    (`client-runtime/src/state/runtime.ts:745`); `readSnapshot` and
    `subscribe` keep nothing (`idleTtlMs: 0`).
- **No avatar fetches.** "No browser HTTP request or avatar lookup contacts
  the provider" (`docs/integrations/source-control-providers.md:277`);
  `PullRequestsActor` renders initials.
- **No ANSI renderer.** xterm serves live terminals only. The 16-color
  terminal palette for both themes is built in `terminalThemeFromApp`
  (`components/ThreadTerminalPanel.tsx:644`; values at `:690`, `:718`).
  `@legendapp/list` 3.3.10 virtualizes the PR conversation and files lists.
  Web Workers already exist for find in thread
  (`chat/threadFind/threadFindWorkerProjector.ts:45`) and diffs
  (`DiffWorkerPoolProvider.tsx`).
- **Icons.** lucide-react 1.61.0 is installed and ships `workflow`,
  `git-graph`, `square-terminal`, `scroll-text`, `chevrons-down-up`,
  `arrow-up-to-line`, `arrow-down-to-line`, `rotate-ccw`, `circle-stop`,
  `wrap-text` and `download`.

## Goals

1. A Pipelines button on every project header (after Pull Requests) and on
   every repository row in the Repositories view (after Pull Requests), with
   the same member choice, settings gate and highlight as Pull Requests.
2. A pipelines list for GitLab and GitHub that answers "what is running, what
   failed, and on which ref" at a glance, with paging and two filters.
3. A pipeline page with a header and stages of jobs, which follows a running
   pipeline within about 10 s.
4. A job page whose log is readable at 100,000 lines: ANSI colors, line
   numbers, sections, timestamps, search, top and bottom, and following a
   running GitLab job within about 5 s.
5. Retry, cancel and play from the list, the pipeline page and the job page,
   enabled from the host's own permission answers (or, where the host gives
   none, enabled until the host refuses), with disabled states that say why.
6. A stated request budget per open view, governed by the host-wide 429
   ladder.
7. Older servers and older clients keep working; nothing about the merge
   request module changes for a user who never opens Pipelines.
8. **As fast as Pull Requests, built the same way.** Opening any Pipelines
   route paints the last good copy with zero host calls, as `readSnapshot`
   does for merge requests; switching between Pull Requests and Pipelines
   reuses one context answer; on GitLab, any number of windows on the same
   list or pipeline share one poller's host reads. Measured as: a reopened
   list or pipeline paints before its first `glab`/`gh` spawn, and two
   windows on one running GitLab pipeline produce the host reads of one.

## Non-goals (v1)

- Downstream and child pipelines in BiBCode. A trigger job links out to its
  downstream pipeline.
- Browsing or downloading artifacts inside BiBCode. Artifacts are links to the
  host's web pages (Open question 7); GitHub artifact downloads, which need
  an API redirect that expires after one minute, are not offered.
- The job-dependencies (needs) view (Open question 6).
- Running a new pipeline or workflow dispatch, manual job variables,
  deleting pipelines, erasing jobs, approving deployments or fork runs.
- Test reports, coverage graphs, pipeline schedules, pipeline editor.
- Persisting job logs. Pipeline lists, details and jobs get snapshot rows;
  log text never reaches SQLite (Engineering decision 2).
- A GitHub server poller. GitHub pipelines paint from snapshot rows and
  refresh on the Pull Requests module's visible timer; a GitHub poller needs
  its own approved design (Open question 5).
- ETags (deferred, as in the live pipeline design). Provider retry and reset
  headers are honored where the CLI exposes them (Backoff, below).
- GitHub Enterprise Server versions without the `2022-11-28` API.
- Pipelines in the thread's right panel.

## Alternatives considered

### Where the server code lives

**A1. A new top-level `apps/server/src/pipelines/`.** Clean name, but every
helper it needs (`HostCommandRunner`, `HostScope`, `context::resolve_scope`,
`bounded_read`, `invalidate_failed_context`, `from_process_error`,
`gitlab::parse::{pipeline_status, web_origin, host_link}`) is private to
`pull_requests`. It would widen a dozen visibilities and copy the tripwires.
Rejected.

**A2. A submodule of `pull_requests` (recommended).** `pull_requests/pipelines/`
holds the provider-neutral service, model and log chunking;
`pull_requests/gitlab/pipelines.rs` and `pull_requests/github/runs.rs` hold the
provider reads, so the GitLab parse helpers stay where they are. Being inside
`pull_requests` is also what lets Pipelines share the Pull Requests module's
snapshot table, fences, context caches and backoff directly. The only
visibility change is `parse::host_link`, private today, which becomes
`pub(super)` so `gitlab/pipelines.rs` can build links with it; `pipeline_status`
and `web_origin` are already `pub(super)`. The shared invalidation and
`bounded_read` move from `PullRequestsService` methods to functions over the
shared handles, so both services call the same code.
Every new file joins `SOURCES`, so the log-content, spawn, interval and
`reqwest` tripwires apply unchanged. RPCs are namespaced `pipelines.*`.

### How live data arrives

**B1. Client visible-refresh timers only.** Each view re-reads on a cadence
while visible. No new server lifecycle. Every window pays its own reads, a
reopened view waits on the host for its first paint, and it is not how the
Pull Requests module is built for GitLab. Rejected as the GitLab path; kept as
the GitHub path and as the fallback while a stream is down, exactly as the
Pull Requests views use `useVisiblePullRequestRefresh`.

**B2. Snapshot rows, `pipelines.readSnapshot` and a `pipelines.subscribe`
stream on a cooperative poller (recommended for GitLab).** The Pull Requests
module's architecture, applied to pipelines: unary reads store display rows,
`readSnapshot` paints them with zero host calls, and one poller per (host,
project, list key) reads the list and the watched pipelines once for every
subscriber, delivering per-subscriber revisions and honoring the host-wide
ladder. The earlier draft rejected this for its cost (a second watcher map,
revisions, delivery tracking); that cost buys performance parity, and the
proven parts are shared rather than rebuilt (Engineering decision 3).

**B2 for GitHub too (a GitHub poller).** Rejected for v1. The Pull Requests
module keeps GitHub on demand: the background sync design lists GitHub
polling as out of scope, and the live pipeline design's answered question 5
leaves GitHub polling to a later design. GitHub's 5,000-an-hour user limit is
shared with `gh` in the user's own terminal, so a server loop on GitHub is a
product decision (Open question 5). GitHub gets everything else of B2:
snapshot rows, `readSnapshot` paint on open, and the visible timer.

**B3. Provider push (webhooks, Action Cable, GitHub's live log channel).**
Undocumented or unreachable from a desktop behind a VPN, for the same reasons
as the live pipeline design's alternatives A and B. Rejected.

### Job log transport

**C1. Raw text chunks by byte offset (recommended).** One RPC,
`pipelines.getJobLog`, returns a decoded window of the log with `offset`,
`nextOffset`, `totalBytes` and `complete`. Opening a log, loading earlier
text and tailing a running job are the same call. GitLab reads ranges with
`byte_offset`/`byte_limit`; GitHub and older GitLab download once into a
bounded server memory cache.

**C2. Server-parsed lines (GitLab's `Ansi2json` shape).** Saves client CPU,
but the JSON is three to five times the text, so an 8 MiB log becomes a 30 MiB
WebSocket payload, and parsing would run on the server for every viewer.
Rejected; the client parses in a worker.

**C3. xterm in read-only mode.** Correct ANSI for free, but no sections, no
per-line search results, no line anchors, and one WebGL context per log.
Rejected. Shiki's `ansi` grammar (used by chat code blocks) tokenizes the whole
text at once with no line model. Rejected.

### What a GitHub "pipeline" is

**D1. One row per workflow run (recommended).** Matches GitHub's Actions page,
keeps retry and cancel unambiguous (they act on a run), and maps 1:1 to the
REST list and its filters. Shown as "`<workflow name>` #`<run_number>`".

**D2. One row per commit, grouping every workflow run for that sha.** Closer
to GitLab's "one pipeline per push", but there is no REST object for it, a
re-run of one workflow would move the row, retry and cancel would need a
choice, and paging by commit over a run list breaks at page edges. Rejected.

**D3. Check suites.** Include third-party CI, but have no logs, no jobs API
and no re-run for non-Actions apps. Rejected.

### Module shell

**E1. Duplicate `PullRequestsPanel`'s shell.** Fast, but the availability,
worktree, context and unavailable-state logic would drift. Rejected.

**E2. Extract a compound `RepositoryModule` shell (recommended)** used by both
modules, with the Pull Requests panel moved onto it in the same slice and its
tests kept green.

## Decision

A2 + B2 (GitLab; GitHub on snapshots and the visible timer) + C1 + D1 + E2,
with these rules:

1. The context read stays `pullRequests.getContext`, through the same client
   atom family and the same stored-context-first read: one provider context,
   one sign-in state and one unavailable copy for both modules, and moving
   between Pull Requests and Pipelines on one checkout costs no context read
   within the client's 60 s.
2. Seven new RPCs (`pipelines.list`, `pipelines.get`, `pipelines.getJob`,
   `pipelines.getJobLog`, `pipelines.readSnapshot`, the stream
   `pipelines.subscribe`, and `pipelines.runAction`) behind two new capability
   flags (`pipelinesReads`, `pipelinesMutations`). `pipelinesReads` is
   advertised only by a server that registers all six reads; the rollout
   ships them together.
3. A route identifier is the host's global id: GitLab pipeline `id` and job
   `id` (the ids REST, web URLs and the merge request tab's
   `PullRequestsPipeline.id` already use), GitHub run `id` and job `id`.
   `run_number` and `iid` are display only. All fit a JavaScript `Number`.
4. Every route paints first from `pipelines.readSnapshot` (both providers,
   zero host calls), then reads live. On GitLab, live data then arrives
   through `pipelines.subscribe`: a cooperative poller per (host, project,
   list key) reads the list and the subscribed pipelines, stores their rows
   and names what changed; the views answer the names from `readSnapshot`.
   GitHub views, and GitLab views while the stream is not live, refresh on
   the Pull Requests module's visible timer. Every read, unary, timer or
   poller tick, is answered with `rate_limited` without a host call while the
   host is backed off. Polling stops on the server's `terminal` flag, not on a
   client status set.
5. Logs are text chunks addressed by byte offset, parsed in a Web Worker,
   rendered as fixed-height virtualized rows.
6. Status uses the existing `PullRequestsPipelineStatus` and the existing
   status icon, moved to a shared location, so the merge request tab and the
   module look the same.
7. Every list page, detail and job carries `revision`, the
   `snapshot_store::next_generation()` stamp taken before its host read, the
   same number its stored row carries, so the existing `shownCopy` and
   `keepNewestCopy` pick between live, stored and polled copies unchanged.

## Design

### Server

#### Module layout

| File                                | Owns                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_requests/pipelines/mod.rs`    | `PipelinesService`: scope resolution, `bounded_read`, backoff check, error invalidation, action gates, `store_read`, `read_snapshot`, `subscribe`           |
| `pull_requests/pipelines/model.rs`  | serde mirrors of the contracts                                                                                                                              |
| `pull_requests/pipelines/poll.rs`   | the pipelines cooperative poller (GitLab): registry, leases, driver hand-off, ticks, per-subscriber delivery                                                |
| `pull_requests/pipelines/log.rs`    | chunk windowing, UTF-8 boundary cut, the in-memory `LogCache` on `ContextCache` conventions                                                                 |
| `pull_requests/gitlab/pipelines.rs` | GitLab list, detail, job, trace and action reads                                                                                                            |
| `pull_requests/gitlab/graphql.rs`   | `PIPELINES_LIST_QUERY`, `PIPELINE_DETAIL_QUERY` (new documents, never merged into existing ones)                                                            |
| `pull_requests/github/runs.rs`      | GitHub runs, jobs, log and action reads                                                                                                                     |
| `pull_requests/backoff.rs`          | `HostBackoff`: the ladder moved out of `gitlab::poll::Registry`, which keeps a handle to it; GitLab and GitHub hosts share one map keyed by lowercased host |
| `production/pipelines_rpc.rs`       | decoding, `validate_cwd`, id range checks, registration, and the `pipelines.subscribe` stream task; mirrors `pull_requests_rpc.rs`                          |

`PipelinesService` holds `Arc`s to the same `HostCommandRunner`, `GitLabHost`,
`GitHubHost`, `HostBackoff`, `HostFences`, context caches and `Database` as
`PullRequestsService`, built in `with_dependencies` so both modules share one
context cache, one backoff, one logout fence and one snapshot table.
`HostFences` is already a cloneable `Arc` handle (`snapshot_store.rs:19`); the
pipelines registry holds a clone of the merge request registry's, so a logout
raised by either module blocks the other's in-flight writes. `production/pipelines_rpc.rs` joins the
tripwire `SOURCES`, and the `async-task` exemption at `mod.rs:3001` names it
beside `pull_requests_rpc.rs`: it is the one place the stream's task is
spawned, as for `pullRequests.subscribe`. A `trait PipelineHost` (object-safe, `HostFuture`, default methods
returning `unavailable(op)`, like `PullRequestHost` at `host.rs:444`) has
`list`, `detail`, `job`, `job_log` and `run_action`; `PipelinesService::host`
dispatches on `scope.provider`.

#### RPC methods

| Method                   | Kind             | Scope                   | `is_long_running`                                  |
| ------------------------ | ---------------- | ----------------------- | -------------------------------------------------- |
| `pipelines.list`         | `read_unary`     | `orchestration:read`    | yes                                                |
| `pipelines.get`          | `read_unary`     | `orchestration:read`    | yes                                                |
| `pipelines.getJob`       | `read_unary`     | `orchestration:read`    | yes                                                |
| `pipelines.getJobLog`    | `read_unary`     | `orchestration:read`    | yes                                                |
| `pipelines.readSnapshot` | `read_unary`     | `orchestration:read`    | no (database only, as `pullRequests.readSnapshot`) |
| `pipelines.subscribe`    | stream           | `orchestration:read`    | no (stream, as `pullRequests.subscribe`)           |
| `pipelines.runAction`    | `mutation_unary` | `orchestration:operate` | yes                                                |

`"pipelines."` joins the `is_background` prefixes (`latency.rs:171`). Each
method joins `ACTIVE_RPC_METHODS` and its test, `auth/scope.rs` and its tests,
the WS group in `rpc.ts`, and `PIPELINES_UNARY_METHODS` (six) or
`PIPELINES_STREAM_METHODS` (one) with their count tests in
`pipelines_rpc.rs`. Without a database, `readSnapshot` and `subscribe`
answer `unavailable`, as `snapshot_unavailable` does today. Errors use `PullRequestsOperationError`
unchanged, so retryability and copy are shared.

#### Reads per provider

**GitLab** (all through `glab api`, `--hostname` pinned):

- `list`: GraphQL `project(fullPath) { pipelines(first: 15, after, scope, ref) { pageInfo count(limit: 1000) nodes { … } } }`
  with `id iid name ref status detailedStatus { name } source latest
  mergeRequestEventType type yamlErrors failureReason stuck createdAt
  startedAt finishedAt duration queuedDuration path user { name username }
  commit { shortId title webPath } mergeRequest { iid title webPath }
  stages { nodes { name status detailedStatus { name } } } retryable
  cancelable userPermissions { updatePipeline cancelPipeline }`. Fifteen per
  page, as GitLab's own page, because the per-row stages keep the query near
  the 250 complexity cap. GitHub pages hold 20 because REST has no such cost;
  the difference is deliberate and invisible behind "Load more". Fields marked `@gl_introduced` (for example
  `commitTitle`, 19.5) are not used. A "Field doesn't exist" error falls back
  once to a baseline document without `mergeRequestEventType`, `type` and
  `stuck`, and the host is remembered as baseline for the process lifetime.
  `count` is read on the first page of a filter and on Refresh only, and
  reused for 5 min otherwise.
- `detail`: GraphQL `project.pipeline(id: "gid://gitlab/Ci::Pipeline/<id>")`
  with the header fields above plus `totalJobs usesNeeds`, and
  `stages { nodes { name status detailedStatus { name } groups { nodes { name size detailedStatus { name } jobs(first: 100) { pageInfo { hasNextPage } nodes { id name kind status detailedStatus { name } allowFailure startedAt finishedAt duration queuedDuration webPath retryable cancelable playable manualJob downstreamPipeline { id path detailedStatus { name } } } } } } } }`.
  Per-group `hasNextPage` sets `truncated`. The verification run measures
  `queryComplexity` on a large pipeline; if it is over the cap, jobs are read
  per stage in a second wave.
- `job`: REST `projects/:id/jobs/:job_id` (runner, `tag_list`, `artifacts[]`
  including the `trace` entry's `size`, `artifacts_expire_at`, `commit`,
  `pipeline`, `erased_at`, `failure_reason`, `queued_duration`, `web_url`).
  The job's permissions come from the pipeline detail, which the job page
  reads anyway for related jobs.
- `job_log`: REST `projects/:id/jobs/:job_id/trace?byte_offset=N&byte_limit=512000`
  through a new `GitLabHost::api_text` (raw body, no JSON parse). Range
  support is established once per host, never inferred from a short body: the
  first time a trace read returns at least 2 bytes, the server sends one probe,
  `byte_offset=1&byte_limit=1`. A 1-byte body proves the range is honored; a
  longer body proves it is ignored. Until the probe has answered, the host is
  treated as unsupported and reads use the full-download path, so no read
  ever follows a `nextOffset` from an unproven range. Any later body longer
  than `byte_limit` also marks the host unsupported. The answer is kept for
  the process lifetime. (This replaces the research note's "body longer than
  `byte_limit`" test, which cannot detect an ignored range on a log shorter
  than 512,000 bytes.)
- **Trace 404.** GitLab answers 404 both for a missing job and for a job with
  no log yet. On a trace 404 the server reads the job (`jobs/:job_id`,
  `Budget::Read`): a job that is created, pending, waiting or running returns
  `unavailable: not_started`, which the log follow read re-reads while the
  job is active; an erased job
  returns `erased`; a terminal job with no log returns `no_output`; only a
  404 on the job itself is `not_found`.
- `run_action`: REST `POST pipelines/:id/retry|cancel`,
  `POST jobs/:id/retry|cancel|play` through `glab api -X POST`. Job retry
  returns the new job, whose id is returned to the client.

**GitHub** (all through `gh api`, `--hostname` pinned, header
`X-GitHub-Api-Version: 2022-11-28`, which both github.com and GHES serve):

- `list`: `repos/{o}/{r}/actions/runs?per_page=20&page=N` with
  `exclude_pull_requests=false`, `branch`, and `status=in_progress|completed`
  for the Running and Finished tabs, or `actions/workflows/{id}/runs` when a
  workflow filter is set. The cursor is the opaque page number. Filtered
  queries stop at 1,000 results; the list says so at the end. Workflows for
  the filter: `actions/workflows`, read once per list open.
- `detail`: the run and its jobs, concurrently. For the latest attempt,
  `actions/runs/:id` and `actions/runs/:id/jobs?filter=latest&per_page=100`;
  for an earlier attempt, `actions/runs/:id/attempts/:n` and
  `actions/runs/:id/attempts/:n/jobs?per_page=100`, so the header, status and
  timing always describe the attempt whose jobs are shown. The first jobs page
  carries `total_count`; the remaining pages (`page=2…`) are read
  concurrently, up to 10 pages (1,000 jobs). A run with more sets
  `truncated` and `totalJobs`, and the page says "Showing the first 1,000 of
  1,240 jobs." with Open on GitHub. No job is dropped without that notice.
- `job`: `actions/jobs/:id` (steps, labels, runner name and group).
- `artifacts`: `actions/runs/:id/artifacts?per_page=100`, read with the
  pipeline detail and shown on the pipeline page and the job page as a list
  (name, size, expiry). GitHub artifacts belong to the run, not to a job. Each
  links to the run's `html_url`, where GitHub's own page offers the download;
  BiBCode never hands the browser `archive_download_url`, an API URL that
  needs a token and redirects to a one-minute URL.
- `job_log`: `actions/jobs/:id/logs` (a 302 that `gh api` follows to a
  pre-signed URL) for completed jobs, through the full-download path.
- `run_action`: `POST actions/runs/:id/rerun`, `/rerun-failed-jobs`,
  `/cancel`, and `POST actions/jobs/:id/rerun`.

#### Status mapping

Both providers map into `PullRequestsPipelineStatus` (`created`, `queued`,
`running`, `waiting`, `manual`, `scheduled`, `canceling`, `success`,
`failed`, `canceled`, `skipped`, `unknown`) plus `warnings`, a `reason` and a
separate `terminal` flag. The status picks the icon; `terminal` alone decides
whether the poller and the timers keep reading and whether Retry applies, so a completed run is
never polled because its icon is shared with an active state. When `reason`
is set, the label comes from it ("Action required", "Neutral", "Stale"), never
from the status word.

| GitHub `status` / `conclusion`   | Status     | `reason`          | `terminal` |
| -------------------------------- | ---------- | ----------------- | ---------- |
| `queued`, `requested`, `pending` | `queued`   | —                 | no         |
| `waiting`                        | `waiting`  | `approval`        | no         |
| `in_progress`                    | `running`  | —                 | no         |
| `completed` + `success`          | `success`  | —                 | yes        |
| `completed` + `failure`          | `failed`   | —                 | yes        |
| `completed` + `timed_out`        | `failed`   | `timed_out`       | yes        |
| `completed` + `startup_failure`  | `failed`   | `startup_failure` | yes        |
| `completed` + `action_required`  | `manual`   | `action_required` | yes        |
| `completed` + `cancelled`        | `canceled` | —                 | yes        |
| `completed` + `skipped`          | `skipped`  | —                 | yes        |
| `completed` + `neutral`          | `skipped`  | `neutral`         | yes        |
| `completed` + `stale`            | `skipped`  | `stale`           | yes        |
| `completed` + anything else      | `unknown`  | —                 | yes        |
| anything else                    | `unknown`  | —                 | no         |

`action_required` is a conclusion; GitHub's run `status` values are
`queued`, `in_progress`, `completed`, `waiting`, `requested` and `pending`
(the list filter accepts conclusions as `status`, which is why both appear
in its docs). `neutral` and `stale` draw the grey skipped icon, not a green
check: GitHub's checks treat `neutral` as non-blocking, but "Passed" would
claim a run passed that GitHub itself shows as neutral. GitLab sets
`terminal` for `success`, `failed`, `canceled` and `skipped`, the set in
`isTerminalPipelineStatus` (`pullRequestsDetail.logic.ts:110`).

GitLab reuses `gitlab::parse::pipeline_status` (`gitlab/parse.rs:55`) and the
`SUCCESS_WITH_WARNINGS` rule. A failed `allowFailure` job is `failed` with
`warnings: true`, which the shared icon draws as a warning, not a failure.
GitLab `reason` comes from `yamlErrors` (`yaml_error`), `stuck` (`stuck`) and
`failureReason` (`config_error` and friends fold into `failure_reason`, the
text itself never reaches the client).

#### Budgets and the log path

- Reads use `Budget::Read` (30 s, 1 MiB) except the GitLab detail and GitHub
  jobs reads (`Budget::Large`, 60 s, 8 MiB) and logs (below). GraphQL reads
  pass their budget to `glab_api_with_body`, as the live pipeline design
  already requires.
- A new `OutputPolicy::Tail` in `git/process.rs` and
  `SupervisedOverflow::Tail` in `process/supervised.rs` keep the **last** N
  bytes in a ring buffer and report how many were dropped. It is the only
  process-layer change.
- **Range path (GitLab with `byte_offset`).** A request for the tail reads the
  job's trace size from `getJob`: the archived `trace` artifact's `size`,
  which exists only once a job has finished. One RPC performs at most two
  512,000-byte host reads, so a chunk is at most 1,024,000 bytes.
- **Catching up on a running log, bounded.** A running job has no archived
  trace, so its size is unknown. If `glab api -i` exposes the trace route's
  `Content-Length` (verification gate), the first read jumps to the tail.
  Otherwise the first read starts at 0 and the client issues at most three
  further catch-up reads (`refresh: "follow"`, so the backoff deadline applies)
  until a chunk returns less than the maximum. Opening a running log therefore
  costs at most four trace reads, about 2 MB. A log still incomplete after
  them returns `unavailable: too_large_live` with the loaded head kept on
  screen: "This running log is over 2 MB. BiBCode shows it once the job
  finishes; GitLab shows the live end." with Open on GitLab. The log is not
  read again until the job is terminal, when the archived trace's `size`
  lets the next read open at the tail. A size search with one-byte probes
  past the end is a follow-up (Open question 14).
- **Full-download path (GitHub, older GitLab).** `Budget::Log`: 90 s,
  `OutputPolicy::Tail` at 16 MiB. The finished log is held in `LogCache`, in
  server memory only, keyed by (host, account login, project, job id,
  attempt). It follows `ContextCache`'s conventions rather than a bespoke
  LRU: one slot per key with one in-flight download (two windows opening the
  same log cause one download), errors never cached, insertion order
  eviction, and `clear`/`remove` detach slots so an in-flight download cannot
  repopulate them. It differs where a log differs from a context: a byte cap
  (64 MiB in total) beside the entry cap (32), a 10 min idle TTL instead of
  30 s because a finished log is immutable, and a `HostFences` generation
  check on insert so a download that started before a logout stores nothing. The account login comes from the context resolved for the
  same request, so a different signed-in account never matches another
  account's entry. A cache hit is served only after a job read by the current
  account has succeeded within the last 30 s (the job page's `getJob`, or one
  the log read makes itself when the last is older), so a revoked job permission
  takes effect within 30 s and never relies on the cache. `invalidate_contexts`
  (rescan, sign-in change) and `invalidate_failed_context` clear the host's
  entries. A log over 16 MiB returns its last 16 MiB with
  `truncatedHead: true` and the provider's raw-log URL.
- Chunk text is decoded as lossy UTF-8 after cutting the window back to a
  character boundary (at most 3 bytes), so `nextOffset` always points at a
  character start and no character is split between chunks.
- A running job on the full-download path re-downloads at most every 15 s
  and only while the log is under 2 MiB; above that the job page shows
  "Live updates pause for logs over 2 MB" with Refresh and the external link.
  GitHub running jobs do not read the log (below).

#### Backoff, auth and permission failures

- Every pipelines read, whatever its `refresh` (`user`: opening a route,
  Refresh, Load more, Load earlier; `follow`: log catch-up; `timer`), checks
  `HostBackoff::backoff_until(host)` first and returns `rate_limited` with
  `retryAfterSeconds` without a host call while the deadline is ahead. No
  read kind bypasses it, so neither repeated Refresh nor catch-up can reach a
  host that has asked for a pause. `refresh` still decides the
  first-page-only `count` reuse and is kept for diagnostics. Pull Requests
  unary reads keep today's behavior.
- Any `rate_limited` result calls `HostBackoff::back_off(host, provider_hint)`;
  a later success calls `recovered`. The deadline is the later of the ladder
  step (60, 120, 300 s) and the provider's own answer: `Retry-After`, or the
  reset time (GitHub `x-ratelimit-reset`, GitLab `RateLimit-Reset`), capped at
  one hour. Pipelines reads run `gh api -i` / `glab api -i` so these headers
  are on stdout before the body; whether they survive a non-zero exit under
  `OutputPolicy::Error` is a verification gate, and without them the ladder
  alone applies. The header split lives in new `api_with_headers` and
  `graphql_with_headers` variants on `GitLabHost` and `GitHubHost` (and in
  `api_text` for the trace), which return `(status, headers, body)`; the
  shared Pull Requests helpers keep their current arguments and JSON parsing
  unchanged. The same split feeds the trace route's `Content-Length` gate. A GitHub 403 with `x-ratelimit-remaining: 0`, or GitHub's
  secondary-limit message, is `rate_limited`, not `forbidden`. The merge
  request poller and pipelines share the ladder and its deadline, because the
  limits are per user; the extension of `HostBackoff` with a provider hint
  is the only change to the live pipeline design's ladder, and the poller
  benefits from a longer provider deadline without other changes.
- Only `not_authenticated` calls `invalidate_failed_context` (contexts,
  snapshot rows and the host's `LogCache` entries). A `forbidden` or
  `not_found` from a pipelines read is about that resource, not evidence that
  the login or repository access is gone, so it never clears the shared Pull
  Requests context or snapshots. It stays on the page that made the read:
  - list `forbidden`: "Your account can't view pipelines for this project."
    (GitLab: Reporter or higher, or public pipelines);
  - pipeline, job or log `forbidden`: "You can't view this job's log." (or
    pipeline, job), with Open on GitLab/GitHub, while the rest of the page
    stays usable;
  - action `forbidden`: shown at the button (Actions, below).
    The shell's own `pullRequests.getContext` read on mount is the single place
    that discovers a lost login and shows the shared sign-in state. A
    `forbidden` or `not_found` does delete the stored rows of the resource that
    refused (that list key, pipeline or job), as a successful merge request
    action deletes only the acted number's rows, so a reopened page never paints
    a copy the host has just refused.
- The pipelines poller classifies the same way, and so differs from the merge
  request poller's `classify` (`gitlab/poll.rs:635`), which ends on
  `forbidden`: `not_authenticated` ends the poller, deletes the host's rows
  and ends every subscriber with the error; a `forbidden` on the list ends
  that key's subscribers with the list copy above; a `forbidden` or
  `not_found` on one pipeline marks that id unreadable (as the merge request
  poller's `no_jobs`), names it once so its view shows the error, and stops
  reading it while the rest of the key keeps polling.
- A GitHub 404 on `actions/runs` cannot tell "Actions is turned off" from "this
  token can't read Actions" (GitHub answers 404 for both on a private
  repository), so the copy names both: "GitHub didn't return workflow runs
  for this repository. Actions may be turned off, or your sign-in may not be
  allowed to read Actions." with Open on GitHub. A 200 with no runs and an
  empty `actions/workflows` is the separate empty state "This repository has
  no workflows." A `not_found` on a pipeline or job is a stale link, shown on
  that page with a link back to the list; a trace 404 follows the GitLab rule
  above.
- A GitLab pipeline whose `stages` resolve to `null` (no `read_build`) is
  shown with its header and "You can't view this pipeline's jobs."
- Mutations run under `action_gates` keyed by (host, project, target), so a
  double click sends one request. GitLab's per-job retry limit (3 a minute)
  and GitHub's 409 for a finished run come back as their codes with copy.
- An action `forbidden` disables that action at its button with the host's
  reason ("GitHub refused: this sign-in can't run Actions for this
  repository. A fine-grained token needs Actions write.") and is remembered
  in server memory per (host, account login, repository, action kind) until
  the next rescan, so every view of the same repository shows the same
  disabled state.

#### Snapshot rows and paint on open

Pipelines rows live in the existing `pull_request_snapshots` table through
`SnapshotStore`, with three new kinds (no schema migration: `kind` is a text
column):

| Kind               | Key                                                  | Written by                                       |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------ |
| `pipelines_list`   | the list input's snapshot key (scope, ref, workflow) | first-page `pipelines.list` reads and the poller |
| `pipelines_detail` | `<pipeline id>` or `<pipeline id>:<attempt>`         | `pipelines.get` and the poller                   |
| `pipelines_job`    | `<job id>`                                           | `pipelines.getJob`                               |

- Every successful unary read stores its row through the shared `store_read`
  (moved from a `PullRequestsService` method to a function over the shared
  handles, like `bounded_read`), with the generation taken before the host
  read and the `HostFences` check, so the ordering and logout guarantees are
  the merge request module's own. Only first pages are stored, as for
  merge requests; a filtered-out key is never written.
- Rows carry the account login of the context that read them, and
  `readSnapshot` paints a row only when it matches the login in the host's
  stored `context` row. After a CLI account change, the next live context
  read stores the new login, and the other account's rows stop painting
  without a rescan having to delete them. The poller stamps its rows with the
  login of the context cache's last good value (`get_any_age`, as the merge
  request poller reuses it) and writes nothing when it has none.
- `pipelines_detail` payloads are capped at 1 MiB, as `files` rows are
  (`FILES_PAYLOAD_CAP`); a larger detail (a GitHub run near 1,000 jobs) is not
  stored and paints from the live read only. Without the cap one such row
  would push a dozen merge request rows out of the shared 32 MiB `BYTE_CAP`.
- **Logs are never stored.** Log text can carry unmasked secrets, and a single
  log is larger than the whole table's cap. Logs stay in `LogCache` (memory).
- `pipelines.readSnapshot` takes `{ list, pipelineId, attempt, jobId }`,
  resolves the host with `resolve_pending_scope` without authenticating (as
  `mod.rs:427-436`), and returns `{ list, detail, job }`, each
  `{ payload, observedAt }` or null, in one database call with zero
  `glab`/`gh` spawns. It is served on both providers.
- `not_authenticated` deletes the rows with the host's others; rescan leaves
  them; a resource `forbidden`/`not_found` deletes that resource's rows
  (Backoff, auth and permission failures).

#### The pipelines poller (GitLab)

`pipelines.subscribe` runs `pull_requests/pipelines/poll.rs` inside the
stream's spawned call, on the same model as the merge request poller:

- **Keying and sharing.** One poller per (lowercased host, project, list key).
  A subscriber joins with an optional `pipelineId` (pipeline and job routes)
  and holds a lease; the first to take `driver_lock` reads the host, the
  others wait and take over if it leaves; each tick is broadcast to all of
  them. Ten windows on one list cost the reads of one.
- **Per-subscriber delivery.** Each subscriber's `Delivery` holds the
  revisions it has been sent per name (`list`, and `pipeline` for its id).
  It starts from the generation of the rows its `readSnapshot` painted, so a
  joining subscriber is not sent what it already shows; a full stream refuses
  an event and the names are re-sent with the next one; a lagged receiver
  catches up from the next tick, because revisions are cumulative.
- **Ticks.** The first page every 20 s (`IDLE`), compared by fingerprint
  (ids, statuses, stage statuses, `updated` times) and stored and named only
  when it changed. The poller never reads `count`; it reuses the stored
  total, as the merge request poller reuses tab totals for up to 5 min. Each subscribed pipeline that is not `terminal`, up to 3
  per key in join order (`ACTIVE_NUMBERS`), is read every 10 s (`ACTIVE`),
  stored as its `pipelines_detail` row, and named when its fingerprint
  (pipeline status, and each job's id and status) changed; a pipeline seen
  turning `terminal` is read once more and then left. After 30 minutes
  without a change it drops to 20 s (`QUIET_AFTER`). Reads run at most 3 at
  once (`PROBES_AT_ONCE`). The first tick waits one period, because the
  mount's own unary reads cover the start.
- **What it does not read.** Jobs (`getJob`) and logs. A job's status rides
  in its pipeline's detail row, which the job page subscribes to; the job's
  side-panel facts (runner, artifacts) change only at the terminal
  transition, when the view re-reads `getJob` once. Log tails stay unary
  `follow` reads (Live updates, below): each viewer owns its own byte window
  and offset, which is not a display copy the poller can name.
- **Backoff.** Before each tick the driver waits for
  `HostBackoff::backoff_until(host)`, and re-checks after the sleep, exactly
  as `run_subscriber` does; a 429 from a tick calls `back_off`, a later
  success `recovered`. Merge request pollers, pipelines pollers and unary
  pipelines reads of one host share that one deadline.
- **Events.** The first event is all-false and pauses the client's visible
  timer, as for merge requests. `PipelinesChanged { list, pipeline }` names
  what to re-read from `readSnapshot`.
- **Why a sibling poller, not the merge request one.** `gitlab::poll`'s
  registry key, `Watcher`, `Raised` and tick body are merge request shaped
  (numbers, probes, merge statuses, tab names). The pipelines poller shares
  the policy that must not diverge (`HostBackoff`, `HostFences`, the
  snapshot store and `store_read`), uses the same cadence values (20 s, 10 s,
  30 min, 3 active), and mirrors the lease and driver hand-off structure with
  its own tests (Engineering decision 3).

#### Client caching and pagination

- Query atoms follow `state/pullRequests.ts`: `list`, `get` and `getJob` are
  fresh for 5 s and kept 5 min after the last subscriber (the runtime
  default, `runtime.ts:745`), so going back to a list or pipeline inside that
  window paints at once and revalidates; `readSnapshot` and `subscribe` keep
  nothing (`idleTtlMs: 0`), as for merge requests; `getJobLog` keeps nothing
  either, because the log viewer's worker owns the chunks and a second copy
  in the atom cache would double the memory of a 16 MiB log.
- Server state besides the snapshot rows: the shared context caches, the
  GitLab baseline and range flags, the remembered action refusals, the
  job-read authorization times, and `LogCache`. No list or detail is cached
  in server memory: the snapshot row is the cache, as for merge requests.
- GitLab lists page by GraphQL keyset cursor, GitHub by page number; both are
  an opaque `cursor` on the wire, "Load more" in the UI. Only the first page
  is polled, stored and painted; a poller or timer refresh replaces only the
  first page and merges by id (a row's newer `revision` wins), so loaded
  later pages stay put.

### Contracts (`packages/contracts/src/pipelines.ts`)

New file, schema only. Reuses `PullRequestsPipelineStatus`,
`PullRequestsPipelineStage`, `PullRequestsActor` and
`PullRequestsOperationError`.

```ts
const PipelineId = PositiveInt; // baseSchemas.ts:17; pipelines_rpc.rs also range-checks, as for PR numbers
const Refresh = Schema.Literals(["user", "follow", "timer"]); // every kind honors the backoff deadline
export const PipelinesReason = Schema.NullOr(
  Schema.Literals([
    "approval",
    "timed_out",
    "startup_failure",
    "action_required",
    "neutral",
    "stale",
    "yaml_error",
    "stuck",
    "failure_reason",
  ]),
);
export const PipelinesBadge = Schema.Literals([
  "latest",
  "merge_request",
  "merged_results",
  "merge_train",
  "scheduled",
  "branch",
  "tag",
  "api",
  "trigger",
  "manual_run",
  "retried",
  "child",
  "yaml_invalid",
  "stuck",
]);
export const PipelinesRef = Schema.Struct({
  kind: Schema.Literals(["branch", "tag", "merge_request", "other"]),
  name: Schema.String,
  number: Schema.NullOr(Schema.Number), // merge request or PR number
  url: Schema.NullOr(Schema.String),
});
// granted: the host said yes; denied: the host said no (or refused an earlier
// action); unknown: enabled, a refusal is shown at the button (GitHub Actions write)
export const PipelinesPermission = Schema.Literals(["granted", "denied", "unknown"]);
export const PipelinesPermissions = Schema.Struct({
  retry: PipelinesPermission,
  cancel: PipelinesPermission,
});
export const PipelinesRow = Schema.Struct({
  id: PipelineId,
  label: Schema.String, // "#4821" (GitLab) or "CI #312" (GitHub)
  title: Schema.NullOr(Schema.String), // commit title, pipeline name, display_title
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean,
  reason: PipelinesReason,
  terminal: Schema.Boolean, // the provider says nothing more will run; timers stop on this
  ref: PipelinesRef,
  sha: Schema.String,
  actor: Schema.NullOr(PullRequestsActor),
  badges: Schema.Array(PipelinesBadge),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  queuedSeconds: Schema.NullOr(Schema.Number),
  stages: Schema.NullOr(Schema.Array(PullRequestsPipelineStage)), // null: none (GitHub list) or hidden
  attempt: Schema.NullOr(Schema.Number), // GitHub run_attempt
  permissions: Schema.NullOr(PipelinesPermissions), // null: older server or no answer, mutations shown disabled
  url: Schema.NullOr(Schema.String),
});
export const PipelinesListInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  scope: Schema.Literals(["all", "running", "finished"]),
  ref: Schema.NullOr(TrimmedNonEmptyStringSchema),
  workflowId: Schema.NullOr(Schema.Number), // GitHub only; ignored on GitLab
  cursor: Schema.NullOr(Schema.String),
  refresh: Refresh,
});
export const PipelinesListPage = Schema.Struct({
  revision: Schema.Number,
  rows: Schema.Array(PipelinesRow),
  nextCursor: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Struct({ count: Schema.Number, capped: Schema.Boolean })),
  workflows: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
});
export const PipelinesJob = Schema.Struct({
  id: PipelineId,
  name: Schema.String,
  stage: Schema.String,
  kind: Schema.Literals(["build", "trigger"]),
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean,
  reason: PipelinesReason,
  terminal: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  queuedSeconds: Schema.NullOr(Schema.Number),
  permissions: Schema.Struct({
    retry: PipelinesPermission,
    cancel: PipelinesPermission,
    play: PipelinesPermission,
  }),
  url: Schema.NullOr(Schema.String),
  downstreamUrl: Schema.NullOr(Schema.String),
});
export const PipelinesGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  pipelineId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  refresh: Refresh,
});
export const PipelinesArtifact = Schema.Struct({
  name: Schema.String,
  sizeBytes: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.String),
  expired: Schema.Boolean,
  url: Schema.NullOr(Schema.String), // a host web page, never an API URL
});
export const PipelinesDetail = Schema.Struct({
  revision: Schema.Number,
  pipeline: PipelinesRow,
  commit: Schema.Struct({
    sha: Schema.String,
    title: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
  }),
  totalJobs: Schema.NullOr(Schema.Number),
  stages: Schema.NullOr(
    // null: no access to jobs
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: PullRequestsPipelineStatus,
        warnings: Schema.Boolean,
        groups: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            size: Schema.Number,
            status: PullRequestsPipelineStatus,
            jobs: Schema.Array(PipelinesJob),
          }),
        ),
      }),
    ),
  ),
  truncated: Schema.Boolean, // GitLab: a group over 100 jobs; GitHub: a run over 1,000 jobs
  usesNeeds: Schema.Boolean, // reserved for the deferred dependencies view
  artifacts: Schema.Array(PipelinesArtifact), // GitHub run artifacts; empty on GitLab (per job there)
});
export const PipelinesJobInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  jobId: PipelineId,
  refresh: Refresh,
});
export const PipelinesJobDetail = Schema.Struct({
  revision: Schema.Number,
  job: PipelinesJob,
  pipelineId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  runner: Schema.NullOr(
    Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  tags: Schema.Array(Schema.String), // GitLab tag_list, GitHub runs-on labels
  source: Schema.NullOr(Schema.String), // provider literal, shown verbatim as a token
  createdAt: Schema.String,
  artifacts: Schema.Array(PipelinesArtifact), // GitLab: the job's; GitHub: the run's
  steps: Schema.Array(
    Schema.Struct({
      // GitHub; empty on GitLab
      number: Schema.Number,
      name: Schema.String,
      status: PullRequestsPipelineStatus,
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  logBytes: Schema.NullOr(Schema.Number),
  erased: Schema.Boolean,
  rawLogUrl: Schema.NullOr(Schema.String),
});
export const PipelinesJobLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  jobId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  from: Schema.Union([
    Schema.TaggedStruct("tail", {}), // the last chunk
    Schema.TaggedStruct("offset", { offset: Schema.Number }), // follow or load later text
    Schema.TaggedStruct("before", { offset: Schema.Number }), // load earlier text
  ]),
  refresh: Refresh,
});
export const PipelinesJobLog = Schema.Union([
  Schema.TaggedStruct("chunk", {
    text: Schema.String,
    offset: Schema.Number, // byte offset of text[0]
    nextOffset: Schema.Number,
    totalBytes: Schema.NullOr(Schema.Number), // null while unknown
    complete: Schema.Boolean, // the job is terminal and nextOffset is the end
    truncatedHead: Schema.Boolean, // bytes before the earliest reachable offset are gone
    firstLine: Schema.NullOr(Schema.Number), // 0-based line index of text[0]; null when the prefix is unread
  }),
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals([
      "not_started",
      "no_output",
      "erased",
      "expired",
      "live_on_host",
      "too_large_live",
    ]),
    url: Schema.NullOr(Schema.String),
  }),
]);
export const PipelinesRunActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  target: Schema.Union([
    Schema.TaggedStruct("pipeline", { id: PipelineId }),
    Schema.TaggedStruct("job", { id: PipelineId }),
  ]),
  action: Schema.Literals(["retry", "retry_failed", "cancel", "play"]),
});
export const PipelinesActionResult = Schema.Struct({
  pipelineId: Schema.NullOr(Schema.Number),
  jobId: Schema.NullOr(Schema.Number), // GitLab job retry: the new job
});
// Mirrors PullRequestsSubscribeInput / PullRequestsSnapshot / PullRequestsChanged.
export const PipelinesSubscribeInput = Schema.Struct({
  ...PipelinesListInput.fields, // the list key; cursor and refresh are ignored
  pipelineId: Schema.NullOr(PipelineId),
  attempt: Schema.NullOr(Schema.Number),
  jobId: Schema.NullOr(PipelineId), // readSnapshot only; the poller never reads jobs
});
const Stored = <S extends Schema.Top>(payload: S) =>
  Schema.NullOr(Schema.Struct({ payload, observedAt: Schema.Number }));
export const PipelinesSnapshot = Schema.Struct({
  list: Stored(PipelinesListPage),
  detail: Stored(PipelinesDetail),
  job: Stored(PipelinesJobDetail),
});
export const PipelinesChanged = Schema.Struct({
  list: Schema.Boolean, // the stored first page changed
  pipeline: Schema.Boolean, // the subscribed pipeline's stored detail changed
});
```

- `ExecutionEnvironmentCapabilities` gains `pipelinesReads` and
  `pipelinesMutations`, both `withDecodingDefault(false)`. The server
  advertises them in `control.rs` beside the Pull Requests flags and the
  assertion list grows. `pipelinesReads` promises all six reads (`list`,
  `get`, `getJob`, `getJobLog`, `readSnapshot`, `subscribe`) and
  `pipelinesMutations` promises `runAction`; a server advertises a flag only
  in the slice where every method it promises is registered, and a test in
  `pipelines_rpc.rs` asserts that each advertised flag's methods are in
  `PIPELINES_UNARY_METHODS` or `PIPELINES_STREAM_METHODS`. The client
  subscribes only when the context's provider is GitLab and the document is
  visible, the gate Pull Requests views use (`isGitlab && visible`); on
  GitHub the server's `subscribe` answers `unavailable`.
- `revision` on `PipelinesListPage`, `PipelinesDetail` and
  `PipelinesJobDetail` is the generation stamp of the read (Decision rule 7),
  equal to the stored row's `generation`.
- `PullRequestsChecks` checks gain `jobId: Schema.optional(Schema.Number)`.
  GitLab fills it from a job `id` added to `PIPELINE_QUERY`; GitHub fills it
  only when the check's `detailsUrl` is on the context's web origin and has
  the `/actions/runs/<run>/job/<job>` shape (server-parsed, never followed).
- `settings.ts` gains `pipelinesEnabled`, default `true`, with its patch key.
- `vp run check:contracts` regenerates `packages/contracts/fixtures/rpc-wire/`;
  the fixtures are committed with the slice that adds each method.

### Client runtime (`packages/client-runtime/src/state/pipelines.ts`)

`createPipelinesEnvironmentAtoms(runtime)`, exported as
`./state/pipelines`, mirrors `state/pullRequests.ts`: query atom families for
`list`, `get` and `getJob` (stale 5 s, default 5 min idle TTL), `getJobLog`
(stale 0, idle TTL 0: the log view owns its chunks), `readSnapshot` (stale 0,
idle TTL 0, like `pullRequests.readSnapshot`), a subscription atom family for
`subscribe` (idle TTL 0), and a command for `runAction` on the existing
`vcsCommandScheduler`. The context comes from the existing
`pullRequestsEnvironment.getContext` family, not a copy, so its cache, its
stored-context-first read and its rescan bypass are shared. `apps/web/src/state/pipelines.ts`
binds it as `pipelinesEnvironment`.

### Web

#### Routes

| Route                                                                  | View     | Search params              |
| ---------------------------------------------------------------------- | -------- | -------------------------- |
| `/project/$environmentId/$projectId/pipelines`                         | list     | `scope`, `ref`, `workflow` |
| `/project/$environmentId/$projectId/pipelines/$pipelineId`             | pipeline | `attempt` (GitHub)         |
| `/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId` | job      | `at` (byte offset)         |

Each validates its numeric parameters in `beforeLoad` and redirects to its
parent when one is invalid, as the `$number` route does. The list route
renders `<Outlet/>` when a child matches, like `PullRequestsListRouteView`, and
keeps the same missing-project redirect. `projectModuleRouteProjectKey`'s
pattern widens to `(?:git|pull-requests(?:\/\d+)?|pipelines(?:\/\d+(?:\/jobs\/\d+)?)?)`.
Filters live in the URL so Back and a copied route keep them; the last filter
per project is remembered in `usePipelinesStore` (persisted, two most recent
projects, like `usePullRequestsStore`), along with the checkout `cwd`, which
is shared with Pull Requests through the extracted shell.

#### Module shell (composition)

`components/repositoryModule/` extracts the shell from `PullRequestsPanel`
into a compound component whose provider is the only place that knows how
availability, `cwd`, catalog and context are resolved
(`state-decouple-implementation`, `state-context-interface`):

```tsx
<RepositoryModule.Provider projectRef={projectRef} module={pipelinesModule}>
  <RepositoryModule.Gate>
    {" "}
    {/* disabled, unsupported, signed out, loading */}
    <RepositoryModule.Header>
      <RepositoryModule.Identity /> {/* provider icon, repository, host, account */}
      <RepositoryModule.WorktreeSelect />
      <PipelinesHeaderActions /> {/* Refresh, Open on GitLab */}
    </RepositoryModule.Header>
    <Outlet />
  </RepositoryModule.Gate>
</RepositoryModule.Provider>
```

`module` is a small descriptor (`{ id, label, settingKey, readsCapability,
mutationsCapability, disabledMessage }`), not a set of booleans
(`architecture-avoid-boolean-props`). The context value is
`{ state: { availability, project, cwd, context }, actions: { rescan, recover, setCwd }, meta: { module, mutationsDisabledReason } }`,
read with `use(RepositoryModuleContext)`. `PullRequestsPanel` moves onto it in
the same slice; its tests are the regression check.

The shell also owns the Pull Requests panel's open-time speedups, so both
modules get them from one place: the context read with stored-context first
paint, and the default first page read alongside the context while the
context is pending (`PullRequestsPanel.tsx:226-250`, `freshPage` and
`freshOnOpen`). The descriptor gains `firstPagePrefetch(store, cwd)` (Pull
Requests: `firstPagePrefetchInput`; Pipelines: the stored filters' first
page, which needs no context field) and `listAtom`, so the shell starts the
list's first page and the list view consumes it without a second read.
`snapshotDisplay.logic.ts` (`shownCopy`, `keepNewestCopy`, `newerObservedAt`)
moves to `components/repositoryModule/` with no re-export alias, and
`useVisiblePullRequestRefresh` and `visibleRefresh.logic.ts` move with it as
`useVisibleModuleRefresh`, gaining one `intervalMs` option (default 20 s, so
Pull Requests behave as today) for the GitHub pipeline cadences and the log
tail.

#### List view

One row per pipeline, `LegendList` with "Load more", a fixed header:

- **Data, as `PullRequestsListView`.** The first page comes from the shell's
  prefetch or `usePullRequestsQuery(list, { freshOnOpen })`; the stored first
  page from `readSnapshot({ ...input, pipelineId: null, jobId: null })`;
  `shownCopy` picks between them, so a reopened list paints at once. On
  GitLab, `subscribe` on the same input pauses the visible timer while its
  stream is live, and a `list` name re-reads `readSnapshot`. On GitHub, or
  while the GitLab stream is down, the visible timer re-reads the first page
  every 20 s; GitHub ignores a late stored copy once its live page answered,
  as `PullRequestsListView.tsx:339-344` does.
- **Hover prefetch.** Hovering a row for 150 ms prefetches its
  `pipelines.get` (and the stored detail), at most 2 in flight per
  environment and not again within 5 s, through the existing
  `hoverPrefetch.logic.ts` gate with a `"pipelines.get"` read kind, so the
  pipeline page usually opens on data already in the atom cache.
- **Toolbar:** tabs All, Running, Finished; a Branch combobox (the project's
  branches from the existing git catalog, free text accepted); on GitHub a
  Workflow select. Refresh lives in the module header.
- **Row, wide (≥ 720 px panel):** Status (shared icon plus label, duration
  `4m 12s`, and age "2 hours ago" with the absolute time as its title),
  Pipeline (title on the first line; `#4821` link, ref with a branch, tag or
  merge request glyph, short sha, badges on the second line), Created by
  (initials and name), Stages (one shared icon per stage, each with the
  accessible name "test: failed" and a tooltip), Actions.
- **Row, narrow:** status icon and title on the first line; label, ref, age
  and stage icons on the second; the actions menu at the end.
- **Badges:** text `Badge`s in `text-xs`: latest, merge request, merged
  results, merge train, scheduled, branch, tag, API, trigger, retried,
  YAML invalid, stuck. GitLab supplies `latest`; GitHub never shows it
  (Open question 12).
- **Actions:** an icon button Retry (`rotate-ccw`) when `permissions.retry`
  is not `denied` and the pipeline is `terminal` and not passed; Cancel
  (`circle-stop`) when `permissions.cancel` is not `denied` and it is not
  `terminal`; a menu with "Retry failed jobs" (GitHub) and "Open on
  GitLab/GitHub". The list offers no artifacts action in v1: neither list read
  returns artifacts, and the pipeline and job pages show them (Open question
  7). Buttons with a `denied` permission render through `PermissionButton`
  with a reason ("You don't have permission to retry pipelines in this
  project.", or the host's refusal remembered from an earlier action). The
  whole row navigates to the pipeline; actions stop propagation and are
  separate tab stops.
- **States:** loading skeleton rows; empty per tab ("No pipelines yet",
  "Nothing running", "No finished pipelines"); "No pipelines on `<branch>`"
  with a Clear filter button; GitHub capped results ("GitHub returns at most
  1,000 filtered runs."); error rows reuse `PullRequestsQueryState`.

#### Pipeline view

- **Data, as `PullRequestsDetailView`.** `get` live, the stored
  `pipelines_detail` row from `readSnapshot`, and `keepNewestCopy` by
  `revision` across live, stored and polled copies, so a newer poller row is
  never replaced by a slower unary answer. On GitLab, `subscribe` with
  `pipelineId` puts the pipeline under the poller's 10 s read while it is not
  `terminal`; a `pipeline` name re-reads `readSnapshot` only (zero host calls
  per tick from the view). On GitHub, the visible timer re-reads `get` while
  the run is not `terminal`, at the interval in the budget table.
- **Header:** shared icon and status label ("Failed", "Passed with
  warnings", "Waiting for approval"), title, then one line: "Pipeline #4821
  created 2 hours ago by Ana Rossi · finished 1 hour ago", then commit
  (`abc1234` external link and title), ref (in-app link to the merge request
  route when `ref.kind` is `merge_request`, otherwise text), "12 jobs",
  duration and queued time. Retry, Cancel, "Retry failed jobs" (GitHub) and
  "Open on GitLab/GitHub" on the right. GitHub shows an Attempt select when
  `attempt > 1`.
- **Stages:** columns in GitLab's order, horizontally scrollable on wide
  panels, stacked on narrow ones. A column has the stage icon, name and
  job count; a job row is a full-width link to the job route: icon, name,
  duration, and one trailing action (Retry, Cancel or Play). A parallel group
  (`size > 1`) is one row "rspec 3" that expands to its jobs. A trigger job
  shows "Downstream pipeline" as an external link. GitHub has no stages: its
  jobs sit in one column titled "Jobs", in the API's order.
- **Truncation:** GitLab: "Showing the first 100 jobs of a stage. Open the
  pipeline for the rest." as in the merge request tab. GitHub: "Showing the
  first 1,000 of 1,240 jobs." with Open on GitHub, shown above the Jobs
  column.
- **Artifacts (GitHub):** below the Jobs column, the run's artifacts (name,
  size, expiry, "Expired" when so), each opening the run's page on GitHub,
  where the download is.
- **No job access:** the header and "You can't view this pipeline's jobs."

#### Job view

Full-height split: the log on the left, a side panel on the right (≥ 960 px)
or a "Details" disclosure above the log (narrower).

- **Data.** `getJob` live and the stored `pipelines_job` row paint the header
  and side panel; the job's status and permissions come from its pipeline's
  detail, painted and polled exactly as on the pipeline view (the job route
  subscribes with its `pipelineId`). `getJob` is re-read once when the job
  turns `terminal` (runner, artifacts and erasure change only then). The log
  is not stored; its tail follows on unary reads (Live updates, below).

- **Header:** icon and status, job name, "Job #998 · stage test · started 4
  minutes ago", Retry / Cancel / Play, "Open on GitLab/GitHub".
- **Log toolbar:** search field with "3 of 17" and previous/next (Enter,
  Shift+Enter); toggles Timestamps (shown only when the log has them), Wrap
  lines, Collapse all / Expand all; Scroll to top and Scroll to bottom;
  "Load earlier" at the top when the first loaded offset is above 0; "Raw
  log" external link. Mod+F focuses the log's search while the job route is
  active, and Escape returns focus to the log. Slice 4 confirms that the
  find-in-thread handler (fallback key at `keybindings.ts:279`) is not mounted
  on module routes, and a test asserts that one press is handled once.
- **Lines:** line number gutter, optional
  timestamp column, text in the app's mono font with the terminal palette from
  `terminalThemeFromApp` (extracted to a shared module) so log colors match the
  terminal in both themes. Section headers are full-width toggles with a
  chevron, the header text and the section duration; `collapsed=true`
  sections start collapsed.
- **Line numbers and line links.** A chunk carries `firstLine` when the
  server knows how many lines precede it: always on the full-download path
  (the whole log is in `LogCache`), and on the range path only once offset 0
  is loaded. Then the gutter shows absolute numbers. When the loaded text
  starts after an unread prefix (a GitLab tail window), the gutter counts from
  the first loaded line, and the "Load earlier" banner says "Line numbers
  start at the first loaded line."; loading back to offset 0 renumbers the
  rows. A line link is addressed by byte offset, not by line number: clicking
  the gutter sets `?at=<byte offset of the line start>` and highlights the
  row. The offset is absolute and never shifts, so a copied link opens the
  window containing it (one `offset` read) without reading the prefix, on
  any path. The link can be shared within BiBCode (Open question 13).
- **Follow:** a running job sticks to the bottom while the user is at the
  bottom; scrolling up stops following and shows "Jump to latest". A finished
  job opens at the bottom too, because failures print last (GitLab does the
  same); `?at=` opens at that line instead.
- **Side panel rows:** Duration (or Elapsed while running), Finished, Queued,
  Runner, Source, Tags, Coverage (GitLab, when present), Artifacts (GitLab:
  the job's artifacts with name, size, expiry and Download and Browse links
  built from the job's web URL on the project origin; GitHub: the run's
  artifacts, each opening the run's page on GitHub), Commit, Pipeline
  (status icon, `#4821` in-app link, ref), Related jobs (a stage select and
  the stage's jobs, each an in-app link, from the pipeline detail), Steps
  (GitHub: each step with its status, and a click jumps to its section).
  **Timeout is not shown:** neither GitLab's public API nor GitHub's exposes
  it.
- **Log states:** "This job hasn't started yet." or, for a started job with
  no output yet, "Waiting for the job's first output." (`not_started`,
  re-read by the log follow read while the job is active); "This job didn't produce
  a log." (`no_output`); "This job's log was erased."; "This running log is
  over 2 MB…" (`too_large_live`, GitLab, above); "This log has expired."
  (GitHub retention); "Showing the last 16 MB of 42 MB." with Raw log
  (`truncatedHead`); for a running GitHub job, the Steps list in place of the
  log with "GitHub shows live logs on its site." and Open on GitHub, until
  the job completes and the log loads (`live_on_host`, pending verification).

#### Log rendering

`components/pipelines/log/`. The viewer is a compound component whose
provider alone knows about the worker, the loaded chunks, follow state, search
and the view toggles; children read it with `use(JobLogContext)`:

```tsx
<JobLog.Provider source={source} initialOffset={at}>
  {" "}
  {/* source: live | complete | unavailable */}
  <JobLog.Toolbar>
    <JobLog.Search />
    <JobLog.TimestampsToggle /> {/* renders only when the log has timestamps */}
    <JobLog.WrapToggle />
    <JobLog.SectionsToggle />
    <JobLog.ScrollButtons />
    <JobLog.RawLink />
  </JobLog.Toolbar>
  <JobLog.LoadEarlier />
  <JobLog.Lines />
  <JobLog.Status /> {/* truncated head, catching up, live, unavailable copy */}
</JobLog.Provider>
```

`source` is a variant, `{ _tag: "live", jobId, attempt }`,
`{ _tag: "complete", jobId, attempt }` or `{ _tag: "unavailable", reason, url }`,
derived from the job's status and the last `getJobLog` answer, so no child
takes `isRunning` or `isGitHub`. The context value is
`{ state: { lines, matches, activeMatch, following, toggles }, actions: { search, next, previous, toggleSection, setToggle, scrollTo, loadEarlier }, meta: { hasTimestamps, truncatedHead, totalBytes } }`.
The job page's side panel uses `JobLog` actions only through the Steps list
(jump to a section), passed as children inside the same provider.

- **Worker (`jobLog.worker.ts`).** Receives text chunks with their offsets
  and keeps the decoded log. One linear pass per chunk:
  - splits lines on `\n`; keeps only the text after the last `\r` in a line,
    and drops `\e[0K`/`\e[K` erase sequences, as GitLab does for progress
    bars;
  - strips a timestamp prefix into a column: GitLab's 32-byte
    `YYYY-MM-DDTHH:MM:SS.ffffffZ xx[EO][+ ]` (a `+` appends to the previous
    line) and GitHub's `YYYY-MM-DDTHH:MM:SS.fffffffZ `, detected from the
    first line;
  - parses SGR state: reset, bold, italic, underline, conceal, strike, and
    their resets; 16 colors, bright colors, 256-color; 24-bit colors
    (GitHub tools emit them, GitLab ignores them) map to the nearest color
    rendered inline; other escapes are dropped. The style at each line start
    is recorded, so any line renders on its own;
  - builds sections from GitLab `section_start:<ts>:<name>[opts]` /
    `section_end` and GitHub `##[group]` / `##[endgroup]` (nested, innermost
    owns the line); GitHub `##[error]`, `##[warning]` and `##[notice]` set a
    line kind drawn with an icon and contrast, not color alone.
  - It returns compact typed arrays (line start offsets, style ids, section
    ids, timestamp ms) and, per visible-range request, the spans of those
    lines only.
  - Search runs in the worker over plain line text (case-insensitive
    substring; no regex in v1) and returns matching line indices, capped at
    10,000 with "10,000+ matches".
- **Rows.** `LegendList` with a fixed item height when wrapping is off (the
  default), estimated heights when it is on. Collapsed sections remove their
  lines from the visible index list in the worker, so the list never renders
  hidden rows. Rows are memoized by (line index, style generation). The
  content wrapper carries `data-text-surface`.
- **Fallback.** If the worker cannot start, the same parser runs on the main
  thread in 64 KiB slices between frames, as find in thread does.
- **Memory.** The client keeps at most 16 MiB of log text per job view;
  "Load earlier" stops there with "Earlier lines are on the host" and the
  Raw log link.

#### Live updates and request budget

Every live read runs only while the document is visible and the view is
mounted, and stops when what it follows is `terminal` (one final read on the
transition). GitLab costs are per poller key, whatever the number of windows
on it; GitHub costs, and GitLab log tails, are per window. A route's open
reads are once: `readSnapshot` (no host call), the context (no host call
within the client's 60 s or the server's 30 s cache, shared with Pull
Requests), and the route's own unary reads.

| View                              | GitLab reads                                                                  | Per hour | GitHub reads                                                                  | Per hour |
| --------------------------------- | ----------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------------------- | -------: |
| Open, any route                   | `readSnapshot` + the route's unary read (list 1, detail 1, job 1 + ≤ 4 trace) |   (once) | `readSnapshot` + list 1, or run + p job pages + artifacts, or job 1           |   (once) |
| List                              | poller: first page every 20 s                                                 |      180 | timer: first page every 20 s while a visible row is not `terminal`, else none |    ≤ 180 |
| Pipeline, active                  | poller: first page 20 s + detail 10 s                                         |      540 | timer: run + p job pages every 10p s (p = ⌈jobs/100⌉ ≤ 10)                    |    ≤ 720 |
| Pipeline, active 30 min unchanged | poller: first page 20 s + detail 20 s                                         |      360 | timer: interval doubles                                                       |    ≤ 360 |
| Job, running                      | the pipeline row above + log tail every 5 s                                   |    1,260 | timer: job (steps) every 10 s + run and job pages every 30p s                 |    ≤ 600 |
| Job, running, `too_large_live`    | the pipeline row above                                                        |      540 | n/a                                                                           |      n/a |
| Pipeline or job, finished         | poller: first page every 20 s                                                 |      180 | none after the final read                                                     |        0 |

- **Shared log tails.** A second window following the same running GitLab
  job does not double the tail reads: `LogCache` keeps the last tail it read
  per (host, account, project, job) for 4 s, and a `follow` read at an offset
  inside it answers from memory, so a job's tail costs at most one host read
  per 4 s (900 an hour) however many windows follow it. Ten windows on one
  running job cost at most 1,440 reads an hour, not 7,740.
- GitHub run artifacts are read with the detail on open and on the terminal
  transition only. A GitLab host's range probe is one extra 1-byte read per
  process lifetime. A finished GitLab pipeline keeps the list poll because the
  subscription carries the list key, as merge request subscriptions do; it is
  what notices a retry's new pipeline.
- Every row is subject to the backoff deadline, so a backed-off host receives
  no reads at all, from the poller, the timers or the user.

Against the limits: a running GitLab job view is 17.5% of a self-managed
7,200-an-hour limit (at most 20% however many windows follow it) and under
1% of GitLab.com's 2,000 a minute; a running GitHub pipeline view is at most 14.4% of 5,000 an
hour per window. The earlier client-timer draft cost 1,200 an hour per GitLab
window, so two windows now cost about half as much. GitLab's runner pushes
logs every 3 s only while someone watches through GitLab's web route; whether
an API trace read counts as watching is a verification gate, so a running job
may lag GitLab's own page by up to 60 s on hosts that don't. The merge request
poller's budget is unchanged: its ticks and the pipelines poller's are
separate reads that share only the backoff deadline.

#### Sidebar button and icon

- **Icon:** lucide `WorkflowIcon` at `size-3.5`: two linked nodes, the same
  stroke family as `GitBranchIcon` and `GitPullRequestIcon`, and close to
  GitLab's linked-circles pipeline glyph. `rocket` means Deployments in
  GitLab, `git-graph` reads as history next to Git Manager, and
  `square-terminal` reads as Terminal (Open question 2).
- **Project header:** a Pipelines button after Pull Requests,
  `aria-label="Pipelines for <project>"`, `data-testid="pipelines-button"`,
  tooltip "Pipelines", through a `runProjectMemberAction` handler like
  `handleOpenPullRequestsClick`. `showsPipelinesAction = pipelinesEnabled && !environmentCard`.
  `PROJECT_HEADER_ACTION_PADDING` gains `5: { plain: "pr-33", badge: "pr-39" }`
  and `actionCount` becomes `3 | 4 | 5`, computed from both flags.
- **Repository row:** `SidebarRepositoryPipelinesButton` after
  `SidebarRepositoryPullRequestsButton` in the `actions` fragment,
  `data-testid="repository-pipelines-button"`. Both buttons become explicit
  variants over one hook, `useOpenRepositoryModule(group, to)`, which owns the
  member choice and the mobile sidebar close (`patterns-explicit-variants`).
- The button shows whatever the provider; an unsupported provider, an older
  server or a signed-out CLI is explained on the module page, as Pull
  Requests does, because the sidebar does not know the provider before the
  context read.

#### Settings

Settings > Source Control gains a **Pipelines** switch below **Pull
requests**: "Show the Pipelines button on projects and repositories."
Turning it off hides both buttons; an open Pipelines route shows "Pipelines
is turned off in Settings." with Open Settings, through the shell's gate.

#### Relationship to the merge request Pipelines tab

- `PullRequestsPipelineStatusIcon` moves to
  `components/pipelines/shared/PipelineStatusIcon.tsx` as
  `PipelineStatusIcon`; the PR files import it from there (no re-export
  alias). The older `STATES` map in `PullRequestsChecks.tsx` maps
  `CheckState` onto it, so jobs look the same in both places.
- In the merge request tab, when `pipelinesReads` and `pipelinesEnabled`
  hold and a check has `jobId`, the job name links to the module's job route;
  "Open on GitLab" remains beside it. The summary's `#4821` gains a "View
  pipeline" in-app link.
- The module's stage list is built for reuse: `PipelineStageList` (stacked)
  and `PipelineStageColumns` (wide) are explicit variants over one stage
  model, and job links come from a `PipelineLinksProvider` context
  (`{ jobLink(jobId), pipelineLink(id) }`), so the merge request tab can adopt
  `PipelineStageList` later without a prop for "where am I". v1 ships only the
  icon, the links and the `jobId` (Open question 11).

### UI review (UI.md, craft floor)

- **Mental model:** GitLab users get GitLab's columns, badges and stage strip;
  GitHub users get "Workflow #N" rows like the Actions page. Vocabulary comes
  from the provider ("Pipelines"/"pipeline" on both; GitHub job pages say
  "workflow run" where GitHub would).
- **Safe defaults:** All tab, no filters, the log opens at the end, Wrap off,
  Timestamps off. Retry and cancel need no confirmation: retry is additive and
  a canceled pipeline can be retried (Open question 9). Nothing destructive
  is offered.
- **Disabled states explain themselves** through `PermissionButton`, from the
  host's own answers, never a role guess. GitLab's `userPermissions`,
  `retryable`, `cancelable` and `playable` are `granted` or `denied`. GitHub
  has no read that proves Actions write: a `repositoryPermission` below
  `write` is `denied` ("You need write access to this repository to re-run
  workflows."); `write` or higher is only a hint, so the permission is
  `unknown`, the button is enabled, and a 403 from the action is shown at the
  button with GitHub's reason and turns it `denied` until the next rescan
  (Actions, above). A 403 never shows the sign-in state. An older server
  without `pipelinesMutations`: "Update the server to retry and cancel
  pipelines."
- **Errors are actionable:** rate limited ("GitLab's rate limit was reached.
  Trying again in 60 s.", with a countdown from `retryAfterSeconds`; Refresh
  is disabled with that reason until the deadline, because every read honors
  it), signed out (the shared state with the
  `glab auth login` command), not found ("This pipeline no longer exists."
  and Back to pipelines).
- **Feedback:** an action shows a spinner in its button until the re-read
  lands; a GitHub cancel (202) shows `canceling` until the run says
  otherwise. One polite live region per page announces a pipeline or job
  reaching a terminal status seen while mounted, reusing
  `useFinishedAnnouncement`.
- **Typography and color:** nothing below `text-xs`; secondary text on the
  solid `text-muted-foreground`; status by icon shape and contrast, with
  color as a second channel; monospace only in the log, the sha and the line
  numbers (tabular numerals); the panel edge and the log toolbar on
  `panel-separator`, row dividers on `border`. Spinners only under
  `motion-safe`. Every scroll surface (list, stages, log, side panel) carries
  `data-text-surface`. Focus rings, selection and the log's scrollbar use the
  app tokens.
- **Targets:** rows are whole-row links; icon buttons are at least 24 px with
  labels; the line-number gutter is the click target for a line link, not a
  1 px handle.

## GitHub mapping

| Product term    | GitLab                         | GitHub (recommended)                                                                                                                                                  |
| --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline        | pipeline (`id`)                | workflow run (`id`), labeled "`<workflow>` #`<run_number>`"                                                                                                           |
| Pipeline number | `#id` (GitLab's page shows id) | `run_number`, per workflow                                                                                                                                            |
| Title           | commit title or pipeline name  | `display_title`                                                                                                                                                       |
| Ref             | `ref`, MR from `mergeRequest`  | `head_branch`, PR from `pull_requests[0]`                                                                                                                             |
| Creator         | `user`                         | `triggering_actor` (`actor` when absent)                                                                                                                              |
| Duration        | `duration`                     | `updated_at − run_started_at` for completed runs, as `gh` does                                                                                                        |
| Stage           | stage                          | none; one "Jobs" column                                                                                                                                               |
| Job             | job (`id`)                     | job (`id`), latest attempt; earlier attempts via Attempt                                                                                                              |
| Badges          | `latest`, MR type, source      | from `event`: `schedule` scheduled, `pull_request*` merge request, `merge_group` merge train, `workflow_dispatch` manual run, tag push tag; `run_attempt > 1` retried |
| Retry           | retry (failed jobs)            | Re-run all jobs; "Retry failed jobs" in the menu                                                                                                                      |
| Log sections    | `section_start`/`end`          | `##[group]`/`##[endgroup]`, one per step                                                                                                                              |
| Live log        | trace by range                 | not public: steps progress, then the full log                                                                                                                         |

## Rollout

Each slice is one commit that ships on its own with its tests and docs.
Slices 1-4 are GitLab-only; the module shows "Pipelines for GitHub are coming"
on GitHub until slice 5 (the shell's unsupported state, with an Open on
GitHub link).

1. **Server reads, GitLab.** Contracts (`pipelines.ts`, capability flags,
   setting), all six reads (`pipelines.list`, `pipelines.get`,
   `pipelines.getJob`, `pipelines.getJobLog`, `pipelines.readSnapshot`,
   `pipelines.subscribe`), the three snapshot kinds and `store_read`
   extraction, the GitLab pipelines poller, the range probe,
   `OutputPolicy::Tail`, `LogCache`, `HostBackoff` extraction with the
   provider hint, registration in every list above (and the widened spawn
   exemption), `check:contracts` fixtures, latency entries. No UI. `pipelinesReads` is advertised here
   because every read it promises exists, so no later client can reach an
   unregistered read on a server that advertises it.
2. **Shell, list and sidebar.** `RepositoryModule` extraction with Pull
   Requests on it (including the first-page prefetch, `snapshotDisplay.logic`
   and the visible-refresh hook moves), the list route and view with
   `readSnapshot` paint, `subscribe` and hover prefetch, both sidebar buttons,
   the highlight pattern, the Settings switch, the shared status icon move.
3. **Pipeline page.** Detail route and view with `readSnapshot` paint and the
   `pipelineId` subscription, stage columns and list.
4. **Job page and log (web).** The job route, the worker parser, the
   virtualized viewer, search, sections, timestamps, follow, line links, the
   side panel. Until this slice ships, job rows on the pipeline page link to
   the host.
5. **GitHub.** `github/runs.rs` for list, detail, job and log, stored as
   snapshot rows like GitLab's; the visible timers at the GitHub cadences; the
   Workflow filter, Attempt select and Steps panel.
6. **Actions.** `pipelines.runAction` and `pipelinesMutations` for both
   providers; buttons, gates, disabled reasons, result navigation (a GitLab
   job retry opens the new job; a GitHub re-run opens the run's new attempt).
7. **Merge request links.** `jobId` in `PIPELINE_QUERY` and GitHub checks,
   in-app links from the merge request tab and summary.

Version skew: a new client on an older server sees `pipelinesReads: false`
and the module's "Update the server" state; the merge request tab ignores the
missing `jobId`. A server from slice 1 on serves every read a client of any
later slice calls, because no read is added after slice 1 except GitHub's,
which an older server answers with the provider's unsupported state through
the existing `unavailable(op)` default. An older client ignores the new flags,
methods, setting and fields.

## Test plan (each written to fail first)

**Slice 1 (server, contracts)**

- `gitlab/pipelines.rs`: the list fixture parses ids, labels, refs (branch,
  tag, `refs/merge-requests/<iid>/head`), badges (latest, merge request from
  `mergeRequestEventType`, scheduled from `source`), stages, permissions and
  `reason`; all 13 GitLab statuses plus an unknown string; an
  `allowFailure` failure is `failed` with warnings; a "Field doesn't exist"
  error retries once with the baseline document and remembers it; `count`
  is skipped on a timer read of a later page; job and pipeline links are built
  from the project origin (`web_origin`, `host_link`) and an off-origin
  `webPath` yields `null`.
- Detail: stage order kept; groups with `size > 1`; trigger job with a
  downstream link; per-group `hasNextPage` sets `truncated`; `stages: null`
  for no `read_build`; the global-ID round trip.
- `pipelines/mod.rs`: a `timer`, `follow` and `user` read during host backoff
  each return `rate_limited` with zero `glab` spawns; a 429 from a pipelines
  read backs off the merge request poller's host too (shared `HostBackoff`);
  a `Retry-After` or reset header later than the ladder step sets the later
  deadline, and a missing header leaves the ladder step; a GitHub 403 with
  `x-ratelimit-remaining: 0` is `rate_limited`; `not_authenticated`
  invalidates the context; a `forbidden` or `not_found` from a list, detail,
  job or log read leaves the Pull Requests context and snapshot rows in place
  (asserted against the snapshot store); reads stop on cancellation and time
  out at their budget.
- `backoff.rs`: the poller's existing `gitlab_poller_*` backoff tests pass
  unchanged against the extracted ladder.
- Snapshots, mirroring the merge request tests: `pipelines.readSnapshot` with
  populated `pipelines_list`, `pipelines_detail` and `pipelines_job` rows
  performs zero `glab` and zero `gh` calls (as
  `gitlab_poller_read_snapshot_with_a_populated_row_performs_zero_glab_calls`);
  a unary `list`, `get` and `getJob` store the row `readSnapshot` then
  paints, on GitLab and GitHub; only first pages are stored; a read that
  started before a logout writes nothing (fence); `not_authenticated`
  deletes the host's pipelines rows; rescan leaves them; a `forbidden` on a
  pipeline deletes only that pipeline's row; a row stored under another
  account login is not painted; a `pipelines_detail` payload over 1 MiB is
  not stored; a slower older read never replaces a newer row.
- `pipelines/poll.rs`, mirroring `gitlab_poller_*`: two subscribers of one
  key share one driver and one list read per tick; a dropped driver hands
  the loop to the other subscriber; an undelivered event is re-sent on the
  next tick; a lagged receiver catches up from revisions; a joining
  subscriber is not sent the revision it painted; a subscribed running
  pipeline is read every 10 s and stored, a terminal one once more and then
  not; at most 3 pipelines per key are active; 30 quiet minutes drop to 20 s;
  a 429 backs off every poller of the host, the merge request pollers
  included, and the next tick waits for the deadline; `not_authenticated`
  ends every subscriber and deletes the host's rows; a `forbidden` on one
  pipeline stops reading it, names it once, and keeps the list polling; the
  first event is all-false.
- `LogCache`: two concurrent opens of one GitHub log run one download; a
  `follow` read inside the last 4 s tail answers with zero `glab` calls; a
  cleared slot is not repopulated by an in-flight download.
- `git/process.rs` / `supervised.rs`: `Tail` keeps the last N bytes across
  chunk boundaries and reports the dropped count.
- `pipelines/log.rs`: window cut at a UTF-8 boundary for 2-, 3- and 4-byte
  characters; `before` and `offset` windows; `firstLine` on the full-download
  path and null for a range window after an unread prefix; the range probe:
  a 1-byte answer marks the host supported, a longer one unsupported, a
  host is treated as unsupported until the probe answers, a log shorter than
  512,000 bytes on an ignoring host is never followed from `nextOffset`
  (fixture host that ignores the parameters: no duplicated bytes), and a
  later body over `byte_limit` also marks it unsupported; a running log stops
  after four catch-up reads with `too_large_live`; `LogCache` eviction by size
  and idle time, clearing on `not_authenticated` and on rescan, no hit for a
  different account login on the same host, and a hit older than 30 s since
  the last successful job read performs a job read first (a 403 there
  returns `forbidden`, not the cached text).
- GitLab trace 404: a running job returns `not_started`, an erased job
  `erased`, a terminal job without a log `no_output`, and only a 404 on the
  job read is `not_found`.
- Registration: `ACTIVE_RPC_METHODS`, scope and `is_background` tests name
  every `pipelines.*` method, and `is_long_running` names every host-bound
  one but not `readSnapshot` or `subscribe`; `PIPELINES_UNARY_METHODS` (6) and
  `PIPELINES_STREAM_METHODS` (1) counts; the subscribe stream forwards
  `PipelinesChanged` events and reports a full stream so the poller re-sends
  (as `pull_requests_subscribe_emit_*`); each advertised flag's promised methods are
  registered; `control.rs` advertises `pipelinesReads` from this slice and
  `pipelinesMutations` from slice 6.
- Contracts: decode with and without every optional field; an older
  capabilities object decodes `pipelinesReads: false`; fixtures regenerated.
- Tripwires: the new files, `pipelines/poll.rs` and
  `production/pipelines_rpc.rs` included, are in `SOURCES`; the poller has no
  `interval`; `tokio::spawn` is allowed only in the two RPC files; a fixture
  `tracing` call with a job name field fails the log-content test.

**Slice 2 (shell, list, sidebar)**

- `RepositoryModule`: every availability state renders the same copy for Pull
  Requests as before (existing `PullRequestsPanel.test.tsx` unchanged and
  green), and the Pipelines variant uses its own setting and capability.
- `Sidebar.test.tsx` / `Sidebar.browser.test.tsx`: `pipelines-button` after
  `pull-requests-button`; hidden when `pipelinesEnabled` is false; absent on
  an environment card; `repository-pipelines-button` after the repository Pull
  Requests button; a two-environment repository opens the member menu; the
  padding for five actions keeps the title clear of the strip (browser test
  measures overlap).
- `projectModuleRoute.logic.test.ts`: list, pipeline and job routes highlight
  the project; `/pipelines/abc` does not.
- `RepositoryModule` speedups: the Pipelines first page is read alongside a
  pending context and consumed by the list without a second read; Pull
  Requests' existing prefetch tests stay green.
- List view: a stored first page paints before the live read answers and is
  replaced by it; a late stored copy never replaces a newer one; tabs map to
  `scope`; the Branch filter writes `ref` to the URL; Load more appends; a
  `list` name re-reads `readSnapshot` and keeps page two; badges render; stage
  icons have names; empty and capped states; a row without permission
  renders a disabled Retry with its reason; hovering a row for 150 ms
  prefetches its `get`, at most 2 in flight.
- Budget (vitest fake timers): on GitLab with a live stream the list issues 0
  timer `pipelines.list` calls, and 180 per simulated hour after the stream
  fails; on GitHub 180 with a non-terminal row, 0 with none and 0 while
  hidden.

**Slice 3 (pipeline page)**

- Header copy for each status, warnings and reason; GitHub-style single Jobs
  column from a fixture; group expand; truncated notice for each provider;
  no-access copy; a `forbidden` detail read shows its copy without the
  sign-in state; job rows link to the host while the job route is absent.
- Paint: a stored detail paints before `get` answers; `keepNewestCopy`
  keeps a poller row over a slower unary answer with a lower `revision`; a
  `pipeline` name re-reads `readSnapshot` and issues no `get`.
- Budget: on GitLab with a live stream, 0 `pipelines.get` calls after the
  open read; on GitHub, 720 run-and-jobs reads per hour for a 1-page run
  while running, one final read on the terminal transition, none after; a
  row with `status: "manual"` and `terminal: true` issues no timer reads.

**Slice 4 (job page and log, web)**

- Worker parser unit tests: GitLab and GitHub timestamp prefixes, the `+`
  continuation, `\r` overwrite, `\e[0K`, SGR combinations and resets,
  256-color and 24-bit, nested sections with options and durations, GitHub
  `##[group]` and `##[error]`, a chunk boundary in the middle of an escape
  sequence and of a line.
- **Load:** a generated 100,000-line, 8 MiB fixture with sections and colors
  parses in the worker within a recorded bound (measured on CI hardware, gate
  at twice the measurement), and the mounted log renders fewer than 200 row
  elements; scrolling to the end and searching a term with 5,000 matches keep
  the main thread free of tasks over 50 ms (browser test with a long-task
  observer).
- Viewer: follow sticks at the bottom and stops on scroll up; Jump to latest;
  `?at=` opens at the line from a tail window without reading the prefix;
  gutter numbers are absolute with `firstLine` and relative (with the banner)
  without it, and renumber when offset 0 loads; collapse hides rows; search
  next and previous wrap; Mod+F focuses search on the job route; every
  unavailable reason's copy, including `no_output` and `too_large_live`.
- Budget: a running GitLab job issues at most 4 `getJobLog` calls on open,
  then 720 `getJobLog` calls per hour, no timer `getJob` or `get` (the
  pipeline row comes from the stream), and one `getJob` on the terminal
  transition; in `too_large_live`, no `getJobLog` until the job is terminal;
  a finished job, none after the final read; a stored job row paints before
  `getJob` answers; a GitHub running job issues 360 `getJob` and at most 240
  run-and-jobs reads per hour.

**Slice 5 (GitHub)**

- `github/runs.rs`: the status table row by row, including `terminal`
  and the `neutral`, `stale` and `action_required` labels; labels "CI #312";
  refs and PR numbers; badges from `event`; duration from `run_started_at`;
  workflow filter path; an earlier attempt reads `attempts/:n` for the header
  and `attempts/:n/jobs` for its jobs (fixture: attempt 1 failed, attempt 2
  passed, attempt 1 shows "Failed"); a run with 240 jobs reads three pages
  and shows all 240; a run with 1,240 jobs shows 1,000 with `truncated`;
  run artifacts parse and link to the run page; a 404 on `actions/runs` shows
  the access-neutral copy; a `repositoryPermission` of `write` yields
  `unknown`, below `write` yields `denied`; log download through the
  full-download path; a running job returns `live_on_host`.

**Slice 6 (actions)**

- Each provider and action maps to its endpoint and method; a double click
  sends one request (`action_gates`); GitLab job retry returns the new job id;
  GitHub 409 and GitLab 429 come back with their copy; a GitHub action 403
  disables that action with GitHub's reason, keeps the context and
  snapshots, and is remembered until rescan; mutations need
  `orchestration:operate`; the web navigates after a job retry.

**Slice 7 (merge request links)**

- `PIPELINE_QUERY` jobs carry `jobId`; GitHub `detailsUrl` on another origin
  yields no `jobId`; the tab links in-app only when the module is enabled and
  supported.

## Verification

- Gates per slice: the focused tests above, `cargo fmt --all --check`, Clippy
  on the server targets with `-D warnings`, `vp check`, `vp run typecheck`,
  `vp run check:contracts`. Reviews: `vercel-react-best-practices` and UI.md
  on every web slice.
- Live, GitLab.com and a self-managed CE host: a pipeline with three stages,
  a parallel group, a trigger job, a manual job and an allowed failure; the
  list, pipeline and job pages against GitLab's own pages; a 50 MB log; the
  list query's `queryComplexity`; a Guest account. Time how far a running
  job's log lags GitLab's page.
- Live, GitHub: a repository with two workflows, a matrix job, a re-run
  attempt, a cancelled run, a fork PR waiting for approval.
- **Verification gates (unknowns, not facts):** whether `glab api` passes a
  `text/plain` trace body through unchanged; which GitLab versions honor
  `byte_offset`/`byte_limit`; whether an API trace read makes the runner
  push every 3 s; whether a running GitHub job's log is readable over REST
  (404, partial or empty); the step-log endpoint's numbering; the 404 when
  Actions is disabled (the copy is access-neutral either way); GHES
  behavior of `triggering_actor`; whether `glab api -i` shows the trace
  route's `Content-Length`; whether `gh api -i` and `glab api -i` keep the
  status line and headers on stdout on a non-zero exit, so `Retry-After` and
  the reset headers reach the backoff (without them the ladder alone
  applies); the GitLab web paths for job artifact Download and Browse; and
  whether GitLab's
  current Pipelines page labels rows with `id` or `iid` (it changes only the
  row `label`; routes use `id` either way). Any of them
  answered differently changes only the copy or a fallback named above.
- Profiler on during the live runs: no `rpc.slow` or `subprocess.crash` from
  `pipelines.*`; `glab` and `gh` attributed.
- **Performance parity (Goal 8), measured side by side with Pull Requests on
  the same host:** time from route open to first painted rows for a reopened
  list and pipeline (stored copy, no spawn before paint) and for a cold one;
  `glab` spawns per hour with one and with three windows on one running
  pipeline and its running job (for the pipeline, the three-window count
  equals the one-window count; for the job's log, at most 900 tail reads an
  hour against 720 for one window); and the same with the load harness in
  `docs/reference/scripts.md` used for the merge request poller.

## Documentation to update

| Document                                        | Change                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/user/workspace-ui.md`                     | A Pipelines section after Pull Requests (`:871`): buttons, list, pipeline, job log, actions, the Settings switch                                                                                                                                                                                                    |
| `docs/architecture/overview.md`                 | The Pull Requests module paragraph (`:2624`) gains the Pipelines submodule, its snapshot kinds, its poller and the log cache                                                                                                                                                                                        |
| `docs/architecture/rpc-and-orchestration.md`    | A Pipelines contract boundary beside the Pull Requests one (`:754`): methods, scopes, capability flags, `readSnapshot` and `subscribe`, the stored-copy and visibility rules                                                                                                                                        |
| `docs/integrations/source-control-providers.md` | Command table rows for the new `glab api` and `gh api` reads and actions; the recurring-traffic paragraph (`:279-289`) gains the pipelines poller (GitLab, list 20 s, at most 3 pipelines at 10 s, log tails at 5 s per job) and GitHub's visible timers; the shared 429 ladder; GitHub still has no server polling |
| `docs/testing/cross-platform-validation.md`     | Focused Pipelines commands beside the Pull Requests ones (`:660`, `:682`) and a Pipelines web shell validation section                                                                                                                                                                                              |
| `docs/reference/scripts.md`                     | Reviewed; no new script                                                                                                                                                                                                                                                                                             |
| `docs/skills/bibcode-profiler/references/`      | Reviewed; no new event or finding                                                                                                                                                                                                                                                                                   |

## Profiler coverage

- **Child processes:** every new `glab` and `gh` call goes through
  `HostCommandRunner` to `run_supervised`; `OutputPolicy::Tail` is a new
  overflow mode of the same supervised path, so exits are still reported. No
  new process kind or attribution identity.
- **RPC methods:** all seven registered through the `rpc/session.rs`
  wrappers via `pipelines_rpc.rs`; the five host-bound ones in
  `is_long_running`, and not `readSnapshot` (database only) or `subscribe` (a
  stream), as for their Pull Requests counterparts; `"pipelines."` in
  `is_background`.
- **Shutdown:** no new service. The poller runs inside the
  `pipelines.subscribe` call's spawned task, as the merge request poller
  does, and ends with the stream's cancellation token; no service joins the
  quiesce sequence, so the profiler's teardown stays last. `LogCache` is
  memory owned by `PipelinesService` and drops with it.
- **Logs:** one `tracing::warn!` per failed read class at the service boundary
  (operation, code), one on entering backoff (operation, delay seconds), the
  merge request poller's set for the pipelines poller (failing ticks, failed
  snapshot write by kind and code, recovery at `debug!`, an auth failure
  ending it), none carrying host content. Job names and log text never reach `tracing`; the new
  files join `SOURCES`, and `LOG_CONTENT_FIELDS` gains the field names the new
  code uses for them.
- **Events and findings:** none added.
- Worktree removal and binaries do not apply.

## Trust boundaries

- Log text, job and stage names, refs, titles and badges are host content,
  rendered as text only; the ANSI parser emits spans with class names and
  never HTML. Links are built server-side from the context's web origin and
  open through `shell.openExternal`. No API URL and no pre-signed redirect
  target (GitHub logs and artifacts expire after one minute) is ever handed
  to the browser; Raw log is GitLab's `<job web URL>/raw` and, on GitHub, the
  job's `html_url`.
- Tokens stay in `glab` and `gh`; BiBCode adds no HTTP client. Artifacts and
  raw logs open in the user's browser, which holds its own session.
- Snapshot rows on disk hold what the merge request rows hold (names, refs,
  titles, statuses, permissions), never log text; they are fenced and
  deleted on sign-out, carry the account login that read them, and paint
  only for that login.
- Logs can contain unmasked secrets: they are never persisted, never logged,
  held in server memory for at most 10 minutes idle, keyed by the signed-in
  account, served from memory only within 30 s of a successful job read by
  that account, and cleared on sign-out, rescan and account change.
- A resource-level 403 is not treated as a sign-out: it never clears the
  shared context or the host's snapshot rows (only the refused resource's
  own rows), so one job a user cannot read cannot push every view of the
  host through recovery.
- Remote servers read from the machine whose CLI holds the login, as today.

## Risks

- **GraphQL cost and versions.** The list and detail queries are near
  GitLab's complexity cap and depend on fields that differ by version. The
  baseline fallback and the per-stage split bound it; the live run measures it.
- **Sidebar crowding.** Five always-visible icons shorten project titles by
  another 24 px.
- **Log size.** Logs over 16 MiB show their tail only; on hosts without
  ranges, a 100 MB log download can hit the 90 s budget, which shows the
  "too large" state with Raw log.
- **GitHub live logs** are not public; a running GitHub job shows steps only.
- **Shell extraction** touches the Pull Requests panel; its existing tests are
  the gate.
- **Two windows on one GitHub pipeline** read it twice: GitHub has no poller
  (Open question 5). On GitLab the poller and the shared log tail remove the
  duplicate.
- **Moving the backoff ladder** touches the poller; its tests must stay green
  unchanged. Adding provider deadlines lets a pipelines read hold the poller
  back longer than its own ladder would; that is intended (the limit is per
  user) and capped at one hour.
- **Backoff blocks user reads.** While a host is backed off, Refresh and
  opening a route do not reach it; the route still paints its stored copy,
  with the countdown beside it. That is the price of never ignoring a
  provider's pause.
- **Shared snapshot cap.** Pipelines rows share the 32 MiB table with merge
  request rows, oldest evicted first; heavy Pipelines use can evict merge
  request rows sooner. The 1 MiB detail cap bounds one row; an eviction only
  costs a slower first paint.
- **Sharing is per list key.** Windows share a poller only when their list
  filters match; two filters showing the same running pipeline run two
  pollers that both read it, as two merge request list keys do today. The
  pipeline and job routes subscribe with the filters remembered for the
  project, so the common case shares one key.
- **A second poller to maintain.** The pipelines poller mirrors the merge
  request poller's lease and hand-off code instead of sharing it
  (Engineering decision 3); a fix in one must be checked in the other until
  a shared core is extracted.
- **Stale paint.** A stored copy can be minutes or days old; it is replaced
  by the live answer within one read, and the views show it exactly as Pull
  Requests show theirs.
- **Large running GitLab logs** over 2 MB show their head until the job
  finishes, unless the trace route exposes `Content-Length` (Open question
  14).
- **GitHub permission is optimistic.** With repository write, Retry and
  Cancel are enabled before BiBCode can know the token's Actions permission;
  the first refusal is shown at the button and disables it.
- **Huge GitHub runs** over 1,000 jobs show the first 1,000 with a notice, and
  a 1,000-job run costs 11 reads per refresh, which stretches the pipeline
  timer to 100 s.

## Performance parity with Pull Requests

The product owner requires Pipelines to be as fast as the Pull Requests module
and built the way it is. Each layer of the Pull Requests performance
architecture (Current behavior), and what Pipelines does with it:

| Pull Requests mechanism                                                                                                                                                           | Pipelines                                                                                           | Reason where it departs                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored context first, then live; 30 s server `ContextCache`; 60 s client cache                                                                                                    | **Adopted as is**: the same `pullRequests.getContext` atom family and server caches                 | —                                                                                                                                                                                      |
| Default first page read alongside the context, consumed with `freshOnOpen`                                                                                                        | **Adopted**, moved into the shared `RepositoryModule` shell so both modules get it                  | —                                                                                                                                                                                      |
| Snapshot rows written by every unary read, generation-ordered, fenced, 32 MiB cap                                                                                                 | **Adopted** for lists (first pages), pipeline details and jobs, in the same table                   | Adds a 1 MiB detail payload cap (as `files` has) and an account-login check on paint, because a 1,000-job detail and a CLI account switch are cases merge request rows do not meet     |
| `readSnapshot` paint on open with zero host calls, `shownCopy` / `keepNewestCopy`                                                                                                 | **Adopted** on both providers, with the display logic moved to the shell, not copied                | —                                                                                                                                                                                      |
| Cooperative `subscribe` poller: one per (host, project, list key), driver hand-off, per-subscriber delivered revisions, host-wide 429 ladder, first event pauses the client timer | **Adopted** for GitLab as a sibling poller sharing the ladder, fences and store                     | Not extended to GitHub: Pull Requests keeps GitHub on demand by approved design (Open question 5). Classifies `forbidden` per resource instead of ending the poller (Codex finding 5)  |
| Poller cadence: list 20 s, active 10 s, quiet after 30 min, 3 active per key                                                                                                      | **Adopted** with the same values                                                                    | —                                                                                                                                                                                      |
| Poller stores the `pipeline` row itself and names the rest                                                                                                                        | **Adopted**: it stores list and detail rows                                                         | Does not read jobs or logs: a job's status rides in the detail row, and a log tail is a per-viewer byte window, not a display copy                                                     |
| Visible 20 s client timer, GitLab only; GitHub never refreshes                                                                                                                    | **Adapted**: the timer is the GitLab fallback while the stream is down, and GitHub's only live path | A merge request is static between reads; a running workflow run is not, and Goal 3 needs it followed. Same hook, with an interval option                                               |
| Hover prefetch: 150 ms, 2 in flight, 5 s freshness                                                                                                                                | **Adopted** for pipeline rows (`pipelines.get`)                                                     | —                                                                                                                                                                                      |
| Client atoms fresh 5 s, kept 5 min; `readSnapshot` and `subscribe` kept 0                                                                                                         | **Adopted**; the earlier 60 s idle TTL is dropped                                                   | `getJobLog` keeps 0, because the log worker owns the chunks                                                                                                                            |
| No server memory cache of payloads (the snapshot row is the cache)                                                                                                                | **Adopted** for lists, details and jobs                                                             | Logs keep an in-memory `LogCache`: logs may hold secrets and exceed the table's cap, so they cannot be snapshot rows; it follows `ContextCache`'s single-flight, detach-on-clear rules |
| Unary reads not held back by the 429 ladder                                                                                                                                       | **Departs**: every pipelines read honors the deadline                                               | Codex finding 3: a provider's `Retry-After` must hold user and catch-up reads too                                                                                                      |
| `invalidate_failed_context` on `forbidden` / `not_found`                                                                                                                          | **Departs**: only `not_authenticated`                                                               | Codex finding 5: a job-level 403 is not evidence of lost host access                                                                                                                   |

## Engineering decisions

These were open questions in the earlier draft. They are engineering calls
with one defensible answer, not product choices, so they are settled here.

1. **Initial log window** (was open question 14). On a GitLab host whose
   range support the probe has proved, a log opens on its last 512,000 bytes
   with Load earlier, as GitLab's own page does. Where the whole log is
   downloaded anyway (GitHub, older GitLab, a host not yet probed), it is
   downloaded once into `LogCache` up to 16 MiB and served to the client in
   1 MiB chunks from the end, so the first rows render before the rest
   arrives. Rejected: always the whole log (an extra 16 MiB download on hosts
   that support ranges), and always 512,000 bytes (a second host download per
   chunk on hosts that do not).
2. **Paint on open** (was open question 13, which recommended no persisted
   rows). Reversed by the performance requirement: lists, pipeline details
   and jobs are stored in `pull_request_snapshots` and painted by
   `pipelines.readSnapshot`, exactly as merge request rows are, with the
   module's generations and logout fences reused rather than rebuilt. The
   earlier reasons no longer hold: the fences already exist and are shared,
   and "loads in one read" is still a host round trip (277 ms for a GitLab
   list page and 634 ms for a merge request through `glab`, measured in the
   background sync design) that the stored copy removes. One part of the earlier answer stands: logs are never
   written to disk, because log text can carry unmasked secrets and one log
   exceeds the table's 32 MiB cap.
3. **Where the poller lives.** A sibling `pull_requests/pipelines/poll.rs`
   that shares `HostBackoff`, `HostFences`, `SnapshotStore` and `store_read`,
   and mirrors the merge request poller's lease, driver lock, broadcast and
   delivery structure. Rejected: extending `gitlab::poll`, whose registry
   key, watchers, revisions and tick are merge request shaped and whose
   `forbidden` handling Pipelines must not inherit; and extracting a generic
   poller core first, which would rewrite a just-approved module's 2,000
   lines of tests before Pipelines exists. A shared core is the follow-up
   once both pollers have shipped.
4. **Log cache shape.** In memory, keyed by (host, account login, project,
   job, attempt), on `ContextCache`'s conventions (single flight per key,
   errors never cached, detach on clear), with a 64 MiB byte cap, 10 min idle
   TTL, a `HostFences` check on insert, a 30 s job-read authorization rule
   before serving a hit, and the last 4 s of a running job's tail shared by
   every viewer of that job.

## Open questions

Each needs the product owner's decision. The design above assumes the
recommended answer. Earlier questions 13 and 14 are now Engineering decisions
2 and 1; the former 15 and 16 are renumbered 13 and 14.

1. **Settings switch.** (a) A separate `pipelinesEnabled`, default on;
   (b) reuse `pullRequestsEnabled` for both buttons; (c) no switch.
   **Recommended: (a).** Reviewing merge requests and watching CI are separate
   activities; a team without CI, or with CI outside GitLab and GitHub, can
   hide the button without losing Pull Requests.
2. **Icon.** (a) lucide `workflow`; (b) a custom three-linked-circles glyph in
   `Icons.tsx`; (c) `circle-play` (GitHub's Actions glyph); (d) `git-graph`.
   **Recommended: (a)**, the same stroke family as its neighbors, no custom
   asset, and closest to GitLab's pipeline glyph.
3. **GitHub row unit.** (a) One row per workflow run; (b) one row per commit
   grouping its runs. **Recommended: (a)**, as GitHub's Actions page and its
   API do.
4. **GitHub stage strip in the list.** (a) None; (b) jobs fetched for visible
   running rows (about 20 extra reads per refresh); (c) jobs for every row.
   **Recommended: (a)** in v1; the pipeline page shows the jobs. (b) can follow
   with ETags.
5. **Live updates.** (a) Visible-only client timers on both providers;
   (b) the Pull Requests module's model: snapshot paint on open for both,
   `pipelines.subscribe` on a cooperative server poller for GitLab, and the
   visible timer for GitHub; (c) as (b), plus a cooperative server poller for
   GitHub. **Recommended: (b).** It is how the Pull Requests module is built
   and meets the performance requirement: zero host calls to paint, one
   poller's reads for any number of GitLab windows. (a) pays per window and
   waits on the host for every first paint. (c) would be the first server
   loop against GitHub, whose 5,000-an-hour user limit the user's own `gh`
   shares; the Pull Requests module has kept GitHub on demand by approved
   design, so a GitHub poller should follow with its own design and
   measurements.
6. **Job dependencies view (GitLab "needs").** (a) Defer; (b) include in v1 as
   a "Group jobs by: Stage / Job dependencies" switch when `usesNeeds`.
   **Recommended: (a)**; it is a second GraphQL read and a layered layout, and
   the stage view answers "what failed". `usesNeeds` is already on the wire.
7. **Artifacts.** (a) Host web links only: GitLab job artifacts with
   Download and Browse links on the job page; GitHub run artifacts listed on
   the pipeline and job pages, each opening the run's page on GitHub; no
   artifacts action in the list row; (b) as (a), plus a list-row "Download
   artifacts" menu that reads artifacts per row on open; (c) in-app downloads
   through a server route that resolves GitLab's archive and GitHub's
   one-minute redirect and saves the zip. **Recommended: (a)**; (b) adds a read
   per row for a rarely used action, and (c) moves auth-bearing downloads
   through BiBCode and needs its own trust review.
8. **Creator avatars.** (a) Initials, as Pull Requests; (b) images through a
   server proxy. **Recommended: (a)**; the integration doc forbids avatar
   lookups, and a proxy is a new trust decision.
9. **Cancel confirmation.** (a) None (Retry recovers; GitLab and GitHub
   cancel at once); (b) a confirmation for running pipelines.
   **Recommended: (a)**, per UI.md: confirm only what cannot be undone.
10. **Play manual jobs in v1.** (a) Yes, without variables (GitLab's own play
    button); (b) defer play. **Recommended: (a)**: a blocking manual job is
    the most common reason to open a pipeline. Jobs that need variables are
    run from the host.
11. **Merge request Pipelines tab.** (a) v1 shares the status icon and adds
    in-app links to pipelines and jobs; (b) v1 also replaces the tab's job list
    with the module's `PipelineStageList`. **Recommended: (a)**, then (b) as a
    follow-up once the component has shipped in the module.
12. **"latest" badge on GitHub.** (a) Omit; (b) compute the newest run per
    workflow and branch among loaded rows. **Recommended: (a)**; (b) is wrong
    across page edges and filters.
13. **Shareable line links.** (a) Links addressed by byte offset (`?at=`),
    with gutter numbers absolute when known and relative to the first loaded
    line otherwise; (b) cut line links from v1 and keep the gutter only;
    (c) `?line=N` links that read the whole prefix to count lines.
    **Recommended: (a)**: the offset is exact on every path and costs one
    read to open; (c) costs up to 200 reads on a 100 MB GitLab log.
14. **Running GitLab logs over 2 MB.** (a) Read at most four chunks on open,
    then show the head with "BiBCode shows it once the job finishes" and Open
    on GitLab, unless the trace route exposes `Content-Length`; (b) find the
    end with concurrent one-byte probes at doubling offsets and bisection
    (about 25 tiny reads in four waves), then follow the tail; (c) read from 0
    until caught up, however long. **Recommended: (a)** in v1: bounded and
    simple, with (b) as a follow-up once the verification run shows what
    GitLab returns past the end of a log; (c) breaks the request budget.

## Review

A Codex review of the first draft raised fifteen findings. Each was checked
against the source at d189f09de3 and the provider research notes. All fifteen
were accepted (6 and 13 with a narrower fix than proposed); none was
rejected. Section names below refer to this revision. The product owner's
performance requirement, applied afterwards, kept every disposition; where it
touched one (5, 6, 7, 10, 13), the row says how.

| #   | Finding                                                                                                                                        | Disposition                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | P1. `LogCache` had no account in its key, so after a CLI sign-in change account B could be served account A's private log.                     | **Accepted.** Confirmed: the context carries `account` (`context.rs:706`), and rescan calls `invalidate_contexts`, which never reached the cache. The cache is now keyed by account login, served only within 30 s of a successful job read by the current account, and cleared on rescan and account change.                                                                                | Budgets and the log path; Trust boundaries; Test plan slice 1                                   |
| 2   | P1. "Body longer than `byte_limit`" cannot detect an ignored range on a log under 512,000 bytes, so following `nextOffset` duplicates the log. | **Accepted.** The research note proposed the same flawed test; it is superseded. Range support is now proved once per host by a `byte_offset=1&byte_limit=1` probe, and no read follows an unproven range.                                                                                                                                                                                   | Reads per provider (GitLab `job_log`); Test plan slice 1                                        |
| 3   | P1. User reads, including back-to-back log catch-up, bypassed backoff, and provider retry and reset headers were deferred.                     | **Accepted.** Every read kind now honors the deadline, and catch-up has its own `follow` kind. The deadline is the later of the ladder step and `Retry-After` or the reset header, read through `-i`. Whether those headers survive a non-zero exit is a verification gate, with the ladder as the fallback. The "Retry now" button is replaced by a countdown.                              | Backoff, auth and permission failures; Non-goals; UI review; Verification                       |
| 4   | P1. GitHub runs with more than 100 jobs silently lost jobs.                                                                                    | **Accepted.** Jobs are paged from `total_count` up to 10 pages. Past 1,000 jobs, `truncated` is set and the page says how many are shown. The timer interval stretches with the page count, so the budget holds.                                                                                                                                                                             | Reads per provider (GitHub `detail`); Pipeline view; Live updates and request budget            |
| 5   | P1. Every `forbidden` called `invalidate_failed_context`, clearing the shared context and snapshot rows for a resource-level 403.              | **Accepted.** Confirmed at `mod.rs:970-980`, which also clears contexts on `not_found`. Pipelines now call it only on `not_authenticated`. A `forbidden` or `not_found` stays on the page that made the read and deletes only that resource's stored rows; the pipelines poller likewise stops reading the refused pipeline instead of ending, unlike the merge request poller's `classify`. | Current behavior; Backoff, auth and permission failures; The pipelines poller; Trust boundaries |
| 6   | P2. Absolute `?line=N` links cannot be resolved from a tail chunk.                                                                             | **Accepted, narrower fix.** Line links are addressed by byte offset (`?at=`), which is exact without reading the prefix. Chunks carry `firstLine` when it is known, and gutter numbers are relative, with a notice, when it is not.                                                                                                                                                          | Contracts; Routes; Job view; Open question 13                                                   |
| 7   | P2. Opening a large running GitLab log could take about 100 back-to-back reads.                                                                | **Accepted.** Catch-up stops after four reads (about 2 MB) and falls back to `too_large_live` until the job finishes, unless `Content-Length` is exposed. The open cost is in the budget table. A size search is Open question 14. The poller does not read logs, so the bound is unchanged by the performance revision.                                                                     | Budgets and the log path; Live updates and request budget                                       |
| 8   | P2. GitHub artifact actions had no API read behind them.                                                                                       | **Accepted.** A run artifacts read is added on the pipeline and job pages, and each artifact links to the run's page on GitHub. The list row's "Download artifacts" is removed, because no list read returns artifacts on either provider, and `artifactsUrl` is dropped from the row. A browser cannot follow GitHub's token-bearing API URL.                                               | Reads per provider (GitHub); Contracts; List view; Pipeline view; Open question 7               |
| 9   | P2. An earlier GitHub attempt showed the latest attempt's header.                                                                              | **Accepted.** The detail read uses `actions/runs/:id/attempts/:n` with `attempts/:n/jobs`.                                                                                                                                                                                                                                                                                                   | Reads per provider (GitHub `detail`); Test plan slice 5                                         |
| 10  | P2. `completed` + `action_required` mapped to a status the client treats as active, and `neutral` and `stale` read as "Passed".                | **Accepted.** Rows and jobs carry a server `terminal` flag that the poller and the timers stop on. `neutral` and `stale` draw the skipped icon, and labels come from `reason`. `action_required` was checked and is a conclusion, not a run status.                                                                                                                                          | Status mapping; Contracts; Test plan slices 3 and 5                                             |
| 11  | P2. GitHub repository write permission does not prove Actions write permission.                                                                | **Accepted.** Permissions are tri-state (`granted`, `denied`, `unknown`). GitHub write or higher is `unknown`: the button is enabled, and a 403 is shown at the button and remembered until rescan. A 403 never shows the sign-in state.                                                                                                                                                     | Contracts; Backoff, auth and permission failures; UI review                                     |
| 12  | P2. A GitHub 404 was presented as "Actions is turned off".                                                                                     | **Accepted.** GitHub returns 404 both when Actions is off and when the token lacks access, and no non-admin read tells them apart. The copy now names both causes, and an empty workflow list is its own empty state.                                                                                                                                                                        | Backoff, auth and permission failures                                                           |
| 13  | P2. `pipelinesReads` was advertised in slice 1, before `getJob` and `getJobLog` existed.                                                       | **Accepted, narrower fix.** No new flag is added. The server side of every read now ships in slice 1 (six since the performance revision added `readSnapshot` and `subscribe`), and a test ties each advertised flag to its registered unary and stream methods.                                                                                                                             | Decision; Contracts; Rollout                                                                    |
| 14  | P2. A GitLab trace 404 for a job with no output yet was reported as a stale link.                                                              | **Accepted.** On a trace 404 the server reads the job: an active job is `not_started` and re-read on a timer, and an erased job is `erased`. A terminal job with no log gets the new `no_output`. Only a 404 on the job itself is `not_found`.                                                                                                                                               | Reads per provider (GitLab trace 404); Job view; Test plan slice 1                              |
| 15  | P3. `gitlab/pipelines.rs` cannot call the private `host_link`.                                                                                 | **Accepted.** Confirmed at `parse.rs:107`. `host_link` becomes `pub(super)`, the only visibility change, and the claim of no visibility change is corrected.                                                                                                                                                                                                                                 | Current behavior; Alternatives (A2)                                                             |
