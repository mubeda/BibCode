// @vitest-environment happy-dom
// Open terminal and history (#378), through a real router: refocusing the terminal shown must
// not push an entry that leads back into it, or the exit's Back opens the shell again.
import { EnvironmentId } from "@bibcode/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => undefined }),
}));

import { useRunServerCommand, validateServerTerminalSearch } from "./serverCommands";

const SERVER_A = EnvironmentId.make("server-a");
const opens: number[] = [];

function Commands() {
  const run = useRunServerCommand();
  return (
    <button type="button" data-testid="open" onClick={() => run("terminal", SERVER_A)}>
      Open terminal
    </button>
  );
}

function Terminal() {
  const { open } = terminalRoute.useSearch();
  // As ServerTerminalPanel does: each invocation runs terminal.open.
  useEffect(() => {
    if (open !== undefined) opens.push(open);
  }, [open]);
  return <div data-testid="terminal" />;
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Commands />
      <Outlet />
    </>
  ),
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environment/$environmentId/terminal",
  validateSearch: validateServerTerminalSearch,
  component: Terminal,
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("Open terminal history", () => {
  it("refocuses in place, so the exit's Back returns to the chat without reopening", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      routeTree: rootRoute.addChildren([chatRoute, terminalRoute]),
      history,
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    const open = () => container.querySelector<HTMLButtonElement>('[data-testid="open"]')!;

    await act(async () => open().click());
    await act(async () => open().click());
    expect(router.state.location.pathname).toBe("/environment/server-a/terminal");
    expect(opens).toHaveLength(2);

    // The shell exits: the panel goes Back.
    await act(async () => history.back());
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(opens, "no third terminal.open").toHaveLength(2);
    container.remove();
  });
});
