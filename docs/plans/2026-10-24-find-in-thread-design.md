# Find in Thread

Status: Proposed 2026-10-24; awaiting approval. Design for #175.

## Problem

A long chat thread can't be searched. To find an earlier answer, file name,
command, or plan, the user has to scroll or use the minimap. Browser or WebView
find-in-page can't do it either:

- The timeline is a virtualized LegendList, so most rows are not in the DOM.
- Settled turns fold behind **Worked for …**.
- Work groups show only their newest calls.
- Long user messages, long plans, and tool rows render collapsed.

## Current behavior (verified at 4e023ac5ff)

- **The client already holds the whole thread.**
  - `orchestration.subscribeThread` sends one thread's full snapshot, then
    patches against it (`apps/server/src/production/orchestration_rpc.rs:253`,
    `docs/architecture/rpc-and-orchestration.md:1956`).
  - The snapshot loads every message, activity, and proposed plan of the
    thread with no limit (`apps/server/src/orchestration/engine.rs:7115`,
    `:7154`, `:7158`, `:7168`; `apps/server/src/persistence/repositories.rs:1236`
    has no `LIMIT`).
  - It serializes all of them (`orchestration_rpc.rs:1370`, `:1375`, `:1417`,
    `:1437`), into the `messages`, `proposedPlans`, and `activities` arrays of
    `OrchestrationThread` (`packages/contracts/src/orchestration.ts:506`,
    `:507`, `:510`).
  - The web client does not window the snapshot. `ChatView` builds timeline
    entries from all of it (`apps/web/src/components/ChatView.tsx:2886`,
    `:2626`, `:3068`; `deriveTimelineEntries` in
    `apps/web/src/session-logic.ts:1323`).
- **Thread state is more than "loaded or not".** Each thread has a status of
  `empty`, `cached`, `synchronizing`, `live`, or `deleted`, plus an optional
  error (`packages/client-runtime/src/state/threads.ts:27`). A stream failure
  keeps the cached data and only sets the error and a non-live status
  (`threads.ts:120-129`). The web app reads these through
  `environmentThreadDetails.statusAtom` and `errorAtom`
  (`packages/client-runtime/src/state/threadDetail.ts:226-228`). `ChatView`
  shows its error banner above a timeline that stays rendered
  (`ChatView.tsx:6923`).
- **Rows are virtualized.**
  - `MessagesTimeline` renders through LegendList 3.3.10 with
    `estimatedItemSize={90}` and `recycleItems={false}`
    (`apps/web/src/components/chat/MessagesTimeline.tsx:515`, `:521`, `:523`).
  - LegendList's `scrollToIndex` returns a `Promise`, and `getState()` exposes
    `indexByKey`, `scroll`, `start` and `end` (`@legendapp/list` 3.3.10
    `react.d.ts:580`, `:585`, `:666`).
  - An imperative scroll can be deferred. While the list settles after a data
    change, or while sizes it needs are unknown, the scroll waits for up to
    800 ms and then runs with the numeric index it was given (`react.js:7390`,
    `:7573`). Starting any new imperative scroll cancels the pending one: the
    request tracker bumps its token and cancels the deferred frame
    (`getScrollRequestTracker`, `react.js:1443`).
  - The minimap already jumps with `scrollToIndex`, after `onManualNavigation`
    (`MessagesTimeline.tsx:552`; `ChatView.tsx:3956`, `:6990`).
- **Six disclosures can hide text.**
  1. The turn fold. `deriveTurnFolds` hides a settled turn's entries except its
     answer (`MessagesTimeline.logic.ts:294`). Its state is `expandedTurnIds`
     (`MessagesTimeline.tsx:265`).
  2. The work group. Only the newest entries show, behind **+N previous**
     (`MessagesTimeline.logic.ts:13`, `:547`). Its state is
     `expandedWorkGroupIds` (`MessagesTimeline.tsx:266`). Entries with a
     neutral status are never rendered (`MessagesTimeline.logic.ts:535`), so a
     row's id can differ from its group's first entry.

     Groups are built after folded entries are removed, and a run of work
     entries breaks at a fold anchor (`MessagesTimeline.logic.ts:482-489`,
     `:519-527`). Opening a fold therefore changes which group an entry belongs
     to, the group's id, and whether the entry is in the group's hidden part.
     A small group renders as one row keyed by its first entry; a large one
     renders one row per entry.

  3. The tool row. Its command shows in full only in the expanded `<pre>`,
     which holds the command, then the output, then changed files
     (`MessagesTimeline.tsx:2094`, `:2315`). The state is `useState(false)` in
     each row (`:2176`). The collapsed heading and preview are `select-none` and
     truncated (`:2234`, `:2246`).
  4. The long user message. A message over 8 lines or 600 characters is
     clipped at `max-h-44` (`MessagesTimeline.tsx:1640`, `:1672`). Its state is
     per row (`:1663`).
  5. The long plan. A plan over 900 characters or 20 lines renders a different,
     shorter Markdown preview (`ProposedPlanCard.tsx:71`, `:73`, `:174`). The
     text past the preview is not in the DOM at all. Its state is per row
     (`:49`).
  6. Markdown `<details>`. It is a Base UI Collapsible with local state
     (`ChatMarkdown.tsx:445`). Its `<summary>` stays visible when closed.
- **The DOM text is not the Markdown source.** Both message roles and plans
  render through `ChatMarkdown`: react-markdown with
  `[remarkGfm, remarkBreaks?, remarkPreserveCodeMeta]` and
  `[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]`, plus custom
  components (`ChatMarkdown.tsx:1686-1693`, `:164`).
  - A file link renders as a chip whose label is built from the path, not from
    the link text: the basename, a parent suffix that tells apart files with
    the same name in one message, and the line (`ChatMarkdown.tsx:1589-1611`).
    The label is ordinary selectable text (`FileTagChipContent … selectable`).
  - A skill token renders as a chip whose label is the skill's display name
    (`SkillInlineText.tsx:86-106`); text inside `code` and links is left alone
    (`SkillInlineText.tsx:47`). Only the composer's chip classes carry
    `select-none` (`apps/web/src/components/composerInlineChip.ts`).
  - Link URLs and Markdown markup are not shown.
  - User messages add terminal-context chips and review-comment cards
    (`MessagesTimeline.tsx:1724`).
- **Keyboard.**
  - `ChatView` resolves shortcuts in a window keydown listener in the capture
    phase, for the host chat only (`ChatView.tsx:4791`, `:4817`, `:4949`).
  - No command binds `mod+f` (`packages/shared/src/keybindings.defaults.json`).
  - Other surfaces use `mod+f`: Pierre's editor search in the right-panel file
    editor (`@pierre/diffs` 1.3.6 `dist/editor/command.js:15`), and the search
    in Settings → Keybindings (`KeybindingsSettings.tsx:1107`).
  - The desktop menu has no Find item (`apps/desktop/src-tauri/src/window.rs:88`).
  - WebView2 keeps its browser accelerator keys, `Ctrl+F` find included. Wry's
    default is true (wry 0.55.1 `src/lib.rs:1687`), and BiBCode does not change
    it.
  - The command palette closes before it runs an action, and its `finalFocus`
    always focuses the composer (`apps/web/src/components/CommandPalette.tsx:479-512`;
    test at `CommandPalette.test.tsx:694`).
- **Keybinding transport.**
  - The client uses the primary server's resolved list whenever it has a
    config, and the shared defaults only before then
    (`apps/web/src/state/server.ts:83-86`).
  - The server sends the shipped defaults only when `keybindings.json` does not
    exist (`apps/server/src/production/keybindings.rs:14-21`). The first saved
    edit writes the whole current list to that file
    (`apps/server/src/production/control.rs:1580-1600`). From then on, defaults
    added in later releases never reach that user.
  - The server checks a rule's command for length only
    (`keybindings.rs:92`). The client decodes every resolved rule's command
    against a closed list (`packages/contracts/src/keybindings.ts:83`,
    `:149`), and that decoder is part of `ServerConfig`
    (`packages/contracts/src/server.ts:528-532`). A command the client does not
    know therefore fails the decode of the whole config. Decoding a resolved
    list containing `chat.find` with the current schema fails; this was
    reproduced.
- **Engines.**
  - The webview engine is WKWebView, WebKitGTK, or WebView2, depending on the
    platform. The frontend must feature-detect optional APIs
    (`docs/architecture/overview.md:1089`).
  - The macOS minimum is 11.0 (`apps/desktop/src-tauri/tauri.conf.json:47`).
  - Linux AppImages build on Ubuntu 22.04 (`.github/workflows/release.yml:340`,
    `:346`).

## Goals

- Mod+F and the command palette open a find bar for the current thread.
- The bar shows `n/total`, Previous, Next, and Close.
- A match is reachable even when its row is not mounted, or is hidden inside
  any disclosure listed above, including a fold and a group at once.
- Keyboard: open, next, previous, and close all work. Escape returns focus to
  the composer.
- The search text never reaches logs, profiler records, persistence, or the
  network.
- An updated client or server never sends or expects anything the other
  version cannot decode.

## Non-goals

- Tool output, changed-file lists (the Changed files tree and the paths in tool
  rows), attachments, terminal-context chips and review-comment cards in user
  rows, reasoning rows (#173), and rendered diagrams (#171). File-link and
  skill chips inside Markdown are searched by their labels.
- Regex, whole-word, and case-sensitive modes; replace.
- Searching across threads.
- Server-side search.
- Theme-editor colours for matches.
- A Mod+F rule in the shipped keybinding defaults (see Command and keybinding).

## Alternatives

**A. WebView or browser find-in-page.** Rejected. It cannot see unmounted rows
or folded content. WKWebView and WebKitGTK also need host work before they
show any find UI.

**B. A server search RPC over persisted history, with paging.** This is the
approach of upstream PR 10439. Its server is TypeScript and shares one
Markdown-to-displayed-text module with the renderer. Counts there follow what
is shown, and paging exists because that client pages thread history.
BiBCode's server is Rust, so it cannot share the renderer's projection. It
would count the Markdown source, and the source differs from the DOM: link
URLs, markup, and file-chip labels. It would also add a method, a schema, a
capability gate for older servers, and a round trip per navigation on remote
links. All of that would search data the client already holds.

**C. A client search over the projected thread.** Recommended. Covered below.

**D. A client search over the raw Markdown source.** It is simple and cheap.
But the count includes hidden text, such as URLs and `**` markers. "3/10" would
then point at occurrences that have no highlight, and file chips would never
match their labels. Rejected under UI.md: the program must behave as the user
expects.

**E. A DOM-only search of the mounted rows.** Rejected. It cannot count or
reach unmounted and folded rows, which is the problem the issue states.

**F. Building the index in a Web Worker.** Deferred, with a measured trigger.
Each query is a plain string scan, and only the first index of a thread parses
Markdown. If a Performance fixture misses its budget, the parse moves to a
worker before merge. The matching and reveal design stays the same.

**G. Messages and plans only, without tool commands.** A smaller first slice:
it drops the work-group reveal, the tool-row disclosure, and the inner
scroller of a tool row. It is offered as a decision. The design below keeps
commands because the issue names "command" among the things users look for,
and the extra reveal is one more step in the same plan.

## Decision

**C: a client-only search, with a displayed-text projection built by the
renderer's own Markdown pipeline.**

- **It searches what the client holds, which is the whole thread when live.**
  The thread stream delivers every message and plan. When the client holds
  only a cached copy (`cached`, or `synchronizing` with data), find still
  searches it and says so in the status.
- **If thread history is ever paged, this decision is revisited.** Counting
  then moves to a server method, or the bar must say it searches only loaded
  messages.
- **What this trades away.**
  - The first find in a long thread parses its Markdown on the main thread,
    which is scheduled in slices and measured below.
  - The projection must keep parity with the renderer, which a test enforces.
  - Mod+F is a built-in fallback, not a shipped default rule, so it does not
    appear as a default row in Settings → Keybindings.

## Answers to the issue's open questions

- **Server or client.** Client. See the Decision. No RPC is added, so nothing
  is registered in `rpc/session.rs` and nothing is classified in
  `diagnostics/profiler/latency.rs`. A later server method would be read-only,
  registered with `register_unary` (`apps/server/src/rpc/session.rs:516`) under
  `orchestration:read`. It would be neither `is_long_running` nor
  `is_background` (`latency.rs:106`, `:164`), because it is a bounded SQLite
  read plus CPU and waits on nothing external.
- **Fields searched.** The text as displayed:
  - user and queued message bodies;
  - assistant message text;
  - proposed plans, title and body;
  - file-link and skill chip labels inside that Markdown;
  - the command of a tool row: the raw command when it differs, otherwise the
    command (`workEntryRawCommand`, `MessagesTimeline.tsx:2084`).

  Not searched: tool output, MCP call JSON, changed-file paths,
  terminal-context chips, review-comment cards, timestamps, fold labels, or
  the `(empty response)` placeholder. Output is large and noisy, and showing a
  match in it means expanding a clamped scroll box.

- **Limits.**
  - The query is 1 to 256 UTF-16 units, matched exactly as typed.
  - Counts are exact. They are stored per entry, so memory is O(entries) and
    there is no cap on the total.
  - Painting covers only mounted rows: at most 1,000 inactive ranges per paint,
    nearest the active match first. The active range is always painted.
  - Typing waits 120 ms before rescanning; Enter rescans at once. Live updates
    recount at most every 300 ms.
- **Paging.** None. The data is local.
- **The acceptance item "Server tests for paging and limits".** With no server
  method, it becomes client tests for limits and ordering (Test plan 2).
  Approving this design accepts that substitution.

## Matching

- **Literal match.** The match is a literal substring, case-insensitive. The
  fold is length-preserving: a code point is lowercased only when the result
  keeps its UTF-16 length, so offsets map one to one.
- **Whitespace and order.** All whitespace characters compare equal, so a query
  with a space matches a soft line break. Runs are not collapsed. Occurrences
  are counted left to right without overlap.
- **Segments.** A match never crosses a segment. A segment is a paragraph,
  heading, list item, table cell, block quote, or code block, matching the
  renderer's block elements.
- **The projection runs the renderer's pipeline.** A new
  `apps/web/src/components/chatMarkdownPipeline.ts` exports what `ChatMarkdown`
  and find both use: the remark plugin list (with and without `remarkBreaks`),
  the rehype plugin list with `CHAT_MARKDOWN_SANITIZE_SCHEMA`, the file-link
  label function with its per-message parent suffixes, and the skill-token
  splitter. `ChatMarkdown` passes the same lists to react-markdown.
  `threadFindText.ts` runs `remark-parse`, the remark plugins, `remark-rehype`
  with `allowDangerousHtml`, and the rehype plugins, which is react-markdown's
  own order, and walks the sanitized hast. Raw HTML and sanitizing need no
  mirrored rules. Only the custom components are mirrored:
  - an ordinary link keeps its text;
  - a file link contributes its chip label, from the shared function;
  - text outside `code` and links goes through the skill splitter, and a skill
    contributes its display name;
  - an image contributes nothing;
  - text inside `<details>`, except its `<summary>`, is flagged with the
    block's ordinal.

  User bodies use the text the row actually passes to `ChatMarkdown`, after the
  existing preview-annotation and element-context extraction, with the same
  `lineBreaks` choice. Plans use `proposedPlanTitle` and
  `stripDisplayedPlanMarkdown`. A tool command is plain text.

- **The cache.** One cache per mounted timeline, keyed by the source text and
  the render context (`cwd`, the skills list, and `lineBreaks`). After each
  scan, the cache drops entries that scan did not use, so its memory stays
  within the current thread. Work entries are re-derived as new objects on
  every activity change, so the cache does not key on objects.
- **Order.** Matches follow the timeline's entry order, which is the row order
  once the entry is revealed. Queued messages come last, as their rows do. The
  set of entries is the set `deriveMessagesTimelineRows` can show: queued rows
  included, entries with a neutral status excluded.
- **Selection.**
  - A new query starts at the first match at or below the top of the viewport.
    The anchor is `getState().start`, mapped to that row's first entry. It
    wraps to the first match.
  - While a query is extended, the scan continues from the active match.
  - Next and Previous move through the matches in order and wrap at both ends.
  - The active match is identified by `(entryId, occurrence)`, not by its
    global index. Matches that arrive before it change `n` but not the
    selection. If its occurrence disappears, the next one is selected.

## Revealing a match

1. **Locate.** `locateTimelineEntry(entryId, input)` in
   `MessagesTimeline.logic.ts` returns a complete reveal plan:
   - `{ kind: "absent" }`, or
   - `{ kind: "found", rowId, openTurnId?, openGroupId? }`.

   It reuses the helpers behind `deriveTurnFolds` and the grouping loop, which
   are extracted from `deriveMessagesTimelineRows`, so the two cannot disagree.
   It works against a hypothetical disclosure set. First it checks the fold;
   if the entry is folded, it adds that turn to the open turns. Then it builds
   the groups under that set; if the entry is in a group's hidden part, it adds
   that group. Finally it computes the entry's row id under both. The plan
   therefore names the group and row that will exist after the fold opens, not
   the ones that exist now. It runs on demand, once per navigation, never while
   the bar is closed.

2. **Open.** In one state update, open everything the plan names. Then open
   the row's own disclosure when the projection says the occurrence needs it:
   past the user-body clip, past the plan preview, in a tool row's command, or
   in a `<details>` block.

   The disclosures need one owner, so the per-row state moves into
   `MessagesTimeline`:
   - a single disclosure owner with `open(keys)` and `toggle(key)`, over turn,
     group, entry, user-body, plan, and details keys;
   - each row receives `expanded` (or `openDetails`) as data, so only the rows
     that change re-render;
   - `isRowUnchanged` compares the new fields.

   `ProposedPlanCard` and `MarkdownDetails` become controlled. A user's toggle
   and a find reveal both write to the same state. Navigating to a match that
   the user collapsed opens it again.

3. **Scroll.** After the commit:
   - `index = getState().indexByKey(rowId)`;
   - call `onManualNavigation()`, so live follow and the new-turn anchor stop
     pulling the list;
   - `await scrollToIndex({ index, animated: false, viewPosition: 0.3 })`,
     recording the request as pending under the navigation's generation token.

   Find never animates its scrolls, which also satisfies Reduce Motion.

4. **Supersede and revalidate.** LegendList may run the scroll up to 800 ms
   later with the index it was given.
   - A newer navigation's own scroll supersedes the old one.
   - On close, on a query that has no matches, and on a thread switch, a
     pending find scroll is superseded with
     `scrollToOffset({ offset: getState().scroll, animated: false })`, which
     cancels LegendList's deferred request and leaves the list where it is.
   - When the promise resolves, the result is ignored unless the generation
     token is still current. If `indexByKey(rowId)` no longer equals the index
     requested, because a previous turn folded, a row streamed in, or a resync
     replaced the snapshot, the scroll is issued once more with the new index.
     A second mismatch ends in the fallback emphasis below.
5. **Settle.** For up to 10 animation frames, look for the row
   (`[data-timeline-row-id]`, `MessagesTimeline.tsx:950`) and build its ranges.
   Once the occurrence's rect is unchanged for two frames:
   - scroll any inner scroller that clips it into view, such as a code block's
     `overflow-x-auto` or the tool row's `max-h-64`;
   - then move the list by the measured delta (`scrollToOffset`), so the match
     sits in the visible band above the composer (`contentInsetEndAdjustment`).

   If the occurrence never appears, the row gets the fallback emphasis below.
   The generation token cancels a stale settle.

Closing find keeps the reading position and everything it opened. A browser's
find does not re-close `<details>` either, and refolding would move the
content. `useFoldPreviousTurnOnNewTurn` (`MessagesTimeline.tsx:576`) still folds
the previous turn when a new turn starts. If that hides the active match, the
next navigation reveals it again.

## Highlighting

- **Scopes.** Searchable scopes are marked `data-find-scope`: the assistant
  Markdown, the user body, the plan title and body, and the command block. A
  tool row's `<pre>` renders the command in its own element, so the output
  below it is outside the scope. Inside Markdown, chip labels are part of the
  scope; only decoration is marked `data-find-ignore`: chip icons and tooltip
  popups. A chip label is truncated with an ellipsis, so a highlight in its
  clipped part is not visible; the match still counts and the chip is scrolled
  into view.
- **Building ranges.** `threadFindHighlights.ts` walks only the text nodes in
  scopes of mounted rows, splits at block elements, and builds a `Range` per
  occurrence. It never writes to the DOM. A `MutationObserver`, coalesced to
  one animation frame, rebuilds only the rows whose scoped text, row id, or
  disclosure changed.
- **CSS Custom Highlight API.** `CSS.highlights` gets two entries,
  `bibcode-find` and `bibcode-find-active`. They are styled by
  `::highlight()` with `background-color` and `color` from new tokens, defined
  on `:root` for light and dark. The active match differs by contrast, not hue
  alone.

  | Engine                | Support                                                     |
  | --------------------- | ----------------------------------------------------------- |
  | Chromium and WebView2 | 105+                                                        |
  | Safari and WKWebView  | 17.2+                                                       |
  | Firefox               | 140+; `text-decoration` from 146 and `text-shadow` from 149 |

  Sources: [MDN data for `Highlight`](https://github.com/mdn/browser-compat-data/blob/main/api/Highlight.json)
  and [for `::highlight()`](https://github.com/mdn/browser-compat-data/blob/main/css/selectors/highlight.json).
  Only `background-color` and `color` are used.

- **One active find per document.** The highlight registry is document-wide,
  and the host chat stays mounted while panel chats run their own timelines.
  `threadFindHighlights.ts` therefore keeps one owner: the surface whose find
  is open. Opening find in another surface closes the current one first, bar
  and highlights, and keeps its query in memory for reopening. Only the owner
  writes or deletes the two registry entries. Closing or unmounting a surface
  that is not the owner leaves the registry alone. The fallback ring is an
  attribute on the surface's own row and is cleared by that surface.
- **WebKitGTK.** WebKit enabled CSS highlights by default in 268673@main and
  made them stable in 269698@main, in September and October 2023
  ([bug 262402](https://bugs.webkit.org/show_bug.cgi?id=262402),
  [bug 263562](https://bugs.webkit.org/show_bug.cgi?id=263562)). That puts them
  in WebKitGTK 2.44, released in March 2024
  ([release](https://webkitgtk.org/2024/03/16/webkitgtk2.44.0-released.html)).
  Ubuntu 22.04 ships 2.50.x
  ([USN-7957-1](https://lists.ubuntu.com/archives/ubuntu-security-announce/2026-January/010088.html)).
  The packaged Linux run must confirm it.
- **`user-select: none`.** WebKit ignores highlight styling on text with
  `user-select: none` ([WebKit bug 278455](https://webkit.org/b/278455)). The
  scopes, chat chip labels included, are selectable text. The tool row's
  `select-none` heading is deliberately not a scope.
- **Fallback.** Without `CSS.highlights`, which means macOS 11's Safari 16 or
  Firefox before 140 in browser mode, there are no inline highlights. The
  active match's row gets a visible ring (`data-find-active-row`), and the
  match is still scrolled into view; counts and navigation are unchanged. Using
  the Selection API instead was rejected: it replaces the user's selection and
  could move focus out of the input.
- **Cleanup.** The owner clears the highlights on close, on a thread switch, on
  thread deletion, and on unmount.

## Command and keybinding

- **No shipped default rule.** Adding a Mod+F rule to
  `keybindings.defaults.json` was rejected for two reasons from Current
  behavior:
  - An older client connected to an updated server would fail to decode the
    whole `ServerConfig`, because its `KeybindingCommand` list lacks the new
    command.
  - Users who have ever saved a keybinding would never receive the rule.
- **The command.** `chat.find` joins `KeybindingCommand`
  (`packages/contracts/src/keybindings.ts:50`), so a user can bind it in
  `keybindings.json` or in Settings.
- **The built-in Mod+F.** In the host `ChatView` keydown listener, after
  `resolveShortcutCommand` returns no command, Mod+F with no other modifier
  opens find when both hold:
  - the target is inside a chat surface (timeline, composer, find bar), or
    nothing is focused;
  - no resolved rule names `chat.find`.

  So a user rule on Mod+F for any other command still wins, and a user rule
  that binds `chat.find` to another key replaces the fallback. Tooltips and the
  palette show the effective key: the rule's key, or Mod+F.

- **`chatFocus`.** The same "inside a chat surface" test is exposed as a
  `when` identifier in the shortcut context, and `chatFocus` joins
  `CORE_WHEN_VARIABLES` in Settings (`KeybindingsSettings.logic.ts:32`),
  because no default rule seeds it.
  - Mod+F in the file editor, Settings, a terminal, or a preview keeps its
    current behaviour.
  - In browser mode outside the chat, the browser's own find still works. That
    respects UI.md's "do not change standard shortcuts" except where browser
    find cannot work.
- **Panels.** The host `ChatView` listener opens the find of the chat surface
  that contains the event target, or the host chat. It uses a small registry of
  open-find callbacks keyed by each surface's root element. Panel chats never
  register a window listener of their own (`ChatView.tsx:4949`).
- **While the bar is open.** Enter and Shift+Enter in the input go to the next
  and previous match. Mod+G and Mod+Shift+G, and F3 and Shift+F3, do the same.
  They are handled by the bar, not added as commands. Mod+F refocuses the input
  and selects its text.
- **The palette.** The command palette gains **Find in thread**, listed only
  while a thread is open. Because the palette closes before it runs an action
  and then focuses the composer, action items gain an optional post-close focus
  target. `finalFocus` calls it when the executed item has one, and otherwise
  focuses the composer as today. Find's target is the find input, so typing
  right after choosing the action goes into the bar.
- **WebView2.** WebView2 documents its processing order as the
  `AcceleratorKeyPressed` event, then browser accelerators, then web content
  ([CoreWebView2AcceleratorKeyPressedEventArgs](https://learn.microsoft.com/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2acceleratorkeypressedeventargs),
  [AreBrowserAcceleratorKeysEnabled](https://learn.microsoft.com/dotnet/api/microsoft.web.webview2.core.corewebview2settings.arebrowseracceleratorkeysenabled)).
  The page's `preventDefault` may therefore not stop the native find bar from
  opening on Ctrl+F, F3, or Ctrl+G. The packaged Windows run checks this.
  - If the native bar opens, the desktop host handles `AcceleratorKeyPressed`
    for exactly those keys and sets `IsBrowserAcceleratorKeyEnabled = false`.
    The key still reaches the page, and every other browser key stays as it
    is. The host already reaches `CoreWebView2` through `with_webview`
    (`window.rs:266`).

## UI behavior (UI.md)

- **Placement.** The bar is a compact overlay at the top right of the timeline
  column, at most 22rem wide and full width on narrow windows. It does not
  cover the minimap or the composer. It uses the existing popover surface and
  `border` tokens.
- **Contents.** A search icon; an input with the placeholder "Find in thread";
  the status (`text-xs`, `tabular-nums`, `text-muted-foreground`);
  **Previous**, **Next**, and **Close**. Each button has an accessible name and
  a tooltip with its shortcut.
- **Status.**
  - "Loading thread…" while the thread is `empty` with no error.
  - "This thread could not be loaded" when it is `empty` with an error. The
    existing error UI owns the retry.
  - "Searching…" during the first index of a thread.
  - `3/17` for a match. Its accessible text is "3 of 17 matches", in a polite
    live region that is throttled.
  - "No results in messages, plans, or commands" for none. That gives the
    search scope at the moment it matters, without a tooltip.
  - While the thread is `cached` or `synchronizing` with data, the status adds
    "· may be out of date", because it searches the copy loaded before the
    connection changed.

  Previous and Next are disabled at zero results, with the reason visible
  beside them.

- **Escape** in the bar or on its buttons closes it and focuses the composer
  (`focusComposer`, `ChatView.tsx:3238`). If the composer cannot take focus,
  focus goes to the timeline. Find never touches the draft.
- **Reopening.** Reopening restores the last query, selected, for that thread
  view. The query is kept in memory only.
- **Another surface.** Opening find in another chat closes this one, as
  described under Highlighting.
- **Choices.** There is no setting and no option toggle. Defaults: whole thread,
  case-insensitive, displayed text.
- **Typography.** The smallest text is `text-xs`, and nothing uses alpha on
  `text-muted-foreground` (UI.md Typography).

## Protocol, schema, and persistence

- **Contracts.** `KeybindingCommand` gains `chat.find`. That widens the client's
  decoder only. The server needs no change, because it checks a command's
  length, not its name.
- **Defaults.** `keybindings.defaults.json` does not change, so an updated
  server sends exactly the list an older server sends.
- **Both version directions.**
  - New client, older server: the server's list never names `chat.find`; the
    current decoder accepts it, and the built-in Mod+F works.
  - Older client, updated server: the server sends nothing new, so the older
    decoder accepts it.
  - A user rule naming `chat.find`: every updated client decodes it. An older
    client connected to the same server fails to decode the whole
    `ServerConfig`. This hazard is not new: it applies to every command added
    since the closed list was introduced. `docs/user/keybindings.md` gains a
    caveat, and a follow-up issue proposes per-rule tolerant decoding.
- **A pre-existing discrepancy, not fixed here.** `docs/user/keybindings.md`
  says a rule with an unknown command "is ignored". In source, the server
  accepts and sends it, and the client then fails to decode the whole config.
  A follow-up issue should either drop unknown rules in the client decoder,
  with a reported issue, or validate command names on the server.
- **No other changes.** There is no RPC, no other wire schema, no persisted
  field, no migration, no fixture regeneration, and no capability flag.

## Trust boundaries

All the data is already in the client. Find adds no network traffic, no
DesktopBridge command, no storage, and no HTML: it builds `Range`s over
existing text nodes. The projection runs the same sanitizing pipeline as the
renderer and only reads its output. The query is matched as a literal, never
compiled into a `RegExp`, so there is no ReDoS. The optional WebView2 handler
changes key routing for three browser accelerators in BiBCode's own window
only.

## Failure, cancellation, reconnect, and concurrency

- **Thread state.** The controller reads `statusAtom` and `errorAtom` for the
  thread's scoped ref; it does not infer state from what is rendered.
  - `empty`, no error (first load): "Loading thread…"; nothing is searched.
  - `empty` with an error (the initial load failed and nothing is cached): the
    unavailable status; Previous and Next are disabled.
  - `cached`, or `synchronizing` with data (a reconnect, or a stream error
    that kept the cache): the held copy is searched, with the out-of-date
    note. Counts refresh when the thread is `live` again.
  - `live`: normal.
  - `deleted`: find closes, and its highlights and any pending find scroll are
    cleared.
  - A thread or environment switch discards the find state. The key is the
    scoped `routeThreadKey`, so the same thread id in two environments is never
    mixed.
- **Reconnect.** The resync snapshot keeps equal objects
  (`rpc-and-orchestration.md:2002`), and the text cache keys on content, so
  unchanged entries are not parsed again. Counts refresh on the next 300 ms
  tick. The active match survives, by `(entryId, occurrence)`, and a scroll in
  flight is revalidated by row id (Revealing, step 4).
- **Streaming.** A streaming message is projected again at most every 300 ms.
  Highlights in mounted rows follow the `MutationObserver`.
- **Rapid navigation.** Navigation is cancellable: each one bumps a generation
  token, and only the newest settle may scroll or paint. A pending LegendList
  scroll is superseded, not just ignored. A query change cancels the scan in
  progress. Index slices resume where they stopped, because the projection does
  not depend on the query.
- **Two surfaces.** Only one find is open per document, so two controllers
  never compete for the highlight registry.
- **IME.** No scan or navigation runs while `isComposing`.

## Performance

- **Find closed.** It costs nothing: no projection, no observer, no
  allocation. The only always-on change is that the disclosure state lives in
  `MessagesTimeline` rather than in each row. Rows still receive stable data,
  and an untouched row keeps its identity through
  `computeStableMessagesTimelineRows`.
- **Scheduling.** Projections run in slices that yield after about 8 ms of
  work, between entries, with `scheduler.yield` where it exists and
  `MessageChannel` elsewhere. 8 ms is a scheduling target, not a bound: one
  entry's parse is a single synchronous `unified` call, so one large message
  can take longer. The scan starts at the viewport anchor and reveals the first
  match as soon as it is found; the total appears when the scan finishes.
- **Budgets,** on the macOS baseline machine, each with its own fixture:
  - 3,000 messages and 3 MB of text: at most 1.5 s to the full count, and each
    later query's scan at most 30 ms;
  - one 1 MB assistant message;
  - a 200 KB message streaming in 2 KB increments while find is open;
  - in all three, no main-thread stall over 50 ms caused by find.
- **Escalation to a worker.** If any single projection in these fixtures takes
  more than 50 ms, projections above a size threshold set from that measurement
  move to a Web Worker (alternative F) before merge. The matcher, the cache
  keys, and the reveal path do not change.
- **Streaming cost.** react-markdown already parses the whole message on every
  render of a streaming row (#172 exists to change that), so one find parse
  per 300 ms adds at most one extra parse per interval.
- **Highlights.** Only mounted rows are walked: about 20 to 40 with
  LegendList's buffer. Rows are walked again only when they change. Painting is
  capped at 1,000 ranges.
- **React.** The controller keeps its working state in refs and talks to the
  DOM outside render. The bar re-renders on status changes only. No context
  value changes on every keystroke, and no effect derives state that can be
  computed.

## Profiler coverage

Following AGENTS.md "Profiler, Crash, and Trace Coverage":

- **Child processes, worktree removal, binaries, re-exec modes, shutdown.** Not
  touched.
- **RPC methods.** None are added, so no `rpc/session.rs` registration and no
  `is_long_running` entry. The optional WebView2 key handler is not an RPC.
- **Events, findings, logs, trace.** No new event or finding. Find runs on the
  main thread, so the existing client collector covers it: Long Animation
  Frames or heartbeat stalls, and Event Timing interactions. It records
  durations only (`apps/web/src/profiler/clientCollector.ts:272`). Find's code
  never passes the query to `console`, `tracing`, the profiler, storage, or the
  network. A development-only parity warning carries an entry id and two
  counts.
- **Documentation.** No profiler reference changes.

## Composition with parallel work

- **#142 (Verbose chat).** It uses the same disclosure owner: verbose sets the
  defaults, and find calls `open`. `locateTimelineEntry` uses the same fold and
  group helpers, so with verbose on it simply returns a plan with nothing to
  open. Whichever change lands first moves the per-row state; the other builds
  on it.
- **#176 (minimap turn steps and PageUp/PageDown).** Independent. Both scroll
  through `listRef` after `onManualNavigation`, and find never animates. A
  minimap or page jump supersedes a pending find scroll the same way a new
  find navigation does.
- **#172 (incremental streaming parse), #171 (Mermaid), #173 (Thinking rows).**
  A change to what `ChatMarkdown` renders must keep the parity test passing;
  a plugin change made in `chatMarkdownPipeline.ts` reaches both sides at
  once. A new row kind is not searchable until it adds a projection and a
  reveal path.

## Files to change

- **New, in `apps/web/src/components/chat/threadFind/`:**
  - `threadFindText.ts`: projection and matcher;
  - `threadFindIndex.ts`: cache, sliced scan, selection;
  - `useThreadFind.ts`: controller, thread status, reveal, scroll supersede,
    settle;
  - `threadFindHighlights.ts`: ranges, the single registry owner,
    `CSS.highlights`, fallback;
  - `ThreadFindBar.tsx`: the bar;
  - a test file for each.
- **New: `apps/web/src/components/chatMarkdownPipeline.ts`:** the plugin lists,
  the sanitize schema, the file-link label function, and the skill splitter,
  moved out of `ChatMarkdown.tsx` and `SkillInlineText.tsx`.
- **`apps/web/src/components/chat/MessagesTimeline.logic.ts`:** extracted fold
  and group helpers, and `locateTimelineEntry`.
- **`apps/web/src/components/chat/MessagesTimeline.tsx`:** the disclosure
  owner, row `expanded` fields, `data-find-scope` markers, a separate command
  element in the tool `<pre>`, and mounting the controller and the bar.
- **`apps/web/src/components/chat/ProposedPlanCard.tsx`:** a controlled
  `expanded` prop.
- **`apps/web/src/components/ChatMarkdown.tsx` and `SkillInlineText.tsx`:** use
  the shared pipeline module, `data-find-ignore` on chip icons and tooltip
  popups, and a controlled `openDetails` prop.
- **`apps/web/src/components/ChatView.tsx`:** the `chatFocus` context, the
  built-in Mod+F fallback and `chat.find` dispatch, the surface registry, and
  focusing the composer on close.
- **`apps/web/src/components/CommandPalette.tsx` and `CommandPalette.logic.ts`:**
  the **Find in thread** action, its shortcut label (the Mod+F label when no
  rule names `chat.find`, since `shortcutCommand` labels come from the
  server's list), and the optional post-close focus target.
- **`apps/web/src/components/settings/KeybindingsSettings.logic.ts`:**
  `chatFocus` in `CORE_WHEN_VARIABLES`.
- **`apps/web/src/index.css`:** the `::highlight()` rules and match tokens.
- **`apps/web/package.json`:** `unified` 11.0.5, `remark-parse` 11.0.0, and
  `remark-rehype` 11.1.2 as direct dependencies. All three are already in
  `pnpm-lock.yaml` through react-markdown 10.1.0, so no new code is downloaded.
- **`packages/contracts/src/keybindings.ts`:** the `chat.find` command. The
  shared defaults file does not change.
- **Only if the Windows check needs it:**
  `apps/desktop/src-tauri/src/window.rs`, the `AcceleratorKeyPressed` handler.
- **Docs:**
  - `docs/user/workspace-ui.md`: a new "Finding text in a chat" subsection
    under Center Panel, and a Current limitations line saying tool output is
    not searched;
  - `docs/user/keybindings.md`: the `chat.find` command, the built-in Mod+F,
    `chatFocus`, and the caveat that older clients cannot decode a rule naming
    `chat.find`;
  - `docs/testing/cross-platform-validation.md`: the packaged find flow.

## Test plan (written to fail first)

1. **`threadFindText.test.ts`.**
   - A phrase across emphasis (`**foo** bar`) matches "foo bar".
   - A link URL does not match; its text does.
   - A file link matches its chip label, not its path, including the parent
     suffix for two files with the same basename.
   - A word repeated in a file chip, a skill chip, and ordinary text counts
     every occurrence.
   - Inline and fenced code match; a match never crosses a block or table
     cell.
   - Text in `<details>` is flagged with its ordinal; its `<summary>` is not.
   - Raw HTML that the sanitizer drops contributes nothing.
   - `(empty response)` is not searchable.
   - Whitespace is equivalent, and the case fold keeps offsets (for example
     `İ`).
2. **`threadFindIndex.test.ts`.**
   - Counts per entry and their order.
   - The start at or below the viewport; Next and Previous wrap.
   - An inserted earlier match keeps the selection.
   - A streaming update keeps the selection.
   - A vanished occurrence moves to the next one.
   - Entries with a neutral status are excluded; queued messages are
     included.
   - Unchanged text is not parsed again (counted with a spy).
   - Slices yield between entries; one oversized entry finishes in one slice
     and the scan continues.
   - Queries of 1 and 256 units are accepted, and 257 is truncated by the
     input.
3. **`MessagesTimeline.logic.test.ts`.** `locateTimelineEntry`:
   - returns `absent`, and a plan with nothing to open for a visible entry;
   - for an entry in a folded turn whose group, once unfolded, hides it, returns
     the turn, the group id computed after unfolding, and the final row id;
   - returns the row id when a small group's first entry is neutral;
   - opens nothing when folds are disabled (the #142 seam).
4. **`useThreadFind.test.tsx`** (happy-dom, with a fake highlight registry and
   a fake list whose `scrollToIndex` can be deferred).
   - In a 500-row thread, a match inside a folded turn opens the fold, calls
     `scrollToIndex` with the row's index, and paints the active range in that
     row.
   - One navigation to a command inside a folded turn and a collapsed group
     opens the fold, the group, and the tool row. Text only in the output is
     not counted.
   - A match past "Show full message" or past a plan preview opens it.
   - A collapsed-by-user row opens again on navigation.
   - Closing find while a scroll is deferred issues the superseding
     `scrollToOffset` at the current offset, and the deferred scroll never
     runs. Replacing the query with one that has no matches does the same.
   - When rows shift during a deferred scroll, the scroll is reissued once with
     the row's new index.
   - Two surfaces: opening find in B closes A's bar and highlights; closing B
     empties the registry; unmounting A afterwards does not touch it.
   - Thread status: `empty` shows loading, `empty` with an error shows
     unavailable, `cached` searches with the out-of-date note, `deleted`
     closes find.
   - Without `CSS.highlights`, the fallback ring is set.
5. **`ThreadFindBar.test.tsx`, `ChatView`, and `CommandPalette` tests.**
   - Mod+F opens and focuses the bar.
   - A user rule binding Mod+F to another command wins; a rule binding
     `chat.find` to another key opens find and disables the Mod+F fallback.
   - Enter and Shift+Enter navigate.
   - Escape closes, clears highlights, focuses the composer, and leaves the
     scroll offset unchanged.
   - Mod+F in the file editor, a terminal, or a preview does not open chat
     find.
   - Each status string appears; zero results disables Previous and Next.
   - Choosing **Find in thread** in the palette, then typing, puts the text in
     the find input. Other palette actions still return focus to the composer
     (the existing test at `CommandPalette.test.tsx:694`).
   - The palette lists **Find in thread** only with an open thread.
6. **Parity test.** Render a `ChatMarkdown` fixture corpus in happy-dom.
   Compare the DOM occurrence counts inside `[data-find-scope]`, excluding
   `[data-find-ignore]`, with the projection's counts over a set of queries.
   The corpus covers lists, tables, code, links, file links, skills,
   `<details>`, `<kbd>`, `<br>`, sanitized raw HTML, and both `lineBreaks`
   settings.
7. **Privacy test.** With spies on `console` and the client collector's batch
   builder, a search over a thread containing a sentinel string never passes
   that string to either.
8. **Keybindings and compatibility.**
   - Contracts decode a resolved list that names `chat.find`.
   - Older client: a fixture copy of the v0.11.0 command list decodes
     `DEFAULT_RESOLVED_KEYBINDINGS` built from the shipped defaults, so the
     defaults name no command an older client lacks.
   - Newer client: a fixture of a v0.11.0 server's resolved list decodes with
     the current schema, and the Mod+F fallback is active.
   - The Settings `when` list includes `chatFocus`.
   - The server's keybinding tests still parse the unchanged defaults.

## Verification

- **Focused tests.**
  `vp run --filter @bibcode/web test threadFind MessagesTimeline ChatMarkdown ChatView CommandPalette keybindings KeybindingsSettings`,
  and `vp run --filter @bibcode/contracts test keybindings`.
- **Gates.** `vp check` and `vp run typecheck`. If Rust is touched:
  `cargo fmt --all --check`, the affected Rust tests, and Clippy with warnings
  denied for the desktop crate when `window.rs` changes.
- **Reviews.** Record the UI.md review and the `vercel-react-best-practices`
  review of the bar, the controller, the palette change, and the timeline
  changes.
- **Packaged validation**, added to `docs/testing/cross-platform-validation.md`:
  on macOS (WKWebView), Linux (WebKitGTK AppImage), and Windows (WebView2),
  open a long thread with folded turns. Then:
  - find a word that appears only in a folded turn, a tool command inside a
    collapsed group, a file chip, and a long plan;
  - step through with Enter, Shift+Enter, Mod+G, and F3;
  - check that highlights paint and the active match is distinct in light and
    dark;
  - open find in a chat panel while the host chat's find is open, and check
    that the host's closes;
  - open find from the command palette and type at once;
  - Escape focuses the composer;
  - on Windows, Ctrl+F, F3, and Ctrl+G open no native find bar.
- **Performance.** Measure the three Performance fixtures against their
  budgets, with the profiler on: no new `client.stall` or `client.interaction`
  finding while searching. Record whether the worker escalation was needed.
- **Documentation.** The testing runbooks are reviewed and updated in the same
  change.

## Rollout

- **One PR.** The change is client-only and needs no flag or capability: it
  works with any server, because it uses only the thread snapshot and a
  built-in shortcut.
- **Older and newer servers.** Mod+F works against any server, because it does
  not depend on a server-sent rule. Updated servers send the same keybinding
  list as before, so older clients are unaffected.
- **Follow-up issues.** Per-rule tolerant decoding of resolved keybindings (or
  server-side command validation), and the keybindings.md discrepancy above.
  Once older clients tolerate unknown commands, a later release may move Mod+F
  into the shipped defaults.
- **Changelog.** The changelog entry names the shortcut and the search scope.

## Risks

- **Projection drift from the renderer.** Sharing the plugin lists removes most
  drift, but the custom components are still mirrored. A `ChatMarkdown`
  change, #171, or #172 can shift occurrence indexes. The parity test catches
  it in CI. At run time, a missing occurrence falls back to the row ring rather
  than highlighting the wrong text.
- **LegendList positions for rows it has not measured.** A first jump lands
  near the row rather than on it. The settle loop corrects it, but tests that
  depend on layout can be flaky. Assert intent (the index requested, the range
  painted), not pixel positions.
- **Deferred list scrolls.** Superseding relies on LegendList 3.3.10's request
  tracker. A LegendList upgrade must keep the supersede test passing.
- **The first-index cost on very long threads, and very large messages.** It is
  measured with three fixtures; the worker (alternative F) has a defined
  trigger.
- **The WebView2 accelerator order.** It is unverified until the Windows run;
  the host-handler fix is scoped above.
- **Degraded engines.** macOS 11 and older Firefox get the ring only.
- **Keybinding decode hazard.** A user rule naming `chat.find` breaks the
  config decode of an older client connected to the same server. It is
  documented, and it is the same hazard every new command has today.
- **Merge conflicts with #142** over the moved disclosure state. Agree the
  merge order before implementation.
- **Memory.** While find is in use, the cache roughly doubles the text memory
  of the open thread. It is bounded to that thread and released when the
  timeline unmounts.

## Review

Codex reviewed the first draft. Each finding was checked against source before
it was applied.

1. **Major: a `chat.find` default breaks older clients.** Accepted. The
   server checks command length only, and the client's closed command list
   fails the whole `ServerConfig` decode; a decode of a list naming
   `chat.find` failed when tried. The review also found that defaults reach
   only users without `keybindings.json`. The default rule is dropped. Mod+F
   is a built-in fallback, `chat.find` stays bindable, and both version
   directions are tested (Command and keybinding; Protocol; Test plan 8). The
   draft's claim that an older server rejects the rule was wrong and is
   removed.
2. **Major: a command behind both a fold and a group is unreachable.**
   Accepted. Groups are built after folded entries are removed, so a group's
   id and hidden part depend on the fold. `locateTimelineEntry` now returns
   one complete plan computed under the opened set (Revealing, step 1; Test
   plan 3 and 4).
3. **Major: chip labels were counted but not highlighted.** Accepted. Chat
   chip labels are selectable text. They are now inside the scope, only icons
   and tooltips are ignored, and the Non-goals no longer list Markdown chips
   (Highlighting; Test plan 1 and 6).
4. **Major: a deferred LegendList scroll can jump after close.** Accepted.
   Pending scrolls are superseded with a zero-distance `scrollToOffset`, which
   LegendList's request tracker treats as a new request, and a resolved scroll
   is checked against the row's current index (Revealing, step 4; Test
   plan 4).
5. **Major: panels share the highlight registry with no owner.** Accepted. One
   find is open per document, with a single registry owner (Highlighting;
   Test plan 4).
6. **Minor: failure handling assumed an error replaces the timeline.**
   Accepted. The cache survives a stream error and the banner sits above the
   timeline. Find now reads the thread's status and error atoms and defines
   each state (Failure; UI behavior).
7. **Minor: no focus handoff from the command palette.** Accepted. Palette
   items gain an optional post-close focus target, and the existing composer
   behaviour stays the default (Command and keybinding; Test plan 5).
8. **Minor: 8 ms slices cannot bound one large parse.** Accepted. 8 ms is now a
   scheduling target, with large-message and streaming fixtures and a measured
   trigger for the worker (Performance). The streaming cost was overstated as
   a risk: react-markdown already parses the whole message on every render.

**The simpler alternative.** Adopted in part. One active find per document
(finding 5), labelling a cached copy (finding 6), and projecting through the
renderer's own pipeline, which removes the mirrored sanitizer rules. Dropping
tool commands is offered as alternative G for the user to decide; it is the
item that requires the work-group reveal. The server-test substitution still
needs approval.
