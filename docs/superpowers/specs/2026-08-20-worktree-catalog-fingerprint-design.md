# Worktree Catalog Fingerprint Design

**Date:** 2026-08-20

## Outcome

Keep worktree discovery and availability fresh while preventing focus,
visibility, and fallback reconciliation from paying for redundant Git
worktree-inventory scans.

This design preserves the server's path/repository authority, focus-driven
discovery introduced by `e0b55f14`, manual authoritative Retry, lifecycle
cancellation, degraded-row retention, and mutation-epoch guarantees.

## Refresh Classes

Catalog refresh intent is explicit:

- **Focus:** catch-up after focus or visible transition; eligible for recent
  result reuse and fingerprint proof.
- **Explicit:** manual Retry and correctness-sensitive caller; bypasses recent
  focus reuse.
- **FirstSubscriber, MetadataChanged, AvailabilityChanged, Mutation:** retain
  their existing service-owned semantics.

The renderer's focus hook sends `Focus`, not the same request used by manual
Retry. Focus and visibility calls for one project remain client single-flight.
Manual Retry always requests an authoritative observation.

## Repository Fingerprint

For a repository observation that already has a trusted common directory, the
server records a subprocess-free fingerprint before the authoritative Git scan.
The fingerprint contains bounded Git-admin and known-worktree facts sufficient
to prove that the previous inventory remains plausible:

- sorted linked-worktree administrative entry names;
- worktree `HEAD`, `gitdir`, `locked`, and relevant ref/config signatures;
- common `packed-refs`, reftable/config, and selected ref signatures;
- primary and known worktree path presence/identity; and
- the repository lifecycle identity and mutation epoch.

Inputs are `stat`, bounded `read_dir`, or small bounded file reads. Symlink,
junction, permission, malformed-content, or identity errors return `unknown`;
they never prove the catalog unchanged.

The fingerprint is captured before the Git scan. A mutation landing during the
scan therefore makes the stored proof stale and forces the next check to scan.

## Cache Decision

After the existing recent-result reuse check:

```text
healthy authoritative snapshot + same lifecycle + same fingerprint
  and last real scan < 5 minutes
    => reuse snapshot without Git
otherwise
    => run the bounded authoritative Git inventory
```

A five-minute real-scan reconciliation remains even when fingerprints are
unchanged. Failed or degraded scans are never extended by fingerprint reuse.

Fingerprint reuse is scoped by physical repository observation but does not
skip per-project joins, suppressions, availability validation, or caller anchor
checks.

Managed worktree creation invalidates the repository fingerprint and retains
the existing managed-creation suppression window. The invalidation covers both
create-dialog outcomes now exposed by the UI: checkout of a reusable free local
branch and server-selected safe suffixing when that branch is already occupied.
The fingerprint never substitutes for the create operation's branch/path
receipt or rollback identity.

## Focus and Poll Interaction

The existing two-second shallow-signature poll remains during the first
fingerprint rollout. Focus first checks the latest healthy result and
fingerprint rather than unconditionally invoking `git rev-parse` plus
`git worktree list`.

Removing or slowing the shallow poll is outside this design. Measurement may
propose it later, after fingerprint correctness and focus freshness are proven.

## Failure and Lifecycle

- Unknown fingerprint state fails open to a real Git scan.
- Cancellation releases project-view ownership without canceling a physical
  observation retained by another valid view.
- Final repository ownership release cancels fingerprint and scan work.
- A prior lifecycle cannot publish into immediate reattachment.
- A different repository at a reused path cannot satisfy the durable pin or
  fingerprint.
- Manual Retry returns the real scan result or its typed failure; it never
  reports cached health after an explicit request.

## Success Criteria

- One focus/visibility burst performs at most one catalog decision per project.
- Unchanged focus catch-up performs no Git subprocess when the fingerprint is
  healthy and the reconciliation bound has not expired.
- Manual Retry performs an authoritative observation.
- External add/remove/move/lock/branch changes alter the fingerprint or converge
  at the five-minute reconciliation.
- Mutation during an in-flight scan forces a later scan and cannot be hidden by
  a post-scan fingerprint capture.
- Reusable-branch and occupied-branch managed creation both invalidate the
  fingerprint without exposing the new checkout as an adoptable external row.
- Degraded snapshots retain prior rows and retry according to existing backoff.
- Shared repositories reuse observation work without crossing project streams,
  suppressions, generations, or ownership.

## Alternatives Rejected

- **Delete focus refresh:** knowingly removes a tested discovery feature.
- **Treat the public explicit RPC as Focus:** weakens manual Retry semantics.
- **Apply the result TTL to every Explicit service call:** can reuse stale data
  in adoption/removal paths that require current authority.
- **Trust directory mtime alone:** misses equal-granularity and ref/content
  changes.
- **Fingerprint with no real-scan reconciliation:** turns a missed filesystem
  signal into unbounded staleness.
