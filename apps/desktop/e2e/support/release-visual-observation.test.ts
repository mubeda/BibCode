// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readVisualWitness } from "./release-visual-observation.ts";
import * as Observations from "./release-visual-observation.ts";
import { validateVisualWitness } from "./release-visual-evidence.ts";
const textRowFacts = {
  layout: null,
  changesActive: true,
  globalTextRows: "one",
  scopedTextRows: "one",
  firstMatchVisible: true,
  listBoxPresent: true,
  listBoxPositiveSize: true,
  listBoxVisible: true,
  emptyPresent: false,
  loadingPresent: false,
  errorPresent: false,
  filterPresent: false,
};
function textRowObservation(value: Observations.VisualTextRowObservationInput) {
  return Reflect.get(Observations, "readVisualTextRowFailure")?.(value) ?? null;
}
function projectTextRow(value: unknown) {
  return Reflect.get(Observations, "projectVisualTextRowFailure")?.(value) ?? null;
}
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
  function textRowDom() {
    palette();
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/project/local/owned-project/git",
      search: "",
      hash: "",
    });
    document.body.innerHTML = `<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><header data-environment-id="local" data-project-id="owned-project"><button aria-label="Worktree">${input.branch}</button><button aria-label="Choose branch">${input.branch}</button></header><button role="tab" aria-selected="true" aria-controls="owned-changes">Changes</button><div role="tabpanel" id="owned-changes"><section aria-label="Changes"><div role="listbox" aria-label="Changed files"><div role="option" data-path="pierre-step5.ts">Owned text</div></div></section></div>`;
    if (typeof HTMLElement.prototype.checkVisibility === "function")
      vi.spyOn(HTMLElement.prototype, "checkVisibility").mockReturnValue(true);
  }
  const layoutFacts = {
    listBoxCount: "one",
    listBoxWidthPositive: true,
    listBoxHeightPositive: true,
    panelWidthPositive: true,
    panelHeightPositive: true,
    changesWidthPositive: true,
    changesHeightPositive: true,
    blockingAncestor: "none",
    diffPanePresent: true,
    commitBoxPresent: true,
    nonListDemandExhaustsChanges: false,
  };
  function layoutDom(withSourceTopology = true) {
    textRowDom();
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
    const changes = panel.querySelector<HTMLElement>('section[aria-label="Changes"]')!;
    const list = changes.querySelector<HTMLElement>('[role="listbox"]')!;
    const diff = document.createElement("section");
    diff.setAttribute("aria-label", "Diff for visual-swatch.png");
    const commit = document.createElement("form");
    commit.setAttribute("aria-label", "Commit Changes");
    changes.append(diff, commit);
    const sizes = new Map<Element, { width: number; height: number }>([
      [panel, { width: 300, height: 600 }],
      [changes, { width: 300, height: 500 }],
      [list, { width: 300, height: 100 }],
      [diff, { width: 300, height: 250 }],
      [commit, { width: 300, height: 100 }],
    ]);
    const styles = new Map<Element, Partial<CSSStyleDeclaration>>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const size = sizes.get(this) ?? { width: 300, height: 100 };
        return new DOMRect(0, 0, size.width, size.height);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return sizes.get(this)?.height ?? 100;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return sizes.get(this)?.height ?? 100;
      },
    );
    vi.stubGlobal("getComputedStyle", (element: Element) => {
      const value = {};
      Object.assign(
        value,
        {
          display: "flex",
          visibility: "visible",
          opacity: "1",
          position: "static",
          flexDirection: "column",
          paddingTop: "0px",
          paddingBottom: "0px",
          marginTop: "0px",
          marginBottom: "0px",
          rowGap: "0px",
        },
        styles.get(element),
      );
      return value;
    });
    const topology = withSourceTopology ? sourceOwnerTopology(panel) : null;
    return { panel, changes, list, diff, commit, sizes, styles, topology };
  }
  function sourceOwnerTopology(panel: HTMLElement) {
    const header = document.querySelector<HTMLElement>("header")!;
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;
    const owner = document.createElement("div");
    owner.className = "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background";
    const toolbar = document.createElement("div");
    toolbar.className = "min-w-0 shrink-0";
    const tabsRoot = document.createElement("div");
    tabsRoot.className = "flex min-w-0 flex-col min-h-0 flex-1 gap-0";
    header.parentElement!.insertBefore(owner, header);
    toolbar.append(header);
    tabsRoot.append(tab, panel);
    owner.append(toolbar, tabsRoot);
    return { owner, toolbar, tabsRoot };
  }
  it.each(["source-shaped", "outside-owner", "nested-owner", "body-owner"])(
    "binds optional layout to the actual toolbar/repository sibling owner only: %s",
    (mode) => {
      const f = layoutDom(false);
      const topology = sourceOwnerTopology(f.panel);
      expect(topology.toolbar.contains(f.panel)).toBe(false);
      if (mode === "outside-owner") {
        const foreign = document.createElement("div");
        document.body.append(foreign);
        foreign.append(topology.tabsRoot);
      }
      if (mode === "nested-owner") {
        const nested = document.createElement("div");
        topology.owner.append(nested);
        nested.append(topology.tabsRoot);
      }
      if (mode === "body-owner") {
        document.body.append(topology.toolbar, topology.tabsRoot);
        topology.owner.remove();
      }
      const output = textRowObservation(input);
      expect(output).not.toBeNull();
      expect(output?.layout).toEqual(mode === "source-shaped" ? layoutFacts : null);
      const original: Record<string, unknown> = { ...output };
      delete original.layout;
      const expectedOriginal: Record<string, unknown> = { ...textRowFacts };
      delete expectedOriginal.layout;
      expect(original).toEqual(expectedOriginal);
    },
  );
  it.each([
    "positive",
    "zero-width",
    "zero-height",
    "zero-panel",
    "zero-section",
    "multiple",
    "none",
    "hidden",
    "inert",
    "display",
    "visibility",
    "opacity",
    "overfull",
    "absolute",
    "fixed",
    "hidden-child",
    "invalid-child-size",
    "contents-child",
    "unknown-child-display",
    "invalid-gap",
    "normal-gap",
    "margin-gap",
    "too-many-children",
    "too-many-ancestors",
    "unknown-css",
    "duplicate-panel",
    "wrong-parent",
    "duplicate-commit",
  ])("exports only bounded synthetic measurement facts, never a native CSS cause: %s", (mode) => {
    const f = layoutDom();
    const expected: Record<string, unknown> = { ...layoutFacts };
    if (mode === "zero-width") {
      f.sizes.set(f.list, { width: 0, height: 100 });
      expected.listBoxWidthPositive = false;
    }
    if (mode === "zero-height") {
      f.sizes.set(f.list, { width: 300, height: 0 });
      expected.listBoxHeightPositive = false;
    }
    if (mode === "zero-panel") {
      f.sizes.set(f.panel, { width: 300, height: 0 });
      expected.panelHeightPositive = false;
    }
    if (mode === "zero-section") {
      f.sizes.set(f.changes, { width: 300, height: 0 });
      expected.changesHeightPositive = false;
      expected.nonListDemandExhaustsChanges = true;
    }
    if (["multiple", "none"].includes(mode)) {
      if (mode === "multiple") f.changes.prepend(f.list.cloneNode(true));
      else f.list.remove();
      Object.assign(expected, {
        listBoxCount: mode === "none" ? "none" : "multiple",
        listBoxWidthPositive: null,
        listBoxHeightPositive: null,
        blockingAncestor: null,
        nonListDemandExhaustsChanges: null,
      });
    }
    if (["hidden", "inert"].includes(mode)) {
      f.panel.setAttribute(mode, "");
      expected.blockingAncestor = "hidden-or-inert";
    }
    if (mode === "display") {
      f.styles.set(f.panel, { display: "none" });
      expected.blockingAncestor = "display-none";
    }
    if (mode === "visibility") {
      f.styles.set(f.panel, { visibility: "hidden" });
      expected.blockingAncestor = "visibility-hidden";
    }
    if (mode === "opacity") {
      f.styles.set(f.panel, { opacity: "0" });
      expected.blockingAncestor = "opacity-zero";
    }
    if (["overfull", "absolute", "fixed", "hidden-child"].includes(mode)) {
      f.sizes.set(f.diff, { width: 300, height: 600 });
      expected.nonListDemandExhaustsChanges = mode === "overfull";
      if (mode === "absolute" || mode === "fixed") f.styles.set(f.diff, { position: mode });
      if (mode === "hidden-child") f.diff.hidden = true;
    }
    if (mode === "contents-child" || mode === "unknown-child-display") {
      f.styles.set(f.diff, {
        display: mode === "contents-child" ? "contents" : "private-unavailable",
      });
      expected.nonListDemandExhaustsChanges = null;
    }
    if (mode === "invalid-child-size") {
      f.sizes.set(f.diff, { width: 300, height: NaN });
      expected.nonListDemandExhaustsChanges = null;
    }
    if (mode === "invalid-gap") {
      f.styles.set(f.changes, { rowGap: "private-unavailable" });
      expected.nonListDemandExhaustsChanges = null;
    }
    if (mode === "normal-gap") f.styles.set(f.changes, { rowGap: "normal" });
    if (mode === "margin-gap") {
      f.styles.set(f.diff, { marginTop: "70px", marginBottom: "70px" });
      f.styles.set(f.changes, { rowGap: "10px" });
      expected.nonListDemandExhaustsChanges = true;
    }
    if (mode === "too-many-children") {
      for (let index = 0; index < 6; index++) f.changes.append(document.createElement("div"));
      Object.assign(expected, {
        diffPanePresent: null,
        commitBoxPresent: null,
        nonListDemandExhaustsChanges: null,
      });
    }
    if (mode === "too-many-ancestors") {
      for (let index = 0; index < 25; index++) {
        const wrapper = document.createElement("div");
        const owner = f.topology!.owner;
        owner.parentElement!.insertBefore(wrapper, owner);
        wrapper.append(owner);
      }
      expected.blockingAncestor = null;
    }
    if (mode === "unknown-css") {
      f.styles.set(f.panel, { opacity: "private-unavailable" });
      expected.blockingAncestor = null;
    }
    if (mode === "duplicate-panel") {
      const duplicate = document.createElement("div");
      duplicate.id = f.panel.id;
      duplicate.setAttribute("role", "tabpanel");
      document.body.append(duplicate);
    }
    if (mode === "wrong-parent") {
      const wrapper = document.createElement("div");
      f.changes.prepend(wrapper);
      wrapper.append(f.list);
    }
    if (mode === "duplicate-commit") f.changes.append(f.commit.cloneNode(true));
    const output = textRowObservation(input);
    expect(output).not.toBeNull();
    expect(output?.layout).toEqual(
      ["duplicate-panel", "wrong-parent", "duplicate-commit"].includes(mode) ? null : expected,
    );
    expect(projectTextRow(output)).toEqual(output);
    expect(JSON.stringify(output)).not.toMatch(
      /private|owned|pierre|visual|4885|http|px|width":|height":/,
    );
  });
  it("quarantines optional measurement exceptions without replacing original facts", () => {
    const f = layoutDom();
    Object.defineProperty(f.diff, "getBoundingClientRect", {
      value: () => {
        throw new Error("private measurement");
      },
    });
    const output = textRowObservation(input);
    expect(output).toMatchObject(textRowFacts);
    expect(output?.layout).toBeNull();
  });
  it("requires exact nested own-data fields and never invokes payload getters", () => {
    const valid = { ...textRowFacts, layout: layoutFacts };
    expect(projectTextRow(valid)).toEqual(valid);
    for (const key of Object.keys(layoutFacts)) {
      const missing: Record<string, unknown> = { ...layoutFacts };
      delete missing[key];
      expect(projectTextRow({ ...valid, layout: missing })).toBeNull();
      expect(projectTextRow({ ...valid, layout: { ...layoutFacts, [key]: "private" } })).toBeNull();
      const getter = vi.fn(() => {
        throw new Error("private getter");
      });
      Object.defineProperty(missing, key, { enumerable: true, get: getter });
      expect(projectTextRow({ ...valid, layout: missing })).toBeNull();
      expect(getter).not.toHaveBeenCalled();
    }
    expect(projectTextRow({ ...valid, layout: { ...layoutFacts, rawSize: 300 } })).toBeNull();
    expect(projectTextRow({ ...valid, layout: [] })).toBeNull();
    const revoked = Proxy.revocable(layoutFacts, {});
    revoked.revoke();
    expect(projectTextRow({ ...valid, layout: revoked.proxy })).toBeNull();
    expect(
      projectTextRow({
        ...valid,
        layout: new Proxy(layoutFacts, {
          ownKeys() {
            throw new Error("private proxy");
          },
        }),
      }),
    ).toBeNull();
  });
  it.each([
    "ok",
    "row-none",
    "duplicate-hidden-first",
    "history",
    "zero-list",
    "empty",
    "loading",
    "error",
    "filter",
  ])("reads only the source-backed current text-row failure facts: %s", (mode) => {
    textRowDom();
    if (mode === "row-none") document.querySelector('[data-path="pierre-step5.ts"]')!.remove();
    if (mode === "duplicate-hidden-first") {
      const hidden = document.createElement("div");
      hidden.hidden = true;
      hidden.append(document.querySelector('[data-path="pierre-step5.ts"]')!.cloneNode(true));
      document.body.prepend(hidden);
    }
    if (mode === "history") {
      document.querySelector('[role="tab"]')!.setAttribute("aria-selected", "false");
      document.querySelector<HTMLElement>('[role="tabpanel"]')!.hidden = true;
    }
    if (mode === "zero-list")
      Object.defineProperty(
        document.querySelector<HTMLElement>('[role="listbox"]')!,
        "getBoundingClientRect",
        { value: () => new DOMRect() },
      );
    if (["empty", "loading", "error", "filter"].includes(mode)) {
      const extra = document.createElement("div");
      extra.innerHTML =
        mode === "empty"
          ? "<p>No local changes</p>"
          : mode === "loading"
            ? '<div role="status">Connecting to changes…</div>'
            : mode === "error"
              ? '<div role="alert">private error text</div>'
              : '<input name="git-manager-change-filter" value="private filter value">';
      document.querySelector('[role="tabpanel"]')!.append(extra);
    }
    const output = textRowObservation(input) as Record<string, unknown>;
    const expected: Record<string, unknown> = { ...textRowFacts };
    if (mode === "row-none")
      Object.assign(expected, {
        globalTextRows: "none",
        scopedTextRows: "none",
        firstMatchVisible: false,
      });
    if (mode === "duplicate-hidden-first")
      Object.assign(expected, { globalTextRows: "multiple", firstMatchVisible: false });
    if (mode === "history")
      Object.assign(expected, {
        changesActive: false,
        scopedTextRows: "none",
        firstMatchVisible: false,
        listBoxPresent: false,
        listBoxPositiveSize: false,
        listBoxVisible: false,
      });
    if (mode === "zero-list")
      Object.assign(expected, { listBoxPositiveSize: false, listBoxVisible: false });
    if (["empty", "loading", "error", "filter"].includes(mode)) expected[mode + "Present"] = true;
    expect(output).toEqual(expected);
    expect(projectTextRow(output)).toEqual(expected);
    expect(JSON.stringify(output)).not.toMatch(/private|owned|pierre|4885|http/);
  });
  it.each([
    "origin",
    "pathname",
    "search",
    "hash",
    "theme",
    "branch",
    "credential",
    "thread",
    "project",
    "rail",
    "duplicate-header",
    "worktree",
    "missing-panel",
  ])("refuses unsafe text-row diagnostic scope: %s", (mode) => {
    textRowDom();
    const value: Observations.VisualObservationInput = { ...input };
    if (["origin", "pathname", "search", "hash"].includes(mode))
      vi.stubGlobal("location", {
        origin: input.origin,
        pathname: "/project/local/owned-project/git",
        search: "",
        hash: "",
        [mode]: "outside",
      });
    if (mode === "theme") value.theme = "dark";
    if (mode === "branch") value.branch = "foreign";
    if (mode === "credential") {
      const field = document.createElement("input");
      field.type = "password";
      document.body.append(field);
    }
    if (mode === "thread") value.threadId = "unsafe/thread";
    if (mode === "project")
      document.querySelector("header")!.setAttribute("data-project-id", "foreign");
    if (mode === "rail")
      document
        .querySelector('[data-testid="environment-rail-local"]')!
        .setAttribute("aria-checked", "false");
    if (mode === "duplicate-header")
      document.body.append(document.querySelector("header")!.cloneNode(true));
    if (mode === "worktree")
      document.querySelector('[aria-label="Worktree"]')!.textContent = "foreign";
    if (mode === "missing-panel") document.querySelector('[role="tabpanel"]')!.remove();
    const query = vi.spyOn(document, "querySelectorAll");
    expect(textRowObservation(value)).toBeNull();
    expect(
      query.mock.calls.some(([selector]) => String(selector).includes('data-path="pierre')),
    ).toBe(false);
  });
  it("contains DOM and input accessor failures without exporting their errors", () => {
    textRowDom();
    const getter = vi.fn(() => {
      throw new Error("private identity getter");
    });
    const malformed = { ...input };
    Object.defineProperty(malformed, "origin", { get: getter });
    expect(textRowObservation(malformed)).toBeNull();
    expect(getter).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("private DOM exception");
    });
    expect(textRowObservation(input)).toBeNull();
  });
  it("projects an exact closed own-data schema and contains getter/proxy failures", () => {
    expect(projectTextRow(textRowFacts)).toEqual(textRowFacts);
    for (const key of Object.keys(textRowFacts)) {
      const missing: Record<string, unknown> = { ...textRowFacts };
      delete missing[key];
      expect(projectTextRow(missing)).toBeNull();
      expect(projectTextRow({ ...textRowFacts, [key]: "private" })).toBeNull();
      let reads = 0;
      Object.defineProperty(missing, key, {
        enumerable: true,
        get: () => {
          reads++;
          throw new Error("private getter");
        },
      });
      expect(projectTextRow(missing)).toBeNull();
      expect(reads).toBe(0);
    }
    expect(projectTextRow({ ...textRowFacts, rawValue: "private" })).toBeNull();
    const revoked = Proxy.revocable(textRowFacts, {});
    revoked.revoke();
    expect(projectTextRow(revoked.proxy)).toBeNull();
    expect(
      projectTextRow(
        new Proxy(textRowFacts, {
          getOwnPropertyDescriptor() {
            throw new Error("private descriptor");
          },
        }),
      ),
    ).toBeNull();
  });
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
