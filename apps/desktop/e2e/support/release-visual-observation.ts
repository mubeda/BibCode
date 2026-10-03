import type { VisualScene } from "./release-visual-evidence.ts";
export interface VisualObservationInput {
  scene: VisualScene;
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}

/** One disposable observer of real events around the existing owned clear command. */
export function observeVisualNameClear(input: {
  origin: string;
  threadId: string;
  admission: string;
  admitted?: boolean;
  operation: "start" | "finish";
}): true | Record<string, unknown> | null {
  const marker = "__bibcodeOwnedVisualNameClear";
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.admission)
    )
      return null;
    const anchor = marker + ":" + input.admission;
    const safe =
      input.origin === "http://127.0.0.1:4885" &&
      location.origin === input.origin &&
      location.search === "" &&
      location.hash === "" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) &&
      location.pathname === "/local/" + input.threadId;
    const descriptor = Object.getOwnPropertyDescriptor(window, marker);
    const anchorDescriptor = Object.getOwnPropertyDescriptor(window, anchor);
    if (input.operation === "finish") {
      // Remove our listeners even after route loss, without reading that page.
      if (
        input.admitted !== true ||
        !anchorDescriptor ||
        !Object.hasOwn(anchorDescriptor, "value") ||
        anchorDescriptor.configurable !== false ||
        anchorDescriptor.writable !== false ||
        typeof anchorDescriptor.value !== "function"
      )
        return null;
      return anchorDescriptor.value(safe);
    }
    if (
      input.operation !== "start" ||
      !safe ||
      descriptor !== undefined ||
      anchorDescriptor !== undefined
    )
      return null;
    const selector = '[data-slot="dialog-popup"][role="dialog"] input[placeholder="Worktree name"]';
    const controls = document.querySelectorAll(selector);
    if (controls.length !== 1 || !(controls[0] instanceof HTMLInputElement)) return null;
    const ownedPathname = "/local/" + input.threadId;
    let name: HTMLInputElement | null = controls[0];
    const emptyBefore = name.value === "";
    let inputs = 0,
      changes = 0,
      trustedInputs = 0,
      trustedChanges = 0;
    let onInput: ((event: Event) => void) | null = (event: Event) => {
      if (event.target !== name) return;
      inputs = Math.min(2, inputs + 1);
      if (event.isTrusted) trustedInputs = Math.min(2, trustedInputs + 1);
    };
    let onChange: ((event: Event) => void) | null = (event: Event) => {
      if (event.target !== name) return;
      changes = Math.min(2, changes + 1);
      if (event.isTrusted) trustedChanges = Math.min(2, trustedChanges + 1);
    };
    const finish = (safeLocation: boolean) => {
      if (name === null) return null;
      const ownedName = name;
      const ownedInput = onInput;
      const ownedChange = onChange;
      name = null;
      onInput = null;
      onChange = null;
      if (ownedInput) ownedName.removeEventListener("input", ownedInput, true);
      if (ownedChange) ownedName.removeEventListener("change", ownedChange, true);
      const currentMarker = Object.getOwnPropertyDescriptor(window, marker);
      if (
        !currentMarker ||
        !Object.hasOwn(currentMarker, "value") ||
        currentMarker.value !== finish
      )
        return null;
      Reflect.deleteProperty(window, marker);
      if (!safeLocation || location.pathname !== ownedPathname) return null;
      const current = document.querySelectorAll(selector);
      const sameInput = current.length === 1 && current[0] === ownedName;
      const count = (value: number) => (value === 0 ? "none" : value === 1 ? "one" : "multiple");
      return {
        nameCount: count(current.length),
        sameInput,
        emptyBefore,
        emptyAfter: sameInput ? ownedName.value === "" : null,
        inputEvents: count(inputs),
        changeEvents: count(changes),
        trustedInputEvents: count(trustedInputs),
        trustedChangeEvents: count(trustedChanges),
        observerClosed: true,
      };
    };
    // One immutable lifetime anchor survives only until the owned browser teardown.
    Object.defineProperty(window, anchor, { value: finish });
    Object.defineProperty(window, marker, { value: finish, configurable: true });
    name.addEventListener("input", onInput, true);
    name.addEventListener("change", onChange, true);
    return true;
  } catch {
    return null;
  }
}

/** Closed failure metadata only; never native input values or capture approval. */
export function projectVisualNameClearObservation(input: unknown): Record<string, unknown> | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const keys = [
      "nameCount",
      "sameInput",
      "emptyBefore",
      "emptyAfter",
      "inputEvents",
      "changeEvents",
      "trustedInputEvents",
      "trustedChangeEvents",
      "observerClosed",
    ];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      const value = descriptor.value;
      if (
        [
          "nameCount",
          "inputEvents",
          "changeEvents",
          "trustedInputEvents",
          "trustedChangeEvents",
        ].includes(key)
      ) {
        if (value !== "none" && value !== "one" && value !== "multiple") return null;
      } else if (!(typeof value === "boolean" || (key === "emptyAfter" && value === null)))
        return null;
      snapshot[key] = value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
/** Serialized as one read-only WebDriver function. Returns closed booleans, never page values. */
export function readVisualWitness(input: VisualObservationInput): Record<string, boolean> | null {
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
    !/^codex\/delivery-retry-(light|dark)$/.test(input.branch)
  )
    return null;
  const visible = (element: Element | null): element is HTMLElement => {
    if (!element) return false;
    const box = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const matches = all(selector);
    return matches.length === 1 ? matches[0]! : null;
  };
  const text = (element: Element | null) => element?.textContent?.trim() ?? "";
  const has = (selector: string, expected: string) =>
    all(selector).some((element) => text(element).includes(expected));
  const shadow = (host: string, selector: string) =>
    all(host)
      .flatMap((element) => Array.from(element.shadowRoot?.querySelectorAll(selector) ?? []))
      .filter(visible);
  const surface = '[data-center-surface-host][data-visible="true"]';
  const card = one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`);
  const row = one(`[data-testid="thread-row-${input.threadId}"]`);
  const composer = one(`${surface} [data-testid="composer-editor"]`);
  const gitScene = input.scene.startsWith("git-");
  const selected = gitScene
    ? /^\/project\/local\/[A-Za-z0-9._:-]+\/git$/.test(location.pathname) &&
      text(one('[aria-label="Worktree"]')) === input.branch &&
      text(one('[aria-label="Choose branch"]')) === input.branch
    : location.pathname === "/local/" + input.threadId && card !== null;
  let target: Element | null = null;
  let facts: Record<string, boolean>;
  switch (input.scene) {
    case "workspace-composite":
      target = one(surface);
      facts = {
        completedResponse:
          text(target).includes("BiBCode deterministic streamed fixture response.") &&
          all(`${surface} [data-timeline-row-kind="working"]`).length === 0 &&
          all(`${surface} button[aria-label="Stop generation"]`).length === 0,
        draftRetained: text(composer) === "Owned visual review draft",
        managedCard: row !== null && card !== null,
        primaryCard: all('[data-testid^="primary-card-button-"]').length === 1,
        dirtyStatus:
          row?.querySelector('[aria-label="Uncommitted changes"]') !== null && row !== null,
      };
      break;
    case "workspace-card-menu": {
      target = one('[role="menu"]');
      const disabled = target?.querySelector('[role="menuitem"][aria-disabled="true"]') ?? null;
      const focused = document.activeElement;
      facts = {
        singleMenu: target !== null,
        disabledReason:
          visible(disabled) &&
          text(disabled).includes("No local opener is available for this workspace."),
        focusedDisabledItem:
          focused !== null &&
          target?.contains(focused) === true &&
          focused.getAttribute("aria-disabled") === "true" &&
          focused.getAttribute("aria-description") ===
            "No local opener is available for this workspace.",
        groupedActions:
          text(target).includes("Pull") &&
          text(target).includes("Copy Branch Name") &&
          (target?.querySelectorAll('[role="separator"]').length ?? 0) === 3,
      };
      break;
    }
    case "worktree-create-ref": {
      target = one('[data-slot="dialog-popup"][role="dialog"]');
      const name = target?.querySelector<HTMLInputElement>('input[placeholder="Worktree name"]');
      const matches = Array.from(target?.querySelectorAll("button") ?? []).filter(
        (element) => text(element) === "visual-held",
      );
      facts = {
        singleDialog: target !== null,
        exactRef:
          matches.length === 0 &&
          target?.querySelector<HTMLInputElement>('input[aria-label="Create From"]')?.value ===
            "visual-held",
        derivedName: name?.value === "visual-held" && text(target).includes('"visual-held-2"'),
        reuseBlocked:
          target?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled === true &&
          text(target).includes('"visual-held" is already checked out.'),
        agentControl: visible(target?.querySelector('[aria-label="Agent"]') ?? null),
        advancedControl: text(target).includes("Advanced"),
      };
      break;
    }
    case "git-changes-diff": {
      target = one('section[aria-label="Changes"]');
      const diff = one('section[aria-label="Diff for pierre-step5.ts"]');
      facts = {
        selectedTextDiff:
          one('[role="option"][data-path="pierre-step5.ts"][aria-selected="true"]') !== null &&
          shadow(
            'section[aria-label="Diff for pierre-step5.ts"] diffs-container',
            'pre[data-diff-type="single"]',
          ).some((element) => text(element).includes('first = "changed one"')),
        stagingGutter: one('aside[aria-label="Partial staging selection gutter"]') !== null,
        stagedAndUnstaged: text(diff).includes("Staged") && text(diff).includes("Unstaged"),
        imageRow: one('[role="option"][data-path="visual-swatch.png"]') !== null,
      };
      break;
    }
    case "git-history-stashes": {
      target = one('section[aria-label="Repository history"]');
      const stashes = one('[aria-label="Repository stashes"]');
      const scroll = stashes
        ? Array.from(stashes.querySelectorAll("div")).find(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
          )
        : null;
      facts = {
        selectedCommit: has(
          '[aria-label="Commit history"] [aria-selected="true"]',
          "Visual qualification baseline",
        ),
        decorations: has('[aria-label="References"]', "visual-base"),
        twelveStashes: text(one('[aria-label="Toggle repository stashes"]')).includes("(12)"),
        containedScroll:
          visible(stashes) &&
          !!scroll &&
          scroll.scrollTop > 0 &&
          getComputedStyle(scroll).overscrollBehaviorY === "contain",
        selectedHistory: has('[role="tab"][aria-selected="true"]', "History"),
      };
      break;
    }
    case "git-branch-menu":
      target = one('[data-slot="popover-popup"]');
      facts = {
        currentBranch: one('[aria-label="Branches"] [aria-label="Current branch"]') !== null,
        remoteBranch:
          one('button[aria-label="Check out remote branch origin/visual-held"]') !== null,
        occupiedBranch:
          has('[aria-label="Branches"] button', "Switch to worktree") &&
          has('[aria-label="Branches"] button', "visual-held"),
        renameDeleteControls:
          one('button[aria-label="Rename visual-held"]') !== null &&
          one('button[aria-label="Delete visual-held"]') !== null,
      };
      break;
    case "files-editor-comment":
      target = one("[data-preview-panel-mode]");
      facts = {
        nestedTree:
          shadow(
            "file-tree-container",
            '[role="treeitem"][data-item-path="src/nested/visual-note.ts"]',
          ).length === 1,
        fileText: shadow(
          "diffs-container",
          '[role="textbox"][aria-label="src/nested/visual-note.ts"]',
        ).some((element) => text(element).includes("Review this owned file")),
        comment:
          has("[data-file-comment-annotation]", "Review this owned line") &&
          one('button[aria-label="Delete comment"]') !== null,
        toolbar: one("[data-file-editor-toolbar]") !== null,
      };
      break;
    case "command-palette": {
      target = one('[data-testid="command-palette"]');
      const search = target?.querySelector<HTMLInputElement>('[data-slot="autocomplete-input"]');
      const items = target?.querySelectorAll('[data-slot="command-item"]');
      facts = {
        singlePalette: target !== null,
        filteredAction:
          search?.value === "settings" &&
          items?.length === 1 &&
          text(items[0]!).includes("Open settings"),
        singleActiveRow:
          target?.querySelectorAll('[data-slot="command-item"][data-highlighted]').length === 1,
        inputFocused: search != null && document.activeElement === search,
      };
      break;
    }
    default:
      return null;
  }
  const box = target?.getBoundingClientRect();
  const unobstructed =
    !!target &&
    !!box &&
    [
      [box.left + box.width / 2, box.top + 2],
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.bottom - 2],
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (hit === target || target.contains(hit));
    });
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched:
      selected &&
      document
        .querySelector('[data-testid="environment-rail-local"]')
        ?.getAttribute("aria-checked") === "true" &&
      document.querySelector('[data-testid="environment-rail-local"] [data-status="connected"]') !==
        null,
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView:
      innerWidth === 1280 &&
      innerHeight === 960 &&
      visible(target) &&
      !!box &&
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= innerWidth &&
      box.bottom <= innerHeight &&
      unobstructed,
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    ...facts,
  };
}

/** A genuine rendered image diff, checked before returning to the text-diff capture. */
export function readVisualImageLoaded(): boolean {
  if (location.origin !== "http://127.0.0.1:4885" || location.search || location.hash) return false;
  const pane = document.querySelector('section[aria-label="Image diff"]');
  const images = Array.from(pane?.querySelectorAll("img") ?? []);
  return (
    !!pane &&
    pane.getBoundingClientRect().height > 0 &&
    images.length === 2 &&
    images.every(
      (element) => element.complete && element.naturalWidth === 64 && element.naturalHeight === 64,
    )
  );
}
export function readVisualPageScroll() {
  return { x: scrollX, y: scrollY };
}
export function readVisualViewport() {
  return { width: innerWidth, height: innerHeight, devicePixelRatio };
}
