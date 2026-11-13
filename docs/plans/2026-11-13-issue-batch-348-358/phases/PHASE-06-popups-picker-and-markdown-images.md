# Phase 6: Popup occlusion, model picker reopen and read-only Markdown images

- Goal: A macOS native preview hides only under an open popup that overlaps it, the composer model picker reopens empty, and the read-only Markdown view in Files loads relative images from the workspace, each with a failing-first test.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/browser/browserSurfaceStore.ts`, `apps/web/src/browser/browserSurfaceSync.ts` and their tests (`browserSurfaceStore.test.ts`, `browserSurfaceSync.test.ts`), `apps/web/src/components/ui/useNativePreviewOcclusion.ts`, new `apps/web/src/components/ui/usePopupOcclusion.ts`, `apps/web/src/components/ui/popover.tsx`, `menu.tsx`, `select.tsx`, `combobox.tsx`, `autocomplete.tsx`, new `apps/web/src/components/ui/popup-occlusion.dom.test.tsx`, `apps/web/src/components/chat/ProviderModelPicker.tsx` and `ProviderModelPicker.test.tsx`, `apps/web/src/components/ChatMarkdown.tsx` and its tests (`ChatMarkdown.test.tsx`), the `RenderedMarkdownSurface` function in `apps/web/src/components/files/FilePreviewPanel.tsx` and `FilePreviewPanel.test.tsx`
- Must not touch: `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/hostDashboard/**`, `apps/web/src/components/files/unsavedFileEdits.ts`, `apps/web/src/components/ui/tooltip.tsx`
- Skills: `tdd` (every task changes behavior test-first), `vercel-react-best-practices` (React changes under apps/web), `better-interface` (picker state and image error text are user-visible)
- Read first: `AGENTS.md` (completion rules); `UI.md` (preserve user work, honest empty and error states); `docs/architecture/overview.md` section on the native browser preview and Files rendered view (current behavior)
- Checkpoint: `cd apps/web && vp test run --project unit src/browser src/components/chat/ProviderModelPicker.test.tsx src/components/ChatMarkdown.test.tsx src/components/files/FilePreviewPanel.test.tsx` exits 0, the `*.dom.test.tsx` files named below exit 0, then `vp check` and `vp run typecheck` exit 0

Facts confirmed in source: the store files live in `apps/web/src/browser/` (not `apps/web/src/`). `ProviderModelPicker.tsx` lives in `apps/web/src/components/chat/`. `occlusionOwners` is a `ReadonlySet<symbol>` in `BrowserSurfaceStoreState`; `browserSurfaceSync.ts` computes `occluded = state.occlusionOwners.size > 0`. `PopoverPopup` renders `PopoverPrimitive.Portal keepMounted`; `MenuPopup`, `SelectPopup`, `ComboboxPopup` and `AutocompletePopup` each render Portal, Positioner, Popup. `ModelPickerContent` keeps the search text in `useState("")` and stays mounted inside the keep-mounted popover. Existing DOM occlusion test to copy: `apps/web/src/components/ui/dialog.occlusion.dom.test.tsx` (it mocks `~/env` and the platform). Decision D11: tooltips take no lease and `tooltip.tsx` is not touched.

## Tasks

### Task 6.1: Occlusion leases that carry a rectangle

- Satisfies: R40, store half. Given a lease with a rectangle, Then a native surface hides only when that rectangle intersects the surface's rectangle; a lease without a rectangle hides every surface as today.
- Depends on: none
- Files: modify `apps/web/src/browser/browserSurfaceStore.ts`, `apps/web/src/browser/browserSurfaceSync.ts`; test `apps/web/src/browser/browserSurfaceStore.test.ts`, `apps/web/src/browser/browserSurfaceSync.test.ts`
- Interfaces: consumes `BrowserSurfaceRect`; produces `occlusionOwners: ReadonlyMap<symbol, BrowserSurfaceRect | null>` (null covers everything; `.size` keeps working for existing tests), `acquireBrowserSurfaceOcclusion(rect?: BrowserSurfaceRect): BrowserSurfaceOcclusionLease` where `BrowserSurfaceOcclusionLease` becomes `{ readonly update: (rect: BrowserSurfaceRect | null) => void; readonly release: () => void }`, and an exported pure function `isBrowserSurfaceOccluded(rect: BrowserSurfaceRect, owners: ReadonlyMap<symbol, BrowserSurfaceRect | null>): boolean` (true when any owner is null or its rectangle overlaps `rect` by more than 0 px on both axes).
- Skills: tdd (red-green cycle)
- Read first: `apps/web/src/browser/browserSurfaceStore.ts` (`acquireBrowserSurfaceOcclusion`); `apps/web/src/browser/browserSurfaceSync.ts` (`push`); `apps/web/src/browser/browserSurfaceSync.test.ts` ("keeps a live surface hidden until every occlusion lease releases")
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/browser` exits 0

Steps

1. [ ] Write failing tests in `browserSurfaceStore.test.ts`: `isBrowserSurfaceOccluded` is true for a null owner, true for an overlapping rectangle, false for a disjoint one and false for a rectangle that only touches an edge; `update` replaces a lease's rectangle and `release` after `update` still removes it.
2. [ ] Write the failing sync test in `browserSurfaceSync.test.ts`: with a surface at `{ x: 0, y: 0, width: 400, height: 300 }`, a lease at `{ x: 500, y: 0, width: 100, height: 100 }` leaves `setBounds` visible; moving it to `{ x: 100, y: 100, width: 50, height: 50 }` with `update` hides it; releasing shows it again.
3. [ ] Run `cd apps/web && vp test run --project unit src/browser`. Expected: FAIL with `isBrowserSurfaceOccluded is not a function` and a surface hidden by a disjoint lease.
4. [ ] Implement the `Map`, the two functions above and the `push` change (`visible: presentation.visible && !isBrowserSurfaceOccluded(presentation.rect, state.occlusionOwners)`). Keep `acquireBrowserSurfaceOcclusion()` with no argument meaning a null rectangle so `useNativePreviewOcclusion` and the dialogs behave as before.
5. [ ] Run `cd apps/web && vp test run --project unit src/browser src/components/ui/dialog.occlusion.dom.test.tsx`. Expected: PASS.
6. [ ] Prove a test can fail: make `isBrowserSurfaceOccluded` return true for every owner, run. Expected: the disjoint-rectangle tests FAIL. Restore and run. Expected: PASS.
7. [ ] Run `vp check` on the changed files. Expected: no errors.

### Task 6.2: Popups hold a rectangle lease only while open

- Satisfies: R40, popup half. Given a macOS desktop host, an open Popover, Menu, Select, Combobox or Autocomplete popup, Then it leases its own rectangle; closing releases it; a popup kept mounted while closed holds no lease; tooltips hold none (D11); dialogs and sheets keep their full lease.
- Depends on: 6.1
- Files: create `apps/web/src/components/ui/usePopupOcclusion.ts`, `apps/web/src/components/ui/popup-occlusion.dom.test.tsx`; modify `apps/web/src/components/ui/popover.tsx`, `menu.tsx`, `select.tsx`, `combobox.tsx`, `autocomplete.tsx`, `apps/web/src/components/ui/useNativePreviewOcclusion.ts` (replace the "Not for menus and popovers" comment with a pointer to the new hook)
- Interfaces: consumes `acquireBrowserSurfaceOcclusion(rect?)` from 6.1, `isDesktopHost` from `~/env`, `isMacPlatform(navigator.platform)` from `~/lib/utils`; produces `usePopupOcclusion(open: boolean, positionerRef: React.RefObject<HTMLElement | null>): void` which, while `open` and on macOS desktop, acquires a lease with the positioner's `getBoundingClientRect()` (rounded like `BrowserSurfaceSlot`), calls `lease.update` from a `ResizeObserver` on the positioner and on window `resize`, and releases on close or unmount. The `open` signal for each primitive is read from the Popup element's `data-open` attribute through a small `MutationObserver` inside the hook's caller component `PopupOcclusion({ positionerRef, popupRef })`, rendered inside each Popup; the first step below confirms that signal against the installed Base UI before the rest is built.
- Skills: tdd (red-green cycle); vercel-react-best-practices (effects, observers and cleanup)
- Read first: `apps/web/src/components/ui/useNativePreviewOcclusion.ts`; `apps/web/src/components/ui/dialog.occlusion.dom.test.tsx` (mocks and platform setup to copy); `apps/web/src/components/ui/popover.tsx` (`Portal keepMounted`); `apps/web/src/components/ui/menu.tsx`, `select.tsx`, `combobox.tsx`, `autocomplete.tsx` (Positioner and Popup structure)
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/ui/popup-occlusion.dom.test.tsx` exits 0 with every case passed

Steps

1. [ ] Write the failing DOM test `popup-occlusion.dom.test.tsx` by copying the setup of `dialog.occlusion.dom.test.tsx`, with cases: (a) an open `PopoverPopup` adds one entry to `useBrowserSurfaceStore.getState().occlusionOwners` whose value is a non-null rectangle; (b) closing it removes the entry although the keep-mounted portal stays in the DOM; (c) a popover that never opened holds no entry; (d) the same for `MenuPopup` and `SelectPopup`, `ComboboxPopup` and `AutocompletePopup` (one case each); (e) a `TooltipPopup` open holds no entry; (f) on a non-macOS platform or `isDesktopHost` false, no entry. Stub `getBoundingClientRect` on the positioner to return a known rectangle and assert the lease value equals it.
2. [ ] Run `cd apps/web && vp test run --project unit src/components/ui/popup-occlusion.dom.test.tsx`. Expected: FAIL with `occlusionOwners.size` 0 where an entry is expected.
3. [ ] Confirm the open signal: in the test, assert that the Popup element carries `data-open` while open and not after close for a keep-mounted popover. If the installed Base UI exposes a different attribute, use that one and write the actual name in the hook's doc comment.
4. [ ] Implement `usePopupOcclusion` and the `PopupOcclusion` child, and render it inside the Popup of the five primitives. Do not edit `tooltip.tsx`.
5. [ ] Run the same command. Expected: PASS. Also run `cd apps/web && vp test run --project unit src/components/ui/popover.test.tsx src/components/ui/combobox.test.tsx src/components/ui/autocomplete.test.tsx src/components/ui/dialog.occlusion.dom.test.tsx`. Expected: PASS (no regression, dialogs still hold a full lease).
6. [ ] Prove the test can fail: make the hook acquire the lease on mount regardless of `open`, run the DOM test. Expected: case (b) and (c) FAIL. Restore and run. Expected: PASS.
7. [ ] Run `vp check` on the changed files and `vp run typecheck`. Expected: no errors. Record the `vercel-react-best-practices` review (observer cleanup, no work while closed). State in the final report that a real macOS run of the native preview was not made here.

### Task 6.3: The model picker reopens with an empty search

- Satisfies: R46. Given a query typed in the composer model picker, When the picker closes and opens again, Then the search is empty and the current model values show.
- Depends on: none
- Files: modify `apps/web/src/components/chat/ProviderModelPicker.tsx`; test `apps/web/src/components/chat/ProviderModelPicker.test.tsx`
- Interfaces: consumes `ProviderModelPicker` props `open`, `onOpenChange`, `model`, `modelOptionsByInstance`; produces an opening counter in `ProviderModelPicker` (state, incremented in `setIsMenuOpen` when `open` becomes true) used as the `key` of `ModelPickerContent`, so each opening mounts it fresh. No prop changes.
- Skills: tdd (red-green cycle); better-interface (picker state a person sees)
- Read first: `apps/web/src/components/chat/ProviderModelPicker.tsx` (`setIsMenuOpen`, `PopoverPopup`); `apps/web/src/components/chat/ModelPickerContent.tsx` (`searchQuery` state, focus layout effect); `apps/web/src/components/chat/ProviderModelPicker.test.tsx` (`renderPicker`, `click`, "opens and closes an uncontrolled picker around selection")
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/chat/ProviderModelPicker.test.tsx` exits 0

Steps

1. [ ] Write the failing test `reopening the picker shows an empty search` first, before any change: open, type `gpt` into the search input (`input` inside `[data-model-picker-content]`) with a change event, close with `onOpenChange(false)` (or select Escape), open again, assert the input value is `""` and the list shows every model. Add `reopening after the model prop changed shows the new current model in the list` (re-render with another `model`, close, open, assert the highlighted or selected item is the new one).
2. [ ] Run `cd apps/web && vp test run --project unit src/components/chat/ProviderModelPicker.test.tsx -t "reopening"`. Expected: the first test FAILS with the input value `gpt` (the popover is keep-mounted, so state survives). If it passes, the premise is wrong: record "R46: no defect, state does not survive" and stop; keep the test as proof.
3. [ ] Add the opening counter and key `ModelPickerContent` with it.
4. [ ] Run the same command. Expected: PASS.
5. [ ] Prove the test can fail: remove the `key`, run. Expected: FAIL. Restore and run. Expected: PASS.
6. [ ] Run `vp check` on the two files. Expected: no errors. Record the UI.md check (typing then closing does not need to preserve the query: an empty search is the expected start).

### Task 6.4: Read-only Markdown loads relative images from the workspace

- Satisfies: R47. Given the read-only rendered Markdown view in Files (rich editor still loading, file over 128 KiB, or content the editor cannot change safely), When the file has `![x](img/a.png)`, Then the image is read from the workspace relative to the Markdown file through `RichMarkdownImage`; a `../` path that leaves the workspace is refused with the loader's message; chat messages render exactly as before.
- Depends on: none
- Files: modify `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/files/FilePreviewPanel.tsx` (only `RenderedMarkdownSurface`); test `apps/web/src/components/ChatMarkdown.test.tsx`, `apps/web/src/components/files/FilePreviewPanel.test.tsx`
- Interfaces: consumes `RichMarkdownImage({ workspace: RichMarkdownWorkspace, src: string, alt: string })` and `RichMarkdownWorkspace { environmentId, threadId, cwd, markdownPath }` from `apps/web/src/components/files/richMarkdown/RichMarkdownImage.tsx`; produces an optional `markdownPath?: string` prop on `ChatMarkdown` (`ChatMarkdownProps`), carried in `ChatMarkdownRenderState` with the existing `environmentId`, `threadRef` and `cwd`, and an `img` entry in `CHAT_MARKDOWN_COMPONENTS` (`MarkdownImage`, module scope, reads the render state) that renders `RichMarkdownImage` when `markdownPath`, `threadRef` and `cwd` are all present and a plain `<img>` otherwise. `RenderedMarkdownSurface` passes `markdownPath={session.relativePath}`.
- Skills: tdd (red-green cycle); vercel-react-best-practices (module-scope components, stable context)
- Read first: `apps/web/src/components/ChatMarkdown.tsx` (`CHAT_MARKDOWN_COMPONENTS`, `ChatMarkdownRenderState`, the `renderState` memo); `apps/web/src/components/files/richMarkdown/RichMarkdownImage.tsx` and `richMarkdownImageSource.ts` (loader and refusal rules); `apps/web/src/components/files/FilePreviewPanel.tsx` (`RenderedMarkdownSurface`); `apps/web/src/components/files/richMarkdown/RichMarkdownImage.test.tsx` (how the loader is mocked)
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/ChatMarkdown.test.tsx src/components/files/FilePreviewPanel.test.tsx src/components/files/richMarkdown` exits 0

Steps

1. [ ] Write the failing test in `ChatMarkdown.test.tsx`: `renders a relative image through the workspace loader when a markdownPath is given` (mock `RichMarkdownImage` as in its own test; assert it receives `src: "img/a.png"` and a workspace with `markdownPath` `docs/readme.md`) and `renders an image unchanged without a markdownPath` (a plain `img` with the same `src`).
2. [ ] Write the failing test in `FilePreviewPanel.test.tsx`: for each of the three read-only paths (rich editor loading, file over 128 KiB via the too-large notice, unsafe content via the read-only notice) a relative image reaches `RichMarkdownImage`; for `../outside.png` the view shows the text "Only images inside this project are shown." (the loader's refusal).
3. [ ] Run `cd apps/web && vp test run --project unit src/components/ChatMarkdown.test.tsx src/components/files/FilePreviewPanel.test.tsx -t "image"`. Expected: FAIL: the image is a plain `img` with the relative `src`.
4. [ ] Add the prop, the render-state field, `MarkdownImage` and the `img` entry; pass `markdownPath` from `RenderedMarkdownSurface`. Keep `MessagesTimeline`, `PlanSidebar` and `ProposedPlanCard` call sites untouched.
5. [ ] Run the step 3 command and then the Done when command. Expected: PASS, including the existing chat Markdown tests.
6. [ ] Prove a test can fail: make `MarkdownImage` ignore `markdownPath`, run. Expected: the workspace tests FAIL. Restore and run. Expected: PASS.
7. [ ] Run `vp check` on the changed files and `vp run typecheck`. Expected: no errors. Record the `vercel-react-best-practices` review (components stay at module scope, no new closure in render).
