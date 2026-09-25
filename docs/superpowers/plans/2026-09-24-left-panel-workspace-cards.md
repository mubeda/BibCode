# Left Panel Workspace Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the left panel's one-line primary and thread rows with workspace cards (status glyph, branch/PR line, session line, "N more chats"), give every sidebar menu grouped separators, Title Case copy and keyboard access, and finish the sidebar's `UI.md` typography sweep.

**Architecture:** Three steps that each ship on their own. Step 1 adds a `ContextMenuEntry` (item or separator) contract, renders separators in the native Tauri builder and in the web fallback (which also gains full keyboard support), moves every sidebar menu into pure builders, and replaces the invisible project-header placeholder with a visible ⋯. Step 2 adds `resolveWorkspaceCardStatus` and card data helpers to `Sidebar.logic.ts`, an app-level minute clock and a `WorkspaceCard` presentational module; `SidebarThreadRow` and the primary row become cards inside one memoised list. Step 3 removes dead chrome and sweeps the remaining typography. Everything is client-side: no RPC, wire schema or persistence changes.

**Tech Stack:** React 19 + Vite+ (Vitest 4, happy-dom), Tailwind v4, Base UI, lucide-react 1.40, Effect Schema (`packages/contracts`), Rust/Tauri 2 (`apps/desktop/src-tauri`), WebdriverIO packaged e2e, Playwright 1.60 for live checks.

**Spec:** `docs/superpowers/specs/2026-09-24-left-panel-workspace-cards-design.md` (approved 2026-09-24 with the recommended option on every ruling). The approved mockup is the visual source of truth: `$S/leftpanel-canvas/project/Main.dc.html` (light; its `dark` prop gives dark), `Anatomy.dc.html`, `States.dc.html`, `Menus.dc.html` and `Today.dc.html`. Executors read the spec and this plan together.

`$S` means `/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad` throughout. The repository is `/work/workspaces/orca/BibCode/main-3` (branch `main-3`). Paths without a leading `/` are repository-relative.

## Global Constraints

Every task's requirements include this section.

**From the spec (with the controller refinements recorded below):**

- The mockup's sizes, colours, glyphs and copy are binding unless `UI.md` or an existing token says otherwise; the only allowed deviations are the six listed in the spec's "Deviations from the mockup".
- Card surface: `flex gap-2 px-2 py-1.5 rounded-md border border-transparent`; 2 px between cards, 6 px between projects; `--radius` is 10 px, so 8 px is `rounded-md`.
- Status column: a 16×20 slot (`w-4 h-5`), centred; 14 px glyph icons; 10 px dots.
- Line 1 (20 px): title `text-[13px] text-foreground/80`; when unread, `font-semibold text-foreground`; chip `text-xs`, bordered, `bg-muted`; hover or focus shows Archive/Confirm, never while running, never on the primary card; the ⌘ jump label replaces them while the modifier key is held.
- Line 2 (18 px): 12 px muted; shown when there is visible branch text or any indicator (controller L10); the branch text is hidden when it equals the title; the indicators stay at the right end; the PR number is a button (`openPrLink`) coloured by `prStatusIndicator`; the terminal icon is muted and static; the ports `Globe2Icon` button stays.
- Line 3 (22 px): 12 px muted; `ProviderInstanceIcon` without a badge; preview `truncate flex-1`; model `font-mono max-w-28 truncate`; age via `<RelativeAge>`.
- More chats (20 px): static text without the chevron, plus the highest-priority glyph among those chats.
- States: hover `bg-accent/60`; active `bg-accent border-border`, without today's `font-medium`; multi-select keeps today's primary tint; focus `ring-2 ring-ring` on the card (`--ring` is `#d8610e`).
- Cards are about 52 px tall with two lines and 80 px with three.
- Status table, first match wins: Hand "Needs approval" (`hasPendingApprovals`, amber pill colour) → CircleHelp "Waiting for your answer" (`hasPendingUserInput`, indigo) → LoaderCircle spinning "Working" / "Connecting" (`session.status` running / starting, sky) → TriangleAlert "Failed" (`session.status === "error"`, or `unresolvedDelivery.state === "failed"`, or an unseen completion with `latestTurn.state === "error"`; `text-destructive`) → ListChecks "Plan ready" (the plan-ready pill, violet) → filled dot "Finished, not opened yet" (an unseen completion whose turn did not error, emerald) → hollow ring "Idle" (anything else, `text-muted-foreground`).
- Don't widen the `ThreadStatusPill` union: the Agents view groups on its labels.
- An `interrupted` turn maps to "Finished, not opened yet" until opened and then "Idle"; an `uncertain` delivery leaves the glyph unchanged and line 3 reports it; under `prefers-reduced-motion` the spinner is static; never-visited threads keep today's rule (no visit marker, no unseen completion).
- The collapsed-project indicator and the Show-more hint use the same glyphs and priority.
- Density stays: 6 visible threads, collapsible projects, no auto-collapse. No Orca-only extras (no status columns, groups, parent worktrees, sleep or project icons).
- Keep the environment rail and context card, the project tree and its guide line, the hover strip minus its invisible placeholder, native desktop menus, discovery, pinned-first ordering, ⌘ jump hints, inline rename and the archive confirm.
- Menus: labels are Title Case; an ellipsis marks an item that opens a dialog or an inline edit; "Update" becomes "Pull" and keeps `vcs.pull`, with the error toast "Failed to pull"; add "Copy Branch Name" (copies the branch shown on the card, omitted when there is none); multi-select shows "Mark as Unread (N)" and "Delete (N)"; a thread without a worktree shows "Delete Thread", with the ellipsis only when `confirmThreadDelete` is on; grouped projects keep their per-member submenus.
- Contract: `ContextMenuSeparator = { separator: true }` and `ContextMenuEntry<T> = ContextMenuItem<T> | ContextMenuSeparator`; `children` and every `show` signature take entries. Rejected: a `separator` flag on items, and `separatorBefore`.
- Renderers: each first applies its own filtering (native drops headers and empty submenus), then both trim leading and trailing separators, collapse runs, and skip the automatic destructive separator after an explicit one. The fallback renders `role="separator"` with `my-1 mx-1.5 h-px bg-border`.
- Accessibility: each card is an `li` holding one `<button type="button">`; its accessible name is the status, the title, and visually hidden "unread"/"pinned" text; lines 2–3 describe it; it carries `aria-current` when active; the PR, ports and Archive buttons and the rename input are layered siblings, never nested in it. Glyphs are `role="img"` with the table's name and a tooltip with the same text. The card opens its menu on Shift+F10 and the ContextMenu key with `preventDefault()`, anchored to the card's rectangle, and ignores a `contextmenu` the webview dispatches for those keys. Right-click and Ctrl-click keep the pointer position. ⋯ opens on Enter or Space. The fallback menu has `menu`, `menuitem` and `separator` roles, `aria-haspopup`, `aria-expanded` and `aria-disabled`; focus starts on the first enabled item; arrow keys skip separators and disabled items; Home, End, Enter and Space work; ArrowRight and ArrowLeft open and close submenus; Escape closes the menu and returns focus.
- Data and performance: no new requests; memoise cards on the shell reference and UI flags; only the `<RelativeAge>` leaf subscribes to the clock, so a tick re-renders no card; one app-level minute clock (an external store with one minute-aligned timer, running only while subscribed, also ticking on `visibilitychange`); don't reuse `useRelativeTimeTick`; per-card work is O(1); chat counts are O(threads) once per project.
- Width: batch 1 owns the 422 px first-launch width and its fit to narrow windows (`AppSidebarLayout.tsx`); this plan assumes them.
- Batch 1 just changed `EnvironmentContextCard.tsx`, `ServerUpdateBadge.tsx` and `SidebarEnvironmentContextCard` in `Sidebar.tsx`; this plan never edits them and plans around their current state.

**Repository requirements (AGENTS.md):**

- Focused tests for every changed behaviour, written first and watched failing where a seam exists.
- Broader checks when a change crosses package or runtime boundaries (contracts → web → desktop).
- `vp check` and `vp run typecheck` pass.
- Rust: `cargo fmt --all --check`, `cargo test -p bibcode-desktop context_menu`, and `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`.
- Every `apps/web` React change is reviewed against the `vercel-react-best-practices` skill and against `UI.md`; report both, or mark them "not run".
- Living docs and the affected `docs/testing/` runbooks change in the same step as the behaviour; otherwise the report says they were "reviewed and remain accurate".
- `packages/contracts` stays schema-only: types and schemas, no runtime helpers.
- `vp run check:contracts` runs because `ipc.ts` changes; menus are not RPC, so no fixture diff is expected (see Task 1 for track A's fixtures).
- **Playwright live verification for every UI change**, against an isolated dev server started with `BIBCODE_PORT_OFFSET=<unused n>` and its own `BIBCODE_HOME`, paired through the server's startup token (`bibcode pairing offer` can't target a dev data root).
- Known host flakes, not this plan's bugs: `provider_terminal_supervisor` tests fail about once per full run even at base; a `managed_endpoint` lib test can hang under heavy load; pipe-heavy fixture tests fail when `pipe-user-pages-soft` is exhausted. Classify any unrelated failure with a focused re-run, or a base-vs-change comparison when cheap; don't chase it.

**Shared-worktree rules:**

- Other agents edit this worktree concurrently. Edit only the files a task lists. Never revert, reformat or "fix" another agent's change. Never run `git commit`, `git stash`, `git reset`, `git restore`, `git checkout -- …` or `git clean`.
- Re-read every file immediately before editing it; the anchors in this plan are text anchors, and line numbers are hints taken on 2026-09-24.
- Shared docs get targeted `Edit`s to the named paragraph only, never a whole-file rewrite.
- Never kill a process you did not start, never run `pkill -f bibcode-desktop`, never touch the user's desktop app (`bibcode-desktop` pid 392675 on `0.0.0.0:3773`), never call the controller's dev server (`:13773`/`:5733`, `BIBCODE_HOME=$S/bibcode-home-gm`), and never stop the Git servers on `127.0.0.1:18431`/`18432`.
- Never write to real remotes. Never print secrets; write `<REDACTED>`.

## Execution protocol

**Codex availability.** Codex is available and implements these tasks. The controller runs host live checks; Finish includes a Codex review of the recorded plan diff.

**Ledger.** Keep `$S/<executor-id>/ledger.md`: one entry per task with the checkpoint tree hash, the commands run and their results, and any classified unrelated failure.

**Checkpoint (no commit).** The user's rule is "commit only when the user asks", after the Codex review. Each task ends with:

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

It prints a tree hash; record it in the ledger. The temporary index leaves the real index untouched. The tree includes other agents' uncommitted work, so a task's review package is scoped to its files: `git diff <previous-tree> <tree> -- <the task's files>`. Run the checkpoint once before Task 1 and record that hash as the **baseline tree**; the Finish section diffs against it.

**Concurrent track A (connection liveness).** Track A runs in this worktree at the same time and owns `apps/server` rpc/session/e2ee, `packages/client-runtime` rpc/connection, and the contracts RPC fixtures. This plan's code files are disjoint from track A's. The unavoidable overlaps:

- Docs both tracks edit, in different paragraphs: `docs/architecture/overview.md` (this plan line ~160, track A lines ~471–475), `docs/testing/cross-platform-validation.md` (this plan the packaged visual list, track A a new scenario near line ~1093), and the Linux, macOS and Windows runbooks (this plan the "Packaged UI scenarios" bullets, track A a link line). Use targeted `Edit`s and re-read first.
- Workspace-wide gates: `vp check`, `vp run typecheck`, `vp run check:contracts` and every `cargo` command over `bibcode-desktop` (it compiles `bibcode-server`). A failure in a track A file is recorded with its output and not touched. Cargo may print `Blocking waiting for file lock on build directory` while track A builds; wait for it.
- Batch 1 (process-group guard, sidebar width, update badge) also left uncommitted edits, including `apps/desktop/src-tauri/src/remote_update_delegate.rs`; a clippy or test failure there is batch 1's.

**Coordination.** Task 10 depends on the concurrent pull-request fix round's shared number/prefix helper in `packages/shared/src/sourceControl.ts`. The current export is `formatChangeRequestNumber(provider: SourceControlProviderKind | null | undefined, number: number): string` (`!` for GitLab, `#` otherwise). Re-read that module and its tests first, reuse the exported helper under its actual name and signature, and add it in that same module under the same name only if no number/prefix helper exists. Do not introduce a second formatter, a `ChangeRequestPresentation.numberPrefix` policy, or a compatibility alias. Preserve the PR round's shared tests and callers (controller M6).

**Formatting.** Before each checkpoint, format exactly the files the task changed, from the repository root: `vp fmt <file> …` for TypeScript, TSX and Markdown outside `docs/superpowers/`, and `rustfmt --edition 2024 apps/desktop/src-tauri/src/context_menu.rs` for Rust. Never run `vp fmt` without paths or `cargo fmt` without `--check`: both would reformat other agents' uncommitted files. The code blocks in this plan are close to the formatter's output, but the formatter is the authority.

**Test commands.** Web tests run from `apps/web`: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run <paths>`. Contracts, shared and desktop-e2e support tests run from the repository root: `cd /work/workspaces/orca/BibCode/main-3 && vp test run <paths>`. Package typechecks: `vp run --filter @bibcode/web typecheck` and `vp run --filter @bibcode/contracts typecheck`.

## File structure

| File | Step | Responsibility |
| --- | --- | --- |
| `packages/contracts/src/ipc.ts` | 1 | `ContextMenuSeparator`, `ContextMenuEntry`, their schemas; `show` signatures take entries |
| `packages/contracts/src/ipc.test.ts` | 1 | Separator decode, encode and rejection |
| `apps/desktop/src-tauri/src/context_menu.rs` | 1 | Native separator entries, normalisation, no doubled destructive separator |
| `apps/web/src/contextMenuFallback.ts` | 1 | Separator rendering, `normalizeContextMenuEntries`, menu roles and keyboard support |
| `apps/web/src/contextMenuFallback.test.ts` | 1 | Fake-DOM separator tests (existing harness) |
| `apps/web/src/contextMenuFallback.keyboard.test.ts` (new), `apps/web/src/contextMenuKeyboard.ts` (new) | 1 | happy-dom keyboard/focus tests and shared keyboard-open echo timing |
| `apps/web/src/tauriDesktopBridge.ts`, `apps/web/src/localApi.ts` | 1 | Type-only move to `ContextMenuEntry` |
| `apps/web/src/components/sidebar/sidebarMenus.logic.ts` (new) | 1 | Pure builders for the card, primary, multi-select and project-header menus |
| `apps/web/src/components/sidebar/sidebarMenus.logic.test.ts` (new) | 1 | Builder ids, labels, separators, omissions, grouped submenus |
| `apps/web/src/components/WorktreeDiscoverySection.logic.ts` (+ test) | 1 | Title Case visibility label with the hidden count |
| `apps/web/src/components/WorktreeDiscoverySection.tsx` (+ test) | 1, 3 | Report the hidden count upward; 12 px typography (step 3) |
| `apps/web/src/components/Sidebar.logic.ts` (+ test) | 1, 2 | Branch label (1); status resolver, card classes, age, chats, keyboard-menu helpers (2) |
| `apps/web/src/components/Sidebar.tsx` | 1, 2, 3 | Menus via builders, ⋯ button (1); cards and merged list (2); removals and typography (3) |
| `apps/web/src/components/Sidebar.test.tsx` | 1, 2, 3 | Updated selectors and new behaviour tests |
| `apps/desktop/e2e/support/motion-guard.ts`, `ui-state.test.ts` | 1, 2 | Motion-guard anchor on a stable projects-group test id (1); no spec finds a card through an `a` (2) |
| `packages/shared/src/sourceControl.ts` (+ test), `apps/web/src/sourceControlPresentation.ts` | 2 | Reuse the shared `formatChangeRequestNumber` and re-export it for web indicators; add it only if absent |
| `apps/web/src/components/ThreadStatusIndicators.tsx` (+ test) | 2 | `numberLabel`, prefixed tooltip, muted static terminal, 12 px label, dead helpers removed |
| `apps/web/src/components/sidebar/agentsSection.logic.ts` (+ test) | 2 | `resolveConversationPreviewLine` shared with the cards |
| `apps/web/src/components/sidebar/workspaceCard.logic.ts` (new, + test) | 2 | Preview, provider, model labels and branch tooltip for cards |
| `apps/web/src/components/sidebar/workspaceCardLookups.ts`, `useWorkspaceCardLookups.ts`, `useWorkspaceCardLookups.test.tsx` (new) | 2 | List-wide keys/flags, adopted-workspace, terminal and port Maps, shared observations, once-per-list regression |
| `apps/web/src/minuteClock.ts` (new, + test) | 2 | App-level minute clock store and `useMinuteClock` |
| `apps/web/src/components/sidebar/RelativeAge.tsx` (new) | 2 | The clock-subscribed age leaf |
| `apps/web/src/components/sidebar/WorkspaceCard.tsx` (new, + test) | 2 | Presentational card: shell, glyph, lines, indicators |
| `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts`, `pierre-diffs.e2e.ts`, `composer-message-queue.e2e.ts`, `project-session-terminal.e2e.ts`, `terminal-font.e2e.ts` | 2 | Primary-card XPaths no longer require an `a` (ruling 23) |
| `apps/web/src/components/sidebar/AgentsNavRow.tsx` (+ test) | 3 | Badge hidden at 0 |
| `apps/web/src/components/sidebar/EnvironmentRail.tsx`, `apps/web/src/components/sidebar/SidebarProjectAvailability.tsx` (+ test), `apps/web/src/components/WorktreeAvailabilityWarning.tsx` | 3 | Typography sweep |
| `apps/web/src/components/sidebar/sidebarTypography.test.ts` (new) | 3 | Source guard: no text below 12 px or letter-spacing in left-panel files |
| `docs/user/workspace-ui.md`, `docs/user/keybindings.md`, `docs/getting-started/quick-start.md`, `docs/architecture/overview.md`, `docs/architecture/worktree-catalog.md`, `docs/reference/workspace-layout.md`, `docs/reference/encyclopedia.md`, `docs/testing/cross-platform-validation.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`, `docs/superpowers/specs/2026-08-02-project-toolbar-actions-design.md` | 1–3 | Living docs, runbooks, superseded note (`UI.md:176` is reviewed, not edited) |

`Sidebar.tsx` stays one file: splitting ~1,000 lines out while batch 1's `SidebarEnvironmentContextCard` edits sit in it would add churn and conflict risk. The new logic and presentational modules take the growth instead.

## Rulings on spec ambiguities

These were decided while planning; the report repeats them.

1. **Keyboard menu anchor.** Keyboard-opened card menus and the ⋯ menu open at the element's bottom-left, `{ x: Math.round(rect.left), y: Math.round(rect.bottom) }`.
2. **Echo window.** A `contextmenu` event within 1,000 ms of a keyboard-opened menu is ignored (`KEYBOARD_CONTEXT_MENU_ECHO_MS`).
3. **Automatic destructive separator.** Only the native renderer has one (as today); both renderers trim and collapse. The builders put an explicit separator before every destructive item, so both renderers show the same groups.
4. **Escape and ArrowLeft.** Escape (and Tab) closes the whole fallback menu and returns focus to the element focused before it opened; ArrowLeft closes one submenu level. Choosing an item also returns focus first, so a follow-up (inline rename, dialog) can take it.
5. **Menu ids.** `update` becomes `pull`; `copy-branch-name` is new; project-header actions keep `action:<physicalProjectKey>` ids and gain `new-worktree`. `parseProjectHeaderSelection` splits at the first colon, because physical keys contain colons.
6. **Multi-select** gets an explicit separator before "Delete (N)".
7. **"(N)".** "Show Hidden Worktrees (N)" shows N only when every supported member of the expanded project has reported a count, including 0; any unknown member gives no parentheses (controller L17).
8. **Cloud icon on cards.** The card never had one in the anatomy, so step 2 builds cards without it; step 3 removes only the project-header cloud icon.
9. **Collapsed-project glyph** summarises the primary card too, because a collapsed project hides it; Show more summarises only the hidden workspace cards.
10. **"N more chats"** always shows a glyph (the idle ring when every chat is idle) and reads "1 more chat" in the singular.
11. **Age while working** uses `latestTurn.startedAt` when present, else `latestUserMessageAt ?? updatedAt ?? createdAt`.
12. **Line 3** renders when the thread has a session, an unresolved delivery or a conversation preview.
13. **Branch line.** When the branch equals the title, the branch icon and text are both hidden and a spacer keeps the indicators right-aligned. The branch tooltip is `Worktree: <last path segment> (<branch>)` on worktree cards and `Checkout: <last path segment> (<branch>)` on the primary card.
14. **Indicator helpers.** `terminalStatusFromRunningIds` becomes muted and static everywhere (it also feeds the command palette). `ThreadStatusLabel`'s label moves to `text-xs` because the file is touched (`UI.md:176`). `ThreadWorktreeIndicator` and `ThreadStatusLabel`'s `compact` variant are deleted once the sidebar stops using them.
15. **Sweep scope.** The step-3 sweep also fixes sidebar violations the research list missed but the spec's own live assertion ("no sidebar text below 12 px or with letter-spacing") would fail: the brand's `tracking-tight`, the stage badge's `tracking-[0.12em]`, `SidebarProjectAvailability`'s `/60` muted text and `WorktreeAvailabilityWarning`'s `text-[11px]`. The stage badge keeps `uppercase`; `UI.md` bans spacing, not case.
16. **Re-authored controls.** The rename input gets `sm:text-[13px]` and the jump label drops `tracking-tight` when step 2 re-authors them; step 3 lists them as done.
17. **Test ids.** Workspace cards keep the `li` test id `thread-row-<id>` (used by `chat-activity-panel.e2e.ts:145`) and add `thread-card-button-<id>` on the button. The primary card uses `primary-card-<project.id>` and `primary-card-button-<project.id>`. `data-thread-item` moves to the card `li` for both kinds.
18. **Mockup rendering.** The `.dc.html` files load a `support.js` runtime that isn't available locally. Holes are dotted lookups only (per the format reference), so Task 19 renders them with a small local expander and compares crops against live screenshots.
19. **Shift+F10** lands with the cards (step 2) because it is card behaviour; step 1 covers the ⋯ button and the fallback keys. The runbooks' Shift+F10 lines are added in step 2.
20. **Doc placement.** `workspace-layout.md`'s row terms change in step 2 with the cards; the encyclopedia and `UI.md:176` change in step 3, as the rollout says.
21. **Azure DevOps prefix.** The spec says "`!` for GitLab, `#` otherwise", so Azure DevOps uses `#` even though its own UI writes `!`. Raised in the report, not changed.
22. **`vp run check:contracts` timing.** The script regenerates `packages/contracts/fixtures` from the current sources, and other agents have uncommitted RPC contract edits (`packages/contracts/src/rpc.ts`, `pullRequests.ts`). Running it mid-flight would rewrite their fixtures. Task 1 proves menus are not RPC (`rg -n "ContextMenu" packages/contracts/src/rpc.ts packages/contracts/scripts packages/contracts/fixtures` prints nothing); the Finish section runs `check:contracts` only when `git status --short packages/contracts` shows no other agent's changes, and otherwise records it as deferred to the controller.
23. **Five packaged specs, not two.** The spec lists `composer-native-triggers.e2e.ts:334` and `pierre-diffs.e2e.ts:246` as the specs that find the primary row through an `a`. Since then `composer-message-queue.e2e.ts:85`, `project-session-terminal.e2e.ts:56` and `terminal-font.e2e.ts:136` have gained the same XPath. Task 17 updates all five, and its contract test scans every spec file so a sixth can't slip in.
24. **Live fixture states.** Task 19 gets approval, question, plan, failed and working states by patching the thread-shell and VCS frames on the page's own socket (`page.routeWebSocket`), because the e2e provider shims can't produce them. The patched "develop" card has no latest turn, so it reads idle whether or not a browser profile has visited it. The plan card ("Queue migration plan") isn't on `Main.dc.html`, so it is compared with the "Plan ready to review" card in `States.dc.html`.

## Controller rulings (2026-09-24)

Each line records the binding ruling — why — cost if wrong.

- **L1.** The fallback renderer suppresses contextmenu and accompanying pointer echoes for 1,000 ms after keyboard open; cards retain native guards and test the real fallback — document capture runs first — menus vanish or open twice.
- **L2.** Build keys, adopted-workspace, terminal and port Maps once per list render, pass stable references, compare references/primitives only — per-card lookup work must be O(1) — large lists regress to quadratic work.
- **L3.** Observe VCS even with a null recorded branch; resolve refName → detachedHead → thread.branch — detached worktrees are valid — branch and dirty indicators disappear.
- **L4.** Copy exactly the displayed branch: retained indicator value in Step 1, helper B (`resolveWorkspaceBranchLabel`) for display and copy in Step 2 — displayed and copied values must agree — users copy another branch.
- **L5.** Use the resolver's running predicate for Archive, including null activeTurnId — running work must remain available — an active workspace can be archived.
- **L6.** Check subscriber count after visibility notification before scheduling — listeners can unsubscribe reentrantly — the minute clock leaks a timer.
- **L7.** Required crops, including terminal, fail if unreproducible; verify each fixture shell; controller runs live checks on the host — Codex sandbox blocks loopback — false passing visual evidence.
- **L8.** Set sidebar-specific provider-icon initials to at least 12 px and inspect imported icons — the shared icon defaults to 10 px — typography violates the spec or changes other surfaces.
- **L9.** Both project lists use a 6 px gap, with class and computed-style assertions — the mockup specifies 6 px — project spacing stays at 4 px.
- **L10.** Omit line 2 when branch text equals the title and no indicators exist — follow the mockup over spec S66's ambiguous wording — empty lines distort card density.
- **L11.** Narrow with `"stale" in status` before reading stale — passive status includes full results — Task 16 fails typechecking.
- **L12.** Record the actual child PID/PGID inside setsid and stop only recorded owned identities — backgrounding a compound shell records the wrong PID — teardown misses children or stops unrelated work.
- **L13.** Delete exactly four ThreadWorktreeIndicator expectations and retain status-label assertions — verified against the current test — status coverage is accidentally removed.
- **L14.** Mark remote-cloud and WSL card evidence as unit-only in Finish — live fixtures are local — coverage is overstated.
- **L15.** Scroll keyboard-focused items into view after focus({ preventScroll: true }) — long menus overflow — keyboard focus becomes invisible.
- **L16.** Give PR/ports controls 24×24 px hit areas without enlarging glyphs; explain disabled Open in/Pull with description/tooltip and aria-description — UI.md requires usable targets and understandable disabled states — users cannot activate or understand actions.
- **L17.** Assert New Worktree opens for the selected project and test grouped known/unknown counts — closure alone proves no action and partial sums mislead — wrong-project creation or incomplete totals.
- **L18.** Share the visit-map/status resolver between both summary memos — they implement the same policy — status precedence drifts.
- **L19.** Never lead a menu/submenu with a separator or repeat separators; test leading destructive groups — removal submenus begin with destructive items — spurious separators appear.
- **L20.** Finish diffs recorded baseline/final trees scoped to this plan's files — shared files contain earlier edits — unrelated changes contaminate review.
- **L21.** Codex is available to implement tasks and perform the Finish review; retain ruling 22's check:contracts condition — availability has changed while shared fixtures still need protection — review is skipped or another agent's fixtures are overwritten.
- **M1.** Task 15 imports `isWorkspaceThreadRunning` in `Sidebar.tsx`; Task 12 does not add the unused test import — Archive uses the shared running predicate — card rendering and typechecking fail otherwise.
- **M2.** Both Task 14 PR indicator fixtures include `label` — `PrStatusIndicator` requires it alongside `numberLabel` — the new component tests fail typechecking.
- **M3.** Tasks 19 and 22 use `page.$$eval` for callbacks that filter/map matched elements; audit the other live-script evaluators — `page.$eval` passes one element — verification crashes before writing results.
- **M4.** Task 15 updates the grouped mixed-capability discovery expectation to two identical supported-member catalog accesses and retains the unsupported-environment assertion — the list lookup and discovery section each access the catalog — the existing test fails or loses capability-boundary coverage.
- **M5.** Task 19 has no terminal waiver: an unreproduced required terminal crop fails the run — L7 applies to every required crop — missing live evidence is reported as a pass.
- **M6.** Task 10 first inspects and reuses the PR round's shared number/prefix helper, currently `formatChangeRequestNumber(providerKind, number)`; only if none exists does it add that same export in `packages/shared/src/sourceControl.ts` — prefix policy has one owner (`!` for GitLab, `#` otherwise) — duplicate implementations or incompatible signatures break concurrent callers.

---

# Step 1 — Menus

Step 1 ships on its own: menus gain separators, the new copy and grouping, keyboard access in the web fallback, and the project header gains a visible ⋯. Today's one-line rows stay until step 2.

## Task 1: Menu contract entries and separators

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (the `ContextMenuItem` block at lines ~115–149; `DesktopBridge.showContextMenu` at ~1269; `LocalApi.contextMenu.show` at ~1382)
- Test: `packages/contracts/src/ipc.test.ts` (imports at lines 1–26; `describe("ContextMenuItemSchema")` at ~351)
- Modify (types only): `apps/web/src/tauriDesktopBridge.ts`, `apps/web/src/localApi.ts`, `apps/web/src/contextMenuFallback.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `@bibcode/contracts`): `interface ContextMenuSeparator { readonly separator: true }`; `type ContextMenuEntry<T extends string = string> = ContextMenuItem<T> | ContextMenuSeparator`; `ContextMenuItem.children?: readonly ContextMenuEntry<T>[]`; `ContextMenuSeparatorSchema`, `ContextMenuEntrySchema` (`Schema.Codec<ContextMenuEntrySchemaType>`); `DesktopBridge.showContextMenu<T>(items: readonly ContextMenuEntry<T>[], position?)` and `LocalApi.contextMenu.show<T>(items: readonly ContextMenuEntry<T>[], position?)`, both still resolving `T | null`. A consumer tells the two apart with `"separator" in entry`; contracts ship no runtime guard (schema-only rule).

- [ ] **Step 1: Write the failing contract tests**

In `packages/contracts/src/ipc.test.ts`, replace the import block at the top of the file:

```ts
import {
  ContextMenuItemSchema,
  type DesktopBridge,
```

with:

```ts
import {
  type ContextMenuEntry,
  ContextMenuEntrySchema,
  ContextMenuItemSchema,
  ContextMenuSeparatorSchema,
  type DesktopBridge,
```

Below `const encodeContextMenuItem = Schema.encodeSync(ContextMenuItemSchema);` add:

```ts
const decodeContextMenuEntry = Schema.decodeUnknownSync(ContextMenuEntrySchema);
const encodeContextMenuEntry = Schema.encodeSync(ContextMenuEntrySchema);
```

Append this block at the end of the file:

```ts
describe("ContextMenuEntrySchema", () => {
  it("decodes and encodes a bare separator", () => {
    expect(decodeContextMenuEntry({ separator: true })).toEqual({ separator: true });
    expect(encodeContextMenuEntry({ separator: true })).toEqual({ separator: true });
    expect(Schema.decodeUnknownSync(ContextMenuSeparatorSchema)({ separator: true })).toEqual({
      separator: true,
    });
  });

  it("round-trips separators between submenu children", () => {
    const input = {
      id: "open-in",
      label: "Open in",
      children: [
        { id: "open-in:file-explorer", label: "File Explorer" },
        { separator: true },
        { id: "open-in:vscode", label: "VS Code" },
      ],
    };
    expect(encodeContextMenuEntry(decodeContextMenuEntry(input))).toEqual(input);
  });

  it("round-trips a disabled action's explanation", () => {
    const input = { id: "pull", label: "Pull", disabled: true, description: "Workspace is unavailable." };
    expect(encodeContextMenuEntry(decodeContextMenuEntry(input))).toEqual(input);
  });

  it("types a mixed list of items and separators", () => {
    const entries: readonly ContextMenuEntry<"pull" | "copy-path">[] = [
      { id: "pull", label: "Pull" },
      { separator: true },
      { id: "copy-path", label: "Copy Path" },
    ];
    expect(entries.filter((entry) => "separator" in entry)).toHaveLength(1);
  });

  it("rejects a separator flag that is not literally true", () => {
    const expected = {
      rootTag: "AnyOf" as const,
      paths: [["id"]],
      containsTag: "MissingKey" as const,
    };
    expectDecodeFailure(ContextMenuEntrySchema, { separator: false }, expected);
    expectEncodeFailure(ContextMenuEntrySchema, { separator: false }, expected);
  });

  it("rejects an invalid separator nested in children", () => {
    expectDecodeFailure(
      ContextMenuEntrySchema,
      { id: "git", label: "Git", children: [{ separator: "yes" }] },
      { rootTag: "AnyOf", paths: [["children", 0, "id"]], containsTag: "MissingKey" },
    );
  });
});
```

The failure shapes above were measured with this repository's `effect` version: a union that fails reports the first member's issue (`id` missing) under an `AnyOf` root. The existing "reports invalid recursive children" test keeps passing unchanged: its `children[0].id` is a number, reported under a `Composite` root with an `InvalidType` leaf.

- [ ] **Step 2: Run the contract tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run packages/contracts/src/ipc.test.ts`
Expected: FAIL. `ContextMenuEntrySchema` and `ContextMenuSeparatorSchema` are not exported yet, so the suite errors while loading.

- [ ] **Step 3: Implement the contract**

In `packages/contracts/src/ipc.ts`, replace everything from `export interface ContextMenuItem<T extends string = string> {` through the end of the `ContextMenuItemSchema` declaration (the line `});` after its `children:` field) with:

```ts
/**
 * A divider between groups of a context menu. Renderers drop leading, trailing
 * and repeated separators, so callers can build groups without tracking which
 * neighbouring items were omitted.
 */
export interface ContextMenuSeparator {
  readonly separator: true;
}

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Explains an unavailable action; exposed by renderers to sighted and assistive users. */
  description?: string;
  /** Renders as a non-interactive section header label. Web fallback only — stripped on desktop native menus. */
  header?: boolean;
  /** Icon keyword resolved by the web fallback. Stripped on desktop native menus. */
  icon?: string;
  children?: readonly ContextMenuEntry<T>[];
}

/** One row of a context menu: an actionable item or a separator. */
export type ContextMenuEntry<T extends string = string> = ContextMenuItem<T> | ContextMenuSeparator;

export interface ContextMenuSeparatorSchemaType {
  readonly separator: true;
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly description?: string;
  readonly header?: boolean;
  readonly icon?: string;
  readonly children?: readonly ContextMenuEntrySchemaType[];
}

export type ContextMenuEntrySchemaType = ContextMenuItemSchemaType | ContextMenuSeparatorSchemaType;

export const ContextMenuSeparatorSchema: Schema.Codec<ContextMenuSeparatorSchemaType> =
  Schema.Struct({
    separator: Schema.Literal(true),
  });

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  header: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(Schema.String),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuEntrySchemaType> => ContextMenuEntrySchema),
    ),
  ),
});

export const ContextMenuEntrySchema: Schema.Codec<ContextMenuEntrySchemaType> = Schema.Union([
  ContextMenuItemSchema,
  ContextMenuSeparatorSchema,
]);
```

`ContextMenuEntrySchema` is referenced inside `Schema.suspend` before its declaration; the thunk runs at decode time, after module initialisation, exactly as the existing self-reference did.

In the `DesktopBridge` interface replace:

```ts
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
```

with:

```ts
  showContextMenu: <T extends string>(
    items: readonly ContextMenuEntry<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
```

In the `LocalApi` interface replace:

```ts
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
```

with:

```ts
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuEntry<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
```

- [ ] **Step 4: Move the web callers to entries (types only)**

`apps/web/src/tauriDesktopBridge.ts`: in the `import type { … } from "@bibcode/contracts";` list replace `ContextMenuItem,` with `ContextMenuEntry,`. In `async function showTauriContextMenu<T extends string>(` replace `items: readonly ContextMenuItem<T>[],` with `items: readonly ContextMenuEntry<T>[],`. In the bridge object's `showContextMenu: <T extends string>(` replace `items: readonly ContextMenuItem<T>[],` with `items: readonly ContextMenuEntry<T>[],`.

`apps/web/src/localApi.ts`: replace `import type { ContextMenuItem, LocalApi } from "@bibcode/contracts";` with `import type { ContextMenuEntry, LocalApi } from "@bibcode/contracts";`, and in `contextMenu.show` replace `items: readonly ContextMenuItem<T>[],` with `items: readonly ContextMenuEntry<T>[],`.

`apps/web/src/contextMenuFallback.ts` (Task 3 renders separators; this step only keeps it compiling):

- replace `import type { ContextMenuItem } from "@bibcode/contracts";` with `import type { ContextMenuEntry } from "@bibcode/contracts";`;
- in `export function showContextMenuFallback<T extends string>(` replace `items: readonly ContextMenuItem<T>[],` with `items: readonly ContextMenuEntry<T>[],`;
- in `const openMenu = (` replace `entries: readonly ContextMenuItem<T>[],` with `entries: readonly ContextMenuEntry<T>[],`;
- replace the loop head `for (const item of entries) {` with:

```ts
      for (const item of entries) {
        if ("separator" in item) {
          continue;
        }
```

  The rest of the loop body stays; `item` narrows to `ContextMenuItem<T>`.

- [ ] **Step 5: Run the tests and typechecks**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run packages/contracts/src/ipc.test.ts`
Expected: PASS, including the five new `ContextMenuEntrySchema` tests and the two existing `ContextMenuItemSchema` tests.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/contracts typecheck && vp run --filter @bibcode/web typecheck`
Expected: both exit 0. A failure in a file another agent owns is recorded, not fixed.

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/contextMenuFallback.test.ts src/localApi.test.ts src/tauriDesktopBridge.test.ts`
Expected: PASS (behaviour unchanged).

Run: `cd /work/workspaces/orca/BibCode/main-3 && rg -n "ContextMenu" packages/contracts/src/rpc.ts packages/contracts/scripts packages/contracts/fixtures`
Expected: no output. Menus are not RPC, so no fixture can change (ruling 22 covers `vp run check:contracts`).

- [ ] **Step 6: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Record the tree hash. Review package: `git diff <previous-tree> <tree> -- packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.ts apps/web/src/localApi.ts apps/web/src/contextMenuFallback.ts`.

## Task 2: Native renderer separators

**Files:**
- Modify: `apps/desktop/src-tauri/src/context_menu.rs` (structs at lines ~21–36; `append_context_menu_items` ~190–221; `normalize_context_menu_items`/`normalize_context_menu_item` ~223–277; tests ~300–401)

**Interfaces:**
- Consumes: the JSON shape from Task 1 (`{ "separator": true }` entries anywhere in `items` or `children`).
- Produces: native menus with explicit separators; `NativeContextMenuRequest` keeps its public functions (`context_menu_request_from_values`, `show_native_context_menu`, `context_menu_request_has_selectable_items`) unchanged for `bridge.rs`.

- [ ] **Step 1: Write the failing Rust tests**

In the `#[cfg(test)] mod tests` block, add these helpers right after `use serde_json::json;`:

```rust
    fn item(entry: &NativeContextMenuEntry) -> &NativeContextMenuItem {
        match entry {
            NativeContextMenuEntry::Item(item) => item,
            NativeContextMenuEntry::Separator => panic!("expected an item, found a separator"),
        }
    }

    fn entry_kinds(entries: &[NativeContextMenuEntry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| match entry {
                NativeContextMenuEntry::Item(item) => item.original_id.as_str(),
                NativeContextMenuEntry::Separator => "---",
            })
            .collect()
    }

    fn row_kinds<'a>(rows: &[NativeMenuRow<'a>]) -> Vec<&'a str> {
        rows.iter()
            .map(|row| match *row {
                NativeMenuRow::Item(item) => item.original_id.as_str(),
                NativeMenuRow::Separator => "---",
            })
            .collect()
    }
```

In `normalizes_context_menu_items_for_native_menus`, replace the six assertions that index `request.items` directly:

```rust
        assert_eq!(request.items[0].original_id, "open");
        assert_eq!(request.items[1].original_id, "share");
        assert_eq!(request.items[1].children.len(), 1);
        assert_eq!(request.items[1].children[0].original_id, "copy-link");
        assert!(request.items[1].children[0].disabled);
        assert!(request.items[2].destructive);
```

with:

```rust
        assert_eq!(item(&request.items[0]).original_id, "open");
        assert_eq!(item(&request.items[1]).original_id, "share");
        assert_eq!(item(&request.items[1]).children.len(), 1);
        assert_eq!(
            item(&item(&request.items[1]).children[0]).original_id,
            "copy-link"
        );
        assert!(item(&item(&request.items[1]).children[0]).disabled);
        assert!(item(&request.items[2]).destructive);
```

Add four tests after `normalizes_context_menu_items_for_native_menus`:

```rust
    #[test]
    fn keeps_explicit_separators_without_ids_between_items() {
        let request = context_menu_request_from_values(vec![
            json!({ "id": "open", "label": "Open" }),
            json!({ "separator": true }),
            json!({ "id": "copy", "label": "Copy" }),
        ]);

        assert_eq!(entry_kinds(&request.items), vec!["open", "---", "copy"]);
        assert_eq!(request.native_to_original.len(), 2);
        let disabled = context_menu_request_from_values(vec![json!({
            "id": "pull", "label": "Pull", "disabled": true,
            "description": "Workspace is unavailable."
        })]);
        assert_eq!(item(&disabled.items[0]).label, "Pull — Workspace is unavailable.");
    }

    #[test]
    fn trims_and_collapses_separators_after_filtering() {
        let request = context_menu_request_from_values(vec![
            json!({ "separator": true }),
            json!({ "id": "header", "label": "Group", "header": true }),
            json!({ "id": "open", "label": "Open" }),
            json!({ "separator": true }),
            json!({ "id": "empty", "label": "Empty", "children": [{ "separator": true }] }),
            json!({ "separator": true }),
            json!({ "id": "copy", "label": "Copy" }),
            json!({ "separator": true }),
        ]);
        assert_eq!(entry_kinds(&request.items), vec!["open", "---", "copy"]);

        let nested = context_menu_request_from_values(vec![json!({
            "id": "open-in",
            "label": "Open in",
            "children": [
                { "id": "a", "label": "A" },
                { "separator": true },
                { "separator": true },
                { "id": "b", "label": "B" },
                { "separator": true }
            ]
        })]);
        assert_eq!(entry_kinds(&item(&nested.items[0]).children), vec!["a", "---", "b"]);
    }

    #[test]
    fn never_separates_a_leading_destructive_group_at_root_or_in_a_submenu() {
        let values = vec![
            json!({ "separator": true }),
            json!({ "id": "delete", "label": "Delete", "destructive": true }),
            json!({ "id": "purge", "label": "Purge", "destructive": true }),
            json!({ "separator": true }),
            json!({ "separator": true }),
            json!({ "id": "copy", "label": "Copy" }),
            json!({ "separator": true }),
        ];
        let root = context_menu_request_from_values(values.clone());
        assert_eq!(row_kinds(&native_menu_rows(&root.items)), vec!["delete", "purge", "---", "copy"]);
        let nested = context_menu_request_from_values(vec![json!({
            "id": "remove", "label": "Remove Project…", "children": values
        })]);
        assert_eq!(
            row_kinds(&native_menu_rows(&item(&nested.items[0]).children)),
            vec!["delete", "purge", "---", "copy"]
        );
    }

    #[test]
    fn skips_the_automatic_destructive_separator_after_an_explicit_one() {
        let explicit = context_menu_request_from_values(vec![
            json!({ "id": "rename", "label": "Rename" }),
            json!({ "separator": true }),
            json!({ "id": "delete", "label": "Delete", "destructive": true }),
        ]);
        assert_eq!(
            row_kinds(&native_menu_rows(&explicit.items)),
            vec!["rename", "---", "delete"]
        );

        let implicit = context_menu_request_from_values(vec![
            json!({ "id": "rename", "label": "Rename" }),
            json!({ "id": "delete", "label": "Delete", "destructive": true }),
            json!({ "id": "purge", "label": "Purge", "destructive": true }),
        ]);
        assert_eq!(
            row_kinds(&native_menu_rows(&implicit.items)),
            vec!["rename", "---", "delete", "purge"]
        );

        let leading = context_menu_request_from_values(vec![
            json!({ "id": "delete", "label": "Delete", "destructive": true }),
            json!({ "id": "rename", "label": "Rename" }),
        ]);
        assert_eq!(
            row_kinds(&native_menu_rows(&leading.items)),
            vec!["delete", "rename"]
        );
    }
```

- [ ] **Step 2: Run the Rust tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3 && cargo test -p bibcode-desktop context_menu`
Expected: FAIL to compile: `NativeContextMenuEntry`, `NativeMenuRow` and `native_menu_rows` do not exist. (This compiles `bibcode-server`; a compile error inside `apps/server` belongs to track A — record it and retry later.)

- [ ] **Step 3: Implement separators in the native builder**

Replace the `NativeContextMenuItem` struct and the `NativeContextMenuRequest` struct with:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeContextMenuEntry {
    Item(NativeContextMenuItem),
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeContextMenuItem {
    native_id: String,
    original_id: String,
    label: String,
    destructive: bool,
    disabled: bool,
    children: Vec<NativeContextMenuEntry>,
}

#[derive(Debug)]
pub(crate) struct NativeContextMenuRequest {
    request_id: String,
    items: Vec<NativeContextMenuEntry>,
    native_to_original: HashMap<String, String>,
}
```

Replace the whole `append_context_menu_items` function with:

```rust
/// A row of one native menu level in display order. The separator the native
/// menu adds before its first destructive item is resolved here, and skipped
/// when an explicit separator already precedes that item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeMenuRow<'a> {
    Item(&'a NativeContextMenuItem),
    Separator,
}

fn native_menu_rows(entries: &[NativeContextMenuEntry]) -> Vec<NativeMenuRow<'_>> {
    let mut rows = Vec::with_capacity(entries.len() + 1);
    let mut inserted_destructive_separator = false;
    for entry in entries {
        match entry {
            NativeContextMenuEntry::Separator => rows.push(NativeMenuRow::Separator),
            NativeContextMenuEntry::Item(item) => {
                // Entries are normalised, so a non-empty `rows` always holds an item.
                if item.destructive && !inserted_destructive_separator {
                    if !rows.is_empty() && !matches!(rows.last(), Some(NativeMenuRow::Separator)) {
                        rows.push(NativeMenuRow::Separator);
                    }
                    inserted_destructive_separator = true;
                }
                rows.push(NativeMenuRow::Item(item));
            }
        }
    }
    rows
}

fn append_context_menu_items<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Submenu<R>,
    entries: &[NativeContextMenuEntry],
) -> tauri::Result<()> {
    for row in native_menu_rows(entries) {
        match row {
            NativeMenuRow::Separator => {
                let separator = PredefinedMenuItem::separator(app)?;
                menu.append(&separator)?;
            }
            NativeMenuRow::Item(item) if item.children.is_empty() => {
                let native_item = MenuItemBuilder::with_id(item.native_id.clone(), &item.label)
                    .enabled(!item.disabled)
                    .build(app)?;
                menu.append(&native_item)?;
            }
            NativeMenuRow::Item(item) => {
                let submenu = SubmenuBuilder::with_id(app, item.native_id.clone(), &item.label)
                    .enabled(!item.disabled)
                    .build()?;
                append_context_menu_items(app, &submenu, &item.children)?;
                menu.append(&submenu)?;
            }
        }
    }

    Ok(())
}
```

Replace `normalize_context_menu_items` and `normalize_context_menu_item` with:

```rust
fn normalize_context_menu_items(
    values: &[Value],
    request_id: &str,
    next_item_index: &mut usize,
    native_to_original: &mut HashMap<String, String>,
) -> Vec<NativeContextMenuEntry> {
    let entries = values
        .iter()
        .filter_map(|value| {
            normalize_context_menu_entry(value, request_id, next_item_index, native_to_original)
        })
        .collect();
    normalize_separators(entries)
}

/// Drops leading and trailing separators and collapses runs. Runs after the
/// entries a native menu cannot show (headers, empty submenus) are filtered.
fn normalize_separators(entries: Vec<NativeContextMenuEntry>) -> Vec<NativeContextMenuEntry> {
    let mut normalized: Vec<NativeContextMenuEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        let is_separator = matches!(entry, NativeContextMenuEntry::Separator);
        if is_separator
            && matches!(
                normalized.last(),
                None | Some(NativeContextMenuEntry::Separator)
            )
        {
            continue;
        }
        normalized.push(entry);
    }
    if matches!(normalized.last(), Some(NativeContextMenuEntry::Separator)) {
        normalized.pop();
    }
    normalized
}

fn normalize_context_menu_entry(
    value: &Value,
    request_id: &str,
    next_item_index: &mut usize,
    native_to_original: &mut HashMap<String, String>,
) -> Option<NativeContextMenuEntry> {
    let object = value.as_object()?;
    // A separator carries no id or label, so it is read before those requirements.
    if bool_property(object, "separator") {
        return Some(NativeContextMenuEntry::Separator);
    }
    if bool_property(object, "header") {
        return None;
    }

    let original_id = string_property(object, "id")?.to_string();
    let base_label = string_property(object, "label")?;
    let label = match (bool_property(object, "disabled"), string_property(object, "description")) {
        (true, Some(reason)) if !reason.trim().is_empty() => format!("{base_label} — {reason}"),
        _ => base_label.to_string(),
    };
    let children = object
        .get("children")
        .and_then(Value::as_array)
        .map(|children| {
            normalize_context_menu_items(children, request_id, next_item_index, native_to_original)
        })
        .unwrap_or_default();

    if object.contains_key("children") && children.is_empty() {
        return None;
    }

    let native_id = format!("{CONTEXT_MENU_ID_PREFIX}{request_id}:{}", *next_item_index);
    *next_item_index += 1;

    if children.is_empty() {
        native_to_original.insert(native_id.clone(), original_id.clone());
    }

    Some(NativeContextMenuEntry::Item(NativeContextMenuItem {
        native_id,
        original_id,
        label,
        destructive: bool_property(object, "destructive"),
        disabled: bool_property(object, "disabled"),
        children,
    }))
}
```

`build_native_context_menu`, `show_native_context_menu` and the manager are unchanged; they only pass `request.items` along.

- [ ] **Step 4: Run the Rust gates**

Run: `cd /work/workspaces/orca/BibCode/main-3 && cargo fmt --all --check`
Expected: no output, exit 0. If it reports this file, run `rustfmt --edition 2024 apps/desktop/src-tauri/src/context_menu.rs` and re-check; if it reports another agent's file, record it.

Run: `cd /work/workspaces/orca/BibCode/main-3 && cargo test -p bibcode-desktop context_menu`
Expected: every `context_menu::tests::*` test passes (eight in this module: the four existing ones and the four new ones).

Run: `cd /work/workspaces/orca/BibCode/main-3 && cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
Expected: `Finished`, no warnings. A warning in `remote_update_delegate.rs` or any file outside `context_menu.rs` belongs to batch 1 or track A: record it with its output.

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/desktop/src-tauri/src/context_menu.rs`.

## Task 3: Web fallback separators and normalisation

**Files:**
- Modify: `apps/web/src/contextMenuFallback.ts`
- Test: `apps/web/src/contextMenuFallback.test.ts`

**Interfaces:**
- Consumes: `ContextMenuEntry` (Task 1).
- Produces: `export function normalizeContextMenuEntries<T extends string>(entries: readonly ContextMenuEntry<T>[]): ContextMenuEntry<T>[]` — trims leading/trailing separators and collapses runs; the fallback renders a separator as `<div role="separator" class="my-1 mx-1.5 h-px bg-border">`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/contextMenuFallback.test.ts` replace `import { showContextMenuFallback } from "./contextMenuFallback";` with:

```ts
import { normalizeContextMenuEntries, showContextMenuFallback } from "./contextMenuFallback";
```

Add inside `describe("showContextMenuFallback", () => {`, after the first test:

```ts
  it("renders separators and drops leading, trailing and repeated ones", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      { separator: true },
      { id: "open", label: "Open" },
      { separator: true },
      { separator: true },
      { id: "copy", label: "Copy" },
      { separator: true },
    ]);
    const inner = fakeDocument.body.children[0]!.children[0]!;
    expect(inner.children.map((child) => child.tagName)).toEqual(["button", "div", "button"]);
    const separator = inner.children[1]!;
    expect(separator.attributes["role"]).toBe("separator");
    expect(separator.className).toBe("my-1 mx-1.5 h-px bg-border");

    findButton("Copy")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(selectionPromise).resolves.toBe("copy");
  });

  it("normalizes separators inside submenus", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      {
        id: "open-in",
        label: "Open in",
        children: [
          { id: "open-in:file-explorer", label: "File Explorer" },
          { separator: true },
          { separator: true },
          { id: "open-in:vscode", label: "VS Code" },
          { separator: true },
        ],
      },
    ]);
    findButton("Open in")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    const submenuInner = fakeDocument.body.children[1]!.children[0]!;
    expect(submenuInner.children.map((child) => child.tagName)).toEqual([
      "button",
      "div",
      "button",
    ]);

    findButton("VS Code")?.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("open-in:vscode");
  });
```

Append at the end of the file:

```ts
describe("normalizeContextMenuEntries", () => {
  it("trims leading and trailing separators and collapses runs", () => {
    expect(
      normalizeContextMenuEntries([
        { separator: true },
        { id: "a", label: "A" },
        { separator: true },
        { separator: true },
        { id: "b", label: "B" },
        { separator: true },
      ]),
    ).toEqual([{ id: "a", label: "A" }, { separator: true }, { id: "b", label: "B" }]);
  });

  it("returns nothing for a list of separators", () => {
    expect(normalizeContextMenuEntries([{ separator: true }, { separator: true }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/contextMenuFallback.test.ts`
Expected: FAIL. `normalizeContextMenuEntries` is not exported, and separators are skipped instead of rendered.

- [ ] **Step 3: Render separators**

In `apps/web/src/contextMenuFallback.ts`, add after `isNodeWithinMenuStack`:

```ts
/**
 * Drops leading and trailing separators and collapses runs. The fallback shows
 * headers and empty submenus as they come, so this is its only filtering.
 */
export function normalizeContextMenuEntries<T extends string>(
  entries: readonly ContextMenuEntry<T>[],
): ContextMenuEntry<T>[] {
  const normalized: ContextMenuEntry<T>[] = [];
  for (const entry of entries) {
    if ("separator" in entry) {
      const previous = normalized.at(-1);
      if (previous === undefined || "separator" in previous) {
        continue;
      }
    }
    normalized.push(entry);
  }
  const last = normalized.at(-1);
  if (last !== undefined && "separator" in last) {
    normalized.pop();
  }
  return normalized;
}
```

In `openMenu`, replace the loop head added by Task 1:

```ts
      for (const item of entries) {
        if ("separator" in item) {
          continue;
        }
```

with:

```ts
      for (const item of normalizeContextMenuEntries(entries)) {
        if ("separator" in item) {
          const separator = document.createElement("div");
          separator.setAttribute("role", "separator");
          separator.className = "my-1 mx-1.5 h-px bg-border";
          separator.style.cssText = "height:1px;margin:0.25rem 0.375rem;background:var(--border);";
          inner.appendChild(separator);
          continue;
        }
```

The inline style mirrors the class, as every other fallback element does, so the separator renders even where the stylesheet lacks the utility.

- [ ] **Step 4: Run the tests**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/contextMenuFallback.test.ts`
Expected: PASS (all existing tests plus the four new ones).

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/contextMenuFallback.ts apps/web/src/contextMenuFallback.test.ts`.

## Task 4: Web fallback keyboard support

The fallback is the only menu in browser mode and on Windows desktop (`tauriDesktopBridge.ts:434-444`). Today it handles only Escape.

**Files:**
- Modify: `apps/web/src/contextMenuFallback.ts` (replace `showContextMenuFallback` wholesale)
- Modify: `apps/web/src/contextMenuFallback.test.ts` (fake DOM gains `stopPropagation`)
- Create: `apps/web/src/contextMenuFallback.keyboard.test.ts`
- Create: `apps/web/src/contextMenuKeyboard.ts` (shared echo timing and keyboard-open marker)

**Interfaces:**
- Consumes: `normalizeContextMenuEntries` (Task 3).
- Produces: `showContextMenuFallback` keeps its signature. Menus are `role="menu"` with `aria-orientation="vertical"`; rows are `role="menuitem"` buttons with `tabIndex = -1`; disabled rows carry `aria-disabled="true"`; submenu parents carry `aria-haspopup="menu"` and `aria-expanded`; headers are `role="presentation"`. Focus starts on the first enabled item; ArrowUp/ArrowDown wrap over enabled items; Home/End; ArrowRight opens a submenu and focuses its first item; ArrowLeft closes one level and refocuses its parent; Enter/Space open a submenu or choose the item; Escape and Tab close everything. Choosing, Escape and Tab return focus to the element focused before the menu opened; outside pointer dismissal does not move focus. Handled keys call `preventDefault()` and `stopPropagation()`, so the sidebar's global shortcuts don't also react.

- [ ] **Step 1: Write the failing keyboard tests**

Create `apps/web/src/contextMenuFallback.keyboard.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { showContextMenuFallback } from "./contextMenuFallback";

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

function focusedText(): string {
  return document.activeElement?.textContent?.trim() ?? "";
}

function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'));
}

function focusTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.textContent = "Card";
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("showContextMenuFallback keyboard support", () => {
  it("exposes menu roles and starts on the first enabled item", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "open-in", label: "Open in", children: [{ id: "open-in:vscode", label: "VS Code" }] },
      { separator: true },
      { id: "copy-path", label: "Copy Path" },
    ]);
    const [menu] = menus();
    expect(menu?.getAttribute("aria-orientation")).toBe("vertical");
    expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu?.querySelector('[aria-disabled="true"]')?.textContent).toBe("Disabled");
    expect(menu?.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(focusedText()).toContain("Open in");

    press("Escape");
    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves with the arrow keys, skipping separators and disabled items, and wraps", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "rename", label: "Rename…" },
      { separator: true },
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "copy-path", label: "Copy Path" },
      { separator: true },
      { id: "delete", label: "Delete", destructive: true },
    ]);
    expect(focusedText()).toBe("Rename…");
    press("ArrowDown");
    expect(focusedText()).toBe("Copy Path");
    press("ArrowDown");
    expect(focusedText()).toBe("Delete");
    press("ArrowDown");
    expect(focusedText()).toBe("Rename…");
    press("ArrowUp");
    expect(focusedText()).toBe("Delete");
    press("Home");
    expect(focusedText()).toBe("Rename…");
    press("End");
    expect(focusedText()).toBe("Delete");

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("opens a submenu with ArrowRight or Enter and closes it with ArrowLeft", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      {
        id: "open-in",
        label: "Open in",
        children: [
          { id: "open-in:file-explorer", label: "File Explorer" },
          { id: "open-in:vscode", label: "VS Code" },
        ],
      },
      { id: "pull", label: "Pull" },
    ]);
    const parent = menus()[0]!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;

    press("ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(focusedText()).toBe("File Explorer");
    press("ArrowDown");
    expect(focusedText()).toBe("VS Code");

    press("ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(parent);

    press("Enter");
    expect(menus()).toHaveLength(2);
    expect(focusedText()).toBe("File Explorer");
    press("Enter");
    await expect(selection).resolves.toBe("open-in:file-explorer");
    expect(menus()).toHaveLength(0);
  });

  it("chooses the focused item with Space and returns focus to the trigger", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([
      { id: "rename", label: "Rename…" },
      { id: "copy-path", label: "Copy Path" },
    ]);
    press("ArrowDown");
    const space = press(" ");
    expect(space.defaultPrevented).toBe(true);
    await expect(selection).resolves.toBe("copy-path");
    expect(document.activeElement).toBe(trigger);
  });

  it("scrolls each arrow/Home/End focus into the visible menu viewport", async () => {
    focusTrigger();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const selection = showContextMenuFallback(
      Array.from({ length: 40 }, (_, index) => ({ id: String(index), label: `Item ${index}` })),
    );
    for (const key of ["End", "Home", "ArrowDown", "ArrowUp"]) {
      scroll.mockClear();
      press(key);
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(document.activeElement);
    }
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("explains disabled Open in and Pull to sighted and assistive users", async () => {
    const selection = showContextMenuFallback([
      { id: "open-in", label: "Open in", disabled: true, description: "No local opener is available." },
      { id: "pull", label: "Pull", disabled: true, description: "Workspace is unavailable." },
    ]);
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    for (const [index, reason] of ["No local opener is available.", "Workspace is unavailable."].entries()) {
      expect(items[index]?.getAttribute("aria-description")).toBe(reason);
      expect(items[index]?.textContent).toContain(reason);
    }
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("closes on Tab without choosing anything", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([{ id: "copy-path", label: "Copy Path" }]);
    press("Tab");
    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
```

- [ ] **Step 2: Run the keyboard tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/contextMenuFallback.keyboard.test.ts`
Expected: FAIL. There is no `role="menu"`, no initial focus, and arrow keys do nothing.

- [ ] **Step 3: Give the fake DOM `stopPropagation`**

The handler now calls `stopPropagation()` on handled keys. In `apps/web/src/contextMenuFallback.test.ts`, in `class FakeDomEvent`, add after `preventDefault()`:

```ts
  stopPropagation() {}
```

The fake DOM has no focus model (`FakeElement` has no `focus()`), so the existing tests keep their behaviour: no item is focused, and the existing "dismisses with Escape but ignores other keys" test still sees Enter do nothing.

- [ ] **Step 4: Implement keyboard support**

Create `apps/web/src/contextMenuKeyboard.ts`:

```ts
export const KEYBOARD_CONTEXT_MENU_ECHO_MS = 1_000;
let pendingKeyboardOpenedAt = Number.NEGATIVE_INFINITY;

/** Called synchronously by the card key handler, before either menu path opens. */
export function markKeyboardContextMenuOpened(): number {
  pendingKeyboardOpenedAt = performance.now();
  return pendingKeyboardOpenedAt;
}

/** A fallback invocation consumes the marker; later pointer-opened menus do not inherit it. */
export function consumeKeyboardContextMenuOpenedAt(): number {
  const openedAt = pendingKeyboardOpenedAt;
  pendingKeyboardOpenedAt = Number.NEGATIVE_INFINITY;
  return openedAt;
}
```

In `apps/web/src/contextMenuFallback.ts`, add:

```ts
import {
  consumeKeyboardContextMenuOpenedAt,
  KEYBOARD_CONTEXT_MENU_ECHO_MS,
} from "./contextMenuKeyboard";
```

1. Replace `import type { ContextMenuEntry } from "@bibcode/contracts";` with:

```ts
import type { ContextMenuEntry, ContextMenuItem } from "@bibcode/contracts";
```

2. Add after `normalizeContextMenuEntries`:

```ts
interface RenderedMenuItem<T extends string> {
  readonly element: HTMLButtonElement;
  readonly item: ContextMenuItem<T>;
  readonly enabled: boolean;
  readonly hasChildren: boolean;
}

function focusElement(element: HTMLElement | null | undefined): void {
  if (element && typeof element.focus === "function") {
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest" });
  }
}

function readFocusedElement(): HTMLElement | null {
  if (typeof HTMLElement === "undefined" || typeof document === "undefined") {
    return null;
  }
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}
```

3. Replace the whole `showContextMenuFallback` function (from its doc comment through its closing brace) with:

```ts
/**
 * Imperative DOM-based context menu for browsers and the Windows desktop
 * webview. Supports nested submenus, separators and full keyboard control, and
 * resolves with the chosen leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuEntry<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const menuStack: HTMLDivElement[] = [];
    const renderedItemsByLevel: RenderedMenuItem<T>[][] = [];
    // openParents[level] is the row at `level` whose submenu is open at level + 1.
    const openParents: RenderedMenuItem<T>[] = [];
    const returnFocusTo = readFocusedElement();
    let isDisposed = false;
    let canDismissFromPointer = false;
    const keyboardOpenedAt = consumeKeyboardContextMenuOpenedAt();
    const isKeyboardEcho = () => {
      const elapsed = performance.now() - keyboardOpenedAt;
      return elapsed >= 0 && elapsed < KEYBOARD_CONTEXT_MENU_ECHO_MS;
    };

    const cleanup = (result: T | null, options: { readonly restoreFocus: boolean }) => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      for (const menu of menuStack) {
        menu.remove();
      }
      if (options.restoreFocus) {
        focusElement(returnFocusTo);
      }
      resolve(result);
    };

    const enabledRecords = (level: number): RenderedMenuItem<T>[] =>
      (renderedItemsByLevel[level] ?? []).filter((record) => record.enabled);

    const focusBoundary = (level: number, boundary: "first" | "last") => {
      const records = enabledRecords(level);
      focusElement((boundary === "first" ? records[0] : records.at(-1))?.element);
    };

    const focusedPosition = (): {
      readonly level: number;
      readonly record: RenderedMenuItem<T>;
    } | null => {
      const active = document.activeElement;
      for (let level = renderedItemsByLevel.length - 1; level >= 0; level -= 1) {
        const record = renderedItemsByLevel[level]?.find(
          (candidate) => candidate.element === active,
        );
        if (record) {
          return { level, record };
        }
      }
      return null;
    };

    const moveFocus = (step: 1 | -1) => {
      const position = focusedPosition();
      const level = position?.level ?? renderedItemsByLevel.length - 1;
      const records = enabledRecords(level);
      if (records.length === 0) {
        return;
      }
      const currentIndex = position ? records.indexOf(position.record) : -1;
      const nextIndex =
        currentIndex === -1
          ? step === 1
            ? 0
            : records.length - 1
          : (currentIndex + step + records.length) % records.length;
      focusElement(records[nextIndex]?.element);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
        case "Tab": {
          event.preventDefault();
          event.stopPropagation();
          cleanup(null, { restoreFocus: true });
          return;
        }
        case "ArrowDown":
        case "ArrowUp": {
          event.preventDefault();
          event.stopPropagation();
          moveFocus(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        case "Home":
        case "End": {
          event.preventDefault();
          event.stopPropagation();
          const level = focusedPosition()?.level ?? renderedItemsByLevel.length - 1;
          focusBoundary(level, event.key === "Home" ? "first" : "last");
          return;
        }
        case "ArrowRight": {
          const position = focusedPosition();
          if (!position?.record.hasChildren) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          openSubmenu(position.record, position.level, true);
          return;
        }
        case "ArrowLeft": {
          const position = focusedPosition();
          if (!position || position.level === 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const parent = openParents[position.level - 1];
          closeMenusFromLevel(position.level);
          focusElement(parent?.element);
          return;
        }
        case "Enter":
        case " ": {
          const position = focusedPosition();
          if (!position) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (position.record.hasChildren) {
            openSubmenu(position.record, position.level, true);
          } else {
            cleanup(position.record.item.id, { restoreFocus: true });
          }
          return;
        }
        default:
          return;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (isKeyboardEcho() && !isNodeWithinMenuStack(event.target, menuStack)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null, { restoreFocus: false });
    };

    const onContextMenu = (event: MouseEvent) => {
      if (isKeyboardEcho()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      event.preventDefault();
      cleanup(null, { restoreFocus: false });
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        menuStack.pop()?.remove();
      }
      if (renderedItemsByLevel.length > level) {
        renderedItemsByLevel.length = level;
      }
      const firstStaleParent = Math.max(level - 1, 0);
      for (let index = openParents.length - 1; index >= firstStaleParent; index -= 1) {
        openParents[index]?.element.setAttribute("aria-expanded", "false");
      }
      if (openParents.length > firstStaleParent) {
        openParents.length = firstStaleParent;
      }
    };

    const openSubmenu = (record: RenderedMenuItem<T>, level: number, focusFirst: boolean) => {
      const children = record.item.children;
      if (!children) {
        return;
      }
      const rect = record.element.getBoundingClientRect();
      openMenu(children, rect.right + 4, rect.top, level + 1);
      openParents[level] = record;
      record.element.setAttribute("aria-expanded", "true");

      const childMenu = menuStack[level + 1];
      if (childMenu) {
        const childRect = childMenu.getBoundingClientRect();
        if (childRect.right > window.innerWidth) {
          clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
        }
      }
      if (focusFirst) {
        focusBoundary(level + 1, "first");
      }
    };

    const openMenu = (
      entries: readonly ContextMenuEntry<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-orientation", "vertical");
      menu.tabIndex = -1;
      menu.className =
        "fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg border border-border bg-popover bg-clip-padding text-popover-foreground shadow-lg/5 outline-none";
      menu.style.cssText =
        "position:fixed;z-index:10000;min-width:8rem;max-width:24rem;overflow:hidden;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--popover);background-clip:padding-box;color:var(--popover-foreground);box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.05),0 4px 6px -4px rgb(0 0 0 / 0.05);outline:none;pointer-events:auto;";
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);

      const inner = document.createElement("div");
      inner.className =
        "max-h-[min(24rem,70vh)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";
      inner.style.cssText =
        "max-height:min(24rem,70vh);min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:0.25rem;";

      const records: RenderedMenuItem<T>[] = [];
      for (const entry of normalizeContextMenuEntries(entries)) {
        if ("separator" in entry) {
          const separator = document.createElement("div");
          separator.setAttribute("role", "separator");
          separator.className = "my-1 mx-1.5 h-px bg-border";
          separator.style.cssText = "height:1px;margin:0.25rem 0.375rem;background:var(--border);";
          inner.appendChild(separator);
          continue;
        }
        const item = entry;
        if (item.header === true) {
          const header = document.createElement("div");
          header.setAttribute("role", "presentation");
          header.className = "px-2 py-1.5 font-medium text-muted-foreground text-xs";
          header.textContent = item.label;
          inner.appendChild(header);
          continue;
        }

        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));
        const isDisabled = item.disabled === true;

        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("role", "menuitem");
        button.disabled = isDisabled;
        if (isDisabled) {
          button.setAttribute("aria-disabled", "true");
        }
        if (hasChildren) {
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
        }
        if (item.description) {
          button.setAttribute("aria-description", item.description);
          button.title = item.description;
        }
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground`
            : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText =
          "display:flex;width:100%;min-height:1.75rem;align-items:center;gap:0.5rem;border:0;border-radius:var(--radius-sm);background:transparent;padding:0.25rem 0.5rem;color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:0.875rem;line-height:1.25rem;text-align:left;cursor:default;";
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
          if (icon) {
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        if (item.description) {
          const reason = document.createElement("span");
          reason.className = "block whitespace-normal text-xs text-muted-foreground";
          reason.textContent = item.description;
          label.appendChild(reason);
        }
        button.appendChild(label);

        if (hasChildren) {
          const chevron = document.createElement("span");
          chevron.className = "ms-auto shrink-0 text-muted-foreground/80 text-sm leading-none";
          chevron.textContent = ">";
          button.appendChild(chevron);
        }

        const record: RenderedMenuItem<T> = {
          element: button,
          item,
          enabled: !isDisabled,
          hasChildren,
        };
        records.push(record);

        if (!isDisabled) {
          // Pointer hover and keyboard focus share one highlight: the inline
          // styles above would otherwise override a focus utility class.
          const highlight = () => {
            button.style.background = isLeafDestructive
              ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
              : "var(--accent)";
            button.style.color = isLeafDestructive
              ? "var(--destructive-foreground)"
              : "var(--accent-foreground)";
          };
          const unhighlight = () => {
            button.style.background = "transparent";
            button.style.color = isLeafDestructive
              ? "var(--destructive-foreground)"
              : "var(--foreground)";
          };
          button.addEventListener("mouseenter", highlight);
          button.addEventListener("mouseleave", unhighlight);
          button.addEventListener("focus", highlight);
          button.addEventListener("blur", unhighlight);

          if (hasChildren) {
            button.addEventListener("mouseenter", () => {
              openSubmenu(record, level, false);
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", () => cleanup(item.id, { restoreFocus: true }));
          }
        }

        inner.appendChild(button);
      }

      menu.appendChild(inner);

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;
      renderedItemsByLevel[level] = records;

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0);
    focusBoundary(0, "first");

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}
```

The icon helpers, `clampMenuPosition`, `isNodeWithinMenuStack` and `normalizeContextMenuEntries` stay as they are.

- [ ] **Step 5: Run the fallback tests**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/contextMenuFallback.test.ts src/contextMenuFallback.keyboard.test.ts src/localApi.test.ts src/tauriDesktopBridge.test.ts`
Expected: PASS. The existing fake-DOM tests, including "clamps nested menus, prevents parent clicks, and closes child levels", keep passing because the submenu open/close and clamp logic is unchanged.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 6: Review against the skills**

Tasks 15/16 add mounted-card integration tests using this real renderer; the echo must be suppressed here in capture phase before any card handler.

`contextMenuFallback.ts` is imperative DOM, not React, so the `vercel-react-best-practices` review is a short "not applicable beyond listener cleanup" note: every listener is removed in `cleanup`, and nothing leaks after the promise settles. Check it against `UI.md`: common actions work from the keyboard (line 61), standard controls and shortcuts are preserved (line 229), and focus returns where the user was. Record both in the ledger.

- [ ] **Step 7: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/contextMenuFallback.ts apps/web/src/contextMenuFallback.test.ts apps/web/src/contextMenuFallback.keyboard.test.ts apps/web/src/contextMenuKeyboard.ts`.

## Task 5: Pure sidebar menu builders

**Files:**
- Create: `apps/web/src/components/sidebar/sidebarMenus.logic.ts`
- Create: `apps/web/src/components/sidebar/sidebarMenus.logic.test.ts`
- Modify: `apps/web/src/components/WorktreeDiscoverySection.logic.ts` (`getDiscoveryVisibilityMenuLabel`, lines ~154–158)
- Test: `apps/web/src/components/WorktreeDiscoverySection.logic.test.ts` (lines ~213–217)

**Interfaces:**
- Consumes: `ContextMenuEntry`, `ContextMenuItem`, `ContextMenuSeparator` (Task 1).
- Produces:
  - `buildWorkspaceCardMenu(input: WorkspaceCardMenuInput): SidebarMenuEntry[]` with `WorkspaceCardMenuInput = { isWorktree: boolean; openIn: readonly ContextMenuItem<string>[]; pullDisabledReason: string | null; branchName: string | null; pinned: boolean; unread: boolean; confirmThreadDelete: boolean }`;
  - `buildPrimaryCardMenu(input: PrimaryCardMenuInput): SidebarMenuEntry[]` with `PrimaryCardMenuInput = { openIn: readonly ContextMenuItem<string>[]; branchName: string | null; hasDefaultThread: boolean; pinned: boolean; unread: boolean }`;
  - `buildMultiSelectMenu(count: number): SidebarMenuEntry[]`;
  - `buildProjectHeaderMenu(input: ProjectHeaderMenuInput): SidebarMenuEntry[]` with `ProjectHeaderMenuInput = { members: readonly { physicalProjectKey: string; label: string }[]; discovery: { visibility: "hidden" | "shown"; hiddenCount: number | null } | null }`;
  - `parseProjectHeaderSelection(id: string): { action: ProjectHeaderAction; physicalProjectKey: string } | null`, `ProjectHeaderAction = "new-worktree" | "rename" | "grouping" | "copy-path" | "delete"`;
  - `type SidebarMenuEntry = ContextMenuEntry<string>`;
  - `getDiscoveryVisibilityMenuLabel(visibility, hiddenCount: number | null = null): string`.
  - Menu ids: card `open-in` (children `open-in:<editor>` / `open-in:file-explorer`), `pull`, `copy-path`, `copy-branch-name`, `copy-thread-id`, `toggle-pin`, `mark-read` / `mark-unread`, `rename`, `delete`; project header `<action>:<physicalProjectKey>` leaves, `<action>:submenu` parents, `worktree-discovery-visibility`, `archive`.

- [ ] **Step 1: Write the failing builder tests**

Create `apps/web/src/components/sidebar/sidebarMenus.logic.test.ts`:

```ts
import type { ContextMenuEntry } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMultiSelectMenu,
  buildPrimaryCardMenu,
  buildProjectHeaderMenu,
  buildWorkspaceCardMenu,
  parseProjectHeaderSelection,
  type WorkspaceCardMenuInput,
} from "./sidebarMenus.logic";

function outline(entries: readonly ContextMenuEntry<string>[]): string[] {
  return entries.map((entry) => ("separator" in entry ? "---" : entry.label));
}

function ids(entries: readonly ContextMenuEntry<string>[]): string[] {
  return entries.map((entry) => ("separator" in entry ? "---" : entry.id));
}

const openIn = [
  { id: "open-in:file-explorer", label: "File Explorer" },
  { id: "open-in:vscode", label: "VS Code" },
];

const worktreeCard: WorkspaceCardMenuInput = {
  isWorktree: true,
  openIn,
  pullDisabledReason: null,
  branchName: "fix-TRI-150",
  pinned: false,
  unread: false,
  confirmThreadDelete: true,
};

describe("buildWorkspaceCardMenu", () => {
  it("groups a worktree card's items as in Menus.dc.html", () => {
    const menu = buildWorkspaceCardMenu(worktreeCard);
    expect(outline(menu)).toEqual([
      "Open in",
      "Pull",
      "---",
      "Copy Path",
      "Copy Branch Name",
      "Copy Thread ID",
      "---",
      "Pin",
      "Mark as Unread",
      "Rename…",
      "---",
      "Delete Worktree…",
    ]);
    expect(ids(menu)).toEqual([
      "open-in",
      "pull",
      "---",
      "copy-path",
      "copy-branch-name",
      "copy-thread-id",
      "---",
      "toggle-pin",
      "mark-unread",
      "rename",
      "---",
      "delete",
    ]);
    expect(menu.at(-1)).toMatchObject({ destructive: true, icon: "trash" });
    expect(menu[0]).toMatchObject({ children: openIn });
  });

  it("omits Copy Branch Name without a branch and reflects pin, read and pull state", () => {
    const menu = buildWorkspaceCardMenu({
      ...worktreeCard,
      branchName: null,
      pinned: true,
      unread: true,
      pullDisabledReason: "Workspace is unavailable.",
      openIn: [],
    });
    expect(outline(menu)).not.toContain("Copy Branch Name");
    expect(outline(menu)).toContain("Unpin");
    expect(outline(menu)).toContain("Mark as Read");
    expect(menu.find((entry) => "id" in entry && entry.id === "pull")).toMatchObject({
      disabled: true,
      description: "Workspace is unavailable.",
    });
    expect(menu[0]).toEqual({
      id: "open-in", label: "Open in", disabled: true,
      description: "No local opener is available for this workspace.",
    });
  });

  it("labels deleting a thread without a worktree by the confirmation setting", () => {
    expect(outline(buildWorkspaceCardMenu({ ...worktreeCard, isWorktree: false })).at(-1)).toBe(
      "Delete Thread…",
    );
    expect(
      outline(
        buildWorkspaceCardMenu({
          ...worktreeCard,
          isWorktree: false,
          confirmThreadDelete: false,
        }),
      ).at(-1),
    ).toBe("Delete Thread");
  });
});

describe("buildPrimaryCardMenu", () => {
  it("groups the main checkout card's items as in Menus.dc.html", () => {
    expect(
      outline(
        buildPrimaryCardMenu({
          openIn,
          branchName: "develop",
          hasDefaultThread: true,
          pinned: false,
          unread: false,
        }),
      ),
    ).toEqual(["Open in", "Pull", "---", "Copy Path", "Copy Branch Name", "---", "Pin", "Mark as Unread"]);
  });

  it("drops the pin group without a default thread and the branch copy without a branch", () => {
    expect(
      outline(
        buildPrimaryCardMenu({
          openIn,
          branchName: null,
          hasDefaultThread: false,
          pinned: false,
          unread: false,
        }),
      ),
    ).toEqual(["Open in", "Pull", "---", "Copy Path"]);
  });
});

describe("buildMultiSelectMenu", () => {
  it("counts the selection and separates the destructive item", () => {
    const menu = buildMultiSelectMenu(3);
    expect(outline(menu)).toEqual(["Mark as Unread (3)", "---", "Delete (3)"]);
    expect(ids(menu)).toEqual(["mark-unread", "---", "delete"]);
    expect(menu.at(-1)).toMatchObject({ destructive: true });
  });
});

describe("buildProjectHeaderMenu", () => {
  const single = [{ physicalProjectKey: "env-main:/repo", label: "Repo" }];

  it("groups a single project's items as in Menus.dc.html", () => {
    const menu = buildProjectHeaderMenu({
      members: single,
      discovery: { visibility: "hidden", hiddenCount: 1 },
    });
    expect(outline(menu)).toEqual([
      "New Worktree…",
      "---",
      "Rename…",
      "Group into…",
      "Copy Path",
      "---",
      "Show Hidden Worktrees (1)",
      "Archived Threads",
      "---",
      "Remove Project…",
    ]);
    expect(ids(menu)).toEqual([
      "new-worktree:env-main:/repo",
      "---",
      "rename:env-main:/repo",
      "grouping:env-main:/repo",
      "copy-path:env-main:/repo",
      "---",
      "worktree-discovery-visibility",
      "archive",
      "---",
      "delete:env-main:/repo",
    ]);
    expect(menu.at(-1)).toMatchObject({ destructive: true, icon: "trash" });
  });

  it("omits the discovery item without discovery support and hides an unknown count", () => {
    expect(outline(buildProjectHeaderMenu({ members: single, discovery: null }))).not.toContain(
      "Show Hidden Worktrees",
    );
    expect(
      outline(
        buildProjectHeaderMenu({
          members: single,
          discovery: { visibility: "hidden", hiddenCount: null },
        }),
      ),
    ).toContain("Show Hidden Worktrees");
    expect(
      outline(
        buildProjectHeaderMenu({
          members: single,
          discovery: { visibility: "shown", hiddenCount: 3 },
        }),
      ),
    ).toContain("Hide Discovered Worktrees");
  });

  it("keeps per-member submenus for grouped projects", () => {
    const menu = buildProjectHeaderMenu({
      members: [
        { physicalProjectKey: "env-main:/repo", label: "Main — /repo" },
        { physicalProjectKey: "env-remote:/srv/repo", label: "Remote — /srv/repo" },
      ],
      discovery: null,
    });
    const rename = menu.find((entry) => "id" in entry && entry.id === "rename:submenu");
    expect(rename).toMatchObject({
      label: "Rename…",
      children: [
        { id: "rename:env-main:/repo", label: "Main — /repo" },
        { id: "rename:env-remote:/srv/repo", label: "Remote — /srv/repo" },
      ],
    });
    const remove = menu.at(-1);
    expect(remove).toMatchObject({ id: "delete:submenu", label: "Remove Project…", icon: "trash" });
    expect(remove && "children" in remove ? remove.children : []).toEqual([
      { id: "delete:env-main:/repo", label: "Main — /repo", destructive: true },
      { id: "delete:env-remote:/srv/repo", label: "Remote — /srv/repo", destructive: true },
    ]);
  });
});

describe("parseProjectHeaderSelection", () => {
  it("splits at the first colon because physical keys contain colons", () => {
    expect(parseProjectHeaderSelection("copy-path:env-main:/repo")).toEqual({
      action: "copy-path",
      physicalProjectKey: "env-main:/repo",
    });
    expect(parseProjectHeaderSelection("new-worktree:env-remote:R:\\repo")).toEqual({
      action: "new-worktree",
      physicalProjectKey: "env-remote:R:\\repo",
    });
  });

  it("rejects ids that are not project-header leaves", () => {
    expect(parseProjectHeaderSelection("archive")).toBeNull();
    expect(parseProjectHeaderSelection("worktree-discovery-visibility")).toBeNull();
    expect(parseProjectHeaderSelection("rename:submenu")).toBeNull();
    expect(parseProjectHeaderSelection("unknown:env-main:/repo")).toBeNull();
  });
});
```

In `apps/web/src/components/WorktreeDiscoverySection.logic.test.ts`, replace:

```ts
    expect(getDiscoveryVisibilityMenuLabel("hidden")).toBe("Show hidden worktrees");
    expect(getDiscoveryVisibilityMenuLabel("shown")).toBe("Hide discovered worktrees");
```

with:

```ts
    expect(getDiscoveryVisibilityMenuLabel("hidden")).toBe("Show Hidden Worktrees");
    expect(getDiscoveryVisibilityMenuLabel("hidden", 0)).toBe("Show Hidden Worktrees (0)");
    expect(getDiscoveryVisibilityMenuLabel("hidden", 2)).toBe("Show Hidden Worktrees (2)");
    expect(getDiscoveryVisibilityMenuLabel("shown", 2)).toBe("Hide Discovered Worktrees");
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar/sidebarMenus.logic.test.ts src/components/WorktreeDiscoverySection.logic.test.ts`
Expected: FAIL. `sidebarMenus.logic` doesn't exist and the visibility label is still sentence case.

- [ ] **Step 3: Implement the builders**

In `apps/web/src/components/WorktreeDiscoverySection.logic.ts`, replace `getDiscoveryVisibilityMenuLabel` with:

```ts
/**
 * The project menu's discovery toggle. `hiddenCount` comes from the mounted
 * discovery section; null (collapsed project, not loaded) omits the count.
 */
export function getDiscoveryVisibilityMenuLabel(
  visibility: WorktreeDiscoveryVisibility,
  hiddenCount: number | null = null,
): string {
  if (visibility !== "hidden") {
    return "Hide Discovered Worktrees";
  }
  return hiddenCount === null ? "Show Hidden Worktrees" : `Show Hidden Worktrees (${hiddenCount})`;
}
```

Create `apps/web/src/components/sidebar/sidebarMenus.logic.ts`:

```ts
import type { ContextMenuEntry, ContextMenuItem, ContextMenuSeparator } from "@bibcode/contracts";

import { getDiscoveryVisibilityMenuLabel } from "../WorktreeDiscoverySection.logic";

/**
 * Pure builders for every left-panel menu, grouped as in the approved
 * Menus.dc.html. Renderers trim and collapse separators, so a builder may put
 * one between groups even when a neighbouring item is omitted.
 */

export type SidebarMenuEntry = ContextMenuEntry<string>;

const SEPARATOR: ContextMenuSeparator = { separator: true };

export interface WorkspaceCardMenuInput {
  /** Worktree cards delete through the worktree removal flow. */
  readonly isWorktree: boolean;
  /** "Open in" children: File Explorer first, then editors. Empty disables the item. */
  readonly openIn: readonly ContextMenuItem<string>[];
  readonly pullDisabledReason: string | null;
  /** The branch the card shows; "Copy Branch Name" is omitted when null. */
  readonly branchName: string | null;
  readonly pinned: boolean;
  readonly unread: boolean;
  readonly confirmThreadDelete: boolean;
}

export interface PrimaryCardMenuInput {
  readonly openIn: readonly ContextMenuItem<string>[];
  readonly branchName: string | null;
  /** Pin and read state live on the default thread; a project without one has neither. */
  readonly hasDefaultThread: boolean;
  readonly pinned: boolean;
  readonly unread: boolean;
}

export type ProjectHeaderAction = "new-worktree" | "rename" | "grouping" | "copy-path" | "delete";

const PROJECT_HEADER_ACTIONS: readonly ProjectHeaderAction[] = [
  "new-worktree",
  "rename",
  "grouping",
  "copy-path",
  "delete",
];

export interface ProjectHeaderMenuMember {
  readonly physicalProjectKey: string;
  /** The member's label inside a grouped project's submenu. */
  readonly label: string;
}

export interface ProjectHeaderMenuInput {
  readonly members: readonly ProjectHeaderMenuMember[];
  /** Present when a member supports worktree discovery. */
  readonly discovery: {
    readonly visibility: "hidden" | "shown";
    readonly hiddenCount: number | null;
  } | null;
}

function openInEntry(openIn: readonly ContextMenuItem<string>[]): ContextMenuItem<string> {
  return openIn.length > 0
    ? { id: "open-in", label: "Open in", children: openIn }
    : {
        id: "open-in", label: "Open in", disabled: true,
        description: "No local opener is available for this workspace.",
      };
}

function pinAndReadEntries(pinned: boolean, unread: boolean): ContextMenuItem<string>[] {
  return [
    { id: "toggle-pin", label: pinned ? "Unpin" : "Pin" },
    unread
      ? { id: "mark-read", label: "Mark as Read" }
      : { id: "mark-unread", label: "Mark as Unread" },
  ];
}

function copyBranchEntry(branchName: string | null): ContextMenuItem<string>[] {
  return branchName === null ? [] : [{ id: "copy-branch-name", label: "Copy Branch Name" }];
}

export function buildWorkspaceCardMenu(input: WorkspaceCardMenuInput): SidebarMenuEntry[] {
  const deleteLabel = input.isWorktree
    ? "Delete Worktree…"
    : input.confirmThreadDelete
      ? "Delete Thread…"
      : "Delete Thread";
  return [
    openInEntry(input.openIn),
    input.pullDisabledReason
      ? { id: "pull", label: "Pull", disabled: true, description: input.pullDisabledReason }
      : { id: "pull", label: "Pull" },
    SEPARATOR,
    { id: "copy-path", label: "Copy Path" },
    ...copyBranchEntry(input.branchName),
    { id: "copy-thread-id", label: "Copy Thread ID" },
    SEPARATOR,
    ...pinAndReadEntries(input.pinned, input.unread),
    { id: "rename", label: "Rename…" },
    SEPARATOR,
    { id: "delete", label: deleteLabel, destructive: true, icon: "trash" },
  ];
}

export function buildPrimaryCardMenu(input: PrimaryCardMenuInput): SidebarMenuEntry[] {
  return [
    openInEntry(input.openIn),
    { id: "pull", label: "Pull" },
    SEPARATOR,
    { id: "copy-path", label: "Copy Path" },
    ...copyBranchEntry(input.branchName),
    ...(input.hasDefaultThread ? [SEPARATOR, ...pinAndReadEntries(input.pinned, input.unread)] : []),
  ];
}

export function buildMultiSelectMenu(count: number): SidebarMenuEntry[] {
  return [
    { id: "mark-unread", label: `Mark as Unread (${count})` },
    SEPARATOR,
    { id: "delete", label: `Delete (${count})`, destructive: true },
  ];
}

function projectHeaderEntry(
  members: readonly ProjectHeaderMenuMember[],
  action: ProjectHeaderAction,
  label: string,
  destructive: boolean,
): ContextMenuItem<string> {
  const onlyMember = members.length === 1 ? members[0] : undefined;
  if (onlyMember !== undefined) {
    return {
      id: `${action}:${onlyMember.physicalProjectKey}`,
      label,
      ...(destructive ? { destructive: true, icon: "trash" } : {}),
    };
  }
  return {
    id: `${action}:submenu`,
    label,
    ...(destructive ? { icon: "trash" } : {}),
    children: members.map((member) => ({
      id: `${action}:${member.physicalProjectKey}`,
      label: member.label,
      ...(destructive ? { destructive: true } : {}),
    })),
  };
}

export function buildProjectHeaderMenu(input: ProjectHeaderMenuInput): SidebarMenuEntry[] {
  const entry = (action: ProjectHeaderAction, label: string, destructive = false) =>
    projectHeaderEntry(input.members, action, label, destructive);
  return [
    entry("new-worktree", "New Worktree…"),
    SEPARATOR,
    entry("rename", "Rename…"),
    entry("grouping", "Group into…"),
    entry("copy-path", "Copy Path"),
    SEPARATOR,
    ...(input.discovery === null
      ? []
      : [
          {
            id: "worktree-discovery-visibility",
            label: getDiscoveryVisibilityMenuLabel(
              input.discovery.visibility,
              input.discovery.hiddenCount,
            ),
          },
        ]),
    { id: "archive", label: "Archived Threads" },
    SEPARATOR,
    entry("delete", "Remove Project…", true),
  ];
}

/**
 * Reads a project-header leaf id back. Physical project keys contain colons
 * (`<environmentId>:<path>`), so the action ends at the first colon.
 */
export function parseProjectHeaderSelection(
  id: string,
): { readonly action: ProjectHeaderAction; readonly physicalProjectKey: string } | null {
  const colonIndex = id.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }
  const action = PROJECT_HEADER_ACTIONS.find((candidate) => candidate === id.slice(0, colonIndex));
  const physicalProjectKey = id.slice(colonIndex + 1);
  if (action === undefined || physicalProjectKey === "" || physicalProjectKey === "submenu") {
    return null;
  }
  return { action, physicalProjectKey };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar/sidebarMenus.logic.test.ts src/components/WorktreeDiscoverySection.logic.test.ts`
Expected: PASS.

`Sidebar.tsx` still calls `getDiscoveryVisibilityMenuLabel(currentDiscoveryVisibility)`, which now returns Title Case; `Sidebar.test.tsx:2242` and `:2279` fail until Task 7 updates them. That is expected at this checkpoint; record it in the ledger.

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/sidebar/sidebarMenus.logic.ts apps/web/src/components/sidebar/sidebarMenus.logic.test.ts apps/web/src/components/WorktreeDiscoverySection.logic.ts apps/web/src/components/WorktreeDiscoverySection.logic.test.ts`.

## Task 6: Card menus use the builders (Pull, Copy Branch Name)

Today's rows stay; only their menus change. "Copy Branch Name" copies the retained ThreadWorktreeIndicator branch value (`thread.branch` when a worktree is shown), never a fresher ref than the display. Its path-only fallback is not a branch, so omit Copy Branch Name then. Task 15 switches display and copy together to helper B (`resolveWorkspaceBranchLabel`).

**Files:**
- Modify: `apps/web/src/components/Sidebar.logic.ts` (imports; add `resolveWorkspaceBranchLabel`)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx` (imports; `SidebarThreadRowProps`/`SidebarProjectThreadListProps`; `SidebarThreadRow`; `SidebarPrimaryRow`; `SidebarProjectItem`'s copy hooks, `handleMultiSelectContextMenu`, `handleThreadContextMenu`, `handlePrimaryRowContextMenu`, JSX)
- Test: `apps/web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `buildWorkspaceCardMenu`, `buildPrimaryCardMenu`, `buildMultiSelectMenu` (Task 5).
- Produces:
  - `resolveWorkspaceBranchLabel(status: VcsStatusResult | VcsStatusSummary | null | undefined, fallbackBranch: string | null): string | null` — the fresh status's `refName`, else its `detachedHead`, else `fallbackBranch`; a stale summary is ignored. Step 2 reuses it.
  - `handleThreadContextMenu(threadRef, position, worktreeStatus, branchName: string | null): Promise<void>` (new fourth parameter).
  - `SidebarPrimaryRow`'s `onContextMenu` prop becomes `onOpenMenu: (position: { x: number; y: number }, branchName: string | null) => void`; `SidebarProjectItem.openPrimaryCardMenu` implements it (Task 16 reuses it for the primary card).

- [ ] **Step 1: Write the failing logic tests**

In `apps/web/src/components/Sidebar.logic.test.ts`, add `resolveWorkspaceBranchLabel,` to the `from "./Sidebar.logic"` import list, and add `type VcsStatusResult, type VcsStatusSummary,` to the `from "@bibcode/contracts"` import list. Append:

```ts
describe("resolveWorkspaceBranchLabel", () => {
  const summary = (overrides: Record<string, unknown>) =>
    ({
      isRepo: true,
      refName: "main",
      detachedHead: null,
      hasWorkingTreeChanges: false,
      sourceControlProvider: null,
      pr: null,
      observedAt: "2026-09-24T10:00:00.000Z",
      stale: false,
      ...overrides,
    }) as unknown as VcsStatusSummary;

  it("prefers the fresh ref name", () => {
    expect(resolveWorkspaceBranchLabel(summary({}), "stored")).toBe("main");
  });

  it("falls back to the detached head", () => {
    expect(
      resolveWorkspaceBranchLabel(summary({ refName: null, detachedHead: "abc1234" }), "stored"),
    ).toBe("abc1234");
  });

  it("ignores a stale summary", () => {
    expect(resolveWorkspaceBranchLabel(summary({ stale: true }), "stored")).toBe("stored");
  });

  it("uses the recorded branch without a status", () => {
    expect(resolveWorkspaceBranchLabel(null, "stored")).toBe("stored");
    expect(resolveWorkspaceBranchLabel(undefined, null)).toBeNull();
  });

  it("reads the ref from a full status result", () => {
    expect(
      resolveWorkspaceBranchLabel({ refName: "feat/x" } as unknown as VcsStatusResult, null),
    ).toBe("feat/x");
  });
});
```

- [ ] **Step 2: Write the failing sidebar tests**

In `apps/web/src/components/Sidebar.test.tsx`:

1. Rename the `update` menu id to `pull` everywhere a test uses it: in `menuItems.find((item) => item.id === "update")` (two occurrences, in "keeps a missing adopted row selectable…" and "keeps retained verification-unavailable rows usable…"), in `setupMenu("update")` (two occurrences), and in `h.spies.contextMenuShow.mockResolvedValue("update")` (two occurrences, both in the "primary row" describe). Replace each `"update"` with `"pull"` in those six places.
2. Rename the two tests `it("runs vcs pull for 'Update' and refreshes the status"` → `it("runs vcs pull for 'Pull' and refreshes the status"` and `it("toasts when 'Update' fails"` → `it("toasts when 'Pull' fails"`, and in the latter replace `title: "Failed to update"` with `title: "Failed to pull"`.
3. In `it("does not expose project removal from the primary branch row"`, replace:

```ts
      expect(items.some((item) => item.id.startsWith("remove-project"))).toBe(false);
```

with:

```ts
      expect(items.some((item) => item.id?.startsWith("delete") === true)).toBe(false);
```

4. Add inside `staticDescribe("thread context menu", () => {`, after `it("copies the workspace path and thread id"`:

```ts
  it("copies the branch shown on the row, grouped with the other copy actions", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    let menuItems: Array<{ id?: string; label?: string; separator?: true }> = [];
    h.spies.contextMenuShow.mockImplementation(async (items) => {
      menuItems = items;
      return "copy-branch-name";
    });
    const row = mustFindProps(byTestId("thread-row-thread-active"), "active worktree row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();

    expect(menuItems.map((item) => (item.separator ? "---" : item.id))).toEqual([
      "open-in",
      "pull",
      "---",
      "copy-path",
      "copy-branch-name",
      "copy-thread-id",
      "---",
      "toggle-pin",
      "mark-unread",
      "rename",
      "---",
      "delete",
    ]);
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("feat/x", { branch: "feat/x" });
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Branch name copied", description: "feat/x" }),
    );
  });

  it("copies the retained indicator branch even if VCS has a newer ref", async () => {
    baseScenario();
    h.state.vcsStatusByCwd["C:/wt/x"] = { refName: "fresh-but-not-displayed" };
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockResolvedValue("copy-branch-name");
    expect(captured("ThreadWorktreeIndicator").some((entry) =>
      (entry.props["thread"] as { branch?: string }).branch === "feat/x",
    )).toBe(true);
    invoke(mustFindProps(byTestId("thread-row-thread-active"), "row"), "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("feat/x", { branch: "feat/x" });
  });

  it("omits Copy Branch Name when the row shows no branch", async () => {
    const row = setupMenu(null);
    let menuItems: Array<{ id?: string; label?: string; separator?: true }> = [];
    h.spies.contextMenuShow.mockImplementation(async (items) => {
      menuItems = items;
      return null;
    });
    invoke(row, "onContextMenu", mouseEvent());
    await flush();

    expect(menuItems.some((item) => item.id === "copy-branch-name")).toBe(false);
    expect(menuItems.at(-1)).toMatchObject({ id: "delete", label: "Delete Thread…" });
  });
```

5. Add inside `staticDescribe("primary row", () => {`, after `it("shows the primary-row context menu and handles update / copy / pin actions"`:

```ts
  it("offers and copies the live checkout branch from the primary row", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
    let menuItems: Array<{ id?: string; separator?: true }> = [];
    h.spies.contextMenuShow.mockImplementation(async (items) => {
      menuItems = items;
      return "copy-branch-name";
    });
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();

    expect(menuItems.map((item) => (item.separator ? "---" : item.id))).toEqual([
      "open-in",
      "pull",
      "---",
      "copy-path",
      "copy-branch-name",
      "---",
      "toggle-pin",
      "mark-unread",
    ]);
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("main", { branch: "main" });
  });
```

Also rename that describe's `it("shows the primary-row context menu and handles update / copy / pin actions"` to `it("shows the primary-row context menu and handles pull / copy / pin actions"`.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/Sidebar.test.tsx`
Expected: FAIL — `resolveWorkspaceBranchLabel` is missing, the menus still use `update`, and there is no Copy Branch Name. (The two discovery-label failures from Task 5 are still there; Task 7 fixes them.)

- [ ] **Step 4: Add `resolveWorkspaceBranchLabel`**

In `apps/web/src/components/Sidebar.logic.ts`, replace `import type { EnvironmentId } from "@bibcode/contracts";` with:

```ts
import type { EnvironmentId, VcsStatusResult, VcsStatusSummary } from "@bibcode/contracts";
```

Add after `hasUnseenCompletion`:

```ts
/**
 * The branch a workspace card shows: the fresh VCS status's ref, else its
 * detached HEAD, else the branch the thread recorded. A stale passive summary is
 * ignored rather than presented as the current branch.
 */
export function resolveWorkspaceBranchLabel(
  status: VcsStatusResult | VcsStatusSummary | null | undefined,
  fallbackBranch: string | null,
): string | null {
  if (status && !("stale" in status && status.stale)) {
    const liveBranch = status.refName ?? ("detachedHead" in status ? status.detachedHead : null);
    if (liveBranch) {
      return liveBranch;
    }
  }
  return fallbackBranch;
}
```

- [ ] **Step 5: Wire the builders into `Sidebar.tsx`**

Apply these edits in order.

(a) Imports: add `resolveWorkspaceBranchLabel,` to the `from "./Sidebar.logic";` import list, and add after `import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";`:

```ts
import {
  buildMultiSelectMenu,
  buildPrimaryCardMenu,
  buildWorkspaceCardMenu,
} from "./sidebar/sidebarMenus.logic";
```

(b) The menu handler type appears twice, identically, in `SidebarThreadRowProps` and `SidebarProjectThreadListProps`. Replace both occurrences (use `replace_all`) of:

```ts
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    worktreeStatus: VcsAdoptedWorktreeStatus | null,
  ) => Promise<void>;
```

with:

```ts
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    worktreeStatus: VcsAdoptedWorktreeStatus | null,
    branchName: string | null,
  ) => Promise<void>;
```

(c) In `SidebarThreadRow`, after `const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);` add:

```ts
  // Step 1 retains ThreadWorktreeIndicator: it displays thread.branch, not the live ref.
  const displayedBranch = thread.worktreePath?.trim() ? thread.branch : null;
```

In `handleRowContextMenu`, replace:

```ts
          handleThreadContextMenu(
            threadRef,
            {
              x: event.clientX,
              y: event.clientY,
            },
            worktreeStatus,
          ),
```

with:

```ts
          handleThreadContextMenu(
            threadRef,
            {
              x: event.clientX,
              y: event.clientY,
            },
            worktreeStatus,
            displayedBranch,
          ),
```

and replace its dependency list:

```ts
    [
      clearSelection,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      isSelected,
      threadRef,
      worktreeStatus,
    ],
```

with:

```ts
    [
      clearSelection,
      displayedBranch,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      isSelected,
      threadRef,
      worktreeStatus,
    ],
```

(d) Replace the whole `SidebarPrimaryRow` function (from `function SidebarPrimaryRow(props: {` through its closing `}` before `const SidebarProjectThreadList = memo(`) with:

```tsx
function SidebarPrimaryRow(props: {
  project: SidebarProjectSnapshot;
  primaryThread: SidebarThreadSummary | null;
  isActive: boolean;
  onClick: () => void;
  onOpenMenu: (position: { x: number; y: number }, branchName: string | null) => void;
}) {
  const { project, primaryThread, isActive, onClick, onOpenMenu } = props;
  const gitStatus = useEnvironmentQuery(
    vcsEnvironment.summary({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    }),
  );
  const liveBranch = resolveWorkspaceBranchLabel(gitStatus.data, null);
  const title = liveBranch ?? primaryThread?.branch ?? project.displayName;
  const branchName = liveBranch ?? primaryThread?.branch ?? null;
  const statusPill = primaryThread ? resolveThreadStatusPill({ thread: primaryThread }) : null;
  const primaryThreadKey = primaryThread
    ? scopedThreadKey(scopeThreadRef(primaryThread.environmentId, primaryThread.id))
    : null;
  const isPinned = useSidebarWorkspaceMetaStore(
    (state) =>
      primaryThreadKey !== null && selectIsPinned(state.pinnedThreadKeys, primaryThreadKey),
  );
  const isUnread = useSidebarWorkspaceMetaStore(
    (state) =>
      primaryThreadKey !== null && selectIsUnread(state.unreadThreadKeys, primaryThreadKey),
  );
  const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const handleClick = useCallback(() => {
    if (primaryThreadKey) {
      markRead(primaryThreadKey);
    }
    onClick();
  }, [markRead, onClick, primaryThreadKey]);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      onOpenMenu({ x: event.clientX, y: event.clientY }, branchName);
    },
    [branchName, onOpenMenu],
  );

  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <SidebarMenuSubButton
        data-thread-item
        size="sm"
        className={resolveThreadRowClassName({ isActive, isSelected: false })}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              statusPill ? statusPill.dotClass : "bg-muted-foreground/30",
              statusPill?.pulse && "animate-pulse",
            )}
          />
          {isUnread && (
            <span
              aria-label="Unread"
              className="size-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-300/80"
            />
          )}
          {isPinned && (
            <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground/50" />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
            primary
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
```

(The row's look is unchanged; step 2 replaces it with the card.)

(e) In `SidebarProjectItem`, add after the `useCopyToClipboard` block that defines `copyPathToClipboard`:

```ts
  const { copyToClipboard: copyBranchNameToClipboard } = useCopyToClipboard<{
    branch: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Branch name copied",
        description: ctx.branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch name",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
```

(f) In `handleMultiSelectContextMenu`, replace:

```ts
      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );
```

with:

```ts
      const clicked = await api.contextMenu.show(buildMultiSelectMenu(count), position);
```

(g) Replace the whole `handlePrimaryRowContextMenu` declaration (from the comment `// Context menu for the primary (project checkout) row. The` through the end of its `useCallback(…)` call) with:

```ts
  // Menu for the primary (project checkout) card. The primary checkout is
  // read-only in the project tree, so project removal stays on the project
  // header menu instead of this card.
  const openPrimaryCardMenu = useCallback(
    (position: { x: number; y: number }, branchName: string | null) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const cwd = project.workspaceRoot;
        const primaryThreadKey = primaryThread
          ? scopedThreadKey(scopeThreadRef(primaryThread.environmentId, primaryThread.id))
          : null;
        const openInEditorOptions = EDITORS.filter((editor) =>
          availableEditorsFor(project.environmentId).includes(editor.id),
        );
        const canOpenInFileExplorer =
          project.environmentId === primaryEnvironmentId && typeof window !== "undefined"
            ? window.desktopBridge?.openInFileManager !== undefined
            : false;
        const openInChildren = [
          ...(canOpenInFileExplorer
            ? [{ id: "open-in:file-explorer", label: "File Explorer" }]
            : []),
          ...openInEditorOptions.map((editor) => ({
            id: `open-in:${editor.id}`,
            label: editor.label,
          })),
        ];
        const clicked = await api.contextMenu.show(
          buildPrimaryCardMenu({
            openIn: openInChildren,
            branchName,
            hasDefaultThread: primaryThreadKey !== null,
            pinned: primaryThreadKey !== null && pinnedThreadKeys.includes(primaryThreadKey),
            unread: primaryThreadKey !== null && unreadThreadKeys.includes(primaryThreadKey),
          }),
          position,
        );

        if (clicked === "pull") {
          const pullResult = await pullWorkspaceRow({
            environmentId: project.environmentId,
            input: { cwd },
          });
          if (pullResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(pullResult)) {
              const error = squashAtomCommandFailure(pullResult);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to pull",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          await refreshVcsStatusAfterPull({ environmentId: project.environmentId, input: { cwd } });
          return;
        }

        if (clicked === "open-in:file-explorer") {
          await openWorkspaceInFileManager(cwd);
          return;
        }

        if (typeof clicked === "string" && clicked.startsWith("open-in:")) {
          const editor = openInEditorOptions.find(
            (candidate) => `open-in:${candidate.id}` === clicked,
          );
          if (!editor) return;
          const openResult = await openInEditorMutation({
            environmentId: project.environmentId,
            input: { cwd, editor: editor.id },
          });
          if (openResult._tag === "Failure" && !isAtomCommandInterrupted(openResult)) {
            const error = squashAtomCommandFailure(openResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open editor",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }

        if (clicked === "copy-path") {
          copyPathToClipboard(cwd, { path: cwd });
          return;
        }
        if (clicked === "copy-branch-name") {
          if (branchName !== null) {
            copyBranchNameToClipboard(branchName, { branch: branchName });
          }
          return;
        }
        if (clicked === "mark-unread" && primaryThreadKey) {
          markThreadRowUnread(primaryThreadKey);
          return;
        }
        if (clicked === "mark-read" && primaryThreadKey) {
          markThreadRowRead(primaryThreadKey);
          return;
        }
        if (clicked === "toggle-pin" && primaryThreadKey) {
          togglePinnedThreadKey(primaryThreadKey);
        }
      })();
    },
    [
      availableEditorsFor,
      copyBranchNameToClipboard,
      copyPathToClipboard,
      markThreadRowRead,
      markThreadRowUnread,
      openInEditorMutation,
      openWorkspaceInFileManager,
      pinnedThreadKeys,
      primaryEnvironmentId,
      primaryThread,
      project,
      pullWorkspaceRow,
      refreshVcsStatusAfterPull,
      togglePinnedThreadKey,
      unreadThreadKeys,
    ],
  );
```

In the JSX, replace `onContextMenu={handlePrimaryRowContextMenu}` with `onOpenMenu={openPrimaryCardMenu}`.

(h) In `handleThreadContextMenu`:

- replace the parameter list

```ts
    async (
      threadRef: ScopedThreadRef,
      position: { x: number; y: number },
      worktreeStatus: VcsAdoptedWorktreeStatus | null,
    ) => {
```

  with

```ts
    async (
      threadRef: ScopedThreadRef,
      position: { x: number; y: number },
      worktreeStatus: VcsAdoptedWorktreeStatus | null,
      branchName: string | null,
    ) => {
```

- delete the two lines

```ts
      const isPinned = pinnedThreadKeys.includes(threadKey);
      const isUnread = unreadThreadKeys.includes(threadKey);
```

- replace the whole `const clicked = await api.contextMenu.show([ … ], position);` call (the one whose first item is `id: "update"`) with:

```ts
      const clicked = await api.contextMenu.show(
        buildWorkspaceCardMenu({
          isWorktree: thread.worktreePath !== null,
          openIn: openInChildren,
          pullDisabledReason: !threadWorkspacePath
            ? "This thread has no workspace path."
            : !workspaceActionsAvailable
              ? "The worktree is missing or unavailable. Verify it before pulling."
              : null,
          branchName,
          pinned: pinnedThreadKeys.includes(threadKey),
          unread: unreadThreadKeys.includes(threadKey),
          confirmThreadDelete: appSettingsConfirmThreadDelete,
        }),
        position,
      );
```

- replace

```ts
      if (clicked === "update") {
        if (!threadWorkspacePath || !workspaceActionsAvailable) return;
```

  with

```ts
      if (clicked === "pull") {
        if (!threadWorkspacePath || !workspaceActionsAvailable) return;
```

  and, in the same branch, `title: "Failed to update",` with `title: "Failed to pull",` (after edit (g) this is the only remaining occurrence);

- insert before `      if (clicked === "copy-thread-id") {`:

```ts
      if (clicked === "copy-branch-name") {
        if (branchName !== null) {
          copyBranchNameToClipboard(branchName, { branch: branchName });
        }
        return;
      }
```

- in its dependency list replace

```ts
      copyPathToClipboard,
      copyThreadIdToClipboard,
```

  with

```ts
      copyBranchNameToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/Sidebar.test.tsx src/components/sidebar/sidebarMenus.logic.test.ts`
Expected: PASS except the two discovery-label assertions at `Sidebar.test.tsx:~2242` and `~2279`, which Task 7 updates.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 7: Review**

Check the changed callbacks against `vercel-react-best-practices` (dependency lists are complete; `displayedBranch` is a primitive, so `handleRowContextMenu` stays stable while the branch is) and the menu copy against `UI.md` (verb labels, ellipsis only for dialogs and inline edits, "Failed to pull" names what failed). Record both.

- [ ] **Step 8: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx`.

## Task 7: Project header ⋯, New Worktree…, hidden-worktree count and motion-guard anchor

**Files:**
- Modify: `apps/web/src/components/Sidebar.logic.ts` (add `contextMenuAnchorForRect`)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/WorktreeDiscoverySection.tsx` (props; `PhysicalWorktreeDiscoverySection`; `WorktreeDiscoverySection`)
- Test: `apps/web/src/components/WorktreeDiscoverySection.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (imports; `SidebarProjectItem` props, refs, `handleProjectButtonContextMenu`, `createMainChatForProjectMember`, `handleCreateThreadClick`, hover strip, discovery wiring; `SidebarProjectsContent`; `Sidebar`)
- Test: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/desktop/e2e/support/motion-guard.ts` (lines 28–33)
- Test: `apps/desktop/e2e/support/ui-state.test.ts` (line ~150)

**Interfaces:**
- Consumes: `buildProjectHeaderMenu`, `parseProjectHeaderSelection` (Task 5).
- Produces:
  - `contextMenuAnchorForRect(rect: Pick<DOMRect, "left" | "bottom">): { x: number; y: number }` — the element's rounded bottom-left (ruling 1); step 2 reuses it for Shift+F10.
  - `WorktreeDiscoverySectionProps.onHiddenCountChange?: (count: number | null) => void` — the total hidden candidates across the project's supported members while mounted and loaded, `null` otherwise.
  - Test ids: `project-actions-button` (the ⋯), `sidebar-projects-group` (the projects `SidebarGroup`); `new-main-chat-button` no longer exists.
  - `SidebarProjectItemProps` and `SidebarProjectsContentProps` lose `handleNewThread`.

- [ ] **Step 1: Write the failing tests**

(a) `apps/web/src/components/Sidebar.logic.test.ts`: add `contextMenuAnchorForRect,` to the import list and append:

```ts
describe("contextMenuAnchorForRect", () => {
  it("anchors a keyboard-opened menu at the element's rounded bottom-left", () => {
    expect(contextMenuAnchorForRect({ left: 40.4, bottom: 152.6 })).toEqual({ x: 40, y: 153 });
  });
});
```

(b) `apps/web/src/components/WorktreeDiscoverySection.test.tsx`: add inside `describe("WorktreeDiscoverySection", () => {`:

```ts
  it("reports the hidden candidate count while mounted and clears it on unmount", async () => {
    testState.catalogs.set(
      `${ENVIRONMENT_ID}:${PROJECT_ID}`,
      snapshot([
        candidate("/worktrees/one", "feature/one"),
        candidate("/worktrees/two", "feature/two"),
      ]),
    );
    const onHiddenCountChange = vi.fn();
    await mount(
      <WorktreeDiscoverySection
        project={project("hidden")}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
        onHiddenCountChange={onHiddenCountChange}
      />,
    );
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(2);

    await unmountLastMountedTree();
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(null);
  });

  it.each([
    { remoteLoaded: false, expected: null },
    { remoteLoaded: true, expected: 3 },
  ])("reports a grouped count only when all members are known: %j", async ({ remoteLoaded, expected }) => {
    testState.catalogs.set(`${ENVIRONMENT_ID}:${PROJECT_ID}`, snapshot([
      candidate("/wt/one", "one"), candidate("/wt/two", "two"),
    ]));
    if (remoteLoaded) {
      testState.catalogs.set(`${REMOTE_ENVIRONMENT_ID}:${REMOTE_PROJECT_ID}`, snapshot([
        candidate("/wt/remote", "remote"),
      ]));
    }
    const onHiddenCountChange = vi.fn();
    await mount(
      <WorktreeDiscoverySection
        project={groupedProject("hidden", "hidden")}
        serverConfigs={groupedServerConfigs()}
        onNavigateToThread={testState.navigate}
        onHiddenCountChange={onHiddenCountChange}
      />,
    );
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(expected);
    if (!remoteLoaded) expect(onHiddenCountChange.mock.calls.every(([count]) => count === null)).toBe(true);
    await unmountLastMountedTree();
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(null);
  });

  it("counts a known shown member as zero alongside a hidden member", async () => {
    testState.catalogs.set(`${ENVIRONMENT_ID}:${PROJECT_ID}`, snapshot([candidate("/wt/local", "local")]));
    testState.catalogs.set(`${REMOTE_ENVIRONMENT_ID}:${REMOTE_PROJECT_ID}`, snapshot([candidate("/wt/remote", "remote")]));
    const onHiddenCountChange = vi.fn();
    await mount(
      <WorktreeDiscoverySection
        project={groupedProject("hidden", "shown")}
        serverConfigs={groupedServerConfigs()}
        onNavigateToThread={testState.navigate}
        onHiddenCountChange={onHiddenCountChange}
      />,
    );
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(1);
  });

  it("reports zero hidden worktrees while discovery is shown", async () => {
    testState.catalogs.set(
      `${ENVIRONMENT_ID}:${PROJECT_ID}`,
      snapshot([candidate("/worktrees/one", "feature/one")]),
    );
    const onHiddenCountChange = vi.fn();
    await mount(
      <WorktreeDiscoverySection
        project={project("shown")}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
        onHiddenCountChange={onHiddenCountChange}
      />,
    );
    expect(onHiddenCountChange).toHaveBeenLastCalledWith(0);
  });
```

(c) `apps/desktop/e2e/support/ui-state.test.ts`: in `it("settles auto-animated project rows without overriding unrelated content"`, replace:

```ts
    expect(configuration).toMatch(
      /\[data-slot="sidebar-group"\]:has\(\[data-testid="new-main-chat-button"\]\)\s+ul\[data-sidebar="menu"\]\s*>\s*li\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
```

with:

```ts
    expect(configuration).toMatch(
      /\[data-slot="sidebar-group"\]\[data-testid="sidebar-projects-group"\]\s+ul\[data-sidebar="menu"\]\s*>\s*li\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
    expect(configuration).not.toContain("new-main-chat-button");
```

(d) `apps/web/src/components/Sidebar.test.tsx`:

1. In `staticDescribe("project header context menu", () => {`, every predicate of the form `item.id.startsWith("…")` must tolerate separators, which have no `id`. Replace `item.id.startsWith(` with `item.id?.startsWith(` in these tests: "copies the project path", "opens the rename and grouping dialogs from the menu" (two), "removes an empty project after confirmation", "aborts project removal when the confirmation is declined", "toasts when project removal fails", and "warns before force-removing a project with threads…".
2. In "toggles hidden and shown discovered worktrees from the project menu", replace `expect(visibility?.label).toBe("Show hidden worktrees");` with `expect(visibility?.label).toBe("Show Hidden Worktrees");` and `expect(visibility?.label).toBe("Hide discovered worktrees");` with `expect(visibility?.label).toBe("Hide Discovered Worktrees");`. (Static rendering runs no effects, so the discovery section never reports a count here.)
3. Add at the end of that describe:

```ts
  it("opens the same menu from the ⋯ button, anchored below it", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    const actions = mustFindProps(byTestId("project-actions-button"), "project actions button");
    const click = mouseEvent({
      currentTarget: {
        getBoundingClientRect: () => ({ left: 300.4, top: 96, right: 324, bottom: 120.6 }),
      },
    });
    invoke(actions, "onClick", click);
    await flush();

    expect(click.preventDefault).toHaveBeenCalled();
    expect(click.stopPropagation).toHaveBeenCalled();
    const [items, position] = h.spies.contextMenuShow.mock.calls[0]!;
    expect(position).toEqual({ x: 300, y: 121 });
    expect(
      (items as Array<{ label?: string; separator?: true }>).map((entry) =>
        entry.separator ? "---" : entry.label,
      ),
    ).toEqual([
      "New Worktree…",
      "---",
      "Rename…",
      "Group into…",
      "Copy Path",
      "---",
      "Archived Threads",
      "---",
      "Remove Project…",
    ]);
  });


```

The creation test must mount React so the dialog state can update. Add inside the existing browser-runtime describe (`if (browserRuntime)`); run the happy-dom command below so it executes:

```tsx
  it("starts worktree creation from New Worktree… for the selected project", async () => {
    baseScenario();
    h.state.sidebarCtx = { isMobile: true, setOpenMobile: h.spies.setOpenMobile };
    fakeLocalApi();
    const { container, root } = await mount(<Sidebar />);
    h.spies.contextMenuShow.mockResolvedValue(`new-worktree:${derivePhysicalProjectKey(projectA)}`);
    try {
      const actions = requiredElement<HTMLButtonElement>(container, '[data-testid="project-actions-button"]');
      await dispatch(actions, new MouseEvent("click", { bubbles: true, cancelable: true }));
      await React.act(async () => flush());
      expect(h.spies.setOpenMobile).toHaveBeenCalledWith(false);
      expect(captured("CreateWorktreeDialog").at(-1)?.props).toMatchObject({
        open: true,
        defaultProjectRef: scopeProjectRef(projectA.environmentId, projectA.id),
      });
    } finally {
      await unmount(root, container);
    }
  });
```

4. In `staticDescribe("new thread entry points", () => {`:
   - replace the whole test `it("keeps the main-chat action invisible and uses the worktree icon", () => { … });` with:

```ts
  it("leads the hover strip with project actions and uses + for New worktree", () => {
    baseScenario();
    const markup = render(<Sidebar />);

    expect(findProps(byTestId("new-main-chat-button"))).toBeNull();
    const actions = mustFindProps(byTestId("project-actions-button"), "project actions button");
    expect(actions["aria-label"]).toBe("Project actions for Repo A");
    expect(actions["aria-haspopup"]).toBe("menu");
    expect(markup).toContain("lucide-ellipsis");
    expect(markup).toContain("lucide-plus");
    expect(markup).not.toContain("lucide-folder-git-2");
    expect(markup.indexOf("lucide-ellipsis")).toBeLessThan(markup.indexOf("lucide-plus"));
    expect(markup).toContain('data-testid="sidebar-projects-group"');
  });
```

   - delete the tests `it("creates a main-branch chat for a single-member project", …)` and `it("closes the mobile sheet before creating a main-branch chat", …)`;
   - replace the whole test `it("renders both actions in the project row and removes them from the Projects toolbar", () => { … });` with:

```ts
  it("renders the project actions in the project row and not in the Projects toolbar", () => {
    baseScenario();
    render(<Sidebar />);

    expect(findProps(byTestId("sidebar-new-main-chat-trigger"))).toBeNull();
    expect(findProps(byTestId("sidebar-new-worktree-trigger"))).toBeNull();
    expect(findProps(byAriaLabel("New main-branch chat in Repo A"))).toBeNull();
    expect(mustFindProps(byAriaLabel("Project actions for Repo A"), "row actions")).toBeDefined();
    expect(mustFindProps(byAriaLabel("New worktree in Repo A"), "row worktree")).toBeDefined();
    expect(mustFindProps(byAriaLabel("Git Manager for Repo A"), "row Git Manager")).toBeDefined();
  });
```

5. In `staticDescribe("grouped and remote projects", () => {`:
   - delete `it("uses a member picker when creating a main-branch chat in a grouped project", …)` (the Git Manager member test right after it covers the picker);
   - replace `it("does not create a grouped-project chat when its picker is unavailable or cancelled", async () => { … });` with:

```ts
  it("does not navigate when the grouped-project picker is unavailable or cancelled", async () => {
    groupedScenario();
    render(<Sidebar />);
    const gitManager = mustFindProps(byTestId("git-manager-button"), "Git Manager button");
    invoke(gitManager, "onClick", mouseEvent());
    await flush();
    expect(h.spies.navigate).not.toHaveBeenCalled();

    fakeLocalApi();
    h.spies.contextMenuShow.mockResolvedValue(null);
    invoke(gitManager, "onClick", mouseEvent());
    await flush();
    h.spies.contextMenuShow.mockResolvedValue("missing-member");
    invoke(gitManager, "onClick", mouseEvent());
    await flush();
    expect(h.spies.navigate).not.toHaveBeenCalled();
  });
```

   - in `it("uses workspace paths when grouped members have no environment label"`, `it("uses a generic message for opaque member-picker failures"` and `it("toasts when the environment picker fails"`, replace `const newThread = mustFindProps(byTestId("new-main-chat-button"), "new main chat button");` with `const newThread = mustFindProps(byTestId("git-manager-button"), "Git Manager button");`. The picker behaviour they assert is shared by every project action.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/WorktreeDiscoverySection.test.tsx src/components/Sidebar.test.tsx`
Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`
Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run apps/desktop/e2e/support/ui-state.test.ts`
Expected: FAIL — no `contextMenuAnchorForRect`, no `onHiddenCountChange`, no ⋯ button or projects-group test id, and the motion guard still anchors on the placeholder.

- [ ] **Step 3: Add `contextMenuAnchorForRect`**

In `apps/web/src/components/Sidebar.logic.ts`, add after `isContextMenuPointerDown`:

```ts
/** Where a menu opened from the keyboard or a button appears: the element's bottom-left. */
export function contextMenuAnchorForRect(rect: Pick<DOMRect, "left" | "bottom">): {
  x: number;
  y: number;
} {
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}
```

- [ ] **Step 4: Report the hidden count from the discovery section**

In `apps/web/src/components/WorktreeDiscoverySection.tsx`:

(a) Add to `WorktreeDiscoverySectionProps`:

```ts
  /**
   * Receives the number of hidden discovered worktrees across the project's
   * supported members while the section is mounted and loaded, and null
   * otherwise, so the project menu can label "Show Hidden Worktrees (N)"
   * without starting a query of its own.
   */
  readonly onHiddenCountChange?: (count: number | null) => void;
```

(b) Add `readonly onHiddenCountChange: (physicalProjectKey: string, count: number | null) => void;` to `PhysicalWorktreeDiscoverySection`'s props type, destructure it (`const { member, serverConfig, primaryEnvironmentId, onNavigateToThread, onHiddenCountChange } = props;`), and add right after the `allCandidates` `useMemo`:

```ts
  const hiddenCount =
    snapshot === null || discovery === null
      ? null
      : member.worktreeDiscovery.visibility === "hidden"
        ? allCandidates.length
        : 0;
  useEffect(() => {
    onHiddenCountChange(member.physicalProjectKey, hiddenCount);
    return () => onHiddenCountChange(member.physicalProjectKey, null);
  }, [hiddenCount, member.physicalProjectKey, onHiddenCountChange]);
```

It sits above the component's early `return null`, so the hook order is stable.

(c) In `WorktreeDiscoverySection`, destructure the new prop (`const { project, serverConfigs, primaryEnvironmentId = null, onNavigateToThread, onHiddenCountChange } = props;`), add before `if (supportedMembers.length === 0) {`:

```ts
  const hiddenCountsRef = useRef(new Map<string, number>());
  const reportMemberHiddenCount = useCallback(
    (physicalProjectKey: string, count: number | null) => {
      const counts = hiddenCountsRef.current;
      if (count === null) {
        counts.delete(physicalProjectKey);
      } else {
        counts.set(physicalProjectKey, count);
      }
      let total = 0;
      for (const member of supportedMembers) {
        const memberCount = counts.get(member.physicalProjectKey);
        if (memberCount === undefined) {
          onHiddenCountChange?.(null);
          return;
        }
        total += memberCount;
      }
      onHiddenCountChange?.(supportedMembers.length === 0 ? null : total);
    },
    [onHiddenCountChange, supportedMembers],
  );
```

and pass `onHiddenCountChange={reportMemberHiddenCount}` to each `<PhysicalWorktreeDiscoverySection … />`.

- [ ] **Step 5: Replace the placeholder with ⋯ in `Sidebar.tsx`**

(a) Imports: in the `lucide-react` import list remove `FolderGit2Icon,` and `MessageSquarePlusIcon,`, and add `EllipsisIcon,` and `PlusIcon,` (keep the list alphabetical). Remove `type ContextMenuItem,` from the `@bibcode/contracts` import (it has no remaining use). Replace `import { getDiscoveryVisibilityMenuLabel } from "./WorktreeDiscoverySection.logic";` with nothing (delete the line). Add `contextMenuAnchorForRect,` to the `from "./Sidebar.logic";` list, and extend the Task 6 import to:

```ts
import {
  buildMultiSelectMenu,
  buildPrimaryCardMenu,
  buildProjectHeaderMenu,
  buildWorkspaceCardMenu,
  parseProjectHeaderSelection,
} from "./sidebar/sidebarMenus.logic";
```

Delete `import { useNewThreadHandler } from "../hooks/useHandleNewThread";`.

(b) Remove the `handleNewThread` prop chain:
   - in `interface SidebarProjectItemProps`, delete `  handleNewThread: ReturnType<typeof useNewThreadHandler>;`;
   - in `SidebarProjectItem`'s props destructuring, delete `    handleNewThread,`;
   - in `interface SidebarProjectsContentProps`, delete `  handleNewThread: ReturnType<typeof useNewThreadHandler>;`;
   - in `SidebarProjectsContent`'s destructuring, delete `    handleNewThread,`;
   - delete both `handleNewThread={handleNewThread}` JSX attributes inside `SidebarProjectsContent` (the sortable and the plain project list);
   - in `Sidebar`, delete `  const handleNewThread = useNewThreadHandler();` and the `handleNewThread={handleNewThread}` attribute on `<SidebarProjectsContent`.

(c) In `SidebarProjectItem`, add after `const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());`:

```ts
  // Hidden discovered-worktree count reported by the mounted discovery section;
  // null while the section is unmounted (collapsed project) or not loaded. A ref,
  // because only the project menu reads it, when it opens.
  const discoveryHiddenCountRef = useRef<number | null>(null);
  const handleDiscoveryHiddenCountChange = useCallback((count: number | null) => {
    discoveryHiddenCountRef.current = count;
  }, []);
```

(d) Delete the whole `handleProjectButtonContextMenu` declaration (from `  const handleProjectButtonContextMenu = useCallback(` through the end of its `useCallback(…)` call, just before `  const navigateToThread = useCallback(`).

(e) Delete the `createMainChatForProjectMember` declaration and the `handleCreateThreadClick` declaration (each a whole `useCallback(…)`).

(f) Insert after the `handleCreateWorktreeClick` declaration (it must come after `openWorktreeForProjectMember`, which the menu uses):

```ts
  const openProjectHeaderMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const discoveryVisibility = supportedWorktreeDiscoveryMembers.some(
        (member) => member.worktreeDiscovery.visibility === "shown",
      )
        ? "shown"
        : "hidden";
      const clicked = await api.contextMenu.show(
        buildProjectHeaderMenu({
          members: project.memberProjects.map((member) => ({
            physicalProjectKey: member.physicalProjectKey,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
          })),
          discovery:
            supportedWorktreeDiscoveryMembers.length > 0
              ? { visibility: discoveryVisibility, hiddenCount: discoveryHiddenCountRef.current }
              : null,
        }),
        position,
      );
      if (!clicked) return;

      if (clicked === "archive") {
        setOpenMobile(false);
        await router.navigate({ to: "/settings/archived" });
        return;
      }

      if (clicked === "worktree-discovery-visibility") {
        const nextVisibility = discoveryVisibility === "hidden" ? "shown" : "hidden";
        const results = await Promise.all(
          supportedWorktreeDiscoveryMembers.map((member) =>
            updateWorktreeDiscoveryPolicy({
              environmentId: member.environmentId,
              input: {
                commandId: newCommandId(),
                projectId: member.id,
                visibility: nextVisibility,
              },
            }),
          ),
        );
        for (const [index, result] of results.entries()) {
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) continue;
          const member = supportedWorktreeDiscoveryMembers[index]!;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not update worktree visibility for ${member.environmentLabel ?? member.title}`,
              description:
                error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        }
        return;
      }

      const selection = parseProjectHeaderSelection(clicked);
      const member = selection
        ? project.memberProjects.find(
            (candidate) => candidate.physicalProjectKey === selection.physicalProjectKey,
          )
        : undefined;
      if (!selection || !member) return;
      switch (selection.action) {
        case "new-worktree":
          openWorktreeForProjectMember(member);
          return;
        case "rename":
          openProjectRenameDialog(member);
          return;
        case "grouping":
          openProjectGroupingDialog(member);
          return;
        case "copy-path":
          copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
          return;
        case "delete":
          await handleRemoveProject(member);
          return;
      }
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      openProjectGroupingDialog,
      openProjectRenameDialog,
      openWorktreeForProjectMember,
      project.groupedProjectCount,
      project.memberProjects,
      router,
      setOpenMobile,
      supportedWorktreeDiscoveryMembers,
      updateWorktreeDiscoveryPolicy,
    ],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void openProjectHeaderMenu({ x: event.clientX, y: event.clientY });
    },
    [openProjectHeaderMenu, suppressProjectClickForContextMenuRef],
  );

  // ⋯ is a real button, so Enter and Space open it too; the menu appears below it.
  const handleProjectActionsClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void openProjectHeaderMenu(
        contextMenuAnchorForRect(event.currentTarget.getBoundingClientRect()),
      );
    },
    [openProjectHeaderMenu],
  );
```

(g) In the hover strip, replace the placeholder's whole `<Tooltip>…</Tooltip>` element (the one containing `data-testid="new-main-chat-button"`) with:

```tsx
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Project actions for ${project.displayName}`}
                  aria-haspopup="menu"
                  data-testid="project-actions-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onClick={handleProjectActionsClick}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Project actions</TooltipPopup>
          </Tooltip>
```

and in the New worktree tooltip replace `<FolderGit2Icon className="size-3.5" />` with `<PlusIcon className="size-3.5" />`.

(h) Pass the count callback: in the JSX, change `<WorktreeDiscoverySection` to add `onHiddenCountChange={handleDiscoveryHiddenCountChange}` after `onNavigateToThread={navigateToThread}`.

(i) In `SidebarProjectsContent`, replace `      <SidebarGroup className="px-2 py-2">` (the projects group, the one followed by the "Projects" label) with `      <SidebarGroup className="px-2 py-2" data-testid="sidebar-projects-group">`.

- [ ] **Step 6: Move the motion guard's anchor**

In `apps/desktop/e2e/support/motion-guard.ts`, replace:

```ts
        `
    [data-slot="sidebar-group"]:has([data-testid="new-main-chat-button"])
      ul[data-sidebar="menu"] > li {
      opacity: 1 !important;
      transform: none !important;
    }`,
```

with:

```ts
        `
    [data-slot="sidebar-group"][data-testid="sidebar-projects-group"]
      ul[data-sidebar="menu"] > li {
      opacity: 1 !important;
      transform: none !important;
    }`,
```

- [ ] **Step 7: Run the tests and typechecks**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/WorktreeDiscoverySection.test.tsx src/components/WorktreeDiscoverySection.logic.test.ts src/components/sidebar/sidebarMenus.logic.test.ts src/components/Sidebar.test.tsx`
Expected: PASS (the Task 5 label failures are gone too).

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run apps/desktop/e2e/support/ui-state.test.ts apps/desktop/e2e/support/motion-guard.test.ts`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`
Expected: PASS, including mounted dialog/card regressions.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck && vp check`
Expected: both exit 0 for this step's files (record other agents' failures without touching them).

- [ ] **Step 8: Review**

`vercel-react-best-practices`: `discoveryHiddenCountRef` avoids re-rendering the project item on every discovery update; the new callbacks list complete dependencies; `openProjectHeaderMenu` is declared after everything it closes over. `UI.md`: project actions are now visible, not right-click-only (lines 111, 157); the 24 px hover-strip targets stay (line 224); the icon change matches `docs/user/workspace-ui.md:61`. Record both.

- [ ] **Step 9: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/WorktreeDiscoverySection.tsx apps/web/src/components/WorktreeDiscoverySection.test.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/desktop/e2e/support/motion-guard.ts apps/desktop/e2e/support/ui-state.test.ts`.

## Task 8: Step 1 living docs and runbooks

**Files:**
- Modify: `docs/architecture/overview.md` (line ~160, one phrase)
- Modify: `docs/user/workspace-ui.md` (the paragraphs at lines ~94–102)
- Modify: `docs/testing/cross-platform-validation.md` (packaged visual list, after the "discovered and adopted external worktrees" bullet, line ~1827)
- Modify: `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md` ("Packaged UI scenarios" lists)
- Modify: `docs/superpowers/specs/2026-08-02-project-toolbar-actions-design.md` (superseded note)

**Interfaces:** documentation only; it describes Tasks 1–7.

- [ ] **Step 1: Architecture overview**

In `docs/architecture/overview.md`, replace `(chat header, Sidebar Update, Source Control panel, or the Git Manager's` with `(chat header, Sidebar Pull, Source Control panel, or the Git Manager's`. Touch nothing else; track A edits another paragraph of this file.

- [ ] **Step 2: Workspace UI menus**

In `docs/user/workspace-ui.md`, replace the two paragraphs that start `Clicking a project header selects it and toggles its thread list;` and `Workspace row context menus include update/open/copy/pin/unread actions, plus` (through `is omitted for remote environments and browser mode.`) with:

```markdown
Clicking a project header selects it and toggles its thread list; the header
stays highlighted as the selected node until you open a thread, and it is also
highlighted while that project's Git Manager or Pull Requests route is open.
Hovering or focusing a header shows **⋯** (project actions), **+** (New
worktree), **Git Manager** and, when enabled, **Pull Requests**.

Menus separate their groups:

- **Worktree row:** **Open in ›**, **Pull** · **Copy Path**, **Copy Branch
  Name**, **Copy Thread ID** · **Pin** or **Unpin**, **Mark as Unread** or
  **Mark as Read**, **Rename…** · **Delete Worktree…**. A thread without a
  worktree offers **Delete Thread** instead, with an ellipsis when deletion
  asks for confirmation.
- **Primary row (the main checkout):** **Open in ›**, **Pull** · **Copy Path**,
  **Copy Branch Name** · **Pin** or **Unpin**, **Mark as Unread** or **Mark as
  Read**. It can't be deleted; remove the project from its header instead.
- **Project header** (**⋯** or right-click): **New Worktree…** · **Rename…**,
  **Group into…**, **Copy Path** · **Show Hidden Worktrees (N)** or **Hide
  Discovered Worktrees**, **Archived Threads** · **Remove Project…**. N appears
  once the project is expanded. Grouped projects list their members in a
  submenu for the actions that target one member.
- **Several selected rows:** **Mark as Unread (N)** · **Delete (N)**.

**Pull** runs `git pull` in that checkout. **Copy Branch Name** copies the
branch the row shows and is left out when the row shows none. On the local
desktop environment, **Open in → File Explorer** opens the repository folder
for a primary row or the worktree folder for a worktree row; it is left out for
remote environments and browser mode.

The desktop app shows native menus on macOS and Linux. In the browser and on
Windows the menu opens inside the app: its first enabled item is focused, the
arrow keys move between items (skipping separators and disabled items),
**Home** and **End** jump to the ends, **→** and **←** open and close a
submenu, **Enter** or **Space** chooses, and **Escape** closes the menu and
returns focus to where you were.
```

This also fixes the old claim that primary rows offer "remove project"; that item has only ever been on the project header.

- [ ] **Step 3: Runbooks**

`docs/testing/cross-platform-validation.md` — in "Packaged visual validation", insert after the bullet `- discovered and adopted external worktrees;`:

```markdown
- sidebar menus and the project header's **⋯**: separators between groups in
  the native menus (macOS, Linux) and the in-app menu (Windows, browser), never
  two in a row and never at an edge; **Pull** and **Copy Branch Name** on
  worktree and primary rows; **Show Hidden Worktrees (N)** on an expanded
  project with discovery; and keyboard operation of the in-app menu;
```

`docs/testing/linux-desktop.md` — in "Packaged UI scenarios", insert after `- external worktree grouping, paths, actions, physical identity, and restart
  are correct;`:

```markdown
- sidebar menus: right-click a worktree row, the primary row and a project
  header, and open the header's **⋯** from the keyboard (Tab to it, then
  **Enter**). Each native menu separates Open in/Pull, the copy actions,
  Pin/Unread/Rename and the destructive item, with no doubled separator before
  **Delete Worktree…** or **Remove Project…**, and **⋯** shows the same items
  as the header's right-click menu;
```

`docs/testing/macos-desktop.md` — in "Packaged UI scenarios", insert the same bullet after `- external worktree grouping, full paths, actions, physical identity, and
  restart are correct;`.

`docs/testing/windows-desktop.md` — in "Packaged UI scenarios", insert after `- external worktrees group by parent, expose full paths accessibly, adopt
  idempotently through junction/case aliases, and persist across restart;`:

```markdown
- sidebar menus use the in-app menu: separators split the groups and are
  never doubled or at an edge. From the keyboard, focus starts on the first
  enabled item, the arrow keys skip separators and disabled items, **Home** and
  **End** jump to the ends, **→** and **←** open and close **Open in**,
  **Enter** or **Space** chooses, and **Escape** closes the menu and returns
  focus to the row or **⋯**;
```

`docs/testing/execution-report-template.md` and `docs/testing/README.md` need no change (reviewed; they remain accurate).

- [ ] **Step 4: Mark the old toolbar spec superseded**

In `docs/superpowers/specs/2026-08-02-project-toolbar-actions-design.md`, insert after the first line (`# Project Toolbar Actions Design`) and a blank line:

```markdown
> **Superseded on 2026-09-24** by
> [`2026-09-24-left-panel-workspace-cards-design.md`](./2026-09-24-left-panel-workspace-cards-design.md):
> the invisible main-branch chat button is gone, **⋯** (project actions) takes
> its place, and the New worktree action uses `+`.
```

- [ ] **Step 5: Verify the doc claims against the code**

Run: `cd /work/workspaces/orca/BibCode/main-3 && rg -n "Sidebar Update|remove project for primary|Show hidden worktrees|Hide discovered worktrees|Mark unread|Rename thread" docs --glob '!docs/plans/**' --glob '!docs/superpowers/**' --glob '!docs/testing/reports/**'`
Expected: no output.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp check`
Expected: exit 0 (`docs/superpowers/**` is excluded from formatting; the edited living docs are formatted Markdown).

- [ ] **Step 6: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- docs/architecture/overview.md docs/user/workspace-ui.md docs/testing/cross-platform-validation.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md docs/superpowers/specs/2026-08-02-project-toolbar-actions-design.md`.

## Task 9: Step 1 live verification (Playwright)

**Host-only execution:** Codex prepares/implements the tasks and scripts; the controller starts the isolated server and runs every live command on the host. Codex must not start servers or browsers: its sandbox blocks loopback. Missing host results remain unavailable evidence, never a pass.

Browser mode always uses the web fallback menu, so this checks the fallback's separators and keys on real data. Native menus can't be driven by Playwright; the Rust tests (Task 2) and the Linux/macOS runbook items (Task 8) cover them.

**Files:**
- Create (scratch, outside the repository): `$S/leftpanel-live/lib.mjs`, `$S/leftpanel-live/setup.mjs`, `$S/leftpanel-live/step1-menus.mjs`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: an isolated dev server and fixture data under `$S/leftpanel-live`, reused by Tasks 19 and 22; `lib.mjs` exports `L`, `WEB`, `SERVER`, `origin`, `launch()`, `pair()`, `rpc()`, `nowIso()`, `newId()`.

- [ ] **Step 1: Start an isolated dev server**

Pick an unused offset. This plan uses 157 (server `13773 + 157 = 13930`, web `5733 + 157 = 5890`); check it first and pick another if either port is taken:

```bash
ss -ltn '( sport = :13930 or sport = :5890 )'
```

Expected: only the header line. Then:

```bash
export S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad
export L=$S/leftpanel-live
mkdir -p $L/home $L/repos $L/shots $L/logs
ln -sfn $S/pw/node_modules $L/node_modules
cd /work/workspaces/orca/BibCode/main-3
setsid bash -c 'echo $$ > "$L/logs/dev.pgid"; exec env BIBCODE_PORT_OFFSET=157 BIBCODE_HOME="$L/home" vp run dev' > "$L/logs/dev.log" 2>&1 < /dev/null &
```

`setsid` records the real group leader inside the child, before exec; `$!` from a backgrounded `cd … && …` shell is not that identity. Do not overwrite an existing live run's record. On the host, run `test -s "$L/logs/dev.pgid" && ps -o pid=,pgid=,sid=,args= -p "$(cat "$L/logs/dev.pgid")"` once startup is recorded; expect PID, PGID and SID to equal the recorded number, with the dev runner command. Task 22 stops exactly this group. Wait (with the Monitor tool and an until-loop, not a foreground `sleep`) until `grep -q '"pairingUrl"' $L/logs/dev.log` succeeds and the log shows `Local:   http://localhost:5890/`. The first run compiles the server and can wait on Cargo's build-directory lock while track A builds.

Save the startup token without printing it:

```bash
grep -o '"token":"[^"]*"' $L/logs/dev.log | tail -1 | cut -d'"' -f4 > $L/.token && chmod 600 $L/.token && test -s $L/.token && echo "token saved"
```

Expected: `token saved`.

- [ ] **Step 2: Create the fixture repositories**

These mirror the projects in `Main.dc.html`:

```bash
R=$L/repos
G="git -c user.name=Fixture -c user.email=fixture@example.invalid"
for spec in customer-portal:develop pathfinder-application-server:alpha pathfinder-docker-manager:master agent-bridges:main; do
  name=${spec%%:*}; branch=${spec##*:}
  $G init -q -b "$branch" "$R/$name" && $G -C "$R/$name" commit -q --allow-empty -m "Initial commit"
done
$G -C $R/customer-portal worktree add -q -b fix-TRI-150 $R/wt/fix-TRI-150
$G -C $R/customer-portal worktree add -q -b chore/pdf-renderer $R/wt/pdf-renderer
$G -C $R/pathfinder-application-server worktree add -q -b feature/search-index $R/wt/search-index
$G -C $R/pathfinder-docker-manager worktree add -q -b chore/pin-images $R/wt/pin-images
$G -C $R/pathfinder-docker-manager worktree add -q -b plan/queue $R/wt/queue
echo "invoice fix in progress" > $R/wt/fix-TRI-150/NOTES.md
```

The last line leaves the "Fix invoice date format" worktree dirty on purpose.

- [ ] **Step 3: Write the shared helpers**

Create `$S/leftpanel-live/lib.mjs`:

```js
// Shared helpers for the left-panel live checks. Secrets are read from files and never printed.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

export const L = process.env.L;
export const WEB = process.env.WEB ?? "5890";
export const SERVER = process.env.SERVER ?? "13930";
export const origin = `http://localhost:${WEB}`;

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function launch({ dark = false, width = 1400, height = 980, profile = "profile" } = {}) {
  const context = await chromium.launchPersistentContext(`${L}/${profile}`, {
    headless: true,
    viewport: { width, height },
    colorScheme: dark ? "dark" : "light",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

export async function pair(page) {
  const token = readFileSync(`${L}/.token`, "utf8").trim();
  await page.goto(`${origin}/pair#token=${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
}

/**
 * Sends one RPC request on a private socket authorised by the page's session
 * cookie. The app's own socket goes straight to the server port; Vite proxies
 * only /api, so the ticket comes from /api and the socket from the server port.
 */
export async function rpc(page, tag, payload) {
  return page.evaluate(
    async ({ tag, payload, serverPort }) => {
      const ticketResponse = await fetch("/api/auth/websocket-ticket", {
        method: "POST",
        credentials: "include",
      });
      if (!ticketResponse.ok) throw new Error(`ticket HTTP ${ticketResponse.status}`);
      const { ticket } = await ticketResponse.json();
      const socket = new WebSocket(
        `ws://127.0.0.1:${serverPort}/ws?wsTicket=${encodeURIComponent(ticket)}`,
      );
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("socket error"));
      });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout: ${tag}`)), 20_000);
          socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.requestId !== "1" || message._tag !== "Exit") return;
            clearTimeout(timer);
            if (message.exit?._tag === "Success") resolve(message.exit.value);
            else reject(new Error(`${tag}: ${JSON.stringify(message.exit?.cause ?? null).slice(0, 400)}`));
          };
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
        });
      } finally {
        socket.send(JSON.stringify({ _tag: "Eof" }));
        socket.close();
      }
    },
    { tag, payload, serverPort: SERVER },
  );
}
```

- [ ] **Step 4: Create the fixture projects and worktree threads**

Create `$S/leftpanel-live/setup.mjs`:

```js
// One-time fixture: four projects mirroring Main.dc.html, worktrees adopted
// through the real discovery UI ("Add all"), renamed to the mockup's titles.
// fixture.json records the project ids for Task 19's frame patcher.
import { writeFileSync } from "node:fs";
import { launch, newId, nowIso, origin, pair, rpc, L } from "./lib.mjs";

const R = `${L}/repos`;
const projects = [
  "customer-portal",
  "pathfinder-application-server",
  "pathfinder-docker-manager",
  "agent-bridges",
];
const titles = {
  "fix-TRI-150": "Fix invoice date format",
  "chore/pdf-renderer": "Upgrade PDF renderer",
  "feature/search-index": "Search index rebuild",
  "chore/pin-images": "Pin base images",
  "plan/queue": "Queue migration plan",
};

const { context, page } = await launch();
await pair(page);
const projectIds = {};
for (const name of projects) {
  const requestedId = newId("project");
  const result = await rpc(page, "orchestration.dispatchCommand", {
    type: "project.create",
    commandId: newId("cmd"),
    projectId: requestedId,
    title: name,
    workspaceRoot: `${R}/${name}`,
    createdAt: nowIso(),
  });
  projectIds[name] = typeof result?.projectId === "string" ? result.projectId : requestedId;
}
writeFileSync(`${L}/fixture.json`, JSON.stringify({ projectIds }, null, 2));
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="sidebar-projects-group"]', { timeout: 60_000 });

const addAll = page.getByRole("button", { name: "Add all discovered worktrees" });
for (let waited = 0; waited < 30_000 && (await addAll.count()) < 3; waited += 500) {
  await page.waitForTimeout(500);
}
while ((await addAll.count()) > 0) {
  await addAll.first().click();
  await page.waitForTimeout(2_000);
}

const rows = await page.$$eval('[data-testid^="thread-row-"]', (nodes) =>
  nodes.map((node) => ({
    id: node.getAttribute("data-testid").slice("thread-row-".length),
    text: node.textContent ?? "",
  })),
);
for (const [branch, title] of Object.entries(titles)) {
  const row = rows.find((candidate) => candidate.text.includes(branch));
  if (!row) throw new Error(`No adopted row shows ${branch}`);
  await rpc(page, "orchestration.dispatchCommand", {
    type: "thread.meta.update",
    commandId: newId("cmd"),
    threadId: row.id,
    title,
  });
}
console.log(`adopted and renamed ${Object.keys(titles).length} worktree threads`);
await context.close();
```

Run it, then add one more worktree that stays hidden, and hide it through the UI:

```bash
cd $L && L=$L node setup.mjs
git -c user.name=Fixture -c user.email=fixture@example.invalid -C $L/repos/pathfinder-application-server worktree add -q -b feature/hidden $L/repos/wt/hidden
cd $L && L=$L node --input-type=module -e '
import { launch, origin } from "./lib.mjs";
const { context, page } = await launch();
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
const keep = page.getByRole("button", { name: "Keep hidden" });
await keep.first().waitFor({ timeout: 30_000 });
await keep.first().click();
await page.getByText("Hiding 1 discovered worktree").waitFor({ timeout: 15_000 });
console.log("hidden worktree acknowledged");
await context.close();
'
```

Expected: `adopted and renamed 5 worktree threads` and `hidden worktree acknowledged`. If a selector differs from this plan, fix the script, not the product, and note it in the ledger.

- [ ] **Step 5: Write the step-1 menu check**

Create `$S/leftpanel-live/step1-menus.mjs`:

```js
// Step 1 live check: separators, Title Case copy, ⋯ keyboard access and the fallback keys.
import { writeFileSync } from "node:fs";
import { L, launch, origin } from "./lib.mjs";

const dark = process.env.DARK === "1";
const theme = dark ? "dark" : "light";
const failures = [];
const results = {};
const check = (name, condition, detail) => {
  results[name] = { pass: Boolean(condition), detail };
  if (!condition) failures.push(name);
};

const { context, page } = await launch({ dark });
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="sidebar-projects-group"]', { timeout: 60_000 });
await page.waitForTimeout(2_000);
const shot = (name) => page.screenshot({ path: `${L}/shots/step1-${theme}-${name}.png` });

const menuOutline = () =>
  page.$$eval('[role="menu"]', (menus) =>
    menus.map((menu) =>
      Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((node) =>
        node.getAttribute("role") === "separator" ? "---" : (node.textContent ?? "").replace(/>$/, "").trim(),
      ),
    ),
  );
const focused = () => page.evaluate(() => (document.activeElement?.textContent ?? "").replace(/>$/, "").trim());
const focusedTestId = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

// 1. The hover strip leads with ⋯ and uses + for New worktree.
const header = page.locator('button[data-sidebar="menu-button"]', { hasText: "customer-portal" });
await header.hover();
// Base UI tooltip triggers render the buttons directly, so the strip's first button is ⋯.
const firstInStrip = await page.$eval(
  '[data-testid="project-actions-button"]',
  (button) => button.parentElement?.querySelector("button") === button,
);
check("⋯ is the first hover-strip button", firstInStrip);
check(
  "New worktree uses the plus icon",
  (await page.locator('[data-testid="new-worktree-button"] svg.lucide-plus').count()) > 0,
);
await shot("header-hover");

// 2. ⋯ from the keyboard: first item focused, arrows skip separators, Escape returns focus.
await page.locator('[data-testid="project-actions-button"]').first().focus();
await page.keyboard.press("Enter");
await page.waitForSelector('[role="menu"]');
const projectMenu = (await menuOutline())[0] ?? [];
check("project menu groups", JSON.stringify(projectMenu.filter((item) => item !== "---").slice(0, 4)) === JSON.stringify(["New Worktree…", "Rename…", "Group into…", "Copy Path"]), projectMenu);
check("project menu separators", projectMenu.filter((item) => item === "---").length === 3, projectMenu);
check("first item focused", (await focused()) === "New Worktree…", await focused());
await page.keyboard.press("ArrowDown");
check("ArrowDown skips the separator", (await focused()) === "Rename…", await focused());
await page.keyboard.press("End");
check("End reaches Remove Project…", (await focused()) === "Remove Project…", await focused());
await shot("project-menu-keyboard");
await page.keyboard.press("Escape");
check("Escape closes the menu", (await page.locator('[role="menu"]').count()) === 0);
check("Escape returns focus to ⋯", (await focusedTestId()) === "project-actions-button", await focusedTestId());

// 3. Worktree row menu, then Copy Branch Name from the keyboard.
const worktreeRow = page.locator('[data-testid^="thread-row-"]', { hasText: "Fix invoice date format" }).first();
await worktreeRow.click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const rowMenu = (await menuOutline())[0] ?? [];
check(
  "worktree row menu",
  JSON.stringify(rowMenu) ===
    JSON.stringify(["Open in", "Pull", "---", "Copy Path", "Copy Branch Name", "Copy Thread ID", "---", "Pin", "Mark as Unread", "Rename…", "---", "Delete Worktree…"]),
  rowMenu,
);
await shot("worktree-menu");
for (let step = 0; step < 8 && (await focused()) !== "Copy Branch Name"; step += 1) {
  await page.keyboard.press("ArrowDown");
}
await page.keyboard.press("Enter");
await page.getByText("Branch name copied").waitFor({ timeout: 5_000 });
check("Copy Branch Name copies the row's branch", (await page.evaluate(() => navigator.clipboard.readText())) === "fix-TRI-150");

// 4. The Open in submenu from the keyboard, when the host detected an editor.
await worktreeRow.click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const openInEnabled = (await page.locator('[role="menuitem"][aria-haspopup="menu"]:not([aria-disabled="true"])').count()) > 0;
if (openInEnabled) {
  check("Open in focused first", (await focused()) === "Open in", await focused());
  await page.keyboard.press("ArrowRight");
  check("ArrowRight opens Open in", (await page.locator('[role="menu"]').count()) === 2);
  await page.keyboard.press("ArrowLeft");
  check("ArrowLeft closes Open in", (await page.locator('[role="menu"]').count()) === 1);
  check("focus back on Open in", (await focused()) === "Open in", await focused());
} else {
  results["Open in submenu"] = { pass: true, detail: "no editor on PATH; submenu keys covered by contextMenuFallback.keyboard.test.ts" };
}
await page.keyboard.press("Escape");

// 5. Primary row menu.
await page.locator('//*[@data-thread-item="true"][.//span[normalize-space()="develop"]]').first().click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const primaryMenu = (await menuOutline())[0] ?? [];
check("primary row menu", JSON.stringify(primaryMenu) === JSON.stringify(["Open in", "Pull", "---", "Copy Path", "Copy Branch Name", "---", "Pin", "Mark as Unread"]), primaryMenu);
await page.keyboard.press("Escape");

// 6. The hidden-worktree count on an expanded project.
await page.locator('button[data-sidebar="menu-button"]', { hasText: "pathfinder-application-server" }).click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const hiddenMenu = (await menuOutline())[0] ?? [];
check("Show Hidden Worktrees (1)", hiddenMenu.includes("Show Hidden Worktrees (1)"), hiddenMenu);
await shot("hidden-count-menu");
await page.keyboard.press("Escape");

// 7. Multi-select menu.
const modifier = process.platform === "darwin" ? "Meta" : "Control";
await page.locator('[data-testid^="thread-row-"]', { hasText: "Fix invoice date format" }).first().click({ modifiers: [modifier] });
await page.locator('[data-testid^="thread-row-"]', { hasText: "Upgrade PDF renderer" }).first().click({ modifiers: [modifier] });
await page.locator('[data-testid^="thread-row-"]', { hasText: "Upgrade PDF renderer" }).first().click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const multiMenu = (await menuOutline())[0] ?? [];
check("multi-select menu", JSON.stringify(multiMenu) === JSON.stringify(["Mark as Unread (2)", "---", "Delete (2)"]), multiMenu);
await page.keyboard.press("Escape");

writeFileSync(`${L}/logs/step1-${theme}.json`, JSON.stringify(results, null, 2));
console.log(`step1 ${theme}: ${failures.length === 0 ? "PASS" : `FAIL ${failures.join(", ")}`}`);
await context.close();
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 6: Run it in light and dark**

```bash
cd $L && L=$L DARK=0 node step1-menus.mjs && L=$L DARK=1 node step1-menus.mjs
```

Expected: `step1 light: PASS` and `step1 dark: PASS`. Open (Read) `$L/shots/step1-*-project-menu-keyboard.png` and `step1-*-worktree-menu.png` and confirm by eye: separators are 1 px lines inset from the menu edges, the focused row is highlighted, the destructive item is red, and the dark menu uses the dark popover colours. Record the result lines, the JSON paths and what you saw in the ledger. Leave the dev server running for Tasks 19 and 22.

- [ ] **Step 7: Checkpoint (no commit)**

No repository files change in this task; run the checkpoint anyway so the ledger has a tree hash at the end of step 1:

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

# Step 2 — Workspace cards

Step 2 ships on its own: the primary and thread rows become cards with the status glyph, the branch/PR line, the session line and "N more chats", inside one memoised list. Tasks 10–14 add tested building blocks; Tasks 15–16 switch the sidebar over.

## Task 10: PR number prefix and the muted terminal indicator

**Files:**
- Inspect/reuse: `packages/shared/src/sourceControl.ts` (`formatChangeRequestNumber`; add only if no number/prefix helper exists after Step 0)
- Test: `packages/shared/src/sourceControl.test.ts` (reuse the PR round's coverage; add only missing cases)
- Modify: `apps/web/src/sourceControlPresentation.ts` (re-export list)
- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx` (`PrStatusIndicator`, `prStatusIndicator`, `TerminalStatusIndicator`, `terminalStatusFromRunningIds`, `ThreadStatusLabel`, `ThreadRowTrailingStatus`)
- Test: `apps/web/src/components/ThreadStatusIndicators.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (the old row's terminal icon, one line)

**Interfaces:**
- Consumes: the shared `formatChangeRequestNumber(provider: SourceControlProviderKind | null | undefined, number: number): string` from `@bibcode/shared/sourceControl` (`!` for GitLab, `#` otherwise; rulings 21 and M6), re-exported by `apps/web/src/sourceControlPresentation.ts`. This is the currently verified API; Step 0 rechecks the actual export before use.
- Produces:
  - `PrStatusIndicator.numberLabel: string` (`"!57"`, `"#12"`), and tooltips that use it (`"!57 MR open: …"`);
  - `TerminalStatusIndicator = { label: "Terminal process running"; colorClass: "text-muted-foreground" }` (no `pulse`).

`packages/shared/src/sourceControl.ts` and its tests are shared with the PR fix round. Follow **Coordination** in the execution protocol; do not change the helper's signature or presentation constants to fit the old plan.

- [ ] **Step 0: Inspect the shared number/prefix helper first**

Before writing tests or implementation, inspect the current exports, callers and tests:

```bash
rg -n 'formatChangeRequestNumber|numberPrefix|export (function|const)' packages/shared/src/sourceControl.ts packages/shared/src/sourceControl.test.ts apps/web/src/sourceControlPresentation.ts
rg -n 'formatChangeRequestNumber' apps/web/src
```

Re-read the matched source and test blocks. Verified anchors on 2026-09-24: `packages/shared/src/sourceControl.ts` exports `formatChangeRequestNumber` at ~108, taking the provider kind and number; `packages/shared/src/sourceControl.test.ts` has "formats request numbers using the shared provider terminology" at ~15. Reuse that export and test under the name/signature found. The snippets below use this current API. If the PR round has renamed it, use the found name consistently in the re-export, imports, calls and tests; do not add an alias. Only if no exported number/prefix helper exists may Step 3 add `formatChangeRequestNumber` in that same shared file. Recheck immediately before any shared-file edit.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/sourceControl.test.ts`: reuse the existing helper import and "formats request numbers using the shared provider terminology" test. It already covers GitLab, GitHub, Azure DevOps, Bitbucket, unknown and null; extend its provider array with `undefined` if still missing, keeping its terminology assertions. If that coverage is absent, add the helper import only if needed and add the following test inside `describe("source control presentation", () => {` (adapt the helper name/signature only to the export found in Step 0):

```ts
  it("prefixes change request numbers the way each host writes them", () => {
    expect(formatChangeRequestNumber("gitlab", 57)).toBe("!57");
    for (const provider of ["github", "azure-devops", "bitbucket", "unknown", null, undefined] as const) {
      expect(formatChangeRequestNumber(provider, 12)).toBe("#12");
    }
  });
```

`apps/web/src/components/ThreadStatusIndicators.test.tsx`:

- in "maps open, closed, merged, absent, and unknown change requests", replace

```ts
    expect(prStatusIndicator({ ...base, state: "open" }, github)).toMatchObject({
      label: "PR open",
      tooltip: "#42 PR open: Ship it",
    });
```

  with

```ts
    expect(prStatusIndicator({ ...base, state: "open" }, github)).toMatchObject({
      label: "PR open",
      numberLabel: "#42",
      tooltip: "#42 PR open: Ship it",
    });
```

  and replace

```ts
    expect(prStatusIndicator({ ...base, state: "merged" }, gitlab)).toMatchObject({
      label: "MR merged",
    });
```

  with

```ts
    expect(prStatusIndicator({ ...base, state: "merged" }, gitlab)).toMatchObject({
      label: "MR merged",
      numberLabel: "!42",
      tooltip: "!42 MR merged: Ship it",
    });
```

- in "maps running terminal IDs", replace the object in `toEqual({ … })` with `{ label: "Terminal process running", colorClass: "text-muted-foreground" }`;
- in "renders terminal and remote-environment trailing states", replace `expect(terminalOnly).toContain("animate-pulse");` with `expect(terminalOnly).not.toContain("animate-pulse");`;
- in "renders worktree and status labels in every display mode", after the `ThreadStatusLabel` non-compact assertion add:

```ts
    expect(
      renderToStaticMarkup(<ThreadStatusLabel status={{ ...status, pulse: false }} />),
    ).toContain("text-xs");
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run packages/shared/src/sourceControl.test.ts`
Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/ThreadStatusIndicators.test.tsx`
Expected: the shared helper tests PASS when the PR round's helper is present; if absent they FAIL until Step 3. The indicator tests FAIL — no `numberLabel`, the GitLab tooltip still says `#42`, the terminal is still teal and pulsing, and the label is still `text-[10px]`. Do not change a working shared helper to manufacture a red test.

- [ ] **Step 3: Reuse the shared helper and expose it to the indicators**

If Step 0 found an exported number/prefix helper, reuse it unchanged and skip adding one. Do not add `numberPrefix` to `ChangeRequestPresentation` or its constants.

Only if no such export exists after rechecking `packages/shared/src/sourceControl.ts`, add the following `formatChangeRequestNumber` after `formatChangeRequestAction` in that same file. `SourceControlProviderKind` is already in its top-level type import; keep the existing import. This is the same name and signature used by the PR round:

```ts
/** Formats a change request number the way its host writes it: `#12`, or `!57` on GitLab. */
export function formatChangeRequestNumber(
  provider: SourceControlProviderKind | null | undefined,
  number: number,
): string {
  return `${provider === "gitlab" ? "!" : "#"}${String(number)}`;
}
```

In `apps/web/src/sourceControlPresentation.ts`, re-export the helper found in Step 0 from `@bibcode/shared/sourceControl` only if not already exported. With the verified name, add `formatChangeRequestNumber,` after `formatChangeRequestAction,` in the existing export list.

- [ ] **Step 4: Use it in the indicators**

In `apps/web/src/components/ThreadStatusIndicators.tsx`:

- replace `import { resolveChangeRequestPresentation } from "../sourceControlPresentation";` with:

```ts
import {
  formatChangeRequestNumber,
  resolveChangeRequestPresentation,
} from "../sourceControlPresentation";
```

- replace the `PrStatusIndicator` and `TerminalStatusIndicator` interfaces with:

```ts
export interface PrStatusIndicator {
  label: string;
  /** The number as its host writes it: "!57" on GitLab, "#12" elsewhere. */
  numberLabel: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
}
```

- replace the body of `prStatusIndicator` (everything after its signature) with:

```ts
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const numberLabel = formatChangeRequestNumber(provider?.kind, pr.number);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      numberLabel,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `${numberLabel} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      numberLabel,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `${numberLabel} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      numberLabel,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `${numberLabel} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}
```

- replace `terminalStatusFromRunningIds`'s returned object with:

```ts
  // Muted and static: a running terminal is context, not an alert.
  return {
    label: "Terminal process running",
    colorClass: "text-muted-foreground",
  };
```

- in `ThreadStatusLabel`'s non-compact branch replace `` className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`} `` with `` className={`inline-flex items-center gap-1 text-xs ${status.colorClass}`} `` (`UI.md:171`; the file is touched);
- in `ThreadRowTrailingStatus` replace `` <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} /> `` with `<TerminalIcon className="size-3" />`.

In `apps/web/src/components/Sidebar.tsx` (the old thread row, replaced in Task 15), replace `` <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} /> `` with `<TerminalIcon className="size-3" />`.

- [ ] **Step 5: Run the tests and typechecks**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run packages/shared/src/sourceControl.test.ts`
Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/ThreadStatusIndicators.test.tsx src/components/Sidebar.test.tsx src/components/BranchToolbar.test.tsx`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/shared typecheck && vp run --filter @bibcode/web typecheck`
Expected: exit 0. (`@bibcode/shared` has a `typecheck` script: `tsc --noEmit`.)

- [ ] **Step 6: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- packages/shared/src/sourceControl.ts packages/shared/src/sourceControl.test.ts apps/web/src/sourceControlPresentation.ts apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx apps/web/src/components/Sidebar.tsx`.

## Task 11: The status-glyph resolver

**Files:**
- Modify: `apps/web/src/components/Sidebar.logic.ts` (pill colours → shared tones; add the card status resolver and priority)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`

**Interfaces:**
- Consumes: `resolveThreadStatusPill`, `hasUnseenCompletion` (existing).
- Produces:
  - `type WorkspaceCardStatusKind = "approval" | "input" | "working" | "failed" | "plan" | "done" | "idle"`;
  - `interface WorkspaceCardStatus { readonly kind: WorkspaceCardStatusKind; readonly label: string; readonly colorClass: string }`;
  - `WORKSPACE_CARD_STATUS` — the eight canonical status objects (`approval`, `input`, `working`, `connecting`, `failed`, `plan`, `done`, `idle`); the resolver always returns one of them, so memo comparisons can use identity;
  - `type WorkspaceCardStatusInput = Omit<ThreadStatusInput, "lastVisitedAt"> & Pick<SidebarThreadSummary, "unresolvedDelivery">`;
  - `resolveWorkspaceCardStatus(thread: WorkspaceCardStatusInput, lastVisitedAt: string | null | undefined): WorkspaceCardStatus`;
  - `pickMoreUrgentWorkspaceCardStatus(left, right): WorkspaceCardStatus`;
  - `resolveHighestWorkspaceCardStatus(statuses: Iterable<WorkspaceCardStatus>): WorkspaceCardStatus | null` (ignores idle; for the collapsed-project and Show-more summaries).
  - `ThreadStatusPill` keeps its label union (the Agents view groups on it).

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/Sidebar.logic.test.ts`, add to the `from "./Sidebar.logic"` import list: `pickMoreUrgentWorkspaceCardStatus, resolveHighestWorkspaceCardStatus, resolveWorkspaceCardStatus, WORKSPACE_CARD_STATUS,`. Append:

```ts
describe("resolveWorkspaceCardStatus", () => {
  const base = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: null,
    session: null,
    unresolvedDelivery: null,
  };
  const session = (status: "running" | "starting" | "ready" | "error") => ({
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "claudeAgent",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: status === "running" ? ("turn-1" as never) : null,
    lastError: status === "error" ? "provider exited" : null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  });
  const settled = (state: "completed" | "error" | "interrupted") => ({
    ...makeLatestTurn(),
    state,
  });
  // makeLatestTurn completes at 10:05.
  const visitedBefore = "2026-03-09T10:04:00.000Z";
  const visitedAfter = "2026-03-09T10:06:00.000Z";
  const W = WORKSPACE_CARD_STATUS;

  it("maps each row of the status table, first match winning", () => {
    expect(
      resolveWorkspaceCardStatus(
        { ...base, hasPendingApprovals: true, hasPendingUserInput: true, session: session("error") },
        null,
      ),
    ).toBe(W.approval);
    expect(
      resolveWorkspaceCardStatus({ ...base, hasPendingUserInput: true, session: session("running") }, null),
    ).toBe(W.input);
    expect(resolveWorkspaceCardStatus({ ...base, session: session("running") }, null)).toBe(W.working);
    expect(resolveWorkspaceCardStatus({ ...base, session: session("starting") }, null)).toBe(
      W.connecting,
    );
    expect(resolveWorkspaceCardStatus({ ...base, session: session("error") }, null)).toBe(W.failed);
    expect(
      resolveWorkspaceCardStatus(
        {
          ...base,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: settled("completed"),
          session: session("ready"),
        },
        null,
      ),
    ).toBe(W.plan);
    expect(
      resolveWorkspaceCardStatus(
        { ...base, latestTurn: settled("completed"), session: session("ready") },
        visitedBefore,
      ),
    ).toBe(W.done);
    expect(resolveWorkspaceCardStatus(base, null)).toBe(W.idle);
  });

  it("names and colours each glyph as the spec's table does", () => {
    expect(W.approval).toEqual({
      kind: "approval",
      label: "Needs approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
    });
    expect(W.input).toEqual({
      kind: "input",
      label: "Waiting for your answer",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
    });
    expect(W.working.label).toBe("Working");
    expect(W.connecting.label).toBe("Connecting");
    expect(W.failed).toEqual({ kind: "failed", label: "Failed", colorClass: "text-destructive" });
    expect(W.plan.label).toBe("Plan ready");
    expect(W.done.label).toBe("Finished, not opened yet");
    expect(W.idle).toEqual({ kind: "idle", label: "Idle", colorClass: "text-muted-foreground" });
  });

  it("shows an unseen errored turn as Failed, where the pill said Completed", () => {
    const errored = { ...base, latestTurn: settled("error"), session: session("ready") };
    expect(
      resolveThreadStatusPill({ thread: { ...errored, lastVisitedAt: visitedBefore } })?.label,
    ).toBe("Completed");
    expect(resolveWorkspaceCardStatus(errored, visitedBefore)).toBe(W.failed);
  });

  it("keeps never-visited threads idle, even after an error", () => {
    expect(
      resolveWorkspaceCardStatus({ ...base, latestTurn: settled("error"), session: session("ready") }, null),
    ).toBe(W.idle);
  });

  it("keeps an interrupted turn Finished until opened, then Idle", () => {
    const interrupted = { ...base, latestTurn: settled("interrupted"), session: session("ready") };
    expect(resolveWorkspaceCardStatus(interrupted, visitedBefore)).toBe(W.done);
    expect(resolveWorkspaceCardStatus(interrupted, visitedAfter)).toBe(W.idle);
  });

  it("fails on a refused delivery and leaves the glyph alone for an uncertain one", () => {
    expect(
      resolveWorkspaceCardStatus({ ...base, unresolvedDelivery: { state: "failed" } }, null),
    ).toBe(W.failed);
    expect(
      resolveWorkspaceCardStatus({ ...base, unresolvedDelivery: { state: "uncertain" } }, null),
    ).toBe(W.idle);
    expect(
      resolveWorkspaceCardStatus(
        { ...base, unresolvedDelivery: { state: "uncertain" }, session: session("running") },
        null,
      ),
    ).toBe(W.working);
  });

  it("ranks Failed above Plan ready", () => {
    expect(
      resolveWorkspaceCardStatus(
        {
          ...base,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: settled("completed"),
          session: session("ready"),
          unresolvedDelivery: { state: "failed" },
        },
        null,
      ),
    ).toBe(W.failed);
  });
});

describe("workspace card status priority", () => {
  const W = WORKSPACE_CARD_STATUS;

  it("summarises by the most urgent non-idle status", () => {
    expect(resolveHighestWorkspaceCardStatus([W.idle, W.done, W.failed, W.plan])).toBe(W.failed);
    expect(resolveHighestWorkspaceCardStatus([W.working, W.input])).toBe(W.input);
    expect(resolveHighestWorkspaceCardStatus([W.input, W.approval])).toBe(W.approval);
    expect(resolveHighestWorkspaceCardStatus([W.connecting, W.plan])).toBe(W.connecting);
    expect(resolveHighestWorkspaceCardStatus([W.idle])).toBeNull();
    expect(resolveHighestWorkspaceCardStatus([])).toBeNull();
  });

  it("picks the more urgent of two statuses, idle included", () => {
    expect(pickMoreUrgentWorkspaceCardStatus(W.idle, W.done)).toBe(W.done);
    expect(pickMoreUrgentWorkspaceCardStatus(W.approval, W.working)).toBe(W.approval);
    expect(pickMoreUrgentWorkspaceCardStatus(W.idle, W.idle)).toBe(W.idle);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement the resolver**

In `apps/web/src/components/Sidebar.logic.ts`, add before `export interface ThreadStatusPill {`:

```ts
/**
 * Status tones shared by the thread pill (Agents view) and the card glyphs, so
 * both surfaces colour a status the same way.
 */
const STATUS_TONES = {
  approval: {
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
  },
  input: {
    colorClass: "text-indigo-600 dark:text-indigo-300/90",
    dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
  },
  working: {
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
  },
  plan: {
    colorClass: "text-violet-600 dark:text-violet-300/90",
    dotClass: "bg-violet-500 dark:bg-violet-300/90",
  },
  completed: {
    colorClass: "text-emerald-600 dark:text-emerald-300/90",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
  },
} as const;
```

Replace the body of `resolveThreadStatusPill` (everything inside the function) with the same logic using the tones:

```ts
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return { label: "Pending Approval", ...STATUS_TONES.approval, pulse: false };
  }

  if (thread.hasPendingUserInput) {
    return { label: "Awaiting Input", ...STATUS_TONES.input, pulse: false };
  }

  if (isWorkspaceThreadRunning(thread)) {
    return { label: "Working", ...STATUS_TONES.working, pulse: true };
  }

  if (thread.session?.status === "starting") {
    return { label: "Connecting", ...STATUS_TONES.working, pulse: true };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return { label: "Plan Ready", ...STATUS_TONES.plan, pulse: false };
  }

  if (hasUnseenCompletion(thread)) {
    return { label: "Completed", ...STATUS_TONES.completed, pulse: false };
  }

  return null;
```

(The pill values are unchanged, so the existing `resolveThreadStatusPill` tests keep passing.)

Add before `resolveThreadStatusPill` (shared by the pill, card resolver and Archive guard):

```ts
export function isWorkspaceThreadRunning(thread: Pick<ThreadStatusInput, "session">): boolean {
  return thread.session?.status === "running";
}
```

Add after `resolveThreadStatusPill`:

```ts
export type WorkspaceCardStatusKind =
  | "approval"
  | "input"
  | "working"
  | "failed"
  | "plan"
  | "done"
  | "idle";

export interface WorkspaceCardStatus {
  readonly kind: WorkspaceCardStatusKind;
  /** Accessible name and tooltip of the glyph. */
  readonly label: string;
  readonly colorClass: string;
}

/**
 * The card glyph states from the spec's status table. `resolveWorkspaceCardStatus`
 * returns these exact objects, so memoised components compare them by identity.
 */
export const WORKSPACE_CARD_STATUS = {
  approval: { kind: "approval", label: "Needs approval", colorClass: STATUS_TONES.approval.colorClass },
  input: { kind: "input", label: "Waiting for your answer", colorClass: STATUS_TONES.input.colorClass },
  working: { kind: "working", label: "Working", colorClass: STATUS_TONES.working.colorClass },
  connecting: { kind: "working", label: "Connecting", colorClass: STATUS_TONES.working.colorClass },
  failed: { kind: "failed", label: "Failed", colorClass: "text-destructive" },
  plan: { kind: "plan", label: "Plan ready", colorClass: STATUS_TONES.plan.colorClass },
  done: {
    kind: "done",
    label: "Finished, not opened yet",
    colorClass: STATUS_TONES.completed.colorClass,
  },
  idle: { kind: "idle", label: "Idle", colorClass: "text-muted-foreground" },
} as const satisfies Record<string, WorkspaceCardStatus>;

export type WorkspaceCardStatusInput = Omit<ThreadStatusInput, "lastVisitedAt"> &
  Pick<SidebarThreadSummary, "unresolvedDelivery">;

/**
 * A card's glyph, wrapping the thread pill so the Agents view keeps its labels.
 * First match wins: approval, input, working/connecting, failed (session error,
 * refused delivery, or an unseen turn that errored — the pill calls that
 * "Completed"), plan ready, finished-not-opened, idle.
 */
export function resolveWorkspaceCardStatus(
  thread: WorkspaceCardStatusInput,
  lastVisitedAt: string | null | undefined,
): WorkspaceCardStatus {
  const visited: ThreadStatusInput = lastVisitedAt ? { ...thread, lastVisitedAt } : thread;
  const pill = resolveThreadStatusPill({ thread: visited });
  switch (pill?.label) {
    case "Pending Approval":
      return WORKSPACE_CARD_STATUS.approval;
    case "Awaiting Input":
      return WORKSPACE_CARD_STATUS.input;
    case "Working":
      return WORKSPACE_CARD_STATUS.working;
    case "Connecting":
      return WORKSPACE_CARD_STATUS.connecting;
    default:
      break;
  }
  if (
    thread.session?.status === "error" ||
    thread.unresolvedDelivery?.state === "failed" ||
    (thread.latestTurn?.state === "error" && hasUnseenCompletion(visited))
  ) {
    return WORKSPACE_CARD_STATUS.failed;
  }
  if (pill?.label === "Plan Ready") {
    return WORKSPACE_CARD_STATUS.plan;
  }
  if (pill?.label === "Completed") {
    return WORKSPACE_CARD_STATUS.done;
  }
  return WORKSPACE_CARD_STATUS.idle;
}

const WORKSPACE_CARD_STATUS_PRIORITY: Record<WorkspaceCardStatusKind, number> = {
  approval: 7,
  input: 6,
  working: 5,
  failed: 4,
  plan: 3,
  done: 2,
  idle: 1,
};

/** The more urgent of two statuses; the first wins ties. */
export function pickMoreUrgentWorkspaceCardStatus(
  left: WorkspaceCardStatus,
  right: WorkspaceCardStatus,
): WorkspaceCardStatus {
  return WORKSPACE_CARD_STATUS_PRIORITY[right.kind] > WORKSPACE_CARD_STATUS_PRIORITY[left.kind]
    ? right
    : left;
}

/**
 * The most urgent non-idle status, for summaries of hidden cards (a collapsed
 * project, the Show more row). Null when every card is idle.
 */
export function resolveHighestWorkspaceCardStatus(
  statuses: Iterable<WorkspaceCardStatus>,
): WorkspaceCardStatus | null {
  let highest: WorkspaceCardStatus | null = null;
  for (const status of statuses) {
    if (status.kind === "idle") continue;
    highest = highest === null ? status : pickMoreUrgentWorkspaceCardStatus(highest, status);
  }
  return highest;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/sidebar/agentsSection.logic.test.ts src/components/agents`
Expected: PASS, including the unchanged pill tests and the Agents view tests.

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts`.

## Task 12: Card data helpers

**Files:**
- Modify: `apps/web/src/components/Sidebar.logic.ts` (branch text, dirty state, age, chats, card classes, keyboard-menu helpers)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/sidebar/agentsSection.logic.ts` (`resolveConversationPreviewLine`)
- Test: `apps/web/src/components/sidebar/agentsSection.logic.test.ts`
- Create: `apps/web/src/components/sidebar/workspaceCard.logic.ts`
- Create: `apps/web/src/components/sidebar/workspaceCard.logic.test.ts`

**Interfaces:**
- Consumes: `WorkspaceCardStatus`, `resolveWorkspaceCardStatus`, `pickMoreUrgentWorkspaceCardStatus` (Task 11); `resolveWorkspaceBranchLabel` (Task 6).
- Produces (from `Sidebar.logic.ts`):
  - `resolveWorkspaceDirty(status: VcsStatusResult | VcsStatusSummary | null | undefined): boolean`;
  - `shouldShowWorkspaceBranchText(branch: string | null, title: string): branch is string`;
  - `resolveWorkspaceCardAgeSource(thread: Pick<SidebarThreadSummary, "latestTurn" | "latestUserMessageAt" | "updatedAt" | "createdAt">, isWorking: boolean): string | null`;
  - `formatCompactAge(iso: string | null | undefined, now: number): string | null`;
  - `workspaceCheckoutKey(input: { environmentId: string; projectId: string; worktreePath: string | null }): string`;
  - `interface WorkspaceChatSummary { readonly count: number; readonly status: WorkspaceCardStatus }`;
  - `summarizeWorkspaceChats<T extends WorkspaceChatThread>(threads: readonly T[], resolveLastVisitedAt: (thread: T) => string | null | undefined): ReadonlyMap<string, WorkspaceChatSummary>`;
  - `resolveWorkspaceCardClassName(input: { isActive: boolean; isSelected: boolean }): string`;
  - `KEYBOARD_CONTEXT_MENU_ECHO_MS = 1_000` (owned by `contextMenuKeyboard.ts`, Task 4), `isContextMenuShortcut(event)`, `isKeyboardContextMenuEcho(openedAtMs, nowMs)`.
- Produces (from `agentsSection.logic.ts`): `resolveConversationPreviewLine(isWorking: boolean, preview): string | null`; `resolveAgentPreviewLine` delegates to it.
- Produces (from `sidebar/workspaceCard.logic.ts`): `interface WorkspaceCardPreview { readonly text: string | null; readonly tone: "destructive" | "warning" | null }`; `resolveWorkspaceCardPreview(thread, status): WorkspaceCardPreview`; `workspaceModelLabelKey(environmentId, instanceId, slug): string`; `buildWorkspaceModelLabels(serverConfigs): ReadonlyMap<string, string>`; `resolveWorkspaceModelLabel(labels, thread): string`; `resolveWorkspaceCardBranchTooltip({ branch, worktreePath, checkoutPath }): string`.

`workspaceCard.logic.ts` is a separate module because it needs `agentsSection.logic.ts`, which already imports `Sidebar.logic.ts`; putting these in `Sidebar.logic.ts` would create an import cycle.

- [ ] **Step 1: Write the failing `Sidebar.logic` tests**

Add to the `from "./Sidebar.logic"` import list: `formatCompactAge, isContextMenuShortcut, isKeyboardContextMenuEcho, resolveWorkspaceCardAgeSource, resolveWorkspaceCardClassName, resolveWorkspaceDirty, shouldShowWorkspaceBranchText, summarizeWorkspaceChats, workspaceCheckoutKey,`. Import `KEYBOARD_CONTEXT_MENU_ECHO_MS` from `../contextMenuKeyboard` in both `Sidebar.logic.ts` and its test. Append:

```ts
describe("card line 2 helpers", () => {
  it("hides the branch text when it repeats the title", () => {
    expect(shouldShowWorkspaceBranchText("develop", "develop")).toBe(false);
    expect(shouldShowWorkspaceBranchText(null, "Fix invoice date format")).toBe(false);
    expect(shouldShowWorkspaceBranchText("fix-TRI-150", "Fix invoice date format")).toBe(true);
  });

  it("reads uncommitted changes only from a fresh status", () => {
    expect(resolveWorkspaceDirty({ hasWorkingTreeChanges: true } as unknown as VcsStatusResult)).toBe(
      true,
    );
    expect(
      resolveWorkspaceDirty({ hasWorkingTreeChanges: true, stale: true } as unknown as VcsStatusSummary),
    ).toBe(false);
    expect(resolveWorkspaceDirty({ hasWorkingTreeChanges: false } as unknown as VcsStatusResult)).toBe(
      false,
    );
    expect(resolveWorkspaceDirty(null)).toBe(false);
  });
});

describe("card age", () => {
  const thread = {
    latestTurn: { ...makeLatestTurn({ startedAt: "2026-07-03T11:54:00.000Z" }), state: "running" as const },
    latestUserMessageAt: "2026-07-03T11:40:00.000Z",
    updatedAt: "2026-07-03T11:30:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  };

  it("counts from the running turn's start while working, else from the last message", () => {
    expect(resolveWorkspaceCardAgeSource(thread, true)).toBe("2026-07-03T11:54:00.000Z");
    expect(resolveWorkspaceCardAgeSource(thread, false)).toBe("2026-07-03T11:40:00.000Z");
    expect(resolveWorkspaceCardAgeSource({ ...thread, latestTurn: null }, true)).toBe(
      "2026-07-03T11:40:00.000Z",
    );
    expect(resolveWorkspaceCardAgeSource({ ...thread, latestUserMessageAt: null }, false)).toBe(
      "2026-07-03T11:30:00.000Z",
    );
  });

  it("formats compactly", () => {
    const now = Date.parse("2026-07-03T12:00:00.000Z");
    expect(formatCompactAge("2026-07-03T11:59:45.000Z", now)).toBe("now");
    expect(formatCompactAge("2026-07-03T11:54:00.000Z", now)).toBe("6m");
    expect(formatCompactAge("2026-07-03T09:00:00.000Z", now)).toBe("3h");
    expect(formatCompactAge("2026-07-01T12:00:00.000Z", now)).toBe("2d");
    expect(formatCompactAge("2026-07-03T12:05:00.000Z", now)).toBe("now");
    expect(formatCompactAge("invalid", now)).toBeNull();
    expect(formatCompactAge(null, now)).toBeNull();
  });
});

describe("summarizeWorkspaceChats", () => {
  const environmentId = localEnvironmentId;
  const panel = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    environmentId,
    projectId: ProjectId.make("project-1"),
    kind: "panel" as const,
    worktreePath: null as string | null,
    archivedAt: null as string | null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: null,
    session: null,
    unresolvedDelivery: null,
    ...overrides,
  });

  it("groups panels by worktree path, sends pathless panels to the main checkout and skips archived ones", () => {
    const summaries = summarizeWorkspaceChats(
      [
        panel("a", { worktreePath: "/wt/fix" }),
        panel("b", { worktreePath: "/wt/fix", hasPendingApprovals: true }),
        panel("c"),
        panel("d", { archivedAt: "2026-03-09T10:00:00.000Z" }),
        { ...panel("e"), kind: "workspace" as const },
      ],
      () => null,
    );
    expect(
      summaries.get(
        workspaceCheckoutKey({ environmentId, projectId: ProjectId.make("project-1"), worktreePath: "/wt/fix" }),
      ),
    ).toEqual({ count: 2, status: WORKSPACE_CARD_STATUS.approval });
    expect(
      summaries.get(
        workspaceCheckoutKey({ environmentId, projectId: ProjectId.make("project-1"), worktreePath: null }),
      ),
    ).toEqual({ count: 1, status: WORKSPACE_CARD_STATUS.idle });
    expect(summaries.size).toBe(2);
  });

  it("keeps worktree keys apart across environments and projects", () => {
    expect(
      workspaceCheckoutKey({ environmentId: "a", projectId: "p", worktreePath: "/wt" }),
    ).not.toBe(workspaceCheckoutKey({ environmentId: "b", projectId: "p", worktreePath: "/wt" }));
    expect(workspaceCheckoutKey({ environmentId: "a", projectId: "p", worktreePath: null })).not.toBe(
      workspaceCheckoutKey({ environmentId: "a", projectId: "q", worktreePath: null }),
    );
  });
});

describe("resolveWorkspaceCardClassName", () => {
  it("washes on hover, fills and borders when active, and keeps the multi-select tint", () => {
    expect(resolveWorkspaceCardClassName({ isActive: false, isSelected: false })).toContain(
      "hover:bg-accent/60",
    );
    const active = resolveWorkspaceCardClassName({ isActive: true, isSelected: false });
    expect(active).toContain("bg-accent");
    expect(active).toContain("border-border");
    expect(active).not.toContain("font-medium");
    expect(resolveWorkspaceCardClassName({ isActive: false, isSelected: true })).toContain(
      "bg-primary/15",
    );
    expect(resolveWorkspaceCardClassName({ isActive: true, isSelected: true })).toContain(
      "bg-primary/22",
    );
  });
});

describe("keyboard context menu helpers", () => {
  const key = (overrides: Partial<Record<"key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey", unknown>>) =>
    ({ key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...overrides }) as {
      key: string;
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    };

  it("recognises Shift+F10 and the Menu key only", () => {
    expect(isContextMenuShortcut(key({ key: "F10", shiftKey: true }))).toBe(true);
    expect(isContextMenuShortcut(key({ key: "ContextMenu" }))).toBe(true);
    expect(isContextMenuShortcut(key({ key: "F10" }))).toBe(false);
    expect(isContextMenuShortcut(key({ key: "F10", shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isContextMenuShortcut(key({ key: "Enter" }))).toBe(false);
  });

  it("treats a contextmenu inside the window after a keyboard open as its echo", () => {
    expect(isKeyboardContextMenuEcho(1_000, 1_000)).toBe(true);
    expect(isKeyboardContextMenuEcho(1_000, 1_000 + KEYBOARD_CONTEXT_MENU_ECHO_MS - 1)).toBe(true);
    expect(isKeyboardContextMenuEcho(1_000, 1_000 + KEYBOARD_CONTEXT_MENU_ECHO_MS)).toBe(false);
    expect(isKeyboardContextMenuEcho(Number.NEGATIVE_INFINITY, 5)).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing preview and model tests**

In `apps/web/src/components/sidebar/agentsSection.logic.test.ts`, add `resolveConversationPreviewLine,` to the import list and add after `describe("resolveAgentPreviewLine", …)`:

```ts
describe("resolveConversationPreviewLine", () => {
  const preview = { prompt: "p", tool: "Bash: ls", assistantMessage: "a" };

  it("shows the tool only while working, then the reply, then the prompt", () => {
    expect(resolveConversationPreviewLine(true, preview)).toBe("Bash: ls");
    expect(resolveConversationPreviewLine(false, preview)).toBe("a");
    expect(resolveConversationPreviewLine(true, { ...preview, tool: null })).toBe("a");
    expect(resolveConversationPreviewLine(false, { ...preview, assistantMessage: null })).toBe("p");
    expect(resolveConversationPreviewLine(false, null)).toBeNull();
  });
});
```

Create `apps/web/src/components/sidebar/workspaceCard.logic.test.ts`:

```ts
import { EnvironmentId, ProviderInstanceId, type ServerConfig } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { WORKSPACE_CARD_STATUS } from "../Sidebar.logic";
import {
  buildWorkspaceModelLabels,
  resolveWorkspaceCardBranchTooltip,
  resolveWorkspaceCardPreview,
  resolveWorkspaceModelLabel,
} from "./workspaceCard.logic";

const preview = {
  prompt: "Fix the export dates",
  tool: "Editing src/export/invoiceDates.ts",
  assistantMessage: "Renderer upgraded; export tests pass",
};
const session = { providerName: "claudeAgent" } as never;

describe("resolveWorkspaceCardPreview", () => {
  it("reports an unresolved delivery first", () => {
    expect(
      resolveWorkspaceCardPreview(
        { unresolvedDelivery: { state: "failed" }, conversationPreview: preview, session },
        WORKSPACE_CARD_STATUS.failed,
      ),
    ).toEqual({ text: "Delivery failed", tone: "destructive" });
    expect(
      resolveWorkspaceCardPreview(
        { unresolvedDelivery: { state: "uncertain" }, conversationPreview: preview, session },
        WORKSPACE_CARD_STATUS.working,
      ),
    ).toEqual({ text: "Delivery uncertain", tone: "warning" });
  });

  it("shows the tool while working, else the reply, else the provider", () => {
    expect(
      resolveWorkspaceCardPreview({ conversationPreview: preview, session }, WORKSPACE_CARD_STATUS.working)
        .text,
    ).toBe("Editing src/export/invoiceDates.ts");
    expect(
      resolveWorkspaceCardPreview({ conversationPreview: preview, session }, WORKSPACE_CARD_STATUS.done)
        .text,
    ).toBe("Renderer upgraded; export tests pass");
    expect(
      resolveWorkspaceCardPreview({ conversationPreview: null, session }, WORKSPACE_CARD_STATUS.idle),
    ).toEqual({ text: "Claude", tone: null });
    expect(
      resolveWorkspaceCardPreview({ conversationPreview: null, session: null }, WORKSPACE_CARD_STATUS.idle),
    ).toEqual({ text: null, tone: null });
  });
});

describe("workspace model labels", () => {
  const environmentId = EnvironmentId.make("env-main");
  const instanceId = ProviderInstanceId.make("claude");
  const serverConfigs = new Map([
    [
      environmentId,
      {
        providers: [
          {
            instanceId,
            models: [
              { slug: "claude-opus-5", name: "Claude Opus 5", shortName: "opus", isCustom: false, capabilities: null },
              { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isCustom: false, capabilities: null },
            ],
          },
        ],
      } as unknown as ServerConfig,
    ],
  ]);
  const labels = buildWorkspaceModelLabels(serverConfigs);

  it("uses the catalog short name, then the model name, then the slug", () => {
    expect(
      resolveWorkspaceModelLabel(labels, {
        environmentId,
        modelSelection: { instanceId, model: "claude-opus-5" },
      }),
    ).toBe("opus");
    expect(
      resolveWorkspaceModelLabel(labels, {
        environmentId,
        modelSelection: { instanceId, model: "claude-sonnet-5" },
      }),
    ).toBe("Claude Sonnet 5");
    expect(
      resolveWorkspaceModelLabel(labels, {
        environmentId,
        modelSelection: { instanceId, model: "gpt-5-codex" },
      }),
    ).toBe("gpt-5-codex");
  });

  it("tolerates configs that have not loaded their providers", () => {
    expect(
      buildWorkspaceModelLabels(new Map([[environmentId, {} as unknown as ServerConfig]])).size,
    ).toBe(0);
  });
});

describe("resolveWorkspaceCardBranchTooltip", () => {
  it("names the worktree or the checkout the card runs in", () => {
    expect(
      resolveWorkspaceCardBranchTooltip({
        branch: "fix-TRI-150",
        worktreePath: "/repos/wt/fix-TRI-150",
        checkoutPath: "/repos/customer-portal",
      }),
    ).toBe("Worktree: fix-TRI-150 (fix-TRI-150)");
    expect(
      resolveWorkspaceCardBranchTooltip({
        branch: "develop",
        worktreePath: null,
        checkoutPath: "/repos/customer-portal",
      }),
    ).toBe("Checkout: customer-portal (develop)");
    expect(
      resolveWorkspaceCardBranchTooltip({ branch: "develop", worktreePath: null, checkoutPath: null }),
    ).toBe("develop");
  });
});
```

The provider label `"Claude"` comes from `PROVIDER_DISPLAY_NAMES.claudeAgent`; if that constant reads differently in this checkout, use its value in the assertion.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/sidebar/agentsSection.logic.test.ts src/components/sidebar/workspaceCard.logic.test.ts`
Expected: FAIL — none of the new functions exist.

- [ ] **Step 4: Implement the `Sidebar.logic` helpers**

In `apps/web/src/components/Sidebar.logic.ts`:

(a) Add after `resolveWorkspaceBranchLabel`:

```ts
/** Whether the checkout has uncommitted changes, per a fresh (not stale) status. */
export function resolveWorkspaceDirty(
  status: VcsStatusResult | VcsStatusSummary | null | undefined,
): boolean {
  return Boolean(status && !("stale" in status && status.stale) && status.hasWorkingTreeChanges);
}

/** Line 2 hides the branch when it repeats the title (the primary card's title is its branch). */
export function shouldShowWorkspaceBranchText(
  branch: string | null,
  title: string,
): branch is string {
  return branch !== null && branch !== title;
}
```

(b) Add after `resolveHighestWorkspaceCardStatus`:

```ts
type WorkspaceChatThread = WorkspaceCardStatusInput & {
  readonly environmentId: string;
  readonly projectId: string;
  readonly kind?: "default" | "workspace" | "panel" | undefined;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
};

export interface WorkspaceChatSummary {
  readonly count: number;
  /** The most urgent status among the chats, idle included; shown as the row's glyph. */
  readonly status: WorkspaceCardStatus;
}

/**
 * The checkout a chat runs in. Panels copy their host's worktree path, so a
 * worktree card matches on it; a panel without a path runs in its project's main
 * checkout and counts on the primary card.
 */
export function workspaceCheckoutKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly worktreePath: string | null;
}): string {
  return input.worktreePath === null
    ? `main\u0000${input.environmentId}\u0000${input.projectId}`
    : `worktree\u0000${input.environmentId}\u0000${input.worktreePath}`;
}

/** Counts unarchived panel chats per checkout with their most urgent status. O(threads). */
export function summarizeWorkspaceChats<T extends WorkspaceChatThread>(
  threads: readonly T[],
  resolveLastVisitedAt: (thread: T) => string | null | undefined,
): ReadonlyMap<string, WorkspaceChatSummary> {
  const summaries = new Map<string, { count: number; status: WorkspaceCardStatus }>();
  for (const thread of threads) {
    if (thread.kind !== "panel" || thread.archivedAt !== null) continue;
    const key = workspaceCheckoutKey(thread);
    const status = resolveWorkspaceCardStatus(thread, resolveLastVisitedAt(thread));
    const current = summaries.get(key);
    if (current === undefined) {
      summaries.set(key, { count: 1, status });
    } else {
      current.count += 1;
      current.status = pickMoreUrgentWorkspaceCardStatus(current.status, status);
    }
  }
  return summaries;
}

/** A card's surface for its state, per States.dc.html. */
export function resolveWorkspaceCardClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const base = "w-full rounded-md border select-none";
  if (input.isSelected && input.isActive) {
    return cn(
      base,
      "border-border bg-primary/22 hover:bg-primary/26 dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }
  if (input.isSelected) {
    return cn(
      base,
      "border-transparent bg-primary/15 hover:bg-primary/19 dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }
  if (input.isActive) {
    return cn(base, "border-border bg-accent");
  }
  return cn(base, "border-transparent hover:bg-accent/60");
}

/**
 * Chromium and WebView2 follow Shift+F10 and the Menu key with a contextmenu
 * event; one arriving within this window after a keyboard-opened menu is ignored.
 */
/** Shift+F10 or the Menu key: the platform shortcuts for a focused element's menu. */
export function isContextMenuShortcut(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
): boolean {
  if (event.key === "ContextMenu") {
    return true;
  }
  return (
    event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
  );
}

export function isKeyboardContextMenuEcho(openedAtMs: number, nowMs: number): boolean {
  const elapsedMs = nowMs - openedAtMs;
  return elapsedMs >= 0 && elapsedMs < KEYBOARD_CONTEXT_MENU_ECHO_MS;
}
```

(c) Add after `formatSessionDuration` (it reuses `MINUTE_MS`, `HOUR_MS` and `DAY_MS`):

```ts
/**
 * The instant a card's age counts from: the running turn's start while the agent
 * works, else the latest user message, update or creation, as the rows did.
 */
export function resolveWorkspaceCardAgeSource(
  thread: Pick<
    SidebarThreadSummary,
    "latestTurn" | "latestUserMessageAt" | "updatedAt" | "createdAt"
  >,
  isWorking: boolean,
): string | null {
  if (isWorking && thread.latestTurn?.startedAt) {
    return thread.latestTurn.startedAt;
  }
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt ?? null;
}

/** A compact age for card line 3: now, 5m, 3h, 2d. Null when the instant is unusable. */
export function formatCompactAge(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const startedAt = Date.parse(iso);
  if (Number.isNaN(startedAt)) return null;
  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  return `${Math.floor(elapsedMs / DAY_MS)}d`;
}
```

- [ ] **Step 5: Implement the preview and model helpers**

In `apps/web/src/components/sidebar/agentsSection.logic.ts`, replace `resolveAgentPreviewLine` with:

```ts
/** The preview line: the running tool while working, else the latest reply, else the prompt. */
export function resolveConversationPreviewLine(
  isWorking: boolean,
  preview: OrchestrationConversationPreview | null | undefined,
): string | null {
  if (preview === null || preview === undefined) return null;
  if (isWorking && preview.tool !== null) {
    return preview.tool;
  }
  return preview.assistantMessage ?? preview.prompt ?? null;
}

export function resolveAgentPreviewLine(
  pill: ThreadStatusPill | null,
  preview: OrchestrationConversationPreview | null | undefined,
): string | null {
  return resolveConversationPreviewLine(
    pill?.label === "Working" || pill?.label === "Connecting",
    preview,
  );
}
```

Create `apps/web/src/components/sidebar/workspaceCard.logic.ts`:

```ts
import type { EnvironmentId, ServerConfig } from "@bibcode/contracts";

import type { SidebarThreadSummary } from "../../types";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import type { WorkspaceCardStatus } from "../Sidebar.logic";
import { resolveAgentProvider, resolveConversationPreviewLine } from "./agentsSection.logic";

export interface WorkspaceCardPreview {
  readonly text: string | null;
  readonly tone: "destructive" | "warning" | null;
}

/**
 * Card line 3's text, first match wins: an unresolved delivery; the tool while
 * working, else the latest assistant message, else the prompt; the provider label.
 */
export function resolveWorkspaceCardPreview(
  thread: Pick<SidebarThreadSummary, "unresolvedDelivery" | "conversationPreview" | "session">,
  status: WorkspaceCardStatus,
): WorkspaceCardPreview {
  const delivery = thread.unresolvedDelivery ?? null;
  if (delivery?.state === "failed") {
    return { text: "Delivery failed", tone: "destructive" };
  }
  if (delivery?.state === "uncertain") {
    return { text: "Delivery uncertain", tone: "warning" };
  }
  const line = resolveConversationPreviewLine(status.kind === "working", thread.conversationPreview);
  if (line !== null) {
    return { text: line, tone: null };
  }
  return { text: resolveAgentProvider(thread.session?.providerName).label, tone: null };
}

export function workspaceModelLabelKey(
  environmentId: string,
  instanceId: string,
  slug: string,
): string {
  return `${environmentId}\u0000${instanceId}\u0000${slug}`;
}

/**
 * One lookup per project list, built from the loaded server configs, so each
 * card resolves its model's catalog short name in O(1).
 */
export function buildWorkspaceModelLabels(
  serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "providers">>,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const [environmentId, config] of serverConfigs) {
    for (const provider of config.providers ?? []) {
      for (const model of provider.models ?? []) {
        labels.set(
          workspaceModelLabelKey(environmentId, provider.instanceId, model.slug),
          getTriggerDisplayModelName(model),
        );
      }
    }
  }
  return labels;
}

/** Line 3's model: the catalog short name, else the slug. */
export function resolveWorkspaceModelLabel(
  labels: ReadonlyMap<string, string>,
  thread: Pick<SidebarThreadSummary, "environmentId" | "modelSelection">,
): string {
  return (
    labels.get(
      workspaceModelLabelKey(
        thread.environmentId,
        thread.modelSelection.instanceId,
        thread.modelSelection.model,
      ),
    ) ?? thread.modelSelection.model
  );
}

/** Line 2's branch tooltip names where the card runs, as the old worktree label did. */
export function resolveWorkspaceCardBranchTooltip(input: {
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly checkoutPath: string | null;
}): string {
  if (input.worktreePath !== null) {
    return `Worktree: ${formatWorktreePathForDisplay(input.worktreePath)} (${input.branch})`;
  }
  if (input.checkoutPath !== null) {
    return `Checkout: ${formatWorktreePathForDisplay(input.checkoutPath)} (${input.branch})`;
  }
  return input.branch;
}
```

- [ ] **Step 6: Run the tests**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.logic.test.ts src/components/sidebar/agentsSection.logic.test.ts src/components/sidebar/workspaceCard.logic.test.ts`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 7: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/sidebar/agentsSection.logic.ts apps/web/src/components/sidebar/agentsSection.logic.test.ts apps/web/src/components/sidebar/workspaceCard.logic.ts apps/web/src/components/sidebar/workspaceCard.logic.test.ts`.

## Task 13: The minute clock and `<RelativeAge>`

**Files:**
- Create: `apps/web/src/minuteClock.ts`
- Create: `apps/web/src/minuteClock.test.ts`
- Create: `apps/web/src/components/sidebar/RelativeAge.tsx`

**Interfaces:**
- Consumes: `formatCompactAge` (Task 12).
- Produces:
  - `interface MinuteClockEnvironment { now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; onVisibilityChange(listener: () => void): () => void }`;
  - `interface MinuteClock { subscribe(listener: () => void): () => void; getSnapshot(): number }`;
  - `createMinuteClock(environment: MinuteClockEnvironment): MinuteClock`;
  - `appMinuteClock: MinuteClock` and `useMinuteClock(): number` (passes `getSnapshot` as the server snapshot too, so `renderToStaticMarkup` tests work);
  - `RelativeAge: React.MemoExoticComponent<(props: { iso: string | null; className?: string }) => JSX.Element | null>` rendering `<time dateTime>` with the compact age.

Today's labels never refresh, and `useRelativeTimeTick` is a per-component one-second timer; this is one minute-aligned timer for the whole app that stops at zero subscribers.

- [ ] **Step 1: Write the failing clock tests**

Create `apps/web/src/minuteClock.test.ts`:

```ts
import { describe, expect, it, vi } from "vite-plus/test";

import { createMinuteClock, type MinuteClockEnvironment } from "./minuteClock";

function fakeEnvironment(start: number) {
  let now = start;
  let nextHandle = 1;
  const timers = new Map<number, { callback: () => void; at: number }>();
  const visibilityListeners = new Set<() => void>();
  const environment: MinuteClockEnvironment = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, at: now + delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    onVisibilityChange: (listener) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    },
  };
  return {
    environment,
    setNow(time: number) {
      now = time;
    },
    advanceTo(time: number) {
      now = time;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    pendingTimers: () => timers.size,
    visibilityListenerCount: () => visibilityListeners.size,
    becomeVisible() {
      for (const listener of [...visibilityListeners]) listener();
    },
  };
}

const at = (time: string) => Date.parse(`2026-09-24T${time}Z`);

describe("createMinuteClock", () => {
  it("keeps one minute-aligned timer for every subscriber", () => {
    const fake = fakeEnvironment(at("10:00:30.000"));
    const clock = createMinuteClock(fake.environment);
    const first = vi.fn();
    const second = vi.fn();
    clock.subscribe(first);
    clock.subscribe(second);
    expect(fake.pendingTimers()).toBe(1);

    fake.advanceTo(at("10:00:59.999"));
    expect(first).not.toHaveBeenCalled();

    fake.advanceTo(at("10:01:00.000"));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(clock.getSnapshot()).toBe(at("10:01:00.000"));
    expect(fake.pendingTimers()).toBe(1);

    fake.advanceTo(at("10:02:00.000"));
    expect(first).toHaveBeenCalledTimes(2);
  });

  it("stops its timer and visibility listener at zero subscribers", () => {
    const fake = fakeEnvironment(at("10:00:00.000"));
    const clock = createMinuteClock(fake.environment);
    const listener = vi.fn();
    const unsubscribeA = clock.subscribe(listener);
    const unsubscribeB = clock.subscribe(vi.fn());
    unsubscribeA();
    expect(fake.pendingTimers()).toBe(1);
    unsubscribeB();
    unsubscribeB();
    expect(fake.pendingTimers()).toBe(0);
    expect(fake.visibilityListenerCount()).toBe(0);

    fake.advanceTo(at("10:05:00.000"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("re-reads the time when the page becomes visible", () => {
    const fake = fakeEnvironment(at("10:00:00.000"));
    const clock = createMinuteClock(fake.environment);
    const listener = vi.fn();
    clock.subscribe(listener);
    fake.setNow(at("10:00:45.000"));
    fake.becomeVisible();
    expect(listener).toHaveBeenCalledOnce();
    expect(clock.getSnapshot()).toBe(at("10:00:45.000"));
    expect(fake.pendingTimers()).toBe(1);
  });

  it("leaves no timer when the last subscriber leaves during visibility notification", () => {
    const fake = fakeEnvironment(at("10:00:00.000"));
    const clock = createMinuteClock(fake.environment);
    const notify = vi.fn(() => unsubscribe());
    const unsubscribe = clock.subscribe(notify);
    fake.setNow(at("10:00:45.000"));
    fake.becomeVisible();
    expect(notify).toHaveBeenCalledOnce();
    expect(fake.pendingTimers()).toBe(0);
    expect(fake.visibilityListenerCount()).toBe(0);
    fake.advanceTo(at("10:02:00.000"));
    expect(notify).toHaveBeenCalledOnce();
  });

  it("refreshes a stale snapshot for the first subscriber", () => {
    const fake = fakeEnvironment(at("10:00:00.000"));
    const clock = createMinuteClock(fake.environment);
    fake.setNow(at("10:05:00.000"));
    clock.subscribe(vi.fn());
    expect(clock.getSnapshot()).toBe(at("10:05:00.000"));
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/minuteClock.test.ts`
Expected: FAIL — `./minuteClock` doesn't exist.

- [ ] **Step 3: Implement the clock**

Create `apps/web/src/minuteClock.ts`:

```ts
import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

export interface MinuteClockEnvironment {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** Calls `listener` when the page becomes visible; returns the unsubscribe function. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

export interface MinuteClock {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

/**
 * One app-wide clock for relative ages. While anything is subscribed it keeps a
 * single timer aligned to the next minute boundary, and re-reads the time when
 * the page becomes visible again; at zero subscribers it stops completely.
 */
export function createMinuteClock(environment: MinuteClockEnvironment): MinuteClock {
  const listeners = new Set<() => void>();
  let snapshot = environment.now();
  let timer: unknown = null;
  let stopVisibility: (() => void) | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const schedule = () => {
    if (timer !== null) {
      environment.clearTimeout(timer);
    }
    const now = environment.now();
    timer = environment.setTimeout(tick, MINUTE_MS - (now % MINUTE_MS));
  };

  function tick() {
    timer = null;
    snapshot = environment.now();
    notify();
    if (listeners.size > 0) {
      schedule();
    }
  }

  const onVisible = () => {
    snapshot = environment.now();
    notify();
    // Notification may synchronously remove the final subscriber.
    if (listeners.size > 0) {
      schedule();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        snapshot = environment.now();
        schedule();
        stopVisibility = environment.onVisibilityChange(onVisible);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        if (timer !== null) {
          environment.clearTimeout(timer);
          timer = null;
        }
        stopVisibility?.();
        stopVisibility = null;
      };
    },
    getSnapshot: () => snapshot,
  };
}

const browserEnvironment: MinuteClockEnvironment = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  onVisibilityChange: (listener) => {
    if (typeof document === "undefined") {
      return () => {};
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        listener();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  },
};

export const appMinuteClock = createMinuteClock(browserEnvironment);

/** The current minute-resolution time; re-renders the caller once per minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(
    appMinuteClock.subscribe,
    appMinuteClock.getSnapshot,
    appMinuteClock.getSnapshot,
  );
}
```

- [ ] **Step 4: Add `<RelativeAge>`**

Create `apps/web/src/components/sidebar/RelativeAge.tsx`:

```tsx
import { memo } from "react";

import { useMinuteClock } from "../../minuteClock";
import { formatCompactAge } from "../Sidebar.logic";

/**
 * A card's age. It is the only card element subscribed to the minute clock, so
 * a tick re-renders this text and no card.
 */
export const RelativeAge = memo(function RelativeAge(props: {
  readonly iso: string | null;
  readonly className?: string;
}) {
  const now = useMinuteClock();
  const label = formatCompactAge(props.iso, now);
  if (props.iso === null || label === null) {
    return null;
  }
  return (
    <time dateTime={props.iso} className={props.className}>
      {label}
    </time>
  );
});
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/minuteClock.test.ts`
Expected: PASS (5 tests), including reentrant unsubscribe during visibility notification.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 6: Review**

`vercel-react-best-practices`: `useSyncExternalStore` with a module-level store (no effect-driven state), a server snapshot for static rendering, and the subscription confined to the `RelativeAge` leaf (`rerender-*` and `client-*` rules). Record it.

- [ ] **Step 7: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/minuteClock.ts apps/web/src/minuteClock.test.ts apps/web/src/components/sidebar/RelativeAge.tsx`.

## Task 14: The `WorkspaceCard` presentational module

**Files:**
- Create: `apps/web/src/components/sidebar/WorkspaceCard.tsx`
- Create: `apps/web/src/components/sidebar/WorkspaceCard.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceCardStatus` (Task 11); `WorkspaceCardPreview` (Task 12); `RelativeAge` (Task 13); `PrStatusIndicator` (Task 10); `ChangeRequestStatusIcon`; `ProviderInstanceIcon`; `SidebarMenuSubItem`; the tooltip primitives.
- Produces:
  - `workspaceCardIds(idBase: string): { status; title; flags; branch; session }` (element ids for the button's `aria-labelledby`/`aria-describedby`);
  - `isWorkspaceCardControlTarget(target: EventTarget | null): boolean` — true inside an element marked `data-card-control`;
  - `WorkspaceCardStatusGlyph({ status, id?, className? })` — `role="img"`, `aria-label`, `data-status`, tooltip; spinner is `motion-safe:animate-spin`;
  - `WorkspaceCardShell(props: WorkspaceCardShellProps)` — the `li` (`data-thread-item`, test id, handlers) with one full-card `<button type="button">` (test id, `aria-labelledby`, `aria-describedby`, `aria-current="page"` when active, `onKeyDown`) and a `pointer-events-none` content layer (status column + lines) above it; `footer` renders below the lines as a card control;
  - `WorkspaceCardTitleLine`, `WorkspaceCardBranchLine`, `WorkspaceCardPrButton`, `WorkspaceCardDirtyDot`, `WorkspaceCardTerminalIcon`, `WorkspaceCardPortsButton`, `WorkspaceCardSessionLine`, `WorkspaceCardMoreChats` (props in the code below).
  - Every interactive child carries `data-card-control` and `pointer-events-auto`; tooltips that need hover (glyph, title, branch, dirty dot, terminal) are `pointer-events-auto` too.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/sidebar/WorkspaceCard.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { ProviderDriverKind } from "@bibcode/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children?: ReactNode }) => <span data-tooltip="">{children}</span>,
  TooltipTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
    render ? cloneElement(render, undefined, children) : <>{children}</>,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuSubItem: ({ children, ...props }: React.ComponentProps<"li">) => (
    <li {...props}>{children}</li>
  ),
}));
vi.mock("../ThreadStatusIndicators", () => ({
  ChangeRequestStatusIcon: ({ className }: { className?: string }) => (
    <svg data-icon="change-request" className={className} />
  ),
}));

import { WORKSPACE_CARD_STATUS } from "../Sidebar.logic";
import {
  isWorkspaceCardControlTarget,
  WorkspaceCardBranchLine,
  WorkspaceCardPrButton,
  WorkspaceCardPortsButton,
  WorkspaceCardMoreChats,
  WorkspaceCardSessionLine,
  WorkspaceCardShell,
  WorkspaceCardStatusGlyph,
  WorkspaceCardTitleLine,
} from "./WorkspaceCard";

const noop = () => {};

describe("WorkspaceCardStatusGlyph", () => {
  it.each([
    ["approval", "lucide-hand"],
    ["input", "lucide-circle-question-mark"],
    ["working", "lucide-loader-circle"],
    ["connecting", "lucide-loader-circle"],
    ["failed", "lucide-triangle-alert"],
    ["plan", "lucide-list-checks"],
  ] as const)("draws %s with its icon and accessible name", (key, iconClass) => {
    const status = WORKSPACE_CARD_STATUS[key];
    const markup = renderToStaticMarkup(<WorkspaceCardStatusGlyph status={status} />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain(`aria-label="${status.label}"`);
    expect(markup).toContain(`data-status="${status.kind}"`);
    expect(markup).toContain(iconClass);
    expect(markup).toContain(status.colorClass.split(" ")[0]!);
  });

  it("spins only when motion is allowed", () => {
    expect(
      renderToStaticMarkup(<WorkspaceCardStatusGlyph status={WORKSPACE_CARD_STATUS.working} />),
    ).toContain("motion-safe:animate-spin");
  });

  it("draws the finished dot filled and the idle ring hollow", () => {
    expect(
      renderToStaticMarkup(<WorkspaceCardStatusGlyph status={WORKSPACE_CARD_STATUS.done} />),
    ).toContain('r="4" fill="currentColor"');
    expect(
      renderToStaticMarkup(<WorkspaceCardStatusGlyph status={WORKSPACE_CARD_STATUS.idle} />),
    ).toContain('r="3.5" fill="none"');
  });
});

describe("WorkspaceCardShell", () => {
  it("keeps PR and ports as focusable sibling controls without activating the card", async () => {
    const openCard = vi.fn();
    const openPr = vi.fn();
    const openPorts = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <WorkspaceCardShell testId="card" buttonTestId="card-button" className="" idBase="controls"
          isActive={false} hasFlags={false} hasBranchLine hasSessionLine={false}
          status={WORKSPACE_CARD_STATUS.idle}
          onClick={(event) => { if (!isWorkspaceCardControlTarget(event.target)) openCard(); }}
          onContextMenu={noop} onButtonKeyDown={noop}>
          <WorkspaceCardPrButton indicator={{ url: "https://example.invalid/1", tooltip: "Open MR !1",
            label: "MR open", colorClass: "text-foreground", numberLabel: "!1" }} onClick={openPr} />
          <WorkspaceCardPortsButton ports={[{ port: 3000 }]} onClick={openPorts} />
        </WorkspaceCardShell>,
      ));
      const card = container.querySelector<HTMLButtonElement>('[data-testid="card-button"]')!;
      const pr = container.querySelector<HTMLButtonElement>('[aria-label="Open MR !1"]')!;
      const ports = container.querySelector<HTMLButtonElement>('[aria-label="Open localhost:3000"]')!;
      for (const control of [pr, ports]) {
        expect(card.contains(control)).toBe(false);
        control.focus();
        expect(document.activeElement).toBe(control);
        await act(async () => control.click());
      }
      expect(openPr).toHaveBeenCalledOnce();
      expect(openPorts).toHaveBeenCalledOnce();
      expect(openCard).not.toHaveBeenCalled();
      card.focus();
      expect(document.activeElement).toBe(card);
      await act(async () => card.click());
      expect(openCard).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("names the one button by status, title and flags, and describes it by lines 2–3", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardShell
        testId="thread-row-a"
        buttonTestId="thread-card-button-a"
        className="card-surface"
        idBase="card"
        isActive
        hasFlags
        hasBranchLine
        hasSessionLine={false}
        status={WORKSPACE_CARD_STATUS.working}
        onClick={noop}
        onContextMenu={noop}
        onButtonKeyDown={noop}
      >
        <span>lines</span>
      </WorkspaceCardShell>,
    );
    expect(markup).toContain('data-testid="thread-row-a"');
    expect(markup).toContain('data-thread-item="true"');
    expect(markup).toContain('data-testid="thread-card-button-a"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-labelledby="card-status card-title card-flags"');
    expect(markup).toContain('aria-describedby="card-branch"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('id="card-status"');
    expect(markup).toContain("pointer-events-none relative z-10 flex gap-2 px-2 py-1.5");
    expect(markup).toContain("flex h-5 w-4 shrink-0 items-center justify-center");
  });

  it("omits the description and aria-current when there is nothing to describe", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardShell
        testId="thread-row-b"
        buttonTestId="thread-card-button-b"
        className=""
        idBase="card"
        isActive={false}
        hasFlags={false}
        hasBranchLine={false}
        hasSessionLine={false}
        status={WORKSPACE_CARD_STATUS.idle}
        onClick={noop}
        onContextMenu={noop}
        onButtonKeyDown={noop}
      >
        {null}
      </WorkspaceCardShell>,
    );
    expect(markup).toContain('aria-labelledby="card-status card-title"');
    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain("aria-current");
  });
});

describe("card lines", () => {
  it("keeps 13 px icons inside PR and ports targets of at least 24 px", () => {
    const markup = renderToStaticMarkup(
      <>
        <WorkspaceCardPrButton indicator={{ url: "https://example.invalid/57", tooltip: "Open MR !57",
          label: "MR open", colorClass: "text-foreground", numberLabel: "!57" }} onClick={noop} />
        <WorkspaceCardPortsButton ports={[{ port: 3000 }]} onClick={noop} />
      </>,
    );
    expect(markup.match(/min-h-6 min-w-6/g)).toHaveLength(2);
    expect(markup.match(/size-\[13px\]/g)).toHaveLength(2);
  });

  it("renders unknown-provider initials at text-xs through the real imported icon", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardSessionLine id="s"
        provider={{ driverKind: ProviderDriverKind.make("custom"), label: "Custom Provider" }}
        preview={{ text: "Ready", tone: null }} model="custom" ageIso={null} />,
    );
    expect(markup).toContain(">CP</span>");
    expect(markup).toContain("text-xs");
    expect(markup).not.toMatch(/text-\[(?:8|9|10|11)px\]/);
  });

  it("bolds an unread title and announces unread and pinned", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardTitleLine
        id="t"
        flagsId="f"
        title="Upgrade PDF renderer"
        titleTestId="thread-title-a"
        unread
        pinned
        pinnedTestId="thread-pinned-a"
      />,
    );
    expect(markup).toContain("font-semibold text-foreground");
    expect(markup).toContain('data-unread="true"');
    expect(markup).toContain('id="f" class="sr-only">unread, pinned</span>');
    expect(markup).toContain('data-testid="thread-pinned-a"');
  });

  it("shows a read title muted with the primary chip", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardTitleLine
        id="t"
        flagsId="f"
        title="develop"
        titleTestId="primary-card-title-p"
        unread={false}
        pinned={false}
        primary
      />,
    );
    expect(markup).toContain("text-[13px] text-foreground/80");
    expect(markup).toContain(">primary<");
    expect(markup).not.toContain("sr-only");
  });

  it("keeps the indicators right-aligned when the branch text is hidden", () => {
    const hidden = renderToStaticMarkup(
      <WorkspaceCardBranchLine id="b" branch={null} branchTooltip={null}>
        <span>indicator</span>
      </WorkspaceCardBranchLine>,
    );
    expect(hidden).not.toContain("lucide-git-branch");
    expect(hidden).toContain('<span class="flex-1"></span><span>indicator</span>');
    const shown = renderToStaticMarkup(
      <WorkspaceCardBranchLine id="b" branch="fix-TRI-150" branchTooltip="Worktree: fix-TRI-150 (fix-TRI-150)" />,
    );
    expect(shown).toContain("lucide-git-branch");
    expect(shown).toContain("fix-TRI-150");
    expect(shown).toContain("h-[18px]");
  });

  it("renders line 3 with the preview tone, a mono model and no age without a source", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCardSessionLine
        id="s"
        provider={{ driverKind: null, label: null }}
        preview={{ text: "Delivery failed", tone: "destructive" }}
        model="opus"
        ageIso={null}
      />,
    );
    expect(markup).toContain("text-destructive");
    expect(markup).toContain("Delivery failed");
    expect(markup).toContain("max-w-28 shrink-0 truncate font-mono text-xs");
    expect(markup).toContain(">opus<");
    expect(markup).not.toContain("<time");
  });

  it("says how many more chats without a chevron", () => {
    const two = renderToStaticMarkup(
      <WorkspaceCardMoreChats count={2} status={WORKSPACE_CARD_STATUS.idle} />,
    );
    expect(two).toContain("2 more chats");
    expect(two).not.toContain("lucide-chevron-right");
    expect(
      renderToStaticMarkup(<WorkspaceCardMoreChats count={1} status={WORKSPACE_CARD_STATUS.done} />),
    ).toContain("1 more chat<");
  });
});

describe("isWorkspaceCardControlTarget", () => {
  it("recognises events from the card's own controls", () => {
    expect(isWorkspaceCardControlTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(true);
    expect(isWorkspaceCardControlTarget({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(isWorkspaceCardControlTarget(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar/WorkspaceCard.test.tsx`
Expected: FAIL — `./WorkspaceCard` doesn't exist.

- [ ] **Step 3: Implement the module**

Create `apps/web/src/components/sidebar/WorkspaceCard.tsx`:

```tsx
import type { ProviderDriverKind } from "@bibcode/contracts";
import {
  CircleHelpIcon,
  GitBranchIcon,
  Globe2Icon,
  HandIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PinIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { WorkspaceCardStatus } from "../Sidebar.logic";
import { ChangeRequestStatusIcon, type PrStatusIndicator } from "../ThreadStatusIndicators";
import { SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RelativeAge } from "./RelativeAge";
import type { WorkspaceCardPreview } from "./workspaceCard.logic";

/** Element ids a card's button points at for its name and description. */
export function workspaceCardIds(idBase: string) {
  return {
    status: `${idBase}-status`,
    title: `${idBase}-title`,
    flags: `${idBase}-flags`,
    branch: `${idBase}-branch`,
    session: `${idBase}-session`,
  } as const;
}

/** True for events that start on one of the card's own controls (PR, ports, Archive, rename). */
export function isWorkspaceCardControlTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === "function" && element.closest("[data-card-control]") != null;
}

const GLYPH_ICON_CLASS = "size-3.5";

function StatusShape({ kind }: { readonly kind: WorkspaceCardStatus["kind"] }) {
  switch (kind) {
    case "approval":
      return <HandIcon aria-hidden className={GLYPH_ICON_CLASS} />;
    case "input":
      return <CircleHelpIcon aria-hidden className={GLYPH_ICON_CLASS} />;
    case "working":
      return <LoaderCircleIcon aria-hidden className={cn(GLYPH_ICON_CLASS, "motion-safe:animate-spin")} />;
    case "failed":
      return <TriangleAlertIcon aria-hidden className={GLYPH_ICON_CLASS} />;
    case "plan":
      return <ListChecksIcon aria-hidden className={GLYPH_ICON_CLASS} />;
    case "done":
      return (
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      );
    case "idle":
      return (
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5">
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

/** The status glyph: its shape carries the meaning and colour only helps (UI.md:208-210). */
export function WorkspaceCardStatusGlyph(props: {
  readonly status: WorkspaceCardStatus;
  readonly id?: string;
  readonly className?: string;
}) {
  const { status } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={status.label}
            id={props.id}
            data-status={status.kind}
            className={cn(
              "pointer-events-auto inline-flex items-center justify-center",
              status.colorClass,
              props.className,
            )}
          />
        }
      >
        <StatusShape kind={status.kind} />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

export interface WorkspaceCardShellProps {
  readonly testId: string;
  readonly buttonTestId: string;
  readonly className: string;
  readonly idBase: string;
  readonly isActive: boolean;
  readonly hasFlags: boolean;
  readonly hasBranchLine: boolean;
  readonly hasSessionLine: boolean;
  readonly status: WorkspaceCardStatus;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClick: (event: React.MouseEvent<HTMLLIElement>) => void;
  readonly onDoubleClick?: (event: React.MouseEvent<HTMLLIElement>) => void;
  readonly onContextMenu: (event: React.MouseEvent<HTMLLIElement>) => void;
  readonly onMouseLeave?: () => void;
  readonly onBlurCapture?: (event: React.FocusEvent<HTMLLIElement>) => void;
  readonly onButtonKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * A workspace card: an `li` holding one `<button>` that covers the whole card
 * and carries its name (status, title, unread/pinned) and description (lines
 * 2–3). The visible content sits above the button and lets pointer events fall
 * through to it, except the card's own controls, which are siblings of the
 * button and never inside it. Pointer handlers live on the `li`, so a click
 * anywhere on the card, or Enter/Space on the focused button, reaches them.
 */
export function WorkspaceCardShell(props: WorkspaceCardShellProps) {
  const ids = workspaceCardIds(props.idBase);
  const labelledBy = [ids.status, ids.title, ...(props.hasFlags ? [ids.flags] : [])].join(" ");
  const describedBy = [
    ...(props.hasBranchLine ? [ids.branch] : []),
    ...(props.hasSessionLine ? [ids.session] : []),
  ].join(" ");
  return (
    <SidebarMenuSubItem
      className={props.className}
      data-thread-item
      data-testid={props.testId}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      onMouseLeave={props.onMouseLeave}
      onBlurCapture={props.onBlurCapture}
    >
      <button
        type="button"
        data-testid={props.buttonTestId}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        aria-current={props.isActive ? "page" : undefined}
        className="absolute inset-0 z-0 cursor-pointer rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={props.onButtonKeyDown}
      />
      <div className="pointer-events-none relative z-10 flex gap-2 px-2 py-1.5">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <WorkspaceCardStatusGlyph status={props.status} id={ids.status} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">{props.children}</div>
      </div>
      {props.footer ? (
        <div className="relative z-10" data-card-control>
          {props.footer}
        </div>
      ) : null}
    </SidebarMenuSubItem>
  );
}

/** Line 1: title (bold while unread), primary chip, pin, then trailing controls. */
export function WorkspaceCardTitleLine(props: {
  readonly id: string;
  readonly flagsId: string;
  readonly title: string;
  readonly titleTestId: string;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly pinnedTestId?: string;
  readonly primary?: boolean;
  /** Replaces the visible title while renaming inline. */
  readonly renameInput?: ReactNode;
  /** Archive/Confirm, or the ⌘ jump label while the modifier is held. */
  readonly trailing?: ReactNode;
}) {
  const flags = [props.unread ? "unread" : null, props.pinned ? "pinned" : null]
    .filter((flag) => flag !== null)
    .join(", ");
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      {props.renameInput ? (
        <>
          <span id={props.id} className="sr-only">
            {props.title}
          </span>
          {props.renameInput}
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                id={props.id}
                data-testid={props.titleTestId}
                data-unread={props.unread ? "true" : undefined}
                className={cn(
                  "pointer-events-auto min-w-0 truncate text-[13px]",
                  props.unread ? "font-semibold text-foreground" : "text-foreground/80",
                )}
              />
            }
          >
            {props.title}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
            {props.title}
          </TooltipPopup>
        </Tooltip>
      )}
      {props.primary ? (
        <span className="shrink-0 rounded border border-border bg-muted px-1.5 text-xs leading-4 text-muted-foreground">
          primary
        </span>
      ) : null}
      {props.pinned ? (
        <PinIcon
          aria-hidden
          data-testid={props.pinnedTestId}
          className="size-3 shrink-0 text-muted-foreground"
        />
      ) : null}
      {flags ? (
        <span id={props.flagsId} className="sr-only">
          {flags}
        </span>
      ) : null}
      <span className="flex-1" />
      {props.trailing}
    </div>
  );
}

/** Line 2: branch (or a spacer when hidden), then indicators at the right end. */
export function WorkspaceCardBranchLine(props: {
  readonly id: string;
  readonly branch: string | null;
  readonly branchTooltip: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div
      id={props.id}
      className="flex h-[18px] min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      {props.branch !== null ? (
        <>
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <Tooltip>
            <TooltipTrigger
              render={<span className="pointer-events-auto min-w-0 flex-1 truncate" />}
            >
              {props.branch}
            </TooltipTrigger>
            {props.branchTooltip ? (
              <TooltipPopup side="top">{props.branchTooltip}</TooltipPopup>
            ) : null}
          </Tooltip>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {props.children}
    </div>
  );
}

/** The PR/MR number: a button coloured by its state that opens the request. */
export function WorkspaceCardPrButton(props: {
  readonly indicator: PrStatusIndicator;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-card-control
            aria-label={props.indicator.tooltip}
            className={cn(
              "pointer-events-auto inline-flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center gap-[3px] rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
              props.indicator.colorClass,
            )}
            onClick={props.onClick}
          />
        }
      >
        <ChangeRequestStatusIcon className="size-[13px]" />
        {props.indicator.numberLabel}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.indicator.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function WorkspaceCardDirtyDot() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Uncommitted changes"
            className="pointer-events-auto size-1.5 shrink-0 rounded-full bg-warning"
          />
        }
      />
      <TooltipPopup side="top">Uncommitted changes</TooltipPopup>
    </Tooltip>
  );
}

export function WorkspaceCardTerminalIcon(props: {
  readonly label: string;
  readonly colorClass: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={props.label}
            className={cn(
              "pointer-events-auto inline-flex shrink-0 items-center justify-center",
              props.colorClass,
            )}
          />
        }
      >
        <TerminalIcon aria-hidden className="size-[13px]" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Opens the first local server a terminal of this card discovered. */
export function WorkspaceCardPortsButton(props: {
  readonly ports: ReadonlyArray<{ readonly port: number }>;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const first = props.ports[0];
  if (!first) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-card-control
            aria-label={`Open localhost:${first.port}`}
            className="pointer-events-auto inline-flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center text-emerald-600 outline-hidden focus-visible:ring-1 focus-visible:ring-ring dark:text-emerald-400"
            onClick={props.onClick}
          />
        }
      >
        <Globe2Icon aria-hidden className="size-[13px]" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        Open localhost:{first.port}
        {props.ports.length > 1 ? ` (+${props.ports.length - 1})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Line 3: provider icon, preview, model and age. */
export function WorkspaceCardSessionLine(props: {
  readonly id: string;
  readonly provider: {
    readonly driverKind: ProviderDriverKind | null;
    readonly label: string | null;
  };
  readonly preview: WorkspaceCardPreview;
  readonly model: string;
  readonly ageIso: string | null;
}) {
  return (
    <div
      id={props.id}
      className="flex h-[22px] min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      {props.provider.driverKind !== null ? (
        <ProviderInstanceIcon
          driverKind={props.provider.driverKind}
          displayName={props.provider.label ?? ""}
          className="workspace-card-provider-icon size-[13px]"
          iconClassName="size-[13px] text-xs"
          showBadge={false}
        />
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          props.preview.tone === "destructive" && "text-destructive",
          props.preview.tone === "warning" && "text-warning-foreground",
        )}
      >
        {props.preview.text}
      </span>
      <span className="max-w-28 shrink-0 truncate font-mono text-xs">{props.model}</span>
      <RelativeAge iso={props.ageIso} className="shrink-0 tabular-nums" />
    </div>
  );
}

/** Other chats open in this checkout, until the server links chats to their host thread. */
export function WorkspaceCardMoreChats(props: {
  readonly count: number;
  readonly status: WorkspaceCardStatus;
}) {
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="flex w-4 shrink-0 items-center justify-center">
        <WorkspaceCardStatusGlyph status={props.status} />
      </span>
      <span className="truncate">
        {props.count === 1 ? "1 more chat" : `${props.count} more chats`}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar/WorkspaceCard.test.tsx`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Review**

`vercel-react-best-practices`: presentational functions only, no state or effects; icons and ids are derived per render with no allocation beyond small strings (`rendering-*`). `UI.md`: 12 px floor, solid `text-muted-foreground`, no letter-spacing, glyph shapes that read without colour, focus ring on the whole card, 24 px PR/ports hit areas with unchanged 13 px glyphs, 24 px Archive target kept by the container, and sidebar-only text-xs initials on the real ProviderInstanceIcon. Record both.

- [ ] **Step 6: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/sidebar/WorkspaceCard.tsx apps/web/src/components/sidebar/WorkspaceCard.test.tsx`.

## Task 15: Worktree cards replace the thread rows

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (imports; `SidebarThreadRowProps` and `SidebarThreadRow` replaced; `SidebarProjectThreadListProps`/`SidebarProjectThreadList` pass card data; `SidebarProjectItem` builds model labels and chat summaries)
- Modify: `apps/web/src/components/Sidebar.logic.ts` (delete `formatSessionDuration`)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx` (delete `ThreadWorktreeIndicator`)
- Test: `apps/web/src/components/ThreadStatusIndicators.test.tsx`
- Test: `apps/web/src/components/Sidebar.test.tsx`
- Create: `apps/web/src/components/sidebar/workspaceCardLookups.ts`, `useWorkspaceCardLookups.ts`, `useWorkspaceCardLookups.test.tsx`

**Interfaces:**
- Consumes: Tasks 6, 7, 11–14.
- Produces:
  - `SidebarThreadRowProps` gains `modelLabel: string`, `moreChatsCount: number`, `moreChatsStatus: WorkspaceCardStatus | null`; `SidebarThreadRow` is `memo(…, sameSidebarThreadRowProps)`;
  - the card `li` keeps `data-testid="thread-row-<id>"` and gains the button `data-testid="thread-card-button-<id>"`; title `thread-title-<id>`, pin `thread-pinned-<id>`, Archive `thread-archive-<id>`, Confirm `thread-archive-confirm-<id>` stay; `thread-agent-row-<id>`, `thread-delivery-row-<id>` and `thread-unread-<id>` are gone;
  - `SidebarProjectThreadListProps` gains `project`, `serverConfigs`, `primaryThread`, `modelLabels` and `chatSummaries`; the list builds keys/flags, adopted-workspace, running-terminal and discovered-port Maps once, then passes scalar values and stable array references to cards. No per-card collection scans.

- [ ] **Step 1: Update the tests for the card**

In `apps/web/src/components/Sidebar.test.tsx`:

Add `cardLookupPass: vi.fn(),` to the hoisted `const spies` object. Add these imports and the helper next to `threadKeyOf`. Both static/browser `rowProps` use it; production cards receive these values from the list's Maps.

```ts
import { showContextMenuFallback } from "../contextMenuFallback";

function cardDataProps(thread: EnvironmentThreadShell) {
  const key = threadKeyOf(thread);
  const catalog = h.state.worktreeCatalogs.get(
    `${thread.environmentId}:${thread.projectId}`,
  ) as { adoptedWorkspaces: Array<{ threadId: string }> } | undefined;
  return {
    isPinned: h.metaStore.getState().pinnedThreadKeys.includes(key),
    isUnread: h.metaStore.getState().unreadThreadKeys.includes(key),
    worktreeStatus: (catalog?.adoptedWorkspaces.find((row) => row.threadId === thread.id) ?? null) as
      import("@bibcode/contracts").VcsAdoptedWorktreeStatus | null,
    runningTerminalIds: h.state.runningTerminalIds as readonly string[],
    discoveredPorts: (h.state.discoveredPortsByThreadId[thread.id] ?? []) as
      readonly import("@bibcode/contracts").DiscoveredLocalServer[],
  };
}

vi.mock("./sidebar/useWorkspaceCardLookups", async () => {
  const indexes = await import("./sidebar/workspaceCardLookups");
  const { selectWorktreeCatalogCapabilityPolicy: policy } =
    await import("@bibcode/client-runtime/state/worktrees");
  return {
    useWorkspaceCardLookups: (input: {
      project: import("../sidebarProjectGrouping").SidebarProjectSnapshot;
      serverConfigs: ReadonlyMap<import("@bibcode/contracts").EnvironmentId, import("@bibcode/contracts").ServerConfig>;
      active: boolean;
      threads: readonly EnvironmentThreadShell[];
      pinnedKeys: readonly string[];
      unreadKeys: readonly string[];
    }) => {
      h.spies.cardLookupPass(input);
      const adopted = input.active ? input.project.memberProjects.flatMap((member) => {
        const config = input.serverConfigs.get(member.environmentId);
        if (!config || policy(config.environment).catalogRpc !== "enabled") return [];
        h.state.discoveryCatalogSubscriptions.push({
          environmentId: member.environmentId, input: { projectId: member.id },
        });
        const catalog = h.state.worktreeCatalogs.get(`${member.environmentId}:${member.id}`);
        return [{ environmentId: member.environmentId, rows: catalog?.adoptedWorkspaces ?? [] }];
      }) : [];
      return {
        keys: indexes.buildWorkspaceCardKeys(input.threads, input.pinnedKeys, input.unreadKeys),
        adopted: indexes.buildAdoptedWorkspaceMap(adopted),
        terminals: new Map(input.threads.map((thread) => [threadKeyOf(thread), cardDataProps(thread).runningTerminalIds])),
        ports: new Map(input.threads.map((thread) => [threadKeyOf(thread), cardDataProps(thread).discoveredPorts])),
      };
    },
  };
});
```

The per-card scans above are confined to fixture setup; production uses the tested Maps.

In the existing "keeps grouped mixed-capability discovery at the supported physical boundary" test (`Sidebar.test.tsx` at ~2496; expectation at ~2517), replace only the `discoveryCatalogSubscriptions` expectation with:

```ts
    expect(h.state.discoveryCatalogSubscriptions).toEqual([
      { environmentId: ENV_MAIN, input: { projectId: projectA.id } },
      { environmentId: ENV_MAIN, input: { projectId: projectA.id } },
    ]);
```

The list lookup mock above and the discovery section each record one supported-member catalog access. Keep `expect(markup).not.toContain("feature/remote");` and the existing `feature/local` and `discoveryFocusRefreshCalls` assertions unchanged; the exact two-entry expectation must contain no `ENV_REMOTE` access.

Add inside `staticDescribe("Sidebar full render", …)` to connect the hook's once-per-Map test below to the actual list:

```tsx
  it("collects lookup data once for the actual project list, not once per card", () => {
    baseScenario();
    h.state.threads = [threadDefault, ...Array.from({ length: 6 }, (_, i) =>
      makeThread("lookup-" + i, { title: "Workspace " + i }))];
    h.spies.cardLookupPass.mockClear();
    render(<Sidebar />);
    expect(h.spies.cardLookupPass).toHaveBeenCalledTimes(1);
    const input = h.spies.cardLookupPass.mock.calls[0]![0] as { threads: readonly unknown[] };
    expect(input.threads.length).toBeGreaterThan(1);
  });
```

For Task 6's "omits Copy Branch Name when the row shows no branch" test, replace its initial `const row = setupMenu(null);` with this complete setup so the new VCS observation has no live branch either:

```tsx
    baseScenario();
    h.state.vcsStatusByCwd[projectA.workspaceRoot] = { refName: null, detachedHead: null };
    render(<Sidebar />);
    fakeLocalApi();
    const row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
```

Replace Task 6's test "copies the retained indicator branch even if VCS has a newer ref" with:

```tsx
  it("switches branch display and copy together to the fresh live ref", async () => {
    baseScenario();
    h.state.vcsStatusByCwd["C:/wt/x"] = { refName: "fresh-displayed" };
    const markup = render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockResolvedValue("copy-branch-name");
    expect(markup).toContain(">fresh-displayed<");
    invoke(mustFindProps(byTestId("thread-row-thread-active"), "row"), "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("fresh-displayed", { branch: "fresh-displayed" });
  });
```

1. In the `vi.mock("./ThreadStatusIndicators", …)` factory, delete the `ThreadWorktreeIndicator: h.mk("ThreadWorktreeIndicator", "span"),` line and replace the `prStatusIndicator` entry with:

```ts
  prStatusIndicator: (pr: { url: string } | null) =>
    pr ? { url: pr.url, tooltip: "PR open", colorClass: "pr-color", numberLabel: "#1" } : null,
```

2. Add `WORKSPACE_CARD_STATUS` to the imports: after the `import Sidebar, { … } from "./Sidebar";` block add `import { WORKSPACE_CARD_STATUS } from "./Sidebar.logic";`.

3. In "surfaces a failed session in the sidebar instead of hiding it as disconnected", replace `expect(markup).toContain("thread-agent-row-thread-failed");` and `expect(markup).toContain("Failed");` with:

```ts
    expect(markup).toContain('aria-label="Failed"');
    expect(markup).toContain("Claude Code");
```

4. In "renders the project header, primary row, and workspace thread rows", replace

```ts
    // Running session renders the nested agent sub-row.
    expect(markup).toContain("thread-agent-row-thread-active");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Running");
```

   with

```ts
    // A running session shows the Working glyph; line 3 names the provider.
    expect(markup).toContain('aria-label="Working"');
    expect(markup).toContain("Claude Code");
    expect(markup).not.toContain("thread-agent-row-");
```

5. In "subscribes only while the existing child panel is rendered and places discovery before primary", replace `captured("SidebarMenuSubButton").some(` with `captured("SidebarMenuSubItem").some(` (the row test id now sits on the card `li`).

6. In `staticDescribe("thread rows in the full sidebar", () => {`, replace the whole test `it("navigates via keyboard activation", () => { … });` with:

```ts
  it("activates from the card button and opens exactly one menu with Shift+F10", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    // Enter and Space on the card's <button> dispatch a click with detail 0.
    invoke(renderedRow("thread-idle"), "onClick", mouseEvent({ detail: 0 }));
    expect(h.spies.routerNavigate).toHaveBeenCalled();

    const button = mustFindProps(byTestId("thread-card-button-thread-idle"), "card button");
    const enter = keyboardEvent("Enter");
    invoke(button, "onKeyDown", enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();

    const shiftF10 = keyboardEvent("F10", {
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      currentTarget: {
        getBoundingClientRect: () => ({ left: 40.4, top: 100, right: 380, bottom: 152.6 }),
      },
    });
    invoke(button, "onKeyDown", shiftF10);
    expect(shiftF10.preventDefault).toHaveBeenCalled();
    // Chromium and WebView2 follow the key with a contextmenu event; it must not open a second menu.
    invoke(renderedRow("thread-idle"), "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalledTimes(1);
    expect(h.spies.contextMenuShow.mock.calls[0]![1]).toEqual({ x: 40, y: 153 });
  });

  it("keeps the pointer position for a right-click after the keyboard echo window", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    try {
      const button = mustFindProps(byTestId("thread-card-button-thread-idle"), "card button");
      invoke(
        button,
        "onKeyDown",
        keyboardEvent("ContextMenu", {
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          currentTarget: { getBoundingClientRect: () => ({ left: 8, top: 0, right: 300, bottom: 60 }) },
        }),
      );
      now.mockReturnValue(11_500);
      invoke(renderedRow("thread-idle"), "onContextMenu", mouseEvent({ clientX: 120, clientY: 90 }));
      await flush();
      expect(h.spies.contextMenuShow).toHaveBeenCalledTimes(2);
      expect(h.spies.contextMenuShow.mock.calls[0]![1]).toEqual({ x: 8, y: 60 });
      expect(h.spies.contextMenuShow.mock.calls[1]![1]).toEqual({ x: 120, y: 90 });
    } finally {
      now.mockRestore();
    }
  });
```

7. In `staticDescribe("SidebarThreadRow direct rendering", () => {`, add to the object returned by `rowProps` (before `...overrides`):

```ts
      ...cardDataProps(thread),
      modelLabel: "gpt-5-codex",
      moreChatsCount: 0,
      moreChatsStatus: null,
```

   and make the same addition in the browser describe's `rowProps` (inside `if (browserRuntime) {`).

8. Replace the test "renders unread and pinned markers with a jump label" body's first two expectations

```ts
    expect(markup).toContain("thread-unread-thread-a");
    expect(markup).toContain("thread-pinned-thread-a");
```

   with

```ts
    expect(markup).toContain('data-unread="true"');
    expect(markup).toContain(">unread, pinned</span>");
    expect(markup).toContain("thread-pinned-thread-a");
```

9. Replace the whole test `it("keeps failure and unresolved-delivery subrows visible with summary updates", () => { … });` with:

```ts
  it("folds failure and unresolved delivery into the glyph and the session line", () => {
    const failed = makeThread("thread-provider-failed", {
      branch: "feature/failure",
      worktreePath: "C:/wt/failure",
      session: {
        threadId: ThreadId.make("thread-provider-failed"),
        status: "error",
        providerName: "Claude Code",
        activeTurnId: null,
        lastError: "provider exited",
        updatedAt: iso(1),
        runtimeMode: "full-access",
      } as EnvironmentThreadShell["session"],
    });
    h.state.vcsStatusByCwd["C:/wt/failure"] = { refName: "feature/failure" };
    const failedMarkup = render(<SidebarThreadRow {...rowProps(failed)} />);
    expect(failedMarkup).toContain('aria-label="Failed"');
    expect(failedMarkup).not.toContain("Claude Code – Failed");

    const unresolved = makeThread("thread-delivery-uncertain", {
      branch: "feature/delivery",
      worktreePath: "C:/wt/delivery",
      unresolvedDelivery: { state: "uncertain" },
      session: {
        threadId: ThreadId.make("thread-delivery-uncertain"),
        status: "starting",
        providerName: "OpenCode",
        activeTurnId: null,
        lastError: null,
        updatedAt: iso(2),
        runtimeMode: "full-access",
      },
    } as never);
    h.state.vcsStatusByCwd["C:/wt/delivery"] = { refName: "feature/updated" };
    const unresolvedMarkup = render(<SidebarThreadRow {...rowProps(unresolved)} />);
    expect(unresolvedMarkup).toContain("Delivery uncertain");
    expect(unresolvedMarkup).toContain('aria-label="Connecting"');
    expect(h.state.vcsQueries.at(-1)?.__q).toBe("vcs.summary");
  });
```

10. Replace the two tests `it("labels a remote thread with the cloud icon and falls back to 'Remote'", …)` and `it("labels a desktop-local thread as 'Local' without the cloud icon", …)` with:

```ts
  it("shows no environment icon on cards, even for remote threads", () => {
    const markup = render(
      <SidebarThreadRow {...rowProps(makeThread("thread-remote-b", { environmentId: ENV_REMOTE }))} />,
    );
    expect(markup).not.toContain('aria-label="Remote"');
    expect(markup).not.toContain("lucide-cloud");
  });
```

    In `staticDescribe("grouped and remote projects", () => {`, the test `it("groups projects by repository and renders remote thread markers"` found "Remote Box" only in the old row's cloud tooltip. Rename it `it("groups projects by repository across environments"` and replace `expect(markup).toContain("Remote Box");` with `expect(markup).not.toContain("lucide-cloud");`.

11. Replace the test `it("renders the agent sub-row for a starting session without a parsable timestamp", …)` with:

```ts
  it("shows Connecting for a starting session without a provider name", () => {
    const thread = makeThread("thread-a", {
      session: {
        threadId: ThreadId.make("thread-a"),
        status: "starting",
        providerName: null,
        activeTurnId: null,
        lastError: null,
        updatedAt: "not-a-date",
        runtimeMode: "full-access",
      },
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).toContain('aria-label="Connecting"');
    expect(markup).not.toContain("Agent –");
  });
```

12. In "hides the archive button while a turn is actively running", replace `expect(markup).toContain("thread-agent-row-thread-a");` with `expect(markup).toContain('aria-label="Working"');`.

13. Add at the end of that describe:

```ts
  it("observes detached worktrees and shows their detached HEAD and dirty indicator", () => {
    const thread = makeThread("thread-detached", { branch: null, worktreePath: "C:/wt/detached" });
    h.state.vcsStatusByCwd["C:/wt/detached"] = {
      refName: null, detachedHead: "abc1234", hasWorkingTreeChanges: true,
    };
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(h.state.vcsQueries.at(-1)?.args?.input?.cwd).toBe("C:/wt/detached");
    expect(markup).toContain(">abc1234<");
    expect(markup).toContain('aria-label="Uncommitted changes"');

  });

  it.each([false, true])("never offers Archive for a running session with no active turn (approval=%s)", (approval) => {
    const thread = makeThread("running-no-turn", {
      hasPendingApprovals: approval,
      session: { ...threadActive.session!, status: "running", activeTurnId: null },
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).not.toContain("thread-archive-running-no-turn");
    expect(markup).not.toContain("thread-archive-confirm-running-no-turn");
  });

  it("omits line 2 when the branch equals the title and there are no indicators", () => {
    const thread = makeThread("same-title", { title: "feature/x", branch: "feature/x", worktreePath: "C:/wt/same" });
    h.state.vcsStatusByCwd["C:/wt/same"] = { refName: "feature/x" };
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).not.toContain("h-[18px]");
  });

  it("renders the worktree card's three lines and the more-chats row", () => {
    const thread = makeThread("thread-card", {
      title: "Fix invoice date format",
      branch: "fix-TRI-150",
      worktreePath: "C:/wt/fix",
      session: {
        threadId: ThreadId.make("thread-card"),
        status: "running",
        providerName: "claudeAgent",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: iso(6),
        runtimeMode: "full-access",
      } as EnvironmentThreadShell["session"],
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: iso(6),
        startedAt: iso(6),
        completedAt: null,
        assistantMessageId: null,
      } as EnvironmentThreadShell["latestTurn"],
      conversationPreview: {
        prompt: "Fix the export date format",
        tool: "Editing src/export/invoiceDates.ts",
        assistantMessage: null,
      },
    } as never);
    h.state.vcsStatusByCwd["C:/wt/fix"] = {
      refName: "fix-TRI-150",
      hasWorkingTreeChanges: true,
      pr: { url: "https://example.com/pr/57" },
    };
    h.state.runningTerminalIds = ["term-1"];
    const markup = render(
      <SidebarThreadRow
        {...rowProps(thread, {
          modelLabel: "opus",
          moreChatsCount: 2,
          moreChatsStatus: WORKSPACE_CARD_STATUS.done,
        })}
      />,
    );
    expect(markup).toContain('aria-label="Working"');
    expect(markup).toContain(">fix-TRI-150<");
    expect(markup).toContain("#1");
    expect(markup).toContain('aria-label="Uncommitted changes"');
    expect(markup).toContain('aria-label="1 terminal running"');
    expect(markup).toContain("Editing src/export/invoiceDates.ts");
    expect(markup).toContain(">opus<");
    expect(markup).toContain("2 more chats");
  });

  it("names the card button by status, title and flags and describes it by its lines", () => {
    const thread = makeThread("thread-a11y", {
      title: "Upgrade PDF renderer",
      branch: "chore/pdf-renderer",
      worktreePath: "C:/wt/pdf",
    });
    h.state.vcsStatusByCwd["C:/wt/pdf"] = { refName: "chore/pdf-renderer" };
    h.metaStore.setState({
      unreadThreadKeys: [threadKeyOf(thread)],
      pinnedThreadKeys: [threadKeyOf(thread)],
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread, { isActive: true })} />);
    const button = mustFindProps(byTestId("thread-card-button-thread-a11y"), "card button");
    const labelledBy = String(button["aria-labelledby"]).split(" ");
    expect(labelledBy).toHaveLength(3);
    for (const id of labelledBy) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(button["aria-current"]).toBe("page");
    expect(String(button["aria-describedby"]).split(" ")).toHaveLength(1);
  });
```

14. In the browser describe (skipped under Node, kept consistent), in "retains archive confirmation for focus inside the row…", replace

```ts
      const row = requiredElement<HTMLElement>(
        container,
        "[data-testid='thread-row-thread-browser-archive']",
      );
      await React.act(async () => row.focus());
```

   with

```ts
      const row = requiredElement<HTMLElement>(
        container,
        "[data-testid='thread-card-button-thread-browser-archive']",
      );
      await React.act(async () => row.focus());
```

Add inside the existing browser-runtime describe, after its `mount`/`dispatch`/`unmount` helpers. This uses the actual fallback renderer (only the LocalApi dispatch is bridged by the harness):

```tsx
  it.each(["thread-card-button-thread-idle"])(
    "keeps one real fallback menu open after the delayed keyboard echo on %s",
    async (testId) => {
      baseScenario();
      fakeLocalApi();
      h.spies.contextMenuShow.mockImplementation(showContextMenuFallback);
      const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
      const { container, root } = await mount(<Sidebar />);
      try {
        const button = requiredElement<HTMLButtonElement>(container, `[data-testid='${testId}']`);
        button.focus();
        await dispatch(button, new KeyboardEvent("keydown", {
          key: "F10", shiftKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const menu = document.querySelector('[role="menu"]');
        expect(menu).not.toBeNull();
        now.mockReturnValue(10_500);
        await dispatch(button, new PointerEvent("pointerdown", { button: 2, bubbles: true, cancelable: true }));
        await dispatch(button, new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(document.querySelector('[role="menu"]')).toBe(menu);
        expect(h.spies.contextMenuShow).toHaveBeenCalledTimes(1);
        await React.act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.activeElement).toBe(button);
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
      } finally {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        now.mockRestore();
        await unmount(root, container);
      }
    },
  );
```

Run the happy-dom variant at both red and green stages; the default Node command skips this describe:
`cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`.
Expected before implementation: FAIL (missing card/echo dismissal); after: PASS, with one surviving menu and restored card focus.

In `apps/web/src/components/Sidebar.logic.test.ts`: remove `formatSessionDuration,` from the import list; delete the whole `describe("formatSessionDuration", () => { … });`; in `it("clamps negative prewarm limits and invalid session elapsed time"`, delete the two `formatSessionDuration` expectations and rename the test to `it("clamps negative prewarm limits"`.

In `apps/web/src/components/ThreadStatusIndicators.test.tsx`: remove `ThreadWorktreeIndicator,` from the import list; in "renders worktree and status labels in every display mode" delete every `ThreadWorktreeIndicator` expectation (exactly four `expect(...)` blocks and the comment about the folder-git glyph, ending at the `">worktree<"` expectation; keep the following `const status` and both `ThreadStatusLabel` expectations) and rename it `it("renders status labels in every display mode"`; delete the whole `it.each([null, "", "   "])("renders no worktree for path %j", …)`.

Create `apps/web/src/components/sidebar/useWorkspaceCardLookups.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as indexes from "./workspaceCardLookups";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

const fixture = vi.hoisted(() => ({ sources: { adopted: [], terminals: [], ports: [] } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixture.sources }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../../state/preview", () => ({ previewEnvironment: {} }));
vi.mock("../../state/worktrees", () => ({ worktreeEnvironment: {} }));

import { useWorkspaceCardLookups } from "./useWorkspaceCardLookups";
afterEach(() => vi.restoreAllMocks());

describe("list-wide card lookups", () => {
  it("builds each Map once for a list render, reuses references, and never rebuilds per card", async () => {
    const builds = [
      vi.spyOn(indexes, "buildWorkspaceCardKeys"),
      vi.spyOn(indexes, "buildAdoptedWorkspaceMap"),
      vi.spyOn(indexes, "buildRunningTerminalMap"),
      vi.spyOn(indexes, "buildDiscoveredPortMap"),
    ];
    const environmentId = EnvironmentId.make("local");
    const threads = Array.from({ length: 50 }, (_, i) => ({
      id: ThreadId.make("thread-" + i), environmentId,
    }));
    const input = {
      project: { memberProjects: [] } as unknown as SidebarProjectSnapshot,
      serverConfigs: new Map(),
      active: true,
      threads,
      pinnedKeys: [] as string[],
      unreadKeys: [] as string[],
    };
    const seen: ReturnType<typeof useWorkspaceCardLookups>[] = [];
    function List() {
      const maps = useWorkspaceCardLookups(input);
      seen.push(maps);
      return <ul>{threads.map((thread) => {
        const key = maps.keys.get(thread)!.key;
        return <li key={key}>{maps.terminals.get(key)?.length ?? 0}</li>;
      })}</ul>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<List />));
      expect(container.querySelectorAll("li")).toHaveLength(50);
      for (const build of builds) expect(build).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<List />));
      for (const build of builds) expect(build).toHaveBeenCalledTimes(1);
      expect(seen.at(-1)).toBe(seen[0]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps equal thread ids in different environments separate and drops idle terminals", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const id = ThreadId.make("same");
    const key = (environmentId: typeof local) => scopedThreadKey(scopeThreadRef(environmentId, id));
    const terminal = (terminalId: string, hasRunningSubprocess: boolean) => ({
      threadId: id, terminalId, cwd: "/repo", worktreePath: null, status: "running" as const,
      pid: null, exitCode: null, exitSignal: null, hasRunningSubprocess, label: "", updatedAt: "2026-09-24T00:00:00Z",
    });
    const map = indexes.buildRunningTerminalMap([
      { environmentId: local, rows: [terminal("active", true), terminal("idle", false)] },
      { environmentId: remote, rows: [terminal("remote", true)] },
    ]);
    expect(map.get(key(local))).toEqual(["active"]);
    expect(map.get(key(remote))).toEqual(["remote"]);
    const port = { host: "localhost", port: 3000, url: "http://localhost:3000", processName: null,
      pid: null, terminal: { threadId: id, terminalId: "active" } };
    const ports = indexes.buildDiscoveredPortMap([
      { environmentId: local, rows: [port] },
      { environmentId: remote, rows: [{ ...port, port: 4000 }] },
    ]);
    expect(ports.get(key(local))?.[0]?.port).toBe(3000);
    expect(ports.get(key(remote))?.[0]?.port).toBe(4000);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx src/components/sidebar/useWorkspaceCardLookups.test.tsx`
Expected: FAIL — there is no card button, no glyph, no line 3, and `SidebarThreadRow` rejects the new props at type level (Vitest still runs; the assertions fail).

- [ ] **Step 3: Delete the dead helpers**

In `apps/web/src/components/Sidebar.logic.ts`, delete `formatSessionDuration` and its doc comment (keep `MINUTE_MS`, `HOUR_MS`, `DAY_MS`; `formatCompactAge` uses them).

In `apps/web/src/components/ThreadStatusIndicators.tsx`, delete `ThreadWorktreeIndicator` and its doc comment, and delete `import { formatWorktreePathForDisplay } from "../worktreeCleanup";`.

- [ ] **Step 4: Update `Sidebar.tsx` imports**

- In the `lucide-react` list remove `Globe2Icon,` and `TerminalIcon,` (the card module draws them).
- Replace the `from "./ThreadStatusIndicators";` import with:

```ts
import {
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
  ThreadStatusLabel,
} from "./ThreadStatusIndicators";
```

- Add `useId,` to the `react` import list.
- Replace `import { formatRelativeTimeLabel } from "../timestampFormat";` with nothing (delete it).
- In the `from "./Sidebar.logic";` list remove `formatSessionDuration,` and add `isContextMenuShortcut, isKeyboardContextMenuEcho, isWorkspaceThreadRunning, resolveWorkspaceCardAgeSource, resolveWorkspaceCardClassName, resolveWorkspaceCardStatus, resolveWorkspaceDirty, shouldShowWorkspaceBranchText, summarizeWorkspaceChats, workspaceCheckoutKey, type WorkspaceCardStatus, type WorkspaceChatSummary,`.
- Add after the `sidebarMenus.logic` import:

```ts
import { markKeyboardContextMenuOpened } from "../contextMenuKeyboard";
import { resolveAgentProvider } from "./sidebar/agentsSection.logic";
import {
  buildWorkspaceModelLabels,
  resolveWorkspaceCardBranchTooltip,
  resolveWorkspaceCardPreview,
  resolveWorkspaceModelLabel,
} from "./sidebar/workspaceCard.logic";
import {
  isWorkspaceCardControlTarget,
  WorkspaceCardBranchLine,
  WorkspaceCardDirtyDot,
  workspaceCardIds,
  WorkspaceCardMoreChats,
  WorkspaceCardPortsButton,
  WorkspaceCardPrButton,
  WorkspaceCardSessionLine,
  WorkspaceCardShell,
  WorkspaceCardTerminalIcon,
  WorkspaceCardTitleLine,
} from "./sidebar/WorkspaceCard";
```

- [ ] **Step 4a: Build the shared lookup Maps once in the list**

Create `apps/web/src/components/sidebar/workspaceCardLookups.ts`:

```ts
import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  ThreadId,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type TerminalSummary,
  type VcsAdoptedWorktreeStatus,
} from "@bibcode/contracts";
import type { SidebarThreadSummary } from "../../types";

export type CardKeyThread = Pick<SidebarThreadSummary, "id" | "environmentId">;
export interface WorkspaceCardSources {
  readonly adopted: readonly {
    environmentId: EnvironmentId;
    rows: readonly VcsAdoptedWorktreeStatus[];
  }[];
  readonly terminals: readonly {
    environmentId: EnvironmentId;
    rows: readonly TerminalSummary[];
  }[];
  readonly ports: readonly {
    environmentId: EnvironmentId;
    rows: readonly DiscoveredLocalServer[];
  }[];
}
export const EMPTY_CARD_SOURCES: WorkspaceCardSources = {
  adopted: [], terminals: [], ports: [],
};
export const EMPTY_CARD_TERMINALS: readonly string[] = [];
export const EMPTY_CARD_PORTS: readonly DiscoveredLocalServer[] = [];

const keyOf = (environmentId: EnvironmentId, threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

export function buildWorkspaceCardKeys(
  threads: readonly CardKeyThread[],
  pinnedKeys: readonly string[],
  unreadKeys: readonly string[],
) {
  const pinned = new Set(pinnedKeys);
  const unread = new Set(unreadKeys);
  return new Map(threads.map((thread) => {
    const key = keyOf(thread.environmentId, thread.id);
    return [thread, { key, pinned: pinned.has(key), unread: unread.has(key) }] as const;
  }));
}

export function buildAdoptedWorkspaceMap(sources: WorkspaceCardSources["adopted"]) {
  const result = new Map<string, VcsAdoptedWorktreeStatus>();
  for (const { environmentId, rows } of sources) {
    for (const row of rows) result.set(keyOf(environmentId, row.threadId), row);
  }
  return result;
}

export function buildRunningTerminalMap(sources: WorkspaceCardSources["terminals"]) {
  const result = new Map<string, string[]>();
  for (const { environmentId, rows } of sources) {
    for (const row of rows) {
      if (!row.hasRunningSubprocess) continue;
      const key = keyOf(environmentId, row.threadId);
      const values = result.get(key);
      if (values) values.push(row.terminalId);
      else result.set(key, [row.terminalId]);
    }
  }
  return result;
}

export function buildDiscoveredPortMap(sources: WorkspaceCardSources["ports"]) {
  const result = new Map<string, DiscoveredLocalServer[]>();
  for (const { environmentId, rows } of sources) {
    for (const row of rows) {
      if (!row.terminal) continue;
      const key = keyOf(environmentId, row.terminal.threadId);
      const values = result.get(key);
      if (values) values.push(row);
      else result.set(key, [row]);
    }
  }
  return result;
}
```

Create `apps/web/src/components/sidebar/useWorkspaceCardLookups.ts`:

```ts
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@bibcode/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { selectWorktreeCatalogCapabilityPolicy } from "@bibcode/client-runtime/state/worktrees";
import { previewEnvironment } from "../../state/preview";
import { terminalEnvironment } from "../../state/terminal";
import { worktreeEnvironment } from "../../state/worktrees";
import * as indexes from "./workspaceCardLookups";

export function useWorkspaceCardLookups(input: {
  readonly project: SidebarProjectSnapshot;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly active: boolean;
  readonly threads: readonly indexes.CardKeyThread[];
  readonly pinnedKeys: readonly string[];
  readonly unreadKeys: readonly string[];
}) {
  const { project, serverConfigs, active, threads, pinnedKeys, unreadKeys } = input;
  const sourcesAtom = useMemo(() => Atom.make((get): indexes.WorkspaceCardSources => {
    if (!active) return indexes.EMPTY_CARD_SOURCES;
    const adopted: Array<indexes.WorkspaceCardSources["adopted"][number]> = [];
    const terminals: Array<indexes.WorkspaceCardSources["terminals"][number]> = [];
    const ports: Array<indexes.WorkspaceCardSources["ports"][number]> = [];
    const seenEnvironments = new Set<EnvironmentId>();
    for (const member of project.memberProjects) {
      const config = serverConfigs.get(member.environmentId);
      if (config && selectWorktreeCatalogCapabilityPolicy(config.environment).catalogRpc === "enabled") {
        const catalog = Option.getOrNull(AsyncResult.value(get(worktreeEnvironment.catalog({
          environmentId: member.environmentId, input: { projectId: member.id },
        }))));
        adopted.push({ environmentId: member.environmentId, rows: catalog?.adoptedWorkspaces ?? [] });
      }
      if (seenEnvironments.has(member.environmentId)) continue;
      seenEnvironments.add(member.environmentId);
      const terminalRows = Option.getOrNull(AsyncResult.value(get(terminalEnvironment.metadata({
        environmentId: member.environmentId, input: null,
      }))));
      const discovered = Option.getOrNull(AsyncResult.value(get(previewEnvironment.discoveredServers({
        environmentId: member.environmentId, input: {},
      }))));
      terminals.push({ environmentId: member.environmentId, rows: terminalRows ?? [] });
      ports.push({ environmentId: member.environmentId, rows: discovered?.servers ?? [] });
    }
    return { adopted, terminals, ports };
  }), [active, project.memberProjects, serverConfigs]);
  const sources = useAtomValue(sourcesAtom);
  const keys = useMemo(() => indexes.buildWorkspaceCardKeys(threads, pinnedKeys, unreadKeys),
    [threads, pinnedKeys, unreadKeys]);
  const adopted = useMemo(() => indexes.buildAdoptedWorkspaceMap(sources.adopted), [sources.adopted]);
  const terminals = useMemo(() => indexes.buildRunningTerminalMap(sources.terminals), [sources.terminals]);
  const ports = useMemo(() => indexes.buildDiscoveredPortMap(sources.ports), [sources.ports]);
  return useMemo(() => ({ keys, adopted, terminals, ports }), [keys, adopted, terminals, ports]);
}
```

This derives data from the existing per-environment metadata/port atoms and per-project catalog atoms; no new RPC or persisted state. The aggregate atom is unobserved when the panel is hidden and deduplicates environment reads within a grouped project. Arrays and Maps are memoised on their source references. The only remaining per-card subscription is the existing VCS observation; pin/unread flags are indexed with the keys once per list.

Add to `Sidebar.tsx`:

```ts
import type { DiscoveredLocalServer, ServerConfig } from "@bibcode/contracts";
import { useWorkspaceCardLookups } from "./sidebar/useWorkspaceCardLookups";
import { EMPTY_CARD_PORTS, EMPTY_CARD_TERMINALS } from "./sidebar/workspaceCardLookups";
```

Merge the type imports into the existing contracts import. Remove the now-unused `useThreadRunningTerminalIds` and `useThreadDiscoveredPorts` imports.

- [ ] **Step 5: Replace the thread row with the card**

Replace everything from `interface SidebarThreadRowProps {` through the end of `export const SidebarThreadRow = memo(function SidebarThreadRow(…) { … });` (just before `interface SidebarProjectThreadListProps {`) with:

```tsx
interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  isPinned: boolean;
  isUnread: boolean;
  worktreeStatus: VcsAdoptedWorktreeStatus | null;
  runningTerminalIds: readonly string[];
  discoveredPorts: readonly DiscoveredLocalServer[];
  projectCwd: string | null;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    worktreeStatus: VcsAdoptedWorktreeStatus | null,
    branchName: string | null,
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  /** Line 3's model: the catalog short name, else the slug. */
  modelLabel: string;
  /** Unarchived panel chats open in this card's worktree. */
  moreChatsCount: number;
  moreChatsStatus: WorkspaceCardStatus | null;
}

/**
 * A fixed number of references/primitives; no array comparison per card.
 * Ordered keys and lookup results are shared by the list.
 */
function sameSidebarThreadRowProps(
  previous: SidebarThreadRowProps,
  next: SidebarThreadRowProps,
): boolean {
  for (const key of Object.keys(next) as Array<keyof SidebarThreadRowProps>) {
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    thread,
    isPinned,
    isUnread,
    worktreeStatus,
    runningTerminalIds,
    discoveredPorts,
    modelLabel,
    moreChatsCount,
    moreChatsStatus,
  } = props;
  const idBase = useId();
  const cardIds = workspaceCardIds(idBase);
  const requestWorktreeRemoval = useContext(WorktreeRemovalRequestContext);
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const markWorkspaceRowRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const isMobile = useIsMobile();
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  // For grouped projects the thread may belong to another environment than the
  // representative project; read its own project cwd so VCS status (and PR
  // detection) queries the right path.
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? props.projectCwd;
  const workspaceActionsAvailable = selectWorktreeWorkspaceActionsAvailable(worktreeStatus);
  const refreshWorktreeCatalog = useAtomCommand(worktreeEnvironment.refresh, {
    reportFailure: false,
  });
  const gitStatus = useEnvironmentQuery(
    workspaceActionsAvailable && gitCwd !== null
      ? isActive
        ? vcsEnvironment.status({
            environmentId: thread.environmentId,
            input: { cwd: gitCwd },
          })
        : vcsEnvironment.summary({
            environmentId: thread.environmentId,
            input: { cwd: gitCwd },
          })
      : null,
  );
  const keyboardMenuOpenedAtRef = useRef(Number.NEGATIVE_INFINITY);

  const status = resolveWorkspaceCardStatus(thread, lastVisitedAt);
  const branchLabel = resolveWorkspaceBranchLabel(gitStatus.data, thread.branch);
  const showBranchText = shouldShowWorkspaceBranchText(branchLabel, thread.title);
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const dirty = resolveWorkspaceDirty(gitStatus.data);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const hasBranchLine =
    showBranchText ||
    prStatus !== null ||
    dirty ||
    terminalStatus !== null ||
    discoveredPorts.length > 0;
  const preview = resolveWorkspaceCardPreview(thread, status);
  const provider = resolveAgentProvider(thread.session?.providerName);
  const hasSessionLine =
    thread.session !== null || thread.unresolvedDelivery != null || preview.text !== null;
  const ageIso = resolveWorkspaceCardAgeSource(thread, status.kind === "working");
  const isThreadRunning = isWorkspaceThreadRunning(thread);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;

  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleCardClick = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      if (isWorkspaceCardControlTarget(event.target)) return;
      markWorkspaceRowRead(threadKey);
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, markWorkspaceRowRead, orderedProjectThreadKeys, threadKey, threadRef],
  );
  const handleCardDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      // Already renaming this card: a double-click outside the input must not
      // restart and discard the in-progress edit.
      if (renamingThreadKey === threadKey) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The card's own controls (PR number, ports, Archive) never start a rename.
      if (isWorkspaceCardControlTarget(event.target)) return;
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
    },
    [isMobile, renamingThreadKey, startThreadRename, threadKey, thread.title],
  );
  const openCardMenu = useCallback(
    (position: { x: number; y: number }) => {
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void (async () => {
          const result = await settlePromise(() => handleMultiSelectContextMenu(position));
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Thread action failed",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })();
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void (async () => {
        const result = await settlePromise(() =>
          handleThreadContextMenu(threadRef, position, worktreeStatus, branchLabel),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [
      branchLabel,
      clearSelection,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      isSelected,
      threadRef,
      worktreeStatus,
    ],
  );
  const handleCardContextMenu = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      event.preventDefault();
      // Chromium and WebView2 also send contextmenu for Shift+F10 and the Menu
      // key; the keydown handler already opened the menu at the card.
      if (isKeyboardContextMenuEcho(keyboardMenuOpenedAtRef.current, performance.now())) {
        return;
      }
      openCardMenu({ x: event.clientX, y: event.clientY });
    },
    [openCardMenu],
  );
  const handleCardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!isContextMenuShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardMenuOpenedAtRef.current = markKeyboardContextMenuOpened();
      openCardMenu(contextMenuAnchorForRect(event.currentTarget.getBoundingClientRect()));
    },
    [openCardMenu],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  // Keep clicks and double-clicks inside the rename input from reaching the card.
  // Without stopping `dblclick`, selecting a word would restart the rename.
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );

  const archiveRevealClassName =
    "pointer-events-none -my-0.5 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100";
  const archiveButton = (onClick: (event: React.MouseEvent<HTMLButtonElement>) => void) => (
    <button
      type="button"
      data-card-control
      data-thread-selection-safe
      data-testid={`thread-archive-${thread.id}`}
      aria-label={`Archive ${thread.title}`}
      className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
      onPointerDown={stopPropagationOnPointerDown}
      onClick={onClick}
    >
      <ArchiveIcon className="size-3.5" />
    </button>
  );
  const trailing = jumpLabel ? (
    <span
      aria-label={jumpLabel}
      className="inline-flex h-5 shrink-0 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-xs font-medium text-foreground shadow-sm"
    >
      {jumpLabel}
    </span>
  ) : isConfirmingArchive ? (
    <button
      ref={handleConfirmArchiveRef}
      type="button"
      data-card-control
      data-thread-selection-safe
      data-testid={`thread-archive-confirm-${thread.id}`}
      aria-label={`Confirm archive ${thread.title}`}
      className="pointer-events-auto -my-0.5 inline-flex h-5 shrink-0 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
      onPointerDown={stopPropagationOnPointerDown}
      onClick={handleConfirmArchiveClick}
    >
      Confirm
    </button>
  ) : isThreadRunning ? null : appSettingsConfirmThreadArchive ? (
    <span className={archiveRevealClassName}>{archiveButton(handleStartArchiveConfirmation)}</span>
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className={archiveRevealClassName} />}>
        {archiveButton(handleArchiveImmediateClick)}
      </TooltipTrigger>
      <TooltipPopup side="top">Archive</TooltipPopup>
    </Tooltip>
  );

  return (
    <WorkspaceCardShell
      testId={`thread-row-${thread.id}`}
      buttonTestId={`thread-card-button-${thread.id}`}
      className={resolveWorkspaceCardClassName({ isActive, isSelected })}
      idBase={idBase}
      isActive={isActive}
      hasFlags={isUnread || isPinned}
      hasBranchLine={hasBranchLine}
      hasSessionLine={hasSessionLine}
      status={status}
      onClick={handleCardClick}
      onDoubleClick={handleCardDoubleClick}
      onContextMenu={handleCardContextMenu}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
      onButtonKeyDown={handleCardKeyDown}
      footer={
        worktreeStatus && worktreeStatus.availability !== "present" ? (
          <WorktreeAvailabilityWarning
            status={worktreeStatus}
            onRetry={() => {
              void refreshWorktreeCatalog({
                environmentId: thread.environmentId,
                input: { projectId: thread.projectId },
              });
            }}
            onRemove={() => {
              requestWorktreeRemoval?.({
                environmentId: thread.environmentId,
                projectId: thread.projectId,
                threadId: thread.id,
                title: thread.title,
                path: worktreeStatus.path,
                branch: worktreeStatus.branch ?? thread.branch,
                availability: worktreeStatus.availability,
                registrationState: worktreeStatus.registrationState,
                locked: worktreeStatus.locked,
                ...(worktreeStatus.lockReason ? { lockReason: worktreeStatus.lockReason } : {}),
              });
            }}
          />
        ) : null
      }
    >
      <WorkspaceCardTitleLine
        id={cardIds.title}
        flagsId={cardIds.flags}
        title={thread.title}
        titleTestId={`thread-title-${thread.id}`}
        unread={isUnread}
        pinned={isPinned}
        pinnedTestId={`thread-pinned-${thread.id}`}
        renameInput={
          renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              data-card-control
              aria-label={`Rename ${thread.title}`}
              className="pointer-events-auto min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-base outline-none sm:text-[13px]"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
            />
          ) : undefined
        }
        trailing={trailing}
      />
      {hasBranchLine ? (
        <WorkspaceCardBranchLine
          id={cardIds.branch}
          branch={showBranchText ? branchLabel : null}
          branchTooltip={
            showBranchText
              ? resolveWorkspaceCardBranchTooltip({
                  branch: branchLabel,
                  worktreePath: thread.worktreePath,
                  checkoutPath: gitCwd,
                })
              : null
          }
        >
          {prStatus ? <WorkspaceCardPrButton indicator={prStatus} onClick={handlePrClick} /> : null}
          {dirty ? <WorkspaceCardDirtyDot /> : null}
          {terminalStatus ? (
            <WorkspaceCardTerminalIcon
              label={terminalStatus.label}
              colorClass={terminalStatus.colorClass}
            />
          ) : null}
          <WorkspaceCardPortsButton ports={discoveredPorts} onClick={handleOpenDiscoveredPort} />
        </WorkspaceCardBranchLine>
      ) : null}
      {hasSessionLine ? (
        <WorkspaceCardSessionLine
          id={cardIds.session}
          provider={provider}
          preview={preview}
          model={modelLabel}
          ageIso={ageIso}
        />
      ) : null}
      {moreChatsCount > 0 && moreChatsStatus !== null ? (
        <WorkspaceCardMoreChats count={moreChatsCount} status={moreChatsStatus} />
      ) : null}
    </WorkspaceCardShell>
  );
}, sameSidebarThreadRowProps);
```

`showBranchText` narrows `branchLabel` to `string` in the tooltip branch (the helper is a type predicate).

- [ ] **Step 6: Pass card data through the list**

(a) In `interface SidebarProjectThreadListProps {`, add before its closing brace:

```ts
  project: SidebarProjectSnapshot;
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  primaryThread: SidebarThreadSummary | null;
  modelLabels: ReadonlyMap<string, string>;
  chatSummaries: ReadonlyMap<string, WorkspaceChatSummary>;
```

(b) In `SidebarProjectThreadList`, destructure `project, serverConfigs, primaryThread, modelLabels, chatSummaries,`. Add these hooks before its return, then replace the `renderedThreads.map` callback as below:

```tsx
  const pinnedKeys = useSidebarWorkspaceMetaStore((state) => state.pinnedThreadKeys);
  const unreadKeys = useSidebarWorkspaceMetaStore((state) => state.unreadThreadKeys);
  const lookupThreads = useMemo(
    () => primaryThread ? [primaryThread, ...renderedThreads] : renderedThreads,
    [primaryThread, renderedThreads],
  );
  const cardLookups = useWorkspaceCardLookups({
    project, serverConfigs, active: shouldShowThreadPanel,
    threads: lookupThreads, pinnedKeys, unreadKeys,
  });
```

`orderedProjectThreadKeys` remains the one array built by the parent's memo and is passed unchanged to every card; only the list can rebuild it. Card comparators never scan it.



```tsx
        renderedThreads.map((thread) => {
          const keyInfo = cardLookups.keys.get(thread)!;
          const threadKey = keyInfo.key;
          const chatSummary =
            thread.worktreePath === null
              ? undefined
              : chatSummaries.get(workspaceCheckoutKey(thread));
          return (
            <SidebarThreadRow
              key={threadKey}
              thread={thread}
              isPinned={keyInfo.pinned}
              isUnread={keyInfo.unread}
              worktreeStatus={thread.worktreePath ? cardLookups.adopted.get(threadKey) ?? null : null}
              runningTerminalIds={cardLookups.terminals.get(threadKey) ?? EMPTY_CARD_TERMINALS}
              discoveredPorts={cardLookups.ports.get(threadKey) ?? EMPTY_CARD_PORTS}
              projectCwd={projectCwd}
              orderedProjectThreadKeys={orderedProjectThreadKeys}
              isActive={activeRouteThreadKey === threadKey}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadKey={renamingThreadKey}
              renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
              setRenamingTitle={setRenamingTitle}
              startThreadRename={startThreadRename}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              confirmingArchiveThreadKey={confirmingArchiveThreadKey}
              setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
              modelLabel={resolveWorkspaceModelLabel(modelLabels, thread)}
              moreChatsCount={chatSummary?.count ?? 0}
              moreChatsStatus={chatSummary?.status ?? null}
            />
          );
        })
```

Passing the rename title only to the card being renamed keeps a keystroke from re-rendering every card. Non-worktree cards show no count until threads record their host (spec decision 2).

(c) In `SidebarProjectItem`, add after `const supportedWorktreeDiscoveryMembers = useMemo(…);`:

```ts
  const modelLabels = useMemo(() => buildWorkspaceModelLabels(serverConfigs), [serverConfigs]);
```

In the first per-project `useMemo` (the one returning `primaryThread, projectStatus, visibleProjectThreads, orderedProjectThreadKeys`), add before its `return {`:

```ts
      const chatSummaries = summarizeWorkspaceChats(projectThreads, (thread) =>
        lastVisitedAtByThreadKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
```

add `chatSummaries,` to the returned object, and change the destructuring line to:

```ts
  const {
    chatSummaries,
    primaryThread,
    projectStatus,
    visibleProjectThreads,
    orderedProjectThreadKeys,
  } = useMemo(() => {
```

(d) In the `<SidebarProjectThreadList` JSX, add `project={project}`, `serverConfigs={serverConfigs}`, `primaryThread={primaryThread}`, `modelLabels={modelLabels}` and `chatSummaries={chatSummaries}`. Task 16 removes the superseded `projectKey`/`projectCwd` props while merging the lists.

- [ ] **Step 7: Run the tests and typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx src/components/Sidebar.logic.test.ts src/components/ThreadStatusIndicators.test.tsx src/components/sidebar`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`
Expected: PASS, including the real fallback renderer integration.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck && vp check`
Expected: exit 0 for this task's files.

- [ ] **Step 8: Review**

`vercel-react-best-practices`: `SidebarThreadRow` memoised with reference/primitive comparison only (`rerender-memo`, `js-index-maps`); keys/flags, adopted workspaces, terminals and ports are indexed once in the list; `threadRef` memoised so callbacks stay stable; the rename title reaches only the renaming card; only `RelativeAge` subscribes to the clock; per-card work is O(1). `UI.md`: the whole card is one target (lines 56–57), controls stay visible on hover/focus, the rename input is 13 px, statuses read without colour. Record both.

- [ ] **Step 9: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/workspaceCardLookups.ts apps/web/src/components/sidebar/useWorkspaceCardLookups.ts apps/web/src/components/sidebar/useWorkspaceCardLookups.test.tsx`.

## Task 16: The primary card, the merged list and the summary glyphs

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (`SidebarPrimaryRow` → `SidebarPrimaryCard`; `SidebarProjectThreadList` merged; `SidebarProjectItem` statuses, JSX, collapsed-project glyph; imports)
- Modify: `apps/web/src/components/Sidebar.logic.ts` (delete `resolveProjectStatusIndicator`, `THREAD_STATUS_PRIORITY`, `resolveThreadRowClassName`)
- Test: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx` (delete `ThreadStatusLabel`'s `compact` variant)
- Test: `apps/web/src/components/ThreadStatusIndicators.test.tsx`
- Test: `apps/web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: Tasks 6, 7, 11–15.
- Produces:
  - `SidebarPrimaryCard` (memoised): props `project`, `primaryThread`, `isActive`, `modelLabel`, `moreChatsCount`, `moreChatsStatus`, `onClick`, `onOpenMenu`, `openPrLink`, `navigateToThread`, `isPinned`, `isUnread`, `runningTerminalIds`, `discoveredPorts`; `li` test id `primary-card-<project.id>`, button `primary-card-button-<project.id>`, title `primary-card-title-<project.id>`; it reads `threadLastVisitedAtById` for the default thread (the "Completed" fix) and the fresh summary's `pr` and `hasWorkingTreeChanges`;
  - one `SidebarMenuSub` per project: discovery, then the primary card, then the workspace cards, then Show more/less, so the guide line is continuous;
  - `SidebarProjectThreadListProps`: `projectKey` and `projectCwd` become `project: SidebarProjectSnapshot`; adds `primaryThread`, `onPrimaryClick`, `openPrimaryCardMenu`, `showDiscovery`, `serverConfigs`, `primaryEnvironmentId`, `onDiscoveryHiddenCountChange`; `hiddenThreadStatus` becomes `WorkspaceCardStatus | null`;
  - the collapsed-project indicator and the Show-more hint render `WorkspaceCardStatusGlyph`.

- [ ] **Step 1: Update and add the tests**

In `apps/web/src/components/Sidebar.test.tsx`:

1. In `staticDescribe("primary row", () => {`, add at the top of the describe body:

```ts
  const primaryCard = () => mustFindProps(byTestId("primary-card-project-a"), "primary card");
```

   and in every test of that describe replace the lookup

```ts
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
```

   (also the variants whose first line is `    const primaryRow = captured("SidebarMenuSubButton").find(`) with `    const primaryRow = { props: primaryCard() };`. The rest of each test keeps calling `primaryRow.props`. This covers the Task 6 test "offers and copies the live checkout branch from the primary row" too.

2. Add at the end of the "primary row" describe:

```ts
  it.each([
    { label: "fresh passive summary", status: { stale: false }, showsIndicators: true },
    { label: "full status result", status: {}, showsIndicators: true },
    { label: "stale passive summary", status: { stale: true }, showsIndicators: false },
  ])("reads primary PR/dirty state directly from $label", ({ status, showsIndicators }) => {
    baseScenario();
    h.state.threads = [threadDefault];
    h.state.vcsStatusByCwd[projectA.workspaceRoot] = {
      refName: "main", hasWorkingTreeChanges: true,
      pr: { url: "https://example.invalid/pr/1" }, ...status,
    };
    const markup = render(<Sidebar />);
    expect(threadDefault.branch).toBeNull();
    expect(markup.includes("#1")).toBe(showsIndicators);
    expect(markup.includes('aria-label="Uncommitted changes"')).toBe(showsIndicators);
    expect(markup.includes("h-[18px]")).toBe(showsIndicators);
  });

  it("hides the primary branch line when the title already shows its branch and there are no indicators", () => {
    baseScenario();
    h.state.threads = [threadDefault];
    h.state.vcsStatusByCwd[projectA.workspaceRoot] = { refName: "main", stale: false, pr: null, hasWorkingTreeChanges: false };
    expect(render(<Sidebar />)).not.toContain("h-[18px]");
  });

  it("renders the primary card first in the project's one list", () => {
    baseScenario();
    const markup = render(<Sidebar />);
    expect(captured("SidebarMenuSub")).toHaveLength(1);
    expect(markup.indexOf('data-testid="primary-card-project-a"')).toBeLessThan(
      markup.indexOf('data-testid="thread-row-thread-active"'),
    );
    expect(markup).toContain('data-testid="primary-card-button-project-a"');
  });

  it("shows the primary card's unseen completion once the default thread was visited", () => {
    baseScenario();
    h.state.threads = [
      makeThread("thread-default", {
        kind: "default",
        title: "Repo A",
        latestTurn: {
          turnId: "turn-default",
          state: "completed",
          requestedAt: iso(12),
          startedAt: iso(12),
          completedAt: iso(10),
          assistantMessageId: null,
        } as EnvironmentThreadShell["latestTurn"],
      }),
    ];
    h.uiStore.setState({
      threadLastVisitedAtById: { [threadKeyOf(threadDefault)]: iso(20) },
    });
    const markup = render(<Sidebar />);
    expect(markup).toContain('aria-label="Finished, not opened yet"');
  });

  it("counts panel chats on the worktree card and on the primary card", () => {
    baseScenario();
    h.state.threads = [
      ...h.state.threads,
      makeThread("panel-on-worktree", { kind: "panel", worktreePath: "C:/wt/x" }),
      makeThread("panel-main", { kind: "panel" }),
      makeThread("panel-archived", { kind: "panel", archivedAt: iso(3) }),
    ];
    const markup = render(<Sidebar />);
    // The base scenario's own panel thread has no path, so the primary card counts two.
    expect(markup).toContain("2 more chats");
    expect(markup).toContain("1 more chat<");
  });
```

3. Add inside `staticDescribe("Sidebar full render", () => {`:

```ts
  it("summarises a collapsed project and the hidden cards with the card glyphs", () => {
    baseScenario();
    h.state.threads = [
      threadDefault,
      threadActive,
      makeThread("thread-idle", { title: "Idle thread", hasPendingApprovals: true }),
    ];
    h.state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, sidebarThreadPreviewCount: 1 };
    const expanded = render(<Sidebar />);
    // thread-idle sorts below thread-active, so it is hidden behind Show more.
    expect(expanded).toMatch(/aria-label="Needs approval"[\s\S]*Show more/);

    h.uiStore.setState({
      projectExpandedById: { [derivePhysicalProjectKey(projectA)]: false },
    });
    h.state.routeParams = {};
    const collapsed = render(<Sidebar />);
    expect(collapsed).toContain('aria-label="Needs approval"');
    expect(collapsed).not.toContain('data-testid="thread-row-thread-idle"');
  });
```

4. Extend Task 15's real-fallback browser integration test to `it.each(["thread-card-button-thread-idle", "primary-card-button-project-a"])`, keeping its complete body unchanged. Both cards must survive the capture-phase echo and restore focus.

5. In the `vi.mock("./ThreadStatusIndicators", …)` factory, delete the `ThreadStatusLabel: (props…) => { … },` entry; `Sidebar.tsx` no longer imports it.

In `apps/web/src/components/Sidebar.logic.test.ts`: remove `resolveProjectStatusIndicator,` and `resolveThreadRowClassName,` from the import list and delete `describe("resolveThreadRowClassName", …)` and `describe("resolveProjectStatusIndicator", …)`. (`resolveWorkspaceCardClassName` and `resolveHighestWorkspaceCardStatus` are covered by Tasks 11–12.)

In `apps/web/src/components/ThreadStatusIndicators.test.tsx`, in "renders status labels in every display mode", delete the expectation that renders `<ThreadStatusLabel status={status} compact />`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx`
Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`
Expected: FAIL — there is no `primary-card-project-a`, two `SidebarMenuSub` lists render, and the summaries still use dots.

- [ ] **Step 3: Delete the superseded helpers**

In `apps/web/src/components/Sidebar.logic.ts`, delete `THREAD_STATUS_PRIORITY`, `resolveProjectStatusIndicator` and `resolveThreadRowClassName`.

In `apps/web/src/components/ThreadStatusIndicators.tsx`, replace `ThreadStatusLabel` with the non-compact version only:

```tsx
export function ThreadStatusLabel({ status }: { status: ThreadStatusPill }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-xs ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}
```

- [ ] **Step 4: Update `Sidebar.tsx` imports**

- Replace the `from "./ThreadStatusIndicators";` import with `import { prStatusIndicator, resolveThreadPr, terminalStatusFromRunningIds } from "./ThreadStatusIndicators";`.
- In the `lucide-react` list remove `PinIcon,` (the card module draws it).
- In the `from "./Sidebar.logic";` list remove `resolveProjectStatusIndicator,`, `resolveThreadRowClassName,`, `resolveThreadStatusPill,` and `ThreadStatusPill,`; add `resolveHighestWorkspaceCardStatus,` and `WORKSPACE_CARD_STATUS,`.
- Add `WorkspaceCardStatusGlyph,` to the `./sidebar/WorkspaceCard` import list.
- Remove `selectIsPinned,` and `selectIsUnread,` from the `../sidebarWorkspaceMetaStore` import: both cards now receive indexed flags from the list.
- Task 15 already imports `ServerConfig` and `DiscoveredLocalServer`; keep those imports.

- [ ] **Step 5: Replace the primary row with the primary card**

Replace the whole `SidebarPrimaryRow` function (from its doc comment `/**` + ` * Primary workspace row:` through its closing brace) with:

```tsx
interface SidebarPrimaryCardProps {
  project: SidebarProjectSnapshot;
  primaryThread: SidebarThreadSummary | null;
  isActive: boolean;
  isPinned: boolean;
  isUnread: boolean;
  runningTerminalIds: readonly string[];
  discoveredPorts: readonly DiscoveredLocalServer[];
  modelLabel: string;
  moreChatsCount: number;
  moreChatsStatus: WorkspaceCardStatus | null;
  onClick: () => void;
  onOpenMenu: (position: { x: number; y: number }, branchName: string | null) => void;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
}

/**
 * The primary card: the project's main checkout. Its title is the checkout's
 * live branch (the default thread's `branch` is always null), and its PR and
 * dirty state come straight from the passive summary for the same reason.
 */
const SidebarPrimaryCard = memo(function SidebarPrimaryCard(props: SidebarPrimaryCardProps) {
  const {
    project,
    primaryThread,
    isActive,
    isPinned,
    isUnread,
    runningTerminalIds,
    discoveredPorts,
    modelLabel,
    moreChatsCount,
    moreChatsStatus,
    onClick,
    onOpenMenu,
    openPrLink,
    navigateToThread,
  } = props;
  const idBase = useId();
  const cardIds = workspaceCardIds(idBase);
  const gitStatus = useEnvironmentQuery(
    vcsEnvironment.summary({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    }),
  );
  const summary = gitStatus.data;
  const liveBranch = resolveWorkspaceBranchLabel(summary, null);
  const title = liveBranch ?? primaryThread?.branch ?? project.displayName;
  const branchName = liveBranch ?? primaryThread?.branch ?? null;
  const primaryThreadRef = useMemo(
    () => (primaryThread ? scopeThreadRef(primaryThread.environmentId, primaryThread.id) : null),
    [primaryThread],
  );
  const primaryThreadKey = primaryThreadRef ? scopedThreadKey(primaryThreadRef) : null;
  // Today's row skipped the visit marker, so the primary never showed "Completed".
  const lastVisitedAt = useUiStateStore((state) =>
    primaryThreadKey === null ? undefined : state.threadLastVisitedAtById[primaryThreadKey],
  );
  const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const keyboardMenuOpenedAtRef = useRef(Number.NEGATIVE_INFINITY);

  const status = primaryThread
    ? resolveWorkspaceCardStatus(primaryThread, lastVisitedAt)
    : WORKSPACE_CARD_STATUS.idle;
  const freshSummary = summary && !("stale" in summary && summary.stale) ? summary : null;
  const prStatus = prStatusIndicator(
    freshSummary?.pr ?? null,
    freshSummary?.sourceControlProvider,
  );
  const dirty = resolveWorkspaceDirty(summary);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const showBranchText = shouldShowWorkspaceBranchText(branchName, title);
  const hasBranchLine =
    showBranchText ||
    prStatus !== null ||
    dirty ||
    terminalStatus !== null ||
    discoveredPorts.length > 0;
  const preview = primaryThread
    ? resolveWorkspaceCardPreview(primaryThread, status)
    : { text: null, tone: null };
  const provider = resolveAgentProvider(primaryThread?.session?.providerName);
  const hasSessionLine =
    primaryThread !== null &&
    (primaryThread.session !== null ||
      primaryThread.unresolvedDelivery != null ||
      preview.text !== null);
  const ageIso = primaryThread
    ? resolveWorkspaceCardAgeSource(primaryThread, status.kind === "working")
    : null;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      if (isWorkspaceCardControlTarget(event.target)) return;
      if (primaryThreadKey) {
        markRead(primaryThreadKey);
      }
      onClick();
    },
    [markRead, onClick, primaryThreadKey],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLLIElement>) => {
      event.preventDefault();
      if (isKeyboardContextMenuEcho(keyboardMenuOpenedAtRef.current, performance.now())) {
        return;
      }
      onOpenMenu({ x: event.clientX, y: event.clientY }, branchName);
    },
    [branchName, onOpenMenu],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!isContextMenuShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardMenuOpenedAtRef.current = markKeyboardContextMenuOpened();
      onOpenMenu(contextMenuAnchorForRect(event.currentTarget.getBoundingClientRect()), branchName);
    },
    [branchName, onOpenMenu],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (prStatus) {
        openPrLink(event, prStatus.url);
      }
    },
    [openPrLink, prStatus],
  );
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port || !primaryThreadRef) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(primaryThreadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef: primaryThreadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, primaryThreadRef],
  );

  return (
    <WorkspaceCardShell
      testId={`primary-card-${project.id}`}
      buttonTestId={`primary-card-button-${project.id}`}
      className={resolveWorkspaceCardClassName({ isActive, isSelected: false })}
      idBase={idBase}
      isActive={isActive}
      hasFlags={isUnread || isPinned}
      hasBranchLine={hasBranchLine}
      hasSessionLine={hasSessionLine}
      status={status}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onButtonKeyDown={handleKeyDown}
    >
      <WorkspaceCardTitleLine
        id={cardIds.title}
        flagsId={cardIds.flags}
        title={title}
        titleTestId={`primary-card-title-${project.id}`}
        unread={isUnread}
        pinned={isPinned}
        primary
      />
      {hasBranchLine ? (
        <WorkspaceCardBranchLine
          id={cardIds.branch}
          branch={showBranchText ? branchName : null}
          branchTooltip={
            showBranchText
              ? resolveWorkspaceCardBranchTooltip({
                  branch: branchName,
                  worktreePath: null,
                  checkoutPath: project.workspaceRoot,
                })
              : null
          }
        >
          {prStatus ? <WorkspaceCardPrButton indicator={prStatus} onClick={handlePrClick} /> : null}
          {dirty ? <WorkspaceCardDirtyDot /> : null}
          {terminalStatus ? (
            <WorkspaceCardTerminalIcon
              label={terminalStatus.label}
              colorClass={terminalStatus.colorClass}
            />
          ) : null}
          <WorkspaceCardPortsButton ports={discoveredPorts} onClick={handleOpenDiscoveredPort} />
        </WorkspaceCardBranchLine>
      ) : null}
      {hasSessionLine ? (
        <WorkspaceCardSessionLine
          id={cardIds.session}
          provider={provider}
          preview={preview}
          model={modelLabel}
          ageIso={ageIso}
        />
      ) : null}
      {moreChatsCount > 0 && moreChatsStatus !== null ? (
        <WorkspaceCardMoreChats count={moreChatsCount} status={moreChatsStatus} />
      ) : null}
    </WorkspaceCardShell>
  );
});
```

- [ ] **Step 6: Merge the two lists**

(a) In `interface SidebarProjectThreadListProps {`: delete `  projectKey: string;` and `  projectCwd: string;` (Task 15 already added `project`, `serverConfigs`, and `primaryThread`), replace `  hiddenThreadStatus: ThreadStatusPill | null;` with `  hiddenThreadStatus: WorkspaceCardStatus | null;`, and add before the closing brace:

```ts
  onPrimaryClick: () => void;
  openPrimaryCardMenu: (position: { x: number; y: number }, branchName: string | null) => void;
  showDiscovery: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  onDiscoveryHiddenCountChange: (count: number | null) => void;
```

(b) In `SidebarProjectThreadList`'s destructuring: delete `    projectKey,` and `    projectCwd,`, keep Task 15's `project`, `serverConfigs`, `primaryThread` destructuring and lookup hook, and add `    onPrimaryClick,`, `    openPrimaryCardMenu,`, `    showDiscovery,`, `    primaryEnvironmentId,`, `    onDiscoveryHiddenCountChange,`. After Task 15's `const cardLookups = useWorkspaceCardLookups(…);` call, add:

```ts
  const projectKey = project.projectKey;
  const projectCwd = project.workspaceRoot;
  const primaryThreadKey = primaryThread
    ? scopedThreadKey(scopeThreadRef(primaryThread.environmentId, primaryThread.id))
    : null;
  const primaryKeyInfo = primaryThread ? cardLookups.keys.get(primaryThread) : undefined;
  const primaryChats = chatSummaries.get(
    workspaceCheckoutKey({
      environmentId: primaryThread?.environmentId ?? project.environmentId,
      projectId: primaryThread?.projectId ?? project.id,
      worktreePath: null,
    }),
  );
```

(c) Immediately after the opening `<SidebarMenuSub …>` tag of this list, insert:

```tsx
      {shouldShowThreadPanel && showDiscovery ? (
        <WorktreeDiscoverySection
          project={project}
          serverConfigs={serverConfigs}
          primaryEnvironmentId={primaryEnvironmentId}
          onNavigateToThread={navigateToThread}
          onHiddenCountChange={onDiscoveryHiddenCountChange}
        />
      ) : null}
      {shouldShowThreadPanel ? (
        <SidebarPrimaryCard
          project={project}
          primaryThread={primaryThread}
          isPinned={primaryKeyInfo?.pinned ?? false}
          isUnread={primaryKeyInfo?.unread ?? false}
          runningTerminalIds={primaryThreadKey ? cardLookups.terminals.get(primaryThreadKey) ?? EMPTY_CARD_TERMINALS : EMPTY_CARD_TERMINALS}
          discoveredPorts={primaryThreadKey ? cardLookups.ports.get(primaryThreadKey) ?? EMPTY_CARD_PORTS : EMPTY_CARD_PORTS}
          isActive={primaryThreadKey !== null && activeRouteThreadKey === primaryThreadKey}
          modelLabel={primaryThread ? resolveWorkspaceModelLabel(modelLabels, primaryThread) : ""}
          moreChatsCount={primaryChats?.count ?? 0}
          moreChatsStatus={primaryChats?.status ?? null}
          onClick={onPrimaryClick}
          onOpenMenu={openPrimaryCardMenu}
          openPrLink={openPrLink}
          navigateToThread={navigateToThread}
        />
      ) : null}
```

(d) In the Show-more button replace `{hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}` with `{hiddenThreadStatus ? <WorkspaceCardStatusGlyph status={hiddenThreadStatus} /> : null}`.

(e) Add this helper to `Sidebar.logic.ts`, export it, and import it in `Sidebar.tsx`. It owns both the visit Map and status resolution; neither summary memo builds its own copy:

```ts
export function createWorkspaceStatusLookup(
  threads: readonly SidebarThreadSummary[],
  visits: readonly (string | null | undefined)[],
) {
  const visitsByKey = new Map(threads.map((thread, index) => [
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    visits[index] ?? null,
  ] as const));
  const lastVisitedAt = (thread: SidebarThreadSummary) =>
    visitsByKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
  const statusOf = (thread: SidebarThreadSummary) =>
    resolveWorkspaceCardStatus(thread, lastVisitedAt(thread));
  return { lastVisitedAt, statusOf };
}
```

In `SidebarProjectItem`, immediately before the first per-project memo, insert:

```ts
  const workspaceStatuses = useMemo(
    () => createWorkspaceStatusLookup(projectThreads, threadLastVisitedAts),
    [projectThreads, threadLastVisitedAts],
  );
```

Delete the `lastVisitedAtByThreadKey` Map construction and `resolveProjectThreadStatus` closure from **both** per-project memos. Replace the first memo's project-status expression and Task 15's chat expression with:

```ts
      const projectStatus = resolveHighestWorkspaceCardStatus(
        [...(primaryThread ? [primaryThread] : []), ...visibleProjectThreads].map(workspaceStatuses.statusOf),
      );
      const chatSummaries = summarizeWorkspaceChats(projectThreads, workspaceStatuses.lastVisitedAt);
```

(f) Replace the second memo's hidden-status return field with:

```ts
      hiddenThreadStatus: resolveHighestWorkspaceCardStatus(hiddenThreads.map(workspaceStatuses.statusOf)),
```

In both memo dependency lists replace `threadLastVisitedAts` with `workspaceStatuses`. Add `import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";` to `Sidebar.logic.ts` for the helper; no new state owner.

(g) In the project header, replace the collapsed-status branch

```tsx
          {!projectExpanded && projectStatus ? (
            <Tooltip>
              …
            </Tooltip>
          ) : (
```

   (the whole `<Tooltip>…</Tooltip>` element that draws the `size-[9px]` dot) with:

```tsx
          {!projectExpanded && projectStatus ? (
            <span className="-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center">
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <WorkspaceCardStatusGlyph status={projectStatus} />
              </span>
              <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
            </span>
          ) : (
```

(h) Delete the whole block that rendered the first list:

```tsx
      {shouldShowThreadPanel && (
        <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1 py-0 sm:mx-1 sm:px-1.5">
          …WorktreeDiscoverySection…
          …SidebarPrimaryRow…
        </SidebarMenuSub>
      )}
```

(i) In the `<SidebarProjectThreadList` JSX: delete `projectKey={project.projectKey}` and `projectCwd={project.workspaceRoot}`; keep Task 15's `project`, `serverConfigs`, `primaryThread`, model and chat props, and add:

```tsx
        onPrimaryClick={handlePrimaryRowClick}
        openPrimaryCardMenu={openPrimaryCardMenu}
        showDiscovery={supportedWorktreeDiscoveryMembers.length > 0}
        primaryEnvironmentId={primaryEnvironmentId}
        onDiscoveryHiddenCountChange={handleDiscoveryHiddenCountChange}
```

(`isPrimaryThreadActiveWhileCollapsed` still feeds `shouldShowThreadPanel`, so a collapsed project routed to its default thread keeps the primary card visible, as before.)

- [ ] **Step 7: Run the tests and typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx src/components/Sidebar.logic.test.ts src/components/ThreadStatusIndicators.test.tsx src/components/sidebar src/components/CommandPalette.test.tsx`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run --environment happy-dom src/components/Sidebar.test.tsx`
Expected: PASS, including mounted dialog/card regressions.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp run --filter @bibcode/web typecheck && vp check`
Expected: exit 0 for this task's files.

- [ ] **Step 8: Review**

`vercel-react-best-practices`: `SidebarProjectThreadList` stays memoised with the primary card inside it (spec: "so that component stays memoised"); `SidebarPrimaryCard` is memoised; chat summaries and the model lookup are built once per project in `useMemo`; no new subscriptions beyond the per-environment terminal and port atoms the spec names. `UI.md`: one guide line, one status language, the primary card's "Completed" now appears. Record both.

- [ ] **Step 9: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/ThreadStatusIndicators.test.tsx apps/web/src/components/Sidebar.test.tsx`.

## Task 17: Packaged e2e selectors

The primary card's `data-thread-item` now sits on an `li`, not an `a`. Packaged e2e specs don't run locally by default, so a source contract test guards every spec's selector and Task 19 exercises the same XPath on the dev server. The spec names two specs (`composer-native-triggers.e2e.ts:334`, `pierre-diffs.e2e.ts:246`); three more have been added since with the same `//a[…]` XPath, and all five break (ruling 23).

**Files:**
- Modify: `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts` (line ~334)
- Modify: `apps/desktop/e2e/specs/pierre-diffs.e2e.ts` (line ~246)
- Modify: `apps/desktop/e2e/specs/composer-message-queue.e2e.ts` (line ~85)
- Modify: `apps/desktop/e2e/specs/project-session-terminal.e2e.ts` (line ~56)
- Modify: `apps/desktop/e2e/specs/terminal-font.e2e.ts` (line ~136)
- Test: `apps/desktop/e2e/support/ui-state.test.ts`

**Interfaces:**
- Consumes: the card test ids and `data-thread-item` placement from Tasks 15–16.
- Produces: primary-card XPaths of the form `//*[@data-thread-item="true"][.//span[normalize-space()="main"]]`. `composer-native-triggers.e2e.ts:755` already uses `//*[…]` and stays; `chat-activity-panel.e2e.ts:145` matches `starts-with(@data-testid, "thread-row-")`, which is the card `li` and contains the title, so it stays too.

- [ ] **Step 1: Write the failing contract test**

In `apps/desktop/e2e/support/ui-state.test.ts`, add inside `describe("packaged composer acceptance contract", () => {`:

```ts
  it("finds sidebar workspace cards without requiring an anchor element", () => {
    const specsDirectory = new URL("../specs/", import.meta.url);
    const anchoredSpecs = NodeFS.readdirSync(specsDirectory)
      .filter((name) => name.endsWith(".e2e.ts"))
      .filter((name) =>
        NodeFS.readFileSync(new URL(name, specsDirectory), "utf8").includes("//a[@data-thread-item"),
      )
      .toSorted();
    expect(anchoredSpecs).toEqual([]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run apps/desktop/e2e/support/ui-state.test.ts`
Expected: FAIL — the diff lists `composer-message-queue.e2e.ts`, `composer-native-triggers.e2e.ts`, `pierre-diffs.e2e.ts`, `project-session-terminal.e2e.ts` and `terminal-font.e2e.ts`.

- [ ] **Step 3: Update the XPaths**

Each of the five files has one line of this form (indentation differs):

```ts
    '//a[@data-thread-item="true"][.//span[normalize-space()="main"]]',
```

Change `//a[` to `//*[` on that line only, giving:

```ts
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
```

As one mechanical edit:

```bash
cd /work/workspaces/orca/BibCode/main-3/apps/desktop/e2e/specs && sed -i 's#//a\[@data-thread-item="true"\]#//*[@data-thread-item="true"]#' composer-native-triggers.e2e.ts pierre-diffs.e2e.ts composer-message-queue.e2e.ts project-session-terminal.e2e.ts terminal-font.e2e.ts && git diff --stat -- .
```

Expected: five files changed, one insertion and one deletion each.

- [ ] **Step 4: Run the support tests and the e2e typecheck**

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp test run apps/desktop/e2e/support/ui-state.test.ts apps/desktop/e2e/support/motion-guard.test.ts`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && node_modules/.bin/tsc --noEmit -p apps/desktop/e2e/tsconfig.json`
Expected: exit 0 (the same check as the tail of `@bibcode/desktop`'s `typecheck` script, without its `cargo check`).

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/desktop/e2e/specs apps/desktop/e2e/support/ui-state.test.ts`.

## Task 18: Step 2 living docs and runbooks

**Files:**
- Modify: `docs/user/workspace-ui.md` (the "Projects are shown as groups of workspace rows" list, lines ~43–52)
- Modify: `docs/reference/workspace-layout.md` (lines ~57–59)
- Modify: `docs/getting-started/quick-start.md` (line ~49)
- Modify: `docs/testing/cross-platform-validation.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md` (the bullets Task 8 added)

**Interfaces:** documentation only; it describes Tasks 10–17.

- [ ] **Step 1: Workspace UI cards**

In `docs/user/workspace-ui.md`, replace the paragraph `Projects are shown as groups of workspace rows:` and its four bullets (through `running state, and elapsed time.`) with:

```markdown
Projects are shown as groups of workspace cards. A card has up to three lines:

- **Line 1:** a status glyph, the title (bold while unread), a **primary**
  chip on the main checkout, and a pin when pinned. Hovering or focusing a
  worktree card shows **Archive**; holding the thread-jump modifier shows its
  number instead.
- **Line 2:** the branch (hidden when it equals the title), the pull or merge
  request number (`#12`, or `!57` on GitLab), coloured by state and opening
  the request when clicked, a dot for uncommitted changes, a terminal icon
  while a terminal process runs, and a globe that opens a discovered local
  server.
- **Line 3:** the provider icon, what the agent is doing (its current tool
  while working, otherwise the latest reply or prompt, or **Delivery failed**
  or **Delivery uncertain** when a message didn't land), the model, and how
  long ago that was.

The glyph's shape carries the status: a hand (needs approval), a question mark
(waiting for your answer), a spinner (working or connecting), a warning
triangle (failed), a checklist (plan ready), a filled dot (finished, not opened
yet) and a hollow ring (idle). A collapsed project and the **Show more** row
show the most urgent glyph among the cards they hide.

- The primary card represents the project's live checkout. Its title is the
  checkout's current branch, refreshed from Git rather than from a stored
  thread title.
- The primary card is backed by an undeletable default thread; to remove it,
  remove the project from its header.
- Worktree cards represent worktree threads. Creating a worktree creates both
  the Git worktree and its thread before the first message.
- Other chats open in a worktree show as **N more chats** under its card;
  chats in the main checkout count on the primary card.

Tab moves between cards; **Enter** opens one, and **Shift+F10** or the
**Menu** key opens its menu at the card.
```

In the menu section Task 8 wrote in the same file, rename rows to cards with five one-line `Edit`s (each anchor is on one line):

| Replace | With |
| --- | --- |
| `- **Worktree row:** **Open in ›**, **Pull** · **Copy Path**, **Copy Branch` | `- **Worktree card:** **Open in ›**, **Pull** · **Copy Path**, **Copy Branch` |
| `- **Primary row (the main checkout):** **Open in ›**, **Pull** · **Copy Path**,` | `- **Primary card (the main checkout):** **Open in ›**, **Pull** · **Copy Path**,` |
| `- **Several selected rows:** **Mark as Unread (N)** · **Delete (N)**.` | `- **Several selected cards:** **Mark as Unread (N)** · **Delete (N)**.` |
| `branch the row shows and is left out when the row shows none. On the local` | `branch the card shows and is left out when the card shows none. On the local` |
| `for a primary row or the worktree folder for a worktree row; it is left out for` | `for a primary card or the worktree folder for a worktree card; it is left out for` |

The Markdown formatter preserves prose wrapping (no `proseWrap` is configured), so the slightly longer lines don't fail `vp check`.

- [ ] **Step 2: Reference and quick start**

In `docs/reference/workspace-layout.md`, replace:

```markdown
- Every project has a primary row backed by an undeletable default thread for
  the main checkout.
- Worktree rows are workspace threads with `worktreePath` set.
```

with:

```markdown
- Every project has a primary card backed by an undeletable default thread for
  the main checkout.
- Worktree cards are workspace threads with `worktreePath` set.
```

In `docs/getting-started/quick-start.md`, replace `3. Pick the project's primary row to work in the live checkout, or use the` with `3. Pick the project's primary card to work in the live checkout, or use the`.

- [ ] **Step 3: Runbooks**

`docs/testing/cross-platform-validation.md` — replace the bullet Task 8 added (it starts `- sidebar menus and the project header's **⋯**:`) with:

```markdown
- workspace cards and sidebar menus at the 422 px default width, in light and
  dark: every status glyph (needs approval, waiting for your answer, working,
  failed, plan ready, finished not opened, idle), the branch line with an open
  and a merged request, a dirty dot and a running terminal, the session line,
  **N more chats**, the hidden-worktree line, and the focus ring; **Shift+F10**
  on a focused card opens exactly one menu at the card; separators between menu
  groups in the native menus (macOS, Linux) and the in-app menu (Windows,
  browser), never two in a row and never at an edge; **Pull** and **Copy Branch
  Name** on worktree and primary cards; **Show Hidden Worktrees (N)** on an
  expanded project with discovery; and keyboard operation of the in-app menu;
```

`docs/testing/linux-desktop.md` and `docs/testing/macos-desktop.md` — in the bullet Task 8 added, replace its first line `- sidebar menus: right-click a worktree row, the primary row and a project` with `- sidebar menus: right-click a worktree card, the primary card and a project`, and replace its last line `  as the header's right-click menu;` with:

```markdown
  as the header's right-click menu. Tab to a card and press **Shift+F10**
  (and, on Linux, the **Menu** key): exactly one native menu opens at the card,
  and no error toast reports a second menu;
```

`docs/testing/windows-desktop.md` — in the bullet Task 8 added (it starts `- sidebar menus use the in-app menu:`), replace `  focus to the row or **⋯**;` with:

```markdown
  focus to the card or **⋯**. **Shift+F10** and the **Menu** key on a focused
  card open the menu once, at the card;
```

- [ ] **Step 4: Verify the doc claims against the code**

Run: `cd /work/workspaces/orca/BibCode/main-3 && rg -n -i "primary row|worktree row|workspace row|selected rows|the row shows|agent activity such as provider" docs/user docs/reference/workspace-layout.md docs/getting-started docs/testing/cross-platform-validation.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md`
Expected: exactly three lines, all left for Task 22 or unrelated: `docs/user/keybindings.md:103` and `:108` ("visible left-panel workspace rows", renamed in Task 22) and `docs/user/workspace-ui.md` "they are primary row content" (the chat timeline's row, not the sidebar).

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp check`
Expected: exit 0.

- [ ] **Step 5: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- docs/user/workspace-ui.md docs/reference/workspace-layout.md docs/getting-started/quick-start.md docs/testing/cross-platform-validation.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md`.

## Task 19: Step 2 live verification — cards at 422 px against the mockup (Playwright)

**Host-only execution:** the controller runs every live command below on the host; Codex implements the code and prepares the scripts. Its sandbox blocks loopback. A missing fixture or crop is a recorded failure, including the required terminal fixture.

The cards need seven statuses, open and merged requests, a dirty dot, a terminal, "N more chats" and hidden discovery. Pending approvals, questions and plans come from provider runs, and the e2e provider shims don't produce them, so the check patches the thread-shell and VCS frames of the page's own WebSocket (plain JSON on the primary connection) with `page.routeWebSocket`. Projects, worktrees, the dirty file, discovery and the terminal are real. The `.dc.html` mockups are rendered locally for crop-by-crop comparison (ruling 18).

**Files:**
- Create (scratch): `$S/leftpanel-live/render-mockup.mjs`, `$S/leftpanel-live/patch-frames.mjs`, `$S/leftpanel-live/step2-cards.mjs`

**Interfaces:**
- Consumes: the Task 9 server, fixture and `lib.mjs`; Tasks 10–17.
- Produces: `$L/shots/mockup-*.png`, `$L/shots/step2-*.png`, `$L/logs/step2-<theme>.json`, and a comparison table in the ledger.

- [ ] **Step 1: Render the mockups**

Create `$S/leftpanel-live/render-mockup.mjs`:

```js
// Renders the approved .dc.html mockups locally. Their runtime (support.js) isn't
// available; holes are dotted lookups only (per the format reference), so a small
// expander reproduces them. Fonts are embedded from the app's own packages.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const S = process.env.S;
const L = process.env.L;
const MOCKUPS = `${S}/leftpanel-canvas/project`;
const WEB = "/work/workspaces/orca/BibCode/main-3/apps/web/node_modules";
const font = (path) => readFileSync(`${WEB}/${path}`).toString("base64");
const fontFaces = `
  @font-face { font-family: 'DM Sans'; font-weight: 100 1000; src: url(data:font/woff2;base64,${font("@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2")}) format('woff2'); }
  @font-face { font-family: 'JetBrains Mono'; font-weight: 400; src: url(data:font/woff2;base64,${font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2")}) format('woff2'); }
  body { margin: 0 }`;

async function render(file, props, name, size) {
  const source = readFileSync(`${MOCKUPS}/${file}`, "utf8");
  const template = source.slice(source.indexOf("<x-dc>") + 6, source.indexOf("</x-dc>"));
  const logic = source.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: size });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces}</style></head><body><div id="root"></div></body></html>`);
  const cards = await page.evaluate(
    ({ template, logic, props }) => {
      class DCLogic {
        constructor(p) {
          this.props = p;
          this.state = {};
        }
      }
      const Component = new Function("DCLogic", `${logic}; return Component;`)(DCLogic);
      const values = new Component(props).renderVals();
      const lookup = (raw, scope) => {
        const path = raw.replace(/[{}]/g, "").trim();
        if (path === "true") return true;
        if (path === "false") return false;
        if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
        return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), scope);
      };
      const fill = (text, scope) =>
        text.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
          const value = lookup(path, scope);
          return value == null ? "" : String(value);
        });
      const holder = document.createElement("template");
      holder.innerHTML = template;
      const expand = (node, scope, out) => {
        if (node.nodeType === Node.TEXT_NODE) {
          out.appendChild(document.createTextNode(fill(node.textContent, scope)));
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.localName;
        if (tag === "helmet") return;
        if (tag === "sc-for") {
          const as = node.getAttribute("as");
          (lookup(node.getAttribute("list"), scope) ?? []).forEach((item, index) => {
            for (const child of node.childNodes) expand(child, { ...scope, [as]: item, $index: index }, out);
          });
          return;
        }
        if (tag === "sc-if") {
          if (lookup(node.getAttribute("value"), scope)) for (const child of node.childNodes) expand(child, scope, out);
          return;
        }
        // localName, not tagName: tagName is upper-case for HTML-parsed nodes.
        const element = document.createElementNS(node.namespaceURI, node.localName);
        for (const attribute of node.attributes) element.setAttribute(attribute.name, fill(attribute.value, scope));
        for (const child of node.childNodes) expand(child, scope, element);
        out.appendChild(element);
      };
      const root = document.getElementById("root");
      for (const child of holder.content.childNodes) expand(child, values, root);
      return Array.from(document.querySelectorAll('[style*="padding: 6px 8px"]')).map((card) => {
        const rect = card.getBoundingClientRect();
        const title = card.querySelector('span[style*="font-size: 13px"]')?.textContent ?? "";
        return { title, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    },
    { template, logic, props },
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${L}/shots/mockup-${name}.png`, clip: { x: 0, y: 0, ...size } });
  for (const card of cards) {
    const slug = card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "card";
    await page.screenshot({
      path: `${L}/shots/mockup-${name}-card-${slug}.png`,
      clip: { x: card.x, y: card.y, width: card.width, height: card.height },
    });
  }
  writeFileSync(`${L}/logs/mockup-${name}-cards.json`, JSON.stringify(cards, null, 2));
  await browser.close();
  return cards.length;
}

console.log("main-light cards:", await render("Main.dc.html", { dark: false }, "main-light", { width: 422, height: 980 }));
console.log("main-dark cards:", await render("Main.dc.html", { dark: true }, "main-dark", { width: 422, height: 980 }));
console.log("states cards:", await render("States.dc.html", {}, "states", { width: 420, height: 700 }));
console.log("anatomy cards:", await render("Anatomy.dc.html", {}, "anatomy", { width: 800, height: 440 }));
await render("Menus.dc.html", {}, "menus", { width: 820, height: 460 });
console.log("rendered the mockups");
```

Run: `cd $L && S=$S L=$L node render-mockup.mjs`
Expected: `main-light cards: 7`, `main-dark cards: 7`, `states cards: 7`, `anatomy cards: 1`, `rendered the mockups`. (`Dark.dc.html` only imports `Main` with `dark` set, so rendering `Main` with `{ dark: true }` is the same board.) Open `$L/shots/mockup-main-light.png` and check it matches the approved artifact's "Proposed · light" board (four projects, the hover strip on the second project, the Settings footer).

- [ ] **Step 2: Write the frame patcher**

Create `$S/leftpanel-live/patch-frames.mjs`:

```js
// Gives real fixture threads the states a provider run would produce. It patches
// only JSON text frames on the page's own socket: thread shells (matched by title,
// or by project for primary threads), passive VCS summaries (matched by branch)
// and full status streams (matched by the cwd of the request that opened them).
// The server sends one message per frame; the client may batch an array.
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const soon = new Date(Date.now() + 10 * 60_000).toISOString();
const turn = (id, state, startedMinutesAgo, completedAt) => ({
  turnId: id,
  state,
  requestedAt: minutesAgo(startedMinutesAgo),
  startedAt: minutesAgo(startedMinutesAgo),
  completedAt,
  assistantMessageId: null,
});
const session = (threadId, status, providerName) => ({
  threadId,
  status,
  providerName,
  runtimeMode: "full-access",
  activeTurnId: status === "running" ? `turn-${threadId}` : null,
  lastError: status === "error" ? "Build failed: image registry rate limit" : null,
  updatedAt: minutesAgo(1),
});
const preview = (fields) => ({ prompt: null, tool: null, assistantMessage: null, ...fields });
// The wire shape of ModelSelection; line 3 falls back to the slug when the
// server's catalog has no short name for it.
const claude = (model) => ({ instanceId: "claudeAgent", model });
const codex = (model) => ({ instanceId: "codex", model });

export const STATES = {
  // Idle with a session line: no latest turn, so no completion can read as unseen.
  "default:customer-portal": (s) => ({
    session: session(s.id, "ready", "claudeAgent"),
    latestTurn: null,
    conversationPreview: preview({ assistantMessage: "Reviewed the release checklist" }),
    modelSelection: claude("sonnet"),
    latestUserMessageAt: minutesAgo(120),
  }),
  "Fix invoice date format": (s) => ({
    session: session(s.id, "running", "claudeAgent"),
    latestTurn: turn(`turn-${s.id}`, "running", 6, null),
    conversationPreview: preview({ prompt: "Fix the export date format", tool: "Editing src/export/invoiceDates.ts" }),
    modelSelection: claude("opus"),
    latestUserMessageAt: minutesAgo(6),
  }),
  "Upgrade PDF renderer": (s) => ({
    session: session(s.id, "ready", "codex"),
    // Completes after any visit made during the run, so it reads "finished, not opened".
    latestTurn: turn(`turn-${s.id}`, "completed", 20, soon),
    conversationPreview: preview({ assistantMessage: "Renderer upgraded; export tests pass" }),
    modelSelection: codex("gpt-5-codex"),
    latestUserMessageAt: minutesAgo(18),
  }),
  "default:pathfinder-application-server": (s) => ({
    hasPendingApprovals: true,
    session: session(s.id, "running", "claudeAgent"),
    latestTurn: turn(`turn-${s.id}`, "running", 1, null),
    conversationPreview: preview({ prompt: "Wants to run: pnpm test --filter api" }),
    modelSelection: claude("sonnet"),
    latestUserMessageAt: minutesAgo(1),
  }),
  "Search index rebuild": (s) => ({
    hasPendingUserInput: true,
    session: session(s.id, "running", "claudeAgent"),
    latestTurn: turn(`turn-${s.id}`, "running", 12, null),
    conversationPreview: preview({ assistantMessage: "Which analyzer should the new index use?" }),
    modelSelection: claude("opus"),
    latestUserMessageAt: minutesAgo(12),
  }),
  "Pin base images": (s) => ({
    session: session(s.id, "error", "codex"),
    latestTurn: turn(`turn-${s.id}`, "error", 185, minutesAgo(180)),
    conversationPreview: preview({ assistantMessage: "Build failed: image registry rate limit" }),
    modelSelection: codex("gpt-5-codex"),
    latestUserMessageAt: minutesAgo(180),
  }),
  "Queue migration plan": (s) => ({
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    session: session(s.id, "ready", "codex"),
    latestTurn: turn(`turn-${s.id}`, "completed", 5, minutesAgo(4)),
    conversationPreview: preview({ assistantMessage: "Plan: 4 steps to migrate the queue" }),
    modelSelection: codex("gpt-5-codex"),
    latestUserMessageAt: minutesAgo(4),
  }),
};

const PROVIDERS = {
  gitlab: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.example.invalid" },
  github: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
};
const REQUESTS = {
  "fix-TRI-150": { provider: "gitlab", number: 57, state: "open", title: "Fix invoice date format" },
  "chore/pdf-renderer": { provider: "gitlab", number: 54, state: "open", title: "Upgrade PDF renderer" },
  "feature/search-index": { provider: "gitlab", number: 12, state: "open", title: "Search index rebuild" },
  "plan/queue": { provider: "github", number: 31, state: "merged", title: "Queue migration plan" },
};
// Worktree directories from Task 9, matched by suffix so a symlinked $S still matches.
const BRANCH_BY_WORKTREE_SUFFIX = {
  "/wt/fix-TRI-150": "fix-TRI-150",
  "/wt/pdf-renderer": "chore/pdf-renderer",
  "/wt/search-index": "feature/search-index",
  "/wt/queue": "plan/queue",
};
const branchForCwd = (cwd) =>
  typeof cwd === "string"
    ? (Object.entries(BRANCH_BY_WORKTREE_SUFFIX).find(([suffix]) => cwd.endsWith(suffix))?.[1] ?? null)
    : null;

const statusChangeRequest = (branch) => {
  const request = REQUESTS[branch];
  return {
    number: request.number,
    title: request.title,
    url: `https://example.invalid/requests/${request.number}`,
    baseRef: "main",
    headRef: branch,
    state: request.state,
  };
};

const isShell = (value) =>
  value && typeof value === "object" && "hasPendingApprovals" in value && "projectId" in value && "title" in value;

export function createFramePatcher({ projectIds, unknownProvider = false }) {
  const projectNameById = Object.fromEntries(Object.entries(projectIds).map(([name, id]) => [id, name]));
  const cwdByRequestId = new Map();
  const counts = { shells: 0, panels: 0, summaries: 0, statuses: 0, shellsByFixture: {} };

  const fixtureKey = (shell) =>
    shell.kind === "default" ? `default:${projectNameById[shell.projectId]}` : shell.title;
  const stateFor = (shell) => STATES[fixtureKey(shell)];
  const panelsFor = (host) =>
    [1, 2].map((n) => ({
      ...host,
      id: `fixture-panel-${n}`,
      kind: "panel",
      title: `Panel chat ${n}`,
      session: null,
      latestTurn: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      conversationPreview: null,
      unresolvedDelivery: null,
    }));

  const patch = (value, branch) => {
    if (Array.isArray(value)) {
      const patched = value.map((entry) => patch(entry, branch));
      const host = patched.find((entry) => isShell(entry) && entry.title === "Search index rebuild");
      if (host && !patched.some((entry) => isShell(entry) && entry.id === "fixture-panel-1")) {
        patched.push(...panelsFor(host));
        counts.panels += 2;
      }
      return patched;
    }
    if (!value || typeof value !== "object") return value;
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = patch(child, branch);
    if (isShell(next)) {
      const state = stateFor(next);
      if (state) {
        Object.assign(next, state(next));
        if (unknownProvider && next.title === "Queue migration plan") next.session.providerName = "custom-provider";
        counts.shells += 1;
        const key = fixtureKey(next);
        counts.shellsByFixture[key] = (counts.shellsByFixture[key] ?? 0) + 1;
      }
    }
    // Passive summaries (VcsStatusSummary): matched by branch.
    if ("isRepo" in next && "stale" in next && typeof next.refName === "string" && REQUESTS[next.refName]) {
      const request = REQUESTS[next.refName];
      next.sourceControlProvider = PROVIDERS[request.provider];
      next.pr = {
        provider: request.provider,
        number: request.number,
        title: request.title,
        url: `https://example.invalid/requests/${request.number}`,
        baseRefName: "main",
        headRefName: next.refName,
        state: request.state,
        updatedAt: { _id: "Option", _tag: "None" },
      };
      counts.summaries += 1;
    }
    // Full status streams (the active card): local and remote halves, by request cwd.
    if (branch && REQUESTS[branch]) {
      if ("hasPrimaryRemote" in next) next.sourceControlProvider = PROVIDERS[REQUESTS[branch].provider];
      if ("hasUpstream" in next) {
        next.pr = statusChangeRequest(branch);
        counts.statuses += 1;
      }
      // A fixture repository has no remote, so the server reports none; supply one.
      if ((next._tag === "snapshot" || next._tag === "remoteUpdated") && next.remote === null) {
        next.remote = { hasUpstream: false, aheadCount: 0, behindCount: 0, pr: statusChangeRequest(branch) };
        counts.statuses += 1;
      }
    }
    return next;
  };

  const patchMessage = (message) => patch(message, branchForCwd(cwdByRequestId.get(message?.requestId)));

  return {
    counts,
    fromPage(text) {
      try {
        const parsed = JSON.parse(text);
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          if (message?._tag === "Request" && typeof message.payload?.cwd === "string") {
            cwdByRequestId.set(message.id, message.payload.cwd);
          }
        }
      } catch {}
    },
    fromServer(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return text;
      }
      return JSON.stringify(Array.isArray(parsed) ? parsed.map(patchMessage) : patchMessage(parsed));
    },
  };
}
```

- [ ] **Step 3: Write the step-2 check**

Create `$S/leftpanel-live/step2-cards.mjs`:

```js
// Step 2 live check: every card state at 422 px, light and dark, with crops for
// comparison against the rendered mockup, plus keyboard focus and the card menu.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { L, SERVER, launch, origin } from "./lib.mjs";
import { createFramePatcher, STATES } from "./patch-frames.mjs";

const dark = process.env.DARK === "1";
const theme = dark ? "dark" : "light";
const fixture = JSON.parse(readFileSync(`${L}/fixture.json`, "utf8"));
const failures = [];
const results = {};
const check = (name, condition, detail) => {
  results[name] = { pass: Boolean(condition), detail };
  if (!condition) failures.push(name);
};

const { context, page } = await launch({ dark });
const patcher = createFramePatcher({ projectIds: fixture.projectIds });
await page.routeWebSocket(
  (url) => url.port === String(SERVER) && url.pathname === "/ws",
  (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") patcher.fromPage(message);
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(typeof message === "string" ? patcher.fromServer(message) : message);
    });
  },
);
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="sidebar-projects-group"]', { timeout: 60_000 });
await page.waitForTimeout(3_000);
for (const key of Object.keys(STATES)) {
  check(`fixture shell patched: ${key}`, (patcher.counts.shellsByFixture[key] ?? 0) > 0, patcher.counts.shellsByFixture[key] ?? 0);
}
check("panel fixtures patched", patcher.counts.panels >= 2, patcher.counts.panels);

const card = (key) =>
  key.startsWith("primary:")
    ? page.locator(`[data-testid="primary-card-${fixture.projectIds[key.slice(8)]}"]`)
    : page.locator('[data-testid^="thread-row-"]', { hasText: key }).first();

// Collapse agent-bridges first (a header click also selects the project; the
// card clicks below clear that selection). Then visit "Upgrade PDF renderer"
// once, so its completion is unseen, make "Fix invoice date format" the active
// card, and mark "Upgrade PDF renderer" unread (idempotent across runs).
const bridges = page.locator('button[data-sidebar="menu-button"]', { hasText: "agent-bridges" });
if ((await bridges.getAttribute("aria-expanded")) === "true") await bridges.click();
await card("Upgrade PDF renderer").click();
await page.waitForTimeout(1_500);
await card("Fix invoice date format").click();
await page.waitForTimeout(1_500);
await card("Upgrade PDF renderer").click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const markUnread = page.locator('[role="menuitem"]', { hasText: "Mark as Unread" });
if ((await markUnread.count()) > 0) await markUnread.first().click();
else await page.keyboard.press("Escape");

// Required real terminal process on the active card. Record each owned foreground child from inside that child.
results["terminal"] = await (async () => {
  try {
    const terminalIcon = card("Fix invoice date format").locator('[aria-label="Terminal process running"]');
    // Light and dark reuse the same fixture/profile. A running recorded child
    // remains required evidence; do not try the empty-state shell button again.
    for (const previousTheme of ["light", "dark"]) {
      const previousRecord = `${L}/logs/terminal-${previousTheme}.pid`;
      if (!existsSync(previousRecord)) continue;
      const pid = readFileSync(previousRecord, "utf8").trim();
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Invalid owned terminal PID");
      const commandPath = `/proc/${pid}/cmdline`;
      if (!existsSync(commandPath)) continue;
      if (readFileSync(commandPath, "utf8") !== "sleep\0" + "900\0") continue;
      await terminalIcon.waitFor({ timeout: 15_000 });
      return { pass: true, pid, detail: "reused recorded terminal fixture" };
    }
    await page.locator('button[aria-label="Toggle right panel"]').first().click({ timeout: 5_000 });
    await page.getByRole("button", { name: /Start a shell in this workspace/ }).first().click({ timeout: 5_000 });
    const input = page.locator(".xterm-helper-textarea").first();
    await input.waitFor({ timeout: 10_000 });
    await input.focus();
    const record = `${L}/logs/terminal-${theme}.pid`;
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await page.keyboard.type(
      "bash -c 'echo $$ > \"$1\"; exec sleep 900' bash " + quote(record),
    );
    await page.keyboard.press("Enter");
    await card("Fix invoice date format").locator('[aria-label="Terminal process running"]').waitFor({ timeout: 15_000 });
    const pid = readFileSync(`${L}/logs/terminal-${theme}.pid`, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Terminal PID was not recorded");
    return { pass: true, pid };
  } catch (error) {
    return { pass: false, detail: `required terminal fixture failed: ${String(error).slice(0, 160)}` };
  }
})();
check("terminal", results.terminal.pass, results.terminal);
await page.mouse.move(1_000, 500);
await page.waitForTimeout(500);

// Glyphs, lines and indicators for every fixture card.
const expected = [
  { key: "primary:customer-portal", kind: "idle", title: "develop", session: true },
  { key: "Fix invoice date format", kind: "working", pr: "!57", dirty: true, session: true },
  { key: "Upgrade PDF renderer", kind: "done", pr: "!54", unread: true, session: true },
  { key: "primary:pathfinder-application-server", kind: "approval", title: "alpha", session: true },
  { key: "Search index rebuild", kind: "input", pr: "!12", more: "2 more chats", session: true },
  { key: "primary:pathfinder-docker-manager", kind: "idle", title: "master", session: false },
  { key: "Pin base images", kind: "failed", session: true },
  { key: "Queue migration plan", kind: "plan", pr: "#31", session: true },
];
for (const entry of expected) {
  try {
    const locator = card(entry.key);
    const kind = await locator.locator('[role="img"][data-status]').first().getAttribute("data-status");
    check(`${entry.key}: glyph`, kind === entry.kind, kind);
    if (entry.title) check(`${entry.key}: title`, (await locator.textContent())?.includes(entry.title), entry.title);
    if (entry.pr) check(`${entry.key}: ${entry.pr}`, (await locator.locator("button[data-card-control]", { hasText: entry.pr }).count()) === 1);
    if (entry.dirty) check(`${entry.key}: dirty dot`, (await locator.locator('[aria-label="Uncommitted changes"]').count()) === 1);
    if (entry.unread) check(`${entry.key}: bold`, (await locator.locator('[data-unread="true"]').count()) === 1);
    if (entry.more) check(`${entry.key}: ${entry.more}`, (await locator.getByText(entry.more).count()) === 1);
    check(`${entry.key}: session line ${entry.session ? "shown" : "hidden"}`, ((await locator.locator('[class*="h-[22px]"]').count()) === 1) === entry.session);
    const box = await locator.boundingBox();
    const slug = entry.key.replace("primary:", "primary-").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    check(`${entry.key}: crop reproducible`, box !== null, box);
    if (box) {
      try {
        await page.screenshot({ path: `${L}/shots/step2-${theme}-card-${slug}.png`, clip: box });
      } catch (error) {
      check(`${entry.key}: crop capture`, false, String(error).slice(0, 160));
    }
  }
  } catch (error) {
    check(`${entry.key}: required fixture/crop`, false, String(error).slice(0, 160));
  }
}
check("Hiding 1 discovered worktree", (await page.getByText("Hiding 1 discovered worktree").count()) === 1);
check("active card", (await card("Fix invoice date format").locator('button[aria-current="page"]').count()) === 1);

// Geometry of a three-line card against Anatomy.dc.html.
const metrics = await card("Pin base images").evaluate((li) => {
  const px = (element, property) => Number.parseFloat(getComputedStyle(element)[property]);
  const content = li.querySelector(":scope > div.pointer-events-none");
  const title = li.querySelector('[data-testid^="thread-title-"]');
  const branchLine = li.querySelector('[class*="h-[18px]"]');
  const sessionLine = li.querySelector('[class*="h-[22px]"]');
  const glyph = li.querySelector('[role="img"][data-status] svg');
  return {
    radius: px(li, "borderTopLeftRadius"),
    paddingTop: px(content, "paddingTop"),
    paddingLeft: px(content, "paddingLeft"),
    titleSize: px(title, "fontSize"),
    line2Height: branchLine?.getBoundingClientRect().height,
    line2Size: branchLine ? px(branchLine, "fontSize") : null,
    line3Height: sessionLine?.getBoundingClientRect().height,
    glyphWidth: glyph?.getBoundingClientRect().width,
    cardHeight: li.getBoundingClientRect().height,
  };
});
check("card radius 8", metrics.radius === 8, metrics);
check("card padding 6×8", metrics.paddingTop === 6 && metrics.paddingLeft === 8, metrics);
check("title 13 px, lines 12 px", metrics.titleSize === 13 && metrics.line2Size === 12, metrics);
check("line heights 18/22", metrics.line2Height === 18 && metrics.line3Height === 22, metrics);
check("glyph 14 px", metrics.glyphWidth === 14, metrics);
// 1 px border + 6 px padding + 20 + 2 + 18 + 2 + 22 + 6 px padding + 1 px border = 78.
check("three-line card about 78 px", metrics.cardHeight >= 74 && metrics.cardHeight <= 82, metrics);

// No card text below 12 px or with letter-spacing (step 3 extends this to the whole sidebar).
const typography = await page.$$eval('[data-sidebar="menu-sub"] [data-thread-item] *', (elements) =>
  elements
    .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim() !== ""))
    .map((element) => {
      const style = getComputedStyle(element);
      return { text: element.textContent.trim().slice(0, 30), size: Number.parseFloat(style.fontSize), spacing: style.letterSpacing };
    })
    .filter((entry) => entry.size < 12 || (entry.spacing !== "normal" && entry.spacing !== "0px")),
);
check("card typography", typography.length === 0, typography);

// PR and ports have large hit areas while glyphs remain at their mockup size.
const targets = await page.$$eval('[data-thread-item] button[data-card-control]', (buttons) =>
  buttons.filter((button) => button.querySelector(".lucide-globe-2") || button.getAttribute("aria-label")?.match(/(?:PR|MR|request|localhost)/i))
    .map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
);
check("PR/ports targets at least 24x24", targets.length > 0 && targets.every((target) => target.width >= 24 && target.height >= 24), targets);

// The sidebar is 422 px wide on a fresh profile at 1400 px.
const width = await page.$eval('[data-slot="sidebar-container"]', (element) => element.getBoundingClientRect().width);
check("sidebar 422 px", width === 422, width);
await page.screenshot({ path: `${L}/shots/step2-${theme}-sidebar.png`, clip: { x: 0, y: 0, width: 422, height: 980 } });
await card("Search index rebuild").hover();
await page.screenshot({ path: `${L}/shots/step2-${theme}-sidebar-hover.png`, clip: { x: 0, y: 0, width: 422, height: 980 } });

// Keyboard: Tab reaches a card, the focus ring is the orange ring, Shift+F10 opens
// exactly one menu at the card, Escape returns focus, Enter opens the card.
await page.locator('[data-testid="command-palette-trigger"]').focus();
let focusedCard = null;
for (let step = 0; step < 40 && focusedCard === null; step += 1) {
  await page.keyboard.press("Tab");
  focusedCard = await page.evaluate(() => {
    const testId = document.activeElement?.getAttribute("data-testid") ?? "";
    return testId.startsWith("thread-card-button-") || testId.startsWith("primary-card-button-") ? testId : null;
  });
}
check("Tab reaches a card button", focusedCard !== null, focusedCard);
const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
check("focus ring is #d8610e", ring.includes("216, 97, 14"), ring);
await page.screenshot({ path: `${L}/shots/step2-${theme}-focus.png`, clip: { x: 0, y: 0, width: 422, height: 980 } });
const anchor = await page.evaluate(() => {
  const rect = document.activeElement.getBoundingClientRect();
  return { left: Math.round(rect.left), bottom: Math.round(rect.bottom) };
});
await page.keyboard.press("Shift+F10");
await page.waitForSelector('[role="menu"]');
await page.waitForTimeout(300);
// Explicitly reproduce the delayed webview echo after the opening animation frame.
await page.locator(`[data-testid="${focusedCard}"]`).evaluate((button) => {
  button.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true, cancelable: true }));
  button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
});
const menus = await page.$$eval('[role="menu"]', (elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
check("Shift+F10 opens exactly one menu", menus.length === 1, menus.length);
check(
  "menu anchored at the card's bottom-left",
  menus.length === 1 && Math.abs(menus[0].left - anchor.left) <= 1 && Math.abs(menus[0].top - anchor.bottom) <= 1,
  { menu: menus[0], anchor },
);
await page.screenshot({ path: `${L}/shots/step2-${theme}-card-menu.png` });
await page.keyboard.press("Escape");
check("Escape returns focus to the card", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === focusedCard);
await page.keyboard.press("ContextMenu");
await page.waitForTimeout(300);
check("Menu key opens exactly one menu", (await page.locator('[role="menu"]').count()) === 1);
await page.keyboard.press("Escape");
await page.keyboard.press("Enter");
await page.waitForTimeout(1_000);
check("Enter opens the card", (await page.locator(`[data-testid="${focusedCard}"]`).getAttribute("aria-current")) === "page");

// The packaged e2e XPath finds the primary card and opens it.
await card("Fix invoice date format").click();
await page.waitForTimeout(1_000);
const primaryXPath = page.locator('//*[@data-thread-item="true"][.//span[normalize-space()="develop"]]');
check("e2e XPath finds the primary card", (await primaryXPath.count()) === 1);
await primaryXPath.first().click();
await page.waitForTimeout(1_000);
check("primary card becomes active", (await card("primary:customer-portal").locator('button[aria-current="page"]').count()) === 1);

writeFileSync(`${L}/logs/step2-${theme}.json`, JSON.stringify(results, null, 2));
console.log(`step2 ${theme}: ${failures.length === 0 ? "PASS" : `FAIL ${failures.join(", ")}`}`);
await context.close();
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 4: Run it in light and dark**

Each run loads the page fresh, so the dev server serves the step-2 code without a restart; that includes Task 10's `@bibcode/shared` change, because the package exports its `src/*.ts` files directly. Run:

```bash
cd $L && L=$L DARK=0 node step2-cards.mjs; L=$L DARK=1 node step2-cards.mjs
```

Expected: `step2 light: PASS` and `step2 dark: PASS`. A failing check names itself; fix the product if it is the product, fix the script if it is the script (for example a selector that differs), and re-run. Failure to reproduce the terminal state or capture its required crop fails the run (L7/M5); record the blocker and have the controller reproduce it on the host before claiming PASS. The runs share one browser profile on purpose: the second run starts from the first run's visit and unread marks, and every step above is written to reach the same state from either starting point.

- [ ] **Step 5: Compare crop by crop with the mockup**

Open (Read) each pair and record a verdict in the ledger:

| Live crop (`$L/shots/`) | Mockup crop (`$L/shots/`) |
| --- | --- |
| `step2-light-card-primary-customer-portal.png` | `mockup-main-light-card-develop.png` |
| `step2-light-card-fix-invoice-date-format.png` | `mockup-main-light-card-fix-invoice-date-format.png` |
| `step2-light-card-upgrade-pdf-renderer.png` | `mockup-main-light-card-upgrade-pdf-renderer.png` |
| `step2-light-card-primary-pathfinder-application-server.png` | `mockup-main-light-card-alpha.png` |
| `step2-light-card-search-index-rebuild.png` | `mockup-main-light-card-search-index-rebuild.png` |
| `step2-light-card-primary-pathfinder-docker-manager.png` | `mockup-main-light-card-master.png` |
| `step2-light-card-pin-base-images.png` | `mockup-main-light-card-pin-base-images.png` |
| `step2-light-card-queue-migration-plan.png` | `mockup-states-card-plan-ready-to-review.png` |
| `step2-light-sidebar-hover.png` | `mockup-main-light.png` |
| `step2-light-card-pin-base-images.png` (geometry) | `mockup-anatomy.png` |
| `step2-light-card-menu.png` (menu rows and separators) | `mockup-menus.png` |

and the same rows with `dark` for the first eight and the full sidebar (`mockup-main-dark*.png`). `States.dc.html`, `Anatomy.dc.html` and `Menus.dc.html` are light only, so compare the dark plan card, geometry and menu with them for shape and layout, and with `mockup-main-dark.png` for colours. For each pair, check the glyph shape and colour family, the title weight, the chip, line order and spacing, the PR label and colour, the dirty dot, the terminal icon, the model in mono, the age, and "N more chats". Differences the spec allows are not failures: indigo rather than violet for input, amber-600 light / `-300/90` dark shades, `text-destructive` for failed, `bg-warning` dirty dot, `bg-accent` active fill, no "draft" colour (the fixture uses open), a glyph on "N more chats" and no chevron, 24 px hover-strip targets, and real provider icons. Anything else is a finding: fix it or record why in the ledger.

- [ ] **Step 6: Checkpoint (no commit)**

No repository files change here (fixes found above belong to the task that owns the file, with their own test). Record the checkpoint tree hash:

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

# Step 3 — Removals and typography

Step 3 ships on its own: "No threads yet", the Agents badge at 0 and the redundant header cloud go, and the rest of the left panel reaches `UI.md`'s 12 px floor without letter-spacing. After it, `UI.md:176` ("Screens outside the sidebar … predate these rules") is true for the sidebar.

## Task 20: Removals — "No threads yet", the Agents badge at 0, the header cloud

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (`SidebarProjectThreadListProps`, `SidebarProjectThreadList`, `SidebarProjectItem`'s second per-project `useMemo` and its `<SidebarProjectThreadList` JSX, the project header's padding and environment badge, the `lucide-react` import)
- Test: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/sidebar/AgentsNavRow.tsx`
- Test: `apps/web/src/components/sidebar/AgentsNavRow.test.tsx`
- Modify: `docs/user/workspace-ui.md` (the Agents paragraph, line ~27)
- Modify: `docs/testing/cross-platform-validation.md` (the Agents nav row item, line ~1815)

**Interfaces:**
- Consumes: Task 16's merged list, whose first card is always the primary card, so an expanded project is never empty.
- Produces: `SidebarProjectThreadListProps` without `showEmptyThreadState`; the header badge renders only when `environmentPresence === "remote-only" && allRemoteMembersAreDesktopLocal`, always as the container icon; `AgentsNavRow` renders its badge only when `unreadCount > 0`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/Sidebar.test.tsx`, replace the test `it("shows the empty-thread state for an expanded project without workspace threads", …)` with:

```tsx
  it("shows only the primary card for an expanded project without workspace threads", () => {
    h.state.projects = [projectA];
    h.state.threads = [threadDefault];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    const markup = render(<Sidebar />);
    expect(markup).toContain('data-testid="primary-card-project-a"');
    expect(markup).not.toContain("No threads yet");
  });
```

In the same file, inside `staticDescribe("Sidebar environment scoping", () => {`, after the test `it("keeps local environments merged when a local environment is selected", …)`, add:

```tsx
  it("drops the cloud from a saved server's project headers", () => {
    seedTwoEnvironments();
    h.state.activeEnvironmentId = ENV_REMOTE;
    const markup = render(<Sidebar />);
    expect(markup).toContain("Remote Repo");
    expect(markup).not.toContain('aria-label="Remote project"');
    expect(markup).not.toContain("lucide-cloud");
  });

  it("keeps the container badge on a WSL project's header", () => {
    seedTwoEnvironments();
    h.state.environments.push(
      environmentFixture({
        environmentId: ENV_WSL,
        label: "Ubuntu",
        connectionId: "local:wsl-ubuntu",
      }),
    );
    h.state.projects.push(
      makeProject("project-wsl", {
        environmentId: ENV_WSL,
        title: "WSL Repo",
        workspaceRoot: "/home/user/wsl-repo",
      }),
    );
    h.state.activeEnvironmentId = ENV_MAIN;
    const markup = render(<Sidebar />);
    expect(markup).toContain('aria-label="Local sandbox project"');
    expect(markup).toContain("lucide-container");
  });
```

In `apps/web/src/components/sidebar/AgentsNavRow.test.tsx`, after `it("shows the unread count for the full agent row set", …)`, add:

```tsx
  it("hides the unread badge when nothing is unread", async () => {
    h.shells = [makeShell({ id: ThreadId.make("thread-read") })];
    h.unreadThreadKeys = [];

    const { container } = await mountNavRow();

    expect(getNavRow(container).textContent).toBe("Agents");
  });
```

- [ ] **Step 2: Run them and watch three fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx src/components/sidebar/AgentsNavRow.test.tsx`
Expected: FAIL in three tests — the markup still contains "No threads yet", the header still has `aria-label="Remote project"`, and the nav row reads "Agents0". "keeps the container badge on a WSL project's header" passes already; it guards against removing too much.

- [ ] **Step 3: Remove "No threads yet"**

In `apps/web/src/components/Sidebar.tsx`:

1. In `interface SidebarProjectThreadListProps {`, delete the line `  showEmptyThreadState: boolean;`.
2. Delete the line `    showEmptyThreadState,` in both places it occurs (`SidebarProjectThreadList`'s props destructuring and `SidebarProjectItem`'s destructuring of its second per-project `useMemo`); one `Edit` with `replace_all: true`, including the line break.
3. In `SidebarProjectThreadList`'s JSX, delete the whole block:

```tsx
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-xs text-muted-foreground"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
```

4. In the second per-project `useMemo`'s returned object, delete `      showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,`.
5. In the `<SidebarProjectThreadList` JSX, delete `        showEmptyThreadState={showEmptyThreadState}`.

- [ ] **Step 4: Keep the header badge for WSL projects only**

In the project header, replace the padding expression

```tsx
            project.environmentPresence === "remote-only" ? "pr-20" : "pr-14"
```

with

```tsx
            project.environmentPresence === "remote-only" &&
            project.allRemoteMembersAreDesktopLocal
              ? "pr-20"
              : "pr-14"
```

and replace the whole environment badge block, from the comment `{/* Environment badge – visible by default, crossfades with the` through the `)}` that closes `{project.environmentPresence === "remote-only" && (`, with:

```tsx
        {/* The container badge tells WSL projects apart inside Local, which
            mixes this device and WSL. A saved server's scope shows only that
            server's projects, so a cloud there said nothing and is gone. The
            badge crossfades with the hover strip. */}
        {project.environmentPresence === "remote-only" &&
        project.allRemoteMembersAreDesktopLocal ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label="Local sandbox project"
                  className="pointer-events-none absolute top-1 right-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity duration-150 max-sm:right-14 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                />
              }
            >
              <ContainerIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {`Local sandbox: ${project.remoteEnvironmentLabels.join(", ")}`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
```

`text-muted-foreground/60` stays: it tints an icon, which `UI.md` allows. Then delete `  CloudIcon,` from the `lucide-react` import: the header was its last user in this file (Task 15 removed the row's cloud). `ThreadRowTrailingStatus`'s cloud in `ThreadStatusIndicators.tsx` belongs to the command palette and stays.

- [ ] **Step 5: Hide the Agents badge at 0**

In `apps/web/src/components/sidebar/AgentsNavRow.tsx`, replace:

```tsx
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
              {unreadCount}
            </span>
```

with:

```tsx
            {unreadCount > 0 ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                {unreadCount}
              </span>
            ) : null}
```

- [ ] **Step 6: Docs**

In `docs/user/workspace-ui.md`, replace `unread-count badge covers agents across all connected environments. Selecting` with `unread-count badge covers agents across all connected environments and is hidden when nothing is unread. Selecting`.

In `docs/testing/cross-platform-validation.md`, replace the line `  nav row below Search, whose unread badge aggregates across environments;` with:

```markdown
  nav row below Search, whose unread badge aggregates across environments and
  is hidden when nothing is unread;
```

- [ ] **Step 7: Run the tests, typecheck and check**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/Sidebar.test.tsx src/components/sidebar/AgentsNavRow.test.tsx`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp fmt apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/AgentsNavRow.tsx apps/web/src/components/sidebar/AgentsNavRow.test.tsx docs/user/workspace-ui.md docs/testing/cross-platform-validation.md && vp run --filter @bibcode/web typecheck && vp check`
Expected: exit 0 for this task's files.

- [ ] **Step 8: Review**

`vercel-react-best-practices`: the removals delete a prop and a branch; the badge is a conditional leaf with no new state. `UI.md`: a badge showing 0 was noise; the container badge still answers "is this WSL?", which the Local scope can't show otherwise. Record both.

- [ ] **Step 9: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/AgentsNavRow.tsx apps/web/src/components/sidebar/AgentsNavRow.test.tsx docs/user/workspace-ui.md docs/testing/cross-platform-validation.md`.

## Task 21: Typography sweep

**Files:**
- Create: `apps/web/src/components/sidebar/sidebarTypography.test.ts` (source guard)
- Modify: `apps/web/src/components/Sidebar.tsx` (the Projects label, the Settings footer button, `SidebarBrandContent`, both project-list gaps)
- Review/test imported provider icon: `apps/web/src/components/chat/ProviderInstanceIcon.tsx` (read-only; the sidebar usage in Task 14 overrides its initials size)
- Test: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/sidebar/EnvironmentRail.tsx` (line ~85)
- Modify: `apps/web/src/components/WorktreeDiscoverySection.tsx` (lines ~124, 155, 159, 182, 200, 431, 436, 454, 473, 483, 505, 532)
- Modify: `apps/web/src/components/sidebar/SidebarProjectAvailability.tsx` (line ~61)
- Test: `apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx`
- Modify: `apps/web/src/components/WorktreeAvailabilityWarning.tsx` (line ~59)

**Interfaces:**
- Consumes: Task 10's `text-xs` status label, Task 15's re-authored rename input and jump label, and ruling 15's scope.
- Produces: no text below `text-xs` and no `tracking-*` utility in any file that renders the left panel, except batch 1's `EnvironmentContextCard.tsx` and `ServerUpdateBadge.tsx`; the guard keeps it that way.

- [ ] **Step 1: Write the failing source guard and markup tests**

Create `apps/web/src/components/sidebar/sidebarTypography.test.ts`:

```ts
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// Every file that renders text in the left panel, except batch 1's environment
// context card and update badge. UI.md: nothing smaller than text-xs (12 px)
// and no letter-spacing utilities.
const LEFT_PANEL_SOURCES = [
  "../Sidebar.tsx",
  "../ThreadStatusIndicators.tsx",
  "../WorktreeAvailabilityWarning.tsx",
  "../WorktreeDiscoverySection.tsx",
  "./AgentsNavRow.tsx",
  "./EnvironmentRail.tsx",
  "./RelativeAge.tsx",
  "./SidebarProjectAvailability.tsx",
  "./SidebarProviderUpdatePill.tsx",
  "./SidebarUpdatePill.tsx",
  "./WorkspaceCard.tsx",
] as const;

const BELOW_TEXT_XS = /\btext-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g;
const LETTER_SPACING = /\btracking-[\w.[\]-]+/g;

describe("left panel typography", () => {
  it("sets text-xs at every sidebar ProviderInstanceIcon usage, including imported initials", () => {
    const usages = LEFT_PANEL_SOURCES.flatMap((path) => {
      const source = NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
      return [...source.matchAll(/<ProviderInstanceIcon\b[\s\S]*?\/>/g)].map(([tag]) => tag);
    });
    expect(usages.length).toBeGreaterThan(0);
    for (const tag of usages) {
      expect(tag).toMatch(/iconClassName="[^"]*\btext-xs\b[^"]*"/);
      expect(tag).toContain("showBadge={false}");
    }
    // The shared component composes iconClassName after its default initials class.
    // Its non-sidebar defaults are intentionally not swept here.
    const icon = NodeFS.readFileSync(new URL("../chat/ProviderInstanceIcon.tsx", import.meta.url), "utf8");
    expect(icon).toContain('"text-[10px] font-semibold leading-none", props.iconClassName');
  });

  it("sets 6 px spacing in both project SidebarMenu branches", () => {
    const source = NodeFS.readFileSync(new URL("../Sidebar.tsx", import.meta.url), "utf8");
    const menus = [...source.matchAll(/<SidebarMenu\b[^>]*data-testid="sidebar-project-list"[^>]*>/g)];
    expect(menus).toHaveLength(2);
    for (const [tag] of menus) expect(tag).toContain('className="gap-1.5"');
    expect(menus.some(([tag]) => tag.includes("ref={attachProjectListAutoAnimateRef}"))).toBe(true);
  });

  it.each(LEFT_PANEL_SOURCES)("%s has no text below 12 px and no letter-spacing", (path) => {
    const source = NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source.match(BELOW_TEXT_XS) ?? []).toEqual([]);
    expect(source.match(LETTER_SPACING) ?? []).toEqual([]);
  });
});
```

In `apps/web/src/components/Sidebar.test.tsx`, extend `it("renders base name and stage label", …)` in `staticDescribe("SidebarBrandContent", …)` with:

```tsx
    // UI.md: no letter-spacing; the stage badge keeps its capitals.
    expect(markup).not.toContain("tracking-");
    expect(markup).toContain("uppercase");
```

and add to `staticDescribe("Sidebar full render", () => {`:

```tsx
  it("renders the Projects label and Settings in the nav rows' type", () => {
    baseScenario();
    const markup = render(<Sidebar />);
    expect(markup).toContain('<span class="text-xs font-medium text-muted-foreground">Projects</span>');
    expect(markup).toContain('<span class="text-[13px] font-medium">Settings</span>');
    expect(markup).not.toContain("uppercase tracking-wider");
  });
```

In `apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx`, extend `it("uses the genuine empty copy only for an authoritative empty catalog", …)` with:

```tsx
    // UI.md: muted text uses the solid token, never an alpha-reduced one.
    expect(render("empty-confirmed")).not.toContain("text-muted-foreground/");
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar/sidebarTypography.test.ts src/components/Sidebar.test.tsx src/components/sidebar/SidebarProjectAvailability.test.tsx`
Expected: FAIL — the guard lists `tracking-tight`, `tracking-[0.12em]` and `tracking-wider` in `Sidebar.tsx`; `text-[10px]` and `tracking-wide` in `EnvironmentRail.tsx`; `text-[9px]`, `text-[8px]`, `text-[11px]` and `tracking-wide` in `WorktreeDiscoverySection.tsx`; `text-[11px]` in `WorktreeAvailabilityWarning.tsx`. The brand, Projects/Settings and availability tests fail on the old classes. The imported-provider guard below passes after Task 14; the project-gap assertion fails before the spacing edit. Every other guarded file passes.

- [ ] **Step 3: Sweep `Sidebar.tsx`**

- Projects label: replace `<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">` with `<span className="text-xs font-medium text-muted-foreground">` (`Main.dc.html`: 12 px, 500, muted, sentence case).
- Settings: replace

```tsx
            className="gap-2 px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
```

  with

```tsx
            className="gap-2 px-2 py-1.5 text-foreground/80 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-4 text-foreground/60" aria-hidden />
            <span className="text-[13px] font-medium">Settings</span>
```

  (the Agents row's treatment; `UI.md:172` puts navigation rows at 13 px medium on `text-foreground/80`).
- Brand: in `SidebarBrandContent`, replace `<span className="truncate text-sm font-semibold tracking-tight text-foreground">` with `<span className="truncate text-sm font-semibold text-foreground">`, and in the stage badge replace ` uppercase tracking-[0.12em] text-muted-foreground">` with ` uppercase text-muted-foreground">` (ruling 15).

In `SidebarProjectsContent`, change only the two project list menus (current anchors: the `<SidebarMenu>` wrapping `<SortableContext>` near line 4060, and `<SidebarMenu ref={attachProjectListAutoAnimateRef}>` near line 4100). Their complete opening tags become:

```tsx
<SidebarMenu className="gap-1.5" data-testid="sidebar-project-list">
<SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-1.5" data-testid="sidebar-project-list">
```

The shared sidebar primitive defaults to `gap-1`; these caller classes override it to 6 px. Keep the other SidebarMenu instances unchanged. Task 22 checks computed rowGap.

- [ ] **Step 4: Sweep the other files**

`apps/web/src/components/sidebar/EnvironmentRail.tsx`: replace `"flex size-[26px] items-center justify-center rounded-lg text-[10px] font-semibold tracking-wide",` with `"flex size-[26px] items-center justify-center rounded-lg text-xs font-semibold",`.

`apps/web/src/components/WorktreeDiscoverySection.tsx`: twelve class strings change, two pairs of them identical, so apply one mechanical edit and check its size:

```bash
cd /work/workspaces/orca/BibCode/main-3/apps/web/src/components && PATTERN='text-\[(8|9|11)px\]|uppercase tracking-wide|muted-foreground/65"|leading-3' && grep -cE "$PATTERN" WorktreeDiscoverySection.tsx && sed -i -e 's/text-\[\(8\|9\|11\)px\]/text-xs/g' -e 's/ text-muted-foreground\/65"/ text-muted-foreground"/' -e 's/ uppercase tracking-wide / /' -e 's/text-xs leading-3 /text-xs /' WorktreeDiscoverySection.tsx && grep -cE "$PATTERN" WorktreeDiscoverySection.tsx
```

Expected: `12` before and `0` after (`grep -c` exits 1 on the second count; that is the success case). The counts don't depend on `HEAD`: Task 7 already changed this file, so `git diff --numstat` against `HEAD` would show more than these twelve lines. It turns every `text-[8px]`, `text-[9px]` and `text-[11px]` into `text-xs`, drops `/65` from line ~182's muted text, drops `uppercase tracking-wide` from line ~200's badge and drops `leading-3` from line ~436's paragraph (a 12 px line inside a 12 px leading would clip). `bg-background/65` on line ~447 is a surface tint and stays. (Planned on a scratch copy of the file on 2026-09-24: exactly these twelve lines changed.)

`apps/web/src/components/sidebar/SidebarProjectAvailability.tsx`: replace `<div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">` with `<div className="px-2 pt-4 text-center text-xs text-muted-foreground">`.

`apps/web/src/components/WorktreeAvailabilityWarning.tsx`: replace `<dd className="break-all font-mono text-[11px]">{status.path}</dd>` with `<dd className="break-all font-mono text-xs">{status.path}</dd>`.

- [ ] **Step 5: Run the tests, typecheck and check**

Run: `cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run src/components/sidebar src/components/Sidebar.test.tsx src/components/WorktreeDiscoverySection.test.tsx src/components/WorktreeAvailabilityWarning.test.tsx`
Expected: PASS.

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp fmt apps/web/src/components/sidebar/sidebarTypography.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/EnvironmentRail.tsx apps/web/src/components/WorktreeDiscoverySection.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.tsx && vp run --filter @bibcode/web typecheck && vp check`
Expected: exit 0 for this task's files.

- [ ] **Step 6: Review**

`vercel-react-best-practices`: class-string changes only. `UI.md`: 12 px floor, no letter-spacing, solid muted text, navigation rows 13 px medium; the rail's two-letter avatar still fits its 26 px tile at 12 px. Record both.

- [ ] **Step 7: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- apps/web/src/components/sidebar/sidebarTypography.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/EnvironmentRail.tsx apps/web/src/components/WorktreeDiscoverySection.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.tsx`.

## Task 22: Step 3 docs, live verification and teardown

**Host-only execution:** the controller runs the live checks and teardown on the host. Codex prepares the code/scripts; its sandbox blocks loopback and it must not start browsers or servers. Record unavailable host evidence without claiming a pass.

**Files:**
- Modify: `docs/reference/encyclopedia.md` (lines ~11, 18–27, 46–55)
- Modify: `docs/user/keybindings.md` (lines ~103, 108)
- Modify: `docs/architecture/worktree-catalog.md` (line ~29)
- Modify: `docs/testing/cross-platform-validation.md` (one bullet after Task 18's)
- Review, no edit expected: `UI.md:176`
- Create (scratch): `$S/leftpanel-live/step3-typography.mjs`

**Interfaces:**
- Consumes: Tasks 20–21, and the Task 9 server with the Task 19 patcher.
- Produces: the living glossary in card terms, `$L/logs/step3-<theme>.json`, `$L/shots/step3-*.png`, and a stopped dev server.

- [ ] **Step 1: Encyclopedia**

In `docs/reference/encyclopedia.md`:

- Replace `workspace root and owns the visible primary/worktree rows in the left panel.` with `workspace root and owns the visible primary and worktree cards in the left panel.`
- Replace the entry

```markdown
### Primary Workspace Row

The left-panel row for a project's live checkout. It is backed by the project's
default thread, shows the live checkout branch, and cannot be deleted as a
normal thread.
```

  with

```markdown
### Primary Workspace Card

The left-panel card for a project's live checkout. It is backed by the project's
default thread, is titled with the live checkout branch, and cannot be deleted
as a normal thread.
```

  (no document links to the old `#primary-workspace-row` anchor; checked on 2026-09-24).
- Replace `The undeletable thread that backs a project primary row. Removing it is modeled` with `The undeletable thread that backs a project's primary card. Removing it is modeled`.
- Replace `transcript. They appear as center-panel tabs, not left-panel rows.` with `transcript. They appear as center-panel tabs, not left-panel cards; the host's card counts them as **N more chats**.`
- Replace the Left Panel paragraph

```markdown
The navigator for Search, the cross-environment Agents nav row, and
environment-scoped project/worktree rows. The Agents row's unread badge
aggregates across environments, and selecting it opens the full-screen Agents
view. The panel also shows project groups, primary rows, worktree rows,
pin/unread state, context menus, and running agent sub-rows.
```

  with

```markdown
The navigator for Search, the cross-environment Agents nav row, and
environment-scoped projects with their workspace cards. The Agents row's unread
badge aggregates across environments and is hidden when nothing is unread;
selecting the row opens the full-screen Agents view. The panel also shows
project groups, the primary card and worktree cards, pin/unread state, and
grouped context menus.

### Workspace Card

One checkout in the left panel: the primary card for the live checkout or a
worktree card. The shape of its status glyph carries the thread's state; its
second line shows the branch, the pull or merge request, uncommitted changes
and a running terminal; its third line shows the provider, what the agent is
doing, the model and how long ago.
```

- [ ] **Step 2: Keybindings and the worktree catalog**

In `docs/user/keybindings.md`, replace `jump through visible left-panel workspace rows` with `jump through visible left-panel workspace cards`, and `jump to a visible left-panel workspace row` with `jump to a visible left-panel workspace card`.

In `docs/architecture/worktree-catalog.md`, replace `the repository when they finish, so sidebar worktree rows follow a checkout` with `the repository when they finish, so sidebar worktree cards follow a checkout`.

- [ ] **Step 3: Runbook**

In `docs/testing/cross-platform-validation.md`, insert after the workspace-cards bullet Task 18 wrote (it ends `expanded project with discovery; and keyboard operation of the in-app menu;`):

```markdown
- the left panel after the typography sweep: an expanded project without
  worktrees shows only its primary card; a saved server's project headers show
  no cloud icon, while a WSL project under **Local** keeps its container icon;
  the **Projects** label is sentence case; **Settings** matches the nav rows;
  and no left-panel text is smaller than the cards' 12 px lines or letter-spaced
  (the stage badge stays uppercase);
```

`docs/testing/linux-desktop.md`, `macos-desktop.md`, `windows-desktop.md`, `README.md` and `execution-report-template.md`: reviewed; step 3 adds no platform-specific behaviour, so they remain accurate. Say so in the report.

- [ ] **Step 4: `UI.md:176`**

Read `UI.md:176` ("Screens outside the sidebar, Agents view, and chat timeline predate these rules and are being swept"). With the step 3 sweep, the guard from Task 21 and the live assertion below, the sentence is now true for the sidebar, so it needs no edit (the spec: "false until step 3, which makes it true"). Record "reviewed; now accurate".

- [ ] **Step 5: Verify the docs**

Run: `cd /work/workspaces/orca/BibCode/main-3 && rg -n -i "primary row|worktree row|workspace row|agent sub-row|primary/worktree" docs --glob '!docs/plans/**' --glob '!docs/superpowers/**' --glob '!docs/testing/reports/**'`
Expected: exactly one line, `docs/user/workspace-ui.md` "they are primary row content" (the chat timeline, unrelated).

Run: `cd /work/workspaces/orca/BibCode/main-3 && vp fmt docs/reference/encyclopedia.md docs/user/keybindings.md docs/architecture/worktree-catalog.md docs/testing/cross-platform-validation.md && vp check`
Expected: exit 0.

- [ ] **Step 6: Write the step-3 live check**

Create `$S/leftpanel-live/step3-typography.mjs`:

```js
// Step 3 live check: the removed chrome is gone, the labels use the nav rows'
// type, no left-panel text is below 12 px or letter-spaced, and final
// screenshots for the mockup comparison.
import { readFileSync, writeFileSync } from "node:fs";
import { L, SERVER, launch, origin } from "./lib.mjs";
import { createFramePatcher } from "./patch-frames.mjs";

const dark = process.env.DARK === "1";
const theme = dark ? "dark" : "light";
const fixture = JSON.parse(readFileSync(`${L}/fixture.json`, "utf8"));
const failures = [];
const results = {};
const check = (name, condition, detail) => {
  results[name] = { pass: Boolean(condition), detail };
  if (!condition) failures.push(name);
};

const { context, page } = await launch({ dark });
// Typography variant: exercise the real imported icon's unknown-provider initials.
const patcher = createFramePatcher({ projectIds: fixture.projectIds, unknownProvider: true });
await page.routeWebSocket(
  (url) => url.port === String(SERVER) && url.pathname === "/ws",
  (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") patcher.fromPage(message);
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(typeof message === "string" ? patcher.fromServer(message) : message);
    });
  },
);
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="sidebar-projects-group"]', { timeout: 60_000 });
await page.waitForTimeout(3_000);
const card = (title) => page.locator('[data-testid^="thread-row-"]', { hasText: title }).first();

// 1. An expanded project without worktrees shows only its primary card.
const bridges = page.locator('button[data-sidebar="menu-button"]', { hasText: "agent-bridges" });
if ((await bridges.getAttribute("aria-expanded")) !== "true") await bridges.click();
await page.waitForTimeout(500);
check("No threads yet is gone", (await page.getByText("No threads yet").count()) === 0);
check(
  "agent-bridges shows its primary card",
  (await page.locator(`[data-testid="primary-card-${fixture.projectIds["agent-bridges"]}"]`).count()) === 1,
);
await bridges.click();

// 2. The Task 19 state: "Fix invoice date format" active, "Upgrade PDF renderer"
// unread (the card clicks also clear the header selection from step 1).
await card("Upgrade PDF renderer").click();
await page.waitForTimeout(1_000);
await card("Fix invoice date format").click();
await page.waitForTimeout(1_000);
await card("Upgrade PDF renderer").click({ button: "right" });
await page.waitForSelector('[role="menu"]');
const markUnread = page.locator('[role="menuitem"]', { hasText: "Mark as Unread" });
if ((await markUnread.count()) > 0) await markUnread.first().click();
else await page.keyboard.press("Escape");
await page.mouse.move(1_000, 500);
await page.waitForTimeout(500);

// 3. Labels.
const projectsLabel = page.locator('[data-testid="sidebar-projects-group"] span', { hasText: /^Projects$/ }).first();
check("Projects label is sentence case", (await projectsLabel.evaluate((element) => getComputedStyle(element).textTransform)) === "none");
const settingsLabel = page.locator('[data-sidebar="footer"] button span', { hasText: /^Settings$/ }).first();
const settingsStyle = await settingsLabel.evaluate((element) => ({
  size: getComputedStyle(element).fontSize,
  weight: getComputedStyle(element).fontWeight,
}));
check("Settings is 13 px medium", settingsStyle.size === "13px" && settingsStyle.weight === "500", settingsStyle);

const projectGaps = await page.$$eval('[data-testid="sidebar-project-list"]', (lists) =>
  lists.map((list) => getComputedStyle(list).rowGap),
);
check("6 px between projects", projectGaps.length > 0 && projectGaps.every((gap) => gap === "6px"), projectGaps);
const initials = page.locator(".workspace-card-provider-icon span", { hasText: /^CP$/ });
check("unknown-provider initials present", (await initials.count()) > 0);
const initialsSizes = await initials.evaluateAll((elements) =>
  elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
);
check("imported provider initials at least 12 px", initialsSizes.length > 0 && initialsSizes.every((size) => size >= 12), initialsSizes);

// 4. The whole left panel: nothing visible below 12 px or letter-spaced.
const offenders = await page.$$eval('[data-slot="sidebar-container"] *', (elements) =>
  elements
    .filter((element) => element.getClientRects().length > 0)
    .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim() !== ""))
    .map((element) => {
      const style = getComputedStyle(element);
      return { text: element.textContent.trim().slice(0, 40), size: Number.parseFloat(style.fontSize), spacing: style.letterSpacing };
    })
    .filter((entry) => entry.size < 12 || (entry.spacing !== "normal" && entry.spacing !== "0px")),
);
check("no left-panel text below 12 px or letter-spaced", offenders.length === 0, offenders);

// 5. Final screenshots for the comparison with mockup-main-<theme>.png.
await page.screenshot({ path: `${L}/shots/step3-${theme}-sidebar.png`, clip: { x: 0, y: 0, width: 422, height: 980 } });
await card("Search index rebuild").hover();
await page.screenshot({ path: `${L}/shots/step3-${theme}-sidebar-hover.png`, clip: { x: 0, y: 0, width: 422, height: 980 } });
await page.mouse.move(1_000, 500);

// 6. The Agents badge shows while something is unread and disappears once every
// unread card has been opened.
const agents = page.locator('[data-testid="agents-nav-row"]');
check("Agents badge shows while a card is unread", (await agents.textContent())?.trim() !== "Agents", await agents.textContent());
const unreadTitles = page.locator('[data-thread-item] [data-unread="true"]');
for (let opened = 0; opened < 10 && (await unreadTitles.count()) > 0; opened += 1) {
  await unreadTitles.first().click();
  await page.waitForTimeout(800);
}
check("Agents badge hidden at 0", (await agents.textContent())?.trim() === "Agents", await agents.textContent());

writeFileSync(`${L}/logs/step3-${theme}.json`, JSON.stringify(results, null, 2));
console.log(`step3 ${theme}: ${failures.length === 0 ? "PASS" : `FAIL ${failures.join(", ")}`}`);
await context.close();
process.exit(failures.length === 0 ? 0 : 1);
```

The Task 22 typography variant uses "Custom Provider" initials on the plan card; record that intentional fixture difference in the comparison. All imported icon descendants stay included in the whole-sidebar computed-style scan.

The header cloud can't be checked live (the dev server has no saved server); the Task 20 tests cover it.

- [ ] **Step 7: Run it in light and dark, and compare**

```bash
cd $L && L=$L DARK=0 node step3-typography.mjs; L=$L DARK=1 node step3-typography.mjs
```

Expected: `step3 light: PASS` and `step3 dark: PASS`. Open (Read) `step3-light-sidebar-hover.png` beside `mockup-main-light.png`, and `step3-dark-sidebar-hover.png` beside `mockup-main-dark.png`, and record a verdict per region in the ledger: rail, brand row, Search/Agents (badge "1" in both), Projects label, the four projects and their cards, the hidden-worktree line, Settings. The differences Task 19 lists as allowed stay allowed; the live run also shows the "Queue migration plan" card, which the mockup's docker-manager project doesn't have.

- [ ] **Step 8: Stop the dev server**

On the host, stop only the identities recorded from inside this plan's children: the required terminal fixture PID for each theme, then the dev runner's PGID. Inspect the saved identity and command before signalling; if an exited PID was reused, record it and do not signal the replacement. Never use a name-pattern kill.

```bash
set -e
for theme in light dark; do
  record="$L/logs/terminal-$theme.pid"
  if test -s "$record"; then
    terminal_pid=$(cat "$record")
    case "$terminal_pid" in ''|*[!0-9]*) printf 'Invalid terminal PID record\n' >&2; exit 1;; esac
    if kill -0 "$terminal_pid" 2>/dev/null; then
      ps -o pid=,pgid=,args= -p "$terminal_pid"
      test "$(ps -o args= -p "$terminal_pid")" = "sleep 900" || exit 1
      kill -TERM -- "$terminal_pid"
    fi
  fi
done
dev_pgid=$(cat "$L/logs/dev.pgid")
case "$dev_pgid" in ''|*[!0-9]*) printf 'Invalid dev PGID record\n' >&2; exit 1;; esac
ps -o pid=,pgid=,sid=,args= -p "$dev_pgid"
test "$(ps -o pgid= -p "$dev_pgid" | tr -d ' ')" = "$dev_pgid"
kill -TERM -- -"$(cat "$L/logs/dev.pgid")"
```

Wait (Monitor tool, until-loop) until `ss -ltn '( sport = :13930 or sport = :5890 )'` prints only its header line, then delete the saved token: `rm -f $L/.token`. Keep `$L/shots` and `$L/logs`: they are the evidence the report cites.

- [ ] **Step 9: Checkpoint (no commit)**

```bash
cd /work/workspaces/orca/BibCode/main-3 && IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
```

Review package: `git diff <previous-tree> <tree> -- docs/reference/encyclopedia.md docs/user/keybindings.md docs/architecture/worktree-catalog.md docs/testing/cross-platform-validation.md`.

---

# Finish

Run after Task 22, in this order. Record every command and its result in the ledger.

- [ ] **Step 1: Full gates**

Run each from the directory shown; each must exit 0:

```bash
cd /work/workspaces/orca/BibCode/main-3 && vp check
cd /work/workspaces/orca/BibCode/main-3 && vp run typecheck
cd /work/workspaces/orca/BibCode/main-3/apps/web && vp test run
cd /work/workspaces/orca/BibCode/main-3 && vp test run packages/contracts packages/shared apps/desktop/e2e/support
cd /work/workspaces/orca/BibCode/main-3 && cargo fmt --all --check
cd /work/workspaces/orca/BibCode/main-3 && cargo clippy -p bibcode-desktop --all-targets -- -D warnings
cd /work/workspaces/orca/BibCode/main-3 && vp run test:desktop
```

A failure in a file this plan doesn't list is recorded with its output and attributed (track A, batch 1 or another agent), not fixed. Classify flakes as the Global Constraints say: a focused re-run, and a base-versus-change comparison when cheap.

- [ ] **Step 2: Contract fixtures (ruling 22)**

Run `cd /work/workspaces/orca/BibCode/main-3 && git status --short packages/contracts`. If it lists only `packages/contracts/src/ipc.ts` and `ipc.test.ts`, run `vp run check:contracts` and expect exit 0 with no fixture diff. Otherwise don't run it; record "`check:contracts` deferred to the controller: other agents' contract edits are in flight", with the status output.

- [ ] **Step 3: Packaged e2e (optional locally)**

`vp run test:ui:desktop:build && vp run test:ui:desktop` runs the WebdriverIO suite that Task 17 touched; on Linux under Xvfb use `WAYLAND_DISPLAY=bibcode-no-wayland xvfb-run -a vp run test:ui:desktop`. CI's `desktop-ui-smoke.yml` runs it too. If it isn't run locally, say so: Task 17's contract test and Task 19's live XPath check are the local evidence.

- [ ] **Step 4: Live evidence**

These checks run on the host by the controller because Codex sandbox loopback is blocked. Confirm the ledger holds actual `step1 light/dark: PASS` (Task 9), `step2 light/dark: PASS` with the crop verdict table (Task 19), `step3 light/dark: PASS` with the final comparison (Task 22), the screenshot and JSON paths, the required terminal fixture results and per-shell patch counts, the recorded child PID/PGID evidence, and the port check after teardown. Missing crops or terminal state are failures, not passes. Remote-cloud and WSL card behaviour are covered by unit tests only; these local live fixtures do not establish their native behaviour.

- [ ] **Step 5: Review on two axes**

Take and record a final checkpoint before reviews, using the Execution protocol command. If fixes follow, record a new final tree and review the updated delta.

Run the `code-review` skill (`/code-review`) over the recorded baseline and final trees, `git diff <baseline-tree> <final-tree> -- <every file in the File structure table>`, because the working tree also holds other tracks' changes. Axis 1, spec compliance: every spec requirement and ruling is implemented, nothing beyond them. Axis 2, code quality: correctness under reconnects and stale data, React rules (`vercel-react-best-practices`), `UI.md`, and tests that test behaviour. Fix each valid finding with a test and re-run the affected gates.

- [ ] **Step 6: Codex review**

Codex is available. Generate the scoped review patch from the ledger's actual baseline/final tree hashes, then ask Codex to review that patch against the spec and controller rulings. The companion's native `review --scope working-tree` would include pre-existing shared edits, so use its read-only task interface with an explicit prompt file:

```bash
git diff <baseline-tree> <final-tree> -- <every file in the File structure table> > "$S/leftpanel-review.patch"
cat > "$S/leftpanel-review.md" <<'REVIEW'
Review the patch at /tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad/leftpanel-review.patch.
Read the common rules at /tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad/codex/codex-common.md first.
Use docs/superpowers/specs/2026-09-24-left-panel-workspace-cards-design.md and the implementation plan's Controller rulings (2026-09-24) as the requirements. Inspect current source to verify each finding. Review correctness, lifecycle, React and UI.md compliance and behavioural tests. Limit findings to the baseline-to-final patch; leave other agents' work alone. Read-only review: do not edit, start servers/browsers, commit or contact real remotes.
REVIEW
node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs task --background --prompt-file "$S/leftpanel-review.md"
```

Substitute the recorded hashes and exact file paths in the diff command before running it. Expected: the patch contains only the recorded scoped delta, and the companion prints a job id. Poll `node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs status <job-id>` through the controller, then read `node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs result <job-id>`. Verify each finding against source; fix valid findings with tests and rerun affected gates. Record the review result and every disposition. A launch error is a reported blocker, never a silent review substitution.

- [ ] **Step 7: Final diff review**

Take a final checkpoint (the command above) and run:

```bash
cd /work/workspaces/orca/BibCode/main-3 && git status --short && git diff --stat <baseline-tree> <final-tree>
```

The stat lists everything that changed since the plan started, other agents' work included. Every path this plan touched must be in the File structure table (the per-task review packages in the ledger show which ones those are); any other changed path belongs to another agent and is left alone. In this plan's files, check that nothing else crept in: debug output (`console.log`, `debugger`), focused tests (`.only`), generated files, lockfile or dependency drift, or a missed doc. `.codegraph/` data is never staged or edited.

- [ ] **Step 8: Hand back**

Report to the controller: the ledger path; every checkpoint tree hash and the final one; each gate command with its result; the live results and screenshot paths; both reviews' outcomes; what was deferred (`check:contracts`, packaged e2e, or a specifically reported Codex launch failure); the runbooks that were "reviewed and remain accurate"; and the residual risk:

- Native menus aren't driven by Playwright; the Rust tests and the Linux/macOS runbook items cover them.
- Whether a webview also dispatches `contextmenu` for Shift+F10 differs between WebKitGTK, WKWebView and WebView2; the 1,000 ms echo guard handles both cases, but each platform's runbook check confirms it.
- "N more chats" counts panel chats on the client until the server links chats to their host thread (the spec's `hostThreadId` follow-up).
- The live approval, question, plan and failed states come from patched frames, not provider runs.
- Remote-cloud and WSL card behaviour are unit-test evidence only; native/live validation for those environments is not claimed.
- Tasks 9, 19 and 22 ran on the host by the controller. List required fixture/crop failures explicitly, and attach recorded terminal PIDs/dev PGID plus teardown results.

Don't commit; the controller asks the user.

---

## Self-review

**Spec coverage.**

| Spec area | Tasks |
| --- | --- |
| Menu contract and separators in both renderers | 1, 2, 3 |
| Fallback menu roles, focus and keys | 4 |
| Regrouping, Title Case, Pull, Copy Branch Name, "(N)" counts, Delete Thread ellipsis, grouped submenus | 5, 6 |
| ⋯ replaces the placeholder, `+` for New worktree, motion-guard anchor, hidden-worktree count | 7 |
| Card anatomy (lines 1–3), glyph table, errored-turn fix, interrupted and uncertain cases, reduced motion | 10, 11, 12, 14, 15 |
| Primary card, merged memoised list, collapsed and Show-more glyphs, "N more chats" | 12, 16 |
| Minute clock and `<RelativeAge>` | 13 |
| Accessibility: one button per card, names and descriptions, Shift+F10 and the Menu key, echo guard | 12, 14, 15 |
| Data and performance: memo comparator, O(1) per card, chat summaries once per project, one clock | 12, 13, 15, 16 |
| Removals: "No threads yet", the Agents badge at 0, the header and card cloud | 15 (card), 20 |
| Typography: labels, rename input, jump label, the sweep | 10, 15, 21 |
| Breaking tests and selectors: `Sidebar.test.tsx` lines, motion guard, packaged XPaths | 6, 7, 15, 16, 17, 20 |
| Visual: Playwright at 422 px, light and dark, crops against the mockup, the font floor | 9, 19, 22 |
| Living docs and runbooks | 8, 18, 20, 22 |
| Reviews and gates | every task, Finish |

**Placeholder scan.** The plan was searched for "TBD", "TODO", "implement later", "fill in", "similar to Task" and "appropriate error handling"; none remain. Every code step shows its code, and every command has its expected output.

**Name consistency.** Checked across tasks: `ContextMenuEntry` and `ContextMenuSeparator` (1–4), `normalizeContextMenuEntries` (3), `contextMenuAnchorForRect` (7, 15, 16), `SidebarMenuEntry` and the `build*Menu` builders (5–7), `resolveWorkspaceCardStatus`, `WORKSPACE_CARD_STATUS`, `pickMoreUrgentWorkspaceCardStatus` and `resolveHighestWorkspaceCardStatus` (11, 12, 16), `workspaceCheckoutKey` and `summarizeWorkspaceChats` (12, 16), `KEYBOARD_CONTEXT_MENU_ECHO_MS` and `markKeyboardContextMenuOpened` (4, 12, 15, 16), `isContextMenuShortcut` and `isKeyboardContextMenuEcho` (12, 15, 16), `useMinuteClock` and `RelativeAge` (13, 14), `workspaceCardIds` and `WorkspaceCardShell` (14–16), and the test ids `thread-row-<id>`, `thread-card-button-<id>`, `primary-card-<project.id>`, `primary-card-button-<project.id>`, `project-actions-button` and `sidebar-projects-group` (7, 9, 15–17, 19, 22).
