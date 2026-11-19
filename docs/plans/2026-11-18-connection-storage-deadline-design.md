# Connection storage deadlines (issue 381)

## Problem

The packaged macOS app sometimes stays at "Project data is still loading"
forever. A probe in a hung page recorded that
`indexedDB.open("bibcode:connection-runtime")` fired no event within 8 seconds.
The storage layer armed a timeout only after `blocked`, its reads and writes had
no deadline, and a connection runtime that never built looked like loading.
That the E2E harness provokes the WebKit stall, by destroying documents during
the IndexedDB bootstrap, is an inference.

## Decision

1. Every connection storage request (open, read, write, recovery deletion) has
   a deadline of 10 seconds (deletion 15). A miss fails the request with the
   existing error type. A write miss says the outcome is unknown and is not
   retried. Late events are ignored and a late open is closed.
2. A miss is published as `unavailable` health with `timedOut: true`. The
   recovery dialog tells the user to quit and reopen BiBCode, and offers only
   Copy diagnostics.
3. A failed runtime build shows "Connections could not start" with a Reload in
   the sidebar and the Inbox instead of their loading lines.
4. The DPoP key storage bounds its requests the same way.
5. The app publishes `data-connection-store="pending|ready|failed"` on
   `<html>`. It is the E2E harness's readiness signal: the harness waits for
   `ready` before and after its connection reset, on every route. It also
   aborts the upgrade of a new database.

## Alternatives

- In-memory fallback session (tried on an abandoned branch). It keeps the app
  usable, but review found it could lose or resurrect saved servers and trust
  stale storage identities across windows. Rejected: a wrong catalog is worse
  than a visible failure.
- Retry only. Retrying the open on the same document likely meets the same
  stall, and without a deadline the retry never starts. Rejected as the fix;
  the user can still reload.
- This design. The app cannot hang silently, and no data path changes. It does
  not keep the app usable during a stall, so the user must restart.

## Trade-offs

- 10 seconds matches the old blocked-open wait. A shorter deadline would fail a
  slow but healthy disk behind a modal dialog that cannot be dismissed.
- The timed-out dialog drops Reload because no test shows a reload in the same
  WebKit process recovers. The coordinator's packaged runs can revisit this.
- A read that misses its deadline mid-session also raises the dialog. A stalled
  store cannot save changes, so stopping the user early protects their work.
