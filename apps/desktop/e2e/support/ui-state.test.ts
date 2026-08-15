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

    expect(configuration).not.toContain('document.createElement("style")');
    expect(configuration).toContain("sheet.insertRule");
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
    expect(source).toContain("const candidate = browser.$(selector)");
    expect(source).toContain("await candidate.waitForExist({");
    expect(source).toContain("await candidate.waitForDisplayed({");
    expect(source).toContain("await candidate.waitForEnabled({");
    expect(source).not.toContain("for (const candidate of await browser.$$(selector))");
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
