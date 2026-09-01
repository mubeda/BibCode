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

## Git Manager evidence

- Project/environment and selected checkout:
- Environment kind: Local | WSL direct | SSH/server | Other remote | Unavailable
- Advertised Git Manager capabilities:
- Repository shape: ordinary | linked worktrees | unborn | detached | conflicted
- Idle interval provider/browser request evidence:
- Streaming operation event sequence and cancellation result:
- Competing catalog/Git Manager mutation and `operation-in-flight` result:

| Scenario                                                            | Result | Screenshot, command, or log evidence | Findings and unavailable behavior |
| ------------------------------------------------------------------- | ------ | ------------------------------------ | --------------------------------- |
| Open from the project-header button and route persistence           |        |                                      |                                   |
| Main checkout and linked-worktree selection                         |        |                                      |                                   |
| Changes, file diff, partial-stage gutter, commit/amend/undo/discard |        |                                      |                                   |
| History paging, selected commit, and commit diff                    |        |                                      |                                   |
| Branch create/checkout/rename/delete and occupied-branch redirect   |        |                                      |                                   |
| Fetch/pull/push/publish/force-with-lease states                     |        |                                      |                                   |
| Native stash list, entry diff, apply/pop/drop, and merge preview    |        |                                      |                                   |
| In-progress and conflicted repository presentation                  |        |                                      |                                   |
| Tag create/delete/push and all four image-diff modes                |        |                                      |                                   |
| Explicit pull-request/check refresh and no idle provider refresh    |        |                                      |                                   |
| Disconnect/reconnect and one missing-capability degradation         |        |                                      |                                   |
| Local-only author identity and no external image source             |        |                                      |                                   |
| Two-project selection, filter, tab, and repository-data isolation   |        |                                      |                                   |
| Three-project visit with two-entry least-recently-used eviction     |        |                                      |                                   |
| Manual idle third-party Network and rendered-image-source check     |        |                                      |                                   |

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

| Kind | Artifact | Absolute path | Version/architecture | Identity/trust verification |
| ---- | -------- | ------------- | -------------------- | --------------------------- |
|      |          |               |                      |                             |

## Standalone server distribution evidence

- Exact staged or installed executable:
- Packaged web discovery result:
- Environment descriptor result:
- Pairing/token-exchange result:
- Shutdown/exit result:
- Checksum result:
- Optional Minisign result or explicitly unsigned state:
- Package install/remove result, when applicable:
- Isolated data sentinel preserved after removal:
- Container image and native architecture, when applicable:

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
