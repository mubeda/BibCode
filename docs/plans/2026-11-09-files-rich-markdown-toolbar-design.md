# Rich Markdown editing in Files

Status: Approved 2026-11-09 (pre-approved: reviewed by Codex and the advisor)

Issue #342. Requirements R24 to R35 and decisions D7, D8, D14, D15, D16 and D20 of
[the batch spec](./2026-11-09-issue-batch-340-345-290/spec.md), section F. Plan phase:
[Phase 6](./2026-11-09-issue-batch-340-345-290/phases/PHASE-06-rich-markdown-editing.md).
Verified against `main` at `3d3a08efd` and Orca at
`94dab9fc697be8c1ea6dc94c13661d9f7ca23980`. Line references are to those commits.

## Problem and scope

A Markdown file in Files is edited only in source view. The rendered view is
`ChatMarkdown` (`FilePreviewPanel.tsx:717-755`), so Undo and Redo are off there
(`FilePreviewPanel.tsx:986-987`). The only edit it supports is a task checkbox, which calls
`changeOutsideEditor` and throws away the Pierre editor and its history
(`fileEditingSession.ts:340-345`).

This change makes the rendered view of a `.md` file an editor. It adds a formatting group
between Redo and the view toggle with Orca's toolbar set (paragraph, heading 1 to 3, bold,
italic, strikethrough, bullet, numbered and task list, quote, link, image, and a More menu
with heading 4, heading 5 and a collapsible section). Saves go through the existing
`FileEditingSession` and `FileSaveCoordinator`, so explicit save, autosave, conflict
detection and the reload-or-overwrite choice stay as they are (R29).

In scope: R24 to R35. Out of scope (spec Non-goals): shortcuts beyond the editor's
defaults, image paste, slash-menu extras, `.mdx` rich editing and a third preview mode.

## Alternatives

1. TipTap with `@tiptap/markdown`, as Orca does. Chosen (D7). TipTap already implements
   every command of the toolbar set, Orca's `details` extension ports with small changes,
   and the Markdown parser and serializer come with the package.
2. Lexical, which is installed. Rejected (D7). It is used only as a plain-text composer
   here. The toolbar commands, a Markdown parser and serializer for lists, tables, task
   lists and `details`, and the source-preserving save would all be new code.
3. Make `ChatMarkdown` editable in place. Rejected. It renders through `react-markdown`
   and `rehype-sanitize` and has no document model, selection or history.

## Packages

All packages are pinned to `3.31.4`, published 2026-09-30, the last patch of the line Orca
uses (Orca pins `3.31.3`). The 3.32 and 3.33 lines are newer than two weeks on 2026-11-09
or fix nothing this design needs. Licenses were read with
`npm view <name>@3.31.4 license` on 2026-11-09. Sizes are `dist.unpackedSize`.

| Package                        | License | Unpacked | Why                                                                                 |
| ------------------------------ | ------- | -------- | ----------------------------------------------------------------------------------- |
| `@tiptap/core`                 | MIT     | 3.2 MB   | The editor, commands and the extension system                                       |
| `@tiptap/pm`                   | MIT     | 15 kB    | ProseMirror, required by every extension (it pulls the `prosemirror-*` packages)    |
| `@tiptap/starter-kit`          | MIT     | 54 kB    | Paragraph, headings, marks, lists, quote, code, hard break, history                 |
| `@tiptap/markdown`             | MIT     | 483 kB   | Markdown parse and serialize through `marked` 17 (MIT, transitive)                  |
| `@tiptap/extension-list`       | MIT     | 1.2 MB   | Task list and task item, imported directly                                          |
| `@tiptap/extension-table`      | MIT     | 773 kB   | GFM tables, which must stay editable (R25, R34)                                     |
| `@tiptap/extension-image`      | MIT     | 66 kB    | Inline image nodes for Insert image (R28)                                           |
| `@tiptap/extension-details`    | MIT     | 128 kB   | The `details`, `detailsSummary` and `detailsContent` nodes (R35)                    |
| `@tiptap/extension-code-block` | MIT     | 87 kB    | Extended so a fence is longer than any backtick run in the code (added in Task 6.9) |

`@tiptap/extension-details` declares `@tiptap/extension-text-style` (MIT, 429 kB) as a
peer but never imports it at run time. It is not a direct dependency. pnpm installs it as
an automatic peer, and the lockfile records it.

Dropped from Orca's list, because the toolbar set does not need them:
`@tiptap/react` (the editor mounts on a DOM element through `@tiptap/core`),
`@tiptap/extension-code-block-lowlight` and `lowlight` (no syntax colors in fenced code),
`@tiptap/extension-mathematics` and `katex` (math keeps a file read-only),
`@tiptap/extension-placeholder`, a direct `marked` (it arrives through `@tiptap/markdown`)
and `@sanity/diff-match-patch` (the reconcile below uses the installed `remark-parse`).

Each direct package gets a ledger entry `js:apps/web:<name>` in
`docs/dependency-upgrades/2026-07-17-ledger.json`, and `inventorySummary.javascriptDirect`
and `javascriptLedger` rise by the number added.

## Editor schema

`createRichMarkdownEditor({ body, element, onUpdate })` in
`apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts` builds one
`@tiptap/core` `Editor` with these extensions.

- `StarterKit` with `underline` and `trailingNode` turned off. Underline has no Markdown
  form, and a trailing empty paragraph would add a block the file does not have. It
  supplies document, text, paragraph, heading (levels 1 to 6 parse, the toolbar offers 1
  to 5), bold, italic, strike, inline code, code block, block quote, bullet list, ordered
  list, list item, hard break, horizontal rule, gap cursor, drop cursor, Undo and Redo
  history, and the link mark. The link is configured through
  `StarterKit.configure({ link: { openOnClick: false, autolink: false } })`, because
  `@tiptap/extension-link` is not a direct dependency and pnpm does not let the client
  import it. A click places the caret, and typing a URL does not create a link the person
  did not ask for.
- `CodeBlock` from `@tiptap/extension-code-block` replaces StarterKit's code block. Its
  `renderMarkdown` writes a fence one backtick longer than the longest backtick run in the
  code, at least three. The stock serializer always writes three, so a three-backtick line
  inside a four-backtick fence closed it early (found in Task 6.9).
- `TaskList` and `TaskItem` (`nested: true`). A checkbox click changes the node's
  `checked` attribute, which the reconcile turns into a change of that item's marker only
  (R25).
- `TableKit` with `resizable: false`: table, row, header and cell.
- `Image` with `inline: true`, because Markdown puts images inside paragraphs.
- The `details` node with its summary and body, ported from Orca (see Files ported).
  It parses an HTML `<details>` block whose only children are a `<summary>` and Markdown
  body, and serializes to `<details>\n<summary>...</summary>\n\nbody\n\n</details>` without
  Orca's `class="orca-details"` and `data-orca-toggle` attributes. A `details` block with
  any other attribute than `open`, or with HTML inside its body, is not parsed as a node;
  the read-only rule catches it first.
- `Markdown` from `@tiptap/markdown`, with GFM on.

One serializer change keeps adjacent lists apart. TipTap writes every bullet item as `- `
(`extension-list` `ListItem.renderMarkdown`). Two adjacent lists that differ only in their
marker (`* a` then `- b`) are two lists in CommonMark, but the serialization merges them
into one (prototype: `* a\n- b` serializes as `- a\n\n- b`). A `marker` attribute on
`bulletList`, read from the first character of the list token's `raw`, is written back by
the list item's `renderMarkdown`. This keeps the tree of the serialization equal to the
file's, which `canReconcile` requires. Ordered delimiters (`1)`) and task-list markers
(`* [ ]`) are not kept by the serializer. The reconcile restores them from the original
head (step 3 and 4 below), so they need no schema change.

The `RichMarkdownEditor` handle hides TipTap from the rest of the client: `canUndo`,
`canRedo`, `undo()`, `redo()`, `isActive(name)`, `run(command)`, `subscribe(listener)`,
`serialize()` and `destroy()`. Task 6.6 adds `currentLink()`, `setLink(href)` and
`removeLink()`, and Task 6.7 adds `insertImage(relativePath)`. `run` maps each
`FormatName` to one TipTap command: `setParagraph`, `toggleHeading({ level })`,
`toggleBold`, `toggleItalic`, `toggleStrike`, `toggleBulletList`, `toggleOrderedList`,
`toggleTaskList`, `toggleBlockquote`, and `insertDetails` for the collapsible section,
which inserts an open `details` with the summary "More" selected. Link and image are not
`run` commands; the group calls `onLink` and `onImage` instead.

## Source-preserving save

The editor serializes canonical Markdown, which is not the file's text: setext headings
become `#` headings, table padding changes, a four-backtick fence becomes three. Saving
that text would rewrite parts the person did not touch (an anti-goal, R31, R33). The save
therefore reconciles three texts, in
`apps/web/src/components/files/richMarkdown/markdownReconcile.ts`.

- `original`: the file body (after the frontmatter) as it was when the rendered view
  opened.
- `before`: the editor's serialization right after it loaded `original`.
- `after`: the editor's serialization now.

Each text is parsed with the installed `unified`, `remark-parse` and `remark-gfm` into a
tree of block nodes with source offsets. Containers are the root, `list`, `listItem`,
`blockquote`, `table` (its rows are the children) and `details`. A `details` container is
made from an `html` node that opens `<details`, the nodes up to the `html` node that closes
`</details>`, or from one `html` node holding the whole element. Every other node is a
leaf. A container's head is its text before its first child (a list item's marker, `> `,
the opening `<details>` and `<summary>`) and its tail is its text after the last child.

A `details` written as one HTML block (no blank line between its tags and its body) is a
leaf for the reconcile: an edit inside it rewrites that block only. The blank-line form,
which the editor writes and which GitHub documents, is a container.

`canReconcile({ original, before })` is true when the two documents are the same document:
their trees, with positions, list `spread` and adjacent-text splits removed and `details`
grouped, are deeply equal. That covers block kinds and order at every level and the inline
content of every leaf. The rendered view opens editable only when it is true. When it is
false the panel shows today's read-only view with the read-only notice, so an edit can
never cause a whole-file rewrite. The inline check matters: a prototype on 2026-11-09
showed TipTap 3.31.4 dropping the link of `[![a](b.png)](https://c.test)`, writing
`&copy;` and `&nbsp;` back as `&amp;copy;` and `&amp;nbsp;`, and turning
`[a](<b c.md>)` into an invalid link. A file with any of these fails the check and opens
read-only, instead of losing the link in the block the person edits.

`reconcileMarkdown({ original, before, after })` builds the output from `after`'s
structure, level by level, starting at the root.

1. Pair `before` children with `after` children by the longest common subsequence of a
   key. The key is the node's source text, except for a list item, whose key is the text
   after its head plus its checkbox state, so a renumbered ordered item still matches. A
   common prefix and suffix are trimmed first, so a one-block edit costs one comparison
   per block.
2. A matched child is emitted with `original`'s bytes for the `before` child in the same
   position (`canReconcile` guarantees the positions line up). One exception: when the
   match is ambiguous, because a deleted or inserted neighbour has the same key and a
   different original spelling, the child is emitted with `after`'s text. Codex's example
   is `Title\n=====` followed by `# Title` with the first heading deleted: both serialize
   as `# Title`, so the reconcile cannot know which original survived.
3. Between matches, unmatched `before` and `after` children of the same container kind
   are paired in order and the reconcile recurses into them. Their tail comes from
   `original`. Their head comes from `original`, patched where `before` and `after`
   differ: a list item keeps its original bullet character, delimiter and spacing and
   takes only the checkbox character from `after`, so ticking `-   [ ] Keep` gives
   `-   [x] Keep`. A `details` head (the opening tag and summary) is taken from `after`
   when the summary changed.
4. Any other unmatched `after` child, a changed leaf or an inserted block, is emitted with
   `after`'s text. An inserted list item gets the list's original bullet character or
   delimiter in its head. Unmatched `before` children are dropped.
5. Between two emitted children that both have an original, the separator is
   `original`'s text after the first of them up to the next original node, so a deleted
   block between them is not copied back. In every other case it is `after`'s separator.
6. Text taken from `after` inside a container has its continuation-line prefix (`> ` or
   the list indent, with markers read as spaces) replaced by `original`'s prefix at that
   place.
7. Text taken from `after` gets `original`'s dominant line ending (Orca's
   `detectDominantEol` rule: CRLF when CRLF lines are at least as many as LF lines).
8. The root's head and tail always come from `original`, so leading blank lines and the
   final-newline state survive (D16).

When `before` equals `after` the function returns `original` unchanged, which is R31's
untouched case.

The fallback covers an edit the reconcile cannot place cleanly, in two steps. First, each
top-level block that the reconcile rebuilt is parsed and compared, as a normalized tree,
with the `after` block it stands for. A block that differs is replaced by that `after`
block's text, so only the region that could not be placed comes from `after` and every
other block keeps its bytes. Second, the whole output is compared with `after` the same
way. If it still differs, the output is `after`. In both steps, each fenced code block in
the replacement text whose content equals the original block's content apart from line
endings gets the original content back, so mixed line endings inside a fence survive.
Frontmatter is outside the body. The output therefore parses to the document the person
saw and keeps fenced code contents and frontmatter (R33 "edit cannot be placed").

The surface keeps `original` and `before` for the whole visit and reconciles the current
`after` on each serialization, so every save of the visit is computed from the file as it
was opened. `original` and `before` are parsed once per visit. Each serialization costs
`getMarkdown()`, one `remark` parse of `after` and a parse of each rebuilt top-level block.
Task 6.3 measures this on a fixture near the 1 MB read limit. If it is too slow for the
300 ms debounce, a size limit for rich editing is an open question for the spec, not a
ruling.

## Frontmatter

`splitFrontmatter(source)` in `markdownSupport.ts` returns `{ frontmatter, body }`. The
frontmatter is a `---` block (YAML) or a `+++` block (TOML) at offset 0, through its
closing line and that line's terminator if it has one. Its bytes are kept exactly, so a
TOML block with no final newline stays that way (D16 rejects Orca's newline fix,
`markdown-frontmatter.ts:1-24`). A `---` line later in the file is a thematic break, not
frontmatter. `frontmatter + body` always equals `source`.

The editor gets only `body`. The surface shows the frontmatter above the editor as a
read-only block with the text "Edit frontmatter in source view", and every save prepends
the original frontmatter bytes to the reconciled body (R32).

## Read-only rule

`findUnsupportedConstruct(body)` parses `body` with `remark-parse` and `remark-gfm` and
returns the first construct the editor cannot represent, or null. Text inside fenced or
indented code never counts, because code is a leaf whose text is not inspected.

| Construct (R34)  | Detected as                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference-link` | a `linkReference`, `imageReference` or `definition` node                                                                                        |
| `footnote`       | a `footnoteReference` or `footnoteDefinition` node                                                                                              |
| `html-comment`   | an `html` node whose value starts with `<!--`                                                                                                   |
| `raw-html`       | any other `html` node, block or inline, that is not part of a `details` block                                                                   |
| `math`           | a `$$` line, or inline `$...$` in a text node by Pandoc's rule (no space after the opening `$`, none before the closing one, no digit after it) |

A `details` block counts as supported when its opening tag has no attribute other than
`open` and its `<summary>` holds plain text, matching what the ported tokenizer accepts.

`richMarkdownMode(path, source)` in `filePreviewMode.ts` returns `{ editable: true }`, or
`{ editable: false, reason }` with reason `"not-markdown"` (not `.md` or `.mdx`), `"mdx"`,
or the construct. `isMarkdownPreviewFile` is unchanged, so `.mdx` files still open in the
rendered view by default, read-only as today, with the notice. Setext headings, aligned
tables, nested lists and hand-written `details` blocks are supported (R34). Each is in the
test corpus with `canReconcile` true, and a failure there is a schema defect to fix, not a
fixture to mark unsupported.

A read-only rendered view keeps today's checkbox path (`setMarkdownTaskChecked` and
`changeOutsideEditor`), shows "This file uses Markdown that the editor cannot change
safely. Edit it in source view." above the text, and passes `editor: null` to the
formatting group. That path still discards the source history, as it does today (R34
"read-only as today"). Making it keep the history is a follow-up, listed under Risks.

## Undo and view switching

Undo history is per view (D14). Rendered view starts a fresh TipTap history each time it
is entered, and the toolbar's Undo and Redo use it there. Source view keeps the Pierre
editor's history, and each visit to rendered view arrives there as one undo step (D20).

The session gains three methods in `fileEditingSession.ts`.

- `changeFromRichEditor(contents)` records `contents` with `coordinator.change`, sets a
  pending-rich-edits flag and publishes. It does not touch or discard the Pierre editor.
  `changeOutsideEditor` stays as it is for the read-only checkbox path.
- `commitRichEdits()` first calls the registered flusher. If the flag is set and a Pierre
  editor instance exists, it closes the visit: it applies the difference between the
  editor's text and the session text with `editor.applyEdits(edits, true, true)`, the
  call the disk reload uses (`fileEditingSession.ts:571-573`), so the visit is one undo
  step. The edits come from the existing `diskReloadEdits`, computed when they are
  applied, against `localText()`. With no Pierre editor instance it does nothing, and the
  next attach seeds from the session text.
- `setPendingEditFlusher(flush)` registers the surface's function that delivers an edit
  still waiting on its 300 ms timer. The surface registers it when an edit starts waiting
  and clears it once the edit is delivered. `flush()`, `settle()`, `commitRichEdits()`,
  `beginDiskCheck()` (before a disk check classifies a change or a deletion),
  `reloadFromDisk()`, `overwriteDisk()` and `rename()` call it first. The registry's file
  switch calls `flush()` and a path mutation calls `settle()`, so both deliver the edit
  without a registry change.

The Pierre editor is detached while rendered view is shown. `cleanUp` drops its text
document, and `applyEdits` throws "Editor is not attached" (`editor.js:176-178` of
`@pierre/diffs` 1.3.6). So a commit on a detached editor appends the session text to a
list of closed visits, and the editor's `onAttach` callback applies each one in order as
its own undo boundary, after Pierre restores the cached document and its history. Two
visits with no source view between them (a file switch in between) stay two undo steps.
The `onChange` these edits cause does not call the coordinator at all: `change` would
mark a saved file unsaved again, and `adopt` would mark an unsaved rich edit as saved.
`discardEditor()` clears the list, because the next editor seeds from the session text.
This covers a visit whose edit was already saved before the switch: `retainedContents` is
then null, but Pierre restores its cached, older document, and the attach brings it up to
the session text. The phase file's Interfaces line says `commitRichEdits` applies the edit
itself. Applying it on attach is the smallest change that works with a detached editor,
and Task 6.2 reports it as a ruling.

While an edit waits on the timer the session snapshot's new `editPending` field is true.
The panel shows "Unsaved changes" and enables Save from it, so Save right after typing is
not disabled and delivers the edit through the flusher (R29).

`FilePreviewPanel` calls `commitRichEdits()` when the view switches to source and when
the rich surface unmounts. In rendered view it takes `canUndo`, `canRedo`, `onUndo` and
`onRedo` from the `RichMarkdownEditor` handle. Save calls `session.flush()` in both views.

The rich surface (`RichMarkdownSurface.tsx`) loads `session.unsavedContents ?? contents`,
so an unsaved source edit shows in rendered view (R30). It serializes 300 ms after the last
editor change, reconciles, prepends the frontmatter, and calls `changeFromRichEditor` only
when the result differs from the text it last delivered, so opening a file never marks it
changed (R31). The surface is keyed by `session.cacheKey`, which changes when a reload
from disk discards the document, so a reload or a disk change on a clean file remounts it
with the new text. IME composition reaches `session.setComposing` as in the source
surface.

A disk change or a deletion while a rich edit waits on the timer: `beginDiskCheck` calls
the flusher first, so the session has pending work when `reconcileVersion` and
`reconcileRead` run, and records a conflict instead of reloading or marking the file
deleted. Neither version is lost (R29).

## Insert image

The image control picks a file and copies it into the Markdown file's folder, then
inserts `![](name)` at the caret (D8, R28). No server change is needed (plan decision
P5). `useInsertImage` in `richMarkdown/useInsertImage.ts`:

1. Picks with `desktopBridge.pickFiles` when it exists, otherwise a hidden
   `<input type="file" accept="image/*">`. A file whose type or extension is not an
   image is refused before any upload, with an error toast.
2. Asks `projects.createUploadUrl` for `{ cwd, relativeDirectory, fileName }`, where
   `relativeDirectory` is the Markdown file's folder, and uploads with
   `desktopBridge.uploadFile({ url, path })` or `sendBrowserUpload(url, file)`.
3. On HTTP 409 (the name exists) it retries with `nextFreeFileName(name, attempt)`
   (`diagram.png`, 1 gives `diagram-1.png`), up to attempt 99, and never sends
   `overwrite=1`, so an existing file is never replaced.
4. On success it calls `editor.insertImage(fileName)` with the name URL-encoded the way
   Markdown link targets need, only if the editor and the Markdown file's path it started
   with are both still current. A move or rename of the Markdown file during the upload
   therefore inserts nothing, because the image sits in the old folder. A failed copy
   shows the Files error toast and inserts nothing.

## Files ported from Orca

Orca is MIT licensed, copyright 2026 Lovecast Inc. Every file below starts with a comment
naming Orca, its copyright line and the MIT license. Nothing imports from an Orca clone.

| Orca source                                                                                   | Target                                                                   | What changed                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/editor/rich-markdown/details/rich-markdown-details-extension.ts` | `apps/web/src/components/files/richMarkdown/detailsExtension.ts`         | Keeps the `details` tokenizer, `parseMarkdown`, `renderMarkdown`, summary `inline*` content and the Enter and Backspace handling. Drops the toggle-heading variants, i18n placeholders and the `orca-details` class. Adds the insert command. |
| `src/renderer/src/components/editor/rich-markdown/details/details-markdown-html.ts`           | `apps/web/src/components/files/richMarkdown/detailsExtension.ts`         | Keeps the `details` block matcher, the summary extractor and the editability check. Drops the variant and class attributes, so only `open` is accepted.                                                                                       |
| `src/renderer/src/components/editor/rich-markdown/commands/RichMarkdownToolbar.tsx`           | `apps/web/src/components/files/richMarkdown/RichMarkdownFormatGroup.tsx` | Keeps the control set, order and commands. Rebuilt on this repository's `Button`, `Tooltip` and `Menu` components with `aria-pressed` and disabled reasons.                                                                                   |
| `src/renderer/src/components/editor/rich-markdown/links/useLinkBubble.ts`                     | `apps/web/src/components/files/richMarkdown/RichMarkdownLinkPopover.tsx` | Keeps the rules: an empty URL removes the link, an empty selection inserts the URL as linked text. Rebuilt on this repository's `Popover`.                                                                                                    |
| `src/renderer/src/components/editor/rich-markdown/document/rich-markdown-source-reconcile.ts` | `apps/web/src/components/files/richMarkdown/markdownReconcile.ts`        | Only `detectDominantEol` is ported. The reconcile itself is new and block based, not Orca's text-patch approach.                                                                                                                              |
| `src/renderer/src/components/editor/rich-markdown/schema/rich-markdown-extensions.ts`         | `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`   | Keeps the StarterKit configuration idea and the inline image. Drops lowlight, math, literal HTML, document links, review highlights and the React node views.                                                                                 |

Not ported. Orca's `markdown-frontmatter.ts`, because `splitFrontmatter` is new and D16
requires the bytes unchanged. The tokenizer helpers the details files import
(`markdown-tokenizer-start`, `markdown-directive-tokenizer`, `markdown-fence-scanner`),
because `detailsExtension.ts` reimplements the two it needs in a few lines: the
tokenizer's start search and the check that a `</details>` tag is not inside a fence.
`useRichMarkdownPendingSerialization.ts`, because the 300 ms flush uses only its idea
(flush before save and before the editor is destroyed), written against this session's
flusher.

## Loading

`FilePreviewPanel` loads the surface with `lazy(() => import("./richMarkdown/RichMarkdownSurface"))`
only when a `.md` file is shown editable in rendered view. The Suspense fallback is the
existing read-only rendered view, so the text is on screen while the editor loads. The
format group, link popover and image hook import only types from
`richMarkdownExtensions.ts`, so TipTap stays in the lazy chunk.

Editor styles live in `richMarkdown/richMarkdown.css`, imported by the surface, on top of
the existing `.chat-markdown` classes so the editable view looks like today's rendered
view.

## Risks

- A Markdown shape the corpus does not cover can still differ between the file and the
  serialization. `canReconcile` makes such a file read-only at load instead of rewriting
  it, so the cost is a lost edit mode, not lost bytes.
- An edit inside a container with an unusual continuation prefix (lazy continuation
  lines) can take `after`'s spelling for that container's changed lines. The fallback
  check keeps the parsed document equal to what the person saw.
- Nine direct packages add about 6 MB unpacked to the install and one lazy chunk to
  the bundle. The chunk loads only when a Markdown file is shown in rendered view.
- The editable view replaces `ChatMarkdown` for editable `.md` files, so it gives up what
  `ChatMarkdown` adds on top of Markdown: syntax colors in fenced code, Mermaid diagrams
  and links that open on a plain click. These are accepted costs of making the rendered
  view the editor (spec non-goal: no third preview mode). Read-only files keep
  `ChatMarkdown`.
- An inserted or existing image shows in the editor through its relative path, which the
  browser resolves against the app, not the file. The saved Markdown is right.
  `ChatMarkdown` has no image source rewrite either (inferred: no match for an image
  handler in `ChatMarkdown.tsx` or `components/markdown/`), so this is not a regression.
- A read-only file's checkbox still discards the source history, as today. Routing it
  through `changeFromRichEditor` would keep the history, but R34 keeps read-only files as
  they are and the plan's test says that path is not used. It is a follow-up.
- `@tiptap/markdown` uses `marked`, whose parse can differ from `remark` on rare inputs.
  The `canReconcile` check at load compares the two, so a disagreement makes the file
  read-only.

## Test plan

Web tests run from `apps/web` with `node ../../scripts/run-local-vp.mjs test run --project unit <path>`.

- `fileEditingSession.test.ts`: a rich edit keeps the source editor and its history; three
  rich edits in one visit are one undo step; a rich edit is pending and `flush()` saves
  it; `commitRichEdits` without an editor does nothing; the flusher runs before `flush`,
  `settle`, a view commit, a disk check and a path mutation; a commit on a detached editor
  lands on the next attach as one step per visit. `pierreEditProvider.integration.test.tsx`:
  two source edits, `File` unmounted, a rich visit, `File` remounted, then three undos
  restore the original text with the real Pierre editor (R30).
- `markdownReconcile.test.ts` on `fixtures/corpus.ts` (frontmatter, aligned table,
  four-backtick fence with trailing spaces, mixed list markers, a nested fence in a list
  item, a list in a block quote, setext headings, a hand-written `details`, CRLF, a task
  list, reference links, a footnote, an HTML comment, a raw `<div>`, math): untouched
  returns `original`; a last-paragraph edit keeps every earlier byte; an insertion keeps
  its neighbours; CRLF stays CRLF; list item, block quote and `details` edits keep sibling
  bytes; an unplaceable edit keeps fenced code contents; the final-newline state never
  changes; `canReconcile` true and false cases (R31, R33).
- `markdownSupport.test.ts`: frontmatter split byte for byte, each unsupported construct,
  supported variants, code-fence false positives, `richMarkdownMode` for `.md`, `.mdx`,
  a footnote and `.txt` (R32, R34).
- `richMarkdownExtensions.test.ts`: every supported fixture loads and reconciles; an
  untouched editor reconciles to the original bytes; a paragraph edit and a table-cell edit
  change only their block or row; Undo and Redo; `destroy` (R25, R31, R34).
- `RichMarkdownSurface.test.tsx` and `FilePreviewPanel.test.tsx`: typing reaches the
  session; opening does not mark the file changed; frontmatter read-only and kept; Undo and
  Redo; list item, quote and table cell typing; one serialization per 300 ms burst; Save,
  view switch, file switch and rename deliver a pending edit; a disk change during the
  wait shows the conflict; an unmappable file and a footnote file open read-only with the
  notice and working checkboxes; the switch to source commits once; an unsaved source edit
  shows in rendered view; a conflict blocks the save; leaving the file autosaves (R25,
  R29, R30, R32, R34).
- `FileEditorToolbar.test.tsx` and `RichMarkdownFormatGroup.test.tsx`: the group sits
  between Redo and the toggle; accessible names; disabled with a reason without an editor;
  heading 2 then bold gives `## **Title**`; each command's Markdown; pressed state and
  toggle off; a collapsible section saves as `details` and reopens editable (R24, R26,
  R35).
- `RichMarkdownLinkPopover.test.tsx`: link selected text; an empty URL removes the link;
  the field shows the current URL; Escape changes nothing and returns focus (R27).
- `useInsertImage.test.tsx` and `fileTransfers.test.ts`: copy next to the file and link;
  a taken name gets `-1`; a failed copy inserts nothing; a non-image is refused; a late
  upload after the file closed inserts nothing; `nextFreeFileName` (R28).
- The packaged end-to-end test of R24 to R35 is written by Phase 8.

## Review handling

Codex (`gpt-6.1-sol`, read-only, 2026-11-09) and the advisor reviewed the first draft.
Each finding was checked against the code, the spec or a prototype before it was taken.

- Codex 1, a deleted block is copied back through the preserved separator. Fixed: step 5
  takes `original`'s text only up to the next original node.
- Codex 2, identical canonical blocks lose their identity (`Title\n=====` then `# Title`).
  Fixed: an ambiguous match is emitted with `after`'s text (step 2).
- Codex 3, the whole-document fallback changes mixed line endings inside an untouched
  fence. Fixed: the fallback is per top-level block first, and fenced code content that
  matches apart from line endings gets the original bytes back.
- Codex 4 and advisor 4, a deletion on disk during the 300 ms wait bypasses the flusher in
  `reconcileVersion`. Fixed: `beginDiskCheck` and `overwriteDisk` call the flusher.
- Codex 5, a read-only file's checkbox still discards the source history. Rejected for
  this change: R34 keeps read-only files "as today" and the phase file's Task 6.4 test
  asserts that path does not use `changeFromRichEditor`. Logged under Risks as a
  follow-up.
- Codex 6 and advisor 2, a changed list-item head is taken whole from `after`, losing the
  original spacing, bullet and delimiter, and an inserted ordered item renumbers its
  neighbours out of their matches. Fixed: list items match on their body and checkbox
  state, the original head is patched with only the checkbox character, and inserted
  items take the list's original bullet or delimiter (steps 1, 3 and 4).
- Codex 7, Save is disabled while an edit waits on the timer. Fixed: the snapshot's
  `editPending` enables Save and shows "Unsaved changes".
- Codex 8, one flag merges two rendered visits with no source attach between them.
  Fixed: closed visits are kept as a list and applied as separate undo boundaries.
- Codex 9, an upload that finishes after the Markdown file moved inserts a broken link.
  Fixed: the hook also checks the Markdown file's path.
- Advisor 1, the deferred commit on a detached Pierre editor is the real path and was
  untested. Fixed: commit on attach is specified, with the coordinator left alone, the
  list cleared by `discardEditor`, and the already-saved case covered. Task 6.2 adds a
  detached-editor unit case and an unmount, visit, remount integration case, and reports
  the Interfaces change as a ruling.
- Advisor 3, the fallback was too wide and its check compared block kinds only. Fixed:
  per-block fallback first, and both checks compare normalized trees with inline content.
- Advisor 5, inline content can be lost inside an edited block. Verified with a prototype
  (links around images dropped, `&copy;` and `&nbsp;` escaped, angle-bracket link targets
  broken). Fixed: `canReconcile` compares inline content too, so such files open
  read-only.
- Advisor 6, default-view regressions were not listed. Fixed: Risks lists Mermaid, code
  colors, plain-click links and image paths, with the image evidence.
- Advisor 7, importing `@tiptap/extension-link` directly breaks under pnpm, and the
  text-style peer was undecided. Fixed: the link is configured through StarterKit, and the
  peer is installed automatically, not as a direct dependency.
- Advisor 8, the ported-files table missed the tokenizer helpers and the pending
  serialization hook. Fixed: listed under "Not ported" with what replaces them.
- Advisor 9, the per-edit cost was understated. Fixed: the cost is stated and Task 6.3
  measures it near 1 MB, with a size limit as a spec question if needed.
- Advisor 10, the single-HTML-block `details` shape was undefined. Fixed: it is a leaf.
- Advisor nits, several visits as one step and the exact Status text. Fixed: visits are
  separate steps, and the Status line matches the phase file.
