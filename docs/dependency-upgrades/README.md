# Dependency Upgrade Records

The dated reports in this directory are immutable audit snapshots. Their
versions, counts, findings, and verification results describe the recorded date
and commit only; they are not current dependency documentation.

`2026-07-17-ledger.json` is the exception to the historical-only rule. Its dated
path is retained for compatibility, but the file remains active,
machine-consumed policy input for `scripts/check-dependency-upgrade-ledger.ts`
and the root `check:dependency-ledger` package script. Update that ledger when
dependency policy changes, and validate it with:

```bash
vp run check:dependency-ledger
```

Do not infer current dependency state from a dated prose report; use manifests,
lockfiles, the active ledger, and validator output.

Rust inventory keys preserve declaration ownership. Root
`[workspace.dependencies]` entries use `rust:workspace:<name>`; an explicit
dependency in a standalone manifest uses
`rust:<manifest-directory>:<name>`, even when the root declares the same name.
A true `workspace = true` consumer is inherited and does not create another
row. Root `[patch.crates-io]` overrides use `rust:patch:<name>` and are
classified by their effective `path` or pinned Git source. Repeated target or
dependency-table declarations for the same name inside one manifest collapse
to that one manifest-owned key and retain every distinct declared value. A
reserved-scope collision such as `workspace/Cargo.toml` producing a root-owned
key is rejected rather than overwritten.

Cargo applicability comes from its declaration context. Unconditional tables
apply to Linux, macOS, and Windows; `cfg(windows)` and
`cfg(target_os = "windows")` apply to Windows; the matching Linux and macOS
selectors apply to their operating system; and `cfg(unix)` applies to Linux and
macOS. Repeated manifest/name declarations union their known contexts. An
unrecognized selector leaves applicability non-authoritative instead of
guessing. For root workspace dependencies, explicit `workspace = true`
consumers supply the applicability when present.

Ledger status describes dependency state, not test-suite health. `current`
means the audited target was already selected, `green` means this migration
moved the declaration or compatible lock resolution to its audited target, and
`blocked` requires a concrete retained dependency boundary with an independent
release condition. Harness compile failures belong in validation metadata and
residual risk; they do not make every harness dependency blocked.
