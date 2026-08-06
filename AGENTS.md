# AGENTS.md

## Required Pre-Work

Before non-trivial diagnosis, design, or implementation:

1. Read every applicable `AGENTS.md` from the repository root to the files in
   scope.
2. Run `git status --short`; preserve unrelated user changes.
3. State the requested outcome, constraints, affected packages, and evidence
   that will prove completion.
4. If `codegraph` is available on `PATH`, run `codegraph sync . --quiet` from
   the repository root before relying on graph results.
5. If CodeGraph sync fails, note that its data may be stale and continue with
   `rg`, manifests, tests, and direct source inspection. Do not block the task.

Do not install, initialize, unlock, repair, or fully re-index CodeGraph unless
the user explicitly requests it. When CodeGraph is available, use its
relationship and impact queries for unfamiliar or cross-package code, then
confirm critical findings in source and tests.

For non-trivial code work, read `docs/README.md`,
`docs/architecture/overview.md`, `docs/reference/workspace-layout.md`, and
`docs/reference/scripts.md`, then read the task-relevant living documentation
linked by the index. Also inspect the closest package README and manifest,
public contracts, existing tests, CI configuration, and recent history for
affected paths when intent is unclear.

Documentation-only and very small mechanical work may use the relevant subset
only after consulting `docs/README.md`. This keeps the workflow proportionate
without letting agents skip documentation discovery.

## Evidence and Documentation

- Source, schemas, manifests, tests, and CI are executable evidence of current
  behavior.
- Living documentation states intended current architecture and supported
  behavior.
- `docs/plans/`, `docs/superpowers/`, dependency reports, and dated
  measurements are historical evidence only; verify their paths, commands, and
  designs before reuse.
- `.repos/` contains read-only upstream examples, not application dependencies
  or BiBCode behavior.

Investigate disagreements by tracing the relevant call path and tests. Either
align living documentation in the same change or report the unresolved
discrepancy.

## Architectural Decision Standards

Before editing, identify:

- owning package and permitted dependency direction;
- callers, consumers, schemas, persistence formats, and public boundaries;
- state owner and source of truth;
- relevant failure, cancellation, reconnect, restart, concurrency, duplicate
  delivery, stale-result, and partial-stream behavior;
- authentication, process, filesystem, network, remote-environment, provider,
  and desktop-bridge trust boundaries;
- CPU, memory, queue, task, I/O, cloning, and backpressure behavior on hot
  paths;
- existing tests and living documents that define the behavior.

Make the smallest coherent change that preserves repository boundaries. Improve
the correct shared abstraction when multiple consumers need the same policy,
while avoiding speculative generalization, duplicate sources of truth,
compatibility aliases without a requirement, hidden fallbacks, and unrelated
cleanup.

Change the corresponding living architecture document in the same patch whenever
package ownership, protocol flow, persisted shape, runtime topology, lifecycle
guarantees, security boundaries, or documented invariants change. Record
alternatives and trade-offs in an approved design document before implementing a
non-trivial new architectural decision.

## Implementation Quality

Before editing, define observable success and relevant failure cases. Inspect
the existing implementation and tests, and update the closest behavioral
coverage.

- Keep changes scoped to the requested outcome and necessary architectural
  support.
- Preserve unrelated worktree changes.
- Follow existing naming, errors, logging, schema, and module conventions.
- Keep shared logic in the package that owns it; do not duplicate policy.
- Update documentation, examples, fixtures, schemas, and contracts together
  when public behavior changes.
- Test public behavior and important failure/lifecycle seams, not private
  implementation details.
- Run focused tests after each meaningful behavior change.

## Task Completion Requirements

No task is complete until all applicable requirements have evidence:

1. Focused tests for every changed behavior.
2. Broader package, integration, build, or end-to-end checks when the change
   crosses package or runtime boundaries.
3. Successful `vp check` and `vp run typecheck`.
4. For Rust changes, `cargo fmt --all --check`, relevant Rust tests, and Clippy
   for affected targets with warnings denied.
5. Final `git diff` and `git status --short` review for unintended edits,
   generated files, debug output, dependency drift, and missing documentation.
6. A synced configured vendored subtree when its matching dependency changes.
7. Report the exact validation commands, any command that could not run, and
   residual risk.

`vp test` is the built-in Vite+ test command and `vp run test` is the workspace
package-script graph. Select broader checks according to risk; a broad suite
does not replace focused coverage for changed behavior.

## Project Snapshot

BiBCode is a web and Tauri desktop GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Keep designs understandable and
evolvable as the codebase grows.

## Package Roles

- `apps/desktop`: Tauri 2 desktop host written in Rust. Owns native windows,
  menus, dialogs, updates, WSL/SSH launch, and the `DesktopBridge`
  implementation. It starts the Rust server as an in-process runtime.
- `apps/server`: Rust/Axum/Tokio application server and native `bibcode` CLI.
  Owns HTTP/WebSocket RPC, authentication, persistence, orchestration,
  providers, terminals, Git, files, diagnostics, relay integration, and process
  supervision.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@bibcode/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared connection, RPC, cache, and environment runtime used by browser and Tauri clients.

Node.js and TypeScript are development dependencies for the frontend and
repository tooling only. Do not add a production Node runtime, Electron host,
TypeScript server, or native helper sidecar.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vp run sync:repos`; use `vp run sync:repos -- --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
