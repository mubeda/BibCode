// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and save screenshots.
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

interface ReadingLineSample {
  readonly anchorTop: number;
  readonly targetTop: number;
  readonly viewportTop: number;
}

/**
 * Scrolls the timeline so `anchorText` sits a little below the visible top, then toggles
 * Show source on the diagram that contains `diagramLabel`, which lies above it, and reports
 * where the anchor paragraph was before and after the swap settled.
 */
async function swapAboveReadingLine(
  diagramLabel: string,
  anchorText: string,
): Promise<{ before: ReadingLineSample; after: ReadingLineSample }> {
  const before = await browser.execute(
    (surface: string, label: string, anchor: string) => {
      const scroller = document
        .querySelector<HTMLElement>(`${surface} [data-timeline-root]`)
        ?.closest<HTMLElement>("[class*='overflow-anchor']");
      const paragraph = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
      ].find((element) => element.textContent === anchor);
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(label));
      if (!scroller || !paragraph || !target) throw new Error("Reading-line fixture missing.");
      const viewportTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += paragraph.getBoundingClientRect().top - viewportTop - 80;
      return {
        anchorTop: paragraph.getBoundingClientRect().top,
        targetTop: target.getBoundingClientRect().top,
        viewportTop,
      };
    },
    visibleSurfaceSelector,
    diagramLabel,
    anchorText,
  );
  await browser.pause(250);
  const settled = await browser.execute(
    (surface: string, label: string, anchor: string) => {
      const paragraph = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
      ].find((element) => element.textContent === anchor);
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(label));
      const toggle = target?.querySelector<HTMLButtonElement>(
        'button[aria-label="Show source"], button[aria-label="Show diagram"]',
      );
      if (!paragraph || !target || !toggle) throw new Error("Reading-line fixture missing.");
      const anchorTop = paragraph.getBoundingClientRect().top;
      toggle.click();
      return { anchorTop, targetTop: target.getBoundingClientRect().top };
    },
    visibleSurfaceSelector,
    diagramLabel,
    anchorText,
  );
  await browser.pause(400);
  const after = await browser.execute(
    (surface: string, label: string, anchor: string) => {
      const paragraph = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
      ].find((element) => element.textContent === anchor);
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(label));
      if (!paragraph || !target) throw new Error("Reading-line fixture missing.");
      return {
        anchorTop: paragraph.getBoundingClientRect().top,
        targetTop: target.getBoundingClientRect().top,
        viewportTop: 0,
      };
    },
    visibleSurfaceSelector,
    diagramLabel,
    anchorText,
  );
  return { before: { ...before, anchorTop: settled.anchorTop }, after };
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

    // A theme switch recolors the drawn diagram without drawing or replacing it.
    const themeSwitch = await browser.execute((viewQuery: string) => {
      const svg = document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`);
      const shape = svg?.querySelector(".pele-node rect, .pele-node polygon, .pele-node path");
      if (!svg || !shape) throw new Error("The drawn fixture diagram has no node shape.");
      let replaced = false;
      const observer = new MutationObserver(() => {
        replaced = true;
      });
      observer.observe(svg.parentElement!, { childList: true });
      const before = getComputedStyle(shape).fill;
      const dark = document.documentElement.classList.contains("dark");
      const next = dark ? "light" : "dark";
      window.localStorage.setItem("bibcode:theme", next);
      window.dispatchEvent(new StorageEvent("storage", { key: "bibcode:theme", newValue: next }));
      const after = getComputedStyle(shape).fill;
      return new Promise<{ before: string; after: string; replaced: boolean; same: boolean }>(
        (resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              observer.disconnect();
              resolve({
                before,
                after,
                replaced,
                same: document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`) === svg,
              });
            }),
          ),
      );
    }, fileViewSelector);
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
    const inRow = await swapAboveReadingLine(
      "Fixture draw",
      "Below the diagram paragraph 20 keeps the reading position measurable.",
    );
    expect(inRow.before.targetTop).toBeLessThan(inRow.before.viewportTop);
    expect(Math.abs(inRow.after.anchorTop - inRow.before.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-first-row");

    // A row wholly above the viewport: the list's size anchoring holds the next row.
    const aboveRow = await swapAboveReadingLine(
      "Fixture draw",
      "Following reply paragraph 2 keeps the reading position measurable.",
    );
    expect(Math.abs(aboveRow.after.anchorTop - aboveRow.before.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-row-above");
  });

  it("draws an evicted diagram again on remount without moving the end of the timeline", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await sendPrompt(mermaidFixturePrompts.many);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            document.querySelectorAll(`${surface} .chat-markdown-mermaid svg`).length >= 101,
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The 101 fixture diagrams never drew.", timeout: 60_000 },
    );
    // Sample every frame while the chat is left and reopened (an in-page navigation keeps the
    // diagram cache, from which the first of the 101 diagrams was evicted): the last line's
    // position and whether the reply's first diagram is drawn.
    await browser.execute((surface: string) => {
      const record = window as unknown as {
        __bibcodeMermaidSamples?: Array<{ bottom: number | null; firstDrawn: boolean }>;
      };
      const samples: Array<{ bottom: number | null; firstDrawn: boolean }> = [];
      record.__bibcodeMermaidSamples = samples;
      const started = performance.now();
      const sample = () => {
        const paragraph = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ].find((element) => element.textContent === "Last line after the diagrams.");
        const firstBlock = paragraph
          ?.closest(".chat-markdown")
          ?.querySelector(".chat-markdown-codeblock");
        samples.push({
          bottom: paragraph?.getBoundingClientRect().bottom ?? null,
          firstDrawn: firstBlock?.querySelector(".chat-markdown-mermaid svg") != null,
        });
        if (performance.now() - started < 8_000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, visibleSurfaceSelector);
    await browser.url(`${await browser.execute(() => window.location.origin)}/#/`);
    await openFixtureWorkspace();
    await browser.pause(8_500);
    const samples = await browser.execute(
      () =>
        (
          window as unknown as {
            __bibcodeMermaidSamples?: Array<{ bottom: number | null; firstDrawn: boolean }>;
          }
        ).__bibcodeMermaidSamples ?? [],
    );
    const mounted = samples.findIndex((entry) => entry.bottom !== null);
    const drawn = samples.findIndex((entry, index) => index > mounted && entry.firstDrawn);
    // The remounted first diagram showed its source before it drew again through the queue.
    expect(mounted).toBeGreaterThanOrEqual(0);
    expect(samples[mounted]?.firstDrawn).toBe(false);
    expect(drawn).toBeGreaterThan(mounted);
    const beforeDraw = samples[drawn - 1]!.bottom!;
    for (const entry of samples.slice(drawn)) {
      expect(Math.abs(entry.bottom! - beforeDraw)).toBeLessThanOrEqual(1);
    }
    await saveEvidence("mermaid-timeline-evicted-remount");
  });
});
