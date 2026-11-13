# Execute plan: Issue batch #348 and #351 to #358

You are about to execute an approved implementation plan. Read this whole file before doing anything.

- Plan folder: docs/plans/2026-11-13-issue-batch-348-358
- Spec: docs/plans/2026-11-13-issue-batch-348-358/spec.md (binding authority; the plan argues from it)
- Planned on: Claude Code, 2026-11-13
- Plan reviewed by: Codex gpt-6.1-sol, effort high
- Base branch: main
- Recommended mode: Workflow, because round 1 has seven phases that own disjoint files and the plan has 47 tasks

## 1. Check the plan

1. Read `progress.md`, `plan.md`, `spec.md` and every file in `phases/`.
   Check that `mstack-receive-review` is in this session's skill list (as `mstack-receive-review` or `<plugin>:mstack-receive-review`), because every review of this run is processed with it. When it is missing, stop before any work and print the install commands: `claude plugin install mstack-receive-review@mstack` (Claude Code) or `codex plugin add mstack-receive-review@mstack` (Codex), after `<claude|codex> plugin marketplace add mubeda/mstack`, or `npx skills add mubeda/mstack --skill mstack-receive-review -g -a <claude-code|codex> -y`; name `mstack-setup`, and say a new session is needed after the install.
2. If `progress.md` says `Plan status: Draft`, stop. Tell the user the plan is not approved and ask them to approve it, or to finish it with `mstack-plan`.
3. Compute the sha256 of `spec.md` (`sha256sum spec.md` or `shasum -a 256 spec.md`). If its first 12 hex digits differ from the `Spec` line of `progress.md`, the spec changed after planning. Stop and ask the user whether to re-plan or continue on the old plan.
4. When `progress.md` has a `Branch` line, continue on that branch. Tasks marked Closed are never redone, but check first that each one's last logged commit is on the branch (`git merge-base --is-ancestor <commit> HEAD`). When it is not, because a workflow closed the task and stopped before integrating it, cherry-pick the logged commits from the logged branch. When that branch is gone, set the task back to In progress and log why.
5. A task marked In progress was interrupted. Read its log lines and `git log` on the branch, then finish it from where the evidence stops.

## 2. Ask the user first

Before any other work, ask the user these questions in one message, using the host's question tool (in Claude Code `AskUserQuestion`; in Codex a numbered list in chat, then wait). Skip a question only when the user's opening message already answers it.

1. How should the plan be executed?
   (a) Inline. This session implements every task in order, red-green, then gets one cross-vendor review of the whole branch.
   (b) Workflow. In Claude Code, the `mstack-codex-review-workflow` skill (Codex reviews). In Codex, the `mstack-claude-review-workflow` skill (Claude reviews). Parallel writer lanes, a cross-vendor review per lane, one integrated branch.
   (c) Codex develops. In Claude Code only, the `mstack-claude-pm-codex-dev` skill: Codex writes each phase, and Claude reviews, validates and commits it.
   I recommend (b), because round 1 has seven phases that own disjoint files and the plan has 47 tasks.
2. Which reviewer model and effort? I recommend `gpt-6.1-sol` and `high` for Codex reviewers (the plan review used them), `opus` and `medium` for Claude reviewers.
3. May this run commit each finished task to the branch in `progress.md`'s `Branch` line, or, when there is none, use the existing branch `claude/open-issues-pr-dc3c33` (created from `main` for this batch) and commit to it? Pushing and opening a pull request happen only when the user asks.

## Before round 1 (plan decision P3)

Run the packaged `chat-reasoning-rows` spec on the base commit in the Linux lab at a 1000x720 viewport, with the Profiler on, and log the result in `progress.md`. Task 5.1 reads it. Follow the user's standing rules for this repository: subagents run on `sonnet` or `haiku`, or `opus` at effort medium for complex work, never above; check free disk (at least 60 GB) before each round of Rust writers and keep at most four at once; every review is triaged with the advisor; push once, after the gates pass.

## 3. Workflow execution

1. Load the workflow skill for this host. If it is not installed, give the user its install command and offer inline execution instead.
   - Claude Code: `claude plugin marketplace add mubeda/mstack`, then `claude plugin install mstack-codex-review-workflow@mstack`, then start a new session.
   - Codex: `codex plugin marketplace add mubeda/mstack`, then `codex plugin add mstack-claude-review-workflow@mstack`, then start a new session.
   - Either host, with the skills CLI: ask the user the scope (global or this repository), the method (symlink or copy) and the agents, then run `npx skills add mubeda/mstack --skill <workflow> -a <claude-code | codex> -y`, adding `-g` for global and `--copy` for copy.
   - Choice (c), Claude Code only: `claude plugin marketplace add mubeda/mstack`, then `claude plugin install mstack-claude-pm-codex-dev@mstack`, then start a new session; or with the skills CLI, after the same three questions, `npx skills add mubeda/mstack --skill mstack-claude-pm-codex-dev -a claude-code -y`. It also needs the OpenAI Codex plugin for Claude Code; `mstack-setup` reports and installs it.
2. Give the workflow this plan folder as its work items, and tell it that every review is processed with `mstack-receive-review` without asking the user. It reads the folder as an `mstack-plan` plan: every task is a work item, `progress.md` is its status file, and each task's Skills, Read first and Done when go into the lane brief.
3. The answers to questions 2 and 3 above answer the workflow's own model, effort and commit questions. The workflow still asks its execution mode question, and Workflow mode is recommended when a round has more than one phase. For choice (c), the same two answers answer its reviewer and commit questions; it still asks which developer model and effort to use.

## 4. Inline execution

### Rules for the whole run

1. Work on the branch from question 3. Never work directly on the default branch without the user's consent.
2. Set `Executor: inline` and `Branch: <branch>` in `progress.md`.
3. Keep going without status check-ins. Stop and ask only for: an irreversible or destructive operation, a security-sensitive action, a side effect outside this repository (a push, a publish, a merge), or a plan so broken that every way forward is a guess. When the context or the session is running out, stop at a safe point, make sure `progress.md` is current, write a handoff with `mstack-handoff` when it is installed, and give its path; the next session continues from `progress.md` and the handoff.
4. When the plan is wrong in a small way (a renamed function, a moved file), make the smallest change that still satisfies the spec, and log it in `progress.md` as `Ruling: <what>, because <why>. Cost if wrong: <impact>.`
5. Never claim a task is done without fresh evidence: run its Done when command in this session, read the whole output and the exit code, and copy the evidence into the log.
6. This session's model does every task, so a task's Tier line does not change it. The tier limits what you delegate: a read-only helper (a search, a log read) runs on the cheapest model this host offers, set explicitly, and no helper runs on a model above the task's tier. In Claude Code that is `Agent` with the model and effort of `haiku`, effort low for a cheap helper and of `sonnet`, effort medium for a standard one. In Codex, pass them as `-m` and `model_reasoning_effort` on the helper run: the cheapest Codex model the host offers, effort low for a cheap helper, `gpt-6.1-sol`, effort medium for a standard one. A helper started without them runs on this session's model.

### Per task

Pick the next task by dependencies. A task is ready when every task in its Depends on line is Closed and every phase its phase depends on is Closed. Among ready tasks, take the lowest phase, then the lowest ID. Skip Closed tasks and tasks marked removed or dropped. A task that depends on a removed or dropped task stays Open, and the final report lists it as blocked.

1. Set the task to In progress in `progress.md` and add a log line.
2. Load every skill the phase and the task list (in Claude Code with the Skill tool; in Codex by reading the skill's SKILL.md). The plan names skills without a plugin prefix, so use whichever form this host lists, `<plugin>:<name>` or `<name>`. For a skill this host does not have, follow the task's steps without it and note that in the log.
3. Read every file and source in the phase's and the task's Read first.
4. Follow the steps in order. After each command, compare the output with its `Expected:` line.
   - Red-green tasks: see the test fail for the expected reason before writing the code, then see it pass. Do the "prove the test can fail" step, and always restore the code afterwards.
   - The output does not match because the code is wrong: debug it before changing anything (load `mstack-diagnose` when it is installed). Never patch the symptom.
   - The output does not match because the plan is wrong: apply rule 4.
5. Run the task's Done when command and the phase's lint and format commands.
6. Commit the task's files together with `progress.md`, where the task is now Closed and the log line carries the command, the result and the commit range.

After a phase's last task, run its Checkpoint and log the result. A failing checkpoint reopens the task that owns the failure.

### After the last task

1. Run every check in `plan.md` › End-to-end verification and log each result.
2. Get one cross-vendor review of the whole branch, read-only, with the model and effort from question 2. Write its output outside the repository: `<tmp>` below is the session's scratch folder when the host has one, otherwise `${TMPDIR:-/tmp}/mstack-plan-issue-batch-348-358`, created first. Put a path in double quotes in these commands when it contains a space.
   - Claude Code (Codex reviews, through the `codex` skill of the skill-codex plugin; timeout at least 600 seconds for `high`, 1200 for `xhigh`, 1800 for `max`):

     Write this prompt to `<tmp>/review-prompt.md` with your file tool, never with `echo` or a heredoc, so no shell expands anything in it:

     ```text
     Read-only code review. Do not edit or run anything that changes files. Review branch <branch> against <base> (git diff <base>...HEAD). The plan is in docs/plans/2026-11-13-issue-batch-348-358 and the spec it implements is docs/plans/2026-11-13-issue-batch-348-358/spec.md. Check that every requirement in the spec is met, and check correctness, regressions, missing tests and scope. Report each finding with file, line, the failing scenario and how to reproduce it. No findings is a valid result.
     ```

     ```bash
     codex exec -m <model> --config model_reasoning_effort="<effort>" --sandbox read-only -C <repository root> - \
       < <tmp>/review-prompt.md 2> <tmp>/codex-review.err > <tmp>/codex-review.md
     ```
   - Codex (Claude reviews, through the `claude-review` skill of the agent-bridges `claude` plugin; it needs network and writes under the home folder, so run it as an approved command):

     ```bash
     node "<claude-plugin-root>/scripts/claude-companion.mjs" review --wait \
       --cwd <repository root> --base <base> --scope branch \
       --model <model> --effort <effort> </dev/null > <tmp>/claude-review.md 2> <tmp>/claude-review.err
     ```
     This review reads the diff, not the spec, so check every requirement against the spec yourself.
   - An empty output or a non-zero exit is never a clean review. Read the end of the `.err` file, fix the cause (a rejected model: use the other model offered in question 2), and rerun once. If it still fails, or this host's reviewer is not installed, warn the user that the review will be same-vendor, and run the same review prompt through a fresh, read-only subagent of this host (in Claude Code the `Agent` tool with the model and effort of `opus`, effort medium; in Codex a separate `codex exec -m <fallback model> --config model_reasoning_effort="<fallback effort>" --sandbox read-only -C <repository root> - < <tmp>/review-prompt.md`, where those two are the model and effort of `gpt-6-astra`, effort medium, with the prompt above written to that file, as an approved command because it needs network). Log it as a same-vendor review, and say so in the final report. Never wait on the user for it.
3. Process the review with the `mstack-receive-review` skill, without asking the user anything. Verify every finding against the code and reproduce it before accepting it. Fix each real finding with a test you saw fail and then pass. Send an unclear finding back to the reviewer once. Reject a finding that is wrong, cannot be verified, or contradicts a decision the user already made, with the reason. Log every finding and its outcome in `progress.md`.
4. Report to the user: the goal and the outcome in the first line, then the final `progress.md` table, the end-to-end results, every Ruling, every review finding with what happened to it (fixed, rejected and why, deferred), and what was not run and why. Offer to open a pull request. Do not push without the user's request.
