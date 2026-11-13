# Evidence: open issues #348 and #350 to #358

Status: Draft
Review: script check passed; a fresh read by a same-vendor subagent, round 1, its findings applied
Source: sources/issue-348.md, issue-350.md to issue-358.md (10 GitHub issues of this repository, exported 2026-11-13 with every comment)

One item is one line of an issue that reports something: a statement by the reporter, a listed follow-up, or a comment. In #348 and #350 the rest of the text (traces, hypotheses, proposed requirements, spike results, review findings) was read in full; it is analysis written by agents, not a report of a problem, and is not counted.

## Sources
- sources/issue-348.md: bug report, 2 items (the two reporter statements)
- sources/issue-350.md: feature issue, 3 items (the problem, what stays affected, 1 comment)
- sources/issue-351.md: bug report, 3 items
- sources/issue-352.md: test report, 2 items
- sources/issue-353.md: follow-up list, 9 items
- sources/issue-354.md: follow-up list, 6 items
- sources/issue-355.md: follow-up list, 6 items
- sources/issue-356.md: follow-up list, 6 items
- sources/issue-357.md: follow-up list, 6 items
- sources/issue-358.md: follow-up list, 6 items (5 lines and 1 comment)
- Skipped: none

## Problems

### 1. A person looking at a terminal sees broken or stale output
- Who has it: people who run AI or full-screen programs in a terminal; 2 of the 8 items name two windows on one terminal
- Count: 8 items
- Items: sources/issue-348.md :: line 5; sources/issue-348.md :: line 14; sources/issue-350.md :: line 5; sources/issue-350.md :: line 7; sources/issue-350.md :: line 114; sources/issue-353.md :: line 7; sources/issue-353.md :: line 12; sources/issue-358.md :: line 7
- Distinct people: 1 reporter account
- Strength: weak, one kind of source and 1 reporter; 2 items carry measured reproductions (5 of 5 runs each); the symptom of #348 itself was never captured
> "intermittent rendering trouble is corrected by a right-panel resize; it occurs with WebGL on and off" @ sources/issue-348.md :: line 14
> "Once a program's last full paint has left that history, the rebuilt screen lacks cells" @ sources/issue-350.md :: line 5
> "the returning window showed 4 stale rows that an attached window did not (5 of 5 runs)" @ sources/issue-350.md :: line 114
- What they asked for:
> "The server keeps an emulated terminal screen per session and a snapshot becomes a checkpoint" @ sources/issue-350.md :: line 11
- Contradicting voices: none found

### 2. A person watching pull-request status can get a late, repeated or stale answer
- Who has it: people who watch pull requests from Source Control
- Count: 5 items
- Items: sources/issue-355.md :: line 5; sources/issue-355.md :: line 6; sources/issue-355.md :: line 7; sources/issue-355.md :: line 8; sources/issue-355.md :: line 9
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter; no item was reproduced by a run, and 1 item is marked not decided
> "Failed lookups are never stored or backed off" @ sources/issue-355.md :: line 6
- What they asked for:
> "Track the task or join it at quiesce, and prove it with an injected fault" @ sources/issue-355.md :: line 5
- Contradicting voices: none found

### 3. A person using the desktop app gets wrong or missing feedback in a panel
- Who has it: people using the Host dashboard, the terminal size notice, popups over a browser preview, the model picker and Files
- Count: 5 items
- Items: sources/issue-353.md :: line 5; sources/issue-353.md :: line 8; sources/issue-358.md :: line 5; sources/issue-358.md :: line 8; sources/issue-358.md :: line 13
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter; 1 item is marked not measured
> "can draw under a native browser preview" @ sources/issue-358.md :: line 5
> "still requests a relative image against the app's own address, so the image does not load" @ sources/issue-358.md :: line 13
- What they asked for:
> "Add a lease that carries a rectangle so the preview hides only when the popup overlaps it" @ sources/issue-358.md :: line 5
- Contradicting voices: none found

### 4. A person reading worktree warnings can get a missing, lost or misplaced creation record
- Who has it: people who create and remove worktrees and read the profiler's worktree audit
- Count: 5 items
- Items: sources/issue-356.md :: line 5; sources/issue-356.md :: line 6; sources/issue-356.md :: line 7; sources/issue-356.md :: line 8; sources/issue-356.md :: line 9
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter, found by reading the code
> "A worktree recreated at that path in the gap loses its record" @ sources/issue-356.md :: line 5
- What they asked for:
> "Delete by the id read when the worktree was resolved" @ sources/issue-356.md :: line 5
- Contradicting voices: none found

### 5. A person with unsaved Files edits during a remote update install can lose the guard or be left with a dialog that never closes
- Who has it: people whose desktop app installs an update asked for from another device
- Count: 5 items
- Items: sources/issue-357.md :: line 5; sources/issue-357.md :: line 6; sources/issue-357.md :: line 7; sources/issue-357.md :: line 8; sources/issue-357.md :: line 9
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter, found by reading the code; 1 item is marked not decided
> "A renderer reload during an allowed install forgets the block" @ sources/issue-357.md :: line 5
> "stays up with no way out" @ sources/issue-357.md :: line 6
- What they asked for:
> "Add one, such as asking the desktop for the install state again" @ sources/issue-357.md :: line 6
- Contradicting voices: none found

### 6. A maintainer cannot trust a red result from a test or lab run
- Who has it: agents and maintainers who validate a change on Windows and Linux
- Count: 3 items
- Items: sources/issue-352.md :: line 3; sources/issue-352.md :: line 5; sources/issue-353.md :: line 6
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter; 1 item carries a measured rate (about one of three whole-suite runs). Line 7 of issue-358.md, counted under problem 1, also names a test that was flaky
> "It is a timing bound under load, not a behaviour change" @ sources/issue-352.md :: line 5
- What they asked for:
> "Make the test wait on the condition with a generous deadline, or control time" @ sources/issue-352.md :: line 5
- Contradicting voices: none found

### 7. A person reading a chat on Windows loses their place when expanding a reasoning row
- Who has it: people using the Windows desktop app
- Count: 3 items
- Items: sources/issue-351.md :: line 3; sources/issue-351.md :: line 5; sources/issue-351.md :: line 7
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter, with one measured run in a Windows 11 arm64 VM
> "the expanded header moved 1014 px against a 2 px limit" @ sources/issue-351.md :: line 3
- What they asked for: nothing specific
- Contradicting voices: none found

### 8. A person whose Git command was stopped by force can be left with a lock file
- Who has it: people who stop a pull or a commit with hooks from BiBCode
- Count: 2 items
- Items: sources/issue-354.md :: line 5; sources/issue-354.md :: line 6
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter, found by reading the code
> "A forced stop while `git pull` is merging leaves its `index.lock` behind" @ sources/issue-354.md :: line 5
- What they asked for: nothing specific
- Contradicting voices: none found

### 9. A person or a server on a different version can meet behavior that was never run or is tied to the wrong capability
- Who has it: people who connect a newer client to an older server
- Count: 2 items
- Items: sources/issue-353.md :: line 10; sources/issue-358.md :: line 6
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter
> "A server that advertises one without the other would break this silently" @ sources/issue-358.md :: line 6
- What they asked for:
> "Add a dedicated capability" @ sources/issue-358.md :: line 6
- Contradicting voices: none found

### 10. A person using the Linux desktop app can meet stalls and growing memory
- Who has it: people using the Linux packaged app
- Count: 2 items
- Items: sources/issue-353.md :: line 9; sources/issue-353.md :: line 11
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter; measured under software rendering only
> "main-thread stalls up to 2.7 s on the settings to thread route change" @ sources/issue-353.md :: line 11
- What they asked for: nothing specific
- Contradicting voices: none found

### 11. A maintainer misses a documented quiesce step or test filter
- Who has it: agents and maintainers who follow the profiler reference and the validation runbook
- Count: 2 items
- Items: sources/issue-354.md :: line 8; sources/issue-354.md :: line 9
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter
> "does not list the `git-writes` step among the `server.stop` quiesce steps" @ sources/issue-354.md :: line 8
- What they asked for: nothing specific
- Contradicting voices: none found

### 12. A person can be shown Git sign-in guidance for text that is not Git's refusal
- Who has it: people whose commit message or hook output contains Git's phrases
- Count: 1 items
- Items: sources/issue-354.md :: line 7
- Distinct people: 1 reporter account
- Strength: weak, 1 reporter, found by reading the code
> "A commit message or a hook's output that contains both phrases triggers the sign-in guidance" @ sources/issue-354.md :: line 7
- What they asked for:
> "Anchor it to Git's own `fatal:` line" @ sources/issue-354.md :: line 7
- Contradicting voices: none found

## Not grouped
- Count: 6 items
- Items: sources/issue-353.md :: line 3; sources/issue-354.md :: line 3; sources/issue-355.md :: line 3; sources/issue-356.md :: line 3; sources/issue-357.md :: line 3; sources/issue-358.md :: line 3
- About: the opening line of each follow-up list, which says where its items came from and whether they were reproduced.

## What this evidence cannot show
- Every item comes from one reporter account. The 8 follow-up issues (#351 to #358) say they were written while validating one pull request. No other user's report is in the sample, so nothing here shows how many people meet any of these problems.
- The 20 follow-up items of #354 to #357 were found by reading the code and were not reproduced by a run. They show that the code permits the problem, not that anyone met it.
- Three counted items are marked by their source as not decided or not measured (issue-355.md line 9, issue-357.md line 9, issue-358.md line 8). They show an open question, not an observed problem.
- The exact visual symptom of #348 is not in the sources: no screenshot or recording was provided.
- Whether the real Claude CLI shows the stale rows of #350's comment is not known; the measurement used a stand-in program.
- Looked for and not found: a report of any of these items from a second person, in the issues' comments and in the duplicate searches recorded in triage.md.
