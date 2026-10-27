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
  `transport.rs:250-289` logs DEBUG only when `is_abnormal()` is false. So the client
  closed the socket in an orderly way (code none, 1000 or 1001). That rules out the
  client liveness timeout (4408, logged as `client-liveness-timeout`) and any
  server-initiated end.
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

**H1: a reconnect makes the editor read-only and the keystrokes are dropped.** The close
at 00:27:06.44 flips the phase, `setEditable(false)` lands while `addValue` is typing,
and nothing reaches the editor.
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

## Diagnosis loop (phase 2, step 1)

Setup:
- Disk: `df -h /System/Volumes/Data` showed 203 GiB free, above the 60 GB floor; check
  again before building.
- Build `vp run test:ui:desktop:build` in the background, then install an isolated copy
  per `docs/testing/macos-desktop.md:225-250`.
- Use a unique `BIBCODE_E2E_WEBDRIVER_PORT=4471`. Before each run, check that
  `lsof -nP -iTCP:4471 -sTCP:LISTEN` prints nothing.
- Keep all loop artifacts in the session scratchpad.

1. **Mechanism loop (deterministic; settles H1, H2 and H3).** A scratch spec under
   `apps/desktop/e2e/specs/manual/`, which the batch deletes or keeps as a manual spec.
   It opens the primary Codex thread, sends once, then in one page task records
   `{t, contentEditable, textContent, activeElement === editor, placeholder}` on every
   animation frame for about 5 s. Three arms, 10 runs each:
   - (a) dispatch `offline`, type "@README" with `execCommand("insertText")` and with
     WebDriver `addValue`, then dispatch `online`;
   - (b) type first, then dispatch `offline` and `online`;
   - (c) no injection (the H3 control).

   In arm (a), the server log must show an unpaired `client-closed`, which confirms the
   synthetic trigger matches the CI signature.
2. **Trigger loop (stochastic).** Run the real `composer-native-triggers` spec 20-50
   times under CPU load (`yes > /dev/null &` once per core, killed afterwards; macOS has
   no `timeout` or `cpulimit`). A recorder installed at spec start (see the changes
   below) logs `online`/`offline` events, `visibilitychange`, and editor editable or
   placeholder changes. After each run, grep `app-server.log` for unpaired closes.
   - If it never fails in N runs, report that as "the trigger does not reproduce in N
     runs", which #199 accepts as long as loop 1 has settled the mechanism.

## Planned changes (after the loop reports)

**Test hardening (owned, done whatever the loop shows):**
- `setComposerValue` (`composer-native-triggers.e2e.ts:250-285`) waits until the visible
  editor is editable (`contentEditable === "true"`) before typing.
- When `waitForComposerValue` times out, it writes a diagnostics JSON to
  `BIBCODE_E2E_ARTIFACT_DIR`, in the same style as `openProviderPanel`'s failure dump
  (lines 397-430). The dump holds the editor's editable state and text,
  `activeElement`, the placeholder or banner text, `location.hash`, the matching
  `bibcode:composer-drafts:v1` entry, and the recorder's connectivity, visibility and
  editable events.
- This makes the next CI occurrence diagnosable even if the trigger stays unknown.

**Spec comment (owned; acceptance item 2):** rewrite the `sendCurrentComposerPrompt`
comment (lines 692-694) so it states that the primary-workspace chat is already a server
thread, so the draft-route wait does nothing there, and that the "@README" loss was a
connection drop (or whatever the loop proves).

**Product fix (only if loop 1 proves H1 or H2):**
- Keep the editor editable during transient phases and gate only Send. This is
  `ChatComposer.tsx:2755-2760` (composer code, which I may change for a proven cause).
- Which phases count as transient (`connecting`, `reconnecting`, `backoff`) is decided
  by client-runtime presentation semantics. I do not own those, so I report rather than
  edit them.
- The change alters what a user sees while an environment is unavailable. UI.md says to
  preserve user work, but the current "X is not connected" read-only state is
  deliberate. Under AGENTS.md this needs a short design note approved before
  implementation, so I will bring the loop results and a proposal back rather than ship
  it unasked.
- If the trigger proves to be an `offline` event tearing down a loopback desktop-local
  connection, that is supervisor or connectivity policy in client-runtime. I report it to
  its owner and do not fix it here.
- If the cause is in ChatView follow/scroll code, I report it to that agent.

## Files

- `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts`: readiness wait, failure
  diagnostics, recorder, comment.
- A support helper if the diagnostics are shared, for example
  `apps/desktop/e2e/support/ui-state.ts` or a new `composer-diagnostics.ts` with a unit
  test.
- Conditional: `apps/web/src/components/chat/ChatComposer.tsx` plus its tests, only
  after the design note is approved.
- Docs: the `docs/testing/cross-platform-validation.md` composer-native-triggers
  paragraph (around line 600) to describe the editable-wait and diagnostics files, and
  `docs/testing/flaky-tests.md` if it tracks this flake.

## Proof

- A focused unit test for any new support helper:
  `vp test run apps/desktop/e2e/support/<helper>.test.ts`.
- The complete caller: the packaged `composer-native-triggers` spec passes locally on
  macOS arm64 with the hardening, and loop 1 arm (a) shows the new diagnostics capture an
  injected drop.
- If the product fix lands: a ChatComposer component test showing that a
  `reconnecting` phase leaves the editor editable and Send disabled, run with
  `vp test run --project unit` from `apps/web`.
- Repository gates: `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`,
  and `vp test run scripts/bibcode-identity.test.ts`.

## Skipped

- Changing supervisor or connectivity behaviour (not owned).
- Collecting webview console logs in the packaged harness (a broader harness change, not
  needed to make this failure diagnosable).
- Re-running the six-platform CI matrix (no pushes from this batch).
