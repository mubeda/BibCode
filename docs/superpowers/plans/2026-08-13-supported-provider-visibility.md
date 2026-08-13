# Supported Provider Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Codex, Claude, Cursor, and OpenCode visible and effective while preserving explicit saved choices and truthful runtime status.

**Architecture:** Contracts and Rust settings continue to own defaults, provider inventory continues to report real probe state, and the web settings panel renders the supported built-in catalog independently of inventory readiness. The change removes only Cursor's preview/default-disabled policy; it does not synthesize installation or authentication.

**Tech Stack:** TypeScript, React, Effect Schema, Rust, Vitest, Cargo.

## Global Constraints

- Target release remains v0.3.14.
- Never hide Codex, Claude, Cursor, or OpenCode in Settings.
- Cursor and OpenCode have no Early Access presentation.
- Cursor defaults to enabled and `cursor-agent`; explicit persisted false remains false.
- Grok remains disabled and hidden.
- Do not weaken provider probing, authentication, or runtime failure reporting.

---

### Task 1: Lock the supported-provider UI contract

**Files:**
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx`
- Modify: `apps/web/src/components/settings/providerDriverMeta.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

**Interfaces:**
- Consumes: `PROVIDER_CLIENT_DEFINITIONS`, `serverProviders`.
- Produces: permanent built-in cards for literal IDs `codex`, `claudeAgent`, `cursor`, and `opencode`.

- [ ] Add a test whose empty/partial live inventory expects the literal card order `codex`, `codex_personal`, `claudeAgent`, `cursor`, `opencode`, `cursor_alt` and rejects an Early Access label for Cursor/OpenCode.
- [ ] Run the focused test and observe the missing `cursor` failure.
- [ ] Remove the Cursor inventory-presence filter and Cursor badge metadata while retaining the Grok exclusion.
- [ ] Run the focused settings tests and observe GREEN.

### Task 2: Make Cursor an enabled, executable default

**Files:**
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `apps/server/src/server_settings/mod.rs`
- Modify: `apps/server/src/production/provider_inventory.rs`
- Modify: closest Rust tests in those modules.

**Interfaces:**
- Consumes: absent or explicit Cursor provider settings.
- Produces: absent values resolve to `{ enabled: true, binaryPath: "cursor-agent" }`; explicit false remains false.

- [ ] Add contract and Rust tests for enabled-by-default, explicit-false preservation, and inventory fallback to `cursor-agent`.
- [ ] Run exact tests and observe the literal false/wrong fallback failures.
- [ ] Change only absent-value defaults in contracts, Rust settings, and inventory fallback.
- [ ] Run exact tests and affected suites GREEN.

### Task 3: Align living provider documentation

**Files:**
- Modify: `docs/providers/cursor.md`
- Modify: `docs/providers/README.md`

**Interfaces:**
- Produces: current setup/default/support documentation matching executable behavior.

- [ ] Remove Early Access/default-disabled wording and document truthful probe states and explicit disable behavior.
- [ ] Run formatting and documentation checks through `vp check`.

### Task 4: Verify the merged v0.3.14 branch

**Files:**
- No source files unless a test exposes a defect.

**Interfaces:**
- Consumes: the complete branch after main merges and provider fix.
- Produces: automated and visual completion evidence.

- [ ] Run focused web/contracts/server tests.
- [ ] Run `vp run test` and `cargo test --workspace -j 2`.
- [ ] Run `vp check`, `vp run typecheck`, `cargo fmt --all --check`, and workspace Clippy with warnings denied.
- [ ] Rebuild the v0.3.14 macOS app and run the complete packaged UI suite.
- [ ] Use Codex Computer Use to verify provider cards, an external worktree not created by BiBCode, thread state, panels, and performance-sensitive navigation; capture screenshots and inspect them at pixel level.
- [ ] Fetch remote main again, review the final diff/status, and commit the scoped fix without losing main's changes.
