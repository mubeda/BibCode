# Provider skill discovery implementation plan

> Execute inline using superpowers:executing-plans and test-driven-development.

**Goal:** Show each supported provider's user and active-workspace skills.
**Spec:** ../specs/2026-10-01-provider-skill-discovery-design.md
**Architecture:** Add one context-specific capability RPC; reuse provider-native
discovery and the existing environment query family. Global status stays global.
**Stack:** Rust/Tokio, Effect contracts/Atoms, React.

## Constraints and review focus

- User-only catalogs must work with zero repository skills.
- Workspace/provider/settings/connection changes must fence stale results.
- Match provider home/environment and native visibility/invocation rules.
- Bound discovery and reap its subprocesses on every exit path.
- Cursor follows skill symlinks without cycles; remote OpenCode retains cwd.
- No dependencies or production Node runtime; preserve drafts and user files.
- Leave the patch uncommitted for review. Use existing isolated worktree.

## Task 1: Provider discovery

Files: server provider_inventory.rs, provider/cursor/capabilities.rs,
provider/opencode/model.rs, and closest Rust tests.

- [x] Write failing coverage for nested/symlinked/compatible user Cursor skills,
  project union/precedence, and OpenCode skill-command classification.
- [x] Run focused Rust tests; observe the missing-skill failures.
- [x] Add context-specific discovery with effective homes, native protocols,
  issues, timeouts, cancellation and explicit process cleanup.
- [x] Cover Codex/Claude user/project native catalogs using fake executables;
  cover directory-scoped local/configured OpenCode through local HTTP fixtures.
- [x] Run affected Rust tests; expect success.

## Task 2: Typed RPC and query ownership

Files: contracts server.ts/rpc.ts and generated fixtures; server control.rs,
server_terminal.rs/rpc/methods.rs; client-runtime state/server.ts and tests.

Interface: server.getProviderCapabilities({ instanceId, cwd }) returns existing
slashCommands/skills/agents shapes and string issues; typed discovery error.

- [x] Cover invalid paths/instances, isolated catalogs and stale configuration.
- [x] Implement the validated RPC using server-owned effective settings and
  cancellation-owned discovery. Do not publish workspace catalogs globally.
- [x] Add a query family keyed by environment, instance, cwd, and local
  configuration revision, reusing existing cache/reconnect mechanics.
- [x] Run contract fixture/parity and focused server/client tests.

## Task 3: Composer integration

Files: web ChatComposer.tsx, ComposerCommandMenu.tsx, composerCapabilities.ts,
query hook and nearest tests.

- [x] Cover user-only lists, project switching, delayed responses, native
  triggers, loading/error/retry, and local search without repeated discovery.
- [x] Feed context-specific capabilities to menus and inline skill metadata;
  retain same-context data during refresh and invalidate on provider changes.
- [x] Show actionable discovery state while preserving composer text/tokens.
- [x] Run focused web/client tests and review against UI.md and React skill
  when available (report unavailable skill explicitly).

## Task 4: Documentation, verification and review

- [x] Update living provider/RPC docs and native skill-discovery validation.
- [x] Run focused and broader affected package checks, contract checks,
  vp check, vp run typecheck, cargo fmt --all --check, and affected Clippy
  targets with warnings denied. Use the checkout-local vp launcher.
- [x] Obtain one independent review; fix important findings with regression
  coverage and record any residual limitations.
- [x] Review git diff/status and report exact validation commands/results.

Validation evidence: [execution report](../../testing/reports/2026-10-01-provider-skill-discovery.md).
The React skill review was unavailable and packaged native visual checks were not run;
both limitations are recorded in that report.
