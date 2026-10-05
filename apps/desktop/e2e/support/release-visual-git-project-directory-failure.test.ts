// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual source reads with inert WebDriver/query ports only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as GitProject from "./release-visual-git-project.ts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const exported = GitProject as unknown as {
  readGitProjectDirectoryFailure: (input: object) => unknown;
  projectGitProjectDirectoryFailure: (value: unknown) => unknown;
  gitProjectDirectoryFailureFacts: (error: unknown, phase: unknown) => unknown;
};
const phase = "visual-git-project-directory-nested-displayed";
const selection = {
  projectId: "owned-project",
  threadId: "owned-thread",
  environmentId: "local",
  cwd: "/owned/rich",
  branch: "main",
  title: "rich",
};
const input = {
  origin: "http://127.0.0.1:4885",
  theme: "light",
  selection,
  ordinary: "/owned/ordinary",
};
const facts = {
  popupVisible: true,
  popupInView: true,
  popupHit: true,
  popupStarting: false,
  popupEnding: false,
  popupAnimationsSettled: true,
  pathCount: "one",
  pathMatchesOrdinary: true,
  pathFocused: false,
  pathInView: true,
  pathHit: true,
  ordinaryBreadcrumbSelected: true,
  nestedFolderCount: "one",
  nestedFolderVisible: true,
  nestedFolderInView: true,
  nestedFolderHit: true,
  nestedBreadcrumbCount: "none",
  loadingShown: false,
  fallbackShown: false,
  errorShown: false,
  newFolderEnabled: true,
  openProjectEnabled: true,
};
beforeEach(() => {
  vi.stubGlobal("location", new URL(input.origin + "/local/owned-thread"));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 610,
    bottom: 610,
    width: 600,
    height: 600,
    toJSON: () => ({}),
  });
  vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]);
  document.body.innerHTML =
    '<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="primary-card-button-owned-project" aria-current="page"></button><section data-slot="dialog-popup" role="dialog"><input aria-label="Server directory path" value="/owned/ordinary"><nav aria-label="Directory breadcrumbs"><button aria-current="page" title="/owned/ordinary">ordinary</button></nav><button aria-label="Open nested"><i data-directory-folder-icon></i>nested</button><button aria-label="New folder">New folder</button><button>Open project</button></section>';
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[role="dialog"]'),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("projects only the fixed directory failure facts and never reads unsafe objects", () => {
  expect(exported.projectGitProjectDirectoryFailure).toBeTypeOf("function");
  expect(exported.projectGitProjectDirectoryFailure(facts)).toEqual(facts);
  let reads = 0;
  const getter = { ...facts };
  Object.defineProperty(getter, "pathFocused", {
    enumerable: true,
    get: () => {
      reads++;
      return true;
    },
  });
  const proxy = new Proxy(facts, {
    ownKeys: () => {
      reads++;
      throw new Error("Inert trap");
    },
  });
  for (const value of [
    null,
    [],
    Object.create(facts),
    getter,
    proxy,
    { ...facts, privatePath: "/private" },
    { ...facts, pathCount: 123 },
    { ...facts, popupAnimationsSettled: "unknown" },
  ])
    expect(exported.projectGitProjectDirectoryFailure(value)).toBeNull();
  expect(reads).toBe(0);
});

it("reads folder rows separately from breadcrumbs and returns no page values", () => {
  expect(exported.readGitProjectDirectoryFailure).toBeTypeOf("function");
  const observed = exported.readGitProjectDirectoryFailure(input) as Record<string, unknown>;
  expect(observed.pathMatchesOrdinary).toBe(true);
  expect(observed.nestedFolderCount).toBe("one");
  expect(observed.nestedBreadcrumbCount).toBe("none");
  document
    .querySelector("nav")!
    .insertAdjacentHTML("beforeend", '<button aria-label="Open nested">nested</button>');
  expect(
    (exported.readGitProjectDirectoryFailure(input) as Record<string, unknown>)
      .nestedBreadcrumbCount,
  ).toBe("one");
  expect(exported.projectGitProjectDirectoryFailure(observed)).toEqual(observed);
  expect(JSON.stringify(observed)).not.toMatch(/owned|http|private|nested\"|</);
});

it.each(["origin", "query", "theme", "credential", "duplicate-popup"])(
  "refuses a foreign or unsafe directory observation: %s",
  (mode) => {
    expect(exported.readGitProjectDirectoryFailure).toBeTypeOf("function");
    if (mode === "origin")
      vi.stubGlobal("location", new URL("https://example.test/local/owned-thread"));
    if (mode === "query")
      vi.stubGlobal("location", new URL(input.origin + "/local/owned-thread?private"));
    if (mode === "theme") document.documentElement.classList.add("dark");
    if (mode === "credential")
      document.body.insertAdjacentHTML("beforeend", '<input type="password">');
    if (mode === "duplicate-popup")
      document.body.append(document.querySelector('[role="dialog"]')!.cloneNode(true));
    expect(exported.readGitProjectDirectoryFailure(input)).toBeNull();
    document.documentElement.classList.remove("dark");
  },
);

const sharedDirectoryError = new Error("Inert owned nested display failure.");
it.each(["observed", "unavailable", "malformed", "late"])(
  "joins the failure-only read to the exact reused original error without changing actions: %s",
  async (mode) => {
    const original = sharedDirectoryError;
    const calls: string[] = [];
    let reads = 0;
    const browser = {
      $: (selector: string) => ({
        waitForDisplayed: async () => {
          if (selector === 'button[aria-label="Open nested"]') throw original;
        },
        waitForEnabled: async () => {},
        click: async () => {
          calls.push(selector);
        },
        addValue: async () => {},
        getText: async () => "visual-discovered",
      }),
      $$: () => ({ length: Promise.resolve(1) }),
      keys: async () => {},
      execute: async () => {
        reads++;
        if (mode === "unavailable") throw new Error("Inert read unavailable.");
        if (mode === "late") return new Promise(() => {});
        return mode === "malformed" ? { ...facts, privatePath: "/private" } : facts;
      },
    };
    if (mode === "late") vi.useFakeTimers();
    const rejected = expect(
      GitProject.runGitProjectVisual({
        ...input,
        browser,
        owner: {},
        fixture: { rich: selection.cwd, ordinary: input.ordinary },
        step: () => {},
        selectProject: async () => selection,
        openHiddenWorktrees: async () => {},
        verifyOwnedIdentity: async () => {},
        capture: async () => {},
      } as never),
    ).rejects.toBe(original);
    try {
      if (mode === "late") await vi.advanceTimersByTimeAsync(2_001);
      await rejected;
    } finally {
      if (mode === "late") vi.useRealTimers();
    }
    expect(exported.gitProjectDirectoryFailureFacts).toBeTypeOf("function");
    expect(exported.gitProjectDirectoryFailureFacts(original, phase)).toEqual(
      mode === "observed" ? facts : null,
    );
    expect(exported.gitProjectDirectoryFailureFacts(new Error("Other"), phase)).toBeNull();
    expect(
      exported.gitProjectDirectoryFailureFacts(original, "visual-git-project-directory-path-fill"),
    ).toBeNull();
    expect(reads).toBe(1);
    expect(calls).not.toContain('button[aria-label="Open nested"]');
  },
);

it("keeps clipped/hidden/starting state and unknown animation samples diagnostic only", () => {
  const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
  popup.setAttribute("data-starting-style", "");
  popup.style.opacity = "0";
  vi.spyOn(popup, "getAnimations").mockImplementation(() => {
    throw new Error("Inert animation unavailable");
  });
  const observed = exported.readGitProjectDirectoryFailure(input) as Record<string, unknown>;
  expect(observed.popupStarting).toBe(true);
  expect(observed.popupVisible).toBe(false);
  expect(observed.popupInView).toBe(false);
  expect(observed.popupAnimationsSettled).toBeNull();
  expect(exported.projectGitProjectDirectoryFailure(observed)).toEqual(observed);
});

it("wires the closed projection only into the existing qualifier failure receipt", () => {
  const source = NodeFS.readFileSync(
    NodePath.resolve("apps/desktop/e2e/qualify-delivery-retry.ts"),
    "utf8",
  );
  expect(source).toContain(
    "gitProjectDirectoryFailureFacts: gitProjectDirectoryFailureFacts(error, phase)",
  );
});
