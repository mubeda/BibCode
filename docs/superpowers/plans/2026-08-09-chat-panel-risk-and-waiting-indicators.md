# Chat Panel Risk and Waiting Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three approved Chat panel states: red Full Access icons, provider-driven red highest-reasoning indicators, and a reversed animated dotted-square `Waiting for` timer with one decimal place.

**Architecture:** Keep all behavior in the existing `apps/web` presentation owners. `ChatComposer` derives Full Access styling from `RuntimeMode`; `TraitsPicker` derives highest reasoning from the ordered provider option descriptor; `MessagesTimeline` derives elapsed text from the authoritative start timestamp while CSS owns animation. No contracts, server state, provider protocol, persistence, desktop bridge, or dependency changes are needed.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Base UI, Lucide React, Vite+ test runner, happy-dom.

## Global Constraints

- Use `text-destructive`; do not hard-code light- or dark-theme red values.
- Keep the composer toolbar icon-only at every width.
- Full Access colors only its toolbar/menu lock icons; surrounding copy and checkmarks remain neutral.
- Highest reasoning means the final option in the active provider/model's ordered reasoning descriptor, independent of provider and label.
- Highest reasoning colors only the toolbar bars and selected menu title; lower values and the checkmark remain neutral.
- Render `Waiting for 3.8s` with 100ms precision, a reversed eight-dot square animation, an 8px icon/text gap, and reduced-motion support.
- Preserve the existing DOM-only timer update path; do not introduce React state updates on the streaming hot path.
- Preserve invalid timestamp fallback, interval cleanup, provider switching, pending-option, tooltip, selection, and accessibility behavior.

---

## File map

- Modify `apps/web/src/components/chat/ChatComposer.tsx`: Full Access trigger and option-icon presentation.
- Modify `apps/web/src/components/chat/ChatComposer.test.tsx`: Full Access red/neutral/icon-only behavior.
- Modify `apps/web/src/components/chat/TraitsPicker.tsx`: shared highest-effort predicate and toolbar/menu presentation.
- Modify `apps/web/src/components/chat/TraitsPicker.test.tsx`: provider-agnostic highest/lower effort behavior and neutral checkmark.
- Modify `apps/web/src/components/chat/MessagesTimeline.tsx`: waiting copy, dotted-square structure, 100ms timer, and one-decimal duration formatting.
- Modify `apps/web/src/components/chat/MessagesTimeline.test.tsx`: waiting structure, duration boundaries, invalid input, and timer lifecycle.
- Modify `apps/web/src/index.css`: paint-and-fade keyframe plus reduced-motion-compatible dot animation class.
- Modify `docs/user/workspace-ui.md`: user-visible warning states and active waiting-row behavior.

---

### Task 1: Full Access warning icons

**Files:**
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx:1239-1267`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:223-325`

**Interfaces:**
- Consumes: `RuntimeMode`, `runtimeModeConfig`, `cn`, and the existing `text-destructive` theme token.
- Produces: Full Access-specific icon classes in the runtime trigger and selector; no new exported API.

- [ ] **Step 1: Write the failing rendering test**

Extend the runtime-control test with a Full Access render and inspect only the icon nodes:

```tsx
const fullAccess = renderComposer({ runtimeMode: "full-access" });
const fullAccessTrigger = captureByLabel("SelectTrigger", "Full access");
expect(fullAccessTrigger["className"]).toContain("[&_svg]:text-destructive");
expect(fullAccess.markup).toMatch(/lucide-lock-open[^>]*text-destructive/);
expect(fullAccess.markup).not.toContain(">Full access</button>");

h.captures.length = 0;
const supervised = renderComposer({ runtimeMode: "approval-required" });
expect(captureByLabel("SelectTrigger", "Supervised")["className"]).not.toContain(
  "[&_svg]:text-destructive",
);
expect(supervised.markup).toContain("Supervised");
```

Also assert that the Full Access label and description retain their existing neutral classes so red does not leak to selector copy or the selected indicator.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `apps/web`:

```bash
vp test run --project unit src/components/chat/ChatComposer.test.tsx
```

Expected: FAIL because neither Full Access icon currently receives `text-destructive`.

- [ ] **Step 3: Implement the minimal Full Access classes**

Derive one local flag and apply red only to SVG targets:

```tsx
const isFullAccess = props.runtimeMode === "full-access";

<SelectTrigger
  className={cn(
    "shrink-0 px-2 text-foreground/80 hover:text-foreground [&_[data-slot=select-icon]]:hidden",
    isFullAccess ? "[&_svg]:text-destructive" : "[&_svg]:text-foreground/80",
  )}
/>

<OptionIcon
  className={cn(
    "size-3.5 shrink-0",
    isFullAccess && mode === "full-access" ? "text-destructive" : "text-muted-foreground",
  )}
/>
```

Do not color the option wrapper, title, description, or `SelectItem` indicator.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same `vp test run` command. Expected: the file passes with no new warning output.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx
git commit -m "feat(web): emphasize full access mode"
```

---

### Task 2: Provider-driven highest reasoning warning

**Files:**
- Modify: `apps/web/src/components/chat/TraitsPicker.test.tsx:560-680`
- Modify: `apps/web/src/components/chat/TraitsPicker.tsx:160-265`
- Modify: `apps/web/src/components/chat/TraitsPicker.tsx:380-690`

**Interfaces:**
- Consumes: provider-resolved `ProviderOptionDescriptor`, selected prompt-injected effort, ordered descriptor options, and `cn`.
- Produces: local `isHighestEffortSelection(descriptor, value): boolean` used by both menu and toolbar presentation; no cross-package export.

- [ ] **Step 1: Write failing tests for highest and lower selections**

Add one provider-independent test using descriptors with different highest labels:

```tsx
it("emphasizes each provider's highest reasoning value and keeps lower values neutral", async () => {
  const ultraDescriptor = selectDescriptor("reasoningEffort", "Reasoning", [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
    { id: "ultra", label: "Ultra" },
  ]);
  const maxDescriptor = selectDescriptor("effort", "Reasoning", [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ]);

  await mount(
    <div>
      <ComposerTraitControls
        provider={CODEX}
        models={modelsWith([ultraDescriptor])}
        model={MODEL}
        prompt=""
        modelOptions={selections(["reasoningEffort", "ultra"])}
        onPromptChange={vi.fn()}
        onModelOptionsChange={vi.fn()}
      />
      <ComposerTraitControls
        provider={CLAUDE}
        models={modelsWith([maxDescriptor])}
        model={MODEL}
        prompt=""
        modelOptions={selections(["effort", "high"])}
        onPromptChange={vi.fn()}
        onModelOptionsChange={vi.fn()}
      />
    </div>,
  );

  const highest = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Reasoning effort: Ultra"]',
  )!;
  const lower = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Reasoning effort: High"]',
  )!;
  expect(highest.className).toContain("text-destructive");
  expect(lower.className).not.toContain("text-destructive");

  await click(highest);
  const title = radioItem("Ultra").querySelector<HTMLElement>("[data-effort-title]")!;
  expect(title.className).toContain("text-destructive");
  expect(radioItem("Ultra").className).not.toContain("text-destructive");
});
```

Add a second highest descriptor/name assertion for Max so the test proves the policy is not tied to `Ultra` or one provider driver.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `apps/web`:

```bash
vp test run --project unit src/components/chat/TraitsPicker.test.tsx
```

Expected: FAIL because highest values currently use the same neutral classes as lower values and no title marker exists.

- [ ] **Step 3: Add the shared highest-selection predicate**

Place this next to the existing descriptor helpers:

```tsx
function isHighestEffortSelection(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  value: string,
): boolean {
  if (!descriptor || value.length === 0 || descriptor.options.length === 0) return false;
  return descriptor.options.at(-1)?.id === value;
}
```

Use the resolved prompt-injected/current value already computed by `getSelectedTraits`; do not inspect provider names or option labels.

- [ ] **Step 4: Apply red only to confirmed highest presentation nodes**

In `ComposerTraitControls`, derive:

```tsx
const effortIsHighest = isHighestEffortSelection(primarySelectDescriptor, effortValue);
```

Keep the pending loader neutral and change the supported, non-pending effort button class to:

```tsx
effortIsHighest
  ? "text-destructive hover:text-destructive"
  : "text-foreground/80 hover:text-foreground"
```

In `TraitsMenuContent`, derive each descriptor's effective selected value once, pass it to `MenuRadioGroup`, and wrap its label:

```tsx
<span
  data-effort-title={descriptor.id === primarySelectDescriptor?.id ? "true" : undefined}
  className={cn(
    descriptor.id === primarySelectDescriptor?.id &&
      option.id === selectedValue &&
      isHighestEffortSelection(primarySelectDescriptor, selectedValue) &&
      "text-destructive",
  )}
>
  {option.label}
  {option.isDefault ? " (default)" : ""}
</span>
```

Keep `MenuRadioItem` itself neutral so its checkmark does not inherit red.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same TraitsPicker command. Expected: all existing control, prompt-injected, pending, bar-count, tooltip, and commit tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/web/src/components/chat/TraitsPicker.tsx apps/web/src/components/chat/TraitsPicker.test.tsx
git commit -m "feat(web): emphasize highest reasoning level"
```

---

### Task 3: Animated one-decimal waiting row

**Files:**
- Modify: `apps/web/src/components/chat/MessagesTimeline.test.tsx:620-680`
- Modify: `apps/web/src/components/chat/MessagesTimeline.test.tsx:1310-1330`
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:1106-1155`
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:1754-1780`
- Modify: `apps/web/src/index.css` after the existing animation utilities

**Interfaces:**
- Consumes: `row.createdAt`, `useRef`, `useEffect`, browser timers, and theme `currentColor`.
- Produces: local `WorkingIndicatorIcon`, `formatWorkingTimer(startIso, endIso): string | null`, and `WorkingTimer`; no exported API changes.

- [ ] **Step 1: Write failing waiting-copy and structure tests**

Replace whole-second assertions with one-decimal expectations and verify the decorative square precedes the text:

```tsx
expect(markup).toContain('data-working-indicator="reversed"');
expect(markup.match(/data-working-indicator-dot=/g)).toHaveLength(8);
expect(markup.indexOf('data-working-indicator="reversed"')).toBeLessThan(
  markup.indexOf("Waiting for"),
);
expect(markup).toMatch(/Waiting for <span[^>]*>(29\.9|30\.0|30\.1)s</);
expect(markup).not.toContain("Working for");
```

Update invalid timestamp to require `0.0s`. Update minute/hour cases to require `1m 30.0s` and `1h 1m 30.0s` within the existing timing tolerance.

- [ ] **Step 2: Add a failing mounted timer lifecycle test**

Use fake timers around a mounted working timeline:

```tsx
vi.useFakeTimers();
const intervalSpy = vi.spyOn(globalThis, "setInterval");
const clearSpy = vi.spyOn(globalThis, "clearInterval");
const mounted = await mountTimeline({
  isWorking: true,
  activeTurnStartedAt: new Date(Date.now() - 3_800).toISOString(),
  timelineEntries: [],
});

expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 100);
await act(async () => mounted.root.unmount());
expect(clearSpy).toHaveBeenCalled();
vi.useRealTimers();
```

Use the file's existing happy-dom mount cleanup conventions and restore real timers even when assertions fail.

- [ ] **Step 3: Run the focused test and verify RED**

Run from `apps/web`:

```bash
vp test run --project unit src/components/chat/MessagesTimeline.test.tsx
```

Expected: FAIL on `Working for`, three dots, whole seconds, and a 1000ms interval.

- [ ] **Step 4: Implement one-decimal duration formatting**

Compute elapsed tenths without rounding into the future:

```tsx
const elapsedTenths = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 100));
const hours = Math.floor(elapsedTenths / 36_000);
const minutes = Math.floor((elapsedTenths % 36_000) / 600);
const seconds = (elapsedTenths % 600) / 10;
const secondsLabel = `${seconds.toFixed(1)}s`;

if (hours > 0) return `${hours}h ${minutes}m ${secondsLabel}`;
if (minutes > 0) return `${minutes}m ${secondsLabel}`;
return secondsLabel;
```

Change the fallback to `0.0s` and the DOM update interval to `100`.

- [ ] **Step 5: Implement the reversed dotted-square icon and copy**

Add eight positions and the approved reverse delays in stable DOM order:

```tsx
const WORKING_INDICATOR_DOTS = [
  ["left-0.5 top-0.5", "0ms"],
  ["left-[6.75px] top-0.5", "-980ms"],
  ["right-0.5 top-0.5", "-840ms"],
  ["right-0.5 top-[6.75px]", "-700ms"],
  ["right-0.5 bottom-0.5", "-560ms"],
  ["left-[6.75px] bottom-0.5", "-420ms"],
  ["left-0.5 bottom-0.5", "-280ms"],
  ["left-0.5 top-[6.75px]", "-140ms"],
] as const;
```

Render a 16px `aria-hidden` wrapper with `data-working-indicator="reversed"`, eight absolute dot spans using `currentColor`, and `style={{ animationDelay }}`. Replace the row copy with:

```tsx
<WorkingIndicatorIcon />
<span>
  Waiting for <WorkingTimer createdAt={row.createdAt} />
</span>
```

Keep the existing `gap-2` (8px) and muted theme foreground.

- [ ] **Step 6: Add CSS animation and reduced-motion behavior**

Add to `apps/web/src/index.css`:

```css
@keyframes working-indicator-paint {
  0%, 18% { opacity: 1; transform: scale(1.15); }
  55% { opacity: 0.42; transform: scale(0.92); }
  100% { opacity: 0.14; transform: scale(0.72); }
}

.working-indicator-dot {
  animation: working-indicator-paint 1.15s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .working-indicator-dot {
    animation: none;
    opacity: 0.65;
  }
}
```

- [ ] **Step 7: Run the focused test and verify GREEN**

Run the same MessagesTimeline command. Expected: all timer, row, scrolling, grouping, and resilience tests pass without leaked fake timers.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/index.css
git commit -m "feat(web): improve active turn waiting feedback"
```

---

### Task 4: Living documentation and complete verification

**Files:**
- Modify: `docs/user/workspace-ui.md:77-106`

**Interfaces:**
- Consumes: the completed behavior from Tasks 1-3.
- Produces: current user-facing documentation; no runtime interface.

- [ ] **Step 1: Update living documentation**

After the existing composer-context section, record the exact behavior:

```markdown
Full Access uses a red lock in the toolbar and access menu. The highest
reasoning level advertised by the selected provider/model uses red reasoning
bars and a red selected-level title; lower levels remain neutral. These
controls stay icon-only in the toolbar.

While a provider turn is active, the timeline shows a reversed paint-and-fade
dotted square followed by `Waiting for` and an elapsed timer with one decimal
place. The animation respects reduced-motion preferences.
```

- [ ] **Step 2: Run all three focused test files together**

Run from `apps/web`:

```bash
vp test run --project unit \
  src/components/chat/ChatComposer.test.tsx \
  src/components/chat/TraitsPicker.test.tsx \
  src/components/chat/MessagesTimeline.test.tsx
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Use CodeGraph to confirm affected tests**

```bash
codegraph sync . --quiet
codegraph affected \
  apps/web/src/components/chat/ChatComposer.tsx \
  apps/web/src/components/chat/TraitsPicker.tsx \
  apps/web/src/components/chat/MessagesTimeline.tsx \
  apps/web/src/index.css
```

Run any additional directly affected web tests CodeGraph reports that are not already covered.

- [ ] **Step 4: Run web package and repository gates**

Run from `apps/web`:

```bash
vp run test
vp run build
```

Run from the repository root:

```bash
vp check
vp run typecheck
```

Expected: every command exits zero.

- [ ] **Step 5: Review diff and worktree status**

```bash
git diff --check
git diff --stat b2e45fa5..HEAD
git diff b2e45fa5..HEAD -- \
  apps/web/src/components/chat/ChatComposer.tsx \
  apps/web/src/components/chat/ChatComposer.test.tsx \
  apps/web/src/components/chat/TraitsPicker.tsx \
  apps/web/src/components/chat/TraitsPicker.test.tsx \
  apps/web/src/components/chat/MessagesTimeline.tsx \
  apps/web/src/components/chat/MessagesTimeline.test.tsx \
  apps/web/src/index.css \
  docs/user/workspace-ui.md
git status --short
```

Confirm no `.codegraph/`, `.superpowers/brainstorm/`, generated assets, dependency files, hard-coded red colors, toolbar text, debug output, or unrelated edits are included.

- [ ] **Step 6: Commit documentation and final verification checkpoint**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs: describe chat status indicators"
```
