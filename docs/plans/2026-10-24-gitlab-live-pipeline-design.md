# GitLab Live Pipeline

Status: Approved 2026-10-24 with every recommended answer.

Scope: the live-pipeline part of issue #156 ("Proposed design: live pipeline
without new transport", GitLab version handling, edge cases). The readiness
copy, auto-merge, cancel, job-state and `head_pipeline` selection defects
(#156 defects 1 to 6) are being fixed in parallel. This design depends on them
where noted. It amends
[the background sync design](../superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md)
(see Amendments). Revised after a Codex review; see Review at the end.

## Problem

When a GitLab project has **Pipelines must succeed** on, GitLab's merge request
page shows the gating pipeline live: its kind, number, status, commit, and a
stage strip. BiBCode's merge box shows none of it. The Pipelines tab shows one
pipeline's jobs, with no header. Both update only when the pipeline's overall
status changes. A user waiting to merge cannot see progress, and must open
GitLab to find out which stage is running.

The issue's acceptance criteria that this design owns:

- The merge box shows "Merge request pipeline #N running for `<sha>` on
  `<branch>`", and its stages advance within about 10 s of GitLab, with no
  manual refresh and no new transport.
- The load harness shows about 900 host requests an hour per actively watched
  merge request, and no detail `get` per pipeline tick.

## Current behavior (verified at 4e023ac5ff)

- **Poller cadence.** One poller per (host, project, list key) runs inside the
  `pullRequests.subscribe` call. It sleeps 20 s (`gitlab/poll.rs:37`), backs off
  60, 120, then 300 s on HTTP 429 (`poll.rs:41-45`), and each tick reads the
  list page, then one `GET merge_requests/:iid` probe (`poll.rs:254-352`). The
  module doc and the 2026-10-08 spec say it never runs the checks read
  (`poll.rs:7-10`). The first tick waits 20 s.
- **Backoff state is per driver.** `delay` and `backoff_index` are locals of
  the driving `run_subscriber` call (`poll.rs:418-419`), so a driver hand-off
  or a new poller starts the ladder again.
- **Only 429 is special.** `classify` turns every other failure, including
  `not_authenticated` and `forbidden`, into `Error`, and the loop retries in
  20 s (`poll.rs:164-170`, `:459-461`). `subscribe` returns `Ok(())` when the
  loop ends (`pull_requests/mod.rs:513-526`). The service's auth invalidation,
  `invalidate_failed_context` (`mod.rs:975-991`), runs only after unary reads.
- **Probe fingerprint.** It holds `updated_at`, `user_notes_count`,
  `head_pipeline.id` and `head_pipeline.status` (`gitlab/refresh.rs:17-22`). A
  pipeline id or status change raises `detail` and `checks`
  (`refresh.rs:58-80`). Job and stage progress inside a running pipeline is
  invisible to it.
- **Change detection is shared, delivery is not.** The probe row is keyed
  `(host, project, "probe", number)`, shared by every list key, while ticks
  are broadcast only to one list key's subscribers (`poll.rs:397-406`). When
  two pollers with different list keys watch one number, the first to probe
  stores the new fingerprint, and the second then sees no change, so its
  subscribers get no names.
- **Writes are silent.** `SnapshotStore::put` returns `Ok(())` both when it
  writes and when it rejects an older generation (`snapshot_store.rs:87-104`),
  and `poll::store` discards database errors (`poll.rs:203-231`).
- **The logout fence covers only contexts.** `delete_host_snapshots` raises a
  per-host fence (`mod.rs:994-1009`), and only `remember_context` checks it
  (`mod.rs:292-305`). Display writes from unary reads (`store_read`,
  `mod.rs:539-570`) and from the poller can land after a logout.
- **`head_pipeline` parsing.** `probe_fingerprint` indexes
  `value["head_pipeline"]["id"]` (`gitlab/parse.rs:16-26`), so an absent key and
  `null` look the same. The detail parse uses the pipeline only as the
  `pipeline_status` readiness input (`parse.rs:573`); no pipeline header
  reaches the client.
- **Only the driver's number is probed.** `Tick::for_subscriber` gives detail
  names only to subscribers of the driver's number (`poll.rs:145-158`). Every
  subscriber gets an all-false event on joining (`poll.rs:405`), and the detail
  view pauses its own 20 s refresh timer on that event
  (`apps/web/src/components/pullRequests/detail/PullRequestsDetailView.tsx:174`).
  So a detail subscriber that is not the driver gets no refresh at all: for
  example, a merge request in a right-panel tab while the module's list (number
  `null`) of the same list key is open and driving. That is a current defect,
  and live mode depends on fixing it.
- **A probe failure loses a list change.** The tick stores the changed list
  page, then returns early on a probe error without emitting `list`
  (`poll.rs:300-309`). The next tick sees an unchanged fingerprint.
- **Checks read.** `checks()` reads `merge_requests/:iid/pipelines?per_page=1`,
  then one page of 100 jobs (`gitlab/mod.rs:633-673`). The Jobs API returns jobs
  newest first, with a stage _name_ and no position. `grouped_checks` orders
  groups by first appearance (`pull_requests/read.rs:111-131`), so the
  Pipelines tab lists the last stage first. Trigger jobs are on a separate
  endpoint and are not shown. The `head_pipeline` selection is defect 5
  (parallel).
- **Snapshots.** `readSnapshot` returns the list row, the detail row, and one
  tab row (`pull_requests/mod.rs:433-484`). Conversation maps to the `timeline`
  kind (`mod.rs:1095-1103`), so there is no row a Conversation-tab stage
  summary could ride on. Rows are keyed `(host, project, kind, key)`, with a
  free-text `kind`, a per-write generation fence (`snapshot_store.rs:87-104`),
  and `delete_number` removing every kind for a number (`snapshot_store.rs:177`).
  `readSnapshot` is not database-only: it resolves the scope through
  `resolve_pending_scope`, which spawns `git remote get-url origin`
  (`context.rs:360-370`) and, for a host that is neither named nor recorded,
  runs provider discovery.
- **Client answers.** `changed.checks` re-reads `getChecks` on the Checks tab,
  or refreshes the inactive atom elsewhere (`PullRequestsDetailView.tsx:208-219`).
  The displayed checks prefer the live value over any snapshot
  (`PullRequestsDetailView.tsx:247`), so a newer stored row never shows while a
  live value exists. The list view uses `shownCopy`
  (`detail/snapshotDisplay.logic.ts:32`), which accepts every new live object
  and stamps it with the newest snapshot `observedAt` seen so far (`:41-49`).
  A live response from a read that started before a newer stored row therefore
  replaces that row on screen, and re-reading the unchanged row does not
  repair it. `shownCopy` is not safe for pipeline state.
- **Client fallback timer.** When the stream is not pushing, the detail view
  re-reads `get` and its active tab every 20 s (`useVisiblePullRequestRefresh`,
  `PullRequestsDetailView.tsx:266-278`): one eight-read detail join plus at
  least one tab read, about 1,600 requests an hour per merge request.
- **Stream.** Events go through `try_send` on a channel of 8, and
  `forward_changed_to_stream` discards the result
  (`apps/server/src/production/pull_requests_rpc.rs:23`, `:365-371`); a full
  channel drops an event.
- **Real cost today.** The poller's list read joins the repository tab totals
  (`gitlab/mod.rs:444-458`), cached for 30 s (`pull_requests/cache.rs:12`). With
  20 s ticks the three `api -i` count reads run every other tick. One driven
  open merge request therefore costs about 630 requests an hour (180 list, 270
  totals, 180 probe), not the 360 the issue counts. `counts()` drops each
  count's error with `.ok()?` (`gitlab/mod.rs:208-225`), so a 429 on a totals
  read never reaches the ladder. The load harness counts `mr list` and probe
  hits per tick, not totals, and records events without answering them
  (`apps/server/tests/pull_requests_gitlab_load_harness.rs:225-436`).
- **Detail join.** One `get` is seven reads in one wave (MR, approvals,
  reviewers, approval state, award emoji, closing issues, GraphQL metadata),
  plus `versions` when diff refs are missing (`gitlab/mod.rs:512-520`).
- **Budgets.** `api` gives `Budget::Read` (30 s) only to the `getContext`,
  `getVocabulary`, `getCreateDefaults` and `subscribe` operation labels and
  `Budget::Mutation` (60 s) to everything else (`gitlab/mod.rs:86-119`).
  Every GraphQL read goes through `glab_api_with_body`, which hardcodes
  `Budget::Mutation` (`host.rs:260-286`); its operation is only a label.
- **Tripwires.** `pull_requests` forbids `tokio::time::interval`, `tokio::spawn`,
  `reqwest` and host content in `tracing` (`mod.rs:2593-2645`), and every module
  file must join the `SOURCES` inventory (`mod.rs:2645`, `:2690`).
- **UI.** The merge box is the Conversation list footer
  (`detail/PullRequestsConversation.tsx:120-151`) and has no pipeline
  information. The Pipelines tab has an "Open pipeline" link and job groups
  (`detail/PullRequestsChecks.tsx:59-88`).
- **Living docs** say the poller never runs checks reads
  (`docs/architecture/rpc-and-orchestration.md:757-779`), and that nothing in
  the module polls (`docs/integrations/source-control-providers.md:252`, `:271`;
  `docs/architecture/overview.md:2589-2598`).

## Goals

1. The merge box and the Pipelines tab show the gating pipeline's kind, id,
   status, commit and branch, from data the server already reads.
2. While that pipeline runs and someone is looking at it, stages and jobs
   update within about 10 s, a newly created pipeline appears within about
   10 s of a push, and no pipeline change runs the detail join on its own.
3. About 900 host requests an hour per actively watched merge request, stated,
   bounded, and governed by the 429 ladder.
4. Every subscriber that has a merge request open gets every change, whichever
   poller saw it first, and recovers after a dropped event.
5. A pipeline copy on screen never moves backwards, whichever read answers
   last.
6. Older clients and older servers keep today's behavior.

## Non-goals

Readiness copy, the merge-checks list, auto-merge labels and endpoints, and
cancel handling (parallel defects). A header status chip. GraphQL
`mergeabilityChecks`. Honoring `Retry-After`. ETags. GitHub polling.
De-duplicating the probe of a number that two list keys both watch (each
poller probes it, as today).

## Alternatives

**A. Webhooks.** GitLab must reach a URL, which a desktop app behind a VPN
does not have. Creating one needs Maintainer, and GitLab auto-disables a hook
after repeated failures. Rejected, as in the 2026-10-08 spec.

**B. GraphQL subscriptions over Action Cable** (`ciPipelineStatusUpdated`,
`mergeRequestMergeStatusUpdated`). External use is undocumented, the pipeline
subscription is an Experiment, and it needs a WebSocket client in a module
whose tripwires forbid direct HTTP. Rejected.

**C. A GraphQL-only probe.** It would replace the REST `GET` that, per the API
docs, also triggers GitLab's asynchronous mergeability check, and it would put
version and complexity risk on every tick. Rejected; the REST probe stays.

**D. REST jobs plus a local stage fold** (the issue's proposal). One
`pipelines/:id/jobs` read per tick, with stage status folded from job states
the way `composite.rb` does. Three defects: the list is newest first with no
stage position, so a stage whose only job was retried moves last; trigger jobs
are on another endpoint (`bridges`, or `trigger_jobs` since 19.2), so a stage
made only of trigger jobs disappears from the strip; and a fold over the first
100 jobs cannot tell whether an allowed failure beyond them gives the stage
warnings. Rejected.

**E. One GraphQL pipeline read per active tick** (recommended).
`mergeRequest(iid) { headPipeline { id … stages { nodes { name status detailedStatus { name } jobs { … } } } } }`.
Stages come in GitLab's order with GitLab's stage status and detailed status,
which GitLab computes over every job (`stage_type.rb`, `detailed_status`;
`success_warning.rb`, `SUCCESS_WITH_WARNINGS`). Jobs come from
`ordered_latest_statuses`, which includes trigger jobs. Per-stage
`pageInfo.hasNextPage` gives truncation. `MergeRequest.headPipeline` resolves
to `diff_head_pipeline` (`merge_request_type.rb`), which is `null` when
`head_pipeline` does not match the merge request's diff head sha
(`merge_request.rb`, `matches_sha_or_source_sha?`): a staleness signal for
every pipeline kind. One read fills both the stage strip and the Pipelines
tab. It is a separate document, never merged into `DETAIL_METADATA_QUERY`,
and a failure degrades instead of failing the read.

**F. Stream payloads instead of snapshot read-through.** Put the pipeline in
the `subscribe` event. The poller broadcasts one `Tick` to every subscriber of
a list key, so up to 100 jobs would be cloned to subscribers that do not want
them. The event and the stored row would be two sources of truth. Rejected:
events stay name-only, and `readSnapshot` is a host-free local read.

**G. A separate per-merge-request watcher.** A second loop beside the list
poller. It would need its own lease and cancellation lifecycle, and the
module's tripwires forbid a spawned task. Rejected: active mode is a cadence
inside the existing `run_subscriber` loop.

**H. A registry-wide broadcast per number.** Publish per-number names to
every list key of a repository, so that the first poller to see a change
tells everyone. It fixes the shared-row defect, but a dropped or lagged event
is still lost. Rejected in favor of per-subscriber delivered revisions
(Server poller, Delivery), which fix both.

## Decision

E inside the existing poller, with these rules. Points 2, 3, 6 and 7 differ
from the issue.

1. **The pipeline header costs nothing extra.** The REST `head_pipeline` that
   the detail `get` and the probe already read carries id, status, ref, sha,
   timing, URL and `detailed_status`.
2. **The stage strip comes from GraphQL** (E). The detail join adds a
   stages-only version of the query (eight reads instead of seven), so the
   strip is on screen at first paint and for finished pipelines, not only
   while polling.
3. **One revisioned pipeline copy.** Every read that observes the pipeline
   (the poller tick, the detail `get`, `getChecks`) returns or stores one
   self-consistent copy stamped with a `revision`: the `next_generation()` the
   read took before its first host call, the same number the store's fence
   compares. The poller writes only the `pipeline` row, holding the header,
   the stages and, when it read them, the job groups. The client shows the
   copy with the highest revision across every source.
4. **Pipeline changes never run the detail join by themselves.** Probe fields
   (`updated_at`, notes, `sha`, `state`, `detailed_merge_status`,
   `merge_when_pipeline_succeeds`) raise `detail`. A `head_pipeline` id or
   status change raises `pipeline` and `checks`, and raises `detail` only when
   it moves the pipeline between the `ci_must_pass` reason buckets that defect
   2 defines (none, failed or canceled, manual, skipped, running) while
   `detailed_merge_status` is unchanged. In practice a bucket change comes with
   a `detailed_merge_status` change (for example `ci_still_running` to
   `ci_must_pass`), so this exception is rare. It keeps the readiness copy
   right in cases such as failed to canceled under `ci_must_pass`. The bucket
   function is defect 2's, reused, not copied.
5. **Three cadences per probed number.**
   - **Active** (probe and pipeline read every 10 s): the merge request is
     open; `head_pipeline.status` is `created`, `waiting_for_resource`,
     `preparing`, `waiting_for_callback`, `pending`, `running` or `canceling`;
     the pipeline is not known to be for an older commit; and a subscriber of
     the number is on the Conversation or Pipelines tab. `manual` and
     `scheduled` are excluded: nothing changes until a person or a timer acts.
     After 30 min with no stage-tier change, both reads drop to every 20 s
     until the next change.
   - **Fast** (probe only, every 10 s, at most 6 ticks per episode): a
     subscriber is on Conversation or Pipelines, the number is not active, and
     one of these holds: `detailed_merge_status` is `unchecked`, `checking`,
     `preparing`, `approvals_syncing` or `ci_still_running`; the `sha`
     changed and `head_pipeline` is `null` or for an older commit (a pipeline
     may be about to appear); the pipeline just turned terminal or `manual`;
     or the REST and GraphQL pipelines disagreed on the last tick. An episode
     starts at a probe fingerprint change.
   - **Idle** (probe every 20 s): everything else.

   The tick that first sees a pipeline leave the active set still runs the
   pipeline read once, so the strip shows the final stages.

6. **Probe every subscribed number; activate at most 3.** The poller probes
   each distinct subscribed number. The first 3 in join order may be active
   or fast; the rest stay idle. No subscribe is refused: a refused subscriber
   falls back to its client timer, which costs about 1,600 requests an hour,
   against 180 for an idle probe.
7. **Reuse the tab totals while polling.** The poller's list read reuses the
   last good totals for the repository even past the 30 s cache TTL, and
   re-reads them only when the list page's fingerprint changed or the copy is
   older than 5 min. This replaces about 270 requests an hour with at most
   about 40, which is what makes the issue's budget reachable.

### Decisions for approval

1. A 10 s active cadence (excluding `manual` and `scheduled`, halved after 30
   quiet minutes), a fast probe-only state bounded at 6 ticks per episode,
   and tab totals reused while polling: about 940 requests an hour per active
   merge request.
2. A pipeline id or status change raises `detail` only when it changes the
   `ci_must_pass` reason bucket without a `detailed_merge_status` change.
3. Probe every subscribed number, at most 3 of them active or fast per list
   key, and never refuse a subscribe.
4. One GraphQL pipeline query, with `detailedStatus`, serves the stage strip,
   active ticks and the unary `getChecks`. It is combined with REST
   `head_pipeline` only when both name the same pipeline id. The REST path is
   the fallback.
5. Defer the header status chip, `Retry-After` and ETags.

## Design

### Contracts (`packages/contracts/src/pullRequests.ts`)

All additions are optional, so an older peer on either side still decodes
(additive compatibility, `docs/architecture/connection-runtime.md:236`; Effect
`Schema.Struct` ignores excess keys by default; Rust fields take
`#[serde(default)]`).

```ts
const PullRequestsPipelineStatus = Schema.Literals([
  "created",
  "queued",
  "running",
  "waiting",
  "manual",
  "scheduled",
  "canceling",
  "success",
  "failed",
  "canceled",
  "skipped",
  "unknown",
]);
export const PullRequestsPipelineStage = Schema.Struct({
  name: Schema.String,
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean, // GitLab's detailed status is SUCCESS_WITH_WARNINGS
});
export const PullRequestsPipeline = Schema.Union([
  Schema.TaggedStruct("none", {}), // head_pipeline is null
  Schema.TaggedStruct("hidden", {}), // head_pipeline key absent: no pipeline access
  Schema.TaggedStruct("present", {
    id: Schema.Number,
    status: PullRequestsPipelineStatus,
    warnings: Schema.Boolean,
    kind: Schema.Literals(["merge_request", "merged_results", "merge_train", "branch", "other"]),
    ref: Schema.String,
    sha: Schema.String,
    isForHead: Schema.NullOr(Schema.Boolean), // null: unknown
    url: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
    startedAt: Schema.NullOr(Schema.String),
    finishedAt: Schema.NullOr(Schema.String),
    durationSeconds: Schema.NullOr(Schema.Number),
    stages: Schema.NullOr(Schema.Array(PullRequestsPipelineStage)), // null: unavailable
  }),
]);
export const PullRequestsPipelineCopy = Schema.Struct({
  revision: Schema.Number, // generation taken before the read
  pipeline: PullRequestsPipeline,
  checks: Schema.NullOr(PullRequestsChecks), // job groups, when the read had them
});
// PullRequestsDetail:   pipeline: Schema.optional(PullRequestsPipelineCopy)  (checks: null)
// PullRequestsChecks:   revision: Schema.optional(Schema.Number)
//                       truncated: Schema.optional(Schema.Boolean)  (unless defect 5 adds it first)
// PullRequestsSnapshot: pipeline: Schema.optional(Schema.NullOr(
//                         Schema.Struct({ payload: PullRequestsPipelineCopy, observedAt: Schema.Number })))
// PullRequestsChanged:  pipeline: Schema.optional(Schema.Boolean)
```

`revision` is the store's generation: wall-clock milliseconds bumped past the
previous stamp in the process (`snapshot_store.rs:21-34`). It is comparable
across the poller, `get` and `getChecks`, and across a server restart unless
the clock moves backwards. It stays below 2^53, so a JavaScript `Number` holds
it exactly.

Status mapping from GitLab's 13 statuses: `waiting_for_resource`, `preparing`
and `pending` map to `queued`; `waiting_for_callback` maps to `waiting`; any
unrecognized string maps to `unknown`. `warnings` is true when the detailed
status is `SUCCESS_WITH_WARNINGS` (GraphQL `detailedStatus.name`) or
`success-with-warnings` (REST `detailed_status.group`). Kind comes from the
REST `ref`: `refs/merge-requests/<iid>/head` is `merge_request`, `/merge` is
`merged_results`, `/train` is `merge_train` (`merge_request.rb` `ref_path`,
`merge_ref_path`, `train_ref_path`); the source branch name is `branch`;
anything else is `other`.

No new RPC method. No migration: `pipeline` is a new free-text snapshot kind.
`check:contracts` regenerates the fixtures.

### Server reads

- `parse.rs`: one `pipeline_header(&Value)` used by `detail` and the probe.
  It uses `value.get("head_pipeline")` to tell absent from `null`. One
  `pipeline_graph(&Value)` parses the GraphQL response into the pipeline id,
  stages and `Checks` groups. The id is the number at the end of the
  `gid://gitlab/Ci::Pipeline/<id>` global ID. Jobs keep stage order; job URLs
  are built server-side from `webPath` and the host's project `web_url`
  origin (`HostContext.web_url`), never from response text. Per-stage
  `hasNextPage` sets `truncated`.
- `graphql.rs`: `PIPELINE_STAGES_QUERY` (headPipeline id, and per stage its
  name, status and `detailedStatus { name }`) for the detail join, and
  `PIPELINE_QUERY` (the same, plus up to 100 jobs per stage: name, status,
  allowFailure, webPath, startedAt, finishedAt, duration, downstreamPipeline)
  for active ticks and `getChecks`. The nesting depth matches the shipped
  `TIMELINE_QUERY`.
- **Combining REST and GraphQL** (`pipeline_copy(rest, graph, stored)`). Both
  reads see the merge request at slightly different moments, so the copy is
  combined only when they agree:

  | REST `head_pipeline` | GraphQL `headPipeline` | Copy                                                                                                                           |
  | -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | id N                 | id N                   | Header from REST, stages and jobs from GraphQL, `isForHead: true`                                                              |
  | id N                 | `null`                 | `isForHead: false`; stages from the stored copy if it is for N, otherwise `null`; the number leaves active mode and turns fast |
  | id N                 | id M                   | A race (a push or a same-commit rerun between the reads): no copy is written this tick, and the number stays fast              |
  | `null`               | id M                   | The same race                                                                                                                  |
  | `null`               | `null`                 | `none`                                                                                                                         |
  | absent               | not read               | `hidden`                                                                                                                       |
  | id N                 | read failed            | Header from REST, stages from the stored copy if it is for N, otherwise `null`; `isForHead: null`                              |

  A same-commit rerun keeps `diff_head_pipeline` non-null, so it shows as a
  race for at most one tick and never as "Older commit". Only the poller can
  defer a write. The unary `get` and `getChecks` must answer, so for them a
  race row behaves like the "read failed" row: the REST header,
  `stages: null` and `isForHead: null`.

- `gitlab/mod.rs`: `detail` joins `PIPELINE_STAGES_QUERY` into its first wave
  and combines it by the same table, with no stored copy; any failure except
  cancellation gives `stages: null`. `probe` returns
  `Probe { fingerprint, header, state }`. The unary `getChecks` uses
  `PIPELINE_QUERY`, returns `revision`, and falls back to the REST path from
  defect 5 on GraphQL failure (decision 4).
- **Budgets.** One `budget_for(operation)` replaces the inline match in `api`
  (`gitlab/mod.rs:86-119`), and `glab_api_with_body` takes a `Budget`
  argument instead of hardcoding `Budget::Mutation`. GraphQL reads labelled
  `pullRequests.subscribe` then take the 30 s `Budget::Read`, and mutations
  keep 60 s. `call_label` gains `pipeline`.
- **Totals.** `counts()` returns `Result`, so a 429 on any count read reaches
  the caller as `rate_limited`. `ContextCache` gains a `get_any_age` read; the
  poller's list read uses it and reloads the totals only when its list
  fingerprint changed or the copy is older than 5 min (decision 7). Unary
  `list` reads keep the 30 s TTL.

### Server poller (`gitlab/poll.rs`, `refresh.rs`)

- **Watchers.** `Shared` gains a map from number to (subscribers, subscribers
  on Conversation or Pipelines), kept in join order and updated under the
  registry lock in `join` and `Lease::drop`. `ActiveTab` is replaced by the
  subscriber's `Option<SubscribeTab>`.
- **Tick.** One loop, one computed one-shot `sleep`, as today. The delay is
  10 s when any number is active or fast, otherwise 20 s. The list reads every
  20 s. Each number's probe runs every tick while it is active or fast,
  otherwise every 20 s; the pipeline read runs on its active ticks. Probes run
  in-task, at most 3 at a time (no spawn). The first tick waits 10 s when a
  subscriber is on Conversation or Pipelines, otherwise 20 s; the mount's own
  live reads cover the start.
- **Fingerprints.** `ProbeFingerprint` gains `sha`, `detailed_merge_status`,
  `merge_when_pipeline_succeeds`, `state` and pipeline `warnings`, all
  `#[serde(default)]`. A row stored by an older build decodes with defaults
  and raises `detail` once. The pipeline row's fingerprint is (pipeline id,
  status, warnings, `updated_at`, and per stage, its name, status and
  warnings, plus per job, its name and status).
- **Revisions per name.** The probe row's payload, empty today, holds
  `Raised { detail, timeline, commits, checks, files, pipeline }`: for each
  name, the generation of the tick that last raised it. An empty or older
  payload decodes as zeros. Each tick compares and writes in one
  `database.call` closure, so the comparison runs against the latest row: it
  loads the stored probe and pipeline fingerprints, computes names, writes the
  `pipeline` row when its fingerprint changed, sets `Raised.pipeline` only if
  that write was accepted, writes the probe row, and returns the current
  `Raised`. When another poller already stored the same fingerprint, nothing
  is written, and the call still returns that poller's `Raised`.
- **Delivery.** `Tick` becomes `{ list, numbers: [(number, Raised)] }`. Each
  `run_subscriber` keeps `delivered: Raised` for its number, read from the
  stored probe row when it joins. For each tick it emits the names whose
  revision is newer than `delivered`, masked by its tab for `commits` and
  `files` as today, and advances `delivered` only when the emit succeeded.
  `emit` returns whether `try_send` accepted the event
  (`forward_changed_to_stream`), and an undelivered `list` name is held and
  sent with the next event. A subscriber that misses ticks (a full stream, a
  lagged broadcast receiver, or a change first seen by a poller of another
  list key) catches up from the next tick it receives, because revisions are
  cumulative.
- **Write outcomes.** `SnapshotStore::put` returns `Result<bool>`, true when
  it wrote. `poll::store` and `store_read` return `Written`, `Older`,
  `Fenced` or `Failed`. A `Failed` write raises no name and logs one
  `tracing::warn!` with the kind and the error code only.

| Observed this tick                                                      | `detail`                                            | `timeline` | `checks` | `pipeline`              |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ---------- | -------- | ----------------------- |
| `updated_at` or notes change                                            | yes                                                 | yes        | —        | —                       |
| `sha`, `state`, `detailed_merge_status`, `merge_when_pipeline_succeeds` | yes                                                 | —          | —        | —                       |
| `head_pipeline` id or status change                                     | only on a `ci_must_pass` bucket change (decision 2) | —          | yes      | when the row is written |
| Stage, job or warnings change only                                      | —                                                   | —          | —        | yes                     |

`commits` and `files` follow `updated_at` and the subscriber's tab, as today.
`checks` on a status change stays so that an older client still re-reads its
tab.

- **Rate limits.** A 429 from any read, totals included, ends the tick. The
  backoff deadline and ladder step move from the driver's locals to the
  `Registry`, keyed by lowercased host, because GitLab limits are per user:
  every poller for that host waits, a driver hand-off or a re-keyed
  subscription inherits the deadline, and a success clears it. Unary reads
  are not held back. Names whose rows were already written in the tick are
  still delivered.
- **Authentication.** `not_authenticated` and `forbidden` from any poller read
  end the poller: the driver stores the error in `Shared` and cancels it,
  every `run_subscriber` returns it, and `subscribe` calls
  `invalidate_failed_context(error, Some(host))`, which deletes the host's
  rows, then ends the stream with the error. The client's timer resumes, and
  its live reads show the sign-in error.
- **Logout fence.** The per-host fence check moves from `remember_context`
  into the shared write path, on the database worker. Every display write
  (poller and `store_read`) whose generation is at or below the host's fence
  is skipped as `Fenced`. A read that started before a logout cannot bring
  its rows back.
- **Other failures.** Any other error from the pipeline read keeps the probe's
  names, writes no row, and retries next tick. A probe error on one number
  neither drops a stored list change nor another number's names (fixes
  `poll.rs:300-309`).
- **No jobs access.** When the pipeline read returns the current pipeline
  with `stages: null` (no `read_build`), the poller stops reading it for that
  pipeline id. The header keeps updating through the probe, and a new id
  tries again.

### Client (`apps/web`)

- `snapshotDisplay.logic.ts`: a pure `newestCopy(candidates)` returns the
  candidate with the highest `revision`, ignoring `null`. A candidate without
  a `revision`, such as a `checks` row stored by the previous build, ranks as
  revision 0, so it never beats a stamped copy. When no candidate has a
  revision (an older server), callers keep today's behavior. `shownCopy`
  stays for the list view.
- `PullRequestsDetailView.tsx`: on `changed.pipeline`, call
  `snapshotQuery.revalidate()` and ignore `changed.checks` in the same event.
  `checks` alone keeps today's answer. A number past the 3-number cap gets
  header-only `pipeline` rows (`checks: null`): on the Pipelines tab, such a
  row arriving after `changed.pipeline` is answered with one `getChecks` per
  row revision, so the job list follows the header (Review, decision A). A
  row that carries jobs never re-reads them. The merge box pipeline is
  `newestCopy([liveDetail?.pipeline, snapshot.detail?.payload.pipeline, snapshot.pipeline?.payload])`.
  The Pipelines tab uses `newestCopy` over the live `getChecks` value, the
  `checks` tab row and the `pipeline` row's `checks`, replacing "live always
  wins" (`:247`). Both are derived during render.
- New `detail/PullRequestsPipelineSummary.tsx` (memoized) renders the header,
  stage strip and live region. The merge box and the Pipelines tab both use
  it. `pullRequestsDetail.logic.ts` holds the kind and status copy.

### UI behavior (UI.md)

- **Merge box.** Between the readiness title and its reasons:
  "Merge request pipeline **#4821** running · abc1234 on feature/login". The
  id is an external link to the pipeline. The kind label is "Merge request",
  "Merged results", "Merge train", "Branch" or plain "Pipeline". The sha shows
  only for `merge_request` and `branch` kinds, where it is a commit the user
  pushed.
- **Stage strip.** One `text-xs` item per stage: an icon and the stage name,
  wrapping, with an accessible name such as "test: running". Status is
  carried by icon shape as well as color (UI.md, Colors): passed, passed with
  warnings, failed, running (spins only under `motion-safe`), queued, manual,
  scheduled, canceled, skipped. The icons are shared with the Pipelines tab
  (UI.md, Be consistent).
- **Older commit.** When `isForHead` is `false`, a text badge "Older commit",
  with the title "This pipeline ran before the latest push." The issue's
  "Creating pipeline…" is not shown: REST cannot tell a pipeline about to be
  created from one that will never run, so the copy would guess. The fast
  state shows the new pipeline within about 10 s of its creation instead.
- **No access.** `hidden` shows one muted line: "You can't view pipelines in
  this project." It never reads as "no pipeline". `none` shows no row; the
  readiness reasons (parallel defect 2) say what "Pipelines must succeed"
  needs.
- **Announcements.** One persistent polite `aria-live` region announces only a
  transition to a terminal status seen while the box is mounted ("Pipeline
  #4821 passed."). First paint and snapshot paints never announce.
- **Pipelines tab.** The same summary replaces the bare "Open pipeline" link.
  `truncated` adds "Showing the first 100 jobs of a stage. Open the pipeline
  for the rest."
- No new controls or disabled states. Merge stays governed by readiness.

## GitLab version handling

| Host                 | Change                                                                   | Live-pipeline behavior                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All                  | `head_pipeline` is "exposed only if the current user can view pipelines" | Absent key is `hidden`; `null` is `none`                                                                                                                |
| All                  | GraphQL `headPipeline` is the diff-head pipeline                         | Source of `isForHead`, combined only on matching ids                                                                                                    |
| All                  | CE never creates `/train` refs; merged results and trains are paid tiers | Kind from `ref`; no version gate                                                                                                                        |
| Newer hosts          | `canceling` and `waiting_for_callback` statuses (13 in the current API)  | Mapped; unknown strings become `unknown`                                                                                                                |
| 16.4                 | `DetailedStatus.group` deprecated in favor of `name`                     | The queries select `name`; a host without it fails the read, which degrades to no strip; REST `detailed_status.group` still gives the header's warnings |
| 17.7                 | Auto-merge for merge trains generally available                          | "Merge train pipeline" comes from the ref alone                                                                                                         |
| 19.2                 | `trigger_jobs` replaces deprecated `bridges`                             | Not needed: GraphQL stage jobs include trigger jobs; the REST fallback uses defect 5's choice                                                           |
| `read_build` missing | GraphQL `stages` is authorized on `read_build`                           | `stages: null`; no strip, header still shown                                                                                                            |

The other GraphQL fields used carry no Experiment or "Introduced in" notes in
the current reference. An unknown version attempts the read, and a failure
degrades as above. Corrections to the issue's table: merge-train auto-merge
became generally available in 17.7, not 19.1 (19.1 changed `auto_merge`
routing for trains); `merge_when_pipeline_succeeds` was deprecated in 17.11;
`cancel_auto_merge` arrived in 19.5. Auto-merge labels belong to the parallel
fix.

## Edge cases

| Case                                    | Handling                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No pipeline                             | `none`; readiness copy (defect 2) explains the block                                                                                                                                                                              |
| Pipeline being created after a push     | `sha` raises `detail`; REST `head_pipeline` keeps the old one until GitLab creates one (`update_head_pipeline`), GraphQL returns `null`, so "Older commit" shows and the number is fast; the new id appears on the next fast tick |
| Same-commit rerun                       | The two reads can name different ids for one tick; nothing is written, the number stays fast, and the next tick agrees; never "Older commit"                                                                                      |
| Push between the REST and GraphQL reads | GraphQL `null` for the REST id: "Older commit", which is now true                                                                                                                                                                 |
| Merged-results pipeline                 | Its `sha` is a merge commit and is not shown; staleness comes from GraphQL, never from `sha`                                                                                                                                      |
| Branch and MR pipelines coexist         | Header and stages follow `head_pipeline` / `headPipeline`, so the tab and the gate agree                                                                                                                                          |
| No pipeline access                      | `hidden`; no pipeline read is attempted                                                                                                                                                                                           |
| Can see pipelines, not jobs             | Header only; the pipeline read stops for that id                                                                                                                                                                                  |
| Blocking manual job                     | Status `manual`; one final pipeline read, then fast, then idle; a stage shows the manual icon                                                                                                                                     |
| Trigger and downstream jobs             | Listed in their stage; the downstream pipeline is linked                                                                                                                                                                          |
| More than 100 jobs in a stage           | `truncated` copy in the tab; the stage's warnings still come from GitLab's detailed status                                                                                                                                        |
| Failed `allow_failure` job              | Stage and pipeline `warnings`: "passed with warnings", not red                                                                                                                                                                    |
| Transient mergeability                  | Fast for at most 6 ticks; never rendered as a failure                                                                                                                                                                             |
| Pipeline runs for hours                 | 30 min quiet cap halves the rate                                                                                                                                                                                                  |
| Tab switch                              | The subscription is re-keyed; the new lease updates the watcher map and inherits the host's backoff; a restarted poller's first tick waits 10 s on Conversation or Pipelines                                                      |
| Hidden document                         | The stream drops (existing); on return, `readSnapshot` paints the last rows                                                                                                                                                       |
| Two windows, two numbers                | Both probed; up to 3 numbers active or fast; the rest idle-probed                                                                                                                                                                 |
| Two filters, one number                 | Each list key's poller probes it; both sets of subscribers get every name through revisions                                                                                                                                       |
| Logout or sign-in failure during a read | Its writes are fenced; a poller auth failure ends the stream and deletes the host's rows                                                                                                                                          |
| 429, including a totals read            | Host-wide ladder, kept across hand-offs and re-keys                                                                                                                                                                               |

## Request budget and rate limits

Per hour, for one open merge request in one list key (derived from source;
the harness phase below confirms it):

| Mode                               | List | Totals | Probe | Pipeline read |     Total |
| ---------------------------------- | ---: | -----: | ----: | ------------: | --------: |
| Today, any state                   |  180 |    270 |   180 |             — |       630 |
| Idle                               |  180 |   ≤ 40 |   180 |             — | about 400 |
| Active                             |  180 |   ≤ 40 |   360 |           360 | about 940 |
| Active, after the 30 min quiet cap |  180 |   ≤ 40 |   180 |           180 | about 580 |

Totals cost three reads per reload: 12 time-based reloads an hour (36) plus
one reload per list change. The fast state adds at most 3 probes per episode
over idle. Each extra active number adds 720 requests an hour; each extra idle
number adds 180. Detail joins come only from merge request metadata and
readiness changes: about two or three per pipeline lifetime from
`detailed_merge_status` moving, and none from stage, job or status ticks
except the rare bucket case (decision 2). The issue's "about 900" counted no
totals; 940 meets it.

| Environment                              | Limit                                                                 | One active | Three active numbers (2,380) |
| ---------------------------------------- | --------------------------------------------------------------------- | ---------: | ---------------------------: |
| Self-managed, default                    | Authenticated API limit disabled by default                           |          — |                            — |
| Self-managed, limit on                   | 7,200 per 3,600 s per user (default)                                  |        13% |                          33% |
| GitLab.com today                         | 2,000 per minute per user                                             |   under 1% |                     about 2% |
| GitLab.com proposed Free (not in effect) | 5,000 per hour per user and per top-level group; 100 per minute burst |        19% |                          48% |

Under the proposed Free limit, web and Git traffic count too, and the group
limit is shared by everyone in the group. The 3-number activation cap, the
visible-only subscription and the quiet cap bound this. A 429 carries
`Retry-After`, but `glab api` hides headers without `-i`; the fixed ladder
(60 s first step, at least GitLab.com's per-minute window) stays. ETags are
deferred: GitLab's REST ETag middleware hashes the generated body, so a 304
saves transfer, not server work.

**Local cost.** Active mode is about one `glab` spawn every 3.8 s (today every
5.7 s), each through `run_supervised`. Each GraphQL call writes one small
private body file (`host.rs:260-291`). Each client also calls `readSnapshot`
at most once per 10 s per watched merge request, and each call spawns
`git remote get-url origin`. The 2026-10-08 measurement put `glab`'s process
overhead at about 25 ms per call; that is historical, and `glab` is not
installed on the machine this design was written on. Measure both spawns
before approval (Verification).

## Failure, cancellation, reconnect, concurrency

- **Cancellation.** Every read takes the driver's token; the shared
  cancellation check before each write stays (`poll.rs:280`). The last
  lease leaving cancels the poller, as today. Leaving clears the poller's
  watcher entries but not the host's backoff deadline.
- **Ordering.** Every pipeline copy carries the `revision` of the read that
  produced it. The store rejects an older generation per row, and the client
  shows the highest revision across live and stored copies. Whichever of a
  live `getChecks` and a poller row answers last, the screen keeps the newer
  one.
- **Atomicity.** The poller writes one `pipeline` row, so the header, the
  stages and the jobs a client reads always come from one read. A unary
  `getChecks` stores only its own `checks` row; both are candidates, and the
  newer wins.
- **Duplicates.** Events are hints; a repeated `pipeline` re-reads the same
  rows and paints nothing new.
- **Dropped events.** A per-number name is re-sent until an emit succeeds,
  and a `list` name is held for the next event. Nothing is lost while the
  stream stays open.
- **Driver hand-off.** The driver reads the watcher map at each tick, so a
  hand-off keeps every number, and the backoff lives in the `Registry`. The
  broadcast capacity of 16 ticks is about 160 s at 10 s; a lagged receiver
  catches up from revisions. Update the comment at `poll.rs:46-48`.
- **Reconnect.** The subscription is re-created and the first tick waits
  10 s on Conversation or Pipelines. The snapshot paints the last rows at
  once, and the remount's live `get` carries fresh stages.
- **Latency.** Stages: at most about 10 s, plus one `readSnapshot`. A new
  pipeline after a push: within about 10 s of GitLab creating it, during the
  60 s fast window, and within 20 s after it. Merge enabling after a pass: the
  passing tick's `detailed_merge_status` may still be transient, so the fast
  state catches the change one or two ticks later, about 10 to 20 s.

## Performance on hot paths

- **Server.** A tick is sequential awaits, plus at most 3 concurrent probes.
  The pipeline read's payload is bounded at 100 jobs per stage; parsing is
  linear. SQLite writes happen only on change; change detection reads the
  fingerprint columns and the small `Raised` payload, not the pipeline
  payload, in the same `database.call` as the write. No allocation in steady
  state beyond the read bodies.
- **Client.** At most one `readSnapshot` per 10 s per watched merge request. It
  decodes the list, detail, tab and pipeline rows (tens of KB). Measure it, and
  add an optional row filter to `readSnapshot` only if decode time shows. The
  summary is memoized and re-renders only when the shown pipeline copy
  changes. Shown copies are derived during render with `newestCopy`. The live
  region is the one effect.

## Trust boundaries

- Stage names, job names, refs, branches and SHAs are host content. They are
  rendered as text only. Links are absolute URLs built server-side from the
  host's project origin, and open through the existing external-link path
  (DesktopBridge in desktop mode).
- Tokens stay inside `glab`; BiBCode adds no HTTP client.
- `pipeline` rows share the snapshot trust boundary. They are deleted with the
  host on logout or on an auth failure from any read, the poller's included,
  and by `delete_number` after a successful action. The host fence keeps a
  read that started earlier from writing them back.
- `tracing` never carries stage or job names, refs or SHAs. Add `sha`, `ref`
  and `stage` to the `log-content` tripwire fields.
- Remote servers poll from the machine whose `glab` holds the login, as today.

## Profiler, crash, and trace coverage

- **Child processes:** new `glab` calls go through `HostCommandRunner` to
  `ProcessRunner::run` to `run_supervised` (`git/process.rs:403`). No new
  process kind.
- **RPC methods:** none added. `pullRequests.subscribe` stays in
  `PULL_REQUESTS_STREAM_METHODS`; `get` and `getChecks` are already in
  `is_long_running` (`diagnostics/profiler/latency.rs:124-133`).
  `readSnapshot` is not database-only: each call spawns one local `git` and
  stays outside `is_long_running`. On the polled path the host is named or
  recorded, so discovery never runs there. Its spawn is counted in the
  local-cost measurement; listing it as long-running would hide a slow
  database read.
- **Tasks and shutdown:** no spawn (tripwire-checked); the loop stays inside
  the existing stream task and stops with it.
- **Logs:** one `tracing::warn!` on entering a run of failed ticks (operation,
  code, delay seconds), one on a failed snapshot write (kind, code), one
  `debug!` on recovery, one `warn!` when an auth failure ends a poller, and no
  host content.
- **Events and findings:** no new profiler event or finding, so nothing changes
  under `docs/skills/bibcode-profiler/references/`.
- Worktree removal and binaries do not apply.

## Open questions answered

1. **Absent `head_pipeline`:** yes. The MR API documents it as "exposed only if
   the current user can view pipelines". Verify with a Guest on a private
   project.
2. **`blocked_status`, `broken_status`, `external_status_checks`,
   `policies_denied`:** legacy REST values. The GitLab 16.0 MR API lists them.
   Keep them as aliases (defect 1).
3. **First `glab` with `--auto-merge`:** not researched. It does not matter
   once auto-merge goes through REST (defect 6).
4. **Local spawn cost:** derived above. It is not measurable here, because
   `glab` is absent and this task runs no builds. The harness phase and a
   timed live run are approval gates.
5. **GitHub reuse:** no. GitHub stays on demand under the 2026-10-08 spec. The
   `pipeline` contract is provider-neutral, so a later GitHub design can fill
   it.

## Amendments to the 2026-10-08 spec

- "Never runs the … checks … reads": it now runs one GraphQL pipeline read on
  active ticks and writes the `pipeline` row.
- The 20 s cadence becomes 10 s for active and fast numbers.
- "Only the open number of the subscriber driving the poller is probed" becomes
  every subscribed number, at most 3 of them active or fast.
- Change detection names come from per-name revisions in the probe row, and
  each subscriber tracks what it has been sent.
- The 429 ladder is host-wide and survives hand-offs; `not_authenticated` and
  `forbidden` end the poller and invalidate the host.
- The poller reuses tab totals for up to 5 min.
- Snapshot kinds gain `pipeline`.

## Files to change

| Area         | Files                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts    | `packages/contracts/src/pullRequests.ts`, `pullRequests.test.ts`, regenerated `packages/contracts/fixtures/`                                                                                                                                                  |
| Server model | `apps/server/src/pull_requests/model.rs`                                                                                                                                                                                                                      |
| Server reads | `apps/server/src/pull_requests/gitlab/{parse.rs,graphql.rs,mod.rs,detail_tests.rs}`, `pull_requests/host.rs` (budget argument), `pull_requests/cache.rs` (`get_any_age`)                                                                                      |
| Poller       | `apps/server/src/pull_requests/gitlab/{poll.rs,refresh.rs}`, `snapshot_store.rs` (`put` outcome), `pull_requests/mod.rs` (`read_snapshot`, `subscribe` error handling, shared fenced write path, tripwire fields)                                             |
| Stream       | `apps/server/src/production/pull_requests_rpc.rs` (`forward_changed_to_stream` reports delivery)                                                                                                                                                              |
| Harness      | `apps/server/tests/pull_requests_gitlab_load_harness.rs`, `pull_requests_detail_reads.rs`                                                                                                                                                                     |
| Web          | `apps/web/src/components/pullRequests/detail/{PullRequestsDetailView.tsx,PullRequestsMergeBox.tsx,PullRequestsChecks.tsx,PullRequestsConversation.tsx,pullRequestsDetail.logic.ts,snapshotDisplay.logic.ts}`, new `PullRequestsPipelineSummary.tsx` and tests |
| Living docs  | `docs/architecture/rpc-and-orchestration.md`, `docs/integrations/source-control-providers.md`, `docs/architecture/overview.md`, `docs/user/workspace-ui.md`, the module doc in `poll.rs`                                                                      |
| Runbook      | `docs/testing/cross-platform-validation.md` (Pull Requests section): add the live-pipeline check                                                                                                                                                              |

No new module file, so `SOURCES` is unchanged; no new dependency.

## Tests that fail first

- `refresh.rs`: the tier split (a status change raises `pipeline` and
  `checks`, not `detail`; a `ci_must_pass` bucket change with an unchanged
  `detailed_merge_status` raises `detail`; a stage-only change raises only
  `pipeline`); an old stored fingerprint and an empty probe payload decode
  with defaults.
- `detail_tests.rs`, `parse.rs`: absent key is `hidden` and `null` is `none`;
  kind for `/head`, `/merge`, `/train`, branch and other; all 13 statuses plus
  an unknown one; every row of the combining table, including a push between
  the two reads and a same-commit rerun, which never gives `isForHead: false`;
  the global-ID parse; trigger jobs inside their stage; `hasNextPage` sets
  `truncated`; stage order kept; a finished pipeline whose only allowed
  failure is beyond the 100-job cap shows stage and pipeline `warnings` on
  first paint; a GraphQL error gives `stages: null` without failing `get`.
- `gitlab/mod.rs`: a GraphQL read labelled `pullRequests.subscribe` times out
  at 30 s and stops on cancellation; a 429 on one totals read returns
  `rate_limited`; the poller reuses totals past 30 s and reloads them on a
  list change or after 5 min.
- `snapshot_store.rs`: `put` reports written and older.
- `poll.rs`, in the existing `gitlab_poller_*` style:
  - `…_running_pipeline_on_conversation_probes_every_10s_and_lists_every_20s`
  - `…_first_tick_waits_10s_on_conversation_and_20s_elsewhere`
  - `…_two_subscribers_of_a_number_cause_one_pipeline_read_per_tick`
  - `…_commits_tab_manual_or_scheduled_pipeline_never_reads_the_pipeline`
  - `…_stage_only_change_writes_one_row_then_emits_pipeline_without_detail`
  - `…_pipeline_turning_terminal_reads_the_final_stages_once`
  - `…_push_with_no_pipeline_probes_fast_and_shows_the_new_pipeline_within_one_tick`
  - `…_transient_merge_status_probes_fast_for_at_most_six_ticks`
  - `…_thirty_quiet_minutes_halve_the_active_rate`
  - `…_staggered_pollers_with_different_filters_both_deliver_a_shared_number_change`
  - `…_undelivered_event_is_resent_on_the_next_tick`
  - `…_lagged_receiver_catches_up_from_revisions`
  - `…_rate_limited_totals_read_backs_off_the_host`
  - `…_backoff_survives_driver_hand_off_and_re_key_at_each_ladder_step`
  - `…_auth_failure_ends_every_subscriber_and_deletes_host_rows`
  - `…_logout_during_a_delayed_successful_pipeline_read_writes_nothing`
  - `…_unary_get_checks_interleaved_with_a_poller_write_keeps_the_newer_copy`
  - `…_failed_pipeline_write_raises_no_name`
  - `…_probe_error_still_emits_a_stored_list_change`
  - `…_four_numbers_are_probed_and_three_are_active`
  - `…_non_driver_detail_subscriber_receives_its_numbers_names`
- `pull_requests/mod.rs`: `read_snapshot` returns the `pipeline` row with zero
  `glab` calls; `delete_number` removes it; a `store_read` that started
  before a logout writes nothing.
- Harness: an active phase in
  `gitlab_subscribed_merge_request_polling_records_host_requests` that answers
  every event the way the real client does (`detail` with `get`, `pipeline`
  and `list` with `readSnapshot`, `checks` without `pipeline` on the Pipelines
  tab with `getChecks`). The budget phase has one list key, one number and
  two subscribers of it; over a simulated pipeline lifetime it asserts about
  940 host requests an hour, zero detail joins from stage, job or status
  ticks, the totals reload rule, and every `glab` and `git` spawn counted. A
  second phase adds a second list key on the same number and four numbers in
  all, and asserts delivery: every subscriber gets every name, and three
  numbers are active. The detail band's expected count rises from 26 to 27,
  deliberately.
- Contracts: decode with and without every new optional field.
- Web: `newestCopy` keeps the higher revision in both completion orders (an
  older live `getChecks` answering after a newer poller row must not turn
  running back into queued) and falls back to today's behavior without
  revisions; `changed.pipeline` re-reads the snapshot and skips `getChecks`;
  `checks` alone still calls it; summary copy for each kind and status,
  `hidden`, "Older commit"; the live region announces a terminal transition
  once and never on first paint.

## Verification

- Gates: focused tests above, `cargo fmt --all --check`, Clippy on the server
  targets with `-D warnings`, `vp check`, `vp run typecheck`,
  `vp run check:contracts`. Reviews: `vercel-react-best-practices` on the
  detail view, merge box, checks and summary; UI.md on the summary.
- Live, self-managed GitLab with **Pipelines must succeed** on: a pipeline with
  three stages, one of them trigger-only, a manual job and an allowed failure.
  Stages advance within about 10 s; the tab and the merge box agree. Push a
  commit and time the new pipeline's first appearance. Rerun a finished
  pipeline on the same commit and confirm "Older commit" never shows. With
  `BIBCODE_PULL_REQUESTS_TIMING=1`, count `glab` and `git` calls and process
  wall time over 10 minutes (active about 157 host requests per 10 min). A
  Guest account sees `hidden`. A CE host and GitLab.com each pass the GraphQL
  read, with its `queryComplexity` within limits. Sign out of `glab` while
  watching and confirm the stream ends and the rows go.
- Profiler on during the live run: no `rpc.slow` or `subprocess.crash` from
  the poller or `readSnapshot`; `glab` appears in attributed CPU and memory.
- Confirm that the subscription runtime
  (`createEnvironmentSubscriptionAtomFamily`, reached from
  `packages/client-runtime/src/state/runtime.ts`) does not re-subscribe in a
  tight loop after a stream ends with `not_authenticated`. If it does, back
  it off there; the design is unchanged.

## Rollout

The contract is additive and there is no flag. A new server with an older
client: `pipeline` is ignored, `checks` still fires on status changes, and
`detail` fires on `detailed_merge_status` and metadata changes, which follow
every pipeline status change that changes readiness. A new client with an
older server shows no pipeline row and keeps today's "live wins" checks. Ship
server and web together after the parallel defect fixes for 2, 4 and 5 land,
then update the living docs in the same change.

## Risks

- **GraphQL on old or unusual hosts** (complexity, `read_build`, a host before
  `DetailedStatus.name`): the read degrades to no strip and REST checks, at
  the price of two parsers for the tab.
- **Budget under the proposed GitLab.com Free limits,** shared per group:
  mitigated by the caps and the totals reuse.
- **Tab totals up to 5 min old while polling,** when a change lands off the
  first page. An explicit Refresh and every unary `list` read still reload
  them.
- **Unmeasured local spawn cost** (`glab`, and `git` per `readSnapshot`): an
  approval gate.
- **Delivery rework.** `Tick`, the probe row payload and `emit` change
  shape; an old row decodes as zero revisions and raises names once. The
  existing hand-off and cancellation tests must stay green.
- **Overlap with the parallel defect branches** in `parse.rs`, `gitlab/mod.rs`
  and the checks contract: land those first. Decision 2 needs defect 2's
  bucket function.

## Sources

- GitLab Merge requests API, single MR, merge status and async mergeability:
  https://docs.gitlab.com/api/merge_requests/
- GitLab 16.0 Merge requests API (legacy `detailed_merge_status` values):
  https://archives.docs.gitlab.com/16.0/ee/api/merge_requests.html
- Pipelines API statuses: https://docs.gitlab.com/api/pipelines/
- Jobs API (newest-first order, statuses, `trigger_jobs` 19.2):
  https://docs.gitlab.com/api/jobs/
- Auto-merge history: https://docs.gitlab.com/user/project/merge_requests/auto_merge/
- Self-managed rate limits:
  https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/
- GitLab.com rate limits: https://docs.gitlab.com/user/gitlab_com/rate_limits/
- GraphQL limits (complexity 250 authenticated, page size 100):
  https://docs.gitlab.com/api/graphql/#limits
- Upstream source: `app/models/merge_request.rb` (`diff_head_pipeline`,
  `update_head_pipeline`, ref paths),
  `app/graphql/types/merge_request_type.rb` (`headPipeline`),
  `app/graphql/types/ci/stage_type.rb` (`detailed_status`, `jobs`),
  `app/graphql/types/ci/detailed_status_type.rb` (`name`, deprecated `group`),
  `lib/gitlab/ci/status/success_warning.rb`, `job_type.rb`,
  `pipeline_type.rb`, `lib/gitlab/ci/status/composite.rb`, at
  https://gitlab.com/gitlab-org/gitlab/-/tree/master
- REST ETag cost: https://gitlab.com/gitlab-org/gitlab-foss/issues/26926

## Review

Codex reviewed the first draft. Each finding was checked against the code at
4e023ac5ff before it was accepted.

| #   | Finding                                                                                                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An older live response can overwrite a newer pipeline snapshot through `shownCopy`                      | Accepted. Confirmed at `snapshotDisplay.logic.ts:41-49`. Every pipeline copy now carries the read's `revision`, and the client shows the highest across sources (Decision 3, Client); a test covers both completion orders                                                                                                                                                                                 |
| 2   | Pollers with different list keys consume each other's change detection                                  | Accepted. Confirmed: the probe row is per number, the broadcast per list key (`poll.rs:397-406`). Names now come from per-name revisions in the probe row, and each subscriber tracks what it was sent (Delivery), which also recovers dropped and lagged events. A registry-wide broadcast was considered (Alternative H)                                                                                 |
| 3   | Rows survive logout and poller auth failures                                                            | Accepted. Confirmed at `poll.rs:164-170` and `mod.rs:292-305`, `:975-1009`. Auth failures end the poller and run `invalidate_failed_context`, and the host fence moves into the shared write path, covering `store_read` too                                                                                                                                                                               |
| 4   | Two rows with equal generations are not atomic, and write outcomes are invisible                        | Accepted. Confirmed at `snapshot_store.rs:87-104` and `poll.rs:203-231`. The poller writes one `pipeline` row with header, stages and jobs; `put` reports its outcome; a failed write raises nothing                                                                                                                                                                                                       |
| 5   | REST and GraphQL can describe different pipelines                                                       | Accepted. Confirmed from `diff_head_pipeline`. Copies combine only on matching ids, with a table for `null` and mismatches; a same-commit rerun never shows "Older commit"                                                                                                                                                                                                                                 |
| 6   | The stage query cannot supply "passed with warnings"                                                    | Accepted. `StageType` has `detailedStatus`, not a warnings field. Both queries select `detailedStatus { name }` (`SUCCESS_WITH_WARNINGS`; `group` is deprecated since 16.4), REST `detailed_status.group` covers the header, and both feed the fingerprint                                                                                                                                                 |
| 7   | A totals 429 is invisible, and backoff resets on hand-off                                               | Accepted. Confirmed at `gitlab/mod.rs:208-225` and `poll.rs:418-419`. `counts()` propagates errors, and the ladder lives in the `Registry` per host                                                                                                                                                                                                                                                        |
| 8   | The budget and detail invalidation fail the issue's acceptance criterion                                | Accepted. Tab totals are reused while polling (Decision 7, about 940 an hour), pipeline status changes raise `detail` only on a rare bucket change (Decision 2), and the harness answers events as the real client does. Counting the fallback timer's reads (one eight-read `get` plus a tab read every 20 s) gives about 1,600 an hour, more than an idle probe, so no subscribe is refused (Decision 6) |
| 9   | No fast mode for pipeline creation or transient mergeability                                            | Accepted. A bounded probe-only fast state covers a push, transient `detailed_merge_status`, a just-finished pipeline and an id race, and the first tick waits 10 s on Conversation or Pipelines. "Creating pipeline…" copy is not adopted, because REST cannot know it                                                                                                                                     |
| 10  | GraphQL reads take `Budget::Mutation`, not `Budget::Read`                                               | Accepted. Confirmed at `host.rs:260-286`. `glab_api_with_body` takes a budget from `budget_for(operation)`                                                                                                                                                                                                                                                                                                 |
| 11  | `readSnapshot` is not local and short                                                                   | Accepted. Confirmed at `context.rs:360-370`. The claim is corrected and the `git` spawn is counted in the local cost. It stays out of `is_long_running`, because on the polled path only that spawn runs, and listing it would hide a slow database read                                                                                                                                                   |
| —   | Simpler alternative: one revisioned payload, totals reuse, detail only on metadata or readiness changes | Adopted, except that readiness copy stays in the server's `detail` (defect 2) rather than moving to the probe, so that the five-way copy is not duplicated in the client. That is what the decision 2 exception keeps correct                                                                                                                                                                              |

### Decisions after the implementation review

| #   | Question                                                                                                                                      | Decision                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | A watched number past the 3-number cap gets header-only `pipeline` rows (`checks: null`), so its Pipelines job list did not follow the header | Decided by the product owner on 2026-10-24. On the Pipelines tab of that number only, a header-only row delivered after `changed.pipeline` makes the client re-read `getChecks` once per row revision. A row that carries jobs (an eligible number) never re-reads them, and a repeated event for the same revision reads nothing |

The same review found four implementation defects against this design, now
fixed: a failed final pipeline read left the row on its old status (the read
is now retried until a copy is written); a tick of another poller that was in
flight when a 429 arrived cleared the host's backoff (only a tick that started
after the step clears it); a sign-in failure on the totals read was swallowed
(it now ends the poller); and a tab switch could show an older pipeline copy
(the client keeps the newest copy shown for the merge request).
