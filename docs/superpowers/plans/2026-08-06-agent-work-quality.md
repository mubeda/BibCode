# Agent Work Quality Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the root `AGENTS.md` into a concrete preflight, architectural-analysis, implementation-quality, and evidence-based completion contract for every coding agent used on BiBCode.

**Architecture:** Keep `AGENTS.md` as the single source of policy and keep `CLAUDE.md` as its pointer. Extend the existing repository-specific rules with an ordered workflow that reads living documentation, conditionally synchronizes CodeGraph, verifies architecture against executable evidence, and selects validation according to change risk.

**Tech Stack:** Markdown agent instructions, Git, CodeGraph CLI when already installed, Vite+, Cargo.

## Global Constraints

- `AGENTS.md` remains the only source of agent policy; do not duplicate the policy in `CLAUDE.md` or new package-local files.
- CodeGraph remains optional and best-effort. Do not add a dependency, repository script, CI step, installation action, initialization action, unlock action, or full-index action.
- A failed CodeGraph sync must be disclosed but must not block normal source navigation or implementation.
- Living documentation describes intended current architecture; historical plans, specifications, reports, and measurements remain history rather than instructions.
- Critical architectural claims must be confirmed against current source, schemas, manifests, tests, and CI.
- Preserve the existing package roles, production Rust constraint, schema-only contracts boundary, `DesktopBridge` boundary, typed application-traffic boundary, and vendored-repository rules.
- `vp check` and `vp run typecheck` must pass before the task is complete.
- Preserve unrelated user changes and do not modify `.repos/` or `.codegraph/`.

---

### Task 1: Strengthen the Root Agent Contract

**Files:**

- Read: `docs/superpowers/specs/2026-08-06-agent-work-quality-design.md`
- Modify: `AGENTS.md`
- Verify unchanged: `CLAUDE.md`

**Interfaces:**

- Consumes: the approved policy and failure semantics in `docs/superpowers/specs/2026-08-06-agent-work-quality-design.md` plus the existing package roles and vendored-reference rules in `AGENTS.md`.
- Produces: one root instruction contract that Codex reads directly and Claude receives through the existing `CLAUDE.md` pointer.

- [ ] **Step 1: Record the clean implementation baseline**

Run:

```bash
git status --short
sed -n '1,280p' AGENTS.md
sed -n '1,40p' CLAUDE.md
```

Expected: only already-approved planning commits are present, `AGENTS.md`
contains the original repository rules, and `CLAUDE.md` contains exactly the
`AGENTS.md` pointer. If unrelated changes exist, preserve them and exclude them
from this task.

- [ ] **Step 2: Demonstrate that the new policy contract is absent**

Run:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const instructions = readFileSync("AGENTS.md", "utf8");
const requiredFragments = [
  "## Required Pre-Work",
  "codegraph sync . --quiet",
  "docs/architecture/overview.md",
  "## Evidence and Documentation",
  "## Architectural Decision Standards",
  "## Implementation Quality",
  "cargo fmt --all --check",
  "report the exact validation commands",
];
const unexpectedlyPresent = requiredFragments.filter((fragment) =>
  instructions.includes(fragment),
);

if (unexpectedlyPresent.length > 0) {
  console.error(`Unexpected existing fragments: ${unexpectedlyPresent.join(", ")}`);
  process.exit(1);
}

console.error("Expected failure: the strengthened policy is not implemented yet.");
process.exit(1);
NODE
```

Expected: exit 1 with `Expected failure: the strengthened policy is not
implemented yet.` The command documents the red state for this Markdown-only
policy change.

- [ ] **Step 3: Add the ordered pre-work workflow**

Insert `## Required Pre-Work` near the start of `AGENTS.md`, before completion
requirements. Write the rules as direct imperatives and include all of these
requirements:

```markdown
## Required Pre-Work

Before non-trivial diagnosis, design, or implementation:

1. Read every applicable `AGENTS.md` from the repository root to the files in
   scope.
2. Run `git status --short`; preserve unrelated user changes.
3. State the requested outcome, constraints, affected packages, and evidence
   that will prove completion.
4. If `codegraph` is available on `PATH`, run `codegraph sync . --quiet` from
   the repository root before relying on graph results.
5. If CodeGraph sync fails, note that its data may be stale and continue with
   `rg`, manifests, tests, and direct source inspection. Do not block the task.

Do not install, initialize, unlock, repair, or fully re-index CodeGraph unless
the user explicitly requests it. When CodeGraph is available, use its
relationship and impact queries for unfamiliar or cross-package code, then
confirm critical findings in source and tests.
```

Follow it with a required reading list that says:

```markdown
For non-trivial code work, read `docs/README.md`,
`docs/architecture/overview.md`, `docs/reference/workspace-layout.md`, and
`docs/reference/scripts.md`, then read the task-relevant living documentation
linked by the index. Also inspect the closest package README and manifest,
public contracts, existing tests, CI configuration, and recent history for
affected paths when intent is unclear.
```

Allow documentation-only and very small mechanical work to use the relevant
subset only after consulting `docs/README.md`. This keeps the workflow
proportionate without letting agents skip documentation discovery.

- [ ] **Step 4: Add the evidence and documentation policy**

Add `## Evidence and Documentation` after the pre-work section. It must make the
following distinctions explicit:

```markdown
- Source, schemas, manifests, tests, and CI are executable evidence of current
  behavior.
- Living documentation states intended current architecture and supported
  behavior.
- `docs/plans/`, `docs/superpowers/`, dependency reports, and dated
  measurements are historical evidence only; verify their paths, commands, and
  designs before reuse.
- `.repos/` contains read-only upstream examples, not application dependencies
  or BiBCode behavior.
```

Require agents to investigate disagreements by tracing the relevant call path
and tests. They must either align living documentation in the same change or
report the unresolved discrepancy. Retain the existing Effect and Alchemy
vendored-reading rules under `## Vendored Repositories` without weakening or
duplicating them.

- [ ] **Step 5: Add architectural decision standards**

Add `## Architectural Decision Standards` before the package-role inventory.
Require agents to identify these facts before editing:

```markdown
- owning package and permitted dependency direction;
- callers, consumers, schemas, persistence formats, and public boundaries;
- state owner and source of truth;
- relevant failure, cancellation, reconnect, restart, concurrency, duplicate
  delivery, stale-result, and partial-stream behavior;
- authentication, process, filesystem, network, remote-environment, provider,
  and desktop-bridge trust boundaries;
- CPU, memory, queue, task, I/O, cloning, and backpressure behavior on hot
  paths;
- existing tests and living documents that define the behavior.
```

Require the smallest coherent change that preserves repository boundaries.
Direct agents to improve the correct shared abstraction when multiple consumers
need the same policy, while avoiding speculative generalization, duplicate
sources of truth, compatibility aliases without a requirement, hidden
fallbacks, and unrelated cleanup.

Require the corresponding living architecture document to change in the same
patch whenever package ownership, protocol flow, persisted shape, runtime
topology, lifecycle guarantees, security boundaries, or documented invariants
change. Require alternatives and trade-offs to be recorded in an approved
design document before a non-trivial new architectural decision is implemented.

- [ ] **Step 6: Add implementation-quality rules**

Add `## Implementation Quality` before completion requirements. Require agents
to define observable success and relevant failure cases before editing, inspect
the existing implementation and tests, and update the closest behavioral
coverage.

Include these operational rules:

```markdown
- Keep changes scoped to the requested outcome and necessary architectural
  support.
- Preserve unrelated worktree changes.
- Follow existing naming, errors, logging, schema, and module conventions.
- Keep shared logic in the package that owns it; do not duplicate policy.
- Update documentation, examples, fixtures, schemas, and contracts together
  when public behavior changes.
- Test public behavior and important failure/lifecycle seams, not private
  implementation details.
- Run focused tests after each meaningful behavior change.
```

Retain the existing maintainability guidance, but remove any repeated sentence
that is now expressed more precisely by the new section.

- [ ] **Step 7: Expand completion requirements into an evidence-based gate**

Keep the existing `vp` command distinction and mandatory gates. Expand
`## Task Completion Requirements` so completion requires:

```markdown
1. Focused tests for every changed behavior.
2. Broader package, integration, build, or end-to-end checks when the change
   crosses package or runtime boundaries.
3. Successful `vp check` and `vp run typecheck`.
4. For Rust changes, `cargo fmt --all --check`, relevant Rust tests, and Clippy
   for affected targets with warnings denied.
5. Final `git diff` and `git status --short` review for unintended edits,
   generated files, debug output, dependency drift, and missing documentation.
6. A synced configured vendored subtree when its matching dependency changes.
7. Report the exact validation commands, any command that could not run, and
   residual risk.
```

State that `vp test` is the built-in Vite+ test command and `vp run test` is the
workspace package-script graph. Select broader checks according to risk; a broad
suite does not replace focused coverage for changed behavior.

- [ ] **Step 8: Run the instruction contract audit**

Run:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const instructions = readFileSync("AGENTS.md", "utf8");
const claudeInstructions = readFileSync("CLAUDE.md", "utf8");
const requiredFragments = [
  "## Required Pre-Work",
  "codegraph sync . --quiet",
  "docs/architecture/overview.md",
  "docs/reference/workspace-layout.md",
  "docs/reference/scripts.md",
  "## Evidence and Documentation",
  "## Architectural Decision Standards",
  "partial-stream",
  "## Implementation Quality",
  "Do not install, initialize, unlock, repair, or fully re-index CodeGraph",
  "cargo fmt --all --check",
  "exact validation commands",
];
const missing = requiredFragments.filter(
  (fragment) => !instructions.includes(fragment),
);

if (missing.length > 0) {
  console.error({ missing });
  process.exit(1);
}

if (claudeInstructions.trim() !== "AGENTS.md") {
  console.error("CLAUDE.md must remain the AGENTS.md pointer.");
  process.exit(1);
}

console.log("Agent instruction contract verified.");
NODE
```

Expected: exit 0 and print `Agent instruction contract verified.` If wording
changes during editing, adjust the audit only to match equally explicit policy;
do not weaken the required semantics.

- [ ] **Step 9: Review the policy as an agent would consume it**

Run:

```bash
git diff --check
git diff -- AGENTS.md CLAUDE.md
git status --short
```

Expected: no whitespace errors; `AGENTS.md` has one coherent workflow without
contradictory or duplicate requirements; `CLAUDE.md` is absent from the diff;
no `.repos/` or `.codegraph/` files are present. Confirm that every command and
path named in the new instructions exists or is explicitly conditional.

- [ ] **Step 10: Run repository completion gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0. This task changes policy documentation only, so
no application test suite is necessary unless the repository gates reveal a
related generated or contract dependency.

- [ ] **Step 11: Commit the implementation**

Run:

```bash
git add AGENTS.md
git commit -m "docs: strengthen agent work quality guidance"
```

Expected: the commit contains only `AGENTS.md`; `CLAUDE.md` still points to the
root policy, and the final report records the contract audit plus both mandatory
repository gates.
