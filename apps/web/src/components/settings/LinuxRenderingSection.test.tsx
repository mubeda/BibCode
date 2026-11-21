// @vitest-environment happy-dom

import type { DesktopLinuxSoftwareRenderingState } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LinuxRenderingSection, type LinuxRenderingBridge } from "./LinuxRenderingSection";

const OFF: DesktopLinuxSoftwareRenderingState = {
  enabled: false,
  override: null,
  gpuCompositingDisabled: false,
  restartApplies: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function fakeBridge(
  initial: DesktopLinuxSoftwareRenderingState,
  overrides: Partial<LinuxRenderingBridge> = {},
): LinuxRenderingBridge {
  return {
    getLinuxSoftwareRendering: vi.fn(async () => initial),
    setLinuxSoftwareRendering: vi.fn(async (enabled: boolean) => ({
      ...initial,
      enabled,
      restartApplies: enabled !== initial.gpuCompositingDisabled,
    })),
    restartApp: vi.fn(async () => {}),
    ...overrides,
  };
}

async function render(bridge: LinuxRenderingBridge | undefined, platform = "Linux x86_64") {
  await act(async () => {
    root.render(<LinuxRenderingSection bridge={bridge} platform={platform} />);
  });
}

const toggle = () => container.querySelector<HTMLElement>('[aria-label="Disable GPU compositing"]');
const text = () => container.textContent ?? "";

describe("LinuxRenderingSection", () => {
  it("renders nothing off Linux or without the bridge methods", async () => {
    await render(fakeBridge(OFF), "MacIntel");
    expect(container.innerHTML).toBe("");
    await render(fakeBridge(OFF), "Win32");
    expect(container.innerHTML).toBe("");
    await render(undefined);
    expect(container.innerHTML).toBe("");
  });

  it("shows the setting and this session's state on Linux", async () => {
    await render(fakeBridge(OFF));
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("GPU compositing is on in this session.");
    expect(text()).not.toContain("Restart");
  });

  it("saves the change and offers a restart that applies it", async () => {
    const bridge = fakeBridge(OFF);
    await render(bridge);
    await act(async () => toggle()?.click());
    expect(bridge.setLinuxSoftwareRendering).toHaveBeenCalledWith(true);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Restart BiBCode to apply this change.");
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart now",
    );
    await act(async () => restart?.click());
    expect(bridge.restartApp).toHaveBeenCalledOnce();
  });

  it("disables the switch and names the variable while the override decides", async () => {
    await render(
      fakeBridge({ ...OFF, enabled: true, override: "off", gpuCompositingDisabled: false }),
    );
    expect(toggle()?.hasAttribute("data-disabled")).toBe(true);
    expect(text()).toContain("BIBCODE_SOFTWARE_RENDERING=0");
    expect(text()).not.toContain("Restart");
  });

  it("does not claim compositing is off when it is not", async () => {
    // The setting is on, but the user exported WEBKIT_DISABLE_COMPOSITING_MODE=0.
    await render(fakeBridge({ ...OFF, enabled: true, gpuCompositingDisabled: false }));
    expect(text()).toContain("GPU compositing is on in this session.");
  });

  it("keeps the stored value and says so when saving fails", async () => {
    const bridge = fakeBridge(OFF, {
      setLinuxSoftwareRendering: vi.fn(async () => {
        throw new Error("Could not write desktop-settings.json: read-only file system");
      }),
    });
    await render(bridge);
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("Could not save the setting");
    expect(text()).toContain("read-only file system");
  });

  it("says to quit and reopen when the app cannot restart itself", async () => {
    const { restartApp: _restartApp, ...withoutRestart } = fakeBridge({
      ...OFF,
      restartApplies: true,
      enabled: true,
    });
    await render(withoutRestart);
    expect(text()).toContain("Quit and reopen BiBCode to apply this change.");
  });
});
