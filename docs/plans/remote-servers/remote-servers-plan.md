# Remote Servers Implementation Plan (master)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Detailed
> tasks live in the per-phase files under `phases/`; steps there use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Any BiBCode server can be shared with other devices and any BiBCode client can
connect to shared servers, with an environment rail in the left panel scoping all
operations to the selected environment.

**Architecture:** Client-side catalog feature over the existing multi-environment
connection runtime (`EnvironmentRegistry` + environment-keyed state). New server-side
surfaces: Noise NK E2EE WebSocket channel with pinned host identity, protocol
compatibility window, remote-update RPC, grant-driven exposure. UI: icon rail + context
card in the left panel and a "Remote Servers" settings section evolved in place from
Connections.

**Tech Stack:** Rust (Axum/Tokio, `snow` for Noise NK), TypeScript (React, Effect
Atom/effect RPC, `@noble/curves`/`@noble/ciphers`/`@noble/hashes`), Tauri 2 desktop
bridge, TanStack Router settings routes.

**Spec:** `docs/plans/remote-servers/remote-servers-spec.md` — all names, wire shapes,
and state machines in the phase plans are pinned there (§4). Research grounding:
`orca-remote-servers-research.md`, `bibcode-current-state.md` (same directory).

## Global Constraints

- Zero reference-product strings in code, identifiers, UI copy, or comments; product
  strings are "BiBCode"/"bibcode" by context (spec D16).
- `packages/contracts` stays schema-only; every new WS method gets a Rust mirror and an
  entry in the TS↔Rust parity manifests; every RPC method declares exactly one scope in
  `apps/server/src/auth/scope.rs`.
- All new descriptor/contract fields are additive and decode-defaulted so older servers
  keep working (no breaking wire changes).
- No production Node runtime, no Electron, no sidecars; desktop-privileged operations
  cross `DesktopBridge`; normal traffic uses typed HTTP/WS RPC.
- Preserve unrelated worktree changes — in particular the user's pending deletions under
  `docs/plans/2026-08-24-environment-project-management/` must never be restored or
  committed by this work.
- Every phase: focused tests for changed behavior, `vp check`, `vp run typecheck`; Rust
  phases additionally `cargo fmt --all --check`, relevant Rust tests, and Clippy for
  affected targets with warnings denied; final `git diff`/`git status --short` review.
- Living docs (`docs/architecture/remote.md`, `connection-runtime.md`, `overview.md`) and
  `docs/testing/` runbooks update in the same patch as the behavior they describe; phases
  that change no runbook-relevant behavior state "reviewed and remain accurate".

## Phase index

Each phase produces working, independently shippable software and has its own detailed
task file under `phases/`. Execute in order; Phase 1 and Phase 2 are independent of each
other; Phase 6 may run in parallel with Phase 5 once Phase 4 lands.

| Phase | File                                     | Delivers                                                                                                                                                                | Depends on |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | `phases/phase-1-ssh-pairing-repair.md`   | `bibcode pairing issue` CLI + fixed desktop SSH bootstrap (spec §4.7)                                                                                                   | —          |
| 2     | `phases/phase-2-protocol-compat.md`      | Protocol window on the descriptor + `CompatVerdict` in client-runtime (spec §4.4)                                                                                       | —          |
| 3     | `phases/phase-3-e2ee-pairing.md`         | Host identity key, `/ws-e2ee` Noise NK channel, `bibcode://pair` code format, verify-then-add flow in client-runtime (spec §4.1–4.3)                                    | 2          |
| 4     | `phases/phase-4-settings-connect-tab.md` | "Remote Servers" section (rename + redirect), Connect tab: saved-server rows with status/version/compat, Add Server via pairing code, Advanced manual entry (spec §4.8) | 3          |
| 5     | `phases/phase-5-share-tab-exposure.md`   | Share tab: intent radio, address picker, browser URL + deep link + QR, paired-client revocation; grant-driven exposure state machine on desktop (spec §4.2, §4.6)       | 3          |
| 6     | `phases/phase-6-environment-rail.md`     | Environment rail + context card in the left panel, add-project environment labeling, primary-environment leak fixes (spec §4.8)                                         | 2, 4       |
| 7     | `phases/phase-7-remote-updates.md`       | `updater.status/check/install` RPC, desktop interactive install, headless manual path, "Check for Server Updates" + badges (spec §4.5)                                  | 2, 4, 6    |

## Cross-phase interfaces (summary — normative definitions in spec §4)

- Phase 2 → 3/4/6/7: `REMOTE_PROTOCOL_VERSION`, `MIN_COMPATIBLE_REMOTE_PROTOCOL`,
  descriptor fields `remoteProtocolVersion`/`minCompatibleRemoteProtocol`,
  `CompatVerdict` + `computeCompatVerdict` from
  `packages/client-runtime/src/connection/compat.ts`, and the per-environment accessor
  `createEnvironmentSessionAtoms(...).compatVerdictAtom(environmentId)`
  (`Atom` of `CompatVerdict | null`; re-exported in web as `environmentSession`).
- Phase 3 → 4/5: pairing-code payload schema `RemotePairingCodePayload` (+
  `RemotePairingReach`, `REMOTE_PAIRING_CODE_VERSION`) in
  `packages/contracts/src/remotePairing.ts` with codec
  `encodePairingCode`/`parsePairingCode` in `packages/shared/src/pairingCode.ts`;
  `hostKey` on saved direct-connection profiles; the verify-then-add flow
  `ConnectionOnboarding.verifyAndAddPairingCode` with classified failures
  (`unreachable | host-identity-mismatch | pairing-rejected | incompatible | duplicate-storage-identity`)
  plus `PairingLoopbackAcknowledgementRequiredError`; mint endpoint
  `POST /api/auth/pairing-offer` (scope `access:write`, accepts `reach` in the input and
  embeds it in the payload — reach _persistence_ arrives in Phase 5).
- Phase 4 → 6: `EnvironmentRegistry.connect/disconnect(environmentId)` passthroughs and
  the web command atoms `environmentCatalog.connect/disconnect(environmentId)` — the
  non-destructive Disconnect latch of spec §6 (Phase 4 Task 5b), consumed by the
  context-card ⋯ menu.
- Phase 5 → 3: pairing grants persist `reach`; exposure desired-state derivation.
- Phase 7 → 6: `RemoteUpdateSnapshot`/`RemoteUpdateSupport` consumed by the context card
  badge and settings rows; capability boolean `remoteUpdateControl`.
- Phase 6 consumes existing `activeEnvironmentIdAtom`, environment presentation atoms,
  and the `local:` connection-id prefix for WSL grouping — it introduces no new
  cross-phase types.

## Validation gate (every phase, from AGENTS.md)

1. Focused tests for each changed behavior (written first — TDD).
2. `vp check` and `vp run typecheck`.
3. Rust changes: `cargo fmt --all --check`, affected-crate tests, Clippy with `-D warnings`.
4. Broader integration checks when the phase crosses package/runtime boundaries.
5. `git diff` + `git status --short` review for unintended edits.
6. Report exact commands run, anything that could not run, and residual risk.
