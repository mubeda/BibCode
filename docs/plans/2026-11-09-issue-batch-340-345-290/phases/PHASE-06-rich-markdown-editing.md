# Phase 6: Rich Markdown editing in Files

- Goal: A `.md` file is editable in rendered view with a formatting toolbar, saves change only what was edited, and Undo, Redo and the existing save path keep working, with a reviewed design note and tests (#342).
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/files/**`, `apps/web/package.json`, `pnpm-lock.yaml`, `docs/dependency-upgrades/2026-07-17-ledger.json`, `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md`
- Must not touch: `apps/web/src/index.css` (Phase 7; editor styles go in `apps/web/src/components/files/richMarkdown/richMarkdown.css`), `apps/web/src/components/ChatMarkdown.tsx` and `apps/web/src/components/chat/**` (consume only), `apps/web/THIRD_PARTY_NOTICES.md`, `docs/user/workspace-ui.md`, `apps/desktop/e2e/**` (Phase 8), `apps/web/src/components/pipelines/**`, `apps/web/src/components/settings/**`, `apps/web/src/hooks/useTheme.ts`
- Skills: test-driven-development (each editing behavior starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for changed React components); ui-ux-pro-max (toolbar density, disabled states that explain themselves)
- Read first: `spec.md` section F (R24 to R35, D7, D8, D14, D15, D16, D20) and its Constraints (design notes, third-party code); `UI.md`; `AGENTS.md` (Implementation Quality, Task Completion Requirements); GitHub issue #342 section "How Orca does it" (`gh issue view 342`) for the Orca file names to port from
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files` exits 0. Opening a `.md` file in Files shows an editable rendered view with the formatting group between Redo and the view toggle.

Web test command used below, always run from `apps/web`: `node ../../scripts/run-local-vp.mjs test run --project unit <path>`, written as `WEBTEST <path>`.

Tasks in this phase run one after another, in the order their Depends on lines give (6.1, 6.2, 6.3, 6.8, 6.9, 6.4, 6.5, 6.6, 6.7); several of them change `richMarkdownExtensions.ts` and `FilePreviewPanel.tsx`. Round-1 phases do not run the repository-wide `vp run typecheck`, which also checks Rust; Phase 8 does.

Orca reference: clone `https://github.com/stablyai/orca` at commit `94dab9fc697be8c1ea6dc94c13661d9f7ca23980` into the session scratch folder, outside this repository. It is MIT licensed. Every file that copies or adapts Orca code starts with a comment naming Orca, its copyright line and the MIT license. Never import from the clone.

## Tasks

### Task 6.1: Write and review the design note

- Satisfies: support (unblocks 6.2 to 6.7; the spec's Constraints require a reviewed design note for #342)
- Depends on: none
- Files: create `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md`
- Interfaces: consumes `spec.md` section F and decisions D7, D8, D14 to D16 and D20; produces the design note sections named in step 1, which Tasks 6.2 to 6.7 read first. The names in the Interfaces lines of Tasks 6.2 to 6.7 are binding; the note may add detail, and a note that needs to change one of them logs a Ruling in `progress.md`.
- Skills: none
- Read first: `docs/plans/2026-11-07-git-manager-interactive-sign-in-design.md` (the house format for a design note); `docs/plans/README.md`; Orca `package.json` lines 282-294 and 343, and `src/renderer/src/components/editor/rich-markdown/` (extensions, serialization commit, source reconcile, frontmatter)
- Tier: most capable
- TDD: exempt (a design document has no behavior to test)
- Done when: the file exists, its first lines read `Status: Approved 2026-11-09 (pre-approved: reviewed by Codex and the advisor)`, it has a "Review handling" section with one line per finding, and `vp run check:markdown-links` exits 0

Steps

1. [ ] Write the note with these sections: Problem and scope (from the spec); Alternatives (TipTap chosen, Lexical rejected, with the reasons in D7); Packages (each new package with its exact version, license, unpacked size and why it is needed, starting from Orca's list and dropping what the toolbar set does not need); Editor schema (the nodes and marks for the toolbar set of R26 and the `details` block of R35); Source-preserving save (the block-level reconcile of Task 6.3, with its fallback); Frontmatter; Read-only rule (the construct list of R34 and how each is detected); Undo and view switching (D14, D20 and the session methods of Task 6.2); Insert image (D8 and the upload flow of Task 6.7); Files ported from Orca (source path, target path, what changed); Loading (the editor is loaded with `lazy(() => import(...))` only when a `.md` file is shown in rendered view); Risks; Test plan.
2. [ ] Check every package license with `npm view <name>@<version> license`. Expected: each prints MIT or another license compatible with this repository; a package that does not is replaced and the note says so.
3. [ ] Get a read-only Codex review of the note (`codex exec --sandbox read-only`, prompt: review this design against `spec.md` section F for gaps, contradictions and data-loss risks). Get a second review from the advisor tool when the session has one, otherwise from a fresh read-only subagent. Process both with `receiving-review.md`.
4. [ ] Fix every accepted finding in the note, list each finding and its outcome under "Review handling", and set the Status line. Standing rule: a design counts as approved once both reviews are resolved (spec decision D3).
5. [ ] Run `vp run check:markdown-links`. Expected: exits 0.

### Task 6.2: Let the session take rich edits without losing source history

- Satisfies: R30 (switch to source after a rich edit; several rendered edits in one visit; switch to rendered after a source edit)
- Depends on: 6.1
- Files: modify `apps/web/src/components/files/fileEditingSession.ts`; modify `apps/web/src/components/files/fileEditingSessionRegistry.ts`; test `apps/web/src/components/files/fileEditingSession.test.ts`; test `apps/web/src/components/files/pierreEditProvider.integration.test.tsx`
- Interfaces: consumes `FileEditingSession` (line 127) with `changeOutsideEditor` (340), `discardEditor` (605), the lazy `editor` getter (220), `editor.applyEdits(edits, true, true)` (as used at 571), `coordinator.change` and `publish`; produces `changeFromRichEditor(contents: string): void` (updates the save coordinator and publishes, does not touch or discard the Pierre editor, sets a pending flag) and `commitRichEdits(): void` (when the flag is set and a Pierre editor instance exists, applies one edit that replaces the smallest differing range so the whole visit is a single undo step; clears the flag; does nothing otherwise), and `setPendingEditFlusher(flush: (() => void) | null): void`: the registered function is called synchronously at the start of `flush()`, `settle()`, `commitRichEdits()`, a reload from disk and a path mutation, so a rich edit still waiting on the surface's 300 ms timer is delivered before any of them runs.
- Skills: none
- Read first: `apps/web/src/components/files/fileEditingSession.ts` lines 220-345 and 560-610; `apps/web/src/components/files/pierreEditProvider.integration.test.tsx` lines 166-204 (how undo boundaries are asserted)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/files/fileEditingSession.test.ts` and `WEBTEST src/components/files/pierreEditProvider.integration.test.tsx` exit 0 with the 6 new tests passing

Steps

1. [ ] Add `a rich edit keeps the source editor and its history`: make two source edits, call `changeFromRichEditor("...")` then `commitRichEdits()`, and assert the editor instance is the same object, `unsavedContents` is the rich text, and three `undo()` calls restore the original text step by step.
2. [ ] Add `several rich edits in one visit are one undo step`: three `changeFromRichEditor` calls then one `commitRichEdits()`; one `undo()` restores the text from before the visit.
3. [ ] Add `a rich edit marks the file as having unsaved changes and flush saves it`: after `changeFromRichEditor`, the snapshot phase is pending, and `flush()` writes the rich text.
4. [ ] Add `commitRichEdits without a source editor does nothing`: no editor was ever created; `commitRichEdits()` does not create one and `documentContents` is the rich text. Add `the pending edit flusher runs before flush, settle, a view commit and a path mutation` (the flusher delivers text through `changeFromRichEditor`, and each operation sees that text; the registry's file switch at `fileEditingSessionRegistry.ts` line 100 is covered too). The session unit test uses a fake editor, so also add to the real-editor file `pierreEditProvider.integration.test.tsx` the case `two source edits, a rich visit, then three undos restore the original text`, which proves the source history survives with the real Pierre editor.
5. [ ] Run `WEBTEST src/components/files/fileEditingSession.test.ts`. Expected: FAIL, `changeFromRichEditor is not a function`.
6. [ ] Implement both methods as described under Interfaces. Do not change `changeOutsideEditor`.
7. [ ] Run the same command. Expected: PASS.
8. [ ] Prove the test can fail: make `changeFromRichEditor` call `discardEditor()`, run the same command. Expected: FAIL in the first new test. Restore and run again. Expected: PASS.
9. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.3: Source-preserving reconcile

- Satisfies: R31 (untouched file), R33 (fence next to an edited paragraph; edit cannot be placed)
- Depends on: 6.2
- Files: create `apps/web/src/components/files/richMarkdown/markdownReconcile.ts`; create `apps/web/src/components/files/richMarkdown/markdownReconcile.test.ts`; create `apps/web/src/components/files/richMarkdown/fixtures/corpus.ts`
- Interfaces: consumes the installed `unified` and `remark-parse` packages for block positions; produces `canReconcile(input: { original: string; before: string }): boolean` (true when `before`, the editor's serialization at load, has the same tree of block nodes as `original`: the same kinds in the same order at every level of lists, block quotes and `details`), and `reconcileMarkdown(input: { original: string; before: string; after: string }): string` (`original` is the file body, `after` the editor's serialization now). The reconcile is recursive: an unchanged block is emitted with its `original` bytes at whatever depth it sits, so editing one list item keeps the bytes of its sibling items and of a fence nested in them.
- Skills: none
- Read first: the design note section "Source-preserving save"; Orca `rich-markdown-source-reconcile.ts` and `rich-markdown-serialization-commit.ts`
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/markdownReconcile.test.ts` exits 0 with at least 10 tests passing

Steps

1. [ ] Create `fixtures/corpus.ts` exporting named Markdown strings: frontmatter (YAML, and TOML with no final newline), a table with alignment, a fenced block with four backticks and trailing spaces, mixed `*` and `-` list markers, a list whose second item holds a nested four-backtick fence, a block quote holding a list, setext headings, a hand-written `details` block, CRLF line endings, a task list, reference-style links, a footnote, an HTML comment, a raw `<div>`, and inline and block math.
2. [ ] Write tests for `reconcileMarkdown`: (a) `before === after` returns `original` unchanged for every corpus fixture; (b) when only the last paragraph differs, every byte before that paragraph equals `original`, including the four-backtick fence; (c) a block inserted in the middle leaves the blocks before and after it byte-identical; (d) a CRLF original yields CRLF in the changed block; (e) when the first item of a list is edited, the bytes of the second item, including its nested fence and its `*` marker, equal `original`; (f) the same for an edit inside a block quote and inside a `details` body; (g) when the changed region cannot be matched to one place in `original` (two identical paragraphs and an edit between them), only that region is taken from `after`, and every fenced code block's contents still equal `original`; (h) the result never loses the final-newline state of `original`.
3. [ ] Write tests for `canReconcile`: true for every supported corpus fixture with a faithful `before`; false when `before` has one block fewer than `original`; false when a nested list in `before` has a different number of items.
4. [ ] Run `WEBTEST src/components/files/richMarkdown/markdownReconcile.test.ts`. Expected: FAIL, the module does not exist.
5. [ ] Implement the module. Parse `original`, `before` and `after` into block trees with source ranges; align `before` with `original` node for node (guaranteed by `canReconcile`); align `before` with `after` at each level by longest common subsequence of node text; emit `original` bytes for unchanged nodes, recurse into changed container nodes, and emit `after` text only for changed leaf blocks and inserted nodes.
6. [ ] Run the same command. Expected: PASS, at least 10 tests.
7. [ ] Prove the test can fail: stop recursing into containers (emit `after` for a whole changed list), run the same command. Expected: FAIL in (e) and (f). Restore and run again. Expected: PASS.
8. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.4: Editable rendered surface on the existing save path

- Satisfies: R25 (edit a paragraph; task checkbox still works), R29 (explicit save; file changed on disk), R30 (undo a rich edit), R32 (edit below frontmatter), R34 (unsupported construct; `.mdx`)
- Depends on: 6.9
- Files: create `apps/web/src/components/files/richMarkdown/RichMarkdownSurface.tsx`; modify `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`; create `apps/web/src/components/files/richMarkdown/richMarkdown.css`; create `apps/web/src/components/files/richMarkdown/RichMarkdownSurface.test.tsx`; modify `apps/web/src/components/files/FilePreviewPanel.tsx`; modify `apps/web/src/components/files/FilePreviewPanel.test.tsx`
- Interfaces: consumes `changeFromRichEditor` and `commitRichEdits` (Task 6.2), `reconcileMarkdown` and `canReconcile` (Task 6.3), `splitFrontmatter` and `richMarkdownMode` (Task 6.8), `createRichMarkdownEditor` and `RichMarkdownEditor` (Task 6.9), `RenderedMarkdownSurface` (FilePreviewPanel.tsx lines 717-755), the toolbar props built at lines 982-1024 and `session.flush()`; produces `RichMarkdownSurface` (default export, loaded with `lazy`) with props `{ session: FileEditingSession; contents: string; onEditorChange(editor: RichMarkdownEditor | null): void }`. The surface serializes 300 ms after the last change and registers that pending work with `session.setPendingEditFlusher` (Task 6.2), so Save, settle, a view switch, a file switch, a rename and a reload all deliver it first; it clears the registration on unmount after a final flush.
- Skills: none
- Read first: the design note sections "Packages", "Editor schema", "Undo and view switching" and "Loading"; `apps/web/src/components/files/FilePreviewPanel.tsx` lines 662-760, 795-831 and 981-1100; `docs/dependency-upgrades/2026-07-17-ledger.json` (entry shape and the `inventorySummary` counts that must match)
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/RichMarkdownSurface.test.tsx src/components/files/FilePreviewPanel.test.tsx` exits 0 with the 16 new tests passing

Steps

1. [ ] Read `RichMarkdownSurface` requirements in the design note sections "Undo and view switching" and "Loading" again and list, in the task's log line, the session methods the surface calls.
2. [ ] In `RichMarkdownSurface.test.tsx`, add: `typing in a paragraph updates the session text` (type " again" after "Hello world"; `session.unsavedContents` contains "Hello world again" and the snapshot is pending); `opening a file does not mark it changed` (mount and unmount with no input; `changeFromRichEditor` was never called); `frontmatter is shown read-only and kept on edit` (the frontmatter block is not editable, shows "Edit frontmatter in source view", and after a body edit the session text starts with the original frontmatter bytes); `undo and redo reverse a rich edit` (through the `RichMarkdownEditor` handle); `typing works in a list item, a block quote and a table cell` (three inputs, each reaches the session text in the right place); `rapid typing serializes once after 300 ms`; `Save, a view switch, a file switch and a rename each deliver a pending edit without advancing the clock` (four cases); `a disk change during the 300 ms wait shows the conflict choice and loses neither version`.
3. [ ] In `FilePreviewPanel.test.tsx`, add: `a markdown file opens editable in rendered view with undo enabled after an edit`; `a file the editor cannot map block for block opens read-only with the same notice` (when `canReconcile` is false at load the surface calls `onEditorChange(null)` and the panel shows the read-only view, so no edit can cause a whole-file rewrite); `a file with a footnote renders read-only with a notice and its task checkboxes still work` (the notice reads "This file uses Markdown that the editor cannot change safely. Edit it in source view." and `changeFromRichEditor` is not called); `switching to source after a rich edit commits it as one step` (`commitRichEdits` is called once on the switch, and Save calls `session.flush()` in both views); `an unsaved source edit is shown after switching to rendered view and Undo there starts empty` (R30); `a rendered edit on a file that changed on disk blocks the save and shows the reload-or-overwrite choice` (R29, using the existing conflict fixture); `leaving the file autosaves a rendered edit` (R29).
4. [ ] Run the command under Done when. Expected: FAIL, `RichMarkdownSurface` does not exist.
5. [ ] Implement `RichMarkdownSurface.tsx` on `createRichMarkdownEditor`: load the body through `splitFrontmatter`, keep the editor's serialization at load as `before`, report the file as not editable when `canReconcile` is false, and on every editor update compute `reconcileMarkdown({ original, before, after })`, prepend the frontmatter and call `session.changeFromRichEditor`. Compose with the existing input-method handling (`setComposing`). Style with the existing `.chat-markdown` classes plus `richMarkdown.css`.
6. [ ] In `FilePreviewPanel.tsx`, choose the surface from `richMarkdownMode`: `RichMarkdownSurface` (lazy, with a suspense fallback that renders the existing read-only view) when editable, otherwise the existing `RenderedMarkdownSurface` with the notice. In rendered view take `canUndo`, `canRedo`, `onUndo` and `onRedo` from the `RichMarkdownEditor` handle instead of forcing them off (lines 986-987). Call `session.commitRichEdits()` when the view switches to source and when the surface unmounts. A reload from disk or an overwrite remounts the surface with the new contents.
7. [ ] Run the same command. Expected: PASS.
8. [ ] Prove the test can fail: skip `reconcileMarkdown` and send the editor's serialization directly, run `WEBTEST src/components/files/richMarkdown/RichMarkdownSurface.test.tsx`. Expected: FAIL in `frontmatter is shown read-only and kept on edit`. Restore and run again. Expected: PASS.
9. [ ] Run `WEBTEST src/components/files`. Expected: PASS, including the existing checkbox, conflict, tab-switch and Pierre undo tests.
10. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.5: Formatting group and its commands

- Satisfies: R24 (order and availability; source view), R26 (heading and mark; active state), R35 (insert and reopen)
- Depends on: 6.4
- Files: create `apps/web/src/components/files/richMarkdown/RichMarkdownFormatGroup.tsx`; modify `apps/web/src/components/files/richMarkdown/detailsExtension.ts`; create `apps/web/src/components/files/richMarkdown/RichMarkdownFormatGroup.test.tsx`; modify `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`; modify `apps/web/src/components/files/FileEditorToolbar.tsx`; modify `apps/web/src/components/files/FileEditorToolbar.test.tsx`; modify `apps/web/src/components/files/FilePreviewPanel.tsx`
- Interfaces: consumes `RichMarkdownEditor` (Task 6.4), `FileEditorToolbar` and its private `ToolbarAction` (FileEditorToolbar.tsx lines 39 and 81; order Save 145, Undo 158, Redo 171, separator 186, toggle 194); produces `type FormatName = "paragraph" | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "bold" | "italic" | "strike" | "bulletList" | "orderedList" | "taskList" | "blockquote" | "link" | "details"`, `type FormatCommand = FormatName | "image"`, a new optional toolbar prop `formatting?: ReactNode` rendered between Redo and the separator, and `RichMarkdownFormatGroup` with props `{ editor: RichMarkdownEditor | null; onLink(): void; onImage(): void }`.
- Skills: better-accessibility (toolbar roles, names and pressed states)
- Read first: the design note section "Editor schema"; Orca `RichMarkdownToolbar.tsx` and `rich-markdown-details-extension.ts`; `UI.md` (Buttons and Actions: disabled states explain themselves)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/RichMarkdownFormatGroup.test.tsx src/components/files/FileEditorToolbar.test.tsx` exits 0 with the 7 new tests passing

Steps

1. [ ] In `FileEditorToolbar.test.tsx`, add `the formatting group sits between Redo and the view toggle`: with a `formatting` node, the accessible order is Save file, Undo, Redo, the group, then the view toggle. Add `no formatting group is rendered without the prop`.
2. [ ] In `RichMarkdownFormatGroup.test.tsx`, add: `every control has an accessible name` (Paragraph, Heading 1, Heading 2, Heading 3, Bold, Italic, Strikethrough, Bullet list, Numbered list, Task list, Quote, Link, Image, More formatting; the More menu holds Heading 4, Heading 5 and Collapsible section); `controls are disabled with a reason when there is no editor` (each has `aria-disabled` and the tooltip "Formatting is available in rendered view"); `heading 2 then bold serializes as a bold heading` (on "Title", the session text for that block is `## **Title**`); `each format command serializes as expected` (a table-driven test on the text "Item": paragraph `Item`, heading 1 to 5 `# Item` to `##### Item`, bold `**Item**`, italic `*Item*`, strikethrough `~~Item~~`, bullet list `- Item`, numbered list `1. Item`, task list `- [ ] Item`, quote `> Item`); `an active format shows as pressed and toggles off` (bullet list); `a collapsible section is saved as details with a summary and reopens editable` (the text contains `<details>` and `<summary>More</summary>`, and loading that text gives an editable `details` node).
3. [ ] Run the command under Done when. Expected: FAIL, `RichMarkdownFormatGroup` does not exist.
4. [ ] Add the insert command to `detailsExtension.ts` (the node itself exists from Task 6.9), register the `FormatName` commands in `richMarkdownExtensions.ts`, implement `RichMarkdownFormatGroup` with the existing `Button size="icon-xs"`, `Tooltip` and menu components, and add the `formatting` prop to `FileEditorToolbar`. In `FilePreviewPanel.tsx`, pass the group when the file is Markdown; pass `editor: null` in source view and for read-only files.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the test can fail: render `formatting` after the view toggle, run `WEBTEST src/components/files/FileEditorToolbar.test.tsx`. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Review the changed components against `vercel-react-best-practices` and `UI.md`, and record the results for the final report.
8. [ ] Run `WEBTEST src/components/files`, `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: PASS and no errors.

### Task 6.6: Link dialog

- Satisfies: R27 (link selected text; empty URL)
- Depends on: 6.5
- Files: create `apps/web/src/components/files/richMarkdown/RichMarkdownLinkPopover.tsx`; create `apps/web/src/components/files/richMarkdown/RichMarkdownLinkPopover.test.tsx`; modify `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`; modify `apps/web/src/components/files/FilePreviewPanel.tsx`
- Interfaces: consumes `RichMarkdownEditor` and the `onLink` prop of `RichMarkdownFormatGroup` (Task 6.5); produces on `RichMarkdownEditor`: `currentLink(): { href: string } | null`, `setLink(href: string): void` (links the selection, or inserts the URL as linked text when the selection is empty) and `removeLink(): void`; and `RichMarkdownLinkPopover` with props `{ editor: RichMarkdownEditor; open: boolean; onOpenChange(open: boolean): void }`, anchored to the selection.
- Skills: better-accessibility (focus moves into the dialog and returns to the editor)
- Read first: Orca `useLinkBubble.ts`; `apps/web/src/components/ui/popover.tsx`
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/RichMarkdownLinkPopover.test.tsx` exits 0 with 4 tests passing

Steps

1. [ ] Add tests: `linking selected text saves a Markdown link` (select "docs", enter `https://example.test/docs`, confirm; the text is `[docs](https://example.test/docs)`); `an empty URL removes the link and keeps the text`; `the field shows the current URL when the caret is in a link`; `Escape closes the dialog, changes nothing and returns focus to the editor`.
2. [ ] Run `WEBTEST src/components/files/richMarkdown/RichMarkdownLinkPopover.test.tsx`. Expected: FAIL, the component does not exist.
3. [ ] Implement the three editor methods and the popover with a labelled URL field, a Save button and a Remove link button that is shown only when a link exists.
4. [ ] Run the same command. Expected: PASS, 4 tests.
5. [ ] Prove the test can fail: make an empty URL call `setLink("")`, run the same command. Expected: FAIL in the second test. Restore and run again. Expected: PASS.
6. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.7: Insert image

- Satisfies: R28 (new image; name taken or copy fails)
- Depends on: 6.6
- Files: create `apps/web/src/components/files/richMarkdown/useInsertImage.ts`; create `apps/web/src/components/files/richMarkdown/useInsertImage.test.tsx`; modify `apps/web/src/components/files/fileTransfers.ts`; modify `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`; modify `apps/web/src/components/files/FilePreviewPanel.tsx`
- Interfaces: consumes `projects.createUploadUrl` with input `{ cwd, relativeDirectory, fileName }` (packages/contracts/src/transfer.ts line 26), `sendBrowserUpload(url, file)` and `interpretUploadResponse` (fileTransfers.ts lines 119 and 151, where HTTP 409 means the name exists), and the optional `desktopBridge.pickFiles` and `desktopBridge.uploadFile({ url, path })` (packages/contracts/src/ipc.ts lines 1355 and 1361); produces in `fileTransfers.ts` `nextFreeFileName(name: string, attempt: number): string` (`diagram.png`, 1 gives `diagram-1.png`), in `richMarkdownExtensions.ts` `insertImage(relativePath: string): void` on `RichMarkdownEditor`, and `useInsertImage(input: { cwd: string; environmentId: string; markdownPath: string; editor: RichMarkdownEditor | null }): { pick(): void; inputProps: InputHTMLAttributes<HTMLInputElement> }`.
- Skills: none
- Read first: the design note section "Insert image"; `apps/web/src/components/files/useFileTransfers.ts` lines 90-270 (the upload flow and its error reporting; do not reuse its replace dialog); `apps/web/src/components/files/fileTransfers.test.ts`
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/useInsertImage.test.tsx src/components/files/fileTransfers.test.ts` exits 0 with the 6 new tests passing

Steps

1. [ ] In `fileTransfers.test.ts`, add `nextFreeFileName adds a numbered suffix before the extension`: `("diagram.png", 1)` gives `diagram-1.png`, `("archive.tar.gz", 2)` gives `archive.tar-2.gz`, `("README", 1)` gives `README-1`.
2. [ ] In `useInsertImage.test.tsx`, add: `a picked image is copied next to the markdown file and linked` (`docs/guide.md` and `diagram.png`: `createUploadUrl` is called with `relativeDirectory: "docs"` and `fileName: "diagram.png"`, and `insertImage("diagram.png")` is called once); `a taken name gets a numbered suffix and nothing is overwritten` (first upload answers 409, second succeeds: the second `fileName` is `diagram-1.png`, no request carries `overwrite=1`, and `insertImage("diagram-1.png")` is called); `a failed copy shows an error and inserts nothing`; `a non-image file is refused before any upload`; `an upload that finishes after the file was closed or replaced inserts nothing` (the hook compares the editor it started with against the current one).
3. [ ] Run the command under Done when. Expected: FAIL, `useInsertImage` does not exist.
4. [ ] Implement `nextFreeFileName`, `insertImage` (inserts `![](<relative path>)` at the caret) and `useInsertImage`: use `desktopBridge.pickFiles` and `uploadFile` when they exist, otherwise a hidden `<input type="file" accept="image/*">` and `sendBrowserUpload`; on 409 retry with `nextFreeFileName` up to attempt 99; report failures through the existing toast used by Files. Wire `pick` to the group's `onImage` in `FilePreviewPanel.tsx`.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the test can fail: make the 409 retry send `overwrite=1` instead of a new name, run the same command. Expected: FAIL in the taken-name test. Restore and run again. Expected: PASS.
7. [ ] Run `WEBTEST src/components/files`, `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: PASS and no errors.
8. [ ] Review every component and hook this phase changed against `vercel-react-best-practices` and `UI.md`, and record the results for the final report.

### Task 6.8: Frontmatter split and the read-only rule

- Satisfies: R32 (edit below frontmatter), R34 (unsupported construct; representable variants stay editable; `.mdx`)
- Depends on: 6.3
- Files: create `apps/web/src/components/files/richMarkdown/markdownSupport.ts`; create `apps/web/src/components/files/richMarkdown/markdownSupport.test.ts`; modify `apps/web/src/components/files/filePreviewMode.ts`
- Interfaces: consumes `isMarkdownPreviewFile` (filePreviewMode.ts line 1) and the corpus of Task 6.3; produces `splitFrontmatter(source: string): { frontmatter: string; body: string }` (YAML `---` and TOML `+++`, bytes kept exactly), `type UnsupportedConstruct = "reference-link" | "footnote" | "raw-html" | "html-comment" | "math"`, `findUnsupportedConstruct(body: string): UnsupportedConstruct | null` (a `details` block is not `raw-html`), and in `filePreviewMode.ts` `richMarkdownMode(path: string, source: string): { editable: true } | { editable: false; reason: UnsupportedConstruct | "mdx" | "not-markdown" }`.
- Skills: none
- Read first: the design note sections "Frontmatter" and "Read-only rule"; Orca `markdown-frontmatter.ts`
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/markdownSupport.test.ts` exits 0 with at least 9 tests passing

Steps

1. [ ] Write tests for `splitFrontmatter`: YAML and TOML blocks are returned byte for byte, a file without frontmatter returns an empty string, a `---` rule in the middle of a file is not frontmatter, and `frontmatter + body` always equals the source.
2. [ ] Write tests for `findUnsupportedConstruct`: each of the five kinds is found in its corpus fixture; the setext, aligned table, nested list and `details` fixtures return `null`; text that only looks like a construct inside a fenced code block returns `null`.
3. [ ] Write tests for `richMarkdownMode`: `notes.md` with supported content is editable; `notes.mdx` gives `mdx`; `notes.md` with a footnote gives `footnote`; `notes.txt` gives `not-markdown`.
4. [ ] Run `WEBTEST src/components/files/richMarkdown/markdownSupport.test.ts`. Expected: FAIL, the module does not exist.
5. [ ] Implement the module and `richMarkdownMode`. Leave `isMarkdownPreviewFile` as it is.
6. [ ] Run the same command. Expected: PASS, at least 9 tests.
7. [ ] Prove the test can fail: make `findUnsupportedConstruct` scan fenced code contents, run the same command. Expected: FAIL. Restore and run again. Expected: PASS.
8. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.9: Editor packages, schema and a faithful round trip

- Satisfies: R25 (edit a paragraph), R31 (untouched file), R34 (representable variants stay editable)
- Depends on: 6.8
- Files: modify `apps/web/package.json`; modify `pnpm-lock.yaml`; modify `docs/dependency-upgrades/2026-07-17-ledger.json`; create `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.ts`; create `apps/web/src/components/files/richMarkdown/detailsExtension.ts`; create `apps/web/src/components/files/richMarkdown/richMarkdownExtensions.test.ts`
- Interfaces: consumes the package list of the design note, `canReconcile` and `reconcileMarkdown` (Task 6.3), `findUnsupportedConstruct` (Task 6.8) and the corpus; produces `type FormatName` and `type FormatCommand` (declared here as string unions that Task 6.5 fills), `type RichMarkdownEditor = { canUndo: boolean; canRedo: boolean; undo(): void; redo(): void; isActive(name: FormatName): boolean; run(command: FormatCommand): void; subscribe(listener: () => void): () => void; serialize(): string; destroy(): void }`, and `createRichMarkdownEditor(input: { body: string; element: HTMLElement | null; onUpdate(): void }): RichMarkdownEditor`.
- Skills: none
- Read first: the design note sections "Packages" and "Editor schema"; `docs/dependency-upgrades/2026-07-17-ledger.json` (entry shape and the `inventorySummary` counts that must match); Orca `rich-markdown-extensions.ts`
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/components/files/richMarkdown/richMarkdownExtensions.test.ts` exits 0 with at least 6 tests passing and `vp run check:dependency-ledger` exits 0

Steps

1. [ ] Check free disk space with `df -h .`. Expected: at least 60 GB free. Add the packages the design note lists to `apps/web/package.json` with exact versions, run `pnpm install`, add one ledger entry per package (key `js:apps/web:<name>`) and raise `inventorySummary.javascriptDirect` and `javascriptLedger` by the number added. Run `vp run check:dependency-ledger`. Expected: exits 0.
2. [ ] In `richMarkdownExtensions.test.ts`, add: `every supported corpus fixture loads and can be reconciled` (`canReconcile({ original, before: editor.serialize() })` is true for each fixture that `findUnsupportedConstruct` accepts, including setext headings, the aligned table, the nested list and the hand-written `details`); `an untouched editor reconciles to the original bytes` (for the same fixtures); `typing in a paragraph changes only that block after reconcile`; `typing in a table cell changes only that row`; `undo and redo are reported and work`; `destroy releases the editor`.
3. [ ] Run `WEBTEST src/components/files/richMarkdown/richMarkdownExtensions.test.ts`. Expected: FAIL, the module does not exist.
4. [ ] Implement `createRichMarkdownEditor` with the nodes and marks the design note lists (paragraph, headings 1 to 5, bold, italic, strikethrough, bullet, ordered and task lists, block quote, link, image, table, fenced code, and the `details` node with its summary and body, parsed from and serialized to HTML `details`, ported from Orca with its notice header; Task 6.5 adds only the command that inserts one).
5. [ ] Run the same command. Expected: PASS, at least 6 tests. A supported fixture for which `canReconcile` is false is a schema defect to fix here, not a reason to mark the fixture unsupported.
6. [ ] Prove the test can fail: drop the table node from the schema, run the same command. Expected: FAIL in the table test. Restore and run again. Expected: PASS.
7. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 6.10: A checkbox in a read-only file keeps source history

- Satisfies: R34 (task checkboxes still work, amendment A6)
- Depends on: 6.4
- Files: modify `apps/web/src/components/files/FilePreviewPanel.tsx`; modify `apps/web/src/components/files/FilePreviewPanel.test.tsx`; modify `apps/web/src/components/files/fileEditingSession.ts` and its test if the change needs a session entry point
- Interfaces: consumes `changeFromRichEditor` or an equivalent session entry that keeps source Undo history (Task 6.2); changes the read-only rendered view's checkbox handler, which today calls `changeOutsideEditor` and discards source history.
- Skills: none
- Read first: the Task 6.4 test `a file with a footnote renders read-only with a notice and its task checkboxes still work`
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files` exits 0 with the new test passing

Steps

1. [ ] Add `ticking a checkbox in a read-only Markdown file keeps the source Undo history`: make two source edits, switch to rendered view of a file with a footnote, tick a checkbox, switch back, and Undo three times; the tick and both edits are undone in order. Change the Task 6.4 test's assertion that `changeFromRichEditor` is not called to assert that the source history survives. Run the Done when command. Expected: FAIL.
2. [ ] Route the read-only checkbox tick through the history-keeping entry. Run the Done when command. Expected: PASS.
3. [ ] Prove the test can fail: route the tick back through `changeOutsideEditor`. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Run `vp check` on the changed files and `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

