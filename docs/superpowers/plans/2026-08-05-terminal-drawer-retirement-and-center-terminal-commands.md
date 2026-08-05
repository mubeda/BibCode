# Terminal Drawer Retirement and Center Terminal Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the bottom terminal drawer and its toggle completely, retain the shared terminal renderer for center/right-panel surfaces, and make terminal keybindings create, split, focus, and close center terminals without leaking backend sessions.

**Architecture:** Replace drawer state with selectors derived from the persisted center/right surface stores. Introduce an atomic center-store placement API and a transactional terminal-creation controller: validate layout and geometry, open the PTY, commit the surface, then compensate with `terminal.close` if the commit fails. Give the retained terminal renderer an explicit `center-panel | right-panel` owner, route shortcuts by that owner, and normalize legacy `terminal.toggle` keybindings at the server load boundary.

**Tech Stack:** React 19, TypeScript, Zustand persistence, Effect Atom commands, terminal WebSocket RPC, Rust/Serde JSON keybinding loading, Vite+ tests, Cargo tests.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-orange-interaction-theme-and-terminal-drawer-retirement-design.md`.
- Remove the bottom drawer mount, hidden thread mounts, resize/height logic, top toolbar bottom-panel toggle, drawer state, and drawer persistence.
- Do not remove terminal RPCs, xterm rendering, attachment, history, input scheduling, links, context capture, provider activity, or right-panel terminal grouping/splitting.
- `Cmd/Ctrl+J` (`terminal.newCenter`) always creates a terminal tab in the focused center group.
- When a center terminal owns focus, `terminal.new` adds a tab, `terminal.split` creates a right center split, `terminal.splitVertical` creates a down center split, and `terminal.close` closes the active center surface/session.
- Preserve existing right-panel behavior for `terminal.new`, split, vertical split, and close.
- Reject pane-limit, geometry, missing-context, and illegal transitions before terminal spawn.
- Compensate a successful terminal spawn followed by a failed layout commit with `terminal.close({ deleteHistory: true })`.
- Do not close server sessions merely because legacy drawer presentation state is discarded.
- Keep the public `terminalOpen` keybinding context, redefining it as “the active thread has a center or right-panel terminal surface.”
- Route project-script execution into a visible center terminal; no code path may reopen or depend on the removed drawer.
- Do not edit `.repos/` or add dependencies.
- Use test-driven development for every behavior change.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Responsibility Map

### Command contract and migration

- `packages/contracts/src/keybindings.ts` and `.test.ts` — replace the static `terminal.toggle` command with `terminal.newCenter`.
- `packages/shared/src/keybindings.ts` and `.test.ts` — bind `mod+j` to `terminal.newCenter`.
- `apps/web/src/keybindings.ts` and `.test.ts` — current-command matching/labels only.
- `apps/web/src/components/settings/KeybindingsSettings.logic.ts` and `.test.ts` — user-facing label `New Center Terminal`.
- `apps/server/src/production/keybindings.rs` — recursively normalize valid legacy rule and `replace` commands before validation/resolution.
- `apps/server/tests/production_control.rs` and `apps/server/src/production/control.rs` tests — persisted/custom migration coverage.

### Supported terminal-surface state

- Create `apps/web/src/terminalSurfaceState.ts` and `.test.ts` — pure center/right `terminalOpen` selector plus hook.
- Create `apps/web/src/clientStateMigrations.ts` and `.test.ts` — idempotent v1 removal of `bibcode:terminal-state:v1` only.
- `apps/web/src/main.tsx` — run the client-state migration before application bootstrap.
- Delete `apps/web/src/terminalUiStateStore.ts` and `.test.ts` after consumers migrate.
- `apps/web/src/hooks/useThreadActions.ts` and `.test.ts` — remove center/right persisted surface state after successful thread deletion.

### Atomic center terminal lifecycle

- `apps/web/src/centerPanelStore.ts` and `.test.ts` — explicit tab/split placement, preflight, atomic commit, and boolean result.
- Create `apps/web/src/centerTerminalActions.ts` and `.test.ts` — transactional spawn/commit/compensation logic.
- `apps/web/src/components/CenterPanelWorkspace.tsx` and `.test.tsx` — imperative split-geometry preflight for the focused group.
- `apps/web/src/centerPanelActions.ts` and `.test.ts` — use the transactional center-terminal action and retain close cleanup.

### Renderer and ownership

- Rename `apps/web/src/components/ThreadTerminalDrawer.tsx` to `ThreadTerminalPanel.tsx`.
- Rename its three test files to `ThreadTerminalPanel.test.ts`, `ThreadTerminalPanel.test.tsx`, and `ThreadTerminalPanel.interactions.test.tsx`.
- `apps/web/src/components/CenterTerminalPanel.tsx` and `.test.tsx` — render owner `center-panel`.
- `apps/web/src/components/ChatView.tsx` right-panel host — render owner `right-panel`.
- `apps/web/src/lib/terminalFocus.ts` and `.test.ts` — supported owner union only.

### Drawer UI and routing removal

- `apps/web/src/components/ChatView.tsx`, `.test.tsx`, and `.hooks.test.tsx` — delete drawer host/state and route terminal commands by owner.
- `apps/web/src/components/chat/PanelLayoutControls.tsx` and `.test.tsx` — right-panel toggle only; rename to `RightPanelLayoutControl` if that yields the clearest API.
- `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/routes/_chat.tsx`, `apps/web/src/components/Sidebar.tsx` and their tests — consume derived terminal-surface context.
- `apps/web/src/components/chat/ChatComposer.tsx` and related fixtures — continue receiving derived `terminalOpen` only where the keybinding/model-picker context needs it.
- `apps/web/src/projectScripts.test.ts`, `apps/web/src/zero-coverage-routes.test.tsx`, and terminal renderer mocks — update obsolete command/component names.

---

### Task 1: Replace `terminal.toggle` with `terminal.newCenter`

**Files:**

- Modify: `packages/contracts/src/keybindings.ts`
- Modify: `packages/contracts/src/keybindings.test.ts`
- Modify: `packages/shared/src/keybindings.ts`
- Modify: `packages/shared/src/keybindings.test.ts`
- Modify: `apps/web/src/keybindings.ts`
- Modify: `apps/web/src/keybindings.test.ts`
- Modify: `apps/web/src/components/settings/KeybindingsSettings.logic.ts`
- Modify: `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts`
- Modify: `apps/server/src/production/keybindings.rs`
- Modify: `apps/server/tests/production_control.rs`
- Modify: `apps/server/src/production/control.rs` test fixtures

**Interfaces:**

- Current command: `terminal.newCenter`.
- Removed current command: `terminal.toggle`.
- Default rule: `{ key: "mod+j", command: "terminal.newCenter" }`.
- Migration: every legacy `command` field equal to `terminal.toggle`, including nested `replace`, becomes `terminal.newCenter` before validation.

- [ ] **Step 1: Make the TypeScript command catalog tests fail**

Update the expected static command list and default-binding assertions:

```ts
expect(decodeKeybindingCommand("terminal.newCenter")).toBe("terminal.newCenter");
expect(() => decodeKeybindingCommand("terminal.toggle")).toThrow();
expect(DEFAULT_KEYBINDINGS).toContainEqual({
  key: "mod+j",
  command: "terminal.newCenter",
});
```

Update web shortcut fixtures so `mod+j` resolves to `terminal.newCenter`.

- [ ] **Step 2: Run the command-contract tests and confirm red**

```bash
vp test packages/contracts/src/keybindings.test.ts packages/shared/src/keybindings.test.ts apps/web/src/keybindings.test.ts
```

Expected: FAIL because `terminal.toggle` remains in the catalog/defaults.

- [ ] **Step 3: Replace the current command and helper**

In `packages/contracts/src/keybindings.ts`, replace the static literal. In `packages/shared/src/keybindings.ts`, replace the `mod+j` rule. In `apps/web/src/keybindings.ts`, rename/remove `isTerminalToggleShortcut`; if a named helper remains, it must match `terminal.newCenter` and be named `isTerminalNewCenterShortcut`.

Add an explicit settings label before the generic title-case fallback:

```ts
if (command === "terminal.newCenter") return "New Center Terminal";
```

- [ ] **Step 4: Add failing Rust migration tests**

In `apps/server/src/production/keybindings.rs` tests, add:

```rust
#[test]
fn legacy_terminal_toggle_is_normalized_recursively() {
    let rule = json!({
        "key": "alt+j",
        "command": "terminal.toggle",
        "when": "!terminalFocus",
        "replace": {
            "key": "mod+j",
            "command": "terminal.toggle"
        }
    });
    assert_eq!(
        normalize_legacy_commands(rule),
        json!({
            "key": "alt+j",
            "command": "terminal.newCenter",
            "when": "!terminalFocus",
            "replace": {
                "key": "mod+j",
                "command": "terminal.newCenter"
            }
        })
    );
}
```

Add an integration assertion in `production_control.rs` that a persisted legacy custom shortcut retains its key/when while the returned current command is `terminal.newCenter`.

- [ ] **Step 5: Run the Rust tests and confirm red**

```bash
cargo test -p bibcode-server keybindings -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
```

Expected: compilation/test failure because normalization is absent.

- [ ] **Step 6: Normalize before validation**

Implement a recursive value normalizer:

```rust
fn normalize_legacy_commands(mut rule: Value) -> Value {
    if let Some(object) = rule.as_object_mut() {
        if object.get("command").and_then(Value::as_str) == Some("terminal.toggle") {
            object.insert("command".to_owned(), json!("terminal.newCenter"));
        }
        if let Some(replace) = object.remove("replace") {
            object.insert("replace".to_owned(), normalize_legacy_commands(replace));
        }
    }
    rule
}
```

Call it for each loaded rule before current-schema validation. Preserve unrelated fields and the existing malformed-entry reporting path.

- [ ] **Step 7: Run focused tests and commit**

```bash
vp test packages/contracts/src/keybindings.test.ts packages/shared/src/keybindings.test.ts apps/web/src/keybindings.test.ts apps/web/src/components/settings/KeybindingsSettings.logic.test.ts
cargo test -p bibcode-server keybindings -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
git add packages/contracts/src/keybindings.ts packages/contracts/src/keybindings.test.ts packages/shared/src/keybindings.ts packages/shared/src/keybindings.test.ts apps/web/src/keybindings.ts apps/web/src/keybindings.test.ts apps/web/src/components/settings/KeybindingsSettings.logic.ts apps/web/src/components/settings/KeybindingsSettings.logic.test.ts apps/server/src/production/keybindings.rs apps/server/src/production/control.rs apps/server/tests/production_control.rs
git commit -m "feat(keybindings): migrate terminal shortcut to center"
```

---

### Task 2: Derive Terminal Context from Supported Surfaces and Retire Legacy Persistence

**Files:**

- Create: `apps/web/src/terminalSurfaceState.ts`
- Create: `apps/web/src/terminalSurfaceState.test.ts`
- Create: `apps/web/src/clientStateMigrations.ts`
- Create: `apps/web/src/clientStateMigrations.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify later in this task: `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/routes/_chat.tsx`, `apps/web/src/components/Sidebar.tsx`

**Interfaces:**

```ts
export function selectThreadHasTerminalSurface(
  centerByThreadKey: Record<string, ThreadCenterPanelState>,
  rightByThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): boolean;

export function useThreadHasTerminalSurface(
  ref: ScopedThreadRef | null | undefined,
): boolean;
```

- [ ] **Step 1: Add failing pure selector tests**

Create center-only, right-only, unrelated-thread, and empty cases using the real stores:

```ts
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useCenterPanelStore } from "./centerPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import { selectThreadHasTerminalSurface } from "./terminalSurfaceState";

const ref = scopeThreadRef("local" as EnvironmentId, "thread-a" as ThreadId);
const otherRef = scopeThreadRef("local" as EnvironmentId, "thread-b" as ThreadId);

function selected(refToRead = ref): boolean {
  return selectThreadHasTerminalSurface(
    useCenterPanelStore.getState().byThreadKey,
    useRightPanelStore.getState().byThreadKey,
    refToRead,
  );
}

beforeEach(() => {
  useCenterPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("selectThreadHasTerminalSurface", () => {
  it("returns true for a center terminal", () => {
    useCenterPanelStore.getState().openTerminalPanel(ref, "term-1");
    expect(selected()).toBe(true);
  });

  it("returns true for a right-panel terminal", () => {
    useRightPanelStore.getState().openTerminal(ref, "term-2");
    expect(selected()).toBe(true);
  });

  it("returns false for an empty or unrelated thread", () => {
    useCenterPanelStore.getState().openTerminalPanel(otherRef, "term-3");
    expect(selected()).toBe(false);
    expect(selected(otherRef)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the selector test and confirm red**

```bash
vp test apps/web/src/terminalSurfaceState.test.ts
```

Expected: compilation failure because the module does not exist.

- [ ] **Step 3: Implement one pure selector and one hook**

Use `selectThreadCenterPanelState` and `selectThreadRightPanelState`; return true when either state's `surfaces` contains `kind === "terminal"`. The hook subscribes separately to `useCenterPanelStore` and `useRightPanelStore`, then calls the pure selector. Do not inspect server-known sessions because a session without a supported surface is not open UI.

- [ ] **Step 4: Add the idempotent v1 storage migration test**

```ts
function memoryStorage(seed: Record<string, string>): Storage {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

it("removes only the retired drawer key without closing sessions", () => {
  const storage = memoryStorage({
    "bibcode:terminal-state:v1": "legacy",
    "bibcode:center-panel-state:v1": "center",
    "bibcode:right-panel-state:v2": "right",
  });

  runClientStateMigrationsV1(storage);
  runClientStateMigrationsV1(storage);

  expect(storage.getItem("bibcode:terminal-state:v1")).toBeNull();
  expect(storage.getItem("bibcode:center-panel-state:v1")).toBe("center");
  expect(storage.getItem("bibcode:right-panel-state:v2")).toBe("right");
});
```

The migration module must not import `terminalEnvironment` or any RPC layer.

- [ ] **Step 5: Implement and bootstrap the migration**

```ts
export const RETIRED_TERMINAL_DRAWER_STORAGE_KEY = "bibcode:terminal-state:v1";

export function runClientStateMigrationsV1(
  storage: Pick<Storage, "removeItem">,
): void {
  storage.removeItem(RETIRED_TERMINAL_DRAWER_STORAGE_KEY);
}
```

Call it at the start of `main()` using the existing safe storage resolver before importing `./bootstrap`; catch storage failures using the same policy as `lib/storage.ts`.

- [ ] **Step 6: Migrate shortcut-context consumers**

Replace drawer-store subscriptions in `CommandPalette.tsx`, `routes/_chat.tsx`, and `Sidebar.tsx` with `useThreadHasTerminalSurface(routeThreadRef)`. Update their mocks/tests so center and right terminal fixtures both produce `{ terminalOpen: true }` in shortcut resolution.

- [ ] **Step 7: Run focused tests and commit**

```bash
vp test apps/web/src/terminalSurfaceState.test.ts apps/web/src/clientStateMigrations.test.ts apps/web/src/components/CommandPalette.test.tsx apps/web/src/routes/_chat.test.tsx apps/web/src/components/Sidebar.test.tsx
git add apps/web/src/terminalSurfaceState.ts apps/web/src/terminalSurfaceState.test.ts apps/web/src/clientStateMigrations.ts apps/web/src/clientStateMigrations.test.ts apps/web/src/main.tsx apps/web/src/components/CommandPalette.tsx apps/web/src/components/CommandPalette.test.tsx apps/web/src/routes/_chat.tsx apps/web/src/routes/_chat.test.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "refactor(web): derive terminal context from surfaces"
```

---

### Task 3: Add Atomic Center Terminal Placement

**Files:**

- Modify: `apps/web/src/centerPanelStore.ts`
- Modify: `apps/web/src/centerPanelStore.test.ts`

**Interfaces:**

```ts
export type CenterTerminalPlacement =
  | { readonly type: "tab"; readonly groupId: string }
  | {
      readonly type: "split";
      readonly groupId: string;
      readonly direction: "right" | "down";
    };

export type CenterTerminalPlacementValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing-group" | "pane-limit" };

validateTerminalPanelPlacement(
  ref: ScopedThreadRef,
  placement: CenterTerminalPlacement,
): CenterTerminalPlacementValidation;
placeTerminalPanel(
  ref: ScopedThreadRef,
  terminalId: string,
  placement: CenterTerminalPlacement,
  options?: OpenTerminalPanelOptions,
): boolean;
```

- [ ] **Step 1: Write failing store tests for explicit tab placement**

```ts
it("places and activates a terminal tab in the requested group", () => {
  const store = useCenterPanelStore.getState();
  const result = store.placeTerminalPanel(ref, "term-7", {
    type: "tab",
    groupId: CENTER_PANEL_ROOT_GROUP_ID,
  });
  expect(result).toBe(true);
  const state = selectThreadCenterPanelState(useCenterPanelStore.getState().byThreadKey, ref);
  expect(findCenterPanelGroup(state, CENTER_PANEL_ROOT_GROUP_ID)).toMatchObject({
    activeSurfaceId: "terminal:term-7",
  });
  expect(state.focusedGroupId).toBe(CENTER_PANEL_ROOT_GROUP_ID);
});
```

- [ ] **Step 2: Add split atomicity/cap tests**

Test right maps to layout `splitDirection: "right"`, down maps to `"down"`, a fifth pane validates as `{ ok: false, reason: "pane-limit" }` and returns false without adding a surface, and an unknown target validates as `{ ok: false, reason: "missing-group" }` and returns false without mutation. Assert options preserve `label` and `command`.

- [ ] **Step 3: Run the focused test and confirm red**

```bash
vp test apps/web/src/centerPanelStore.test.ts -t "terminal"
```

Expected: compilation failure because the placement API does not exist.

- [ ] **Step 4: Implement preflight and one-set atomic placement**

For a tab, call `insertCenterPanelSurface(current, surface.id, placement.groupId)` and add the descriptor only if the mutation changes. For a split:

1. Insert the new descriptor into the requested group in memory.
2. Call `dropCenterPanelSurface` on that just-inserted surface with a generated `center-group:${crypto.randomUUID()}` and `right`/`down`.
3. Publish `{ ...mutation.state, surfaces }` in the same Zustand `set` callback.
4. Set a local `changed` flag and return it after `set`.

Preflight must distinguish missing groups from `MAX_CENTER_PANEL_GROUPS` before generating an ID. `placeTerminalPanel` reruns validation inside its `set` callback so a race is safely rejected. Keep `openTerminalPanel` as a thin focused-group compatibility wrapper until Task 6 removes old callers.

- [ ] **Step 5: Run the store suite and commit**

```bash
vp test apps/web/src/centerPanelStore.test.ts apps/web/src/centerPanelLayout.test.ts
git add apps/web/src/centerPanelStore.ts apps/web/src/centerPanelStore.test.ts
git commit -m "feat(web): place center terminals atomically"
```

---

### Task 4: Transact Terminal Spawn and Layout Commit

**Files:**

- Create: `apps/web/src/centerTerminalActions.ts`
- Create: `apps/web/src/centerTerminalActions.test.ts`
- Modify: `apps/web/src/components/CenterPanelWorkspace.tsx`
- Modify: `apps/web/src/components/CenterPanelWorkspace.test.tsx`

**Interfaces:**

```ts
export interface CenterTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
  readonly label?: string;
  readonly command?: TerminalLaunchCommand;
}

export interface CreateCenterTerminalInput {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly placement: CenterTerminalPlacement;
  readonly launch: CenterTerminalLaunch | null;
}

export type CenterTerminalCreationResult =
  | { readonly status: "opened"; readonly terminalId: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export interface CenterPanelWorkspaceHandle {
  canSplitGroup(groupId: string, direction: "right" | "down"): boolean;
}

export interface CenterTerminalActionDependencies {
  readonly validatePlacement: (
    placement: CenterTerminalPlacement,
  ) => CenterTerminalPlacementValidation;
  readonly canSplit: (groupId: string, direction: "right" | "down") => boolean;
  readonly openSession: (
    input: TerminalOpenInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly place: (
    terminalId: string,
    placement: CenterTerminalPlacement,
    options?: OpenTerminalPanelOptions,
  ) => boolean;
  readonly closeSession: (input: TerminalCloseInput) => Promise<void>;
}
```

- [ ] **Step 1: Write preflight-before-open tests**

Use injected functions/spies for `validatePlacement`, `canSplit`, `openSession`, `place`, and `closeSession`:

```ts
const validAction: CreateCenterTerminalInput = {
  threadRef: scopeThreadRef("local" as EnvironmentId, "thread-a" as ThreadId),
  terminalId: "term-4",
  placement: { type: "tab", groupId: CENTER_PANEL_ROOT_GROUP_ID },
  launch: {
    cwd: "/workspace/project",
    worktreePath: null,
    env: { BIBCODE_WORKTREE_PATH: "/workspace/project" },
  },
};
const openSession = vi.fn(async () => ({ ok: true as const }));
const place = vi.fn(() => true);
const closeSession = vi.fn(async () => undefined);
const deps: CenterTerminalActionDependencies = {
  validatePlacement: () => ({ ok: false, reason: "pane-limit" }),
  canSplit: () => true,
  openSession,
  place,
  closeSession,
};

const result = await createCenterTerminal(validAction, deps);

expect(result).toEqual({ status: "rejected", reason: "Center pane limit reached." });
expect(openSession).not.toHaveBeenCalled();
expect(place).not.toHaveBeenCalled();
```

Add the geometry case by setting `validatePlacement: () => ({ ok: true })`, `canSplit: () => false` on a split action, and the missing-context case by setting `launch: null`. Each must make the same no-spawn/no-place assertions with its exact reason.

- [ ] **Step 2: Write spawn/commit/compensation tests**

```ts
it("closes a spawned session when the atomic placement loses its race", async () => {
  const closeSession = vi.fn(async () => undefined);
  const deps: CenterTerminalActionDependencies = {
    validatePlacement: () => ({ ok: true }),
    canSplit: () => true,
    openSession: vi.fn(async () => ({ ok: true as const })),
    place: vi.fn(() => false),
    closeSession,
  };
  const result = await createCenterTerminal(validAction, deps);

  expect(result.status).toBe("failed");
  expect(closeSession).toHaveBeenCalledWith({
    threadId: validAction.threadRef.threadId,
    terminalId: validAction.terminalId,
    deleteHistory: true,
  });
});
```

Also prove open failure does not call `place` or `closeSession`, and success preserves `command`, cwd, worktree path, and environment in `TerminalOpenInput`.

- [ ] **Step 3: Run the controller tests and confirm red**

```bash
vp test apps/web/src/centerTerminalActions.test.ts
```

Expected: compilation failure because the controller does not exist.

- [ ] **Step 4: Implement the dependency-injected transaction**

Keep `createCenterTerminal` free of React and Zustand imports. It must:

1. Validate the host ref/launch values supplied by the caller.
2. Call `validatePlacement`; for split placement also call `canSplit`.
3. Await `openSession` with a complete `TerminalOpenInput`.
4. Call `place` only after open success.
5. Await compensating close when `place` returns false.
6. Return a discriminated result; let the React boundary translate non-interruption failures into a toast.

- [ ] **Step 5: Expose geometry through a narrow workspace handle**

Convert `CenterPanelWorkspace` to `forwardRef<CenterPanelWorkspaceHandle, CenterPanelWorkspaceProps>`. Implement `canSplitGroup` using the existing `targets.readBodyRect`, `canCenterPanelPaneSplit`, and current store/layout preflight. Do not add a second ResizeObserver or query the whole document.

- [ ] **Step 6: Test the workspace handle and commit**

```bash
vp test apps/web/src/centerTerminalActions.test.ts apps/web/src/components/CenterPanelWorkspace.test.tsx
git add apps/web/src/centerTerminalActions.ts apps/web/src/centerTerminalActions.test.ts apps/web/src/components/CenterPanelWorkspace.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
git commit -m "feat(web): transact center terminal creation"
```

---

### Task 5: Convert the Shared Drawer Renderer into an Explicitly Owned Panel Renderer

**Files:**

- Rename: `apps/web/src/components/ThreadTerminalDrawer.tsx` → `apps/web/src/components/ThreadTerminalPanel.tsx`
- Rename: `apps/web/src/components/ThreadTerminalDrawer.test.ts` → `apps/web/src/components/ThreadTerminalPanel.test.ts`
- Rename: `apps/web/src/components/ThreadTerminalDrawer.test.tsx` → `apps/web/src/components/ThreadTerminalPanel.test.tsx`
- Rename: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx` → `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Modify: `apps/web/src/components/CenterTerminalPanel.tsx`
- Modify: `apps/web/src/components/CenterTerminalPanel.test.tsx`
- Modify: `apps/web/src/lib/terminalFocus.ts`
- Modify: `apps/web/src/lib/terminalFocus.test.ts`

**Interfaces:**

```ts
export type TerminalPanelOwner = "center-panel" | "right-panel";

interface ThreadTerminalPanelProps {
  readonly owner: TerminalPanelOwner;
  // existing terminal/session/group/action props remain
  // no mode, visible, height, or onHeightChange props
}
```

- [ ] **Step 1: Change focus-owner tests to the supported union**

Replace the drawer case with:

```ts
it("returns the center panel owner for focus inside a center terminal", () => {
  const attached = new MockHTMLElement();
  attached.isConnected = true;
  attached.terminalOwner = "center-panel";
  attached.dataset.terminalOwner = "center-panel";
  globalThis.document = { activeElement: attached } as unknown as Document;
  expect(getTerminalFocusOwner()).toBe("center-panel");
  expect(isTerminalFocused()).toBe(true);
});

it("rejects the retired drawer owner", () => {
  const attached = new MockHTMLElement();
  attached.isConnected = true;
  attached.terminalOwner = "drawer";
  attached.dataset.terminalOwner = "drawer";
  globalThis.document = { activeElement: attached } as unknown as Document;
  expect(getTerminalFocusOwner()).toBeNull();
});
```

- [ ] **Step 2: Rename files/imports first and run tests**

Use `mv` for the renames, then update imports/mocks mechanically. Run:

```bash
vp test apps/web/src/components/ThreadTerminalPanel.test.ts apps/web/src/components/ThreadTerminalPanel.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/CenterTerminalPanel.test.tsx apps/web/src/lib/terminalFocus.test.ts
```

Expected: tests still expose drawer-only props/branches and fail the new owner assertions.

- [ ] **Step 3: Remove drawer-only renderer code**

Delete:

- `mode`, `visible`, `height`, and `onHeightChange` props;
- `MIN_DRAWER_HEIGHT`, `MAX_DRAWER_HEIGHT_RATIO`, `maxDrawerHeight`, and `clampDrawerHeight`;
- pointer resize state/effects/handle;
- drawer-only border/height/visibility branches;
- `isTerminalToggleShortcut` handling inside the renderer.

Render a full-height panel root in all cases:

```tsx
<aside
  data-terminal-owner={owner}
  className="thread-terminal-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
>
```

Preserve group normalization, right-panel internal splits, terminal controls, xterm lifetime, activity dock, links, input scheduler, and theme handling.

- [ ] **Step 4: Pass owners from both hosts**

`CenterTerminalPanel` passes `owner="center-panel"`; the right-panel host in `ChatView.tsx` passes `owner="right-panel"`. Update comments and test names so no supported API mentions a drawer.

- [ ] **Step 5: Run renderer/focus tests and commit**

```bash
vp test apps/web/src/components/ThreadTerminalPanel.test.ts apps/web/src/components/ThreadTerminalPanel.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/CenterTerminalPanel.test.tsx apps/web/src/lib/terminalFocus.test.ts
git add -A apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalPanel.tsx apps/web/src/components/ThreadTerminalDrawer.test.ts apps/web/src/components/ThreadTerminalPanel.test.ts apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalPanel.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/CenterTerminalPanel.tsx apps/web/src/components/CenterTerminalPanel.test.tsx apps/web/src/lib/terminalFocus.ts apps/web/src/lib/terminalFocus.test.ts
git commit -m "refactor(web): make terminal renderer panel only"
```

---

### Task 6: Remove Drawer Composition and Route Center/Right Commands

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/centerPanelActions.ts`
- Modify: `apps/web/src/centerPanelActions.test.ts`
- Modify: `apps/web/src/components/chat/PanelLayoutControls.tsx`
- Modify: `apps/web/src/components/chat/PanelLayoutControls.test.tsx`

**Interfaces and routing matrix:**

| Command | No terminal owner | `center-panel` | `right-panel` |
|---|---|---|---|
| `terminal.newCenter` | focused center group tab | focused center group tab | focused center group tab |
| `terminal.new` | no-op | same center group tab | existing right-panel new terminal |
| `terminal.split` | no-op | new right center split | existing right-panel horizontal split |
| `terminal.splitVertical` | no-op | new down center split | existing right-panel vertical split |
| `terminal.close` | no-op | close active center terminal surface | existing right-panel close |

- [ ] **Step 1: Replace drawer shortcut tests with the routing matrix**

In `ChatView.hooks.test.tsx`, add parameterized cases that set `data-terminal-owner`, dispatch the resolved command, and assert the exact center/right action spy. Include:

- `terminal.newCenter` from composer and right-panel focus targets center;
- center new/tab, split right, split down, close;
- right new/splits/close regressions;
- center split geometry rejection makes no `terminal.open` call;
- layout commit failure calls `terminal.close(deleteHistory: true)`.
- successful create/split increments the focus request only after placement;
- close activates the next group-local tab, and closing an empty split collapses to and focuses the surviving group.

- [ ] **Step 2: Add drawer absence tests**

In `ChatView.test.tsx`, assert rendered output has no `PersistentThreadTerminalDrawer`, `data-terminal-owner="drawer"`, `Toggle terminal drawer`, or bottom-panel icon. In `PanelLayoutControls.test.tsx`, assert the only toggle is `Toggle right panel`.

- [ ] **Step 3: Run the ChatView/control tests and confirm red**

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/PanelLayoutControls.test.tsx
```

Expected: FAIL because drawer state/composition and toggle remain.

- [ ] **Step 4: Wire the transactional center action**

In `ChatView`, create one `CenterPanelWorkspaceHandle` ref. Build `openCenterTerminal(placement, options, launchOverride?)` around `createCenterTerminal` with:

- IDs allocated by `nextTerminalId([...activeKnownTerminalIds, ...centerTerminalIds, ...panelTerminalIds])`;
- current focused group from `selectFocusedCenterPanelGroup(centerPanelState)`;
- geometry from `workspaceRef.current?.canSplitGroup`;
- `terminalEnvironment.open` and `.close` atom commands;
- `useCenterPanelStore.getState().validateTerminalPanelPlacement/placeTerminalPanel`;
- one toast per non-interruption rejection/failure;
- `setTerminalFocusRequestId(value => value + 1)` only after successful placement.

Pass `label` and structured provider `command` through `TerminalOpenInput` and `OpenTerminalPanelOptions`.

- [ ] **Step 5: Replace the keyboard handler branches**

Use the routing table above. For center close, resolve `selectFocusedCenterSurface(centerPanelState)` and call the existing center lifecycle close only when it is `kind === "terminal"`. Do not fall through to right-panel behavior when the center owner is present but the action is invalid.

Set shortcut context as:

```ts
const shortcutContext = {
  terminalFocus: terminalFocusOwner !== null,
  terminalOpen: hasTerminalSurface,
  modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
};
```

- [ ] **Step 6: Route project scripts into center terminals**

Remove `setTerminalOpen`, drawer launch context, and drawer store mutations from `runProjectScript`. If the focused center surface is an idle terminal, focus/open that session and enqueue the command there; otherwise create a new center tab transactionally using the script cwd/worktree/runtime env, then enqueue only after the transaction reports `opened`. Preserve the existing busy-terminal check, `rememberAsLastInvoked`, preview behavior, error reporting, and input scheduler.

- [ ] **Step 7: Delete the persistent drawer host and simplify the toolbar control**

Delete `PersistentThreadTerminalDrawer`, `mountedTerminalThreadRefs`, drawer focus effects, and the drawer mount after the center workspace. Remove `PanelBottomIcon` and all terminal-drawer props/callbacks from `PanelLayoutControls`; optionally rename the component/file to `RightPanelLayoutControl` and update imports in the same commit.

- [ ] **Step 8: Run the focused integration tests and commit**

```bash
vp test apps/web/src/centerTerminalActions.test.ts apps/web/src/centerPanelActions.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/PanelLayoutControls.test.tsx
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/centerPanelActions.ts apps/web/src/centerPanelActions.test.ts apps/web/src/components/chat/PanelLayoutControls.tsx apps/web/src/components/chat/PanelLayoutControls.test.tsx
git commit -m "feat(web): route terminal commands to center panels"
```

---

### Task 7: Delete Drawer State and Clean Every Remaining Consumer

**Files:**

- Delete: `apps/web/src/terminalUiStateStore.ts`
- Delete: `apps/web/src/terminalUiStateStore.test.ts`
- Modify: `apps/web/src/hooks/useThreadActions.ts`
- Modify: `apps/web/src/hooks/useThreadActions.test.ts`
- Modify: all remaining test fixtures/mocks reported by the searches below

- [ ] **Step 1: Change thread-deletion cleanup tests**

Mock the supported stores and assert successful deletion calls both:

```ts
expect(useCenterPanelStore.getState().removeThread).toHaveBeenCalledWith(ref);
expect(useRightPanelStore.getState().removeThread).toHaveBeenCalledWith(ref);
```

Cover dependent panel threads as well as the requested thread. Keep the backend `terminal.close` teardown unchanged.

- [ ] **Step 2: Replace cleanup implementation**

Remove `useTerminalUiStateStore`. After successful thread deletion, call `removeThread` on `useCenterPanelStore.getState()` and `useRightPanelStore.getState()` for each deleted ref. Do not clear surface state before backend deletion succeeds.

- [ ] **Step 3: Delete the drawer store and eliminate references**

```bash
rg -n "terminalUiStateStore|useTerminalUiStateStore|selectThreadTerminalUiState|PersistentThreadTerminalDrawer|ThreadTerminalDrawer|terminal\.toggle|Toggle terminal drawer|data-terminal-owner=.?drawer|PanelBottomIcon" apps packages
```

Expected after cleanup: no production references. The only allowed `terminal.toggle` string is in the Rust legacy-normalization test/input. Update `projectScripts.test.ts`, zero-coverage mocks, ChatComposer fixtures, route/sidebar/palette mocks, and renamed terminal renderer imports.

- [ ] **Step 4: Run every affected web and Rust suite**

```bash
vp test apps/web/src/hooks/useThreadActions.test.ts apps/web/src/components/CommandPalette.test.tsx apps/web/src/routes/_chat.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ThreadTerminalPanel.test.ts apps/web/src/components/ThreadTerminalPanel.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/projectScripts.test.ts apps/web/src/zero-coverage-routes.test.tsx
cargo test -p bibcode-server keybindings -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit final drawer deletion**

```bash
git add -A apps/web/src apps/server packages
git commit -m "refactor(web): remove retired terminal drawer state"
```

---

### Task 8: Full Lifecycle, Build, and Desktop Verification

**Files:**

- Modify: `docs/user/workspace-ui.md`
- Local only: `.artifacts/visual-qa/terminal-drawer-retirement/`
- Local only: `.artifacts/visual-qa/orange-theme/`

- [ ] **Step 1: Document current terminal entry points**

Update the workspace UI documentation: `Cmd/Ctrl+J` opens a center terminal, center terminal shortcuts create center tabs/splits, right-panel terminals retain internal splitting, and the bottom drawer no longer exists.

- [ ] **Step 2: Run static absence and source-integrity checks**

```bash
rg -n "terminalUiStateStore|PersistentThreadTerminalDrawer|ThreadTerminalDrawer|Toggle terminal drawer|PanelBottomIcon" apps packages
rg -n 'terminal\.toggle' apps packages
git diff --check
```

Expected: the first search has no hits; the second has only explicit legacy-migration fixtures/tests; diff check exits 0.

- [ ] **Step 3: Run the full required test gates**

```bash
vp test
vp check
vp run typecheck
```

Expected: all exit 0.

- [ ] **Step 4: Build and launch the desktop app**

Run the canonical production build, then launch this worktree's desktop development host:

```bash
vp run build:desktop
vp run start:desktop
```

Keep the launched process running for UI verification; do not substitute an Orca runtime.

- [ ] **Step 5: Verify with Codex Computer Use**

Invoke `computer-use:computer-use` (the Codex bundled skill, not Orca's CLI) and verify:

1. No bottom drawer and no bottom-panel toolbar toggle.
2. `Cmd/Ctrl+J` creates and focuses a center terminal tab.
3. Center new, split right, split down, and close shortcuts work and collapse empty panes correctly.
4. Rejected fifth-pane and too-small split attempts show a notice and create no hidden server session.
5. Right-panel terminal new/split/close still work.
6. Project scripts run in a visible center terminal.
7. Restarting the app removes only legacy drawer storage and preserves center/right layouts.

For the final **combined** verification, the root controller owns the orange
theme QA after this terminal-drawer-retirement plan and the responsive-toolbar
plan are implemented and `vp run build:desktop` succeeds. Still using Codex
`computer-use:computer-use`, verify in both light and dark themes that:

8. Buttons, toggles, selected tabs/rows, and focus rings use the exact
   `#d8610e` orange interaction treatment, with white text for solid
   selections.
9. Links and informational states remain blue.
10. Full-resolution screenshots for those checks are saved under ignored
    `.artifacts/visual-qa/orange-theme/` and inspected before final approval.

Save screenshots under ignored `.artifacts/visual-qa/terminal-drawer-retirement/` and inspect full-resolution captures before completion.

- [ ] **Step 6: Stop the verification app and commit documentation/fixes**

Stop only the process started for this verification. Commit any required corrections together after rerunning their focused tests and the three required gates.
