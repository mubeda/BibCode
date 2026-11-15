// @effect-diagnostics nodeBuiltinImport:off - Packaged send to agent tests read fixture logs and save screenshots.
// @effect-diagnostics globalDate:off - The standalone WDIO spec waits on host-side fixture files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { openFixtureCodexTerminal } from "../support/fixture-terminal.ts";
import { readProviderInputLog, type ProviderInputLogEntry } from "../support/provider-input-log.ts";
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
  throw new Error("The packaged desktop send to agent fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const visibleComposerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const sendControlSelector = `${visibleSurfaceSelector} button[aria-label^="Send to agent"]`;
const SLOW_TURN_RELEASE_FILE = ".bibcode-e2e-slow-turn-release";

// The second opinion's own note carries the Codex fixture's slow marker, so Codex stays on it.
const claudeNote = "check the parser";
const secondOpinionNote = "weigh in on the answer [[slow]]";
const queuedNote = "please look at the lexer too";
const terminalNote = "terminal asks about the grammar";

const providerInputs = (): ProviderInputLogEntry[] =>
  readProviderInputLog(preparedProviderInputLogPath);

function composerEditor() {
  return browser.$(visibleComposerFormSelector).$('[data-testid="composer-editor"]');
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
  if (await hasVisibleProject()) return;

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

/** The center panel tab with this id, as a clickable tab button. */
function chatTab(tabId: string) {
  return browser.$(`[data-center-panel-tab-id="${tabId}"] [role="tab"]`);
}

/** The Send to agent control of the visible panel, a chat or a terminal. */
async function sendControl() {
  const control = browser.$(sendControlSelector);
  await control.waitForDisplayed({ timeoutMsg: "The visible panel has no Send to agent control." });
  // The control is disabled until the server's capabilities have arrived.
  await browser.waitUntil(async () => (await control.getAttribute("aria-disabled")) !== "true", {
    timeoutMsg: "Send to agent stayed disabled.",
  });
  return control;
}

/** Opens the menu, then the action's submenu, then picks the agent or new panel with this name. */
async function chooseSendTarget(action: string, target: string): Promise<void> {
  const control = await sendControl();
  await control.click();
  const actionItem = browser.$(`//*[@role="menuitem"][normalize-space()="${action}"]`);
  await actionItem.waitForDisplayed({ timeoutMsg: `The ${action} action was not offered.` });
  await actionItem.click();
  const targetItem = browser.$(`//*[@role="menuitem"][.//span[normalize-space()="${target}"]]`);
  await targetItem.waitForDisplayed({ timeoutMsg: `${target} was not offered for ${action}.` });
  await targetItem.click();
}

function previewDialog() {
  return browser.$('[role="dialog"]');
}

/** Types the note in the open preview and presses Send. */
async function sendFromPreview(note: string): Promise<void> {
  const dialog = previewDialog();
  await dialog.waitForDisplayed({ timeoutMsg: "The send preview did not open." });
  if (note !== "") await dialog.$("textarea").addValue(note);
  const send = dialog.$("button=Send");
  await send.waitForEnabled({ timeoutMsg: "Send stayed disabled in the preview." });
  await send.click();
  await dialog.waitForExist({ reverse: true, timeoutMsg: "The preview stayed open after Send." });
}

function requestRows() {
  return browser.$$(`${visibleSurfaceSelector} [data-send-request-state]`);
}

function requestRow(state: string) {
  return browser.$(`${visibleSurfaceSelector} [data-send-request-state="${state}"]`);
}

async function releaseSlowTurn(turnId: string): Promise<void> {
  completeDesktopUiSlowTurn(preparedProjectPath, turnId);
  const release = NodePath.join(preparedProjectPath, SLOW_TURN_RELEASE_FILE);
  await browser.waitUntil(() => !NodeFS.existsSync(release), {
    timeoutMsg: `The fixture provider did not release slow turn ${turnId}.`,
  });
}

/** Starts a slow Codex turn in the open `main` thread and returns its turn id. */
async function startSlowMainTurn(prompt: string): Promise<string> {
  const baseline = providerInputs().length;
  await submitWithEnter(prompt);
  let turnId: string | undefined;
  await browser.waitUntil(
    () => {
      turnId = providerInputs()
        .slice(baseline)
        .find((entry) => entry.provider === "codex" && entry.prompt === prompt)?.turnId;
      return turnId !== undefined;
    },
    { timeoutMsg: `The slow Codex turn "${prompt}" did not start.` },
  );
  return turnId!;
}

/** Waits for a provider input of this provider whose prompt contains every part. */
async function waitForProviderPrompt(
  baseline: number,
  provider: ProviderInputLogEntry["provider"],
  parts: ReadonlyArray<string>,
): Promise<ProviderInputLogEntry> {
  let found: ProviderInputLogEntry | undefined;
  await browser.waitUntil(
    () => {
      found = providerInputs()
        .slice(baseline)
        .find(
          (entry) =>
            entry.provider === provider && parts.every((part) => entry.prompt.includes(part)),
        );
      return found !== undefined;
    },
    {
      timeoutMsg: `No ${provider} input containing ${JSON.stringify(parts)} reached its provider.`,
    },
  );
  return found!;
}

describe("packaged send to agent", () => {
  // Agent messaging stays off (its default): a person's own Send to agent works either way.
  let claudeTabId = "";
  const slowTurnIds: string[] = [];

  after(() => {
    // Each write replaces the one release file, so only a turn still running needs it.
    const last = slowTurnIds.at(-1);
    if (last !== undefined) completeDesktopUiSlowTurn(preparedProjectPath, last);
  });

  it("a message reaches a new Claude panel and shows who sent it", async () => {
    await ensureFixtureProjectImported();
    await openInitialCodexThread();
    await setDesktopUiWindowSize(1_200, 900);
    const baseline = providerInputs().length;
    await chooseSendTarget("Message", "Claude");
    await sendFromPreview(claudeNote);
    const delivered = await waitForProviderPrompt(baseline, "claudeAgent", [claudeNote]);
    expect(delivered.kind).toBe("start");
    await browser.waitUntil(
      async () => (await browser.$(visibleSurfaceSelector).getText()).includes("sent from main"),
      { timeoutMsg: "The new panel did not label the message with where it was sent from." },
    );
    const label = await browser.$(`${visibleSurfaceSelector} [data-message-provenance]`).getText();
    expect(label).toBe("Message, sent from main");
    await expect(browser.$(visibleSurfaceSelector)).toHaveText(
      expect.stringContaining(desktopUiFixture.streamedResponse),
    );
    claudeTabId =
      (await browser
        .$('//*[@data-center-panel-tab-id][.//*[@role="tab"][@aria-selected="true"]]')
        .getAttribute("data-center-panel-tab-id")) ?? "";
    expect(claudeTabId).not.toBe("");
    expect(claudeTabId).not.toBe("chat:host");
  });

  it("a queued request can be cancelled and its target never receives it", async () => {
    await chatTab("chat:host").click();
    await waitForComposerDisplayed();
    slowTurnIds.push(await startSlowMainTurn("refactor the parser [[slow]]"));
    await chatTab(claudeTabId).click();
    await waitForComposerDisplayed();

    const baseline = providerInputs().length;
    await chooseSendTarget("Message", "main");
    await sendFromPreview(queuedNote);
    const queued = requestRow("queued");
    await queued.waitForDisplayed({ timeoutMsg: "The request row never showed Queued." });
    await expect(queued).toHaveText(expect.stringContaining("Queued for main"));
    await queued.$("button=Cancel").click();
    const cancelled = requestRow("cancelled");
    await cancelled.waitForDisplayed({ timeoutMsg: "Cancel did not mark the request cancelled." });
    await expect(cancelled.$("button=Dismiss")).toBeDisplayed();
    await expect(cancelled.$("button=Cancel")).not.toExist();

    await releaseSlowTurn(slowTurnIds.at(-1)!);
    // Nothing else reached Codex: its own slow turn started before this baseline.
    await browser.pause(1_000);
    const afterBaseline = providerInputs().slice(baseline);
    expect(afterBaseline.filter((entry) => entry.prompt.includes(queuedNote))).toEqual([]);
    await cancelled.$("button=Dismiss").click();
    await expect(requestRows()).toBeElementsArrayOfSize(0);
  });

  it("a second opinion that is read but unanswered offers no Dismiss", async () => {
    const baseline = providerInputs().length;
    await chooseSendTarget("Second opinion", "main");
    await sendFromPreview(secondOpinionNote);
    const entry = await waitForProviderPrompt(baseline, "codex", [secondOpinionNote]);
    slowTurnIds.push(entry.turnId!);
    const row = requestRow("read");
    await row.waitForDisplayed({ timeoutMsg: "The second opinion never showed as read." });
    await expect(row).toHaveText(expect.stringContaining("main read it"));
    await expect(row.$("button=Open")).toBeDisplayed();
    await expect(row.$("button=Dismiss")).not.toExist();
    await expect(row.$("button=Cancel")).not.toExist();
  });

  it("the answer notice survives a reload", async () => {
    await releaseSlowTurn(slowTurnIds.at(-1)!);
    const notice = browser.$(`${visibleSurfaceSelector} [data-answer-notice]`);
    await notice.waitForDisplayed({ timeoutMsg: "The answer notice did not appear." });
    await expect(notice).toHaveText(expect.stringContaining("main answered"));
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "send-to-agent-notice.png"),
    );

    await refreshDesktopUiDocument();
    await chatTab(claudeTabId).click();
    await waitForComposerDisplayed();
    await browser
      .$(`${visibleSurfaceSelector} [data-answer-notice]`)
      .waitForDisplayed({ timeoutMsg: "The answer notice did not survive the reload." });
  });

  it("Bring back drafts the quoted answer and sends nothing", async () => {
    const before = providerInputs().length;
    const notice = browser.$(`${visibleSurfaceSelector} [data-answer-notice]`);
    await notice.$("button*=Bring back").click();
    await expect(composerEditor()).toHaveText(
      expect.stringContaining(desktopUiFixture.streamedResponse),
    );
    await expect(notice).not.toExist();
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "send-to-agent-bring-back.png"),
    );
    await browser.pause(1_000);
    expect(providerInputs().length).toBe(before);
  });

  it("the terminal's requests sit in a popover and focus returns to Send to agent", async () => {
    await chatTab("chat:host").click();
    await waitForComposerDisplayed();
    slowTurnIds.push(await startSlowMainTurn("document the grammar [[slow]]"));
    await openFixtureCodexTerminal();

    await chooseSendTarget("Message", "main");
    await sendFromPreview(terminalNote);
    const requests = browser.$(`${visibleSurfaceSelector} button[aria-label^="Send requests"]`);
    await requests.waitForDisplayed({ timeoutMsg: "The terminal never showed Send requests." });
    await expect(requests).toHaveAttribute("aria-label", "Send requests, 1 request");
    await requests.click();
    const popoverRow = browser.$(
      '[role="dialog"] [data-send-request-state="queued"], [data-send-request-state="queued"]',
    );
    await popoverRow.waitForDisplayed({
      timeoutMsg: "The popover did not list the queued request.",
    });
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "send-to-agent-terminal-requests.png"),
    );
    await popoverRow.$("button=Cancel").click();
    const cancelled = browser.$('[data-send-request-state="cancelled"]');
    await cancelled.waitForDisplayed({ timeoutMsg: "The terminal request was not cancelled." });

    // Dismiss with the keyboard, so the focus that must come back is a keyboard user's.
    const dismiss = await cancelled.$("button=Dismiss");
    await browser.execute((element: HTMLElement) => element.focus(), dismiss);
    await browser.keys("Enter");
    await requests.waitForExist({
      reverse: true,
      timeoutMsg: "The button stayed after the last row.",
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement?.getAttribute("aria-label")?.startsWith("Send to agent") ===
              true &&
            document.activeElement.closest('[data-center-surface-host][data-visible="true"]') !==
              null,
        ),
      { timeoutMsg: "Keyboard focus did not return to Send to agent after the last row went." },
    );
    await releaseSlowTurn(slowTurnIds.at(-1)!);
  });
});
