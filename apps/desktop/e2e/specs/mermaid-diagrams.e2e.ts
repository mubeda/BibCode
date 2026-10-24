// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and save screenshots.
// @effect-diagnostics globalTimers:off - Page scripts wait and sample on timers inside the packaged webview.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  mermaidFixtureFiles,
  mermaidFixturePrompts,
  prepareMermaidFixtureFiles,
} from "../support/mermaid-fixture.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!artifactDirectory || !projectPath) {
  throw new Error("The packaged desktop Mermaid fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const composerEditorSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"] [data-testid="composer-editor"]`;
const fileViewSelector = "[data-preview-panel-mode]";

interface EndSample {
  readonly at: number;
  readonly bottom: number | null;
  /** The last line is inside the list's visible area. */
  readonly visible: boolean;
  /** How far the list is scrolled from its end. */
  readonly endGap: number | null;
  readonly evictedDrawn: boolean;
}

async function saveEvidence(name: string): Promise<void> {
  await browser.saveScreenshot(NodePath.join(preparedArtifactDirectory, `${name}.png`));
}

/** Records CSP violations from now on; the packaged app runs its production policy. */
async function watchSecurityPolicyViolations(): Promise<void> {
  await browser.execute(() => {
    const record = window as unknown as { __bibcodeCspViolations?: string[] };
    if (record.__bibcodeCspViolations) return;
    record.__bibcodeCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      record.__bibcodeCspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function securityPolicyViolations(): Promise<string[]> {
  return browser.execute(
    () => (window as unknown as { __bibcodeCspViolations?: string[] }).__bibcodeCspViolations ?? [],
  );
}

async function probeResourceRequests(): Promise<string[]> {
  return browser.execute(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/mermaid-probe/")),
  );
}

async function openFixtureWorkspace(): Promise<void> {
  await ensureMainSidebarOpen();
  const project = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  if (!(await project.isDisplayed())) {
    const projectDataLoading = browser.$("//*[normalize-space()='Project data is still loading']");
    if (await projectDataLoading.isExisting()) {
      await projectDataLoading.waitForDisplayed({ reverse: true });
    }
    const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
    await addProject.waitForDisplayed();
    await addProject.click();
    const browseFolder = browser.$(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    await browseFolder.waitForDisplayed();
    await mockDesktopUiFolderPicker(preparedProjectPath);
    await browseFolder.click();
  }
  await project.waitForDisplayed();
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    await project.click();
  }
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
  await browser.$(composerEditorSelector).waitForDisplayed();
}

async function openFilesSurface(): Promise<void> {
  const rightPanel = browser.$("[data-right-panel-tabbar]");
  if (!(await rightPanel.isDisplayed())) {
    const toggle = browser.$('button[aria-label^="Toggle right panel"]');
    await toggle.waitForDisplayed();
    await toggle.click();
    await rightPanel.waitForDisplayed();
  }
  const existingTab = browser.$(
    '//*[@data-right-panel-tab-list]//button[normalize-space()="Files"]',
  );
  if (await existingTab.isDisplayed()) {
    await existingTab.click();
    return;
  }
  const emptyStateAction = browser.$(
    '//button[.//span[normalize-space()="Files"] and not(@aria-disabled="true")]',
  );
  if (await emptyStateAction.isDisplayed()) {
    await emptyStateAction.click();
    return;
  }
  const addSurface = browser.$('button[aria-label="Add panel surface"]');
  await addSurface.waitForDisplayed();
  await addSurface.click();
  const menuItem = browser.$('//*[@role="menuitem" and normalize-space()="Files"]');
  await menuItem.waitForDisplayed();
  await menuItem.click();
}

/** Opens a workspace file from the Files tree, which renders inside a shadow root. */
async function openWorkspaceFile(fileName: string): Promise<void> {
  const treeHostSelector = `${fileViewSelector} file-tree-container`;
  const itemSelector = `[role="treeitem"][data-item-path="${fileName}"]`;
  await browser.waitUntil(
    () =>
      browser.execute(
        (hostQuery: string, targetQuery: string) => {
          const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
            (candidate) => candidate.getBoundingClientRect().height > 0,
          );
          const target = host?.shadowRoot?.querySelector<HTMLElement>(targetQuery);
          if (!target) return false;
          target.click();
          return true;
        },
        treeHostSelector,
        itemSelector,
      ),
    { timeoutMsg: `The Files tree did not list ${fileName}.` },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (viewQuery: string, title: string) =>
          [...document.querySelectorAll(`${viewQuery} .chat-markdown h1`)].some(
            (heading) => heading.textContent === title,
          ),
        fileViewSelector,
        fileName === mermaidFixtureFiles.valid.name
          ? "Valid diagram"
          : fileName === mermaidFixtureFiles.invalid.name
            ? "Invalid diagram"
            : "Hostile diagram",
      ),
    { timeoutMsg: `The rendered Markdown view did not show ${fileName}.` },
  );
}

async function waitForDiagram(scope: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (scopeQuery: string) =>
          [...document.querySelectorAll(`${scopeQuery} .chat-markdown-mermaid svg`)].some(
            (svg) => svg.getBoundingClientRect().height > 0,
          ),
        scope,
      ),
    { timeoutMsg },
  );
}

async function sendPrompt(prompt: string): Promise<void> {
  const editor = browser.$(composerEditorSelector);
  await editor.click();
  await editor.addValue(prompt);
  await expect(editor).toHaveText(prompt);
  await browser.keys("Enter");
  await expect(editor).toHaveText("");
}

interface ReadingLineGeometry {
  readonly anchorTop: number;
  readonly targetTop: number;
  readonly targetBottom: number;
  readonly targetRowTop: number;
  readonly targetRowBottom: number;
  readonly viewportTop: number;
}

/** Where the anchor paragraph and the diagram block containing `label` are now. */
async function readingLineGeometry(label: string, anchor: string): Promise<ReadingLineGeometry> {
  return browser.execute(
    (surface: string, targetLabel: string, anchorText: string) => {
      const paragraph = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
      ].find((element) => element.textContent === anchorText);
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(targetLabel));
      const row = target?.closest<HTMLElement>("[data-timeline-root]");
      const viewport = row?.closest<HTMLElement>("[class*='overflow-anchor']")?.parentElement;
      if (!paragraph || !target || !row || !viewport) {
        throw new Error(
          `Reading-line fixture missing: ${JSON.stringify({
            paragraph: !!paragraph,
            target: !!target,
            row: !!row,
            viewport: !!viewport,
          })}`,
        );
      }
      const targetBox = target.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        anchorTop: paragraph.getBoundingClientRect().top,
        targetTop: targetBox.top,
        targetBottom: targetBox.bottom,
        targetRowTop: rowBox.top,
        targetRowBottom: rowBox.bottom,
        viewportTop: viewport.getBoundingClientRect().top,
      };
    },
    visibleSurfaceSelector,
    label,
    anchor,
  );
}

/**
 * Scrolls the timeline until `anchor` rests 80 px below the visible top. Right after a reply
 * the list can still move itself (the sent-row anchor, end following), so it scrolls again
 * until two readings agree.
 */
async function restAnchorBelowTop(label: string, anchor: string): Promise<ReadingLineGeometry> {
  let previous: number | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await browser.execute(
      (surface: string, anchorText: string) => {
        const paragraph = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ].find((element) => element.textContent === anchorText);
        const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
        const viewport = scroller?.parentElement;
        if (!paragraph || !scroller || !viewport) return;
        const offset =
          paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 80;
        if (Math.abs(offset) > 0.5) scroller.scrollTop += offset;
      },
      visibleSurfaceSelector,
      anchor,
    );
    await browser.pause(300);
    const geometry = await readingLineGeometry(label, anchor);
    const resting = Math.abs(geometry.anchorTop - geometry.viewportTop - 80) <= 1;
    if (resting && previous !== null && Math.abs(previous - geometry.anchorTop) <= 0.5) {
      return geometry;
    }
    previous = resting ? geometry.anchorTop : null;
  }
  throw new Error(`The timeline did not rest with "${anchor}" below its top.`);
}

/** Toggles Show source on the diagram block containing `label`, as a reader would. */
async function toggleDiagramView(label: string): Promise<void> {
  await browser.execute(
    (surface: string, targetLabel: string) => {
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(targetLabel));
      const toggle = target?.querySelector<HTMLButtonElement>(
        'button[aria-label="Show source"], button[aria-label="Show diagram"]',
      );
      if (!toggle) throw new Error("The diagram view toggle is missing.");
      toggle.click();
    },
    visibleSurfaceSelector,
    label,
  );
  await browser.pause(600);
}

describe("packaged Mermaid diagrams", () => {
  it("draws, refuses and sanitizes diagrams in the rendered Markdown view", async () => {
    prepareMermaidFixtureFiles(preparedProjectPath);
    await setDesktopUiWindowSize(1_600, 1_000);
    await watchSecurityPolicyViolations();
    await openFixtureWorkspace();
    await openFilesSurface();

    await openWorkspaceFile(mermaidFixtureFiles.valid.name);
    await waitForDiagram(fileViewSelector, "The valid fixture diagram never drew.");
    await expect(browser.$(`${fileViewSelector} .chat-markdown-mermaid`)).toHaveText(
      expect.stringContaining("Fixture draw"),
    );
    await saveEvidence("mermaid-file-valid");

    // A theme switch recolors the drawn diagram without drawing or replacing it. Timers, not
    // animation frames, wait for React: frames can stop in an occluded macOS webview.
    const themeSwitch = await browser.executeAsync(
      (
        viewQuery: string,
        done: (result: { before: string; after: string; replaced: boolean; same: boolean }) => void,
      ) => {
        const svg = document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`);
        const shape = svg?.querySelector(".pele-node rect, .pele-node polygon, .pele-node path");
        if (!svg || !shape) throw new Error("The drawn fixture diagram has no node shape.");
        let replaced = false;
        const observer = new MutationObserver(() => {
          replaced = true;
        });
        observer.observe(svg.parentElement!, { childList: true });
        const before = getComputedStyle(shape).fill;
        const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
        window.localStorage.setItem("bibcode:theme", next);
        window.dispatchEvent(new StorageEvent("storage", { key: "bibcode:theme", newValue: next }));
        setTimeout(() => {
          observer.disconnect();
          done({
            before,
            after: getComputedStyle(shape).fill,
            replaced,
            same: document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`) === svg,
          });
        }, 500);
      },
      fileViewSelector,
    );
    expect(themeSwitch.after).not.toBe(themeSwitch.before);
    expect(themeSwitch.replaced).toBe(false);
    expect(themeSwitch.same).toBe(true);
    await saveEvidence("mermaid-file-valid-other-theme");

    await openWorkspaceFile(mermaidFixtureFiles.invalid.name);
    const error = browser.$(`${fileViewSelector} .chat-markdown-mermaid-error`);
    await error.waitForDisplayed({ timeoutMsg: "The invalid fixture diagram showed no error." });
    await expect(error).toHaveText("Can't draw this diagram: line 3, Unrecognized text.");
    await saveEvidence("mermaid-file-invalid");

    await openWorkspaceFile(mermaidFixtureFiles.hostile.name);
    await waitForDiagram(fileViewSelector, "The hostile fixture diagram never drew.");
    const hostile = await browser.execute(
      (viewQuery: string) =>
        document.querySelectorAll(
          `${viewQuery} .chat-markdown-mermaid :is(a, image, foreignObject, style, use, script)`,
        ).length,
      fileViewSelector,
    );
    expect(hostile).toBe(0);
    await browser.pause(500);
    // Same-origin loads raise no CSP event, so the resource list is the evidence.
    expect(await probeResourceRequests()).toEqual([]);
    expect(await securityPolicyViolations()).toEqual([]);
    await saveEvidence("mermaid-file-hostile");
  });

  it("keeps the reading line in place when a diagram above it swaps", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await sendPrompt(mermaidFixturePrompts.rows);
    await waitForDiagram(visibleSurfaceSelector, "The fixture reply's diagram never drew.");
    await sendPrompt(mermaidFixturePrompts.long);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [...document.querySelectorAll(`${surface} .chat-markdown p`)].some(
              (paragraph) =>
                paragraph.textContent ===
                "Following reply paragraph 60 keeps the reading position measurable.",
            ),
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The long fixture reply never arrived." },
    );

    // Inside the first visible row, above the top edge: the reading anchor compensates.
    const inRowAnchor = "Below the diagram paragraph 20 keeps the reading position measurable.";
    const inRow = await restAnchorBelowTop("Fixture draw", inRowAnchor);
    expect(inRow.targetTop).toBeLessThan(inRow.viewportTop);
    expect(inRow.targetRowTop).toBeLessThanOrEqual(inRow.viewportTop);
    expect(inRow.targetRowBottom).toBeGreaterThan(inRow.viewportTop);
    await toggleDiagramView("Fixture draw");
    const inRowAfter = await readingLineGeometry("Fixture draw", inRowAnchor);
    // The swap changed the block's height, so a fixed line below it would have moved.
    expect(
      Math.abs(
        inRowAfter.targetBottom - inRowAfter.targetTop - (inRow.targetBottom - inRow.targetTop),
      ),
    ).toBeGreaterThan(1);
    expect(Math.abs(inRowAfter.anchorTop - inRow.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-first-row");

    // A row wholly above the viewport: the list's size anchoring holds the next row.
    const aboveAnchor = "Following reply paragraph 2 keeps the reading position measurable.";
    const above = await restAnchorBelowTop("Fixture draw", aboveAnchor);
    expect(above.targetRowBottom).toBeLessThanOrEqual(above.viewportTop);
    await toggleDiagramView("Fixture draw");
    const aboveAfter = await readingLineGeometry("Fixture draw", aboveAnchor);
    expect(Math.abs(aboveAfter.anchorTop - above.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-row-above");
  });

  it("draws an evicted diagram again on remount and settles at the end", async function () {
    // The draws alone may wait 240 s in an occluded webview, then the remount up to 60 s more,
    // past the suite's 120 s default.
    this.timeout(420_000);
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await sendPrompt(mermaidFixturePrompts.many);
    // One render per task: an occluded macOS webview throttles timers to about one a second.
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            document.querySelectorAll(
              `${surface} .chat-markdown-codeblock[data-language="mermaid"] .chat-markdown-mermaid svg`,
            ).length >= 101,
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The 101 fixture diagrams never drew.", timeout: 240_000, interval: 1_000 },
    );
    // Sample on a timer while the chat is left and reopened (an in-page navigation keeps the
    // diagram cache): the last line's position and whether the evicted diagram is drawn. The
    // queue draws the most recently mounted block first, so the reply's last diagram was the
    // first one drawn and, once 100 others followed it, the one the cache evicted.
    await browser.execute((surface: string) => {
      const record = window as unknown as { __bibcodeMermaidSamples?: EndSample[] };
      const samples: EndSample[] = [];
      record.__bibcodeMermaidSamples = samples;
      const started = performance.now();
      const sample = () => {
        const paragraph = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ].find((element) => element.textContent === "Last line after the diagrams.");
        const evictedBlock = [
          ...(paragraph?.closest(".chat-markdown")?.querySelectorAll(".chat-markdown-codeblock") ??
            []),
        ].at(-1);
        samples.push({
          at: performance.now() - started,
          bottom: paragraph?.getBoundingClientRect().bottom ?? null,
          visible: (() => {
            const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
            if (!paragraph || !scroller) return false;
            const line = paragraph.getBoundingClientRect();
            const area = scroller.getBoundingClientRect();
            return line.top >= area.top && line.bottom <= area.bottom;
          })(),
          endGap: (() => {
            const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
            return scroller
              ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
              : null;
          })(),
          evictedDrawn: evictedBlock?.querySelector(".chat-markdown-mermaid svg") != null,
        });
      };
      // The first sample is where the reply ends before the chat is left; an occluded webview
      // can delay the first timer past the navigation.
      sample();
      const timer = setInterval(() => {
        sample();
        if (performance.now() - started > 60_000) clearInterval(timer);
      }, 5);
    }, visibleSurfaceSelector);
    await browser.url(`${await browser.execute(() => window.location.origin)}/#/`);
    await openFixtureWorkspace();
    const readSamples = () =>
      browser.execute(
        () =>
          (window as unknown as { __bibcodeMermaidSamples?: EndSample[] })
            .__bibcodeMermaidSamples ?? [],
      );
    let samples: EndSample[] = [];
    await browser.waitUntil(
      async () => {
        samples = await readSamples();
        const gone = samples.findIndex((entry) => entry.bottom === null);
        const redrawn = samples.findIndex(
          (entry, index) => gone >= 0 && index > gone && entry.evictedDrawn,
        );
        return redrawn >= 0 && samples.at(-1)!.at - samples[redrawn]!.at > 1_500;
      },
      { timeoutMsg: "The evicted diagram never drew again.", timeout: 60_000, interval: 500 },
    );
    const left = samples.findIndex((entry) => entry.bottom === null);
    const mounted = samples.findIndex((entry, index) => index > left && entry.bottom !== null);
    const drawn = samples.findIndex((entry, index) => index > mounted && entry.evictedDrawn);
    // The remounted evicted diagram showed its source before it drew again through the queue.
    expect(left).toBeGreaterThan(0);
    expect(mounted).toBeGreaterThan(left);
    expect(samples[mounted]?.evictedDrawn).toBe(false);
    expect(drawn).toBeGreaterThan(mounted);
    const trace = samples
      .slice(Math.max(0, left - 1))
      .filter(
        (entry, index, all) =>
          index === 0 ||
          entry.bottom !== all[index - 1]!.bottom ||
          entry.visible !== all[index - 1]!.visible ||
          entry.endGap !== all[index - 1]!.endGap ||
          entry.evictedDrawn !== all[index - 1]!.evictedDrawn,
      );
    // The per-sample trace is evidence for the open gate item below; it holds no message text.
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, "mermaid-timeline-evicted-remount.json"),
      JSON.stringify(trace, null, 2),
    );
    // The reopened chat settles at its end, with the reply's last line in view, and stays
    // there for the last second of samples. Open item (#171 merge gate): when the evicted
    // diagram redraws before the list's first scroll to the end, the end can converge in steps
    // (about one diagram height each) for a few frames after it first shows; a reply whose
    // diagrams all stay cached lands straight at the end.
    const final = samples.at(-1)!;
    expect(final.visible).toBe(true);
    expect(final.endGap).toBeLessThanOrEqual(1);
    const lastSecond = samples.filter((entry) => entry.at >= final.at - 1_000);
    expect(lastSecond.every((entry) => Math.abs(entry.bottom! - final.bottom!) <= 1)).toBe(true);
    await saveEvidence("mermaid-timeline-evicted-remount");
  });
});
