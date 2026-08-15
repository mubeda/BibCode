# Repeatable Platform Validation Runbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add living, repeatable Windows, Linux, and macOS desktop validation runbooks with one shared contract, a reusable report template, and an agent rule that keeps the procedures current.

**Architecture:** `docs/testing/` owns current validation procedures. Shared safety, automated gates, repair discipline, cleanup, and reporting live in one cross-platform page; platform pages contain only native host/toolchain, packaging, identity, lifecycle, and visual deltas. Existing documentation links to these runbooks, while `AGENTS.md` makes reviewing them part of every affected change.

**Tech Stack:** Markdown, PowerShell 7, POSIX shell, Git/GitHub CLI, Vite+ (`vp`), Cargo/Rust, Tauri 2, WebdriverIO, Codex Computer Use.

## Global Constraints

- Runbooks are living documentation and must remain branch-, commit-, release-, test-count-, duration-, and machine-path-agnostic.
- Execution-specific values belong in reports created from the template.
- Native evidence, non-native contract evidence, and unavailable evidence must be labelled separately.
- Use current manifests, scripts, source, tests, CI, and release workflows as executable sources of truth.
- Preserve the existing remote functionality while documenting current desktop presentation.
- Windows WSL remains a same-device environment; Linux and macOS do not present WSL.
- Claude, Codex, Cursor, and OpenCode remain visible; Grok remains hidden from ordinary provider surfaces.
- Visual verification uses Codex Computer Use, not Orca.
- Runbooks must reject broad serialization, sleep/yield ordering, production timeout widening, global locks, global process environment/CWD mutation, and weakened assertions as test repairs.
- Do not add dependencies, scripts, workflows, schemas, or production code.
- `CLAUDE.md` remains `@AGENTS.md`; do not duplicate agent guidance there.

---

### Task 1: Shared Validation Contract and Report Template

**Files:**
- Create: `docs/testing/README.md`
- Create: `docs/testing/cross-platform-validation.md`
- Create: `docs/testing/execution-report-template.md`
- Reference: `docs/reference/scripts.md`
- Reference: `docs/operations/ci.md`
- Reference: `.github/workflows/ci.yml`
- Reference: `.github/workflows/desktop-ui-smoke.yml`

**Interfaces:**
- Consumes: Current command names from root `package.json`, package scripts, CI workflows, and `docs/reference/scripts.md`.
- Produces: Shared definitions and ordered execution phases referenced by all three platform pages; stable report headings referenced by every runbook.

- [ ] **Step 1: Establish the missing-section RED**

Run:

```sh
test -f docs/testing/README.md && \
test -f docs/testing/cross-platform-validation.md && \
test -f docs/testing/execution-report-template.md
```

Expected: FAIL because `docs/testing/` does not exist.

- [ ] **Step 2: Create the testing index**

Create `docs/testing/README.md` with these exact responsibilities:

```markdown
# Testing Runbooks

These runbooks describe the current repeatable validation contract. They are
living documentation, not execution history.

## Choose a runbook

- [Shared cross-platform validation](./cross-platform-validation.md)
- [Windows desktop](./windows-desktop.md)
- [Linux desktop](./linux-desktop.md)
- [macOS desktop](./macos-desktop.md)
- [Execution report template](./execution-report-template.md)

## Evidence classes

- Native evidence: executed on the named operating system.
- Compatibility evidence: source, contract, fixture, or cross-target checks
  for another operating system.
- Unavailable evidence: a command or capability that could not execute and is
  reported with its exact blocker.
```

Add short sections that require the shared page before a native page, define
living versus execution-specific material, and direct reports to use the
template without prescribing a permanent report storage location.

- [ ] **Step 3: Write the shared ordered procedure**

Create `docs/testing/cross-platform-validation.md` with these headings and
requirements:

```markdown
# Cross-Platform Validation

## Inputs
## Required pre-work
## Revision and worktree preflight
## Source-of-truth audit
## Focused tests
## Workspace and static gates
## Native package contract
## Disposable external-worktree scenario
## Packaged visual validation
## Non-native compatibility audit
## Failure classification and repair
## Cleanup
## Final Git audit
## Reporting
```

The content must:

- accept branch, required commits, and expected version as execution inputs;
- use `gh` for GitHub metadata and Git for fetch/ancestry/status checks;
- require AGENTS/docs/manifest/CI/test inspection and CodeGraph handling from
  `AGENTS.md`;
- run focused tests before `vp run test` and `cargo test --workspace -j 2`;
- require `vp check`, `vp run typecheck`, `cargo fmt --all --check`, relevant
  Clippy with `-D warnings`, and `git diff --check`;
- explain that `vp test` is the built-in Vite+ test command while
  `vp run test` is the workspace package graph;
- require one broad Cargo owner at a time and retain normal test-harness
  concurrency;
- verify native artifacts by discovery and metadata rather than hard-coded
  bundle executable names;
- create only disposable Git repositories/worktrees and isolated app data;
- require external worktree discovery, adoption, idempotence, restart, and
  non-destructive hide/remove checks;
- require Codex Computer Use, exact executable identity, original-resolution
  screenshots, focused crops, and separation of diagnostics from acceptance;
- define product, fixture, package/build, and environment failure classes;
- require deterministic RED-to-GREEN repair evidence without prohibited timing
  or serialization workarounds;
- stop only exact owned processes and remove only exact test-created roots;
- state that non-native evidence cannot be reported as a native pass; and
- require final status/diff review and the report template.

- [ ] **Step 4: Write the execution-report template**

Create `docs/testing/execution-report-template.md` with a copyable document
whose first field is exactly one of:

```markdown
**Result:** PASS | PASS WITH RESIDUAL RISKS | BLOCKED | FAIL
```

Include headings for:

```markdown
## Tested revision
## Native environment
## Requested inputs and ancestry
## Focused validation
## Workspace and static gates
## Native package artifacts
## Packaged UI and visual evidence
## External-worktree scenario
## Process and temporary-root cleanup
## Non-native compatibility evidence
## Source changes and commits created
## Commands not run
## Residual risks
## Publication state
```

Every command row must record command, result/exit code, duration, and evidence
or warning summary. Screenshot rows must record absolute path, state, and
pixel-review finding. Publication state must say whether anything was pushed,
merged, or opened as a PR.

- [ ] **Step 5: Verify the shared contract**

Run:

```sh
test -f docs/testing/README.md
test -f docs/testing/cross-platform-validation.md
test -f docs/testing/execution-report-template.md
rg -n "Native evidence|Compatibility evidence|Unavailable evidence" docs/testing/README.md
rg -n "vp run test|cargo test --workspace -j 2|vp check|vp run typecheck|cargo fmt --all --check|git diff --check" docs/testing/cross-platform-validation.md
rg -n "PASS WITH RESIDUAL RISKS|Commands not run|Publication state" docs/testing/execution-report-template.md
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the shared files**

```sh
git add docs/testing/README.md docs/testing/cross-platform-validation.md docs/testing/execution-report-template.md
git diff --cached --check
git commit -m "docs(testing): add shared validation contract"
```

---

### Task 2: Native Platform Runbooks

**Files:**
- Create: `docs/testing/windows-desktop.md`
- Create: `docs/testing/linux-desktop.md`
- Create: `docs/testing/macos-desktop.md`
- Reference: `scripts/run-msvc-x64.mjs`
- Reference: `scripts/build-desktop-artifact.ts`
- Reference: `apps/desktop/e2e/support/build-packaged-app.ts`
- Reference: `apps/desktop/e2e/wdio.conf.ts`
- Reference: `apps/desktop/package.json`
- Reference: `.github/workflows/desktop-ui-smoke.yml`
- Reference: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Shared phases and evidence definitions from `docs/testing/cross-platform-validation.md`; report schema from `docs/testing/execution-report-template.md`.
- Produces: One directly executable native runbook for each supported desktop operating system.

- [ ] **Step 1: Establish the platform-page RED**

Run:

```sh
test -f docs/testing/windows-desktop.md && \
test -f docs/testing/linux-desktop.md && \
test -f docs/testing/macos-desktop.md
```

Expected: FAIL because the platform pages do not exist.

- [ ] **Step 2: Write the Windows runbook**

Create `docs/testing/windows-desktop.md` with:

```markdown
# Windows Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first.

## Supported native target
## Host and toolchain inventory
## Focused Windows contracts
## External worktree and junction fixture
## WSL matrix
## Native tests and static gates
## NSIS package build and inspection
## Packaged UI scenarios
## Process and Job cleanup
## Linux and macOS compatibility audit
## Report and cleanup
```

Document Windows 10/11 x64, MSVC/Windows SDK/WebView2 checks, PowerShell 7,
`wsl.exe --status`, `wsl.exe --list --verbose`, exact repository MSVC wrapper
use, `BIBCODE_E2E_PLATFORM=win`, and `vp run dist:desktop:win:x64`.

The disposable scenario must use a normal path, a path with spaces, mixed case,
a long nested path, and a test-owned directory junction created with
`cmd /c mklink /J`. It must verify drive-letter/separator/case aliases do not
create duplicate owners and that destructive actions remain identity-safe.

The WSL matrix must distinguish installed/usable WSL from unavailable WSL.
Windows Local Environment remains visible in both cases; Add Project offers
only usable mapped WSL targets. Remote SSH/Tailscale/device controls remain
absent from ordinary desktop presentation.

Packaging must discover the generated NSIS executable, inspect PE/version
metadata, and classify `Get-AuthenticodeSignature` accurately. The runbook must
not require signing credentials for an ordinary local build because current
release documentation says Windows artifacts are unsigned.

Process validation must cover exact PID/image/creation identity, Windows Jobs,
late admission, cancellation, wait/reap, peer-runtime isolation, WSL process
boundaries, and zero scoped survivors.

- [ ] **Step 3: Write the Linux runbook**

Create `docs/testing/linux-desktop.md` with:

```markdown
# Linux Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first.

## Supported native target
## Distribution, desktop, and toolchain inventory
## Focused Linux contracts
## External worktree and symlink fixture
## Native tests and static gates
## AppImage build and inspection
## Packaged UI scenarios
## Process-group cleanup
## Windows and macOS compatibility audit
## Report and cleanup
```

Document the supported x64 Linux baseline from release docs, record kernel,
distribution, desktop environment, X11/Wayland, WebKitGTK/Tauri libraries, and
use `BIBCODE_E2E_PLATFORM=linux`, Xvfb when required, and
`vp run dist:desktop:linux`.

The disposable scenario must include normal, symlinked-parent, spaces, and long
paths. It must verify physical identity, exact display spelling, idempotent
adoption, restart, and non-destructive hiding. Visual checks must cover native
launcher/taskbar behavior, no WSL, local-only desktop presentation, provider
visibility, Activity, terminal, responsive layouts, and external worktrees.

Cleanup must prove Unix process-group ownership, bounded terminate/wait/reap,
and no scoped AppImage, WebDriver, provider, terminal, fixture, or temp-root
survivor.

- [ ] **Step 4: Write the macOS runbook**

Create `docs/testing/macos-desktop.md` with:

```markdown
# macOS Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first.

## Supported native targets
## Host and toolchain inventory
## Focused macOS contracts
## External worktree and symlink fixture
## Native tests and static gates
## Application and DMG build inspection
## Renderer-data isolation
## Packaged UI scenarios
## Process-group cleanup
## Windows and Linux compatibility audit
## Report, restoration, and cleanup
```

Document arm64 and x64 release targets, `BIBCODE_E2E_PLATFORM=mac`, host-native
`vp run dist:desktop:dmg`, artifact discovery, `Info.plist` inspection,
`CFBundleExecutable` lookup, executable permission, DMG read-only mounting, and
`codesign --verify --deep --strict`. Classify configured signing and
notarization separately; do not claim notarization when credentials are absent.

The path fixture must cover symlinked ancestors such as `/tmp` and
`/private/tmp`. Renderer isolation must resolve the exact bundle identifier,
back up only its exact WebKit/cache roots while the app is absent, use an
isolated app data root, and restore exact owned paths after quit. Any inability
to prove byte-identical restoration must be reported rather than repaired by
deleting user data.

Visual checks must cover providers, local-only desktop presentation, external
worktrees, Activity elapsed time, keyboard focus, terminal, minimum size, and
responsive overlays. Cleanup must prove exact process ownership, DMG detach,
zero scoped survivors, and no deletion of pre-existing build targets.

- [ ] **Step 5: Verify platform interfaces and prohibited drift**

Run:

```sh
rg -n "BIBCODE_E2E_PLATFORM=win|dist:desktop:win:x64|mklink /J|wsl.exe --list --verbose" docs/testing/windows-desktop.md
rg -n "BIBCODE_E2E_PLATFORM=linux|dist:desktop:linux|Xvfb|Wayland|AppImage" docs/testing/linux-desktop.md
rg -n "BIBCODE_E2E_PLATFORM=mac|dist:desktop:dmg|CFBundleExecutable|codesign --verify|/private/tmp" docs/testing/macos-desktop.md
rg -n "Codex Computer Use" docs/testing/windows-desktop.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md
if rg -n "codex/parallel-runtime-worktree-validation|68ae60ca|75be2e9e|0\.3\.14|[0-9]+/[0-9]+ tests" docs/testing; then exit 1; fi
```

Expected: required interfaces are present and the stale/execution-specific scan
finds no match.

- [ ] **Step 6: Commit the platform pages**

```sh
git add docs/testing/windows-desktop.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md
git diff --cached --check
git commit -m "docs(testing): add native desktop runbooks"
```

---

### Task 3: Navigation, Operations Cross-Links, and Agent Maintenance

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/operations/ci.md`
- Modify: `docs/operations/release.md`
- Modify: `AGENTS.md`
- Verify unchanged: `CLAUDE.md`

**Interfaces:**
- Consumes: Final paths and responsibilities from Tasks 1 and 2.
- Produces: Repository-wide discovery paths and a maintenance obligation for future agents.

- [ ] **Step 1: Establish navigation and maintenance REDs**

Run:

```sh
rg -n "Testing runbooks" docs/README.md
rg -n "docs/testing|testing/README|platform validation runbooks" AGENTS.md
rg -n "cross-platform-validation" docs/operations/ci.md docs/operations/release.md
```

Expected: each command fails because the links and rule are absent.

- [ ] **Step 2: Add the documentation index entry**

In `docs/README.md`, add under **Operations and reference**:

```markdown
- [Testing runbooks](./testing/README.md)
```

Do not classify `docs/testing/` as historical material.

- [ ] **Step 3: Cross-link CI and release ownership**

In `docs/operations/ci.md`, add a closing paragraph stating that native manual
and packaged validation follows
`../testing/cross-platform-validation.md` plus the host platform page.

In `docs/operations/release.md`, add a link from local verification to
`../testing/README.md`, clarifying that the release checklist owns release
publication while testing runbooks own repeatable native validation evidence.

Do not duplicate command matrices already present in those documents.

- [ ] **Step 4: Add the authoritative AGENTS maintenance rule**

Add a `## Testing Runbook Maintenance` section to root `AGENTS.md` after
**Evidence and Documentation**. It must require agents to review and update
`docs/testing/` in the same change when modifying:

- commands, scripts, targets, CI/static gates;
- desktop build, package, signing, or artifact discovery;
- platform/environment presentation;
- provider visibility or availability;
- worktree discovery, adoption, identity, persistence, or removal;
- process admission, ownership, cancellation, shutdown, reaping, or cleanup;
- packaged UI flows included in visual validation; or
- required evidence/report schema.

Require verification against current source, manifests, scripts, tests, and CI.
Require final reports to say that the affected runbooks were **reviewed and
remain accurate** when no documentation change was needed. State that
execution SHAs, versions, counts, timings, and screenshots belong in reports,
not living runbooks.

Do not modify `CLAUDE.md`; it must remain exactly:

```text
@AGENTS.md
```

- [ ] **Step 5: Verify navigation and authoritative ownership**

Run:

```sh
rg -n "Testing runbooks" docs/README.md
rg -n "Testing Runbook Maintenance|docs/testing/|reviewed and remain accurate" AGENTS.md
rg -n "cross-platform-validation|testing/README" docs/operations/ci.md docs/operations/release.md
test "$(cat CLAUDE.md)" = "@AGENTS.md"
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit navigation and maintenance rules**

```sh
git add AGENTS.md docs/README.md docs/operations/ci.md docs/operations/release.md
git diff --cached --check
git commit -m "docs(testing): require runbook maintenance"
```

---

### Task 4: Full Documentation Verification

**Files:**
- Verify: `AGENTS.md`
- Verify: `CLAUDE.md`
- Verify: `docs/README.md`
- Verify: `docs/testing/*.md`
- Verify: `docs/operations/ci.md`
- Verify: `docs/operations/release.md`
- Modify only if verification finds an error in the new documentation.

**Interfaces:**
- Consumes: All runbooks, links, and maintenance rules from Tasks 1–3.
- Produces: A clean, navigable, command-accurate documentation section ready for repeated use.

- [ ] **Step 1: Recheck executable sources of truth**

Compare every documented command and platform value against:

```sh
rg -n '"test"|"test:ui:desktop"|"test:ui:desktop:build"|"build:desktop"|"dist:desktop' package.json apps/desktop/package.json apps/server/package.json
rg -n "BIBCODE_E2E_PLATFORM" apps/desktop/e2e/wdio.conf.ts apps/desktop/e2e/support/build-packaged-app.ts .github/workflows/desktop-ui-smoke.yml
rg -n "ubuntu-|windows-|macos-|AppImage|NSIS|DMG" .github/workflows/ci.yml .github/workflows/release.yml docs/operations/release.md
```

Expected: documented commands, values `win`, `linux`, and `mac`, and platform
targets agree with current sources.

- [ ] **Step 2: Check local Markdown links**

Run this read-only Node link check:

```sh
node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = [
  "docs/README.md",
  "docs/operations/ci.md",
  "docs/operations/release.md",
  "docs/testing/README.md",
  "docs/testing/cross-platform-validation.md",
  "docs/testing/windows-desktop.md",
  "docs/testing/linux-desktop.md",
  "docs/testing/macos-desktop.md",
  "docs/testing/execution-report-template.md",
];
const missing = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(file), target.split("#", 1)[0]);
    if (!existsSync(path)) missing.push(`${file}: ${target}`);
  }
}
if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
NODE
```

Expected: exit 0 with no missing local target.

- [ ] **Step 3: Check living-runbook hygiene**

Run:

```sh
if rg -n "TBD|TODO|FIXME|codex/parallel-runtime-worktree-validation|68ae60ca|75be2e9e|0\.3\.14|/Users/|[A-Z]:\\\\Users\\\\" docs/testing; then exit 1; fi
rg -n "Native evidence|Compatibility evidence|Unavailable evidence" docs/testing/README.md
rg -n "PASS WITH RESIDUAL RISKS|BLOCKED|FAIL" docs/testing/execution-report-template.md
```

Expected: no placeholder, branch-specific, release-specific, or local-machine
content; evidence and report classifications remain present.

- [ ] **Step 4: Run repository documentation/static gates**

Run sequentially:

```sh
vp check
vp run typecheck
git diff --check
```

Expected: all commands exit 0. Existing non-fatal compiler suggestions must be
reported accurately, not called new documentation failures.

- [ ] **Step 5: Review final scope**

Run:

```sh
git status --short
git diff --stat HEAD~3..HEAD
git log --oneline -5
```

Review every changed file. Confirm there are no source, dependency, generated,
vendored, or CodeGraph changes staged or committed.

- [ ] **Step 6: Commit verification corrections only if needed**

If Steps 1–5 required a documentation correction, stage only the corrected
documentation and commit:

```sh
git add AGENTS.md docs/README.md docs/operations/ci.md docs/operations/release.md docs/testing
git diff --cached --check
git commit -m "docs(testing): finalize validation runbooks"
```

If no correction was required, do not create an empty commit.
