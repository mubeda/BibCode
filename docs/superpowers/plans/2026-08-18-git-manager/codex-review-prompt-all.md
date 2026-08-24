You are a senior Rust + TypeScript engineer reviewing an implementation plan and its decomposition for the BiBCode repository. Review the PLAN and its PHASES — not the product decision to build a Git manager, which was settled with the author. This is a READ-ONLY review: modify nothing, and cite `file:line` for every claim you make.

# Repo

Run from the repo root: `X:/Workspaces/BiBCode/BibCode/develop-5` (a git worktree of the BiBCode monorepo, branch `develop-5`, Windows host).

Stack: a Rust/Axum/Tokio application server (`apps/server`, crate `bibcode-server`) that owns all Git execution, HTTP/WebSocket RPC, persistence and process supervision; a React 19 + Vite+ frontend (`apps/web`); schema-only Effect `Schema` wire contracts (`packages/contracts`); a Tauri 2 desktop host (`apps/desktop`). Gates: `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server`, and `vp check` / `vp run typecheck` / `vp test` for the TypeScript side (`vp` is the Vite+ CLI; `vp test` is the built-in test command, `vp run test` is the package-script graph).

# What you're reviewing

A feature plan for a **Git Manager**: a project-scoped panel in the BiBCode UI showing branches, remote branches, tags and worktrees, a Fork-style lane commit graph with commit detail and diffs, and fetch/pull/push/merge plus branch/tag lifecycle operations — with every blocked action explaining itself on hover. The plan folder is `docs/superpowers/plans/2026-08-18-git-manager/`.

Two artifacts are under review:

- **Part 1 — the master plan** (`master-plan.md`): judge it for fidelity to the actual repo, technical correctness, soundness of its key decisions, completeness against the spec, and internal consistency.
- **Part 2 — the decomposition** (13 phase files + `tasks.md` + `execute-plan.md` + `handoff.md`): judge whether it covers the master plan, whether its rounds/dependencies/file-conflict claims hold, and whether a fresh teammate could execute each phase from its file alone.

Review Part 1 first — the decomposition is judged against the master plan.

Nothing has been implemented yet. There is no code diff to review; the deliverable is the plan.

# Onboarding — read these first (in order)

## A. The plan under review

- `docs/superpowers/plans/2026-08-18-git-manager/master-plan.md` — the master plan. Contains Global Constraints, Technical Requirements, a seven-phase Implementation Outline with concrete Effect schemas, Test Configuration, Validation & Testing, 13 Acceptance Criteria, Success Criteria, Alternatives Considered, and Skill-operator notes. This is the primary subject of Part 1.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-00-contracts.md` — Round 0: all contracts, front-loaded so `rpc.ts` is written once.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-01-server-read-rpcs.md` — Round 1: `graph.rs` / `refs.rs` / `guards.rs` + the four read RPCs and their registration.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-02-web-shell-and-route.md` — Round 1: project route, panel shell, LRU store, sidebar button, four region placeholders.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-03-lane-layout-module.md` — Round 1: the pure incremental lane-layout algorithm.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-04-server-operations.md` — Round 2: the streaming `git.runRepositoryOperation` executor, per-repository lock, failure classification.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-05-ref-tree.md` — Round 2: the ref tree and guard rendering.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-06-commit-graph.md` — Round 2: virtualized graph rendering.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-07-server-live-signal.md` — Round 3: broadcaster signature + `subscribeVcsGraph`.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-08-commit-detail.md` — Round 3: commit detail pane + diff.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-09-operations-ui.md` — Round 3: toolbar, progress banner, push/merge/conflict dialogs.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-10-branch-tag-lifecycle.md` — Round 4: create/delete/rename dialogs and the ref context menu.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-11-live-refresh-wiring.md` — Round 4: client subscription and revalidation policy.
- `docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-12-docs-and-verification.md` — Round 5: living docs + the whole-feature gate.
- `docs/superpowers/plans/2026-08-18-git-manager/tasks.md` — the tracker: phase table, round/dependency graph, the four **file-conflict matrices** (verify these independently), and Coordination Notes recording decomposition-time decisions.
- `docs/superpowers/plans/2026-08-18-git-manager/execute-plan.md` — the coordinator prompt: round dispatch rules, teammate prompt shape, hard rules.
- `docs/superpowers/plans/2026-08-18-git-manager/handoff.md` — the review scaffold the coordinator fills after the last round.
- `docs/superpowers/plans/2026-08-18-git-manager/screenshots/` — nine screenshots of Fork, the UI this feature is modelled on. Read only if you can view images; the plan's § Attachments table describes each one.

## B. Source of truth

- `docs/superpowers/plans/2026-08-18-git-manager/issue.specs` — the author's own spec plus an appended `## Interview Notes` section recording every scope decision (surface, history depth, merge-conflict handling, operations in v1, progress/error presentation, live updates, guards, explicit exclusions). **Every plan requirement must trace back to this file.** Where the plan and this file disagree, the file wins.
- `AGENTS.md` (repo root) — the repository's binding engineering rules: required pre-work, package roles and permitted dependency direction, architectural decision standards, log hygiene, testing-runbook maintenance, and the Task Completion Requirements the plan must satisfy. Treat violations of this file as findings.

## C. Repo surface to verify the plan's file:line references and factual claims

### Contracts (`packages/contracts` — schema-only by rule)

- `packages/contracts/src/git.ts` — existing Git schemas. Verify the plan's claim that `VcsCommit` (~line 360) has **no** parent SHAs and **no** ref decorations, which is the justification for a whole new commit-graph schema rather than extending it. Check the shared base schemas the plan reuses exist with those exact names.
- `packages/contracts/src/rpc.ts` — `WS_METHODS` (~line 306) and the `Rpc.make` declarations (e.g. `WsVcsListRefsRpc` ~line 764). Confirm which VCS methods already exist (`vcs.listRefs`, `vcs.listCommits`, `vcs.pull`, `vcs.createRef`, `vcs.switchRef`, …) so you can judge what the plan genuinely adds versus duplicates.
- `packages/contracts/src/review.ts` — `ReviewDiffPreviewInput` / `ReviewDiffPreviewSourceKind`. The plan originally proposed extending this for commit diffs and then rejected it; verify the rejection reasoning against `auth/scope.rs` below.
- `packages/contracts/src/index.ts`, `packages/contracts/src/git.test.ts` — the export barrel and the schema-test pattern Phase 00 must follow.

### Server (`apps/server`)

- `apps/server/src/git/repository.rs` — the 210 KB Git module. Verify: `git_environment()` (~line 4261) really sets `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GIT_CONFIG_NOSYSTEM=1` (the plan's whole "credential prompts fail fast, never hang" argument rests on this); `push_current_branch` (~line 2727) and the pull path exist and are what Phase 04 should delegate to; `list_refs` (~1189) and `list_commits` (~1316) shapes; and the fixture-repo test helpers (~5772) the phases tell teammates to reuse.
- `apps/server/src/git/broadcaster.rs` — `StatusBroadcaster`. The plan asserts this is an **interval poller** with per-repository state, subscriber fan-out, an immediate-refresh channel (`local_refresh_requests`) and remote-failure backoff — and that "live updates" can therefore be a signature check on the existing tick with **no second timer and no filesystem watcher**. Verify that claim against the actual implementation; if extending it cleanly is harder than the plan implies, that is a Major finding.
- `apps/server/src/production/git_vcs.rs` — RPC dispatch. Verify `GIT_VCS_STREAM_METHODS` (~line 192), the unary dispatch pattern (`"vcs.listRefs" =>` ~line 404), and the `git.runStackedAction` streaming handler (~line 988) with its `guard_git_path` admission and child cancellation token — the plan cites this as the precedent for its single streaming operation method.
- `apps/server/src/auth/scope.rs` — `required_scope`. Verify two load-bearing claims: read-only VCS methods map to `SCOPE_ORCHESTRATION_READ` (~lines 35-60), and `review.getDiffPreview` maps to `SCOPE_REVIEW_WRITE` (~line 109) — the sole justification for adding a separate read-scoped `vcs.commitDiff`.
- `apps/server/src/rpc/methods.rs` — `ACTIVE_RPC_METHODS` (~line 30) and the `unary(...)` registration list.
- `apps/server/src/rpc/session.rs` — how `ACTIVE_RPC_METHODS` is consumed (~line 278). **Critical for Part 2:** the decomposition front-loads all six method declarations into the TypeScript contracts (Phase 00) while the Rust registrations land across Phases 01/04/07. It claims nothing asserts parity between `WS_METHODS` and `ACTIVE_RPC_METHODS`. Verify this — including whether any client-runtime code or test iterates the RPC group and expects server support. If a parity check exists anywhere, Phase 00 breaks Rounds 0-2 by design.
- `apps/server/src/maintenance.rs` — the read-only method allowlist the read RPCs must join.
- `apps/server/src/git/process.rs` — `ProcessRequest`: timeout, `max_output_bytes`, `OutputPolicy`, cancellation. Judge whether the plan's new git invocations (paged `git log`, `for-each-ref`, `git show --patch`, streaming fetch/push output) fit this supervised path, especially output caps for large diffs and streamed progress.
- `apps/server/src/git/{mod,parser,model}.rs` — module wiring and existing parsing conventions the new `graph.rs` / `refs.rs` / `guards.rs` must match.
- `apps/server/src/review/mod.rs` — the existing diff-preview production and truncation policy Phase 04/Phase 01 are told to reuse for commit diffs.
- `apps/server/Cargo.toml` — crate name (`bibcode-server`) used in every phase's test/clippy commands.

### Web (`apps/web`)

- `apps/web/src/components/Sidebar.tsx` — 4,685 lines. Verify the anchor the plan gives for the new button: the project-header icon row and `data-testid="new-worktree-button"` around **lines 3037-3069**, and the project-header click handler the plan wants to extend for "restore the open project view".
- `apps/web/src/centerPanelStore.ts` — verify the plan's claim that center-panel state is **thread-keyed** (`byThreadKey`, surfaces `chat-host` / `chat` / `terminal`), which is why the plan introduces a separate project-keyed store instead of reusing it. Judge whether a separate store is right or whether this should extend the existing surface model.
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` and `apps/web/src/routes/_chat.tsx` — the sibling route shape the new `_chat.project.$environmentId.$projectId.tsx` must match (TanStack Router file conventions, route generation).
- `apps/web/src/state/vcs.ts` — the existing VCS atom pattern Phase 02's `state/gitManager.ts` must follow.
- `apps/web/src/components/CreateWorktreeDialog.tsx` — the dialog + RPC-command + interruption-handling pattern all the new dialogs are told to copy.
- `apps/web/src/lib/diffRendering.ts` and `apps/web/src/components/DiffPanel.tsx` — the diff helpers Phase 08 reuses, and the thread-coupled panel it must NOT reuse wholesale.
- `apps/web/package.json` — verify the "no new dependency" claim: `@legendapp/list`, `@pierre/diffs`, `@base-ui/react`, `zustand`, `lucide-react` are present and there is no virtualization/graph library the plan overlooked.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — an existing consumer of both `@legendapp/list` and `@pierre/diffs`; use it to judge whether the plan's virtualization and diff-rendering assumptions are realistic.

### Living documentation the plan must respect and update

- `docs/architecture/rpc-and-orchestration.md` — session establishment, wire protocol, server composition, and the rule that a live method needs exactly one declared scope. The plan's RPC additions must fit this model.
- `docs/architecture/worktree-catalog.md` — repository identity, physical-path identity, availability admission and mutation arbitration. The plan's per-repository operation lock and its "worktrees come from the catalog, not a second `git worktree list`" rule are judged against this.
- `docs/architecture/overview.md` — package roles and runtime topology.
- `docs/reference/scripts.md` — the real `vp` command set (verify the plan's commands exist and mean what it says).
- `docs/testing/README.md` — the runbooks `AGENTS.md` requires updating when RPC surface, packaged UI flows, or validation evidence change; Phase 12 owns this.
- `docs/user/workspace-ui.md`, `docs/README.md` — the user-facing doc and index Phase 12 updates.
- `.repos/effect-smol/LLMS.md` — `AGENTS.md` requires reading this before writing Effect code; the contracts phase cites it. Confirm it is a usable substitute for the missing Effect-specific skill.

## D. Optional calibration (read if accessible)

- `docs/superpowers/plans/2026-07-01-source-control/00-overview.md`, `03-staged-unstaged-index.md`, `04-commits-history.md` — the shipped, archival plan set that built the thread-scoped source-control panel and `vcs.listCommits`. Closest prior art in this repo; `03` carries an RPC registration checklist. Historical, so its paths may be stale — useful for judging whether the new plan's registration story is complete, and whether it duplicates or conflicts with what already shipped.
- `docs/superpowers/README.md` — states that this tree holds immutable engineering history. Note that this plan is in-flight work placed there at the user's request; that is a known, deliberate deviation, not a finding.

---

# Part 1 — Master plan review

# How to perform the review

Review the master plan for correctness, completeness, faithfulness to the actual repo, and executability. Judge the PLAN — not the underlying product decisions, which were settled in the interview recorded in `issue.specs`. Where the plan contradicts the source-of-truth spec, flag it; where you merely disagree with a settled decision, note it as out-of-scope for this review.

## 1. Fidelity to ground truth (verify, don't trust)
- Open the files in onboarding group C and confirm that EVERY `file:line` reference in the plan resolves to the surface area the plan claims. List any that are wrong, stale, or off by more than a few lines.
- Confirm the plan's statements about the current code are TRUE. The load-bearing ones: `git_environment()` makes git non-interactive; `StatusBroadcaster` is an interval poller with an immediate-refresh channel; `review.getDiffPreview` is write-scoped; `VcsCommit` carries no parents or decorations; `centerPanelStore` is thread-keyed; the new-worktree button sits where the plan says; no new dependency is needed. Read the code and verify each. Flag any claim the code contradicts.
- Watch for stale assumptions — a tool, file, or approach the repo has since changed.

## 2. Technical correctness
- Does the approach achieve the goal? Walk the critical path end-to-end: contracts → server reads + guards → client shell → graph → operations → live signal, and confirm each step does what the plan assumes.
- Scrutinise the keystones: (a) the **server-computed guard model** — can the server really produce per-ref blocked reasons for every code the plan lists (`worktree-checked-out`, `dirty-working-tree`, `operation-in-flight`, `merge-in-progress`, `protected-branch`, `current-branch`, `no-upstream`, `detached-head`, `no-remote`) from one refs snapshot, and is a repo-wide condition like dirty-tree sensibly modelled per-ref? (b) the **per-repository operation lock** keyed by canonicalized common directory — does it compose with the availability admission and mutation arbitration in `docs/architecture/worktree-catalog.md`, and can it leak on cancellation or panic? (c) the **paged `git log --all --skip N`** model — is `--skip` a correct and stable cursor when the repository changes between pages, and does the plan's `generation` field actually protect against it?
- Check edge cases and ordering: empty repository, detached HEAD, no remotes, a repository shared by several projects, an operation cancelled mid-push, a merge left conflicted across a server restart.
- Confirm the plan's verification steps would really exercise the change with `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `vp test`, `vp run typecheck`, `vp check`.

## 3. Soundness of the key decisions
Give a definite verdict, with evidence, on each of these — they are the plan's high-judgment calls:
- **One streaming `git.runRepositoryOperation`** carrying an 11-variant tagged union, versus a method per operation. The plan cites `git.runStackedAction` as precedent. Is the fat method right here, or does it over-couple unrelated operations and complicate scoping/auditing?
- **Read-scoped `vcs.commitDiff`** instead of extending `review.getDiffPreview` — verify the scope evidence and judge whether duplicating diff production is the lesser evil.
- **Client-side lane layout** with the server shipping only the DAG. Correct division, or should the server own it?
- **Extending the existing poller** for live updates rather than adding a watcher — is the staleness acceptable given the plan's own claim that agent threads commit into these repositories continuously?
- **Merge policy**: refuse on dirty tree, stop on conflict, ask the user to abort or keep. The "keep conflicted state" branch leaves the repository mid-merge — assess the blast radius for the rest of BiBCode (running threads, worktree operations, the status broadcaster) and whether the plan's `mergeInProgress` handling is sufficient.
- **A project-scoped center-panel route with a two-project LRU cache** — does this satisfy the spec's "popup window, only one instance per project" requirement as recorded in `issue.specs` § Interview Notes, or does it drift from what the author asked for?

## 4. Completeness / coverage
- Map every requirement in `issue.specs` (including every decision in `## Interview Notes`) to plan work. List anything DROPPED and anything INVENTED (plan work not traceable to the spec).
- Confirm the cross-cutting items `AGENTS.md` demands survive: focused tests per changed behavior, broader checks at package/runtime boundaries, `vp check` + `vp run typecheck`, Rust fmt/clippy/tests, living-documentation updates in the same change, testing-runbook maintenance, and the final `git diff` / `git status` review.
- `AGENTS.md` § Architectural Decision Standards requires an approved design document recording alternatives and trade-offs before implementing a non-trivial architectural decision. Judge whether this plan's § Alternatives Considered satisfies that, or whether a separate design doc is owed.

## 5. Internal consistency & executability
- Are names, schema field names, method names and terminology consistent across § Technical Requirements, the Implementation Outline, § Acceptance Criteria and § Success Criteria? (Specifically: `VcsGraphOperationKind` values versus the `GitRepositoryOperation` tags; `generation` usage across the two reads and the finished event; `mergeInProgress`/`conflictedPaths`.)
- Is the plan concrete enough to execute? Flag any placeholder, "TBD", or step that says WHAT without HOW where HOW matters.
- Are the out-of-scope list and the success criteria believable and measurable? Is "first commit-graph page under ~1 s on a repository with tens of thousands of commits" achievable with the described `git log` + client layout approach?

**Scrutinise especially:**
- The guard model's completeness and its per-ref versus repo-wide modelling — the whole UX rests on the server's reasons being right and exhaustive.
- The `--skip`-based paging cursor under concurrent repository mutation.
- The claim that the existing broadcaster can carry the live signal cheaply; read `broadcaster.rs` before accepting it.

---

# Part 2 — Decomposition review

# How to perform the review

Review the DECOMPOSITION — whether it faithfully covers the master plan, whether its round/dependency/file-conflict structure is sound, and whether a fresh teammate with zero prior context could execute each phase from its file alone. Do not re-review the master plan's technical decisions (Part 1 covers those); do flag any place a phase contradicts the master plan.

## 1. Coverage / traceability (most important)
- Build a matrix: every master-plan unit of work (each of its seven implementation phases, each Technical Requirement, each of the 13 Acceptance Criteria) → the PHASE file that implements it. List every ORPHAN (nothing covers it) and every INVENTION (phase work not in the master plan).
- Confirm the easily-dropped items survived the split: log hygiene, the non-interactive git environment, living-documentation updates, testing-runbook maintenance, the accessibility requirements, and the "no new dependency" constraint.

## 2. Round structure & dependencies
- Re-derive the dependency graph from each phase's "Dependencies" and "Files". Is the sort into six rounds correct? Could any phase in a parallel round actually depend — by data or by file — on a sibling in the same round?
- Check each stated dependency: real and complete, or overstated/missing? Specifically: does Phase 05 (ref tree) really only need Phase 02, given it renders server guard data produced by Phase 01 in the same earlier round? Does Phase 09 need Phase 05, or only Phase 04? Is Phase 07's dependency on Phase 04 justified?

## 3. File-conflict matrix (verify independently, don't trust)
- Re-derive each phase's Create/Modify set from its "Files" section and check the four matrices in `tasks.md` against your derivation. Rounds 1, 2, 3 and 4 all claim to be conflict-free.
- The decomposition rests on two structural mechanisms: (a) exactly **one server phase per round** owns the shared Rust registries (`git/mod.rs`, `production/git_vcs.rs`, `rpc/methods.rs`, `auth/scope.rs`, `maintenance.rs`); (b) the web hub `GitManagerView.tsx` renders four **region files** created as placeholders by Phase 02, each later web phase replacing exactly one. Judge both: do they actually eliminate the conflicts, or do they merely hide coupling (for example, does a phase realistically need to touch `GitManagerView.tsx` or a sibling's file to finish its work)?
- Note that all teammates share one working tree — no per-phase git worktree isolation is used. Assess the consequences for full-workspace gates and for any file a phase reads while a sibling writes it.

## 4. Phase self-containment & executability
- For each phase, could a fresh teammate with NO other context execute it from that file alone? Phases cite `../master-plan.md` sections for schema listings rather than repeating them — judge whether that is acceptable delegation or a reconstruction burden.
- Are the atomic steps right-sized and test-first where the phase delivers code? Is the TDD-proof step (deliberately break the implementation, confirm the tests fail, restore) meaningful in each case, or ceremonial in some?
- Check that the test commands in each phase are real for this repo (`vp test <path>`, `cargo test -p bibcode-server <filter>`) and that the assertion/test-library idioms named match what the repo actually uses — read an existing test in both languages and compare.

## 5. file:line accuracy (spot-check against the repo)
- The phases inherit `file:line` hints from the master plan (`Sidebar.tsx:3037-3069`, `git_vcs.rs:988`, `repository.rs:2727`, `repository.rs:4261`, `scope.rs:109`, `broadcaster.rs`). Open a sample and confirm they resolve. A teammate will trust them blindly.

## 6. Right-sizing
- Phases 01, 04 and 09 are estimated at ~3 h and each bundle several units (Phase 01: three new modules plus four RPC registrations; Phase 04: eleven operation tags plus locking plus classification; Phase 09: a state module, a toolbar, a progress banner and three dialogs). Rule on each: correctly sized given the conflict constraints, or should it split? Weigh the tension explicitly — splitting Phase 01 or 04 would put two writers on the same Rust registries in one round.
- Is any phase too trivial to stand alone (candidate: Phase 03 or Phase 11)?

## 7. Owners, skills, and gaps
- Every phase is owned by `general-purpose` because the agent roster has no Rust or React specialist, and `tasks.md` § Coordination Notes records that no Rust or Effect-Schema skill exists in the inventory. Judge whether that gap is honestly recorded and adequately mitigated (the phases substitute `AGENTS.md`, `.repos/effect-smol/LLMS.md` and existing modules as references), or whether it materially endangers Phases 00/01/04/07.

## 8. Honesty of outstanding items
- The plan is deliberately **commit-free** — no phase commits anything; the user decides afterwards. Confirm this is coherent everywhere, including Phase 12's use of read-only `git status` / `git diff` and the Rust fixture repositories that run git internally.
- Are manual/verification-only items (the in-app checks, the acceptance-criteria walk) honestly marked as required rather than assumed?

## 9. Orchestrator & consistency
- Does `execute-plan.md` correctly encode the rounds (parallel dispatch inside a round, sequential advance between rounds) and the repository's rules? Are the remaining `{NN}` / `{slug}` / `{Phase Title}` tokens legitimate per-dispatch template slots, or unsubstituted placeholders that should be concrete?
- Cross-check `tasks.md`, `execute-plan.md`, the 13 phase files and `handoff.md` for agreement on phase numbers, titles, filenames, owners, round assignments and dependency lists.
- The coordinator is instructed to harvest specific facts from each round's completion notes (Phase 01's `refs_signature` helper name for Phase 07; Phase 03's exported symbols for Phase 06; Phase 04's event label strings for Phase 09; Phase 05's and Phase 09's UI seams for Phase 10; Phase 07's event shape for Phase 11). Are those hand-offs complete, or does a downstream phase need something no upstream phase was told to record?

## 10. Executability risks (predict failures)
- Predict where a teammate would realistically BLOCK or FAIL: a phase that cannot verify in isolation (Phase 02's in-app check runs while Phase 01's RPCs may not exist), a full-workspace gate failing on a sibling's half-written file, a contract field discovered missing after the Phase 00 freeze, an operation Phase 04 cannot implement safely. Flag each with the phase and the reason.

**Scrutinise especially:**
- The Round 1/2/3/4 conflict-free claims and the region-file mechanism that produces them.
- Phase 00's front-loading of all six RPC declarations while the Rust registrations land across three later phases — verify no parity check or client-runtime iteration breaks in the interim.
- Whether Phase 01 and Phase 04 are executable in ~3 h each, given each is the sole owner of the shared Rust registries for its round.

---

# Output format

Produce:

1. **Verdict** — one combined verdict (Approve / Approve-with-changes / Needs-rework) with a 2–3 sentence rationale, plus a one-line sub-verdict for the master plan and one for the decomposition.
2. **Coverage check (Part 1)** — each `issue.specs` requirement and interview decision → the master-plan section that covers it, with dropped and invented items called out.
3. **Coverage matrix (Part 2)** — each master-plan unit of work → the phase that implements it, with orphans and inventions called out. This is the heart of Part 2.
4. **Findings table** — one row per finding: `Severity (Blocker/Major/Minor/Nit) | Location (file:line) | Issue | Evidence (the file:line you checked) | Recommended fix`. Sort by severity. Cover both parts in one table, with a column or prefix marking Part 1 vs Part 2.
5. **Answers to the high-judgment questions** — rule explicitly, with evidence, on: the single fat operation RPC; the read-scoped `vcs.commitDiff`; client-side lane layout; poller-based live updates; the "keep conflicted state" merge branch; the project-route + 2-project-LRU interpretation of "one popup per project"; the four conflict-free round claims; the region-file mechanism; Phase 00's contract front-loading; and the sizing of Phases 01, 04 and 09.
6. **What the plan and the decomposition got right** — so revisions don't regress it.
7. **Executability risks and open questions** — predicted block/fail points, and anything the author must decide.

Separate verified facts ("I read `apps/server/src/git/broadcaster.rs:120-140`; it does X") from opinions ("I'd split this phase"). If you cannot verify a claim because a file is missing or unreadable, say so rather than assuming. Where the plan reflects a decision the author settled deliberately in `issue.specs` § Interview Notes and you would have chosen differently, note it as out-of-scope rather than a defect.
