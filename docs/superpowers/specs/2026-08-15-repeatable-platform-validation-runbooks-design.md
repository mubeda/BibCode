# Repeatable Platform Validation Runbooks Design

**Date:** 2026-08-15

**Status:** Approved in conversation; pending written-spec review

## Summary

Create a living `docs/testing/` section for repeatable native desktop
validation on Windows, Linux, and macOS. The section separates shared gates
from platform-specific procedures, provides one execution-report template, and
adds an agent instruction requiring the runbooks to remain aligned with source,
scripts, CI, packaging, and supported product behavior.

The runbooks describe the current validation contract. They are not tied to a
particular release, branch, commit, test count, duration, or screenshot set.
Each execution records those values in a report created from the template.

## Goals

- Give engineers and coding agents one indexed place to repeat complete native
  desktop validation.
- Keep shared preflight, automated gates, repair discipline, cleanup, and
  reporting requirements consistent across all supported operating systems.
- Preserve explicit native procedures for Windows, Linux, and macOS without
  duplicating the shared contract.
- Make cross-platform compatibility review mandatory when a change is tested
  on only one native host.
- Make packaged-app visual verification reproducible with disposable fixtures,
  isolated application data, screenshots, and original-resolution inspection.
- Require agents to update the runbooks whenever the commands, platform
  behavior, ownership rules, packaging, or required evidence changes.

## Non-Goals

- Replacing CI, package scripts, automated tests, or release procedures.
- Storing individual execution logs, screenshots, SHAs, timings, or test counts
  in living documentation.
- Claiming that static or contract checks equal native execution on another
  operating system.
- Adding a test runner, platform abstraction, CI workflow, or report database.
- Freezing the runbooks to v0.3.14 or the current validation branch.
- Duplicating instructions already owned by manifests, scripts, or CI when a
  link and a verification rule are sufficient.

## Approved Structure

The living documentation will be rooted at `docs/testing/`:

- `README.md` is the entry point. It explains which runbook to select, the
  distinction between native and compatibility evidence, and how execution
  reports relate to living documentation.
- `cross-platform-validation.md` owns shared preflight, revision inputs,
  focused and broad automated gates, failure classification, RED-to-GREEN
  repair discipline, cross-platform review, cleanup, and final reporting.
- `windows-desktop.md` owns MSVC and Windows SDK preparation, WSL presentation,
  Windows path/file identity, junction fixtures, Job/process cleanup, native
  packaging, and Windows visual checks.
- `linux-desktop.md` owns distribution and display-protocol inventory, native
  package variants, Unix symlink identity, process-group cleanup, and Linux
  visual checks.
- `macos-desktop.md` owns application and DMG verification, macOS physical path
  identity, renderer-data isolation, process cleanup, signing/notarization
  classification, and macOS visual checks.
- `execution-report-template.md` provides the common PASS, PASS WITH RESIDUAL
  RISKS, BLOCKED, or FAIL evidence format.

`docs/README.md` will expose the new section under operations and reference.
The existing CI and release documents will link to the shared validation
runbook rather than copy it.

## Shared Execution Model

Every native platform runbook follows the same order:

1. Inventory the native host and required toolchain.
2. Verify the worktree, remote revision, requested branch, required commits,
   and product version supplied for that execution.
3. Inspect the affected source, tests, manifests, CI, and living documents.
4. Run focused behavioral tests before broad suites.
5. Run the workspace test graph, Rust workspace tests, formatting, linting,
   type checking, and diff checks applicable to the change.
6. Build and inspect the native package produced from the exact tested worktree.
7. Exercise disposable external-worktree and lifecycle scenarios relevant to
   the platform.
8. Launch only the package built by the current worktree with isolated
   application data and perform visual verification through Codex Computer Use.
9. Audit the non-native platform contracts without representing that audit as
   native evidence.
10. Stop owned processes, remove only test-created resources, and prove no
    scoped survivors remain.
11. Record the result using the execution-report template and perform the final
    Git audit.

The shared runbook names stable repository commands only when those commands
are verified against current manifests and scripts. Platform pages describe
how to discover artifact names and supported platform values rather than
assuming filenames that may change.

## Safety and Failure Discipline

The runbooks require testers to:

- stop when requested commits, branch state, or version inputs are absent;
- preserve unrelated changes, user repositories, user application data,
  credentials, processes, mounts, and pre-existing temporary directories;
- use disposable repositories, worktrees, profiles, package targets, and
  visual fixtures for destructive or identity-sensitive scenarios;
- resolve exact process, directory, mount, and worktree ownership before
  cleanup;
- distinguish product defects, test-fixture defects, package/build defects,
  and environment limitations;
- reproduce a failure with the smallest relevant command and establish a
  deterministic behavioral RED before repairing a real defect;
- reject sleep/yield ordering, timeout widening, broad serialization, global
  locks, global environment or CWD mutation, and weakened assertions as test
  repairs;
- rerun focused, package, static, native package, and visual gates in
  proportion to the affected boundary; and
- report every command that could not run and every remaining risk.

Native Windows, Linux, and macOS results are reported separately. A run on one
host may provide source, contract, or cross-target evidence for another host,
but may not call that evidence a native pass.

## Platform-Specific Responsibilities

### Windows

The Windows runbook covers PowerShell, MSVC, the Windows SDK, WebView2, native
file identity, drive-letter and separator variants, directory junctions, long
paths, Windows Jobs, WSL availability and mapped bootstrap behavior, native
installer metadata, Authenticode classification, and Windows-specific process
cleanup. WSL remains a same-device Windows environment; SSH, Tailscale, relay,
and remote-device presentation follow the current desktop policy.

### Linux

The Linux runbook records distribution, architecture, kernel, desktop
environment, display protocol, and packaging support. It covers AppImage and
other repository-supported artifacts, symlinked path identity, Unix process
groups, WebKitGTK/runtime requirements, taskbar/launcher presentation, and the
absence of WSL and remote-device desktop presentation.

### macOS

The macOS runbook covers `.app` and DMG metadata, the actual
`CFBundleExecutable`, ad-hoc or configured signing, notarization availability,
symlinked ancestors such as `/tmp` and `/private/tmp`, isolated renderer data,
safe restoration, process-group cleanup, and package-specific visual review.

## Visual Verification

All platform pages require Codex Computer Use, not Orca, for packaged desktop
interaction. Each run identifies the exact executable before launch, proves no
other BiBCode instance is used as evidence, and captures original-resolution
screenshots at normal and minimum supported sizes.

The visual review records absolute artifact paths and inspects full images plus
focused crops for clipping, overflow, spacing, truncation, icon/text alignment,
focus rings, tooltip placement, disabled states, stale labels, and unintended
layout movement. Diagnostic images are separated from acceptance evidence.

The disposable functional scenario includes external worktree discovery and
adoption, provider visibility, local environment presentation, thread and
terminal switching, Activity/subagent/background-task presentation, restart,
and process cleanup. Authentication-dependent checks are reported accurately
when credentials are unavailable; they are not silently skipped.

## Execution Reports

The template begins with one result classification:

- PASS
- PASS WITH RESIDUAL RISKS
- BLOCKED
- FAIL

It then records the tested branch and HEAD, native environment, requested
commit/version inputs, focused and broad command results, native package
artifacts, packaged UI evidence, external-worktree scenario, process and temp
cleanup, compatibility audits, source changes and commits created during the
run, commands that could not execute, residual risks, and whether anything was
pushed.

Run-specific SHAs, versions, test counts, durations, logs, screenshots, and
machine paths belong in these reports, not in the living runbooks. The template
does not prescribe a permanent report directory because CI artifacts, issue
attachments, pull requests, and local evidence folders have different
retention owners.

## Agent Maintenance Rule

`AGENTS.md` is the repository's authoritative agent instruction file.
`CLAUDE.md` imports it through `@AGENTS.md`, so the maintenance rule is written
once in `AGENTS.md` and is not duplicated.

Agents must review and update `docs/testing/` in the same change whenever they
modify:

- test commands, package scripts, test targets, or CI/static gates;
- desktop build, packaging, signing, or artifact-discovery procedures;
- supported operating-system or environment presentation;
- provider visibility or availability;
- worktree discovery, adoption, identity, persistence, or removal;
- process ownership, admission, cancellation, shutdown, reaping, or cleanup;
- packaged UI flows covered by native visual validation; or
- required validation evidence or the execution-report schema.

Agents verify procedures against current source, manifests, scripts, CI, and
tests. Historical plans and prior reports cannot be copied as current commands
without that verification. When no testing-document change is needed, final
work should state that the affected runbooks were reviewed and remain accurate.

## Alternatives Considered

1. **Approved: shared core plus three platform runbooks and a report template.**
   This keeps common rules consistent while making native execution direct.
2. One large cross-platform document. Rejected because platform preparation,
   packaging, identity, and UI differences would make it difficult to execute
   and maintain.
3. Three independent platform documents. Rejected because shared gates and
   repair discipline would be duplicated and drift over time.
4. Versioned validation snapshots only. Rejected because the requested value is
   repeatability as source, scripts, and platform behavior evolve. Dated
   execution reports still preserve historical evidence.

## Verification

The documentation change is complete when:

- all six `docs/testing/` files exist and cross-link without circular or stale
  navigation;
- `docs/README.md`, `docs/operations/ci.md`, and
  `docs/operations/release.md` link to the appropriate runbooks;
- `AGENTS.md` contains the maintenance rule and `CLAUDE.md` remains the single
  import of `AGENTS.md`;
- commands, script names, environment values, package behavior, and artifact
  discovery instructions are checked against current manifests, source, CI,
  and tests;
- living runbooks contain no branch-specific SHA, fixed release version, fixed
  test count, execution duration, or local evidence path;
- links and paths are checked directly;
- `vp check`, `vp run typecheck`, and `git diff --check` pass; and
- the final diff and status contain only the intended documentation and agent
  instruction changes.

## Residual Risk

Manual platform procedures can still drift when behavior changes without an
agent following repository instructions. Keeping shared rules small, linking
to executable sources, and requiring runbook review in `AGENTS.md` reduces but
cannot eliminate that risk. Native toolchains and signing credentials also
vary by host, so the runbooks require explicit environment classification
rather than pretending every optional packaging step is always available.
