// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests save native screenshots.
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
  throw new Error("The packaged environment-navigation fixture was not prepared.");
}
const fixtureArtifactDirectory = artifactDirectory;
const fixtureProjectPath = projectPath;

export const requiredEnvironmentNavigationVisualStates = [
  "first-run",
  "several-online",
  "wsl-setup-required",
  "wsl-stopped",
  "connecting",
  "reconnecting",
  "offline-full-cache",
  "offline-metadata-only",
  "offline-no-cache",
  "authentication-required",
  "version-incompatible",
  "updating",
  "identity-mismatch",
  "duplicate-add",
  "search",
  "hidden-restoration",
  "online-removal",
  "offline-force-removal",
  "narrow-layout",
  "reduced-motion",
  "large-tree",
] as const;

type EnvironmentNavigationVisualState = (typeof requiredEnvironmentNavigationVisualStates)[number];

function visualStateFromEnvironment(
  value: string | undefined,
): EnvironmentNavigationVisualState | null {
  const normalized = value?.trim() ?? "";
  return requiredEnvironmentNavigationVisualStates.find((state) => state === normalized) ?? null;
}

async function waitForEnvironmentTree() {
  const tree = browser.$('[role="tree"][aria-label="Environments, projects, and threads"]');
  await tree.waitForDisplayed();
  await browser.waitUntil(
    async () => (await (await tree.$$('[role="treeitem"][aria-level="1"]')).length) > 0,
    { timeoutMsg: "The primary environment row did not become available." },
  );
  return tree;
}

async function ensureFixtureProject(): Promise<void> {
  const existing = browser.$(`//*[normalize-space()="${desktopUiFixture.projectName}"]`);
  if (await existing.isExisting()) return;

  const primaryEnvironment = browser.$('[role="treeitem"][aria-level="1"]');
  await browser.waitUntil(
    async () =>
      (await primaryEnvironment.getAttribute("aria-label"))?.endsWith(", Online") ?? false,
    {
      timeoutMsg: "The primary environment did not become writable before Add Project.",
    },
  );

  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await addProject.click();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(fixtureProjectPath);
  await browseFolder.click();
  await existing.waitForDisplayed();
}

async function auditNavigationOnlySidebar(): Promise<void> {
  const finding = await browser.execute(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
    return {
      treeCount: sidebar?.querySelectorAll('[role="tree"]').length ?? 0,
      tablistCount: sidebar?.querySelectorAll('[role="tablist"]').length ?? 0,
      detailPanelCount:
        sidebar?.querySelectorAll(
          '[aria-label="Environment workspace"], [aria-label="Environment removal workspace"]',
        ).length ?? 0,
    };
  });
  expect(finding).toEqual({ treeCount: 1, tablistCount: 0, detailPanelCount: 0 });
}

describe("packaged environment-owned navigation", () => {
  it("captures the first-run environment hierarchy without left-panel detail surfaces", async () => {
    await ensureMainSidebarOpen();
    const tree = await waitForEnvironmentTree();
    await expect(tree).toBeDisplayed();
    await auditNavigationOnlySidebar();
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, "environment-navigation-first-run.png"),
    );
  });

  it("renders Environment -> Project -> Main and keeps search ancestry", async () => {
    await ensureMainSidebarOpen();
    await ensureFixtureProject();
    const tree = await waitForEnvironmentTree();
    const rows = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((row) => ({
        level: row.getAttribute("aria-level"),
        label: row.getAttribute("aria-label"),
      })),
    );
    expect(rows.some((row) => row.level === "1" && row.label?.startsWith("Environment "))).toBe(
      true,
    );
    expect(rows.some((row) => row.level === "2" && row.label?.startsWith("Project "))).toBe(true);
    expect(rows.some((row) => row.level === "3" && row.label?.includes("Main"))).toBe(true);

    const search = browser.$('input[aria-label="Search environments, projects, and threads"]');
    await search.setValue(desktopUiFixture.projectName);
    await browser.waitUntil(
      async () => (await (await tree.$$('[role="treeitem"][aria-level="2"]')).length) > 0,
      { timeoutMsg: "Search removed the matching project's environment ancestry." },
    );
    await expect(tree.$('[role="treeitem"][aria-level="1"]')).toBeDisplayed();
    await expect(tree.$('[role="treeitem"][aria-level="2"]')).toBeDisplayed();
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, "environment-navigation-search.png"),
    );
    await search.clearValue();
  });

  it("opens environment settings in the center and exercises semantic tree keys", async () => {
    await ensureMainSidebarOpen();
    const tree = await waitForEnvironmentTree();
    const environmentRow = tree.$('[role="treeitem"][aria-level="1"]');
    await environmentRow.click();
    await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]');
      row?.focus();
      for (const key of ["ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"]) {
        row?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
    });

    const openEnvironment = tree.$('button[aria-label^="Open environment "]');
    await openEnvironment.click();
    await expect(browser.$('main[aria-label="Environment workspace"]')).toBeDisplayed();
    await expect(browser.$('[role="tablist"][aria-label="Environment sections"]')).toBeDisplayed();
    await auditNavigationOnlySidebar();
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, "environment-navigation-center-settings.png"),
    );
  });

  it("keeps safety copy visible at narrow width and 200 percent zoom", async () => {
    await ensureMainSidebarOpen();
    const environmentRowKey = await browser
      .$('[role="treeitem"][aria-level="1"]')
      .getAttribute("data-environment-tree-row");
    const environmentId = environmentRowKey?.replace(/^environment:/u, "");
    if (!environmentId) throw new Error("Could not resolve the fixture environment identity.");
    const appOrigin = await browser.execute(() => window.location.origin);
    await browser.url(`${appOrigin}/#/environments/${environmentId}/remove`);
    await expect(browser.$('main[aria-label="Environment removal workspace"]')).toBeDisplayed();
    await expect(
      browser.$("//*[normalize-space()='Primary environment is permanent']"),
    ).toBeDisplayed();

    await setDesktopUiWindowSize(800, 640);
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, "environment-navigation-narrow-layout.png"),
    );
    await browser.execute(() => {
      document.documentElement.style.zoom = "2";
    });
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, "environment-navigation-200-percent-zoom.png"),
    );
    await browser.execute(() => {
      document.documentElement.style.removeProperty("zoom");
    });
  });

  it("captures an externally prepared required visual state", async function () {
    const requested = visualStateFromEnvironment(process.env.BIBCODE_E2E_ENVIRONMENT_VISUAL_STATE);
    if (requested === null) {
      this.skip();
      return;
    }
    await ensureMainSidebarOpen();
    await waitForEnvironmentTree();
    await auditNavigationOnlySidebar();
    await browser.saveScreenshot(
      NodePath.join(fixtureArtifactDirectory, `environment-navigation-${requested}.png`),
    );
  });
});
