// @effect-diagnostics nodeBuiltinImport:off - Packaged wiring check writes a probe script and reads its result file.
// @effect-diagnostics globalDate:off - The standalone WDIO spec waits on a host-side result file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { setDesktopAgentMessaging } from "../../support/activity-session.ts";
import {
  openFixtureCodexTerminal,
  openFixtureTerminalThread,
} from "../../support/fixture-terminal.ts";
import { readProviderInputLog } from "../../support/provider-input-log.ts";
import { completeDesktopUiSlowTurn } from "../../support/test-project.ts";
import { sendTerminalCommand } from "../../support/terminal-input.ts";

/**
 * Not in the default suite. Run it with `BIBCODE_E2E_AGENT_MESSAGING=1` and
 * `BIBCODE_E2E_SPEC=./specs/manual/agent-terminal-wiring.e2e.ts`.
 *
 * It makes the Codex executable a script that starts a shell for a terminal and hands every
 * other call to the fixture Codex. In the shell of a Codex Terminal (an AI Terminal) it records
 * whether the agent credential and endpoint are set (never their values), what `bibcode`
 * resolves to and whether `bibcode agent list` answers. Then it sends an agent message to a
 * chat that is busy with a slow turn and turns agent messaging off and on while the message is
 * queued.
 */
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const runRoot = process.env.BIBCODE_E2E_RUN_ROOT;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
const shimDirectory = process.env.BIBCODE_E2E_SHIM_DIRECTORY;
if (!artifactDirectory || !projectPath || !runRoot || !providerInputLogPath || !shimDirectory) {
  throw new Error("The packaged desktop fixture environment was not prepared.");
}
const result = NodePath.join(artifactDirectory, "agent-terminal-wiring.txt");
const script = NodePath.join(runRoot, "codex-shell");
const heldText = "held check";

const readResult = () => (NodeFS.existsSync(result) ? NodeFS.readFileSync(result, "utf8") : "");

const terminalTabSelector =
  '//*[@data-center-panel-tab-id][.//span[normalize-space()="Codex Terminal"]]//*[@role="tab"]';

/** Brings the terminal tab forward and waits for its input to exist. */
async function showTerminal(): Promise<void> {
  const tab = browser.$(terminalTabSelector);
  await tab.waitForDisplayed();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await browser.$(".xterm-helper-textarea").waitForExist({ timeout: 20_000 });
}

/** Runs a shell line in the terminal and waits for the marker it echoes last. */
async function shell(line: string, marker: string): Promise<string> {
  await showTerminal();
  await sendTerminalCommand(`${line}; echo "${marker}"`);
  await browser.waitUntil(() => readResult().includes(marker), {
    timeout: 30_000,
    timeoutMsg: `The terminal never wrote ${marker}.`,
  });
  return readResult();
}

describe("packaged AI terminal agent wiring", () => {
  let turnId = "";
  let messageId = "";

  it("opens a Codex Terminal whose shell is an AI Terminal, with the chat busy", async () => {
    NodeFS.writeFileSync(
      script,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *app-server*|*--version*|*--help*) exec '${NodePath.join(shimDirectory, "codex")}' "$@" ;;`,
        "esac",
        'exec "${SHELL:-/bin/sh}" -i',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    NodeFS.rmSync(result, { force: true });
    await openFixtureTerminalThread(projectPath, script);
    await openFixtureCodexTerminal();
    await sendTerminalCommand(`exec >> '${result}' 2>&1`);
    // The primary chat is the message's target. Its route is admitted when it first runs, after the
    // Codex executable was set, so a slow turn there keeps later messages queued.
    const primary = browser.$('//*[@data-thread-item="true"][.//span[normalize-space()="main"]]');
    await primary.waitForDisplayed();
    await primary.click();
    const baseline = readProviderInputLog(providerInputLogPath).length;
    const editor = browser.$('[data-testid="composer-editor"]');
    await editor.waitForDisplayed();
    await editor.click();
    await editor.addValue("hold the line [[slow]]");
    await browser.keys("Enter");
    await browser.waitUntil(
      () => {
        const entry = readProviderInputLog(providerInputLogPath)
          .slice(baseline)
          .find((candidate) => candidate.prompt.includes("hold the line"));
        if (entry?.turnId !== undefined) turnId = entry.turnId;
        return turnId !== "";
      },
      { timeoutMsg: "The chat's slow turn did not start." },
    );
    // Back to the terminal's own thread and its terminal tab.
    const owner = browser.$(
      '//*[@data-thread-item="true"][.//*[normalize-space()="Activity acceptance fixture"]]',
    );
    await owner.click();
    const tab = browser.$(
      '//*[@data-center-panel-tab-id][.//span[normalize-space()="Codex Terminal"]]//*[@role="tab"]',
    );
    await tab.waitForDisplayed();
    await tab.click();
  });

  it("sets the credential and endpoint, resolves bibcode to the shim and answers agent list", async () => {
    await showTerminal();
    await sendTerminalCommand('echo "auth=${BIBCODE_AGENT_AUTH:+set}"');
    await sendTerminalCommand('echo "endpoint=${BIBCODE_AGENT_ENDPOINT:+set}"');
    await sendTerminalCommand(
      'echo "shim=$(head -n 2 "$(command -v bibcode)" | grep -c "BiBCode agent shim")"',
    );
    const text = await shell('bibcode agent list; echo "list_exit=$?"', "done=1");
    expect(text).toContain("auth=set");
    expect(text).toContain("endpoint=set");
    expect(text).toContain("shim=1");
    expect(text).toContain("list_exit=0");
  });

  it("does not deliver a queued message while agent messaging is off and releases it when on", async () => {
    const before = readResult().length;
    const listed = readResult().split("done=1")[0] ?? "";
    const targetAddress = /(thread:(?!bibcode-ui-activity-thread)\S+)/.exec(listed)?.[1] ?? "";
    expect(targetAddress).not.toBe("");
    const sent = await shell(`bibcode agent send ${targetAddress} '${heldText}' --json`, "done=2");
    messageId = /"messageId"\s*:\s*"([^"]+)"/.exec(sent.slice(before))?.[1] ?? "";
    expect(messageId).not.toBe("");
    const status = async (marker: string) =>
      (await shell(`bibcode agent status ${messageId} --json`, marker)).split(marker)[0] ?? "";
    expect(await status("s1=1")).toContain('"queued"');

    await setDesktopAgentMessaging(false);
    // While messaging is off the command is refused outright, so the held state is not readable
    // from the terminal; what shows is the refusal and that nothing reached the chat.
    await browser.waitUntil(
      async () => (await status(`s2=${Date.now()}`)).includes("AgentMessagingDisabledError"),
      { timeout: 30_000, timeoutMsg: "agent status was not refused while messaging was off." },
    );
    const delivered = () =>
      readProviderInputLog(providerInputLogPath).some((entry) => entry.prompt.includes(heldText));
    expect(delivered()).toBe(false);

    await setDesktopAgentMessaging(true);
    await browser.waitUntil(
      async () => {
        const marker = `s3=${Date.now()}`;
        return (await status(marker)).slice(-400).includes('"queued"');
      },
      { timeout: 30_000, timeoutMsg: "The held message was not released back to queued." },
    );
    expect(delivered()).toBe(false);

    completeDesktopUiSlowTurn(projectPath, turnId);
    await browser.waitUntil(delivered, {
      timeout: 60_000,
      timeoutMsg: "The released message never reached the chat's provider.",
    });
  });
});
