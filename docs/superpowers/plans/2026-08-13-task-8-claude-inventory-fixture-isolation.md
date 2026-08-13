# Task 8 Claude Inventory Fixture Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude production-control inventory tests own exactly their Claude fixture so ambient installed providers cannot delay or change their assertions.

**Architecture:** Keep provider inventory production behavior unchanged. The integration fixture supplies explicit legacy-provider disablement and disables maintenance update checks, then verifies through the public server snapshot that Claude is the only enabled provider before running its full probe.

**Tech Stack:** Rust, Tokio tests, `NativeServerControl`, Cargo.

## Global Constraints

- Preserve the production 10-second provider probe timeout.
- Do not serialize tests or mutate process-global environment/current-directory state.
- Do not depend on any ambient provider executable, network service, or user configuration.
- Preserve the uncommitted Task 8 package, CI, script, and documentation edits.

---

### Task 1: Isolate Claude production-control inventory fixtures

**Files:**
- Modify: `apps/server/tests/production_control.rs`
- Create: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-8-claude-inventory-fixture-report.md`

**Interfaces:**
- Consumes: the existing `providers` legacy settings shape and `providerInstances.claudeAgent` integration fixture.
- Produces: three Claude inventory cases whose only enabled provider is the test-owned `claudeAgent` instance.

- [ ] **Step 1: Add a deterministic owner assertion and run RED**

Before the first full refresh, read `server.getConfig`, collect enabled provider instance IDs, and assert the literal list is `['claudeAgent']`. Run:

```bash
cargo test -p bibcode-server --test production_control claude_inventory_uses_authoritative_discovered_model_catalog -- --exact --nocapture
```

Expected: FAIL because default legacy Codex and OpenCode providers are enabled in the old fixture settings.

- [ ] **Step 2: Add the minimal fixture isolation**

For all three Claude inventory settings documents, set `enableProviderUpdateChecks` to `false` and explicitly set `providers.codex.enabled`, `providers.cursor.enabled`, `providers.grok.enabled`, and `providers.opencode.enabled` to `false`. Keep the configured Claude instance and its command-local environment unchanged.

- [ ] **Step 3: Run exact GREEN and the owner suite under parallel harnesses**

```bash
cargo test -p bibcode-server --test production_control claude_inventory_uses_authoritative_discovered_model_catalog -- --exact --nocapture
cargo test -p bibcode-server --test production_control claude_inventory_hides_models_unsupported_by_the_installed_cli_version -- --exact --nocapture
cargo test -p bibcode-server --test production_control claude_inventory_keeps_discovered_models_when_skill_reload_is_invalid -- --exact --nocapture
cargo test -p bibcode-server --test production_control
cargo test -p bibcode-server --test production_control -- --test-threads=8
cargo test -p bibcode-server --test production_control -- --test-threads=12
```

Expected: all commands pass without provider probe timeout diagnostics or surviving fixture processes.

- [ ] **Step 4: Run repository gates and review the scoped diff**

```bash
cargo test -p bibcode-server -j 2
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
git status --short
```

Expected: all gates pass; only this plan, the Claude integration fixture, and its ignored task report belong to this repair.

- [ ] **Step 5: Obtain independent review and commit the repair**

Have a read-only reviewer check fixture isolation, lack of ambient dependencies, unchanged production deadlines, and preserved Task 8 edits. Address any Important or Critical finding before committing:

```bash
git add docs/superpowers/plans/2026-08-13-task-8-claude-inventory-fixture-isolation.md apps/server/tests/production_control.rs
git commit -m "test(server): isolate Claude inventory fixtures"
```
