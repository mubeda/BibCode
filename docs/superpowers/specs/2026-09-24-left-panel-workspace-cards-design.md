# Left panel: workspace cards and context menus

Status: **Approved by the user on 2026-09-24** (the recommended option on every ruling listed below).

Input: `docs/plans/left-panel/orca-left-panel-research.md` ("research") §3–§4, and the approved mockup
(published privately at <https://claude.ai/artifact/8Z4gc1jVqAAPPYDWVRZbqr>). The mockup's sources are
`Main.dc.html` (its `dark` prop gives the dark theme), `Today.dc.html`, `Anatomy.dc.html`,
`States.dc.html` and `Menus.dc.html`. Its sizes, colours, glyphs and copy are binding unless `UI.md` or
an existing token says otherwise; the deviations are listed below.

Code lines refer to `fd5effbb`. Batch 1 has uncommitted edits in `Sidebar.tsx` (+5 lines after line 300),
`ui/sidebar.tsx` (+13) and `AppSidebarLayout.tsx`, so re-read those files before implementing.
Lines in `docs/user/workspace-ui.md` (HEAD + 2 after line 14) and `docs/testing/` are working-tree lines,
because other agents have uncommitted edits there too. Bare component names are under
`apps/web/src/components/`.

## Problem and evidence

- **One line per item.** The primary row (`Sidebar.tsx:1306-1381`) and the thread rows (`560-1249`) are
  24–28 px lines: a 6 px dot, a 10 px status label, a 12 px title and a 10 px branch label. Most of the
  370 px panel stays empty (research §3.3–3.4).
- **Status is a coloured dot, and sometimes the wrong one.** `hasUnseenCompletion`
  (`Sidebar.logic.ts:240-249`) checks only `completedAt`. The server also sets that on errored turns
  (`apps/server/src/orchestration/engine.rs:5946-5953`), so a failure shows as green "Completed". The
  primary row omits `lastVisitedAt` (`Sidebar.tsx:1327`), so it never shows "Completed" at all.
- **Menus are flat.** Native menus get one automatic separator, before the first destructive item
  (`apps/desktop/src-tauri/src/context_menu.rs:195-203`); the web fallback gets none. "Update" runs
  `git pull` (`Sidebar.tsx:1588-1596`), and project actions are reachable only by right-click
  (`2261-2283`).
- **Keyboard gaps.** The primary row is an `<a>` with no `href` or `tabIndex` (`ui/sidebar.tsx:994-1024`,
  `Sidebar.tsx:1349-1355`), so Tab skips it. The web fallback menu handles only Escape: no arrow keys, no
  initial focus, and submenus that open only on hover (`apps/web/src/contextMenuFallback.ts:131-136`,
  `252-267`). Windows desktop always uses this fallback (`apps/web/src/tauriDesktopBridge.ts:434-444`).
- **UI.md violations** (research §3.8; re-checked at the lines under "Removals and typography"): text
  below 12 px, alpha-reduced muted text, 12 px thread titles, and letter-spacing.

## Decisions (made by the user)

1. **Cards replace the primary and thread rows.** Line 1: the status glyph, the title (semibold when
   unread), a "primary" chip, the pin and hover actions. Line 2: the branch, the PR/MR number, a dirty
   dot, and terminal and ports icons. Line 3: the session.
2. **Other chats in the worktree** show as an "N more chats" row. Nesting each chat needs `hostThreadId`
   on the thread shell, so it is a follow-up.
3. **No Orca-only extras:** no status columns, groups, parent worktrees, sleep or project icons.
4. **Density stays as today:** 6 visible threads (`packages/contracts/src/settings.ts:60`), collapsible
   projects, and no auto-collapse.
5. **Keep** the environment rail and context card; the project tree and its guide line
   (`ui/sidebar.tsx:968-974`); the hover strip, minus its invisible placeholder; native desktop menus;
   and discovery, pinned-first ordering, ⌘ jump hints, inline rename and the archive confirm.
6. **Menus:** **Update** becomes **Pull**. Add **Copy Branch Name**, separators (a change to contracts,
   desktop and web), and a visible **⋯** on project headers. Group the items as in `Menus.dc.html`.
7. **Removals:** "No threads yet", the Agents badge at 0, the uppercase "Projects" and the redundant
   cloud icon go. Settings becomes 13 px medium. Sweep the §3.8 typography, except the environment card
   and update badge, which batch 1 owns.
8. **Project names stay 13 px medium** on `text-foreground/90` (`UI.md:172`).
9. **Width:** batch 1 owns the 422 px first-launch width and its fit to narrow windows
   (`AppSidebarLayout.tsx`). This design assumes them.

## Card anatomy (`Main.dc.html`, `Anatomy.dc.html`)

| Part | Mockup | Implementation |
| --- | --- | --- |
| Surface | 6×8 padding, 8 px radius, 1 px border, 8 px gap; 2 px between cards, 6 px between projects | `flex gap-2 px-2 py-1.5 rounded-md border border-transparent`. `--radius` is 10 px, so 8 px is `rounded-md` (`index.css:80-83`) |
| Status column | 16×20 slot; 14 px glyph icons; 10 px dots | `w-4 h-5`, centred; see the status table |
| Line 1 (20 px) | 13 px title, chip, pin, spacer, hover actions | Title `text-[13px] text-foreground/80`; when unread, `font-semibold text-foreground`. Chip `text-xs`, bordered, `bg-muted`. Hover or focus shows Archive/Confirm (`Sidebar.tsx:1069-1119`; never while running, never on the primary card). The ⌘ jump label replaces them while the modifier key is held |
| Line 2 (18 px) | 12 px muted: branch icon and branch, then PR `!57`, a 6 px dirty dot, the terminal icon | Shown when there is a branch or any indicator. The branch text is hidden when it equals the title; the indicators stay at the right end. The PR number is a button (`openPrLink`) coloured by `prStatusIndicator` (`ThreadStatusIndicators.tsx:37-69`). The terminal icon is muted and static (today it is teal and pulsing, `98-109`). The ports `Globe2Icon` button stays (`Sidebar.tsx:1028-1047`) |
| Line 3 (22 px) | 12 px muted: provider icon, preview, 12 px mono model (at most 112 px), age | `ProviderInstanceIcon` without a badge (as in `agents/AgentsRow.tsx:85-93`); preview `truncate flex-1`; model `font-mono max-w-28 truncate`; age via `<RelativeAge>` |
| More chats (20 px) | "2 more chats" with a chevron | Static text without the chevron, plus the highest-priority glyph among those chats |
| States (`States.dc.html`) | Hover 2.5 %; active 5.5 % with a border; 2 px orange focus ring | Hover `bg-accent/60`. Active `bg-accent border-border`, without today's `font-medium`. Multi-select keeps today's primary tint (`Sidebar.logic.ts:421-433`). Focus `ring-2 ring-ring` on the card (`--ring` is `#d8610e`, `index.css:259`) |

Cards are about 52 px tall with two lines and 80 px with three. The title is the thread title, or the live
branch on the primary card (`Sidebar.tsx:1321-1326`). The branch is the fresh summary's `refName`, else
its `detachedHead`, else `thread.branch`; its tooltip names the worktree path, as `ThreadWorktreeIndicator`
does today (`ThreadStatusIndicators.tsx:117-149`). Worktree cards keep the `resolveThreadPr` branch guard
(`75-96`). The primary card reads `pr` and `hasWorkingTreeChanges` straight from the fresh summary,
because the default thread's `branch` is always `null` (`Sidebar.tsx:1302-1304`). Merge the two
`SidebarMenuSub` lists (`1426`, `3285`) so the guide line is continuous, as in the mockup. Render the
primary card as the first item inside the memoised `SidebarProjectThreadList`, so that component
stays memoised.

## Status glyphs (`States.dc.html`)

Add `resolveWorkspaceCardStatus(thread, lastVisitedAt)` to `Sidebar.logic.ts`, wrapping
`resolveThreadStatusPill` (`445-510`). Don't widen the `ThreadStatusPill` union: the Agents view groups on
its labels (`sidebar/agentsSection.logic.ts:52-65`). Rows are in priority order; the first match wins.

| Glyph (lucide) | Accessible name | Condition | Pill today (priority) | Colour |
| --- | --- | --- | --- | --- |
| Hand | Needs approval | `hasPendingApprovals` | Pending Approval (5) | pill `colorClass` (amber) |
| CircleHelp | Waiting for your answer | `hasPendingUserInput` | Awaiting Input (4) | pill (indigo) |
| LoaderCircle (spinning) | Working / Connecting | `session.status` is running / starting | Working, Connecting (3) | pill (sky) |
| TriangleAlert | Failed | `session.status === "error"`; or `unresolvedDelivery.state === "failed"`; or an unseen completion with `latestTurn.state === "error"` | none (today's red sub-rows, `Sidebar.tsx:1194-1246`) | `text-destructive` |
| ListChecks | Plan ready | the plan-ready pill | Plan Ready (2) | pill (violet) |
| Filled dot | Finished, not opened yet | an unseen completion whose turn did not error | Completed (1) | pill (emerald) |
| Hollow ring | Idle | anything else | null | `text-muted-foreground` |

- **Other states:** an `interrupted` turn maps as today, to "Finished, not opened yet" until opened and
  then "Idle". An `uncertain` delivery leaves the glyph unchanged; line 3 reports it. Under
  `prefers-reduced-motion` the spinner is static.
- **Never-visited threads:** these keep today's rule. With no recorded visit, a completion never
  counts as unseen (`Sidebar.logic.ts:244`), so a new device doesn't mark every old thread as
  "Finished". A turn that settles while the app is running still makes the card unread (bold) through
  `useAgentsUnread`.
- **Summary indicators:** the collapsed-project indicator and the Show-more hint (`1144-1164`, `1486`)
  switch to the same glyphs and priority, so the panel uses one status language. They are computed where
  `projectStatus` and `hiddenThreadStatus` are computed today (`1751-1794`, `1874-1882`).

## Data and performance (all client-side; no new requests)

- **Thread shell** (`packages/contracts/src/orchestration.ts:513-550`): title, `kind`, `branch`,
  `worktreePath`, session status and `providerName`, `modelSelection`, `latestTurn`, the pending flags,
  `unresolvedDelivery`, `conversationPreview` and timestamps. Unread comes from `unreadThreadKeys`
  (`sidebar/useAgentsUnread.ts:9-44`); pin is local metadata.
- **Subscriptions:** the card adds no RPC. Branch, dirty state and PR come from the per-row VCS summary
  (`packages/contracts/src/vcs.ts:62-116`; `Sidebar.tsx:654-666`, `1314-1319`), an `Atom.family` keyed
  by environment and cwd (`packages/client-runtime/src/state/vcs.ts:119-135`). Terminal and ports are
  shared per-environment atoms (`state/terminalSessions.ts:150-189`, `portDiscoveryState.ts:9-32`) that
  the primary card now reads too; the worktree catalog stays per project (`Sidebar.tsx:640-647`).
- **Preview:** the first of these that applies. (1) "Delivery failed" (`text-destructive`) or "Delivery
  uncertain" (`text-warning-foreground`). (2) `resolveAgentPreviewLine`
  (`sidebar/agentsSection.logic.ts:83-92`): the tool while working, else the latest assistant message,
  else the prompt. (3) The provider label (`resolveAgentProvider`, `67-81`). Today's "Running · 1h",
  "Failed" and delivery sub-rows fold into the glyph and line 3.
- **Model:** the catalog short name (`ServerProviderModel.shortName`, `packages/contracts/src/server.ts:61-68`,
  via `getTriggerDisplayModelName`, `chat/providerIconUtils.ts:52-54`), read from one memoised map per
  list built from the loaded server configs. Without a match, show the slug.
- **Age:** compact (`now`, `5m`, `3h`, `2d`, like `formatSessionDuration`, `Sidebar.logic.ts:681-697`),
  from `latestTurn.startedAt` while working, else `latestUserMessageAt ?? updatedAt ?? createdAt` as
  today (`Sidebar.tsx:1159-1161`). One app-level minute clock drives every age: an external store with
  one minute-aligned interval, running only while subscribed and also ticking on `visibilitychange`.
  Today's labels never refresh (`timestampFormat.ts:90-106`); don't reuse `useRelativeTimeTick`, a
  per-component 1 s timer (`settings/settingsLayout.tsx:9-12`).
- **"N more chats":** counts the unarchived `kind: "panel"` shells in the card's checkout. Panels copy
  their host's `worktree_path` (`apps/server/src/production/worktree_catalog_rpc.rs:1292-1293`), so
  worktree cards match on that path. Panels with no path run in the main checkout and count on the
  primary card; non-worktree cards show no count until `hostThreadId` exists. Derive the count in the
  per-project `useMemo`; `sidebarThreads` already holds panels (`Sidebar.logic.ts:643-651`).
- **Rendering:** rows are unchanged (one card per workspace thread plus the primary; 6 per project before
  Show more). Memoise cards on the shell reference and UI flags, as `agents/AgentsRow.tsx:28-42` does;
  only the `<RelativeAge>` leaf subscribes to the clock, so a tick re-renders no card. Per-card work is
  O(1); chat counts are O(threads) once per project.

## Menus (`Menus.dc.html`)

| Worktree card | Main checkout card | Project header (⋯ or right-click) |
| --- | --- | --- |
| Open in ›, Pull | Open in ›, Pull | New Worktree… |
| — Copy Path, Copy Branch Name, Copy Thread ID | — Copy Path, Copy Branch Name | — Rename…, Group into…, Copy Path |
| — Pin/Unpin, Mark as Unread/Read, Rename… | — Pin/Unpin, Mark as Unread/Read | — Show Hidden Worktrees (N) / Hide Discovered Worktrees, Archived Threads |
| — Delete Worktree… (destructive) | | — Remove Project… (destructive) |

- **Copy:** labels are Title Case. An ellipsis marks an item that opens a dialog or an inline edit: rename
  is inline, and Remove always confirms (`Sidebar.tsx:2027-2072`, `2115-2122`). A thread without a
  worktree shows "Delete Thread", with the ellipsis only when `confirmThreadDelete` is on (`2942`).
  Multi-select shows "Mark as Unread (N)" and "Delete (N)" (`2433-2437`). Pull keeps `vcs.pull`; its
  error toast reads "Failed to pull" (`2827`, `3050`).
- **Behaviour:** Copy Branch Name copies the branch shown on the card, and is omitted when there is none.
  "(N)" appears on an expanded project, once `WorktreeDiscoverySection` reports its count (`504-511`),
  lifted up without a new query. On a collapsed project the section isn't mounted (`3284-3293`), so the
  label omits the count rather than adding a subscription. Grouped projects keep their per-member
  submenus (`2228-2259`).
- **⋯ button:** the first button in the hover strip (`3214-3281`). It replaces the invisible "New
  main-branch chat" placeholder (`3215-3230`); also remove the placeholder's only callers,
  `handleCreateThreadClick` and `createMainChatForProjectMember` (`2495-2538`). New chats stay on
  `chat.new` and the command palette. The New worktree icon becomes `+`, as `docs/user/workspace-ui.md:61`
  already describes it. This supersedes `docs/superpowers/specs/2026-08-02-project-toolbar-actions-design.md`.
- **Contract:** add `ContextMenuSeparator = { separator: true }` and
  `ContextMenuEntry<T> = ContextMenuItem<T> | ContextMenuSeparator` (`packages/contracts/src/ipc.ts:115-149`);
  `children` and every `show` signature take entries. Rejected alternatives: a `separator` flag on items,
  which needs a fake `id` and `label` and widens `T`; and `separatorBefore`, which is lost when its item
  is omitted.
- **Renderers:** `context_menu.rs` reads `separator` before its `id`/`label` requirement (`248-249`) and
  appends `PredefinedMenuItem::separator`, which is already imported (`6`). The fallback renders
  `role="separator"` (`my-1 mx-1.5 h-px bg-border`). Each renderer first applies its own filtering (the
  native one drops headers and empty submenus, `243-260`). Then both trim leading and trailing
  separators, collapse runs, and skip the automatic destructive separator after an explicit one.

## Accessibility

- **Card:** each card is an `li` holding one `<button type="button">`. Today's rows are a
  `<div role="button">` (`Sidebar.tsx:941`), and the primary row is an `<a>` with no `href`. The
  button's accessible name is the status, the title, and visually hidden "unread"/"pinned" text; lines
  2–3 describe it, and it carries `aria-current` when active. The PR, ports and Archive buttons, and the
  inline rename input, are layered siblings, never nested inside it (a button cannot contain them).
- **Glyphs:** `role="img"` with the table's accessible name and a tooltip with the same text. Shape
  carries the meaning (`UI.md:208-210`).
- **Opening menus from the keyboard:** the card handles `keydown` for Shift+F10 and the ContextMenu key.
  It calls `preventDefault()` and opens the menu anchored to the card's rectangle; this is the primary
  path, because not every webview turns those keys into `contextmenu`, and WebKit's `contextmenu` is a
  `MouseEvent` without `pointerType`. Where a webview also dispatches `contextmenu` for those keys
  (Chromium, WebView2), ignore that event. The native builder refuses a second open menu
  (`context_menu.rs:67-69`), so a double open would surface as an error. Right-click and Ctrl-click keep
  the pointer position. ⋯ opens on Enter or Space.
- **Fallback menu:** `menu`, `menuitem` and `separator` roles, with `aria-haspopup`, `aria-expanded` and
  `aria-disabled`. Focus starts on the first enabled item. Arrow keys skip separators and disabled items;
  Home, End, Enter and Space work; ArrowRight and ArrowLeft open and close submenus; Escape closes the
  menu and returns focus.

## Removals and typography (step 3)

- **Remove** "No threads yet" (`Sidebar.tsx:1430-1439`, `1884`), since the primary card always renders
  with the list (`3294-3304`); the Agents badge at 0 (`sidebar/AgentsNavRow.tsx:61-63`); and the cloud
  icon on headers (`Sidebar.tsx:3187-3213`) and cards (`1122-1136`). The container icon for desktop-local
  (WSL) projects stays, because the Local scope mixes this-device and WSL projects
  (`sidebar/environmentRail.logic.ts:42-45`, `147-167`).
- **Typography:** "Projects" drops `uppercase tracking-wider` (`Sidebar.tsx:4006`). Settings becomes
  `text-[13px] font-medium text-foreground/80` with a `size-4` icon (`3816-3820`). The rail avatar becomes
  `text-xs` without tracking (`sidebar/EnvironmentRail.tsx:85`). The discovery UI becomes `text-xs`,
  without `/65` or `uppercase tracking-wide` (`WorktreeDiscoverySection.tsx:124`, `155`, `159`, `182`,
  `200`, `431`, `436`, `454`, `473`, `483`, `505`, `532`). The rename input becomes `sm:text-[13px]`
  (`Sidebar.tsx:1000`). The 12 px row title (`1013`), the `text-[10px]` labels
  (`ThreadStatusIndicators.tsx:140`, `186`) and the `/40` time (`Sidebar.tsx:1156`) retire with the cards
  in step 2.

## Deviations from the mockup

1. **Colours.** Glyphs reuse the pill's `colorClass`, so the Agents view agrees. Input is indigo rather
   than violet (`Sidebar.logic.ts:462`), light approval is amber-600 rather than amber-700, and dark
   shades are `-300/90` rather than `-400`. Failed uses `text-destructive` (red-500) rather than
   `#dc2626`, and the dirty dot uses `bg-warning`.
2. **Fills and text.** The active fill is `bg-accent` (4 %), not 5.5 % (7 % in dark). Project names use
   `text-foreground/90` and Settings `/80`, not full foreground (`UI.md:172`).
3. **Draft PR.** The muted "draft" colour can't be shown: `ChangeRequestState` is only open, closed or
   merged (`packages/contracts/src/sourceControl.ts:21`). Closed PRs render zinc, as today.
4. **PR prefix.** `!57` needs a `numberPrefix` ("!" for GitLab, "#" otherwise) in
   `ChangeRequestPresentation` (`packages/shared/src/sourceControl.ts:24-93`). That also fixes the
   tooltip, which prints `#` even for GitLab (`ThreadStatusIndicators.tsx:48`).
5. **"N more chats"** drops the chevron, because nothing expands yet (`UI.md:111-112`), and gains a glyph.
6. **Sizes.** Hover-strip targets stay 24 px, not 22 px (`UI.md:224`). The native menu uses the OS font,
   and the fallback keeps its 14 px rows. The mockup's provider icons are stand-ins.

## Validation

- **Web (`vp test`):** `Sidebar.logic.test.ts` covers the status table and its precedence (an unseen
  errored turn → Failed; `uncertain` → unchanged; the primary card with `lastVisitedAt`), the age source,
  branch hiding, and chat grouping (path match, no path → primary, archived excluded). Also test the menu
  builders (ids, labels, separators, omissions, grouped submenus), `contextMenuFallback.test.ts`
  (separators, normalisation, keys), the card's Shift+F10 path (exactly one menu, at the card
  rectangle, including when a `contextmenu` follows), and the clock (a single interval that stops at
  zero subscribers).
- **Contracts:** `packages/contracts/src/ipc.test.ts:351-381` covers separator decode, encode and
  rejection. Run `vp run check:contracts`; expect no fixture diff, because menus aren't RPC.
- **Desktop:** `context_menu.rs` tests (`300-346`) cover an id-less separator, normalisation and no
  doubling. Run `cargo fmt --all --check`, `cargo test -p bibcode-desktop context_menu`, and
  `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`.
- **Existing tests and selectors:** update `Sidebar.test.tsx:1331`, `1348`, `4074` (`thread-agent-row-`),
  `1605` ("No threads yet"), `3583-3891` (`new-main-chat-button`) and `3968` (`thread-unread-`). The motion
  guard's placeholder selector (`apps/desktop/e2e/support/motion-guard.ts:29`, `ui-state.test.ts:150`)
  needs a stable `data-testid` on the projects group. The `//a[@data-thread-item…]` XPaths must stop
  requiring an `a` (`apps/desktop/e2e/specs/composer-native-triggers.e2e.ts:334`, `755`;
  `pierre-diffs.e2e.ts:246`). Keep `thread-row-<id>`, which `chat-activity-panel.e2e.ts:145` uses.
- **Visual:** run Playwright on an isolated dev server
  (`BIBCODE_PORT_OFFSET=<n> BIBCODE_HOME=<scratch> vp run dev`) with a 422 px sidebar (window ≥ 1062 px),
  in light and dark (`colorScheme` or `bibcode:theme`, `hooks/useTheme.ts:15-16`, `188`). The fixture
  covers all seven states, open and merged PRs, dirty, terminal, "N more chats" and hidden discovery,
  compared crop by crop with `Main.dc.html`. Assert that no sidebar text computes below 12 px or with
  letter-spacing.
- **Reviews and gates:** `vercel-react-best-practices` (card, clock, menus), the `UI.md` checklist,
  `vp check` and `vp run typecheck`.

## Living docs and runbooks

- **`docs/user/workspace-ui.md`:** lines 19–23 (the badge is hidden at 0), 43–52 (cards, glyphs,
  "N more chats") and 94–102 (⋯, menus, Pull). This fixes lines 98–99 (HEAD 96–97), which say primary
  rows offer "remove project"; that item is header-only (`Sidebar.tsx:2989-2991`, `3020-3036`).
- **Architecture and reference:** `docs/architecture/overview.md:160` ("Sidebar Update" becomes "Sidebar
  Pull"), `docs/reference/encyclopedia.md:49-55` ("running agent sub-rows") and
  `docs/reference/workspace-layout.md:57-59` (the row terms). No living doc describes the menu contract;
  the `ipc.ts` doc comments carry it.
- **`UI.md:176`** calls the sidebar swept. That is false until step 3, which makes it true.
- **Testing runbooks:** `docs/testing/cross-platform-validation.md:1785-1861` gains a cards-and-menus
  item. The packaged-UI lists check native separators and Shift+F10 in `linux-desktop.md:319-431` and
  `macos-desktop.md:223-330`, and fallback separators and keys in `windows-desktop.md:435-584`.
  `execution-report-template.md` needs no change.

## Rollout (each step ships on its own)

1. **Menus:** the contract, separators in both renderers, fallback keyboard support, the regrouping and
   copy, and the ⋯ button replacing the placeholder (with the motion-guard anchor). Update
   `overview.md:160`, the menu paragraph in `workspace-ui.md`, and the runbook menu checks.
2. **Cards:** the resolver, the primary and worktree cards, line 3, "N more chats", the clock, the merged
   list and the summary glyphs; test, e2e and doc updates; and the Playwright comparison.
3. **Removals and typography**, plus `UI.md:176` and the encyclopedia.

## Open questions and follow-ups

- **Copy:** glyph names use the mockup's wording, while the Agents view keeps "Pending Approval",
  "Awaiting Input" and "Completed". Should they be unified?
- **Colours:** the pill colours (recommended), or the mockup's hex values?
- **macOS keyboard:** macOS has no Menu key. Shift+F10 works in the app but is not a macOS convention,
  and VoiceOver users have VO+Shift+M. Is a card ⋯ wanted later?
- **Server work:** `hostThreadId` for nesting, a check rollup for CI colours, and a PR draft state.
