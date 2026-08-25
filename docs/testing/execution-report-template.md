# Platform Validation Execution Report

**Result:** PASS | PASS WITH RESIDUAL RISKS | BLOCKED | FAIL

Delete the unused result values above. Do not leave an ambiguous status.

## Tested revision

- Repository:
- Remote:
- Branch or requested revision:
- Local HEAD:
- Remote HEAD:
- Merge base and ahead/behind:
- Dirty state before execution:
- Dirty state after execution:

## Native environment

- Operating system and release/build:
- Architecture:
- Kernel:
- Desktop environment/display protocol, when applicable:
- Rust/Cargo:
- Node/package manager/Vite+:
- Native compiler/SDK/runtime dependencies:
- Optional capabilities such as WSL, signing, or notarization:

## Requested inputs and ancestry

- Expected product version:
- Observed version sources:
- Required commits:
- Ancestry result for each commit:
- Inputs that were unavailable:

## Focused validation

| Command | Result/exit code | Duration | Evidence and warnings |
| ------- | ---------------- | -------- | --------------------- |
|         |                  |          |                       |

## Environment, project, and Main invariants

- Environment UUID before/restart/restore:
- Storage-instance UUID before/restart/restore:
- UUIDs distinct and explicit start-empty rotation:
- First project add disposition and project/Main IDs:
- Same-path duplicate disposition and IDs:
- Linked-worktree duplicate disposition and IDs:
- Independent-clone disposition and IDs:
- Same repository on another environment result:
- Active Main count after migration/restart/replay:
- Main rename/archive/delete rejection:
- Ambiguous legacy migration diagnostic IDs:
- Existing worktree suite result and unchanged-behavior evidence:

## Environment catalog, routes, secrets, cache, and cleanup

- v1 direct migration route/result and receipt count:
- v1 Relay-only discarded counts and negative secret/metadata evidence:
- Corrupt input quarantine/recovery result:
- Secret provider used and unavailable/locked fail-closed result:
- Renderer/IndexedDB credential negative evidence:
- Cache persistence mode: Durable | Session-only | Unavailable
- Cache ciphertext/AAD scope, tamper, stale-revision, and eviction result:
- Cross-environment duplicate route/binding rejection:
- Route order, first-route outcome, active route, and active session count:
- Offline cancellation/cache presentation result:
- Stale environment/route/admission generation result:
- Hide/restore runtime-retention result:
- Single-route removal and retained-environment result:
- Forget ordered lifecycle result:
- Injected secret/transaction failure and redacted repair receipt result:
- Restart with pending repair and successful retry result:
- Remote server/projects/worktrees/data retained after local Forget:

## Listener, authentication, and local-control evidence

- Loopback HTTP listener address/PID and admission result:
- Plain non-loopback HTTP rejection and no-override evidence:
- Direct HTTPS listener address/PID:
- Certificate hostname/chain/date result:
- Trust source: System trust | Explicit SPKI pin | Unavailable
- Wrong/untrusted certificate result:
- Exact HTTPS DPoP URL/method/replay result:
- Pairing five-minute expiry, race, retry, and redaction result:
- WebSocket one-use/revocation-close result:
- Unix socket parent/mode/owner/wrong-UID result:
- Windows named-pipe DACL/remote rejection/SID/impersonation result:
- Public service-view redaction result:
- Network host-action rejection and allowed channels:

## Service and update lifecycle evidence

- Mode: Workstation | Headless
- Native manager/definition identity:
- Authority/account and insufficient-authority result:
- Data root and loopback bind:
- Status before install:
- Install/idempotence/single-instance result:
- Definition mismatch and explicit update result:
- Partial-install rollback and pre-existing-account result:
- Stop drain/admission/owned-child reap result:
- Restart environment/storage identities:
- Update operation/backup/phase/target version:
- Expected-version reconciliation result:
- Interrupted/mismatched recovery result:
- Uninstall registration/account result:
- Preserved data/environment/projects/worktrees evidence:
- Final native service/socket/pipe/process survivor result:

Repeat this section for every tested mode. Keep adapter simulations and
cross-target checks under non-native compatibility evidence.

## WSL provisioning evidence

- Native Windows/WSL versions and distro state:
- Discovery generation / setup generation:
- Target version / architecture / signed artifact tuple and byte count:
- Consent shown / declined / one-use replay / concurrent request results:
- Missing tar / disk / trust / size / checksum failure results:
- Transfer cancellation and child/I/O join result:
- Atomic switch and previous-target preservation result:
- Restart and descriptor version/platform/protocol/identity result:
- Managed current path and development fallback result:
- Loopback listeners/forward and unrelated-process survivor result:
- Final staging cleanup and mutation/cleanup status:

## SSH trust, descriptor, and pairing evidence

- Native desktop / OpenSSH client / disposable remote OS:
- Effective SSH config source / alias / port:
- Known / unknown / changed-or-revoked host-key results:
- Observed and saved non-secret host-key fingerprint result:
- Trust / probe / server / tunnel / descriptor ordered result:
- Same-process host-key gate before launch/stop/pairing script bytes:
- Numeric-loopback listeners and non-loopback/redirect/proxy rejection:
- Descriptor byte bound and environment/storage/protocol result:
- Exact native descriptor refetch result:
- Mismatch-before-pairing negative evidence:
- Native pairing create/redeem and raw-credential negative evidence:
- Authenticated credential-free managed/`--no-startup-pairing` startup result:
- OS-secret persistence-before-route/session result:
- Route-cancellation support and shutdown SSH/askpass/tunnel/I/O survivor result:

## VCS observation evidence

- Execution host and route: Native | WSL direct | SSH/server | Unavailable
- Physical repositories/worktrees/active full subscribers/passive subscribers:
- Watcher health and fallback state:
- Automatic-fetch interval and passive-summary interval:

| Scenario                           | Signal source | Git launches after baseline | Publication result | Evidence class |
| ---------------------------------- | ------------- | --------------------------- | ------------------ | -------------- |
| Idle through 59 seconds            |               |                             |                    |                |
| 60-second safety boundary          |               |                             |                    |                |
| Worktree/index/HEAD/refs           |               |                             |                    |                |
| Structured terminal exit           |               |                             |                    |                |
| Overflow/setup unavailable         |               |                             |                    |                |
| Reconnect/hidden/reveal/focus/menu |               |                             |                    |                |

## Workspace and static gates

| Command                                                                           | Result/exit code | Duration | Test totals or warning summary |
| --------------------------------------------------------------------------------- | ---------------- | -------- | ------------------------------ |
| `vp run test`                                                                     |                  |          |                                |
| `cargo test --workspace -j 2 -- --test-threads=2` or documented native equivalent |                  |          |                                |
| `vp check`                                                                        |                  |          |                                |
| `vp run typecheck`                                                                |                  |          |                                |
| `cargo fmt --all --check`                                                         |                  |          |                                |
| Relevant Clippy with `-D warnings`                                                |                  |          |                                |
| `git diff --check`                                                                |                  |          |                                |

## Native package artifacts

| Artifact | Absolute path | Version/architecture | Identity/trust verification |
| -------- | ------------- | -------------------- | --------------------------- |
|          |               |                      |                             |

## Packaged UI and visual evidence

| Scenario | Screenshot absolute path | State | Pixel-review finding |
| -------- | ------------------------ | ----- | -------------------- |
|          |                          |       |                      |

- Exact executable launched:
- Exact PID/start identity:
- Other installed or development copies excluded:
- External tool, command, and path used for the Files Refresh rescan:
- Authentication-dependent scenarios unavailable:

## External-worktree scenario

- Disposable repository root:
- Git-reported worktrees:
- Physical/path-alias identities:
- Discovery result:
- Adoption/idempotence result:
- Restart result:
- Hide/remove non-destructive result:
- Final on-disk verification:

## Process and temporary-root cleanup

- Before snapshot:
- After snapshot:
- Scoped surviving processes:
- New test-owned roots:
- Pre-existing roots/processes intentionally left untouched:
- Package mounts or platform resources released:

## Non-native compatibility evidence

### Platform

- Evidence class: Compatibility evidence | Unavailable evidence
- Source/contracts reviewed:
- Commands and results:
- Native-only evidence still required:

Repeat the subsection for every non-native supported platform.

## Source changes and commits created

- Files changed:
- Behavioral reason:
- RED evidence:
- GREEN evidence:
- Local commits:

## Commands not run

| Command or scenario | Reason | Required follow-up owner |
| ------------------- | ------ | ------------------------ |
|                     |        |                          |

## Residual risks

- Risk:
- Impact:
- Evidence that bounds it:
- Required follow-up:

## Publication state

- Commits created:
- Pushed: yes/no
- Branch merged: yes/no
- Pull request opened: yes/no
- Artifacts published: yes/no
