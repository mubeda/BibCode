// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readVisualWitness } from "./release-visual-observation.ts";
import * as Observations from "./release-visual-observation.ts";
import { validateVisualWitness } from "./release-visual-evidence.ts";
const input = {
  scene: "command-palette" as const,
  theme: "light" as const,
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
};
let clearAdmissionOrdinal = 0;
let clearAdmitted = false;
const clearInput = {
  origin: input.origin,
  threadId: input.threadId,
  admission: "00000000-0000-4000-8000-000000000000",
};
function renewClearAdmission() {
  clearInput.admission =
    "00000000-0000-4000-8000-" + (++clearAdmissionOrdinal).toString(16).padStart(12, "0");
  clearAdmitted = false;
}
function observeClear(operation: "start" | "finish") {
  const value =
    Reflect.get(
      Observations,
      "observeVisualNameClear",
    )?.({
      ...clearInput,
      operation,
      admitted: clearAdmitted,
    }) ?? null;
  if (operation === "start") clearAdmitted = value === true;
  return value;
}
function projectClear(value: unknown) {
  return Reflect.get(Observations, "projectVisualNameClearObservation")?.(value) ?? null;
}
function palette() {
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.className = "";
  document.body.innerHTML = `<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="thread-card-button-owned" aria-current="page"></button><div data-testid="thread-row-owned"><span data-testid="thread-title-owned">codex/delivery-retry-light</span></div><div data-testid="command-palette" data-slot="command-dialog-popup"><input data-slot="autocomplete-input"><div data-slot="command-item" data-highlighted>Open settings</div></div>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 310,
    bottom: 210,
    width: 300,
    height: 200,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[data-testid="command-palette"]'),
  );
  document.querySelector<HTMLInputElement>("input")!.value = "settings";
  document.querySelector<HTMLInputElement>("input")!.focus();
}
afterEach(() => {
  observeClear("finish");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("owned name-clear event observation", () => {
  function clearField() {
    renewClearAdmission();
    palette();
    document.body.innerHTML =
      '<div data-slot="dialog-popup" role="dialog"><input placeholder="Worktree name" value="Owned fixture name"></div>';
    return document.querySelector<HTMLInputElement>('input[placeholder="Worktree name"]')!;
  }
  it("counts only received target events and exports empty booleans after closing the observer", () => {
    const name = clearField();
    const remove = vi.spyOn(name, "removeEventListener");
    expect(observeClear("start")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        window,
        "__bibcodeOwnedVisualNameClear:" + clearInput.admission,
      ),
    ).toMatchObject({
      configurable: false,
      writable: false,
      enumerable: false,
    });
    name.value = "";
    name.dispatchEvent(new Event("change", { bubbles: true }));
    const observation = projectClear(observeClear("finish"));
    expect(remove.mock.calls.map(([type, , capture]) => [type, capture])).toEqual([
      ["input", true],
      ["change", true],
    ]);
    expect(observation).toEqual({
      nameCount: "one",
      sameInput: true,
      emptyBefore: false,
      emptyAfter: true,
      inputEvents: "none",
      changeEvents: "one",
      trustedInputEvents: "none",
      trustedChangeEvents: "none",
      observerClosed: true,
    });
    expect(JSON.stringify(observation)).not.toMatch(/Owned|fixture|4885|owned/);
    expect(observeClear("finish")).toBeNull();
    renewClearAdmission();
    expect(observeClear("start")).toBe(true);
    expect(projectClear(observeClear("finish"))).toMatchObject({
      inputEvents: "none",
      changeEvents: "none",
    });
  });
  it("saturates event counts and ignores another input", () => {
    const name = clearField();
    const other = document.createElement("input");
    document.body.append(other);
    expect(observeClear("start")).toBe(true);
    other.dispatchEvent(new Event("change", { bubbles: true }));
    for (let index = 0; index < 4; index++)
      name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(projectClear(observeClear("finish"))).toMatchObject({
      inputEvents: "multiple",
      changeEvents: "none",
      emptyAfter: false,
    });
  });
  it("refuses a different lifetime without consuming the admitted observer", () => {
    const name = clearField();
    const remove = vi.spyOn(name, "removeEventListener");
    expect(observeClear("start")).toBe(true);
    const admission = clearInput.admission;
    renewClearAdmission();
    clearAdmitted = true;
    expect(observeClear("finish")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    clearInput.admission = admission;
    expect(projectClear(observeClear("finish"))).toMatchObject({ observerClosed: true });
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("reports replacement without reading the new input value", () => {
    const name = clearField();
    expect(observeClear("start")).toBe(true);
    const replacement = document.createElement("input");
    replacement.placeholder = "Worktree name";
    Object.defineProperty(replacement, "value", {
      get: () => {
        throw new Error("No replacement value read.");
      },
    });
    name.replaceWith(replacement);
    expect(projectClear(observeClear("finish"))).toMatchObject({
      nameCount: "one",
      sameInput: false,
      emptyAfter: null,
      observerClosed: true,
    });
  });
  it.each(["origin", "search", "hash", "pathname"])(
    "refuses unsafe %s without a DOM query and still closes an owned observer",
    (key) => {
      clearField();
      expect(observeClear("start")).toBe(true);
      vi.stubGlobal("location", {
        origin: input.origin,
        pathname: "/local/owned",
        search: "",
        hash: "",
        [key]: "outside-owned-location",
      });
      const query = vi.spyOn(document, "querySelectorAll");
      expect(observeClear("finish")).toBeNull();
      expect(query).not.toHaveBeenCalled();
      vi.stubGlobal("location", {
        origin: input.origin,
        pathname: "/local/owned",
        search: "",
        hash: "",
      });
      renewClearAdmission();
      expect(observeClear("start")).toBe(true);
    },
  );
  it.each(["marker", "anchor"])(
    "refuses a preexisting %s without invoking its private callback",
    (kind) => {
      clearField();
      const marker = "__bibcodeOwnedVisualNameClear";
      const key = kind === "marker" ? marker : marker + ":" + clearInput.admission;
      const foreign = vi.fn(() => "private-function-canary");
      Object.defineProperty(window, key, { value: foreign, configurable: true });
      try {
        expect(observeClear("start")).toBeNull();
        expect(observeClear("finish")).toBeNull();
        expect(foreign).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptor(window, key)?.value).toBe(foreign);
      } finally {
        Reflect.deleteProperty(window, key);
      }
    },
  );
  it("cleans only its installed listeners after marker replacement and preserves the foreign callback", () => {
    const name = clearField();
    const marker = "__bibcodeOwnedVisualNameClear";
    const remove = vi.spyOn(name, "removeEventListener");
    expect(observeClear("start")).toBe(true);
    const foreign = vi.fn(() => "private-function-canary");
    Object.defineProperty(window, marker, { value: foreign, configurable: true });
    const query = vi.spyOn(document, "querySelectorAll");
    try {
      expect(observeClear("finish")).toBeNull();
      expect(remove.mock.calls.map(([type, , capture]) => [type, capture])).toEqual([
        ["input", true],
        ["change", true],
      ]);
      expect(query).not.toHaveBeenCalled();
      expect(foreign).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(window, marker)?.value).toBe(foreign);
      expect(observeClear("finish")).toBeNull();
      expect(remove).toHaveBeenCalledTimes(2);
      expect(foreign).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, marker);
    }
  });
  it.each([0, 2])("refuses %s controls and never substitutes another target", (count) => {
    clearField();
    document.body.innerHTML =
      '<div data-slot="dialog-popup" role="dialog">' +
      '<input placeholder="Worktree name">'.repeat(count) +
      "</div>";
    expect(observeClear("start")).toBeNull();
    expect(observeClear("finish")).toBeNull();
  });
  it("admits only exact own enumerable data facts", () => {
    const valid = {
      nameCount: "one",
      sameInput: true,
      emptyBefore: false,
      emptyAfter: true,
      inputEvents: "none",
      changeEvents: "one",
      trustedInputEvents: "none",
      trustedChangeEvents: "none",
      observerClosed: true,
    };
    expect(projectClear(valid)).toEqual(valid);
    expect(projectClear(Object.assign(Object.create(null), valid))).toEqual(valid);
    for (const key of Object.keys(valid)) {
      let reads = 0;
      const bad = { ...valid };
      Object.defineProperty(bad, key, {
        enumerable: true,
        get: () => {
          reads++;
          return "inert-canary";
        },
      });
      expect(projectClear(bad)).toBeNull();
      expect(reads).toBe(0);
    }
    const extra = { ...valid };
    Object.defineProperty(extra, Symbol("extra"), { value: true });
    expect(projectClear(extra)).toBeNull();
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    expect(projectClear(revoked.proxy)).toBeNull();
  });
});
describe("read-only visual observations", () => {
  it.each([
    "ok",
    "wrong-route",
    "wrong-branch",
    "duplicate-pane",
    "unselected",
    "selectable-lines",
    "enabled-stage",
    "image",
  ])("binds only the owned nonselectable working-tree PNG presentation: %s", (mode) => {
    palette();
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: mode === "wrong-route" ? "/local/owned" : "/project/local/owned/git",
      search: "",
      hash: "",
    });
    document.body.innerHTML = `<button aria-label="Worktree">${input.branch}</button><button aria-label="Choose branch">${mode === "wrong-branch" ? "foreign" : input.branch}</button><button role="option" data-path="visual-swatch.png" aria-selected="${mode !== "unselected"}">Owned image row</button><section aria-label="Diff for visual-swatch.png"><aside aria-label="Partial staging selection gutter"><button ${mode === "enabled-stage" ? "" : "disabled"}>Stage selected lines</button>${mode === "selectable-lines" ? '<button aria-label="Toggle changed-line run starting at line 1"></button>' : ""}</aside>${mode === "image" ? '<img alt="Inert unrelated image">' : ""}</section>`;
    if (mode === "duplicate-pane")
      document.body.append(document.querySelector("section")!.cloneNode(true));
    expect(
      Reflect.get(Observations, "readVisualWorkingImageSelected")({ branch: input.branch }),
    ).toBe(mode === "ok");
  });
  it("admits the actually focused single public palette action without returning input contents", () => {
    palette();
    const witness = readVisualWitness(input);
    expect(validateVisualWitness(input.scene, witness)).toEqual({
      themeMatched: true,
      selectedMatched: true,
      expectedTextMatched: true,
      targetInView: true,
      credentialAbsent: true,
      bootShellAbsent: true,
      singlePalette: true,
      filteredAction: true,
      singleActiveRow: true,
      inputFocused: true,
    });
    expect(JSON.stringify(witness)).not.toMatch(/owned|settings|4885|delivery-retry/);
  });
  it.each([
    "focus",
    "duplicate",
    "obstructed",
    "credential",
    "boot",
    "theme",
    "selection",
    "viewport",
  ])("refuses a %s mismatch instead of capturing a nearby state", (kind) => {
    palette();
    if (kind === "focus") document.querySelector<HTMLInputElement>("input")!.blur();
    if (kind === "duplicate")
      document
        .querySelector('[data-slot="command-item"]')!
        .insertAdjacentHTML(
          "afterend",
          '<div data-slot="command-item" data-highlighted>Open settings</div>',
        );
    if (kind === "obstructed") vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    if (kind === "credential")
      document.body.insertAdjacentHTML("beforeend", '<input id="pairing-token">');
    if (kind === "boot")
      document.body.insertAdjacentHTML("beforeend", '<div id="boot-shell"></div>');
    if (kind === "theme") document.documentElement.className = "dark";
    if (kind === "selection")
      document.querySelector('[aria-current="page"]')!.removeAttribute("aria-current");
    if (kind === "viewport") vi.stubGlobal("innerHeight", 700);
    expect(() => validateVisualWitness(input.scene, readVisualWitness(input))).toThrow();
  });
  it.each(["origin", "search", "hash"])("refuses a private %s before reading any DOM", (key) => {
    palette();
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/local/owned",
      search: "",
      hash: "",
      [key]: "private-token",
    });
    const query = vi.spyOn(document, "querySelector");
    expect(readVisualWitness(input)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
it("binds the auto-selected exact ref after its search row disappears, including the real occupied-branch name hint", () => {
  palette();
  document.querySelector('[data-testid="command-palette"]')!.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div data-slot="dialog-popup" role="dialog"><input placeholder="Worktree name" value="visual-held"><input aria-label="Create From" value="visual-held"><input type="checkbox" disabled><p role="status">"visual-held" is already checked out. A new branch ("visual-held-2" or the next available name) will be created from it.</p><button aria-label="Agent">Claude</button><button>Advanced</button></div>`,
  );
  vi.mocked(document.elementFromPoint).mockImplementation(() =>
    document.querySelector('[role="dialog"]'),
  );
  const scene = "worktree-create-ref" as const;
  expect(validateVisualWitness(scene, readVisualWitness({ ...input, scene }))).toMatchObject({
    exactRef: true,
    derivedName: true,
    reuseBlocked: true,
  });
  document.querySelector<HTMLInputElement>('input[aria-label="Create From"]')!.value =
    "origin/visual-held";
  expect(() => validateVisualWitness(scene, readVisualWitness({ ...input, scene }))).toThrow();
});

describe("actual workspace-card fallback menu witness", () => {
  it.each(["no-opener", "cursor", "host-opener", "wrong-reason", "no-reason", "wrong-focus"])(
    "admits only the focused disabled Open in with its visible no-opener reason: %s",
    async (mode) => {
      // Load the real bundler-owned web modules through Vitest. A static import
      // would add their extensionless imports to the NodeNext E2E type graph.
      const fallbackModule = "../../../web/src/contextMenuFallback.ts";
      const sidebarMenuModule = "../../../web/src/components/sidebar/sidebarMenus.logic.ts";
      const { showContextMenuFallback } = await import(fallbackModule);
      const { buildWorkspaceCardMenu } = await import(sidebarMenuModule);
      palette();
      document.querySelector('[data-testid="command-palette"]')!.remove();
      const entries = buildWorkspaceCardMenu({
        isWorktree: true,
        openIn:
          mode === "cursor"
            ? [{ id: "open-in:cursor", label: "Cursor" }]
            : mode === "host-opener"
              ? [{ id: "open-in:zed", label: "Zed" }]
              : [],
        pullDisabledReason: null,
        workspaceUnavailableReason:
          mode === "wrong-reason" ? "This worktree is being removed." : null,
        branchName: input.branch,
        pinned: false,
        unread: false,
        confirmThreadDelete: true,
        worktreeSessionRunning: false,
      });
      if (mode === "no-reason") entries[0] = { id: "open-in", label: "Open in", disabled: true };
      const result = showContextMenuFallback(entries, { x: 10, y: 10 });
      try {
        vi.mocked(document.elementFromPoint).mockImplementation(() =>
          document.querySelector('[role="menu"]'),
        );
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        if (mode === "wrong-focus")
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        const scene = "workspace-card-menu" as const;
        const witness = readVisualWitness({ ...input, scene });
        if (mode === "no-opener") {
          expect(
            document.getElementById(document.activeElement!.getAttribute("aria-labelledby")!)
              ?.textContent,
          ).toBe("Open in");
          expect(validateVisualWitness(scene, witness)).toEqual({
            themeMatched: true,
            selectedMatched: true,
            expectedTextMatched: true,
            targetInView: true,
            credentialAbsent: true,
            bootShellAbsent: true,
            singleMenu: true,
            disabledReason: true,
            focusedDisabledItem: true,
            groupedActions: true,
          });
        } else {
          expect(() => validateVisualWitness(scene, witness)).toThrow(
            "Visual precondition failed.",
          );
          if (mode === "cursor" || mode === "host-opener") {
            expect(document.activeElement?.getAttribute("aria-disabled")).toBeNull();
            expect(document.activeElement?.getAttribute("aria-haspopup")).toBe("menu");
          }
        }
      } finally {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await expect(result).resolves.toBeNull();
      }
    },
  );
});
