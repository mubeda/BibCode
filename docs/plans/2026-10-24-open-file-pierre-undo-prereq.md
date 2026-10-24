# Open File Disk Changes: Pierre Undo Boundary

Status: Approved 2026-10-24 with every recommended answer. This covers only the prerequisite
named in issue #180 and in rule 3 of
[the approved design](./2026-10-23-open-file-disk-changes-design.md#reconciling-a-disk-version).
It is implemented with #180, after v0.11.0 is published.

## Problem

Rule 3 of the design reloads a clean, attached editor by applying the disk text
with `Editor.applyEdits`. Then Undo brings the old text back as an ordinary
unsaved edit. That only holds if the reload is a separate undo step. Pierre
merges consecutive edits of the same shape into one undo entry. If the reload
merges with the user's last typing, one Undo removes both. If the user's next
keystroke merges into the reload, Undo of that keystroke also undoes the
reload. The design says the implementation must not ship without a way to mark
the reload as its own step.

## Current behavior (verified at 4e023ac5ff, `@pierre/diffs` 1.3.6)

Paths are under `apps/web/node_modules/@pierre/diffs/dist/editor/`.

- **The boundary already exists inside Pierre.**
  - `TextDocument.applyEdits` and `applyResolvedEdits` take a fifth parameter,
    `undoBoundary` (`textDocument.js:87`, `:94`).
  - The flag is set on the new undo entry only when `updateHistory` is true
    (`textDocument.js:100`).
  - The merge decision is made in one place, `textDocument.js:101-105`. It
    runs only when the line count is unchanged (`change.lineDelta === 0`).
  - `shouldCoalesceEditStackEntry` refuses to merge when either the previous or
    the next entry has the flag (`editStack.js:145`). One flag therefore seals
    both sides: earlier typing cannot absorb the reload, and later typing
    cannot merge into it.
  - `EditStackEntry.undoBoundary` is documented as "its own undo step"
    (`editStack.d.ts:26-31`). No other merge path exists in the package.
- **The public editor drops the flag.**
  - `Editor.applyEdits(edits, updateHistory = true)` (`editor.js:176-191`)
    calls `textDocument.applyEdits(edits, updateHistory, selectionsBefore)` at
    `editor.js:183`. The declaration has no third parameter
    (`editor.d.ts:84`).
  - Pierre's own paste (`editor.js:1034`, `:1153`), cut (`:2607`), command
    edits (`:1400`) and line moves (`:1594`) do pass `true`. The public API has
    no way to do the same.
  - `@pierre/diffs/edit` exports only `Editor` and `TextDocument`
    (`dist/edit/index.js`). The editor's document is a private field, and
    nothing exposes the edit stack.
- **When a reload merges.** Only when the line count is unchanged, the reload
  has as many edits as the previous entry, and each edit pairs with the
  previous entry's edit. A pair means a single-line insert that starts where the
  previous insert ended, or a delete that is adjacent to the previous delete in
  the same direction (`editStack.js:145-175`). A replacement (a range with new
  text) never merges as the next entry. The risk is real but narrow. Two
  examples:
  - The user typed `foo` and saved, and an agent appended `bar` on the same
    line.
  - The design's own case: the user deleted `c` from `abc`, then chose _Reload
    from disk_ against an empty file. The reload deletes `ab`, which merges in
    backspace mode.

  The caret's right gravity makes the second direction likely too
  (`selection.js:775-783`). Text inserted at the caret pushes the caret past the
  insertion, so the next keystroke lands exactly at the reload's end.

- **Undo and redo seal the stack anyway.** After either one, the next edit
  starts a new entry (`editStack.js:75`, `:85`). The boundary matters only for
  edits applied straight after typing.
- **BiBCode never calls `Editor.applyEdits` in production today.** The only
  call is in `apps/web/src/components/files/pierreEditProvider.integration.test.tsx:100`.
  `FileEditingSession` creates the editor with `persistState: true`
  (`apps/web/src/components/files/fileEditingSession.ts:104-118`). Its
  `onChange` records every change (`:110-116`).
- **No released version exposes the flag.**
  - `Editor.applyEdits` keeps the same two-parameter shape in 1.4.0 through
    1.6.1. In 1.6.1 it is at `editor.js:327-342`
    (<https://unpkg.com/@pierre/diffs@1.6.1/dist/editor/editor.js>) and its
    declaration at `editor.d.ts:165`
    (<https://unpkg.com/@pierre/diffs@1.6.1/dist/editor/editor.d.ts>).
  - The newest release is 1.6.1, from 2026-10-21
    (<https://registry.npmjs.org/@pierre%2Fdiffs>).
  - Since 1.4.0, Pierre applies an external value that changes during an edit
    session as one whole-document replacement, and it passes the boundary for
    it: `#applyExternalDocumentReplacement`, at `editor.js:798-808` in 1.5.2 and
    `:802-825` in 1.6.1. This came from upstream PR 1072
    (<https://github.com/pierrecomputer/pierre/pull/1072>).
  - Upstream PR 987 made programmatic edits join the undo timeline exactly as
    typed edits do (<https://github.com/pierrecomputer/pierre/pull/987>).

## Goals

- `Editor.applyEdits` can mark one call as its own undo step, in both
  directions, without changing what any existing call does.
- An upgrade that drops the change fails loudly, at install or in tests, rather
  than quietly bringing back the merge.
- The change can be proposed upstream as it is, so the patch can be dropped
  later.

## Non-goals

- The reload itself: the version polling, the character-level diff, conflict
  handling, and the session flag around `onChange`. Those stay in #180 as
  designed.
- Upgrading Pierre past 1.3.6.
- Changing how Pierre merges ordinary typing.

## Alternatives

**A. Patch in an opt-in parameter.** Add
`applyEdits(edits, updateHistory = true, undoBoundary = false)` and forward it
to `TextDocument.applyEdits`. Two lines of JS and one declaration. It mirrors
the parameter `TextDocument` already has, and the same two lines apply to 1.6.1
unchanged. Cost: a patch BiBCode maintains until upstream ships one.

**B. Patch `Editor.applyEdits` to always pass `true`.** Smaller to call, but it
breaks the contract Pierre documents at `editor.js:166-175`: a programmatic
edit leaves history exactly as the same typed edit would. Upstream would not
take it, and it would surprise any future caller that wants that behavior.

**C. Upstream first, no patch.** No release has the parameter. Waiting means
waiting for a release, then the 14-day age rule the dependency ledger applies,
then a move to the 1.6 API. #180 stays blocked for an unknown time.

**D. Seal with `editor.undo(); editor.redo()` before the reload.** This clears
the merge flag (`editStack.js:75`, `:85`), but only before the reload. The next
keystroke can still merge into it. It also fires `onChange` twice, re-renders
twice, and does nothing when `canUndo` is false. Rejected.

**E. Shape the edits so they never qualify.** For example, emit a replacement
edit or a different edit count. This depends on private merge heuristics that
upstream keeps revising (PR 987 changed them; the closed PR 988 proposed more), and a single replacement can still
absorb the next keystroke as the previous entry (`editStack.js:153`). Rejected.

**F. Override `TextDocument.prototype.applyEdits` at runtime.** `TextDocument`
is exported, so BiBCode could force the flag while a module-level flag is set.
This is global, untyped, invisible in the lockfile, and keeps "working" after an
upgrade that moves the call. That is the opposite of the second goal. Rejected.

**G. Rebuild the document on reload (a new `cacheKey`, as in rule 4).** No
patch, but each reload clears the user's whole undo history. _Reload from disk_
in the source view would also need a confirmation, because Undo could no longer
restore the edits (UI.md: confirm only what cannot be undone). Rejected.

**H. Upgrade to 1.6.x and use its external-document path.** Pierre already
passes the boundary there. But the replacement is one edit over the whole
document. Under right gravity, every caret inside the document moves to its
end (`selection.js:775-783`, unchanged in 1.6.1). That breaks the design's
requirement that a caret on a changed line stays in place.

1.4 and later also replace `persistState` and `cacheKey` with `editStateKey`
and a typed `Editor` constructor (1.6.1 `editor.d.ts:139-146`). Under the age rule, 1.6.0
is not eligible before 2026-11-03 and 1.6.1 not before 2026-11-04. This is a separate upgrade
decision, not a prerequisite.

## Decision

**A**, as a pnpm patch, `patches/@pierre__diffs@1.3.6.patch`, with the same
change offered upstream.

BiBCode calls it in exactly one place: the #180 reload, as
`editor.applyEdits(edits, true, true)`, behind a named helper in
`FileEditingSession`. `updateHistory` must stay `true`. The flag only takes
effect with it (`textDocument.js:100`), and that also makes Undo restore the
caret.

## Answers to the issue's open questions

- **Does Pierre expose an undo boundary?** Not publicly in any release up to
  1.6.1. `TextDocument` has one, and `Editor.applyEdits` drops it.
- **Upstream change or patch?** A patch now. The same parameter is proposed
  upstream in parallel; posting it needs the product owner's approval. #180's
  implementation depends on the patch. It does not depend on the upstream
  change.

## Patch outline

Create it with `pnpm patch @pierre/diffs@1.3.6`. Edit the extracted copy, then
run `pnpm patch-commit <dir>`, which writes the file and the
`patchedDependencies` key (<https://pnpm.io/cli/patch>). Expected content:

```diff
--- a/dist/editor/editor.js
+++ b/dist/editor/editor.js
@@ -176 +176 @@
-	applyEdits(edits, updateHistory = true) {
+	applyEdits(edits, updateHistory = true, undoBoundary = false) { // BiBCode patch: forward undoBoundary
@@ -183 +183 @@
-		const change = textDocument.applyEdits(edits, updateHistory, selectionsBefore);
+		const change = textDocument.applyEdits(edits, updateHistory, selectionsBefore, void 0, undoBoundary);
--- a/dist/editor/editor.d.ts
+++ b/dist/editor/editor.d.ts
@@ -82,3 +82,6 @@
    * are remapped during replay and the text edit still joins the undo timeline.
+   * @param undoBoundary When true, and updateHistory is true, this edit is its
+   * own undo step and never merges with the entry before or after it.
+   * BiBCode patch: adds the undoBoundary parameter.
    */
-  applyEdits(edits: TextEdit[], updateHistory?: boolean): void;
+  applyEdits(edits: TextEdit[], updateHistory?: boolean, undoBoundary?: boolean): void;
```

- **Source maps are stale on the changed lines, and that is accepted.**
  - `editor.js` keeps its line count, so `editor.js.map` still maps every line
    to the right source line.
  - On the two changed lines, 176 (42 to 103 characters) and 183 (81 to 103),
    the column mappings after the insertion point no longer fit.
  - The map also embeds the unpatched TypeScript in `sourcesContent`. A
    debugger on those lines shows the old two-parameter signature and call.
  - `editor.d.ts` gains three JSDoc lines, so `editor.d.ts.map` is three lines
    off for everything after line 83. Those offsets matter only to a tool that
    opens the map's source, `../../src/editor/editor.ts`, and the package ships
    only `dist/`.
  - The maps are not regenerated. That would mean building Pierre 1.3.6 from
    upstream source and adding a rewritten one-line, 290 KB JSON map to the
    patch. The drift covers two lines, each changed only by an added argument.
    The maps themselves are left unmodified.
- **Modification notices.** Apache-2.0 §4(b) asks every modified file to carry
  a prominent notice (`LICENSE.md:94`), so both files carry one. In `editor.js`
  it is the trailing comment, on the same line, so the line count is unchanged.
  In `editor.d.ts` it is the last JSDoc line of the `undoBoundary` parameter,
  where an editor hover shows it.
- **The `selectionsAfter` argument.** It stays `void 0`. `Editor.applyEdits`
  already sets it afterwards (`editor.js:188`).

## Protocol, schema and persistence

None at runtime.

- **Undo history.** Entries live only in the Editor's in-memory document cache
  (`editor.d.ts:20-24`). The flag is a plain field on an in-memory entry and
  is never serialized.
- **Repository state.** The `patchedDependencies` key in `pnpm-workspace.yaml`
  and the patch hash pnpm writes into `pnpm-lock.yaml` change, next to the
  existing `@pierre/trees` entry.

## Trust boundaries

The patch changes third-party code that ships in the web bundle and the desktop
app.

- **Review.** It is a reviewed diff in `patches/`.
- **Integrity.** The lockfile pins its hash.
- **Version bumps.** In pnpm 11, the repository's toolchain, a patch that fails
  to apply always fails the install. pnpm also fails on a key that matches
  nothing, because `allowUnusedPatches` defaults to false and this repository
  does not set it (<https://pnpm.io/cli/patch>). A Pierre bump therefore cannot
  silently drop the patch.
- **Scope.** It adds no network, filesystem, process or `DesktopBridge` access.

## Failure, cancellation, reconnect and concurrency

- **Synchronous.** `applyEdits` runs synchronously on the UI thread. It calls
  `onChange` before it returns (`editor.js:190` → `:2682-2692`), which the
  design's flag around the call depends on.
- **Detached editor.** It still throws "Editor is not attached"
  (`editor.js:178`). Rule 4 of the design handles that case.
- **Overlapping edits.** They still throw (`textDocument.js:189`). The #180
  diff must emit sorted, disjoint edits; edits that touch end to start are
  allowed.
- **Undo and redo.** Undoing the reload moves it to the redo stack. The next
  edit then starts a fresh entry and clears redo (`editStack.js:33-38`,
  `:71-77`), the same as for any undone edit.
- **History limit.** The reload is one more entry against the 100-entry limit
  (`editStack.js:3`). The oldest entries drop first, as they already do.
- **Reconnect and cancellation.** Not applicable: this is local editor state.

## Performance

- **Typing.** The default parameter costs nothing measurable, and typing never
  passes the flag.
- **Reloads.** Each reload adds at most one undo entry. Reloads happen only when
  the disk version changes, which the 2 s poll of the visible file bounds.

## Profiler coverage

None applies. The change adds no child process, RPC method, worktree removal
path, binary mode, shutdown step, event or finding.

## UI

None by itself. The visible result, Undo restoring the pre-reload text as one
step, is reviewed against UI.md together with #180's conflict bar and reload
behavior.

## Files to change

- `patches/@pierre__diffs@1.3.6.patch`: new, as outlined.
- `pnpm-workspace.yaml:89-93`: add
  `"@pierre/diffs@1.3.6": patches/@pierre__diffs@1.3.6.patch`. `pnpm
  patch-commit` writes it.
- `pnpm-lock.yaml`: the patch hash and the `@pierre/diffs` snapshot key. Written
  by pnpm.
- `scripts/check-dependency-upgrade-ledger.test.ts:629-634`: add
  `"@pierre/diffs@1.3.6"` to the exact key list.
- `docs/dependency-upgrades/2026-07-17-ledger.json:1220-1229`: give
  `js:catalog:@pierre/diffs` a `notes` entry modeled on the `@pierre/trees`
  note (`:702`). The status stays `green`. Suggested text: "Retain the
  `Editor.applyEdits` undo-boundary patch while no release lets a programmatic
  edit be its own undo step (none through 1.6.1). Remove it when BiBCode is on
  a release whose `Editor.applyEdits` accepts the boundary and the open-file
  reload undo tests pass without the patch." Once the upstream PR exists, add
  its number.
- `apps/web/src/components/files/pierreEditProvider.integration.test.tsx`: the
  tests below.

## Test plan (tests that fail first)

These use real Pierre in happy-dom, extending the existing integration test. A
shared helper renders `EditableFile` inside `EditProvider` and returns the
editor, as `:61-92` does. Every edit is single-line, so `lineDelta === 0`. The
document starts as `original\n`, with the caret set at `(0, 8)` through
`setSelections`.

1. **A boundary edit does not merge into earlier typing.** Insert `a` at
   `(0, 8)`, then insert `b` at `(0, 9)` with `applyEdits(edits, true, true)`.
   The text is `originalab\n`. One `undo()` leaves `originala\n`. The test
   also asserts that an `onChange` spy passed through the editor options ran
   once during the boundary call, before it returned. Without the patch,
   typecheck rejects the third argument (TS2554). At runtime the two inserts
   merge and `undo()` gives `original\n`.
2. **Typing after a boundary edit does not merge into it.** Insert `a` at
   `(0, 8)` with the boundary. The caret moves to `(0, 9)`. Then insert `b` at
   `(0, 9)` without it. The first `undo()` gives `originala\n` and the second
   gives `original\n`. Without the patch, the first `undo()` gives
   `original\n`.
3. **Default behavior is unchanged (control).** Insert `a`, then `b`, both
   without the boundary. One `undo()` gives `original\n`. This passes before
   and after the patch. It also shows that tests 1 and 2 exercise a merge that
   really happens: if Pierre ever stops merging these edits, this test fails
   and tests 1 and 2 no longer prove anything.
4. **Ledger guard.** Once the expected key is added,
   `scripts/check-dependency-upgrade-ledger.test.ts` fails until
   `pnpm-workspace.yaml` carries it.

The backspace-mode case from the design (`abc`, delete `c`, reload to empty,
Undo gives `ab`) stays in #180's test plan, where the session drives the reload.

## Verification

Run the install only after approval:

```bash
vp install
(cd apps/web && vp test run --project unit src/components/files/pierreEditProvider.integration.test.tsx)
vp test run scripts/check-dependency-upgrade-ledger.test.ts scripts/bibcode-identity.test.ts
vp run check:dependency-ledger
vp check
vp run typecheck
```

Expected:

- Before the patch, tests 1 and 2 fail on the assertions above, and
  `vp run typecheck` fails on the third argument.
- After the patch, all of these pass. `git diff` shows only the files listed
  above.

The testing runbooks were reviewed and remain accurate: no test command, target
or validation flow changes.

## Rollout

1. Land the patch and its tests as the first commit of the #180 work, after
   v0.11.0 is published. On its own it changes nothing a user sees.
2. With the product owner's approval, open an upstream PR against
   pierrecomputer/pierre that adds the same parameter. Record its number in the
   ledger note.
3. Drop the patch when the removal condition holds. If BiBCode upgrades Pierre
   first, port the same two lines (1.6.1 `editor.js:327`, `:334`) and update the
   key, the ledger test and the note.

## Risks

- **A Pierre upgrade makes the patch obsolete or wrong.** pnpm fails the install
  when the patch stops applying, and test 1 fails if the flag stops working.
  1.4 and later also change how external values reach the editor (upstream PR
  1072). Upgrading may change the #180 reload as a whole, beyond this patch.
- **Upstream picks a different API, such as an options object.** BiBCode has one
  call site, behind one helper, so adopting it is a one-line change.
- **Pierre's merge heuristics change.** Test 3 shows when the merge it guards
  against no longer happens. The boundary refuses to merge whatever the
  heuristics are (`editStack.js:145`).
- **Licensing.** Both modified files carry a notice. The patch is
  Apache-2.0-compatible, like the existing `@pierre/trees` patch.
- **Stale source maps on two lines.** A debugger stepping through
  `editor.js:176` or `:183` shows the unpatched code. This is accepted; see
  the patch outline.

## Review

Codex reviewed this design on 2026-10-24 and found no blocking or major
problems. Both minor findings were checked against the installed package and
accepted.

1. **The claim that `editor.js.map` stays aligned was wrong. Accepted.** The
   map embeds the unpatched TypeScript in `sourcesContent` and has column
   segments on line 183. The patch lengthens line 176 from 42 to 103 characters
   and line 183 from 81 to 103. The patch outline now says that line mappings
   survive but the columns and embedded source on those two lines go stale, and
   that this is accepted rather than regenerating the maps. It also notes the
   three-line shift in `editor.d.ts.map`. Risks lists the trade-off.
2. **The declaration patch had no modification notice. Accepted.**
   `LICENSE.md:94` requires notices in every modified file, and the `.d.ts`
   hunk carried only API documentation. The hunk now ends the `undoBoundary`
   JSDoc with "BiBCode patch: adds the undoBoundary parameter." Its header is
   now `+82,6`, and the patch outline and Risks now say both files carry a
   notice. The existing patches in `patches/` carry no notices, so this
   follows the license, not repository precedent.
