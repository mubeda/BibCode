import type { VisualScene } from "./release-visual-evidence.ts";
export interface VisualObservationInput {
  scene: VisualScene;
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}

export type VisualTextRowObservationInput = Omit<VisualObservationInput, "scene">;

/** One failure-only DOM sample; no page identity, text or values leave this reader. */
export function readVisualTextRowFailure(
  input: VisualTextRowObservationInput,
): Record<string, unknown> | null {
  try {
    const route = /^\/project\/local\/([A-Za-z0-9._:-]{1,128})\/git$/.exec(location.pathname);
    if (
      input.origin !== "http://127.0.0.1:4885" ||
      location.origin !== input.origin ||
      location.search !== "" ||
      location.hash !== "" ||
      route === null ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
      (input.theme !== "light" && input.theme !== "dark") ||
      document.documentElement.classList.contains("dark") !== (input.theme === "dark") ||
      input.branch !== "codex/delivery-retry-" + input.theme ||
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) !== null
    )
      return null;
    const headers = document.querySelectorAll("header[data-environment-id][data-project-id]");
    const rails = document.querySelectorAll('[data-testid="environment-rail-local"]');
    const worktrees = document.querySelectorAll('[aria-label="Worktree"]');
    const branches = document.querySelectorAll('[aria-label="Choose branch"]');
    if (
      headers.length !== 1 ||
      headers[0]!.getAttribute("data-environment-id") !== "local" ||
      headers[0]!.getAttribute("data-project-id") !== route[1] ||
      rails.length !== 1 ||
      rails[0]!.getAttribute("aria-checked") !== "true" ||
      rails[0]!.querySelector('[data-status="connected"]') === null ||
      worktrees.length !== 1 ||
      branches.length !== 1 ||
      !headers[0]!.contains(worktrees[0]!) ||
      !headers[0]!.contains(branches[0]!) ||
      worktrees[0]!.textContent?.trim() !== input.branch ||
      branches[0]!.textContent?.trim() !== input.branch
    )
      return null;
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(
      (tab) => tab.textContent?.trim() === "Changes",
    );
    if (tabs.length !== 1) return null;
    const changesActive = tabs[0]!.getAttribute("aria-selected") === "true";
    const panelId = tabs[0]!.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (changesActive && panel?.getAttribute("role") !== "tabpanel") return null;
    const scope = changesActive ? panel : null;
    const selector = '[role="option"][data-path="pierre-step5.ts"]';
    const globalRows = document.querySelectorAll(selector);
    const scopedRows = scope?.querySelectorAll(selector);
    const lists = scope?.querySelectorAll('[role="listbox"][aria-label="Changed files"]');
    const list = lists?.length === 1 ? lists[0]! : null;
    const positiveSize = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const visible = (element: Element | null): boolean => {
      if (!positiveSize(element)) return false;
      for (let ancestor = element; ancestor !== null; ancestor = ancestor.parentElement) {
        if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert")) return false;
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
          return false;
      }
      return (
        typeof element!.checkVisibility !== "function" ||
        element!.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      );
    };
    const count = (value: number) => (value === 0 ? "none" : value === 1 ? "one" : "multiple");
    const paragraphs = Array.from(scope?.querySelectorAll("p") ?? []);
    const loading = Array.from(scope?.querySelectorAll('[role="status"]') ?? []);
    const filters = Array.from(
      scope?.querySelectorAll<HTMLInputElement>('input[name="git-manager-change-filter"]') ?? [],
    );
    const filterNames = ["included", "excluded", "new", "modified", "deleted"];
    const facts = {
      changesActive,
      globalTextRows: count(globalRows.length),
      scopedTextRows: count(scopedRows?.length ?? 0),
      firstMatchVisible: visible(globalRows[0] ?? null),
      listBoxPresent: (lists?.length ?? 0) > 0,
      listBoxPositiveSize: positiveSize(list),
      listBoxVisible: visible(list),
      emptyPresent: paragraphs.some((element) =>
        ["No local changes", "No changed files match these filters."].includes(
          element.textContent?.trim() ?? "",
        ),
      ),
      loadingPresent: loading.some(
        (element) => element.textContent?.trim() === "Connecting to changes…",
      ),
      errorPresent: scope?.querySelector('[role="alert"]') !== null && scope !== null,
      filterPresent:
        filters.some((field) => field.value.length > 0) ||
        filterNames.some(
          (name) =>
            scope?.querySelector(
              '[role="checkbox"][aria-label="Filter ' +
                name +
                ' changed files"][aria-checked="true"]',
            ) != null,
        ),
    };
    // Optional layout reads cannot replace any original fact or widen the caller's bound.
    const layout = (() => {
      try {
        const toolbar = headers[0]!.parentElement;
        const owner = toolbar?.parentElement;
        const tabsRoot = scope?.parentElement;
        // Current toolbar wrapper and repository Tabs are siblings in this exact owner.
        if (
          !scope ||
          !panelId ||
          toolbar?.tagName !== "DIV" ||
          owner?.tagName !== "DIV" ||
          tabsRoot?.tagName !== "DIV" ||
          tabsRoot === toolbar ||
          tabsRoot.parentElement !== owner ||
          !tabsRoot.contains(tabs[0]!) ||
          toolbar.contains(scope)
        )
          return null;
        const ownedPanels = Array.from(document.querySelectorAll('[role="tabpanel"]')).filter(
          (candidate) => candidate.getAttribute("id") === panelId,
        );
        if (ownedPanels.length !== 1 || ownedPanels[0] !== scope) return null;
        const sections = scope.querySelectorAll('section[aria-label="Changes"]');
        if (sections.length !== 1 || sections[0]!.parentElement !== scope) return null;
        const changes = sections[0]!;
        if (list && list.parentElement !== changes) return null;
        const children = changes.children;
        // The Commit form is required by this source branch. Do not guess a foreign structure.
        const commits = changes.querySelectorAll('form[aria-label="Commit Changes"]');
        if (commits.length !== 1 || commits[0]!.parentElement !== changes) return null;
        const diffs = changes.querySelectorAll('section[aria-label^="Diff for "]');
        if (diffs.length > 1 || (diffs.length === 1 && diffs[0]!.parentElement !== changes))
          return null;
        const dimensions = (element: Element | null) => {
          if (!element) return { width: null, height: null };
          const rect = element.getBoundingClientRect();
          const axis = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0 ? value > 0 : null;
          return { width: axis(rect.width), height: axis(rect.height) };
        };
        const listDimensions = dimensions(list),
          panelDimensions = dimensions(scope),
          changesDimensions = dimensions(changes);
        const blockingAncestor = (() => {
          if (!list) return null;
          let ancestor: Element | null = list;
          for (let inspected = 0; ancestor !== null && inspected < 24; inspected++) {
            if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert"))
              return "hidden-or-inert";
            const style = getComputedStyle(ancestor);
            if (style.display === "none") return "display-none";
            if (style.visibility === "hidden" || style.visibility === "collapse")
              return "visibility-hidden";
            if (style.opacity === "0") return "opacity-zero";
            const opacity =
              typeof style.opacity === "string" &&
              /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(style.opacity)
                ? Number(style.opacity)
                : null;
            if (
              typeof style.display !== "string" ||
              style.display === "" ||
              style.visibility !== "visible" ||
              opacity === null
            )
              return null;
            ancestor = ancestor.parentElement;
          }
          return ancestor === null ? "none" : null;
        })();
        const demandExhaustsChanges = (() => {
          if (!list || children.length > 8) return null;
          const style = getComputedStyle(changes);
          if (
            (style.display !== "flex" && style.display !== "inline-flex") ||
            style.flexDirection !== "column"
          )
            return null;
          const pixels = (value: unknown, normal = false): number | null => {
            if (normal && value === "normal") return 0;
            if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value))
              return null;
            const number = Number(value.slice(0, -2));
            return Number.isFinite(number) ? number : null;
          };
          const paddingTop = pixels(style.paddingTop),
            paddingBottom = pixels(style.paddingBottom),
            gap = pixels(style.rowGap, true);
          const height = changes.clientHeight;
          if (
            paddingTop === null ||
            paddingBottom === null ||
            gap === null ||
            paddingTop < 0 ||
            paddingBottom < 0 ||
            gap < 0 ||
            !Number.isFinite(height) ||
            height < 0
          )
            return null;
          let demand = 0,
            flow = 0;
          for (let index = 0; index < children.length; index++) {
            const child = children[index]!;
            const childStyle = getComputedStyle(child);
            if (
              child.hasAttribute("hidden") ||
              childStyle.display === "none" ||
              childStyle.position === "absolute" ||
              childStyle.position === "fixed"
            ) {
              if (child === list) return null;
              continue;
            }
            if (
              ![
                "block",
                "flow-root",
                "flex",
                "inline-flex",
                "grid",
                "inline-grid",
                "inline-block",
                "list-item",
              ].includes(childStyle.display) ||
              !["static", "relative", "sticky"].includes(childStyle.position)
            )
              return null;
            flow++;
            const marginTop = pixels(childStyle.marginTop),
              marginBottom = pixels(childStyle.marginBottom);
            if (marginTop === null || marginBottom === null) return null;
            if (child === list) {
              demand += marginTop + marginBottom;
              continue;
            }
            const rect = child.getBoundingClientRect();
            if (
              !Number.isFinite(rect.width) ||
              !Number.isFinite(rect.height) ||
              rect.width < 0 ||
              rect.height < 0
            )
              return null;
            if (
              !(child instanceof HTMLElement) ||
              !Number.isFinite(child.offsetHeight) ||
              child.offsetHeight < 0
            )
              return null;
            // CSS box height and clientHeight share a coordinate space even under transforms.
            demand += child.offsetHeight + marginTop + marginBottom;
          }
          demand += gap * Math.max(0, flow - 1);
          return Number.isFinite(demand)
            ? demand >= Math.max(0, height - paddingTop - paddingBottom)
            : null;
        })();
        return {
          listBoxCount: count(lists?.length ?? 0),
          listBoxWidthPositive: listDimensions.width,
          listBoxHeightPositive: listDimensions.height,
          panelWidthPositive: panelDimensions.width,
          panelHeightPositive: panelDimensions.height,
          changesWidthPositive: changesDimensions.width,
          changesHeightPositive: changesDimensions.height,
          blockingAncestor,
          diffPanePresent: children.length <= 8 ? diffs.length === 1 : null,
          commitBoxPresent: children.length <= 8 ? true : null,
          nonListDemandExhaustsChanges: demandExhaustsChanges,
        };
      } catch {
        return null;
      }
    })();
    return { ...facts, layout };
  } catch {
    return null;
  }
}

/** Only the exact closed data schema may enter a failure receipt. */
export function projectVisualTextRowFailure(input: unknown): Record<string, unknown> | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const keys = [
      "changesActive",
      "globalTextRows",
      "scopedTextRows",
      "firstMatchVisible",
      "listBoxPresent",
      "listBoxPositiveSize",
      "listBoxVisible",
      "emptyPresent",
      "loadingPresent",
      "errorPresent",
      "filterPresent",
      "layout",
    ];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      const value = descriptor.value;
      if (key === "layout") {
        if (value === null) {
          result[key] = null;
          continue;
        }
        if (typeof value !== "object" || Array.isArray(value)) return null;
        const layoutKeys = [
          "listBoxCount",
          "listBoxWidthPositive",
          "listBoxHeightPositive",
          "panelWidthPositive",
          "panelHeightPositive",
          "changesWidthPositive",
          "changesHeightPositive",
          "blockingAncestor",
          "diffPanePresent",
          "commitBoxPresent",
          "nonListDemandExhaustsChanges",
        ];
        const layoutOwnKeys = Reflect.ownKeys(value);
        if (
          layoutOwnKeys.length !== layoutKeys.length ||
          !layoutOwnKeys.every((field) => typeof field === "string" && layoutKeys.includes(field))
        )
          return null;
        const layout: Record<string, unknown> = {};
        for (const field of layoutKeys) {
          const property = Object.getOwnPropertyDescriptor(value, field);
          if (!property?.enumerable || !Object.hasOwn(property, "value")) return null;
          const fact = property.value;
          if (field === "listBoxCount") {
            if (fact !== "none" && fact !== "one" && fact !== "multiple") return null;
          } else if (field === "blockingAncestor") {
            if (
              fact !== null &&
              ![
                "none",
                "hidden-or-inert",
                "display-none",
                "visibility-hidden",
                "opacity-zero",
              ].includes(fact)
            )
              return null;
          } else if (fact !== null && typeof fact !== "boolean") return null;
          layout[field] = fact;
        }
        result[key] = layout;
        continue;
      }
      if (key === "globalTextRows" || key === "scopedTextRows") {
        if (value !== "none" && value !== "one" && value !== "multiple") return null;
      } else if (typeof value !== "boolean") return null;
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
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

/** The existing binary working-tree representation; this does not claim image preview support. */
export function readVisualWorkingImageSelected(input: { branch: string }): boolean {
  if (
    location.origin !== "http://127.0.0.1:4885" ||
    location.search ||
    location.hash ||
    !/^\/project\/local\/[A-Za-z0-9._:-]{1,128}\/git$/.test(location.pathname) ||
    !/^codex\/delivery-retry-(light|dark)$/.test(input.branch)
  )
    return false;
  const controls = (selector: string) => Array.from(document.querySelectorAll(selector));
  const target = controls('section[aria-label="Diff for visual-swatch.png"]');
  const worktree = controls('[aria-label="Worktree"]');
  const branch = controls('[aria-label="Choose branch"]');
  if (
    target.length !== 1 ||
    target[0]!.getBoundingClientRect().height <= 0 ||
    controls('[role="option"][data-path="visual-swatch.png"][aria-selected="true"]').length !== 1 ||
    worktree.length !== 1 ||
    worktree[0]!.textContent?.trim() !== input.branch ||
    branch.length !== 1 ||
    branch[0]!.textContent?.trim() !== input.branch
  )
    return false;
  const gutter = target[0]!.querySelector('aside[aria-label="Partial staging selection gutter"]');
  const stage = Array.from(gutter?.querySelectorAll("button") ?? []).filter(
    (button) => button.textContent?.trim() === "Stage selected lines",
  );
  return (
    gutter !== null &&
    stage.length === 1 &&
    stage[0]!.disabled &&
    gutter.querySelectorAll('button[aria-label^="Toggle changed-line run starting at line"]')
      .length === 0 &&
    target[0]!.querySelectorAll("img").length === 0
  );
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
