# GitLab Merge Request Background Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visible GitLab merge request paints from the last stored copy, then a subscribed poller refreshes only the queries whose fingerprint changed.

**Architecture:** SQLite in the environment store holds display snapshots. `pullRequests.readSnapshot` reads that table and never calls GitLab. `pullRequests.subscribe` is a small invalidation stream. One poller per mounted list key runs the existing list read plus one merge-request GET, writes the list page, and emits names. The client paints the newer `observedAt` and binds action controls to the live detail only. Slice 1's 20 s timer is paused while the subscription is connected.

**Tech Stack:** Rust (Tokio, rusqlite), TypeScript (Effect Schema, React), the existing GitLab load harness.

**Spec:** `docs/superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md` (slice 2).

**Depends on:** `docs/superpowers/plans/2026-10-08-gitlab-mr-visible-refresh.md` merged or present on the branch. This plan adds a `paused` argument to `useVisiblePullRequestRefresh`.

## Global Constraints

- GitLab only. A GitHub subscribe stays open and emits nothing; no GitHub rows are stored.
- `pullRequests.readSnapshot` performs zero host calls. Missing keys are null, not an error.
- `pullRequests.subscribe` events name `list`, `detail`, `timeline`, `commits`, `checks`, `files`. No payload bodies on the stream.
- Poll period is 20_000 ms after a tick. The first tick waits 20_000 ms after subscribe.
- HTTP 429 delays: 60_000 ms, then 120_000 ms, then 300_000 ms. Any success returns the delay to 20_000 ms. Any other host error emits nothing and retries in 20_000 ms.
- The open detail's probe is always one `GET merge_requests/:iid`, including when that number is on the list page. Probe fields: `updated_at`, `user_notes_count`, `head_pipeline.id`, `head_pipeline.status`. Null pipeline is a real value.
- A changed list fingerprint emits `list`. The client answers `list` with `readSnapshot`, not `pullRequests.list`.
- A changed `updated_at` or note count emits `detail` and `timeline`. A changed pipeline id or status emits `detail` and `checks`. `commits` and `files` emit only when `updated_at` changed and that tab is active. Those names are answered with the existing unary reads. The probe body is not stored as detail.
- List key is the canonical list input without `refreshTotals`.
- Display shows the copy with the newer `observedAt`. A slower older read is discarded.
- Action controls render only from a live detail that succeeded on this mount.
- `runAction` and `checkout` do not read snapshots. A successful `runAction` deletes that number's rows.
- Files payloads over 1_048_576 bytes are not stored. Table payload cap is 33_554_432 bytes; delete oldest `observed_at_ms` until it fits.
- Delete every row for a host on recorded-credential clear, full GitLab logout, or an auth/permission failure that invalidates host context. Rescan does not wipe snapshots.
- An older in-flight write must not overwrite a newer stored payload. A write that finishes after the last subscriber cancelled is dropped.
- Logs must not include payload bytes, hostnames, project paths, or credentials.
- Migration id is 53, name `PullRequestSnapshots`. If 53 is already present, use the next free id and say so in the commit message.
- Update `docs/architecture/rpc-and-orchestration.md`: snapshots are display-only; the visible route subscribes; hidden routes do not; mutations re-read the host.
- Do not change release workflows, version numbers, signing, or publishing.

---

### Task 1: Refresh decision

**Files:**
- Create: `apps/server/src/pull_requests/gitlab/refresh.rs`
- The module is private and tested from `apps/server/src/pull_requests/gitlab/mod.rs` via `mod refresh;`.

**Interfaces:**
- Produces:

```rust
pub(super) struct ListFingerprint {
    pub updated_at: String,
    pub state: String,
    pub checks_summary: Option<String>,
    pub review_decision: Option<String>,
    pub comment_count: u64,
    pub approvals: Option<(u64, u64)>,
    pub unresolved_threads: Option<u64>,
}

pub(super) struct ProbeFingerprint {
    pub updated_at: String,
    pub user_notes_count: u64,
    pub pipeline_id: Option<u64>,
    pub pipeline_status: Option<String>,
}

pub(super) struct ActiveTab {
    pub commits: bool,
    pub files: bool,
}

pub(super) struct RefreshNames {
    pub detail: bool,
    pub timeline: bool,
    pub commits: bool,
    pub checks: bool,
    pub files: bool,
}

pub(super) fn list_changed(previous: &[ListFingerprint], next: &[ListFingerprint]) -> bool;
pub(super) fn detail_refresh(previous: &ProbeFingerprint, next: &ProbeFingerprint, tab: ActiveTab) -> RefreshNames;
```

`list_changed` is true when the lengths differ or any paired fingerprint differs. Order matters: row 0 compared with row 0.

- [ ] **Step 1: Write the failing tests in `refresh.rs` under `#[cfg(test)]`**

```rust
#[test]
fn unchanged_list_and_probe_request_nothing() {
    let row = sample_row();
    assert!(!list_changed(&[row.clone()], &[row]));
    let probe = ProbeFingerprint {
        updated_at: "2026-10-08T00:00:00Z".into(),
        user_notes_count: 3,
        pipeline_id: None,
        pipeline_status: None,
    };
    assert_eq!(
        detail_refresh(&probe, &probe, ActiveTab { commits: true, files: true }),
        RefreshNames::none()
    );
}

#[test]
fn pipeline_change_with_the_same_updated_at_refreshes_detail_and_checks_only() {
    let previous = ProbeFingerprint {
        updated_at: "2026-10-08T00:00:00Z".into(),
        user_notes_count: 3,
        pipeline_id: Some(1),
        pipeline_status: Some("pending".into()),
    };
    let next = ProbeFingerprint {
        pipeline_id: Some(2),
        pipeline_status: Some("pending".into()),
        ..previous.clone()
    };
    assert_eq!(
        detail_refresh(&previous, &next, ActiveTab { commits: true, files: true }),
        RefreshNames { detail: true, checks: true, ..RefreshNames::none() }
    );
}

#[test]
fn note_count_change_refreshes_detail_and_timeline_only() {
    let previous = ProbeFingerprint {
        updated_at: "2026-10-08T00:00:00Z".into(),
        user_notes_count: 3,
        pipeline_id: None,
        pipeline_status: None,
    };
    let next = ProbeFingerprint {
        user_notes_count: 4,
        ..previous.clone()
    };
    assert_eq!(
        detail_refresh(&previous, &next, ActiveTab { commits: true, files: true }),
        RefreshNames { detail: true, timeline: true, ..RefreshNames::none() }
    );
}

#[test]
fn updated_at_change_refreshes_detail_timeline_and_the_active_heavy_tabs() {
    let previous = ProbeFingerprint {
        updated_at: "2026-10-08T00:00:00Z".into(),
        user_notes_count: 3,
        pipeline_id: None,
        pipeline_status: None,
    };
    let next = ProbeFingerprint {
        updated_at: "2026-10-08T00:01:00Z".into(),
        ..previous.clone()
    };
    assert_eq!(
        detail_refresh(&previous, &next, ActiveTab { commits: false, files: true }),
        RefreshNames {
            detail: true,
            timeline: true,
            files: true,
            commits: false,
            checks: false,
        }
    );
}
```

Add `PartialEq` on `RefreshNames`. `sample_row()` fills every `ListFingerprint` field with a fixed value.

- [ ] **Step 2: Run**

`cargo test -p bibcode-server unchanged_list_and_probe_request_nothing -- --test-threads=1`

Expected: FAIL — `refresh` is not a module.

- [ ] **Step 3: Implement**

`detail_refresh`: `notes = previous.user_notes_count != next.user_notes_count`. `updated = previous.updated_at != next.updated_at`. `pipeline = previous.pipeline_id != next.pipeline_id || previous.pipeline_status != next.pipeline_status`. `detail = notes || updated || pipeline`. `timeline = notes || updated`. `checks = pipeline`. `commits = updated && tab.commits`. `files = updated && tab.files`.

- [ ] **Step 4: Re-run the four tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pull_requests/gitlab/refresh.rs apps/server/src/pull_requests/gitlab/mod.rs
git commit -m "test(server): decide which merge request queries a probe refreshes"
```

### Task 2: Snapshot table

**Files:**
- Modify: `apps/server/src/persistence/migrations.rs` (add `migration_053`, register it after 52, add `pull_request_snapshots` to `CORE_TABLES`)
- Create: `apps/server/src/pull_requests/snapshot_store.rs`
- Modify: `apps/server/src/pull_requests/mod.rs` (`mod snapshot_store;`)

**Interfaces:**
- Produces `SnapshotStore` with `get(host, project, kind, key) -> Option<Snapshot>`, `put(Snapshot) -> Result`, `delete_host(host)`, `delete_number(host, project, number)`, `byte_total()`.
- `Snapshot { host, project, kind, key, fingerprint, payload, observed_at_ms, generation }`.
- `put` refuses when `kind == "files" && payload.len() > 1_048_576`. After insert it deletes oldest rows until `sum(length(payload)) <= 33_554_432`. `put` no-ops when an existing row for the same primary key has `generation >=` the incoming generation.

- [ ] **Step 1: Write the failing migration test next to `migration_052_adds_nullable_repository_identity_column`**

Open an in-memory connection, `run_migrations`, then `SELECT name FROM sqlite_master WHERE name = 'pull_request_snapshots'`. Expect one row. Insert two payloads, call the store's `put` for a third whose bytes push the total over 33_554_432, and expect the oldest `observed_at_ms` gone. Insert a files payload of 1_048_577 bytes and expect `get` to return `None`. Put generation 2 then generation 1 and expect the generation 2 payload to remain.

- [ ] **Step 2: Run**

`cargo test -p bibcode-server pull_request_snapshots -- --test-threads=1`

Expected: FAIL — table does not exist.

- [ ] **Step 3: Migration and store**

```sql
CREATE TABLE pull_request_snapshots (
  host TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload BLOB NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (host, project, kind, key)
);
```

`fn migration_053(transaction: &Transaction<'_>) -> Result<()>` runs that statement. Register `Migration::new(53, "PullRequestSnapshots", migration_053)` and `CORE_TABLES` entry `(53, "pull_request_snapshots")`.

`SnapshotStore` takes `&Connection` methods that the caller runs inside the environment store's existing connection lock. Follow the lock style already used by `apps/server/src/persistence/store.rs`; do not open a second database file.

- [ ] **Step 4: Re-run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/migrations.rs apps/server/src/pull_requests/snapshot_store.rs apps/server/src/pull_requests/mod.rs
git commit -m "feat(server): store GitLab merge request snapshots"
```

### Task 3: Contracts and RPC names

**Files:**
- Modify: `packages/contracts/src/pullRequests.ts`
- Modify: `packages/contracts/src/pullRequests.test.ts`
- Modify: `packages/contracts/src/rpc.ts` (`WS_METHODS`, Rpc makers, the RPC group)
- Modify: `apps/server/src/auth/scope.rs` (both new methods are `orchestration:read`)
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/production/pull_requests_rpc.rs`
- Regenerate the RPC wire fixtures the way `pullRequests.getCreateDefaults` did (`packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `apps/server/tests/rpc_wire.rs` pinned counts).

**Interfaces:**
- `WS_METHODS.pullRequestsReadSnapshot = "pullRequests.readSnapshot"`
- `WS_METHODS.pullRequestsSubscribe = "pullRequests.subscribe"`
- Payload `PullRequestsSubscribeInput`: list input fields plus `number: number | null` plus `tab: "conversation" | "commits" | "checks" | "files" | null`.
- `PullRequestsSnapshot`: `{ list: { payload, observedAt } | null, detail: { payload, observedAt } | null, tab: { kind, payload, observedAt } | null }`. `observedAt` is a number (epoch ms).
- `PullRequestsChanged`: `{ list, detail, timeline, commits, checks, files }` all booleans. Stream success type. Error is the existing `PullRequestsOperationError`.

- [ ] **Step 1: Contract test**

Decode a snapshot with a null list and a detail `observedAt` of `1`. Reject a changed event that omits `checks`.

- [ ] **Step 2: Run** `node ../../scripts/run-local-vp.mjs test run src/pullRequests.test.ts` from `packages/contracts`.

Expected: FAIL — schema not exported.

- [ ] **Step 3: Add the schemas and the two RPC definitions**

`readSnapshot` is unary. `subscribe` sets `stream: true`, matching `WsSubscribeGitManagerSignalRpc`.

In `handle_read_unary`, `pullRequests.readSnapshot` calls `self.service.read_snapshot(...)`. Add `handle_subscribe` next to the existing stream registration path used by git manager signals, calling `self.service.subscribe(...)`.

`PullRequestsService::read_snapshot` and `subscribe` return `PullRequestsOperationError` with code `unavailable` and message `Merge request snapshots are not available for this host.` until Task 4 implements GitLab. GitHub takes that branch permanently.

- [ ] **Step 4: Re-run the contract test and `cargo test -p bibcode-server rpc_wire -- --test-threads=1`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(contracts): add merge request snapshot reads and change events"
```

### Task 4: Poller

**Files:**
- Create: `apps/server/src/pull_requests/gitlab/poll.rs`
- Modify: `apps/server/src/pull_requests/mod.rs` (`read_snapshot`, `subscribe`)
- Modify: `apps/server/src/pull_requests/gitlab/mod.rs` (parse probe fields from one merge-request JSON object)

**Interfaces:**
- Consumes: `list_changed`, `detail_refresh`, `SnapshotStore`.
- `GitLabHost::probe(scope, number, cancellation) -> Result<ProbeFingerprint, PullRequestsOperationError>` performs one API GET of `merge_requests/{number}` and reads the four probe fields. It does not call `detail`.
- `subscribe` reference-counts `(environment, host, project, list key)`. The poller task starts at 0→1 and ends at 1→0, cancelling its token. Server shutdown cancels it too.

- [ ] **Step 1: Write a poll-loop test with the stub `glab` pattern already used in `gitlab/detail_tests.rs`**

Assertions, one test each:

- Two subscribers cause one list command per tick, not two.
- Dropping the last subscriber leaves the command log unchanged across a further 20 s (`tokio::time::pause`).
- An unchanged probe writes no detail snapshot and emits no detail bit.
- A changed `updated_at` emits `detail` and `timeline` and then the unary detail method runs; the stored detail payload is the detail response, not the probe JSON.
- A changed `head_pipeline.id` with the same `updated_at` emits `checks` and `detail` only.
- The first command's timestamp is at least 20 s after subscribe.
- A 429 response is followed by a gap of 60 s, then 120 s. The test can stop after the second gap.
- `read_snapshot` with a populated row performs zero `glab` calls.
- `run_action` success for number 7 deletes kinds `detail`, `timeline`, `commits`, `checks`, `files` for that number and leaves other numbers.
- Rescan leaves rows in place.
- A list write with generation 1 does not replace generation 2.
- Cancelling during `put` drops that put. Structure the test by cancelling the subscriber before the stub returns, then asserting the row is absent.

- [ ] **Step 2: Run** `cargo test -p bibcode-server gitlab_poller -- --test-threads=1`

Expected: FAIL.

- [ ] **Step 3: Implement the loop**

```text
sleep(delay) with delay starting at 20s
list = existing list read
if list fingerprint changed:
  store list payload with generation = tick id
  emit list
if a number is subscribed:
  probe = GET
  names = detail_refresh(stored probe fingerprint, probe, active tab)
  store the new probe fingerprint only
  emit the true names
on 429: delay = min(next backoff step, 300s) and do not emit
on other error: delay = 20s and do not emit
on success: delay = 20s and backoff step = 60s again
```

Unary `get` / `getTimeline` / `getCommits` / `getChecks` / `getFiles` / `list`, on success, `put` their payload with a new generation. The poller does not call those methods for names it only probed. The client does, in Task 5.

`read_snapshot` loads list, detail, and the active tab kind. It strips `refreshTotals` from the list key before lookup.

Do not call `delete_host` from `invalidate_contexts`. Rescan uses that method and must leave snapshots in place. Call `delete_host` from the `NotAuthenticated` branch in `context` that already calls `provider_hosts().forget`, and from `invalidate_failed_context` when the code is `not_authenticated` or `forbidden`. `cli_missing`, `cli_too_old`, and `not_found` do not delete snapshots.

- [ ] **Step 4: Re-run the poller tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(server): poll a visible GitLab merge request from stored fingerprints"
```

### Task 5: Client paint and pause the timer

**Files:**
- Modify: `packages/client-runtime/src/state/pullRequests.ts` (add `readSnapshot` query family and `subscribe` stream family, same helpers as `gitManager.ts`'s signal)
- Modify: `apps/web/src/components/pullRequests/useVisiblePullRequestRefresh.ts` (add `paused: boolean`; when true, clear the timer and do not revalidate)
- Modify: `apps/web/src/components/pullRequests/detail/PullRequestsDetailView.tsx`
- Modify: `apps/web/src/components/pullRequests/list/PullRequestsListView.tsx`
- Test: extend `useVisiblePullRequestRefresh.test.tsx` with `paused: true` advancing 60 s and expecting zero calls
- Test: `apps/web/src/components/pullRequests/snapshotDisplay.logic.test.ts`

**Interfaces:**
- Produces `newerObservedAt(current: number | null, incoming: number): boolean` which is `current === null || incoming > current`.
- List invalidation calls `readSnapshot` and, when `newerObservedAt` is true, replaces the displayed list page.
- Detail, timeline, commits, checks, and files invalidation call `revalidate` on those atoms.
- `paused` is true only when `context.provider === "gitlab"` and the subscribe stream's latest event is a success (including the initial connected success with all bits false).

- [ ] **Step 1: Display-rule test**

```ts
import { describe, expect, it } from "vite-plus/test";
import { newerObservedAt } from "./snapshotDisplay.logic";

describe("newerObservedAt", () => {
  it("accepts the first copy and a later copy, and rejects an older one", () => {
    expect(newerObservedAt(null, 10)).toBe(true);
    expect(newerObservedAt(10, 11)).toBe(true);
    expect(newerObservedAt(11, 10)).toBe(false);
    expect(newerObservedAt(10, 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run that test and the paused-timer test**

Expected: FAIL.

- [ ] **Step 3: Implement**

On GitLab list and detail mount:

1. `readSnapshot` for the mounted list key, number, and tab.
2. If its `observedAt` is newer than what is displayed, paint it. A snapshot counts as `data` for `PullRequestsQueryState`, so the skeleton does not replace it.
3. If the live atom has no successful value yet, call `revalidate` once. The existing 5 s stale time still applies when the atom is already fresh.
4. Open `subscribe`. On `list: true`, `readSnapshot` again and apply it through `newerObservedAt`. On the other true bits, `revalidate` that atom.
5. Pass `paused` to both `useVisiblePullRequestRefresh` calls.

Action controls: `PullRequestsMergeBox` and the review actions already receive `detail` from `detailQuery`. Split the detail view's data into `displayed` (snapshot or live, newer `observedAt`) and `live` (the live atom only). Pass `displayed` to the header, conversation, commits, checks, and files. Pass `live` to `PullRequestsMergeBox`, `PullRequestsReviewPopover`, and any other control that calls `runAction`. When `live` is null, those controls keep the existing `PermissionButton` pending reason `"Loading…"` and stay inactive. Add a case to `PullRequestsDetailView.test.tsx`: a snapshot detail with a null live detail renders the title and leaves the merge control inactive.

- [ ] **Step 4: Re-run the new tests plus `PullRequestsDetailView.test.tsx` and `PullRequestsListView.test.tsx`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): paint stored GitLab merge requests and follow change events"
```

### Task 6: Harness numbers and the living rule

**Files:**
- Modify: `apps/server/tests/pull_requests_gitlab_load_harness.rs`
- Modify: `docs/architecture/rpc-and-orchestration.md`

- [ ] **Step 1: Add one harness scenario beside `gitlab_list_and_merge_request_loads_record_requests_and_wall_time`**

At 200 ms injected RTT:

- `read_snapshot` on an empty store: 0 host requests.
- After one live detail has stored a row, `read_snapshot`: 0 host requests.
- An idle subscribed list with an unchanged page: exactly one list-class request across the first tick, and no detail join.
- An idle subscribed detail with an unchanged probe: that list request plus one merge-request GET, and no second wave of the 14 detail calls.
- A cold detail with no row still records a wall time within the existing detail band (the harness already records that band; assert the cold path still performs the detail join).

- [ ] **Step 2: Run**

`cargo test -p bibcode-server --test pull_requests_gitlab_load_harness -- --test-threads=1`

Expected: PASS.

- [ ] **Step 3: Extend the slice 1 sentence in `docs/architecture/rpc-and-orchestration.md`**

State that a visible GitLab route also subscribes; the server polls that list and one probe GET; full reads run only after a fingerprint change; snapshots are display copies; `runAction` and `checkout` re-read the host; a hidden route drops the subscription and the poller stops; GitHub is unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/pull_requests_gitlab_load_harness.rs docs/architecture/rpc-and-orchestration.md
git commit -m "test(server): measure subscribed GitLab merge request polling"
```

## Slice 2 done when

- The refresh, store, poller, contract, client, and harness tests pass.
- `read_snapshot` is covered by a test that counts zero `glab` invocations.
- Action controls in the detail test stay inactive until the live detail exists.
- The living architecture paragraph matches the constraints at the top of this plan.
