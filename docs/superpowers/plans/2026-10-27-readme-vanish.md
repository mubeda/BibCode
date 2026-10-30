# Plan: "@README" vanished after the first send (#199)

Batch: readme-vanish. Branch `claude/b3f-readme-vanish` from
`claude/issue-batch-after-v0.12.0` (contains the #189 draft-carry fix and the
attachment-authority send fix). Phase 1 output: evidence, ranked hypotheses,
and the diagnosis loop. Nothing is implemented yet.

## Acceptance criterion (#199)

1. Reproduce or bound the failure using the Intel runner's artifacts or a stress
   loop, identify the cause and fix it, or document with evidence that it does
   not reproduce.
2. The `composer-native-triggers` spec comment describes what actually happens.

## Evidence

### The single observation

- `composer-native-triggers` failed with `Composer did not contain "@README"` once:
  PR #183 run 40421268641, job 121916025542 (Desktop UI - macOS x64), commit
  932f61e370, at `setComposerValue("@README")` inside `selectAndSendReadmeReference`,
  right after the Codex `$refactor` send reached the provider log.
- Across the seven packaged-smoke runs on PR #183, all six platforms, this message
  appears in no other job. There is one sample, so "Intel only" cannot be told apart
  from chance.
- Failure screenshot
  (`failure-normalizes-every-ready-provider-...png`): the composer is empty and focused,
  shows the normal placeholder (so the environment is connected again), and has no menu or
  error banner. The `$refactor` turn has finished ("Worked for 9ms").

### Timeline from `app-server.log` (failing artifact `desktop-ui-mac-x64`)

- `waitforTimeout` is 20 s (`apps/desktop/e2e/wdio.conf.ts:139`). The error is logged at
  00:27:26.85, so `waitForComposerValue("@README")` started no later than 00:27:06.85.
  By then `editor.click()`, the select-all script, `Backspace` and `addValue("@README")`
  had all returned.
- At **00:27:06.44** the server logged `RPC connection ended reason="client-closed"` at
  DEBUG with **no page load** next to it. Every other `client-closed` in the spec's window
  comes a few ms before a `desktop_e2e_page_load_started` (a WebDriver navigation).
  `transport.rs:250-289` logs DEBUG only when `is_abnormal()` is false: the server
  *received* a Close frame with code none, 1000 or 1001. It is not the client liveness
  close (4408, logged as `client-liveness-timeout`). The record does not prove which
  client code path initiated it, or that the editor went read-only while the test was
  typing. **This close is correlated with the failure, not a proven cause.**
- At 00:27:09.49, about 3 s later, four workspace-index requests arrive within 14 ms (one
  `cache_wait miss` and three `shared`). Searches earlier in the spec arrive one at a
  time. The burst fits a reconnect finishing after `RETRY_DELAYS_MS[0]` = 1 s ±15 %
  (`packages/client-runtime/src/connection/supervisor.ts:35`) plus socket setup and initial
  config on a slow runner, with subscribers then asking again. It is consistent with a
  reconnect but does not prove one.
- Comparison set: the passing macOS x64 run 40463655776, runs 40447718462 and
  40439236485, and the failing run's macOS arm64 artifact have **no** unpaired
  `client-closed`. Run 40428617333 (x64) and the failing run each show one more unpaired
  close (02:07:52 and 00:27:36). Both are followed within 1 s by `client-eof` and a
  close-then-page-load. That is a separate, recurring pattern later in the suite, so it
  is not counted here. In the five macOS logs checked, the 00:27:06 close is the only one
  of its kind, and it lands in the only failure's typing window.

### Evidence gaps

- The worker WebDriver log in the artifact (`main-window.e2e-0-0.log`) covers only
  00:26:35-00:26:39. There is no command timeline for the failure window.
- No client-side (webview console, connection phase) log is collected. The artifact
  therefore cannot show why the client closed, or whether "@README" ever reached the
  DOM.

### Product path the close would take (file:line chain)

Once the supervisor drops its lease, the phase leaves `connected`.
`isConnectionUnavailable` returns `phase !== "connected"`
(`packages/client-runtime/src/connection/presentation.ts:130-131`), so ChatView sets
`activeEnvironmentUnavailableState` (`apps/web/src/components/ChatView.tsx:1708-1721`).
ChatComposer then passes `disabled` while `environmentUnavailable !== null`
(`apps/web/src/components/chat/ChatComposer.tsx:2755-2760`), and the editor calls
`editor.setEditable(!disabled)` (`apps/web/src/components/ComposerPromptEditor.tsx:1765-1767`).
While the phase is anything but `connected`, including a one-second reconnect, the
composer stops taking input.

The value-sync layout effect (`ComposerPromptEditor.tsx:1769-1801`) rebuilds the editor
from the controlled `value` when the value changes *or the editor is not focused*.
`providerCapabilities.data?.skills ?? []` (`ChatComposer.tsx:2731`) can change during a
reconnect, which also triggers that effect.

### Ruled out

- Draft promotion (#189): the primary workspace chat is already a server thread, so its
  route never changes, and the wait added in #183 does nothing for this path.
- The send clearing the composer late: `promptRef.current = ""` and
  `clearComposerDraftContent` run synchronously in `onSend` before any await
  (`ChatView.tsx:5436-5437`). The test also types only after the provider log has the
  entry.
- A failed send restoring the prompt: `restoreOutgoing` merges the restored prompt into
  the current one (`ChatView.tsx:5241-5281`), which would leave text in the composer,
  not empty it.

## Ranked hypotheses and what decides between them

**H1: a reconnect makes the editor read-only and the keystrokes are dropped.** This is a
candidate suggested by the correlated close at 00:27:06.44, not something the artifacts
show. If the phase left `connected` while `addValue` was typing, `setEditable(false)`
would drop the keys.
- Prediction: at typing time the editor root has `contentEditable === "false"`, and
  `textContent` never contains "@README", not even for one frame.

**H2: the text is typed, then wiped when the connection comes back.** "@README" reaches
the editor (still editable when the keys arrive), but the editor either loses focus
(`setEditable(false)`) or the skills signature changes. The value-sync effect then
rebuilds it from a store `value` without the text, perhaps because `onChange` did not
store it while the editor was read-only.
- Prediction: frame-by-frame, `textContent` goes to "@README" and then back to `""`
  around the phase change.

**What decides between H1 and H2:** whether "@README" ever appears in the editor DOM
during the window.

**H3: no connection involvement.** The finishing fixture turn (a thread update arriving
mid-typing) resets the composer.
- Prediction: it reproduces in a control arm with no disconnect, and the server log has
  no unpaired close.
- This ranks lower because the unique close is in the window, but the same loop rules it
  in or out cheaply.

**What triggered the close is a separate unknown.** The plan instruments for it rather
than guessing. Candidates:

- a window `offline` event. `connectivityLayer` listens to `online` and `offline`
  (`apps/web/src/connection/platform.ts:85-100`), and `NetworkChanged offline` makes
  `monitorConnectedLease` return (`supervisor.ts:557-561`). The run loop then waits
  offline until `online` arrives.
- an `application-active` probe hitting the 15 s timeout (`supervisor.ts:568-610`).
  Unlikely, since it needs 15 s of silence on a loopback socket.
- a registry lease release (`packages/client-runtime/src/connection/registry.ts:332,353,1010`).
- `RetryRequested` or `DisconnectRequested` from the UI.

## Diagnosis loop (phase 2, step 1; approved with corrections)

Setup:
- Disk: 185 GiB free at the start of phase 2.
- Packaged arm64 `.app` built with an isolated bundle identifier,
  `com.bibcode.desktop.e2e.b3f`, using `tauri build ... --bundles app`
  (`docs/testing/macos-desktop.md:491-495`), and copied with `ditto` into an install
  folder in the scratchpad.
- `BIBCODE_E2E_WEBDRIVER_PORT=4471`, checked free with
  `lsof -nP -iTCP:4471 -sTCP:LISTEN` before each run.

**Recorder.** One page task installs it and *returns before any typing*, so a waiting page
task can never overlap the WebDriver typing it is meant to observe. It records, each with
a `performance.now()` timestamp:

- DOM mutations on the visible composer editor (`characterData`, `childList`, and the
  `contenteditable` attribute), with the resulting `textContent`;
- `beforeinput` and `input` events on the editor. These are what reach Lexical's change
  path (`handleEditorChange`, `ComposerPromptEditor.tsx:1997`), whose `onChange` feeds
  ChatComposer's `setPrompt` (`ChatComposer.tsx:1590-1591`);
- the persisted draft: on every recorded mutation it reads the thread's
  `bibcode:composer-drafts:v1` entry;
- a connection phase proxy, taken from the placeholder "is not connected", the composer
  banner, and the Send button's `disabled`;
- window `online`/`offline`/`focus`/`blur`/`visibilitychange` events;
- every `WebSocket.prototype.close` call with its code and a stack trace, and each new
  socket. This shows which client path initiated a close.

After the run, a second page task reads the log back.

Arms:

- (a) **Offline before typing:** dispatch `offline`, WebDriver `addValue("@README")`,
  dispatch `online`, then wait until Send can send again.
- (b) **Typing through the transition:** a page `setTimeout` dispatches `offline` partway
  through a WebDriver `addValue` of a longer string, then `online` about 1.5 s later.
- (c) **Offline after typing:** type, then dispatch `offline` and `online`. This tests
  H2: are typed text and the stored draft wiped on reconnect?
- (d) **H3 control, no disconnect:** the real spec's sequence. Send `$refactor`, and as
  soon as the provider log has it, type "@README", so the typing overlaps the fixture's
  finishing turn update. The recorder shows the timeline row mutation next to the editor
  mutations to prove the overlap.

Each arm also checks the server log for unpaired `client-closed` records.

**Trigger loop (stochastic, second).** Run the real spec repeatedly under CPU load with
the recorder installed, and count unpaired closes. If it never fails in N runs, that is
reported as the trigger not reproducing in N runs.

## Deterministic loop result (2026-10-27, macOS arm64, packaged)

The spec is `apps/desktop/e2e/specs/manual/composer-connection-drop.e2e.ts`, run with
the loop script in the scratchpad. It ran 9 iterations per arm (the 10th stopped on a
WebDriver script timeout in setup), each against a fresh fixture project. Results:

| Arm | Result | What the recorder shows |
| --- | --- | --- |
| a. `offline`, then type with `addValue` | **lost 9/9**, final `""` | `contenteditable` flips to `false` 8-15 ms after the event. `addValue` returns without error and fires no `beforeinput`; the stored draft stays empty. |
| b. type one key at a time, `offline` after key 3 | **9/9 final `"@RE"`** | Keys before the drop stay; every key after it is dropped silently, with `insertText` doing nothing. |
| c. type, then `offline`, then `online` | **kept 9/9** | Text and stored draft survive the read-only period and the reconnect. |
| e. type, then close the socket from the page (backoff, then reconnect) | **kept 9/9** | Same as c. The editor is read-only from the close until the new socket opens (about 1 s). |
| d. no drop: send `$refactor`, then type "@README" as soon as the provider log has it | **kept 9/9** | On arm64 the fixture's finishing update (timeline rows) lands before the provider-log entry, so the typing did not overlap it. |

Conclusions:

- **H1 is confirmed as a mechanism.** In every phase but `connected` (including
  `reconnecting`/backoff and `offline`), typing is silently discarded: no error, no
  input event, nothing stored. Typing before the drop is kept.
- **H2 is refuted** for offline and socket-close reconnects (arms c and e): nothing is
  wiped on reconnect.
- **H3 is not reproduced, but not excluded:** in arm d the typing never overlapped the
  turn update on arm64.
- **The server-side signature matches CI.** Both the `offline` path (the app's own
  `close(1000)` from Effect's scope release, `ws:close-called` stack via
  `interruptUnsafe`) and a page-initiated close produce DEBUG `client-closed` with no
  page load, the same as CI at 00:27:06.44. So the CI failure is consistent with "a
  client-side drop at typing time, keys dropped while read-only". Which code path
  dropped the connection on the runner is still unknown.
- **A harness gap found on the way:** with a non-default `BIBCODE_E2E_WEBDRIVER_PORT`,
  `browser.tauri.mock` fails with `fetch failed`. Its direct-eval client reads
  `TAURI_WEBDRIVER_PORT` (default 4445), so both must be set. This is undocumented.

## Design note: composer input while the environment is not connected (for approval)

**Goal.** Nothing a person types, pastes or inserts is ever discarded silently because
the connection is not `connected`. Anything that needs the server stays blocked, and
says why.

**Input paths.** Keep these working in every phase, for an existing thread or draft:

- editor typing and paste: `disabled` at `ChatComposer.tsx:2755-2760` no longer includes
  `environmentUnavailable`;
- type-to-focus `insertTextAtEnd` (`ChatComposer.tsx` around 2165);
- chip insertion from already-loaded menu items.

The draft is local (composer draft store, persisted), so typing cannot reach the server
until Send. Paths that stage data on the server stay blocked and explain why in their
tooltip:

- attaching or pasting files, which use upload staging;
- answering pending approvals and user-input prompts.

**Send paths.** All of them stay blocked while the environment is not connected, and
each states the reason:

- the primary Send button (`ComposerPrimaryActions`);
- the collapsed mobile Send (`ChatComposer.tsx` around 1270), which also gains
  `environmentUnavailable`, since today it is missing;
- Enter or ⌘Enter through ChatView `onSend` (around 4972). That refusal is silent today;
  it should show the same reason inline (the composer banner already exists) and must
  never clear the draft.

Nothing is queued to send automatically on reconnect: after a long outage, an automatic
send would be a surprise.

**Behaviour per phase** (presentation phases; the supervisor state is in brackets):

| Phase | Editor | Send | Reason shown |
| --- | --- | --- | --- |
| `connecting` [connecting] | editable | blocked | "Connecting to X… your message is kept" |
| `reconnecting` [backoff], including long remote retries | editable | blocked | the existing reconnecting text and banner with Reconnect |
| `offline` [offline, `supervisor.ts` around 779] | editable | blocked | "You are offline", from `connectionPhaseMessage` |
| `available` [explicit disconnect, desired=false] | editable | blocked | "X is disconnected" plus the banner's Reconnect |
| `error` [blocked identity, auth or storage change] | editable | blocked | the blocked reason plus the banner's existing action |

The placeholder stays as the empty-state hint, and the banner carries the reason.
Provider-binding conflict and approval states keep their current read-only behaviour,
since they are not about the connection.

**Not in this change.** Whether a loopback desktop-local connection should tear down on a
window `offline` event is supervisor policy. I would change it only with evidence that
it was the trigger.

**Proof.**

- A packaged spec case types *through* an `offline` transition and a page socket-close
  (remote-retry style) case. It asserts:
  - every key is in the DOM and in the stored draft;
  - Send is disabled and explains itself;
  - the text survives the reconnect;
  - a later Send delivers exactly one provider input.
- Component tests for each changed path.
- Docs: `docs/architecture/connection-runtime.md` (around 49) and the
  composer-native-triggers runbook paragraph.
- macOS x64 stays unverified unless it can be run.

## Planned changes (after the loop reports)

**Spec (owned):**
- Do **not** add an unconditional editable wait. Keep a regression assertion that types
  *through* the transition (arm b as a spec case if a product fix lands).
- On a `waitForComposerValue` timeout, write a diagnostics JSON: the recorder log,
  editor editable state and text, `activeElement`, placeholder or banner, `location.hash`,
  and the persisted draft.
- Rewrite the shared `sendCurrentComposerPrompt` comment (around line 692) for both
  cases: a server thread's route does not change, so the wait passes at once; a new
  chat's draft route gives way to the thread. Attribute the "@README" loss to a close
  only if the loop proves it.

**Product (only if the loop proves H1 or H2): send a design note to the coordinator
before implementing.** The note covers:

- every input and Send path: the editor's `disabled` (`ChatComposer.tsx:2755-2760`),
  type-to-focus `insertTextAtEnd` (around 2165), the collapsed mobile Send (around 1270),
  and ChatView's silent `onSend` refusal (around 4972), which must explain itself under
  UI.md;
- behaviour per phase: offline (`supervisor.ts` around 779), backoff or reconnecting
  (including prolonged remote retries), explicit disconnect, and blocked
  identity/auth.

**Grants:**
- ChatView composer-disable wiring (around 1708-1721 and around 4972), not follow/scroll
  code.
- `packages/client-runtime/src/connection/supervisor.ts`.

**Docs if editor availability changes:**
- `docs/architecture/connection-runtime.md` (around 49);
- the composer-native-triggers paragraph in `docs/testing/cross-platform-validation.md`;
- `docs/testing/macos-desktop.md` if commands change.

## Proof

- **Loop results:** recorder logs for each arm are kept in the scratchpad and summarized
  in the report.
- **Full caller for any product fix:** a packaged spec injects a drop while the real
  composer types. It asserts the DOM text, the stored draft, a disabled Send that
  explains itself, the text surviving the reconnect, and exactly one later provider
  delivery. It includes an offline arm and a remote-retry case, plus web component tests
  for each changed path.
- **macOS x64 is unverified** unless it can be run; this Mac is arm64.
- **Gates:** `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`, and
  `vp test run scripts/bibcode-identity.test.ts`.

## Skipped

- Webview console log collection in the harness.
- Re-running the CI matrix (no pushes from this batch).

## Outcome (phase 2, approved design)

- **Mechanism fixed; the Intel trigger is still unidentified.** A connection phase no
  longer makes the composer read-only.
- **Every server-bound path refuses and names the banner's state:** Send, the
  collapsed mobile Send, Enter, approvals, question answers and the timed advance.
- **The draft, the question and its answers stay.** A refused mobile send keeps focus.
  Nothing is sent on reconnect, and an in-flight send that fails restores through
  `restoreOutgoing`.
- **Packaged proof:** the third case of `composer-native-triggers` types through an
  offline event and through a lost socket. It passed 2/2 on macOS arm64, and
  `composer-message-queue` passed 1/1.
- **Not verified:**
  - macOS x64: no x64 runner here.
  - The collapsed mobile composer inside the packaged app: the window is at least
    960 px wide, so component tests cover it.
- **Skipped as instructed:** the CPU-load trigger loop.
