# Local UI Copy and Activity Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale remote-host accessibility copy from Add Project and render Activity detail timestamps as readable, preference-aware dates while preserving their exact canonical values.

**Architecture:** Keep both changes in `apps/web`, which owns presentation. Reuse the existing timestamp-format preference and long-form formatter through the Activity binding/panel/detail prop chain; do not change contracts, persistence, server data, or environment-selection policy.

**Tech Stack:** React 19, TypeScript, Vite+, Vitest/happy-dom, existing `timestampFormat.ts` utilities, Tailwind CSS.

## Global Constraints

- `AddProjectDialog` must use the exact accessible description `Choose how to add a project.`
- Activity Started/Ended labels must honor `locale`, `12-hour`, and `24-hour` user preferences through the existing formatter.
- Each `<time>` must retain the exact source value in `dateTime` and `title`.
- Malformed timestamps must remain visibly inspectable rather than rendering blank or throwing.
- Do not change environment selection, WSL/browser behavior, Activity contracts, persisted values, provider runtimes, or server schemas.
- Use strict RED/GREEN TDD and preserve unrelated worktree changes.

---

### Task 1: Neutral Add Project Accessible Copy

**Files:**
- Modify: `apps/web/src/components/AddProjectDialog.test.tsx:175-205`
- Modify: `apps/web/src/components/AddProjectDialog.tsx:20-30`

**Interfaces:**
- Consumes: the existing `DialogDescription`/`aria-describedby` relationship.
- Produces: exact dialog description text `Choose how to add a project.`

- [ ] **Step 1: Write the failing accessibility regression**

Replace the partial description assertion with the complete local-only contract:

```tsx
const description = document.getElementById(describedBy!);
expect(description?.textContent).toBe("Choose how to add a project.");
expect(description?.textContent).not.toMatch(/host/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `apps/web`:

```bash
vp test run --passWithNoTests --project unit src/components/AddProjectDialog.test.tsx
```

Expected: FAIL because the description still contains `which connected host should own it`.

- [ ] **Step 3: Implement the minimal copy fix**

Change only the description body:

```tsx
<DialogDescription className="sr-only">Choose how to add a project.</DialogDescription>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again. Expected: all `AddProjectDialog` tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/components/AddProjectDialog.tsx \
  apps/web/src/components/AddProjectDialog.test.tsx
git commit -m "fix(web): remove remote copy from Add Project"
```

---

### Task 2: Preference-Aware Activity Detail Times

**Files:**
- Modify: `apps/web/src/components/activity/ActivityPanel.test.tsx:160-190,980-1060`
- Modify: `apps/web/src/components/activity/ActivityPanel.tsx:30-60,110-140,315-330`
- Modify: `apps/web/src/components/activity/ActivityRecordDetail.tsx:1-25,100-140,205-230`
- Modify: `apps/web/src/components/ChatView.tsx:540-570,825-855,5835-5860`
- Modify: `docs/user/workspace-ui.md` under `Activity and targeted Stop`

**Interfaces:**
- Consumes: `TimestampFormat` from `@bibcode/contracts/settings` and `formatChatTimestampTooltip(isoDate, timestampFormat)` from `apps/web/src/timestampFormat.ts`.
- Produces: `ActivityPanelProps.timestampFormat: TimestampFormat` and `ActivityRecordDetailProps.timestampFormat: TimestampFormat`.

- [ ] **Step 1: Write the failing Activity detail regressions**

Set a default in the test prop factory:

```tsx
timestampFormat: "24-hour",
```

In the metadata test, select the Started and Ended `<time>` elements and assert integration with the shared formatter while retaining exact data:

```tsx
const started = container.querySelector<HTMLTimeElement>(
  'time[datetime="2026-07-22T20:00:00.000Z"]',
);
const ended = container.querySelector<HTMLTimeElement>(
  'time[datetime="2026-07-22T20:15:00.000Z"]',
);
expect(started?.textContent).toBe(
  formatChatTimestampTooltip("2026-07-22T20:00:00.000Z", "24-hour"),
);
expect(ended?.textContent).toBe(
  formatChatTimestampTooltip("2026-07-22T20:15:00.000Z", "24-hour"),
);
expect(started?.title).toBe("2026-07-22T20:00:00.000Z");
expect(ended?.title).toBe("2026-07-22T20:15:00.000Z");
expect(started?.textContent).not.toBe(started?.dateTime);
```

Add a second detail case with `startedAt: "not-a-date"` and assert the visible text, `dateTime`, and `title` all preserve `not-a-date`.

- [ ] **Step 2: Run the focused Activity test and verify RED**

Run from `apps/web`:

```bash
vp test run --passWithNoTests --project unit src/components/activity/ActivityPanel.test.tsx
```

Expected: TypeScript/test failure because `timestampFormat` is not an Activity panel prop and raw ISO strings are still visible.

- [ ] **Step 3: Add the timestamp prop flow**

Add required props:

```tsx
readonly timestampFormat: TimestampFormat;
```

Pass the value through these boundaries:

```tsx
<ActivityPanelBinding timestampFormat={timestampFormat} ... />
<ActivityPanel timestampFormat={timestampFormat} ... />
<ActivityRecordDetail timestampFormat={timestampFormat} ... />
```

Do not read global settings inside Activity components; the owning `ChatView` already has the active preference.

- [ ] **Step 4: Format visible labels while preserving canonical metadata**

Add a local helper in `ActivityRecordDetail.tsx`:

```tsx
function formatActivityTimestamp(value: string, timestampFormat: TimestampFormat): string {
  return formatChatTimestampTooltip(value, timestampFormat) || value;
}
```

Render Started and terminal Ended values as:

```tsx
<time dateTime={value} title={value}>
  {formatActivityTimestamp(value, timestampFormat)}
</time>
```

- [ ] **Step 5: Align living documentation**

Add this invariant to `docs/user/workspace-ui.md`:

```markdown
Activity record details format Started and Ended instants using the user's
timestamp preference. The exact canonical RFC 3339 value remains available in
the semantic time metadata and hover tooltip.
```

- [ ] **Step 6: Run focused Activity and binding tests and verify GREEN**

Run from `apps/web`:

```bash
vp test run --passWithNoTests --project unit \
  src/components/activity/ActivityPanel.test.tsx \
  src/components/ChatView.test.tsx \
  src/components/ActivitySurfaces.test.tsx
```

Expected: all selected tests pass with no new warnings.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityPanel.tsx \
  apps/web/src/components/activity/ActivityRecordDetail.tsx \
  apps/web/src/components/ChatView.tsx \
  docs/user/workspace-ui.md
git commit -m "fix(activity): format record timestamps"
```

---

### Task 3: Broader Verification and Visual Recapture

**Files:**
- No tracked source changes expected.
- Create ignored evidence under `.superpowers/sdd/2026-08-16-local-ui-copy-and-activity-time/visual-evidence/`.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: package/workspace command evidence and current v0.3.14 screenshots from the exact worktree bundle.

- [ ] **Step 1: Run the combined focused matrix**

From `apps/web`:

```bash
vp test run --passWithNoTests --project unit \
  src/components/AddProjectDialog.test.tsx \
  src/components/activity/ActivityPanel.test.tsx \
  src/components/ChatView.test.tsx \
  src/components/ActivitySurfaces.test.tsx
```

- [ ] **Step 2: Run the complete web unit suite**

From `apps/web`:

```bash
vp test run --passWithNoTests --project unit
```

- [ ] **Step 3: Run repository checks and workspace typecheck**

From the repository root, sequentially:

```bash
vp check
vp run typecheck
git diff --check
```

- [ ] **Step 4: Run the workspace test graph**

```bash
vp run test
```

Expected: all package tasks pass. Stop and diagnose the first different failure rather than weakening concurrency or deadlines.

- [ ] **Step 5: Build the exact desktop v0.3.14 bundle once**

```bash
vp run build:desktop
```

Verify `target/release/bundle/macos/BiBCode.app/Contents/Info.plist` reports version `0.3.14` and executable `bibcode-desktop`.

- [ ] **Step 6: Recapture through Codex Computer Use**

Launch only the full worktree path
`target/release/bundle/macos/BiBCode.app` through `@oai/sky`. Capture:

1. Add Project with no Host control and accessible description `Choose how to add a project.`
2. Activity detail at normal width with readable Started/Ended values.
3. Activity detail/roster at narrow width to check wrapping, clipping, and alignment.

Review original-resolution images for text clipping, baseline drift, border joins,
control overlap, focus treatment, and contrast. Quit the exact app through Codex
Computer Use and prove no exact-bundle process remains.

- [ ] **Step 7: Final audit**

```bash
git status --short
git diff --check HEAD~2..HEAD
```

Confirm no generated, manifest, lockfile, dependency, provider, server, desktop,
or unrelated source drift.

