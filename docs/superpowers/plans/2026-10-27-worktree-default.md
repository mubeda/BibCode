# Plan: Create Worktree honours Settings → Default Agent (#185)

Batch `worktree-default`, branch `claude/b3-worktree-default` from `origin/develop` at
`27702287cc`. Phase 1 deliverable; nothing is implemented yet.

## Approval corrections (supersede the sections below where they differ)

1. **Empty agent list.** Never submit the default's instance id when the project's server
   config is missing or has no selectable agent: the server would reject the first launch.
   Create waits in both states, and the line under the picker says why.
2. **Complete caller.** A mounted test uses the real `useSettings` hook. It changes the Settings
   Default Agent control, the primary config update arrives, and the test opens Create Worktree.
   It asserts the picker and the create command's provider, for a primary project and a remote
   project. The fallback line goes away after a manual pick.
3. **Add Project.** `useAddProjectWorkflow.ts` adopts the same primary-server setting.
4. **Root cause wording.** The primary and the project's server hold divergent persisted
   settings: the remote reads its own `settings.defaultAgent`. An environment whose config is
   null is left out of the map (`packages/client-runtime/src/state/shell.ts:495`).
5. **Runbook.** The Create Worktree step in `docs/testing/cross-platform-validation.md`
   becomes definite.

## Acceptance criteria

1. **Runtime change.** With the app running, changing **Settings → Agents → Default Agent** and
   then opening **Create worktree** preselects the new agent, and a worktree created without
   touching the picker starts its thread with that agent's provider (chat) or replaces Main with
   that AI terminal (terminal).
2. **One source.** The dialog and Settings read the default selection from the same hook,
   `usePrimarySettings` (`apps/web/src/hooks/useSettings.ts:265-270`), for every project,
   including a project on a non-primary (remote, WSL, SSH) environment.
3. **Fallback explains itself.** When the default agent is unavailable for the project's
   environment, the picker falls back as today (first selectable chat) and one short line under
   the picker says why. The line goes away once the user picks an agent.
4. **Empty list at open.** Opening the dialog before the environment's agent list arrives does not
   lose the setting. When the list arrives, the picker preselects the default. Submitting before
   it arrives targets the default agent's instance, not the project default or `codex`.

## Root cause (source evidence)

- Settings reads and writes the **primary** server's settings:
  `AgentsSettingsPanel` uses `usePrimarySettings()` and `useUpdatePrimarySettings()`
  (`apps/web/src/components/settings/SettingsPanels.tsx:976-978`, write at `:1032`).
  `useUpdatePrimarySettings` targets `usePrimaryEnvironment()` only
  (`apps/web/src/hooks/useSettings.ts:308-310`).
- The dialog reads the default from the **project's environment** server config:
  `serverConfigs.get(environmentId)` → `serverConfig.settings.defaultAgent`
  (`apps/web/src/components/CreateWorktreeDialog.tsx:140, 366, 376-379`). It resolves it again
  from the same environment settings at submit (`:446-454`).
- For a primary-environment project these are the same value. `environmentServerConfigsAtom`
  and `primaryServerSettingsAtom` both read `serverEnvironment.configValueAtom(primaryId)`
  (`packages/client-runtime/src/state/shell.ts:489-507`, `apps/web/src/state/server.ts:24-27,
74-76`). The primary id comes from the catalog entries the map iterates
  (`apps/web/src/state/primaryEnvironment.ts:5-12`), so the primary is always in the map.
- For a project on **another environment**, the dialog reads that server's own
  `settings.defaultAgent`. No UI writes that value: Settings writes only the primary, and
  `useUpdateEnvironmentSettings` is used only by `ProfilerSection.tsx:319`. A remote project
  therefore always resolves the built-in default (`chat:codex`,
  `packages/contracts/src/settings.ts:516-519`), whatever the user chose. This is the reproducible
  defect.
- Secondary defects:
  - The submit-time fallback chain `selectedAction → project.defaultModelSelection → codex`
    (`CreateWorktreeDialog.tsx:451-454`) drops the setting when the action list is empty.
  - The disabled or absent default falls back silently (`resolveEffectiveProviderAgentAction`,
    `apps/web/src/components/chat/providerAgentActions.ts:84-98`). The only trace is a
    `console.warn` (`CreateWorktreeDialog.tsx:461-463`, a different fallback).
- Phase 2 first writes the runtime-change test for a **primary** project against current code.
  If it passes, as the source suggests, the plan's report says so: the primary path was already
  correct, and the defect is the remote path plus the two secondary defects. If it fails, that
  failure is a new root cause. I stop and report before widening scope.

## Authority decision

- **Selection:** a client-wide user preference owned by Settings. The dialog reads
  `usePrimarySettings(selectDefaultAgent)` with a module-level selector so the memo stays stable.
- **Availability:** per environment. The action list is still built from the project
  environment's `serverConfig.providers` and `serverConfig.settings`, because provider instances
  and their session defaults belong to that server. `resolveProviderSessionSelectionForInstance`
  keeps the environment settings.
- The default is resolved once, as `effectiveDefaultAgent` plus a fallback reason, and that
  result is reused at submit. The second resolution at `:450` is deleted.
- Rejected alternative: writing Default Agent to every environment. That multiplies writes,
  creates divergent copies on servers that can disconnect, and needs an editing UI per server.

## Change

`apps/web/src/components/CreateWorktreeDialog.logic.ts`:

- Add a pure helper,
  `resolveDefaultAgentChoice(actions, selection, environmentLabel) → { action, fallbackNotice }`.
- `action` keeps today's resolution rules: the saved action if it is selectable, otherwise the
  first selectable chat.
- `fallbackNotice` is `null` when the saved action was used or when there is nothing to fall back
  to. Otherwise it is one sentence:
  - when the saved instance is present but disabled: "<saved label> is unavailable (<disabledReason>),
    so <fallback label> is selected."
  - when the saved instance is absent from this environment: "Your default agent is not set up on
    <environment label>, so <fallback label> is selected."
- This file is outside the literal `CreateWorktreeDialog*.tsx` glob, but it is the dialog's own
  logic module. If the integrator objects, the helper goes into the `.tsx` instead.

`apps/web/src/components/CreateWorktreeDialog.tsx`:

- Read `defaultAgent` from `usePrimarySettings`.
- Compute the choice through the helper and render `fallbackNotice` as a muted line under the
  Agent picker while the selection is untouched.
- At submit:
  - use the selected action, or else the resolved default;
  - delete the `settings.defaultAgent` re-resolution;
  - when there is no action at all, insert `primaryDefaultAgent.instanceId` ahead of
    `project.defaultModelSelection?.instanceId ?? codex`.

No change to `useSettings.ts`: `usePrimarySettings` already exists and is correct. No change to
the Default Agent setting component.

## Tests (focused; complete dialog caller)

`CreateWorktreeDialog.logic.test.ts`:

- The helper returns the saved action with no notice.
- A saved action that is present but disabled gives the fallback and a notice with its reason.
- A saved instance that is absent gives a notice naming the environment.
- When nothing is selectable, the helper returns no action and no notice.

`CreateWorktreeDialog.test.tsx`:

- The harness gains `vi.mock("~/hooks/useSettings")` with `usePrimarySettings` backed by
  `testState.primarySettings`, a tiny `useSyncExternalStore` store, mirroring
  `SettingsPanels.test.tsx:121-124`.
- The existing static tests keep their meaning: their saved default moves from
  `serverConfigs.settings.defaultAgent` to `primarySettings.defaultAgent`.

New mounted tests run through `CreateWorktreeDialog.dom.test.tsx`, the happy-dom companion:

1. **Runtime change, primary project.** Mount the dialog closed with default `chat:codex`. Change
   the store to `chat:claudeAgent`, as Settings' `useUpdatePrimarySettings` write lands, and open
   the dialog. Assert the picker value is `chat:claudeAgent` and that `createWorktree` received
   `threadDefaults.modelSelection.instanceId === "claudeAgent"`. Repeat for a terminal default:
   `replaceMainWithTerminal` is called. Run this first, against current code (see Root cause).
2. **Remote project, primary wins.** The project is on `remote`, and the remote config's own
   `defaultAgent` is `chat:codex`. The primary default is `chat:claudeAgent`, and remote has
   `claudeAgent` ready. Assert that the picker and the created thread use claudeAgent. This fails
   on current code.
3. **Remote lacks the default.** Assert the picker shows `chat:codex`, the created thread uses
   codex, and the "not set up on <remote label>" line is rendered. A second case has the default
   present but disabled, and the line carries the disabled reason. The existing static test "falls
   back when the saved provider is disabled" also asserts the line.
4. **Empty list at open.** Open with no config for the environment, so the picker has no value.
   Then supply the config and re-render. Assert the picker preselects the default. Submitting
   before the config arrives sends the default's instanceId.

Scope of proof: these tests prove the dialog given `usePrimarySettings`. Whether a Settings write
reaches that hook is the existing chain Settings itself depends on: the RPC, the config stream,
then `primaryServerSettingsAtom`. These tests do not re-prove that chain.
`SettingsPanels.test.tsx` already covers the panel writing `{ defaultAgent }` through
`useUpdatePrimarySettings`.

## Validation commands (phase 2)

- `cd apps/web && vp test run --project unit src/components/CreateWorktreeDialog.logic.test.ts src/components/CreateWorktreeDialog.test.tsx src/components/CreateWorktreeDialog.dom.test.tsx src/components/settings/SettingsPanels.test.tsx src/components/Sidebar.browser.test.tsx`
- `vp check --no-fmt` plus `vp check <changed files>`
- `vp run typecheck`
- `vp test run scripts/bibcode-identity.test.ts`
- The React review of the dialog against vercel-react-best-practices: stable selector, no new
  effects, and derived state rather than a new `useState`.
- A UI.md review of the fallback line and the preselect behaviour.
- No Rust is touched, so there is no cargo run.

## Docs and runbooks

- `docs/user/workspace-ui.md:151`: the agent picker starts on Settings → Agents → Default Agent.
  For a project on another server where that agent is unavailable, the picker selects the first
  available chat and says why.
- `docs/architecture/remote.md` or `overview.md` settings scope: one sentence saying Default
  Agent is a primary-client preference applied against each environment's own provider list.
- `docs/testing/cross-platform-validation.md:2943` (Create Worktree): add a step "Default Agent
  preselects and creates" if the packaged UI flow covers the agent picker. Otherwise mark it
  reviewed and still accurate.
- Profiler coverage: none applies. The change adds no process, RPC, removal path, binary,
  shutdown step, or event. The existing `console.warn` stays as it is.

## Follow-up outside owned files (flag, do not fix)

- `apps/web/src/components/add-project/useAddProjectWorkflow.ts:1019-1027, 1087-1092` resolves
  Default Agent from each environment's own settings, the same pattern. After this change, Add
  Project and Create Worktree disagree for remote projects. It needs the same
  `usePrimarySettings` source in its owner's batch or a follow-up issue.

## Skipped (ponytail)

These are out of scope:

- A per-environment Default Agent editing UI.
- The Add Project change, which is flagged above.
- A new disabled or loading state for Create.
- Changes to `providerAgentActions.ts`, the `useSettings.ts` hook, or the Settings component.
