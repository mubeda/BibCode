// @vitest-environment happy-dom

import type { DesktopLinuxSoftwareRenderingState } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LinuxRenderingSection, type LinuxRenderingBridge } from "./LinuxRenderingSection";

const OFF: DesktopLinuxSoftwareRenderingState = {
  enabled: false,
  override: null,
  userVariables: [],
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
    expect(text()).toContain("This launch does not ask WebKit to turn off GPU compositing.");
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

  it("says what this launch asked for, not what WebKit decided", async () => {
    await render(fakeBridge({ ...OFF, enabled: true, gpuCompositingDisabled: true }));
    expect(text()).toContain("This launch asks WebKit to draw without GPU compositing.");
  });

  it("explains that variables the user exported decide, and the switch cannot change them", async () => {
    await render(
      fakeBridge({
        ...OFF,
        gpuCompositingDisabled: true,
        userVariables: [
          { name: "WEBKIT_DISABLE_COMPOSITING_MODE", value: "1" },
          { name: "WEBKIT_DISABLE_DMABUF_RENDERER", value: "1" },
        ],
      }),
    );
    expect(text()).toContain("WEBKIT_DISABLE_COMPOSITING_MODE=1");
    expect(text()).toContain("WEBKIT_DISABLE_DMABUF_RENDERER=1");
    expect(text()).toContain("this switch cannot change");
  });

  it("keeps Restart now unavailable while a save is in flight, and restarts once", async () => {
    let finishSave: (state: DesktopLinuxSoftwareRenderingState) => void = () => {};
    let finishRestart: () => void = () => {};
    const initial = { ...OFF, enabled: true, restartApplies: true };
    const bridge = fakeBridge(initial, {
      setLinuxSoftwareRendering: vi.fn(
        () =>
          new Promise<DesktopLinuxSoftwareRenderingState>((resolve) => {
            finishSave = resolve;
          }),
      ),
      restartApp: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRestart = resolve;
          }),
      ),
    });
    await render(bridge);
    const restartButton = () =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Restart"),
      );
    await act(async () => toggle()?.click());
    expect(restartButton()?.disabled).toBe(true);
    await act(async () => restartButton()?.click());
    expect(bridge.restartApp).not.toHaveBeenCalled();
    await act(async () => finishSave({ ...initial, enabled: false, restartApplies: true }));
    await act(async () => restartButton()?.click());
    await act(async () => restartButton()?.click());
    expect(bridge.restartApp).toHaveBeenCalledOnce();
    expect(restartButton()?.textContent).toBe("Restarting…");
    await act(async () => finishRestart());
  });

  it("says how to apply the change when the restart fails, and clears that on retry", async () => {
    const restartApp = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("an update is installing"))
      .mockResolvedValueOnce(undefined);
    await render(fakeBridge({ ...OFF, enabled: true, restartApplies: true }, { restartApp }));
    const restartButton = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Restart now",
      );
    await act(async () => restartButton()?.click());
    expect(text()).toContain("Quit and reopen BiBCode to apply this change.");
    expect(text()).toContain("an update is installing");
    await act(async () => restartButton()?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("explains how to recover when the setting cannot be read", async () => {
    await render(
      fakeBridge(OFF, {
        getLinuxSoftwareRendering: vi.fn(async () => {
          throw new Error("expected value at line 1 column 2");
        }),
      }),
    );
    expect(text()).toContain("desktop-settings.json");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.id).toBeTruthy();
    expect(toggle()?.getAttribute("aria-describedby")).toContain(alert?.id ?? "missing");
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
