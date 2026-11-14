# Phase 5: Docs, gates and pull request

- Goal: the living documents state the measured causes and the new CI shape, every gate passes, and the pull request carries one measured `ci:full` run.
- Round: 3
- Depends on: 1, 2, 3, 4
- Owns: `docs/operations/ci.md`, `docs/operations/release.md`, `docs/testing/`, `docs/plans/README.md`
- Must not touch: source files owned by phases 1 to 4, except to apply review findings
- Skills: issue-delivery (checkpoint before the CI dispatch, progress by accepted requirements); mstack-receive-review (processes the Codex review of the branch)
- Read first: `AGENTS.md` (Task Completion Requirements, Testing Runbook Maintenance, Sensitive Data)
- Checkpoint: the pull request is open with green checks, a table of measured step times against the baselines, and an accept or reject line per requirement.

## Tasks

### Task 5.1: Update the living documents

- Satisfies: R8
- Depends on: 1.1, 2.1, 3.1, 3.2, 3.3, 4.1
- Files: modify `docs/operations/ci.md`; modify `docs/operations/release.md`; modify the Windows runbook under `docs/testing/`; modify `docs/plans/README.md`
- Interfaces: none
- Skills: none
- Read first: `docs/operations/ci.md` (Native desktop, Server tests, Rust cache budget sections)
- Tier: cheap
- TDD: exempt (documentation)
- Done when: `vp run check:markdown-links` exits 0 and `rg -n "without a Rust cache" docs/operations/ci.md` prints nothing that explains a row's time

Steps

1. [ ] `ci.md`: add `server_tests_windows` to the label table and the Jobs list; rewrite the Native desktop paragraph for the override (what CI still proves, what only Release proves) and the heartbeat; state the measured budget (about 17 GB wanted against 10 GB, pull requests no longer save pnpm entries, the limit can be raised in repository settings); replace "without a cache" explanations of row times with the compile counts. Expected: the file names no execution-specific run IDs outside the dated measurements it already keeps.
2. [ ] `release.md` Symbol assets: say that a `dump_syms` CFI error from a dSYM is expected, where the unwind records come from, and what the script checks. Expected: one short paragraph.
3. [ ] Windows runbook: list the server tests under their own job. Expected: commands match `ci.yml`.
4. [ ] `docs/plans/README.md`: add this folder to the plan folder list. Expected: one line.
5. [ ] Run `vp run check:markdown-links`. Expected: PASS.

### Task 5.2: Local gates, review and pull request

- Satisfies: support (5.3, which accepts the requirements on the pull request's run)
- Depends on: 5.1, 4.2
- Files: none
- Interfaces: produces the pull request and its first CI run
- Skills: issue-delivery (delivery checkpoint); mstack-receive-review (review findings)
- Read first: `docs/skills/issue-delivery/SKILL.md`
- Tier: standard
- TDD: exempt (gates and a pull request)
- Done when: the pull request is open with the `ci:full` label and one CI run started on its head commit

Steps

1. [ ] Run `vp check`, `vp run typecheck`, `vp test run scripts`, `cargo fmt --all --check`. Expected: all pass.
2. [ ] Get the cross-vendor review of the branch and process it with `mstack-receive-review`. Expected: every finding fixed with a test or rejected with a reason.
3. [ ] Review `git diff main...HEAD` and `git status --short` for unintended files and sensitive data. Expected: none.
4. [ ] Write the delivery checkpoint and run `node scripts/check-agent-delivery.mjs <checkpoint.json>`. Expected: exit 0.
5. [ ] Push the branch and open the pull request with the `ci:full` label already on it when the measured commit is pushed, then bind it. Expected: one CI run with all rows.

### Task 5.3: Accept the requirements on the measured run

- Satisfies: R2 (row times), R3 (dependencies reused in CI), R4 (the recorded macOS measurement), R7 (issue comment)
- Depends on: 5.2
- Files: none
- Interfaces: consumes the `k of 30` line from Task 4.2
- Skills: issue-delivery (progress by accepted requirements)
- Read first: `research/measured_ci_and_local.md` sections 1 and 2 (the baselines)
- Tier: standard
- TDD: exempt (reading a CI run and writing its numbers down)
- Done when: `gh pr checks` shows every check green on the final commit, the pull request body holds the table, and every Must requirement is accepted or covered by a fallback the spec names (D3, D4); R7 may stay unaccepted with its reason

Steps

1. [ ] When the run ends, record each native row's step times, the Windows server test job times and the macOS heartbeat (peak memory, swap, build seconds) in the pull request body, next to the baselines. `progress.md` is not edited after the measured commit, because a new commit starts a new run; the pull request is the record. Expected: the table is in the pull request.
2. [ ] Decide R2: both Windows native rows under 89 and 103 minutes. Decide R3 from the controlled local comparison already recorded in `research/measured_ci_and_local.md` section 3 (same target, only the override changed, only the two workspace crates compiled) and from Task 2.1 step 6; from the run, record each row's bundle build seconds against its baseline as an observation, since a cache restore on the day is not guaranteed. Expected: one accept or reject line each.
3. [ ] Apply spec D3 if the macOS arm64 bundle build took more than 81 minutes: remove the override from that row, push, and repeat steps 1 and 2 for the new run. Apply spec D4's fallback if the Windows server test job ran out of memory: restore `-j 2`, change the contract case to require it, and record the reason in the workflow comment and the spec. Expected: the final commit's run is the one recorded.
4. [ ] Comment on #367 with the `k of 30` result and any failure output; comment on #363 and #368 with the measured numbers. Expected: three comments, no private data.
