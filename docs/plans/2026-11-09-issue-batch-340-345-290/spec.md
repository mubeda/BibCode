# Issue batch: pipeline headers, Git reliability, rich Markdown editing and custom themes

Status: Approved 2026-11-09 (approved in chat by the user, with amendments A1 and A2; amendments A3 to A9 approved in chat during execution)
Size: full Mode: gated Type: bug class (#341, #343, #344, #345) and feature (#340, #342, #290)
Source: GitHub issues #340, #341, #342, #343, #344, #345 and #290 of this repository, and the conversation of 2026-11-09. One pull request closes all seven.

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
