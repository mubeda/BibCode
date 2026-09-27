// @vitest-environment happy-dom

import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const connect = vi.hoisted(() => vi.fn());

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => connect,
}));

// The root gate does not need the application shell's theme/storage bootstrap.
vi.mock("../hooks/useTheme", () => ({ syncBrowserChromeTheme: vi.fn() }));

import { Route as RootRoute } from "./__root";
import { Route as PairRoute } from "./pair";

let container: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("VITE_HTTP_URL", "");
  vi.stubEnv("VITE_WS_URL", "");
  vi.stubEnv("VITE_HOSTED_APP_URL", "");
  vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
  window.history.replaceState(
    {},
    "",
    "/pair?host=https://backend.example.test&label=Office#token=%3CREDACTED%3E",
  );
  history = createBrowserHistory();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  connect.mockReset().mockResolvedValue({ _tag: "Success" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  history.destroy();
  container.remove();
  window.history.replaceState({}, "", "/");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function renderPairRoute() {
  // Keep the production root gate, pair route, pairing surface, and browser
  // history together; the unrelated application shell is outside this seam.
  const beforeLoad = RootRoute.options.beforeLoad;
  if (!beforeLoad) throw new Error("Root beforeLoad is not registered.");
  const rootRoute = createRootRoute({
    beforeLoad,
    component: Outlet,
  });
  const pairRoute = PairRoute.update({ getParentRoute: () => rootRoute, path: "/pair" } as never);
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <h1>App</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pairRoute, indexRoute]),
    history,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });

  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await vi.waitFor(() => {
      expect(window.location.hash).toBe("");
      expect(router.state.status).toBe("idle");
    });
  });
  return router;
}

describe("hosted /pair routing", () => {
  it("shows recovery advice without connection troubleshooting when the link has no token", async () => {
    window.history.replaceState({}, "", "/pair?host=https://backend.example.test");

    await renderPairRoute();

    expect(container.textContent).toContain("Pairing failed");
    expect
      .soft(container.textContent)
      .toContain(
        "This pairing link is missing its backend host or token. Open the complete link again, or create a new pairing link on the backend.",
      );
    expect.soft(container.textContent).not.toContain("Verify the backend is reachable");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["fragment", "query"])(
    "keeps confirmation actionable after removing the %s token from browser history",
    async (tokenLocation) => {
      if (tokenLocation === "query") {
        window.history.replaceState(
          {},
          "",
          "/pair?host=https://backend.example.test&label=Office&token=%3CREDACTED%3E",
        );
      }
      const historyLength = window.history.length;
      const router = await renderPairRoute();

      expect(connect).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/pair");
      expect(window.history.length).toBe(historyLength);
      expect(new URL(window.location.href).searchParams.has("token")).toBe(false);

      // Subsequent gate evaluations must not discard the in-memory request.
      await act(async () => router.invalidate());
      const confirm = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Pair this backend",
      );
      expect(confirm).toBeDefined();
      expect(confirm?.disabled).toBe(false);

      await act(async () => confirm?.click());

      expect(connect).toHaveBeenCalledExactlyOnceWith({
        host: "https://backend.example.test/",
        pairingCode: "<REDACTED>",
      });
      expect(container.textContent).toContain("Backend paired");
    },
  );

  it("lets the user leave pairing without submitting the retained token", async () => {
    const router = await renderPairRoute();
    expect(container.textContent).toContain("Pair this backend");

    await act(async () => router.navigate({ to: "/" }));

    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(container.textContent).not.toContain("Pair this backend");
    expect(connect).not.toHaveBeenCalled();
  });
});
