// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and save screenshots.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!artifactDirectory || !projectPath) {
  throw new Error("The packaged desktop Files fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const fileViewSelector = "[data-preview-panel-mode]";
const mediaSurfaceSelector = `${fileViewSelector} [data-file-media-surface]`;

const fixtureFiles = {
  png: "binary-preview-fixture.png",
  svg: "binary-preview-fixture.svg",
  pdf: "binary-preview-fixture.pdf",
  wav: "binary-preview-fixture.wav",
} as const;

// A 2x1 red PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8Dwn4EBAAj+Af9IxWaQAAAAAElFTkSuQmCC";
// The script would flag the document if the webview ever ran it. Shown through <img>, it cannot.
const SVG_WITH_SCRIPT = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">',
  '<rect width="64" height="32" fill="#2a7"/>',
  "<script>window.top.__svgScriptRan = true; window.__svgScriptRan = true;</script>",
  "</svg>",
].join("");
const PDF_ONE_PAGE = [
  "%PDF-1.1",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

/** Half a second of 8 kHz mono silence: the shortest WAV every webview decodes. */
function silentWav(): Buffer {
  const samples = 4_000;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)]);
}

function writeFixtureFiles(): void {
  NodeFS.writeFileSync(
    NodePath.join(preparedProjectPath, fixtureFiles.png),
    Buffer.from(PNG_BASE64, "base64"),
  );
  NodeFS.writeFileSync(NodePath.join(preparedProjectPath, fixtureFiles.svg), SVG_WITH_SCRIPT);
  NodeFS.writeFileSync(NodePath.join(preparedProjectPath, fixtureFiles.pdf), PDF_ONE_PAGE);
  NodeFS.writeFileSync(NodePath.join(preparedProjectPath, fixtureFiles.wav), silentWav());
}

/** Records every content security policy violation the page reports from now on. */
async function watchSecurityPolicyViolations(): Promise<void> {
  await browser.execute(() => {
    const target = window as unknown as { __cspViolations?: string[] };
    target.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      target.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function securityPolicyViolations(): Promise<string[]> {
  return browser.execute(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
}

async function saveEvidence(name: string): Promise<void> {
  await browser.saveScreenshot(NodePath.join(preparedArtifactDirectory, `${name}.png`));
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
  await browser
    .$('[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]')
    .waitForDisplayed();
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

/** Clicks a file in the Files tree, which renders inside a shadow root. */
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
}

async function loadedImage(): Promise<{ width: number; height: number } | null> {
  return browser.execute((selector: string) => {
    const image = document.querySelector<HTMLImageElement>(`${selector} img`);
    return image?.complete && image.naturalWidth > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
  }, mediaSurfaceSelector);
}

describe("packaged Files binary previews", () => {
  it("shows a PNG, an SVG without running its script, and a PDF from the Files tree", async () => {
    writeFixtureFiles();
    await setDesktopUiWindowSize(1_600, 1_000);
    await openFixtureWorkspace();
    await openFilesSurface();
    await watchSecurityPolicyViolations();

    // PNG: an <img> from the asset route with its pixel size, and no read-error text.
    await openWorkspaceFile(fixtureFiles.png);
    await browser.waitUntil(async () => (await loadedImage()) !== null, {
      timeoutMsg: "The PNG never loaded in the Files panel.",
    });
    expect(await loadedImage()).toEqual({ width: 2, height: 1 });
    await expect(browser.$(`${fileViewSelector} [data-file-media-toolbar]`)).toHaveText(
      expect.stringContaining("2 × 1"),
    );
    await expect(browser.$(`${fileViewSelector} [data-file-media-notice]`)).not.toExist();
    await saveEvidence("files-binary-preview-png");

    // SVG: drawn as an image; its script did not run, and View source shows the markup.
    await openWorkspaceFile(fixtureFiles.svg);
    await browser.waitUntil(async () => (await loadedImage()) !== null, {
      timeoutMsg: "The SVG never loaded in the Files panel.",
    });
    expect(await browser.execute(() => "__svgScriptRan" in window)).toBe(false);
    await saveEvidence("files-binary-preview-svg");
    const viewSource = browser.$(`//button[normalize-space()="View source"]`);
    await viewSource.waitForDisplayed();
    await viewSource.click();
    await browser.$(mediaSurfaceSelector).waitForExist({ reverse: true });
    const showImage = browser.$('button[aria-label="Show SVG as image"]');
    await showImage.waitForDisplayed();
    await showImage.click();
    await browser.waitUntil(async () => (await loadedImage()) !== null, {
      timeoutMsg: "The SVG image did not come back after viewing its source.",
    });

    // PDF: embedded in the webview's own viewer from a blob: URL the app made.
    await openWorkspaceFile(fixtureFiles.pdf);
    const pdf = browser.$(`${fileViewSelector} embed[type="application/pdf"]`);
    await pdf.waitForExist({ timeoutMsg: "The PDF viewer never mounted." });
    expect(await pdf.getAttribute("src")).toMatch(/^blob:/);
    await expect(browser.$(`${fileViewSelector} [data-file-media-notice]`)).not.toExist();
    await saveEvidence("files-binary-preview-pdf");

    // Audio: the native player decodes the blob, so its metadata loads.
    await openWorkspaceFile(fixtureFiles.wav);
    const audio = browser.$(`${fileViewSelector} audio[controls]`);
    await audio.waitForExist({ timeoutMsg: "The audio player never mounted." });
    expect(await audio.getAttribute("src")).toMatch(/^blob:/);
    await browser.waitUntil(
      () =>
        browser.execute((selector: string) => {
          const element = document.querySelector<HTMLAudioElement>(selector);
          return !!element && element.error === null && element.readyState >= 1;
        }, `${fileViewSelector} audio[controls]`),
      { timeoutMsg: "The audio player never loaded the file's metadata." },
    );
    await expect(browser.$(`${fileViewSelector} [data-file-media-notice]`)).not.toExist();

    // None of the previews tripped the page's content security policy.
    expect(await securityPolicyViolations()).toEqual([]);
  });
});
