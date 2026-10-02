// @effect-diagnostics nodeBuiltinImport:off - Native route qualification uses owned OS state and evidence files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopBridge } from "../../../../packages/contracts/src/ipc.ts";
import type { AdvertisedEndpoint } from "../../../../packages/contracts/src/remoteAccess.ts";

import { setDesktopUiWindowSize } from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const namespace = process.env.BIBCODE_ISSUE28_NETNS;
const hostNamespace = process.env.BIBCODE_ISSUE28_HOST_NETNS;
if (!artifactDirectory || !namespace || !hostNamespace || namespace === hostNamespace) {
  throw new Error("A private issue28 network namespace and evidence directory are required.");
}
const evidenceRoot = artifactDirectory;
const expectedNamespace = namespace;
const missingRouteCopy =
  "Native sharing uses the private address of this computer's default network route, and this computer has none right now. Connect it to a local network that provides a default route, then Refresh. Otherwise, use an externally managed server or reverse proxy.";

function command(program: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(program, [...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  });
}

function assertOwnedNamespace(): void {
  const actual = NodeFS.readlinkSync("/proc/self/ns/net");
  if (actual !== expectedNamespace) {
    throw new Error(`Refusing route mutation outside owned namespace: ${actual}`);
  }
}

function routes(): unknown {
  return JSON.parse(command("ip", ["-j", "route", "show", "table", "all"]));
}

async function endpoints(): Promise<ReadonlyArray<AdvertisedEndpoint>> {
  return browser.execute(async () => {
    const bridge = Reflect.get(window, "desktopBridge") as DesktopBridge | undefined;
    if (!bridge) throw new Error("Real packaged DesktopBridge is unavailable.");
    return bridge.getAdvertisedEndpoints();
  });
}

async function setTheme(origin: string, theme: "Light" | "Dark"): Promise<void> {
  await browser.url(`${origin}/#/settings/general`);
  const picker = browser.$('[aria-label="Theme preference"]');
  await picker.waitForDisplayed();
  await picker.scrollIntoView();
  await picker.click();
  const option = browser.$(`//*[@role="option" and normalize-space()="${theme}"]`);
  await option.waitForDisplayed();
  await option.click();
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.documentElement.classList.contains("dark"))) ===
      (theme === "Dark"),
    { timeoutMsg: `The actual ${theme} theme did not apply.` },
  );
}

async function showSharing(origin: string): Promise<void> {
  await browser.url(`${origin}/#/settings/remote-servers`);
  const tab = browser.$("//*[normalize-space()='Share this host' and @role='tab']");
  await tab.waitForDisplayed();
  await tab.click();
  await browser.$('button[aria-label="Refresh addresses"]').waitForDisplayed();
}

async function capture(phase: string, theme: string): Promise<void> {
  const rootClass = await browser.execute(() => document.documentElement.className);
  const nativeEndpoints = await endpoints();
  NodeFS.writeFileSync(
    NodePath.join(evidenceRoot, `${phase}-${theme}.json`),
    `${JSON.stringify({ phase, theme, rootClass, routes: routes(), nativeEndpoints }, null, 2)}\n`,
  );
  await browser.saveScreenshot(NodePath.join(evidenceRoot, `${phase}-${theme}.png`));
}

describe("real native host without a private default route", () => {
  it("shows both themes and recovers through Refresh after adding the owned route", async () => {
    assertOwnedNamespace();
    const initialDefaults = command("ip", ["-j", "route", "show", "default"]);
    expect(JSON.parse(initialDefaults)).toEqual([]);
    await setDesktopUiWindowSize(1280, 960);
    const origin = await browser.execute(() => window.location.origin);
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(origin, theme);
      await showSharing(origin);
      await browser.waitUntil(
        async () => (await browser.$("body").getText()).includes(missingRouteCopy),
        { timeoutMsg: "The actual no-private-default-route copy did not render." },
      );
      await expect(browser.$("button=Generate pairing offer")).toBeDisabled();
      const actual = await endpoints();
      expect(actual.some((entry) => entry.isDefault)).toBe(false);
      expect(actual.some((entry) => entry.httpBaseUrl.includes("10.188.28.2"))).toBe(true);
      await capture("no-default-route", theme.toLowerCase());
    }

    assertOwnedNamespace();
    command("ip", ["route", "add", "default", "via", "10.188.28.1", "dev", "issue28-in"]);
    expect(JSON.parse(command("ip", ["-j", "route", "show", "default"]))).toHaveLength(1);
    // Stay on the same sharing view: this click must cause the recovery.
    await browser.$('button[aria-label="Refresh addresses"]').click();
    await browser.waitUntil(
      async () =>
        !(await browser.$("body").getText()).includes(missingRouteCopy) &&
        (await browser.$("button=Generate pairing offer").isEnabled()),
      { timeoutMsg: "Refresh did not recover native sharing after the real route appeared." },
    );
    const recovered = await endpoints();
    expect(
      recovered.some((entry) => entry.isDefault && entry.httpBaseUrl.includes("10.188.28.2")),
    ).toBe(true);
    await capture("route-recovered", "dark");
    await setTheme(origin, "Light");
    await showSharing(origin);
    await expect(browser.$("button=Generate pairing offer")).toBeEnabled();
    expect((await browser.$("body").getText()).includes(missingRouteCopy)).toBe(false);
    await capture("route-recovered", "light");
    NodeFS.writeFileSync(
      NodePath.join(evidenceRoot, "result.json"),
      `${JSON.stringify({ passed: true, namespace: expectedNamespace, themes: ["light", "dark"], generatedPairingOffer: false })}\n`,
    );
  });
});
