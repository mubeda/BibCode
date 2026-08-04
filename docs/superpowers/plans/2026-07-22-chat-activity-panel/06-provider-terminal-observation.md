# Chat Activity Dock — Provider Terminal Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the same activity dock and inspector for BiBCode-launched Codex, Claude, and OpenCode terminal sessions after a reliable native-session handshake.

**Architecture:** Provider-terminal actions carry a bounded, declarative observation hint. The server validates the provider instance and uses an injected terminal-launch observer to prepare a private control topology before the PTY starts. A generation-scoped observer projects native activity into a terminal activity scope and tears down with the PTY. The original terminal always remains usable when observer setup or handshake fails.

**Tech Stack:** TypeScript contracts, Rust/Tokio, PTY manager, Unix sockets/loopback HTTP, Codex App Server, Claude HTTP hooks/transcripts, OpenCode serve/attach, React terminal viewport.

## Prerequisites and Constraints

- Complete Plans [01](./01-activity-foundation.md), [02](./02-web-dock-and-inspector.md), [03](./03-codex-adapter.md), [04](./04-claude-adapter.md), and [05](./05-opencode-adapter.md).
- Only terminals created by `providerTerminalActions.ts` are eligible.
- The client hint is untrusted. The server validates provider instance, driver, executable policy, topology support, and scope.
- No activity UI appears before the native provider session is correlated to the terminal generation.
- Observer failure never prevents the requested provider terminal from opening.
- Cursor and Grok receive no observation hint and no dock in v1.
- The feature is inspect-only. Do not add provider process-control RPCs.
- Never log credentials, hook tokens, socket secrets, full environment maps, or settings content.

---

## Task 1: Extend the terminal launch contract with a bounded observation hint

**Files:**

- Modify: `packages/contracts/src/terminal.ts`
- Modify: `packages/contracts/src/terminal.test.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Modify: `packages/contracts/src/rpcRustParity.test.ts`
- Modify: `packages/contracts/fixtures/rpc-wire/manifest.json`
- Modify: `apps/server/tests/fixtures/terminal-rpc-wire.json`
- Modify: `apps/server/src/terminal/model.rs`
- Modify: `apps/server/src/production/server_terminal.rs`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`
- Modify: `apps/server/tests/terminal_rpc.rs`

**Interfaces:**

- Produces: `ProviderTerminalActivityLaunch` in TypeScript and Rust.
- Consumed by: Tasks 2–6.

- [ ] **Step 1: Write failing TypeScript contract tests**

Add round-trip and rejection cases for:

```ts
export const ProviderTerminalActivityLaunch = Schema.Struct({
  driverKind: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
});

export const TerminalLaunchCommand = Schema.Struct({
  // existing fields
  activity: Schema.optional(ProviderTerminalActivityLaunch),
});
```

Reject unknown drivers through `ProviderDriverKind`, empty/oversized instance IDs through the existing instance schema, extra secret/token fields, and malformed nested objects. Do not place a strategy, URL, port, socket, token, or native session ID on the client wire; the server chooses those.

- [ ] **Step 2: Add failing Rust wire-parity tests**

Extend the terminal RPC fixture with:

- a valid Codex activity hint;
- a command without a hint;
- invalid nested fields; and
- a launch whose command `env` continues to merge exactly as before.

Rust model:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTerminalActivityLaunch {
    pub driver_kind: String,
    pub provider_instance_id: String,
}
```

Add `activity: Option<ProviderTerminalActivityLaunch>` to Rust `TerminalLaunchCommand` and the production wire decoder. Keep activity metadata out of the PTY environment.

- [ ] **Step 3: Verify red state**

```bash
vp test run packages/contracts/src/terminal.test.ts packages/contracts/src/rpcRustParity.test.ts
cargo test -p bibcode-server --test production_server_terminal_rpc command -- --nocapture
cargo test -p bibcode-server --test terminal_rpc command -- --nocapture
```

- [ ] **Step 4: Implement the schema/wire changes and regenerate fixtures**

Use the existing fixture export script; do not hand-edit generated representations when the repository script owns them.

- [ ] **Step 5: Verify and commit**

```bash
vp test run packages/contracts/src/terminal.test.ts packages/contracts/src/rpcRustParity.test.ts
cargo test -p bibcode-server --test production_server_terminal_rpc command -- --nocapture
cargo test -p bibcode-server --test terminal_rpc command -- --nocapture
git add packages/contracts/src/terminal.ts packages/contracts/src/terminal.test.ts \
  packages/contracts/scripts/export-rust-rpc-fixtures.ts \
  packages/contracts/src/rpcRustParity.test.ts packages/contracts/fixtures/rpc-wire \
  apps/server/tests/fixtures/terminal-rpc-wire.json \
  apps/server/src/terminal/model.rs apps/server/src/production/server_terminal.rs \
  apps/server/tests/production_server_terminal_rpc.rs apps/server/tests/terminal_rpc.rs
git commit -m "feat(terminal): add provider activity launch hint"
```

---

## Task 2: Mark only supported provider terminal actions

**Files:**

- Modify: `apps/web/src/components/chat/providerTerminalActions.ts`
- Modify: `apps/web/src/components/chat/providerTerminalActions.test.ts`
- Modify: `apps/web/src/lib/terminalLaunchCommand.ts`
- Modify: `apps/web/src/centerPanelStore.ts`
- Modify: `apps/web/src/centerPanelStore.test.ts`

- [ ] **Step 1: Write failing provider-action tests**

Assert that resolved commands contain:

```ts
activity: {
  driverKind: entry.driverKind,
  providerInstanceId: entry.instanceId,
}
```

for `codex`, `claudeAgent`, and `opencode` only. Assert the field is absent for Cursor, Grok, ordinary shells, and an unsupported custom driver.

Also prove:

- custom configured binary paths keep the same hint;
- model/effort/permission/theme args remain unchanged;
- decode bounds still reject oversized commands; and
- persisted center-panel terminal surfaces round-trip the hint and remove malformed hints during migration.

- [ ] **Step 2: Verify red state**

```bash
vp test run apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/centerPanelStore.test.ts
```

- [ ] **Step 3: Add a supported-driver set and reuse the contract decoder**

Define one local constant:

```ts
const OBSERVABLE_TERMINAL_DRIVERS = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
]);
```

Attach the hint before `decodeTerminalLaunchCommand` so the schema is the single bounds authority. Do not add conditionals in `CenterTerminalPanel`; it transports the command as data.

- [ ] **Step 4: Verify and commit**

```bash
vp test run apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/centerPanelStore.test.ts
git add apps/web/src/components/chat/providerTerminalActions.ts \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/lib/terminalLaunchCommand.ts apps/web/src/centerPanelStore.ts \
  apps/web/src/centerPanelStore.test.ts
git commit -m "feat(terminal): mark observable provider terminals"
```

---

## Task 3: Add generation-scoped terminal launch observation plumbing

**Files:**

- Create: `apps/server/src/provider_terminal/mod.rs`
- Create: `apps/server/src/provider_terminal/model.rs`
- Create: `apps/server/src/provider_terminal/supervisor.rs`
- Create: `apps/server/tests/provider_terminal_supervisor.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `apps/server/src/terminal/mod.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/tests/terminal_rpc.rs`

**Interfaces:**

- Produces: generic terminal launch-preparer trait and production supervisor.
- Consumed by: provider observers in Tasks 4–6.

- [ ] **Step 1: Write failing terminal-manager lifecycle tests**

Use a fake observer/preparer and fake PTY backend. Prove:

- an unhinted command bypasses the preparer;
- a valid hinted command calls `prepare` once before PTY spawn;
- `PreparedTerminalLaunch` may replace executable/args and add private env entries;
- prepare failure spawns the original command unchanged and records no activity capability;
- PTY spawn failure cancels and cleans a successfully prepared observer/helper;
- observer handshake completion can publish terminal scope capabilities after spawn;
- process exit, close, restart, and manager shutdown each cancel the matching observer;
- late output from generation N is rejected after restart creates generation N+1;
- each `SessionGeneration` owns a fresh UUID and the terminal activity scope ID is `terminal:<generation-uuid>`;
- attach to a running PTY does not create a second observer; and
- restart uses a fresh terminal activity scope even when terminal ID is reused.

- [ ] **Step 2: Define the generic terminal boundary**

Keep provider-specific types out of `terminal/manager.rs`. Define:

```rust
pub trait TerminalLaunchPreparer: Send + Sync {
    fn prepare(
        &self,
        input: TerminalLaunchPreparationInput,
    ) -> Pin<Box<dyn Future<Output = TerminalLaunchPreparation> + Send + '_>>;
}

pub enum TerminalLaunchPreparation {
    PassThrough,
    Prepared(PreparedTerminalLaunch),
}

pub struct PreparedTerminalLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub private_env: BTreeMap<String, String>,
    pub observer: Box<dyn PreparedTerminalObserver>,
}
```

`PreparedTerminalObserver` exposes `on_spawned(pid, generation)`, `cancel(reason)`, and a non-secret diagnostic label. Use boxed futures if the repository avoids `async_trait`.

- [ ] **Step 3: Integrate with terminal generation ownership**

Add an optional `launch_preparer` to `TerminalManagerOptions`. During `start`:

1. assign/read the UUID stored on the current `SessionGeneration` and validate normal input;
2. call the preparer only for a command carrying an activity hint;
3. merge `private_env` at highest internal precedence while rejecting reserved-key collision from the client;
4. spawn the prepared or original candidate;
5. store the observer handle inside the shared terminal session; and
6. notify it only after a PID/process exists.

Never include private env values in attempted-command errors or terminal history. Drop/cancel the observer before invalidating its generation during restart/close.

- [ ] **Step 4: Implement the production supervisor skeleton**

`ProviderTerminalActivitySupervisor` receives:

- validated server provider settings/inventory;
- `ActivityProjection`;
- process attribution registry;
- an application-private temp/runtime directory; and
- factories for Codex/Claude/OpenCode observers.

Validation requires the hinted instance to exist, its configured driver to equal
`driverKind`, and the requested executable to resolve to that instance's
configured binary (or the registered built-in default). Canonicalize filesystem
paths where possible and compare platform-appropriately; never trust a matching
basename alone. A mismatch yields `PassThrough` plus one bounded operational
warning. The supervisor chooses strategy server-side.

Use the generation UUID for the bounded canonical scope ID
`terminal:<generation-uuid>`. Persist the public scope ref as terminal/thread IDs
and mark only the newest generation current. Namespace native IDs internally by
the same generation. A logical terminal subscription receives a replacement
snapshot when its current generation changes; the old journal remains retained
and terminal records are marked interrupted.

- [ ] **Step 5: Verify generic lifecycle and commit**

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor lifecycle -- --nocapture
cargo test -p bibcode-server --test terminal_rpc observer -- --nocapture
git add apps/server/src/provider_terminal apps/server/src/lib.rs \
  apps/server/src/terminal/manager.rs apps/server/src/terminal/mod.rs \
  apps/server/src/production/runtime.rs apps/server/tests/provider_terminal_supervisor.rs \
  apps/server/tests/terminal_rpc.rs
git commit -m "feat(terminal): add provider observer lifecycle"
```

---

## Task 4: Implement the Codex remote App Server terminal observer

**Files:**

- Create: `apps/server/src/provider_terminal/codex.rs`
- Create: `apps/server/tests/fixtures/provider-terminal/codex-remote-handshake.json`
- Modify: `apps/server/src/provider_terminal/mod.rs`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`

- [ ] **Step 1: Write failing topology and handshake tests**

Use fake processes/socket transport to prove:

- the configured Codex executable is feature-probed for App Server Unix listening and `--remote` support;
- a private Unix socket path is created under a mode-0700 runtime directory;
- the App Server helper starts before the PTY command is returned;
- the observer initializes with the same protocol negotiation as Plan 03;
- the returned PTY command launches the configured Codex binary against that exact `unix://` endpoint while preserving model/config/permission args allowed by remote mode;
- no activity capability publishes until a TUI-created native root thread is observed and correlated;
- two terminals never share endpoints or graph namespaces;
- helper startup failure returns PassThrough with the original command;
- a 10-second missing handshake leaves the terminal running but publishes no dock; and
- close/restart kills only the owned helper and removes the socket.

Where Unix sockets are unavailable, use a separately feature-gated WebSocket
branch only when the installed App Server advertises listener support. Bind
strictly to `127.0.0.1`, allocate the port without a release/rebind race, and
fixture-test the exact `ws://127.0.0.1:<port>` endpoint. If that branch is not
supported, report terminal observation unsupported and pass through. Never
bind a non-loopback listener.

- [ ] **Step 2: Implement version-gated command construction**

Parse the installed binary's help/version output into a cached capability record. Command templates belong in this module and must be fixture-tested; do not concatenate shell strings. Spawn the helper with structured executable/args and redirected bounded logs.

Prefer Unix transport. If a future supported local named-pipe transport is added, implement it as a separate tested capability branch.

- [ ] **Step 3: Reuse the Codex tracker and reconciliation**

Instantiate Plan 03's `CodexActivityTracker` for the terminal generation. The observer is an App Server client, filters to the correlated root, and uses the same descendant/read/background-terminal repair logic. Set `terminalObservation: true` only in the handshake mutation batch.

The first correlated thread becomes the root only if it is created after the terminal generation starts and belongs to the shared endpoint. Reject pre-existing/unrelated threads.

- [ ] **Step 4: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor codex -- --nocapture
git add apps/server/src/provider_terminal/codex.rs apps/server/src/provider_terminal/mod.rs \
  apps/server/tests/fixtures/provider-terminal/codex-remote-handshake.json \
  apps/server/tests/provider_terminal_supervisor.rs
git commit -m "feat(terminal): observe Codex remote sessions"
```

---

## Task 5: Implement the Claude hook/registry terminal observer

**Files:**

- Create: `apps/server/src/provider_terminal/claude.rs`
- Create: `apps/server/tests/fixtures/provider-terminal/claude-hook-handshake.json`
- Modify: `apps/server/src/provider_terminal/mod.rs`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`

- [ ] **Step 1: Write failing settings-composition and sink tests**

Cover:

- feature probe confirms interactive settings overlay and HTTP hook support;
- an isolated mode-0600 settings file adds BiBCode `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, and failure hooks;
- the generated overlay composes with normal user/project/local settings and does not replace existing hooks;
- hook URL binds loopback only and contains no bearer token in logs;
- each POST requires a per-launch bearer token, correct correlation value, JSON content type, and body <= 1 MiB;
- the first valid root-session hook establishes the handshake;
- hooks for other sessions/tokens are rejected without graph mutation;
- unsafe/unsupported settings composition returns PassThrough; and
- closing the terminal stops the HTTP sink and deletes the overlay.

- [ ] **Step 2: Implement a private authenticated hook sink**

Bind an ephemeral `127.0.0.1` listener owned by the observer. Generate 256 bits of random token material. The settings overlay points HTTP hooks to the sink and includes a non-secret launch correlation ID. Never bind `0.0.0.0` or `[::]`.

If the installed Claude version cannot express authenticated HTTP hooks, do not fall back to an untrusted command hook. Mark terminal observation unsupported and launch normal Claude.

- [ ] **Step 3: Compose without mutating user configuration**

Pass the generated overlay through the installed CLI's supported `--settings` mechanism while leaving default user/project/local setting sources enabled. Before enabling generally, an integration test must prove the installed/versioned merge semantics append the observer hooks. If semantics replace user hooks, disable the observer for that version.

Do not write into `~/.claude`, the project, or the worktree.

- [ ] **Step 4: Reuse Claude mapping and bounded recovery**

Feed validated hook bodies into Plan 04's `ClaudeActivityTracker`. After handshake, reconcile against documented background-agent registry/transcript helpers when available. Set capabilities to the truthful supported subset; `terminalObservation` becomes true only after session correlation.

If the observer restarts and cannot prove it has reattached to the same Claude session, mark active records interrupted and leave history inspectable.

- [ ] **Step 5: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor claude -- --nocapture
git add apps/server/src/provider_terminal/claude.rs apps/server/src/provider_terminal/mod.rs \
  apps/server/tests/fixtures/provider-terminal/claude-hook-handshake.json \
  apps/server/tests/provider_terminal_supervisor.rs
git commit -m "feat(terminal): observe Claude hook sessions"
```

---

## Task 6: Implement the OpenCode serve/attach terminal observer

**Files:**

- Create: `apps/server/src/provider_terminal/opencode.rs`
- Create: `apps/server/tests/fixtures/provider-terminal/opencode-attach-handshake.json`
- Modify: `apps/server/src/provider_terminal/mod.rs`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`

- [ ] **Step 1: Write failing topology tests**

Prove:

- the configured binary supports `serve` and `attach` before modification;
- one authenticated loopback server starts per terminal generation;
- host is always `127.0.0.1`, port is reserved without a race, and credentials are random per launch;
- the observer connects to the server's status/children/messages/SSE endpoints;
- the returned PTY command uses `opencode attach <exact-url>` and preserves model/theme configuration;
- a TUI session is accepted only when observed on that exact server after generation start;
- helper failure returns the original `opencode` command;
- handshake timeout shows no dock but leaves attach/TUI usable when the server itself is healthy; and
- cancellation stops server/SSE work and releases the port.

- [ ] **Step 2: Implement safe server startup**

Prefer an API-supported port-0 readiness contract. If the installed CLI requires a fixed port, hold a bound listener or use the repository's managed-endpoint allocator until the child takes ownership, then verify the exact child endpoint before releasing. Never choose a port by “bind, close, then hope.”

Pass credentials through private process environment and authenticated client headers. Redact them from errors and diagnostics.

- [ ] **Step 3: Reuse OpenCode child mapping**

After root-session correlation, instantiate/reuse Plan 05's tracker and reconciliation loop against the shared server. Namespace all actors/entries by terminal generation. Set `terminalObservation: true` in the handshake batch.

- [ ] **Step 4: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor opencode -- --nocapture
git add apps/server/src/provider_terminal/opencode.rs apps/server/src/provider_terminal/mod.rs \
  apps/server/tests/fixtures/provider-terminal/opencode-attach-handshake.json \
  apps/server/tests/provider_terminal_supervisor.rs
git commit -m "feat(terminal): observe OpenCode attach sessions"
```

---

## Task 7: Mount the shared dock in eligible terminal viewports

**Files:**

- Create: `apps/web/src/components/activity/ProviderTerminalActivityDock.tsx`
- Create: `apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`

- [ ] **Step 1: Write failing terminal dock tests**

At the `TerminalViewport` boundary prove:

- no hint means no terminal activity subscription or dock;
- a supported hint subscribes to `{ _tag: "terminal", threadId, terminalId }`;
- starting/reconnecting/error snapshots with no successful handshake remain hidden;
- `terminalObservation: true` plus records renders the shared `ActivityDock`;
- each split terminal uses its own terminal ID/scope;
- hidden terminal panes do not mount duplicate live announcements;
- clicking a section calls `openActivity(ref, section, { _tag: "terminal", terminalId })`;
- the Activity surface resolves the terminal scope until closed, even if another pane becomes active; and
- closing/restarting the terminal returns the inspector to an interrupted snapshot or a fresh generation, never another terminal's records.

- [ ] **Step 2: Verify red state**

```bash
vp test run apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
```

- [ ] **Step 3: Implement a small scope-binding wrapper**

`ProviderTerminalActivityDock` reads the Plan 01 atom for the terminal scope and renders Plan 02's presentational dock only when:

```ts
snapshot !== null &&
snapshot.scope._tag === "terminal" &&
snapshot.capabilities.terminalObservation &&
selectActivityDockVisibility(snapshot).visible
```

Mount it inside `TerminalViewport`'s relative content boundary after the xterm mount, with placement below the terminal toolbar and above xterm. Reuse workspace expansion state. Do not import provider-specific types beyond the generic launch hint.

- [ ] **Step 4: Resolve the inspector scope from its persisted route**

In `ChatView`, convert the activity surface's local scope descriptor to the full contract scope using the active host thread ID. If a terminal ID is no longer valid, keep the last journal inspectable but show its interrupted/stale state; malformed IDs fall back to the thread roster during store hydration.

- [ ] **Step 5: Verify UI and commit**

```bash
vp test run apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx \
  apps/web/src/components/ChatView.test.tsx
vp run --filter @bibcode/web typecheck
git add apps/web/src/components/activity/ProviderTerminalActivityDock.tsx \
  apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.tsx \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx \
  apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx
git commit -m "feat(activity): show activity in provider terminals"
```

---

## Task 8: Harden restart, cleanup, and unsupported-provider behavior

**Files:**

- Modify: `apps/server/src/provider_terminal/supervisor.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/tests/provider_terminal_supervisor.rs`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`
- Modify: `apps/web/src/components/chat/providerTerminalActions.test.ts`

- [ ] **Step 1: Write failure-matrix tests**

Cover:

- server restart with no reattach marks active terminal records interrupted;
- recovered completed records stay completed;
- observer helper exits before PTY -> no dock, PTY remains;
- PTY exits before helper -> helper is cancelled;
- bounded exponential retry never spawns a second helper for one generation;
- stale credentials/socket files are cleaned only inside the validated private runtime directory;
- startup scans and cleans owned stale artifacts without following symlinks;
- Cursor/Grok commands never invoke the preparer even if a malicious hint is manually supplied with mismatched settings;
- deleting a provider instance makes future hinted launches pass through; and
- diagnostics contain provider/strategy/status but no secret values.

- [ ] **Step 2: Implement server-start reconciliation**

On production runtime construction, ask `ActivityProjection` to mark unresolved active terminal scopes interrupted. Do not mark normal web-chat scopes interrupted; their provider runtimes own separate reconnect rules.

Clean only artifacts carrying a validated BiBCode ownership marker and residing under the configured application-private runtime directory.

- [ ] **Step 3: Run full terminal regressions and commit**

```bash
cargo test -p bibcode-server --test provider_terminal_supervisor -- --nocapture
cargo test -p bibcode-server --test terminal_rpc -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
vp test run apps/web/src/components/chat/providerTerminalActions.test.ts
git add apps/server/src/provider_terminal/supervisor.rs apps/server/src/production/runtime.rs \
  apps/server/tests/provider_terminal_supervisor.rs \
  apps/server/tests/production_server_terminal_rpc.rs \
  apps/web/src/components/chat/providerTerminalActions.test.ts
git commit -m "fix(activity): harden terminal observer cleanup"
```

---

## Plan 06 Verification

- [ ] Run the terminal activity slice:

```bash
vp test run packages/contracts/src/terminal.test.ts packages/contracts/src/rpcRustParity.test.ts \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/centerPanelStore.test.ts \
  apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx \
  apps/web/src/components/ChatView.test.tsx
cargo test -p bibcode-server --test provider_terminal_supervisor -- --nocapture
cargo test -p bibcode-server --test terminal_rpc -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
```

- [ ] Manual smoke matrix:

| Terminal action | Expected |
|---|---|
| Codex | remote App Server handshake, then dock |
| Claude | authenticated hook handshake, then dock |
| OpenCode | shared serve/attach handshake, then dock |
| Cursor | ordinary terminal, no dock |
| Grok | ordinary terminal, no dock |
| Any supported provider with observer setup failure | ordinary usable terminal, no dock |

- [ ] For each supported terminal, spawn a child actor, inspect detail, restart the terminal, and confirm the previous generation becomes interrupted while the new generation gets a separate graph.
