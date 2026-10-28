# Handler chains (#204): plan

Design: [`2026-10-27-handler-chains-design.md`](../specs/2026-10-27-handler-chains-design.md).
Branch `claude/b3d-handler-chains` from `claude/issue-batch-after-v0.12.0`.

## Acceptance

- Harness: ChatView render scopes (`--var handleOpenProviderTerminalPanel`)
  equal at changed-2, changed-4 and changed-8 (now 29 / 41 / 65); composer
  scopes (`--var submitComposer`) reported likewise.
- No behavior change: ChatView and ChatComposer suites pass, plus tests that
  each changed handler keeps one identity and reads the latest render's state.

## Root cause (evidence)

Alternating memoized callbacks retain each other's render contexts:
`ChatView.tsx:1774` `refuseWhileEnvironmentUnavailable` (deps: unavailable
state, refusal key) and `ChatView.tsx:6358` `onCompactConversation` (deps:
thread, connecting, busy, ...); composer render scopes reach them through the
`setThreadError` prop (`ChatView.tsx:2760`, passed at `:7159`), read by
`ChatComposer.tsx:1872` `shouldBlurMobileComposerOnSubmit`'s context, which
`submitComposer` (`:1893`, the form's `onSubmit`) keeps. Measured paths are in
the design.

## Change

1. Move `useLatestHandler` from `ChatComposer.tsx:257` to
   `apps/web/src/hooks/useLatestHandler.ts` (same body, JSDoc gains the safety
   rule); ChatComposer imports it.
2. Wrap, mechanically (body unchanged, dependency list removed):
   ChatView `setThreadError`, `refuseWhileEnvironmentUnavailable`,
   `onCompactConversation`; ChatComposer `shouldBlurMobileComposerOnSubmit`.
3. Rebuild, rerun the harness, read the top paths; wrap only newly named
   alternating links after the same call-site audit (render-time or child
   layout-effect callers excluded). At most two rounds, then replan.

## Files

- `apps/web/src/hooks/useLatestHandler.ts` (new), `useLatestHandler.test.tsx` (new)
- `apps/web/src/components/ChatView.tsx`, `ChatView.test.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`, `ChatComposer.rerender.test.tsx`
- `docs/architecture/rpc-and-orchestration.md`: one sentence beside the #134
  retention note naming the long-lived handler rule and the hook.

## Tests (TDD where the seam exists)

- Hook: identity constant across renders; post-commit call runs the latest
  handler with arguments and result.
- ChatView: composer `setThreadError` prop identity survives a rerender that
  changes thread and connection state, and the first-captured function sets the
  latest thread's error; ThreadErrorBanner's compact action identity survives
  the rerender and runs the latest compaction path.
- ChatComposer: submit after a rerender that changes mobile/busy inputs follows
  the latest inputs for blur.
- Commands (from `apps/web`): `vp test run --project unit src/hooks/useLatestHandler.test.tsx
  src/components/ChatView.test.tsx src/components/ChatView.hooks.test.tsx
  src/components/chat/ChatComposer.test.tsx src/components/chat/ChatComposer.rerender.test.tsx
  src/reactCompiler.test.tsx`; root `vp check --no-fmt`, `vp check <changed files>`,
  `vp run typecheck`, `vp test run scripts/bibcode-identity.test.ts`.

## Harness recipe (scratch only, nothing committed)

- `df -h /` first; stop under 30 GB free.
- From `apps/web`: `vp build --minify false --outDir <scratch>/dist-<round>`
  (unminified so context slots keep their names).
- Server: copy of the existing guarded debug `bibcode` (no Rust build). Run the
  copied `run.mjs` (REPO and BIN pointed at this worktree and the copy) with
  `TMPDIR=/tmp BIBCODE_HERMETIC_GUARD=report node --experimental-strip-types run.mjs
  --out <dir> --web <dist> --port 14204`. Without `TMPDIR=/tmp` the guard
  refuses the fixture's provider shims; without `report` it aborts on the
  keychain probe.
- `node --max-old-space-size=12000 ctx.mjs <dir>/<snapshot>.heapsnapshot --var
  handleOpenProviderTerminalPanel` for each snapshot; same with
  `--var submitComposer`.

## Docs and runbooks

`docs/testing/` runbooks: no command or gate changes, so reviewed and expected
to stay accurate. Profiler coverage: none applies (no processes, RPC methods,
removal paths, binaries, shutdown, or events).

## Skipped

Wrapping all ~25 ChatView-to-composer props, switching the hook to an insertion
effect, and a lint rule for the pattern: not needed for the acceptance.
