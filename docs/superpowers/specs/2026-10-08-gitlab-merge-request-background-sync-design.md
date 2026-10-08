# GitLab merge request background sync

Status: **Proposed** on 2026-10-08. This document is not approval to implement.
Implementation waits until this status line says **Approved** and names the
approved slices.

## Problem and evidence

Opening a GitLab merge request is slow on a high-latency self-hosted instance.
The load harness in `apps/server/tests/pull_requests_gitlab_load_harness.rs`
injects 200 ms before every mock GitLab response and drives
`PullRequestsService` through the real `glab` adapter.

Measured on that harness, one run per figure, after the independent reads were
overlapped (`tokio::join!` in `GitLabHost::detail` and `read_timeline`):

| Screen | Host requests | Shape | Wall time |
| --- | ---: | --- | ---: |
| List, one page | 7 | 1 concurrent wave | 277 ms |
| One merge request, before overlap | 26 | sequential, max in flight 2 | 4,532 ms |
| One merge request, after overlap | 26 | 2 waves, max in flight 14 | 634 ms |

The 634 ms figure is two network round trips plus about 25 ms of `glab`
process overhead per call. Replacing `glab` with a pooled HTTP client does not
remove the two round trips, so it is not a large improvement. The remaining
wait is the time to the first byte from GitLab.

What the user sees on top of that:

- List, detail, timeline, and checks are fresh for 5 s. Commits and files are
  fresh for 30 s. After the last subscriber leaves, the client keeps the value
  for 5 minutes (`packages/client-runtime/src/state/pullRequests.ts`,
  `idleTtlMs` default in `runtime.ts`). Coming back inside that window paints
  immediately and revalidates.
- After 5 minutes, or after a restart, the screen waits on GitLab again.
- Nothing refreshes an open page. The living rule in
  `docs/architecture/rpc-and-orchestration.md` is that pull-request reads start
  from a route, a tab, a filter, a page, Refresh, Rescan, or a successful
  action. No timer, focus event, or idle worker starts provider traffic.
- The server cache (`apps/server/src/pull_requests/cache.rs`) stores host
  context for 30 s. It does not store merge request payloads. Every detail
  read goes to GitLab.
- `PullRequestsQueryState` replaces the panel with the error view whenever the
  latest attempt failed, and it shows the loading skeleton only when `data` is
  null.

The useful outcome is: an open merge request paints from the last good copy,
then catches up while the page is visible, and a hidden page does not talk to
GitLab.

## Alternatives

1. **Visible refresh and hover prefetch (client only).** While the merge
   request route is mounted and the document is visible, refresh the mounted
   list and the open detail on a 20 s timer. Prefetch one hovered row. No new
   table and no new RPC. An idle open detail still pays the full 634 ms read
   every 20 s, and a restart still waits on GitLab for the first paint.
2. **Snapshot, probe, and invalidation (recommended with option 1).** The
   server stores the last successful GitLab payload in the environment SQLite
   database. A visible page reads that snapshot for the first paint, then the
   server polls only while something is subscribed. The poll is one list read,
   plus one merge request GET while a detail is open. The full detail join
   runs only when that detail's fingerprint changed. The stream tells
   the client which queries to refresh. Hidden pages unsubscribe, and the
   poller stops.
3. **Webhook or always-on sync.** Rejected. A desktop app behind a VPN cannot
   receive GitLab webhooks, and polling every repository while the module is
   closed spends the self-hosted instance's budget on screens nobody is
   looking at.

Decision: option 2, with option 1 as the first slice. Option 1 is the
visibility rule and the hover prefetch. Option 2 adds the snapshot and
replaces the blind 20 s detail join with the probe. GitHub keeps today's
on-demand reads. Both hosts already share the unary RPCs; this design adds
GitLab-only server behavior behind a host-neutral client subscription.

## Slice 1 — visible refresh and hover prefetch

Applies to a GitLab project only. GitHub routes keep the current atoms.

- The list query and the open detail query refresh 20 s after the last
  successful response, and again on the same period.
- The timer runs only while that route is mounted and
  `document.visibilityState === "visible"`. Hiding the document clears the
  timer. Showing it refreshes immediately when the last success is older than
  5 s, then the 20 s period starts. `Atom.withRefresh` is the wrong mechanism:
  `setIdleTTL` keeps the atom alive for 5 minutes after the route unmounts, and
  a bare interval would keep calling GitLab after the user left.
- Becoming visible uses the route's own listener. It does not use the
  supervisor `application-active` wakeup, so a visible document does not
  refresh every connected environment.
- The open detail refreshes `get` and the active tab's query (`getTimeline`,
  `getCommits`, `getChecks`, or `getFiles`). Inactive tabs are not refreshed.
- Hovering a list row for 150 ms starts `get` and `getTimeline` for that
  number when that atom has no successful value. At most two such prefetches
  are in flight per environment. A prefetch that has started runs to
  completion. Rows that scroll into view are not prefetched: a page of 30
  would be 30 full detail joins.
- A refresh failure keeps the last successful body on screen. The error is a
  banner with the existing Retry action. The skeleton and the full-panel error
  remain for the case where there is no successful body yet.

Slice 1 changes the living "no timer starts provider traffic" rule for this
route only. The implementation updates
`docs/architecture/rpc-and-orchestration.md` in the same patch.

## Slice 2 — snapshot, probe, and invalidation

Slice 2 makes the first paint local and stops slice 1 from repeating the full
detail join every 20 s.

### Reads

Two additions, both `orchestration:read`:

- `pullRequests.readSnapshot` is unary. It reads SQLite and returns the stored
  payloads for the requested list key and, when a number is open, that
  number's detail and active tab. It does not call GitLab. Missing keys are
  null. Each hit includes `observedAt` from the server clock at the time the
  live read succeeded.
- `pullRequests.subscribe` is a stream, same shape as
  `subscribeGitManagerSignal`: a small event, no payload body. The payload is
  the mounted list input, the open number if any, and the active tab. Events
  name which of `list`, `detail`, `timeline`, `commits`, `checks`, and `files`
  to refresh.

Mount order for a GitLab route:

1. Request the snapshot and open the subscription together.
2. Paint a snapshot as soon as it arrives. The snapshot counts as `data`, so
   the skeleton does not replace it.
3. Start the live unary read when the atom has no successful live value yet.
   A snapshot only covers the wait. The existing 5 s stale time still
   suppresses that live read when the atom is already fresh.
4. The server stores each successful live read with `observedAt` set to the
   server clock at completion.
5. An invalidation event refreshes only the named queries.

Display rule: the screen shows whichever copy has the newer `observedAt`.
A slow read that finishes after a newer copy is already shown is discarded.
Action controls are the exception: they bind only to a live detail that
succeeded on this mount, never to the snapshot copy.

`runAction` and `checkout` are unchanged. They are `orchestration:operate`,
they re-read the host before checking permissions, and they never read the
snapshot. Merge, approve, review, and the other action controls render only
from a live detail that succeeded on this mount. Until that detail arrives,
those controls use the existing pending reason and stay inactive. Title, body,
conversation, commits, checks, and files may render from the snapshot.

A failed live read or a failed poll leaves the snapshot in place and shows the
slice 1 banner. The server does not delete the snapshot on a failed read.

### Poller

One poller per environment, host, project, and mounted list key. Subscribers
are reference counted. The poller starts when the count goes from 0 to 1 and
stops when it returns to 0. Stopping cancels the in-flight `glab` call through
the same cancellation token the unary RPCs already use. Server shutdown
cancels it too.

Each tick, after the previous tick has settled:

1. Run the existing list read for that key (one `glab mr list` page of 30).
2. Compare each row with the stored list fingerprint: `updatedAt`, `state`,
   `checksSummary`, `reviewDecision`, `commentCount`, `approvals`,
   `unresolvedThreads`.
3. When a detail is open, one `GET merge_requests/:iid` is its probe, whether
   or not that number is on the list page. The list row has `checksSummary`
   and no pipeline id, so it cannot see a new pipeline that is still pending.
   The probe fields are `updated_at`, `user_notes_count`, and
   `head_pipeline.id` plus `head_pipeline.status`.
4. The poller writes the list page into the snapshot before it emits. A
   changed list fingerprint emits `list`. The client answers `list` by
   calling `readSnapshot`, not `pullRequests.list`, so the page it already
   fetched is not fetched again.
5. A changed `updated_at` or note count emits `detail` and `timeline`. A
   changed pipeline id or status emits `detail` and `checks`. `commits` and
   `files` are emitted only when `updated_at` changed and that tab is the
   active subscription. The client answers those names with the existing
   unary reads. Those reads are the full join, and their success is what
   gets stored. The probe body is not stored as detail.

`head_pipeline` null is a real fingerprint value. The list `key` is the
canonical list input without `refreshTotals`, so a totals refresh does not
fork the row.

The first tick waits 20 s after subscribe so it does not run beside the
mount's live read. After a tick, the next delay is 20 s. On HTTP 429 the next
delay is 60 s, then 120 s, then 300 s, and a success returns it to 20 s. Any
other host error keeps the last snapshot, emits nothing, and retries in 20 s.
At most one detail-sized read is in flight per poller, and it is the open
number. Other rows on the page update through the stored list page. Opening
one of them later uses that mount's live read. A detail read whose subscriber
left is cancelled and not stored.

While slice 2 is active, slice 1's 20 s client timer is off for that route.
The subscription is the timer. Hover prefetch stays.

### What is stored

The table is migration 53, `PullRequestSnapshots`, in the environment SQLite
database that already holds provider session content. If 53 is taken by the
time this is implemented, use the next free id. Rows:

- `host`, `project`, `kind` (`list`, `detail`, `timeline`, `commits`,
  `checks`, `files`), `key` (canonical list input, or the merge request number
  for the other kinds)
- `fingerprint` (the probe fields, or the list-row fields)
- `payload` (the encoded contract value)
- `observed_at_ms`
- `bytes`

The primary key is `(host, project, kind, key)`. The database is already one
per environment, so the environment is not a column. Checkouts of the same
host project share rows.

Limits: a `files` payload over 1 MiB is not stored. The files tab then waits
on the live read, as it does today. The table's total payload is capped at
32 MiB; the oldest `observed_at_ms` rows are deleted until it fits. Delete
every row for a host when that host's recorded credentials are cleared, when
discovery reports a full GitLab logout, or when an auth or permission failure
invalidates host context. A successful `runAction` deletes that number's
rows. The following live read writes the new snapshot. Rescan does not wipe
snapshots.

Snapshots are display copies. Logs, timing traces, and errors must not include
payload bytes, the GitLab hostname, project paths, or credentials. The store
gets no new encryption in this design; these rows sit in the same trust
boundary as stored provider transcripts.

## Failure and concurrency

- Two subscribers of the same list key share one poller and one list read.
- A snapshot write from an older in-flight read must not overwrite a newer
  observed payload. Stamp the write with the read's start order and drop the
  write when a later success is already stored.
- RPC cancellation of the last subscriber cancels the poll. A snapshot write
  that finishes after cancellation is dropped.
- The client ignores an invalidation for a query it no longer mounts.
- `readSnapshot` returning null is a normal miss, not an error.

## Living documents

The implementation patch updates `docs/architecture/rpc-and-orchestration.md`:
a visible GitLab merge request route may subscribe and may refresh on the
20 s period; hidden and unmounted routes do not; GitHub stays on demand;
snapshots are display-only; mutations re-read the host. No other living
runbook changes unless the patch adds a test command. The harness script
already documented in `docs/reference/scripts.md` stays the measurement tool.

## Tests

- Client: the 20 s refresh fires while visible and mounted, stops while
  hidden, and fires once on show when the last success is older than 5 s.
  Hover prefetch is capped at two and does not start for an atom that already
  succeeded. A refresh failure keeps the previous body and shows Retry.
  Action controls stay inactive until the live detail succeeds.
- Server, on the existing latency harness: a subscription performs the list
  probe; dropping the subscription cancels further probes; an unchanged
  fingerprint performs no detail join; a changed `updated_at` performs one;
  a changed pipeline status with the same `updated_at` performs the checks
  read; `readSnapshot` performs zero host calls; a 429 uses the backoff
  delays; logout deletes the host's rows; a files payload over 1 MiB is
  absent from the table; an older in-flight write does not clobber a newer
  snapshot.
- Re-measure list and detail on the harness at 200 ms. Expected: first paint
  of a stored detail is the SQLite read, with no host call on that path; a
  cold detail with no row stays about 634 ms; an idle visible list with no
  fingerprint change is one list page per 20 s; an idle visible detail adds
  one merge request GET per 20 s and does not repeat the 14-request join.

## Out of scope

- GitHub polling, GitHub snapshots, and webhooks.
- An HTTP connection pool in place of `glab`.
- Prefetching every visible row, or syncing projects with no open subscriber.
- Serving a snapshot to `runAction`, `checkout`, or permission checks.
- Release workflows, version numbers, signing, and publishing.
