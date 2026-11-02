// @vitest-environment happy-dom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import { SourceControlDraftConflict } from "./components/SourceControlDraftConflict";
import { sourceControlDraftKey, useSourceControlDraft } from "./sourceControlDraft";
import { useSourceControlPanelStore } from "./sourceControlPanelStore";

const STORAGE_KEY = "bibcode:source-control-panel-state:v1";
const persisted = new Map<string, string>();
/** While set, the storage refuses new draft entries, as a full disk does. */
let refusing = false;
const storage = {
  getItem: (name: string) => persisted.get(name) ?? null,
  setItem: (name: string, value: string) => {
    if (refusing && name.includes(":draft:")) {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    persisted.set(name, value);
  },
  removeItem: (name: string) => {
    persisted.delete(name);
  },
};
const draftEntry = (cwdKey: string) => `${STORAGE_KEY}:draft:${cwdKey}`;
/** A folder's draft as saved in its own entry. */
const saved = (cwdKey: string) => {
  const entry = persisted.get(draftEntry(cwdKey));
  return entry === undefined ? undefined : JSON.parse(entry).state;
};

/**
 * A browser tab: its own copy of the store over the one shared storage. A tab hears of the
 * others' saves only when `hearSaves` fires the `storage` events, as a browser does later.
 */
interface Tab {
  readonly store: () => ReturnType<typeof useSourceControlPanelStore.getState>;
}
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const { useSourceControlPanelStore: tabStore } = await import("./sourceControlPanelStore");
  tabStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  tabStore.setState({ byThreadKey: {}, byCwdKey: {} });
  return { store: () => tabStore.getState() };
}
function hearSaves() {
  for (const name of persisted.keys()) {
    if (name.startsWith(`${STORAGE_KEY}:draft:`)) {
      window.dispatchEvent(new StorageEvent("storage", { key: name }));
    }
  }
}

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  persisted.clear();
  refusing = false;
  useSourceControlPanelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useSourceControlPanelStore.setState({ byThreadKey: {}, byCwdKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("sourceControlDraftKey", () => {
  it("keys a draft by environment and cwd, so ids cannot collide across environments", () => {
    const a = sourceControlDraftKey({ environmentId: "env-a", cwd: "/repo" });
    const b = sourceControlDraftKey({ environmentId: "env-b", cwd: "/repo" });
    expect(a).not.toEqual(b);
    expect(sourceControlDraftKey({ environmentId: "env-a", cwd: "/repo/" })).toEqual(a);
  });
});

describe("source control store loading", () => {
  it("loads when the browser denies storage access", async () => {
    const denied = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Access is denied.", "SecurityError");
    });
    try {
      vi.resetModules();
      const { useSourceControlPanelStore: tabStore } = await import("./sourceControlPanelStore");
      expect(tabStore.getState().byCwdKey).toEqual({});
    } finally {
      denied.mockRestore();
    }
  });

  it("loads when the saved state is malformed", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    try {
      vi.resetModules();
      const { useSourceControlPanelStore: tabStore } = await import("./sourceControlPanelStore");
      expect(tabStore.getState().byCwdKey).toEqual({});
    } finally {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  });
});

describe("source control draft persistence", () => {
  it("migrates a v1 thread-keyed draft without losing the half-written message", async () => {
    persisted.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { byThreadKey: { "env-a:thread-a": { message: "Keep this draft" } } },
      }),
    );

    await useSourceControlPanelStore.persist.rehydrate();

    expect(useSourceControlPanelStore.getState().byThreadKey).toEqual({
      "env-a:thread-a": { message: "Keep this draft" },
    });
    expect(useSourceControlPanelStore.getState().byCwdKey).toEqual({});

    useSourceControlPanelStore.getState().promoteThreadDraft("env-a:thread-a", "env-a::/repo");
    expect(useSourceControlPanelStore.getState().byCwdKey).toEqual({
      "env-a::/repo": { message: "Keep this draft" },
    });
    expect(useSourceControlPanelStore.getState().byThreadKey).toEqual({});
  });

  it("saves each checkout draft in its own entry and migrates the shared one to them", async () => {
    persisted.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: {
          byThreadKey: { "env-a:thread-a": { message: "Legacy" } },
          byCwdKey: { "env-a::/one": { message: "One" }, "env-a::/two": { message: "Two" } },
        },
      }),
    );
    persisted.set(
      draftEntry("env-a::/two"),
      JSON.stringify({ version: 1, state: { message: "Newer" } }),
    );

    await useSourceControlPanelStore.persist.rehydrate();

    expect(saved("env-a::/one")).toEqual({ message: "One" });
    // A draft already saved for the folder is kept as an alternate, not overwritten.
    expect(saved("env-a::/two")).toEqual({ message: "Two", alternates: ["Newer"] });
    expect(useSourceControlPanelStore.getState().byCwdKey["env-a::/one"]).toEqual({
      message: "One",
    });
    const blob = JSON.parse(persisted.get(STORAGE_KEY)!);
    expect(blob.version).toBe(3);
    expect(blob.state.byCwdKey).toBeUndefined();
    expect(blob.state.byThreadKey).toEqual({ "env-a:thread-a": { message: "Legacy" } });
  });

  it("clears only the requested checkout draft", () => {
    const store = useSourceControlPanelStore.getState();
    store.setCwdMessage("env-a::/one", "One");
    store.setCwdMessage("env-a::/two", "Two");

    useSourceControlPanelStore.getState().clearCwdDraft("env-a::/one", "One");

    expect(useSourceControlPanelStore.getState().byCwdKey).toEqual({
      "env-a::/two": { message: "Two" },
    });
    expect(saved("env-a::/one")).toBeUndefined();
  });
});

describe("source control drafts when storage is full", () => {
  it("keeps what is typed in memory, and warns once, when every save throws", () => {
    const quota = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    useSourceControlPanelStore.persist.setOptions({
      // A full disk refuses the new draft entries; the panel's own entry is unchanged from before.
      storage: createJSONStorage(() => ({
        ...storage,
        setItem: (name: string, value: string) =>
          name.includes(":draft:") ? quota() : storage.setItem(name, value),
      })),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "env-a::/full";
    const store = () => useSourceControlPanelStore.getState();

    store().setCwdMessage(key, "Typed");
    store().setCwdMessage(key, "Typed and pasted");
    expect(store().byCwdKey[key]).toEqual({ message: "Typed and pasted" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("source control drafts that storage refused", () => {
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("keeps old drafts in the saved entry until each is copied, and copies them next load", async () => {
    const oldBlob = {
      version: 2,
      state: { byCwdKey: { "env-a::/migrate-one": { message: "One" } } },
    };
    persisted.set(STORAGE_KEY, JSON.stringify(oldBlob));
    refusing = true;
    const spy = warn();

    await useSourceControlPanelStore.persist.rehydrate();

    expect(useSourceControlPanelStore.getState().byCwdKey["env-a::/migrate-one"]?.message).toBe(
      "One",
    );
    expect(saved("env-a::/migrate-one")).toBeUndefined();
    const kept = JSON.parse(persisted.get(STORAGE_KEY)!);
    expect(kept.version).toBe(3);
    expect(kept.state.byCwdKey).toEqual({ "env-a::/migrate-one": { message: "One" } });
    spy.mockRestore();

    // The next load, with room again, copies it and drops it from the saved entry.
    refusing = false;
    window.localStorage.setItem(STORAGE_KEY, persisted.get(STORAGE_KEY)!);
    vi.resetModules();
    const reopened = await import("./sourceControlPanelStore");
    const entry = window.localStorage.getItem(draftEntry("env-a::/migrate-one"));
    expect(JSON.parse(entry!).state).toEqual({ message: "One" });
    expect(reopened.useSourceControlPanelStore.getState().byCwdKey["env-a::/migrate-one"]).toEqual({
      message: "One",
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).state.byCwdKey).toBeUndefined();
    window.localStorage.clear();
  });

  it("keeps an unsaved edit as the message when another tab saves, and offers theirs", async () => {
    const key = "env-a::/refused-event";
    const [a, b] = [await openTab(), await openTab()];
    const spy = warn();
    refusing = true;
    a.store().setCwdMessage(key, "A typed, not saved");
    refusing = false;
    b.store().setCwdMessage(key, "B saved");
    spy.mockRestore();

    await act(async () => hearSaves());

    const expected = { message: "A typed, not saved", alternates: ["B saved"] };
    expect(a.store().byCwdKey[key]).toEqual(expected);
    expect(saved(key)).toEqual(expected);
  });

  it("keeps newer unsaved text when a delayed commit of the saved text lands", async () => {
    const key = "env-a::/refused-commit";
    const a = await openTab();
    a.store().setCwdMessage(key, "Sent");
    const spy = warn();
    refusing = true;
    a.store().setCwdMessage(key, "Newer, not saved");
    refusing = false;
    spy.mockRestore();

    a.store().clearCwdDraft(key, "Sent");

    expect(a.store().byCwdKey[key]).toEqual({ message: "Newer, not saved" });
    expect(saved(key)).toBeUndefined();
  });
});

describe("source control drafts in several tabs (#219)", () => {
  const ONE = "env-a::/one";
  const TWO = "env-a::/two";
  const hear = () => act(async () => hearSaves());

  it("keeps both folders when two tabs edit different folders", async () => {
    const [a, b] = [await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "One from A");
    b.store().setCwdMessage(TWO, "Two from B");
    a.store().setCwdMessage(ONE, "One from A, edited");

    expect(saved(ONE)).toEqual({ message: "One from A, edited" });
    expect(saved(TWO)).toEqual({ message: "Two from B" });
    await hear();
    for (const tab of [a, b]) {
      expect(tab.store().byCwdKey[ONE]?.message).toBe("One from A, edited");
      expect(tab.store().byCwdKey[TWO]?.message).toBe("Two from B");
    }
  });

  it("follows another tab's draft when it saves", async () => {
    const [a, b] = [await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "Typed in A");
    expect(b.store().byCwdKey[ONE]).toBeUndefined();

    await hear();

    expect(b.store().byCwdKey[ONE]).toEqual({ message: "Typed in A" });
  });

  it("loses no version when three tabs edit before hearing of each other", async () => {
    const [a, b, c] = [await openTab(), await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "From A");
    b.store().setCwdMessage(ONE, "From B");
    c.store().setCwdMessage(ONE, "From C");

    const expected = { message: "From C", alternates: ["From B", "From A"] };
    expect(saved(ONE)).toEqual(expected);
    await hear();
    for (const tab of [a, b, c]) expect(tab.store().byCwdKey[ONE]).toEqual(expected);
  });

  it("keeps at most five alternates, dropping the oldest", async () => {
    for (let index = 0; index < 8; index += 1) {
      (await openTab()).store().setCwdMessage(ONE, `Version ${index}`);
    }
    expect(saved(ONE)).toEqual({
      message: "Version 7",
      alternates: ["Version 6", "Version 5", "Version 4", "Version 3", "Version 2"],
    });
  });

  it("does not delete newer text when a delayed commit of older text lands", async () => {
    const [a, b] = [await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "Commit me");
    await hear();
    b.store().setCwdMessage(ONE, "Newer words");
    await hear();

    a.store().clearCwdDraft(ONE, "Commit me"); // the commit A submitted earlier succeeds now

    expect(saved(ONE)).toEqual({ message: "Newer words" });
    await hear();
    for (const tab of [a, b]) {
      expect(tab.store().byCwdKey[ONE]).toEqual({ message: "Newer words" });
    }
  });

  it("keeps unresolved alternates when the active message is committed", async () => {
    const [a, b] = [await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "From A");
    b.store().setCwdMessage(ONE, "From B");

    b.store().clearCwdDraft(ONE, "From B");

    expect(saved(ONE)).toEqual({ message: "", alternates: ["From A"] });
    await hear();
    expect(a.store().byCwdKey[ONE]).toEqual({ message: "", alternates: ["From A"] });
  });

  it("uses and dismisses alternates without losing the message they replace", async () => {
    const [a, b] = [await openTab(), await openTab()];
    a.store().setCwdMessage(ONE, "From A");
    b.store().setCwdMessage(ONE, "From B");
    b.store().setCwdMessage(ONE, "From B, edited");

    b.store().useCwdAlternate(ONE, "From A");
    expect(saved(ONE)).toEqual({ message: "From A", alternates: ["From B, edited"] });

    b.store().dismissCwdAlternate(ONE, "From B, edited");
    expect(saved(ONE)).toEqual({ message: "From A" });
    expect(saved(TWO)).toBeUndefined();
  });
});

function DraftWriter() {
  const draft = useSourceControlDraft({ environmentId: "env-a", cwd: "/repo" });
  return createElement(
    "button",
    { type: "button", onClick: () => draft.setMessage("Typed from writer") },
    "Write",
  );
}

function DraftReader() {
  const draft = useSourceControlDraft({ environmentId: "env-a", cwd: "/repo/" });
  return createElement("output", null, draft.message);
}

describe("useSourceControlDraft", () => {
  it("shares a message between two consumers of the same checkout", async () => {
    await act(async () =>
      root?.render(
        createElement(Fragment, null, createElement(DraftWriter), createElement(DraftReader)),
      ),
    );

    await act(async () => container.querySelector("button")?.click());

    expect(container.querySelector("output")?.textContent).toBe("Typed from writer");
  });
});

describe("SourceControlDraftConflict", () => {
  it("lists the other versions newest first and swaps or drops each one", async () => {
    const repo = "env-a::/repo";
    const store = useSourceControlPanelStore.getState();
    store.setCwdMessage(repo, "Older");
    (await openTab()).store().setCwdMessage(repo, "Middle\nbody");
    (await openTab()).store().setCwdMessage(repo, "Newest");
    useSourceControlPanelStore.setState({
      byCwdKey: { [repo]: { message: "Newest", alternates: ["Middle\nbody", "Older"] } },
    });
    await act(async () =>
      root?.render(
        createElement(SourceControlDraftConflict, { environmentId: "env-a", cwd: "/repo" }),
      ),
    );
    const rows = () => [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows()).toEqual(["“Middle”UseDismiss", "“Older”UseDismiss"]);

    await act(async () => container.querySelector<HTMLButtonElement>("li button")?.click());
    expect(saved(repo)).toEqual({ message: "Middle\nbody", alternates: ["Newest", "Older"] });

    await act(async () =>
      [...container.querySelectorAll("li")][1]?.querySelectorAll("button")[1]?.click(),
    );
    expect(saved(repo)).toEqual({ message: "Middle\nbody", alternates: ["Newest"] });
  });
});
