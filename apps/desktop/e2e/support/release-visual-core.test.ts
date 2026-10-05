// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Synthetic PNG and inert WebDriver boundary only; no browser or server starts.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  captureVisualScene,
  type VisualCaptureInput,
  type CoreBranchCaptureFailureRecord,
} from "./release-visual-core.ts";
import * as CoreCapture from "./release-visual-core.ts";
import { readVisualWitness, observeVisualNameClear } from "./release-visual-observation.ts";

it("returns from Git through the actual card's public keyboard activation when its sibling covers the button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const webRequire = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement } = webRequire("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  };
  const { createRoot } = webRequire("react-dom/client") as {
    createRoot: (container: Element) => { render: (node: unknown) => void; unmount: () => void };
  };
  const cardModule = "../../../web/src/components/sidebar/WorkspaceCard.tsx";
  const {
    WorkspaceCardShell,
    WorkspaceCardTitleLine,
    WorkspaceCardBranchLine,
    isWorkspaceCardControlTarget,
  } = await import(cardModule);
  const routesModule = "../../../web/src/threadRoutes.ts";
  const { buildThreadRouteParams } = await import(routesModule);
  const logicModule = "../../../web/src/components/Sidebar.logic.ts";
  const { isTrailingDoubleClick, isContextMenuShortcut, contextMenuAnchorForRect } = await import(
    logicModule
  );
  const utilsModule = "../../../web/src/lib/utils.ts";
  const { isMacPlatform } = await import(utilsModule);
  const sidebar = NodeFS.readFileSync(
    NodePath.resolve("apps/web/src/components/Sidebar.tsx"),
    "utf8",
  );
  const threadBegin = sidebar.indexOf("  const handleThreadClick = useCallback(");
  const threadEnd = sidebar.indexOf(
    "  const handleMultiSelectContextMenu = useCallback(",
    threadBegin,
  );
  const cardBegin = sidebar.indexOf("  const handleCardClick = useCallback(");
  const cardEnd = sidebar.indexOf("  const handleCardDoubleClick = useCallback(", cardBegin);
  const keyBegin = sidebar.indexOf("  const handleCardKeyDown = useCallback(");
  const keyEnd = sidebar.indexOf("  const handlePrClick = useCallback(", keyBegin);
  expect(threadBegin).toBeGreaterThan(0);
  expect(threadEnd).toBeGreaterThan(threadBegin);
  expect(cardBegin).toBeGreaterThan(0);
  expect(cardEnd).toBeGreaterThan(cardBegin);
  expect(keyBegin).toBeGreaterThan(0);
  expect(keyEnd).toBeGreaterThan(keyBegin);
  const navigation = vi.fn();
  const markRead = vi.fn();
  const { handleCardClick, handleCardKeyDown } = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      sidebar.slice(threadBegin, threadEnd) +
        sidebar.slice(cardBegin, cardEnd) +
        sidebar.slice(keyBegin, keyEnd) +
        "\n({handleCardClick,handleCardKeyDown})",
    ),
    {
      useCallback: (callback: unknown) => callback,
      isWorkspaceCardControlTarget,
      isMacPlatform,
      isTrailingDoubleClick,
      isContextMenuShortcut,
      contextMenuAnchorForRect,
      keyboardMenuOpenedAtRef: { current: null },
      markKeyboardContextMenuOpened: () => {
        throw new Error("Unexpected context-menu command.");
      },
      openCardMenu: () => {
        throw new Error("Unexpected context-menu command.");
      },
      buildThreadRouteParams,
      navigator: { platform: "Linux" },
      threadRef: { environmentId: "local", threadId: "owned-card" },
      threadKey: "owned-card",
      orderedProjectThreadKeys: ["owned-card"],
      scopedThreadKey: () => "owned-card",
      useThreadSelectionStore: { getState: () => ({ selectedThreadKeys: new Set() }) },
      markWorkspaceRowRead: markRead,
      clearSelection: vi.fn(),
      setSelectionAnchor: vi.fn(),
      toggleThreadSelection: vi.fn(),
      rangeSelectTo: vi.fn(),
      isMobile: false,
      setOpenMobile: vi.fn(),
      router: { navigate: navigation },
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const style = document.createElement("style");
  document.head.append(style);
  try {
    await act(async () =>
      root.render(
        createElement(
          WorkspaceCardShell,
          {
            testId: "thread-row-owned-card",
            buttonTestId: "thread-card-button-owned-card",
            idBase: "owned-card",
            className: "",
            isActive: false,
            hasFlags: false,
            hasBranchLine: true,
            hasSessionLine: false,
            status: { kind: "idle", label: "Idle", colorClass: "text-foreground" },
            onClick: handleCardClick,
            onContextMenu: () => {},
            onButtonKeyDown: handleCardKeyDown,
          },
          createElement(WorkspaceCardTitleLine, {
            id: "owned-card-title",
            flagsId: "owned-card-flags",
            title: "Owned fixture",
            titleTestId: "owned-card-title",
            unread: false,
            pinned: false,
          }),
          createElement(WorkspaceCardBranchLine, {
            id: "owned-card-branch",
            branch: "codex/delivery-retry-light",
            branchTooltip: null,
          }),
        ),
      ),
    );
    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="thread-card-button-owned-card"]',
    )!;
    const branch = container.querySelector<HTMLElement>(
      '#owned-card-branch [data-slot="tooltip-trigger"]',
    )!;
    expect(card.contains(branch)).toBe(false);
    const content = branch.closest<HTMLElement>(".z-10")!;
    expect(card.classList.contains("z-0")).toBe(true);
    expect(content.classList.contains("pointer-events-none")).toBe(true);
    expect(branch.classList.contains("pointer-events-auto")).toBe(true);
    const { compile } = webRequire("tailwindcss") as {
      compile: (source: string) => Promise<{ build: (classes: string[]) => string }>;
    };
    style.textContent = (await compile("@tailwind utilities;")).build([
      "z-0",
      "z-10",
      "pointer-events-none",
      "pointer-events-auto",
    ]);
    expect(getComputedStyle(card).zIndex).toBe("0");
    expect(getComputedStyle(content).zIndex).toBe("10");
    expect(getComputedStyle(content).pointerEvents).toBe("none");
    expect(getComputedStyle(branch).pointerEvents).toBe("auto");
    // Geometry and center-hit placement are explicitly inert. The real DOM/CSS
    // permits this sibling overlap; it does not identify the native covering node.
    const rect = new DOMRect(80, 100, 300, 60);
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(card, "getClientRects").mockReturnValue({
      0: rect,
      length: 1,
      item: () => rect,
      [Symbol.iterator]: () => [rect][Symbol.iterator](),
    });
    vi.spyOn(card, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(card, "clientHeight", "get").mockReturnValue(60);
    const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(branch);
    const desktopRequire = NodeModule.createRequire(NodePath.resolve("apps/desktop/package.json"));
    const sdkRequire = NodeModule.createRequire(desktopRequire.resolve("webdriverio"));
    const sdk = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(desktopRequire.resolve("webdriverio")), "index.js"),
      "utf8",
    );
    const clickableBegin = sdk.indexOf("function isElementClickable(elem) {");
    const clickableEnd = sdk.indexOf("\n// src/commands/element/isClickable.ts", clickableBegin);
    const clickable = NodeVM.runInNewContext(
      sdk.slice(clickableBegin, clickableEnd) + "\nisElementClickable",
      { document, window },
    ) as (element: HTMLElement) => boolean;
    expect(clickable(card)).toBe(false);
    hit.mockReturnValue(card);
    expect(clickable(card)).toBe(true);
    hit.mockReturnValue(branch);
    const keysBegin = sdk.indexOf("async function keys(value) {");
    const keysEnd = sdk.indexOf("\n// src/commands/browser/mock.ts", keysBegin);
    const unicodeBegin = sdk.indexOf("function checkUnicode(value) {");
    const unicodeEnd = sdk.indexOf("\nfunction fetchElementByJSFunction", unicodeBegin);
    const utilsEntry = NodePath.resolve(
      NodePath.dirname(desktopRequire.resolve("webdriverio")),
      "..",
      "..",
      "@wdio/utils/build/index.js",
    );
    const { UNICODE_CHARACTERS } = await import(utilsEntry);
    const sdkKeys = NodeVM.runInNewContext(
      sdk.slice(keysBegin, keysEnd) + sdk.slice(unicodeBegin, unicodeEnd) + "\nkeys",
      {
        Key: desktopRequire("webdriverio").Key,
        UNICODE_CHARACTERS2: UNICODE_CHARACTERS,
        GraphemeSplitter: sdkRequire("grapheme-splitter"),
      },
    ) as (this: unknown, key: string) => Promise<void>;
    const calls: string[] = [];
    const keyPort = {
      isIOS: false,
      action: (type: string) => {
        expect(type).toBe("key");
        const actions: Array<{ operation: string; value: string | number }> = [];
        const action = {
          down: (value: string) => {
            actions.push({ operation: "down", value });
            return action;
          },
          pause: (value: number) => {
            actions.push({ operation: "pause", value });
            return action;
          },
          up: (value: string) => {
            actions.push({ operation: "up", value });
            return action;
          },
          perform: async (release: boolean) => {
            expect(release).toBe(true);
            const key = actions[0]!.value;
            expect(actions).toEqual([
              { operation: "down", value: key },
              { operation: "pause", value: 10 },
              { operation: "up", value: key },
            ]);
            // Fake WebDriver endpoint models only standard Tab focus and native
            // button Enter activation. HappyDOM does not supply native key defaults.
            if (key === desktopRequire("webdriverio").Key.Tab) {
              card.focus();
              calls.push("Tab");
            } else {
              expect(key).toBe(desktopRequire("webdriverio").Key.Enter);
              expect(document.activeElement).toBe(card);
              await act(async () => {
                const event = new KeyboardEvent("keydown", {
                  key: "Enter",
                  bubbles: true,
                  cancelable: true,
                });
                card.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(false);
                card.click();
              });
              calls.push("Enter");
            }
          },
        };
        return action;
      },
    };
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const focusBegin = source.indexOf("  const focus = async");
    const focusEnd = source.indexOf("  const clearOwnedInput = async", focusBegin);
    const filesBegin = source.indexOf('  step("visual-files-open");');
    const filesEnd = source.indexOf('  step("visual-files-panel-visible");', filesBegin);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" +
          source.slice(focusBegin, focusEnd) +
          source.slice(filesBegin, filesEnd) +
          "}\nrun",
      ),
      {
        card: '[data-testid="thread-card-button-owned-card"]',
        step: () => {},
        click: async () => {
          expect(clickable(card)).toBe(true);
        },
        input: {
          verifyManaged: async () => {
            expect(navigation).toHaveBeenCalledOnce();
            calls.push("identity");
          },
        },
        owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
        browser: {
          $$: () => ({
            length: Promise.resolve(
              container.querySelectorAll('[data-testid="thread-card-button-owned-card"]').length,
            ),
          }),
          $: () => ({
            isFocused: async () => document.activeElement === card,
            waitForDisplayed: async () => {},
            waitForEnabled: async () => {},
          }),
          keys: (key: string) => sdkKeys.call(keyPort, key),
        },
      },
    ) as () => Promise<void>;
    await run();
    expect(calls).toEqual(["Tab", "Enter", "identity"]);
    expect(markRead).toHaveBeenCalledExactlyOnceWith("owned-card");
    expect(navigation).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "owned-card" },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it.each(["ready", "missing", "duplicate", "focus", "displayed", "enabled", "enter", "identity"])(
  "preserves card keyboard admission and the original failure before Files: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const focusBegin = source.indexOf("  const focus = async");
    const focusEnd = source.indexOf("  const clearOwnedInput = async", focusBegin);
    const filesBegin = source.indexOf('  step("visual-files-open");');
    const filesEnd = source.indexOf('  step("visual-files-panel-visible");', filesBegin);
    const calls: string[] = [],
      phases: string[] = [];
    let focused = false;
    const original = new Error("Inert original card admission failure.");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" +
          source.slice(focusBegin, focusEnd) +
          source.slice(filesBegin, filesEnd) +
          "}\nrun",
      ),
      {
        Error,
        card: "owned-card",
        step: (phase: string) => phases.push(phase),
        click: async () => {
          throw new Error("Unexpected center click.");
        },
        input: {
          verifyManaged: async () => {
            calls.push("identity");
            if (mode === "identity") throw original;
          },
        },
        owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
        browser: {
          $$: () => ({
            length: Promise.resolve(mode === "missing" ? 0 : mode === "duplicate" ? 2 : 1),
          }),
          $: () => ({
            isFocused: async () => {
              if (mode === "focus") throw original;
              return focused;
            },
            waitForDisplayed: async () => {
              calls.push("displayed");
              if (mode === "displayed") throw original;
            },
            waitForEnabled: async () => {
              calls.push("enabled");
              if (mode === "enabled") throw original;
            },
          }),
          keys: async (key: string) => {
            calls.push(key);
            if (key === "Tab") focused = true;
            else {
              expect(key).toBe("Enter");
              if (mode === "enter") throw original;
            }
          },
        },
      },
    ) as () => Promise<void>;
    if (mode === "ready") {
      await run();
      expect(calls).toEqual(["Tab", "displayed", "enabled", "Enter", "identity"]);
      expect(phases).toEqual([
        "visual-files-open",
        "visual-files-card-focus",
        "visual-files-card-enter",
        "visual-files-managed-identity",
      ]);
    } else {
      const failure = await run().catch((error: unknown) => error);
      if (mode === "missing" || mode === "duplicate") {
        expect(failure).toBeInstanceOf(Error);
        expect(calls).toEqual([]);
      } else expect(failure).toBe(original);
      expect(phases.at(-1)).toBe(
        mode === "identity"
          ? "visual-files-managed-identity"
          : mode === "enter"
            ? "visual-files-card-enter"
            : "visual-files-card-focus",
      );
      if (mode !== "identity") expect(calls).not.toContain("identity");
      if (mode !== "identity" && mode !== "enter") expect(calls).not.toContain("Enter");
    }
    expect(JSON.stringify(phases)).not.toMatch(/owned-card|data-|aria-|private/);
  },
);

it("awaits the actual keep-mounted BaseUI popup close before the next Files card interaction", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("BASE_UI_ANIMATIONS_DISABLED", false);
  const frames = new Map<number, FrameRequestCallback>();
  let ordinal = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++ordinal, callback);
    return ordinal;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flushFrames = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(0);
  };
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animationDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getAnimations",
  );
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value(this: HTMLElement) {
      return this.matches('[data-slot="popover-popup"][data-ending-style]') ? [{ finished }] : [];
    },
  });
  const webRequire = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement } = webRequire("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  };
  const { createRoot } = webRequire("react-dom/client") as {
    createRoot: (container: Element) => { render: (node: unknown) => void; unmount: () => void };
  };
  const popoverModule = "../../../web/src/components/ui/popover.tsx";
  const { Popover, PopoverTrigger, PopoverPopup } = await import(popoverModule);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  let closeCompleted = false;
  try {
    await act(async () =>
      root.render(
        createElement(
          Popover,
          {
            defaultOpen: true,
            onOpenChangeComplete: (open: boolean) => {
              if (!open) closeCompleted = true;
            },
          },
          createElement(PopoverTrigger, null, "Choose branch"),
          createElement(
            PopoverPopup,
            null,
            createElement(
              "div",
              { "aria-label": "Branches" },
              createElement("button", null, "visual-held"),
            ),
          ),
        ),
      ),
    );
    await act(async () => {
      for (let pass = 0; pass < 4; pass++) {
        flushFrames();
        await Promise.resolve();
      }
    });
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
    const positioner = popup.closest<HTMLElement>('[data-slot="popover-positioner"]')!;
    expect(positioner.hidden).toBe(false);
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const start = source.indexOf('  await capture("git-branch-menu");');
    const end = source.indexOf("  await input.verifyManaged();", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" + source.slice(start, end) + "}\nrun",
      ),
      {
        card: "owned-card",
        capture: async () => {
          calls.push("capture");
          expect(positioner.hidden).toBe(false);
        },
        step: () => {},
        focus: async (selector: string) => {
          expect(selector).toBe("owned-card");
          expect(closeCompleted).toBe(true);
          expect(positioner.hidden).toBe(true);
          calls.push("focus");
        },
        browser: {
          keys: async (key: string) => {
            if (key === "Enter") {
              expect(closeCompleted).toBe(true);
              expect(positioner.hidden).toBe(true);
              calls.push("Enter");
              return;
            }
            expect(key).toBe("Escape");
            calls.push("Escape");
            await act(async () => {
              popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              flushFrames();
              await Promise.resolve();
            });
            expect(popup.hasAttribute("data-ending-style")).toBe(true);
            expect(positioner.hidden).toBe(false);
            // BaseUI makes the ending positioner inert; this seam proves missing
            // completion admission, not that animation alone intercepted native clicks.
            expect(positioner.style.pointerEvents).toBe("none");
            expect(closeCompleted).toBe(false);
          },
          $: (selector: string) => ({
            waitForDisplayed: async (options: { reverse?: boolean }) => {
              expect(selector).toBe(
                '//*[@data-slot="popover-popup" and .//*[@aria-label="Branches"] and not(ancestor::*[@hidden])]',
              );
              expect(options).toEqual({ reverse: true });
              calls.push("close-proof");
              await act(async () => {
                flushFrames();
                await Promise.resolve();
                finish();
                await finished;
                await Promise.resolve();
              });
              expect(positioner.hidden).toBe(true);
              expect(closeCompleted).toBe(true);
            },
          }),
        },
      },
    ) as () => Promise<void>;
    await run();
    expect(calls).toEqual(["capture", "Escape", "close-proof", "focus", "Enter"]);
  } finally {
    finish();
    await act(async () => root.unmount());
    container.remove();
    if (animationDescriptor)
      Object.defineProperty(HTMLElement.prototype, "getAnimations", animationDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    vi.unstubAllGlobals();
  }
});

it.each(["escape", "hidden"])(
  "propagates the original branch-close %s failure before Files interaction",
  async (stage) => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const start = source.indexOf('  await capture("git-branch-menu");');
    const end = source.indexOf("  await input.verifyManaged();", start);
    const calls: string[] = [];
    const phases: string[] = [];
    const original = new Error("Inert original branch-close failure.");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" + source.slice(start, end) + "}\nrun",
      ),
      {
        card: "owned-card",
        capture: async () => calls.push("capture"),
        click: async () => calls.push("card"),
        step: (phase: string) => phases.push(phase),
        browser: {
          keys: async () => {
            calls.push("Escape");
            if (stage === "escape") throw original;
          },
          $: () => ({
            waitForDisplayed: async (options: { reverse?: boolean }) => {
              expect(options).toEqual({ reverse: true });
              calls.push("close-proof");
              throw original;
            },
          }),
        },
      },
    ) as () => Promise<void>;
    await expect(run()).rejects.toBe(original);
    expect(calls).toEqual(
      stage === "escape" ? ["capture", "Escape"] : ["capture", "Escape", "close-proof"],
    );
    expect(phases.at(-1)).toBe(`visual-branches-close-${stage}`);
  },
);

it.each([
  "right-panel",
  "open",
  "collapse",
  "tree-src",
  "tree-nested",
  "tree-file",
  "line",
  "comment",
])(
  "attributes only the existing Files click await and preserves its original error: %s",
  async (target) => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const clickStart = source.indexOf("  const click = async");
    const clickEnd = source.indexOf("  const focus = async", clickStart);
    const start = source.indexOf('  step("visual-files-open");');
    const end = source.indexOf('  await capture("files-editor-comment");', start);
    expect(clickStart).toBeGreaterThan(0);
    expect(clickEnd).toBeGreaterThan(clickStart);
    expect(end).toBeGreaterThan(start);
    const phases: string[] = [];
    const actions: string[] = [];
    const original = new Error("Inert original Files click failure.");
    const element = (control: string) => ({
      waitForDisplayed: async () => actions.push("display:" + control),
      waitForEnabled: async () => actions.push("enabled:" + control),
      isDisplayed: async () => target !== "right-panel",
      setValue: async () => actions.push("draft"),
      click: async () => {
        actions.push("click:" + control);
        if (control === target) throw original;
      },
      shadow$: (selector: string) =>
        element(
          selector.includes("data-gutter")
            ? "line"
            : selector.includes('"src/"')
              ? "tree-src"
              : selector.includes('"src/nested/"')
                ? "tree-nested"
                : "tree-file",
        ),
    });
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" +
          source.slice(clickStart, clickEnd) +
          source.slice(start, end) +
          "}\nrun",
      ),
      {
        card: "owned-card",
        focus: async () => actions.push("focus"),
        step: (phase: string) => phases.push(phase),
        input: { verifyManaged: async () => actions.push("identity") },
        observePartialAwait: () => {
          throw new Error("Unexpected partial-stage observer.");
        },
        browser: {
          keys: async (key: string) => {
            expect(key).toBe("Enter");
            actions.push("Enter");
          },
          $: (selector: string) =>
            element(
              selector === "owned-card"
                ? "card"
                : selector.includes("Toggle right panel")
                  ? "right-panel"
                  : selector.includes('normalize-space()="Files"')
                    ? "open"
                    : selector.includes("Collapse all folders")
                      ? "collapse"
                      : selector.includes('normalize-space()="Comment"')
                        ? "comment"
                        : "tree",
            ),
        },
      },
    ) as () => Promise<void>;
    await expect(run()).rejects.toBe(original);
    expect(phases.at(-1)).toBe(`visual-files-${target}-click`);
    expect(actions.at(-1)).toBe("click:" + target);
    expect(JSON.stringify(phases)).not.toMatch(/owned-card|data-|aria-|src\/|private/);
  },
);

function png() {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(NodeZlib.crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const data = Buffer.alloc((1280 * 3 + 1) * 960);
  for (let y = 0; y < 960; y++) {
    data.fill(y % 256, y * 3841 + 1, (y + 1) * 3841);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(data)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const proof = {
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
};
const branchFailureProof = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
  currentBranch: false,
  remoteBranch: true,
  occupiedBranch: true,
  renameDeleteControls: true,
};
const captureOwnership = {
  source: "a".repeat(40),
  scene: "git-branch-menu",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
} as const;
const managedOwnership = {
  theme: captureOwnership.theme,
  origin: captureOwnership.origin,
  threadId: captureOwnership.threadId,
  branch: captureOwnership.branch,
};
const currentOwnership = {
  ...captureOwnership,
  phase: "visual-git-branch-menu",
};
function projectBranchFailure(value: unknown) {
  return Reflect.get(CoreCapture, "projectCoreBranchCaptureFailureWitness")?.(value) ?? null;
}
function createBranchFailureObserver(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  ownership: unknown = captureOwnership,
  managed: unknown = managedOwnership,
) {
  return (
    Reflect.get(CoreCapture, "createCoreBranchCaptureFailureObserver")?.(
      records,
      ownership,
      managed,
    ) ?? (() => {})
  );
}
function readBranchFailure(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  error: unknown,
  current: unknown = currentOwnership,
) {
  return (
    Reflect.get(CoreCapture, "readCoreBranchCaptureFailureFacts")?.(records, error, current) ?? null
  );
}
function boundary() {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-evidence-test-"));
  const bytes = png();
  const browser = {
    isAlertOpen: vi.fn(async () => false),
    execute: vi.fn(async (read: unknown): Promise<Record<string, boolean>> => {
      expect(read).toBe(readVisualWitness);
      return proof;
    }),
    takeScreenshot: vi.fn(async () => bytes.toString("base64")),
  };
  const input = {
    scene: "command-palette",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    evidence,
    browser,
    captured: new Set<string>(),
    owner: {
      until: async (read: () => Promise<boolean>) => {
        if (!(await read())) throw new Error("Owned observation timeout.");
      },
    },
  } as unknown as VisualCaptureInput;
  return {
    input,
    browser,
    bytes,
    close: () => NodeFS.rmSync(evidence, { recursive: true, force: true }),
  };
}
describe("original visual capture boundary", () => {
  it("retains the actual post-screenshot refusal without a third witness read or a PNG", async () => {
    const f = boundary();
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const admitted = { ...branchFailureProof, expectedTextMatched: true, currentBranch: true };
    const refused = { ...admitted, targetInView: false };
    const observe = vi.fn(createBranchFailureObserver(records));
    Object.assign(f.input, { scene: "git-branch-menu", observeFailure: observe });
    f.browser.execute.mockResolvedValueOnce(admitted).mockResolvedValueOnce(refused);
    try {
      const failure = await captureVisualScene(f.input).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(observe).toHaveBeenCalledWith(failure, refused);
      expect(readBranchFailure(records, failure)).toEqual({
        scene: "git-branch-menu",
        theme: "light",
        witness: refused,
      });
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      expect(f.browser.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(f.input.captured.size).toBe(0);
      expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
    } finally {
      f.close();
    }
  });
  it("reports the last existing branch witness only after the original capture fails", async () => {
    const f = boundary();
    const original = new Error("Inert original observation timeout.");
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const last = { ...branchFailureProof, currentBranch: true, remoteBranch: false };
    Object.assign(f.input, {
      scene: "git-branch-menu",
      observeFailure: createBranchFailureObserver(records),
    });
    f.browser.execute.mockResolvedValueOnce(branchFailureProof).mockResolvedValueOnce(last);
    f.input.owner.until = async (read) => {
      expect(await read()).toBe(false);
      expect(readBranchFailure(records, original)).toBeNull();
      expect(await read()).toBe(false);
      throw original;
    };
    try {
      await expect(captureVisualScene(f.input)).rejects.toBe(original);
      expect(readBranchFailure(records, original)).toEqual({
        scene: "git-branch-menu",
        theme: "light",
        witness: last,
      });
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
      expect(readBranchFailure(records, new Error(original.message))).toBeNull();
    } finally {
      f.close();
    }
  });
  it.each(["before-read", "unsafe-latest", "observer-fault"])(
    "preserves the original capture failure with unavailable diagnostics: %s",
    async (mode) => {
      const f = boundary();
      const original = new Error("Inert original capture failure.");
      const observed = vi.fn(() => {
        if (mode === "observer-fault") throw new Error("Inert observer fault.");
      });
      Object.assign(f.input, { scene: "git-branch-menu", observeFailure: observed });
      if (mode === "before-read") f.browser.isAlertOpen.mockRejectedValue(original);
      else {
        f.browser.execute.mockResolvedValue(
          mode === "unsafe-latest"
            ? { ...branchFailureProof, credentialAbsent: false }
            : branchFailureProof,
        );
        f.input.owner.until = async (read) => {
          expect(await read()).toBe(false);
          throw original;
        };
      }
      try {
        await expect(captureVisualScene(f.input)).rejects.toBe(original);
        expect(observed).toHaveBeenCalledWith(
          original,
          mode === "observer-fault" ? branchFailureProof : null,
        );
        expect(f.browser.execute).toHaveBeenCalledTimes(mode === "before-read" ? 0 : 1);
        expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
  it("writes original bytes only after both read-only witnesses pass and refuses a duplicate", async () => {
    const f = boundary();
    try {
      const capture = await captureVisualScene(f.input);
      expect(capture).toMatchObject({
        scene: "command-palette",
        theme: "light",
        file: "command-palette-light.png",
        width: 1280,
        height: 960,
        nonBlank: true,
        witness: proof,
      });
      expect(
        NodeFS.readFileSync(NodePath.join(f.input.evidence, "command-palette-light.png")),
      ).toEqual(f.bytes);
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      await expect(captureVisualScene(f.input)).rejects.toThrow();
      expect(f.browser.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(capture)).not.toMatch(/owned|4885|delivery-retry/);
    } finally {
      f.close();
    }
  });
  it.each(["invalid-scene", "alert", "before", "after", "driver"])(
    "retains no PNG after %s failure",
    async (failure) => {
      const f = boundary();
      try {
        if (failure === "invalid-scene") f.input.scene = "native-share-refresh" as never;
        if (failure === "alert") f.browser.isAlertOpen.mockResolvedValue(true);
        if (failure === "before")
          f.browser.execute.mockResolvedValue({ ...proof, credentialAbsent: false });
        if (failure === "after")
          f.browser.execute
            .mockResolvedValueOnce(proof)
            .mockResolvedValue({ ...proof, selectedMatched: false });
        if (failure === "driver")
          f.browser.takeScreenshot.mockRejectedValue(new Error("private-token"));
        await expect(captureVisualScene(f.input)).rejects.toThrow();
        expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
        expect(f.input.captured.size).toBe(0);
        if (["invalid-scene", "alert", "before"].includes(failure))
          expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
});

describe("closed core branch capture failure facts", () => {
  it("snapshots only safe data and deletes prior facts when the same error receives an unsafe witness", () => {
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const error = new Error("Inert capture failure.");
    const observe = createBranchFailureObserver(records);
    const value = { ...branchFailureProof };
    observe(error, value);
    value.currentBranch = true;
    expect(readBranchFailure(records, error)?.witness.currentBranch).toBe(false);
    observe(error, { ...value, credentialAbsent: false });
    expect(readBranchFailure(records, error)).toBeNull();
  });
  it("refuses ownership and record accessors without invoking them, and tolerates reflection faults", () => {
    let reads = 0;
    const accessor = (value: object, key: string) => {
      Object.defineProperty(value, key, {
        enumerable: true,
        get() {
          reads++;
          return "private";
        },
      });
      return value;
    };
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const error = new Error("Inert capture failure.");
    createBranchFailureObserver(records, accessor({ ...captureOwnership }, "source"))(
      error,
      branchFailureProof,
    );
    createBranchFailureObserver(
      records,
      captureOwnership,
      accessor({ ...managedOwnership }, "threadId"),
    )(error, branchFailureProof);
    expect(
      readBranchFailure(records, error, accessor({ ...currentOwnership }, "source")),
    ).toBeNull();
    WeakMap.prototype.set.call(
      records,
      error,
      accessor({ ownership: captureOwnership, witness: branchFailureProof }, "witness"),
    );
    expect(readBranchFailure(records, error)).toBeNull();
    const fault = vi.spyOn(Reflect, "ownKeys").mockImplementation(() => {
      throw new Error("Inert reflection fault.");
    });
    try {
      expect(projectBranchFailure(branchFailureProof)).toBeNull();
    } finally {
      fault.mockRestore();
    }
    expect(reads).toBe(0);
  });
  it.each(["error", "records", "stored-record"])(
    "refuses native proxies on the %s association boundary before a trap",
    (boundary) => {
      let traps = 0;
      const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
      const error = new Error("Inert capture failure.");
      const revoked = <T extends object>(value: T) => {
        const proxy = Proxy.revocable(value, {
          get() {
            traps++;
            throw new Error("Inert proxy access.");
          },
          ownKeys() {
            traps++;
            throw new Error("Inert reflection access.");
          },
        });
        proxy.revoke();
        return proxy.proxy;
      };
      const observedError = boundary === "error" ? revoked(error) : error;
      const observedRecords = boundary === "records" ? revoked(records) : records;
      if (boundary === "stored-record")
        records.set(error, revoked({ ownership: captureOwnership, witness: branchFailureProof }));
      else createBranchFailureObserver(observedRecords)(observedError, branchFailureProof);
      expect(readBranchFailure(observedRecords, observedError)).toBeNull();
      expect(traps).toBe(0);
    },
  );
  it("retains a frozen complete boolean witness with failed scene facts", () => {
    const result = projectBranchFailure(branchFailureProof);
    expect(result).toEqual(branchFailureProof);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    "missing",
    "extra",
    "symbol",
    "getter",
    "inherited",
    "hidden",
    "non-boolean",
    "credential",
    "theme",
    "selection",
    "boot",
  ])("refuses unsafe or malformed own fields without reading accessors: %s", (mode) => {
    let value: object = { ...branchFailureProof };
    let reads = 0;
    if (mode === "missing") Reflect.deleteProperty(value, "remoteBranch");
    if (mode === "extra") Object.assign(value, { private: "inert secret" });
    if (mode === "symbol") Object.assign(value, { [Symbol("private")]: true });
    if (mode === "getter")
      Object.defineProperty(value, "remoteBranch", {
        enumerable: true,
        get() {
          reads++;
          return true;
        },
      });
    if (mode === "inherited") {
      value = Object.create(branchFailureProof);
    }
    if (mode === "hidden")
      Object.defineProperty(value, "remoteBranch", { enumerable: false, value: true });
    if (mode === "non-boolean") Object.assign(value, { remoteBranch: "private" });
    for (const [failure, key] of [
      ["credential", "credentialAbsent"],
      ["theme", "themeMatched"],
      ["selection", "selectedMatched"],
      ["boot", "bootShellAbsent"],
    ])
      if (mode === failure) Object.assign(value, { [key!]: false });
    expect(projectBranchFailure(value)).toBeNull();
    expect(reads).toBe(0);
  });
  it.each(["live", "spoofing", "throwing", "revoked"])(
    "rejects native witness and ownership proxies before every trap: %s",
    (mode) => {
      let traps = 0;
      const wrap = (value: object) => {
        const proxy = Proxy.revocable(value, {
          get(target, key, receiver) {
            traps++;
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            traps++;
            if (mode === "throwing") throw new Error("Inert reflection fault.");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            traps++;
            return mode === "spoofing"
              ? { enumerable: true, configurable: true, value: true }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        if (mode === "revoked") proxy.revoke();
        return proxy.proxy;
      };
      const error = new Error("Inert capture failure.");
      const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
      expect(projectBranchFailure(wrap(branchFailureProof))).toBeNull();
      createBranchFailureObserver(records, wrap(captureOwnership))(error, branchFailureProof);
      createBranchFailureObserver(
        records,
        captureOwnership,
        wrap(managedOwnership),
      )(error, branchFailureProof);
      expect(readBranchFailure(records, error, wrap(currentOwnership))).toBeNull();
      expect(readBranchFailure(records, error)).toBeNull();
      expect(traps).toBe(0);
    },
  );
  it("joins the original capture error to current private source, managed identity, scene and theme", () => {
    const error = new Error("Inert capture failure.");
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    createBranchFailureObserver(records)(error, branchFailureProof);
    expect(readBranchFailure(records, error)).toEqual({
      scene: "git-branch-menu",
      theme: "light",
      witness: branchFailureProof,
    });
    for (const patch of [
      { source: "b".repeat(40) },
      { threadId: "other" },
      { branch: "codex/delivery-retry-dark", theme: "dark" },
      { scene: "git-history-stashes" },
      { phase: "visual-git-history-stashes" },
      { origin: "http://inert.invalid" },
    ])
      expect(readBranchFailure(records, error, { ...currentOwnership, ...patch })).toBeNull();
    const records2 = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    createBranchFailureObserver(records2, captureOwnership, {
      ...managedOwnership,
      threadId: "other",
    })(error, branchFailureProof);
    expect(readBranchFailure(records2, error)).toBeNull();
    expect(JSON.stringify(readBranchFailure(records, error))).not.toMatch(
      /owned|delivery-retry|4885|aaaa|private/,
    );
  });
});

import { runVisualCore, type VisualCoreInput } from "./release-visual-core.ts";
it.each([
  "ok",
  "start-reject",
  "start-unadmitted",
  "finish-reject",
  "clear-reject",
  "callback-reject",
  "clear-and-callback-reject",
])(
  "observes the public keyboard clear before typing the ref without replacing its failure: %s",
  async (mode) => {
    const order: string[] = [];
    let admission: string | undefined;
    const snapshots: unknown[] = [];
    const stopped = new Error("Inert capture stop.");
    const clearFailure = new Error("Inert original clear failure.");
    const callbackFailure = new Error("Inert unavailable observation callback.");
    const clearRejected = mode === "clear-reject" || mode === "clear-and-callback-reject";
    const snapshot = {
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
    const input = {
      browser: {
        $$: () => ({ length: Promise.resolve(1) }),
        $: (selector: string) => ({
          elementId: "owned-name",
          isFocused: async () => true,
          waitForDisplayed: async () => {},
          waitForEnabled: async () => {},
          click: async () => {},
          setValue: async (value: string) => {
            expect(selector).not.toContain('placeholder="Worktree name"');
            expect(value).toBe("visual-held");
            order.push("type-exact-ref");
          },
        }),
        keys: async (value: string | string[]) => {
          if (Array.isArray(value) && value[0] === "Control") {
            expect(value).toEqual(["Control", "a"]);
            order.push("select-owned-name");
          } else if (value === "Backspace") {
            order.push("delete-owned-name");
            if (clearRejected) throw clearFailure;
          }
        },
        execute: async (
          read: unknown,
          value: { operation: string; admission: string; admitted?: boolean },
        ) => {
          expect(read).toBe(observeVisualNameClear);
          expect(value).toMatchObject({
            origin: "http://127.0.0.1:4885",
            threadId: "owned",
            operation: value.operation,
          });
          expect(value.admission).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          if (value.operation === "start") {
            admission = value.admission;
            expect(value).not.toHaveProperty("admitted");
          } else {
            expect(value.admission).toBe(admission);
            expect(value.admitted).toBe(true);
          }
          order.push(value.operation + "-observer");
          if (
            (mode === "start-reject" && value.operation === "start") ||
            (mode === "finish-reject" && value.operation === "finish")
          )
            throw new Error("Inert unavailable observation.");
          return value.operation === "start" ? mode !== "start-unadmitted" : snapshot;
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {},
      openWorktreeDialog: async () => {},
      recordClearObservation: (value: unknown) => {
        snapshots.push(value);
        order.push("record-closed-observation");
        if (mode === "callback-reject" || mode === "clear-and-callback-reject")
          throw callbackFailure;
      },
      capture: async (scene: string) => {
        if (scene === "worktree-create-ref") throw stopped;
      },
    } as unknown as VisualCoreInput;
    await expect(runVisualCore(input)).rejects.toBe(clearRejected ? clearFailure : stopped);
    expect(snapshots).toEqual([
      mode === "start-reject" || mode === "start-unadmitted" || mode === "finish-reject"
        ? null
        : snapshot,
    ]);
    expect(order).toEqual([
      "start-observer",
      "select-owned-name",
      "delete-owned-name",
      ...(mode === "start-reject" || mode === "start-unadmitted" ? [] : ["finish-observer"]),
      "record-closed-observation",
      ...(clearRejected ? [] : ["type-exact-ref"]),
    ]);
  },
);
it.each(["missing", "duplicate", "focus-lost", "replacement"])(
  "refuses keyboard deletion when the exact owned name proof fails: %s",
  async (mode) => {
    let focused = true;
    const gestures: unknown[] = [];
    const captures: string[] = [];
    const sourceInput = vi.fn(async () => {});
    const name = {
      elementId: "owned-name",
      isFocused: async () => focused,
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
    };
    const input = {
      browser: {
        $$: (selector: string) => ({
          length: Promise.resolve(
            selector.includes('placeholder="Worktree name"')
              ? mode === "missing"
                ? 0
                : mode === "duplicate"
                  ? 2
                  : 1
              : 1,
          ),
        }),
        $: (selector: string) =>
          selector.includes('placeholder="Worktree name"')
            ? name
            : {
                isFocused: async () => true,
                waitForDisplayed: async () => {},
                waitForEnabled: async () => {},
                click: async () => {},
                setValue: sourceInput,
              },
        keys: async (value: string | string[]) => {
          if (Array.isArray(value) && value[0] === "Control") {
            gestures.push(value);
            if (mode === "focus-lost") focused = false;
            if (mode === "replacement") name.elementId = "replacement";
          } else if (value === "Backspace") gestures.push(value);
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {},
      openWorktreeDialog: async () => {},
      capture: async (scene: string) => {
        captures.push(scene);
      },
    } as unknown as VisualCoreInput;
    await expect(runVisualCore(input)).rejects.toThrow("Visual public control refused.");
    expect(gestures).toEqual(mode === "missing" || mode === "duplicate" ? [] : [["Control", "a"]]);
    expect(sourceInput).not.toHaveBeenCalled();
    expect(captures).toEqual(["workspace-composite", "workspace-card-menu"]);
  },
);
it.each([
  "ready",
  "stale",
  "stale-after-focus",
  "missing",
  "duplicate",
  "missing-id",
  "replacement",
  "focus-lost",
  "read-failed",
])(
  "admits occupied branch focus only after public current-ref readiness and preserves identity: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "release-visual-core.ts"),
      "utf8",
    );
    const begin = source.indexOf("  const focus = async");
    const end = source.indexOf("\n  const composer =", begin);
    const branchBegin = source.indexOf(
      "  await clearOwnedInput('input[aria-label=\"Filter branches\"]');",
    );
    const branchEnd = source.indexOf('  await capture("git-branch-menu");', branchBegin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(branchBegin).toBeGreaterThan(end);
    expect(branchEnd).toBeGreaterThan(branchBegin);
    const held = '//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-held"]]';
    const calls: string[] = [];
    let focused = 'input[aria-label="Filter branches"]';
    let readyReads = 0;
    let ownedId = mode === "missing-id" ? undefined : "owned-held";
    const original = new Error("Inert original current-ref read failure.");
    const element = {
      get elementId() {
        return Promise.resolve(ownedId);
      },
      isFocused: async () => focused === held,
      waitForDisplayed: async () => {
        if (mode === "replacement") ownedId = "replacement";
        if (mode === "focus-lost") focused = "other";
      },
      waitForEnabled: async () => {},
      moveTo: async () => calls.push("hover"),
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" +
          source.slice(begin, end) +
          source.slice(branchBegin, branchEnd + '  await capture("git-branch-menu");'.length) +
          "}\nrun",
      ),
      {
        Error,
        browser: {
          $$: (selector: string) => ({
            length: Promise.resolve(
              selector === held ? (mode === "missing" ? 0 : mode === "duplicate" ? 2 : 1) : 1,
            ),
          }),
          $: (selector: string) =>
            selector === held
              ? element
              : selector.includes("Current branch")
                ? {
                    isDisplayed: async () => {
                      readyReads++;
                      if (mode === "read-failed") throw original;
                      return (
                        mode !== "stale" &&
                        readyReads >= 2 &&
                        (mode !== "stale-after-focus" || readyReads === 2)
                      );
                    },
                  }
                : {
                    elementId: "owned-filter",
                    isFocused: async () => focused === selector,
                    waitForDisplayed: async () => {},
                    waitForEnabled: async () => {},
                  },
          keys: async (keys: string | string[]) => {
            if (keys === "Tab") {
              expect(readyReads).toBeGreaterThanOrEqual(2);
              calls.push("Tab");
              focused = held;
            } else calls.push(JSON.stringify(keys));
          },
        },
        owner: {
          until: async (proof: () => Promise<boolean>) => {
            for (let pass = 0; pass < 4; pass++) if (await proof()) return;
            throw new Error("Inert public readiness timed out.");
          },
        },
        capture: async () => calls.push("capture"),
      },
    ) as () => Promise<void>;
    if (mode === "ready") {
      await run();
      expect(readyReads).toBe(3);
      expect(calls).toEqual(['["Control","a"]', '"Backspace"', "Tab", "hover", "capture"]);
    } else {
      const failure = await run().catch((error: unknown) => error);
      if (mode === "read-failed") expect(failure).toBe(original);
      else expect(failure).toBeInstanceOf(Error);
      expect(calls).not.toContain("hover");
      expect(calls).not.toContain("capture");
      if (["missing", "duplicate", "missing-id", "stale", "read-failed"].includes(mode))
        expect(calls).not.toContain("Tab");
    }
  },
);
it("checks the shared managed-worktree identity before the first exact scene and propagates capture failure", async () => {
  const order: string[] = [];
  const stopped = new Error("fixture capture stopped");
  const input = {
    browser: {},
    owner: {},
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    step: (phase: string) => order.push(phase),
    verifyManaged: async () => {
      order.push("verified-managed");
    },
    capture: async (scene: string) => {
      order.push(scene);
      throw stopped;
    },
  } as unknown as VisualCoreInput;
  await expect(runVisualCore(input)).rejects.toBe(stopped);
  expect(order).toEqual(["verified-managed", "visual-workspace-composite", "workspace-composite"]);
});
it.each([true, false])(
  "runs only the eight fixed scenes and requires the supported image proof: loaded=%s",
  async (imageLoaded) => {
    const calls: string[] = [],
      captures: string[] = [];
    const element = (selector: string): object => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      elementId: "owned-element",
      isFocused: async () => true,
      isDisplayed: async () => selector !== "[data-right-panel-tabbar]",
      click: async () => {
        calls.push(`click:${selector}`);
      },
      setValue: async (value: string) => {
        calls.push(`input:${selector}:${value}`);
      },
      moveTo: async () => {
        calls.push(`hover:${selector}`);
      },
      scrollIntoView: async () => {
        calls.push(`scroll:${selector}`);
      },
      getText: async () => "Owned visual review draft",
      shadow$: (next: string) => element(selector + " >> " + next),
    });
    const input = {
      browser: {
        $: element,
        $$: () => ({ length: Promise.resolve(1) }),
        keys: async (key: unknown) => {
          calls.push(`key:${JSON.stringify(key)}`);
        },
        execute: async (read: { name: string }) => {
          if (read.name === "readVisualWorkingImageSelected") {
            calls.push("read-working-image-binary");
            return true;
          }
          if (read.name === "readVisualImageLoaded") {
            calls.push("read-supported-commit-image");
            return imageLoaded;
          }
          return { x: 0, y: 0 };
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          if (!(await read())) throw new Error("Inert required image load did not arrive.");
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {
        calls.push("verify-managed");
      },
      openWorktreeDialog: async () => {
        calls.push("shared-worktree-opener");
      },
      partialStageMatches: () => {
        calls.push("read-actual-partial-stage");
        return true;
      },
      capture: async (scene: string) => {
        calls.push(`capture:${scene}`);
        captures.push(scene);
      },
    } as unknown as VisualCoreInput;
    if (!imageLoaded) {
      await expect(runVisualCore(input)).rejects.toThrow(
        "Inert required image load did not arrive.",
      );
      expect(captures).toEqual([
        "workspace-composite",
        "workspace-card-menu",
        "worktree-create-ref",
      ]);
      expect(calls).toContain("read-working-image-binary");
      expect(calls).toContain(
        'click:[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]',
      );
      expect(calls).not.toContain("read-actual-partial-stage");
      return;
    }
    const result = await runVisualCore(input);
    expect(captures).toEqual([
      "workspace-composite",
      "workspace-card-menu",
      "worktree-create-ref",
      "git-changes-diff",
      "git-history-stashes",
      "git-branch-menu",
      "files-editor-comment",
      "command-palette",
    ]);
    expect(calls.filter((call) => call === "shared-worktree-opener")).toHaveLength(1);
    expect(calls).not.toContain(
      'input:[data-slot="dialog-popup"][role="dialog"] input[placeholder="Worktree name"]:',
    );
    expect(calls).toContain('key:["Control","a"]');
    expect(calls).toContain('key:"Backspace"');
    expect(calls.indexOf('key:["Control","a"]')).toBeLessThan(calls.indexOf('key:"Backspace"'));
    expect(calls.indexOf('key:"Backspace"')).toBeLessThan(
      calls.indexOf("capture:worktree-create-ref"),
    );
    expect(calls).not.toContain(
      'click://*[@data-slot="dialog-popup"]//button[normalize-space()="visual-held"]',
    );

    expect(calls).toContain('key:["Shift","F10"]');
    const commitImage =
      'click:[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]';
    expect(calls.indexOf("read-working-image-binary")).toBeLessThan(calls.indexOf(commitImage));
    expect(calls.indexOf(commitImage)).toBeLessThan(calls.indexOf("read-supported-commit-image"));
    expect(calls.indexOf("read-supported-commit-image")).toBeLessThan(
      calls.indexOf("read-actual-partial-stage"),
    );
    expect(calls.indexOf("read-actual-partial-stage")).toBeLessThan(
      calls.indexOf("capture:git-changes-diff"),
    );
    expect(calls).toContain('scroll:button[aria-label="Select stash stash@{11}"]');
    expect(result).toEqual({
      managedIdentityMatched: true,
      partialStageVerified: true,
      imageDiffInspected: true,
      dialogCancelled: true,
      draftRetained: true,
      noCommandExecuted: true,
      unpictured: ["git-image-diff", "files-context-menu", "workspace-terminal-and-other-chat"],
    });
  },
);

const partialAwaitCalls = [
  "changes-tab-displayed",
  "changes-tab-enabled",
  "changes-tab-click",
  "text-row-displayed",
  "text-row-enabled",
  "text-row-click",
  "first-run-displayed",
  "first-run-enabled",
  "first-run-click",
  "stage-submit-displayed",
  "stage-submit-enabled",
  "stage-submit-click",
  "index-proof",
  "index-read",
  "staged-area-displayed",
  "staged-area-enabled",
  "staged-area-click",
];

function partialAwaitReplay(failed?: string, observerThrows = false) {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-core.ts"),
    "utf8",
  );
  const start = source.indexOf(
    "  const { browser, owner, step } = input;",
    source.indexOf("export async function runVisualCore"),
  );
  const end = source.indexOf("  const focus = async", start);
  const bodyStart = source.indexOf('  step("visual-partial-stage");', end);
  const bodyEnd = source.indexOf('  await capture("git-changes-diff");', bodyStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  const replay = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function replay(input) {\n" +
        source.slice(start, end) +
        source.slice(bodyStart, bodyEnd) +
        "\n}\nreplay",
    ),
  ) as (input: unknown) => Promise<void>;
  const calls: string[] = [],
    phases: string[] = [];
  const error = new Error("Inert original partial-stage await failure.");
  const action = (operation: string) => {
    calls.push(operation);
    if (operation === failed) throw error;
  };
  const controls: Record<string, string> = {
    '//button[@role="tab" and normalize-space()="Changes"]': "changes-tab",
    '[role="option"][data-path="pierre-step5.ts"]': "text-row",
    'aside[aria-label="Partial staging selection gutter"] button[aria-label="Toggle changed-line run starting at line 1"]':
      "first-run",
    '//aside[@aria-label="Partial staging selection gutter"]//button[normalize-space()="Stage selected lines"]':
      "stage-submit",
    '//section[@aria-label="Diff for pierre-step5.ts"]//button[normalize-space()="Staged"]':
      "staged-area",
  };
  return {
    calls,
    phases,
    error,
    run: () =>
      replay({
        browser: {
          $: (selector: string) => {
            const control = controls[selector];
            expect(control).toBeDefined();
            return {
              waitForDisplayed: async () => action(control + "-displayed"),
              waitForEnabled: async () => action(control + "-enabled"),
              click: async () => action(control + "-click"),
            };
          },
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            action("index-proof");
            expect(await read()).toBe(true);
          },
        },
        partialStageMatches: () => {
          action("index-read");
          return true;
        },
        step: (phase: string) => {
          phases.push(phase);
          if (observerThrows && phase.startsWith("visual-partial-stage-"))
            throw new Error("Inert optional attribution failure.");
        },
      }),
  };
}

describe("partial-stage last-await attribution", () => {
  it.each(partialAwaitCalls)(
    "preserves the original %s failure at its exact existing boundary",
    async (failed) => {
      const replay = partialAwaitReplay(failed, true);
      await expect(replay.run()).rejects.toBe(replay.error);
      expect(replay.calls).toEqual(
        partialAwaitCalls.slice(0, partialAwaitCalls.indexOf(failed) + 1),
      );
      expect(replay.phases.at(-1)).toBe(
        "visual-partial-stage-" + (failed === "index-read" ? "index-proof" : failed),
      );
    },
  );
  it.each([false, true])(
    "keeps original action order and success with throwing attribution=%s",
    async (throws) => {
      const replay = partialAwaitReplay(undefined, throws);
      await expect(replay.run()).resolves.toBeUndefined();
      expect(replay.calls).toEqual(partialAwaitCalls);
      expect(replay.phases[0]).toBe("visual-partial-stage");
      expect(replay.phases.at(-1)).toBe("visual-partial-stage-staged-area-click");
    },
  );
});
