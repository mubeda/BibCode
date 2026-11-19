// @vitest-environment happy-dom
import { EnvironmentId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  environment: null as Record<string, unknown> | null,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/state/environments", () => ({ useEnvironment: () => h.environment }));

import { MISSING_SERVER_NOTICE_DELAY_MS, ServerPanelFrame } from "./ServerPanelFrame";

const LOCAL = EnvironmentId.make("local");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  h.environment = null;
  h.navigate.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render() {
  await act(async () =>
    root.render(
      <ServerPanelFrame environmentId={LOCAL} title="Dashboard" testId="panel">
        <p>body</p>
      </ServerPanelFrame>,
    ),
  );
}

describe("ServerPanelFrame", () => {
  it("waits for a server that registers after reload instead of leaving the panel", async () => {
    await render();
    expect(container.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(MISSING_SERVER_NOTICE_DELAY_MS - 1));
    expect(container.textContent).toBe("");
    // The platform registers Local after the catalog was already ready.
    h.environment = {
      label: "This Mac",
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
      connection: { phase: "connected" },
    };
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Local");
    expect(container.textContent).toContain("body");
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("says a server that never appears is not available, without redirecting", async () => {
    await render();
    await act(async () => vi.advanceTimersByTime(MISSING_SERVER_NOTICE_DELAY_MS));
    expect(container.textContent).toContain("This server is not available.");
    expect(container.textContent).not.toContain("body");
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
