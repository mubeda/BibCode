# Pipelines job dependencies (`needs`) view

Issue #322, part 3. Status: **proposed, awaiting review.** No code until approved.

## Goal

On a GitLab pipeline that uses `needs`, the pipeline page can show jobs grouped by
their dependencies instead of by stage, as GitLab's own **Group jobs by: Job
dependencies** does. Each job also says which jobs it needs. GitHub gets no
dependency view in this change.

Today `PipelinesDetail.usesNeeds` is on the wire and unused; `PipelinesJob`
carries no dependency list.

## Facts this rests on

- GitLab GraphQL `CiJob.needs: CiBuildNeedConnection`, each `CiBuildNeed` has
  `id` and `name` ("name of the job we need to complete"). It has no version
  note in the current reference. `previousStageJobsOrNeeds` is deprecated
  (16.4) and `previousStageJobs` is deprecated (19.2, "computed on the client
  side"), so neither is used.
- `needs` names jobs, not ids. A retry creates a new job id with the same name,
  so dependencies are keyed by name within one pipeline.
- A pipeline's `needs` come from its YAML and do not change while it runs.
- GraphQL cannot tell a job with no `needs:` keyword (waits for earlier stages)
  from one with `needs: []` (starts at once). Both return an empty connection.
- GitHub's jobs API (`/actions/runs/{id}/jobs`) has no `needs` field. The
  dependencies live only in the workflow YAML.
- The GitLab detail query already selects up to 100 jobs per group under a
  GraphQL complexity cap (`gitlab/pipelines.rs` `PAGE_SIZE` comment), and the
  poller calls `host.detail` every 10 s for each running pipeline it follows
  (`pipelines/poll.rs`).

## Contract

`packages/contracts/src/pipelines.ts`, on `PipelinesJob`:

```ts
/** Names of the jobs this job needs (GitLab). Absent or null: the host did not say. */
needs: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
```

- `null` or absent: unknown (GitHub, an older server, a pipeline without
  `usesNeeds`, or a failed dependency read).
- `[]`: GitLab returned no needs for this job.
- Optional so a newer client decodes an older server's answer and stored rows.

Rust `pipelines/model.rs` `Job`: `#[serde(default, skip_serializing_if =
"Option::is_none")] pub needs: Option<Vec<String>>`, so stored `pipelines_detail`
rows written before this change still decode. Fixtures gain the field where a
test needs it; every other constructor sets `needs: None`.

## Server read

### Rejected: select `needs` in the detail query

Adding `needs { nodes { name } }` under `jobs(first:100)` adds a nested
connection per job to the query every poller tick sends, for every pipeline,
including the many that do not use `needs`. It risks the complexity cap that
already shapes that query.

### Proposed: a separate read, once per pipeline

When a parsed GitLab detail has `uses_needs == true`, `GitLabHost::detail`
fills each job's `needs` from a per-pipeline map:

1. Look up `(repository, pipeline_id)` in a bounded in-memory cache on the
   GitLab host (LRU, 64 pipelines). A hit costs no host call.
2. On a miss, send `PipelinesGitLabNeeds`:
   `project(fullPath) { pipeline(id) { jobs(first: N, after) { pageInfo
   { hasNextPage endCursor } nodes { name needs { nodes { name } } } } } }`,
   paged up to the detail's own 1,000-job reach, under `Budget::Large` and the
   same cancellation token. `N` is set by measuring complexity against
   gitlab.com during implementation (start at 50 and lower it if GitLab
   refuses the query for complexity). The result is a `name -> [names]` map,
   cached.
3. Set `job.needs = Some(map.get(name).cloned().unwrap_or_default())` for every
   job in the detail.

A pipeline without `usesNeeds` costs nothing. A followed pipeline costs one
extra read at its first tick, then none. A server restart costs one read again.
Because the map is keyed by name, retried jobs keep their dependencies.

GitHub `runs.rs` sets `needs: None`. Reading workflow YAML at the run's commit
is out of scope.

### Failure modes

| Case                                                                            | Behavior                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Needs read fails (network, 5xx, invalid answer)                                 | Detail returns with `needs: None` on every job; `tracing::warn!` names the operation; not cached, so the next read retries. |
| Rate limited                                                                    | Same as above, without a retry inside this read; the detail itself already succeeded.                                       |
| GitLab refuses the field (`Field doesn't exist`)                                | Treated as unsupported for that host: cache an empty marker for the pipeline and return `needs: None`.                      |
| Cancelled                                                                       | Propagates like every other pipelines read.                                                                                 |
| More jobs than the reach                                                        | Jobs past it get `[]`; the page already shows the truncation notice.                                                        |
| A need names a job not in the detail (optional need, truncated, other pipeline) | Kept as text; the view puts the job by its known needs only.                                                                |

## Web rendering

- When `detail.usesNeeds` is true and at least one job has `needs !== null`,
  the pipeline page shows a **Group jobs by** select next to **Wrap stages**:
  **Stage** (default) and **Job dependencies**. Stored globally under
  `bibcode:pipelines-job-grouping`; a corrupt value reads as Stage. GitHub and
  pipelines without `needs` never show it.
- **Job dependencies** reuses `PipelineStageColumns` with pseudo-stages built
  by a pure function in `pipelineDetail.logic.ts`: a job's layer is 0 when it
  needs nothing known, otherwise one more than the highest layer among the jobs
  it needs that are in the pipeline. A visited set breaks any cycle (GitLab
  rejects them; the guard keeps a bad answer from hanging the tab). Columns are
  named "Layer 1", "Layer 2", …, with the usual status and job count. Wrap,
  column width and the inline log panel work unchanged.
- Each job row, in both groupings, shows "Needs: build, lint" under its name
  when `needs` is non-empty: plain text, so screen readers get the
  dependencies without a graph. No connecting lines in this change.
- A job with empty `needs` lands in layer 0. Because GitLab returns the same
  empty list for "no `needs:` keyword" and `needs: []`, a job that actually
  waits for earlier stages shows in the first layer. Open question 1.

## Tests

- Contract: decode with `needs` absent, null, empty and filled
  (`packages/contracts` fixtures).
- Rust (`gitlab/pipelines.rs` tests, fixture JSON): a `usesNeeds` detail sends
  one needs query and fills `needs` by name; a second read of the same pipeline
  sends none (request counter); a pipeline without `usesNeeds` sends none; a
  failed needs read returns the detail with `needs: None` and is retried next
  time; pagination stops at the reach; an old stored row without `needs`
  decodes. GitHub detail has `needs: None`.
- Web logic: layering (chain, diamond, unknown name, cycle, all empty).
- Web view: the select appears only for `usesNeeds` with known needs, switches
  columns, persists, and falls back on a corrupt value; "Needs:" text renders;
  GitHub shows no select.
- `docs/testing/cross-platform-validation.md`: packaged check on a GitLab
  project with `needs`.

## Coverage and docs

- Profiler: no new process or RPC. The needs read runs inside `pipelines.get`
  and the poller, both already in `is_long_running`.
- Update the pipelines module design, `docs/user/workspace-ui.md`, and the
  testing runbook line in the same change.

## Open questions for review

1. Accept that "no `needs:` keyword" and `needs: []` look the same, putting both
   in the first layer? The alternative is to treat an empty list as "after
   every job of earlier stages" whenever the pipeline uses `needs`, which is
   wrong for `needs: []` jobs instead.
2. In-memory cache versus storing the map with the `pipelines_detail` row.
   In-memory is smaller and loses only one read on restart.
3. Column labels "Layer 1…n", or no stage-like header at all?
4. Should the "Needs:" text show in the Stage grouping too (proposed), or only
   in the dependency grouping?
