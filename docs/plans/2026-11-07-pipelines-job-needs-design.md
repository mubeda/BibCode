# Pipelines job dependencies (`needs`) view

Issue #322, part 3. Status: **implemented** after the coordinator's review
(2026-11-07, four P2 findings closed in the revision).

## Goal

On a GitLab pipeline that uses `needs`, the pipeline page can show jobs grouped by
their dependencies instead of by stage, as GitLab's own **Group jobs by: Job
dependencies** does. Each job also says which jobs it needs. GitHub gets no
dependency view in this change.

Before this change `PipelinesDetail.usesNeeds` was on the wire and unused;
`PipelinesJob` carried no dependency list.

## Facts this rests on

- GitLab GraphQL `CiJob.needs: CiBuildNeedConnection`, each `CiBuildNeed` has
  `id` and `name` ("name of the job we need to complete").
  `previousStageJobsOrNeeds` is deprecated (16.4) and `previousStageJobs` is
  deprecated (19.2, "computed on the client side"), so neither is used.
- GitLab GraphQL `CiJob.schedulingType: String`: "`dag` if the job uses the
  needs keyword, and `stage` otherwise". A `needs: []` job is `dag` with no
  needs and can start at once; a `stage` job waits for every job of the earlier
  stages.
- `needs` names jobs, not ids. A retry creates a new job id with the same name,
  so dependencies are keyed by name within one pipeline.
- A pipeline's `needs` come from its YAML and do not change while it runs.
- GitHub's jobs API (`/actions/runs/{id}/jobs`) has no `needs` field. The
  dependencies live only in the workflow YAML.
- The GitLab detail query selects up to 100 jobs **per group**
  (`jobs(first:100)` under `groups`), so a pipeline's displayed jobs have no
  overall cap; it already sits under a GraphQL complexity cap (`gitlab/pipelines.rs`
  `PAGE_SIZE` comment). The poller calls `host.detail` every 10 s for each
  running pipeline it follows (`pipelines/poll.rs`).
- One `GitLabHost` serves every GitLab host; its other caches key by
  `HostScope::context_key()`, the lowercased host and the repository.

## Contract

`packages/contracts/src/pipelines.ts`, on `PipelinesJob`:

```ts
/** GitLab `schedulingType`: `dag` uses `needs`, `stage` waits for earlier stages. Absent or null: unknown. */
scheduling: Schema.optionalKey(Schema.NullOr(Schema.Literals(["dag", "stage"]))),
/** Names of the jobs a `dag` job needs. Absent or null: unknown. */
needs: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
```

- `null` or absent: unknown (GitHub, an older server or stored row, a pipeline
  without `usesNeeds`, a failed or truncated dependency read, an unknown
  `schedulingType` string).
- `needs: []` with `scheduling: "dag"`: starts at once.
- `scheduling: "stage"`: `needs` is `[]`; the job depends on earlier stages.
- Optional so a newer client decodes an older server's answer and stored rows.
  Every client check treats `undefined` and `null` alike (`== null`).

Rust `pipelines/model.rs` `Job`: `scheduling: Option<Scheduling>` and
`needs: Option<Vec<String>>`, both `#[serde(default, skip_serializing_if =
"Option::is_none")]`, so stored `pipelines_detail` rows written before this
change still decode and older clients see no new keys when unknown.

## Server read

### Rejected: select `needs` in the detail query

Adding `needs { nodes { name } }` under `jobs(first:100)` adds a nested
connection per job to the query every poller tick sends, for every pipeline,
including the many that do not use `needs`. It risks the complexity cap that
already shapes that query.

### Chosen: a separate read, once per pipeline

When a parsed GitLab detail has `uses_needs == true`, `GitLabHost::detail`
fills each job's `scheduling` and `needs` from a per-pipeline map:

1. Look up `(lowercased host, repository, pipeline_id)` in a bounded in-memory
   cache on the GitLab host (the 64 most recently used pipelines). A hit costs
   no host call.
2. On a miss, send `PipelinesGitLabNeeds`:
   `project(fullPath) { pipeline(id) { jobs(first: 50, after) { pageInfo
   { hasNextPage endCursor } nodes { name schedulingType needs { nodes { name } } } } } }`,
   under `Budget::Large` and the same cancellation token. Pages continue until
   every job name the detail displays has an entry or GitLab has no next page,
   with a hard cap of 40 pages (2,000 jobs). The result is a
   `name -> (scheduling, needs)` map plus a `complete` flag (false when the cap
   stopped the read), cached either way since the answer does not change.
3. Each displayed job takes its own entry. A job with no entry keeps
   `scheduling: None, needs: None` (unknown), never an empty list. An unknown
   `schedulingType` string also gives `None` for both.

`complete` is separate from `detail.truncated` (which means a group's job list
was cut) and is not on the wire: a job whose entry is missing already says
"unknown". The server logs `tracing::warn!` once per pipeline when the cap
stops a read with displayed jobs still missing.

A pipeline without `usesNeeds` costs nothing. A followed pipeline costs one
read at its first tick, then none. A server restart costs one read again.
Because the map is keyed by name, retried jobs keep their dependencies.

GitHub `runs.rs` leaves both fields `None`. Reading workflow YAML at the run's
commit is out of scope.

### Failure modes

| Case                                                                                                                 | Behavior                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Needs read fails (network, 5xx, invalid answer, rate limited)                                                        | The detail returns with both fields `None` on every job; `tracing::warn!` names the operation; not cached, so a later read retries. |
| GitLab refuses a field (`Field doesn't exist`, an older GitLab; `glab` exits nonzero, so its body or stderr is read) | Same, and the host joins a "no needs read" set for the process lifetime, as `pipelines_baseline` does for list fields.              |
| Cancelled                                                                                                            | Propagates like every other pipelines read.                                                                                         |
| Page cap reached with displayed jobs missing                                                                         | Those jobs stay unknown; the rest are filled.                                                                                       |
| A need names a job not displayed (optional need, truncated group)                                                    | Kept as text; layering ignores it.                                                                                                  |

## Web rendering

- When `detail.usesNeeds` is true and at least one job has `scheduling != null`,
  the pipeline page shows a **Group jobs by** select next to **Wrap stages**:
  **Stage** (default) and **Job dependencies**. Stored globally under
  `bibcode:pipelines-job-grouping`; a corrupt value reads as Stage. GitHub,
  older servers, stored rows without the fields, and pipelines without `needs`
  never show it.
- **Job dependencies** reuses `PipelineStageColumns` with pseudo-stages built
  by a pure function in `pipelineDetail.logic.ts`, job by job; a parallel group
  whose jobs land in different layers is split across them. A job's layer:
  - `dag`: 0 with no displayed needs, otherwise one more than the highest layer
    of the displayed jobs it needs;
  - `stage` or unknown: one more than the highest layer of every job in the
    earlier stages (0 in the first stage), which is when GitLab starts it.

  A visited set breaks any cycle (GitLab rejects them; the guard keeps a bad
  answer from hanging the tab). Columns are named "Layer 1", "Layer 2", …,
  with the usual status and job count. Wrap, column width and the inline log
  panel work unchanged.

- Each job row, in both groupings, shows "Needs: build, lint" under its name
  when `needs` is non-empty: plain text, so screen readers get the
  dependencies without a graph. No connecting lines in this change.

## Tests

- Contract: decode with the fields absent, null, and filled.
- Rust (`gitlab/pipelines.rs` tests, fixture JSON): parse the needs page
  (dag, stage, unknown `schedulingType`); fill a detail by name and leave a
  missing job unknown; cache key separates two hosts with the same repository
  and pipeline id; a second fill of the same pipeline sends no read; pagination
  stops once every displayed name is found and at the cap; an old stored row
  without the fields decodes.
- Web logic: layering (chain, diamond, `needs: []` dag job in layer 1, stage
  job after earlier stages, unknown job treated as stage, unknown name, cycle).
- Web view: the select appears only for `usesNeeds` with known scheduling,
  never with the fields absent; switches columns, persists, falls back on a
  corrupt value; "Needs:" text renders in both groupings; GitHub shows no
  select.
- `docs/testing/cross-platform-validation.md`: packaged check on a GitLab
  project with `needs`.

## Coverage and docs

- Profiler: no new process or RPC. The needs read runs inside `pipelines.get`
  and the poller, both already in `is_long_running`.
- Update the pipelines module design, `docs/user/workspace-ui.md`, and the
  testing runbook line in the same change.

## Review decisions

1. Replaced by `schedulingType` (finding 1): stage jobs keep their implicit
   dependency on earlier stages.
2. In-memory cache keyed by host, repository and pipeline id.
3. "Layer 1…n" column labels.
4. "Needs:" text shows in the Stage grouping too.
