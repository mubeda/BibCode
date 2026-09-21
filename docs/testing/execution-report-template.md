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

## Pull Requests evidence

- Packaged sidebar route smoke (`pierre-pull-requests-route.png`), native target and exact executable:
- Authenticated read-only list → detail → Files smoke: request, route/`tab=files`, real patch and reload screenshots:
- Unavailable/no-remote fixture evidence (separate from list/detail/files pass):
- Web zero-telemetry regression: image/avatar fixtures, actor initials, idle hour and explicit query/action counts:
- Server source/command tripwires, complete module inventory and checkout deadline exception:
- Listener-bound checks blocked with exact command, test name and bind error (never passed/skipped):
- Separate GitHub and GitLab live-host outcomes; unavailable host/authentication and remaining verification:

- Review surface: comment/edit/delete confirmation, reactions, reply/resolve,
  gutter single/range anchors, pending counter, suggestion single/batch apply,
  dismissal message/confirmation, reviewer re-request:
- Draft navigation/reload/failure retention and loaded-head submission:
- Full/partial/zero-landed receipts, posted-summary handling, failed-body matching, and stale-head Refresh:
- Checkout current/other/new worktree, branch/head, dirty/in-progress/occupied guards:
- Checkout project/repository identity proof, divergent/occupied PR-suffix naming and free matching-branch reuse, catalog owner/sidebar evidence:
- Initial-only worktree loading status in Pull Requests/Git Manager, including empty snapshots and visible catalog errors:
- Checkout pre-write cancellation versus background write completion after disconnect/deadline/admission loss, retained locks/admission, clean tree/no stale index.lock, shutdown drain/bounds and reconnect refresh:
- Checkout Git-failure recovery via git status, current eligibility on toast retry, and explicit Git Manager result navigation:
- Unsupported host and environment mutation denial reasons:

- Project/environment, selected checkout, provider/host, and evidence class:
- Advertised read/mutation capabilities and client setting:
- List/detail route persistence and grouped-row highlighting:
- Server detail/tab RPC shapes and permission/readiness reason inventory:
- Reviewer/version gates, timeline ids/positions, nullable check timing/grouping:
- Review action argv/env/body evidence, private-file mode and cleanup:
- GitLab Note-subtype GlobalIDs, inline suggestion reads and label/milestone resource events:
- Cold/warm per-action process counts, bounded context expiry/Rescan and fresh permission/head refusals:
- Fresh denial/stale-head no-mutation evidence and duplicate-toggle no-ops:
- GitHub atomic / GitLab partial review failures, posted counts and refresh-before-retry:
- New GraphQL documents and separate live-host validation or exact blocked error:
- Diff refs, binary rows, per-file/whole-patch caps, and pagination limits:
- Per-host authentication display and account redaction:
- Tabs/counts, filters, lazy vocabularies, pagination, Refresh, and scroll restoration:
- Detail active-tab reads, cached-open refresh, and authentication recovery:
- Conversation kinds, remote-image links, file anchors, and responsive metadata:
- Real GitHub/GitLab FileDiff shapes, lazy mounting, Viewed persistence and whitespace:
- Merge readiness states/defaults and every disabled control's hover/screen-reader reason:
- Title/description Save, Cancel/Escape, Preview, and reload/failure draft retention:
- Lazy metadata/branch pickers, truncated-search debounce, exact deltas, numeric milestone Clear, and five-second Undo:
- Undo during another action, disabled picker controls until post-Undo detail refresh, correct next-toggle direction, refresh failure/Retry, and late initial vocabulary response:
- Base-change pending-comment warning, cancel/failure preservation, and success-only clearing:
- Merge confirmation method/target/deletion/auto/bypass, loaded-head pinning and retained merge-message drafts:
- Read-only merge without a method selector; GitHub auto/bypass exclusion; GitLab current dual permission:
- Auto-merge enabled versus merged result, Disable, Update branch/Rebase and GitLab Skip CI:
- Draft/state/lock actions, host lock reasons, Revert creation/navigation and permanent GitLab Delete/list navigation:
- Partial-progress messages, no automatic write retry, late completion without navigation hijack, and no Base UI console errors:
- Edit/merge/state exact commands, numeric milestone lookup, and full-list people updates:
- Merge head/method/permission rejections, bypass ordering, auto-merge result, and private message transport:
- Revert branch/commit/create sequence, per-step failures and partial progress, GitLab deletion, and new live GraphQL validation:
- Rescan after origin/account changes; absence of stale rows/picker data:
- Unavailable/error messages, copyable auth advice, Retry, and Clear filters:
- Disconnected-environment behavior and no unintended connection:
- Git Manager link checkout scope and creation-dialog cancellation:
- Module DOM/network/idle evidence (no external images or provider polling):
- React best-practice review and UI.md review:
- Blocked commands and exact errors; browser/native scenarios still unverified:

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
