// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ primary: null as unknown }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironment: () => state.primary }));
vi.mock("../env", () => ({ isDesktopHost: false }));
vi.mock("../branding", () => ({ APP_VERSION: "0.7.2" }));
import { ServerReloadPrompt } from "./ServerReloadPrompt";
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  state.primary = null;
  vi.restoreAllMocks();
});
describe("ServerReloadPrompt", () => {
  it("captures late bootstrap and preserves unsent input until an explicit Reload", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const input = document.createElement("textarea");
    input.value = "Unsent text";
    document.body.append(input);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ServerReloadPrompt />));
    state.primary = {
      serverConfig: { environment: { bootId: "boot-before", serverVersion: "0.7.2" } },
    };
    await act(async () => root.render(<ServerReloadPrompt />));
    expect(container.textContent).toBe("");
    state.primary = {
      serverConfig: { environment: { bootId: "boot-after", serverVersion: "0.7.3" } },
    };
    await act(async () => root.render(<ServerReloadPrompt />));
    expect(container.textContent).toContain("updated to v0.7.3. Reload to use it.");
    expect(input.value).toBe("Unsent text");
    expect(reload).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click());
    expect(reload).toHaveBeenCalledOnce();
  });
});
