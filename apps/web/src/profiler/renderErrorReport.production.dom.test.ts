// @vitest-environment happy-dom

/**
 * R51 with a real nested-update crash, under React's production build as the app ships it: a
 * component that sets state in a layout effect without bound reaches React's update-depth
 * limit, and the error screen's record carries React's code 185. The development build throws
 * the full message, which carries no code. React picks its build from `NODE_ENV` when it is
 * first loaded, so this file sets it before any import and uses no JSX (the development JSX
 * transform has no production runtime).
 */
import { vi } from "vite-plus/test";

const testEnv = vi.hoisted(() => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  return { previous };
});

import { createElement, Fragment, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it } from "vite-plus/test";

import type { ProfilerClientBatch } from "@bibcode/contracts";

vi.mock("../routeTree.gen", async () => {
  const { createRootRoute, createRoute, Outlet } = await import("@tanstack/react-router");
  const { clientCollector } = await import("./clientCollector");
  function CollectorHost() {
    useEffect(() => {
      clientCollector.setEnabledEnvironments(new Set(["env-1"]));
      return () => clientCollector.setEnabledEnvironments(new Set());
    }, []);
    return null;
  }
  const rootRoute = createRootRoute({
    component: () =>
      createElement(Fragment, null, createElement(CollectorHost), createElement(Outlet)),
    errorComponent: () =>
      createElement(
        Fragment,
        null,
        createElement(CollectorHost),
        createElement("h1", null, "Something went wrong."),
      ),
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => createElement("p", null, "Home"),
  });
  const loopRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/loop",
    component: UnboundedLayoutUpdate,
  });
  return { routeTree: rootRoute.addChildren([homeRoute, loopRoute]) };
});

function UnboundedLayoutUpdate() {
  const [renders, setRenders] = useState(0);
  // oxlint-disable-next-line react/set-state-in-effect -- the unbounded update is the crash under test.
  useLayoutEffect(() => setRenders(renders + 1));
  return createElement("p", null, renders);
}

import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";

import { getRouter } from "../router";
import { clientCollector, setClientBatchSender } from "./clientCollector";

async function until(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never appeared`);
}

afterAll(() => {
  process.env.NODE_ENV = testEnv.previous;
});

afterEach(() => {
  clientCollector.dispose();
  setClientBatchSender(null);
  vi.restoreAllMocks();
});

it("a real nested-update crash is recorded with React's code 185", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sent: ProfilerClientBatch[] = [];
  setClientBatchSender(async (_environmentId, batch) => {
    sent.push(batch);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  root.render(createElement(RouterProvider, { router }));
  await until(() => container.textContent?.includes("Home") ?? false, "home");

  await router.history.push("/loop");
  await until(
    () => container.textContent?.includes("Something went wrong.") ?? false,
    "the error screen",
  );
  await clientCollector.flush();
  root.unmount();
  container.remove();

  const records = sent.flatMap((batch) => batch.renderErrors ?? []);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    errorType: "Error",
    reactErrorCode: 185,
    routePattern: "/loop",
  });
  expect(records[0]?.componentNames[0]).toBe("UnboundedLayoutUpdate");
  expect(JSON.stringify(sent)).not.toContain("Minified");
});
