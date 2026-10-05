// @vitest-environment happy-dom
import * as Observation from "./git-project-tab-observation.ts";
// @effect-diagnostics nodeBuiltinImport:off - A serialized reader is replayed with inert DOM ports only.
import * as NodeVM from "node:vm";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import { bounded } from "./qualification-owner.ts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const api = Observation as unknown as {
  readGitProjectTabFailure: (input: object) => unknown;
  projectGitProjectTabFailure: (value: unknown) => unknown;
  observeGitProjectTabFailure: (error: unknown, input: object) => Promise<void>;
  gitProjectTabFailureFacts: (error: unknown, phase: unknown) => unknown;
};
const input = {
  origin: "http://127.0.0.1:4885",
  theme: "light",
  tab: "changes",
  selection: {
    environmentId: "local",
    projectId: "owned-project",
    threadId: "owned-thread",
    cwd: "/owned/merge",
  },
};
beforeEach(() => {
  vi.stubGlobal("location", new URL(input.origin + "/project/local/owned-project/git"));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.classList.remove("dark");
  document.body.innerHTML =
    '<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="primary-card-button-owned-project" ></button><header data-environment-id="local" data-project-id="owned-project"><span data-testid="git-manager-project" title="/owned/merge"></span></header><button role="tab" aria-selected="false">Changes</button><button role="tab" aria-selected="true">History</button><button role="tab">Tags</button>';
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 110,
    bottom: 40,
    width: 100,
    height: 30,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[role="tab"]'),
  );
  vi.stubGlobal("getComputedStyle", (node: HTMLElement) => ({
    display: node.style.display || "block",
    visibility: node.style.visibility || "visible",
    opacity: node.style.opacity || "1",
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("samples the owned tab without retaining names, values, coordinates or identifiers", () => {
  expect(api.readGitProjectTabFailure).toBeTypeOf("function");
  const facts = api.readGitProjectTabFailure(input) as Record<string, unknown>;
  expect(facts).toMatchObject({
    tabCount: "one",
    tabVisible: true,
    tabEnabled: true,
    tabInView: true,
    tabHit: true,
    tabSelected: false,
    receiverSlot: "target",
    receiverEnding: false,
  });
  expect(api.projectGitProjectTabFailure(facts)).toEqual(facts);
  expect(JSON.stringify(facts)).not.toMatch(/owned|4885|http|Changes|History|<|\"x\"/);
});

it("executes the actual serialized reader without imported helpers", () => {
  const read = NodeVM.runInNewContext("(" + api.readGitProjectTabFailure.toString() + ")", {
    location,
    document,
    getComputedStyle,
    innerWidth,
    innerHeight,
  }) as (input: object) => unknown;
  expect(read(input)).toEqual(api.readGitProjectTabFailure(input));
});

it.each(["dialog-popup", "dialog-backdrop", "popover-popup", "toast-root", "other"])(
  "records only the closed receiving slot for %s without claiming a cause",
  (slot) => {
    const blocker = document.createElement("div");
    blocker.setAttribute("data-slot", slot);
    blocker.setAttribute("data-ending-style", "");
    blocker.textContent = "Private native value must never leave the page";
    document.body.append(blocker);
    vi.mocked(document.elementFromPoint).mockReturnValue(blocker);
    const facts = api.readGitProjectTabFailure(input) as Record<string, unknown>;
    expect(facts.tabHit).toBe(false);
    expect(facts.receiverSlot).toBe(slot);
    expect(facts.receiverEnding).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("Private");
  },
);

it.each([
  "origin",
  "query",
  "fragment",
  "theme",
  "credential",
  "boot",
  "foreign-card",
  "duplicate-card",
  "disconnected",
  "invalid-tab",
  "chat-route",
  "foreign-header",
  "foreign-checkout",
  "duplicate-header",
])("refuses unsafe or foreign context: %s", (mode) => {
  if (mode === "origin")
    vi.stubGlobal("location", new URL("https://foreign.test/local/owned-thread"));
  if (mode === "query")
    vi.stubGlobal("location", new URL(input.origin + "/project/local/owned-project/git?secret"));
  if (mode === "fragment")
    vi.stubGlobal("location", new URL(input.origin + "/project/local/owned-project/git#secret"));
  if (mode === "theme") document.documentElement.classList.add("dark");
  if (mode === "credential")
    document.body.insertAdjacentHTML("beforeend", '<input type="password">');
  if (mode === "boot") document.body.insertAdjacentHTML("beforeend", '<div id="boot-shell"></div>');
  if (mode === "foreign-card")
    document.querySelector('[data-testid="primary-card-button-owned-project"]')!.remove();
  if (mode === "duplicate-card")
    document.body.append(
      document.querySelector('[data-testid="primary-card-button-owned-project"]')!.cloneNode(true),
    );
  if (mode === "disconnected") document.querySelector('[data-status="connected"]')!.remove();
  if (mode === "chat-route")
    vi.stubGlobal("location", new URL(input.origin + "/local/owned-thread"));
  if (mode === "foreign-header")
    document.querySelector("header")!.setAttribute("data-project-id", "other");
  if (mode === "foreign-checkout")
    document.querySelector('[data-testid="git-manager-project"]')!.setAttribute("title", "/other");
  if (mode === "duplicate-header")
    document.body.append(document.querySelector("header")!.cloneNode(true));
  expect(
    api.readGitProjectTabFailure(mode === "invalid-tab" ? { ...input, tab: "private" } : input),
  ).toBeNull();
});

it("distinguishes missing, duplicated, hidden and disabled targets without inventing a target", () => {
  const tab = document.querySelector('[role="tab"]')!;
  tab.setAttribute("disabled", "");
  expect((api.readGitProjectTabFailure(input) as Record<string, unknown>).tabEnabled).toBe(false);
  (tab as HTMLElement).style.opacity = "0";
  expect((api.readGitProjectTabFailure(input) as Record<string, unknown>).tabVisible).toBe(false);
  document.body.append(tab.cloneNode(true));
  expect(api.readGitProjectTabFailure(input)).toMatchObject({
    tabCount: "many",
    tabHit: null,
    receiverSlot: null,
  });
  document.querySelectorAll('[role="tab"]').forEach((node) => node.remove());
  expect(api.readGitProjectTabFailure(input)).toMatchObject({
    tabCount: "none",
    tabEnabled: null,
    receiverSlot: null,
  });
});

it("rejects proxy/accessor/nonenumerable/extra output without touching unsafe fields", () => {
  const facts = api.readGitProjectTabFailure(input) as Record<string, unknown>;
  let reads = 0;
  const accessor = { ...facts };
  Object.defineProperty(accessor, "tabHit", {
    enumerable: true,
    get: () => {
      reads++;
      return true;
    },
  });
  const proxy = new Proxy(facts, {
    ownKeys: () => {
      reads++;
      throw new Error("private trap");
    },
  });
  const hidden = { ...facts };
  Object.defineProperty(hidden, "tabHit", { enumerable: false, value: true });
  for (const value of [
    null,
    [],
    Object.create(facts),
    accessor,
    proxy,
    hidden,
    { ...facts, private: "secret" },
    { ...facts, tabCount: 123 },
    { ...facts, receiverSlot: "private" },
  ])
    expect(api.projectGitProjectTabFailure(value)).toBeNull();
  expect(reads).toBe(0);
});

const reused = new Error("Inert original click failure");
it.each(["observed", "unavailable", "malformed", "late"])(
  "executes the actual failing tab click and preserves the reused error: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      NodePath.resolve("apps/desktop/e2e/support/release-visual-git-project.ts"),
      "utf8",
    );
    const begin = source.indexOf(
      "  const click = async (",
      source.indexOf("export async function runGitProjectVisual("),
    );
    const end = source.indexOf("  const capture = async (", begin);
    expect(begin).toBeGreaterThan(0);
    const facts = api.readGitProjectTabFailure(input);
    const calls: string[] = [],
      phases: string[] = [];
    const execute = async () => {
      calls.push("read");
      if (mode === "unavailable") throw new Error("Inert read unavailable");
      if (mode === "late") return new Promise(() => {});
      return mode === "malformed" ? { private: "refused" } : facts;
    };
    const click = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end) + "\nclick"),
      {
        input: { ...input, step: (phase: string) => phases.push(phase) },
        browser: {
          $: () => ({
            waitForDisplayed: async () => {
              calls.push("displayed");
            },
            waitForEnabled: async () => {
              calls.push("enabled");
            },
            click: async () => {
              calls.push("click");
              throw reused;
            },
          }),
          $$: () => ({ length: Promise.resolve(1) }),
          execute,
        },
        observeGitProjectTabFailure: api.observeGitProjectTabFailure,
        observeDirectoryAwait: () => {},
        NodeUtil,
        bounded,
        refused: () => new Error("Inert refusal"),
      },
    ) as (selector: string, directory: undefined, tab: string, selection: object) => Promise<void>;
    if (mode === "late") vi.useFakeTimers();
    const rejected = expect(click("owned-tab", undefined, "Changes", input.selection)).rejects.toBe(
      reused,
    );
    try {
      if (mode === "late") await vi.advanceTimersByTimeAsync(2001);
      await rejected;
    } finally {
      if (mode === "late") vi.useRealTimers();
    }
    expect(calls).toEqual(["displayed", "enabled", "click", "read"]);
    expect(phases.at(-1)).toBe("visual-git-project-tab-changes-click");
    expect(api.gitProjectTabFailureFacts(reused, phases.at(-1))).toEqual(
      mode === "observed" ? facts : null,
    );
    expect(
      api.gitProjectTabFailureFacts(reused, "visual-git-project-tab-history-click"),
    ).toBeNull();
    expect(api.gitProjectTabFailureFacts(new Error("Other"), phases.at(-1))).toBeNull();
  },
);
