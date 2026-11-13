# #355 Pull-request lookups: teardown, failures and stale answers

Follow-ups to the status-stream pull-request lookups in #349. Found by reading the code; none was reproduced by a run.

- The shared lookup runs in a bare `tokio::spawn` in `OpenPullRequestLookups::admit` (`apps/server/src/source_control/open_pull_request_lookups.rs`). Quiesce cancels it but does not wait for it, so a `gh` child may be reaped after the profiler teardown. Track the task or join it at quiesce, and prove it with an injected fault.
- Failed lookups are never stored or backed off (`settle` removes the entry on error). With `gh` failing or slow and local events arriving steadily, the status stream in `apps/server/src/production/git_vcs.rs` runs lookups back to back. Add a short failure backoff.
- The request remembered for a branch (`GitBroadcaster::record_pull_request` in `apps/server/src/git/broadcaster.rs`) never expires. If the forge changes it under the same branch name while lookups keep failing, it stays shown until a lookup succeeds.
- `spawn_for_subscribers` drops the late lookup when nobody is subscribed. A refresh with no status subscriber therefore never warms the remembered request.
- Not decided: whether a status-neutral local change leaves a lookup answer from before an invalidation in place. A stream test with an invalidation that changes no status would decide it.


