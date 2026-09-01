# Testing Runbooks

These runbooks describe BiBCode's current repeatable validation contract. They
are living documentation, not execution history.

## Choose a runbook

Start with the shared procedure, then use the page for the native host:

- [Shared cross-platform validation](./cross-platform-validation.md)
- [Windows desktop](./windows-desktop.md)
- [Linux desktop](./linux-desktop.md)
- [macOS desktop](./macos-desktop.md)
- [Execution report template](./execution-report-template.md)

## Evidence classes

- **Native evidence:** the command or scenario executed on the named operating
  system.
- **Compatibility evidence:** source, contract, fixture, or cross-target checks
  for another operating system.
- **Unavailable evidence:** a command or capability that could not execute and
  is reported with its exact blocker.

Never describe compatibility or unavailable evidence as a native pass. A
complete report separates all three classes.

Native release reports also separate desktop-installer evidence from standalone-server
archive/package evidence. Each architecture requires its own native result; one
architecture never proves another.

## Living documentation and execution reports

The runbooks define current procedure and supported behavior. Branch names,
required commit SHAs, expected product versions, test counts, durations,
screenshots, logs, and machine paths are inputs or outputs of a particular run.
Record those values in a report created from the
[execution report template](./execution-report-template.md), not in these
pages.

Reports may live in CI artifacts, issue or pull-request attachments, or an
explicit local evidence directory. The runbooks do not prescribe one retention
owner. Never commit secrets, credentials, private user data, or unbounded logs.

## Operating rule

Read [Shared cross-platform validation](./cross-platform-validation.md) in full
before the native page. Source, manifests, scripts, tests, CI, and release
workflows remain executable evidence; if a runbook disagrees with them, stop,
classify the disagreement, and update the living documentation with the
behavior change.

Static lint evidence must be freshly re-derived rather than replayed from Cargo
cache. From the repository root, clean every workspace crate and then lint the
whole workspace with warnings denied:

```sh
cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
cargo clippy --workspace --all-targets -- -D warnings
```
