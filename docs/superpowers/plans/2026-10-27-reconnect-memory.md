# Reconnect memory (#96 remainder, from #134)

Status: approved with changes on 2026-10-27 and implemented (see Outcome). Branch `claude/b3-reconnect-memory` from
`origin/develop` at `27702287cc`.

## Requested outcome

The macOS run `docs/testing/reports/2026-10-20-macos-119-96-measurements.md`
(run 6, after the minimap fix `1b3e1df8`) still fails #96. Each changed
in-page reconnect adds about 0.66 copies of every message's `text` (3,008 →
3,474 strings of about 60 KB over 8 reconnects). The JS heap grows about 5.6 MB
and the WebContent footprint about 31 MB per changed reconnect. The shortest
retaining paths run through:

- a "subscribe … messages" path;
- React fiber `memoizedState … messages`;
- `<root>.Internal`.

Find what keeps a changed resend's message graph reachable, fix it in the
owned files (or report the owning component), and hand the lead an exact
re-measurement procedure. #119 and VoiceOver are not part of this batch.

## Acceptance criteria

Thread: M = 100 prompts of 60,000 characters with unique tokens, plus
answers. Then N ≥ 6 changed resends: snapshots resent after a short turn was
added, or after only a scalar such as `updatedAt` changed. The prompts never
change.

1. **Client-runtime and atom layer (node, deterministic).**
   - After a forced GC, no raw snapshot graph older than the latest resend is
     reachable.
   - Each prompt has at most 2 live message objects: the latest raw
     `state.data` plus the shared UI projection, which is the designed steady
     state of `threadDetail.ts`.
2. **React layer (Chromium, real app, production React).**
   - The number of live objects with a `text` value of at least 60,000
     characters, per prompt token, is the same after reconnect 2 and after
     reconnect N, within ±0.1 copies per prompt.
   - The JS heap after a forced GC grows by at most 0.5 MB per changed
     reconnect between those two points.
3. **macOS (lead, Safari Web Inspector).**
   - Strings of about 60 KB stay flat from the baseline snapshot to the
     snapshot after 8 reconnects, within +100 (one copy of each prompt).
   - The JS heap grows by at most about 0.5 MB per changed reconnect.
   - A footprint-only run without the Inspector shows no linear growth.

## Evidence gathered in phase 1

**Throwaway probes.** They are kept outside the repository in the session
scratchpad, `.../scratchpad/b3-reconnect-memory/`.

- `probe-subref.tmp.ts`: a consumed `SubscriptionRef` keeps only its latest
  value; 1 of 20 is alive after GC.
- `probe-resend-retention.tmp.test.ts`:
  - **Setup.**
    - The real `makeEnvironmentThreadState`, with the fake-client harness
      shape of `threads-sync.test.ts`.
    - It feeds a registry atom read by the real
      `createEnvironmentThreadDetailAtoms`, with a live subscription to
      `messagesAtom`.
    - Every resend is `JSON.parse(JSON.stringify(thread))`, so each one has
      fresh strings.
  - **Results.** After 8 changed resends, in both the "append a short
    message" and the "scalar only" variants:
    - 60 KB strings go from 194 to 294, which is exactly +100: one extra copy,
      the latest raw resend. The other 94 strings of 60 KB were not
      attributed; they are constant across every run.
    - The shown `messages[0]` keeps its first identity.
    - Only raw resend 0 and raw resend 8 are alive.
  - **Conclusion.** The client-runtime state and detail projection are bounded
    at 2 copies. The growth is above them, in React and the components, or
    beside them, in the RPC/socket layer. The probe replaced that layer with a
    fake client.
- `probe-dedupe.tmp.mjs`: V8 does not merge equal strings from separate
  `JSON.parse` calls, so V8 string counts are comparable to JSC's.

**Retained raw resend 0, a small oddity.** The raw resend-0 thread *object*
stays alive in the probe, although the projection only keeps its message
objects. It is bounded, so it is not this leak. Phase 2 checks it with one
retainer query, because it pins the first decoded graph for the whole
lifetime of the thread state.

**Baseline of 30 copies.** The baseline already has 30 copies of every prompt,
about 180 MB of a 222 MB heap. That comes from the live turn and patch path
while the thread is built, not from reconnects. It is out of scope here. It is
named so it is not mistaken for reconnect growth, and Tier B measures what a
reload settles to.

## Suspected retention paths (to confirm or rule out; ranked)

A changed resend can add *new* `text` strings to the heap only if a raw
resend's message objects stay reachable. Something else could also copy
`text`, or rebuild messages from the raw ones. `shareUnchanged` hands the UI
the previous message objects for every unchanged message.

1. **React consumers of the raw thread state.**
   - `useEnvironmentThread` (`apps/web/src/state/threads.ts:80-93`) returns
     `EnvironmentThreadState`, whose `data` is the raw resend.
   - Its live caller is `SidebarThreadDetailPrewarmer`
     (`apps/web/src/components/Sidebar.tsx:550-553`, rendered per
     prewarmed ref at `:5545`).
   - The fiber's `useSyncExternalStore` hook keeps raw N. The alternate
     keeps raw N−1. React's store listener is a "subscribe" closure that
     reaches the fiber.
   - On its own this is bounded at 2 raw copies. It adds one more copy than
     the design, and any long-lived closure in that subtree makes it grow.
   - The prewarmer needs the subscription mounted, not the data.
   - `apps/web/src/state/queries.ts:39` `useThreadDetail` (raw) has no
     callers; it is deleted if confirmed.
2. **Closure-context chains in ChatView and MessagesTimeline.**
   - Commit `1b3e1df8` found this pattern: closures created in one render
     share one context, a long-lived holder keeps an old closure, and that
     context keeps the previous render's derived arrays and closures.
   - The report's fiber `memoizedState … messages` path fits.
   - New `text` strings appear only if those derived arrays hold raw-resend
     message objects, or copies such as `trim()` or `slice()` of a whole
     message. So the Tier B retainer paths say exactly which derivation it is.
   - These files belong to other agents (ChatView follow/scroll, activity,
     sidebar status, `composerDraftStore`). A hit there is reported with the
     exact retainer path and a proposed change, not edited here.
3. **`shareUnchanged` rebuilding containers**
   (`packages/client-runtime/src/state/threadDetail.ts:31-55`).
   - For `Object.is`-equal primitives it returns `next`, the *new* string.
   - Any container rebuild takes fresh strings for every primitive in it. A
     rebuild happens when the key count differs, when a key is absent
     (`!owned`), or when an optional key is present but `undefined`.
   - Messages built by the event reducer
     (`threadReducer.ts:251-264`: no `delivery`, conditional
     `attachments`/`resendOf`) can differ in key set from snapshot-decoded
     ones. The patch decode (`threadPatch.ts`) can also leave optional keys
     out.
   - The existing test (`entities.test.ts:505`) compares only snapshot against
     snapshot.
   - **Discriminating test:** build `previous` the way the live thread is
     built (`applyThreadPatch` and `applyThreadDetailEvent`). Then feed a
     Schema-decoded snapshot and assert
     `result.messages[i] === previous.messages[i]` for every unchanged `i`.
   - **Hardening:** return `previous` when `Object.is` holds, so a rebuilt
     container keeps the strings already shown. It costs nothing.
4. **The RPC layer across session switches.** Candidates:
   - `rpc/client.ts:320-345`: `Stream.switchMap` over `supervisor.session`,
     with a new `RpcClient` per reconnect.
   - `rpc/session.ts:165-327`.
   - `chunkedSocket.ts`: the `RecordAssembler` and ordered delivery.

   An old session or client that still holds its last decoded frame would
   hold a raw resend per changed reconnect, which is linear growth. It would
   also explain why unchanged reconnects (tiny frames) add nothing.
   `<root>.Internal` paths, such as pending promise jobs and socket
   listeners, fit too. The phase 1 probe bypassed this layer.
5. **Ruled out by the probes:**
   - `SubscriptionRef.changes` with a consuming subscriber;
   - the thread state's sliding persistence queue;
   - the detail atom's `previousSource`/`shared` bookkeeping (bounded);
   - `cache.saveThread`, which stores one encoded string.

## Feedback loop

**Tier A: node, about 3 s per run, committed as regression tests.**
A vitest file in `packages/client-runtime/src/state/`.

- **Garbage collection:** `v8.setFlagsFromString("--expose_gc")` plus
  `vm.runInNewContext("gc")`, with a macrotask awaited before each `gc()`. No
  pool flags are needed.
- **Fresh strings:** every resend is a real decode
  (`JSON.parse(JSON.stringify(...))`, or the contracts Schema decode), so each
  one has new strings.
- **Measures:**
  - `WeakRef`s on each raw resend's thread, `messages` array and first prompt
    message, counted after GC;
  - the shown `messages[i]` identity.

  No heap-snapshot parsing goes into committed tests: it is too slow and
  brittle. The probe's `v8.writeHeapSnapshot` count stays a diagnostic.

Layers, each a case:

1. State and detail atoms, with the append and scalar variants. This is the
   probe turned into a test; it is expected to pass today.
2. Layer 1 plus `previous` built through the patch and event paths, for
   suspect 3.
3. A real `RpcSession` from `rpc/session.ts` over the fake `WebSocket`
   pattern in `rpc/session.test.ts:192`, with JSON `Chunk` frames.
   - The socket is closed and a new session installed for each resend,
     driven through `subscribe()` and `makeEnvironmentThreadState`.
   - It asserts that raw graphs from closed sessions are collected. This is
     suspect 4.

**Tier B: Chromium with the real app, about 3–5 minutes per run after the
first build. A scratch harness, not committed.**

1. **Server.**
   - Build the server once: `cargo build -p bibcode-server`, with the pinned
     1.98.1 toolchain, this worktree's own `target/` and
     `CARGO_BUILD_JOBS=4`.
   - Run `bibcode serve` with a temporary `BIBCODE_HOME` and the Codex shim
     that `createProviderShims` in `apps/desktop/e2e/support/test-project.ts`
     generates on `PATH`.
2. **Web build.**
   - Production React, unminified so retainer names are readable:
     `vp build` in `apps/web` with `--minify false --sourcemap`.
   - Serve it from the server or `vite preview`.
   - Development React is avoided: StrictMode and `_debugOwner` add their own
     retention.
3. **Thread.**
   - Seed it over RPC from node: 100 turns with 60,000-character prompts,
     each carrying a unique token.
   - Then open the thread in Playwright Chromium.
4. **Reconnects.**
   - An init script wraps `WebSocket` to keep the RPC sockets.
   - A *changed* reconnect:
     1. Set the network offline through CDP
        `Network.emulateNetworkConditions`, then close the socket.
     2. Send a short turn from node.
     3. Restore the network.
   - An *unchanged* reconnect skips step 2.
   - Sequence: 2 unchanged, then 8 changed.
5. **Measure.**
   - `HeapProfiler.collectGarbage`, then `HeapProfiler.takeHeapSnapshot`,
     after reconnects 2, 4 and 8.
   - A node parser counts live objects with a `text` edge to a string of at
     least 60,000 characters, grouped by token. It also prints
     `Runtime.getHeapUsage`.
   - For each copy beyond the second it prints the shortest retainer path:
     the edge names through closures (`context`), fibers (`memoizedState`,
     `alternate`) and listener sets.
   - The path names the file and component that hold the copy.
6. **Loop.** Run the harness, change one suspected holder, then rerun. Each
   run is compared against the same reconnect sequence.

## Change (decided by the loop; candidates now)

- **Suspect 1** (owned seam):
  - Add a mount-only hook to `apps/web/src/state/threads.ts`, for example
    `useMountedThreadState(ref)` over `useAtomMount`, or a status-only atom.
    It keeps the thread subscription warm while React holds no thread data.
  - Remove the unused raw `useThreadDetail` from `state/queries.ts`.
  - The one-line call-site change in `Sidebar.tsx:551` belongs to the Sidebar
    owner. **Lead decision needed:** either allow this one line or route it
    to that agent.
- **Suspect 3:**
  - `shareUnchanged` keeps `previous` for `Object.is`-equal primitives.
  - Add the cross-path identity test.
  - If the key sets differ, align the reducer's message construction with the
    decoded shape (`threadReducer.ts`, owned).
- **Suspect 4:**
  - Release the per-session decoded state in client-runtime, wherever Tier A
    case 3 shows the holder: `rpc/client.ts`, `rpc/session.ts` or
    `chunkedSocket.ts`.
  - **Lead decision needed:** these RPC files are not named in the brief's
    owned list ("thread cache/reconnect resend handling"). I treat
    reconnect-resend handling in client-runtime as owned unless the lead
    says otherwise.
- **Suspect 2:** report the retainer path and a proposed fix to the owning
  agent. No edit here.
- **The raw resend-0 oddity:** fix it only if it is in owned code and the fix
  is one line.

## Files I expect to touch

- `packages/client-runtime/src/state/threadDetail.ts`
- `packages/client-runtime/src/state/threadReducer.ts` (only for suspect 3)
- `packages/client-runtime/src/rpc/{client,session,chunkedSocket}.ts` (only
  for suspect 4)
- `packages/client-runtime/src/state/reconnectRetention.test.ts` (new,
  Tier A)
- `packages/client-runtime/src/state/entities.test.ts` (the cross-path
  identity case)
- `apps/web/src/state/threads.ts` and `apps/web/src/state/queries.ts`
- `docs/architecture/rpc-and-orchestration.md`
- `docs/testing/macos-desktop.md`

## Tests that prove it (complete caller)

- **Tier A cases 1–3.** They run through the real `makeEnvironmentThreadState`
  → `subscribe()` → `RpcSession` path that the app uses, with only the
  WebSocket faked. Each test fails before the fix wherever its layer is the
  holder.
- **For a web-side fix,** a happy-dom `createRoot` test. It mounts the changed
  hook or component with the real atoms over Tier A's state source. It
  asserts by `WeakRef` that raw resends are not reachable from the mounted
  tree after 8 resends and GC.
- **Tier B numbers,** before and after, recorded in the phase-2 report as
  supporting evidence.
- **Package checks:**
  - `vp test run` for client-runtime;
  - `vp test run --project unit` for the touched web tests;
  - `vp check --no-fmt` and `vp check <files>`;
  - `vp run typecheck`;
  - the vercel-react-best-practices review for any web hook.

## Docs and runbooks

- **`docs/architecture/rpc-and-orchestration.md` around line 2594.** It says a
  resync "does not hand the UI a second copy". Correct it to the measured
  steady state, the latest raw resend plus the shared projection, and name
  what was fixed.
- **`docs/testing/macos-desktop.md`.** Add the #96 heap-snapshot procedure
  below as a living section; today it lives only in scratch specs. Then
  review the Linux and Windows runbooks for the same step.

## Re-measurement procedure for the lead (macOS, Safari Web Inspector)

**Missing inputs.**

- The 2026-10-18 and 2026-10-20 scratch specs (the #96 WebDriver spec with
  `console.takeHeapSnapshot` gates) and `analyze.py` are not in this
  session's scratchpad.
- `/private/tmp/m134-heap` no longer exists.

The lead must supply them, or recreate them from the steps below. In phase 2
I can write the recreated spec into the scratchpad if asked.

**Spec changes.**

1. **Thread.** Keep 100 prompts of 60,000 characters with unique tokens.
   Make every turn added during a reconnect short (well under 1 KB). Then
   every string of about 60 KB is an original prompt: JSC snapshots carry no
   string contents, so size and the retaining edge name are the only grouping.
2. **Sequence.** An idle control, 2 unchanged reconnects, then 8 changed ones.
   Keep the in-page socket close, and make each change happen while the
   socket is down.
3. **Snapshots.**
   - Take snapshots at the baseline (after the unchanged reconnects), after
     changed reconnect 4 (linearity) and after reconnect 8.
   - Take one more after a page reload, to see what the 30 baseline copies
     collapse to.
   - Record the Inspector only around each snapshot, as in run 6.
4. **Analysis.**
   - Report the count of strings of about 60 KB per snapshot, split by
     retaining field (`text`, `userText`, `__text`, `__cachedText`).
   - Give the top three shortest retainer paths for strings added since the
     baseline.
   - Exclude paths through `__wd_el_*` (a WebDriver artifact).
5. **Footprint-only run.** No Inspector attached: the same sequence, with the
   WebContent `phys_footprint` median of 3 samples after a 30 s settle, after
   every reconnect, then 120 s after the end.
6. **Build.** Use this branch's tip, with the same packaged build command and
   a fresh identifier (`com.bibcode.desktop.e2e.m134b`).

## Skipped (ponytail)

Not in this batch:

- the 30-copy baseline from the live turn and patch path;
- the #119 long frames;
- VoiceOver;
- a committed Chromium harness or CI memory gate;
- protocol changes, for example a patch against the held revision.

## Outcome (phase 2, 2026-10-27)

**Root cause.** The Tier B Chromium run reproduced the macOS failure: 2 → 4 →
6 → 10 copies of every prompt after 0, 2, 4 and 8 changed reconnects, with the
JS heap going from 48.6 to 99.7 MB.

- An identity probe on the live projection showed it lost the identity of the
  shown messages on every changed resend. The server orders messages by
  delivery and time, so the reconnect turn's messages landed *before* messages
  the client already showed.
- `shareUnchanged` matched array entries by position, so it took the resent
  copy of every later message.
- Superseded ChatView renders keep their `serverMessages` arrays alive through
  closure-context chains (`handleOpenProviderTerminalPanel` ↔
  `getActiveTimelineTurnMetrics`, the composer's `onSubmit` → `focus` →
  `onRemoveTerminalContext` → `addComposerAttachments` → `onPageTimeline`).
  Each changed reconnect therefore pinned one more full copy.

**Fix.** Entries with an `id` are matched by id (`threadDetail.ts`). After the
fix, Tier B shows 1 → 3 → 3 → 3 copies, and the heap goes 41.2 → 55.1 → 55.7 →
57.1 MB. That is about 0.3 MB per changed reconnect between reconnects 2 and 8,
mostly JIT code. A wrapper-free control, which restarts the server for every
reconnect, agrees:

| Run          | Copies after changed reconnect 2 | Copies after changed reconnect 6 |
| ------------ | -------------------------------- | -------------------------------- |
| Before fix   | —                                | 7.75                             |
| After fix    | 2.96                             | 2.96                             |

**Residuals,** reported rather than fixed:

- `SidebarThreadDetailPrewarmer` holds one stale raw resend, a bounded extra
  copy, through `useEnvironmentThread`.
- The ChatView closure chains remain, but now hold only arrays of shared
  objects.
- Each reconnect sends two `subscribeThread` requests: in Tier B, one snapshot
  and one `unchanged`, or two snapshots after a server restart. The likely
  cause is a pre-verification subscription followed by a verified one; this is
  not confirmed.
