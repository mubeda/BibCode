# Code review button

Issue #293, amendment A11. Requirements R90 to R105, decisions D40 to D49. Phase 12 of the
batch plan in [2026-11-09-issue-batch-340-345-290](2026-11-09-issue-batch-340-345-290/plan.md).
Status: Draft, for the user's approval before code lands.

## Problem

A review today takes several manual steps: open a chat, pick an agent, paste a review prompt,
name the base branch and hope the agent does not edit. The Source Control panel already knows
the branch, the base and whether the tree is dirty, so it can start the review in one click.

## Facts on this branch

Everything below was read at commit `3cd0fbab8` unless marked otherwise.

- The panel header is the `header` element in `apps/web/src/components/SourceControlPanel.tsx`
  (about line 1075). It shows the ref name, the `vs <base>` label from `resolveVsBaseLabel`
  (`SourceControlPanel.logic.ts` line 118), an open pull request chip and the upstream counts.
  It has no buttons. The panel receives `threadRef`, `gitCwd`, `projectRef` and
  `workspaceUnavailable` from `ChatView` (about line 7249). #343 and #345 changed the panel's
  push and status code on this branch; the header itself is unchanged by them.
- `ChatView` owns both launchers a review needs: `centerPanelActions` (chat panels, side chats)
  and `openCenterTerminal` with `handleOpenProviderTerminalPanel` (AI Terminals, about line
  4804).
- **A public client cannot give a new thread a worktree through `thread.turn.start`.** The
  client schema `ClientThreadTurnStartBootstrapCreateThread` has no `worktreePath`
  (`packages/contracts/src/orchestration.ts` about line 1113; `orchestration.test.ts` line 794
  asserts it is stripped), and `decode_public_orchestration_command`
  (`apps/server/src/production/orchestration_rpc.rs` about line 350) refuses one with "worktree
  authority requires a dedicated server-resolved RPC". `ChatView`'s `bootstrap.createThread`
  therefore only reaches the main checkout. The issue's `useStartThreadWithPrompt` built on it
  would review the wrong checkout from a worktree.
- The server-resolved path that gives a new thread its host's checkout and sends a first message
  already exists: side chats (#265, landed). `useCenterPanelActions`
  (`apps/web/src/centerPanelActions.ts` lines 328 to 457) calls `worktree.createPanel` with
  `threadDefaults`, then `startTurn`, and handles a close while creating, an unknown outcome and
  a double click. The issue's "#265 needs the same path" is stale: #265 built it.
- Runtime and interaction modes per driver:

  | Driver   | `interactionMode: "plan"`                                                                      | `runtimeMode: "approval-required"`                                                   | `runtimeMode: "full-access"` (the default)                    |
  | -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
  | Claude   | permission mode `plan`, whatever the runtime mode (`claude_mode`, `provider_runtime.rs` 20643) | permission mode `default`                                                            | permission mode `bypassPermissions`                           |
  | Codex    | adds plan developer instructions only (`provider/codex/model.rs` 759 to 778)                   | approval `untrusted`, sandbox `readOnly` (`model.rs` 728)                            | approval `never`, sandbox `dangerFullAccess`                  |
  | Cursor   | `session/set_mode` to a `plan` or `architect` mode (`provider/acp_mode.rs` 14)                 | `ask` mode; permission requests wait for the person                                  | `code` or `agent` mode; permission requests are auto-approved |
  | Grok     | as Cursor                                                                                      | as Cursor                                                                            | as Cursor                                                     |
  | OpenCode | ignored                                                                                        | `ask` rules on edit, bash and the rest (`provider/opencode/runtime.rs` 5832 to 5854) | one `allow` rule for everything                               |

  The new-thread default is `DEFAULT_RUNTIME_MODE = "full-access"` (`orchestration.ts` line
  130); no setting changes it. Side chats already force `approval-required`
  (`centerPanelActions.ts` line 347).

- Claude reports a plan through the `ExitPlanMode` tool: `handle_assistant_message`
  (`provider/claude/runtime.rs` line 2529) turns its `plan` input into `turn.proposed.completed`.
  BiBCode launches Claude with `--print` and no permission prompt tool, and nothing calls
  `open_permission_request` (line 2548), so BiBCode never answers a Claude permission request.
  The `--settings` BiBCode adds (`claude_session_settings`, `provider_runtime.rs` line 18686)
  carries only HTTP hooks for activity, and the hook sink answers `204 No Content` with no
  decision (`provider/claude/hook_sink.rs`), so no BiBCode hook grants a permission. But the same
  launch passes `--setting-sources=user,project,local` (`provider_runtime.rs` near 18635), so the
  person's and the repository's own Claude settings load too. Claude's documentation (cited by the
  plan review, not re-read here) says such a hook can approve `ExitPlanMode`, allow rules can let
  edit tools run, and `permissions.defaultMode: "bypassPermissions"` adds bypass to the mode cycle.
  So plan mode is the mechanism BiBCode sets, not a guarantee: configuration it loads can weaken
  it.
- A panel thread takes its host's `branch` and `worktreePath` on the server
  (`worktree_catalog_rpc.rs`, the `thread.create` it dispatches near line 1545), and the engine
  refuses a panel whose host is itself a panel (`engine.rs` line 4915), so a review from a panel is
  hosted by that panel's host.
- The chat offers Implement while `interactionMode === "plan"` and the latest proposed plan is
  not implemented (`showPlanFollowUpPrompt`, `ChatView.tsx` about line 2359). An empty Enter then
  sends `PLEASE IMPLEMENT THIS PLAN` in default mode (`resolvePlanFollowUpSubmission`,
  `apps/web/src/proposedPlan.ts`). "Implement in a new thread" sits in
  `ComposerPrimaryActions.tsx` (line 277).
- AI Terminal definitions (`apps/web/src/components/chat/providerTerminalActions.ts` line 30)
  launch Claude with `--dangerously-skip-permissions` and Codex with
  `--dangerously-bypass-approvals-and-sandbox`. `TerminalLaunchCommand` caps an argument at
  8,192 characters and the count at 64 (`packages/contracts/src/terminal.ts` lines 47 and 48).
- On Windows the server resolves the executable on `PATH` and wraps a `.cmd` or `.bat` file in
  `cmd.exe` (`apps/server/src/terminal/pty.rs` line 685, `apps/server/src/process/executable.rs`
  lines 141 to 229). Each argument is quoted when it holds anything outside
  `[A-Za-z0-9#$*+-./:?@\_]`, a quote becomes `""`, `%` becomes `%%cd:~,%%`, and a line break is
  refused. The web never sees which file was resolved, so the issue's "when the resolved
  executable is a `.cmd`" rule has nowhere to run in the web. The existing Windows test
  (`apps/server/tests/windows_terminal_shims.rs` line 585) echoes `%~1`, not `%*` as npm shims
  forward, and that test target is not run by CI (`.github/workflows/ci.yml` only compiles the
  Windows test targets, line 405).
- Settings are validated, defaulted and patched by hand on the server
  (`apps/server/src/production/control.rs`: `validate_settings_document` line 2144,
  `apply_settings_defaults` line 2583, `apply_settings_patch` line 2631, where `defaultAgent` is
  replaced whole). The issue's "add three fields to `ServerSettings`" also needs these.
- Migration 72 (`WorktreeCreationRecords`) is in `MIGRATIONS` already
  (`apps/server/src/persistence/migrations.rs` line 675). The next free number is 73.
- `sideChat` is the model for a thread flag: a contract field, `WorktreeCreatePanelInput.sideChat`
  (`deny_unknown_fields` on the server, `worktree_catalog_rpc.rs` line 3530), migration 67, a
  projection column and the `sideChats` capability (`packages/contracts/src/environment.ts` line
  104).

### Installed CLIs

Checked with `claude --version` (2.1.322), `codex --version` (codex-cli 0.167.1) and `--help` of
each, plus these probes. No probe sent a prompt to a model: Codex stopped at "stdin is not a
terminal", and the Claude probe ran with `--bare` and a bad API key so it stopped at "Invalid API
key".

| Behaviour                                 | Claude 2.1.322                                                                                  | Codex 0.167.1                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Prompt as the last positional argument    | yes, `claude [options] [command] [prompt]`                                                      | yes, `codex [OPTIONS] [PROMPT]`                                                 |
| `--` before a prompt that starts with `-` | verified: `-- --version` became a prompt                                                        | verified: `-- --version` became a prompt                                        |
| `--` before a prompt equal to a command   | **not protected**: `-- mcp` still ran `claude mcp`                                              | verified: `-- features` became a prompt; without `--` it ran `codex features`   |
| Read-only flags                           | `--permission-mode plan` (choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan) | `--sandbox read-only`, `--ask-for-approval never` (values on-request, never)    |
| Model and effort                          | `--model`, `--effort`                                                                           | `--model`, `-c key=value`                                                       |
| Prompt from stdin in the interactive UI   | not probed                                                                                      | no: `codex -` stops at "stdin is not a terminal"; only `codex exec` reads stdin |
| `git status` under `--sandbox read-only`  | not applicable                                                                                  | reasoned only: Git skips an index refresh it cannot write                       |

Claude's command list includes `purge`, `install`, `rm` and `stop`, so a project prompt that is
exactly one of those words would run that command. Claude 2.1.322 lists `manual`, not `default`,
as a permission mode, while the chat driver sends `default` for `approval-required`; whether the
CLI still accepts `default` is unverified and outside this issue (it does not affect plan mode).

## Approach

1. A **Review changes** icon button and a menu button sit in the Source Control header.
2. `resolveCodeReviewScope(status)` picks the scope: branch when `aheadOfDefaultCount > 0`,
   uncommitted when files exist and no commits are ahead, none otherwise. The base is
   `origin/<defaultRefName>`.
3. The prompt is a fixed BiBCode lead-in, then the first non-blank of the project prompt, the
   user prompt and `DEFAULT_CODE_REVIEW_PROMPT`, with `{scope}` and `{base}` replaced.
4. A chat reviewer opens a **chat panel of the current thread** through the side-chat path, with
   `runtimeMode: "approval-required"`, the interaction mode its driver needs (below) and the
   prompt as its first message. The panel is a tab beside the work, titled `Code review ·
   <provider>`, and the server marks it `codeReview: true`.
5. A terminal reviewer (Claude or Codex) opens an AI Terminal through the existing
   `handleOpenProviderTerminalPanel`, with read-only flags, `--`, and the prompt last.
6. Settings → Agents gets a Code review group (agent, model, prompt with Reset). The menu next to
   the button edits the project's prompt.

### Read-only, per reviewer

The guard each reviewer gets, what can weaken it, and the words the UI may use. The UI names
the mechanism BiBCode sets and never promises the outcome ("cannot edit"). MECHANISM means the
provider applies a block or an approval gate that BiBCode requests; INSTRUCTED means only the
prompt asks.

| Reviewer        | What BiBCode sets                                               | Guard                                                                          | Can be weakened by                                                                                                                                   | UI line                                                            |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Claude chat     | interaction `plan`, runtime `approval-required`                 | MECHANISM: Claude plan mode                                                    | user, project or local Claude settings: a hook that approves `ExitPlanMode`, allow rules for edit tools, a default bypass mode; the composer pickers | "Starts in Claude's plan mode."                                    |
| Codex chat      | interaction `default`, runtime `approval-required`              | MECHANISM: `readOnly` sandbox; a write escalation waits for the person         | the person approving an escalation; the runtime picker                                                                                               | "Runs in Codex's read-only sandbox. Writes ask for your approval." |
| OpenCode chat   | interaction `default`, runtime `approval-required`              | MECHANISM: OpenCode `ask` rules hold edits and commands for approval           | the person approving; the runtime picker                                                                                                             | "Edits and commands ask for your approval."                        |
| Cursor chat     | interaction `default`, runtime `approval-required` (`ask` mode) | INSTRUCTED: the agent's own mode; BiBCode holds only requests the agent raises | anything the agent does without asking                                                                                                               | "Told not to edit. BiBCode cannot block edits for this agent."     |
| Grok chat       | as Cursor                                                       | INSTRUCTED                                                                     | as Cursor                                                                                                                                            | as Cursor                                                          |
| Claude Terminal | `--permission-mode plan`, no bypass flags                       | MECHANISM: Claude plan mode                                                    | the same Claude settings as the chat, including a user or managed `defaultMode` of `bypassPermissions`; Shift+Tab in the terminal                    | "Starts in Claude's plan mode."                                    |
| Codex Terminal  | `--sandbox read-only --ask-for-approval never`, no bypass flag  | MECHANISM: a write fails back to the model                                     | Codex's sandbox support on the platform (unverified on Windows); commands typed in the terminal                                                      | "Runs in Codex's read-only sandbox."                               |

Every review prompt also starts with "Do not edit files." (the lead-in below), so every row keeps
that line even when a custom prompt drops it. The UI shows the line in the Settings → Agents
reviewer row and in the button's tooltip. The changelog, the user guide and the requirements use the
same mechanism wording.

**Open decision for the user (not changed by this plan): which Claude settings a review loads.**
Options:

1. Keep loading user, project and local settings, as every Claude chat does, and name only the
   mechanism. This plan's default; no code change.
2. Load user settings only for review sessions (`--setting-sources user`), so a repository cannot
   weaken plan mode, at the cost of the repository's own settings (its hooks, permissions and
   plugins; CLAUDE.md is separate).
3. Add deny rules for edit tools on review sessions. Claude 2.1.322's `--help` offers
   `--disallowedTools` ("tool names to deny", for example `Edit`). Deny rules do not stop a write
   made through Bash, and whether a hook can override them was not checked here.

Options 2 and 3 can combine. Each would add a requirement and a task once chosen.

### Prompt lead-in

The resolved text always starts with:

```text
Code review requested from BiBCode. Do not edit files. Scope: {scope}. Base: {base}.
```

`Base: {base}.` is left out for the uncommitted scope. The lead-in closes four holes at once: a
custom prompt that starts with `-`, `/`, `!`, `#` or `@`; a custom prompt that is exactly a
Claude subcommand (Claude dispatches `-- purge`); a custom prompt that leaves out the scope or the
"do not edit" line; and a prompt that a person did not write (a project prompt set by someone
else) reaching a CLI as its first token. A unit test pins it.

### Default prompt

`DEFAULT_CODE_REVIEW_PROMPT` in `packages/contracts/src/settings.ts` is the issue's text, kept as
written (it repeats the scope in its first sentence, which does no harm). `{scope}` expands to
"the commits on the current branch that are not on {base}, plus all staged, unstaged and
untracked changes" or "the staged, unstaged and untracked changes in the working tree".

## Alternatives and decisions

**D40. The review opens as a chat panel of the current thread.** Alternatives: the issue's new
top-level thread through `bootstrap.createThread` (cannot carry a worktree for a public client,
so a review from a worktree would read the main checkout); a new dedicated server RPC that creates
a top-level thread in a worktree (new authority surface, a new RPC to cover in the profiler, and
nothing the panel path lacks). The panel path is server-resolved, already covers close-while-
creating and unknown outcomes, and puts the findings beside the work as Conductor does. Agent's
call. A draft chat (no server thread yet) has no host and no terminal launch context
(`resolveCenterPanelLaunchContext` returns `null` for it, `ChatView.logic.ts` line 211), so both
reviewer kinds are disabled there with a reason (D48).

**D41. Review chats run with `approval-required`, and `plan` only where plan mode is the block.**
The issue's open question 1 recommends the user's default runtime mode. On this branch that
default is `full-access`, which gives Codex `dangerFullAccess` with plan text as the only guard,
auto-approves Cursor and Grok permission requests, and allows everything in OpenCode. Options:

- User's default runtime mode, plan everywhere (the issue): nothing is enforced except Claude.
- `approval-required` and `plan` everywhere: Codex gains the read-only sandbox, but plan mode
  adds nothing to its guard and makes Codex, Cursor and Grok end with a proposed plan card.
- `approval-required` everywhere, `plan` only for Claude (chosen): every driver that can enforce
  a block or an approval gate does, and only Claude, whose plan mode is its hard block, produces
  plan cards. Cost: Codex's `untrusted` policy may ask before some read commands, which the
  person answers in the panel. Side chats already use `approval-required` for the same reason.

Agent's call, overriding the issue's recommendation as the brief requires.

**D42. A review thread offers no Implement.** The issue's open question 2 recommends checking
during implementation. Claude in plan mode reports through `ExitPlanMode`, which BiBCode shows as
a proposed plan, and an empty Enter would then implement it: one-click auto-fixing, a non-goal.
The thread therefore carries `codeReview: true`, set by the server at panel creation and kept like
`sideChat` (contract field, panel input, projection column, migration 74). For such a thread the
composer shows no Implement, Refine or "Implement in a new thread", and the plan card reads
"Review findings" with its copy and download actions. Alternatives: a title match (a rename breaks
it), a client-only flag (lost on reload or on another device), keeping Implement (no
justification: a person can ask for fixes in a normal chat). Agent's call.

**D43. Terminal prompts pass as `--` then the prompt, behind the lead-in; never through stdin.**
The issue's open question 3 recommends `--` and trimming leading dashes. `--` holds for both CLIs
for a leading `-`, but Claude still dispatches a bare subcommand word after `--`, and Codex cannot
read the interactive prompt from stdin. The lead-in makes the argument always start with "Code
review requested", so trimming is not needed and saved text is never changed. Agent's call.

**D44. Windows terminal reviews start disabled; the server refuses a batch command line that is
too long.** The web knows `serverConfig.environment.platform.os`, not the resolved file, so it
replaces each line break with one space whenever the environment is Windows (harmless for a
`.exe`). The length limit sits beside the encoder: `make_windows_batch_command_line` in
`apps/server/src/process/executable.rs` has no length check today, so it gains one that refuses an
encoded command line over the `cmd.exe` limit of 8,191 characters with "The command is too long
for a Windows terminal (N of 8,191 characters). Shorten the review prompt or pick a chat
reviewer." The terminal open path already shows a refused launch in a toast. No web-side estimate
duplicates the encoder (backslash doubling before quotes and at a quoted end, `""` and the `%`
expansion all count).

Because a suspected `%` fault sits on this path and the prompt is project data, the terminal
reviewer stays disabled on Windows environments ("Terminal reviews are off on Windows for now. Pick
a chat reviewer in Settings → Agents.") until native tests (Task 12.4) have run green on real
Windows, in CI or the local Windows VM. Those tests send one argument per class through a `%*`
shim to `node` and compare `process.argv`: quotes, `%` and `%PATH%`, `&`, `^`, `|`, `<` with `>`,
`!`, trailing backslashes, a backslash before a quote, and one argument combining them all.
Enabling is its own small task (12.17) gated on that evidence. If the `%` case fails, fixing the
encoder is a conditional task (12.18) with its own red-green test, and 12.17 waits for it.
Alternatives: a web-side length estimate (duplicates the encoder, and the first draft's missed
backslash doubling); a server-side line-break rewrite for batch targets (changes every terminal
launch). Decided by the coordinator.

**D45. The base is `origin/<defaultRefName>`; a stale local default branch may enable the
button.** The issue's open question 4 recommendation, kept: the prompt tells the agent to use the
local branch when the remote ref is missing. Agent's call.

**D46. The P1 shortcut is `mod+alt+shift+r`, not `mod+shift+r`.** `mod+shift+r` is the hard
reload in Chrome, Edge and Firefox and in the WebView2 desktop shell on Windows, and the web build
runs in a browser. No default binding on this branch uses `mod+alt+shift+r`
(`packages/shared/src/keybindings.defaults.json`), the desktop menu sets only `CmdOrCtrl+W` and
`CmdOrCtrl+Q` (`apps/desktop/src-tauri/src/window.rs`), no hard-coded handler in `apps/web/src`
checks it, and the matcher reads `event.code`, so macOS Option does not change the letter. It
keeps the R for review. Browser defaults are from vendor shortcut lists as known, not re-fetched.
`when: "!terminalFocus"`, because terminal programs use many chords. Agent's call.

**D47. A `codeReviews` capability gates the feature.** The new panel field meets
`deny_unknown_fields` on an older server, the project field and settings keys would be ignored or
refused there. The server advertises `capabilities.codeReviews`; without it the button is disabled
with "Update the BiBCode server on this environment to use Review." and the Settings rows say the
same. Agent's call.

**D48. Disabled states, and no fallback reviewer.** Every disabled state names its reason (UI.md),
including loading, which the issue left without a tooltip. The saved reviewer is resolved exactly,
without the fallback to the first chat in `resolveEffectiveProviderAgentAction`
(`providerAgentActions.ts` line 81): when it is missing or unavailable, the button is disabled with
"<reviewer> is not available. Change the code review agent in Settings → Agents.", or "The code
review agent is not available on this environment. Change it in Settings → Agents." when it is not
listed at all, because a fallback would change the provider and its guard silently. Decided by the
coordinator.

**D49. Settings are per environment; the model override applies only to its own instance.** A
review uses the settings of the environment that runs it, as the Default Agent does. A stored
`codeReviewModelSelection` whose instance differs from the reviewer's is ignored and the provider
session default applies. Agent's call.

## Data and contracts

- `ServerSettings`: `codeReviewAgent: DefaultAgentSelection` (default
  `DEFAULT_DEFAULT_AGENT_SELECTION`), `codeReviewModelSelection: NullOr(ModelSelection)` (default
  `null`), `codeReviewPrompt: String` with a maximum of 7,680 (default `""`), and the matching
  `ServerSettingsPatch` keys. The server validates the three keys, defaults them, and replaces
  `codeReviewAgent` and `codeReviewModelSelection` whole on a patch.
- Project: `codeReviewPrompt` on `OrchestrationProject`, `OrchestrationProjectShell` and
  `ProjectCreatedPayload` with a decoding default of `""`; optional on `ProjectMetaUpdateCommand`,
  `ClientProjectMetaUpdateCommand` and `ProjectMetaUpdatedPayload`. Server: the
  `ProjectMetaUpdate` variant, the decider payload, `project.created` writes `""`,
  `project.meta-updated` writes `COALESCE(?, code_review_prompt)` (an explicit `""` is kept, so
  Reset survives replay), `ProjectionProject`, `PROJECT_SELECT`, `decode_project`,
  `upsert_project`, `project_shell`. Migration 73 `ProjectCodeReviewPrompt`:
  `ALTER TABLE projection_projects ADD COLUMN code_review_prompt TEXT NOT NULL DEFAULT ''`, guarded
  like `migration_052`. Replay of an old `project.created` or `project.meta-updated` without the
  key decodes to `""` or leaves the column alone.
- Thread: `codeReview: Schema.optional(Schema.Boolean)` on `OrchestrationThread`,
  `OrchestrationThreadShell` and the thread-created payload, sent only when true;
  `WorktreeCreatePanelInput.codeReview`. Server: panel input field (skipped when false, so old
  receipts keep their digest), thread-created payload, migration 74 `ProjectionThreadCodeReview`
  (`code_review INTEGER NOT NULL DEFAULT 0`, guarded like `migration_067`), the shell, and
  `capabilities.codeReviews: true`.
- Fixtures under `packages/contracts/fixtures` change; `vp run check:contracts` regenerates and
  compares them.

## Trust boundaries

- **Project prompt.** Project data that any client allowed to dispatch `project.meta.update` can
  set, including another collaborator on a shared server or a synced project. It is text in a
  prompt, never a flag: it goes behind the lead-in, after `--`, as one argument through the
  existing argv path with no shell. The contract and the server cap it at 7,680 characters, and
  the launcher refuses a resolved prompt with control characters other than tab and line breaks.
  The person sees the full prompt as the panel's first message, and the dialog shows the project's
  prompt before they review.
- **Prompt injection.** A hostile prompt can ask the reviewer to edit or exfiltrate. The mechanisms
  in the table are what limit edits, within the weaknesses the table lists; the instructed rows
  say so in the UI. Network access is not
  changed by this issue.
- **Repository settings.** A project's `.claude/settings.json` (loaded through
  `--setting-sources=user,project,local`) or `.codex/config.toml` is read by the CLI as today, and
  for Claude it can weaken plan mode (see the open decision above). This plan does not change which
  settings a review loads.
- **No new privileged path.** The web reuses `worktree.createPanel`, `orchestration.dispatchCommand`
  and the terminal open path; the server resolves the checkout.

## Failure and lifecycle

- **Double click.** One review per host is in flight; a second click while creating does nothing
  (the side-chat guard pattern).
- **Panel creation fails.** The existing "Failed to open chat panel" toast; nothing else changes.
- **First message fails.** The panel stays open with the prompt in its composer and a toast
  "Couldn't start the review" / "The review prompt is in its composer." (as side chats).
- **Unknown outcome or reconnect.** The panel keeps its tab for adoption, as side chats do; the
  first message is not resent blindly.
- **Tab closed while creating.** The panel is archived once it exists and the prompt is not sent.
- **Restart.** The panel, its `codeReview` flag and the project prompt are durable; the terminal
  is an ordinary AI Terminal and follows the existing terminal lifecycle, unchanged here.
- **Cancel or shutdown.** The panel's Stop and the terminal's close work as for any chat or AI
  Terminal; nothing new runs in the background.
- **Status changes after the click.** The scope is read once at the click; a later status change
  does not alter a started review.

## Performance

The button reads the status the panel already subscribes to and derives scope with a pure
function. The prompt is resolved only on click. No new subscription, polling, RPC or process type.
Settings and project reads are existing atoms.

## Profiler, crash and trace coverage

None applies. No new RPC method (the review reuses `worktree.createPanel`, the orchestration
dispatch and the settings update), no new child process type (the terminal reviewer spawns through
the existing AI Terminal path, which is already supervised and attributed), no new binary,
re-exec mode, shutdown step, worktree removal path, event or finding.

## Out of scope

- P2.2, terminal reviewers for Cursor, Grok and OpenCode: their read-only flags are unverified.
- Posting review comments to GitHub or GitLab, auto-fixing findings, reviewing one commit or an
  arbitrary range, inlining the diff, `codex review` and `claude ultrareview`.
- Editing a remote environment's review settings from the primary Settings page beyond what
  Settings already offers.
- The Claude `default` versus `manual` permission mode name (noted above, not this issue).
