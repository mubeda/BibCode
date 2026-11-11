# Amendment A11: Source Control Review button (#293)

Amendment A11 (2026-11-11, user, adding #293 to this batch) brings in the Review button of issue
#293: one click in the Source Control panel starts a review of the current branch and its
uncommitted changes, by a chat or AI Terminal agent picked in Settings → Agents, guarded against
edits wherever the agent's provider can enforce it. Its first priority tier is in scope, then the
shortcut, the one-off reviewer menu, the scope tooltip and one-off instructions as separate later
tasks. Terminal reviewers for Cursor, Grok and OpenCode stay out (their read-only flags are
unverified). The design is in `docs/plans/2026-11-11-code-review-button-design.md`. Requirements
R90 to R105, decisions D40 to D49.

### R90. The Review button says when it can start a review [Must] (amendment A11)

WHILE the Source Control panel shows a repository, the panel SHALL offer a "Review changes"
button that is enabled when the working tree has a staged, unstaged or untracked change or the
branch has at least one commit that its default branch lacks, and SHALL otherwise be disabled
with a tooltip that names the reason.

#### Scenario: dirty tree on the default branch

- GIVEN branch `main` is the default branch, with one unstaged file and no commits ahead
- WHEN the panel is shown
- THEN "Review changes" is enabled

#### Scenario: clean feature branch with commits

- GIVEN branch `feature/a` with a clean tree and 2 commits ahead of `main`
- WHEN the panel is shown
- THEN "Review changes" is enabled

#### Scenario: nothing to review

- GIVEN a clean tree and 0 commits ahead, or a clean tree on a server that does not report a count ahead
- WHEN the panel is shown
- THEN the button is disabled with the tooltip "No changes to review" and clicking it starts nothing

#### Scenario: status still loading

- GIVEN the panel has not received its first status
- WHEN it is shown
- THEN the button is disabled with the tooltip "Checking for changes"

#### Scenario: older server

- GIVEN an environment whose server does not advertise code reviews
- WHEN the panel is shown with changes
- THEN the button is disabled with the tooltip "Update the BiBCode server on this environment to use Review."

### R91. A review covers the branch and the uncommitted changes against the remote base [Must] (amendment A11)

WHEN a review starts, the review launcher SHALL choose branch scope when the branch has commits
that its default branch lacks and uncommitted scope otherwise, and SHALL name the base as
`origin/` followed by the default branch name.

#### Scenario: branch scope

- GIVEN branch `feature/a`, default branch `main`, 2 commits ahead and one untracked file
- WHEN the scope is resolved
- THEN it is branch scope with base `origin/main`

#### Scenario: uncommitted scope

- GIVEN branch `main` (the default), 0 commits ahead and one staged file
- WHEN the scope is resolved
- THEN it is uncommitted scope, and the scope text is "the staged, unstaged and untracked changes in the working tree"

### R92. The review prompt follows project, then user, then default, behind a fixed lead-in [Must] (amendment A11)

WHEN a review starts, the review launcher SHALL send a prompt that begins with "Code review
requested from BiBCode. Do not edit files. Scope: " and the scope text, adds " Base: " and the base
for branch scope, and continues with the first non-blank of the project's review prompt, the
user's review prompt and the built-in default, with every `{scope}` and `{base}` replaced.

#### Scenario: all three set

- GIVEN project prompt "Check our test naming. Base is {base}.", user prompt "User text" and branch scope against `origin/main`
- WHEN the prompt is resolved
- THEN it starts with "Code review requested from BiBCode. Do not edit files. Scope: the commits on the current branch that are not on origin/main, plus all staged, unstaged and untracked changes. Base: origin/main." and continues with "Check our test naming. Base is origin/main."

#### Scenario: blank values fall through

- GIVEN a project prompt of three spaces and a user prompt of ""
- WHEN the prompt is resolved
- THEN the built-in default follows the lead-in

#### Scenario: a prompt that looks like a command

- GIVEN a project prompt "purge" or "--dangerously-skip-permissions"
- WHEN a terminal review is resolved
- THEN the argument after `--` starts with "Code review requested from BiBCode." and no argument before it comes from the prompt

### R93. Review settings decode with defaults and are validated [Must] (amendment A11)

The settings service SHALL store a code review agent, an optional review model and a review prompt
of at most 7,680 characters, SHALL give a settings document without them the defaults (the default
agent selection, no model, ""), and IF a patch carries a review prompt longer than 7,680 characters
or a malformed agent or model, THEN the settings service SHALL reject the patch and keep the stored
settings.

#### Scenario: old settings document

- GIVEN a settings document with no code review keys
- WHEN it is decoded
- THEN the agent is chat `codex`, the model is null and the prompt is ""

#### Scenario: patch round trip

- GIVEN a patch setting the agent to terminal `claudeAgent`, the model to `claudeAgent` / `opus` and the prompt to "Look at tests."
- WHEN it is applied and the settings are read back
- THEN all three values are returned, and a later patch with model null clears the model

#### Scenario: oversized prompt

- GIVEN a patch with a review prompt of 7,681 characters
- WHEN it is applied
- THEN it is rejected and the stored prompt is unchanged

### R94. A project keeps its own review prompt across restart and replay [Must] (amendment A11)

The orchestration engine SHALL store a project's review prompt of at most 7,680 characters from a
project metadata update, SHALL keep it when a later update omits it, SHALL store "" when an update
sets "", and SHALL give a project created or updated before the field existed the value "".

#### Scenario: set, omit, reset, replay

- GIVEN a project whose review prompt is set to "Project text"
- WHEN a title-only update follows, then the projections are rebuilt from the events
- THEN the prompt is still "Project text"; after an update with "" and another rebuild it is ""

#### Scenario: old events

- GIVEN a `project.created` and a `project.meta-updated` event recorded without the field
- WHEN they are decoded and replayed
- THEN the project's review prompt is "" and nothing is reported as invalid

#### Scenario: oversized project prompt

- GIVEN a metadata update with a 7,681 character review prompt
- WHEN it is dispatched
- THEN it is rejected and the stored prompt is unchanged

### R95. A chat review opens beside the work with the guard its provider supports [Must] (amendment A11)

WHEN "Review changes" is clicked and the reviewer is a chat agent, the review launcher SHALL open
one chat panel of the current thread in that thread's checkout or worktree, titled "Code review ·
" and the provider name, running with approval required, in plan mode only for Claude, with the
review model when one is set for that provider (else the provider's session default), and SHALL
send the resolved prompt as its first message.

#### Scenario: Codex reviewer in a worktree

- GIVEN the current thread is in worktree `wt-a` and the reviewer is chat `codex`
- WHEN "Review changes" is clicked
- THEN one panel opens whose thread has runtime mode `approval-required`, interaction mode `default`, worktree `wt-a`, and whose first message is the resolved prompt

#### Scenario: Claude reviewer

- GIVEN the reviewer is chat `claudeAgent`
- WHEN "Review changes" is clicked
- THEN the panel thread has interaction mode `plan` and runtime mode `approval-required`

#### Scenario: double click

- GIVEN a review panel is being created for this thread
- WHEN "Review changes" is clicked again
- THEN no second panel or message is created

#### Scenario: draft chat

- GIVEN the current chat has not been sent yet and the reviewer is a chat agent
- WHEN the panel is shown with changes
- THEN the button is disabled with the tooltip "Send a first message in this chat, then review from here."

#### Scenario: first message fails

- GIVEN panel creation succeeds and the first message is refused
- WHEN the review starts
- THEN the panel stays open with the prompt in its composer and a "Couldn't start the review" toast shows

### R96. A review thread offers no implementation action [Must] (amendment A11)

WHILE a thread was started as a review, the chat SHALL offer no Implement, Refine or "Implement in a
new thread" action for its proposed plans, and SHALL keep that after a reload or on another client.

#### Scenario: Claude ends with a plan

- GIVEN a review thread whose latest turn produced a proposed plan
- WHEN the turn settles and the composer is empty
- THEN no Implement action is shown, pressing Enter sends nothing, and the plan card is titled "Review findings"

#### Scenario: old thread

- GIVEN a thread created before the review flag existed
- WHEN it is decoded
- THEN it is not a review thread and its plan actions are unchanged

### R97. A terminal review starts the CLI with read-only flags and the prompt as data [Must] (amendment A11)

WHEN the reviewer is Claude Terminal or Codex Terminal, the review launcher SHALL open an AI
Terminal labelled with the provider name and "Review" whose arguments contain no bypass flag, start
with `--permission-mode plan` for Claude or `--sandbox read-only --ask-for-approval never` for
Codex, and end with `--` and the resolved prompt, and IF the resolved prompt is longer than 8,192
characters or holds a control character other than tab, carriage return or line feed, THEN the
review launcher SHALL start nothing and show the reason.

#### Scenario: Claude arguments

- GIVEN the reviewer is Claude Terminal with model `opus`
- WHEN the review command is built
- THEN the arguments are `--permission-mode plan --model opus -- <prompt>` and contain neither `--dangerously-skip-permissions` nor `--allow-dangerously-skip-permissions`

#### Scenario: Codex arguments

- GIVEN the reviewer is Codex Terminal
- WHEN the review command is built
- THEN the arguments start with `--sandbox read-only --ask-for-approval never`, end with `--` and the prompt, and do not contain `--dangerously-bypass-approvals-and-sandbox`

#### Scenario: oversized prompt

- GIVEN a resolved prompt of 8,193 characters
- WHEN the review command is built
- THEN no command is returned and the reason is "Review prompt is longer than 8,192 characters. Shorten it in Settings → Agents."

### R98. A Windows terminal review passes the prompt intact or does not start [Must] (amendment A11)

WHILE the reviewing environment runs Windows, the review launcher SHALL replace each line break in
the prompt with one space, and IF the prompt's length plus eight per `%` and one per `"` exceeds
7,000, or the prompt holds a character that a Windows batch launch is not proven to pass intact,
THEN it SHALL start no terminal review and name the reason.

#### Scenario: line breaks

- GIVEN a Windows environment and a prompt "a\nb\r\nc"
- WHEN the review command is built
- THEN the prompt argument is "a b c"

#### Scenario: metacharacters through an npm-style shim

- GIVEN a Windows `.cmd` shim that forwards `%*` to `node`, and one argument per character class: `say "hi"`, `100% %PATH%`, `a & b`, `a ^ b`, `a | b`, `c < d > e` and `!x!`
- WHEN each is launched through the terminal launch path
- THEN `node` receives each argument exactly and no redirect or second command runs, and for any class where that does not hold, the review launcher refuses a prompt holding that character on Windows with "Review prompt contains a character a Windows terminal cannot pass. Remove it or pick a chat reviewer."

#### Scenario: too long for cmd.exe

- GIVEN a Windows environment and a prompt of 6,000 characters holding 200 `%`
- WHEN the review command is built
- THEN no command is returned and the reason is "Review prompt is too long for a Windows terminal. Shorten it or pick a chat reviewer."

### R99. Settings → Agents shows the reviewer, its model, its prompt and its guard [Must] (amendment A11)

The Agents settings page SHALL offer a Code review group with a reviewer picker listing the chat
agents and the Claude and Codex terminals, a review model picker with "Provider default", and a
review prompt field of at most 7,680 characters with a counter and Reset, and SHALL show under the
picker the guard line of the selected reviewer.

#### Scenario: unedited prompt

- GIVEN the stored review prompt is ""
- WHEN the page opens
- THEN the field shows the built-in default text and no Reset is offered

#### Scenario: reset and default text

- GIVEN the stored prompt is "Mine"
- WHEN Reset is clicked, or the field is saved with text equal to the default
- THEN "" is stored

#### Scenario: instructed reviewer

- GIVEN the reviewer is chat `cursor`
- WHEN the page shows
- THEN the line "Told not to edit. BiBCode cannot block edits for this agent." is shown under the picker

### R100. The project review prompt is edited next to the button [Must] (amendment A11)

The Source Control panel SHALL offer, in a menu next to "Review changes", "Review prompt for this
project…", which opens a dialog showing the project's prompt (or the effective prompt when blank)
with a counter, Reset and Save, and IF saving fails, THEN the dialog SHALL stay open with the text
and show the reason next to the field.

#### Scenario: save and reset

- GIVEN the dialog with "Our rules"
- WHEN Save is clicked, then the dialog is reopened and Reset and Save are clicked
- THEN the project prompt is "Our rules" and then ""

#### Scenario: save fails

- GIVEN the server refuses the update
- WHEN Save is clicked
- THEN the dialog stays open with the typed text and the reason is shown under the field

### R101. Documentation and an end-to-end check cover the flow [Must] (amendment A11)

The user guide and the changelog SHALL describe the Review button, its settings and the guard per
reviewer without claiming a block for an instructed reviewer, and a packaged desktop test SHALL
start a review from Source Control and observe the panel, its first message and the absent
Implement action.

#### Scenario: packaged review

- GIVEN the packaged desktop fixture project with one modified file
- WHEN Source Control's "Review changes" is clicked
- THEN a "Code review · " tab opens, the fixture provider receives a first message that contains "Scope: the staged, unstaged and untracked changes in the working tree", and no Implement button is shown

### R102. A keyboard shortcut starts a review [Should] (amendment A11)

The keybinding service SHALL offer the command `sourceControl.review`, bound by default to
`mod+alt+shift+r` outside a focused terminal, which starts a review exactly as the button does.

#### Scenario: shortcut

- GIVEN the Source Control panel would enable "Review changes" and focus is not in a terminal
- WHEN `mod+alt+shift+r` is pressed
- THEN a review starts; with focus in a terminal nothing happens, and `mod+shift+r` still reloads in the browser

### R103. A one-off reviewer can be picked from the menu [Should] (amendment A11)

The Source Control panel's review menu SHALL list the same reviewers as Settings with their guard
lines, and picking one SHALL start a review with that reviewer without changing the saved reviewer.

#### Scenario: one-off reviewer

- GIVEN the saved reviewer is chat `codex`
- WHEN "Claude Terminal" is picked in the menu
- THEN a Claude review terminal opens and the saved reviewer is still chat `codex`

### R104. The enabled button names its scope [Should] (amendment A11)

WHILE "Review changes" is enabled, its tooltip SHALL name the scope and base and the reviewer's
guard line.

#### Scenario: branch scope tooltip

- GIVEN branch scope against `origin/main` and reviewer chat `claudeAgent`
- WHEN the button is hovered or focused
- THEN the tooltip reads "Review branch vs origin/main and uncommitted changes" and "Claude plan mode blocks edits."

### R105. One-off instructions can be added to a review [Should] (amendment A11)

The review menu SHALL offer "Review with instructions…", which takes up to 1,000 characters and
appends them after a blank line to the resolved prompt of that one review only.

#### Scenario: added instructions

- GIVEN "Focus on the parser." typed in the instructions field
- WHEN the review starts
- THEN the first message ends with "\n\nFocus on the parser." and the saved prompts are unchanged

## Decisions

D40. A review opens as a chat panel of the current thread through the side-chat creation path, not as a new top-level thread through `thread.turn.start` with `bootstrap.createThread`, because a public client cannot give a new thread a worktree that way and the review would read the main checkout. Alternatives considered: the issue's top-level thread (wrong checkout from a worktree); a new server RPC for a top-level thread in a worktree (new authority surface and RPC for what the panel path already does). Decided by: agent's call. Source: #293 "Start a thread with a prompt"; `decode_public_orchestration_command`.

D41. Review chats run with `approval-required` for every provider and in plan mode only for Claude. Alternatives considered: the user's default runtime mode (the issue's recommendation for open question 1; on this branch it is `full-access`, which leaves Codex, Cursor, Grok and OpenCode unguarded); `approval-required` with plan everywhere (plan adds no block to Codex and makes Codex, Cursor and Grok end with plan cards). UI copy claims a block only for the rows the design note marks ENFORCED. Decided by: agent's call. Source: #293 open question 1; driver mappings in the design note.

D42. A review thread carries a durable `codeReview` flag set at panel creation, and a review thread shows no Implement, Refine or "Implement in a new thread"; its plan card reads "Review findings". Alternatives considered: matching the title (breaks on rename); a client-only flag (lost on reload); keeping Implement (one-click auto-fixing is a non-goal). Decided by: agent's call. Source: #293 open question 2.

D43. A terminal prompt is passed as one argument after `--`, behind the fixed lead-in, and never through stdin; saved text is never trimmed or rewritten. Alternatives considered: `--` alone (Claude 2.1.322 still runs a subcommand named by the prompt); trimming leading dashes at save time (changes the person's text and misses subcommand words); stdin (interactive Codex refuses it). Decided by: agent's call. Source: #293 open question 3; CLI probes recorded in the design note.

D44. On Windows the web replaces line breaks by the environment's OS, bounds the escaped length at 7,000, and refuses on Windows any character whose native `%*` round trip does not pass in Windows CI; this phase does not change the server's escaping. Alternatives considered: the issue's rule keyed on the resolved `.cmd` (the web never sees it); a server-side rewrite for batch targets (changes every terminal launch). Decided by: agent's call. Source: #293 "Handle the argument limits".

D45. The base is `origin/<default>` with the local branch as the prompt's fallback, and a stale local default branch may enable the button. Alternatives considered: counting against the remote ref (a server change outside this issue). Decided by: agent's call (the issue's recommendation for open question 4). Source: #293 open question 4.

D46. The shortcut defaults to `mod+alt+shift+r`. Alternatives considered: `mod+shift+r` (hard reload in browsers and WebView2); no default binding (the issue asks for one). Decided by: agent's call. Source: #293 P1.1.

D47. A `codeReviews` server capability gates the button and the settings rows, with the reason "Update the BiBCode server on this environment to use Review." Alternatives considered: sending the new fields to any server (an older server refuses the panel field). Decided by: agent's call. Source: the `sideChats` precedent.

D48. Every disabled state of the button names its reason, including loading ("Checking for changes"), and a draft chat disables the chat reviewer with "Send a first message in this chat, then review from here." Alternatives considered: the issue's loading state without a tooltip (against `UI.md`); creating a top-level thread from a draft (see D40). Decided by: agent's call. Source: `UI.md` Buttons and Errors.

D49. Review settings belong to the environment that runs the review, and a review model whose provider instance differs from the reviewer's is ignored in favour of the provider's session default. Alternatives considered: one review model per provider (more settings than the issue asks for). Decided by: agent's call. Source: #293 "Settings".
