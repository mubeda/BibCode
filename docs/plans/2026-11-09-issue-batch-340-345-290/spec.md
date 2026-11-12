# Issue batch: pipeline headers, Git reliability, rich Markdown editing and custom themes

Status: Approved 2026-11-09 (approved in chat by the user, with amendments A1 and A2; amendments A3 to A9 approved in chat during execution; amendments A10 and A11 added on the user's instruction of 2026-11-11 and reviewed by Codex and the advisor, with their agent's calls listed for the user before the push; amendments A12, A13 and A14 added on the user's instruction of 2026-11-11)
Size: full Mode: gated Type: bug class (#341, #343, #344, #345) and feature (#340, #342, #290)
Source: GitHub issues #340, #341, #342, #343, #344, #345 and #290 of this repository, and the conversation of 2026-11-09; issues #292 and #293 by amendments A10 and A11, #346 by amendment A12, #347 by amendment A13 and #348 by amendment A14. One pull request covers all twelve.

This spec is longer than the usual 25 requirements because the maintainer chose one pull request for seven issues. Each issue has its own section and its requirements can be planned and reviewed on their own. Built-in theme values are in [theme-palettes.md](theme-palettes.md).

Names used throughout:

- **Stage header**: the heading above a column of jobs in the pipeline detail view. It covers host stages, dependency `Layer N` columns and the single `Jobs` column.
- **Managed worktree directory**: the folder under which BiBCode creates worktrees for one project.
- **Worktree evidence**: proof that a folder was once a BiBCode worktree (defined in R5).
- **Remote server**: any BiBCode server that the desktop app did not start inside itself, including one on the same machine that a browser connects to. Its **server name** is the name it already shows for its environment (the host name for a headless server). **Local desktop** is the server that runs inside the desktop app.
- **Stacked action**: the Source Control action that can commit, push and open a pull request in one step.
- **Push-family operation**: stacked-action push and pull-request steps, and Git Manager push, publish branch, force push and remote branch delete.
- **Rendered view** and **source view**: the two views of a Markdown file in Files.
- **Theme**: a named palette with a light or dark **base**. **Built-in themes** are the six that ship. **Custom themes** are the ones a person creates.
- **Slot**: the theme picked for light mode, or the one picked for dark mode.
- **Fixed pairs**: the text-and-surface pairs checked for contrast, the same for every theme: foreground on background; card-foreground on card; popover-foreground on popover; primary-foreground on primary; secondary-foreground on secondary; accent-foreground on accent; muted-foreground on background, on card and on accent; selected-foreground on selected; placeholder on background; find-match-foreground on find-match; find-match-active-foreground on find-match-active; terminal foreground on terminal background.
- **Supported tokens**: the color tokens the base stylesheet defines today (background, app-chrome-background, foreground, card, popover, primary, secondary, muted, accent and destructive with their `-foreground` partners, border, input, ring, panel-separator, sidebar-well, sidebar-card, sidebar-card-border, sidebar-env-band, link, info, success and warning with their `-foreground` partners, and the four find-match tokens), plus the tokens of D17.

## Problem

Seven open issues block or degrade daily work:

- **#340.** In the pipeline detail view a stage header and the job rows under it share text size, icon, padding and color, so stages read as more jobs.
- **#344.** The profiler warns every 600 seconds about a folder inside a managed worktree directory that was never a worktree. The count passed 280 in two days and nothing the person can do in BiBCode stops it.
- **#343.** A push that runs on a remote server fails with Git's "could not read Username ... terminal prompts disabled". The message does not say that Git ran on the server or how to recover.
- **#341.** While BiBCode is open, a person's own `git add` or `git commit` in a terminal fails with "index.lock: File exists". A lock was also left behind for two days, and locks remain after the app closes. Reported on Windows with linked worktrees.
- **#345.** While a stacked action waits on a push, refreshing status for the same worktree waits too. The profiler recorded waits of up to 138 seconds and nine hang findings in nine minutes.
- **#342.** A Markdown file in Files can be edited only in source view. In rendered view Undo and Redo are disabled and the only edit that works is ticking a task checkbox.
- **#290.** The app has three theme choices and a palette fixed in CSS. A person cannot change the accent, raise contrast or match the terminal palette they use elsewhere.

## Goals

1. A reader names every stage header in a multi-stage pipeline without mistaking it for a job, in wide and stacked layouts.
2. The profiler stops warning about folders that were never worktrees and keeps warning about real leftovers.
3. A person whose remote push fails for missing credentials learns from the failure itself which machine needs Git sign-in and what to run there.
4. A person's own Git commands in a terminal succeed while BiBCode is open, and BiBCode leaves no lock behind when it stops.
5. Local status for a worktree is delivered while a push for that worktree is still waiting on the network.
6. A person edits a Markdown file in rendered view with a formatting toolbar, and a save changes only what they edited.
7. A person creates, edits, imports, exports and selects color themes in Settings, and picks from six built-in themes.

## Non-goals

- Signing in to Git on a remote server from the client (#343 P1). It needs its own design for secret handling.
- Shortcuts, image paste, slash-menu extras, `.mdx` rich editing and a third preview mode for #342. They follow once the toolbar set works.
- Drawing annotations in the browser preview with theme colors (R58 covers reporting the colors only). The preview bridges ignore the annotation theme today, and wiring them is a separate change.
- Custom syntax colors, importing themes from other apps, server-side theme sync and a theme CLI (#290 P2).
- Changing the pull-request checks tab for #340. It is a different renderer.
- Changing pull and fetch gating for #345. Pull rewrites files at its end, so reads stay gated.
- A new warning in the UI for stale locks (#341). Cleaning up BiBCode's own lock covers the case.
- Deleting, moving or registering the folder reported in #344.

Anti-goals, which count as failure even if everything else works:

- A sign-in prompt, browser window or credential request on a remote server, in background work or in agent-driven Git.
- BiBCode removing a lock file that another program created.
- Two writes changing the same worktree at the same time.
- A save from rendered view that rewrites parts of the file the person did not edit.
- A changed default look for people who never open the new Appearance section.
- A theme file that can inject anything other than a color, a bounded length or a fixed keyword.

## Users and scenarios

1. As a person running BiBCode next to a terminal, I want my own `git add` to succeed, so that I can commit without closing the app. (#341)
2. As a person who just started a push, I want the change list to stay current, so that a slow network does not freeze Source Control. (#345)
3. As a desktop user connected to a remote server, I want a failed push to say where to sign in, so that I can fix the server's Git credentials and retry. (#343)
4. As an operator reading profiler findings, I want orphan warnings only for real leftovers, so that a recurring warning means something to clean up. (#344)
5. As a person reviewing a pipeline, I want stages to look like group labels, so that I can find a job by its stage at a glance. (#340)
6. As a person editing documentation, I want to format a Markdown file in rendered view, so that I do not have to switch to source for a heading or a list. (#342)
7. As a person who spends the day in the app, I want to choose or build a color theme, so that the app matches my terminal and my contrast needs. (#290)

## Requirements

### A. Pipeline stage headers (#340)

### R1. Stage headers look different from job rows [Must]

The pipeline detail view SHALL render every stage header with a background surface and a text style that no job row in that view uses.

#### Scenario: multi-stage pipeline

- GIVEN a pipeline with stages `versioning`, `security` and `test`, each with at least one job, grouped by stage
- WHEN the detail view is shown at a wide width and at a stacked width below 720px
- THEN each stage header has a header surface and text style that differ from every job row, at both widths

#### Scenario: other column kinds and neighbors stay as they are

- GIVEN a pipeline grouped by job dependencies, and a GitHub pipeline with the single `Jobs` column
- WHEN the detail view is shown
- THEN `Layer N` headers and the `Jobs` header use the same treatment as stage headers, and job rows, column widths, resize, wrap and the pull-request checks tab are NOT changed

### R2. Stage headers stay readable by assistive technology [Must]

The pipeline detail view SHALL expose each stage header as a heading that carries the stage status label, the stage name and the job count.

#### Scenario: heading content

- GIVEN a stage `test` with status "passed" and 3 jobs
- WHEN the accessibility tree is read
- THEN one heading contains the status label, the name `test` and the count 3

### B. Orphan worktree warnings (#344)

### R3. Each leftover keeps its own finding [Must]

WHEN the worktree audit reports a leftover folder, the profiler SHALL give each parent-and-name pair its own finding ID, SHALL keep absolute paths out of the ID, and SHALL include the folder name in the evidence, with the ID computed exactly as it is today.

#### Scenario: same name under two parents

- GIVEN leftovers named `feature-a` under two different managed worktree directories outside the home folder
- WHEN the audit runs
- THEN two findings with different IDs are raised, each evidence names `feature-a`, and neither ID changes when the audit runs again

### R4. BiBCode records the worktrees it creates [Must]

WHEN BiBCode creates a worktree in a managed worktree directory, the server SHALL store a durable creation record for that path that survives restart.

#### Scenario: record survives restart

- GIVEN a worktree created through BiBCode at `<managed>/feature-a`
- WHEN the server restarts
- THEN the creation record for `<managed>/feature-a` is still present

#### Scenario: failed creation

- GIVEN a worktree creation that fails before the folder exists
- WHEN the audit runs
- THEN no creation record and no finding exist for that path

#### Scenario: record ends with the worktree

- GIVEN a worktree with a creation record
- WHEN BiBCode removes it and its folder is gone, or an audit finds that the recorded folder no longer exists
- THEN the creation record is deleted, and a new unrelated folder created later at the same path has no worktree evidence

### R5. Leftovers with worktree evidence keep warning [Must]

WHILE a visible, unowned, unregistered direct child of a managed worktree directory has worktree evidence, the profiler SHALL raise `worktree.orphan-dir` for it on every audit, where worktree evidence is any of: a creation record (R4), a removal receipt for that path whose removal did not complete, a Git worktree pointer file at its root, or a BiBCode removal marker at its root.

#### Scenario: leftover without `.git`

- GIVEN a folder with a creation record whose `.git` pointer file is gone, unowned and unregistered
- WHEN the audit runs twice
- THEN the finding is raised both times and its count increases

#### Scenario: pointer file only

- GIVEN a folder with a Git worktree pointer file at its root and no creation record
- WHEN the audit runs
- THEN the finding is raised

### R6. Folders that were never worktrees do not warn [Must]

IF a visible, unowned, unregistered direct child of a managed worktree directory has no worktree evidence, THEN the profiler SHALL NOT raise `worktree.orphan-dir` for it.

#### Scenario: container folder

- GIVEN a folder `container` holding a project-like tree in a subfolder, with no `.git` and no worktree evidence
- WHEN the audit runs
- THEN no finding is raised for `container`, the audit does NOT look inside its subfolders, and the result does NOT depend on the folder's name

### R7. A warning stops when its cause is gone [Must]

WHEN a leftover folder is removed, becomes registered with Git, or becomes owned in the worktree catalog, the profiler SHALL stop raising `worktree.orphan-dir` for that path.

#### Scenario: one of two removed

- GIVEN two leftovers with worktree evidence
- WHEN one is removed and the audit runs
- THEN only the remaining path is raised, and hidden names stay excluded as before

### C. Remote push sign-in guidance (#343)

### R8. A remote missing-credentials failure says where to recover [Must]

IF a person-started HTTPS push on a remote server fails because Git cannot read a username with prompts disabled, THEN the server SHALL report a failure that names the remote server as the place Git ran, tells the person to run `git push` in a terminal there in the same repository as the user that runs BiBCode, and tells them to retry in BiBCode afterwards.

#### Scenario: known server name

- GIVEN a remote server whose name is `example-server` and an empty credential store
- WHEN a person pushes and Git prints `fatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled`
- THEN the failure text is "Push ran on the remote server example-server. In a terminal on example-server, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode."

#### Scenario: unknown server name

- GIVEN the same failure on a remote server with no known name
- WHEN the failure is shown
- THEN it says "the remote server" in both places, and it does NOT invent a host name, a user name or a path, and does NOT tell the person to sign in on their own computer

### R9. Both push surfaces show the guidance [Must]

WHEN the failure of R8 occurs, the app SHALL show the guidance in Git Manager and in Source Control, and SHALL keep Git's own error text available to the person.

#### Scenario: Source Control stacked action

- GIVEN the R8 failure during the push step of a stacked action
- WHEN the failure toast is shown
- THEN it shows the R8 guidance and Git's original line can still be read or copied

#### Scenario: Git Manager push

- GIVEN the R8 failure during a Git Manager push
- WHEN the operation ends
- THEN the panel shows the R8 guidance

### R10. Remote, background and agent Git never prompt [Must]

IF a push fails authentication on a remote server, in background work or in agent-driven Git, THEN the server SHALL NOT offer or start a sign-in, open a browser, ask for a credential or retry on its own.

#### Scenario: caller asks for sign-in anyway

- GIVEN a remote session whose request claims to be eligible for interactive sign-in
- WHEN the push fails with either Git refusal text
- THEN no sign-in is offered or started

### R11. Local desktop behavior is unchanged [Must]

WHEN a push fails authentication on the local desktop, the app SHALL behave as it does today: the existing sign-in offer for a credential-manager refusal, and the existing authentication message otherwise.

#### Scenario: credential manager refusal

- GIVEN an eligible local desktop session and a helper that prints the credential manager's refusal
- WHEN a person pushes
- THEN the existing destination-specific sign-in offer appears

#### Scenario: missing username on local desktop

- GIVEN the local desktop and an empty credential store
- WHEN the push fails with the missing-username text
- THEN the failure does NOT mention a remote server and no sign-in offer appears for that helper

### R12. Other failures and working credentials are unaffected [Must]

WHEN a push ends for any reason other than the missing-username refusal, the server SHALL report that outcome without the R8 guidance.

#### Scenario: stored credential

- GIVEN a remote server with a matching stored credential
- WHEN a person pushes to a local test Git host that requires authentication
- THEN the push succeeds with no prompt and no guidance

#### Scenario: unrelated failure

- GIVEN a refused connection, and separately a non-fast-forward rejection
- WHEN the push fails
- THEN the specific failure is shown and the R8 guidance is NOT shown

### R13. Help text matches the failure [Should]

The user documentation SHALL describe remote-server recovery with the same wording as R8 and SHALL keep local desktop sign-in as a separate case.

#### Scenario: documentation check

- GIVEN the Git authentication help
- WHEN it is compared with the R8 text
- THEN the remote case names the server and the `git push` command, and neither case promises a sign-in window for a plain credential store

### D. Background Git and the person's own Git (#341)

### R14. Background reads never lock the index [Must]

WHILE BiBCode refreshes status or diff statistics in the background, the server SHALL NOT create `index.lock` in that worktree's Git directory.

#### Scenario: a person's `git add` during polling

- GIVEN a worktree with one tracked file whose timestamp changed but whose content did not, and one file with a real unstaged edit
- WHEN BiBCode refreshes status 50 times in a row and a separate `git add` of the edited file runs at the same time, 50 times
- THEN every `git add` exits 0

#### Scenario: polling alone leaves the index untouched

- GIVEN the same worktree and no other Git process
- WHEN BiBCode refreshes status 50 times in a row
- THEN the index file's bytes and modification time are unchanged, and a watcher on the Git directory sees no `index.lock` appear

#### Scenario: statistics stay correct

- GIVEN the same worktree
- WHEN status is refreshed
- THEN the unstaged insertions and deletions reported for the edited file are the same as before this change, and the timestamp-only file is NOT reported as changed

### R15. Git is asked to stop before it is killed [Must]

WHEN the server stops a Git process because of a timeout, a cancellation or shutdown, the server SHALL first ask the process to stop, on every platform that offers a way to ask, and SHALL force it to stop only if it is still running 2 seconds later.

#### Scenario: Git stops cleanly

- GIVEN a BiBCode Git process that holds `index.lock` and stops when asked
- WHEN the server cancels it
- THEN the process exits within 2 seconds and `index.lock` is gone

#### Scenario: Git ignores the request

- GIVEN a Git process that ignores the stop request
- WHEN 2 seconds pass
- THEN the server forces it to stop, and the caller still receives the timeout or cancellation outcome it receives today

#### Scenario: Windows

- GIVEN Windows, where a clean stop request may not reach a Git process without a console
- WHEN the design note for this fix finds no dependable request
- THEN the process is forced to stop as today and R16 and R17 remove its lock; the clean-stop scenario is then proven on Linux and macOS only

### R16. BiBCode removes only a lock its own killed process left [Must]

IF a Git process that BiBCode forced to stop leaves an `index.lock` that did not exist when the process started and that does not change for 2 seconds after the stop, THEN the server SHALL remove that lock and log the removal as a warning.

#### Scenario: own lock

- GIVEN a BiBCode Git write that created `index.lock` and was forced to stop
- WHEN 2 seconds pass with the lock unchanged
- THEN the lock is removed, a warning is logged, and a following `git add` in a terminal exits 0

#### Scenario: someone else's lock

- GIVEN an `index.lock` that existed before the BiBCode process started, and separately a lock that changes within the 2 seconds
- WHEN the BiBCode process is forced to stop
- THEN the lock is NOT removed

### R17. Shutdown leaves no lock behind [Must]

WHEN BiBCode shuts down, the server SHALL leave no `index.lock` created by its own Git processes in any worktree.

#### Scenario: shutdown during a write

- GIVEN a BiBCode Git write in progress
- WHEN the server shuts down
- THEN after shutdown completes no `index.lock` from that process remains

### E. Status during a push (#345)

### R18. Status is delivered while a stacked push waits [Must]

WHILE a stacked action for a worktree has finished its local writes and is waiting on a push or on the pull-request step, the server SHALL deliver current local status for that worktree to a status refresh and to status subscribers.

#### Scenario: held push

- GIVEN a stacked commit-and-push whose push is held open for longer than 10 seconds, with pull-request lookups stubbed to succeed
- WHEN status is refreshed for the same worktree and a subscriber is listening
- THEN both receive status that shows the new commit before the push is released

#### Scenario: another worktree

- GIVEN a held push in worktree A
- WHEN status is refreshed for worktree B
- THEN B is answered without waiting for A

#### Scenario: a slow pull-request lookup (amendment A7)

- GIVEN a worktree whose pull-request lookup (`gh` or `glab`) does not answer for longer than 10 seconds
- WHEN status is refreshed
- THEN the refresh answers with current local status within a few seconds, and subscribers receive the lookup's result on the status stream once it finishes

#### Scenario: the pull request a subscriber sees (amendment A7)

- GIVEN a subscriber that shows a pull request for the current ref
- WHEN a lookup for the same ref is still running, fails or is cancelled, or a status event with an equal or newer local status arrives, THEN the subscriber keeps showing that pull request
- WHEN the lookup ends with an open request, THEN the subscriber shows it; WHEN it ends with no open request, THEN the subscriber clears it; WHEN the ref changes, THEN the subscriber clears it at once
- AND a lookup result that arrives across a status epoch change is still delivered once

### R19. Status is delivered during Git Manager push-family operations [Must]

WHILE a Git Manager push, publish branch, force push or remote branch delete waits on the network, the server SHALL deliver current local status for that worktree.

#### Scenario: held Git Manager push

- GIVEN a Git Manager push held open for longer than 10 seconds
- WHEN status is refreshed for the same worktree
- THEN status is delivered before the push is released

#### Scenario: pull and fetch keep waiting

- GIVEN a pull in progress
- WHEN status is refreshed for the same worktree
- THEN the refresh waits for the pull as it does today

### R20. Writes stay serialized and commits stay saved [Must]

WHILE a push-family operation is in progress for a worktree, the server SHALL make every other write to that worktree wait until it ends, and SHALL keep a commit made earlier in the same stacked action if the push stalls or fails.

#### Scenario: second write during a held push

- GIVEN a held push after a commit in the same stacked action
- WHEN a second write to the same worktree is requested
- THEN the second write starts only after the first action ends, and the commit is present in history whether the push succeeds or fails

#### Scenario: status read before the action ended

- GIVEN status delivered during the push
- WHEN the action ends
- THEN a fresh status is published afterwards, and a status read that started before the action began is NOT published

### R21. Readers are released after every outcome [Must]

IF a push-family operation ends by success, authentication refusal, timeout, cancellation or loss of the workspace, THEN the server SHALL release the worktree and publish fresh status.

#### Scenario: each outcome

- GIVEN each of the five outcomes in turn
- WHEN the operation ends
- THEN a following status refresh is answered, a timeout is reported as a timeout and NOT as a Git exit code, and no refresh fails with "status read owner stopped"

### R22. Pull-request lookups stay independent of a push [Must]

WHEN the pull-request vocabulary or create-defaults lookups run during a held push, the server SHALL answer them without waiting for the push.

#### Scenario: lookup during a held push

- GIVEN a held push and a provider that answers at once
- WHEN both lookups run
- THEN both complete while the push is still held

### R23. A real status hang is still recorded [Must]

WHEN a status refresh waits more than 10 seconds on the server, the profiler SHALL record the hang finding for it.

#### Scenario: refresh blocked by something else

- GIVEN a status refresh blocked for more than 10 seconds by something other than a push-family operation
- WHEN the hang detector runs
- THEN a hang finding for the status refresh is recorded, and the status refresh is NOT reclassified as long-running

### F. Rich Markdown editing in Files (#342)

### R24. The toolbar keeps its controls and gains a formatting group [Must]

The Files toolbar SHALL show Save, Undo and Redo, then the formatting group, then the source/rendered toggle, and SHALL make the formatting group usable only in rendered view of an editable Markdown file.

#### Scenario: order and availability

- GIVEN a `.md` file open in rendered view
- WHEN the toolbar is read left to right
- THEN the order is Save, Undo, Redo, formatting group, view toggle, and every control has an accessible name

#### Scenario: source view

- GIVEN the same file in source view, and separately a non-Markdown file
- WHEN the toolbar is shown
- THEN no formatting control can be activated

### R25. Rendered Markdown is editable [Must]

WHILE a `.md` file is shown in rendered view, the Files editor SHALL let the person type, delete and select text in headings, paragraphs, lists, block quotes and table cells.

#### Scenario: edit a paragraph

- GIVEN a file with the paragraph "Hello world"
- WHEN the person types " again" at its end in rendered view
- THEN the file's text contains "Hello world again" and the file shows as having unsaved changes

#### Scenario: task checkbox still works

- GIVEN a task list item
- WHEN the person clicks its checkbox
- THEN only that item's marker changes, and Undo reverses it

### R26. The formatting group applies Orca's toolbar set [Must]

WHEN a person activates a formatting control, the Files editor SHALL apply that format to the selection or current block, for: paragraph, heading 1 to 3, bold, italic, strikethrough, bullet list, numbered list, task list, block quote, link, image, and a More menu with heading 4, heading 5 and collapsible section.

#### Scenario: heading and mark

- GIVEN the paragraph "Title" with the word selected
- WHEN the person activates Heading 2 and then Bold
- THEN the saved Markdown for that block is `## **Title**`

#### Scenario: active state

- GIVEN the caret inside a bullet list item
- WHEN the toolbar is shown
- THEN the bullet list control shows as active, and activating it again turns the item back into a paragraph

### R27. Links are added, changed and removed from a dialog [Must]

WHEN a person activates the link control, the Files editor SHALL open a dialog anchored to the selection in which they can enter a URL, change it or remove the link.

#### Scenario: link selected text

- GIVEN the selected text "docs"
- WHEN the person enters `https://example.test/docs` and confirms
- THEN the saved Markdown is `[docs](https://example.test/docs)`

#### Scenario: empty URL

- GIVEN the caret inside an existing link
- WHEN the person clears the URL and confirms
- THEN the link is removed, the text stays, and nothing else in the file changes

### R28. Insert image copies the file next to the Markdown file [Must]

WHEN a person picks an image with the image control, the Files editor SHALL copy it into the Markdown file's folder and insert a relative image link at the caret.

#### Scenario: new image

- GIVEN `docs/guide.md` open and a picked file `diagram.png`
- WHEN the copy completes
- THEN `docs/diagram.png` exists and `![](diagram.png)` is inserted at the caret

#### Scenario: name taken or copy fails

- GIVEN `docs/diagram.png` already exists, and separately a copy that fails
- WHEN the person picks `diagram.png`
- THEN in the first case the copy is saved as `diagram-1.png` and the existing file is NOT overwritten, and in the second case an error is shown and no link is inserted

### R29. Saving uses the existing save path [Must]

WHEN a file is edited in rendered view, the Files editor SHALL save it through the same explicit save, autosave, conflict detection and reload-or-overwrite choice as source view.

#### Scenario: explicit save

- GIVEN an unsaved rendered edit
- WHEN the person presses Save or the save shortcut
- THEN the file on disk contains the edit and the unsaved indicator clears

#### Scenario: file changed on disk

- GIVEN an unsaved rendered edit and a newer version of the file on disk
- WHEN a save is attempted
- THEN the save is blocked and the existing reload-or-overwrite choice is shown, and the disk file is NOT overwritten without that choice

### R30. Undo and Redo work in rendered view and survive a view switch [Must]

WHILE a Markdown file is in rendered view, the Files editor SHALL enable Undo and Redo for edits made there, and WHEN the person switches view it SHALL carry pending edits over and keep the source view's earlier history.

#### Scenario: undo a rich edit

- GIVEN a heading applied in rendered view
- WHEN the person presses Undo and then Redo
- THEN the heading is removed and then applied again

#### Scenario: switch to source after a rich edit

- GIVEN two source edits, then a switch to rendered view and one rendered edit
- WHEN the person switches back to source view and presses Undo three times
- THEN the first Undo reverses the rendered edit as one step and the next two reverse the earlier source edits, and no history is discarded by the rendered edit

#### Scenario: several rendered edits in one visit

- GIVEN three rendered edits made without leaving rendered view
- WHEN the person switches to source view and presses Undo once
- THEN all three are reversed together, because one visit to rendered view arrives in source view as one step

#### Scenario: switch to rendered after a source edit

- GIVEN an unsaved source edit
- WHEN the person switches to rendered view
- THEN the rendered view shows the edit, and Undo there is available only for edits made in rendered view since the switch

### R31. Opening and saving without editing changes nothing [Must]

WHEN a Markdown file is opened in rendered view and not edited, the Files editor SHALL NOT mark it as changed, and a save SHALL write the original bytes.

#### Scenario: untouched file

- GIVEN a file with frontmatter, a table, a fenced code block, mixed list markers and no final newline
- WHEN it is opened in rendered view, switched to source and back, and saved
- THEN the bytes on disk are identical to the original and no unsaved indicator appeared

### R32. Frontmatter is preserved and not editable in rendered view [Must]

WHILE a Markdown file with YAML or TOML frontmatter is in rendered view, the Files editor SHALL keep the frontmatter bytes unchanged on save and SHALL show it as a read-only block that says to edit it in source view.

#### Scenario: edit below frontmatter

- GIVEN a file starting with a `---` frontmatter block
- WHEN the person edits a paragraph below it and saves
- THEN the frontmatter bytes are identical to the original

### R33. A local edit leaves the rest of the file as written [Must]

WHEN a person edits one block in rendered view, the Files editor SHALL save every block they did not edit with its original bytes.

#### Scenario: fence next to an edited paragraph

- GIVEN a fenced code block with unusual spacing followed by a paragraph
- WHEN the person edits only the paragraph and saves
- THEN the fenced block's bytes, including its fence spelling, are identical to the original

#### Scenario: edit cannot be placed

- GIVEN an edit that cannot be matched back to a single place in the original text
- WHEN the file is saved
- THEN frontmatter and fenced code contents are still identical to the original, and the result parses to the same rendered document the person saw

### R34. Files the rich editor cannot represent stay read-only in rendered view [Must]

IF a Markdown file contains reference-style links or their definitions, footnotes, raw HTML other than a `details` block, HTML comments or math, or is an `.mdx` file, or is larger than 128 KiB (amendment A4), THEN the Files editor SHALL show rendered view read-only as today, with a notice that says to edit in source view, and SHALL NOT rewrite the file.

#### Scenario: unsupported construct

- GIVEN a file with reference-style link definitions and a footnote
- WHEN it is opened in rendered view
- THEN it renders read-only with the notice, the formatting group cannot be activated, task checkboxes still work and a tick keeps the file's source Undo history (amendment A6), and source view edits the file normally

#### Scenario: representable variants stay editable

- GIVEN a file with underlined (setext) headings, an aligned table and a hand-written `details` block
- WHEN it is opened in rendered view
- THEN it is editable, and R31 and R33 hold for it

#### Scenario: `.mdx`

- GIVEN an `.mdx` file
- WHEN it is opened
- THEN it behaves as it does today, except that a task checkbox tick keeps the file's source Undo history (amendment A6)

#### Scenario: a large file (amendment A4)

- GIVEN a supported Markdown file of 129 KiB
- WHEN it is opened in rendered view
- THEN it renders read-only with the notice, and no rich editor is created

### R35. A collapsible section is saved as HTML details [Must]

WHEN a person inserts a collapsible section, the Files editor SHALL save it as a `details` element with a `summary`.

#### Scenario: insert and reopen

- GIVEN a collapsible section inserted with summary "More" and body "Text"
- WHEN the file is saved and reopened in rendered view
- THEN the source contains a `details` element with `summary` "More", and the rendered view shows it as an editable collapsible section

### G. Custom color themes (#290)

### R36. A theme is a base plus optional overrides [Must]

The theme format SHALL describe a theme as a version, an ID, a name of 1 to 48 characters, a light or dark base, optional UI token values and optional terminal colors, and the app SHALL leave every supported token a theme does not set as its base defines it, including base tokens that are derived from other tokens.

#### Scenario: one-color theme

- GIVEN a theme with a dark base that sets only the primary color to `#3b82f6`
- WHEN it is selected
- THEN the primary color is `#3b82f6`, tokens the base derives from primary (primary hover and primary pressed) follow the new primary, and every other token equals the built-in Dark theme

#### Scenario: unknown token

- GIVEN a theme file that sets a token outside the supported tokens, or has an unknown top-level field
- WHEN it is validated
- THEN it is rejected with an error that names the token

### R37. Six built-in themes ship and cannot be changed [Must]

The app SHALL ship Light, Dark, Tokyo Night, Matrix Dark, Matrix Light and Verdant Light as read-only themes with the values in theme-palettes.md, and SHALL refuse to edit, delete or replace them.

#### Scenario: Tokyo Night values

- GIVEN Tokyo Night selected for the dark slot in dark mode
- WHEN the app is painted
- THEN the background is `#1a1b26`, the primary color is `#7aa2f7`, the border is `#414868`, and the desktop window uses the dark window theme

#### Scenario: Verdant Light values

- GIVEN Verdant Light selected in light mode
- WHEN the app is painted
- THEN the background is `#ffffff`, the text color is `#303840`, the primary color is `#087f5b`, the control border is `#87939b`, the placeholder color is `#667078`, the selected surface is `#eaf5ef` with selected text `#065f46`, and the panel separator is `#dee3e6`

#### Scenario: built-in protection

- GIVEN any built-in theme
- WHEN a delete is requested for its ID, or a file with its ID is imported
- THEN the request is refused as reserved, and the theme list offers only Duplicate for it

### R38. Upgrading changes nothing until a person picks a theme [Must]

WHEN the app starts with no stored slots, the app SHALL use Light for the light slot and Dark for the dark slot and SHALL keep the stored System, Light or Dark mode as it is.

#### Scenario: existing user

- GIVEN a stored mode of Dark and no stored slots or custom themes
- WHEN the app starts after the upgrade
- THEN every color equals the value before the upgrade, including the new tokens of R50

### R39. The mode chooses between a light slot and a dark slot [Must]

The app SHALL keep one theme for the light slot and one for the dark slot, each with a matching base, and SHALL paint the slot that matches the current mode, following the operating system in System mode.

#### Scenario: System mode with a custom dark theme

- GIVEN System mode, a custom theme in the dark slot and Light in the light slot
- WHEN the operating system switches from dark to light
- THEN the light slot's colors are applied and every override of the dark theme is cleared

#### Scenario: wrong base

- GIVEN a theme with a light base
- WHEN it is offered for the dark slot
- THEN it cannot be chosen there

### R40. Clicking a theme applies it at once, switching the mode when needed [Must] (amendment A8)

WHEN a person clicks anywhere on a theme's row (or presses Enter or Space on it), the app SHALL put the theme in its base's slot and SHALL show it at once: if the mode shown on screen differs from the theme's base (including System resolving to the other base), the app SHALL set the mode to the theme's base and SHALL offer an Undo that restores the previous mode and slot. The list SHALL group themes into Light themes and Dark themes, SHALL mark the theme in use in each group visibly and with a selected state for assistive technology, and SHALL keep the secondary actions (Duplicate, Edit, Export, Delete) out of the row's click target.

#### Scenario: dark theme in Light mode

- GIVEN Light mode
- WHEN the person clicks the Tokyo Night row
- THEN the dark slot holds Tokyo Night, the mode is Dark, the app shows Tokyo Night, and an Undo returns the mode to Light and the dark slot to its previous theme

#### Scenario: dark theme while System shows light

- GIVEN System mode while the system is light
- WHEN the person clicks the Matrix Dark row
- THEN the mode is Dark, the app shows Matrix Dark, and Undo returns the mode to System

#### Scenario: same-base theme

- GIVEN Dark mode showing Dark
- WHEN the person clicks the Tokyo Night row
- THEN the app shows Tokyo Night, the mode stays Dark, and no Undo is offered

#### Scenario: secondary action

- GIVEN any theme row
- WHEN the person uses Duplicate (or Edit, Export, Delete) on it
- THEN that action runs and the row's theme is not applied

### R41. A theme applies to the whole app and clears cleanly [Must]

WHEN the resolved theme changes, the app SHALL apply the new theme's overrides, clear every override of the previous theme, set the desktop window theme and the code highlighter from the new base, and update the browser chrome color to the new background.

#### Scenario: switch back to a built-in

- GIVEN Matrix Dark active
- WHEN the person selects Dark
- THEN no Matrix Dark override remains and every color equals built-in Dark

#### Scenario: light custom theme

- GIVEN a custom theme on a light base
- WHEN it becomes active
- THEN the light code highlighter and the light window theme are used

### R42. The theme is painted before the app appears [Must]

WHEN the app loads, the app SHALL apply the stored theme's mode, overrides and background before the first frame is shown.

#### Scenario: reload with a custom theme

- GIVEN a stored custom dark theme with background `#101820`
- WHEN the page loads
- THEN the mode, the overrides and the background `#101820` are already set on the page when the app's own code starts, before the app renders anything

#### Scenario: stored theme is corrupt

- GIVEN stored theme data that cannot be read
- WHEN the page loads
- THEN the built-in theme for the stored mode is painted and the app starts normally

### R43. Settings has an Appearance section [Must]

The Settings screen SHALL have an Appearance section that holds the mode and the theme list, and the General section SHALL no longer hold the theme row.

#### Scenario: navigation

- GIVEN Settings open
- WHEN the section list is read
- THEN Appearance is listed, it shows System, Light and Dark, and General has no theme control

### R44. The theme list shows every theme with the actions it allows [Must]

The Appearance section SHALL list the six built-in themes and then the custom themes, each with a color preview, its base, and a control to use it for its slot, and SHALL offer Duplicate on every theme and Edit, Export and Delete only on custom themes.

#### Scenario: duplicate a built-in

- GIVEN Tokyo Night
- WHEN the person chooses Duplicate
- THEN a custom theme named "Tokyo Night copy" with the same values and a new ID appears and can be edited

#### Scenario: empty custom list

- GIVEN no custom themes
- WHEN the list is shown
- THEN the six built-ins are listed and a "New theme" action is available

### R45. Deleting a theme asks first and falls back safely [Must]

WHEN a person deletes a custom theme, the Appearance section SHALL ask for confirmation, and IF the theme was in a slot THEN the app SHALL put the built-in theme of the same base in that slot.

#### Scenario: delete the active theme

- GIVEN a custom dark theme active in the dark slot
- WHEN the person confirms Delete
- THEN the theme is gone, the dark slot holds Dark, and the app repaints with Dark

#### Scenario: cancel

- GIVEN the confirmation
- WHEN the person cancels
- THEN nothing changes

### R46. A new theme starts from a base and a name [Must]

WHEN a person chooses "New theme", the Appearance section SHALL ask for a base and a name and SHALL open the editor on a new custom theme with no overrides.

#### Scenario: name rules

- GIVEN the New theme form
- WHEN the name is empty or longer than 48 characters
- THEN the theme is NOT created and the form says which rule failed

### R47. The editor previews live and saves only on Save [Must]

WHILE a person edits a custom theme, the theme editor SHALL repaint the app on every change, SHALL show every supported token, grouped as Surfaces, Text, Accent and focus, Status, Sidebar and Terminal with a color picker and a text field each, and SHALL offer Save, Cancel, Reset for one token and Reset for all tokens.

#### Scenario: edit and cancel

- GIVEN a saved custom theme with primary `#3b82f6`
- WHEN the person changes primary to `#ff0000` and then chooses Cancel
- THEN the app showed `#ff0000` during the edit and shows `#3b82f6` afterwards, and the stored theme is unchanged

#### Scenario: reset one token

- GIVEN an overridden background
- WHEN the person resets that token
- THEN the background returns to the base value and other overrides stay

#### Scenario: invalid text

- GIVEN the text field of a color token
- WHEN the person types `url(x)`
- THEN the field shows an error, the app is NOT repainted with that value, and Save is disabled until it is fixed

### R48. Theme data is validated at every entry point [Must]

IF a theme value is not a CSS color, or a length outside its range for a length token, or a keyword outside its list for a keyword token, or a theme file is larger than 16 KiB, or an ID is reserved or is not lowercase letters, digits and hyphens, THEN the app SHALL reject it with an error that names the field.

#### Scenario: injection attempts

- GIVEN color values `url(https://example.test/x)`, `var(--x)` and `red; background: blue`
- WHEN each is validated
- THEN each is rejected and nothing from it reaches the page

#### Scenario: limits

- GIVEN a radius of `2rem`, a 17 KiB file, the ID `dark`, and a 65th custom theme
- WHEN each is submitted
- THEN the radius is rejected because the range is 0 to 1rem, the file because of size, the ID as reserved, and the 65th theme because the library holds at most 64

### R49. One bad stored theme does not lose the others [Must]

IF a stored custom theme cannot be read, THEN the app SHALL skip it, log it, and keep every other stored theme and both slots.

#### Scenario: one corrupt entry

- GIVEN three stored themes of which the second is corrupt
- WHEN the app starts
- THEN the first and third are listed, the corrupt one is not, and a slot that pointed at it falls back to the built-in of its base

### R50. New color roles default to today's look [Must]

The app SHALL provide color tokens for strong text, placeholder text, primary hover, primary pressed, selected surface and selected text, and in Light and Dark each SHALL resolve to the color the app shows today for that role.

#### Scenario: defaults

- GIVEN Light, and separately Dark
- WHEN an input placeholder, a hovered primary button, a pressed primary button and a selected row are painted
- THEN each color equals the color before this change

#### Scenario: a theme sets them

- GIVEN Verdant Light
- WHEN the same elements are painted
- THEN the placeholder is `#667078`, primary hover is `#066649`, primary pressed is `#05543d`, and a selected row is `#eaf5ef` with text `#065f46`

### R51. The terminal follows the theme only when asked to [Must]

WHILE the terminal theme preference is "Follow app theme", the terminal SHALL use the active theme's terminal colors for new sessions and SHALL take unset colors from the base's built-in terminal palette; WHILE the preference is Dark or Light, it SHALL use the built-in palette.

#### Scenario: Tokyo Night terminal

- GIVEN "Follow app theme" and Tokyo Night active
- WHEN a new terminal session starts
- THEN its ANSI green is `#9ece6a` and its background is reported to the shell as `26,27,38`

#### Scenario: fixed preference and running sessions

- GIVEN the preference Dark, and separately a session started before a theme change
- WHEN the theme changes
- THEN the built-in dark palette is used in the first case, and in the second the running session keeps the colors it started with and the Appearance section says so

#### Scenario: job log

- GIVEN "Follow app theme" and Matrix Dark active
- WHEN a pipeline job log is shown
- THEN its ANSI colors come from the Matrix Dark terminal palette

### R52. Custom themes can set terminal colors [Must]

The theme editor SHALL let a person set the terminal background, foreground, cursor, selection colors and the 16 ANSI colors of a custom theme.

#### Scenario: custom ANSI red

- GIVEN a custom theme whose ANSI red is `#ff5555` and the preference "Follow app theme"
- WHEN a new terminal session starts
- THEN its ANSI red is `#ff5555`

### R53. Themes are exported to and imported from JSON [Must]

WHEN a person exports a custom theme, the Appearance section SHALL save it as a JSON file, and WHEN a person imports a file or pasted JSON it SHALL show every validation error by field before anything is stored.

#### Scenario: round trip

- GIVEN an exported custom theme whose fixed pairs all meet 4.5:1
- WHEN the file is imported on a device without it
- THEN the imported theme equals the exported one

#### Scenario: ID already exists

- GIVEN an import whose ID matches an existing custom theme
- WHEN it is validated
- THEN the person chooses between replacing the existing theme and keeping both, and nothing is stored before they choose

#### Scenario: invalid file

- GIVEN pasted JSON with two invalid colors
- WHEN it is validated
- THEN both fields are listed with their errors and no theme is stored

#### Scenario: export in the desktop app (amendment A5)

- GIVEN a custom theme in the desktop app
- WHEN the person clicks Export
- THEN the native Save dialog opens with `<id>.theme.json`, the chosen file holds the exported JSON, Cancel writes nothing and shows no error, and a failed write shows an error

### R54. The editor warns about low contrast and never blocks saving [Must]

WHILE a person edits a theme, the theme editor SHALL show the contrast ratio of each fixed pair and SHALL mark every pair below 4.5:1 with a warning that names both colors, without preventing Save.

#### Scenario: unreadable pair

- GIVEN text color equal to the background color
- WHEN the editor is shown
- THEN that pair shows a ratio of 1:1 with a warning, and Save still works

### R55. An imported theme cannot paint unreadable text [Must]

IF an imported theme has a fixed pair below 4.5:1, and either the same pair at the theme's base values meets 4.5:1 or the import overrides that pair's text token (amendment A3, revised), THEN the app SHALL remove that pair's text-color override from the theme before storing it, SHALL also remove its surface override if the pair still fails and the same pair at the base values meets 4.5:1, and SHALL tell the person which pairs were reset to base values.

#### Scenario: low-contrast import

- GIVEN an import whose muted text on background is 2.1:1
- WHEN it is imported
- THEN the stored theme has no muted text override, a notice names the pair, the other overrides are kept, and exporting the stored theme and importing it again changes nothing further

#### Scenario: a pair the base already fails (amendment A3)

- GIVEN a light-based import that sets only a background override of `#fffdf8`, with the default placeholder, whose placeholder on background is below 4.5:1 like the same pair in built-in Light
- WHEN it is imported
- THEN the background override is kept and no notice is shown

#### Scenario: a failing text override on a pair the base already fails (amendment A3)

- GIVEN a light-based import that sets `background: #fffdf8` and `placeholder: #cccccc`
- WHEN it is imported
- THEN the placeholder override is removed and named in the notice, and the background override is kept

### R56. Every built-in theme meets contrast minimums [Must]

Tokyo Night, Matrix Dark, Matrix Light and Verdant Light SHALL keep every fixed pair at or above 4.5:1; Matrix Light and Verdant Light SHALL keep their control border (the input token) at or above 3:1 on the background and every ANSI color at or above 4.5:1 on the terminal background.

#### Scenario: computed check

- GIVEN each built-in theme's values
- WHEN the ratios are computed
- THEN every pair meets its minimum, including Tokyo Night muted text on background (5.75), Matrix Dark muted text on accent (4.81), Verdant Light placeholder on white (5.06) and the Verdant Light control border (3.15), and Light and Dark are NOT changed to meet these minimums

### R57. Colors outside the token set follow the theme [Must]

The app SHALL take the scrollbar colors, the model picker scrollbar colors and the sidebar card's muted text color from theme tokens, so that a theme's overrides reach them.

#### Scenario: scrollbar under a custom theme

- GIVEN a custom dark theme that sets the muted and border colors
- WHEN a scrollbar and a sidebar card are painted
- THEN their colors derive from the theme's values, and under built-in Dark they equal today's colors

### R58. Diagrams and browser annotations follow a theme change [Must]

WHEN the resolved theme changes, the app SHALL repaint Mermaid diagrams with the new theme's colors and SHALL report the new theme's colors to the browser preview annotation layer, without a reload.

#### Scenario: theme colors change

- GIVEN a rendered Mermaid diagram and a listener on the annotation colors
- WHEN the info, background, foreground and primary colors change from one dark theme to another dark theme
- THEN the diagram uses the new info, background and foreground colors, which are the colors diagrams are drawn with, and the listener receives annotation colors that contain the new primary color

### R59. Focus rings and control shadows can be themed [Should]

WHERE a theme sets a focus ring width of 1 to 3px, a focus ring offset of 0 to 3px or a control shadow of "none" or "default", the app SHALL use those values for focus outlines and for button and composer shadows.

#### Scenario: Verdant Light

- GIVEN Verdant Light active
- WHEN a button is focused
- THEN the focus outline is 2px wide with a 2px offset, and buttons and the composer have no shadow

#### Scenario: defaults

- GIVEN Light or Dark
- WHEN a button is focused
- THEN the outline and shadows equal today's

### R60. Restore defaults resets the choice, not the library [Must]

WHEN a person restores default settings, the app SHALL set the mode to System and both slots to their built-in themes and SHALL keep every custom theme.

#### Scenario: restore

- GIVEN two custom themes, one of them active
- WHEN defaults are restored
- THEN the mode is System, the slots hold Light and Dark, and both custom themes are still listed

### R61. Theme changes reach other open windows [Must]

WHEN the theme library or a slot changes in one window, the app SHALL apply the change in every other open window and tab on the same device.

#### Scenario: second window

- GIVEN two windows open
- WHEN a custom theme is edited and saved in the first
- THEN the second repaints with the saved values without a reload

### R62. Closing the window with unsaved Files edits asks first [Must]

WHEN the person closes the desktop window or quits the app while any Files edit is unsaved, in source or rendered view, the app SHALL keep the window open and show a dialog that lists the unsaved files with Save all, Discard and Cancel (amendment A5). Save all SHALL save every listed file through the existing save path and close only when every save succeeded; Discard SHALL close without saving; Cancel SHALL keep the window open with every edit intact. Restarting the app and installing an update SHALL ask the same way first. In browser mode the app SHALL ask the browser to warn before the page is left. If the web part of the app stops answering, the person SHALL still be able to close the app. Ending the operating-system session (logging out or shutting down), and on macOS quitting from the Dock or the app switcher, cannot wait for an answer and are outside this requirement.

#### Scenario: save all

- GIVEN an unsaved rendered edit in one file and an unsaved source edit in another
- WHEN the window is closed and Save all is chosen
- THEN both files are written and the window closes

#### Scenario: a save is blocked

- GIVEN an unsaved edit to a file that changed on disk
- WHEN the window is closed and Save all is chosen
- THEN the window stays open, nothing overwrites the disk file, and the file shows the existing reload-or-overwrite choice

#### Scenario: discard and cancel

- GIVEN an unsaved edit
- WHEN the window is closed and Discard is chosen, the window closes without writing; WHEN Cancel is chosen instead
- THEN the window stays open and the edit is still there

#### Scenario: nothing unsaved

- GIVEN no unsaved Files edit
- WHEN the window is closed
- THEN it closes at once with no dialog

### R63. The left panel shows five distinct levels in every built-in theme [Must] (amendment A9)

The left panel SHALL draw the repository or project card, the environment band, the primary checkout, a worktree and a chat row so that each differs from the others by more than color: the environment band has its own surface and a leading accent rule; the primary checkout has an accent-tinted badge with an icon and a heavier label; a worktree has a branch icon, an indent guide under its environment and its own surface; a chat row is smaller and lighter than a checkout row. This holds in both the Environments and the Repositories view and in each of the six built-in themes, and every text and surface pair of these levels SHALL keep at least 4.5:1. A view marks only the levels it draws: a local environment draws no environment card, so its rows carry no `environment` level.

#### Scenario: fixture sidebar

- GIVEN a sidebar with one repository, two environments, one primary checkout, two worktrees and a chat under each checkout, in each built-in theme
- WHEN it is painted
- THEN each element carries its level (`repo`, `environment`, `checkout`, `worktree`, `chat`), the primary checkout is marked as primary, the level surfaces and markers of that theme resolve to values that differ from each other, and every level's text meets 4.5:1 on its surface

#### Scenario: primary without reading the badge

- GIVEN a primary checkout and a worktree side by side
- WHEN the badge text is ignored
- THEN the primary checkout is still told apart by its icon and label weight, and the worktree by its branch icon and indent guide

### R64. The existing card states survive the redesign [Must] (amendment A9)

The left panel SHALL keep every card outlined, the active card's stronger border, the tinted multi-selected card, the focus ring, the hover state and the dimmed unavailable environment, and a selected worktree SHALL be clearly stronger than a hovered one.

#### Scenario: states on a worktree

- GIVEN a worktree row
- WHEN it is hovered, then selected, then focused by keyboard
- THEN each state is visible and differs from the others, and the selected state differs from hover by more than a slight tint

### R65. Themes can style each sidebar level [Must] (amendment A9)

The supported tokens SHALL include `sidebar-env-accent`, `sidebar-primary-badge`, `sidebar-primary-badge-foreground`, `sidebar-worktree`, `sidebar-worktree-border`, `sidebar-worktree-icon`, `sidebar-chat-foreground` and `sidebar-indent-guide`, next to the existing `sidebar-well`, `sidebar-card`, `sidebar-card-border`, `sidebar-env-band` and `sidebar-card-shadow`. A theme file without them SHALL get values derived from its base, so existing theme files keep working. The theme editor's Sidebar group SHALL offer every one of them and SHALL show a live preview of the five levels built from fixture data, drawn by the same styles as the real left panel. Export and import SHALL carry them, and the contrast check of R54 to R56 SHALL cover the new text and surface pairs.

#### Scenario: old theme file

- GIVEN a custom theme saved before these tokens existed
- WHEN it is applied
- THEN the left panel shows the five levels with values derived from the theme's base and nothing is reported as invalid

#### Scenario: custom worktree color

- GIVEN a custom theme that sets `sidebar-worktree` and `sidebar-primary-badge`
- WHEN it is edited in the theme editor
- THEN the preview and the real left panel repaint with those values, and an export followed by an import keeps them

#### Scenario: unreadable level

- GIVEN an imported theme whose `sidebar-primary-badge-foreground` on `sidebar-primary-badge` is below 4.5:1 and below the base's ratio
- WHEN it is imported
- THEN that pair falls back as R55 describes

#### Amendment A10: host dashboard (#292)

A10 (proposed 2026-11-11, awaiting the user's approval in chat). Issue #292 joins this pull
request: a **Host dashboard** for each environment that shows the CPU, memory and volume space of
the host its server runs on, live and since the server process started. Scope: all of the issue's
P0, its P1.1 charts inside P0, then P1.2, P1.3 and P1.4, and P2.1 and P2.2 as separate tasks
that can be cut. The issue was verified at an older commit; its corrections on this branch are in
[the design note](../2026-11-11-host-metrics-dashboard-design.md#where-the-issue-is-wrong-or-stale-on-this-branch).
Requirements R66 to R85, decisions D22 to D33. Plan phase: Phase 11.

Names used in these requirements:

- **Host collector**: the server part that reads the host's CPU, memory and volumes.
- **Background rate**: one reading every 60 seconds. **Live rate**: one reading every second.
- **Host stream**: the subscription a client opens to receive host readings.
- **Host dashboard**: the sheet that shows one environment's host readings.

### R66. The host collector reads CPU, memory and volume space without a process scan [Must] (amendment A10)

The host collector SHALL report CPU use as a percentage of all logical cores between 0 and 100, memory total, used and available bytes where used is the operating system's own used figure and available is total minus used, and for each volume its mount point, name, file system, total and free bytes, both relative to the user the server runs as (Linux: total blocks and the blocks available to unprivileged users from `statvfs`; macOS: the volume's total capacity and its available capacity for important usage; Windows: the caller's total and the caller's free bytes from one `GetDiskFreeSpaceEx` call, so a quota applies to both), and used bytes as total minus free, never below 0, and whether it is removable or read-only (on Linux from the mount options), and it SHALL NOT enumerate processes to do so.

#### Scenario: memory figures

- GIVEN a source that reports 32,000,000,000 bytes total and 11,200,000,000 bytes used
- WHEN the collector takes a reading
- THEN the reading has `memoryTotalBytes` 32,000,000,000, `memoryUsedBytes` 11,200,000,000 and `memoryAvailableBytes` 20,800,000,000

#### Scenario: CPU outside its range

- GIVEN a source that reports CPU use of 104.5 and then of -0.2
- WHEN the collector takes two readings
- THEN their `cpuPercent` values are 100 and 0

#### Scenario: free above total

- GIVEN a source that reports a volume with 100 GB total and 800 GB free
- WHEN the collector takes a reading with volumes
- THEN the volume has `freeBytes` 100 GB, `totalBytes` 100 GB and `usedBytes` 0, on every system

#### Scenario: read-only mount on Linux

- GIVEN a Linux host with an ext4 image mounted read-only at `/mnt/ro-test`
- WHEN the native source lists and reads its volumes
- THEN `/mnt/ro-test` has `readOnly` true and `/` has `readOnly` false

#### Scenario: no process table

- GIVEN the native source
- WHEN it takes 10 readings
- THEN no process list was refreshed (the source exposes no process refresh and its process count stays 0)

### R67. The volume list shows each local volume once [Must] (amendment A10)

The host collector SHALL skip zero-size volumes, `overlay` volumes not mounted at `/`, mount points that are files, and network volumes, SHALL merge volumes that share storage (same file system, total and free bytes) into one entry mounted at `/` when there is one and otherwise at the shortest mount point, and SHALL keep removable and read-only volumes with their markers.

#### Scenario: container and APFS lists

- GIVEN a source listing `/` (overlay, 100 GB total, 40 GB free), `/etc/hosts` (a file, ext4, 100 GB, 40 GB), `/var/lib/docker/overlay2/x/merged` (overlay, 100 GB, 40 GB), `/System/Volumes/Data` and `/` (both apfs, 2,000 GB total, 600 GB free, on another host), `/snap/core/1` (squashfs, 0 bytes) and `/media/usb` (exfat, 64 GB, 10 GB, removable)
- WHEN the container list and the APFS list are filtered
- THEN the container list is `/` and `/media/usb` (removable), and the APFS list is `/` only

#### Scenario: two volumes that only look alike

- GIVEN `/` (ext4, 500 GB, 200 GB free) and `/data` (ext4, 500 GB, 199 GB free)
- WHEN the list is filtered
- THEN both are kept

#### Scenario: network volume

- GIVEN a volume of file system `nfs4` mounted at `/mnt/share`
- WHEN the list is filtered
- THEN it is not in the list and no space read was attempted for it

### R68. A volume that does not answer does not hold back the rest [Must] (amendment A10)

The host collector SHALL make every volume list and space read on a fixed pool of 4 disk worker threads and never in the CPU and memory sampling; WHILE a volume's read has run longer than 2 seconds, it SHALL report that volume as not responding with its last known sizes, or none before its first answer, SHALL NOT admit another read of that volume, and SHALL apply the late result when it arrives if that volume, identified by its mount point and the generation of the listing that first showed it, is still listed; WHEN a listing no longer shows a volume, it SHALL retire that volume's state and queued jobs and discard any result of its generation that arrives later, and a hung read of a retired volume SHALL NOT block a read of a new volume at the same mount point; IF the volume list takes longer than 2 seconds, THEN it SHALL keep the last list; and WHILE all 4 workers are held by calls that have not returned, it SHALL stop admitting disk reads, mark each reading with disk reads paused, and keep publishing CPU and memory at the current rate.

#### Scenario: CPU and memory keep their pace

- GIVEN a source whose volume list call and whose space read of `/mnt/slow` each block a real thread on a channel the test holds, at the live rate of 1 second
- WHEN 4 seconds pass
- THEN 4 readings arrive with `sampledAt` values 1 second apart (within 200 ms), each with CPU and memory, `/` from the last list as `ok` and `/mnt/slow` as `notResponding`, and the source received exactly one space read for `/mnt/slow`

#### Scenario: the volume answers late

- GIVEN the held read of `/mnt/slow` from the scenario above
- WHEN the test releases it with 100 GB total and 30 GB free after 12 seconds
- THEN the next reading shows `/mnt/slow` as `ok` with those sizes, and the next volume tick admits a new space read for `/mnt/slow`

#### Scenario: every worker is held

- GIVEN a source whose space reads of `/a`, `/b`, `/c` and `/d` all block
- WHEN 10 seconds pass at the live rate
- THEN every reading after the fourth call blocked has `volumesPaused` true, no fifth disk call was made, and the readings still arrive once a second

#### Scenario: a volume is replaced at the same mount point

- GIVEN a held space read of `/mnt/usb` (generation 1), then a listing without `/mnt/usb`, then a listing with a new `/mnt/usb` (generation 2) whose read returns 64 GB total and 10 GB free
- WHEN the held generation 1 read later returns 32 GB total and 30 GB free
- THEN `/mnt/usb` shows 64 GB total and 10 GB free, the late result is discarded, and the generation 2 read was admitted while the generation 1 read was still held

#### Scenario: mount churn

- GIVEN 200 listings, each with `/` and one new mount point that the next listing drops, at the live rate
- WHEN they have been processed
- THEN the collector holds state for at most the volumes of the latest listing plus the reads still held, and CPU and memory readings arrived once a second throughout

### R69. Statistics since server start keep a fixed size [Must] (amendment A10)

The host collector SHALL keep, for CPU percent and memory used percent since the server process started, the current value, the minimum, the maximum, an average weighted by each reading's interval and a p95 from 1-percentage-point bins (the whole percent at which 95 percent of the weight is reached), in a size that does not grow with uptime, and SHALL keep chart history of the last 15 minutes of readings, 1-minute buckets for the last 24 hours and 15-minute buckets beyond, each bucket with average and peak, with the oldest tier held under 1 MiB.

#### Scenario: known values

- GIVEN background readings of CPU 10, 20, 30, 40 and 90 percent
- WHEN the statistics are read
- THEN current is 90, minimum 10, maximum 90, average 38 and p95 is 90

#### Scenario: a watched minute does not outweigh an unwatched hour

- GIVEN 60 background readings of CPU 10 percent (one hour) and then 60 live readings of CPU 90 percent (one minute)
- WHEN the statistics are read
- THEN the average is between 11.3 and 11.4 and the p95 is 10

#### Scenario: a week of uptime

- GIVEN one week of simulated background readings on a paused clock
- WHEN the history is read
- THEN the raw tier holds at most 900 readings, the minute tier at most 1,440 buckets, and the statistics start at the first reading's time

#### Scenario: the oldest tier compacts

- GIVEN chart history whose oldest tier holds at most 8 buckets, fed 64 closed 15-minute buckets of CPU 10 percent, then 64 of CPU 30 percent of which one contains a reading of 95 percent
- WHEN the history is read after the compactions this forces
- THEN the oldest tier holds at most 8 buckets, its first bucket starts at the first reading, the weighted average across its buckets is within 0.1 of 20 percent, and the highest bucket peak is 95

### R70. The collector samples in the background and faster while watched [Must] (amendment A10)

WHILE no host stream is open, the host collector SHALL read CPU and memory at the background rate from server start and volumes every fifth reading; WHILE at least one host stream is open, it SHALL read at the live rate, with volumes every fifth reading; and WHEN the last host stream closes, it SHALL return to the background rate.

#### Scenario: reads per subscriber count

- GIVEN a collector with a fake source on a paused clock
- WHEN 120 seconds pass with no stream, then 10 seconds with one stream, then 10 seconds with two, then 120 seconds after both closed
- THEN the source received 2 or 3 CPU and memory reads in the first period, 9 to 11 in each live period (not 18 or more with two streams), and 2 or 3 in the last, and volume reads only on every fifth reading

### R71. The collector's cost is measured, and the sampling policy follows the measurement [Must] (amendment A10)

The host collector's CPU cost SHALL be measured through the real collector path (both loops, statistics, chart production and the encoding of every item one subscriber receives) as CPU time per background reading and per live reading on a macOS host and in a Linux container, and the sampling policy SHALL be the outcome of D22 that the measurement selects: always on with a 1-second live rate when background costs at most 0.1 percent of one core at 60 seconds and live at most 1 percent at 1 second; IF background costs more, THEN collection SHALL start at the first host stream; IF live costs more than 1 percent at 1 second, THEN the live rate SHALL be 2 seconds; and a fallback outcome SHALL take effect only after the user approves it.

#### Scenario: measured cost

- GIVEN the real collector with the native source on this repository's macOS development host and in the Linux lab container, at test rates no faster than 250 ms so that every CPU refresh does its work
- WHEN the cost probe runs 300 background-shaped and 300 live-shaped readings with one subscriber whose items are encoded
- THEN the probe reports CPU time per reading of each kind and the derived percent of one core at 60 s and at 1 s, and the design note records the figures, the method and the selected outcome

### R72. The host stream sends a snapshot first, then readings, to an authorized client only [Must] (amendment A10)

WHEN a client with the `orchestration:read` scope opens the host stream, the server SHALL send first a snapshot with the host's operating system, architecture, logical CPU count and total memory, the server's start time and boot ID, the current reading, the statistics and both charts, then one reading with the updated statistics each live tick, and SHALL end the stream when the client closes it or disconnects; IF the client lacks that scope, THEN the server SHALL refuse the stream with an authorization error and send no reading.

#### Scenario: snapshot then sample

- GIVEN a server whose collector has a fake source
- WHEN a client opens the host stream and waits 2 seconds
- THEN the first item is a `Snapshot` with `bootId`, `startedAt`, `host.cpuCount` and statistics, and the next items are `Sample` items one second apart

#### Scenario: under-scoped session

- GIVEN a session whose token has only the `orchestration:operate` scope
- WHEN it opens the host stream
- THEN it receives `EnvironmentAuthorizationError` with `requiredScope` `orchestration:read` and no chunk

#### Scenario: client leaves

- GIVEN an open host stream
- WHEN the client closes it
- THEN the stream's task ends and the collector is back at the background rate within one second

### R73. Servers advertise host metrics, and the client never asks one that does not [Must] (amendment A10)

The server SHALL advertise `hostMetrics: true` in both of its environment descriptors, a descriptor without the flag SHALL decode as `false`, and WHILE an environment's `hostMetrics` is false, the client SHALL NOT send the host stream request and the host dashboard SHALL say "This server's version doesn't report host metrics. Update it to see this dashboard." with an **Open Remote Servers** button.

#### Scenario: older server

- GIVEN a remote environment whose descriptor has no `hostMetrics` field
- WHEN its host dashboard is opened
- THEN the sheet shows the unsupported message and the button, and no `server.subscribeHostMetrics` request was sent

### R74. Mount points stay out of logs, profiler records and fingerprints [Must] (amendment A10)

The host collector SHALL name a volume in log lines only by its file system type and position in the list, and no profiler event, finding or fingerprint SHALL contain a mount point or volume name.

#### Scenario: hung volume log

- GIVEN a volume mounted at `/media/test-user/backup` that does not answer
- WHEN the collector logs it
- THEN the log line is `host volume did not answer` with `file_system` and `position` fields and contains neither `test-user` nor `backup`

### R75. Every environment has a Host dashboard entry [Must] (amendment A10)

The web client SHALL offer **Host dashboard** in a remote environment's Environment actions menu, in each connected saved server row in Settings, Remote Servers, and in the status bar's Resource Manager popover for the selected environment, local or remote, and each SHALL open the host dashboard of that environment.

#### Scenario: three entry points

- GIVEN a connected remote environment `example-server` and the local environment
- WHEN Host dashboard is chosen from the environment menu, from the `example-server` row, and from the Resource Manager popover with the local environment selected
- THEN the sheet opens titled `example-server`, `example-server` and the local environment's name

#### Scenario: disconnected row

- GIVEN a saved server that is not connected
- WHEN its row is shown
- THEN it has no Host dashboard button

### R76. The host dashboard shows CPU, memory, volumes and statistics since start [Must] (amendment A10)

The host dashboard SHALL show the CPU percentage with the logical core count and a chart of the last 15 minutes, memory as used of total with its percentage and a chart, one row per volume with a usage bar, used of total, free, and Removable, Read-only or Not responding badges, and a "Since <time> (up <duration>)" section with current, minimum, average, p95 and maximum for CPU and memory and a chart of the whole uptime with average and peak per bar, and its text SHALL contain no em dash.

#### Scenario: populated dashboard

- GIVEN a snapshot with CPU 23.5 percent on 12 cores, memory 12,025,908,428 of 34,359,738,368 bytes, volume `/` with 2,147,483,648,000 bytes total and 671,088,640,000 bytes free, and a start time 3 hours 5 minutes ago, in the `en-US` locale
- WHEN the dashboard renders
- THEN it shows "23.5%", "12 cores", "11.2 GB of 32.0 GB, 35%", a row for `/` with "625.0 GB free", and "Since" followed by the start time and "(up 3h)"

### R77. The host dashboard shows loading, live, stale, disconnected, restarted, unsupported and error states [Must] (amendment A10)

The host dashboard SHALL show skeletons until the first snapshot; WHEN no item has arrived for 3 seconds while subscribed, it SHALL dim the values and show "Last updated <n> s ago"; WHILE the environment is not connected, it SHALL keep the last values dimmed with "Disconnected" and SHALL subscribe again after reconnect; WHEN a snapshot after reconnect has a different boot ID, it SHALL reset the statistics and show "Server restarted at <time>"; and IF the stream fails, THEN it SHALL show the failure message and a **Retry** button that subscribes again.

#### Scenario: one test per state

- GIVEN a fake host stream
- WHEN it sends nothing; a snapshot; nothing for 3 seconds; a disconnect; a reconnect with a new boot ID; a failure; and Retry is pressed
- THEN the sheet shows skeletons; values; "Last updated 3 s ago"; "Disconnected" with the last values; "Server restarted at" and reset statistics; the failure message with Retry; and a new subscription

### R78. The host stream runs only while the dashboard can be seen [Must] (amendment A10)

WHEN the host dashboard closes or the document becomes hidden, the web client SHALL close the host stream, and WHEN the document becomes visible again with the dashboard open, it SHALL open the stream again.

#### Scenario: hidden document

- GIVEN an open host dashboard with an active stream
- WHEN the document's visibility becomes `hidden`, then `visible`
- THEN the subscription ends, and a new one starts with a new snapshot

#### Scenario: unfocused but visible

- GIVEN an open host dashboard
- WHEN the window loses focus but stays visible
- THEN the stream stays open

### R79. The collector builds and passes its tests on Linux, macOS and Windows [Must] (amendment A10)

The host collector and its tests SHALL compile and pass on the Linux, macOS and Windows CI runners, including the exit test of R84 and the runtime start-and-quiesce test, and each CI step that runs them SHALL fail when it matches no test.

#### Scenario: CI

- GIVEN the pull request's CI run
- WHEN the server test jobs finish on Linux, macOS and Windows
- THEN the host collector's tests pass on all three

### R80. The readings match the operating system's own tools [Should] (amendment A10)

The host collector's readings SHALL agree with the operating system's command-line tools: memory used within 3 percentage points, each volume's total within 1 percent, free space within 1 percent of the matching column of the same tool (Linux: `df -k -P` Available and 1024-blocks; Windows: the caller's free and total bytes; on macOS, the volume's available capacity for important usage, falling back to its available capacity as the collector does, read through the system's JavaScript bridge, and at least `df`'s Available), and CPU within 10 percentage points over the same 5-second window.

#### Scenario: macOS host and Linux container

- GIVEN this repository's macOS development host and the Linux lab container
- WHEN the comparison probe runs against `vm_stat`, `df -k`, `osascript -l JavaScript` (`NSURL` volume resource values) and `top` on macOS, and `/proc/meminfo` (`MemTotal` minus `MemAvailable`), `df -k -P` and `/proc/stat` on Linux
- THEN every comparison is inside its tolerance and the probe prints the figures it compared

#### Scenario: Windows

- GIVEN the Windows CI runner or the Windows lab
- WHEN the comparison probe runs against PowerShell's `Get-CimInstance Win32_OperatingSystem`, `[System.IO.DriveInfo]` (`AvailableFreeSpace` and `TotalSize`) and `Get-Counter`
- THEN every comparison is inside its tolerance; until one such run has passed, R80 and the Windows space read stay unproven on Windows

### R81. Hidden volumes can be listed [Should] (amendment A10)

The host dashboard SHALL list the volumes the filter hid under a closed **Hidden volumes (N)** disclosure, each with its mount point and the reason it was hidden, and SHALL NOT read the space of a volume rejected before sampling (network, overlay not at `/`, file mount); volumes hidden as empty or as sharing storage are hidden after their space read.

#### Scenario: one network volume hidden

- GIVEN a host with `/` and an `nfs4` volume at `/mnt/share`
- WHEN the disclosure is opened
- THEN it shows `/mnt/share` with "Network volume" and no sizes, and the source received no space read for it

### R82. Agents can read a host snapshot without paths [Could] (amendment A10)

WHERE the MCP diagnostics tools are enabled, the server SHALL offer a read-only `host_metrics` tool that returns the host facts, current reading and statistics, with each mount point kept only when it is a file system root and reported as `null` otherwise, and without volume names.

#### Scenario: user name in a mount point

- GIVEN volumes `/`, `C:\` and `/media/test-user/usb`
- WHEN an agent calls `host_metrics`
- THEN the volumes' `mountPoint` values are `/`, `C:\` and `null`, and the result contains neither `test-user` nor `usb`

### R83. Each volume has statistics since start [Could] (amendment A10)

The host collector SHALL keep, for each volume's used percent, the same five statistics as R69, and the host dashboard SHALL show them in its "Since" section.

#### Scenario: a volume that filled up

- GIVEN volume `/` read at 40, 50 and 60 percent used over three background readings with volumes
- WHEN the statistics are read
- THEN `/` has current 60, minimum 40, maximum 60 and average 50

### R84. A hung volume never delays server exit [Must] (amendment A10)

WHEN the server shuts down while a disk call has not returned, the host collector SHALL stop without waiting for that call, and the server process SHALL exit.

#### Scenario: exit with a read held

- GIVEN a child process that runs the collector in a multi-thread Tokio runtime dropped after `block_on`, as the server's `main` does, with a space read blocked forever
- WHEN the child shuts the collector down and returns from `block_on`
- THEN the child exits with status 0 within 5 seconds

### R85. A slow client still receives the latest charts [Must] (amendment A10)

WHEN a subscriber falls behind while the uptime chart or the hidden-volume list changes, the server SHALL build each item only after it holds a free slot in that subscriber's send queue, from the latest reading and chart revision at that moment, so that once the items already queued have drained the subscriber holds the latest complete chart state, and the client SHALL keep only recent points less than 15 minutes older than its newest one, at most 900 of them.

#### Scenario: blocked across a minute boundary

- GIVEN a subscriber that does not read its stream from 50 seconds into a minute until 70 seconds, on a paused clock, with its send queue of 64 items full
- WHEN it reads again and drains every item that was queued
- THEN the chart it holds includes the bucket closed at 60 seconds, every item built after it resumed carries a reading from 70 seconds or later, and no item was built while the queue was full

#### Scenario: skipped samples

- GIVEN a client view whose newest point is at 20:00:00 and which holds points back to 19:40:00
- WHEN a sample at 20:00:01 arrives
- THEN no point older than 19:45:01 remains

#### Amendment A11: Source Control Review button (#293)

Amendment A11 (2026-11-11, user, adding #293 to this batch) brings in the Review button of issue
#293: one click in the Source Control panel starts a review of the current branch and its
uncommitted changes, by a chat or AI Terminal agent picked in Settings → Agents, started in the
provider's own read-only or approval mechanism wherever one exists (plan mode, a read-only sandbox,
approval rules), and saying so where none exists. Its first priority tier is in scope, then the
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

#### Scenario: saved reviewer unavailable

- GIVEN the saved code review agent is chat `claudeAgent`, Claude is disabled on this environment, and chat `cursor` is available
- WHEN the panel is shown with changes
- THEN the button is disabled with the tooltip "Claude is not available. Change the code review agent in Settings → Agents.", and clicking it starts no review with Cursor or any other agent

#### Scenario: saved reviewer not listed

- GIVEN the saved code review agent names a provider instance that this environment does not list
- WHEN the panel is shown with changes
- THEN the button is disabled with the tooltip "The code review agent is not available on this environment. Change it in Settings → Agents."

#### Scenario: draft chat with a chat reviewer

- GIVEN the current chat has not been sent yet and the reviewer is chat `codex`
- WHEN the panel is shown with changes
- THEN the button is disabled with the tooltip "Send a first message in this chat, then review from here."

#### Scenario: draft chat with a terminal reviewer

- GIVEN the current chat has not been sent yet and the reviewer is Claude Terminal
- WHEN the panel is shown with changes
- THEN the button is disabled with the same tooltip and no terminal is opened

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
- THEN all three values are returned

#### Scenario: replacing a model drops its old options

- GIVEN a stored review model `claudeAgent` / `opus` with options `[{"id":"effort","value":"high"}]`
- WHEN a patch sets the review model to `codex` / `gpt-5` with no options
- THEN the stored review model is exactly `codex` / `gpt-5` with no `options` key

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

### R98. A Windows terminal review starts only on a proven path and with the prompt intact [Must] (amendment A11)

WHILE the reviewing environment runs Windows, the review launcher SHALL keep terminal reviewers
disabled with a reason until native batch-launch tests have passed on Windows, and once enabled
SHALL replace each line break in the prompt with one space; IF the encoded batch command line
exceeds the 8,191 characters `cmd.exe` accepts, THEN the terminal service SHALL refuse the launch
with an error that names the length, and the UI SHALL show it.

#### Scenario: off until proven

- GIVEN a Windows environment, the reviewer Claude Terminal and a dirty tree, before the Windows terminal reviews are enabled
- WHEN the panel is shown
- THEN the button is disabled with the tooltip "Terminal reviews are off on Windows for now. Pick a chat reviewer in Settings → Agents.", the review menu shows Claude Terminal and Codex Terminal disabled with the same reason, and on macOS and Linux environments the button and those items stay enabled

#### Scenario: line breaks

- GIVEN a Windows environment with terminal reviews enabled and a prompt "a\nb\r\nc"
- WHEN the review command is built
- THEN the prompt argument is "a b c"

#### Scenario: arguments through an npm-style shim

- GIVEN a Windows `.cmd` shim that forwards `%*` to `node`, and one argument per class: `say "hi"`, `100% %PATH%`, `a & b`, `a ^ b`, `a | b`, `c < d > e`, `!x!`, `ends with \\\`, `back\\"slash` and one argument combining all of them
- WHEN each is launched through the terminal launch path
- THEN `node` receives each argument exactly, and no redirect or second command runs

#### Scenario: too long for cmd.exe

- GIVEN a Windows batch target and arguments whose encoded command line is 8,192 characters or longer, for example a prompt ending in 4,200 backslashes
- WHEN the terminal service prepares the launch
- THEN it refuses with "The command is too long for a Windows terminal (N of 8,191 characters). Shorten the review prompt or pick a chat reviewer.", nothing is spawned, and the UI shows that message

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

The user guide and the changelog SHALL describe the Review button, its settings and the mechanism
each reviewer starts with (for example "starts in Claude's plan mode", "runs in Codex's read-only
sandbox") without promising that a review cannot edit, and a packaged desktop test SHALL
start a review from Source Control and observe the panel, its first message and the absent
Implement action.

#### Scenario: packaged review

- GIVEN the packaged desktop fixture project with one modified file
- WHEN Source Control's "Review changes" is clicked
- THEN a "Code review · " tab opens and the fixture provider receives a first message that contains "Scope: the staged, unstaged and untracked changes in the working tree"

#### Scenario: packaged Claude review ending in a plan

- GIVEN the packaged fixture with the code review agent set to chat `claudeAgent`, and a fixture Claude response to the review prompt that calls `ExitPlanMode` with a plan
- WHEN the review runs, the turn completes and the window reloads
- THEN the plan card reads "Review findings", and no Implement, Refine or "Implement in a new thread" action is shown before or after the reload; the same case without the review flag shows Implement

### R102. A keyboard shortcut starts a review [Should] (amendment A11)

Correction of 2026-11-12: the shortcut is a built-in fallback, like the find shortcut, not an entry of the shipped default keybindings, because a new command in the shipped defaults breaks an older client's decoding of the server's settings and a person with a saved keybindings file never receives new defaults.

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
- THEN the tooltip reads "Review branch vs origin/main and uncommitted changes" and "Starts in Claude's plan mode."

### R105. One-off instructions can be added to a review [Should] (amendment A11)

The review menu SHALL offer "Review with instructions…", which takes up to 1,000 characters and
appends them after a blank line to the resolved prompt of that one review only.

#### Scenario: added instructions

- GIVEN "Focus on the parser." typed in the instructions field
- WHEN the review starts
- THEN the first message ends with "\n\nFocus on the parser." and the saved prompts are unchanged

#### Amendment A12: a fresh Create worktree dialog (#346)

A12 (added on the user's instruction in chat on 2026-11-11 during execution). Issue #346 joins this pull request: the Create worktree dialog kept the previous creation's name, source, mode and base override when it was opened again. The issue's proposed behavior and its recorded agent's calls are the requirement; they replace the documented promise that a same-project source survives a reopen. Requirements R106 to R109, decision D50. Plan phase: Phase 13.

### R106. Every opening of Create worktree starts fresh [Must] (amendment A12)

WHEN the Create worktree dialog opens, the dialog SHALL show an empty Name and an empty Create From, no selected source branch and no Reuse branch, Smart mode, an empty base override, Advanced collapsed, Create more off and no earlier form error, and SHALL put focus in Name. This holds after a successful creation and after the dialog was dismissed with Close or Escape.

#### Scenario: reopen after a successful creation

- GIVEN a dialog for one project with a typed name, Branch mode, a picked source branch, a base override under Advanced and a manually picked agent
- WHEN creation succeeds with Create more off and the dialog is opened again for the same project, on the same mounted instance
- THEN Name and Create From are empty, no branch is selected, the mode is Smart, the base override is empty, Advanced is collapsed, Create is disabled until a new name is entered, and neither cached nor refreshed branch data brings the old name or source back

#### Scenario: reopen after dismissal

- GIVEN edited input, Advanced expanded, Create more on and a form error
- WHEN the idle dialog is dismissed with Escape and opened again
- THEN every default of this requirement shows and the earlier error is gone

#### Scenario: the next creation borrows nothing

- GIVEN a successful first creation and a reopened dialog
- WHEN a different valid name is entered with no source and no override, and Create is pressed
- THEN the create command carries the new title and branch, `HEAD` as its base, the current project and the resolved agent, and no value of the first creation

### R107. A fresh opening keeps context and saved preferences [Must] (amendment A12)

WHEN the Create worktree dialog opens, the dialog SHALL select the project the caller supplies, otherwise the first available project or none, and SHALL select the Default Agent saved in Settings with the existing availability and fallback behavior, not the agent picked by hand in an earlier opening.

#### Scenario: another project, and no context

- GIVEN an earlier opening for project A
- WHEN the dialog opens for project B, and later with no project context
- THEN B is selected, then the first available project, and none of A's form values return; with no projects there is no selection and Create is disabled

#### Scenario: the saved agent wins over an earlier manual pick

- GIVEN a manually picked agent in the previous opening and a changed Default Agent in Settings
- WHEN the dialog opens again
- THEN the saved default is selected when it is available, and the existing fallback reason shows when it is not

### R108. Work in progress survives while the dialog stays open [Must] (amendment A12)

IF a creation fails, or projects, branches or agent settings refresh while the dialog is open, THEN the dialog SHALL keep the person's inputs, SHALL not apply the opening reset and SHALL not create a second worktree.

#### Scenario: failure, pending and refresh

- GIVEN an edited form
- WHEN creation fails, the inputs stay with the existing error; WHEN creation is pending, dismissal and a second submission stay blocked; WHEN branch data refreshes without a new opening
- THEN no input is erased

### R109. Create more clears only the per-worktree fields [Must] (amendment A12)

WHEN a creation succeeds with Create more on, the dialog SHALL stay open with Name, Create From, the branch and Reuse selection and the form error cleared and focus in Name, and SHALL keep the batch's project, mode, agent, base override, Advanced state and Create more setting until the dialog is closed.

#### Scenario: batch, then a fresh opening

- GIVEN Create more on with Branch mode, a base override and a picked agent
- WHEN creation succeeds
- THEN the dialog stays open with only the per-worktree fields cleared and no navigation happens; WHEN it is then closed and opened again, R106 and R107 apply

#### Amendment A13: the composer's model picker stays on the chat's provider (#347)

A13 (added on the user's instruction in chat on 2026-11-11 during execution, diagnosed with a reproduction first). Issue #347 joins this pull request: a chat created for one agent listed every ready provider's models before its first turn. Requirements R110 to R112, decision D51. Plan phase: Phase 14.

### R110. A chat created for an agent lists only that agent's models [Must] (amendment A13)

WHILE a chat that exists on the server has not started its first turn, the composer's model picker SHALL list only the models of the provider instance the chat was created for, and SHALL refuse a selection that belongs to another provider.

#### Scenario: a new main chat with two ready providers

- GIVEN two ready providers and a never-started main chat created for the first
- WHEN the model picker opens
- THEN it lists the first provider's models only, a second account of the same driver is not offered, and a stale selection from the other provider is not sent

### R111. A blank draft still chooses its provider [Must] (amendment A13)

WHILE a chat is a local draft that does not exist on the server, the model picker SHALL list every ready provider, and the provider picked in the draft SHALL be the one the chat binds to. Adopted worktrees and pull request threads take the project's Default Agent.

#### Scenario: a drafted pick

- GIVEN a blank draft with two ready providers
- WHEN a model of the second provider is picked and the chat is created
- THEN the chat is bound to the second provider

### R112. An unavailable provider is explained and Send is refused [Must] (amendment A13)

IF the provider a chat is bound to is disabled, removed or not supported by the server, THEN the composer SHALL name the provider and the way to recover, SHALL refuse Send with that reason, and SHALL NOT fall back to another provider. An instance that is configured but not reported yet SHALL NOT be called unavailable.

#### Scenario: a disabled provider, before and after the first turn

- GIVEN a chat bound to a provider that was then disabled
- WHEN the composer shows, for a never-started and for a started chat
- THEN a banner names the provider and points to Settings > Providers or a new chat with another agent, and Send submits nothing

#### Amendment A14: one terminal in several windows keeps its last lines (#348)

A14 (added on the user's instruction in chat on 2026-11-11 during execution, with the user's ruling of 2026-11-11 on how two windows share one terminal). Issue #348 joins this pull request: an AI terminal lost its bottom lines or its whole footer until a panel was resized. The owner uses the macOS app as a client of a Linux desktop app, so two windows of different size show one terminal. The symptom was reproduced only with two viewers; single-window runs on three environments did not show it, and the owner's observation that a panel resize repairs it is not explained. Requirements R113 to R118, decisions D52 to D54. Plan phase: Phase 15.

### R113. The window last used sizes the terminal [Must] (amendment A14)

WHEN a person focuses, types in or clicks a terminal in one window, that window SHALL become the one that sizes the terminal. A window nobody is using SHALL NOT take the size, including when its tab is shown again, when it reloads or when the terminal queries it.

#### Scenario: an unattended window does not take the size back

- GIVEN a client window that owns the size and a second window left idle
- WHEN the idle window's tab is hidden and shown, or it reloads
- THEN the client window still owns the size

#### Scenario: a click claims

- GIVEN a window showing a mirror
- WHEN the person clicks the terminal in it
- THEN that window owns the size and the program is told its fit

### R114. A window that does not size the terminal shows all of it [Must] (amendment A14)

WHILE another window sizes the terminal, a window SHALL show the whole grid: scaled down to fit when the grid is larger than its space, never below half size, after which it scrolls pinned to the bottom; at normal size with empty space when the grid is smaller. It SHALL say that another window sizes the terminal and at what scale.

#### Scenario: a taller owner

- GIVEN an owner of 120 by 50 and a mirror that fits 100 by 30
- WHEN the program draws its footer on the last rows
- THEN the mirror shows the footer, clipped by no pixel

### R115. Every window converges on the size the server holds [Must] (amendment A14)

WHEN a window asks for a size, the server SHALL answer with the outcome, the size it holds, the terminal generation and a sequence, and the client SHALL apply answers and events in generation and sequence order and ignore older ones. An equal claim SHALL be acknowledged to the requester in stream order.

#### Scenario: a stale answer

- GIVEN a resize answer that arrives after a newer size event
- WHEN the client reads it
- THEN the newer size stays

### R116. Mixed versions keep working [Must] (amendment A14)

The server SHALL answer `terminal.resize` in the released form unless the request says the caller reads the new answer, and the client SHALL send an input origin only to a server that advertises it. A client of either age SHALL type and resize against a server of either age.

#### Scenario: the released client against the new server

- GIVEN the resize codec of the released contract
- WHEN the new server answers a request without the flag
- THEN the answer decodes, and no extra acknowledgement is sent

### R117. Only real typing counts as use [Must] (amendment A14)

The server SHALL NOT treat the terminal's automatic replies as use of a window. WHEN the owner leaves several viewers, the size SHALL go to the one typed in last, and with no typing on record it SHALL stay un-owned until a person uses a window. Input from an older client, which carries no origin, SHALL count as use.

#### Scenario: a reply to a query

- GIVEN an owner that left and an idle mirror whose terminal answers a device query
- WHEN the owner returns
- THEN the owner takes the size back

### R118. A refused low-level resize does not leave a wrong size [Must] (amendment A14)

IF the operating system refuses a terminal resize, THEN the server SHALL retry the latest size after 100 ms, 500 ms and 2 s without another request, and if every retry is refused SHALL publish the size the terminal kept, so that every window shows the truth.

#### Scenario: refused on every retry

- GIVEN a terminal of 80 by 30 whose resize to 100 by 40 is refused four times
- WHEN the retries are exhausted
- THEN every window is told 80 by 30, a warning is logged without terminal content, and the owner asking again for 100 by 40 sends nothing to the terminal until the state changes

## Constraints and assumptions

- **Public repository.** No real host, organization, person or machine path appears in code, tests, fixtures or this folder. Tests use `example-server`, `gitlab.example.test`, `test-user` and disposable folders. (Repository rule: AGENTS.md, Sensitive Data.)
- **Agent-run delivery.** Every requirement is proven by a script, a test, the WebDriver end-to-end suite or the local Docker and Windows labs. No step needs a person at a screen. (AGENTS.md, Delivery discipline.)
- **Design notes.** #342 and #290 each need a design note in `docs/plans/` that lands with the code. A note counts as approved once Codex and the advisor have reviewed it and their findings are resolved. (Decision D3.)
- **Third-party code.** Code ported from Orca keeps its MIT copyright and permission notice. Tokyo Night and Matrix Dark values carry notices for Omarchy (MIT), the Tokyo Night projects (MIT and Apache-2.0) and omarchy-matrix-theme (MIT). The repository has no notices file today, so one is added. Every new package has its license checked before it lands.
- **No production Node runtime, no new sidecar.** Rich editing and theming are web-client features. (AGENTS.md, Package Roles.)
- **Server tests** use the real Git runner, an isolated home folder, disposable repositories and a local Git host that requires authentication. They never contact a public Git host and never read real credentials. (#343, #345 issue test plans.)
- **Windows.** The #341 scenario of R14 passes on the Windows CI job, because the report is from Windows 11 with Git 2.56.
- **Existing values kept:** the hang budget is 10 seconds; the default Git timeout is 30 seconds; the push transfer limit is 600 seconds; the audit interval is 600 seconds; the stored mode key `bibcode:theme` and its three values are unchanged.
- **Theme storage** is per device in the browser's local storage, next to the mode. The desktop content policy allows only external scripts, so the pre-paint step stays an external script.
- **Profiler coverage.** New events, findings and log lines are documented in the profiler skill references and the architecture overview in the same change. (AGENTS.md, Profiler, Crash, and Trace Coverage.)
- **Living documents** updated in the same change: the worktree catalog architecture document (R4 to R6), the user workspace guide (R13, Files editing, Appearance), and the testing runbooks where a packaged UI flow is added.
- Assumption (agent's call: read from Git's source, not yet run): the #341 lock comes from the background unstaged-statistics command rewriting the index for timestamp-only changes. The first planned task proves or refutes this with a failing test against real Git before any fix. If refuted, R14 still stands and the fix follows the evidence.
- Assumption (agent's call: the Files upload route already transfers arbitrary files): Insert image needs no new server call. If the route cannot write next to the Markdown file, the plan adds that path without changing R28.

## Decisions

D1. One pull request closes all seven issues. Alternatives considered: one pull request per issue, which is easier to review but was not what the maintainer asked for. Decided by: user. Source: request of 2026-11-09.

D2. Scope per issue is the first priority tier of #340, #342 and #343 plus matching help text; all of #341, #344 and #345; and the first two tiers of #290. Its sidebar extension was first left out and came back in by amendment A9 (2026-11-11, user, after trying the dev build: the left panel still did not show which row is a repository, a machine, the main checkout or a worktree); see R63 to R65 and D21. Alternatives considered: including #343 remote sign-in (needs a secret-handling design), #342 shortcuts and paste (deferred to keep the first slice provable), the #290 sidebar extension (a separate redesign). Decided by: user. Source: round 1, questions 1 and 2.

D3. Design notes for #342 and #290 count as approved after Codex and advisor review. Alternatives considered: waiting for the maintainer to approve each note, which the issues ask for but which stops an unattended run. Decided by: user. Source: round 1, question 3.

D4. The orphan warning requires worktree evidence, and BiBCode starts recording the worktrees it creates. Alternatives considered: warn for every unowned folder (today's rule, the cause of #344); skip every folder without `.git` (hides real leftovers); guess from the folder's shape (unreliable). Accepted cost: a leftover from before this change with no `.git`, no receipt and no marker stops warning. Decided by: user. Source: round 1, question 4.

D5. Status reads resume once a push-family operation finishes its local writes, while the write lock stays held to the end. Alternatives considered: let reads run for the whole action and rely on the version check alone (every read would be rejected and subscribers would spin); a deadline that returns stale status (hides the wait instead of removing it); raising the hang budget (hides the hang). Decided by: user. Source: round 1, question 5.

D6. The #341 fix has three parts: background reads that do not lock the index, a clean stop before a forced one, and removal of a lock only when BiBCode's own forced-stopped process left it. Alternatives considered: pausing polling while the index changes (reduces the window without closing it); a UI warning for stale locks (does not fix the cause). Decided by: user. Source: round 1, question 6.

D7. The rendered view uses the TipTap editor family with its Markdown support, as Orca does. Alternatives considered: Lexical, which is already installed but is used only as a plain-text composer, so the toolbar commands and the source-preserving save would be written from scratch. Accepted cost: about ten new packages. Decided by: user. Source: round 1, question 7.

D8. Insert image copies the picked file into the Markdown file's folder and inserts a relative link, with a numbered suffix when the name is taken. Alternatives considered: linking to the file where it is (breaks when the repository moves); a shared assets folder (a new convention nobody asked for). Decided by: user. Source: round 1, question 8.

D9. #290 follows its issue's recommended answers: warn about contrast in the editor and fall back to base values on import; picking a theme for the other mode fills its slot and offers a switch; a curated token list; per-device storage; radius and "no sidebar shadow" first, then focus ring and control shadow. Alternatives considered: blocking Save on low contrast (stops deliberate choices); switching mode automatically (surprising); exposing every CSS variable (a larger contract to keep stable); syncing through the server (cannot paint before first frame). Decided by: user. Source: round 1, question 9. Amended by A8 (2026-11-10, user, after trying the dev build): clicking a theme row applies it and switches the mode to its base, with Undo, because a slot change that leaves the screen unchanged read as "nothing happens".

D10. The stage header uses a quiet muted strip with a smaller, heavier, uppercase label, the pattern the app already uses for group labels. Alternatives considered: a bottom rule only (too weak in dark mode); the bordered accordion of the pull-request checks tab (changes the column layout). Decided by: agent's call. Source: #340 open question 1 and existing group-label styles.

D11. The remote failure names the server and says "the user that runs BiBCode", because the server's account name is not available to the client. Alternatives considered: exposing the account name (a new field with privacy cost for a one-line gain). Decided by: agent's call. Source: code reading of 2026-11-09.

D12. On the local desktop the missing-username failure keeps today's behavior. Alternatives considered: adding local guidance, which the issue does not ask for. Decided by: agent's call. Source: #343 R2 and R3.

D13. The clean-stop grace period and the lock-unchanged wait are 2 seconds each. Alternatives considered: 5 seconds (slows shutdown); no wait (risks removing a lock another Git just took). Decided by: agent's call. Source: none; chosen as short enough for shutdown and long enough for Git to remove its lock.

D14. Undo history is per view. A rendered edit arrives in source view as one undoable step, source history is kept, and rendered view starts a fresh history each time it is entered. Alternatives considered: one history shared by both views (neither editor supports it, and Orca does not have it). Decided by: agent's call. Source: #342 open question 2.

D15. A Markdown file with constructs the rich editor cannot represent, and every `.mdx` file, stays read-only in rendered view. Alternatives considered: opening it editable and normalizing on save (silent rewrites, an anti-goal). Decided by: agent's call. Source: #342 goals and open question 4.

D16. An untouched file saves byte-identical, including a frontmatter block with no final newline. Alternatives considered: Orca's newline fix, which changes a file the person did not edit. Decided by: agent's call. Source: #342 open question 8.

D17. New color tokens are named `foreground-strong`, `placeholder`, `primary-hover`, `primary-active`, `selected` and `selected-foreground`; non-color tokens are `radius`, `sidebar-card-shadow`, `focus-ring-width`, `focus-ring-offset` and `control-shadow`. Tokyo Night sets `foreground-strong` to `#c0caf5`. Diff line fills stay derived from the success and destructive colors. Alternatives considered: separate diff-line tokens (two more tokens for a difference of a few shades). Decided by: agent's call. Source: #290 requirement 7 and open questions 8 and 10.

D18. Built-in names are "Tokyo Night", "Matrix Dark", "Matrix Light" and "Verdant Light", with the source named in each row's subtitle. Tokyo Night and Matrix Dark keep their source values, including ANSI black equal to the background and Matrix Dark's softer accent. Alternatives considered: brightening Matrix Dark toward the mockups (departs from the cited source). Decided by: agent's call. Source: #290 open questions 6, 7, 9 and 11.

D20. Review-driven clarifications: "remote server" means any server the desktop app did not start inside itself; a creation record ends when its folder is gone; several rendered edits in one visit are one undo step in source view; the list of constructs that keep a file read-only is the one in R34; an unset token keeps its base definition, including derived ones; the theme format and the editor cover every supported token instead of a shorter curated list, because the built-in themes already set about 35 of them; contrast minimums bind the four new built-ins and not Light and Dark; a low-contrast import has the failing overrides removed from what is stored. Alternatives considered: a curated editor list of about 20 tokens (a duplicate of a built-in would carry values the person cannot edit); painting base values for failing pairs without changing the stored theme (export and re-import would then disagree with what is shown). Decided by: agent's call. Source: independent read of 2026-11-09.

D21. The sidebar levels reuse the existing sidebar tokens and add eight (R65) instead of the issue's eighteen. Alternatives considered: the issue's full list (it renames `sidebar-card`, `sidebar-card-border`, `sidebar-env-band` and `sidebar-card-shadow`, which would need aliases or break saved themes), a separate selected-worktree token (selection keeps the primary-tinted states of R64), a sidebar radius token (the `radius` token already exists). New defaults for Light and Dark are intended; R50's "today's look" covers only the six roles it names. Levels are styled in one place from `data-sidebar-level` and `data-primary` attributes, with no new subscriptions in the sidebar. Decided by: agent's call, after the user's go-ahead for A9. Source: #290 Extension, parts 1 and 2.

D19. A theme with no terminal colors uses its base's built-in terminal palette, and the custom theme library holds at most 64 themes. Alternatives considered: deriving the terminal background from the UI background (breaks the reason the terminal is decoupled). Decided by: agent's call. Source: #290 open question 4 and Orca's limit.

D22. The collector samples from server start at 60 seconds, faster while watched, subject to measured cost (R71). Task 11.4 measures first and then applies the policy. Outcomes: always on with live 1 s (background at most 0.1 percent of one core and live at most 1 percent); start at the first host stream (background over 0.1 percent; R69, R70, R71 and R76 then say "since the first dashboard opened"); live 2 seconds (live over 1 percent at 1 s and at most 1 percent at 2 s; R68's scenarios, R70, R72 and R77's stale threshold, 5 s instead of 3 s, change, with the tests Task 11.4 lists). A fallback takes effect only after the user approves it, before any web task; if live is over 1 percent even at 2 s, no outcome is accepted and the user decides. Alternatives considered: sampling only while a dashboard is open (cannot answer "since server start"); starting at the first open (the first look of each run has no history). This reverses the process monitor's rule that a server nobody reads samples nothing, for the host collector only. Decided by: agent's call. Source: #292 open question 2 and P1.4.

D23. Statistics cover the current server process only, in memory, reset on restart or update. Alternatives considered: persisting 15-minute buckets for 90 days (a schema change and a migration for a follow-up nobody has asked for yet). Decided by: agent's call, the issue's recommendation. Source: #292 open question 1.

D24. Memory used is the operating system's own used figure on every platform, and available is total minus used. Alternatives considered: total minus the crate's available figure everywhere, which on macOS counts active pages as available and reported about 8 GB used where `top` showed 65 GB on the development host. Decided by: agent's call. Source: `sysinfo` 0.39.6 source and a reading on 2026-11-11.

D25. The dashboard shows local fixed and removable volumes; network volumes stay hidden by default; `overlay` is kept only at `/`; mount points that are files are skipped; volumes with the same file system, total and free bytes are one entry. Alternatives considered: skipping `overlay` everywhere (hides the only disk in a container); merging by device name (does not fold APFS volumes). Decided by: agent's call, the issue's recommendation plus the container finding; confirmed by the probe of Task 11.3. Source: #292 open question 3.

D26. The host stream needs `orchestration:read`, the scope of the process diagnostics that already return command lines. Mount points go only to authorized clients of that server; logs and profiler records never name them; the MCP tool keeps only root mount points. Alternatives considered: a new scope (one more grant for the same trust level); reducing mount points to file names as the other diagnostics tools do (turns `/media/<user>` into the user name and `/` into an empty string). Decided by: agent's call, the issue's recommendation. Source: #292 open question 4.

D27. The dashboard is a sheet, labelled **Host dashboard** at every entry; the local environment's entry is the Resource Manager popover, because the environment context card and its menu exist only for remote environments. Alternatives considered: "Dashboard" alone (says nothing in a server row); a menu on the rail's Local button (a radio, and already a menu with WSL); a Settings page (loses the sidebar's place). Decided by: agent's call. Source: #292 open question 5 and the context card's code.

D28. Each reading counts for its own interval in the average and the p95, and the wire carries at most 900 recent points and 240 uptime bars. Alternatives considered: equal weight per reading (one watched minute outweighs an unwatched hour); statistics from the background rate only (drops the spikes a person watched). Decided by: agent's call. Source: #292 P0.2 and the rate design.

D29. Hidden volumes are a disclosure in the sheet, not a setting, and there is no option to hide removable volumes. Alternatives considered: the issue's two settings (`UI.md`: options should not stand in for a design decision). Decided by: agent's call, for the user to confirm. Source: #292 P1.2 and `UI.md`.

D30. The host stream closes when the document is hidden, not when the window loses focus. Alternatives considered: also closing on blur like the status bar (a dashboard on a second display would freeze). Decided by: agent's call. Source: #292 Web 3 and #168.

D31. Free and total are both relative to the user the server runs as, on every system: Linux `statvfs` available blocks and total blocks, macOS available capacity for important usage and total capacity, and on Windows a small space read of its own, `GetDiskFreeSpaceExW` through the existing `windows-sys` dependency (its `Win32_Storage_FileSystem` feature is already enabled, and `persistence/compaction.rs` already calls it) taking the caller's free bytes with the caller's total, run on the disk workers like every other space read. Used is total minus free, clamped at 0. Alternatives considered: the crate's Windows read, which pairs the caller's total with the volume-wide free bytes, so free can exceed total under a quota and used goes negative; the volume-wide pair (not what the server's user can write). The Windows read is proven only by Windows CI or the Windows lab, and stays unproven until one runs. Decided by: the coordinator, after the second review. Source: `sysinfo` 0.39.6 `src/windows/disk.rs` and the `GetDiskFreeSpaceExW` documentation.

D32. Disk calls run on a fixed pool of 4 dedicated OS threads that shutdown never joins, never on the Tokio blocking pool and never inside CPU and memory sampling; all 4 held pauses disk reads with a visible notice. Alternatives considered: the Tokio blocking pool (runtime shutdown waits for every started blocking task, so a hung `statvfs` would keep the server from exiting); a thread per call (no bound). Decided by: the coordinator, after review. Source: the server's `main` drops its runtime after `block_on`.

D33. On Linux the read-only flag comes from the mount options in `/proc/self/mounts`, read while listing on a disk worker. Alternatives considered: listing with a storage refresh, the only way the crate sets the flag (a `statvfs` of every volume on every listing, which can hang). Decided by: agent's call, after review. Source: `sysinfo` 0.39.6 `src/unix/linux/disk.rs`.

D40. A review opens as a chat panel of the current thread through the side-chat creation path, not as a new top-level thread through `thread.turn.start` with `bootstrap.createThread`, because a public client cannot give a new thread a worktree that way and the review would read the main checkout. Alternatives considered: the issue's top-level thread (wrong checkout from a worktree); a new server RPC for a top-level thread in a worktree (new authority surface and RPC for what the panel path already does). Decided by: agent's call. Source: #293 "Start a thread with a prompt"; `decode_public_orchestration_command`.

D41. Review chats run with `approval-required` for every provider and in plan mode only for Claude, so a Claude review starts in Claude's plan mode; user, project and local Claude settings can weaken it. Alternatives considered: the user's default runtime mode (the issue's recommendation for open question 1; on this branch it is `full-access`, which leaves Codex, Cursor, Grok and OpenCode unguarded); `approval-required` with plan everywhere (plan adds no block to Codex and makes Codex, Cursor and Grok end with plan cards). UI copy names the mechanism ("Starts in Claude's plan mode.", "Runs in Codex's read-only sandbox.") and never promises the outcome, because user, project and local Claude settings load and can weaken plan mode; which settings a review loads is an open decision for the user. Decided by: agent's call. Source: #293 open question 1; driver mappings in the design note.

D42. A review thread carries a durable `codeReview` flag set at panel creation, and a review thread shows no Implement, Refine or "Implement in a new thread"; its plan card reads "Review findings". Alternatives considered: matching the title (breaks on rename); a client-only flag (lost on reload); keeping Implement (one-click auto-fixing is a non-goal). Decided by: agent's call. Source: #293 open question 2.

D43. A terminal prompt is passed as one argument after `--`, behind the fixed lead-in, and never through stdin; saved text is never trimmed or rewritten. Alternatives considered: `--` alone (Claude 2.1.322 still runs a subcommand named by the prompt); trimming leading dashes at save time (changes the person's text and misses subcommand words); stdin (interactive Codex refuses it). Decided by: agent's call. Source: #293 open question 3; CLI probes recorded in the design note.

D44. On Windows the web replaces line breaks by the environment's OS; the server's batch encoder refuses an encoded command line over 8,191 characters; and terminal reviewers stay disabled on Windows until native batch-launch tests (quotes, `%`, `&`, `^`, `|`, redirects, `!`, trailing backslashes, a backslash before a quote, combined) have passed on real Windows, with enabling as its own task and an encoder fix as a conditional task if the `%` case fails. Alternatives considered: the issue's rule keyed on the resolved `.cmd` (the web never sees it); a web-side length estimate (duplicates the encoder and missed backslash doubling); enabling on the first draft's per-character refusal (the prompt is project data and a `%` fault is suspected on this path). Decided by: coordinator. Source: #293 "Handle the argument limits"; plan review.

D45. The base is `origin/<default>` with the local branch as the prompt's fallback, and a stale local default branch may enable the button. Alternatives considered: counting against the remote ref (a server change outside this issue). Decided by: agent's call (the issue's recommendation for open question 4). Source: #293 open question 4.

D46. The shortcut defaults to `mod+alt+shift+r`. Alternatives considered: `mod+shift+r` (hard reload in browsers and WebView2); no default binding (the issue asks for one). Decided by: agent's call. Source: #293 P1.1.

D47. A `codeReviews` server capability gates the button and the settings rows, with the reason "Update the BiBCode server on this environment to use Review." Alternatives considered: sending the new fields to any server (an older server refuses the panel field). Decided by: agent's call. Source: the `sideChats` precedent.

D48. Every disabled state of the button names its reason, including loading ("Checking for changes"); a draft chat disables both reviewer kinds with "Send a first message in this chat, then review from here." (a draft has neither a panel host nor a terminal launch context); and the saved reviewer is resolved without falling back to another agent, so a missing or unavailable reviewer disables the button with a reason that names it and Settings → Agents. Alternatives considered: the issue's loading state without a tooltip (against `UI.md`); creating a top-level thread from a draft (see D40); falling back to the first available chat (silently changes the provider and its guard). Decided by: coordinator (draft and fallback rules), agent's call (loading). Source: `UI.md` Buttons and Errors; plan review.

D49. Review settings belong to the environment that runs the review, and a review model whose provider instance differs from the reviewer's is ignored in favour of the provider's session default. Alternatives considered: one review model per provider (more settings than the issue asks for). Decided by: agent's call. Source: #293 "Settings".

D50. Create worktree resets at its opening boundary: every opening is a new creation, including after Close or Escape, and no base override is remembered between openings; the Settings Default Agent and the caller's project are fresh defaults, not remembered form data; Create more keeps its batch options within one opening. Alternatives considered: resetting only after a successful creation (misses dismissal); remounting the dialog with a changing key (wider lifecycle change); keeping the documented same-project source retention (the reported defect). Decided by: the user, by adopting issue #346's proposal. Source: #346.

D51. A chat that exists on the server is bound to the instance it was created for, with the lock started chats already use; a local draft stays unlocked. Alternatives considered: lock by driver only (lists a second account's models the chat cannot use); fall back to another provider when the chat's own is unavailable (sends a turn to an agent the person did not choose). Decided by: agent's call, confirmed by the user on 2026-11-11. Source: #347.

D52. The window last used sizes the terminal; other windows scale the picture to fit and never clip; a larger window shows normal size with empty space. Alternatives considered: the smallest window sizes it; the active window sizes it and others scroll. Decided by: the user, 2026-11-11. Source: #348.

D53. The server is the authority on the terminal size: the resize answer and an ordered acknowledgement replace the client's timed settle. Alternatives considered: a client-only fix with a 250 ms settle and process-id fencing (judged unsound in review, because the client cannot order its answer against the stream). Decided by: agent's call after review. Source: #348.

D54. New wire shapes are negotiated, never sent blind: an optional request field for the resize answer, a server capability for the input origin. Alternatives considered: a new method name; a boolean for typing (cannot keep older clients' input counting while excluding new clients' replies). Decided by: agent's call. Source: #348.

## Risks

- The #341 cause is inferred from Git's source. -> The first task is a failing reproduction against real Git on Linux and Windows; the fix follows what it shows.
- Reopening status reads during a push touches the code that prevents concurrent writes. -> R20 and R21 are tested for every outcome and every push-family caller before the gate change lands, and the existing boundary test is updated on purpose.
- Removing a lock file can break another Git process. -> R16 removes only a lock that appeared during BiBCode's own process and stayed unchanged for 2 seconds, and a clean stop (R15) makes removal rare.
- A leftover from before the upgrade may stop warning (D4). -> Stated in the profiler documentation; the removal receipt and pointer file still catch most leftovers.
- Rich editing can rewrite Markdown. -> R31 to R34 are proven by byte-comparison tests on a corpus that includes frontmatter, tables, fences and mixed list markers, and unsupported files stay read-only.
- About ten new editor packages increase bundle size and supply-chain surface. -> The design note records each package, its license and its size, and the editor loads only when a Markdown file is opened in rendered view.
- Theme values are applied as live styles. -> R48 allows only colors, bounded lengths and fixed keywords, and values are set as individual properties, never as style text.
- New tokens change shared components. -> R38 and R50 are checked by comparing computed colors in Light and Dark before and after.
- One pull request of this size is slow to review and to keep green. -> The plan orders the four bug fixes first so they can be verified on their own, and keeps each issue's changes in separate commits.

## Verification

- **R1, R2:** component tests on the pipeline detail view for the header classes and heading content at wide and stacked widths, plus the existing detail tests for order, groups, resize, wrap and logs. No packaged-app screenshot: the end-to-end fixture has no pipeline host (amended 2026-11-09 during planning).
- **R3 to R7:** the profiler worktree-audit integration tests with disposable managed folders and an isolated home.
- **R8 to R12:** server tests through the real Git runner against a local authenticated Git host, in remote and local modes, for both push callers; component tests for the toast and the Git Manager panel. Existing sign-in tests stay as a regression gate.
- **R13:** a documentation check that the help text contains the R8 wording.
- **R14 to R17:** server tests against real Git with a concurrent `git add`, a controlled process that holds the lock, and a shutdown test. R14 also runs on the Windows CI job.
- **R18 to R23:** server tests with a controlled held push and a controlled clock, for stacked actions and each Git Manager push-family operation, and the profiler hang test.
- **R24 to R35:** component and session tests in the web client, byte-comparison round-trip tests on a Markdown corpus, and a desktop end-to-end test that edits, saves, reopens, switches view and undoes.
- **R36 to R61:** schema tests, theme application tests, pre-paint tests, Appearance panel tests, terminal palette tests, a contrast test over every built-in theme, and a desktop end-to-end test that selects a built-in, creates a custom theme and reloads.
- **Every change:** `vp check`, `vp run typecheck`, `vp run test`; for server changes `cargo fmt --all --check`, Clippy with warnings denied and the affected server tests; the React best-practices review and the UI.md review for changed screens.

- **R66 to R70, R74, R83, R85:** Rust unit tests of the host collector with a fake source and a paused clock; a log-capture test for R74.
- **R84:** a child-process test shaped like the server's `main`.
- **R71, R80:** ignored probe tests run on the macOS development host and in the Linux lab container, their output recorded in the pull request; Windows only through CI build and tests (R79) and, if reachable, the Windows lab of `docs/testing/windows-desktop.md`. Unproven by this plan: the graphical tools (Activity Monitor, Disk Utility, Task Manager), Linux on bare metal and on x64, Windows on x64, and containers with cgroup limits.
- **R72, R73:** server RPC tests over the real registrar, the scope test over a restricted socket, both descriptor tests, the contract fixture decoded and re-encoded by a Rust test, and the capability default test.
- **R75 to R78, R81:** web component and logic tests with a fake stream; one packaged desktop end-to-end test that opens the local host dashboard and sees CPU, memory and at least one volume.
- **R82:** an MCP tool test for the projection.
- **Every change:** `vp check`, `vp run typecheck`, `vp run check:contracts`, `cargo fmt --all --check`, Clippy with warnings denied, the affected tests, and the React best-practices and `UI.md` reviews for the new components.

- **R90 to R105:** contract and settings decode tests, a Rust projection and migration test with replay of events that lack the new fields, web logic and component tests for scope, prompt and reviewer resolution, terminal launch argument tests, native Windows batch argument tests on the Windows CI job, and a packaged desktop end-to-end test that starts a review and finds no Implement action after a reload.

- **R106 to R109:** mounted tests of the real dialog on one mounted instance with real input events, asserting the visible state and the next create command's payload, and one Sidebar test with the real dialog through open, create, close and reopen.

Input classes no scenario names, and their expected behavior:

- A Markdown file larger than the existing preview limit opens in source view as today.
- A Markdown file with Windows line endings keeps them on save.
- A theme name that duplicates another is allowed; IDs are what must be unique.
- A stage with zero jobs shows its header with a count of 0.
- A managed worktree directory with more than 500 entries is audited up to the existing limit of 500.
- A push that needs no network (nothing to push) releases readers the same way as a successful push.
- Local storage that is full or unavailable leaves the built-in themes working and shows an error when a custom theme cannot be saved.

## Open questions

- None since amendment A9 brought the sidebar-hierarchy extension into this spec (R63 to R65).
- Amendments A10 and A11: every decision marked "agent's call" in D22 to D33 and D40 to D49 awaits the user's confirmation before the push, together with which Claude settings a review session loads (D41 keeps all three sources and names the mechanism only).

## Appendix: interview record

- 2026-11-09 Evidence: issues #340, #341, #342, #343, #344, #345 and #290 read in full / Decision: their acceptance criteria are the starting point for the requirements; real names in them are replaced by placeholders.
- 2026-11-09 Evidence: code reading of the Git status path / Decision: every background read already disables optional locks; the unstaged-statistics command is the suspected lock source, to be proven by test.
- 2026-11-09 Evidence: code reading of Git process supervision / Decision: timeouts, cancellation and shutdown force-stop the process group, and nothing removes a lock.
- 2026-11-09 Evidence: code reading of the status owner and stacked action / Decision: reopening reads after local writes is feasible with one new state flag; relying on the version check alone is not.
- 2026-11-09 Evidence: code reading of push failure handling / Decision: the server can tell remote from local and knows a headless server's name; no account name is exposed.
- 2026-11-09 Evidence: code reading of the worktree audit and catalog / Decision: worktree creation leaves no BiBCode marker; removal receipts, pointer files and removal markers exist.
- 2026-11-09 Evidence: web client manifests and Files code / Decision: no rich Markdown editor packages are installed, no Orca checkout is vendored, the text write call cannot carry images, and an upload route exists.
- 2026-11-09 Evidence: desktop content policy / Decision: the pre-paint theme step must stay an external script.
- 2026-11-09 Evidence: standing preference recorded in the maintainer's notes / Decision: designs count as approved after Codex and advisor review; confirmed in round 1.
- 2026-11-09 Evidence: independent read of the draft by a fresh reviewer, twelve points / Decision: all settled without asking, as fact fixes in R3, R4, R5, R14, R15, R30, R34, R36, R42, R53 to R56 and as agent's calls in D20.
- 2026-11-09 Evidence: plan review by Codex, findings 14 and 17 / Decision: R58's scenario and the Verification line for R1 and R2 amended; both listed for the user's approval with the plan.
- 2026-11-09 Q: Is the proposed scope per issue right? / Recommended: yes / Decision: accepted (D2).
- 2026-11-09 Q: Should the #290 sidebar extension move to its own issue? / Recommended: yes / Decision: accepted (D2).
- 2026-11-09 Q: Do reviewed design notes count as approved? / Recommended: yes / Decision: accepted (D3).
- 2026-11-09 Q: Warn only with worktree evidence, and record created worktrees? / Recommended: yes / Decision: accepted (D4).
- 2026-11-09 Q: Resume status reads after local writes for the push family, leaving pull and fetch as they are? / Recommended: yes / Decision: accepted (D5).
- 2026-11-09 Q: Three-part #341 fix with no new UI warning and a Windows CI proof? / Recommended: yes / Decision: accepted (D6).
- 2026-11-09 Q: TipTap for the rendered view? / Recommended: yes / Decision: accepted (D7).
- 2026-11-09 Q: Insert image copies next to the Markdown file with a relative link? / Recommended: yes / Decision: accepted (D8).
- 2026-11-09 Q: Accept #290's own recommended answers, with cosmetic choices left to the agent? / Recommended: yes / Decision: accepted (D9, D17 to D19).
