/**
 * Operation names the server's guards emit in `GitManagerBlockedReason.operation`
 * (`apps/server/src/git/manager/guards.rs`). They differ from the request tags
 * (`branch-delete`, `branch-checkout`), which name what the client sends.
 */
export const GUARD_DELETE_BRANCH = "delete-branch";
export const GUARD_RENAME_BRANCH = "rename-branch";
export const GUARD_CHECKOUT = "checkout";
export const GUARD_MERGE = "merge";
