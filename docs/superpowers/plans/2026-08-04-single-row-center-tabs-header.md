# Single-Row Center Tabs Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked chat title and center-tab rows with one compact header whose provider- and terminal-named tabs scroll independently beside pinned workspace actions.

**Architecture:** `ChatView` remains the composition boundary: it derives the host provider label, renders `CenterPanelTabs` in the flexible left region, and renders `ChatHeaderActions` in the non-shrinking right region. `CenterPanelTabs` owns only presentation and navigation; provider state stays out of the persisted center-panel schema.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Base UI `ScrollArea`, Zustand, Vite+ tests, Tauri 2 desktop, Codex Computer Use.

## Global Constraints

- Keep the `CenterSurface` union and center-panel persistence schema unchanged.
- No center tab may display `Main`.
- The host tab uses the current provider instance `displayName`, falling back to the selected provider driver label.
- Added AI tabs keep their existing provider-label fallback; terminal tabs keep their existing terminal-label chain.
- The tab rail scrolls horizontally and never wraps, overlaps, moves, or shrinks the existing action and layout controls.
- Preserve click activation, close buttons, middle-click close, context-menu close commands, host close behavior, and mounted transcript state.
- Do not redesign the panel menu, project scripts, Open picker, Git synchronization, or panel-layout controls.
- Do not add dependencies or a production Node runtime.
- Use test-driven development for every behavior change.
- Completion requires focused tests, `vp check`, `vp run typecheck`, and Codex `computer-use:computer-use` verification of every accepted change in the running desktop UI.

---

## File Structure

- Modify `apps/web/src/components/CenterPanelTabs.tsx`: accept the host label, render the header-sized scroll rail, translate conventional mouse-wheel input, and support horizontal-arrow tab navigation.
- Modify `apps/web/src/components/CenterPanelTabs.test.tsx`: cover naming, overflow, active reveal, keyboard navigation, and preserved close interactions.
- Rename `apps/web/src/components/chat/ChatHeader.tsx` to `apps/web/src/components/chat/ChatHeaderActions.tsx`: remove visible title rendering and retain only workspace actions.
- Rename `apps/web/src/components/chat/ChatHeader.render.test.tsx` to `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`: verify the action-only component.
- Rename `apps/web/src/components/chat/ChatHeader.test.ts` to `apps/web/src/components/chat/ChatHeaderActions.test.ts`: keep the local Open-picker policy tests with the renamed module.
- Modify `apps/web/src/components/ChatView.tsx`: derive the current host provider label and compose tabs plus actions inside one header row.
- Modify `apps/web/src/components/ChatView.test.tsx`: verify one-row composition, label propagation, fallback behavior, and empty-surface behavior.
- Modify `apps/web/src/components/ChatView.hooks.test.tsx`: update the header mock/import name while preserving the existing action-handler coverage.

---

### Task 1: Make `CenterPanelTabs` a named, navigable horizontal rail

**Files:**
- Modify: `apps/web/src/components/CenterPanelTabs.tsx`
- Test: `apps/web/src/components/CenterPanelTabs.test.tsx`

**Interfaces:**
- Consumes: existing `CenterSurface[]`, active surface id, terminal labels, and close/activate callbacks.
- Produces: `CenterPanelTabsProps.hostLabel: string`; a flexible `data-center-panel-tabbar` rail that Task 3 can place beside fixed actions.

- [ ] **Step 1: Write the failing host-label test**

Add `hostLabel: "Codex"` to the shared `props()` fixture. Replace the old host-title assertion with an explicit content-naming assertion:

```tsx
it("names the host from its current provider and preserves other surface labels", () => {
  const input = props();
  const markup = renderToStaticMarkup(<CenterPanelTabs {...input} />);

  expect(markup).toContain("Codex");
  expect(markup).not.toContain("Main");
  expect(markup).toContain("Claude");
  expect(markup).toContain("Codex Terminal");
});
```

- [ ] **Step 2: Run the host-label test to verify it fails**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx -t "names the host"
```

Expected: FAIL because the component still renders `Main` and does not consume `hostLabel`.

- [ ] **Step 3: Implement provider-based host naming**

Add the required prop and thread it into the existing title resolver:

```tsx
interface CenterPanelTabsProps {
  hostLabel: string;
  surfaces: readonly CenterSurface[];
  activeSurfaceId: string | null;
  terminalLabelsById?: ReadonlyMap<string, string>;
  onActivate: (surface: CenterSurface) => void;
  onCloseSurface: (surface: CenterSurface) => void;
  onCloseOtherSurfaces: (surface: CenterSurface) => void;
  onCloseSurfacesToRight: (surface: CenterSurface) => void;
  onCloseAllSurfaces: () => void;
}

function centerSurfaceTitle(
  surface: CenterSurface,
  hostLabel: string,
  terminalLabelsById: ReadonlyMap<string, string> | undefined,
): string {
  switch (surface.kind) {
    case "chat-host":
      return hostLabel;
    case "chat":
      return surface.providerLabel ?? "Chat";
    case "terminal":
      return (
        surface.label ??
        terminalLabelsById?.get(surface.terminalId) ??
        getTerminalLabel(surface.terminalId)
      );
  }
}
```

Call it as `centerSurfaceTitle(surface, props.hostLabel, props.terminalLabelsById)`.

- [ ] **Step 4: Run the naming test and verify it passes**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx -t "names the host"
```

Expected: PASS; the rendered host label is `Codex` and `Main` is absent.

- [ ] **Step 5: Write failing wheel and arrow-navigation tests**

Extend the ref harness so its root can return both the Base UI viewport and activation buttons:

```tsx
const viewport = { scrollWidth: 640, clientWidth: 240, scrollLeft: 12 };
const activeTab = { scrollIntoView: vi.fn() };
const activationButtons = [
  { focus: vi.fn(), scrollIntoView: vi.fn() },
  { focus: vi.fn(), scrollIntoView: vi.fn() },
  { focus: vi.fn(), scrollIntoView: vi.fn() },
];
harness.refCurrent = {
  querySelector: vi.fn((selector: string) =>
    selector === '[data-slot="scroll-area-viewport"]' ? viewport : activeTab,
  ),
  querySelectorAll: vi.fn(() => activationButtons),
};
```

Add these cases:

```tsx
it("translates vertical wheel input only when the tab viewport overflows", () => {
  const input = props();
  const tree = CenterPanelTabs(input);
  const scrollArea = visit(tree).find(
    (element) => (element.props as Record<string, unknown>)["data-center-panel-tab-list"] === true,
  );
  if (!scrollArea) throw new Error("Tab scroll area not found");

  const event = { deltaX: 0, deltaY: 48, preventDefault: vi.fn() };
  (scrollArea.props as { onWheel: (event: typeof event) => void }).onWheel(event);

  expect(viewport.scrollLeft).toBe(60);
  expect(event.preventDefault).toHaveBeenCalledOnce();

  viewport.clientWidth = viewport.scrollWidth;
  (scrollArea.props as { onWheel: (event: typeof event) => void }).onWheel(event);
  expect(viewport.scrollLeft).toBe(60);
});

it("moves to and reveals the adjacent tab with horizontal arrow keys", () => {
  const input = props();
  const tree = CenterPanelTabs(input);
  const elements = visit(tree);
  const activeButton = elements.find(
    (element) =>
      element.type === "button" &&
      (element.props as Record<string, unknown>)["aria-selected"] === true,
  );
  if (!activeButton) throw new Error("Active tab button not found");

  const event = { key: "ArrowRight", preventDefault: vi.fn() };
  (activeButton.props as { onKeyDown: (event: typeof event) => void }).onKeyDown(event);

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(activationButtons[2]?.focus).toHaveBeenCalledOnce();
  expect(activationButtons[2]?.scrollIntoView).toHaveBeenCalledWith({
    block: "nearest",
    inline: "nearest",
  });
  expect(input.onActivate).toHaveBeenCalledWith(terminal);
});
```

Update the mocked `ScrollArea` to forward its remaining props to the rendered `div`, and update `harness.refCurrent`'s type to include `querySelectorAll`.

- [ ] **Step 6: Run the navigation tests to verify they fail**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx -t "wheel|arrow keys"
```

Expected: FAIL because the scroll area has no wheel handler and tab buttons have no horizontal-arrow handler.

- [ ] **Step 7: Implement bounded wheel translation and arrow navigation**

Import the exact event types with the existing React imports:

```tsx
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
```

Add these handlers inside `CenterPanelTabs`:

```tsx
const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
  const viewport = tabListRef.current?.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;
  if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

  viewport.scrollLeft += event.deltaY;
  event.preventDefault();
}, []);

const handleTabKeyDown = useCallback(
  (event: ReactKeyboardEvent<HTMLButtonElement>, surfaceIndex: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = surfaceIndex + direction;
    const nextSurface = props.surfaces[nextIndex];
    if (!nextSurface) return;

    event.preventDefault();
    const activationButtons = tabListRef.current?.querySelectorAll<HTMLButtonElement>(
      "[data-center-panel-tab-activation]",
    );
    const nextButton = activationButtons?.[nextIndex];
    nextButton?.focus();
    nextButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
    props.onActivate(nextSurface);
  },
  [props],
);
```

Render the component as a flexible rail rather than a second header row:

```tsx
return (
  <div
    className="relative flex min-w-0 flex-1 self-stretch items-center overflow-hidden"
    data-center-panel-tabbar
  >
    <ScrollArea
      ref={tabListRef}
      hideScrollbars
      scrollFade
      className="min-w-0 flex-1 self-stretch rounded-none"
      data-center-panel-tab-list
      onWheel={handleWheel}
    >
      <div
        className="flex h-full w-max min-w-full items-center gap-1 px-2"
        role="tablist"
        aria-label="Workspace panels"
      >
        {props.surfaces.map((surface, surfaceIndex) => {
          const active = surface.id === props.activeSurfaceId;
          const title = centerSurfaceTitle(
            surface,
            props.hostLabel,
            props.terminalLabelsById,
          );
          return (
            <div
              key={surface.id}
              data-active-tab={active}
              onMouseDown={handleTabMouseDown}
              onAuxClick={(event) => handleTabAuxClick(event, surface)}
              onContextMenu={(event) => void handleTabContextMenu(event, surface)}
              className={cn(
                "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-center-panel-tab-activation
                      className="flex min-w-0 flex-1 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                      onClick={() => props.onActivate(surface)}
                      onKeyDown={(event) => handleTabKeyDown(event, surfaceIndex)}
                    >
                      <CenterSurfaceIcon surface={surface} />
                      <span className="truncate">{title}</span>
                    </button>
                  }
                />
                <TooltipPopup>{title}</TooltipPopup>
              </Tooltip>
              <button
                type="button"
                className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 group-hover:opacity-100"
                aria-label={`Close ${title}`}
                onClick={() => props.onCloseSurface(surface)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  </div>
);
```

Keep the existing middle-click handler, context menu, and active-tab `scrollIntoView` effect above this returned tree unchanged.

- [ ] **Step 8: Run the complete `CenterPanelTabs` suite**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx
```

Expected: PASS, including existing activation and close interaction coverage.

- [ ] **Step 9: Commit the rail behavior**

```bash
git add apps/web/src/components/CenterPanelTabs.tsx apps/web/src/components/CenterPanelTabs.test.tsx
git commit -m "feat(web): make center tabs a navigable rail"
```

---

### Task 2: Refactor the title header into fixed workspace actions

**Files:**
- Rename: `apps/web/src/components/chat/ChatHeader.tsx` → `apps/web/src/components/chat/ChatHeaderActions.tsx`
- Rename: `apps/web/src/components/chat/ChatHeader.render.test.tsx` → `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`
- Rename: `apps/web/src/components/chat/ChatHeader.test.ts` → `apps/web/src/components/chat/ChatHeaderActions.test.ts`

**Interfaces:**
- Consumes: the existing project, provider, editor, script, Git, and panel callbacks.
- Produces: `ChatHeaderActions`, a non-shrinking action cluster with no visible thread title; Task 3 places it after the tab rail.

- [ ] **Step 1: Rename the component and test files**

Run:

```bash
git mv apps/web/src/components/chat/ChatHeader.tsx apps/web/src/components/chat/ChatHeaderActions.tsx
git mv apps/web/src/components/chat/ChatHeader.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx
git mv apps/web/src/components/chat/ChatHeader.test.ts apps/web/src/components/chat/ChatHeaderActions.test.ts
```

Update both test imports from `./ChatHeader` to `./ChatHeaderActions` and rename `ChatHeader` references to `ChatHeaderActions`. Keep the existing `shouldShowOpenInPicker` export in the renamed module.

- [ ] **Step 2: Write the failing action-only rendering assertion**

In `ChatHeaderActions.render.test.tsx`, keep `activeThreadTitle: "Thread title"` temporarily in the fixture and add:

```tsx
it("renders a fixed action cluster without the thread title", () => {
  const markup = renderToStaticMarkup(<ChatHeaderActions {...props()} />);

  expect(markup).toContain("data-chat-header-actions");
  expect(markup).not.toContain("Thread title");
  expect(markup).toContain("pr-16");
});
```

- [ ] **Step 3: Run the action-only test to verify it fails**

Run:

```bash
vp test apps/web/src/components/chat/ChatHeaderActions.render.test.tsx -t "fixed action cluster"
```

Expected: FAIL because the renamed component still renders `Thread title`.

- [ ] **Step 4: Remove title ownership and export `ChatHeaderActions`**

In `ChatHeaderActions.tsx`:

1. Remove `activeThreadTitle` from the props interface and destructuring.
2. Remove the title tooltip imports and the title-containing flexible child.
3. Rename `ChatHeaderProps` to `ChatHeaderActionsProps` and `ChatHeader` to `ChatHeaderActions`.
4. Return the action controls directly from this fixed wrapper:

```tsx
return (
  <div
    data-chat-header-actions
    className={cn(
      "@container/header-actions flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
      rightPanelOpen ? "pr-0" : "pr-16",
    )}
  >
    <ChatHeaderPanelMenu
      providerStatuses={providerStatuses}
      settings={settings}
      canCreatePanel={canCreatePanel}
      onCreateChatPanel={onCreateChatPanel}
      onOpenTerminalPanel={onOpenTerminalPanel}
      onOpenProviderTerminalPanel={onOpenProviderTerminalPanel}
      onAddCustomAction={() => setAddDialogRequestId((id) => id + 1)}
    />
    {activeProjectScripts && (
      <ProjectScriptsControl
        scripts={activeProjectScripts}
        keybindings={keybindings}
        preferredScriptId={preferredScriptId}
        addDialogRequestId={addDialogRequestId}
        onRunScript={onRunProjectScript}
        onAddScript={onAddProjectScript}
        onUpdateScript={onUpdateProjectScript}
        onDeleteScript={onDeleteProjectScript}
      />
    )}
    {showOpenInPicker && (
      <OpenInPicker
        environmentId={activeThreadEnvironmentId}
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
      />
    )}
    {activeProjectName && (
      <GitActionsControl
        gitCwd={gitCwd}
        activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
        {...(draftId ? { draftId } : {})}
        hideTrigger
      />
    )}
  </div>
);
```

Delete `activeThreadTitle` from the test fixture. Preserve every existing conditional action and callback unchanged.

- [ ] **Step 5: Run the renamed header-action tests**

Run:

```bash
vp test apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts
```

Expected: PASS for title removal, project actions, remote Open-picker suppression, and `shouldShowOpenInPicker`.

- [ ] **Step 6: Commit the action-component refactor**

```bash
git add apps/web/src/components/chat/ChatHeaderActions.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts
git commit -m "refactor(web): isolate chat header actions"
```

---

### Task 3: Compose tabs and actions into one provider-named workspace header

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`

**Interfaces:**
- Consumes: `CenterPanelTabs.hostLabel`, `ChatHeaderActions`, existing `activeProviderStatus`, and existing `selectedProvider`.
- Produces: a single `data-chat-header` row with a flexible tab rail followed by pinned actions.

- [ ] **Step 1: Update the ChatView test mocks for the renamed component**

In both ChatView test files, replace the old module mock with:

```tsx
vi.mock("./chat/ChatHeaderActions", () => ({
  ChatHeaderActions: (props: Record<string, unknown>) => {
    h.capture("chatHeaderActions", props);
    return <div data-mock="chat-header-actions" />;
  },
}));
```

In `ChatView.test.tsx`, use `h.captured["chatHeaderActions"] = props` instead of `h.capture` to match that file's harness. Mechanically rename captured test keys from `chatHeader` to `chatHeaderActions` without changing the handler assertions they exercise.

- [ ] **Step 2: Write failing one-row and provider-label integration assertions**

Update the existing connected-thread rendering test:

```tsx
const markup = renderServerRoute();

expect(markup).toContain('data-mock="center-panel-tabs"');
expect(markup).toContain('data-mock="chat-header-actions"');
expect(markup).toContain('aria-label="Demo Thread workspace"');
expect(markup.indexOf('data-mock="center-panel-tabs"')).toBeLessThan(
  markup.indexOf('data-mock="chat-header-actions"'),
);

const tabs = capturedProps<Record<string, unknown>>("centerPanelTabs");
expect(tabs["hostLabel"]).toBe("Codex");
expect(capturedProps<Record<string, unknown>>("chatHeaderActions")).not.toHaveProperty(
  "activeThreadTitle",
);
```

Add an explicit provider-display-name case:

```tsx
it("uses the selected provider display name for the host tab", () => {
  const namedProvider: ServerProvider = {
    ...codexProvider,
    displayName: "Codex Personal",
  };
  seedEnvironment(
    makeEnvironmentPresentation({
      serverConfig: { providers: [namedProvider], environment: { label: "Local" } },
    }),
  );
  seedProject(makeProject());
  seedServerThread(makeThread());
  seedGitStatus(true);

  renderServerRoute();

  expect(capturedProps<Record<string, unknown>>("centerPanelTabs")["hostLabel"]).toBe(
    "Codex Personal",
  );
});
```

Add the missing-status fallback case by seeding `providers: []` and asserting `hostLabel === "Codex"`.

- [ ] **Step 3: Run the integration assertions to verify they fail**

Run:

```bash
vp test apps/web/src/components/ChatView.test.tsx -t "renders header|host tab"
```

Expected: FAIL because ChatView imports the old component, passes the visible thread title, renders tabs below the header, and does not pass `hostLabel`.

- [ ] **Step 4: Derive a stable current-provider label**

`formatProviderDriverKindLabel` is already imported by `ChatView.tsx`. Immediately after `activeProviderStatus`, derive:

```tsx
const centerHostLabel =
  activeProviderStatus?.displayName?.trim() || formatProviderDriverKindLabel(selectedProvider);
```

This intentionally derives presentation state at render time. Do not write the label to `CenterSurface` or the Zustand store.

- [ ] **Step 5: Compose the approved single-row header**

Replace the import with:

```tsx
import { ChatHeaderActions } from "./chat/ChatHeaderActions";
```

Inside the existing `!isPanel` header, keep the current classes, `panelLayoutControls`, collapsed-sidebar inset, safe-area padding, and bottom border. Add an accessible label and render the rail before the actions:

```tsx
<header
  data-chat-header
  aria-label={`${activeThread.title} workspace`}
  className={cn(
    "border-b border-border transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
    "workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
    COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  )}
>
  {!effectiveRightPanelOpen ? panelLayoutControls : null}
  {activeThreadRef && centerPanelState.surfaces.length > 0 ? (
    <CenterPanelTabs
      hostLabel={centerHostLabel}
      surfaces={centerPanelState.surfaces}
      activeSurfaceId={centerPanelState.activeSurfaceId}
      onActivate={(surface) =>
        centerPanelActions.activateSurface(activeThreadRef, surface.id)
      }
      onCloseSurface={closeCenterPanelSurface}
      onCloseOtherSurfaces={closeOtherCenterPanelSurfaces}
      onCloseSurfacesToRight={closeCenterPanelSurfacesToRight}
      onCloseAllSurfaces={closeAllCenterPanelSurfaces}
    />
  ) : (
    <div
      className="min-w-0 flex-1"
      aria-hidden="true"
      data-center-panel-empty-spacer
    />
  )}
  <ChatHeaderActions
    activeThreadEnvironmentId={activeThread.environmentId}
    activeThreadId={activeThread.id}
    {...(routeKind === "draft" && draftId ? { draftId } : {})}
    activeProjectName={activeProject?.title}
    openInCwd={gitCwd}
    activeProjectScripts={activeProject?.scripts}
    preferredScriptId={
      activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
    }
    keybindings={keybindings}
    availableEditors={availableEditors}
    rightPanelOpen={effectiveRightPanelOpen}
    gitCwd={gitCwd}
    providerStatuses={providerStatuses as ServerProvider[]}
    settings={settings}
    canCreatePanel={centerPanelLaunchContext !== null}
    onCreateChatPanel={handleCreateChatPanel}
    onOpenTerminalPanel={handleOpenTerminalPanel}
    onOpenProviderTerminalPanel={handleOpenProviderTerminalPanel}
    onRunProjectScript={runProjectScript}
    onAddProjectScript={saveProjectScript}
    onUpdateProjectScript={updateProjectScript}
    onDeleteProjectScript={deleteProjectScript}
  />
</header>
```

Delete the former standalone `CenterPanelTabs` block below the header and remove the old `activeThreadTitle` prop.

- [ ] **Step 6: Verify provider changes update the host label on rerender**

Add a ChatView test with Codex and Claude snapshots. Render once with the Codex selection, update the composer selection, publish the store, and render again:

```tsx
const claudeInstanceId = ProviderInstanceId.make("claude");
const claudeProvider: ServerProvider = {
  ...codexProvider,
  instanceId: claudeInstanceId,
  driver: ProviderDriverKind.make("claude"),
  displayName: "Claude",
};
seedEnvironment(
  makeEnvironmentPresentation({
    serverConfig: {
      providers: [codexProvider, claudeProvider],
      environment: { label: "Local" },
    },
  }),
);
seedProject(makeProject());
seedServerThread(makeThread());
seedGitStatus(true);

renderServerRoute();
expect(capturedProps<Record<string, unknown>>("centerPanelTabs")["hostLabel"]).toBe("Codex");

useComposerDraftStore.getState().setModelSelection(threadRef, {
  instanceId: claudeInstanceId,
  model: "claude-sonnet",
});
publishSeededStoreState(useComposerDraftStore);
renderServerRoute();
expect(capturedProps<Record<string, unknown>>("centerPanelTabs")["hostLabel"]).toBe("Claude");
```

The seeded server thread has no messages and no provider session, so `deriveLockedProvider` leaves it unlocked and the composer selection is the active provider source. Also assert the center-panel surface array is unchanged across the two renders.

- [ ] **Step 7: Add and verify the empty-surface layout case**

Use `useCenterPanelStore.getState().closeAllSurfaces(threadRef)`, publish the seeded state, and assert the rendered header still contains `data-mock="chat-header-actions"` while omitting `data-mock="center-panel-tabs"`. Also assert the header contains `data-center-panel-empty-spacer` so actions remain right-aligned.

- [ ] **Step 8: Run both ChatView suites**

Run:

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS. Existing project-script, panel creation, terminal creation, right-panel, and center-panel action tests remain green under the renamed mock.

- [ ] **Step 9: Run all focused header and tab tests together**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS with no `Main` label assertions and no import of `./chat/ChatHeader`.

- [ ] **Step 10: Commit the one-row integration**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "feat(web): merge center tabs into chat header"
```

---

### Task 4: Run repository gates and verify every accepted change with Computer Use

**Files:**
- Verify: `apps/web/src/components/CenterPanelTabs.tsx`
- Verify: `apps/web/src/components/chat/ChatHeaderActions.tsx`
- Verify: `apps/web/src/components/ChatView.tsx`
- Do not commit: build products, screenshots, logs, `.superpowers/`, or temporary desktop state.

**Interfaces:**
- Consumes: the completed implementation and the running BiBCode desktop app.
- Produces: automated and visual evidence that every acceptance criterion passes; no code interface.

- [ ] **Step 1: Run the complete focused test set**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: all focused suites pass.

- [ ] **Step 2: Run repository-required gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit successfully with no new diagnostics. These gates are mandatory under `AGENTS.md`.

- [ ] **Step 3: Inspect the code diff before launching the app**

Run:

```bash
git status --short
git diff --check
git diff HEAD~3 --stat
rg -n '"Main"|>Main<' apps/web/src/components/CenterPanelTabs.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/chat/ChatHeaderActions.tsx
```

Expected: `git diff --check` succeeds; only scoped source/test changes are present; the `rg` command finds no center-tab `Main` label.

- [ ] **Step 4: Build and launch the Tauri desktop app**

Run:

```bash
vp run build:desktop
vp run start:desktop
```

Keep the desktop process running in its terminal. Expected: a unique local `BiBCode` window opens and loads the modified web assets.

- [ ] **Step 5: Bootstrap the user-required Codex Computer Use skill**

Read `/Users/admin/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000550/skills/computer-use/SKILL.md` completely. Through `node_repl`, initialize the plugin-owned runtime exactly once:

```js
if (!globalThis.sky) {
  const { setupComputerUseRuntime } =
    await import("/Users/admin/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000550/scripts/computer-use-client.mjs");
  await setupComputerUseRuntime({ globals: globalThis });
}
var bibcodeState = await sky.get_app_state({ app: "BiBCode" });
nodeRepl.write(bibcodeState.text);
```

Expected: the accessibility tree describes the running BiBCode window. If the display name fails, call `sky.list_apps()`, locate the BiBCode bundle identifier, and retry `get_app_state` with that identifier.

- [ ] **Step 6: Create a real overflowing mix of AI and terminal tabs**

Using only fresh element indices from `sky.get_app_state` after each action:

1. Open a started host thread that exposes the `New panel` button.
2. Use `New panel` to create available AI-provider tabs.
3. Reopen `New panel` and choose `Open Terminal` repeatedly until at least six total tabs exist and the rail overflows at a constrained width.
4. Record the accessibility tree and emit the screenshot through `nodeRepl.emitImage`.

Expected: the first tab is the current provider name; added AI tabs use their provider names; terminal tabs use terminal labels; no tab says `Main`.

- [ ] **Step 7: Verify wide layout and every retained interaction**

At the normal window width, use fresh app state before every interaction and verify:

1. Only one top bar is visible above the transcript or active panel.
2. No visible thread-title box remains.
3. Tabs appear before the fixed `New panel`, Open, terminal-drawer, and right-panel controls.
4. Clicking a tab activates the corresponding AI or terminal panel.
5. A close button closes its tab.
6. Middle-click closes a disposable tab.
7. The tab context menu still exposes Close, Close others, Close to the right, and Close all when applicable.
8. ArrowLeft and ArrowRight move through and activate adjacent tabs without losing focus.

Fetch a new accessibility state after every action. Emit a screenshot showing the approved one-row wide layout.

- [ ] **Step 8: Verify constrained-width overflow and pinned actions**

Use `sky.drag` on the BiBCode window edge to reduce the workspace width until tabs overflow. Then:

1. Confirm the action cluster retains full hit targets and never overlaps tabs.
2. Scroll the tab rail horizontally with Computer Use; activate a previously hidden tab and confirm it scrolls into view.
3. Confirm long provider and terminal labels truncate without increasing header height; focus or hover them and confirm the full label remains available.
4. Toggle the terminal drawer and right panel to prove the reserved title-bar controls stay reachable in both open and closed states.
5. Emit a constrained-width screenshot and the corresponding accessibility text.

Expected: tabs alone clip/scroll; actions remain stationary and operable; there is no second tab row or wrapped tab.

- [ ] **Step 9: Verify the host label follows provider selection**

Activate the host chat. Through the existing provider/model picker, switch from the current provider to another configured provider such as Claude, then fetch fresh UI state.

Expected: the first tab label changes to the newly selected provider immediately, the center-panel surface order is unchanged, and no `Main` or thread-title label appears. Switch back if needed and emit before/after screenshots.

- [ ] **Step 10: Fix every visual discrepancy test-first and repeat verification**

If Computer Use finds any missing accepted change, overlap, unreachable tab, stale provider label, or broken interaction:

1. Stop and add a focused failing regression test to the owning test file.
2. Run the test and confirm the observed failure.
3. Apply the smallest implementation fix.
4. Run the focused suite, `vp check`, and `vp run typecheck` again.
5. Rebuild/relaunch the desktop app and repeat Steps 5–9.

Do not waive or document around a discrepancy; all accepted changes must be visibly present before completion.

- [ ] **Step 11: Audit final state and commit verification fixes only if needed**

Run:

```bash
git status --short
git diff --check
git log --oneline -8
```

If visual verification required source fixes, stage only the scoped source/test files and commit them with:

```bash
git add apps/web/src/components/CenterPanelTabs.tsx apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/chat/ChatHeaderActions.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "fix(web): resolve center tab header verification findings"
```

If verification changed no files, do not create an empty commit. Expected final state: automated gates pass, Computer Use has verified every accepted behavior, and no generated build or screenshot artifacts are staged.

---

## Completion Checklist

- [ ] The chat workspace has one top bar, not stacked title and tab rows.
- [ ] The visible thread-title box is absent while the header retains an accessible workspace label.
- [ ] The host tab shows and follows the current provider name; no tab says `Main`.
- [ ] Added AI and terminal tabs retain truthful labels and full-label tooltips.
- [ ] Multiple tabs are reachable by pointer, wheel/trackpad, active reveal, and horizontal arrow keys.
- [ ] Tabs never overlap, wrap, move, or shrink the pinned action and layout controls.
- [ ] Existing activate, close, middle-click, and context-menu behavior still works.
- [ ] Empty center-surface state keeps the fixed actions available.
- [ ] Focused tests pass.
- [ ] `vp check` passes.
- [ ] `vp run typecheck` passes.
- [ ] Codex Computer Use screenshots and accessibility inspection confirm every accepted change in the running BiBCode desktop UI.
