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
