# Agent Activity Dormant Observers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace terminal activity disconnect-and-reconstruct behavior with a generation- and epoch-fenced minimal dormant observer for Claude, Codex, and OpenCode.

**Architecture:** `TerminalAgentActivityControl` becomes the shared, allocation-free generation fence for provider-terminal activity. Already-instrumented provider observers retain and drain only their authenticated transport while disabled, then establish a provider-specific live boundary before acknowledging the new generation; Claude uses request admission, Codex uses an ordered `account/read` JSON-RPC barrier, and OpenCode uses a replacement SSE connection confirmed by `server.connected`. Provider history is never queried to reconstruct the disabled interval.

**Tech Stack:** Rust, Tokio, Axum, reqwest, WebSocket JSON-RPC, Server-Sent Events, SQLite/rusqlite, tracing, Cargo test, Tauri 2.

## Global Constraints

- The setting remains named `enableAgentActivity`, scoped per environment/server, and enabled by default.
- Disabling must not stop or corrupt the underlying provider chat or terminal.
- Existing activity history is retained; disabled-period events are neither buffered nor backfilled.
- Claude, Codex, and OpenCode are in scope. Cursor and Grok are not.
- A terminal launched while disabled creates no observer, helper, hook, or provider activity connection and must be reopened after enabling.
- An already-instrumented terminal may retain one minimal authenticated transport; OpenCode may temporarily own two SSE streams only during enable handoff.
- Dormant traffic may perform bounded transport framing and authentication only. It may not decode provider activity, mutate trackers, reconcile history, access the activity repository, publish, buffer event bodies, or log per event.
- Controller generations fence environment transitions; observer epochs fence provider connection instances.
- A provider reports `observed=true` only after its current generation and epoch have crossed the provider-specific live boundary.
- A failed boundary leaves that observer unavailable and must not reopen activity admission.
- Activity transition logs remain bounded and transition-only, with no prompts, output, transcripts, commands, credentials, or provider payloads.
- `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` must remain unset during tests and UI verification.
- Use test-driven development for every behavioral change.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Responsibility Map

### Shared lifecycle

- `apps/server/src/provider_terminal/model.rs` — terminal activity state, generation admission, observation kind, epoch-aware acknowledgement, provider epoch aggregates, and focused concurrency tests.
- `apps/server/src/provider_terminal/mod.rs` — crate-private lifecycle exports and public transition/fixture exports.
- `apps/server/src/terminal/manager.rs` — aggregate exact provider transition results without treating dormant transports as activity stream registrations.
- `apps/server/src/production/agent_activity.rs` — add bounded unavailable counts and fixed Claude/Codex/OpenCode epoch fields to effective-state trace records.

### Claude adapter

- `apps/server/src/provider_terminal/claude.rs` — retain the authenticated listener, capture an admission before reading a hook, reject stale queued requests, and acknowledge listener readiness.
- `apps/server/tests/provider_terminal_supervisor.rs` — prove dormant malformed bodies are not decoded and pre-disable admitted bodies cannot publish after re-enable.

### Codex adapter

- `apps/server/src/provider_terminal/codex.rs` — retain one initialized WebSocket/client/tracker owner, discard notifications while dormant, perform an ordered `account/read` boundary, reset volatile tracker state, and recover transport without history reconstruction.
- `apps/server/tests/provider_terminal_supervisor.rs` — replace reconstruction-oriented toggle cases with retained-connection, barrier-order, stale-epoch, failure, and recovery coverage.

### OpenCode adapter

- `apps/server/src/provider/opencode/sse.rs` — expose bounded SSE data frames separately from JSON decoding while preserving the existing decoded-event API.
- `apps/server/src/provider_terminal/opencode.rs` — split unary REST ownership from event-stream ownership, drain raw SSE data while dormant, and perform a `server.connected` replacement-stream handoff.
- `apps/server/tests/provider_terminal_supervisor.rs` — replace reconciliation-oriented toggle coverage with raw-drain, connection-handoff, epoch, and failure tests.

### Resource and production evidence

- `apps/server/tests/activity_load.rs` — prove dormant transports do not register activity streams or create database/projection/log work.
- `apps/server/src/production/agent_activity.rs` — focused trace serialization tests for provider epochs and unavailable counts.
- `apps/server/tests/production_server_terminal_rpc.rs` — black-box effective transition trace coverage.

---

### Task 1: Add the Shared Generation and Observation-Epoch Fence

**Files:**
- Modify: `apps/server/src/provider_terminal/model.rs:917-1088`
- Modify: `apps/server/src/provider_terminal/mod.rs:1-35`
- Modify: `apps/server/src/terminal/manager.rs:1090-1110`

**Interfaces:**
- Produces:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalAgentActivityState {
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalAgentActivityObservationKind {
    Live,
    Dormant,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalAgentActivityObservation {
    pub(crate) state: TerminalAgentActivityState,
    pub(crate) epoch: u64,
    pub(crate) kind: TerminalAgentActivityObservationKind,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TerminalAgentActivityAdmission {
    state: TerminalAgentActivityState,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalAgentActivityProviderEpochs {
    pub claude: u64,
    pub codex: u64,
    pub opencode: u64,
}
```

- Changes `TerminalAgentActivityControl::subscribe()` to return
  `watch::Receiver<TerminalAgentActivityState>`.
- Produces:

```rust
impl TerminalAgentActivityControl {
    pub(crate) fn snapshot(&self) -> TerminalAgentActivityState;
    pub(crate) fn admit(&self) -> Option<TerminalAgentActivityAdmission>;
    pub(crate) fn admission_is_current(
        &self,
        admission: &TerminalAgentActivityAdmission,
    ) -> bool;
    pub(crate) fn transition_state(
        &self,
        enabled: bool,
    ) -> (TerminalAgentActivityState, TerminalAgentActivityTransition);
    pub(crate) fn mark_observed(
        &self,
        observation: TerminalAgentActivityObservation,
    ) -> bool;
    pub(crate) async fn transition_observed(
        &self,
        enabled: bool,
        enable_ack_timeout: Duration,
    ) -> TerminalAgentActivityTransition;
}
```

- Extends `TerminalAgentActivityTransition` with:

```rust
pub unavailable: usize,
pub epochs: TerminalAgentActivityProviderEpochs,
```

- `merge()` saturating-adds counts and takes the maximum of each fixed provider
  epoch.

- [ ] **Step 1: Write failing generation, admission, and acknowledgement tests**

Add focused tests to `apps/server/src/provider_terminal/model.rs`:

```rust
#[tokio::test]
async fn terminal_activity_control_rejects_stale_admission_and_observation() {
    let control = TerminalAgentActivityControl::enabled();
    let admission = control.admit().expect("initial live admission");
    let (dormant, _) = control.transition_state(false);

    assert!(!control.admission_is_current(&admission));
    assert!(control.mark_observed(TerminalAgentActivityObservation {
        state: dormant,
        epoch: 7,
        kind: TerminalAgentActivityObservationKind::Dormant,
    }));

    let (live, _) = control.transition_state(true);
    assert_ne!(live.generation, dormant.generation);
    assert!(!control.mark_observed(TerminalAgentActivityObservation {
        state: dormant,
        epoch: 8,
        kind: TerminalAgentActivityObservationKind::Live,
    }));
    assert!(control.mark_observed(TerminalAgentActivityObservation {
        state: live,
        epoch: 9,
        kind: TerminalAgentActivityObservationKind::Live,
    }));
}

#[tokio::test]
async fn unavailable_acknowledgement_fails_the_exact_enable_generation() {
    let control = Arc::new(TerminalAgentActivityControl::enabled());
    let mut changes = control.subscribe();
    let disabled = control.clone();
    let disable = tokio::spawn(async move {
        disabled
            .transition_observed(false, Duration::from_millis(100))
            .await
    });
    let dormant = *changes.wait_for(|state| !state.enabled).await
        .expect("dormant state");
    control.mark_observed(TerminalAgentActivityObservation {
        state: dormant,
        epoch: 3,
        kind: TerminalAgentActivityObservationKind::Dormant,
    });
    assert_eq!(disable.await.expect("disable").failed, 0);

    let enabled = control.clone();
    let enable = tokio::spawn(async move {
        enabled
            .transition_observed(true, Duration::from_millis(100))
            .await
    });
    let live = *changes.wait_for(|state| state.enabled).await
        .expect("live state");
    control.mark_observed(TerminalAgentActivityObservation {
        state: live,
        epoch: 4,
        kind: TerminalAgentActivityObservationKind::Unavailable,
    });
    let report = enable.await.expect("enable");
    assert_eq!((report.resumed, report.failed, report.unavailable), (0, 1, 1));
    assert_eq!(control.snapshot(), live, "failed enable remains requested");
}
```

Also add a merge test proving counts saturate and
`epochs.{claude,codex,opencode}` use `max`.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
cargo test -p bibcode-server provider_terminal::model::tests::terminal_activity_control -- --nocapture
cargo test -p bibcode-server provider_terminal::model::tests::unavailable_acknowledgement -- --nocapture
```

Expected: compilation fails because the state, admission, observation, and epoch
interfaces do not exist.

- [ ] **Step 3: Implement the packed generation state and exact observation acknowledgement**

Replace the boolean atomic/watch payload with a packed `AtomicU64` state. Use
bit 0 for enabled and the remaining bits for generation:

```rust
const TERMINAL_ACTIVITY_ENABLED_BIT: u64 = 1;

fn pack_terminal_activity_state(state: TerminalAgentActivityState) -> u64 {
    (state.generation << 1) | u64::from(state.enabled)
}

fn unpack_terminal_activity_state(value: u64) -> TerminalAgentActivityState {
    TerminalAgentActivityState {
        enabled: value & TERMINAL_ACTIVITY_ENABLED_BIT != 0,
        generation: value >> 1,
    }
}

fn next_terminal_activity_generation(generation: u64) -> u64 {
    generation.wrapping_add(1) & (u64::MAX >> 1)
}
```

Implement `transition_state` with a compare-exchange loop. Advance generation
only when the desired boolean differs, publish the exact state through the
watch sender, and preserve the existing stopped/dormant/resumed count
semantics. Publish an explicit repeated request even when the boolean is
unchanged so an unavailable observer can retry its boundary without inventing
a new generation.

Implement admission with snapshot/recheck:

```rust
pub(crate) fn admit(&self) -> Option<TerminalAgentActivityAdmission> {
    let state = self.snapshot();
    if !state.enabled {
        return None;
    }
    let admission = TerminalAgentActivityAdmission { state };
    self.admission_is_current(&admission).then_some(admission)
}

pub(crate) fn admission_is_current(
    &self,
    admission: &TerminalAgentActivityAdmission,
) -> bool {
    admission.state.enabled && self.snapshot() == admission.state
}
```

`mark_observed` must compare `observation.state` with `snapshot()` before
publishing it. `wait_until_observed` must match the exact state and return
`Live`/`Dormant` success or `Unavailable` failure; it must never accept an
acknowledgement from an older generation. Unlike the old boolean
implementation, an enable timeout or unavailable acknowledgement must not
transition the desired state back to disabled. Return a failed/unavailable
report while leaving the requested enabled generation authoritative.

- [ ] **Step 4: Update transition aggregation without registering dormant transports as streams**

Keep `TerminalManager::set_agent_activity_enabled` sequential and bounded.
Update only its transition merge contract; do not create an
`AgentActivityStreamRegistration` for a dormant observer:

```rust
for observer in observers {
    let provider_transition = observer.set_agent_activity_enabled(enabled).await;
    transition.merge(provider_transition);
}
```

Confirm `TerminalAgentActivityTransition::merge` uses `saturating_add` for
counts and `max` for each provider epoch.

- [ ] **Step 5: Export the shared lifecycle types at the existing module boundary**

Keep state/admission/observation types crate-private and expose the aggregate
epoch type with the already-public transition:

```rust
pub(crate) use model::{
    TerminalAgentActivityAdmission, TerminalAgentActivityControl,
    TerminalAgentActivityObservation, TerminalAgentActivityObservationKind,
    TerminalAgentActivityState,
};

pub use model::{
    PreparedTerminalLaunch, PreparedTerminalObserver, TerminalAgentActivityProviderEpochs,
    TerminalAgentActivityTransition,
    // Preserve the remaining existing exports.
};
```

- [ ] **Step 6: Run shared lifecycle tests**

Run:

```bash
cargo test -p bibcode-server provider_terminal::model::tests -- --nocapture
cargo test -p bibcode-server terminal::manager::tests::agent_activity -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit the shared fence**

```bash
git add apps/server/src/provider_terminal/model.rs apps/server/src/provider_terminal/mod.rs apps/server/src/terminal/manager.rs
git commit -m "refactor(activity): fence terminal observer generations"
```

---

### Task 2: Make Claude Hook Admission Generation-Safe

**Files:**
- Modify: `apps/server/src/provider_terminal/claude.rs:510-610`
- Modify: `apps/server/src/provider_terminal/claude.rs:690-1045`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs:9520-9700`

**Interfaces:**
- Consumes: `TerminalAgentActivityAdmission`,
  `TerminalAgentActivityObservation`, and
  `TerminalAgentActivityObservationKind` from Task 1.
- Adds to `ClaudeHookRequest`:

```rust
admission: TerminalAgentActivityAdmission,
```

- Adds to `ClaudeObserverInner`:

```rust
listener_ready: AtomicBool,
observation_epoch: AtomicU64,
```

- [ ] **Step 1: Add a failing delayed-body generation-race test**

Extend
`agent_activity_toggle_claude_hook_is_dormant_without_stopping_terminal` or add
`agent_activity_toggle_claude_rejects_pre_disable_admission_after_reenable`.
Start an authenticated request whose body sends its first chunk and waits on a
oneshot before completing:

```rust
let old_hook = serde_json::to_vec(&correlated_claude_root_hook(&fixture, &root))
    .expect("old-generation hook JSON");
let split = old_hook.len() / 2;
let first = bytes::Bytes::from(old_hook[..split].to_vec());
let second = bytes::Bytes::from(old_hook[split..].to_vec());
let (first_chunk_sent, first_chunk_seen) = tokio::sync::oneshot::channel::<()>();
let (release_body, released_body) = tokio::sync::oneshot::channel::<()>();
let body = reqwest::Body::wrap_stream(
    futures_util::stream::once(async move {
        let _ = first_chunk_sent.send(());
        Ok::<_, std::io::Error>(first)
    })
    .chain(futures_util::stream::once(async move {
        let _ = released_body.await;
        Ok::<_, std::io::Error>(second)
    })),
);
let request = tokio::spawn(
    reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(&token)
        .header("X-BiBCode-Launch-Correlation", &correlation)
        .header("content-type", "application/json")
        .body(body)
        .send(),
);

first_chunk_seen.await.expect("first body chunk sent");
tokio::time::sleep(Duration::from_millis(25)).await;
manager.set_agent_activity_enabled(false).await;
manager.set_agent_activity_enabled(true).await;
release_body.send(()).expect("release old-generation body");
assert_eq!(
    request.await.expect("request task").expect("hook response").status(),
    reqwest::StatusCode::NO_CONTENT,
);
assert!(
    projection.snapshot(&scope).await.is_err(),
    "an old-generation hook body must not create activity after re-enable",
);
```

Keep the existing malformed dormant body assertion proving the body is not
decoded while disabled.

- [ ] **Step 2: Run the Claude toggle test and verify red**

Run:

```bash
unset BIBCODE_CLAUDE_KEYCHAIN_ACCESS
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_claude -- --nocapture
```

Expected: the delayed pre-disable body can be processed in the new enabled
generation because requests do not carry terminal admission.

- [ ] **Step 3: Capture and revalidate hook admission**

In `capture_claude_hook`, authenticate first, then obtain admission before
content-type/body work:

```rust
let Some(admission) = state.activity.admit() else {
    return StatusCode::NO_CONTENT;
};
```

After the bounded body decode and immediately before queueing, reject a stale
admission with `NO_CONTENT`. Include the admission in `ClaudeHookRequest`.

At the beginning of `process_claude_hook`, and again immediately before every
publisher call or tracker commit, enforce:

```rust
if !inner.activity.admission_is_current(&admission) {
    return StatusCode::NO_CONTENT;
}
```

Do not install the staged tracker or retain active actors/work when the
publisher call loses admission.

- [ ] **Step 4: Acknowledge the listener epoch without adding a hook hot-path log**

After `TcpListener::from_std` succeeds, set `listener_ready=true`, increment
`observation_epoch`, and publish `Live` or `Dormant` for the current state.
Before server cleanup, set readiness false and publish `Unavailable` for the
current state.

In `set_agent_activity_enabled`, call `transition_state`, then synchronously
acknowledge:

```rust
let kind = if self.inner.listener_ready.load(Ordering::Acquire) {
    if state.enabled {
        TerminalAgentActivityObservationKind::Live
    } else {
        TerminalAgentActivityObservationKind::Dormant
    }
} else {
    TerminalAgentActivityObservationKind::Unavailable
};
let epoch = self.inner.observation_epoch.load(Ordering::Acquire);
self.inner.activity.mark_observed(TerminalAgentActivityObservation {
    state,
    epoch,
    kind,
});
transition.epochs.claude = epoch;
if kind == TerminalAgentActivityObservationKind::Unavailable {
    transition.failed = transition.failed.saturating_add(1);
    transition.unavailable = transition.unavailable.saturating_add(1);
}
```

Do not add logs to `capture_claude_hook` or `process_claude_hook`.

- [ ] **Step 5: Run Claude unit and integration tests**

Run:

```bash
unset BIBCODE_CLAUDE_KEYCHAIN_ACCESS
cargo test -p bibcode-server provider_terminal::claude::tests -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_claude -- --nocapture
```

Expected: PASS, with the terminal process still alive through both transitions.

- [ ] **Step 6: Commit the Claude adapter**

```bash
git add apps/server/src/provider_terminal/claude.rs apps/server/tests/provider_terminal_supervisor.rs
git commit -m "fix(activity): fence dormant Claude hooks"
```

---

### Task 3: Retain and Drain the Codex WebSocket with an Ordered Barrier

**Files:**
- Modify: `apps/server/src/provider_terminal/codex.rs:350-390`
- Modify: `apps/server/src/provider_terminal/codex.rs:600-1125`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs:4078-4405`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs:4540-6060`

**Interfaces:**
- Consumes Task 1 state/observation types.
- Adds:

```rust
const CODEX_ACTIVITY_ENABLE_BARRIER_METHOD: &str = "account/read";

async fn cross_codex_enable_barrier(
    client: &mut dyn CodexRemoteClient,
    generation: &TerminalObserverGeneration,
    deadline: tokio::time::Instant,
) -> bool;
```

- The barrier request is exactly:

```rust
client.request(
    CODEX_ACTIVITY_ENABLE_BARRIER_METHOD,
    json!({"refreshToken": false}),
)
```

- `thread/resume` remains permitted only for initial attachment or transport
  reattachment. Its response is ignored during recovery and is never decoded
  into activity.
- `thread/list`, `thread/read`, retained baselines, and detail reconciliation
  are forbidden during disable/re-enable.

- [ ] **Step 1: Replace reconstruction-oriented tests with failing retained-transport tests**

Remove or rewrite the toggle-only tests whose expected behavior is an
authoritative history baseline:

- `agent_activity_toggle_codex_request_buffered_notifications_remain_baseline_traffic`
- `agent_activity_toggle_codex_requires_authoritative_bounded_baseline_then_recovers`
- the toggle-specific reconstruction portions of
  `agent_activity_toggle_codex_reenable_keeps_post_ack_same_transport_notifications_live`

Add
`agent_activity_toggle_codex_retains_connection_and_crosses_ordered_barrier`:

```rust
let history_calls_before = count_codex_history_calls(&remote_state);
let connections_before = remote_state.endpoints.lock().expect("endpoints").len();

let disabled = manager.set_agent_activity_enabled(false).await;
assert_eq!((disabled.stopped, disabled.dormant), (1, 1));

remote_state.events.lock().expect("events").push_back(disabled_notification());
remote_state
    .request_events
    .lock()
    .expect("request events")
    .entry("account/read".to_owned())
    .or_default()
    .push_back(vec![pre_barrier_notification()]);

let enabled = manager.set_agent_activity_enabled(true).await;
assert_eq!((enabled.resumed, enabled.failed), (1, 0));
assert_eq!(
    remote_state.endpoints.lock().expect("endpoints").len(),
    connections_before,
    "healthy enable reuses the retained WebSocket",
);
assert_eq!(count_codex_history_calls(&remote_state), history_calls_before);

remote_state.events.lock().expect("events").push_back(post_barrier_notification());
assert_activity_contains_only(&projection, &scope, "post-barrier-detail").await;
```

`count_codex_history_calls` counts `thread/list`, `thread/read`, and
`thread/backgroundTerminals/list` writes after the initial live observation.
Assert disabled and pre-barrier details never appear.

Add
`agent_activity_toggle_codex_barrier_failure_stays_dormant_then_recovers`:
inject an `account/read` error/timeout, assert `(resumed, failed, unavailable) ==
(0, 1, 1)`, assert the PTY/helper remain alive, then provide a successful
barrier and assert the observer's bounded enabled-state retry eventually marks
the same generation live.

Add a stale-epoch fixture case where an old connection's delayed barrier
response arrives after replacement; assert it cannot mark the new epoch live.

- [ ] **Step 2: Run the new Codex tests and verify red**

Run:

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_codex -- --nocapture
```

Expected: retained-connection assertions fail because the current observer
drops its inner future while dormant and reconnects/reconciles on enable.

- [ ] **Step 3: Keep one observer owner across activity transitions**

Refactor `run_codex_observer` so initial connection, root correlation,
`thread/resume`, initial best-effort reconciliation, client, root ID, tracker,
receive sequence, and observation epoch are created once and then owned by one
long-running select loop.

The loop must prioritize cancellation and activity transitions:

```rust
loop {
    tokio::select! {
        biased;
        _ = generation.cancelled() => break,
        changed = activity.changed() => {
            if changed.is_err() {
                break;
            }
            let desired = *activity.borrow_and_update();
            if desired.enabled {
                // Step 4 boundary; no live processing before success.
            } else {
                inner.activity.mark_observed(TerminalAgentActivityObservation {
                    state: desired,
                    epoch,
                    kind: TerminalAgentActivityObservationKind::Dormant,
                });
            }
        }
        envelope = client.next() => {
            let envelope = match envelope {
                Ok(Some(envelope)) => envelope,
                Ok(None) => continue,
                Err(_) => {
                    // Advance epoch and run bounded transport recovery.
                    continue;
                }
            };
            if !activity.borrow().enabled {
                continue; // transport-level discard only
            }
            // Existing live tracker/output path, fenced by the exact state.
        }
    }
}
```

Remove `successful_observations`, resume-baseline state, retained activity
baseline reads, required baseline policy, and disabled-period
`drain_request_buffered_notifications` activity handling. Keep initial
best-effort reconciliation because it occurs before the terminal first becomes
observed, not during a toggle.

- [ ] **Step 4: Implement the ordered `account/read` live boundary**

When an enabled state arrives:

1. Move logically to enabling; do not mark live.
2. Call `cross_codex_enable_barrier` with the current reattach deadline.
3. Regardless of response content, discard every value returned by
   `drain_request_buffered_notifications()`.
4. On success, replace volatile tracker state with a new
   `CodexActivityTracker::new(Some(&root))`, seed only the root, advance the
   native event-key epoch, and mark the exact state/epoch `Live`.
5. On error/timeout, mark the exact state/epoch `Unavailable` and continue
   draining. While the same generation remains enabled, retry the boundary with
   the existing capped exponential backoff; cancellation or a new activity
   state always wins.

The barrier helper must be cancellation-safe:

```rust
let response = tokio::select! {
    biased;
    _ = generation.cancelled() => return false,
    response = tokio::time::timeout_at(
        deadline,
        client.request(
            CODEX_ACTIVITY_ENABLE_BARRIER_METHOD,
            json!({"refreshToken": false}),
        ),
    ) => response,
};
client.drain_request_buffered_notifications();
matches!(response, Ok(Ok(_)))
```

Never decode the `account/read` response.

- [ ] **Step 5: Recover a failed transport without reconstructing history**

On WebSocket loss:

1. Advance epoch and mark unavailable for the exact controller state.
2. Reconnect and initialize with the existing bounded exponential retry.
3. Reattach to the already-owned root with `thread/resume`, validate only that
   the request succeeds, and discard the response without
   `decode_thread_read_response`.
4. If currently dormant, resume raw draining and mark dormant.
5. If currently enabled, run the `account/read` barrier before resetting the
   tracker and marking live. A failed barrier remains in bounded enabled-state
   recovery without changing the requested controller generation.

Late work carries its captured epoch and must fail the current-epoch check.
Use the epoch in native event keys:

```rust
format!("codex:terminal-observation:{epoch}:live:{receive_sequence}")
```

Set `transition.epochs.codex` to the current epoch and increment
`unavailable/failed` only when the exact enable boundary fails.

- [ ] **Step 6: Run Codex unit, fixture, and topology tests**

Run:

```bash
cargo test -p bibcode-server provider_terminal::codex::tests -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_codex -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor codex_resume -- --nocapture
```

Expected: PASS. Initial attachment/resume tests remain valid; toggle tests show
no history RPC growth and one healthy retained connection.

- [ ] **Step 7: Commit the Codex dormant pump**

```bash
git add apps/server/src/provider_terminal/codex.rs apps/server/tests/provider_terminal_supervisor.rs
git commit -m "fix(activity): retain dormant Codex transport"
```

---

### Task 4: Drain Raw OpenCode SSE and Use a Connected-Stream Handoff

**Files:**
- Modify: `apps/server/src/provider/opencode/sse.rs:1-185`
- Modify: `apps/server/src/provider_terminal/mod.rs:15-24`
- Modify: `apps/server/src/provider_terminal/opencode.rs:350-430`
- Modify: `apps/server/src/provider_terminal/opencode.rs:730-1185`
- Modify: `apps/server/src/provider_terminal/opencode.rs:1715-1972`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs:10485-10830`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs:11503-12090`

**Interfaces:**
- Produces while retaining `OpenCodeSseDecoder::take_event()` for structured
  OpenCode runtime callers:

```rust
impl OpenCodeSseDecoder {
    pub(crate) fn discard_event(&mut self) -> Result<bool, String>;
    pub(crate) fn take_data(&mut self) -> Result<Option<Vec<u8>>, String>;
    pub(crate) fn take_event(&mut self) -> Result<Option<Value>, String>;
}
```

`discard_event()` consumes one complete bounded frame without collecting its
payload into a new `Vec`. `take_event()` calls `take_data()` and then
`serde_json::from_slice`.

- Produces:

```rust
pub trait OpenCodeEventStream: Send {
    fn discard_next(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;

    fn next_data(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + '_>>;
}

pub trait OpenCodeRemoteClient: Send {
    // Existing unary methods remain.
    fn open_event_stream(
        &mut self,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Box<dyn OpenCodeEventStream>, String>>
                + Send
                + '_,
        >,
    >;
}
```

- Removes `subscribe()` and `next_event()` from `OpenCodeRemoteClient`.
- Re-exports `OpenCodeEventStream` beside `OpenCodeRemoteClient` for the
  integration fixture.
- Adds:

```rust
async fn wait_for_opencode_connected(
    stream: &mut dyn OpenCodeEventStream,
    generation: &TerminalObserverGeneration,
    deadline: tokio::time::Instant,
) -> bool;
```

- [ ] **Step 1: Write failing raw-frame decoder tests**

In `apps/server/src/provider/opencode/sse.rs`, add:

```rust
#[test]
fn raw_data_can_be_discarded_without_decode_or_payload_copy() {
    let mut decoder = decoder_with(
        b"data: {this is deliberately not JSON}\n\n\
          data: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
    );

    assert!(decoder.discard_event().expect("bounded raw discard"));
    assert_eq!(
        serde_json::from_slice::<Value>(
            &decoder.take_data().expect("connected frame").expect("data"),
        )
        .expect("connected JSON")["type"],
        "server.connected",
    );
}
```

Keep the existing LF/CRLF, split UTF-8, oversize, resynchronization, and buffer
bound tests passing through `take_event`.

- [ ] **Step 2: Replace the OpenCode reconstruction toggle test**

Replace
`agent_activity_toggle_opencode_rejects_failed_reconnect_then_recovers_and_cleans_up`
with:

- `agent_activity_toggle_opencode_drains_raw_dormant_stream`
- `agent_activity_toggle_opencode_handoff_requires_server_connected`
- `agent_activity_toggle_opencode_failed_handoff_stays_dormant`
- `agent_activity_toggle_opencode_repeated_handoffs_return_to_one_stream`

Use one scripted queue per fixture stream instead of one global decoded event
queue:

```rust
#[derive(Debug)]
struct OpenCodeFixtureStreamScript {
    frames: Arc<Mutex<VecDeque<Result<Vec<u8>, String>>>>,
}

#[derive(Debug, Default)]
struct OpenCodeFixtureRemoteState {
    stream_scripts: Mutex<VecDeque<OpenCodeFixtureStreamScript>>,
    open_streams: AtomicUsize,
    maximum_open_streams: AtomicUsize,
    discarded_frames: AtomicUsize,
    decoded_activity_events: AtomicUsize,
    replacement_waiting: tokio::sync::Notify,
    // Existing unary call recording remains.
}
```

The handoff test must prove:

```rust
let unary_before = opencode_history_call_count(&remote_state);
manager.set_agent_activity_enabled(false).await;
push_raw_dormant_frame(&remote_state, b"data: not-json\n\n");

let replacement_waiting = remote_state.replacement_waiting.notified();
let enabling = tokio::spawn({
    let manager = manager.clone();
    async move { manager.set_agent_activity_enabled(true).await }
});
replacement_waiting.await;
assert!(!enabling.is_finished(), "enable waits for server.connected");
push_connected_frame_to_replacement(&remote_state);
let enabled = enabling.await.expect("enable transition");
assert_eq!((enabled.resumed, enabled.failed), (1, 0));
assert_eq!(opencode_history_call_count(&remote_state), unary_before);
assert_eq!(remote_state.open_streams.load(Ordering::Acquire), 1);
assert!(remote_state.maximum_open_streams.load(Ordering::Acquire) <= 2);
```

Add `replacement_waiting: tokio::sync::Notify` to the fixture state. The
fixture's replacement `next_data` branch calls `notify_one()` immediately
before it waits for its scripted `server.connected` frame.

Assert no `children:*`, `statuses`, or `messages:*` calls are added by
disable/re-enable.

- [ ] **Step 3: Run decoder and OpenCode toggle tests and verify red**

Run:

```bash
cargo test -p bibcode-server provider::opencode::sse::tests -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_opencode -- --nocapture
```

Expected: raw data API is absent, and the observer currently drops/reconnects
its client and runs REST reconciliation on enable.

- [ ] **Step 4: Split SSE framing from JSON decoding**

Move the current frame-boundary, UTF-8, `data:` line collection, oversize
discard, and buffer compaction logic into `take_data`. Return the joined
`data:` bytes without calling serde:

```rust
pub(crate) fn take_event(&mut self) -> Result<Option<Value>, String> {
    let Some(data) = self.take_data()? else {
        return Ok(None);
    };
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|_| "OpenCode SSE data was invalid JSON".to_owned())
}
```

Implement `discard_event` through the same boundary/oversize state machine, but
drain `..index + delimiter` directly and return `true` without collecting the
frame or validating UTF-8/JSON. Comments and heartbeat-only frames count as
successfully discarded transport frames. Do not clone or retain a raw frame
after returning it to the caller.

- [ ] **Step 5: Give each OpenCode event subscription an independent stream owner**

Remove `sse_response` and `sse_decoder` from `SystemOpenCodeRemoteClient`.
Create `SystemOpenCodeEventStream { response, decoder }`.

`open_event_stream(&mut self)` performs the existing authenticated bounded GET and
returns the stream only after validating success and
`text/event-stream`. `SystemOpenCodeEventStream::next_data` repeatedly calls
`decoder.take_data()`, reads bounded chunks, and fails when the response ends.
`discard_next` uses `decoder.discard_event()` and the same bounded chunk reader,
so dormant frames do not allocate payload vectors.

The unary client retains the reqwest client, endpoint, and directory, so a
replacement SSE GET can coexist temporarily with the dormant stream without
creating another helper or root session.

- [ ] **Step 6: Implement the long-lived OpenCode observer and replacement handshake**

After initial root verification and initial best-effort reconciliation, open
one event stream and require `server.connected` before initial observation.
Then own `remote`, `stream`, `tracker`, activity receiver, sequence, and epoch
in one loop.

While dormant:

```rust
discarded = stream.discard_next() => {
    match discarded {
        Ok(()) => {} // bounded framing only; no payload Vec or serde
        Err(_) => {
            epoch = epoch.saturating_add(1);
            // Open a replacement dormant stream with bounded backoff and
            // require server.connected; do not run REST reconciliation.
        }
    }
}
```

When enabling:

1. Open a second event stream through the same authenticated unary client.
2. Wait until `server.connected` is decoded on that replacement.
3. If the controller state is still the same enabled generation, advance epoch,
   replace the old stream, reset `OpenCodeActivityTracker` with only the owned
   root correlation, and mark live.
4. Drop the old stream immediately after the swap.
5. If the generation changed, drop the replacement and remain dormant.
6. If timeout/error occurs, mark unavailable; keep draining the old dormant
   stream.

Only the live branch parses subsequent data into `Value` and calls
`handle_observed_event_at`. Disable the reconciliation interval while dormant,
and never invoke `reconcile_opencode` during enable handoff or dormant
reconnection.

Set `transition.epochs.opencode` to the current epoch.

- [ ] **Step 7: Run OpenCode unit, integration, and cleanup tests**

Run:

```bash
cargo test -p bibcode-server provider::opencode::sse::tests -- --nocapture
cargo test -p bibcode-server provider_terminal::opencode::tests -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor agent_activity_toggle_opencode -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor opencode_ -- --nocapture
```

Expected: PASS; repeated handoffs settle at one stream, never exceed two, and
terminal exit still aborts the owned root and reaps the helper exactly once.

- [ ] **Step 8: Commit the OpenCode dormant pump**

```bash
git add apps/server/src/provider/opencode/sse.rs apps/server/src/provider_terminal/mod.rs apps/server/src/provider_terminal/opencode.rs apps/server/tests/provider_terminal_supervisor.rs
git commit -m "fix(activity): retain dormant OpenCode stream"
```

---

### Task 5: Prove Bounded Resources and Transition-Only Diagnostics

**Files:**
- Modify: `apps/server/src/production/agent_activity.rs:25-255`
- Modify: `apps/server/src/production/agent_activity.rs:380-610`
- Modify: `apps/server/tests/activity_load.rs:1700-1810`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs:90-155`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`

**Interfaces:**
- Consumes `TerminalAgentActivityTransition.unavailable` and `.epochs` from
  Task 1.
- Extends `AgentActivityTransitionReport`:

```rust
pub unavailable_observers: usize,
pub terminal_observation_epochs: TerminalAgentActivityProviderEpochs,
```

- Effective transition trace attributes add:

```json
{
  "unavailableObservers": 0,
  "terminalObservationEpochs": {
    "claude": 1,
    "codex": 3,
    "opencode": 2
  }
}
```

- [ ] **Step 1: Add failing trace serialization tests**

In `apps/server/src/production/agent_activity.rs`, make the fixture runtime
return a transition with fixed provider epochs and one unavailable observer.
Assert one effective transition record contains the bounded aggregate:

```rust
assert_eq!(record["attributes"]["unavailableObservers"], 1);
assert_eq!(
    record["attributes"]["terminalObservationEpochs"],
    json!({"claude": 2, "codex": 4, "opencode": 3}),
);
```

Assert the trace store still contains exactly one
`agent_activity_change_requested` and one effective enabled/disabled event per
actual setting transition. No provider event volume may change these counts.

- [ ] **Step 2: Add a failing disabled-load resource test**

Extend `apps/server/tests/activity_load.rs` with a fake dormant observer whose
transport frame counter increases while all existing activity evidence remains
fixed. Add shared `dormant_frames` and `decoded_events` atomics to
`LoadTerminalObserverFactory`; the fixture's bounded transport-delivery method
increments only `dormant_frames`.

```rust
let streams_before = controller.active_stream_count_for_integration_test();
let database_before = database.queue_backpressure_snapshot_for_integration_test();
let trace_before = trace_record_count(&trace);
let mut apply_completions =
    projection.subscribe_apply_completions_for_integration_test();

for _ in 0..10_000 {
    terminal_factory.deliver_bounded_dormant_frame();
}

assert_eq!(terminal_factory.dormant_frames.load(Ordering::Acquire), 10_000);
assert_eq!(terminal_factory.decoded_events.load(Ordering::Acquire), 0);
assert_eq!(
    controller.active_stream_count_for_integration_test(),
    streams_before,
);
assert_eq!(
    database.queue_backpressure_snapshot_for_integration_test(),
    database_before,
);
assert!(matches!(
    apply_completions.try_recv(),
    Err(tokio::sync::broadcast::error::TryRecvError::Empty),
));
assert_eq!(trace_record_count(&trace), trace_before);
```

This fixture method represents transport framing only; do not route these
frames through `ActivityProjection`. Provider-specific tests in Tasks 2–4
remain responsible for proving their real dormant ingress paths select the
discard branch.

Add a repeated transition test across Claude, Codex, and OpenCode fixture
observers asserting:

- helper count does not grow;
- Claude listener count remains one;
- healthy Codex connection count remains one;
- OpenCode settles to one SSE stream and has a maximum of two;
- activity stream registrations return to zero while disabled;
- restart descriptor count equals live instrumented terminals; and
- closing terminals releases descriptors and transports.

- [ ] **Step 3: Run the new evidence tests and verify red**

Run:

```bash
cargo test -p bibcode-server production::agent_activity::tests -- --nocapture
cargo test -p bibcode-server --test activity_load dormant -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor repeated_activity_toggle -- --nocapture
```

Expected: trace fields and the cross-provider repeated-transition evidence are
not yet wired.

- [ ] **Step 4: Merge epoch/unavailable evidence into the existing transition log**

Update `merge_terminal_transition`:

```rust
report.unavailable_observers = report
    .unavailable_observers
    .saturating_add(terminal.unavailable);
report.terminal_observation_epochs.claude = report
    .terminal_observation_epochs
    .claude
    .max(terminal.epochs.claude);
report.terminal_observation_epochs.codex = report
    .terminal_observation_epochs
    .codex
    .max(terminal.epochs.codex);
report.terminal_observation_epochs.opencode = report
    .terminal_observation_epochs
    .opencode
    .max(terminal.epochs.opencode);
```

Serialize the fixed three-provider object only in startup/effective transition
records. Do not add tracing to provider frame/request/event loops. Preserve the
existing deduplicated bounded warning when `failed_observers > 0`.

Update `assert_safe_transition_trace` in `apps/server/tests/activity_load.rs`
to add `unavailableObservers` and `terminalObservationEpochs` to the allowlist.
Add `BTreeSet` to the existing `std::collections` import. Keep primitive-only
validation for every other field and validate the one nested object exactly:

```rust
let epochs = attributes
    .get("terminalObservationEpochs")
    .and_then(Value::as_object)
    .expect("fixed provider epoch object");
assert_eq!(
    epochs.keys().map(String::as_str).collect::<BTreeSet<_>>(),
    BTreeSet::from(["claude", "codex", "opencode"]),
);
assert!(epochs.values().all(Value::is_u64));
```

- [ ] **Step 5: Run the complete focused backend suite**

Run:

```bash
unset BIBCODE_CLAUDE_KEYCHAIN_ACCESS
cargo test -p bibcode-server provider_terminal:: -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor -- --nocapture
cargo test -p bibcode-server --test activity_load -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Run repository-wide required gates**

Run:

```bash
unset BIBCODE_CLAUDE_KEYCHAIN_ACCESS
vp test
vp check
vp run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Build and verify the desktop behavior**

Build and run the debug desktop target without setting
`BIBCODE_CLAUDE_KEYCHAIN_ACCESS`:

```bash
unset BIBCODE_CLAUDE_KEYCHAIN_ACCESS
vp run build:desktop
BIBCODE_DEV_INSTANCE=activity-dormant-observers vp run dev:desktop
```

Keep the dev process running in its terminal. Use the computer-use skill to
verify:

1. Open one Claude, one Codex, and one OpenCode terminal while activity is
   enabled and confirm the toolbar can become visible.
2. Disable **Settings → Agents → Agent activity for this environment** and
   confirm both chat and terminal activity surfaces disappear immediately.
3. Leave provider activity running while disabled; confirm terminals remain
   usable.
4. Re-enable and confirm each already-instrumented terminal becomes observable
   only after its provider boundary.
5. Confirm no disabled-period detail appears.
6. Open a terminal while disabled, re-enable, and confirm that terminal remains
   unmonitored until reopened.
7. Repeat transitions and confirm no duplicate toolbar entries, panels,
   connections, or transition logs.
8. Inspect the trace bundle and confirm requested/effective records contain
   only bounded counts and the fixed provider-epoch object.

Capture screenshots and trace excerpts as verification artifacts only; do not
commit credentials, terminal output, provider payloads, or user content.

- [ ] **Step 8: Review the final diff and commit production evidence**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm:

- no Cursor or Grok files changed;
- no history reconstruction remains in toggle/re-enable paths;
- no dormant event buffer or per-event log was added;
- all new queues, frames, retries, and connection overlap are bounded; and
- only expected source/tests/docs are modified.

Commit:

```bash
git add apps/server/src/production/agent_activity.rs apps/server/tests/activity_load.rs apps/server/tests/production_server_terminal_rpc.rs apps/server/tests/provider_terminal_supervisor.rs
git commit -m "test(activity): prove dormant observer bounds"
```
