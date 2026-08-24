# Optional Desktop Update Protection Design

**Status:** Approved in chat on 2026-08-24.

## Outcome

Desktop updates remain protected by default on macOS, Windows, and Linux, but a
user may explicitly continue without a pre-update backup after protection
fails. Protection reports live, truthful progress, and a passive read stream
must never block the mutation drain.

## Decisions

1. The typed RPC inventory owns each method's maintenance mutability. Unknown
   methods remain fail-safe mutations. `subscribeWorktreeCatalog` and
   `vcs.refreshWorktreeCatalog` are reads; durable mutation commands remain
   mutations.
2. Mutation permits retain a bounded operation name and admission time. The
   authenticated maintenance status endpoint reports the current preparation
   stage, elapsed time, remaining time, mutation count, and bounded blockers.
   Timeout logs contain the same method-level evidence without payloads,
   credentials, paths, or request bodies.
3. The desktop host polls the existing authenticated status endpoint while a
   prepare request is pending and publishes per-environment stage, elapsed
   time, and blocked-operation count through `DesktopUpdateState`.
4. Protection is default-on. `skipProtection` is accepted only after a previous
   protection attempt failed and the downloaded update remains available. A
   skipped attempt stops the exact snapshotted backend set before invoking the
   updater, but does not call prepare or claim that a verified backup exists.
5. The renderer labels skipped environments honestly and requires an explicit
   acknowledgement before enabling **Install without backup**. Secondary named
   exclusions continue to work independently.
6. Maintenance rejection is a typed RPC error for background provider-usage
   refresh, so an expected update transition cannot become a schema defect.

## State and Trust Boundaries

`apps/server` remains the source of truth for RPC admission and backup stages.
`apps/desktop` remains the only owner of native update installation, process
snapshotting, and the bypass decision received over `DesktopBridge`.
`packages/contracts` remains schema-only. `apps/web` presents progress and
collects explicit user acknowledgement; it cannot stop processes, create
backups, or invoke installers outside the bridge command.

No bypass is persisted as a setting. Each downloaded update attempt starts in
the protected path, and a new download requires a new failed protection attempt
before bypass becomes eligible.

## Failure and Recovery

- A read subscription cannot acquire a mutation permit.
- New mutations remain rejected after maintenance closes admission.
- A prepare timeout retains blocker evidence in the status response and log.
- Failed protection cancels prepared backends and restores the exact prior
  running set before the bypass can be selected.
- A skipped update still stops the exact prior running set. Installer failure
  restarts that set using the existing recovery path.
- A forged first-attempt `skipProtection` request is rejected by the host.
- Progress polling failure does not cancel preparation; the last known stage
  remains visible and the prepare request remains authoritative.

## Compatibility

All desktop-state fields are additive and decode with defaults, preserving
compatibility with older desktop hosts. The Rust server and Tauri coordination
are shared across macOS, Windows, and Linux; platform-specific updater restart
behavior is unchanged.

## Alternatives

- A permanent global “never protect” setting was rejected because it silently
  removes the rollback boundary from every future update.
- An up-front skip button was rejected because it makes the unsafe path the
  fastest routine path. The failure-gated bypass avoids repeated dead ends
  while keeping protection the default.
- Treating every stream as a read was rejected because finite streamed commands
  can perform durable mutations.

## Verification

Focused tests cover method classification, permit diagnostics, preparation
status, host-side bypass eligibility and recovery, contract decoding, bridge
forwarding, and dialog acknowledgement/progress. Repository completion requires
the applicable Rust tests, web/contracts tests, formatting, Clippy, `vp check`,
`vp run typecheck`, final diff/status review, and the native runbooks updated for
macOS, Windows, and Linux validation.
