# Git Manager / Phase 01 — Server read modules and read RPCs

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Serve the Git Manager's four read RPCs from the server — paged commit graph, refs snapshot with server-computed guards, commit detail, and commit diff.

**Architecture:** Implements § "Phase 1 — Contracts and server reads" and § "Phase 4 — Commit detail and diff" (server half) of `../master-plan.md`. Three new modules under `apps/server/src/git/`: `graph.rs` (commit paging, commit detail, commit diff), `refs.rs` (`for-each-ref` + dirty flag + worktree join + merge state), `guards.rs` (pure blocked-reason policy). All four handlers are registered in this phase, so this is the only Round 1 phase that touches the shared RPC registries.

**Tech Stack:** Rust (Axum/Tokio). Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server git::`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Coding rules: root `AGENTS.md`.

---

## Files

- **Create:** `apps/server/src/git/graph.rs` — commit-graph paging, commit detail, commit diff (with unit tests).
- **Create:** `apps/server/src/git/refs.rs` — refs snapshot assembly (with unit tests).
- **Create:** `apps/server/src/git/guards.rs` — pure blocked-reason computation (with unit tests).
- **Modify:** `apps/server/src/git/mod.rs` — declare and re-export the three new modules.
- **Modify:** `apps/server/src/production/git_vcs.rs` — dispatch the four new read methods; add RPC-level tests.
- **Modify:** `apps/server/src/rpc/methods.rs` — add four `unary(...)` entries.
- **Modify:** `apps/server/src/auth/scope.rs` — map all four to `SCOPE_ORCHESTRATION_READ`.
- **Modify:** `apps/server/src/maintenance.rs` — add all four to the read-only allowlist.

## Dependencies

- Phase 00: Wire contracts for the whole feature.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: High (new Git parsing, shared registries, guard policy that the whole UI trusts). Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the parser and guard tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="ponytail:ponytail")` — one git invocation per read, no per-ref shelling out

> No Rust-specific skill exists in the current inventory; the existing modules under `apps/server/src/git/` are the style reference.

## Documents to Read

- `../master-plan.md` — § Technical Requirements → Server, § Phase 1 (command formats, guard messages), § Phase 4 (commit diff).
- `AGENTS.md` (repo root) — architectural decision standards, log hygiene, task completion requirements.
- `docs/architecture/rpc-and-orchestration.md` — session, method inventory, and the scope rule ("adding a live method without exactly one declared scope fails a server test").
- `docs/architecture/worktree-catalog.md` — repository identity and physical-path identity; the worktree list in the refs snapshot must come from the catalog inventory, not a second `git worktree list`.
- `apps/server/src/git/repository.rs` — `list_refs` (line ~1189), `list_commits` (~1316), `git_environment()` (~4258, the non-interactive env every git call must use), and the fixture-repo test helpers (~5772).
- `apps/server/src/git/process.rs` — `ProcessRequest`: timeout, `max_output_bytes`, `OutputPolicy`, cancellation.
- `apps/server/src/git/parser.rs` — existing parsing conventions.
- `apps/server/src/production/git_vcs.rs` — the unary dispatch pattern (`"vcs.listRefs" => { … }`, line ~404) and `guard_git_path` admission.

---

## Pre-execution check

- [ ] **Step 01.0: Claim the phase.** Set Phase 01 in `../tasks.md` → `in_progress`, `Agent = phase-01`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 01.1: Locate the surface area.**

	```bash
	grep -n "pub async fn list_refs\|pub async fn list_commits\|fn git_environment" apps/server/src/git/repository.rs
	grep -n "\"vcs.listRefs\" =>" apps/server/src/production/git_vcs.rs
	```

	Read those three functions plus `guard_git_path`. Confirm how a `ProcessRequest` is built and how errors become `GitCommandError`. Record deviations from the master plan's assumptions in `../tasks.md`.

- [ ] **Step 01.2: Author the first failing test** in `apps/server/src/git/graph.rs`:

	```rust
	#[test]
	fn parses_a_merge_commit_record_with_two_parents_and_decorations() {
	    let raw = "9569e81eda50\u{1f}9569e81\u{1f}0ecd0de b58fe80\u{1f}mubeda\u{1f}m@example.invalid\u{1f}1780000000\u{1f}1780000001\u{1f}HEAD -> develop, tag: v1.2.0, origin/develop\u{1f}Merge branch 'x'\u{1e}";
	    let commits = parse_commit_graph_records(raw, &["origin".to_owned()]);
	    let commit = commits.first().expect("one commit");
	    assert_eq!(commit.parents.len(), 2);
	    assert!(commit.refs.iter().any(|r| r.kind == GraphRefKind::Tag && r.name == "v1.2.0"));
	    assert!(commit.refs.iter().any(|r| r.kind == GraphRefKind::RemoteBranch));
	    assert_eq!(commit.subject, "Merge branch 'x'");
	}
	```

- [ ] **Step 01.3: Run it; expect FAIL** (`parse_commit_graph_records` not found).

	```bash
	cargo test -p bibcode-server git::graph::
	```

- [ ] **Step 01.4: Implement `parse_commit_graph_records`** — split on `\x1e`, then `\x1f`, mapping `%D` decorations: `HEAD -> name` → `Head` + `LocalBranch`, `tag: name` → `Tag`, `remote/name` where `remote` is in the known-remotes list → `RemoteBranch`, else `LocalBranch`.

- [ ] **Step 01.5: Run the test; expect PASS.**

- [ ] **Step 01.6: Add the paged reader + tests.** `list_commit_graph(cwd, scope, limit, cursor, tips)` runs, through the supervised process path with `git_environment()`:

	```
	git log <tip… | --all | HEAD> --date-order
	  --pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s%x1e
	  --skip <cursor> --max-count <limit>
	```

	**Pages are pinned to a tip snapshot.** When the caller sends no `tips`, resolve the current tips for the scope (`git for-each-ref --format=%(objectname)` over the scope's refs, or `HEAD` for `current-branch`), page against them, and return them in `tips` with `tipsPinned: true`. When the caller echoes `tips` back, page against exactly those. Above 500 tips, fall back to `--all` and return `tipsPinned: false` with an empty `tips`. Pass a long tip list via `--stdin` rather than the command line. This is what keeps `--skip` offsets valid while the repository moves — a raw `--all --skip N` cursor shifts by one every time a commit lands, and the ref tick is 3 s.

	Tests against a fixture repo: linear history pages correctly; `nextCursor` is `null` on the last page; a limit above 1000 is rejected; **committing between page 1 and page 2 does not duplicate or skip a commit when tips are echoed back** (the test that proves the pinning works); the over-cap fallback sets `tipsPinned: false`; and an **empty repository with an unborn HEAD** returns zero commits without erroring.

- [ ] **Step 01.7: Add commit detail + tests.** `commit_detail(cwd, sha)` = `git show --no-patch --pretty=…` for metadata plus `git show --numstat --format= <sha>` for the file list (`-` counts mean binary). Tests: rename records populate `previousPath`; a binary file sets `isBinary`; the file list truncates at a documented cap and sets `filesTruncated`.

- [ ] **Step 01.8: Add commit diff + tests.** `commit_diff(cwd, sha, file_path, ignore_whitespace)` = `git show --format= --patch <sha> [-- <path>]`, root commits diffing against the empty tree. Reuse the review pipeline's truncation policy and `diffHash` computation. Tests: root commit produces a diff with `baseRef = None`; a path filter narrows the patch; oversized output sets `truncated`.

- [ ] **Step 01.9: Add `refs.rs` + tests.** One `git for-each-ref --format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD) refs/heads refs/remotes refs/tags` pass; parse `[ahead N, behind M]`. Dirty flag from `git status --porcelain=v2 --untracked-files=no`. Merge state from the presence of `MERGE_HEAD` plus `git diff --name-only --diff-filter=U` for `conflictedPaths`. Worktrees come from the catalog inventory. Tests: no upstream → `ahead`/`behind` are `None`; detached HEAD populates `detachedHeadSha` and leaves `headRef` empty; a conflicted fixture reports `mergeInProgress = true` with its paths; an **empty repository with an unborn HEAD** returns empty collections rather than erroring; and **two projects sharing one physical repository through separate worktrees** produce the same worktree list and the same generation from either cwd (they resolve to one common directory — the snapshot must not be duplicated or diverge per project).

- [ ] **Step 01.10: Add `guards.rs` + tests.** A pure function taking the parsed refs, worktree inventory, dirty flag, default branch, merge state and running-operation state, returning blocked reasons per ref. Cover every code in `VcsGraphBlockedCode`: `worktree-checked-out`, `dirty-working-tree`, `operation-in-flight`, `merge-in-progress`, `protected-branch`, `current-branch`, `no-upstream`, `detached-head`, `no-remote`. Messages are user-facing and complete sentences, e.g. `Checkout is blocked: this branch is already checked out in the worktree at <path>.` Include the negative case: a clean non-current branch with an upstream has an empty blocked list. **`resolveMergeConflict` is exempt from the dirty-tree guard** — assert that explicitly.

- [ ] **Step 01.11: Wire the four handlers.** In `apps/server/src/production/git_vcs.rs` add `"vcs.listCommitGraph"`, `"vcs.graphRefs"`, `"vcs.commitDetail"`, `"vcs.commitDiff"` to the unary dispatch, each decoding its input, taking `guard_git_path` admission, and mapping errors the way `vcs.listRefs` does. Add the same four names to `apps/server/src/rpc/methods.rs` (`unary(...)`, alphabetical), to `apps/server/src/auth/scope.rs` under `SCOPE_ORCHESTRATION_READ`, and to the `apps/server/src/maintenance.rs` read-only allowlist.

- [ ] **Step 01.12: Add RPC-level tests** in `git_vcs.rs` mirroring the existing `unary(&services, "vcs.listRefs", json!({"cwd":42}))` shape: an invalid payload is rejected, and a valid call against a fixture repo returns the expected shape for each of the four methods.

- [ ] **Step 01.13: Log-hygiene sweep.** Grep your new code for interpolated branch names, ref names, paths, remote URLs, and git stderr in log strings:

	```bash
	grep -n "tracing::\|log::" apps/server/src/git/graph.rs apps/server/src/git/refs.rs apps/server/src/git/guards.rs
	```

	Every log line must carry stable codes plus counts/lengths only. User-facing text belongs in payload fields.

- [ ] **Step 01.14: Full gate.**

	```bash
	cargo fmt --all --check
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	cargo test -p bibcode-server
	```

	Expected: zero warnings, all tests green.

- [ ] **Step 01.15: TDD proof.** Make `guards.rs` return an empty blocked list unconditionally; re-run `cargo test -p bibcode-server git::guards::` and confirm the guard tests fail. Restore, re-run, confirm green. Describe the mutation in your notes.

- [ ] **Step 01.16: Mark complete.** Phase 01 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, with a summary (modules added, test count, deviations).

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] All four read RPCs answer against a fixture repository and reject malformed payloads.
- [ ] Commit pages are pinned to an echoed tip snapshot; a commit landing between two page requests neither duplicates nor skips a row. The over-cap `--all` fallback is signalled with `tipsPinned: false`.
- [ ] An empty repository (unborn HEAD) and a repository shared by two projects via worktrees both behave correctly.
- [ ] Every guard code in `VcsGraphBlockedCode` is produced by at least one test, and `resolveMergeConflict` is proven exempt from the dirty-tree guard.
- [ ] The refs snapshot reports `mergeInProgress` and `conflictedPaths` for a conflicted fixture repository.
- [ ] Worktree data comes from the catalog inventory — no second `git worktree list` call was added.
- [ ] Every new git invocation uses `git_environment()` and the supervised process path with a timeout and output cap.
- [ ] `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server` all clean.
- [ ] No branch name, path, remote URL, or git stderr text appears in any log string.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 04 adds `git.runRepositoryOperation` and will re-open `mod.rs`, `git_vcs.rs`, `methods.rs`, `scope.rs` — it runs in a later round precisely so those files are never edited concurrently. Leave the registry lists alphabetically sorted so Phase 04's diff stays small.
- Phase 04 must call `guards::…` rather than re-deriving policy, and must re-validate guards at execution time (a stale client is rejected with `blocked`).
- Phase 07 extends `broadcaster.rs` with the refs signature — expose whatever cheap "refs + HEAD + worktree" fingerprint helper you build in `refs.rs` as `pub(crate)` so Phase 07 reuses it instead of writing a second one. Name it `refs_signature` and say so in your completion notes if you deviate.
- Web phases consume `generation` from both reads; keep it sourced from one place so the two reads cannot disagree.
