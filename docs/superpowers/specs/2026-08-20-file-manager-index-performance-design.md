# File Manager Index Performance Design

**Date:** 2026-08-20

## Outcome

Reduce File Manager cold-start and post-mutation index latency while preserving
the complete path list, ignored styling, external path-change detection,
expanded folders, explicit Refresh, workspace guards, and Git decorations.

This work is independent from VCS status coordination. It does not change
Source Control status scheduling or use the path-only workspace watcher as a
content watcher.

## Evidence

A cold or invalidated `WorkspaceSearchIndex` currently runs three sequential
`git ls-files` commands:

1. cached plus ordinary untracked files;
2. deleted files; and
3. ignored roots.

It then walks ignored-directory contents and remaining directories. With the
observed Windows process-launch cost, the three sequential Git launches can
dominate the panel before filesystem traversal begins.

Commit `8488fd88` established the current behavioral contract: a cached
server-owned index, out-of-band path-set signals, explicit server rescan,
idempotent signal handling, drag/drop resynchronization, and expansion
preservation.

## Ownership and Cache

The Rust server remains the source of truth for one `WorkspaceSearchIndex` per
canonical workspace root. Concurrent callers share the existing single-flight
build. A generation prevents a scan started before invalidation from being
installed as current.

The renderer continues to re-list after a signal rather than applying its own
path diff. File Manager refresh continues to invalidate and rebuild on the
server before refreshing the query.

## Git Listing

The optimized Git snapshot uses two concurrent read-only commands.

The first command lists cached, ordinary untracked, and deleted entries with
tags so the parser preserves their classification:

```text
git -c core.quotePath=false ls-files -z -t --cached --others --deleted --exclude-standard --
```

The second lists ignored roots:

```text
git -c core.quotePath=false ls-files -z --others --ignored --exclude-standard --directory --
```

The modes cannot be safely collapsed into one tagged invocation because Git's
combined tagged output does not distinguish ordinary untracked and ignored
paths. Both commands use `GIT_OPTIONAL_LOCKS=0`, existing output/memory limits,
the request cancellation token, and a ten-second post-spawn execution bound.
The bound is workspace-index-specific: it does not widen the shared Git runner's
other operations. Ten seconds gives measured slow Windows success enough load
headroom while remaining one-third of the repository Git default; fifteen
seconds would extend failure fallback without evidence that the extra time is
needed.

The parser accepts only the documented tags needed for cached, deleted, and
other entries. An unsupported command, malformed tag, timeout, truncation, or
non-zero result does not produce an authoritative empty tree. The complete Git
snapshot falls back to the existing bounded filesystem scan for that request.

## Filesystem Completion

Ignored-directory content remains eagerly included during the first rollout.
The existing bounded walk and memory/entry/path limits remain unchanged.

Directory walking continues to add empty directories and prunes `.git` plus
ignored roots so ignored content is not traversed twice.

Instrumentation records Git-listing, ignored-tree, directory-walk, cache-wait,
and cache-build durations independently.

## Mutation Invalidation

`WorkspaceService::write_file` returns internal mutation metadata containing the
normalized path, whether the operation created any previously absent path
component, and whether a supported built-in classification control may have
changed. The public RPC response remains `{ relativePath }`.

- A content-only write to an ordinary existing file retains the path index.
- A write that creates a file or parent directory invalidates the path index.
- A write whose logical relative path or safely resolved effective target has
  any `.git` or `.gitignore` component under ASCII case-insensitive comparison
  invalidates the index. False positives on case-sensitive hosts are safe. This
  covers built-in controls such as nested `.gitignore`, `.git/info/exclude`, and
  `.git/config`, including in-workspace symlink aliases.
- Arbitrary files selected by `core.excludesFile` are not retained as cache
  provenance. Editing one of those custom files does not automatically rebuild
  the index; use File Manager **Refresh**. A future separately reviewed design
  must add cached classification-control provenance without a Git process or
  config query on every save.
- Create, rename, delete, duplicate, and drag/drop mutations continue to
  invalidate the complete index.
- External path-set signals continue to invalidate before publication.
- Any admitted write error or panic after a filesystem effect invalidates before
  the original error or unwind continues.

The first rollout does not incrementally patch the cached index. Git ignore
rules, directory rows, renames, and partial failures make that a separate
correctness problem.

VCS local-status invalidation after content writes remains independent. Keeping
the path index does not suppress Git decoration refresh.

## Lazy Ignored-Directory Follow-Up

After the two-command listing ships, lazy ignored-directory loading is added in
a separate reviewed change when either condition is true:

- ignored-tree walking exceeds 50% of p95 index-build time; or
- ignored-tree walking exceeds 500 ms at p95.

The later design keeps ignored roots visible and loads their descendants when
expanded or explicitly searched. Until that change is approved and delivered,
eager ignored-directory behavior remains the contract.

## Success Criteria

- A warm list launches no Git process.
- A cold Git index uses one parallel wave of two Git processes.
- Concurrent cold listers share one build.
- Saving an ordinary existing file does not rebuild the path index.
- Saving a supported built-in classification control rebuilds the path index.
- Custom `core.excludesFile` content changes require explicit File Manager
  **Refresh** until cached control provenance is separately designed.
- Creating a file through `writeFile` does rebuild it.
- Ignored, deleted, tracked, untracked, empty-directory, and truncated states
  match the current result.
- External create/rename/delete signals re-list exactly once.
- Expansion, drag/drop recovery, workspace guards, and Git decorations remain
  unchanged.

## Alternatives Rejected

- **One combined tagged `ls-files`:** loses ignored-versus-untracked identity.
- **Run the existing three commands concurrently:** improves wall time but
  preserves avoidable process volume.
- **Reuse the path watcher for Git content:** directory mtimes do not observe
  in-place content edits.
- **Incrementally mutate the index immediately:** creates a second source of
  truth for ignore, directory, and rename semantics.
- **Make ignored loading lazy in the first patch:** mixes a user-visible tree
  behavior change with subprocess reduction.
