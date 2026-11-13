// @vitest-environment happy-dom

/**
 * R51: the Profiler records an error the app's error screen caught. The router is the app's
 * own (`getRouter`) with the real TanStack root boundary; only its route tree is a small one, so
 * a throwing child sits under a root route whose error component is the error screen. The
 * collector is the app's singleton, enabled and disabled by a host that mounts and unmounts
 * with the route component and the error screen, as `startClientCollector` does in both.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProfilerClientBatch } from "@bibcode/contracts";

const scene = vi.hoisted(() => ({
  profiledEnvironments: [] as string[],
  throwError: (): never => {
    throw new Error("unset");
  },
}));

vi.mock("../routeTree.gen", async () => {
  const { createRootRoute, createRoute, Outlet } = await import("@tanstack/react-router");
  const { clientCollector } = await import("./clientCollector");
  function CollectorHost() {
    useEffect(() => {
      clientCollector.setEnabledEnvironments(new Set(scene.profiledEnvironments));
      return () => clientCollector.setEnabledEnvironments(new Set());
    }, []);
    return null;
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <CollectorHost />
        <Outlet />
      </>
    ),
    errorComponent: () => (
      <>
        <CollectorHost />
        <h1>Something went wrong.</h1>
      </>
    ),
  });
  function ExplodingThreadPanel(): never {
    return scene.throwError();
  }
  function ThreadPane() {
    return <ExplodingThreadPanel />;
  }
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>Home</p>,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread/$threadId",
    component: ThreadPane,
  });
  return { routeTree: rootRoute.addChildren([homeRoute, threadRoute]) };
});

import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";

import { getRouter } from "../router";
import { clientCollector, setClientBatchSender } from "./clientCollector";

const SECRET_PATH = "/thread/thread-7f3a9c-secret";
const sent: ProfilerClientBatch[] = [];
let container: HTMLDivElement;
let root: Root;

async function settle(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (done()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`${what} never appeared`);
}

/** Opens the app at home, so the collector runs, then opens the thread whose panel throws. */
async function showErrorScreen() {
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle(() => container.textContent?.includes("Home") ?? false, "home");
  await act(async () => {
    await router.history.push(SECRET_PATH);
  });
  await settle(
    () => container.textContent?.includes("Something went wrong.") ?? false,
    "the error screen",
  );
}

function renderErrors(): unknown[] {
  return sent.flatMap((batch) => batch.renderErrors ?? []);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  sent.length = 0;
  setClientBatchSender(async (_environmentId, batch) => {
    sent.push(batch);
  });
  scene.profiledEnvironments = ["env-1"];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clientCollector.dispose();
  setClientBatchSender(null);
  vi.restoreAllMocks();
});

describe("a render error the error screen caught", () => {
  it("is recorded once, with names and codes only", async () => {
    scene.throwError = () => {
      throw new TypeError(
        "Cannot read thread-7f3a9c-secret from /Users/test-user/project/file.ts at https://example.test/x",
      );
    };
    await showErrorScreen();
    await clientCollector.flush();

    expect(sent).toHaveLength(1);
    const records = renderErrors();
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(Object.keys(record).toSorted()).toEqual([
      "componentNames",
      "errorType",
      "fingerprint",
      "reactErrorCode",
      "routePattern",
    ]);
    expect(record.errorType).toBe("TypeError");
    expect(record.reactErrorCode).toBeNull();
    expect(record.routePattern).toBe("/thread/$threadId");
    const names = record.componentNames as string[];
    expect(names[0]).toBe("ExplodingThreadPanel");
    expect(names).toContain("ThreadPane");
    expect(names.length).toBeLessThanOrEqual(12);
    for (const name of names) expect(name).toMatch(/^[A-Za-z_$][\w$.]*$/);
    expect(record.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    const wire = JSON.stringify(sent);
    for (const forbidden of ["secret", "Cannot read", "/Users", "https:", "file.ts", "env-1"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("parses React's minified error code and never keeps the message", async () => {
    scene.throwError = () => {
      throw new Error(
        "Minified React error #185; visit https://react.dev/errors/185 for the full message",
      );
    };
    await showErrorScreen();
    await clientCollector.flush();

    const [record] = renderErrors() as Array<Record<string, unknown>>;
    expect(record?.errorType).toBe("Error");
    expect(record?.reactErrorCode).toBe(185);
    expect(JSON.stringify(sent)).not.toContain("react.dev");
  });

  it("gives the same error the same fingerprint, whatever its message", async () => {
    let message = "first secret";
    scene.throwError = () => {
      throw new RangeError(message);
    };
    await showErrorScreen();
    await clientCollector.flush();
    act(() => root.unmount());
    root = createRoot(container);
    message = "another secret";
    await showErrorScreen();
    // The first flush reset the window; the second batch carries the second record.
    await clientCollector.flush();

    const records = renderErrors() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]?.fingerprint).toBe(records[1]?.fingerprint);
  });

  it("records nothing while the Profiler is off, and the error screen still shows", async () => {
    scene.profiledEnvironments = [];
    scene.throwError = () => {
      throw new Error("off");
    };
    await showErrorScreen();
    // Turned on afterwards: nothing was kept from while it was off.
    clientCollector.setEnabledEnvironments(new Set(["env-1"]));
    await clientCollector.flush();
    expect(renderErrors()).toHaveLength(0);
  });

  it("never throws from the error screen, even for a hostile error", async () => {
    scene.throwError = () => {
      const hostile = new Error("x");
      Object.defineProperty(hostile, "name", {
        get() {
          throw new Error("name getter");
        },
      });
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("message getter");
        },
      });
      throw hostile;
    };
    await showErrorScreen();
    expect(container.textContent).toContain("Something went wrong.");
  });
});
