# PR/MR remote branch selection validation

**Result:** PASS WITH RESIDUAL RISKS. Focused tests and required static gates
passed. Packaged-app and unavailable skill-review evidence remain unverified.

## Scope and findings

Validated on Linux in the existing dirty checkout of `mubeda/main`, HEAD
`dc5d6d3852572317d0f1fff461b98e69c43ed23a`. Earlier authorized fixes remain
preserved. No commit, installation, push, or forge mutation was performed.

The previous dialog included local branches. Both shared branch selectors now
request `refKind: "remote"` and `includeMatchingRemoteRefs: true` through the
existing `vcs.listRefs` API, then exclude other remotes and symbolic `HEAD`.
Same-named local branches do not hide their origin counterparts. The lists use
origin-tracking refs from the last fetch; opening the dialog does not contact the
forge or fetch automatically.

Ordinary creation prefills the source only if the checkout has a matching origin
branch. Otherwise source selection remains required, with push/fetch guidance.
The explicitly combined commit/publish action retains its fixed current or new
source, which that action publishes first; its target choices are remote-only.
Missing-origin guidance takes priority over asking for a source that cannot be
selected yet. There are no Rust, contract, persistence, or dependency changes in
this follow-up.

## Evidence

Three new RED cases reproduced local-only options in both selectors and an
unpublished default source. A further RED check reproduced misleading guidance
when neither an origin nor a selectable source existed. All pass after the fix.
Coverage also verifies remote paging, explicit target selection, retained
content, and combined-action behavior.

Root component/logic checks: **176 passed in four files**.

```sh
node scripts/run-local-vp.mjs test run \
  apps/web/src/components/gitManager/provider/GitManagerCreatePullRequestDialog.test.tsx \
  apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.logic.test.ts \
  apps/web/src/components/GitActionsControl.test.tsx \
  apps/web/src/components/SourceControlPanel.test.tsx
```

React-compiled checks from `apps/web`: **148 passed in three files**.

```sh
node ../../scripts/run-local-vp.mjs test run --project unit \
  src/components/gitManager/provider/GitManagerCreatePullRequestDialog.test.tsx \
  src/components/GitActionsControl.test.tsx \
  src/components/SourceControlPanel.test.tsx
```

Other commands from the repository root:

| Command                                       | Result                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| `codegraph sync .`                            | Passed; caller/impact queries confirmed shared dialog coverage  |
| `node scripts/run-local-vp.mjs check`         | Passed; 0 errors, 421 existing warnings                         |
| `node scripts/run-local-vp.mjs run typecheck` | Passed; all 11 tasks                                            |
| `git diff --check`                            | Passed                                                          |
| `git status --short`                          | Reviewed; earlier work preserved, no unintended generated files |

`vp` is unavailable on PATH, so commands use the repository launcher. Gate logs
are `/tmp/bibcode-remote-branches-{tests,compiled-tests,check,typecheck}.log`.

## Reviews and limitations

- `UI.md` reviewed: labels, empty-state guidance, disabled reasons, target
  reselection, and draft preservation remain consistent with the existing flow.
- The required `vercel-react-best-practices` skill is unavailable; that review
  was **not run**. Ordinary React review and compiled tests ran.
- The shared native validation procedure and living architecture/integration
  documentation were updated. Linux, Windows, and macOS runbooks were
  **reviewed and remain accurate**.
- Native packaged-app, live remote/forge, and new visual fixture checks were
  **not run** for this follow-up. The installed app remains unchanged.
- Existing server source and its remote-ref RPC regression were inspected; no
  server behavior changed, so native tests and Clippy were not repeated.
