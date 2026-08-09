# Neutral Chat Composer Focus Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the chat composer's border neutral when it receives keyboard-visible focus without changing any focus, drag, layout, or control behavior.

**Architecture:** `apps/web` owns the shared React composer rendered by both browser and Tauri clients. Remove the single composer-surface focus-color override so the existing `border-border` state remains authoritative; preserve the independent drag-over branch and all focus handlers.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 utilities, Vite+, Vitest-compatible unit tests, Tauri 2 desktop host.

## Global Constraints

- A focused composer uses the same neutral `border-border` color as an unfocused composer.
- Focus acquisition, focus state, keyboard interaction, border thickness, rounded shape, transitions, send controls, and provider controls remain unchanged.
- Drag-over feedback continues to use `border-primary/70`.
- Do not change the shared `--ring` token or other orange accents such as the send button, provider/model icons, and terminal prompt content.
- Validate light and dark themes in a freshly launched build of the exact worktree Tauri bundle, not an already-running or installed application.

---

### Task 1: Neutralize the composer focus border

**Files:**
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:2223-2231`
- Test: `apps/web/src/components/chat/ChatComposer.test.tsx` in `describe("ChatComposer rendering")`

**Interfaces:**
- Consumes: the existing composer surface host element selected by `data-chat-composer-mobile-collapsed`, its `border-border` default class, `border-primary/70` drag-over branch, and `onFocusCapture` handler.
- Produces: unchanged `ChatComposer` props and behavior with no `has-focus-visible:border-ring` utility on the composer surface.

- [ ] **Step 1: Add the failing rendering test**

Add this test beside the other `ChatComposer rendering` scenarios:

```tsx
it("keeps the composer border neutral for focused descendants", () => {
  renderComposer();
  const surface = findHost(
    (element) => element.props["data-chat-composer-mobile-collapsed"] !== undefined,
  ).props;
  const className = String(surface["className"]);

  expect(className).toContain("border-border");
  expect(className).not.toContain("has-focus-visible:border-ring");
  expect(surface["onFocusCapture"]).toBeTypeOf("function");
});
```

This catches reintroducing the orange focus token on the real rendered composer surface while guarding the existing focus handler.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `apps/web`:

```bash
vp test run --project unit src/components/chat/ChatComposer.test.tsx
```

Expected: exactly the new scenario fails because the current class string contains `has-focus-visible:border-ring/45`; existing scenarios pass.

- [ ] **Step 3: Remove only the orange focus-color override**

Change the composer surface class in `ChatComposer.tsx` from:

```tsx
"chat-composer-glass rounded-[20px] border transition-colors duration-200 has-focus-visible:border-ring/45"
```

to:

```tsx
"chat-composer-glass rounded-[20px] border transition-colors duration-200"
```

Do not alter the next line:

```tsx
isDragOverComposer ? "border-primary/70 bg-accent/45" : "border-border"
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run from `apps/web`:

```bash
vp test run --project unit src/components/chat/ChatComposer.test.tsx
```

Expected: the complete file passes, including the new neutral-focus regression test and existing focus/drag behavior tests.

- [ ] **Step 5: Run repository quality gates**

Run from the repository root:

```bash
vp check
vp run typecheck
git diff --check
```

Expected: all commands exit successfully. Existing non-failing Effect finite-number suggestions may remain unchanged.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx \
  apps/web/src/components/chat/ChatComposer.test.tsx
git commit -m "fix(web): neutralize composer focus border"
```

---

### Task 2: Verify the fresh native desktop rendering

**Files:**
- Verify: `target/release/bundle/macos/BiBCode.app`
- Create as validation evidence: `/Users/admin/.codex/visualizations/2026/08/09/composer-neutral-focus-light.png`
- Create as validation evidence: `/Users/admin/.codex/visualizations/2026/08/09/composer-neutral-focus-dark.png`

**Interfaces:**
- Consumes: Task 1's committed web assets, the existing Tauri build script, theme preference UI, composer focus behavior, and center-pane split UI.
- Produces: fresh-process native evidence that the composer border is neutral in light and dark while the composer remains focusable and drag/focus behavior is unchanged.

- [ ] **Step 1: Build the exact desktop bundle**

Run from the repository root:

```bash
vp run build:desktop
```

Expected: the web production build and native Tauri release build complete, producing exactly `target/release/bundle/macos/BiBCode.app`.

- [ ] **Step 2: Eliminate stale-process validation**

Use the computer-use workflow to gracefully quit only the application whose executable path is inside this worktree. Confirm no exact-worktree executable remains before relaunching:

```bash
ps -ww -Ao pid,lstart,command | rg '[B]iBCode\.app/Contents/MacOS/bibcode-desktop'
```

Leave any separately installed `/Applications/BiBCode.app` process untouched.

- [ ] **Step 3: Launch and identify a fresh native process**

```bash
open /Users/admin/.codex/worktrees/af5d/BibCode/target/release/bundle/macos/BiBCode.app
```

Record the new exact-worktree PID/start time and use Computer Use to confirm the visible app is BiBCode rendering `tauri://localhost`.

- [ ] **Step 4: Capture light mode with the composer focused**

Open a valid workspace, set Settings → General → Theme preference to `Light`, focus the chat text editor by keyboard, and capture the native window. Confirm:

- the composer perimeter uses neutral equal-channel grayscale pixels;
- the send button and other intentionally orange accents remain unchanged;
- typing focus and composer controls still work;
- the center-pane frame remains neutral.

Save the capture to `/Users/admin/.codex/visualizations/2026/08/09/composer-neutral-focus-light.png`.

- [ ] **Step 5: Capture dark mode with the composer focused**

Set Theme preference to `Dark`, focus the chat text editor by keyboard, and capture the native window. Confirm the same four conditions against dark-theme neutral border pixels.

Save the capture to `/Users/admin/.codex/visualizations/2026/08/09/composer-neutral-focus-dark.png`.

- [ ] **Step 6: Run final verification and inspect the patch**

Run from the repository root:

```bash
cd apps/web && vp test run --project unit src/components/chat/ChatComposer.test.tsx
cd ../..
vp check
vp run typecheck
git diff --check
git status --short
```

Expected: the focused test file and repository gates pass, the diff is whitespace-clean, and tracked status is clean after the planned commits. Review the final commit range for accidental theme-token, shared-input, behavior, manifest, lockfile, or generated-file edits.
