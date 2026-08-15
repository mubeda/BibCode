# Cross-Platform Validation

This page defines the procedure common to every native desktop validation.
Pair it with the [Windows](./windows-desktop.md),
[Linux](./linux-desktop.md), or [macOS](./macos-desktop.md) runbook.

## Inputs

Before starting, record the requested:

- repository and remote;
- branch or exact revision;
- required ancestor commits, if any;
- expected product version, if any;
- native operating system and architecture;
- features, regressions, and user scenarios in scope; and
- permission boundaries for commits, pushes, merges, installations, system
  settings, credentials, and external services.

Inputs are execution data. Do not edit the living runbooks to insert them.

## Required pre-work

1. Read every applicable `AGENTS.md` from the repository root to the affected
   files.
2. Run `git status --short` and preserve unrelated changes.
3. State the requested outcome, constraints, affected packages, and completion
   evidence.
4. Follow the CodeGraph setup and fallback rules in `AGENTS.md`.
5. Read `docs/README.md`, the architecture overview, workspace layout, scripts
   reference, relevant living documents, package manifests, tests, and CI.
6. Inspect recent history for affected paths when intent is unclear.

Do not install, repair, or re-index repository tools outside the authority
granted by `AGENTS.md` and the current request.

## Revision and worktree preflight

Use GitHub CLI for GitHub metadata and Git for worktree/revision operations.
A typical read-only preflight is:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
gh repo view --json nameWithOwner
gh api "repos/OWNER/REPOSITORY/git/ref/heads/BRANCH"
git fetch origin BRANCH
git rev-list --left-right --count "origin/BRANCH...HEAD"
```

Replace the uppercase input tokens for the current execution. Quote branch
names when the shell requires it. Fast-forward only a clean worktree and only
when the request authorizes updating it. Never force-checkout, reset, rewrite,
or overwrite unrelated changes to reach a requested revision.

For every required commit:

```sh
git merge-base --is-ancestor REQUIRED_COMMIT HEAD
```

Stop when a required revision or expected version is absent. Do not test an
older substitute or recreate a missing change from memory. Record local HEAD,
remote HEAD, merge base, ahead/behind counts, required ancestry, and the version
sources used by the affected packages.

## Source-of-truth audit

Trace the feature from public behavior to its owner before selecting tests.
Inspect:

- package scripts and workspace manifests;
- relevant source, schemas, persisted formats, and public contracts;
- focused unit and integration tests;
- `.github/workflows/ci.yml`, native desktop smoke, and release workflows;
- [repository scripts](../reference/scripts.md);
- [CI quality gates](../operations/ci.md); and
- [release process](../operations/release.md) for native artifact support.

Check platform boundaries explicitly: filesystem identity, path spelling,
process ownership, environment presentation, desktop bridge operations,
provider availability, network trust, cancellation, restart, duplicate
delivery, partial streams, and cleanup.

## Focused tests

Run the closest behavioral coverage before broad suites. Discover exact Rust
targets and filters from manifests and `cargo test -- --list`; do not invent
test names. When concurrency matters, run the affected owner at its default
harness width and at the repository's relevant explicit parallel widths.

Use `vp test` for the built-in Vite+ test command. Use `vp run test` only when
the workspace package-script graph is required. Exact subprocess tests may
select a single thread only when the subprocess intentionally owns isolated
process-global state, as documented in the repository scripts reference.

A focused suite must cover the changed success behavior and its material
failure, cancellation, retry, restart, and cleanup seams. For cross-platform
logic, include host-independent fixtures for every affected platform.

## Workspace and static gates

Run broad owners sequentially so one Cargo process owns the shared build
directory at a time:

```sh
vp run test
cargo test --workspace -j 2
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git diff --check
```

Use the repository's Windows/MSVC launcher when required by the native Windows
page. The `-j 2` option bounds Cargo compilation jobs; it does not serialize
Rust test binaries. Do not add `--test-threads=1`, broad locks, sleeps, yields,
or larger production deadlines to make a loaded suite pass.

For each command record the exact invocation, exit code, duration, test totals,
warnings, cleanup diagnostics, and commands skipped after a failure. A broad
suite does not replace focused evidence.

## Native package contract

Build through current repository scripts. Discover the artifact and executable
from current package output and metadata rather than assuming a filename.
Confirm:

- package version and architecture;
- executable existence and permission;
- native package metadata and bundle identity;
- the artifact came from the tested worktree/revision; and
- signing, notarization, or Authenticode state without overstating unavailable
  credentials.

Build packaged desktop E2E through:

```sh
vp run test:ui:desktop:build
vp run test:ui:desktop
```

Set only the native platform value documented by the selected platform page.
Never use an installed BiBCode application as evidence for the worktree build.

## Disposable external-worktree scenario

Create a unique temporary Git repository outside BiBCode-managed worktree and
user project locations. Configure identity locally, create an initial commit,
then create two or more worktrees with native `git worktree add`.

Include platform-relevant path aliases and at least one path with spaces. Record
Git's worktree paths and the host's physical/canonical identities. In the
packaged application:

1. add the repository as a project;
2. observe manually created worktrees in **Discovered worktrees**;
3. verify the parent is grouped once and full paths remain accessible;
4. adopt one candidate and exercise **Add all** only on disposable candidates;
5. verify **Keep hidden** does not delete the Git worktree;
6. present the same physical worktree through its platform alias and confirm no
   duplicate owner/catalog entry appears;
7. restart the exact package and confirm identity/adoption persists; and
8. prove every external worktree still exists on disk.

Do not run destructive worktree scenarios against a user repository.

## Packaged visual validation

Use Codex Computer Use, not Orca, to operate the exact packaged executable.
Before launch, prove no conflicting BiBCode instance is running. Use disposable
application data and platform-specific renderer isolation without overwriting a
user profile.

Capture original-resolution screenshots at normal and minimum supported window
sizes. Cover relevant:

- Add Project and environment presentation;
- provider settings and provider/terminal action menus;
- discovered and adopted external worktrees;
- thread creation, switching, persistence, and streaming;
- terminal input/output and panel switching;
- Activity subagents and background tasks, including elapsed time and keyboard
  navigation;
- responsive menus, overlays, narrow panels, and focus states; and
- loaded interaction without stale ownership, duplicate events, or runaway
  process growth.

For every screenshot record the absolute evidence path, UI state, and review
finding. Inspect the full image and focused crops for clipping, overflow,
spacing, truncation, contrast, icon/text alignment, focus rings, tooltip
placement, disabled states, stale labels, and unintended movement. Keep
diagnostic frames separate from acceptance evidence.

Authentication-dependent scenarios must be reported as unavailable when the
native host has no suitable credentials. Never copy secrets into evidence.

## Non-native compatibility audit

Review shared and platform-gated code for every supported non-native host. Run
host-independent source-inclusion, contract, fixture, and cross-target checks
where they are supported. Confirm a native fix does not introduce:

- foreign path normalization or separators in shared code;
- an unsupported platform API in an unguarded module;
- platform-global environment or CWD mutation;
- deleted remote functionality when presentation alone is hidden;
- changed provider visibility outside the current product contract;
- lost process admission, cancellation, kill, wait, reap, or peer isolation;
- test serialization or timing workarounds; or
- dependency, lockfile, generated, or vendored-subtree drift.

If an SDK, linker, signing identity, or system service is unavailable, report
the exact limitation. Do not claim the non-native host passed.

## Failure classification and repair

On the first distinct failure:

1. stop the broad run and preserve its exact output;
2. reproduce once with the smallest relevant command;
3. classify it as product, test fixture, package/build, or environment;
4. trace the owning state and lifecycle boundary;
5. form a falsifiable hypothesis;
6. add a deterministic behavioral RED before a real repair;
7. implement the smallest coherent fix while preserving every platform;
8. rerun focused tests at relevant concurrency widths;
9. rerun affected package, static, native package, and visual gates in
   proportion to the boundary; and
10. update living architecture and these runbooks when their contract changes.

Do not repair tests with sleeps, yields, broad serialization, timeout widening,
global locks, global process mutation, retry loops that hide the failure, or
weakened assertions. Distinguish honest load-sensitive contract failures from
environment starvation with positive owner/readiness/cleanup evidence.

## Cleanup

Resolve exact ownership before any destructive action. Stop only processes
launched by the run, using PID plus executable, creation/start identity, and
fixture/worktree association where available. Unmount only test-owned package
mounts. Remove only exact disposable repositories, worktrees, profiles,
artifact directories, and temporary roots created by the run.

Capture before/after process and temporary-root snapshots. Report pre-existing
survivors without killing or deleting them. Prove no scoped desktop, server,
provider, terminal, WebDriver, package, or fixture process remains.

## Final Git audit

Run:

```sh
git diff --check
git status --short
git log --oneline -10
```

Review the complete diff for unrelated edits, debug output, generated files,
dependency/lockfile drift, vendored changes, platform leaks, and missing living
documentation. Re-sync CodeGraph when source changed and it is usable under
`AGENTS.md`.

Do not push, merge, open a pull request, or publish an artifact unless the
current request explicitly authorizes it.

## Reporting

Copy [the execution report template](./execution-report-template.md). Lead with
one result classification and keep native, compatibility, and unavailable
evidence separate. Do not claim completion from partial output or prior runs.
