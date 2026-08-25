# Environment-Owned Project Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver first-class Linux, Windows, macOS, and WSL environments that own independent projects and workspace threads, remove BiBCode Connect, and publish secure server-only installers without weakening current worktree safety.

**Architecture:** Keep every server authoritative for its environment-local domain and federate those environments in the client through durable identities, several verified routes, secure secret references, and bounded encrypted cache. Privileged host work crosses `DesktopBridge` or the server's protected local control channel; normal traffic remains typed HTTP/WebSocket RPC.

**Tech Stack:** Rust 2024, Tokio, Axum, SQLite/rusqlite, Clap, Tauri 2, TypeScript 7, Effect 4, React 19, IndexedDB, Vite+, native Windows/macOS/Linux packaging, GitHub Actions.

**Spec:** [Approved specification set](./README.md)

## Global Constraints

- One server and data root is one environment; do not add `environment_id` to environment-local server tables.
- The same Git common-directory family has one active project per environment; independent clones remain valid.
- Preserve the current worktree catalog, discovery, adoption, detach, retarget, removal-plan, and process-reaping boundaries.
- Main is the existing `kind = "default"` thread, created atomically with its project and protected from rename/archive/delete.
- The client may federate and cache, but it is never authoritative for server projects, threads, worktrees, or processes.
- HTTP/WS is allowed only on a validated loopback listener or inside a client-owned SSH forward. A non-loopback listener requires validated TLS; there is no insecure override.
- Desktop secrets use user-scoped DPAPI, macOS Keychain, or Linux Secret Service. No persistent plaintext fallback is allowed.
- BiBCode Connect, Relay variants, Clerk, managed endpoints, and relay deployment code are deleted, not hidden or aliased.
- There are no permission tiers in this release. Every paired client receives the full non-Connect administrator scope set.
- Telemetry, analytics, usage reporting, remote log drains, and automated crash upload remain forbidden.
- macOS Developer ID signing/notarization is optional; the current credential-free ad-hoc desktop build remains green.
- Every affected living document and native testing runbook changes with the behavior it describes.

---

## Plan Set And Dependency Map

```text
10 identity + project/Main invariants
          |                  \
          v                   v
20 catalog/routes/secrets/cache    30 control/pairing/TLS/services
          |                   |
          +---------+---------+
                    v
          40 WSL + SSH provisioning
                    |
                    v
          50 environment tree/settings/removal UX
                    |
                    v
          60 remove BiBCode Connect
                    |
                    v
          70 server artifacts/CI/docs/final policy
```

| Order | Plan                                                                                                    | Independently testable outcome                                                                   | Depends on                                |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1     | [10 — Identity and project invariants](./10-environment-identity-and-project-invariants.plan.md)        | Durable environment/storage identity split and one repository project/one Main invariants        | —                                         |
| 2     | [20 — Catalog, routes, secrets, and cache](./20-catalog-routes-secrets-cache.plan.md)                   | Multiple verified routes per environment with protected credentials and encrypted scoped cache   | Plan 10 contracts                         |
| 3     | [30 — Control, pairing, transport, and services](./30-server-control-pairing-transport-service.plan.md) | Working local pairing CLI/control channel, DPoP admin sessions, TLS admission, service lifecycle | Plan 10 identity                          |
| 4     | [40 — WSL and SSH provisioning](./40-wsl-ssh-provisioning.plan.md)                                      | All running WSL distros and consent-based Linux/macOS/Windows SSH enrollment                     | Plans 20 and 30                           |
| 5     | [50 — Environment navigation and settings](./50-environment-navigation-and-settings.plan.md)            | Approved left tree, center settings, offline UX, and explicit destructive warnings               | Plans 20–40                               |
| 6     | [60 — BiBCode Connect removal](./60-bibcode-connect-removal.plan.md)                                    | No active Connect/Relay/Clerk/runtime/infrastructure surface remains                             | Direct replacement paths from Plans 20–50 |
| 7     | [70 — Server distribution, CI, docs, and policy](./70-server-distribution-ci-docs.plan.md)              | Server-only artifact matrix, smoke evidence, complete living docs, privacy gates                 | Plans 10–60                               |

## File-Ownership Map

| Boundary                                | Owning plan | Primary paths                                                                                                         |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Durable server/store identity           | 10          | `apps/server/src/persistence/**`, `apps/server/src/lifecycle.rs`, `packages/contracts/src/environment.ts`             |
| Project repository claims and Main      | 10          | `apps/server/src/orchestration/engine.rs`, `apps/server/src/persistence/migrations.rs`, orchestration contracts/tests |
| Client environment/route model          | 20          | `packages/client-runtime/src/connection/**`, `packages/client-runtime/src/platform/**`                                |
| Client persistence and secrets          | 20          | `apps/web/src/connection/storage.ts`, `packages/contracts/src/ipc.ts`, `apps/desktop/src-tauri/src/security.rs`       |
| Server local administration/TLS/service | 30          | `apps/server/src/config.rs`, `auth/**`, `local_control/**`, `service/**`, `lifecycle.rs`                              |
| Desktop WSL/SSH host authority          | 40          | `apps/desktop/src-tauri/src/bridge.rs`, `backend.rs`, `ssh.rs`, IPC/platform adapters                                 |
| Left tree and center settings           | 50          | `apps/web/src/components/Sidebar*`, routes/settings/state/UI stores                                                   |
| Connect deletion/migration              | 60          | `infra/relay/**`, cloud/relay modules, Connect routes/workflows/manifests                                             |
| Packaging/release/docs                  | 70          | `scripts/build-server-*`, `.github/workflows/**`, `docs/**`, package manifests                                        |

## Integration Rules

- Keep every plan commit buildable. Where a wire shape changes, add the new schema and migration reader before switching writers; remove old runtime variants only in Plan 60.
- Do not run Plans 20 and 60 concurrently against the same catalog files. Plan 20 owns the replacement schema; Plan 60 owns the bounded legacy Connect decoder and final deletion.
- Do not run Plans 40 and 50 concurrently against `packages/contracts/src/ipc.ts` or `apps/web/src/connection/platform.ts`; land WSL/SSH contracts first.
- Before each plan begins, rerun `git status --short`, review overlapping user changes, and sync CodeGraph if available under the repository instructions.
- Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before claiming a plan complete.

## Cross-Plan Checkpoints

### Checkpoint A — Server domain foundation

- [ ] Complete Plan 10 and confirm legacy stores retain their storage UUID while gaining one stable environment UUID.
- [ ] Confirm duplicate local repository adds return the existing project/Main and independent clones remain distinct.
- [ ] Run the existing worktree catalog suite unchanged before continuing.

### Checkpoint B — Direct secure connectivity

- [ ] Complete Plans 20 and 30.
- [ ] Prove one environment accepts several matching routes but blocks environment, storage, and certificate mismatches.
- [ ] Prove the catalog contains only secret references and encrypted cache envelopes.
- [ ] Prove `bibcode auth pairing create --format json` works through the protected local channel.

### Checkpoint C — Host discovery and UI

- [ ] Complete Plans 40 and 50.
- [ ] Run native Windows WSL discovery, Linux/macOS/Windows SSH enrollment, and packaged visual runs.
- [ ] Compare the resulting UI with [the approved mockups](./left-panel-mockups.md).

### Checkpoint D — Removal and release

- [ ] Complete Plan 60 before packaging; no release artifact may retain Connect code.
- [ ] Complete Plan 70 and inspect the machine-readable artifact manifest instead of guessing filenames.
- [ ] Run the full repository and native verification matrix below.

## Final Repository Verification

- [ ] Run focused tests listed in every subsystem plan.
- [ ] Run TypeScript/workspace gates:

```sh
vp check
vp run typecheck
vp run test
vp run check:contracts
```

- [ ] Run Rust gates:

```sh
cargo fmt --all --check
node scripts/run-msvc-x64.mjs cargo test --workspace -j 2
node scripts/run-msvc-x64.mjs cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] Run policy/release gates:

```sh
vp test scripts/privacy-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp run release:smoke
node scripts/verify-server-artifacts.ts --manifest release/server/artifacts.json
```

- [ ] Run the native Windows, macOS, Linux, WSL, SSH, worktree, process-lifecycle, and packaged-visual procedures under `docs/testing/` and record results from `docs/testing/execution-report-template.md`.
- [ ] Review `git diff --check`, `git diff --stat`, `git diff`, and `git status --short` for generated files, dependency drift, debug output, missing docs, or unrelated edits.
- [ ] Scan active source and living docs for Connect/telemetry remnants using the exact allowlist in Plan 60.
- [ ] Commit the final integration verification only after every required command either passes or has a documented platform-specific limitation and residual risk.
