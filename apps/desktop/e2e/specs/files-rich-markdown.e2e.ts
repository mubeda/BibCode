// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and read them back.
// @effect-diagnostics globalTimers:off - The spec waits out the rendered view's edit delay.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!projectPath) {
  throw new Error("The packaged desktop rich Markdown fixture environment was not prepared.");
}
const preparedProjectPath: string = projectPath;
const fileViewSelector = "[data-preview-panel-mode]";
const richEditorSelector = `${fileViewSelector} .rich-markdown-editor [contenteditable="true"]`;
const sourceEditorHostSelector = `${fileViewSelector} diffs-container`;

const frontmatter = "---\ntitle: Fixture notes\ntags: [e2e]\n---\n";
const fence = "```ts\nconst answer   = 42; // spacing kept\n```\n";
/** Frontmatter, the paragraph "Hello world" and a fenced code block (R25, R31). */
const notesContents = `${frontmatter}\nHello world\n\n${fence}`;

const untouchedContents = [
  "---",
  "title: Untouched fixture",
  "---",
  "",
  "Hello world",
  "",
  "| Name | Value |",
  "|:-----|------:|",
  "| one  |     1 |",
  "",
  "```ts",
  "const answer   = 42;",
  "```",
  "",
  "* star item",
  "- dash item",
  "+ plus item",
].join("\n");

/** Records, from now on, whether the Files toolbar ever says "Unsaved changes". */
async function watchForUnsavedIndicator(): Promise<void> {
  await browser.execute(() => {
    const record = window as unknown as { __bibcodeUnsavedSeen?: boolean };
    record.__bibcodeUnsavedSeen = false;
    const check = () => {
      const status = document.querySelector("[data-file-editor-toolbar] [aria-live='polite']");
      if (status?.textContent === "Unsaved changes") record.__bibcodeUnsavedSeen = true;
    };
    new MutationObserver(check).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    check();
  });
}

async function unsavedIndicatorAppeared(): Promise<boolean> {
  return browser.execute(
    () => (window as unknown as { __bibcodeUnsavedSeen?: boolean }).__bibcodeUnsavedSeen === true,
  );
}

function writeNotes(fileName: string): string {
  const path = NodePath.join(preparedProjectPath, fileName);
  NodeFS.writeFileSync(path, notesContents);
  return path;
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
  if ((await project.getAttribute("aria-expanded")) !== "true") {
    await project.click();
  }
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
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
  // The editable rendered view, not the read-only view shown while the editor loads.
  await browser.waitUntil(
    () =>
      browser.execute(
        (editorQuery: string) =>
          [...document.querySelectorAll(editorQuery)].some((editor) =>
            editor.textContent?.includes("Hello world"),
          ),
        richEditorSelector,
      ),
    { timeoutMsg: `The rendered Markdown view did not show ${fileName} as editable.` },
  );
}

async function openNotes(fileName: string): Promise<void> {
  await setDesktopUiWindowSize(1_200, 720);
  await openFixtureWorkspace();
  await openFilesSurface();
  await openWorkspaceFile(fileName);
}

/** Puts the caret at the end of the paragraph that holds `text`. */
async function placeCaretAfter(text: string): Promise<void> {
  const placed = await browser.execute(
    (editorQuery: string, needle: string) => {
      const editor = document.querySelector<HTMLElement>(editorQuery);
      const block = [...(editor?.querySelectorAll<HTMLElement>("p, h1, h2, h3") ?? [])].find(
        (candidate) => candidate.textContent?.includes(needle),
      );
      if (!editor || !block) return false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(block);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    },
    richEditorSelector,
    text,
  );
  if (!placed) throw new Error(`No rendered block holds "${text}".`);
}

async function typeInRichEditor(text: string): Promise<void> {
  const editor = await browser.$(richEditorSelector);
  await editor.addValue(text);
}

async function toolbarButton(label: string) {
  const button = await browser.$(`[data-file-editor-toolbar] button[aria-label="${label}"]`);
  await button.waitForDisplayed();
  return button;
}

async function clickToolbar(label: string): Promise<void> {
  const button = await toolbarButton(label);
  await button.waitForEnabled();
  await button.click();
}

async function waitForStatus(status: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.$("[data-file-editor-toolbar] [aria-live='polite']").getText()) === status,
    { timeoutMsg: `The Files toolbar never said "${status}".` },
  );
}

async function renderedBlocks(): Promise<string[]> {
  return browser.execute((editorQuery: string) => {
    const editor = document.querySelector(editorQuery);
    return [...(editor?.children ?? [])].map(
      (block) => `${block.tagName.toLowerCase()}:${block.textContent ?? ""}`,
    );
  }, richEditorSelector);
}

async function sourceEditorText(fileName: string): Promise<string | null> {
  return browser.execute(
    (hostQuery: string, targetQuery: string) => {
      const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
        (candidate) => candidate.getBoundingClientRect().height > 0,
      );
      const root = host?.shadowRoot;
      if (!root) return null;
      const textbox = root.querySelector<HTMLElement>(targetQuery);
      return (textbox ?? root.querySelector("pre"))?.textContent ?? null;
    },
    sourceEditorHostSelector,
    `[role="textbox"][aria-label="${fileName}"]`,
  );
}

async function waitForSourceEditor(fileName: string): Promise<void> {
  await browser.waitUntil(async () => (await sourceEditorText(fileName)) !== null, {
    timeoutMsg: `The source view of ${fileName} did not open.`,
  });
}

async function switchView(label: "Show markdown source" | "Show rendered markdown") {
  const toggle = await browser.$(`[data-file-editor-toolbar] button[aria-label="${label}"]`);
  await toggle.waitForDisplayed();
  await toggle.click();
}

describe("packaged rich Markdown editing", () => {
  it("edits in rendered view, saves and keeps the rest of the file", async () => {
    const path = writeNotes("notes.md");
    await openNotes("notes.md");

    await placeCaretAfter("Hello world");
    await typeInRichEditor(" again");
    await placeCaretAfter("Hello world again");
    await clickToolbar("Heading 2");
    await waitForStatus("Unsaved changes");
    expect(NodeFS.readFileSync(path, "utf8")).toBe(notesContents);

    await clickToolbar("Save file");
    await browser.waitUntil(() => NodeFS.readFileSync(path, "utf8") !== notesContents, {
      timeoutMsg: "Save file never wrote notes.md.",
    });
    const saved = NodeFS.readFileSync(path, "utf8");
    expect(saved.startsWith(frontmatter)).toBe(true);
    expect(saved.endsWith(fence)).toBe(true);
    expect(saved).toBe(`${frontmatter}\n## Hello world again\n\n${fence}`);
  });

  it("undo in rendered view and one-step undo in source view", async () => {
    writeNotes("notes-undo.md");
    await openNotes("notes-undo.md");

    await placeCaretAfter("Hello world");
    await typeInRichEditor(" again");
    // The editor's history joins changes made within half a second into one undo step.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await placeCaretAfter("Hello world again");
    await clickToolbar("Heading 2");
    await browser.waitUntil(async () => (await renderedBlocks())[0] === "h2:Hello world again", {
      timeoutMsg: "Heading 2 did not apply to the paragraph.",
    });
    await clickToolbar("Undo");
    await browser.waitUntil(async () => (await renderedBlocks())[0] === "p:Hello world again", {
      timeoutMsg: "Undo in rendered view did not remove the heading.",
    });

    // The source editor exists from here on, so the next rendered visit reaches it as one step.
    await switchView("Show markdown source");
    await waitForSourceEditor("notes-undo.md");
    expect(await sourceEditorText("notes-undo.md")).toContain("Hello world again");
    await switchView("Show rendered markdown");
    await browser.$(richEditorSelector).waitForDisplayed();

    await placeCaretAfter("Hello world again");
    await typeInRichEditor(" twice");
    await placeCaretAfter("Hello world again twice");
    await clickToolbar("Heading 2");
    await browser.waitUntil(
      async () => (await renderedBlocks())[0] === "h2:Hello world again twice",
      { timeoutMsg: "The second visit's edits did not apply." },
    );

    await switchView("Show markdown source");
    await browser.waitUntil(
      async () => (await sourceEditorText("notes-undo.md"))?.includes("## Hello world again twice"),
      { timeoutMsg: "The source view did not show the rendered visit's edits." },
    );
    await clickToolbar("Undo");
    await browser.waitUntil(
      async () => {
        const text = (await sourceEditorText("notes-undo.md")) ?? "";
        return (
          text.includes("Hello world again") && !text.includes("twice") && !text.includes("##")
        );
      },
      { timeoutMsg: "One Undo in source view did not remove both rendered edits." },
    );
  });

  it("shows an image the file links by a relative path (#345)", async () => {
    // A 1x1 placeholder PNG next to the Markdown file's own folder.
    const imagesPath = NodePath.join(preparedProjectPath, "images");
    NodeFS.mkdirSync(imagesPath, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(imagesPath, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    NodeFS.writeFileSync(
      NodePath.join(preparedProjectPath, "notes-image.md"),
      "Hello world\n\n![Placeholder pixel](images/pixel.png)\n",
    );
    await openNotes("notes-image.md");

    await browser.waitUntil(
      () =>
        browser.execute((editorQuery: string) => {
          const image = document.querySelector<HTMLImageElement>(`${editorQuery} img`);
          return image !== null && image.complete && image.naturalWidth > 0;
        }, richEditorSelector),
      { timeoutMsg: "The relative image in notes-image.md never loaded." },
    );
  });

  it("opening and saving without editing leaves the file byte-identical", async () => {
    // R31: frontmatter, a table, a fenced code block, mixed list markers, no final newline.
    const path = NodePath.join(preparedProjectPath, "notes-untouched.md");
    NodeFS.writeFileSync(path, untouchedContents);
    const before = NodeFS.readFileSync(path);
    await openNotes("notes-untouched.md");
    await watchForUnsavedIndicator();

    await switchView("Show markdown source");
    await waitForSourceEditor("notes-untouched.md");
    await switchView("Show rendered markdown");
    await browser.$(richEditorSelector).waitForDisplayed();
    await placeCaretAfter("Hello world");
    // A clean file's Save file is disabled, so save through the Files shortcut.
    await browser.keys(["Meta", "s"]);
    // Longer than the rendered view's 300 ms edit delay and a save round trip.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(NodeFS.readFileSync(path).equals(before)).toBe(true);
    expect(await unsavedIndicatorAppeared()).toBe(false);
  });
});
