# Phase 14: The composer's model picker stays on the chat's provider

- Goal: A chat created for an agent lists only that agent's models before its first turn, and a chat whose provider is unavailable says so and refuses Send (#347, amendment A13).
- Round: 5
- Depends on: 10
- Owns: `apps/web/src/threadProviderBinding.ts`, its test, the composer provider banners and their tests, the Files "Add as project" default
- Shared files: `CHANGELOG.md`, `docs/user/workspace-ui.md` (other phases change them too; the coordinator integrates this phase's commits in sequence)
- Must not touch: the provider runtimes, persisted thread shape
- Skills: mstack-diagnose (a failing reproduction before any theory); test-driven-development; vercel-react-best-practices
- Read first: `spec.md` R110 to R112 and D51; GitHub issue #347; `UI.md` (disabled states explain themselves)
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/threadProviderBinding.test.ts` exits 0.

## Tasks

### Task 14.1: Reproduce, and bind a never-started server chat to its provider

- Satisfies: R110 (a new main chat lists its provider only; a second account of the same driver; a stale foreign selection), R111 (a blank draft still lists every provider; a drafted pick is the one it locks to)
- Depends on: none
- Files: modify `apps/web/src/threadProviderBinding.ts`; modify `apps/web/src/threadProviderBinding.test.ts`; modify the composer model picker tests
- Interfaces: consumes `resolveThreadProviderBinding` and the existing exact-instance lock; produces `resolveDefaultAgentInstanceId`, shared with Add Project.
- Skills: mstack-diagnose; test-driven-development
- Read first: the existing tests of the exact-instance lock for started chats
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/threadProviderBinding.test.ts` exits 0

Steps

1. [ ] Mount the real composer and model picker for a never-started main chat created for one provider, with two ready providers, and assert the list holds only that chat's instance. Run the command under Done when. Expected: FAIL, every ready provider's models are listed.
2. [ ] Bind a thread that exists on the server to its exact instance with the existing lock; leave a local draft unlocked; stop falling back to another provider when the chat's own is unavailable.
3. [ ] Open a project added from Files on the Default Agent through the shared resolver. Run the command under Done when. Expected: PASS.

### Task 14.2: Explain an unavailable provider and refuse Send

- Satisfies: R112 (a disabled or removed provider, never-started and started; an instance not reported yet)
- Depends on: 14.1
- Files: modify the composer banners and `apps/web/src/components/chat/ComposerPrimaryActions.tsx`, with their tests
- Interfaces: consumes the composer's existing blocked-reason prop; produces no names.
- Skills: test-driven-development; vercel-react-best-practices
- Read first: `UI.md`
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `pnpm exec tsc --noEmit` exits 0 and the composer banner tests pass

Steps

1. [ ] Render the real banners for a chat bound to a disabled or removed provider and assert the reason, the recovery and a refused Send. Run the web unit tests of the composer banners. Expected: FAIL, nothing is shown and Send submits.
2. [ ] Name the provider and the recovery in the banner and refuse Send through the blocked-reason prop. Run the same tests. Expected: PASS.

### Task 14.3: The server says when a configured agent is unsupported

- Satisfies: R112 (an agent the server does not support)
- Depends on: 14.2
- Files: modify `apps/server/src/production/control.rs` and its tests
- Interfaces: produces a provider snapshot with `availability: "unavailable"` for a configured instance whose driver the server does not support; the contract already defines it and the client already handles it.
- Skills: test-driven-development
- Read first: `packages/contracts/src/server.ts` (provider snapshot availability)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server -j 2 an_unsupported_driver_is_published_unavailable_before_the_settings_that_add_it` exits 0

Steps

1. [ ] Write a server test that configures an instance of an unsupported driver and expects an unavailable snapshot. Run the command under Done when. Expected: FAIL, no snapshot is sent.
2. [ ] Emit the snapshot after the settings update. Run the command under Done when. Expected: PASS.

### Task 14.4: User guide and changelog

- Satisfies: support (documentation of R110 to R112)
- Depends on: 14.2
- Files: modify `docs/user/workspace-ui.md`; modify `CHANGELOG.md`
- Interfaces: consumes the behavior of Tasks 14.1 and 14.2; produces no names.
- Skills: none
- Read first: the composer passage of `docs/user/workspace-ui.md`
- Tier: cheap
- TDD: exempt (documentation only, no behavior to test)
- Done when: `vp run check:markdown-links` exits 0 and `rg -c "#347" CHANGELOG.md` prints 1 or more

Steps

1. [ ] Describe the provider-scoped picker, that a started chat keeps its provider's other accounts, and the unavailable state; add one changelog line.
2. [ ] Run `vp run check:markdown-links`. Expected: no errors.
