// @effect-diagnostics nodeBuiltinImport:off - Packaged side chat tests read fixture logs and save screenshots.
// @effect-diagnostics globalDate:off - The standalone WDIO spec waits on a host-side fixture file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  readProviderInputLog,
  waitForProviderInputLogEntry,
} from "../support/provider-input-log.ts";
import { completeDesktopUiSlowTurn, desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop side chat fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const visibleComposerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const hostSurfaceSelector = '[data-center-surface-host="chat:host"]';
const SLOW_TURN_RELEASE_FILE = ".bibcode-e2e-slow-turn-release";

function composerForm() {
  return browser.$(visibleComposerFormSelector);
}
function composerEditor() {
  return composerForm().$('[data-testid="composer-editor"]');
}

async function waitForComposerDisplayed(): Promise<void> {
  const form = browser.$(visibleComposerFormSelector);
  await form.waitForExist();
  await form.waitForDisplayed();
  await form.$('[data-testid="composer-editor"]').waitForDisplayed();
}

async function ensureFixtureProjectImported(): Promise<void> {
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/`);
  await ensureMainSidebarOpen();
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const hasVisibleProject = async () => {
    for (const candidate of await browser.$$(projectSelector)) {
      if (await candidate.isDisplayed()) return true;
    }
    return false;
  };
  if (await hasVisibleProject()) {
    return;
  }

  const projectDataLoading = browser.$("//*[normalize-space()='Project data is still loading']");
  if (await projectDataLoading.isExisting()) {
    await projectDataLoading.waitForDisplayed({
      reverse: true,
      timeoutMsg: "The primary project catalog did not become ready for fixture import.",
    });
  }

  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await expect(addProject).toBeDisplayed();
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(preparedProjectPath);
  await browseFolder.click();
  await browser.waitUntil(hasVisibleProject, {
    timeoutMsg: "The imported fixture project did not become visible in the main sidebar.",
  });
}

async function openInitialCodexThread(): Promise<void> {
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    let projectClicked = false;
    for (const project of await browser.$$(projectSelector)) {
      if (await project.isDisplayed()) {
        await project.click();
        projectClicked = true;
        break;
      }
    }
    expect(projectClicked).toBe(true);
    await primaryWorkspace.waitForDisplayed();
  }
  await primaryWorkspace.click();
  await waitForComposerDisplayed();
}

async function replaceComposerText(text: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await browser.execute(() => {
    const editor = document.activeElement;
    if (!(editor instanceof HTMLElement) || editor.dataset.testid !== "composer-editor") {
      throw new Error("The composer editor did not receive focus.");
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await browser.keys("Backspace");
  await editor.addValue(text);
  await expect(editor).toHaveText(text);
}

async function submitWithEnter(text: string): Promise<void> {
  await replaceComposerText(text);
  await browser.keys("Enter");
  await expect(composerEditor()).toHaveText("");
}

/** Releases one slow fixture turn and waits until its provider consumed the release. */
async function releaseSlowTurn(turnId: string): Promise<void> {
  completeDesktopUiSlowTurn(preparedProjectPath, turnId);
  const release = NodePath.join(preparedProjectPath, SLOW_TURN_RELEASE_FILE);
  await browser.waitUntil(() => !NodeFS.existsSync(release), {
    timeoutMsg: `The fixture provider did not release slow turn ${turnId}.`,
  });
}

describe("packaged side chat", () => {
  it("opens a side chat with :btw while the host runs and leaves the host untouched", async () => {
    await ensureFixtureProjectImported();
    await openInitialCodexThread();
    await setDesktopUiWindowSize(1_100, 900);
    const baseline = readProviderInputLog(preparedProviderInputLogPath).length;
    const hostPrompt = "refactor the parser [[slow]]";
    const question = "why did you pick that file?";
    const slowTurnIds: string[] = [];
    try {
      await submitWithEnter(hostPrompt);
      const hostStart = await waitForProviderInputLogEntry(preparedProviderInputLogPath, baseline, {
        provider: "codex",
        prompt: hostPrompt,
        kind: "start",
      });
      slowTurnIds.push(hostStart.turnId!);
      await expect(composerForm().$('button[aria-label="Stop generation"]')).toBeDisplayed();

      // The host is running: `:btw` opens a side chat instead of queueing or steering.
      await submitWithEnter(`:btw ${question}`);
      const sideTab = browser.$(
        '//button[@role="tab"][@aria-selected="true"][.//span[normalize-space()="Side chat · Codex"]]',
      );
      await sideTab.waitForDisplayed({ timeoutMsg: "The side chat tab did not open active." });

      let sideStart: { prompt: string; turnId?: string } | undefined;
      await browser.waitUntil(
        () => {
          sideStart = readProviderInputLog(preparedProviderInputLogPath)
            .slice(baseline)
            .find((entry) => entry.kind === "start" && entry.prompt.endsWith(question));
          return sideStart !== undefined;
        },
        { timeoutMsg: "The side chat's first turn did not reach its provider." },
      );
      // The host's slow marker is in the seed, so the side chat's turn is slow as well.
      slowTurnIds.push(sideStart!.turnId!);
      expect(sideStart!.prompt).toContain("<bibcode_thread_context>");
      expect(sideStart!.prompt).toContain("You are in a side chat beside a BiBCode thread.");
      expect(sideStart!.prompt).toContain(`[user] ${hostPrompt}`);
      expect(sideStart!.prompt).not.toContain(":btw");

      // The side chat replies in its own tab.
      await expect(browser.$(visibleSurfaceSelector)).toHaveText(
        expect.stringContaining(desktopUiFixture.streamedResponse),
      );
      await browser.saveScreenshot(NodePath.join(preparedArtifactDirectory, "side-chat-reply.png"));

      // The host got nothing: only its own turn reached its provider, its transcript has no
      // side chat text, and nothing is queued behind its running turn.
      const hostInputs = readProviderInputLog(preparedProviderInputLogPath)
        .slice(baseline)
        .filter((entry) => !entry.prompt.endsWith(question));
      expect(hostInputs.map(({ kind, prompt }) => ({ kind, prompt }))).toEqual([
        { kind: "start", prompt: hostPrompt },
      ]);
      const hostSurface = browser.$(hostSurfaceSelector);
      await expect(hostSurface).not.toHaveText(expect.stringContaining(question));
      await expect(hostSurface.$('[data-timeline-row-kind="queued-message"]')).not.toExist();

      await browser.$('[data-center-panel-tab-id="chat:host"] [role="tab"]').click();
      await waitForComposerDisplayed();
      await expect(composerEditor()).toHaveText("");
      await expect(composerForm().$('button[aria-label="Stop generation"]')).toBeDisplayed();
      await browser.saveScreenshot(
        NodePath.join(preparedArtifactDirectory, "side-chat-host-untouched.png"),
      );
    } finally {
      for (const turnId of slowTurnIds) await releaseSlowTurn(turnId);
    }
  });
});
