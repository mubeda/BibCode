// @effect-diagnostics nodeBuiltinImport:off - Contract tests inspect the packaged UI harness source.
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { mockDesktopUiFolderPicker } from "./ui-state.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mockDesktopUiFolderPicker", () => {
  it("returns the fixture path from the packaged Tauri folder-picker command", async () => {
    const mockReturnValue = vi.fn(async () => undefined);
    const mock = vi.fn(async () => ({ mockReturnValue }));
    vi.stubGlobal("browser", { tauri: { mock } });

    await mockDesktopUiFolderPicker("/tmp/bibcode-ui-project");

    expect(mock).toHaveBeenCalledExactlyOnceWith("desktop_bridge_pick_folder");
    expect(mockReturnValue).toHaveBeenCalledExactlyOnceWith("/tmp/bibcode-ui-project");
  });
});

describe("desktop UI motion stabilization", () => {
  it("keeps the WDIO motion guard from overriding open or closed portal styles", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    // The guard is one marked stylesheet installed once per document; it never
    // sets inline styles or observes and rewrites portal lifecycle attributes.
    expect(configuration).toContain("style[data-bibcode-desktop-ui-automation]");
    expect(configuration).toContain("style.dataset.bibcodeDesktopUiAutomation");
    expect(configuration).toContain(
      'document.documentElement.dataset.bibcodeDesktopUiMotion = "disabled"',
    );
    expect(configuration).not.toMatch(
      /style\.setProperty\("(?:opacity|scale|translate|transform)"/,
    );
    expect(configuration).not.toContain("new MutationObserver");
    expect(configuration).not.toMatch(/removeAttribute\("data-(?:starting|ending)-style"\)/);
  });

  it("settles stuck opening portals and hides closed portals through state-aware CSS", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(configuration).toContain("[data-open][data-starting-style]");
    expect(configuration).toMatch(
      /\[data-open\]\[data-starting-style\]\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
    expect(configuration).toMatch(/\[data-closed\]\s*\{[^}]*display:\s*none\s*!important;[^}]*\}/s);
  });

  it("settles auto-animated project rows without overriding unrelated content", () => {
    const configuration = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(configuration).toMatch(
      /\[data-slot="sidebar-group"\]:has\(\[data-testid="new-main-chat-button"\]\)\s+ul\[data-sidebar="menu"\]\s*>\s*li\s*\{[^}]*opacity:\s*1\s*!important;[^}]*\}/s,
    );
    expect(configuration).not.toMatch(/(?:^|,)\s*li\s*\{[^}]*opacity:/s);
  });

  it("leaves portal lifecycle state to Base UI in every smoke spec", () => {
    for (const spec of ["../specs/main-window.e2e.ts", "../specs/platform-capabilities.e2e.ts"]) {
      const source = NodeFS.readFileSync(new URL(spec, import.meta.url), "utf8");
      expect(source).not.toContain("stabilizeDesktopUiTransitions");
    }
  });
});

describe("packaged composer acceptance contract", () => {
  const readComposerSpec = (): string =>
    NodeFS.readFileSync(
      new URL("../specs/composer-native-triggers.e2e.ts", import.meta.url),
      "utf8",
    );

  it("checks every visible model row through semantic provider and model attributes", () => {
    const source = readComposerSpec();

    expect(source).toContain('[data-model-picker-content="true"] [data-slot="combobox-item"]');
    expect(source).toContain("element.dataset.modelPickerInstanceId");
    expect(source).toContain("element.dataset.modelPickerModelSlug");
    expect(source).toContain("row.instanceId === scenario.provider");
    expect(source).toContain("row.modelSlug.length > 0");
    expect(source).not.toContain("foreignModels");
  });

  it("uses browser visibility semantics before clicking portal-backed composer items", () => {
    const source = readComposerSpec();

    expect(source).toContain("element.checkVisibility({");
    expect(source).toContain("opacityProperty: true");
    expect(source).toContain("visibilityProperty: true");
    // The click target is resolved inside the visible composer form only after
    // the menu has settled its workspace search, and its ownership is asserted
    // right before the click; there is no global lookup, retry, or sleep.
    expect(source).toContain("await waitForComposerMenuSettled();");
    expect(source).toContain('(await menu.getAttribute("data-composer-menu-loading")) === "false"');
    expect(source).toContain(
      'const candidate = composerForm().$(`${composerMenuSelector} [data-composer-item-id="${id}"]`)',
    );
    expect(source).toContain("await candidate.waitForExist({");
    expect(source).toContain("await candidate.waitForDisplayed({");
    expect(source).toContain("await candidate.waitForEnabled({");
    // The ownership script receives the resolved element, never the chainable
    // wrapper, and the click reuses that same resolved reference.
    expect(source).toContain("const element = await candidate;");
    expect(source).toMatch(
      /browser\.execute\(\s*\(element: HTMLElement, itemId: string\) => \{[\s\S]*?\},\s*element,\s*id,\s*\);/,
    );
    expect(source).toMatch(
      /expect\(ownership\)\.toEqual\(\{[\s\S]*?\}\);\s*await element\.click\(\);/,
    );
    expect(source).toContain("connected: element.isConnected");
    expect(source).toContain('hostVisible: "true"');
    expect(source).not.toContain("const candidate = browser.$(selector)");
    expect(source).not.toContain("for (const candidate of await browser.$$(selector))");
    expect(source).not.toMatch(/browser\.pause\(|setTimeout\(resolve/);
  });

  it("restarts the packaged session and compares the complete native provider payload sequence", () => {
    const source = readComposerSpec();

    expect(source).toContain("await browser.reloadSession()");
    expect(source).not.toContain("await browser.refresh()");
    expect(source).toContain(
      "const composerLogBaseline = readProviderInputLog(preparedProviderInputLogPath).length",
    );
    expect(source).toContain(".slice(composerLogBaseline)");
    expect(source.match(/await activateProviderPanel\("Codex"\)/g)).toHaveLength(2);
    expect(source.match(/await appendAndSelectComposerItem/g)).toHaveLength(3);
    expect(source).not.toContain("await waitForComposerValue(expectedValue)");
    expect(source).toContain('await composerEditor().addValue("$refactor ")');
    expect(source).toContain("expect(actualProviderInputs).toEqual(expectedProviderInputs)");
    for (const prompt of [
      '"$refactor"',
      '"@README.md"',
      '"/compact"',
      '"/docs"',
      '"/review"',
      '"@reviewer"',
    ]) {
      expect(source).toContain(prompt);
    }
    expect(source).not.toContain('provider: "grok"');
    expect(source).not.toContain('prompt: "/skills"');
  });
});

describe("packaged activity viewport contract", () => {
  it("starts responsive coverage at the native window minimum", () => {
    const configuration = JSON.parse(
      NodeFS.readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    ) as { app: { windows: Array<{ minWidth: number }> } };
    const source = NodeFS.readFileSync(
      new URL("../specs/chat-activity-panel.e2e.ts", import.meta.url),
      "utf8",
    );

    expect(configuration.app.windows[0]?.minWidth).toBe(960);
    expect(source).toContain("for (const width of [960, 980, 981, 1_199, 1_200] as const)");
    expect(source).not.toContain("for (const width of [800,");
  });
});
