# Subscribe once per thread per reconnect (#197)

## Acceptance criterion (from the issue)

- One `subscribeThread` per thread per reconnect, or a documented reason for
  two. A client-runtime test counts the requests across a reconnect.
- The `unchanged` fast path does not change.

## Finding: the client already sends one per thread; the count mixed two threads

The issue's suspect was a request on the unverified session plus another on the
verified one. It was tested and **did not reproduce**.

### 1. Complete client-runtime caller, fake WebSocket

A scratch probe ran the whole path over the `TestWebSocket` from
`rpc/session.test.ts`:

- real `RpcSession.layer`;
- real `ConnectionDriver.make` with `makeVerifiedSessionGate`;
- real `EnvironmentSupervisor.make`;
- real `makeEnvironmentThreadState`, which calls `subscribe()`.

It connected, closed the socket (1006) and reconnected twice. Each socket got
exactly one `orchestration.subscribeThread`, and each request carried the
revision the previous socket delivered:

```
socket 1 [{"threadId":"thread-1","patches":true}] connected
socket 1 after 8 s: [subscribeServerConfig, orchestration.subscribeThread]
socket 2 [{"threadId":"thread-1","patches":true,"resume":{"revision":"r1",...}}] connected
socket 3 [{"threadId":"thread-1","patches":true,"resume":{"revision":"r2",...}}] connected
```

The result did not change in either case below:

- The clock advanced 8 s after `connected`, which would expose a resubscribe
  from the 250 ms retry.
- The server answered the thread before the config, so its data was held by
  the gate.

Why the code sends one:

- The supervisor publishes `subscriptionSession` only at `configuring`
  (`connection/supervisor.ts:391-397`). It publishes `session` at `connected`
  only if `session` does not already hold that session
  (`supervisor.ts:693-700`).
- `subscribe()` follows `subscriptionSession` for the pre-verification tags
  (`rpc/client.ts:325-328`). Publishing `session` therefore never restarts a
  read subscription.
- The gate decides when the request is made (`rpc/session.ts:404-415`). Before
  `open`, the request leaves at once and its output is buffered. After `open`,
  it goes straight to the session. In both cases one request leaves.
- Existing proof:
  - `supervisor.test.ts:502` ("publishes each connection's session once, from
    configuring on").
  - `session.test.ts:1027` and `:1074` (the request is sent while configuring;
    data is held until verified and dropped if the attempt ends unverified).

### 2. The real app in Chromium, instrumented

This reran #134's Tier B harness (scratch, not committed) with:

- this branch's server and web build;
- temporary `console.info` in `subscribe`, `subscribeInSession`,
  `makeEnvironmentThreadState` and `applyItem`;
- per-request CDP logging of each `subscribeThread` frame's socket, RPC id and
  payload.

It covered wrapper mode (1 unchanged reconnect, 2 changed) and restart mode
(2 restarts).

Every reconnect sent **two requests for two different threads**:

```
[page] thread state made 1 memory-thread
[page] thread state made 2 ec76693f-7253-4766-8bed-0adb4c23bc6c
...
[sent] subscribeThread socket .166 rpc 77 {"threadId":"memory-thread", "resume":{...}}
[sent] subscribeThread socket .166 rpc 78 {"threadId":"ec76693f-…", "resume":{...}}
[recv] unchanged socket .166 rpc 78 len 135
[recv] snapshot  socket .166 rpc 77 len 65519   (the 6 MB thread, in records)
reconnect 1 (changed): snapshot=1 unchanged=1 inbound=6.17 MB
```

- **The two threads:** the seeded `memory-thread`, and a second, small thread
  with a UUID id. The app creates thread state for both at page load. That is
  probably the sidebar's `SidebarThreadDetailPrewarmer`
  (`apps/web/src/components/Sidebar.tsx:550`); this was not confirmed.
- **Why the harness saw two:** it counted items per `subscribeThread` request
  id without the payload's `threadId`.
- **Changed reconnect.** The big thread changed and gets a `snapshot`. The
  small one did not change and gets `unchanged`. The issue reported
  "snapshot + unchanged" for this case.
- **Unchanged reconnect.** Both threads are unchanged, so both get `unchanged`.
- **Restart.** New revision keys mean both threads get a snapshot: about 6.17
  MB and 791 bytes. That is "two snapshots" with about 6.18 MB inbound, which
  matches the #134 rows after the first. The 12.04/12.25 MB first reconnect in
  #134 did not reproduce: it was 6.18 MB here. Where its extra 6 MB came from
  is unexplained. It is reported as residual, not as a second subscription.

The second thread's request carries its own resume and is answered with
`unchanged` or a small snapshot. It is not a second copy of the big thread:
nothing is resent and nothing is decoded twice.

### Why the pre-verification subscription exists, and what must keep working

`3fe012b958` sends read subscriptions alongside the config request, which saves
one round trip per reconnect on high-latency links. The gate keeps these
guarantees:

- No data from an unverified server reaches domain state, and buffered data is
  dropped if the attempt ends unverified.
- Unary and mutating calls wait until the gate opens.
- The session is published once per connection, so nothing subscribes twice.

These are documented in `docs/architecture/connection-runtime.md:32-47`, and
none of them changes.

## Change (phase 2)

There is no product code change: the code already meets the criterion. Phase 2
makes it a regression gate and corrects the record.

1. **Test:** `packages/client-runtime/src/rpc/client.reconnect.test.ts` (new,
   next to `client.ts`). It is the probe turned into assertions over the
   complete caller: real session factory over a fake `WebSocket`, real driver
   and gate, real supervisor, and `makeEnvironmentThreadState`. It asserts the
   following:
   - **Verification transition.** Exactly one `subscribeThread` request is
     sent on the socket:
     - before the config arrives;
     - after `open`;
     - after the clock moves past the retry delay.
   - **Reconnect.** After a 1006 close and a reconnect, the new socket gets
     exactly one request, carrying `resume` with the revision delivered on the
     previous socket. The server's `unchanged` answer keeps the thread `live`
     with no snapshot applied, so the fast path is unchanged.
   - **Two threads.** Two thread states on one supervisor send two requests
     per socket, one per `threadId`. This pins the documented reason.
   - **Unverified attempt** (thread answered, config never verified, socket
     closed): the next socket sends one request with the *old* resume. The
     dropped buffer is never applied. This is the legitimate "two requests,
     one per attempt" case.
   - **Paths:**
     - Plain loopback (the `bibcode.rpc.chunked.v1` offer).
     - Plain remote, the deflate offer. Same gate and supervisor; only the
       subprotocol list differs, so this is a parameterized run.
     - E2EE (pinned host key) through `createNkResponder`, as at
       `session.test.ts:326`. If the Noise responder makes the full-stack E2EE
       case disproportionate, it is limited to one reconnect, and the report
       says so.
2. **Docs.**
   - `docs/superpowers/plans/2026-10-27-reconnect-memory.md` (historical): add
     a correction under its "Residuals" entry. The two requests are two
     threads, with a pointer to this plan.
   - `docs/architecture/connection-runtime.md` already says "nothing
     subscribes twice". It gets one clause naming the regression test.
   - Testing runbooks: this changes no command, gate or procedure. They will be
     reviewed and reported as accurate unless the macOS "Thread memory across
     reconnects" section repeats the per-request count. If it does, it gets a
     note to count by `threadId`.
3. **Issue:** the report recommends closing #197 with the documented reason:
   one request per thread per reconnect. I post nothing myself.

Files touched: one new test file and two doc edits. No owned source file
changes. Nothing outside the owned set, apart from the two doc lines.

## Validation (phase 2)

- `vp test run src/rpc/client.reconnect.test.ts`, then
  `vp test run src/rpc src/connection src/state` in `packages/client-runtime`.
- `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`.
- `vp test run scripts/bibcode-identity.test.ts`.
- Profiler coverage: none applies. No process, RPC method, removal path, binary,
  shutdown or event changes.

## Skipped (ponytail)

- Committing the Tier B harness.
- Changing the sidebar prewarmer. Subscribing to a second visible thread is
  intended and costs about 135 bytes per reconnect.
- Folding several threads into one request.
