# Bounded file list and commit pages (issue 390)

`projects.listEntries` without `limit` (the Files panel's read) returned the whole entry
snapshot: up to 25,000 entries and about 16 MiB of index memory. `gitManager.getCommits` kept a
page's first commit whole, so one commit with a long changed-file list made a page of several
megabytes (measured: 2,692,130 B and 4,528,420 B). The memory-retention hypothesis is unproven.

## Decision

1. **listEntries is paged.** A request with `paged: true` gets the first page, and one with the
   previous page's `cursor` gets the next. Each page encodes to at most 960 KiB, leaving room for
   the envelope under the 1 MiB page target, and holds at least one entry. `nextCursor`
   is absent on the last page. `truncated` keeps its meaning: the index hit its own cap.
   The cursor names a random per-index value, the snapshot generation and an offset. A cursor
   from a rebuilt index, or one from before a server restart, fails with `search_index_cursor_stale`.
2. **Client.** The Files panel's query follows `nextCursor` and returns only the joined list, so
   the previous list stays on screen until the new one is complete. A stale cursor restarts from
   the first page at most three times, then shows the usual list error. A re-read is still one
   query refresh, so the existing coalescing (issue 111) applies. The rescan asks for one entry,
   because it only rebuilds the index.
3. **getCommits.** Only for a request with `fitFirstCommit: true` (the history sends it), a page's
   first commit is cut to 960 KiB: files from the end, counted in `changedFilesOmitted`, then
   text, then decorations, all from part sizes. The rest of that page shares the 960 KiB. SHAs and
   parents are never cut; a merge with tens of thousands of parents stays a known residual.

## Alternatives

- **A byte cap that cuts the tree** (an earlier draft): a 25,000-entry workspace showed about
  9,100 rows, worse than the large reply. Rejected.
- **Per-directory (lazy) listing.** The right long-term shape, but too large for this fix.
- **Offset paging without a generation.** A rebuild between pages would mix two lists.

## Compatibility

- An older client sends neither `paged` nor `cursor` and still gets the whole list in one reply.
- A new client against an older server: the server ignores the unknown fields and returns the
  whole list without `nextCursor`, which the client takes as one complete page. No capability is
  needed. A `getCommits` request without `fitFirstCommit` gets the first commit whole, so an
  older client never shows a cut file list as complete.
- Paging splits replies; the panel still holds the whole list, so client memory is unchanged.
