// @effect-diagnostics nodeBuiltinImport:off - Manual real-provider run writes an evidence file and screenshots.
// @effect-diagnostics globalDate:off - Waits for the real Claude CLI against wall-clock deadlines.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ensureMainSidebarOpen, mockDesktopUiFolderPicker } from "../../support/ui-state.ts";

/**
 * Claude approvals against the installed Claude Code (#383). Not in the default suite: it runs
 * the machine's own `claude` and its sign-in, so it spends a little of that account. Set
 * `BIBCODE_E2E_REAL_PROVIDERS=1` and `BIBCODE_E2E_REAL_PROJECT=<a disposable Git folder>`, then
 * `BIBCODE_E2E_SPEC=./specs/manual/claude-approval-real-provider.e2e.ts`.
 *
 * It writes what it saw to `real-claude-approval-evidence.txt`: a Supervised Claude chat asks
 * before a command, "Always allow this session" runs it, and the same command then runs again
 * with no card and no settings file.
 */
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const realProject = process.env.BIBCODE_E2E_REAL_PROJECT;
if (!artifactDirectory || !realProject) {
  throw new Error("BIBCODE_E2E_ARTIFACT_DIR and BIBCODE_E2E_REAL_PROJECT are required.");
}
const evidencePath = NodePath.join(artifactDirectory, "real-claude-approval-evidence.txt");
const probeFile = NodePath.join(realProject, "bibcode-approval-probe.txt");
const settingsFile = NodePath.join(realProject, ".claude", "settings.local.json");
const COMMAND = "touch bibcode-approval-probe.txt";
const PROMPT = `Run exactly this shell command with the Bash tool and nothing else: ${COMMAND}`;
const SESSION_BUTTON = '//button[normalize-space()="Always allow this session"]';
let surface = '[data-center-surface-host][data-visible="true"]';

function note(line: string): void {
  NodeFS.appendFileSync(evidencePath, `${line}\n`);
}

async function shot(name: string): Promise<void> {
  await browser.saveScreenshot(
    NodePath.join(artifactDirectory!, `real-claude-approval-${name}.png`),
  );
}

/** The first script after a launch can time out while the webview is still starting. */
async function awaitWebview(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await browser.execute(() => window.location.origin);
      return;
    } catch {
      await browser.pause(5_000);
    }
  }
}

async function importProject(): Promise<void> {
  await awaitWebview();
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/`);
  await ensureMainSidebarOpen();
  const loading = browser.$("//*[normalize-space()='Project data is still loading']");
  await browser.pause(1_000);
  if (await loading.isExisting()) {
    await loading.waitForDisplayed({ reverse: true, timeout: 60_000 });
  }
  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await addProject.waitForDisplayed();
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(realProject!);
  await browseFolder.click();
  const thread = browser.$('//*[@data-thread-item="true"]');
  await thread.waitForDisplayed({ timeout: 60_000 });
  await thread.click();
  await browser.pause(2_000);
}

async function selectedTabId(): Promise<string> {
  const id = await browser
    .$('//*[@data-center-panel-tab-id][.//*[@role="tab"][@aria-selected="true"]]')
    .getAttribute("data-center-panel-tab-id");
  if (!id) throw new Error("No selected center panel tab.");
  return id;
}

async function newClaudeChat(): Promise<void> {
  const before = await selectedTabId();
  const trigger = browser.$('button[aria-label="New panel"]');
  await trigger.waitForDisplayed();
  await trigger.click();
  const item = browser.$('//*[@role="menuitem"][.//span[normalize-space()="Claude"]]');
  await item.waitForDisplayed();
  await item.click();
  await browser.waitUntil(async () => (await selectedTabId()) !== before, {
    timeout: 30_000,
    timeoutMsg: "The Claude panel did not open.",
  });
  surface = `[data-center-surface-host="${await selectedTabId()}"]`;
}

const composerForm = () => browser.$(`${surface} [data-chat-composer-form="true"]`);

/** Switches the chat to Supervised, where Claude asks before commands. */
async function chooseSupervised(): Promise<void> {
  const form = composerForm();
  await form.waitForDisplayed({ timeout: 30_000 });
  if (await form.$('[aria-label="Supervised"]').isExisting()) return;
  const trigger = form.$('[aria-label="Full access"], [aria-label="Auto-accept edits"]');
  await trigger.waitForDisplayed();
  await trigger.click();
  const option = browser.$('//*[@role="option"][.//*[normalize-space()="Supervised"]]');
  await option.waitForDisplayed();
  await option.click();
  await form.$('[aria-label="Supervised"]').waitForExist({ timeout: 10_000 });
}

async function submitPrompt(text: string): Promise<void> {
  const editor = composerForm().$('[data-testid="composer-editor"]');
  await editor.waitForDisplayed({ timeout: 30_000 });
  await editor.click();
  await editor.addValue(text);
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await editor.getText()).trim() === "", {
    timeoutMsg: "The composer kept the prompt after Enter.",
  });
}

/** Waits for the probe file, reporting whether an approval card showed while waiting. */
async function waitForCommand(maxMs: number): Promise<{ ran: boolean; cardSeen: boolean }> {
  const deadline = Date.now() + maxMs;
  let cardSeen = false;
  while (Date.now() < deadline) {
    cardSeen ||= await browser.$(SESSION_BUTTON).isExisting();
    if (NodeFS.existsSync(probeFile)) return { ran: true, cardSeen };
    await browser.pause(2_000);
  }
  return { ran: false, cardSeen };
}

/** Claude's question opens the question card, and the chosen answer reaches Claude. */
async function questionStep(): Promise<void> {
  await submitPrompt(
    "Use the AskUserQuestion tool to ask me whether I prefer red or blue, with exactly those two options. Then tell me in one short sentence which one I chose.",
  );
  const option = composerForm().$('//button[.//*[normalize-space()="Blue"]]');
  await option.waitForDisplayed({
    timeout: 180_000,
    timeoutMsg: "No question card with a Blue option opened.",
  });
  await shot("question-card");
  note(`question card: ${(await composerForm().getText()).replaceAll(/\s+/g, " ").slice(0, 200)}`);
  await option.click();
  await option.waitForExist({ reverse: true, timeout: 30_000 });
  // Claude read the answer when its reply names the chosen option. The prompt names both
  // colors, so the check reads what follows the last "Worked for" row.
  await browser.waitUntil(
    async () => {
      const text = await browser.$(surface).getText();
      return /blue/i.test(text.slice(text.lastIndexOf("Worked for")));
    },
    { timeout: 120_000, timeoutMsg: "Claude's reply did not name the chosen answer." },
  );
  note("the question card closed and Claude's reply names the chosen answer");
  await shot("question-answered");
}

/** Plan review stays in BiBCode: the plan shows, no approval card opens, the turn ends. */
async function planStep(): Promise<void> {
  await browser.pause(20_000);
  const planToggle = composerForm().$('[aria-label="Enable plan mode"]');
  await planToggle.waitForDisplayed({ timeout: 30_000 });
  await planToggle.click();
  await composerForm().$('[aria-label="Disable plan mode"]').waitForExist({ timeout: 10_000 });
  await submitPrompt(
    "Plan how to create a file named hello.txt with one line of text. Keep the plan to two steps and do not ask questions.",
  );
  let cardSeen = false;
  const deadline = Date.now() + 240_000;
  let settled = false;
  while (Date.now() < deadline) {
    cardSeen ||= await browser.$(SESSION_BUTTON).isExisting();
    const text = await browser.$(surface).getText();
    const running = await composerForm().$('button[aria-label="Stop generation"]').isExisting();
    if (/hello\.txt/.test(text.slice(-1_500)) && !running && Date.now() > deadline - 200_000) {
      settled = true;
      break;
    }
    await browser.pause(5_000);
  }
  await shot("plan");
  note(`plan turn settled: ${settled}; approval card seen: ${cardSeen}`);
  note(
    `plan text tail: ${(await browser.$(surface).getText()).replaceAll(/\s+/g, " ").slice(-400)}`,
  );
  expect(cardSeen).toBe(false);
  expect(settled).toBe(true);
  expect(NodeFS.existsSync(NodePath.join(realProject!, "hello.txt"))).toBe(false);
}

describe("real Claude approvals (#383)", function () {
  this.timeout(1_500_000);

  it("asks once, honors the session approval, shows a question and keeps plan review", async function () {
    NodeFS.writeFileSync(evidencePath, "");
    NodeFS.rmSync(probeFile, { force: true });
    const settingsBefore = NodeFS.existsSync(settingsFile);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await importProject();
        break;
      } catch (error) {
        note(`import attempt ${attempt} failed: ${String(error).split("\n")[0]}`);
        if (attempt >= 3) throw error;
        await browser.pause(10_000);
      }
    }
    await newClaudeChat();
    await chooseSupervised();
    await shot("supervised");

    // A warm-up turn. The composer adds the chat's default options to the second message, which
    // restarts the Claude process, and a session approval ends with its process. After this turn
    // the options are settled, so both commands below run in one process.
    await submitPrompt("Reply with the single word: ok");
    await browser.pause(45_000);
    note("warm-up turn sent");

    // First command: Claude asks, and the card names the command.
    await submitPrompt(PROMPT);
    const sessionButton = browser.$(SESSION_BUTTON);
    await sessionButton.waitForDisplayed({
      timeout: 180_000,
      timeoutMsg: "No approval card opened for the first command.",
    });
    const cardText = (await composerForm().getText()).replaceAll(/\s+/g, " ");
    const placeholder = await composerForm()
      .$('[data-testid="composer-editor"]')
      .getAttribute("aria-placeholder");
    note(`card opened; composer text: ${cardText.slice(0, 300)}`);
    note(`card detail: ${placeholder ?? "(none)"}`);
    await shot("card-open");
    expect(NodeFS.existsSync(probeFile)).toBe(false);
    await sessionButton.click();
    const first = await waitForCommand(120_000);
    note(`first command ran after the session approval: ${first.ran}`);
    expect(first.ran).toBe(true);
    await sessionButton.waitForExist({ reverse: true, timeout: 30_000 });
    note("the card closed after the approval");
    await shot("after-approval");

    // Let the turn finish, then repeat the same command: no card this time.
    await browser.pause(30_000);
    NodeFS.rmSync(probeFile, { force: true });
    await submitPrompt(PROMPT);
    const second = await waitForCommand(180_000);
    note(`second command ran: ${second.ran}; approval card seen: ${second.cardSeen}`);
    await shot("second-command");
    expect(second.ran).toBe(true);
    expect(second.cardSeen).toBe(false);

    const settingsAfter = NodeFS.existsSync(settingsFile);
    note(`settings.local.json existed before: ${settingsBefore}; after: ${settingsAfter}`);
    expect(settingsAfter).toBe(settingsBefore);
    NodeFS.rmSync(probeFile, { force: true });

    // The harness reloads the document between tests, so the question and the plan run here,
    // in the same chat.
    await browser.pause(20_000);
    await questionStep();
    await planStep();
  });
});
