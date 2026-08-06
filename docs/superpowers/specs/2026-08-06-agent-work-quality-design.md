# Agent Work Quality Instructions

## Summary

BiBCode's root `AGENTS.md` will become the single operational contract for
coding agents. It will require agents to establish current repository context
before analysis or implementation, use CodeGraph when it is already available,
trace architectural consequences before editing, and finish with evidence that
matches the risk of the change. `CLAUDE.md` will continue pointing to the root
contract so Codex and Claude receive the same guidance.

## Goals

- Make reading current, task-relevant documentation a required pre-work step.
- Refresh an existing CodeGraph index before analysis without making CodeGraph
  a repository dependency or a prerequisite for work.
- Improve architectural decisions by requiring ownership, dependency, data-flow,
  lifecycle, failure, security, and performance analysis.
- Keep implementation aligned with the repository's actual source, schemas,
  tests, manifests, CI, and living documentation.
- Require focused behavioral tests, repository gates, documentation review, and
  an explicit validation report before a task is declared complete.
- Preserve one authoritative instruction file rather than duplicating policy
  across agent-specific or package-specific files.

## Non-Goals

- Install, initialize, repair, unlock, or fully rebuild CodeGraph.
- Add CodeGraph to the repository's dependencies, scripts, or CI.
- Require agents to read every document or historical plan for every task.
- Introduce nested `AGENTS.md` files before a package has genuinely distinct
  local rules that justify one.
- Replace task-specific judgment with a fixed test command that is either too
  weak for risky changes or unnecessarily expensive for focused changes.
- Turn historical specifications and plans into current implementation
  instructions.

## Current State

The repository has one root `AGENTS.md`. `CLAUDE.md` contains only a reference to
that file. The root instructions describe package roles, priorities, mandatory
completion gates, reference repositories, and special Effect and Alchemy
reading requirements, but they do not define an ordered preflight or a repeatable
architectural review process.

`docs/README.md` already identifies living documentation and explicitly marks
dated plans, specifications, dependency reports, and performance measurements
as historical material. The repository also ignores `.codegraph/`, and prior
planning artifacts refer to CodeGraph data as generated local state. The
CodeGraph CLI is not present in the current environment, so its use must remain
conditional.

## Instruction Architecture

The root `AGENTS.md` remains the only source of agent policy. Its current project
snapshot, priorities, package roles, runtime constraints, reference repositories,
and vendored-repository rules remain in force. New sections organize agent work
as an ordered lifecycle:

1. preflight and evidence gathering;
2. task-scoped documentation reading;
3. architectural analysis;
4. implementation and testing discipline;
5. completion verification and reporting.

The instructions use commands and paths that exist in the repository. They
distinguish unconditional requirements from risk-based checks so agents can
follow them literally without inventing exceptions.

## Preflight

Before non-trivial diagnosis, design, or implementation, an agent must:

1. Read every applicable instruction file from the repository root down to the
   files in scope. Today that means the root `AGENTS.md`; the wording remains
   valid if narrower instruction files are added later.
2. Inspect `git status --short` and preserve unrelated user changes.
3. Identify the requested outcome, constraints, and evidence needed to prove
   completion.
4. If `codegraph` is on `PATH`, run `codegraph sync . --quiet` from the repository
   root before using its results.
5. If the sync fails, mention that the graph may be stale and continue with
   normal source navigation, including `rg`, manifests, tests, and direct source
   inspection. The failure does not block work.

Agents must not automatically run `codegraph install`, `codegraph init`,
`codegraph index`, `codegraph unlock`, or other mutating repair/setup commands.
When CodeGraph is available, agents should use its relationship and impact
queries for unfamiliar or cross-package code, but must confirm critical claims
against source and tests.

## Required Documentation Reading

For non-trivial code work, the baseline reading set is:

- `docs/README.md`, to find the living documentation for the task;
- `docs/architecture/overview.md`, for runtime boundaries and invariants;
- `docs/reference/workspace-layout.md`, for package ownership;
- `docs/reference/scripts.md`, for supported development and validation commands;
- the living architecture, provider, user, operations, or integration documents
  linked from the index that match the task;
- the nearest relevant package README, manifest, public contracts, tests, and CI
  configuration;
- recent history for the affected paths when intent is unclear.

Documentation-only or very small mechanical work may use the relevant subset,
but an agent must still consult `docs/README.md` before deciding what is relevant.
Historical files under `docs/plans/`, `docs/superpowers/`, dependency-upgrade
reports, and architecture measurements provide rationale and evidence only.
Their commands, paths, and proposed designs must be verified against the current
tree before reuse.

Effect and Alchemy changes retain the existing stronger requirements to read
their vendored guidance and examples. Vendored repositories remain read-only
references and cannot become application imports.

## Evidence Model

Agents must reconcile information rather than relying on the first source they
find. For current behavior, executable source, schemas, manifests, tests, and CI
configuration are direct evidence. Living documentation states intended current
architecture and supported behavior. Historical artifacts explain earlier
decisions but are not authoritative. Vendored repositories show upstream or
reference patterns but do not define BiBCode behavior.

If these sources disagree, the agent must investigate the relevant call path and
tests, describe the conflict, and either align the living documentation in the
same change or report why it remains unresolved. Documentation must never be
silently treated as correct when executable behavior disproves it, and code drift
must never be used as an excuse to ignore a documented invariant.

## Architectural Analysis

Before editing, an agent must be able to state:

- which package owns the behavior and why;
- which callers, consumers, schemas, persistence formats, and public boundaries
  are affected;
- where state is owned and which component is the source of truth;
- how the change behaves during failure, cancellation, reconnect, restart,
  concurrency, duplicate delivery, stale results, and partial streams when those
  conditions are relevant;
- whether untrusted input crosses authentication, process, filesystem, network,
  remote-environment, provider, or desktop-bridge boundaries;
- whether hot paths remain bounded in CPU, memory, queues, tasks, I/O, and
  cloning;
- which existing tests and living documents describe the behavior.

The package roles and dependency direction in `AGENTS.md` remain hard boundaries.
Contracts stay schema-only, Rust continues owning production backend behavior,
privileged desktop operations continue crossing `DesktopBridge`, and normal
application traffic continues using typed HTTP/WebSocket RPC.

Agents should prefer the smallest coherent change that preserves these
boundaries. They should reuse or improve the correct shared abstraction when the
same policy has multiple consumers, while avoiding speculative generalization,
parallel sources of truth, compatibility aliases without a requirement, hidden
fallbacks, and unrelated cleanup.

Any change to package ownership, protocol flow, persisted shape, runtime
topology, lifecycle guarantees, security boundaries, or documented invariants
must update the corresponding living architecture documentation in the same
change. A non-trivial new decision must record its alternatives and trade-offs
in the task's approved design document before implementation.

## Implementation and Test Discipline

Agents must define observable success and relevant failure cases before editing.
They must inspect the existing implementation and tests, then add or update the
closest behavioral coverage. Tests should exercise public behavior and important
failure or lifecycle seams rather than mirror private implementation details.

During implementation, agents must:

- keep changes scoped to the requested outcome and necessary architectural
  support;
- preserve unrelated worktree changes;
- follow existing naming, error, logging, schema, and module conventions;
- avoid duplicate logic and keep shared logic in the package that owns it;
- update documentation, examples, fixtures, and contracts together when a
  public behavior changes;
- run focused tests after each meaningful behavior change rather than waiting
  until the end.

## Completion and Validation

No task is complete until the agent has:

1. run focused tests for every changed behavior;
2. run broader package, integration, build, or end-to-end coverage when the
   change crosses packages or runtime boundaries;
3. run `vp check` and `vp run typecheck` successfully;
4. for Rust changes, run `cargo fmt --all --check`, relevant Rust tests, and
   Clippy for the affected targets with warnings denied;
5. review `git diff` and `git status --short` for unintended edits, generated
   files, debug output, dependency drift, and missing documentation;
6. update a configured vendored subtree when its corresponding dependency was
   changed;
7. report the validation commands that ran and disclose any command that could
   not run or any residual risk.

`vp test` remains the built-in Vite+ test command. `vp run test` remains the
workspace package-script graph and is required when that full graph is the
appropriate risk-based check. Passing a broad suite does not replace focused
coverage for newly changed behavior.

## Expected Outcome

Agents begin work with an accurate model of the current repository, use a fresh
CodeGraph index when available, and ground architectural decisions in verified
boundaries and call paths. Changes include proportionate behavioral coverage,
keep living documentation synchronized with architectural reality, and finish
with explicit evidence rather than unsupported completion claims.
