# Chat Activity Dock and Agent Inspector Implementation Plan — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reliable, current-chat-scoped activity dock and right-panel inspector for subagents and provider-managed background tasks, with structured-chat support for Codex, Claude, and OpenCode and handshake-gated observation for T4Code-owned provider terminals.

**Architecture:** Provider adapters emit native-identity-preserving mutations into a server-owned activity projection. The projection persists a bounded journal and materialized records, exposes a snapshot-plus-ordered-delta RPC, and feeds a provider-neutral client reducer. React renders one floating dock and one Activity right-panel surface; terminal observation is a separately negotiated capability attached to structured terminal launch metadata.

**Tech Stack:** Rust/Axum/Tokio/SQLite/Serde, Effect Schema and Effect Streams, `@effect/atom-react`, React 19, Zustand, Base UI primitives, Vite+ tests, Cargo tests, provider-native JSON-RPC/SSE/hooks.

**Approved design:** `docs/superpowers/specs/2026-07-22-chat-activity-panel-design.md`

## Why this is a plan suite

The approved specification crosses independently reviewable subsystems. A
single implementation plan would make the provider adapters and terminal
control plane one all-or-nothing change. This suite splits them so each phase
has an independently testable deliverable and a reviewer can approve one
provider without accepting another.

The shared activity protocol, server projection, and web UI are one foundation.
Codex, Claude, and OpenCode then adopt that protocol independently. Terminal
observation remains last because it must not weaken an already-correct
structured-chat implementation.

## Global Constraints

- Follow `/Users/admin/.codex/worktrees/b4f1/t4code/AGENTS.md`.
- Before modifying Effect schemas or Effect Streams, read `.repos/effect-smol/LLMS.md` completely and use vendored Effect source examples.
- Do not edit or import from `.repos/`.
- Keep `packages/contracts` schema-only. Put runtime reducers in `packages/client-runtime` or `packages/shared` with explicit subpath exports.
- Scope activity to the current root chat and provider-reported descendants. Never aggregate sibling or unrelated workspace sessions.
- The first release is inspect-only. Do not add stop, steer, resume, terminate, retry, or send-input RPCs or controls.
- Never infer an actor from a tool name, prompt, icon, command duration, or generic ACP event. Admit only stable provider identities and parent relationships.
- Never request or display hidden chain-of-thought. Only provider-delivered user-visible commentary, tool/command activity, results, errors, and summaries qualify.
- Cursor and Grok provider terminals receive no activity launch metadata and render no activity dock in v1.
- Terminal capability remains false until the observer and TUI prove they share one native session.
- A lost active actor/work item becomes `interrupted`, never `completed`.
- Terminal lifecycle states never regress because of duplicate or late events.
- All IDs, labels, metadata, page sizes, and payloads are bounded at the contract and server boundaries.
- Stream revisions are scope-local and ordered. A gap causes atomic snapshot replacement, not guessed replay.
- Initial snapshots contain summary rows only. Roster pages and detail entries load lazily.
- Preserve existing chat work-log rendering, provider session routing, terminal attach/restart semantics, and right-panel responsive sheet behavior.
- Use structured executable/argument arrays. Never assemble a provider terminal command through shell interpolation.
- Follow red-green-refactor for every task: write a focused failing test, run it and observe the intended failure, implement the minimum behavior, rerun, then refactor.
- Commit after each green task using the commit message supplied by that task.
- Before the suite is complete, `vp check` and `vp run typecheck` must both pass.

## Canonical Interfaces

Every phase uses the following names. Do not rename them in one phase without
updating every dependent phase in the same commit.

```ts
type ActivitySection = "subagents" | "backgroundTasks";
type ActivityRecordKind = "actor" | "workItem";
type ActivityLifecycle =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

interface ActivityCapabilities {
  readonly actors: boolean;
  readonly attributedActivity: boolean;
  readonly backgroundWork: boolean;
  readonly historyRecovery: "full" | "bounded" | "none";
  readonly terminalObservation: boolean;
}

interface ActivitySectionHealth {
  readonly state: "unsupported" | "live" | "stale" | "error";
  readonly message: string | null;
  readonly retryable: boolean;
}
```

The server owns the equivalent Rust types in
`apps/server/src/activity/model.rs`. Provider adapters emit
`ProviderActivityMutation`; they never construct RPC JSON directly.

## Plan Map and Dependencies

| Order | Plan | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | [01-activity-foundation.md](./01-activity-foundation.md) | Contracts, SQLite projection, RPC, durable client reducer | Approved design |
| 2 | [02-web-dock-and-inspector.md](./02-web-dock-and-inspector.md) | Floating dock, Activity surface, roster/detail, responsive behavior | Plan 01 |
| 3 | [03-codex-adapter.md](./03-codex-adapter.md) | Codex child actors, attributed detail, background terminals, recovery | Plan 01; UI can land before or after |
| 4 | [04-claude-adapter.md](./04-claude-adapter.md) | Claude hook lifecycle, attribution, transcript recovery | Plan 01 |
| 5 | [05-opencode-adapter.md](./05-opencode-adapter.md) | OpenCode child sessions, SSE attribution, history recovery | Plan 01 |
| 6 | [06-provider-terminal-observation.md](./06-provider-terminal-observation.md) | Handshake-gated Codex/Claude/OpenCode terminal observation | Plans 01–05 |
| 7 | [07-integration-and-rollout.md](./07-integration-and-rollout.md) | Cross-provider failure tests, accessibility/performance gates, docs, final verification | Plans 01–06 |

Plans 03–05 may execute in parallel after Plan 01. Plan 02 may also execute in
parallel with them because its tests use canonical contract fixtures. Plan 06
must wait for all three provider adapters because it reuses their native
mapping and recovery code.

## File Responsibility Map

### Shared protocol and client state

- `packages/contracts/src/activity.ts` — bounded wire schemas only.
- `packages/contracts/src/rpc.ts` — four additive activity RPC tags.
- `packages/client-runtime/src/state/activityReducer.ts` — pure revision-aware reducer.
- `packages/client-runtime/src/state/activity.ts` — reconnecting Effect Stream state and paged queries.
- `apps/web/src/state/activity.ts` — binds the client-runtime atoms to the web connection runtime.

### Server projection

- `apps/server/src/activity/model.rs` — canonical Rust wire and mutation types.
- `apps/server/src/activity/projection.rs` — state-machine validation and transactional mutation orchestration.
- `apps/server/src/activity/rpc.rs` — authenticated snapshot, stream, roster, and detail handlers.
- `apps/server/src/activity/mod.rs` — focused exports; no provider parsing.
- `apps/server/src/persistence/migrations.rs` — activity journal/materialized tables and indexes.
- `apps/server/src/activity/repository.rs` — transactional activity persistence/query methods over the shared database worker.

### Web presentation

- `apps/web/src/activityDockStore.ts` — workspace-local expanded/collapsed preference only.
- `apps/web/src/components/activity/activityPresentation.ts` — pure grouping/count/time/label helpers.
- `apps/web/src/components/activity/ActivityDock.tsx` — collapsed and expanded floating controls.
- `apps/web/src/components/activity/ActivityPanel.tsx` — roster/detail router and lazy paging.
- `apps/web/src/rightPanelStore.ts` — persists one singleton Activity surface route.
- `apps/web/src/components/ChatView.tsx` — mounts the dock and Activity surface.
- `apps/web/src/components/ThreadTerminalDrawer.tsx` — mounts the shared dock inside each negotiated terminal viewport, including center-panel terminals.

### Provider adapters

- `apps/server/src/provider/codex/activity.rs` — App Server collaboration/descendant/background-terminal mapping.
- `apps/server/src/provider/claude/activity.rs` — hook/subagent/transcript mapping.
- `apps/server/src/provider/opencode/activity.rs` — child-session/SSE/history mapping.
- `apps/server/src/production/provider_runtime.rs` — transports normalized mutation batches to the projection.

### Provider-terminal observation

- `packages/contracts/src/terminal.ts` — bounded optional activity launch descriptor.
- `apps/server/src/provider_terminal/mod.rs` — observer service exports.
- `apps/server/src/provider_terminal/supervisor.rs` — per-terminal observer lifecycle and handshake deadline.
- `apps/server/src/provider_terminal/codex.rs` — local App Server control socket and `codex --remote` preparation.
- `apps/server/src/provider_terminal/claude.rs` — isolated hook overlay and correlation sink.
- `apps/server/src/provider_terminal/opencode.rs` — authenticated loopback server and `opencode attach` preparation.
- `apps/server/src/terminal/manager.rs` — invokes the observer preparer before PTY spawn and tears it down with the terminal generation.

## Delivery Checkpoints

### Checkpoint A — canonical path

Plans 01 and 02 are green with synthetic fixtures. The UI can demonstrate all
states without provider-specific parsing, and unsupported chats have no dock.

### Checkpoint B — structured providers

Plans 03–05 are green. Codex, Claude, and OpenCode each pass native fixture,
projection, reconnect, duplicate, and late-event tests.

### Checkpoint C — terminals

Plan 06 is green. Each eligible provider terminal proves session correlation
before the dock appears. Observer failure preserves the ordinary provider TUI
without the dock.

### Checkpoint D — release gate

Plan 07 is green, including responsive/accessibility/performance checks,
`vp check`, and `vp run typecheck`.

## Execution Rule

Execute one task at a time. A task is complete only after its focused red-green
cycle, diff review, and commit. Do not begin Plan 06 merely because a provider
CLI appears to work manually; its structured adapter and recovery tests must be
green first.
