// @vitest-environment jsdom
// DOMPurify, which every drawn diagram goes through, does not run under happy-dom.
import { DEFAULT_CLIENT_SETTINGS } from "@bibcode/contracts/settings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setClientSettingsForTests } from "../hooks/useSettings";
import { writeThemePreference } from "../hooks/useTheme";
import { buildCollapsedProposedPlanPreviewMarkdown } from "../proposedPlan";
import ChatMarkdown from "./ChatMarkdown";
import { ReadingAnchorContext } from "./chat/readingAnchor";
import {
  __resetMermaidDiagramsForTests,
  __setMermaidRendererLoaderForTests,
} from "./markdown/MarkdownMermaidBlock";

type MermaidRenderer = typeof import("./markdown/mermaidRenderer");

const FLOWCHART = "graph TD\n  Write --> Draw";
const SEQUENCE = "sequenceDiagram\n  User->>App: Send";
// Distinct sources whose FNV-1a hashes and lengths collide (#171): a hash-keyed cache would
// show one block the other's diagram.
const COLLIDING = ['flowchart TD\n A["76ab3ce7"]\n', 'flowchart TD\n A["2bb1fad8"]\n'] as const;

interface MountedMarkdown {
  readonly container: HTMLDivElement;
  readonly root: Root;
  render(text: string, options?: { isStreaming?: boolean; className?: string }): Promise<void>;
}

const mounted: MountedMarkdown[] = [];
let rendererLoads = 0;
let renderedSources: string[] = [];

function fence(source: string, marker = "```"): string {
  return `${marker}mermaid\n${source}\n${marker}`;
}

/** The real renderer, counting module loads and diagram renders. */
async function countingRenderer(): Promise<MermaidRenderer> {
  rendererLoads += 1;
  const renderer = await import("./markdown/mermaidRenderer");
  return {
    ...renderer,
    renderMermaidDiagram: (source, fonts, idPrefix) => {
      renderedSources.push(source);
      return renderer.renderMermaidDiagram(source, fonts, idPrefix);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function mount(text?: string, options?: { isStreaming?: boolean }): Promise<MountedMarkdown> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry: MountedMarkdown = {
    container,
    root,
    async render(nextText, renderOptions = {}) {
      await act(async () =>
        root.render(
          <ChatMarkdown
            text={nextText}
            cwd={undefined}
            isStreaming={renderOptions.isStreaming ?? false}
            {...(renderOptions.className ? { className: renderOptions.className } : {})}
          />,
        ),
      );
    },
  };
  mounted.push(entry);
  if (text !== undefined) await entry.render(text, options);
  return entry;
}

async function unmount(entry: MountedMarkdown): Promise<void> {
  await act(async () => entry.root.unmount());
  entry.container.remove();
  mounted.splice(mounted.indexOf(entry), 1);
}

/** Lets pending imports settle and the render queue run, one task at a time. */
async function settle(tasks = 3): Promise<void> {
  for (let task = 0; task < tasks; task += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Runs pending promise callbacks without letting any task, such as a queue run, start. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 30; tick += 1) await Promise.resolve();
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; !condition(); attempt += 1) {
    if (attempt > 400) throw new Error(message);
    await settle(1);
  }
}

const diagrams = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(".chat-markdown-mermaid"),
];
const hasDiagram = (container: HTMLElement) => diagrams(container).length > 0;
const errorText = (container: HTMLElement) =>
  container.querySelector(".chat-markdown-mermaid-error")?.textContent ?? null;
const viewToggle = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show source"], button[aria-label="Show diagram"]',
  );

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

beforeEach(() => {
  __resetMermaidDiagramsForTests();
  __setMermaidRendererLoaderForTests(countingRenderer);
  rendererLoads = 0;
  renderedSources = [];
  writeThemePreference("light");
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  __setMermaidRendererLoaderForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.restoreAllMocks();
});

describe("Mermaid diagrams in chat Markdown", () => {
  describe("drawing", () => {
    it("draws nothing, and loads no renderer, until the fence closes", async () => {
      const stream = await mount(`Intro\n\n\`\`\`mermaid\n${FLOWCHART}\n`, { isStreaming: true });
      await stream.render(`Intro\n\n${fence(FLOWCHART)}`, { isStreaming: true });
      await settle();
      expect(hasDiagram(stream.container)).toBe(false);
      expect(rendererLoads).toBe(0);
      expect(stream.container.querySelector("pre")?.textContent).toContain("Write --> Draw");

      await stream.render(`Intro\n\n${fence(FLOWCHART)}\n`, { isStreaming: true });
      await waitFor(() => hasDiagram(stream.container), "the closed fence never drew");
      const svg = diagrams(stream.container)[0]?.querySelector("svg");
      expect(svg?.getAttribute("aria-roledescription")).toBe("flowchart");
      expect(renderedSources).toEqual([FLOWCHART]);
    });

    it.each([
      ["a tilde fence", fence(FLOWCHART, "~~~")],
      ["a list item", `- item\n\n  ${fence(FLOWCHART).replaceAll("\n", "\n  ")}`],
      ["a blockquote", `> ${fence(FLOWCHART).replaceAll("\n", "\n> ")}`],
      ["CRLF line endings", fence(FLOWCHART).replaceAll("\n", "\r\n")],
    ])("draws %s", async (_name, text) => {
      const view = await mount(text);
      await waitFor(() => hasDiagram(view.container), "the fence never drew");
      // Every form draws from the same normalized source.
      expect(renderedSources).toEqual([FLOWCHART]);
    });

    it("keeps raw-HTML language-mermaid as source", async () => {
      const view = await mount(`<pre><code class="language-mermaid">${FLOWCHART}\n</code></pre>`);
      await settle();
      expect(hasDiagram(view.container)).toBe(false);
      expect(rendererLoads).toBe(0);
    });

    it("shows an invalid diagram's source with the line and what is wrong", async () => {
      const view = await mount(fence("graph TD\n  A --> B\n  B --> C]"));
      await waitFor(() => errorText(view.container) !== null, "no error was shown");
      expect(errorText(view.container)).toBe("Can't draw this diagram: line 3, Unrecognized text.");
      expect(view.container.querySelector("pre")?.textContent).toContain("B --> C]");
      expect(viewToggle(view.container)).toBeNull();
      expect(
        view.container.querySelector(
          'button[aria-label="Wrap lines"], button[aria-label="Disable line wrap"]',
        ),
      ).not.toBeNull();
    });

    it("refuses a source over 25,000 characters without loading the renderer", async () => {
      const view = await mount(fence(`graph TD\n  A --> B\n${"%".repeat(24_990)}`));
      await settle();
      expect(errorText(view.container)).toBe("Too large to draw: over 25,000 characters.");
      expect(rendererLoads).toBe(0);
    });

    it("refuses a long source full of backtick runs without failing to render", async () => {
      // More runs than one call can take as arguments, inside a fence longer than any of them.
      const source = `graph TD\n${"``` ".repeat(140_000)}`;
      const view = await mount(fence(source, "````"));
      await settle();
      expect(errorText(view.container)).toBe("Too large to draw: over 25,000 characters.");
      expect(rendererLoads).toBe(0);
    });

    it("draws a source at the character limit", async () => {
      const source = `graph TD\n  A --> B\n%%${"x".repeat(25_000 - 21)}`;
      expect(source).toHaveLength(25_000);
      const view = await mount(fence(source));
      await waitFor(() => hasDiagram(view.container), "the source at the limit never drew");
    });

    it("offers Retry when the renderer fails to load, and Retry draws", async () => {
      let failNext = true;
      __setMermaidRendererLoaderForTests(async () => {
        if (failNext) {
          failNext = false;
          throw new TypeError("Failed to fetch dynamically imported module");
        }
        return countingRenderer();
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const view = await mount(fence(FLOWCHART));
      await waitFor(() => errorText(view.container) !== null, "the load failure was not shown");
      expect(errorText(view.container)).toBe("Couldn't load the diagram renderer.Retry");
      expect(consoleError).toHaveBeenCalledWith("[chat-markdown] action failed", {
        operation: "load-diagram-renderer",
        code: "TypeError",
      });

      const retry = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry",
      );
      await act(async () => retry!.click());
      await waitFor(() => hasDiagram(view.container), "Retry never drew");
      expect(errorText(view.container)).toBeNull();
    });

    it("draws a cached diagram in the same render as its remount", async () => {
      const first = await mount(fence(FLOWCHART));
      await waitFor(() => hasDiagram(first.container), "the first block never drew");
      await unmount(first);

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mounted.push({ container, root, render: async () => undefined });
      act(() => root.render(<ChatMarkdown text={fence(FLOWCHART)} cwd={undefined} />));
      expect(hasDiagram(container)).toBe(true);
      expect(renderedSources).toEqual([FLOWCHART]);
    });
  });

  describe("stability", () => {
    it("keeps the diagram across a theme switch without drawing it again", async () => {
      const view = await mount(fence(FLOWCHART));
      await waitFor(() => hasDiagram(view.container), "the diagram never drew");
      const svg = diagrams(view.container)[0]!.querySelector("svg");
      const host = diagrams(view.container)[0];
      const card = view.container.querySelector(".chat-markdown-codeblock");

      writeThemePreference("dark");
      await view.render(fence(FLOWCHART), { className: "themed" });
      await settle();

      expect(view.container.querySelector(".chat-markdown-codeblock")).toBe(card);
      expect(diagrams(view.container)[0]).toBe(host);
      expect(diagrams(view.container)[0]!.querySelector("svg")).toBe(svg);
      expect(renderedSources).toEqual([FLOWCHART]);
    });

    it("keeps Show source pressed across new text and a theme switch", async () => {
      const text = `${fence(FLOWCHART)}\n`;
      const stream = await mount(text, { isStreaming: true });
      await waitFor(() => hasDiagram(stream.container), "the diagram never drew");
      await act(async () => viewToggle(stream.container)!.click());
      expect(hasDiagram(stream.container)).toBe(false);
      expect(viewToggle(stream.container)?.getAttribute("aria-pressed")).toBe("true");
      expect(viewToggle(stream.container)?.getAttribute("aria-label")).toBe("Show diagram");

      await stream.render(`${text}\nMore text after the diagram.`, { isStreaming: true });
      writeThemePreference("dark");
      await stream.render(`${text}\nMore text after the diagram.`, {
        isStreaming: false,
        className: "themed",
      });

      expect(viewToggle(stream.container)?.getAttribute("aria-pressed")).toBe("true");
      expect(hasDiagram(stream.container)).toBe(false);
      await act(async () => viewToggle(stream.container)!.click());
      expect(hasDiagram(stream.container)).toBe(true);
    });

    it("renders one source shown by two blocks once", async () => {
      const first = await mount(fence(SEQUENCE));
      const second = await mount(fence(SEQUENCE));
      await waitFor(
        () => hasDiagram(first.container) && hasDiagram(second.container),
        "both blocks never drew",
      );
      expect(renderedSources).toEqual([SEQUENCE]);
    });

    it("keeps a fence the Proposed Plan preview cut open as source", async () => {
      const plan = [
        "# Plan",
        "",
        ...Array.from({ length: 6 }, (_, index) => `- step ${index + 1}`),
        "",
        "```mermaid",
        "graph TD",
        "  A --> B",
        "  B --> C",
        "  C --> D",
        "```",
      ].join("\n");
      const preview = buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 8 });
      expect(preview).toContain("```mermaid");
      expect(preview.endsWith("...")).toBe(true);
      const view = await mount(preview);
      await settle();
      expect(hasDiagram(view.container)).toBe(false);
      expect(rendererLoads).toBe(0);
    });

    it("commits each swap through the reading anchor it renders under", async () => {
      const preserveReadingPosition = vi.fn((_element: HTMLElement, commit: () => void) =>
        commit(),
      );
      const anchor = { preserveReadingPosition, holdReadingPosition: vi.fn(() => null) };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mounted.push({ container, root, render: async () => undefined });
      await act(async () =>
        root.render(
          <ReadingAnchorContext value={anchor}>
            <ChatMarkdown text={fence(FLOWCHART)} cwd={undefined} />
          </ReadingAnchorContext>,
        ),
      );
      await waitFor(() => hasDiagram(container), "the diagram never drew");
      expect(preserveReadingPosition).toHaveBeenCalledOnce();
      const body = preserveReadingPosition.mock.calls[0]![0];
      expect(body.classList.contains("chat-markdown-mermaid-body")).toBe(true);

      await act(async () => viewToggle(container)!.click());
      expect(preserveReadingPosition).toHaveBeenCalledTimes(2);
      expect(hasDiagram(container)).toBe(false);
    });

    it("holds the reading line while new text replaces a drawn diagram's source", async () => {
      /** What the block body shows: the drawn diagram's kind, or its source. */
      const showing = (body: HTMLElement) =>
        body.querySelector(".chat-markdown-mermaid svg")?.getAttribute("aria-roledescription") ??
        "source";
      const held: { before: string; after: string | null }[] = [];
      const anchor = {
        preserveReadingPosition: vi.fn((_element: HTMLElement, commit: () => void) => commit()),
        holdReadingPosition: vi.fn((body: HTMLElement) => {
          const hold = { before: showing(body), after: null as string | null };
          held.push(hold);
          return () => {
            hold.after = showing(body);
          };
        }),
      };
      const roots = [0, 1].map(() => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        mounted.push({ container, root, render: async () => undefined });
        return { container, root };
      });
      const show = (index: number, text: string) =>
        act(async () =>
          roots[index]!.root.render(
            <ReadingAnchorContext value={anchor}>
              <ChatMarkdown text={text} cwd={undefined} />
            </ReadingAnchorContext>,
          ),
        );
      await show(0, fence(FLOWCHART));
      await show(1, fence(SEQUENCE));
      await waitFor(
        () => hasDiagram(roots[0]!.container) && hasDiagram(roots[1]!.container),
        "both blocks never drew",
      );
      expect(anchor.holdReadingPosition).not.toHaveBeenCalled();

      // A replacement already drawn elsewhere shows in the same commit, under the anchor.
      await show(0, fence(SEQUENCE));
      expect(held).toEqual([{ before: "flowchart", after: "sequence" }]);

      // One not yet drawn shows its source in that commit, also under the anchor, and its draw
      // then goes through the anchor's own commit.
      const drawsBefore = anchor.preserveReadingPosition.mock.calls.length;
      await show(0, fence("graph LR\n  Replace --> Again"));
      expect(held.at(-1)).toEqual({ before: "sequence", after: "source" });
      await waitFor(() => hasDiagram(roots[0]!.container), "the replacement never drew");
      expect(anchor.preserveReadingPosition).toHaveBeenCalledTimes(drawsBefore + 1);
      expect(anchor.holdReadingPosition).toHaveBeenCalledTimes(2);
    });
  });

  describe("problems", () => {
    it("says when a diagram type is not supported", async () => {
      const view = await mount(fence("notADiagram\n  A --> B"));
      await waitFor(() => errorText(view.container) !== null, "no error was shown");
      expect(errorText(view.container)).toBe("Diagram type not supported.");
    });

    it("shows an unexpected render failure and logs only its class", async () => {
      __setMermaidRendererLoaderForTests(async () => {
        const renderer = await countingRenderer();
        return {
          ...renderer,
          renderMermaidDiagram: (source) => {
            throw new TypeError(`could not draw ${source}`);
          },
        };
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const view = await mount(fence(FLOWCHART));
      await waitFor(() => errorText(view.container) !== null, "no error was shown");

      expect(errorText(view.container)).toBe("Couldn't draw this diagram.");
      expect(consoleError).toHaveBeenCalledWith("[chat-markdown] action failed", {
        operation: "render-diagram",
        code: "TypeError",
      });
      // Pele's messages can quote the source, which never reaches a log.
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("Write --> Draw");
    });
  });

  describe("lifecycle", () => {
    it("cancels a queued render when its only block unmounts", async () => {
      const typeLoaded = deferred<void>();
      let typeRequested = false;
      __setMermaidRendererLoaderForTests(async () => {
        const renderer = await countingRenderer();
        return {
          ...renderer,
          loadMermaidDiagramType: async (source) => {
            typeRequested = true;
            await renderer.loadMermaidDiagramType(source);
            await typeLoaded.promise;
          },
        };
      });
      const view = await mount(fence(SEQUENCE));
      await waitFor(() => typeRequested, "the diagram type was never requested");
      // Let a queue run left by an earlier test finish, so this job schedules its own.
      await settle(2);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const timersBefore = vi.getTimerCount();
        typeLoaded.resolve();
        await flushMicrotasks();
        // The render job is queued and has not run; its only block leaves.
        expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);
        expect(renderedSources).toEqual([]);
        await unmount(view);
        vi.runAllTimers();
        expect(renderedSources).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows a diagram already drawn for a replacement source at once", async () => {
      const first = await mount(fence(FLOWCHART));
      const second = await mount(fence(SEQUENCE));
      await waitFor(
        () => hasDiagram(first.container) && hasDiagram(second.container),
        "both blocks never drew",
      );
      await first.render(fence(SEQUENCE));
      expect(
        diagrams(first.container)[0]?.querySelector("svg")?.getAttribute("aria-roledescription"),
      ).toBe("sequence");
      expect(renderedSources.toSorted()).toEqual([FLOWCHART, SEQUENCE].toSorted());
    });

    it("draws only the new source when the text is replaced during the module load", async () => {
      const load = deferred<MermaidRenderer>();
      __setMermaidRendererLoaderForTests(() => load.promise);
      const view = await mount(fence(FLOWCHART));
      await view.render(fence(SEQUENCE));
      load.resolve(await countingRenderer());
      await waitFor(() => hasDiagram(view.container), "the replacement never drew");
      await settle();

      expect(renderedSources).toEqual([SEQUENCE]);
      expect(
        diagrams(view.container)[0]?.querySelector("svg")?.getAttribute("aria-roledescription"),
      ).toBe("sequence");
    });

    it("schedules no render after an unmount during the module load", async () => {
      const load = deferred<MermaidRenderer>();
      __setMermaidRendererLoaderForTests(() => load.promise);
      const view = await mount(fence(FLOWCHART));
      await unmount(view);
      load.resolve(await countingRenderer());
      await settle(5);
      expect(renderedSources).toEqual([]);
    });

    it("schedules no render after an unmount during the font wait", async () => {
      const fontsReady = deferred<void>();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { status: "loading", ready: fontsReady.promise },
      });
      try {
        const view = await mount(fence(FLOWCHART));
        await waitFor(() => rendererLoads === 1, "the renderer never loaded");
        await settle(3);
        await unmount(view);
        fontsReady.resolve();
        await settle(5);
        expect(renderedSources).toEqual([]);
      } finally {
        Reflect.deleteProperty(document, "fonts");
      }
    });

    it("still draws a block whose partner on the same pending job unmounted", async () => {
      const typeLoaded = deferred<void>();
      let typeRequests = 0;
      __setMermaidRendererLoaderForTests(async () => {
        const renderer = await countingRenderer();
        return {
          ...renderer,
          loadMermaidDiagramType: async (source) => {
            typeRequests += 1;
            await renderer.loadMermaidDiagramType(source);
            await typeLoaded.promise;
          },
        };
      });
      const leaving = await mount(fence(FLOWCHART));
      const staying = await mount(fence(FLOWCHART));
      await waitFor(() => typeRequests === 2, "both blocks never requested the diagram type");
      // Let a queue run left by an earlier test finish, so this job schedules its own.
      await settle(2);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const timersBefore = vi.getTimerCount();
        typeLoaded.resolve();
        await flushMicrotasks();
        // Both blocks joined the one queued job; one leaves before the queue runs it.
        expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);
        expect(renderedSources).toEqual([]);
        await unmount(leaving);
        await act(async () => {
          vi.runAllTimers();
        });
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => hasDiagram(staying.container), "the remaining block never drew");
      expect(renderedSources).toEqual([FLOWCHART]);
    });

    it("keeps colliding sources apart, while pending and from the cache", async () => {
      const [left, right] = COLLIDING;
      const first = await mount(`${fence(left)}`);
      const second = await mount(`${fence(right)}`);
      await waitFor(
        () => hasDiagram(first.container) && hasDiagram(second.container),
        "the colliding blocks never drew",
      );
      expect(renderedSources.toSorted()).toEqual([left, right].toSorted());
      expect(first.container.textContent).toContain("76ab3ce7");
      expect(first.container.textContent).not.toContain("2bb1fad8");
      expect(second.container.textContent).toContain("2bb1fad8");

      const cachedLeft = await mount(`${fence(left)}`);
      const cachedRight = await mount(`${fence(right)}`);
      expect(cachedLeft.container.textContent).toContain("76ab3ce7");
      expect(cachedLeft.container.textContent).not.toContain("2bb1fad8");
      expect(cachedRight.container.textContent).toContain("2bb1fad8");
      expect(renderedSources).toHaveLength(2);
    });

    it("draws a diagram again through the queue once 100 others evicted it", async () => {
      const first = await mount(fence(FLOWCHART));
      await waitFor(() => hasDiagram(first.container), "the first diagram never drew");
      await unmount(first);

      const others = Array.from({ length: 100 }, (_, index) =>
        fence(`graph LR\n  N${index} --> M`),
      );
      const many = await mount(others.join("\n\n"));
      await waitFor(() => diagrams(many.container).length === 100, "the other diagrams never drew");
      await unmount(many);

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mounted.push({ container, root, render: async () => undefined });
      act(() => root.render(<ChatMarkdown text={fence(FLOWCHART)} cwd={undefined} />));
      expect(hasDiagram(container)).toBe(false);
      await waitFor(() => hasDiagram(container), "the evicted diagram never drew again");
      expect(renderedSources.filter((source) => source === FLOWCHART)).toHaveLength(2);
    });

    it("keeps an evicted diagram's drawn height while it draws again", async () => {
      // jsdom lays nothing out: a body showing a diagram measures 123 px tall.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const drawn =
          this.classList.contains("chat-markdown-mermaid-body") &&
          this.querySelector(".chat-markdown-mermaid") !== null;
        return DOMRect.fromRect({ width: 400, height: drawn ? 123 : 0 });
      });
      const body = (container: HTMLElement) =>
        container.querySelector<HTMLElement>(".chat-markdown-mermaid-body")!;
      const first = await mount(fence(FLOWCHART));
      await waitFor(() => hasDiagram(first.container), "the first diagram never drew");
      expect(body(first.container).style.height).toBe("");
      await unmount(first);

      const others = Array.from({ length: 100 }, (_, index) =>
        fence(`graph LR\n  N${index} --> M`),
      );
      const many = await mount(others.join("\n\n"));
      await waitFor(() => diagrams(many.container).length === 100, "the other diagrams never drew");
      await unmount(many);

      // The remount shows the source, held at the diagram's height, until the queue draws it.
      const remounted = await mount(fence(FLOWCHART));
      expect(hasDiagram(remounted.container)).toBe(false);
      expect(body(remounted.container).style.height).toBe("123px");
      await waitFor(() => hasDiagram(remounted.container), "the evicted diagram never drew again");
      expect(body(remounted.container).style.height).toBe("");
      expect(renderedSources.filter((source) => source === FLOWCHART)).toHaveLength(2);

      // A source that never drew reserves nothing.
      const fresh = await mount(fence(SEQUENCE));
      expect(hasDiagram(fresh.container)).toBe(false);
      expect(body(fresh.container).style.height).toBe("");
    });
  });
});
