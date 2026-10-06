// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual component and owned source bytes, with inert metadata/geometry only.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readCoreImageDiffWitness,
  runCoreImageDiffOriginal,
  validateCoreImageDiffWitness,
  coreImageScreenshotName,
  type CoreImageObservation,
} from "./release-visual-core-image.ts";
import { QualificationOwner, bounded } from "./qualification-owner.ts";
import { readOwnedDeliveryWorktree } from "./delivery-retry-workspace.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import { observeOwnedBrowserAlert } from "./owned-browser-alert.ts";

const input: CoreImageObservation = {
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned-thread",
  branch: "codex/delivery-retry-light",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

async function mountedImage(theme: "light" | "dark") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/project/local/owned-project/git",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.classList.toggle("dark", theme === "dark");
  const observation = { ...input, theme, branch: "codex/delivery-retry-" + theme };
  document.body.innerHTML = `<header data-environment-id="local" data-project-id="owned-project"><button aria-label="Worktree">${observation.branch}</button><button aria-label="Choose branch">${observation.branch}</button></header><div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><div data-testid="thread-row-owned-thread"><button data-testid="thread-card-button-owned-thread">Owned fixture</button></div><button role="tab" aria-selected="true">History</button><section aria-label="Repository history"><div aria-label="Commit history"><button role="option" aria-selected="true" aria-label="abc1234 Visual qualification baseline">Visual qualification baseline</button></div><div aria-label="Changed files" role="listbox"><button role="option" aria-selected="true" data-changed-file-path="visual-swatch.png">visual-swatch.png</button></div><div id="owned-image-root"></div></section>`;
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-fixture.ts"),
    "utf8",
  );
  const swatches = [...source.matchAll(/"(iVBORw0KGgo[A-Za-z0-9+/=]+)"/g)].map(
    (match) => "data:image/png;base64," + match[1],
  );
  expect(swatches).toHaveLength(2);
  const webRequire = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement, useState } = webRequire("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown) => unknown;
    useState: <T>(value: T) => [T, (value: T) => void];
  };
  const { createRoot } = webRequire("react-dom/client") as {
    createRoot: (element: Element) => { render: (element: unknown) => void; unmount: () => void };
  };
  const module = "../../../web/src/components/gitManager/diff/GitManagerImageDiff.tsx";
  const { GitManagerImageDiff } = await import(module);
  const modes: string[] = [];
  function ImageProbe() {
    const [mode, setMode] = useState("difference");
    return createElement(GitManagerImageDiff, {
      mode,
      before: swatches[1],
      after: swatches[0],
      onModeChange: (next: string) => {
        modes.push(next);
        setMode(next);
      },
    });
  }
  const root = createRoot(document.getElementById("owned-image-root")!);
  const network = vi.fn(() => {
    throw new Error("No network in the image component seam.");
  });
  vi.stubGlobal("fetch", network);
  try {
    await act(async () => root.render(createElement(ImageProbe, null)));
    // Loaded metadata and layout are inert; source inputs are the real two owned PNGs.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(64);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(64);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 10, 500, 300),
    );
    vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
      document.querySelector('section[aria-label="Image diff"]'),
    );
    const reader: typeof readCoreImageDiffWitness = (value) =>
      (
        NodeVM.runInNewContext("(" + readCoreImageDiffWitness.toString() + ")", {
          document,
          location,
          getComputedStyle,
          HTMLElement,
          HTMLImageElement,
          innerWidth,
          innerHeight,
        }) as typeof readCoreImageDiffWitness
      )(value);
    return {
      observation,
      reader,
      act,
      modes,
      network,
      close: async () => act(async () => root.unmount()),
    };
  } catch (error) {
    await act(async () => root.unmount());
    throw error;
  }
}

it.each(["light", "dark"] as const)(
  "reads the actual two-sided Image diff only after public 2-up selection: %s",
  async (theme) => {
    const f = await mountedImage(theme);
    try {
      expect(f.reader(f.observation)?.twoUpMode).toBe(false);
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === "2-up",
      )!;
      await f.act(async () => button.click());
      expect(f.modes).toEqual(["two-up"]);
      const witness = f.reader(f.observation);
      expect(witness).not.toBeNull();
      expect(Object.values(witness!)).toEqual(Array(11).fill(true));
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each(["Before image", "After image"])(
  "refuses a loaded image reduced to one pixel: %s",
  async (label) => {
    const f = await mountedImage("light");
    try {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === "2-up",
      )!;
      await f.act(async () => button.click());
      const image = document.querySelector<HTMLImageElement>(`img[alt="${label}"]`)!;
      vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 1, 1));
      const witness = f.reader(f.observation);
      expect(witness?.loadedImages).toBe(true);
      expect(witness?.beforeAfterVisible).toBe(false);
      expect(() => validateCoreImageDiffWitness(witness)).toThrow(
        "Image visual precondition failed.",
      );
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("captures one original through ordinary History/commit/file/mode actions and owned source checks", async () => {
  const calls: string[] = [];
  await runCoreImageDiffOriginal({
    ...input,
    browser: {
      $: (selector: string) => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => calls.push(selector),
      }),
      $$: () => ({ length: Promise.resolve(1) }),
      execute: async () =>
        Object.fromEntries(
          [
            "themeMatched",
            "selectedMatched",
            "expectedTextMatched",
            "targetInView",
            "credentialAbsent",
            "bootShellAbsent",
            "selectedBaseline",
            "selectedImage",
            "loadedImages",
            "beforeAfterVisible",
            "twoUpMode",
          ].map((key) => [key, true]),
        ),
    } as never,
    owner: {
      until: async (read) => expect(await read()).toBe(true),
      cleanup: async (_role, run) => run(),
    },
    verifyOwnedSource: async () => {
      calls.push("source");
    },
    capture: async () => {
      calls.push("capture");
    },
    step: () => {},
  });
  expect(calls[0]).toBe("source");
  expect(calls.at(-2)).toBe("capture");
  expect(calls.at(-1)).toBe("source");
  expect(calls.filter((value) => value === "capture")).toHaveLength(1);
  expect(calls).toContain('//*[@aria-label="Image diff mode"]//button[normalize-space()="2-up"]');
});

it("the actual image driver selects public 2-up on the real component before admitting its capture", async () => {
  const f = await mountedImage("light");
  const selectors = new Map<string, string>([
    ['//button[@role="tab" and normalize-space()="History"]', 'button[role="tab"]'],
    [
      '//*[@aria-label="Commit history"]//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]',
      '[aria-label="Commit history"] button',
    ],
    [
      '[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]',
      '[data-changed-file-path="visual-swatch.png"]',
    ],
    [
      '//*[@aria-label="Image diff mode"]//button[normalize-space()="2-up"]',
      '[aria-label="Image diff mode"] button',
    ],
  ]);
  const find = (selector: string) => {
    expect(selectors.has(selector)).toBe(true);
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(selectors.get(selector)!),
    ).filter(
      (button) => !selector.includes('normalize-space()="2-up"') || button.textContent === "2-up",
    );
  };
  let sources = 0,
    captures = 0;
  try {
    expect(f.reader(f.observation)?.twoUpMode).toBe(false);
    await runCoreImageDiffOriginal({
      ...f.observation,
      browser: {
        $$: (selector: string) => ({ length: Promise.resolve(find(selector).length) }),
        $: (selector: string) => ({
          waitForDisplayed: async () => {},
          waitForEnabled: async () => expect(find(selector)[0]!.disabled).toBe(false),
          click: async () => f.act(async () => find(selector)[0]!.click()),
        }),
        execute: async (reader: typeof readCoreImageDiffWitness, value: CoreImageObservation) => {
          expect(reader).toBe(readCoreImageDiffWitness);
          return f.reader(value);
        },
      } as never,
      owner: {
        until: async (read) => expect(await read()).toBe(true),
        cleanup: async (_role, run) => run(),
      },
      verifyOwnedSource: async () => {
        sources++;
      },
      capture: async () => {
        expect(validateCoreImageDiffWitness(f.reader(f.observation))).toEqual(validImageWitness());
        expect(f.modes).toEqual(["two-up"]);
        captures++;
      },
      step: () => {},
    });
    expect([sources, captures]).toEqual([2, 1]);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["hidden-header", "invalid-clip"])(
  "refuses unsafe owned image context or geometry: %s",
  async (mode) => {
    const f = await mountedImage("light");
    try {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === "2-up",
      )!;
      await f.act(async () => button.click());
      if (mode === "hidden-header") document.querySelector("header")!.setAttribute("hidden", "");
      else {
        const parent = document.querySelector('section[aria-label="Image diff"]')!.parentElement!;
        parent.style.overflow = "hidden";
        Object.defineProperty(parent, "getBoundingClientRect", {
          configurable: true,
          value: () => new DOMRect(Number.NaN, 0, 1280, 960),
        });
      }
      const witness = f.reader(f.observation);
      expect(() => validateCoreImageDiffWitness(witness)).toThrow();
      if (mode === "hidden-header") expect(witness).toBeNull();
      else expect(witness?.targetInView).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.each(["pairing", "password", "one-time-code", "pairing-textarea", "boot-shell", "vite-overlay"])(
  "refuses %s before reading credential values or image sources/metadata",
  async (kind) => {
    const f = await mountedImage("light");
    try {
      let secretReads = 0,
        sourceReads = 0,
        metadataReads = 0;
      const field = document.createElement(
        kind === "pairing-textarea"
          ? "textarea"
          : kind === "vite-overlay"
            ? "vite-error-overlay"
            : "input",
      );
      if (kind === "pairing") field.id = "pairing-token";
      if (kind === "password") field.setAttribute("type", "password");
      if (kind === "one-time-code") field.setAttribute("autocomplete", "one-time-code");
      if (kind === "pairing-textarea") field.setAttribute("placeholder", "bibcode://pair owned");
      if (kind === "boot-shell") field.id = "boot-shell";
      Object.defineProperty(field, "value", {
        get: () => {
          secretReads++;
          return "private canary";
        },
      });
      document.body.append(field);
      const image = document.querySelector("img")!;
      const getAttribute = image.getAttribute.bind(image);
      vi.spyOn(image, "getAttribute").mockImplementation((name) => {
        if (name === "src") sourceReads++;
        return getAttribute(name);
      });
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(() => {
        metadataReads++;
        return 64;
      });
      expect(f.reader(f.observation)).toBeNull();
      expect([secretReads, sourceReads, metadataReads]).toEqual([0, 0, 0]);
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([
  "origin",
  "query",
  "hash",
  "route",
  "theme",
  "branch",
  "project",
  "rail",
  "card",
  "duplicate-card",
  "foreign-card",
])("refuses a stale or foreign image identity before capture: %s", async (kind) => {
  const f = await mountedImage("light");
  try {
    const current = {
      origin: input.origin,
      pathname: "/project/local/owned-project/git",
      search: "",
      hash: "",
    };
    if (kind === "origin") current.origin = "http://localhost:4885";
    if (kind === "query") current.search = "?owned=private";
    if (kind === "hash") current.hash = "#private";
    if (kind === "route") current.pathname = "/local/owned-thread";
    vi.stubGlobal("location", current);
    if (kind === "theme") document.documentElement.classList.add("dark");
    if (kind === "branch") f.observation.branch = "main";
    if (kind === "project")
      document.querySelector("header")!.setAttribute("data-project-id", "other-project");
    if (kind === "rail")
      document
        .querySelector('[data-testid="environment-rail-local"]')!
        .setAttribute("aria-checked", "false");
    const card = document.querySelector('[data-testid="thread-card-button-owned-thread"]')!;
    if (kind === "card") card.remove();
    if (kind === "duplicate-card") document.body.append(card.cloneNode(true));
    if (kind === "foreign-card") document.body.append(card);
    expect(f.reader(f.observation)).toBeNull();
  } finally {
    await f.close();
  }
});

it.each([
  "baseline",
  "image-row",
  "unloaded",
  "same-images",
  "remote-image",
  "missing-before",
  "difference",
  "viewport",
  "clipped",
  "obstructed",
  "other-dialog",
])("does not admit an incomplete or obscured actual image view: %s", async (kind) => {
  const f = await mountedImage("light");
  try {
    const twoUp = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (node) => node.textContent === "2-up",
    )!;
    await f.act(async () => twoUp.click());
    if (kind === "baseline")
      document
        .querySelector('[aria-label="Commit history"] button')!
        .setAttribute("aria-selected", "false");
    if (kind === "image-row")
      document
        .querySelector('[data-changed-file-path="visual-swatch.png"]')!
        .setAttribute("aria-selected", "false");
    if (kind === "unloaded")
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    const before = document.querySelector<HTMLImageElement>('img[alt="Before image"]')!,
      after = document.querySelector<HTMLImageElement>('img[alt="After image"]')!;
    if (kind === "same-images") after.setAttribute("src", before.getAttribute("src")!);
    if (kind === "remote-image") {
      const attribute = after.getAttribute.bind(after);
      vi.spyOn(after, "getAttribute").mockImplementation((name) =>
        name === "src" ? "https://example.invalid/private.png" : attribute(name),
      );
    }
    if (kind === "missing-before") before.remove();
    if (kind === "difference") {
      const mode = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === "Difference",
      )!;
      await f.act(async () => mode.click());
    }
    if (kind === "viewport") vi.stubGlobal("innerHeight", 959);
    if (kind === "clipped") {
      const parent = document.querySelector('section[aria-label="Image diff"]')!.parentElement!;
      parent.style.overflow = "hidden";
      Object.defineProperty(parent, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(10, 10, 500, 299),
      });
    }
    if (kind === "obstructed")
      vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body);
    if (kind === "other-dialog") {
      const dialog = document.createElement("div");
      dialog.setAttribute("data-slot", "dialog-popup");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
    }
    const witness = f.reader(f.observation);
    expect(witness).not.toBeNull();
    expect(() => validateCoreImageDiffWitness(witness)).toThrow();
    expect(Object.values(witness!).every((value) => typeof value === "boolean")).toBe(true);
  } finally {
    await f.close();
  }
});

const validImageWitness = () =>
  Object.fromEntries(
    [
      "themeMatched",
      "selectedMatched",
      "expectedTextMatched",
      "targetInView",
      "credentialAbsent",
      "bootShellAbsent",
      "selectedBaseline",
      "selectedImage",
      "loadedImages",
      "beforeAfterVisible",
      "twoUpMode",
    ].map((key) => [key, true]),
  );
it.each([
  "false",
  "missing",
  "extra",
  "inherited",
  "accessor",
  "non-enumerable",
  "symbol",
  "live-proxy",
  "revoked-proxy",
])("refuses unsafe Node capture evidence without getter or proxy reflection: %s", (kind) => {
  let reads = 0;
  let value: object = validImageWitness();
  if (kind === "false") Reflect.set(value, "loadedImages", false);
  if (kind === "missing") Reflect.deleteProperty(value, "selectedImage");
  if (kind === "extra")
    Object.defineProperty(value, "private", {
      enumerable: true,
      get: () => {
        reads++;
        return "private";
      },
    });
  if (kind === "inherited") {
    Reflect.deleteProperty(value, "loadedImages");
    Object.setPrototypeOf(value, {
      get loadedImages() {
        reads++;
        return true;
      },
    });
  }
  if (kind === "accessor")
    Object.defineProperty(value, "loadedImages", {
      enumerable: true,
      get: () => {
        reads++;
        return true;
      },
    });
  if (kind === "non-enumerable")
    Object.defineProperty(value, "loadedImages", { enumerable: false, value: true });
  if (kind === "symbol") {
    Reflect.deleteProperty(value, "loadedImages");
    Reflect.set(value, Symbol("private"), true);
  }
  if (kind === "live-proxy")
    value = new Proxy(value, {
      ownKeys: () => {
        reads++;
        throw new Error("private reflection");
      },
    });
  if (kind === "revoked-proxy") {
    const p = Proxy.revocable(value, {});
    p.revoke();
    value = p.proxy;
  }
  expect(() => validateCoreImageDiffWitness(value)).toThrow();
  expect(reads).toBe(0);
});

it.each([
  "ready",
  "missing",
  "duplicate",
  "click",
  "read",
  "unsettled",
  "capture",
  "initial-source",
  "final-source",
  "capture-and-source",
])("keeps public image ownership, cleanup and the original failure: %s", async (kind) => {
  const calls: string[] = [];
  const owner = new QualificationOwner("owned-root", "owned-fixture");
  const original = new Error("Inert original image action failure.");
  const cleanupFailure = new Error("Inert final source failure.");
  let sourceReads = 0;
  const run = runCoreImageDiffOriginal({
    ...input,
    browser: {
      $$: () => ({
        length: Promise.resolve(kind === "missing" ? 0 : kind === "duplicate" ? 2 : 1),
      }),
      $: () => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => {
          calls.push("click");
          if (kind === "click") throw original;
        },
      }),
      execute: async () => {
        calls.push("read");
        if (kind === "read") throw original;
        return { ...validImageWitness(), loadedImages: kind !== "unsettled" };
      },
    } as never,
    owner: {
      until: async (read) => {
        if (!(await read())) throw original;
      },
      cleanup: owner.cleanup.bind(owner),
    },
    verifyOwnedSource: async () => {
      calls.push("source");
      sourceReads++;
      if (kind === "initial-source" && sourceReads === 1) throw original;
      if ((kind === "final-source" || kind === "capture-and-source") && sourceReads === 2)
        throw cleanupFailure;
    },
    capture: async () => {
      calls.push("capture");
      if (kind === "capture" || kind === "capture-and-source") throw original;
    },
    step: () => {},
  });
  if (kind === "ready") {
    await run;
    expect(calls).toEqual([
      "source",
      "click",
      "click",
      "click",
      "click",
      "read",
      "capture",
      "source",
    ]);
  } else {
    const failure = await run.catch((error: unknown) => error);
    if (["missing", "duplicate", "final-source"].includes(kind))
      expect(failure).toBeInstanceOf(Error);
    else expect(failure).toBe(original);
    if (!["capture", "final-source", "capture-and-source"].includes(kind))
      expect(calls).not.toContain("capture");
  }
  expect(sourceReads).toBe(kind === "initial-source" ? 1 : 2);
  expect(owner.failures.map((failure) => failure.role)).toEqual(
    kind === "final-source" || kind === "capture-and-source" ? ["visual-owned-image-source"] : [],
  );
});

it.each([false, true])(
  "uses the existing private Git-source reader on success and failed capture: failure=%s",
  async (failed) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "image-owned-")),
    );
    const project = NodePath.join(root, "primary"),
      home = NodePath.join(root, "home"),
      worktree = NodePath.join(root, "selected");
    const commonDirectory = NodePath.join(project, ".git"),
      admin = NodePath.join(commonDirectory, "worktrees", "selected");
    try {
      for (const directory of [home, worktree, admin])
        NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(worktree, ".git"), "gitdir: " + admin + "\n", {
        mode: 0o600,
      });
      NodeFS.writeFileSync(NodePath.join(admin, "gitdir"), NodePath.join(worktree, ".git") + "\n", {
        mode: 0o600,
      });
      const swatch = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "release-visual-fixture.ts"),
        "utf8",
      ).match(/"(iVBORw0KGgo[A-Za-z0-9+/=]+)"/)![1]!;
      const originalBytes = Buffer.from(swatch, "base64");
      const sourceFile = NodePath.join(worktree, "visual-swatch.png");
      NodeFS.writeFileSync(sourceFile, originalBytes, { mode: 0o600 });
      const identitySource = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "delivery-retry-workspace.ts"),
        "utf8",
      );
      const identityBegin = identitySource.indexOf("export function readOwnedDeliveryWorktree("),
        identityEnd = identitySource.indexOf("/** Public rendered-card", identityBegin);
      expect(identityBegin).toBeGreaterThan(0);
      expect(identityEnd).toBeGreaterThan(identityBegin);
      const read = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          identitySource.slice(identityBegin, identityEnd).replace("export ", ""),
        ) + "\nreadOwnedDeliveryWorktree",
        {
          NodeFS,
          NodePath,
          NodeChildProcess: {
            spawnSync: (
              _command: string,
              args: string[],
              options: { env: Record<string, string>; timeout: number; shell: boolean },
            ) => {
              expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
              expect(options.timeout).toBe(5000);
              expect(options.shell).toBe(false);
              return {
                status: 0,
                stdout: args.includes("worktree")
                  ? "worktree " +
                    project +
                    "\0branch refs/heads/main\0\0worktree " +
                    worktree +
                    "\0branch refs/heads/" +
                    input.branch +
                    "\0\0"
                  : commonDirectory + "\n",
              };
            },
          },
        },
      ) as typeof readOwnedDeliveryWorktree;
      const owner = new QualificationOwner(root, root);
      let verified = 0;
      const original = new Error("Inert capture failure with owned Git identity.");
      const run = runCoreImageDiffOriginal({
        ...input,
        browser: {
          $$: () => ({ length: Promise.resolve(1) }),
          $: () => ({
            waitForDisplayed: async () => {},
            waitForEnabled: async () => {},
            click: async () => {},
          }),
          execute: async () => validImageWitness(),
        } as never,
        owner: {
          until: async (check) => expect(await check()).toBe(true),
          cleanup: owner.cleanup.bind(owner),
        },
        verifyOwnedSource: async () => {
          expect(
            read({ root, home, project, git: "/owned/bin/git", branch: input.branch }),
          ).toEqual({ path: worktree, branch: input.branch, commonDirectory });
          verified++;
        },
        capture: async () => {
          if (failed) throw original;
        },
        step: () => {},
      });
      if (failed) await expect(run).rejects.toBe(original);
      else await run;
      expect(verified).toBe(2);
      expect(owner.failures).toHaveLength(0);
      expect(NodeFS.readFileSync(sourceFile)).toEqual(originalBytes);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

function originalPng(width = 1280, height = 960, blank = false) {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(NodeZlib.crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  if (!blank)
    for (let row = 0; row < height; row++)
      rows.fill(row % 256, row * (width * 3 + 1) + 1, (row + 1) * (width * 3 + 1));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it.each([
  "original",
  "after-unsafe",
  "blank",
  "wrong-size",
  "duplicate",
  "alert",
  "screenshot-error",
])(
  "uses the actual unchanged shared original owner with strict image reader/name/validator ports: %s",
  async (kind) => {
    const f = await mountedImage("light");
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "image-original-")),
    );
    const original = new Error("Inert original screenshot failure.");
    const bytes = originalPng(kind === "wrong-size" ? 1279 : 1280, 960, kind === "blank");
    const captured = new Set<string>(
      kind === "duplicate" ? [coreImageScreenshotName("light")] : [],
    );
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const begin = source.indexOf("export async function captureVisualScene("),
      end = source.indexOf("export interface VisualCoreInput", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    // Only the three declared dispatch ports differ before root integrates the image
    // scene. The existing screenshot/PNG bytes, wait and post-read body execute unchanged.
    const capture = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end).replace("export ", "")) +
        "\ncaptureVisualScene",
      {
        NodeFS,
        NodePath,
        Buffer,
        bounded,
        inspectScreenshot,
        observeOwnedBrowserAlert,
        visualScreenshotName: (scene: string, theme: string) => {
          expect(scene).toBe("git-image-diff");
          return coreImageScreenshotName(theme);
        },
        validateVisualWitness: (scene: string, value: unknown) => {
          expect(scene).toBe("git-image-diff");
          return validateCoreImageDiffWitness(value);
        },
        readVisualWitness: readCoreImageDiffWitness,
        readCoreImageDiffWitness,
      },
    ) as (input: unknown) => Promise<unknown>;
    let snapshots = 0;
    try {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === "2-up",
      )!;
      await f.act(async () => button.click());
      const run = capture({
        ...f.observation,
        scene: "git-image-diff",
        evidence: directory,
        captured,
        verifyOwnedSource: async () => {},
        owner: { until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true) },
        browser: {
          ownedIsAlertOpen: async () => kind === "alert",
          execute: async (
            reader: typeof readCoreImageDiffWitness,
            observation: CoreImageObservation,
          ) => {
            expect(reader).toBe(readCoreImageDiffWitness);
            return f.reader(observation);
          },
          takeScreenshot: async () => {
            snapshots++;
            if (kind === "screenshot-error") throw original;
            if (kind === "after-unsafe") {
              const field = document.createElement("textarea");
              field.setAttribute("placeholder", "bibcode://pair owned");
              document.body.append(field);
            }
            return bytes.toString("base64");
          },
        },
      });
      if (kind === "original") {
        await run;
        const file = NodePath.join(directory, coreImageScreenshotName("light"));
        expect(NodeFS.readFileSync(file)).toEqual(bytes);
        expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
        expect(captured).toEqual(new Set([coreImageScreenshotName("light")]));
      } else {
        const failure = await run.catch((error: unknown) => error);
        if (kind === "screenshot-error") expect(failure).toBe(original);
        else expect(failure).toBeTruthy();
        expect(NodeFS.readdirSync(directory)).toEqual([]);
      }
      expect(snapshots).toBe(kind === "duplicate" || kind === "alert" ? 0 : 1);
    } finally {
      await f.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
