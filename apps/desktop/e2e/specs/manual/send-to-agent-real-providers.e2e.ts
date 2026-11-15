// @effect-diagnostics nodeBuiltinImport:off - Manual real-provider run writes an evidence file and screenshots.
// @effect-diagnostics globalDate:off - Waits for real provider CLIs against wall-clock deadlines.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ensureMainSidebarOpen, mockDesktopUiFolderPicker } from "../../support/ui-state.ts";

/**
 * Not in the default suite: it runs the machine's own provider CLIs and sign-ins, so it spends
 * a little of the signed-in accounts. Set `BIBCODE_E2E_REAL_PROVIDERS=1`,
 * `BIBCODE_E2E_AGENT_MESSAGING=1`, `BIBCODE_E2E_PROVIDER=claude|codex|opencode` and
 * `BIBCODE_E2E_REAL_PROJECT=<an existing Git folder>`, optionally `BIBCODE_E2E_STEPS=1,2,3`, then
 * `BIBCODE_E2E_SPEC=./specs/manual/send-to-agent-real-providers.e2e.ts`.
 *
 * Every step writes what it saw to `real-<provider>-evidence.txt` and keeps going on a failed
 * step, so one run reports each step as observed or not.
 */
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const realProject = process.env.BIBCODE_E2E_REAL_PROJECT;
if (!artifactDirectory || !realProject) {
  throw new Error("BIBCODE_E2E_ARTIFACT_DIR and BIBCODE_E2E_REAL_PROJECT are required.");
}
const provider = (process.env.BIBCODE_E2E_PROVIDER ?? "claude") as "claude" | "codex" | "opencode";
const terminalLabel = {
  claude: "Claude Terminal",
  codex: "Codex Terminal",
  opencode: "OpenCode Terminal",
}[provider];
const steps = new Set(
  (process.env.BIBCODE_E2E_STEPS ?? "1,2,3,4").split(",").map((step) => step.trim()),
);
const evidencePath = NodePath.join(artifactDirectory, `real-${provider}-evidence.txt`);
const anyVisibleSurface = '[data-center-surface-host][data-visible="true"]';
/** The surface host of the panel the run is working in; several hosts can be visible at once. */
let visibleSurface = anyVisibleSurface;
const POINTER = "you have new messages";

function note(line: string): void {
  NodeFS.appendFileSync(evidencePath, `${line}\n`);
}

async function shot(name: string): Promise<void> {
  await browser.saveScreenshot(NodePath.join(artifactDirectory!, `real-${provider}-${name}.png`));
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

function chatTab(tabId: string) {
  return browser.$(`[data-center-panel-tab-id="${tabId}"] [role="tab"]`);
}

async function activate(tabId: string): Promise<void> {
  await chatTab(tabId).click();
  visibleSurface = `[data-center-surface-host="${tabId}"]`;
  await browser.$(visibleSurface).waitForDisplayed({ timeout: 15_000 });
}

async function newPanel(label: string): Promise<string> {
  const before = await selectedTabId();
  const trigger = browser.$('button[aria-label="New panel"]');
  await trigger.waitForDisplayed();
  await trigger.click();
  const item = browser.$(`//*[@role="menuitem"][.//span[normalize-space()="${label}"]]`);
  await item.waitForDisplayed();
  await item.click();
  await browser.waitUntil(async () => (await selectedTabId()) !== before, {
    timeout: 30_000,
    timeoutMsg: `The ${label} panel did not open.`,
  });
  const tabId = await selectedTabId();
  visibleSurface = `[data-center-surface-host="${tabId}"]`;
  return tabId;
}

async function terminalTab(): Promise<{ tabId: string; terminalId: string }> {
  await newPanel(terminalLabel);
  const mount = browser.$("[data-terminal-xterm-mount]");
  await mount.waitForExist({ timeout: 30_000 });
  const terminalId = (await mount.getAttribute("data-terminal-xterm-mount")) ?? "";
  return { tabId: await selectedTabId(), terminalId };
}

/** The rows xterm draws for the visible terminal (the WebGL renderer is off in this run). */
async function terminalScreen(): Promise<string> {
  return browser.execute(
    (surfaceSelector: string) =>
      document.querySelector(`${surfaceSelector} .xterm-rows`)?.textContent ?? "",
    visibleSurface,
  );
}

function composerEditor() {
  return browser
    .$(`${visibleSurface} [data-chat-composer-form="true"]`)
    .$('[data-testid="composer-editor"]');
}

async function submitPrompt(text: string): Promise<void> {
  const editor = composerEditor();
  await editor.waitForDisplayed({ timeout: 30_000 });
  await editor.click();
  await editor.addValue(text);
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await editor.getText()).trim() === "", {
    timeoutMsg: "The composer kept the prompt after Enter.",
  });
}

/**
 * Waits until the visible chat's text stops changing for 25 s, at most `maxMs`. A running turn's
 * Stop button can outlive its answer, so the text is the signal.
 */
async function waitForTurn(maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = "";
  let stableSince = Date.now();
  await browser.pause(15_000);
  while (Date.now() < deadline) {
    const text = await chatText();
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 25_000) return;
    await browser.pause(5_000);
  }
}

async function chatText(): Promise<string> {
  return browser.$(visibleSurface).getText();
}

async function sendControl() {
  const control = browser.$(`${visibleSurface} button[aria-label^="Send to agent"]`);
  await control.waitForDisplayed({ timeout: 30_000 });
  await browser.waitUntil(async () => (await control.getAttribute("aria-disabled")) !== "true");
  return control;
}

async function openAction(action: string): Promise<void> {
  const control = await sendControl();
  await control.click();
  const actionItem = browser.$(`//*[@role="menuitem"][normalize-space()="${action}"]`);
  await actionItem.waitForDisplayed();
  await actionItem.click();
}

async function targetNames(): Promise<string[]> {
  const items = await browser.$$('[role="menuitem"]');
  const names: string[] = [];
  for (const item of items) names.push((await item.getText()).replaceAll("\n", " | "));
  return names;
}

const previewDialog = () => browser.$('//*[@role="dialog"][.//button[normalize-space()="Send"]]');

async function step(name: string, id: string, body: () => Promise<void>): Promise<void> {
  if (!steps.has(id)) return;
  note(`== ${name}`);
  try {
    await body();
  } catch (error) {
    note(`FAILED: ${String(error).split("\n")[0]}`);
    await shot(`step${id}-failure`).catch(() => undefined);
  }
}

let senderTab = "";
let terminal = { tabId: "", terminalId: "" };

describe(`real ${provider}`, function () {
  this.timeout(1_800_000);
  it("opens the project, the AI Terminal and a Claude sender chat", async function () {
    this.timeout(1_500_000);
    NodeFS.writeFileSync(evidencePath, "");
    await importProject();
    terminal = await terminalTab();
    // A fresh CLI needs a moment before it waits for a prompt.
    await browser.pause(provider === "claude" ? 25_000 : 12_000);
    await shot("terminal-ready");
    note(
      `terminal screen after start: ${(await terminalScreen()).replaceAll(/\s+/g, " ").slice(0, 300)}`,
    );
    // Codex asks before running hooks and about a model change. Trusting or switching would change
    // Codex's own configuration, so the run only skips each question and records that it was asked.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const screen = await terminalScreen();
      if (!/Hooks need review|no longer available|enter\/esc continue/.test(screen)) break;
      note(
        `start-up question skipped with Escape: ${screen.replaceAll(/\s+/g, " ").slice(0, 160)}`,
      );
      await browser.$(`${visibleSurface} .xterm-helper-textarea`).addValue("");
      await browser.keys("Escape");
      await browser.pause(5_000);
    }
    // A fresh agent is not ready for a pointer before its first end-of-turn signal, so the person
    // gives it one tiny prompt first.
    await browser.$(`${visibleSurface} .xterm-helper-textarea`).addValue("Reply with the word ok.");
    // Codex's input takes the driver's Enter as a new line; Return submits in every CLI.
    await browser.keys("Return");
    await browser.pause(provider === "claude" ? 60_000 : 45_000);
    await shot("first-turn");
    note(
      `terminal screen after the first prompt: ${(await terminalScreen()).replaceAll(/\s+/g, " ").slice(-500)}`,
    );
    senderTab = await newPanel("Claude");
    await shot("sender-open");
  });

  it("1. an agent message reaches the terminal's agent", async function () {
    this.timeout(1_500_000);
    await step("1 agent message to the terminal", "1", async () => {
      await activate(senderTab);
      const started = Date.now();
      await submitPrompt(
        'Use the agents_list tool, find the AI terminal agent (its address starts with "terminal:"), then call agent_message_send once to it with the text "BiBCode check: reply with the word ok, using bibcode agent reply". Do not wait for a reply. Then print the message id on its own line.',
      );
      await waitForTurn(240_000);
      await shot("1-sender-sent");
      note(`sender turn finished after ${Math.round((Date.now() - started) / 1_000)}s`);
      note(`sender text tail: ${(await chatText()).replaceAll(/\s+/g, " ").slice(-500)}`);
      await activate(terminal.tabId);
      let pointerAt = -1;
      let replyAt = -1;
      for (let waited = 0; waited < 240; waited += 10) {
        const screen = await terminalScreen();
        if (pointerAt < 0 && screen.includes(POINTER)) pointerAt = waited;
        if (pointerAt >= 0 && replyAt < 0 && /bibcode agent reply/.test(screen)) replyAt = waited;
        if (replyAt >= 0) break;
        await browser.pause(10_000);
      }
      note(
        `pointer line seen in the terminal after ~${pointerAt}s of polling; reply command after ~${replyAt}s`,
      );
      await shot("1-terminal-after");
      note(`terminal screen: ${(await terminalScreen()).replaceAll(/\s+/g, " ").slice(-700)}`);
      // The reply starts a new turn in the sender.
      await browser.pause(20_000);
      await activate(senderTab);
      await waitForTurn(240_000).catch(() => undefined);
      await shot("1-sender-after-reply");
      note(`sender text after reply: ${(await chatText()).replaceAll(/\s+/g, " ").slice(-700)}`);
      await submitPrompt(
        "Call agent_message_status for the message you sent and print only its status and reason.",
      );
      await waitForTurn(240_000);
      note(`status answer: ${(await chatText()).replaceAll(/\s+/g, " ").slice(-300)}`);
    });
  });

  it("2. a person's Second opinion to the terminal is answered", async function () {
    this.timeout(1_500_000);
    await step("2 person request to the terminal", "2", async () => {
      await activate(senderTab);
      await openAction("Second opinion");
      note(`second opinion targets: ${(await targetNames()).join(" ; ")}`);
      // The terminal is an existing agent, listed before the new-panel entries.
      const plain = new Set([
        "Review",
        "Second opinion",
        "Hand off",
        "Take over from",
        "Message",
        "Codex",
        "Claude",
        "Cursor",
        "OpenCode",
      ]);
      let clicked = false;
      for (const item of await browser.$$('[role="menuitem"]')) {
        const text = (await item.getText()).trim();
        if (plain.has(text) || text.includes("cannot be notified")) continue;
        note(`second opinion target picked: ${text.replaceAll("\n", " | ")}`);
        await item.click();
        clicked = true;
        break;
      }
      if (!clicked) throw new Error("No existing agent target was offered.");
      const dialog = previewDialog();
      await dialog.waitForDisplayed();
      note(`preview: ${(await dialog.getText()).replaceAll(/\s+/g, " ").slice(0, 400)}`);
      await dialog.$("textarea").addValue("Reply with the word ok.");
      await shot("2-preview");
      await dialog.$("button=Send").click();
      const seen = new Set<string>();
      for (let waited = 0; waited < 240; waited += 5) {
        for (const row of await browser.$$(`${visibleSurface} [data-send-request-state]`)) {
          const state = await row.getAttribute("data-send-request-state");
          if (state && !seen.has(state)) {
            seen.add(state);
            note(
              `request row state ${state} after ~${waited}s: ${(await row.getText()).replaceAll("\n", " ")}`,
            );
          }
        }
        if (seen.has("answered") || seen.has("not_answered")) break;
        await browser.pause(5_000);
      }
      await shot("2-answer-notice");
      const notice = browser.$(`${visibleSurface} [data-answer-notice]`);
      if (await notice.isExisting()) {
        await notice.$("button*=Bring back").click();
        await browser.pause(1_000);
        note(
          `bring back composer: ${(await composerEditor().getText()).replaceAll(/\s+/g, " ").slice(0, 300)}`,
        );
      } else {
        note("no answer notice");
      }
    });
  });

  it("3. the terminal as the source attaches its conversation", async function () {
    this.timeout(1_500_000);
    await step("3 terminal as source", "3", async () => {
      await activate(terminal.tabId);
      await browser.pause(1_000);
      for (const action of ["Second opinion", "Hand off"]) {
        await openAction(action);
        const target = browser.$(`//*[@role="menuitem"][normalize-space(.)="Claude"]`);
        await target.waitForDisplayed();
        await target.click();
        const dialog = previewDialog();
        await dialog.waitForDisplayed({ timeout: 30_000 });
        await browser.pause(3_000);
        note(
          `${action} preview from the terminal: ${(await dialog.getText()).replaceAll(/\s+/g, " ").slice(0, 700)}`,
        );
        await shot(`3-${action.replaceAll(" ", "-")}`);
        await dialog.$("button=Cancel").click();
        await dialog.waitForExist({ reverse: true });
      }
    });
  });
});
