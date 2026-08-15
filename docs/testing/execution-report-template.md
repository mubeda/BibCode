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

## Workspace and static gates

| Command                                                       | Result/exit code | Duration | Test totals or warning summary |
| ------------------------------------------------------------- | ---------------- | -------- | ------------------------------ |
| `vp run test`                                                 |                  |          |                                |
| `cargo test --workspace -j 2` or documented native equivalent |                  |          |                                |
| `vp check`                                                    |                  |          |                                |
| `vp run typecheck`                                            |                  |          |                                |
| `cargo fmt --all --check`                                     |                  |          |                                |
| Relevant Clippy with `-D warnings`                            |                  |          |                                |
| `git diff --check`                                            |                  |          |                                |

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
