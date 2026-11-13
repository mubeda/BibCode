# #356 Worktree creation records: delete by id, audit rollbacks, and edge cases

Follow-ups to the worktree creation records (#344) in #349. Found by reading the code.

- The creation rollback (dispatch failure) and the removal path in `apps/server/src/production/worktree_catalog_rpc.rs` call `delete_worktree_creation_record(path)`. A worktree recreated at that path in the gap loses its record. Delete by the id read when the worktree was resolved, as `reap_worktree_creation_record` does for the audit.
- Neither creation-rollback arm (record write failed, dispatch failed) calls `worktree_audit::record_removal_outcome`. The removal still happens but the profiler audit never sees it.
- `reap_gone_records` in `apps/server/src/diagnostics/profiler/worktree_audit.rs` treats NotFound as gone. A record on an unmounted volume is deleted although the folder still exists.
- A record can outlive its worktree if an unrelated folder is created at the same path later, which warns for that folder. A crash between Git's success and the record write leaves a worktree with no record.
- The tests for the `.git` pointer read pin the no-follow and non-blocking flags, not the ordering between the check and the open. The read is also not contained to a directory handle.


